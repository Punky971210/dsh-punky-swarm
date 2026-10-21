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

// watch 热更通道（新增；扩展生效面）：
//   装配级（apply + runtime.json 热写，镜像 governance-hotconfig/governance-preset-config 写法）断言
//   remountWatchEngine 生效——生效面 = 5 键 { enabled, longrun.enabled, scanIntervalMinutes,
//   longrun.maxDurationMs, longrun.noProgressWindowMs } 任一变化 → dispose+重建+重挂 timer+
//   更新 heartbeatRef/watchInstalledCfg（lib/index.js remountWatchEngine）。行为断言双通道：
//   (a) applied.watch（configEndpoints.appliedWatch = watchInstalledCfg 生效快照）经 GET /config 同步可查——
//       快照形状为 5 键全形（阈值随安装快照携带，供面板回显与确认轮询）；
//   (b) 引擎级 dispose+重建语义（longrun.enabled=false 重建 → tick 不产候选但 stalled 档存活）。
//   幂等（语义翻转，取代旧「阈值不在生效面」契约）：阈值 maxDurationMs/noProgressWindowMs 已纳入生效面——
//   阈值-only 热写触发 remount（新阈值即时生效）；同值重写 JSON 比较相等 → 幂等 no-op（零操作）。
//   disabled 状态对象：引擎缺失（watch 关/热关）时 lane_heartbeat/lane_longrun
//   查询返回 {enabled:false, reason:'watch-disabled', ...} 不 throw；beat=true 关闭态 no-op。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_LANE_LONGRUN_CANDIDATE, EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import { createLaneHeartbeat, createHeartbeatTools, createLongrunTools } from '../lib/watch/lane-heartbeat.js';
import * as mailbox from '../lib/comms/mailbox.js';
import { writeRuntime, assemblyCtxWeb } from './helpers/gate-fixture.mjs';

// 等待纪律（本批）：固定等待已全部替换为「到达（waitFor）+ 保持（waitQuiet）」双极；
//   迟到异常地平线 1500ms ⇒ 静默窗 quietMs 默认 1600ms（必须 > 1500ms）。
const MIN = 60_000;

// 有界轮询（H1 去 flake；形态判据源 = plan/scope.md §3.2，五字段诊断）：
//   条件达即返回；超时**失败并打印五个诊断字段** —— 让下次 flake 能自证是「等不够久」还是「条件真没发生」。
//   纪律：禁止写成「固定等一个更大的值」（那不是有界轮询，是换个数字复现同一个 bug）；
//   也禁止去掉间隔的忙等（必须 await intervalMs）。
async function waitFor(label, check, { timeoutMs = 4000, intervalMs = 25, expected = '' } = {}) {
  const startedAt = Date.now();
  let lastObserved;
  for (;;) {
    lastObserved = check();                       // 返回 truthy 即满足
    if (lastObserved) return lastObserved;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('waitFor timeout: ' + JSON.stringify({
        label, timeoutMs, elapsedMs: Date.now() - startedAt,
        lastObserved: String(lastObserved), expected,
      }));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// 静态保持（双极的「超了」侧）：读数在连续 quietMs 窗口内**不再变化**才返回最后读数；
//   任何一次变化都会重置静默计时并记入 changes（那是「迟到变化」的证据）；总等待超过 timeoutMs 仍不静默 ⇒ 抛错。
//   与 waitFor 分工不可互替：waitFor = 到达（正向），waitQuiet = 保持（反向）。
//   quietMs 默认 1600ms 必须 > 1500ms（变异注入的迟到地平线）。
async function waitQuiet(label, read, { quietMs = 1600, intervalMs = 25, timeoutMs = 6000, expected = '' } = {}) {
  const startedAt = Date.now();
  const changes = [];
  let last = read();
  let lastChangeAt = startedAt;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const now = read();
    if (now !== last) {
      changes.push({ at: Date.now() - startedAt, from: String(last), to: String(now) });
      last = now; lastChangeAt = Date.now();
    }
    if (Date.now() - lastChangeAt >= quietMs) return last;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('waitQuiet timeout: ' + JSON.stringify({
        label, timeoutMs, quietMs, elapsedMs: Date.now() - startedAt,
        lastObserved: String(last), changes, expected,
      }));
    }
  }
}

