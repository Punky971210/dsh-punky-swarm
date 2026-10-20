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

// `rt` 真源写面单测（batch `punky-w7f-20261020` · lane `e2-w7f-test`）
//
// 判据源：`plan/scope.md` §6（L1/L2/L3 三层）、§8（测试面）、AC-2/3/4/5/6/7/9/11/18
//         ＋ `plan/rt-write-observability.md` §1.1（八写集 → 期望写序列）/ §4（断言形态 + 阴性对照）
//
// **本件存在的唯一理由**：`end-state 同构`（只写一个字段 vs 同步多写一个字段）普通探针**区分不了**。
//   举例：设 ⑤ 分支多写一行 `rt.watchTimer = null;`（该字段当时本来就是 null）——
//     · 终态（`appliedWatch` / `liveTimers()` / dispose 后计数）：正确实现与双写实现**完全一致**；
//     · **写序列**（本件）：正确 `[governanceHook, governanceInstalledCfg]` vs 双写「多一项 watchTimer」。
//   ⇒ 序列判据是本批「单写 vs 双写可区分」的**唯一**可判面（L1 静态 + L2 痕迹为补充，三层不得互相冒充）。
//
// 断言纪律（AC-18）：每条「0 次 / 为空 / 不变 / 不抛 / disabled / 超时」断言，**同一测试内**都先做
//   一次同输入阳性（先 1 次 / 非空 / 变化 / 可触发 / 阈值内可观测），否则该断言在「实现根本没跑」时也成立。
//
// 盲区纪律（d1 §3 / impl §9，**不得越界写成序列断言**）：
//   · B-2 `heartbeatRef.current`（对象属性写）与 B-3 `topicSink.emit`（调用非赋值）⇒ 走 L2，不进序列；
//   · B-1/B-7：序列只有字段名 ⇒ **一次只改一个分支**（跨分支拼接不可归因）；
//   · B-5 `acpsEndpoint.close()` 异步（R-a）⇒ 不作序列断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';
import { createStore } from '../lib/state/store.js';
import { writeRuntime, assemblyCtxEffect } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_JS = path.join(PKG_ROOT, 'lib', 'index.js');
const INDEX_SRC = fs.readFileSync(INDEX_JS, 'utf8');

const CONFIG_PATH = '/api/dsh-punky-swarm/config';
const TRUSTED_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' };

// ── rt 冻结字段集（plan/scope.md §3.1，20 项；集合相等判据）────────────────────────────
const RT_FIELDS_20 = [
  'hotConfig', 'watchTimer', 'sweepTimer', 'heartbeat', 'heartbeatRef',
  'watchInstalledCfg', 'apiDispose', 'trajectory', 'topicRuntime', 'topicAttachUn',
  'panelStream', 'verifyMount', 'governanceHook', 'governanceInstalledCfg',
  'dispatchReg', 'autoSettle', 'autoSettleEnabled', 'laneWake', 'acpsEndpoint',
  'lastRatchetJson',
];

// ── 八写集冻结集（p1 §3.2 可判核心 + dispose；②③④ 见 T-3 的 log-level 段）───────────
const WRITE_SETS = {
  '⑤ governance': ['governanceHook', 'governanceInstalledCfg'],
  '⑥ autoSettle': ['autoSettle', 'laneWake', 'autoSettleEnabled'],
  'dispose': ['watchTimer', 'sweepTimer', 'topicAttachUn', 'panelStream', 'acpsEndpoint'],
};

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-w7f-surface-'));
}

/** 有界等待（禁裸 sleep；谓词满足即返回，超时返回 false 由调用方判红）。 */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 写 runtime.json（与 fixture 同一落盘形态；热更触发源 = fs.watch 防抖 300ms）。 */
const writeRuntimeJson = (root, overlay) => writeRuntime(root, overlay);

