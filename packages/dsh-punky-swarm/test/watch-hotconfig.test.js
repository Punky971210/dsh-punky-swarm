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
import { topicWarnVerdict } from './helpers/warn-topic.mjs';
const WATCH_TOPIC_WARN = /watch|re-mounted|hot config|unmounted/;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_LANE_LONGRUN_CANDIDATE, EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import { createLaneHeartbeat, createHeartbeatTools, createLongrunTools } from '../lib/watch/lane-heartbeat.js';
import * as mailbox from '../lib/comms/mailbox.js';
import { writeRuntime, assemblyCtxWeb } from './helpers/gate-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// fs.watch 事件 → 防抖 300ms（createConfigWatcher 默认）→ reload → onChange；等待窗口对齐
// governance-hotconfig HOT_SLEEP 1000 先例（防抖 + 事件 + 解析余量）
const HOT_SLEEP = 1000;
const HOT_SETTLE = 300;
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
    // 基线等待：原「固定等 HOT_SETTLE=300ms」→ 有界轮询（条件达即返回）。
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
    // 热更等待：原「固定等 HOT_SLEEP=1000ms」→ 有界轮询到 remount 留痕出现（fs.watch → 防抖 300ms → reload → onChange）。
    await waitFor('h1-remount', () => remountLines(ctx.calls).length >= 1,
      { expected: 're-mounted 日志恰 1（longrun=false 生效面）' });
    const lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1, 'remount 恰 1 行（实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.match(lines[0], /re-mounted \(scan 60000ms, longrun=false\)/, '重建日志含生效面（longrun=false）');
    assert.equal(lines[0].includes('[boot-overlay]'), false, '热更路径无 [boot-overlay] tag（区分启动对账）');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: false, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      'applied.watch 生效快照已随 remount 更新（watchInstalledCfg；enabled 翻转阈值保留默认）');
    assert.equal(topicWarnVerdict(ctx.calls.warn, WATCH_TOPIC_WARN).ok, true, '热更路径主题面零 warn；非主题 warn（可见、不判死）：' + JSON.stringify(topicWarnVerdict(ctx.calls.warn, WATCH_TOPIC_WARN).other));
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
    await sleep(HOT_SETTLE);
    assert.equal(getConfig(routes).applied.watch.enabled, true, '出厂默认开');
    // ① enabled:false → unmounted（引擎 dispose + timer 清；工具查询 disabled——见 H5）
    writeRuntime(root, { capabilities: { watch: { enabled: false } } });
    await sleep(HOT_SLEEP);
    let lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /unmounted \(watch disabled\)/, 'enabled=false → unmounted 方向（实际: ' + lines[0] + '）');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: false, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      '关闭态 applied.watch.enabled=false（watchInstalledCfg 仍记快照全形含阈值，供面板回显）');
    // ② enabled:true → 以合并快照重建（re-mounted）
    writeRuntime(root, { capabilities: { watch: { enabled: true } } });
    await sleep(HOT_SLEEP);
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
    await sleep(HOT_SETTLE);
    // 热写 scanIntervalMinutes:0.5（watcher 白名单放行 capabilities.watch 深层；watch 级键仅手工 runtime.json 路径）
    writeRuntime(root, { capabilities: { watch: { scanIntervalMinutes: 0.5 } } });
    await sleep(HOT_SLEEP);
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
    await sleep(HOT_SETTLE);
    // ① 热写阈值（分钟级：maxDurationMs 60000=1min / noProgressWindowMs 30000=30s）→ 生效面 5 键第 4/5 键变化
    //    → remount 恰 1 次（dispose 旧引擎 + 以合并快照 nextConfig 重建——新阈值经 createLaneHeartbeat
    //    resolveLongrunConfig 捕获，判定时机验证见 T16）
    writeRuntime(root, { capabilities: { watch: { longrun: { maxDurationMs: 60000, noProgressWindowMs: 30000 } } } });
    await sleep(HOT_SLEEP);
    const lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1, '阈值-only 变化现触发 remount（实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.match(lines[0], /re-mounted \(scan 60000ms, longrun=true\)/, '重建日志 re-mounted（阈值变化不翻 enabled/longrun/scan）');
    assert.equal(lines[0].includes('[boot-overlay]'), false, '热更路径无 [boot-overlay] tag');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 60000, noProgressWindowMs: 30000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      'applied.watch 生效快照随 remount 携带新阈值（watchInstalledCfg 7 键全形）');
    assert.equal(topicWarnVerdict(ctx.calls.warn, WATCH_TOPIC_WARN).ok, true, '热更路径主题面零 warn；非主题 warn（可见、不判死）：' + JSON.stringify(topicWarnVerdict(ctx.calls.warn, WATCH_TOPIC_WARN).other));
    assert.equal(ctx.calls.error.length, 0, '热更路径零 error');
    // ② 同值重写 → nextInstalled 与 watchInstalledCfg JSON 相等 → 幂等 no-op（零新增 remount，快照不变）
    writeRuntime(root, { capabilities: { watch: { longrun: { maxDurationMs: 60000, noProgressWindowMs: 30000 } } } });
    await sleep(HOT_SLEEP);
    assert.equal(remountLines(ctx.calls).length, 1, '同值重写幂等 no-op：remount 仍恰 1 次（实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 60000, noProgressWindowMs: 30000, staleBatchMs: 86400000, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      '同值重写后生效快照不变');
    assert.equal(topicWarnVerdict(ctx.calls.warn, WATCH_TOPIC_WARN).ok, true, '幂等路径主题面零 warn；非主题 warn（可见、不判死）：' + JSON.stringify(topicWarnVerdict(ctx.calls.warn, WATCH_TOPIC_WARN).other));
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
    await sleep(HOT_SETTLE);
    assert.equal(remountLines(ctx.calls).length, 0, '基线 boot 对账 no-op');
    // ① 热写 staleBatchMs=0（显式关闭僵尸批过滤）→ 生效面第 6 键变化 → remount 恰 1 次
    writeRuntime(root, { capabilities: { watch: { longrun: { staleBatchMs: 0 } } } });
    await sleep(HOT_SLEEP);
    let lines = remountLines(ctx.calls);
    assert.equal(lines.length, 1, 'staleBatchMs 变化触发 remount（实际: ' + ctx.calls.info.join(' || ') + '）');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 0, unconsumedTimeoutMs: 1800000 }, scanIntervalMinutes: 1 },
      '快照携带 staleBatchMs=0（显式 0 被当合法值透传，而非回退默认 24h）');
    // ② 热写 unconsumedTimeoutMs=60000（D-2 阈值收紧）→ 第 7 键变化 → 再 remount 1 次
    writeRuntime(root, { capabilities: { watch: { longrun: { staleBatchMs: 0, unconsumedTimeoutMs: 60000 } } } });
    await sleep(HOT_SLEEP);
    lines = remountLines(ctx.calls);
    assert.equal(lines.length, 2, 'unconsumedTimeoutMs 变化再次 remount');
    assert.deepEqual(getConfig(routes).applied.watch,
      { enabled: true, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000, staleBatchMs: 0, unconsumedTimeoutMs: 60000 }, scanIntervalMinutes: 1 },
      '两档新键均已纳入生效面（7 键全形随动）');
    assert.equal(topicWarnVerdict(ctx.calls.warn, WATCH_TOPIC_WARN).ok, true, '热更路径主题面零 warn；非主题 warn（可见、不判死）：' + JSON.stringify(topicWarnVerdict(ctx.calls.warn, WATCH_TOPIC_WARN).other));
    assert.equal(ctx.calls.error.length, 0, '热更路径零 error');
    // ③ 同值重写幂等：零新增 remount
    writeRuntime(root, { capabilities: { watch: { longrun: { staleBatchMs: 0, unconsumedTimeoutMs: 60000 } } } });
    await sleep(HOT_SLEEP);
    assert.equal(remountLines(ctx.calls).length, 2, '同值重写幂等 no-op');
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
  assert.deepEqual(q.lanes.map((r) => r.lane), ['l1'],
    '查询面 lane 身份集合（期望来自入参 lane；实测 ' + JSON.stringify(q.lanes.map((r) => r.lane)) + '）');
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
  assert.deepEqual(q.lanes.map((r) => r.lane), ['l1'],
    'running lane 每行 disabled：lane 身份集合（实测 ' + JSON.stringify(q.lanes.map((r) => r.lane)) + '）');
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
  assert.deepEqual(tools.map((t) => t.name), ['lane_longrun'],
    'longrun enabled 静态 → 注册工具名集合相等（实测 ' + JSON.stringify(tools.map((t) => t.name)) + '）');
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
  assert.deepEqual(q.lanes.map((r) => r.lane), ['l1'],
    '查询面 lane 身份集合（实测 ' + JSON.stringify(q.lanes.map((r) => r.lane)) + '）');
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
  // G1 身份集合（期望值来自输入侧：播种 lane 就是 'l1'）
  {
    const candLanes1 = (st1.readBatch(S, 'b-rb1')?.events ?? [])
      .filter((e) => e.type === EVT_LANE_LONGRUN_CANDIDATE).map((e) => e.lane);
    assert.deepEqual(candLanes1.sort(), ['l1'],
      '重建前 tick 产候选的 lane 身份集合（实测 ' + JSON.stringify(candLanes1) + '）');
    assert.ok(candLanes1.length >= 1, '至少 1 条候选（实测 ' + candLanes1.length + '）');
  }
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
  {
    const candLanesKept = (st1.readBatch(S, 'b-rb1')?.events ?? [])
      .filter((e) => e.type === EVT_LANE_LONGRUN_CANDIDATE).map((e) => e.lane);
    assert.deepEqual(candLanesKept.sort(), ['l1'],
      '既有候选不被新引擎清除：lane 身份集合仍为 l1（实测 ' + JSON.stringify(candLanesKept) + '）');
    assert.ok(candLanesKept.length >= 1, '既有候选条数不得归零（实测 ' + candLanesKept.length + '）');
  }
  // stalled 档存活佐证：0ms 档位下 tick 已跑心跳扫描 → inbox 追问照发（引擎活着，只是 longrun 门控关）
  const probes = inboxItems(root, S, 'b-rb2').filter((m) => m.message?.kind === 'probe' && m.message.lane === 'l1');
  assert.ok(probes.length >= 1, '心跳档仍活（探针照发）——证明 tick 已执行而 longrun 判定被门控（实际: ' + probes.length + '）');
});