const CONFIG_PATH = '/api/dsh-punky-swarm/config';
const TRUSTED_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' };

// ── 装配级 fake ctx：`assemblyCtxWeb()` 基线 + `webServer`（返回 `{ ctx, routes }`）⇒ `routes` 供
//   GET /config 经 configEndpoints.appliedWatch 查 applied.watch 生效快照
//   （取自 'helpers/gate-fixture.mjs'；F4 收敛，原 11 份同名副本）

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-whc-'));
}


// remount 留痕日志行（'hot config: watch engine …'；初始 mount 为 'watch capability enabled' 不带此前缀）
const remountLines = (calls) => calls.info.filter((l) => l.includes('hot config: watch engine'));

function invoke(route, url, { method = 'GET', headers = TRUSTED_HEADERS } = {}) {
  let status = 0, resBody = null;
  const res = { writeHead(s) { status = s; }, end(b) { resBody = JSON.parse(b); } };
  const req = { url, method, headers };
  const ret = route.handler(req, res);
  if (ret && typeof ret.then === 'function') return ret.then(() => ({ status, body: resBody }));
  return { status, body: resBody };
}

// GET /config → body（overlay/overlayWatch/applied/presets；applied.watch = watchInstalledCfg 生效快照）
function getConfig(routes) {
  const route = routes.find((r) => r.path === CONFIG_PATH);
  assert.ok(route, '/config 已注册（webServer 注入面）');
  const r = invoke(route, CONFIG_PATH);
  assert.equal(r.status, 200, 'GET /config 200');
  return r.body;
}

// 装配级静态 config：watch 出厂默认开（enabled=true / longrun=true / scanIntervalMinutes=1）
function bareConfig(root) {
  return { root };
}

// 引擎级 seeding：批次直写补丁（镜像 IT-G 先例——setMember 的真实 settled ts 会覆盖伪造时间轴，
//   故 lanes/事件直接写文件）——running lane + 25min 前 dispatch（超 maxDuration 的旧 stint）
function seedOverdueStint(root, S, batchId, lane) {
  const aux = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: [{ id: lane, outputs: ['exec/' + lane + '/out.txt'], cmd: 'work' }] });
  aux.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  const bf = aux.batchFile(S, batchId);
  const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
  b.lanes[lane] = 'running'; // plan 初态 pending → running（直写）
  b.events.push({ ts: new Date(Date.now() - 25 * MIN).toISOString(), type: EVT_MEMBER_DISPATCH, lane, workerSessionId: 'w1' });
  fs.writeFileSync(bf, JSON.stringify(b, null, 2));
  return aux;
}
function candCount(store, S, batchId, lane) {
  return (store.readBatch(S, batchId)?.events ?? []).filter((e) => e.type === EVT_LANE_LONGRUN_CANDIDATE && e.lane === lane).length;
}
function inboxItems(root, S, batchId) {
  return mailbox.readUnacked(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'inbox' });
}