/**
 * 深合并一行 overlay 后再落盘。
 * ⚠ 必须用它（而不是直接 `writeRuntimeJson`）**串联多个窗口**：`writeRuntime` 是**整文件覆盖**
 *   （`fs.writeFileSync(JSON.stringify(overlay))`）⇒ 第二窗口若只写自己的键，第一窗口的关闭会被
 *   静默回滚，于是「上一分支恢复」会在本窗口多写一次他分支字段 —— 那会伪装成「双写」（B-1/B-7 的同族坑）。
 *   本 lane 首轮即踩中：② 关 trajectory 后，④ 只写 verify ⇒ trajectory 被重新打开 ⇒ ④ 窗口序列成
 *   `['trajectory','verifyMount']`（实测）。**这不是产品缺陷，是测试夹具用法**。
 */
function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)
      && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else base[k] = v;
  }
  return base;
}

const watchRemountLines = (calls) => calls.info.filter((l) => l.includes('hot config: watch engine'));
const govRemountLines = (calls) => calls.info.filter((l) => l.includes('hot config: governance hook'));
const autoSettleLines = (calls) => calls.info.filter((l) => l.includes('hot config: auto-settle'));
const ratchetWarns = (calls) => calls.warn.filter((l) => l.includes('hot config: 棘轮') || l.includes('ratchet'));