// ─────────────────────────────────────────────────────────────────────────────
// F1：C1 归因收窄的三条反向构造（缺一条这个修法就是软化）
//   F1-a 主题面 warn ⇒ 必红
//   F1-b 实测 witness（asset sync failed）⇒ **不红**，但要进 other 且**出现在断言消息里**（可见）
//   F1-c 空集 ⇒ 绿
// ⚠ F1-b 是命门：若"不红且不可见"，就是把噪声静默吞了（与 D3 那轮同型错误）。
// ─────────────────────────────────────────────────────────────────────────────

test('F1 归因收窄三构造：主题面必红 / witness 不红但可见 / 空集绿', () => {
  const topic = WATCH_TOPIC_WARN;

  // F1-a：注入一条主题面 warn
  const a = topicWarnVerdict(['[dsh-punky-swarm] hot config re-mounted: longrun=false'], topic);
  assert.equal(a.ok, false, 'F1-a：主题面 warn ⇒ 必须判红（主题面零容忍，无余量）');
  assert.equal(a.topic.length, 1, 'F1-a：须归入 topic');
  assert.equal(a.other.length, 0, 'F1-a：other 不得误收');

  // F1-b：实测 witness（并发资产同步的 utime EPERM）
  const witness = "[dsh-punky-swarm] asset sync failed: presets/punky-preset/asset-manifest.json: EPERM: operation not permitted, utime '...\\.dsh\\.agent-presets\\punky-preset\\asset-manifest.json'";
  const b = topicWarnVerdict([witness], topic);
  assert.equal(b.ok, true, 'F1-b：witness 不属主题面 ⇒ 不判红（这是本轮修掉的偶发红）');
  assert.equal(b.other.length, 1, 'F1-b：witness 必须进 other（不得静默丢弃）');
  assert.equal(b.other[0].includes('asset sync failed'), true, 'F1-b：other 须保留可读原文');
  // 断言消息必须**带出** other（可见性）
  const msg = '热更路径主题面零 warn；非主题 warn（可见、不判死）：' + JSON.stringify(b.other);
  assert.equal(msg.includes('asset sync failed'), true, 'F1-b：断言消息须带出 witness 全文（可见，不静默）');

  // F1-c：空集
  const c = topicWarnVerdict([], topic);
  assert.equal(c.ok, true, 'F1-c：空集 ⇒ 绿');
  assert.equal(c.topic.length + c.other.length, 0, 'F1-c：两侧均为空');
  // 合成：三构造结论可区分
  assert.notEqual(a.ok, b.ok, 'F1 合成：主题面与 witness 必须可区分（相同 ⇒ 归因没起作用）');
  assert.equal(b.ok, c.ok, 'F1 合成：witness 与空集同为绿（差异只在 other 可见性）');

  process.stderr.write('[F1] a=' + (a.ok ? 'green' : 'red') + ' b=' + (b.ok ? 'green' : 'red')
    + ' bOtherVisible=' + msg.includes('asset sync failed') + ' c=' + (c.ok ? 'green' : 'red') + String.fromCharCode(10));
});