// ── H1 热更通道：longrun.enabled 翻转 → remountWatchEngine 重建（日志 + applied.watch 生效快照）──
test('H1 longrun.enabled 翻转热更即时：re-mounted 日志（longrun=false）+ GET applied.watch 生效快照更新', async () => {
  const root = freshRoot();
  writeRuntime(root, {}); // 预建 runtime.json（文件级 watch 需文件存在；初始 overlay {} 零变化）
  const { ctx, routes } = assemblyCtxWeb();
  const disposer = apply(ctx, bareConfig(root));
  try {
    // 基线等待：原「固定等 300ms」→ 有界轮询（条件达即返回）。
    //   boot 对账在 apply() 内**同步**完成（readRuntimeSnapshot → reconcile，config-watch.js:106）⇒ 本条件首轮即成立；
    //   因此这里的作用是「立刻确认出厂快照已就位 + 零 remount」，真正的等待在下方热更段（fs.watch 防抖 300ms）。
    await waitFor('h1-baseline', () => getConfig(routes).applied?.watch?.enabled === true && remountLines(ctx.calls).length === 0,
      { expected: 'applied.watch 出厂快照已就位 + boot 对账零 remount' });
    // 基线：出厂快照 5 键全形 {enabled:true, longrun:{enabled:true, maxDurationMs:1200000, noProgressWindowMs:300000},
    //   scanIntervalMinutes:1}；boot 对账幂等零 remount
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      'applied.watch 出厂快照含 7 键（阈值随 e2 生效面携带默认 1200000/300000 + D-4/D-2 两档 86400000/1800000）');
    assert.equal(remountLines(ctx.calls).length, 0, '快照与静态一致 → boot 对账 no-op（无 remount 日志）');
    // 热写 longrun.enabled:false → 生效面变化 → dispose+重建（re-mounted，logTag 缺省=热更路径）
    writeRuntime(root, { capabilities: { watch: { longrun: { enabled: false } } } });
    // 热更等待：原「固定等 1000ms」→ 有界轮询到 remount 留痕出现（fs.watch → 防抖 300ms → reload → onChange）。
    await waitFor('h1-remount', () => remountLines(ctx.calls).length >= 1,
      { expected: 're-mounted 日志恰 1（longrun=false 生效面）' });
    const lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1, 'remount 恰 1 行（实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.match(lines[0], /re-mounted \(scan 60000ms, longrun=false\)/, '重建日志含生效面（longrun=false）');
    assert.equal(lines[0].includes('[boot-overlay]'), false, '热更路径无 [boot-overlay] tag（区分启动对账）');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: false, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      'applied.watch 生效快照已随 remount 更新（watchInstalledCfg；enabled 翻转阈值保留默认）');
    assert.equal(ctx.calls.warn.length, 0, '热更路径零 warn');
    assert.equal(ctx.calls.error.length, 0, '热更路径零 error');
    // AC-6 可证伪自检：构造一次**真的会超时**的等待，验证诊断五字段
    //   （label / timeoutMs / elapsedMs / lastObserved / expected）确实落进错误文本——
    //   不靠注释声明，靠断言证明。构造预算 80ms（不拖慢用例），只验证 helper 的失败模式。
    await assert.rejects(
      () => waitFor('h1-timeout-probe', () => false, { timeoutMs: 80, intervalMs: 20, expected: '永不满足（构造超时）' }),
      (err) => {
        const msg = String(err && err.message);
        for (const field of ['label', 'timeoutMs', 'elapsedMs', 'lastObserved', 'expected']) {
          assert.ok(msg.includes('"' + field + '"'), '超时诊断缺字段 ' + field + '：' + msg);
        }
        assert.match(msg, /"label":"h1-timeout-probe"/, 'label 值回填（可据以定位是哪个等待点超时）');
        return true;
      },
    );
  } finally {
    disposer();
  }
});