/** 多重集相等（字段名多重集；顺序敏感的场景另用 deepEqual）。 */
const MULTISET_EQUAL = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function getConfig(routes) {
  const route = routes.find((r) => r.path === CONFIG_PATH);
  assert.ok(route, '阳性前置：/config 路由须已注册');
  let status = 0, body = null;
  const res = { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
  route.handler({ url: CONFIG_PATH, method: 'GET', headers: TRUSTED_HEADERS }, res);
  assert.equal(status, 200, 'GET /config 须 200');
  return body;
}

/** 取走并清空该窗口的写序列（每个分支窗口前清一次：B-1/B-7 —— 窗口外不归因）。 */
const takeSeq = (ctx) => (ctx.rtWriteLog ?? []).splice(0);

// ══════════════════════════════════════════════════════════════════════════════════════
// T-1 L1 静态写集（AC-2 / AC-3；源码面，不跑运行期）
//   阳性对照：字段集非空 + 每个扫描窗口内 `rt.*` 写点计数 > 0（否则「集合相等」在没扫到任何东西时也成立）。
// ══════════════════════════════════════════════════════════════════════════════════════
test('T-1 L1 静态写集：rt 字段集恰 20、八写集与冻结集集合相等、apply 内旧 let 残留 0', () => {
  // ① `createRuntimeState` 的 base 字面量键集 == 20 项冻结集
  const baseStart = INDEX_SRC.indexOf('const createRuntimeState = (onWrite) => {');
  assert.ok(baseStart > 0, '阳性前置：createRuntimeState 定义须在场');
  const baseSeg = INDEX_SRC.slice(baseStart, baseStart + 1200);
  const baseObj = baseSeg.slice(baseSeg.indexOf('const base = {'), baseSeg.indexOf('};', baseSeg.indexOf('const base = {')));
  const keys = [...baseObj.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*null/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, '阳性前置：base 字面量须能扫出键（否则「集合相等」空转）');
  assert.equal(keys.length, 20, 'rt 字段数须恰 20（实测 ' + keys.length + '）');
  assert.deepEqual([...keys].sort(), [...RT_FIELDS_20].sort(), 'rt 字段集须与冻结 20 项集合相等');

  // ② seam 四要素（d1 §5 接口约定硬要求）
  assert.equal((INDEX_SRC.match(/if \(typeof onWrite !== 'function'\) return base;/g) ?? []).length, 1,
    'seam 早退须恰 1 处（生产零路径的唯一证据）');
  assert.equal((INDEX_SRC.match(/new Proxy\(/g) ?? []).length, 1, 'new Proxy( 须恰 1 处');
  assert.equal(INDEX_SRC.includes('rtWriteLog'), true, 'seam 读取位须在场');

  // ③ apply 内旧 `let <句柄>` 残留 == 0（AC-2；B-4 的兜底）
  const applyStart = INDEX_SRC.indexOf('export const apply = (ctx, config = {}) => {');
  const applySrc = INDEX_SRC.slice(applyStart);
  const HANDLES = RT_FIELDS_20.filter((f) => f !== 'hotConfig' && f !== 'heartbeatRef'); // heartbeatRef 不是 let 句柄
  const residual = HANDLES.filter((h) => new RegExp('let\\s+' + h + '\\b').test(applySrc));
  assert.deepEqual(residual, [], 'apply 内旧 let 句柄残留须为 0（实测 ' + JSON.stringify(residual) + '）');

  // ④ 分支窗口静态写集（在**各自工厂体内**扫 `rt.<field> =`）
  const fnBody = (signature) => {
    const s = INDEX_SRC.indexOf(signature);
    assert.ok(s > 0, '阳性前置：工厂须在场：' + signature);
    // 取到下一个顶层 `\n};` 或 `\nexport ` 之前的文本（工厂体）
    const rest = INDEX_SRC.slice(s);
    const end = rest.indexOf('\n};');
    return end > 0 ? rest.slice(0, end) : rest;
  };
  const writesIn = (body) => [...body.matchAll(/\brt\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]);
  const uniq = (arr) => [...new Set(arr)].sort();

  const setters = fnBody('const createAutoSettleRemounter =');
  const setterWrites = uniq(writesIn(setters));
  assert.ok(setterWrites.length > 0, '阳性前置：⑥ 工厂内须扫出写点');
  assert.deepEqual(setterWrites, [...WRITE_SETS['⑥ autoSettle']].sort(),
    '⑥ 静态写集须 == {autoSettle, laneWake, autoSettleEnabled}（实测 ' + JSON.stringify(setterWrites) + '）');

  const rel = fnBody('const releaseAll = (rt) => {');
  const relWrites = uniq(writesIn(rel));
  assert.ok(relWrites.length > 0, '阳性前置：releaseAll 内须扫出写点');
  assert.deepEqual(relWrites, [...WRITE_SETS.dispose].sort(),
    'dispose 静态写集须 == 5 项置空（实测 ' + JSON.stringify(relWrites) + '）');

  const remount = fnBody('const mountRemounters = (');
  const remountWrites = uniq(writesIn(remount));
  assert.ok(remountWrites.length > 0, '阳性前置：mountRemounters 内须扫出写点');
  // ① 与 ⑤ 共用本工厂（B-1：静态不可按分支拆 ⇒ 只断言并集；分支归属由 T-3 的运行期序列给出）
  assert.deepEqual(remountWrites,
    ['governanceHook', 'governanceInstalledCfg', 'heartbeat', 'watchInstalledCfg', 'watchTimer'].sort(),
    '①∪⑤ 静态写集须 == 5 项（实测 ' + JSON.stringify(remountWrites) + '）');

  const hot = fnBody('const mountHotConfigRuntime = (');
  const hotWrites = uniq(writesIn(hot));
  assert.ok(hotWrites.length > 0, '阳性前置：mountHotConfigRuntime 内须扫出写点');
  assert.deepEqual(hotWrites,
    ['hotConfig', 'lastRatchetJson', 'topicAttachUn', 'topicRuntime', 'trajectory', 'verifyMount'].sort(),
    '⓪②③④ 静态写集须 == 6 项（实测 ' + JSON.stringify(hotWrites) + '）');

  // ⑤ 全文 `rt.<field> =` 写点总数（回归锚；`impl-w7f.md §3` 报 34，本件独立复算）
  const allWrites = [...INDEX_SRC.matchAll(/\brt\.[A-Za-z_$][\w$]*\s*=/g)].length;
  assert.equal(allWrites, 34, '全文 rt.* 赋值须恰 34 处（实测 ' + allWrites + '）');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// T-2 L2 运行期痕迹（AC-5 / AC-6 / AC-7 / P-8 / P-9①）
//   阳性对照：清账前先断言「装配后 preCount=1 / subagent-end>0 / liveTimers≥1 / 热更 2/2 触发」。
// ══════════════════════════════════════════════════════════════════════════════════════
test('T-2 L2 痕迹：释放账目 1/2/1 → 0/0/0、dispose 后热更不再触发、二次 dispose 幂等', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  // 定时器账本：测试侧计量（不改产品源码）
  const origSet = globalThis.setInterval;
  const origClear = globalThis.clearInterval;
  const live = new Set();
  globalThis.setInterval = (...a) => { const id = origSet(...a); live.add(id); return id; };
  globalThis.clearInterval = (id) => { live.delete(id); return origClear(id); };
  const { ctx } = assemblyCtxEffect();
  ctx.rtWriteLog = [];
  let disposer;
  try {
    disposer = apply(ctx, { root });
    // ① 阳性基线
    assert.equal(ctx.preCount(), 1, '①阳性 装配后 preCount=1');
    const subBefore = ctx.listeners.get('subagent/end')?.size ?? 0;
    assert.ok(subBefore > 0, '①阳性 装配后须有 subagent/end 订阅（实测 ' + subBefore + '）');
    assert.ok(live.size >= 1, '①阳性 装配后须有活定时器（实测 ' + live.size + '）');
    // 热更 2/2 可触发（P-7 阳性）
    writeRuntimeJson(root, { governance: { hook: { enabled: false } } });
    const hot1 = await waitFor(() => govRemountLines(ctx.calls).length >= 1);
    assert.equal(hot1, true, '①阳性 dispose 前热更 #1 须触发');
    writeRuntimeJson(root, { capabilities: { watch: { scanIntervalMinutes: 3 } } });
    const hot2 = await waitFor(() => watchRemountLines(ctx.calls).length >= 1);
    assert.equal(hot2, true, '①阳性 dispose 前热更 #2 须触发');

    // ② dispose 清账（AC-5：1 / 2 / 1 → 0 / 0 / 0）
    takeSeq(ctx);
    disposer();
    assert.equal(ctx.preCount(), 0, '② dispose 后 preCount 须为 0');
    assert.equal(ctx.listeners.get('subagent/end')?.size ?? 0, 0, '② dispose 后 subagent/end 订阅须为 0');
    assert.equal(live.size, 0, '② dispose 后活定时器须为 0（实测 ' + live.size + '）');
    const disposeSeq = takeSeq(ctx);
    assert.ok(disposeSeq.length > 0, '② dispose 须产生写（阳性：否则「⊆ 5 项」空转）');
    const foreign = disposeSeq.filter((k) => !WRITE_SETS.dispose.includes(k));
    assert.deepEqual(foreign, [], '② dispose 写集须 ⊆ 5 项置空（实测外来项 ' + JSON.stringify(foreign) + '）');

    // ③ dispose 后热更不再触发（P-7 阴性侧；阳性 = ①的 2/2）
    const govBefore = govRemountLines(ctx.calls).length;
    writeRuntimeJson(root, { governance: { hook: { enabled: true } } });
    const fired = await waitFor(() => govRemountLines(ctx.calls).length > govBefore, { timeoutMs: 1500 });
    assert.equal(fired, false, '③ dispose 后热更不得再触发（实测仍触发 = hotConfig 未释放）');

    // ④ 二次 dispose 幂等（P-9①）
    assert.doesNotThrow(() => disposer(), '④ 二次 dispose 不得抛');
    assert.deepEqual(takeSeq(ctx), [], '④ 二次 dispose 不得产生新写');
  } finally {
    globalThis.setInterval = origSet;
    globalThis.clearInterval = origClear;
  }
});

test('T-2b P-8 实例隔离：两次 apply 各自独立 rt，互不影响（一笔 dispose 后另一笔仍可热更）', async () => {
  const rootA = freshRoot();
  const rootB = freshRoot();
  writeRuntime(rootA, {});
  writeRuntime(rootB, {});
  const a = assemblyCtxEffect();
  const b = assemblyCtxEffect();
  a.ctx.rtWriteLog = [];
  b.ctx.rtWriteLog = [];
  const dA = apply(a.ctx, { root: rootA });
  const dB = apply(b.ctx, { root: rootB });
  try {
    // 阳性：两笔装配都写满了 20 字段（各自 sink 独立、互不污染）
    assert.equal(a.ctx.rtWriteLog.length, 20, 'P-8 阳性：A 实例装配写 20 次（实测 ' + a.ctx.rtWriteLog.length + '）');
    assert.equal(b.ctx.rtWriteLog.length, 20, 'P-8 阳性：B 实例装配写 20 次（实测 ' + b.ctx.rtWriteLog.length + '）');
    takeSeq(a.ctx); takeSeq(b.ctx);
    // 变更 A ⇒ 只有 A 的 sink 增长
    writeRuntimeJson(rootA, { capabilities: { watch: { scanIntervalMinutes: 4 } } });
    const okA = await waitFor(() => a.ctx.rtWriteLog.length > 0);
    assert.equal(okA, true, 'P-8 A 实例须响应自身热更');
    assert.equal(b.ctx.rtWriteLog.length, 0, 'P-8 B 实例不得被 A 的热更写入（实测 ' + JSON.stringify(b.ctx.rtWriteLog) + '）');
    // A 释放后，B 仍可热更（阳性对照）
    dA();
    writeRuntimeJson(rootB, { capabilities: { watch: { scanIntervalMinutes: 5 } } });
    const okB = await waitFor(() => watchRemountLines(b.ctx.calls).length >= 1);
    assert.equal(okB, true, 'P-8 A 释放后 B 仍须可热更（实例隔离）');
  } finally {
    dB();
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// T-3 六分支写序列（L3 核心；窗口 = 一次只改一个分支 —— B-1/B-7）
//   每条「序列相等」的阳性对照 = 同一窗口「序列非空」+ 期望多重集本身非空。
// ══════════════════════════════════════════════════════════════════════════════════════
test('T-3 ⓪ ratchet：写集恰 {lastRatchetJson}，同值二次 ⇒ 0 次写（阳性在前）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx } = assemblyCtxEffect();
  ctx.rtWriteLog = [];
  const disposer = apply(ctx, { root });
  try {
    takeSeq(ctx);
    writeRuntimeJson(root, { ratchet: { allowRelax: true } });
    const ok = await waitFor(() => ratchetWarns(ctx.calls).length >= 1);
    assert.equal(ok, true, '⓪ 阳性：棘轮变更须落 warn');
    const seq = takeSeq(ctx);
    assert.deepEqual(seq, ['lastRatchetJson'], '⓪ 写序列须恰 [lastRatchetJson]（实测 ' + JSON.stringify(seq) + '）');
    // 幂等：同值二次 ⇒ 0 次写（阳性 = 上面已 1 次）
    const warnBefore = ratchetWarns(ctx.calls).length;
    writeRuntimeJson(root, { ratchet: { allowRelax: true } });
    const rewarn = await waitFor(() => ratchetWarns(ctx.calls).length > warnBefore, { timeoutMs: 1200 });
    assert.equal(rewarn, false, '⓪ 同值二次不得再 warn');
    assert.deepEqual(takeSeq(ctx), [], '⓪ 同值二次须 0 次写（实测 ' + JSON.stringify(takeSeq(ctx)) + '）');
  } finally {
    disposer();
  }
});

test('T-3 ① watch：写序恰 5 项 [watchTimer,heartbeat,heartbeat,watchTimer,watchInstalledCfg]，无他分支字段', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx } = assemblyCtxEffect();
  ctx.rtWriteLog = [];
  const disposer = apply(ctx, { root });
  try {
    takeSeq(ctx);
    writeRuntimeJson(root, { capabilities: { watch: { scanIntervalMinutes: 3 } } });
    const ok = await waitFor(() => watchRemountLines(ctx.calls).length >= 1);
    assert.equal(ok, true, '① 阳性：watch 热更须触发 remount');
    const seq = takeSeq(ctx);
    assert.equal(seq.length > 0, true, '① 阳性：写序列须非空');
    assert.deepEqual(seq, ['watchTimer', 'heartbeat', 'heartbeat', 'watchTimer', 'watchInstalledCfg'],
      '① 写序须恰 5 项且顺序固定（实测 ' + JSON.stringify(seq) + '）');
    const foreign = seq.filter((k) => !['heartbeat', 'watchTimer', 'watchInstalledCfg'].includes(k));
    assert.deepEqual(foreign, [], '① 窗口内出现其它分支字段 = 双写（实测 ' + JSON.stringify(foreign) + '）');
    // 无他分支日志（窗口纪律旁证）
    assert.equal(govRemountLines(ctx.calls).length, 0, '① 窗口不得同时触发 ⑤（Boot 对账已 no-op）');
  } finally {
    disposer();
  }
});

test('T-3 ⑤ governance：写序恰 [governanceHook, governanceInstalledCfg] 且顺序固定', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx, routes } = assemblyCtxEffect();
  ctx.rtWriteLog = [];
  const disposer = apply(ctx, { root });
  try {
    takeSeq(ctx);
    writeRuntimeJson(root, { governance: { hook: { enabled: false } } });
    const ok = await waitFor(() => govRemountLines(ctx.calls).length >= 1);
    assert.equal(ok, true, '⑤ 阳性：governance 热更须触发 remount');
    const seq = takeSeq(ctx);
    assert.deepEqual(seq, ['governanceHook', 'governanceInstalledCfg'],
      '⑤ 写序须恰 2 项且顺序固定（实测 ' + JSON.stringify(seq) + '）');
    // L2 旁证：生效快照随动
    assert.equal(getConfig(routes).applied.hook.enabled, false, '⑤ applied.hook.enabled 须随动为 false');
    assert.equal(watchRemountLines(ctx.calls).length, 0, '⑤ 窗口不得同时触发 ①');
  } finally {
    disposer();
  }
});

test('T-3 ⑥ autoSettle：写序恰 [autoSettle, laneWake, autoSettleEnabled]', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx } = assemblyCtxEffect();
  ctx.rtWriteLog = [];
  const disposer = apply(ctx, { root });
  try {
    takeSeq(ctx);
    writeRuntimeJson(root, { autoSettle: { enabled: false } });
    const ok = await waitFor(() => autoSettleLines(ctx.calls).length >= 1);
    assert.equal(ok, true, '⑥ 阳性：autoSettle 翻转须落日志');
    const seq = takeSeq(ctx);
    assert.deepEqual(seq, ['autoSettle', 'laneWake', 'autoSettleEnabled'],
      '⑥ 写序须恰 3 项且顺序固定（实测 ' + JSON.stringify(seq) + '）');
    // 幂等：同值重写 ⇒ 0 次写（阳性 = 上面已 1 次）
    const linesBefore = autoSettleLines(ctx.calls).length;
    writeRuntimeJson(root, { autoSettle: { enabled: false } });
    const again = await waitFor(() => autoSettleLines(ctx.calls).length > linesBefore, { timeoutMs: 1200 });
    assert.equal(again, false, '⑥ 同值重写不得再落日志');
    assert.deepEqual(takeSeq(ctx), [], '⑥ 同值重写须 0 次写');
  } finally {
    disposer();
  }
});