// ─────────────────────────────────────────────────────────────────────────────
// G1：C1 可见性的**结构守卫**（审计 FLK-3）
//
// F1-b 只证明「模板会带出 other」，守不住**生产那 8 处**模板：若有人删掉某一处的
// `JSON.stringify(...other)`，F1-b 仍然绿 ⇒ 可见性静默消失。本用例把"每处都必须带 .other"变成断言。
//
// 用 **every 形态（存在性）而不是计数**：
//   · 计数（"须恰好 N 处带 .other"）⇒ 新增第 N+1 处**不带** .other 不会红（漏）；
//   · every ⇒ 新增任一处不带 .other **立刻红**，且报出行号。
// 这条符合「只锚定存在性，不锚定数量」。
// ─────────────────────────────────────────────────────────────────────────────

test('G1 静态自检：每处 topicWarnVerdict 断言的消息模板都必须带出 .other（存在性，不计数）', () => {
  // 自我命中防范：搜索串**拼接构造**（字面量不连续）⇒ 不会命中本行自身
  const NEEDLE = 'topic' + 'WarnVerdict(';
  const targets = [
    fileURLToPath(new URL('./watch-hotconfig.test.js', import.meta.url)),
    fileURLToPath(new URL('./auto-settle.test.js', import.meta.url)),
  ];
  const offenders = [];
  let checked = 0;
  for (const file of targets) {
    const name = path.basename(file);
    const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(NEEDLE)) continue;
      // 只核「处于断言位置」的形态：`.ok, true` 即本批 8 处的调用形态
      if (!line.includes('.ok, true')) continue;
      checked += 1;
      // 可见性要求：同一行必须把 other 带进消息（.other 出现在模板里）
      if (!line.includes('.other')) offenders.push(name + ':' + (i + 1));
    }
  }
  // 存在性前置（防空转：一处都没查到 ⇒ 本守卫什么都没守）
  assert.equal(checked > 0, true, 'G1 前置：必须至少查到一处 topicWarnVerdict 断言（实测 ' + checked + '）');
  // every 形态：任一处缺 .other ⇒ 红，且**逐处列出行号**
  assert.equal(offenders.length, 0,
    'G1：以下位置的断言模板**缺 .other**（可见性会静默消失，逐处修）→ '
    + (offenders.length ? offenders.join(' , ') : '（无）') + '；已核 ' + checked + ' 处');
});
