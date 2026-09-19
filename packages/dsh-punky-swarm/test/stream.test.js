/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// SSE hub + /stream 端点单测：
//   握手/帧格式、摘要推送与批次过滤、会话级连接上限、close 清理、fs.watch 触发源、
//   topic 触发源（attachTopic，payload 与主题名双解析）、dispose、api 路由装配。
//   心跳周期/防抖/上限用构造参数覆盖提速（生产缺省 heartbeatMs=10000/debounceMs=300/maxConns=8 不变）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamHub, hasShortNameSegment } from '../lib/panel/stream.js';
import { createApi } from '../lib/api.js';
import { createStore } from '../lib/state/store.js';
import { emitTopic } from '../lib/comms/topic.js';

function FakeRes() {
  this.frames = [];
  this.status = 0;
  this.headers = null;
  this.destroyed = false;
  this.writableEnded = false;
  this._onClose = null;
  const self = this;
  this.writeHead = (s, h) => { self.status = s; self.headers = h; };
  this.flushHeaders = () => {};
  this.write = (chunk) => { self.frames.push(String(chunk)); return true; };
  this.end = (b) => { self.writableEnded = true; if (b != null) self.frames.push(String(b)); };
  this.on = (ev, cb) => { if (ev === 'close' || ev === 'error') self._onClose = cb; };
  this.emitClose = () => { self.destroyed = true; if (self._onClose) self._onClose(); };
}

// 解析 SSE 帧：'event: <type>\ndata: <json>\n\n'；注释帧（': ...'）跳过
function parseFrames(res) {
  const out = [];
  for (const raw of res.frames) {
    const m = String(raw).match(/^event: ([A-Za-z]+)\ndata: (.+?)\n\n$/s);
    if (m) out.push({ event: m[1], data: JSON.parse(m[2]) });
  }
  return out;
}

async function until(fn, timeout = 3000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-stream-'));
const S = 's-stream';

test('S1 握手：Content-Type text/event-stream + 初始 heartbeat 帧', () => {
  const hub = createStreamHub({ root, heartbeatMs: 60 });
  const res = new FakeRes();
  const r = hub.subscribe(S, null, res);
  assert.equal(r.ok, true);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  const evs = parseFrames(res);
  assert.equal(evs[0].event, 'heartbeat', '订阅即推初始心跳帧');
  assert.ok(evs[0].data.ts, '心跳帧带 ts');
  hub.dispose();
});

test('S2 摘要推送：仅命中会话/批次的订阅者收到 {sessionId,batchId,eventCount,updatedAt}', () => {
  const hub = createStreamHub({ root });
  const list = new FakeRes();   // 列表流（batchId null）
  const detail = new FakeRes(); // 详情流（batchId=b1）
  const other = new FakeRes();  // 其他会话
  hub.subscribe(S, null, list);
  hub.subscribe(S, 'b1', detail);
  hub.subscribe('s-other', null, other);
  hub.notify(S, 'batch', 'b1', { eventCount: 7 });
  const l = parseFrames(list);
  const d = parseFrames(detail);
  assert.equal(l.some((f) => f.event === 'batch'), true, '列表流收到 batch 事件');
  const lf = l.find((f) => f.event === 'batch');
  assert.equal(lf.data.sessionId, S);
  assert.equal(lf.data.batchId, 'b1');
  assert.equal(lf.data.eventCount, 7);
  assert.ok(lf.data.updatedAt);
  assert.equal(d.find((f) => f.event === 'batch').data.batchId, 'b1');
  assert.equal(parseFrames(other).filter((f) => f.event === 'batch').length, 0, '其他会话不收到');
  hub.dispose();
});

test('S3 批次过滤：详情流订阅者不收到非本批次信号', () => {
  const hub = createStreamHub({ root });
  const detail = new FakeRes();
  hub.subscribe(S, 'b1', detail);
  hub.notify(S, 'batch', 'b2', { eventCount: 1 });
  assert.equal(parseFrames(detail).filter((f) => f.event === 'batch').length, 0, 'b1 订阅者不收到 b2 信号');
  hub.dispose();
});

test('S4 会话级连接上限（缺省 8，可覆盖）', () => {
  const hub = createStreamHub({ root, maxConns: 2 });
  const r1 = hub.subscribe(S, null, new FakeRes());
  const r2 = hub.subscribe(S, null, new FakeRes());
  assert.equal(r1.ok && r2.ok, true);
  const r3 = hub.subscribe(S, null, new FakeRes());
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'limit');
  // 其他会话不受影响
  const r4 = hub.subscribe('s-other', null, new FakeRes());
  assert.equal(r4.ok, true);
  hub.dispose();
});