// ── H2 watch.enabled 翻转既有语义回归（true→false 卸载 / false→true 重建，原 ① 通道统一进 remount）──
test('H2 watch.enabled 翻转语义回归：unmounted（dispose+清 timer）→ re-mounted（以合并快照重建）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx, routes } = assemblyCtxWeb();
  const disposer = apply(ctx, bareConfig(root));
  try {
    await waitFor('h2-baseline', () => getConfig(routes).applied?.watch?.enabled === true, { expected: true });
    await waitQuiet('h2-baseline-quiet', () => remountLines(ctx.calls).length, { expected: 0 });
    assert.equal(getConfig(routes).applied.watch.enabled, true, '出厂默认开');
    // ① enabled:false → unmounted（引擎 dispose + timer 清；工具查询 disabled——见 H5）
    writeRuntime(root, { capabilities: { watch: { enabled: false } } });
    await waitFor('h2-unmount', () => remountLines(ctx.calls).length === 1, { expected: 1 });
    const heldUnmount = await waitQuiet('h2-unmount-quiet', () => remountLines(ctx.calls).length, { expected: 1 });
    assert.equal(heldUnmount, 1, 'unmount 后 remount 计数稳定为 1（迟到第 2 次 ⇒ quiet 超时）');
    let lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /unmounted \(watch disabled\)/, 'enabled=false → unmounted 方向（实际: ' + lines[0] + '）');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: false, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      '关闭态 applied.watch.enabled=false（watchInstalledCfg 仍记快照全形含阈值，供面板回显）');
    // ② enabled:true → 以合并快照重建（re-mounted）
    writeRuntime(root, { capabilities: { watch: { enabled: true } } });
    await waitFor('h2-remount', () => remountLines(ctx.calls).length === 2, { expected: 2 });
    const heldRemount = await waitQuiet('h2-remount-quiet', () => remountLines(ctx.calls).length, { expected: 2 });
    assert.equal(heldRemount, 2, '二次重挂后计数稳定为 2（第 3 次 ⇒ quiet 超时）');
    lines = remountLines(ctx.calls);
    assert.equal(lines.length, 2, '二次 remount 留痕');
    assert.match(lines[1], /re-mounted/, 'enabled=true → re-mounted');
    assert.equal(getConfig(routes).applied.watch.enabled, true, '恢复默认开');
  } finally {
    disposer();
  }
});

// ── H3 scanIntervalMinutes 变更同通道热更 remount（生效面第 3 键）──
test('H3 scanIntervalMinutes 变更 → remount（scan 档期重挂）；applied.watch.scanIntervalMinutes 随动', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx, routes } = assemblyCtxWeb();
  const disposer = apply(ctx, bareConfig(root));
  try {
    await waitFor('h3-baseline', () => getConfig(routes).applied?.watch?.enabled === true, { expected: true });
    await waitQuiet('h3-baseline-quiet', () => remountLines(ctx.calls).length, { expected: 0 });
    // 热写 scanIntervalMinutes:0.5（watcher 白名单放行 capabilities.watch 深层；watch 级键仅手工 runtime.json 路径）
    writeRuntime(root, { capabilities: { watch: { scanIntervalMinutes: 0.5 } } });
    await waitFor('h3-scan', () => remountLines(ctx.calls).length === 1, { expected: 1 });
    const heldScan = await waitQuiet('h3-scan-quiet', () => remountLines(ctx.calls).length, { expected: 1 });
    assert.equal(heldScan, 1, 'scan 变化后计数稳定为 1（迟到第 2 次 ⇒ quiet 超时）');
    const lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1, 'scan 变化触发 remount（实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.match(lines[0], /re-mounted \(scan 30000ms, longrun=true\)/, '重挂档期 0.5min → 30000ms');
    assert.equal(getConfig(routes).applied.watch.scanIntervalMinutes, 0.5, '生效快照 scanIntervalMinutes 随动');
  } finally {
    disposer();
  }
});