test('T-3 ②③④ log-level：各自方向翻转恰 1 次日志 + 写集与冻结集相等（不按字段级冒充）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx } = assemblyCtxEffect();
  ctx.rtWriteLog = [];
  const disposer = apply(ctx, { root });
  try {
    // 窗口串联：用累积 overlay（`writeRuntime` 整文件覆盖 ⇒ 必须先 merge，见 `deepMerge` 注释）
    const ov = {};
    const set = (patch) => writeRuntimeJson(root, deepMerge(ov, patch));

    // ② trajectory（装配默认开 ⇒ 关方向触发；写集 {trajectory}）
    takeSeq(ctx);
    set({ capabilities: { trajectory: { enabled: false } } });
    let ok = await waitFor(() => ctx.calls.info.some((l) => l.includes('trajectory bridge stopped')));
    assert.equal(ok, true, '② 阳性：trajectory 关闭须落日志');
    assert.deepEqual(takeSeq(ctx), ['trajectory'], '② 写序列须恰 [trajectory]（日志级判据 + 写集相等）');

    // ④ verify（默认开 ⇒ 关方向；写集 {verifyMount}）
    takeSeq(ctx);
    set({ capabilities: { verify: { enabled: false } } });
    ok = await waitFor(() => ctx.calls.info.some((l) => l.includes('hot config: verify capture unmounted')));
    assert.equal(ok, true, '④ 阳性：verify 关闭须落日志');
    assert.deepEqual(takeSeq(ctx), ['verifyMount'], '④ 写序列须恰 [verifyMount]');

    // ③ topic（默认关 ⇒ 开方向；写集 ⊆ {topicRuntime, topicAttachUn}）
    takeSeq(ctx);
    set({ capabilities: { topic: { enabled: true } } });
    ok = await waitFor(() => ctx.calls.info.some((l) => l.includes('hot config: topic runtime started')));
    assert.equal(ok, true, '③ 阳性：topic 开启须落日志');
    const seq = takeSeq(ctx);
    const allowed = new Set(['topicRuntime', 'topicAttachUn']);
    const foreign = seq.filter((k) => !allowed.has(k));
    assert.deepEqual(foreign, [], '③ 写序列不得含 {topicRuntime, topicAttachUn} 之外的字段（实测 ' + JSON.stringify(seq) + '）');
    assert.ok(seq.includes('topicRuntime'), '③ 写序列须含 topicRuntime（实测 ' + JSON.stringify(seq) + '）');
  } finally {
    disposer();
  }
});