test('S5 close 清理：res close → 订阅移除（计数回落），会话空 → watcher/会话拆除', () => {
  const hub = createStreamHub({ root });
  const a = new FakeRes();
  const b = new FakeRes();
  hub.subscribe(S, null, a);
  hub.subscribe(S, null, b);
  assert.equal(hub.stats().conns, 2);
  a.emitClose();
  assert.equal(hub.stats().conns, 1);
  b.emitClose();
  assert.equal(hub.stats().conns, 0);
  assert.equal(hub.stats().sessions, 0, '最后订阅者断开 → 会话拆除');
  hub.dispose();
});

test('S6 fs.watch 触发源：批次 JSON 落盘 → 防抖后推送摘要（eventCount 读物理事实源）', async () => {
  const hub = createStreamHub({ root, debounceMs: 50 });
  // 先建目录再订阅（watcher 挂载需要目录存在；目录后创建的兜底在 10s 心跳对齐时补挂）
  const bdir = path.join(root, 'sessions', S, 'batches');
  fs.mkdirSync(bdir, { recursive: true });
  const res = new FakeRes();
  hub.subscribe(S, 'b1', res);
  await new Promise((r) => setTimeout(r, 300)); // 等 watcher 挂载
  fs.writeFileSync(path.join(bdir, 'b1.json'), JSON.stringify({ batchId: 'b1', events: [{}, {}] }));
  const evs = await until(() => {
    const f = parseFrames(res).filter((x) => x.event === 'batch' && x.data.batchId === 'b1');
    return f.length ? f : null;
  });
  assert.ok(evs, 'fs.watch 变更应触发 batch 推送');
  assert.equal(evs[evs.length - 1].data.eventCount, 2, 'eventCount 读自批次文件 events.length');
  hub.dispose();
});

test('S7 topic 触发源（attachTopic）：payload 携带会话/批次 → 路由推送；主题名兜底解析', () => {
  const hub = createStreamHub({ root });
  hub.attachTopic('swarm.');
  const res = new FakeRes();
  hub.subscribe(S, 'b1', res);
  // ① payload 携带 ids（emitTopic 载荷形态）
  emitTopic('swarm.member.settled.' + S + '.b1', { sessionId: S, batchId: 'b1', eventCount: 5 });
  // ② payload 无 ids → 从主题名 swarm.<type>.<sid>.<bid> 尾部解析
  emitTopic('swarm.batch.phase.' + S + '.b1', {});
  const evs = parseFrames(res).filter((f) => f.event === 'batch');
  assert.equal(evs.length, 2);
  assert.equal(evs[0].data.eventCount, 5, 'payload eventCount 直传');
  assert.equal(evs[1].data.batchId, 'b1', '主题名兜底解析出 batchId');
  assert.equal(evs[1].data.sessionId, S);
  hub.dispose();
});

test('S8 topic 触发源隔离：非 swarm 前缀不触发 hub；attachTopic 退订后不再收到', () => {
  const hub = createStreamHub({ root });
  const un = hub.attachTopic('swarm.');
  const res = new FakeRes();
  hub.subscribe(S, 'b1', res);
  emitTopic('other.event.' + S + '.b1', { sessionId: S, batchId: 'b1' });
  assert.equal(parseFrames(res).filter((f) => f.event === 'batch').length, 0);
  emitTopic('swarm.batch.phase.' + S + '.b1', {});
  assert.equal(parseFrames(res).filter((f) => f.event === 'batch').length, 1);
  un();
  emitTopic('swarm.batch.phase.' + S + '.b1', {});
  assert.equal(parseFrames(res).filter((f) => f.event === 'batch').length, 1, '退订后不再收到');
  hub.dispose();
});

test('S9 心跳周期帧：heartbeatMs 覆盖下周期推送（生产缺省 10s，代码常量可查）', async () => {
  const hub = createStreamHub({ root, heartbeatMs: 80 });
  const res = new FakeRes();
  hub.subscribe(S, null, res);
  const n0 = parseFrames(res).filter((f) => f.event === 'heartbeat').length;
  await new Promise((r) => setTimeout(r, 250));
  const n1 = parseFrames(res).filter((f) => f.event === 'heartbeat').length;
  assert.ok(n1 > n0 + 1, '约 80ms 一帧心跳，250ms 内应多出 ≥2 帧（实际 ' + (n1 - n0) + '）');
  // 注释保活帧存在（: ping）
  assert.ok(res.frames.some((f) => String(f).startsWith(': ping')), '注释心跳帧 : ping 存在');
  hub.dispose();
});

test('S10 dispose：全清理（watcher/定时器/订阅）；dispose 后订阅拒绝', () => {
  const hub = createStreamHub({ root });
  hub.subscribe(S, null, new FakeRes());
  hub.dispose();
  assert.equal(hub.stats().conns, 0);
  const r = hub.subscribe(S, null, new FakeRes());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disposed');
});

