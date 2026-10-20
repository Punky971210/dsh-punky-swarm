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

// W7e remount / 释放面单测（batch `punky-w7e-20261020` · lane `e2-w7e-test`）
//
// 为什么要有这一件（判据源 `plan/scope.md` §6 / AC-8 / AC-12 / AC-15）：
//   W7e 把 `apply` 内三块（E1 governance 装载 / E2 governance remounter / E3 watch remounter）
//   下沉为**同文件顶层工厂**，句柄改经 `read*/write*` 访问器与 `apply` 作用域交互。
//   搬移本身由 coder 的块 sha 守恒证明；**本件证明的是「搬移后装配面行为与释放面没变」**——
//   三处缺口此前零覆盖：
//     · G-2/G-3：释放完整性与 dispose 幂等（`ctx.effect` 通道在该批前**任何测试都没走过**）；
//     · G-6（部分）：hotConfig 装配面 —— `applied` 全键快照 / `appliedWatch` 7 键全形 /
//       同值重写零操作 / 多次 boot 后仍可热写；
//     · G-8（代理）：watch 引擎实例替换后的工具面可观测（tracked ↔ disabled）。
//
// 纪律（AC-15，本文件的核心取舍）：
//   ① 每条「空 / 计数 0 / 不变 / 不抛 / disabled」断言，**同一测试内**先有同输入阳性
//      （装配后 preCount=1 / 变更前日志 0 而变更后 1 / 翻转前 tracked=true）；
//   ② **不用裸 sleep**：热更是 `fs.watch` → 300ms 防抖 → 异步，故用**有界等待**（谓词 + 截止时间），
//      谓词先满足即返回，超时才判红（既有套件的 `HOT_SLEEP=1000` 是定长等待，本件不复制该形态）；
//   ③ 不改既有 168 个测试的任何断言（`watch-hotconfig:238` 的 boot 对账 no-op 是本批唯一的真牙齿，零触碰）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../lib/index.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';
import { resolveGovernanceConfig } from '../lib/governance/config.js';
import { loadPresetTable } from '../lib/governance/preset-loader.js';
import { writeRuntime, assemblyCtxEffect } from './helpers/gate-fixture.mjs';

const CONFIG_PATH = '/api/dsh-punky-swarm/config';
const TRUSTED_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' };
const EXEC = { agent: { session: { id: 'sess-w7e-surface' } } };
// watch 出厂 7 键快照（与 `lib/index.js` remountWatchEngine 的 nextInstalled 同形）
const WATCH_DEFAULTS = {
  enabled: true,
  longrun: { enabled: true, maxDurationMs: 1_200_000, noProgressWindowMs: 300_000, staleBatchMs: 86_400_000, unconsumedTimeoutMs: 1_800_000 },
  scanIntervalMinutes: 1,
};

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-w7e-surface-'));
}