// ── H4 语义翻转（watch-panel-wiring e2）：阈值已纳入生效面（第 4/5 键）——阈值-only 热更 →
//   remountWatchEngine 重建（remount 恰 1 次 + applied.watch 快照携带新阈值）；同值重写 → JSON 比较相等
//   → 幂等 no-op（对照 BO1-B 写法，动态热更路径）。分钟级测试值（60000=1min / 30000=30s）即 task 2
//   窗口生效正例的 remount 端证据；判定时机（引擎侧）见 watch-longrun.test.js T16（同阈值注入时钟）。
test('H4 阈值-only 热更即时 remount（语义翻转，取代旧「阈值留门零 remount」契约）：新阈值生效快照随动 + 同值重写幂等 no-op', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx, routes } = assemblyCtxWeb();
  const disposer = apply(ctx, bareConfig(root));
  try {
    await waitFor('h4-baseline', () => getConfig(routes).applied?.watch?.enabled === true, { expected: true });
    await waitQuiet('h4-baseline-quiet', () => remountLines(ctx.calls).length, { expected: 0 });
    // ① 热写阈值（分钟级：maxDurationMs 60000=1min / noProgressWindowMs 30000=30s）→ 生效面 5 键第 4/5 键变化
    //    → remount 恰 1 次（dispose 旧引擎 + 以合并快照 nextConfig 重建——新阈值经 createLaneHeartbeat
    //    resolveLongrunConfig 捕获，判定时机验证见 T16）
    writeRuntime(root, { capabilities: { watch: { longrun: { maxDurationMs: 60000, noProgressWindowMs: 30000 } } } });
    await waitFor('h4-threshold', () => remountLines(ctx.calls).length === 1, { expected: 1 });
    const heldThreshold = await waitQuiet('h4-threshold-quiet', () => remountLines(ctx.calls).length, { expected: 1 });
    assert.equal(heldThreshold, 1, '阈值变更后计数稳定为 1（迟到第 2 次 ⇒ quiet 超时）');
    const lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1, '阈值-only 变化现触发 remount（实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.match(lines[0], /re-mounted \(scan 60000ms, longrun=true\)/, '重建日志 re-mounted（阈值变化不翻 enabled/longrun/scan）');
    assert.equal(lines[0].includes('[boot-overlay]'), false, '热更路径无 [boot-overlay] tag');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 60000, noProgressWindowMs: 30000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      'applied.watch 生效快照随 remount 携带新阈值（watchInstalledCfg 7 键全形）');
    assert.equal(ctx.calls.warn.length, 0, '热更路径零 warn');
    assert.equal(ctx.calls.error.length, 0, '热更路径零 error');
    // ② 同值重写 → nextInstalled 与 watchInstalledCfg JSON 相等 → 幂等 no-op（零新增 remount，快照不变）
    writeRuntime(root, { capabilities: { watch: { longrun: { maxDurationMs: 60000, noProgressWindowMs: 30000 } } } });
    await waitFor('h4-idem', () => remountLines(ctx.calls).length === 1, { expected: 1 });
    const heldH4Idem = await waitQuiet('h4-idem-quiet', () => remountLines(ctx.calls).length, { quietMs: 1600, expected: 1 });
    assert.equal(heldH4Idem, 1, '同值重写幂等 no-op：remount 仍恰 1 次（迟到第 2 次 ⇒ quiet 超时，实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 60000, noProgressWindowMs: 30000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      '同值重写后生效快照不变');
    assert.equal(ctx.calls.warn.length, 0, '幂等路径零 warn');
    assert.equal(ctx.calls.error.length, 0, '幂等路径零 error');
  } finally {
    disposer();
  }
});