test('S11 /stream 端点：无 session → 400；有 session → hub 订阅 + notify 帧可达（deps.panelStream 注入）', () => {
  const hub = createStreamHub({ root });
  const routes = [];
  const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
  const store = createStore(root);
  const api = createApi(ctx, { store, root, panelStream: hub });
  const route = routes.find((x) => x.path === '/api/dsh-punky-swarm/stream');
  assert.ok(route, '/stream 路由必须注册');
  // 无 session → 400 JSON
  const no = new FakeRes();
  route.handler({ url: '/api/dsh-punky-swarm/stream' }, no);
  assert.equal(no.status, 400);
  assert.ok(no.frames[0].includes('session required'));
  // 有 session → hub 接管（写入 SSE 握手）
  const res = new FakeRes();
  route.handler({ url: '/api/dsh-punky-swarm/stream?session=' + S + '&batchId=b1' }, res);
  assert.equal(res.status, 200);
  assert.equal(hub.stats().conns, 1);
  hub.notify(S, 'batch', 'b1', { eventCount: 9 });
  const evs = parseFrames(res).filter((f) => f.event === 'batch');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data.eventCount, 9);
  // api.dispose 不处置注入的 hub（归属装配点）
  api.dispose();
  assert.equal(hub.stats().conns, 1, '注入 hub 不被 api.dispose 释放');
  hub.dispose();
});

test('S12 /stream 端点缺省自建 hub：未注入 panelStream 时路由仍可用（自建 + dispose 归 api）', () => {
  const routes = [];
  const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
  const store = createStore(root);
  const api = createApi(ctx, { store, root });
  const route = routes.find((x) => x.path === '/api/dsh-punky-swarm/stream');
  assert.ok(route);
  const res = new FakeRes();
  route.handler({ url: '/api/dsh-punky-swarm/stream?session=' + S }, res);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  api.dispose(); // 自建 hub 随之 dispose（无泄漏）
});

test('S14 帧协议 event: mailbox：mailbox 变更信号推送（详情流监听侧回拉双 /mailbox）', () => {
  const hub = createStreamHub({ root });
  const res = new FakeRes();
  hub.subscribe(S, 'b1', res);
  hub.notify(S, 'mailbox', 'b1', { eventCount: 3 });
  const evs = parseFrames(res);
  const mb = evs.find((f) => f.event === 'mailbox');
  assert.ok(mb, 'mailbox 事件帧存在');
  assert.equal(mb.data.batchId, 'b1');
  assert.equal(mb.data.eventCount, 3);
  hub.dispose();
});

test('S15 8.3 短路径预判（hasShortNameSegment）：短路径段命中 → 规避 fs.watch；正常长路径不命中', () => {
  if (process.platform !== 'win32') return; // 短路径形态仅 Windows 判定
  assert.equal(hasShortNameSegment('C:\\Users\\ADMINI~1\\AppData\\Local\\Temp'), true, '8.3 段命中');
  assert.equal(hasShortNameSegment('C:\\Users\\Administrator\\.dsh\\punky-preset'), false, '长路径不命中');
  assert.equal(hasShortNameSegment('C:\\tmp\\foo~2\\bar'), true, '任意目录的 8.3 段命中');
  assert.equal(hasShortNameSegment('C:\\a\\b\\c'), false);
  assert.equal(hasShortNameSegment(''), false);
});

// ── BOM 读端容忍（2026-09-17 techdebt-bom-reader，缺陷回归锚 BOM-R*）──
// 缺陷（上游端到端实测复现）：批 JSON 若被外部工具（PowerShell `Set-Content -Encoding UTF8`）写带 UTF-8 BOM，
//   readEventCount 的裸 `JSON.parse(readFileSync(f,'utf8'))` 直接抛 SyntaxError（Node 不剥 U+FEFF），
//   被 `catch { return null }` 吞成 null ⇒ SSE batch 帧 eventCount 静默失效（无日志、无降级信号）。
// 修复：读端复用 lib/hot/config-watch.js 既有 stripBom（与 webui/runtime-config.js#readOverlay 同一单一实现，
//   禁第三份副本）。只放宽读端对 BOM 的容忍，不放宽任何校验（数组判定 / 存在性短路原样）。
const BOM = '\uFEFF';
const BS = 's-stream-bom';