/** 有界等待（AC 纪律：禁裸 sleep；谓词满足即返回，超时才判红）。 */
async function waitFor(predicate, { label = '条件', timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** remount 留痕：watch 引擎 / governance hook 两族（判据面 = `hot config: …` 前缀）。 */
const watchRemountLines = (calls) => calls.info.filter((l) => l.includes('hot config: watch engine'));
const govRemountLines = (calls) => calls.info.filter((l) => l.includes('hot config: governance hook'));

function invoke(route, url, { method = 'GET', headers = TRUSTED_HEADERS } = {}) {
  let status = 0, body = null;
  const res = { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
  const req = { url, method, headers };
  const ret = route.handler(req, res);
  if (ret && typeof ret.then === 'function') return ret.then(() => ({ status, body }));
  return { status, body };
}

/** GET /config → `{ overlay, overlayWatch, applied, presets }`；`applied.hook` / `applied.watch` = 装配生效快照。 */
function getConfig(routes) {
  const route = routes.find((r) => r.path === CONFIG_PATH);
  assert.ok(route, '阳性前置：/config 路由须已注册（webServer 注入面）');
  const r = invoke(route, CONFIG_PATH);
  assert.equal(r.status, 200, 'GET /config 须 200');
  return r.body;
}

/** 在 `<root>/sessions/...` 落一个 running lane 的批次（与 apply 内部 store 同盘真源）。 */
function seedRunningBatch(root, session, batchId, lane) {
  const aux = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: [{ id: lane, outputs: ['exec/' + lane + '/out.txt'], cmd: 'work' }] });
  aux.createBatch(session, { batchId, wavePlan: plan, phase: 'running' });
  const bf = aux.batchFile(session, batchId);
  const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
  b.lanes[lane] = 'running';
  b.events.push({ ts: new Date(Date.now() - 60_000).toISOString(), type: EVT_MEMBER_DISPATCH, lane, workerSessionId: 'w-w7e' });
  fs.writeFileSync(bf, JSON.stringify(b, null, 2));
  return aux;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// T-1 释放完整性 + dispose 幂等（G-2 / G-3；含 G-5：`ctx.effect` 通道首次被执行）
// 阳性对照设计：
//   ① 与 ② 本身就是同输入先后对照（装配后 1 → dispose 后 0）；
//   ③ 的阳性 = **第一次** dispose 的 `clearInterval` 计数 ≥ 1（否则「第二次不增长」在「从不清理」时也成立）；
//   ④ 的阳性 = 同一 `apply` 用**无 effect 的 ctx**（`assemblyCtxPre` 等价姿态）⇒ 注册数 0 ⇒
//      证明「≥2」是被测能力位（`if (ctx.effect)`）真的被执行，而不是装配恒有。
// ══════════════════════════════════════════════════════════════════════════════════════
test('T-1 释放完整性与 dispose 幂等：preCount 1→0、effect 注册 ≥2、二次 dispose 零增量', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx } = assemblyCtxEffect();
  // 周期 sweep 的默认值是 **0 = 关**（`lib/index.js:218` 明文「零隐式行为」）⇒ 要让 sweep 那条
  //   `ctx.effect` 也注册，必须显式给 `mailbox.sweepIntervalMs > 0`。**这不是产品缺陷**：
  //   默认配置下 effect 注册数本来就是 1（只有 watch），见 T-1b 的对照与缺陷清单 N-1。
  const disposer = apply(ctx, { root, mailbox: { sweepIntervalMs: 60_000 } });

  // ① 装配后：governance hook 已挂（pre listener 1 个）—— ② 的阳性基线
  assert.equal(ctx.preCount(), 1, '① 装配后 tools/pre-execute 监听数须为 1（governance hook 已挂）');

  // ④（前半）`ctx.effect` 注册数 ≥ 2（mailbox sweep + watch heartbeat），且标签可分辨
  assert.ok(ctx.effects.length >= 2, '④ ctx.effect 注册数须 ≥2（实测 ' + ctx.effects.length + '；标签: ' + ctx.effects.map((e) => e.label).join(' / ') + '）');
  const labels = ctx.effects.map((e) => e.label ?? '');
  assert.ok(labels.some((l) => l.includes('mailbox sweep')), '④ 须含 mailbox sweep 释放项（实测: ' + JSON.stringify(labels) + '）');
  assert.ok(labels.some((l) => l.includes('watch heartbeat')), '④ 须含 watch heartbeat 释放项（实测: ' + JSON.stringify(labels) + '）');

  // ③ 的计数通道：**测试侧**替换 `clearInterval` 计数（不改产品源码；finally 恢复）
  const origClear = globalThis.clearInterval;
  let clearCount = 0;
  globalThis.clearInterval = (t) => { clearCount += 1; return origClear(t); };
  try {
    // ② disposer() 后 preCount 归 0
    disposer();
    assert.equal(ctx.preCount(), 0, '② disposer() 后 tools/pre-execute 监听数须为 0（hook 已卸载）');

    // ③（阳性）第一次 dispose 的 clearInterval 计数 ≥ 1 —— 证明清理确实发生了
    assert.ok(clearCount >= 1, '③阳性 第一次 disposer() 的 clearInterval 计数须 ≥1（实测 ' + clearCount + '）');
    const afterFirst = clearCount;

    // ③（幂等）二次 disposer() 不抛，且 clearInterval 计数不增长（幂等差 = 0）
    assert.doesNotThrow(() => disposer(), '③ 二次 disposer() 不得抛错');
    assert.equal(clearCount, afterFirst, '③ 二次 disposer() 的 clearInterval 增量须为 0（实测差 ' + (clearCount - afterFirst) + '）');
  } finally {
    globalThis.clearInterval = origClear;
  }

  // ④（后半）effect 清理函数可调用不抛（跑完所有注册项的 cleanup）
  const ran = ctx.runEffects();
  assert.equal(ran.length, ctx.effects.length, '④ runEffects() 须覆盖全部注册项');
  assert.deepEqual(ran.filter((r) => !r.ok), [], '④ 全部 effect 清理函数须不抛（实测异常: ' + JSON.stringify(ran) + '）');
});