// ── H7（本批新增）D-4/D-2 两档开关纳入生效面（第 6/7 键）：热写 staleBatchMs/unconsumedTimeoutMs 变化 →
//   remountWatchEngine 重建（remount 恰 1 次 + applied.watch 快照携带新值）；**显式 0 = 关闭**同样是一次
//   有效生效变化（不是「非法回退默认」——否则逃生阀热更后静默无效）。──
test('H7 D-4/D-2 两档开关热更即时：staleBatchMs/unconsumedTimeoutMs 变化 → remount（快照 7 键随动）；显式 0 同样生效（逃生阀）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx, routes } = assemblyCtxWeb();
  const disposer = apply(ctx, bareConfig(root));
  try {
    const heldH7Baseline = await waitQuiet('h7-baseline-quiet', () => remountLines(ctx.calls).length, { expected: 0 });
    assert.equal(heldH7Baseline, 0, '基线 boot 对账 no-op（静默窗内迟到 remount ⇒ quiet 超时）');
    assert.equal(remountLines(ctx.calls).length, 0, '基线 boot 对账 no-op');
    // ① 热写 staleBatchMs=0（显式关闭僵尸批过滤）→ 生效面第 6 键变化 → remount 恰 1 次
    writeRuntime(root, { capabilities: { watch: { longrun: { staleBatchMs: 0 } } } });
    await waitFor('h7-stale', () => remountLines(ctx.calls).length === 1, { expected: 1 });
    const heldStale = await waitQuiet('h7-stale-quiet', () => remountLines(ctx.calls).length, { expected: 1 });
    assert.equal(heldStale, 1, 'staleBatchMs 变化后计数稳定为 1（迟到第 2 次 ⇒ quiet 超时）');
    let lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1, 'staleBatchMs 变化触发 remount（实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 0, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      '快照携带 staleBatchMs=0（显式 0 被当合法值透传，而非回退默认 24h）');
    // ② 热写 unconsumedTimeoutMs=60000（D-2 阈值收紧）→ 第 7 键变化 → 再 remount 1 次
    writeRuntime(root, { capabilities: { watch: { longrun: { staleBatchMs: 0, unconsumedTimeoutMs: 60000 } } } });
    await waitFor('h7-unconsumed', () => remountLines(ctx.calls).length === 2, { expected: 2 });
    const heldUnconsumed = await waitQuiet('h7-unconsumed-quiet', () => remountLines(ctx.calls).length, { expected: 2 });
    assert.equal(heldUnconsumed, 2, 'unconsumedTimeoutMs 后计数稳定为 2（第 3 次 ⇒ quiet 超时）');
    lines = remountLines(ctx.calls);
    assert.equal(lines.length, 2, 'unconsumedTimeoutMs 变化再次 remount');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 0, unconsumedTimeoutMs: 60000 }, scanIntervalMinutes: 1 },
      '两档新键均已纳入生效面（7 键全形随动）');
    assert.equal(ctx.calls.warn.length, 0, '热更路径零 warn');
    assert.equal(ctx.calls.error.length, 0, '热更路径零 error');
    // ③ 同值重写幂等：零新增 remount
    writeRuntime(root, { capabilities: { watch: { longrun: { staleBatchMs: 0, unconsumedTimeoutMs: 60000 } } } });
    await waitFor('h7-idem', () => remountLines(ctx.calls).length === 2, { expected: 2 });
    const heldH7Idem = await waitQuiet('h7-idem-quiet', () => remountLines(ctx.calls).length, { quietMs: 1600, expected: 2 });
    assert.equal(heldH7Idem, 2, '同值重写幂等 no-op（迟到第 3 次 ⇒ quiet 超时）');
  } finally {
    disposer();
  }
});

// ── H5 disabled 状态对象：引擎缺失（watch 关/热关）工具查询不 throw ──
function runningStore(root, S, batchId, lane) {
  const store = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: [{ id: lane, cmd: 'work' }] });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  store.setMember(S, batchId, lane, 'running');
  return store;
}
const EXEC = { agent: { session: { id: 'cli' } } }; // args.session 优先