test('T-3b boot 对账零写（阳性 = overlay 有差异时必多写）', async () => {
  // 阳性侧：预置一份**与静态不同**的 overlay ⇒ 装配期 boot 对账必触发 watch remount ⇒ 写数 > 20
  const rootDiff = freshRoot();
  writeRuntime(rootDiff, { capabilities: { watch: { scanIntervalMinutes: 7 } } });
  const diff = assemblyCtxEffect();
  diff.ctx.rtWriteLog = [];
  const dDiff = apply(diff.ctx, { root: rootDiff });
  try {
    const diffWrites = diff.ctx.rtWriteLog.length;
    assert.ok(diffWrites > 20, '阳性：overlay 有差异时装配写数须 > 20（实测 ' + diffWrites + '）');
  } finally {
    dDiff();
  }
  // 阴性侧：overlay 与静态一致（{}）⇒ 对账三个 remount 全部早退 ⇒ 装配写数**恰 20**（每字段 1 次）
  const rootSame = freshRoot();
  writeRuntime(rootSame, {});
  const same = assemblyCtxEffect();
  same.ctx.rtWriteLog = [];
  const dSame = apply(same.ctx, { root: rootSame });
  try {
    assert.equal(same.ctx.rtWriteLog.length, 20,
      'boot 对账零写：一致 overlay 下装配写数须恰 20（实测 ' + same.ctx.rtWriteLog.length + '，多于 20 = 对账多写了）');
    const dup = same.ctx.rtWriteLog.filter((k, i, arr) => arr.indexOf(k) !== i);
    assert.deepEqual(dup, [], '装配期每个字段须只写 1 次（实测重复 ' + JSON.stringify(dup) + '）');
  } finally {
    dSame();
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// T-4 可证伪性自证 + D-1 回归（cordis 无 sink 时取值不得抛）
//   ① 判据自证：多重集比较器对「多一项 / 少一项」必翻假（否则 T-3 的相等断言不可证伪）；
//   ② D-1 回归：`impl-w7f.md §8 D-1` —— d1 原式 `typeof ctx?.rtWriteLog?.push === 'function'` 在
//      cordis Context 上**直接抛错**（`cannot get property "rtWriteLog" without inject`），首版被
//      `auditlog-mount` 抓出 11 红；现实现改为 try/catch 取值守卫。本用例用「未声明属性即抛」的
//      伪 Context 钉住它：**无 sink 时取值不得抛**，且装配不得因此中断。
// ══════════════════════════════════════════════════════════════════════════════════════
test('T-4 判据自证：多重集比较器对多写/漏写必翻假（否则 T-3 不可证伪）', () => {
  const want = ['governanceHook', 'governanceInstalledCfg'];
  assert.equal(MULTISET_EQUAL(want, ['governanceHook', 'governanceInstalledCfg']), true, '自证阳性：同集须相等');
  assert.equal(MULTISET_EQUAL(want, ['governanceHook', 'governanceInstalledCfg', 'watchTimer']), false,
    'V-1 双写自证：多一项须判不等（否则「双写」抓不住）');
  assert.equal(MULTISET_EQUAL(want, ['governanceHook']), false, 'V-2 漏写自证：少一项须判不等');
  assert.equal(MULTISET_EQUAL(want, ['governanceInstalledCfg', 'governanceHook']), true, '多重集口径：顺序不敏感');
  // 顺序敏感的序列断言（deepEqual 形态）对换序必翻假
  assert.notDeepEqual(['watchTimer', 'heartbeat'], ['heartbeat', 'watchTimer'], '顺序敏感判据须能分辨换序');
});

test('T-4b D-1 回归：cordis 式「未声明属性即抛」的 ctx ⇒ 取值不得抛、装配不得中断（无 sink 时纯对象）', () => {
  const base = assemblyCtxEffect().ctx;
  delete base.rtWriteLog; // 不注入 sink
  // 伪 cordis Context：访问未声明的 `rtWriteLog` 直接抛（复刻 D-1 的真实症状）
  const strictCtx = new Proxy(base, {
    get(target, key, receiver) {
      if (key === 'rtWriteLog') {
        throw new Error('cannot get property "rtWriteLog" without inject');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const root = freshRoot();
  writeRuntime(root, {});
  let disposer = null;
  assert.doesNotThrow(() => { disposer = apply(strictCtx, { root }); },
    'D-1 回归：无 sink 时 apply 取值不得抛（现实现 = try/catch 取值守卫）');
  assert.equal(typeof disposer, 'function', 'D-1 回归：装配须完成并返回 disposer');
  assert.doesNotThrow(() => disposer(), 'D-1 回归：disposer() 不得抛');

  // 阳性对照：同一 ctx 形态但**真的注入了 sink** ⇒ 写序列必须被记录（证明上面的「不抛 + 无记录」
  //   不是「trap 永不生效」造成的假绿）
  const sinkCtx = assemblyCtxEffect().ctx;
  sinkCtx.rtWriteLog = [];
  const root2 = freshRoot();
  writeRuntime(root2, {});
  const d2 = apply(sinkCtx, { root: root2 });
  try {
    assert.equal(sinkCtx.rtWriteLog.length, 20, '阳性对照：注入 sink 后装配须记录 20 次写（实测 ' + sinkCtx.rtWriteLog.length + '）');
  } finally {
    d2();
  }
});