test('T-1b 阳性对照：**无 `ctx.effect` 的 ctx** ⇒ effect 注册面为 0（证明 T-1④ 的 ≥2 来自能力位执行）', async () => {
  // 与 T-1 同输入（同一 apply、同一 root 形状），唯一差异 = ctx 无 `effect` 键。
  // 该姿态正是本批之前的真实状况（G-5：两处 `if (ctx.effect)` 分支从未执行）。
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx } = assemblyCtxEffect();
  delete ctx.effect;          // 抽掉能力位
  const disposer = apply(ctx, { root, mailbox: { sweepIntervalMs: 60_000 } }); // 与 T-1 同配置（控制变量）
  try {
    assert.equal(ctx.effects.length, 0, '无 ctx.effect ⇒ 注册数须为 0（若仍 >0 说明装配另有通道，本件阳性对照失效）');
    assert.equal(ctx.preCount(), 1, '对照：无 effect 时 governance hook 仍照常挂载（差异只在释放通道）');
  } finally {
    disposer();
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// T-2 hotConfig 装配面（G-6 ①/⑤ 子集；全六分支仍属 W7f，登记 W7F-IN-1）
// 阳性对照设计：
//   ① 变更前先取 `applied.hook` 基线快照（非空对象）⇒ 变更后与新解析快照 deepEqual；
//   ② 变更前 watch remount 日志 0（boot 对账 no-op）⇒ 变更后恰 1；
//   ③ 同值重写的阳性 = ② 已产生 1 条（增量 0 才有意义）；
//   ④ 三次 boot 的对账阳性 = 每次 boot 的 watch 生效快照都非空且等于默认（证明对账真的跑了，只是 no-op）。
// ══════════════════════════════════════════════════════════════════════════════════════
test('T-2 governance 热更：applied.hook 全键 deepEqual 新快照 + preCount 1→0', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx, routes } = assemblyCtxEffect();
  const disposer = apply(ctx, { root });
  try {
    // 阳性基线：初始 applied.hook 非空且 enabled=true（未显式关闭）
    const before = getConfig(routes).applied.hook;
    assert.ok(before && typeof before === 'object', '①阳性 初始 applied.hook 须为非空快照');
    assert.notEqual(before.enabled, false, '①阳性 初始 enabled 不得为 false（否则下面的 1→0 无分辨力）');
    assert.equal(ctx.preCount(), 1, '①阳性 初始 preCount=1');
    assert.equal(govRemountLines(ctx.calls).length, 0, '①阳性 初始装配无 governance remount 日志（静态即快照）');

    // 热写 governance.hook.enabled=false
    writeRuntime(root, { governance: { hook: { enabled: false } } });
    const ok = await waitFor(() => govRemountLines(ctx.calls).length >= 1, { label: 'governance remount' });
    assert.equal(ok, true, '热更须产生 governance remount 日志（实测: ' + JSON.stringify(ctx.calls.info.slice(-3)) + '）');

    // ① preCount 1 → 0（hook 卸载）
    assert.equal(ctx.preCount(), 0, '① 热更 enabled=false 后 preCount 须为 0');
    // ① applied.hook 与新解析快照**全键 deepEqual**
    const { table, banTable } = loadPresetTable();
    const expected = resolveGovernanceConfig({ enabled: false }, { presetTable: table, presetBanTable: banTable });
    assert.deepEqual(getConfig(routes).applied.hook, expected, '① applied.hook 须与新快照全键 deepEqual');
    // 日志方向正则逐字不变（AC-11）
    const line = govRemountLines(ctx.calls).at(-1);
    assert.match(line, /unmounted \(governance\.hook\.enabled=false 或装配前置缺失\)/, '① 日志方向文案须逐字不变');
    assert.match(line, /\[was=true now=false\]/, '① 日志须带 was/now 位');
  } finally {
    disposer();
  }
});