test('H5a lane_heartbeat 引擎缺失 → disabled 状态对象（enabled:false reason:watch-disabled tracked:false）；beat=true no-op', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-whc-d1-'));
  const store = runningStore(root, 'sess-whc-d1', 'b-whc-d1', 'l1');
  const ctx = { tools: { register: () => {} } };
  // index 装配同形：getHeartbeat → heartbeatRef.current（热关后 = null）→ disabled 路径
  const [tool] = createHeartbeatTools(ctx, {
    store, root, mailbox,
    config: { capabilities: { watch: { enabled: true } } },
    getHeartbeat: () => null,
  });
  assert.ok(tool, 'watch enabled 静态 → lane_heartbeat 注册');
  const eventsBefore = store.readBatch('sess-whc-d1', 'b-whc-d1').events.length;
  const q = await tool.execute({ batchId: 'b-whc-d1', lane: 'l1', session: 'sess-whc-d1' }, EXEC);
  assert.equal(q.sessionId, 'sess-whc-d1');
  assert.equal(q.lanes.length, 1);
  const row = q.lanes[0];
  assert.equal(row.laneKey, 'sess-whc-d1/b-whc-d1/l1');
  assert.equal(row.enabled, false);
  assert.equal(row.reason, 'watch-disabled');
  assert.equal(row.tracked, false);
  assert.equal(row.missed, 0);
  assert.equal(row.stalled, false);
  assert.equal(row.pendingProbeId, null);
  assert.equal(row.lastActivityAt, null);
  // beat=true 关闭态 no-op（引擎 null → 不 tick），查询仍安全返回，零状态副作用
  const qb = await tool.execute({ batchId: 'b-whc-d1', lane: 'l1', session: 'sess-whc-d1', beat: true }, EXEC);
  assert.equal(qb.lanes[0].reason, 'watch-disabled');
  assert.equal(qb.lanes[0].tracked, false);
  const eventsAfter = store.readBatch('sess-whc-d1', 'b-whc-d1').events.length;
  assert.equal(eventsAfter, eventsBefore, 'beat no-op：零事件副作用（tick 未跑）');
});

test('H5b lane_heartbeat 引擎缺失 + 缺省 lane → 每 running lane 一 disabled 行（与引擎开同形，reason 区分）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-whc-d2-'));
  const S = 'sess-whc-d2';
  const store = runningStore(root, S, 'b-whc-d2', 'l1');
  const ctx = { tools: { register: () => {} } };
  const [tool] = createHeartbeatTools(ctx, {
    store, root, mailbox,
    config: { capabilities: { watch: { enabled: true } } },
    getHeartbeat: () => null,
  });
  const q = await tool.execute({ batchId: 'b-whc-d2', session: S }, EXEC);
  assert.equal(q.lanes.length, 1, 'running lane 每行 disabled');
  assert.equal(q.lanes[0].lane, 'l1');
  assert.equal(q.lanes[0].enabled, false);
  assert.equal(q.lanes[0].reason, 'watch-disabled');
});

test('H5c lane_longrun 引擎缺失 → disabled 状态对象（含 longrun 域字段候选/阈值 null）；beat=true no-op', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-whc-d3-'));
  const S = 'sess-whc-d3';
  const store = runningStore(root, S, 'b-whc-d3', 'l1');
  const ctx = { tools: { register: () => {} } };
  const tools = createLongrunTools(ctx, {
    store, root, mailbox,
    config: { capabilities: { watch: { enabled: true, longrun: { enabled: true } } } },
    getHeartbeat: () => null,
  });
  assert.equal(tools.length, 1, 'longrun enabled 静态 → lane_longrun 注册');
  const [tool] = tools;
  const q = await tool.execute({ batchId: 'b-whc-d3', lane: 'l1', session: S, beat: true }, EXEC);
  const row = q.lanes[0];
  assert.equal(row.enabled, false);
  assert.equal(row.reason, 'watch-disabled');
  assert.equal(row.tracked, false);
  assert.equal(row.candidate, false);
  assert.equal(row.emitted, false);
  assert.equal(row.maxDurationMs, null);
  assert.equal(row.noProgressWindowMs, null);
  assert.equal(row.runningSince, null);
  assert.equal(row.checkpointFresh, false);
  assert.equal(row.activityFresh, false);
  assert.equal(q.lanes.length, 1);
});