function bomBatchFile(bid) {
  const dir = path.join(root, 'sessions', BS, 'batches');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, bid + '.json');
}
function writeBatchRaw(bid, text) {
  const f = bomBatchFile(bid);
  fs.writeFileSync(f, text, 'utf8');
  return f;
}
// 直调 notify 形态（非 S6 的 fs.watch + 挂载等待）：readEventCount 的取值发生在 notifyAll 内，
//   fs.watch 只决定触发时机；直调消除防抖/挂载时序导致的 flaky（同规格探针 D 段形态）。
function notifyEventCount(bid) {
  const hub = createStreamHub({ root });
  const res = new FakeRes();
  hub.subscribe(BS, bid, res);
  hub.notify(BS, 'batch', bid, {});
  hub.dispose();
  const f = parseFrames(res).filter((x) => x.event === 'batch' && x.data.batchId === bid);
  return f.length ? f[f.length - 1].data.eventCount : undefined;
}
const head3 = (f) => [...fs.readFileSync(f).subarray(0, 3)]
  .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

test('S16 BOM 读端（AC-1）：带 BOM 批 JSON ⇒ eventCount 为真实计数（非 null）', () => {
  const f = writeBatchRaw('bom-2', BOM + JSON.stringify({ batchId: 'bom-2', events: [{}, {}] }));
  assert.equal(head3(f), 'EF BB BF', '用例输入确带 UTF-8 BOM（防「没写进去却断言通过」）');
  assert.equal(notifyEventCount('bom-2'), 2, 'BOM 批 ⇒ eventCount === 2（严格数值，非 != null 弱断言）');
  // 同形无 BOM 对照：stripBom 对非 BOM 输入恒等返回 ⇒ 读数应与带 BOM 一致（恒等替换，非近似）
  writeBatchRaw('plain-2', JSON.stringify({ batchId: 'plain-2', events: [{}, {}] }));
  assert.equal(notifyEventCount('plain-2'), 2, '无 BOM 同形批 ⇒ 同样 2');
});

test('S17 BOM 读端反例（AC-1）：events:[] + BOM ⇒ 0（非 null）；BOM 但 events 非数组 ⇒ 仍 null', () => {
  writeBatchRaw('bom-empty', BOM + JSON.stringify({ batchId: 'bom-empty', events: [] }));
  assert.equal(notifyEventCount('bom-empty'), 0, '空数组是「空」不是「读失败」⇒ 严格 0，不得为 null');
  writeBatchRaw('bom-noev', BOM + JSON.stringify({ batchId: 'bom-noev' }));
  assert.equal(notifyEventCount('bom-noev'), null, 'events 缺失 ⇒ 仍 null（不放宽为 0）');
  writeBatchRaw('bom-evstr', BOM + JSON.stringify({ batchId: 'bom-evstr', events: 'nope' }));
  assert.equal(notifyEventCount('bom-evstr'), null, 'events 非数组 ⇒ 仍 null');
});

test('S18 读端反例（AC-2）：坏 JSON ⇒ 仍 null 且不向调用方抛错；批文件不存在 ⇒ 仍 null', () => {
  writeBatchRaw('bad-plain', '{ not-json');
  writeBatchRaw('bad-bom', BOM + '{ not-json');
  let v1;
  let v2;
  assert.doesNotThrow(() => { v1 = notifyEventCount('bad-plain'); }, '坏 JSON 不得向调用方抛错逃逸（catch 语义保留）');
  assert.doesNotThrow(() => { v2 = notifyEventCount('bad-bom'); }, '带 BOM 的坏 JSON 同样不抛错');
  assert.equal(v1, null, '坏 JSON ⇒ 仍 null');
  assert.equal(v2, null, '带 BOM 的坏 JSON ⇒ 仍 null');
  assert.equal(fs.existsSync(bomBatchFile('missing')), false, '前置：缺文件确不存在');
  assert.equal(notifyEventCount('missing'), null, '存在性短路路径不变 ⇒ null');
});

test('S19 静态（AC-4）：命名 stripBom 定义仍恰 2 处；stream.js 无内联 BOM 剥除副本', () => {
  const libDir = fileURLToPath(new URL('../lib/', import.meta.url));
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|ts)$/.test(e.name)) continue;
      if (/^export function stripBom\b/m.test(fs.readFileSync(p, 'utf8'))) {
        hits.push(path.relative(libDir, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(libDir);
  assert.deepEqual(hits.sort(), ['assembly/team-asset.js', 'hot/config-watch.js'], '禁第三份副本：命名定义仍恰 2 处');
  const src = fs.readFileSync(new URL('../lib/panel/stream.js', import.meta.url), 'utf8');
  assert.equal(src.includes('\\uFEFF'), false, 'stream.js 无 uFEFF 字面量内联');
  assert.equal(/charCodeAt\s*\(\s*0\s*\)/.test(src), false, 'stream.js 无 charCodeAt(0) 内联判断');
  assert.ok(src.includes("import { stripBom } from '../hot/config-watch.js'"), '唯一新增是复用 import');
  assert.ok(src.includes("JSON.parse(stripBom(readFileSync(f, 'utf8')))"), '读路径经 stripBom');
});