test('T-2 watch 热更：appliedWatch 7 键全形 deepEqual + remount 恰 1 + 同值重写恰 0', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const { ctx, routes } = assemblyCtxEffect();
  const disposer = apply(ctx, { root });
  try {
    // ② 阳性基线：出厂快照 7 键全形 + boot 对账零 remount
    assert.deepEqual(getConfig(routes).applied.watch, WATCH_DEFAULTS, '②阳性 初始 applied.watch 须为 7 键出厂快照');
    assert.equal(watchRemountLines(ctx.calls).length, 0, '②阳性 boot 对账 no-op（零 remount 日志）');

    // 变更 scanIntervalMinutes 1 → 2
    writeRuntime(root, { capabilities: { watch: { scanIntervalMinutes: 2 } } });
    let ok = await waitFor(() => watchRemountLines(ctx.calls).length >= 1, { label: 'watch remount #1' });
    assert.equal(ok, true, '② 热更须产生 watch remount 日志');
    // ② appliedWatch 7 键全形 deepEqual（只有 scanIntervalMinutes 变）
    assert.deepEqual(getConfig(routes).applied.watch, { ...WATCH_DEFAULTS, scanIntervalMinutes: 2 },
      '② applied.watch 须 7 键全形 deepEqual 新快照');
    // ② remount 日志恰 1 条，且方向正则逐字不变
    assert.equal(watchRemountLines(ctx.calls).length, 1, '② 本次变更 remount 须恰 1 条');
    assert.match(watchRemountLines(ctx.calls)[0], /re-mounted \(scan 120000ms, longrun=true\)/, '② 日志文案须含新 scan 与 longrun 位');

    // ③ 同值重写 ⇒ remount 增量恰 0（阳性 = 上面已产生 1 条）
    writeRuntime(root, { capabilities: { watch: { scanIntervalMinutes: 2 } } });
    // 给够「若会 remount 则必然已发生」的窗口：等到日志数 >1 或超时
    const grew = await waitFor(() => watchRemountLines(ctx.calls).length > 1, { label: '同值重写增量', timeoutMs: 1500 });
    assert.equal(grew, false, '③ 同值重写不得新增 remount（实测: ' + JSON.stringify(watchRemountLines(ctx.calls)) + '）');
    assert.equal(watchRemountLines(ctx.calls).length, 1, '③ 同值重写后仍恰 1 条');
  } finally {
    disposer();
  }
});