test('H5d getHeartbeat 执行时解引用：返回活引擎 → 查询走真实引擎（非 disabled）；修复旧实例闭包路径回归', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-whc-d4-'));
  const S = 'sess-whc-d4';
  const store = runningStore(root, S, 'b-whc-d4', 'l1');
  const engine = createLaneHeartbeat({ store, mailbox, config: { capabilities: { watch: { enabled: true } } }, root });
  engine.tick(); // 首拍建心跳 entry（missed 0；新派发宽限不追问）
  const ref = { current: engine };
  const ctx = { tools: { register: () => {} } };
  const [tool] = createHeartbeatTools(ctx, {
    store, root,
    config: { capabilities: { watch: { enabled: true } } },
    heartbeat: engine,
    getHeartbeat: () => ref.current, // index 装配注入形态：heartbeatRef.current 执行时解引用
  });
  const q = await tool.execute({ batchId: 'b-whc-d4', lane: 'l1', session: S }, EXEC);
  const row = q.lanes[0];
  assert.equal(row.tracked, true, '活引擎路径返回真实心跳状态');
  assert.equal(row.enabled, undefined, '真实 status 行无 enabled 键（disabled 以 reason 区分，非此路径）');
  assert.notEqual(row.reason, 'watch-disabled');
  // 热重建模拟：ref.current 指向新引擎实例 → 工具自动跟随（执行时解引用，不绑创建时旧实例）
  const engine2 = createLaneHeartbeat({ store, mailbox, config: { capabilities: { watch: { enabled: true } } }, root });
  engine2.tick();
  ref.current = engine2;
  const q2 = await tool.execute({ batchId: 'b-whc-d4', lane: 'l1', session: S }, EXEC);
  assert.equal(q2.lanes[0].tracked, true, '热重建后工具跟随新实例（经 getHeartbeat 解引用）');
  engine.dispose();
  engine2.dispose();
});

// ── H6 热重建语义行为（引擎级，dispose+重建镜像 remountWatchEngine）：longrun.enabled=false 重建 → ──
//    tick 不产候选（长跑探针停扫）但 stalled 档存活（watch 引擎仍在扫描）——「候选不再产」行为证据
test('H6 重建语义行为：longrun.enabled=false 新引擎 tick 零候选（事件流不变）；心跳档仍活（探针照发）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-whc-rb-'));
  // 引擎 e1（出厂默认开）：旧 stint 超时 → 产候选（重建前基线）
  const S = 'sess-whc-rb';
  const st1 = seedOverdueStint(root, S, 'b-rb1', 'l1');
  const e1 = createLaneHeartbeat({ store: st1, mailbox, config: {}, root });
  e1.tick();
  assert.equal(candCount(st1, S, 'b-rb1', 'l1'), 1, '重建前（longrun 默认开）tick 产候选');
  e1.dispose(); // remountWatchEngine 语义：dispose 旧引擎
  // 引擎 e2（longrun.enabled=false 重建，镜像热更合并快照）：新批次旧 stint → tick 零候选
  const st2 = createStore(root);
  const st2Seed = seedOverdueStint(root, S, 'b-rb2', 'l1');
  const e2 = createLaneHeartbeat({
    store: st2, mailbox, root,
    config: { capabilities: { watch: { enabled: true, longrun: { enabled: false }, intervalsMinutes: [0, 0, 0], maxMissed: 3 } } },
  });
  e2.tick();
  assert.equal(candCount(st2Seed, S, 'b-rb2', 'l1'), 0, 'longrun.enabled=false → tick 不产候选（长跑探针停扫）');
  assert.equal(candCount(st1, S, 'b-rb1', 'l1'), 1, '既有候选不被新引擎追加/清除');
  // stalled 档存活佐证：0ms 档位下 tick 已跑心跳扫描 → inbox 追问照发（引擎活着，只是 longrun 门控关）
  const probes = inboxItems(root, S, 'b-rb2').filter((m) => m.message?.kind === 'probe' && m.message.lane === 'l1');
  assert.ok(probes.length >= 1, '心跳档仍活（探针照发）——证明 tick 已执行而 longrun 判定被门控（实际: ' + probes.length + '）');
});