test('T-2b 三次 boot 对账后仍可热写：每次 boot no-op，热写仍恰 1 次 remount', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  // ④ 三次 boot：每次装配都对账一次（快照非空 = 对账真跑了），但**均不得产生 remount**
  for (let i = 1; i <= 3; i += 1) {
    const { ctx, routes } = assemblyCtxEffect();
    const disposer = apply(ctx, { root });
    try {
      assert.deepEqual(getConfig(routes).applied.watch, WATCH_DEFAULTS, '④ 第 ' + i + ' 次 boot 的 applied.watch 须为出厂快照（对账已跑）');
      assert.equal(watchRemountLines(ctx.calls).length, 0, '④ 第 ' + i + ' 次 boot 对账须 no-op（零 remount）');
      const bootLines = ctx.calls.info.filter((l) => l.includes('[boot-overlay]'));
      assert.deepEqual(bootLines, [], '④ 第 ' + i + ' 次 boot 不得留 [boot-overlay] remount 日志');
    } finally {
      disposer();
    }
  }
  // 第四次 boot 上做热写：hotConfig 仍活 ⇒ 恰 1 次 remount
  const { ctx, routes } = assemblyCtxEffect();
  const disposer = apply(ctx, { root });
  try {
    writeRuntime(root, { capabilities: { watch: { scanIntervalMinutes: 3 } } });
    const ok = await waitFor(() => watchRemountLines(ctx.calls).length >= 1, { label: '三次 boot 后热写' });
    assert.equal(ok, true, '④ 三次 boot 后热写须仍能触发 remount（hotConfig 存活）');
    assert.equal(watchRemountLines(ctx.calls).length, 1, '④ 三次 boot 后热写须恰 1 次 remount');
    assert.deepEqual(getConfig(routes).applied.watch, { ...WATCH_DEFAULTS, scanIntervalMinutes: 3 }, '④ 生效快照须随动');
  } finally {
    disposer();
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// T-3 引擎实例替换可观测（G-8 代理；G-5 的 `effect`/`heartbeatRef` 面）
// 阳性对照设计：
//   ① tracked=true 是 ② disabled 的阳性（同工具、同调用、只差 watch 开关）；
//   ③ 是 ② 的反向恢复（同工具、同调用、只差开关方向）；
//   ④ 每次方向翻转恰 1 条 remount，用「翻转前 0 → 第一次翻转 1 → 第二次翻转 2」逐步证明。
// ══════════════════════════════════════════════════════════════════════════════════════
test('T-3 watch.enabled 翻转：lane_heartbeat 工具 tracked → disabled → tracked（每次翻转恰 1 条 remount）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const S = 'sess-w7e-surface';
  const B = 'b-w7e-surface';
  const LANE = 'l1';
  seedRunningBatch(root, S, B, LANE); // 与 apply 同盘的批（供真实注册的 lane_heartbeat 查询）

  const { ctx } = assemblyCtxEffect();
  const disposer = apply(ctx, { root });
  try {
    const tool = ctx.registered.find((t) => t?.name === 'lane_heartbeat');
    assert.ok(tool, '阳性前置：apply 须注册出 lane_heartbeat（注册面 ' + ctx.registered.length + ' 件）');
    const q = (extra = {}) => tool.execute({ batchId: B, lane: LANE, session: S, ...extra }, EXEC);

    // ① 初始 watch 开 ⇒ tracked:true（② 的阳性基线）
    //   ⚠ `tracked` 的语义 = 「lane 在本引擎实例的**内存状态表**内」，状态表由 **tick 扫描**建立
    //   （`state-surface.js:49-59`：无 entry ⇒ tracked:false；有 entry ⇒ tracked:true）。
    //   装配刚完成、尚未 tick 时 tracked 必为 false（见缺陷清单 N-2：本批判据把「装配后」当「已跟踪」）。
    //   故先用 `beat:true` 打一拍（工具自带的有界单次 tick，非等待循环）建立 entry，再断言。
    await q({ beat: true });
    const r1 = await q();
    assert.equal(r1.lanes.length, 1, '① 查询须返回 1 行');
    assert.equal(r1.lanes[0].tracked, true, '① tick 后须 tracked:true（实测行: ' + JSON.stringify(r1.lanes[0]) + '）');
    assert.notEqual(r1.lanes[0].reason, 'watch-disabled', '① 初始不得为 disabled');
    assert.equal(watchRemountLines(ctx.calls).length, 0, '① 初始零 remount');

    // ② watch.enabled=false 热更 ⇒ 工具面落 disabled（heartbeatRef.current = null 路径）
    writeRuntime(root, { capabilities: { watch: { enabled: false } } });
    let ok = await waitFor(() => watchRemountLines(ctx.calls).length >= 1, { label: 'watch 关' });
    assert.equal(ok, true, '② 关闭须产生 remount 日志');
    const r2 = await q();
    assert.equal(r2.lanes[0].reason, 'watch-disabled', '② 关闭后须返回 watch-disabled（实测: ' + JSON.stringify(r2.lanes[0]) + '）');
    assert.equal(r2.lanes[0].tracked, false, '② 关闭后须 tracked:false');
    assert.match(watchRemountLines(ctx.calls).at(-1), /unmounted \(watch disabled\)/, '② 日志方向文案须逐字不变');

    // ③ 写回 true ⇒ 恢复 tracked（反向恢复，证明 ② 不是「工具永久坏掉」）
    writeRuntime(root, { capabilities: { watch: { enabled: true } } });
    ok = await waitFor(() => watchRemountLines(ctx.calls).length >= 2, { label: 'watch 开' });
    assert.equal(ok, true, '③ 恢复须产生第 2 条 remount 日志');
    // ③ 同一原因：重建后的引擎实例状态表为空 ⇒ 先打一拍再断言 tracked（证明「新实例真的可用」）
    await q({ beat: true });
    const r3 = await q();
    assert.equal(r3.lanes[0].tracked, true, '③ 恢复后须 tracked:true（实测: ' + JSON.stringify(r3.lanes[0]) + '）');
    assert.notEqual(r3.lanes[0].reason, 'watch-disabled', '③ 恢复后不得为 disabled');

    // ④ 两个方向各恰 1 条（总 2 条），且 re-mounted 方向带 scan/longrun 位
    assert.equal(watchRemountLines(ctx.calls).length, 2, '④ 两次翻转须恰 2 条 remount（实测: ' + JSON.stringify(watchRemountLines(ctx.calls)) + '）');
    assert.match(watchRemountLines(ctx.calls).at(-1), /re-mounted \(scan 60000ms, longrun=true\)/, '④ 恢复方向日志须带生效面');
  } finally {
    disposer();
  }
});
