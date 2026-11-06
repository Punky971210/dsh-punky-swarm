// test/agent-team-probe.test.js
//
// 【批 `punky-engine-fix-20261106` · lane `e1-fix-b1`】B-1 钉死用例（用户裁决 Q-F = 甲）。
//
// ## 修的是什么
// `lib/provider-dsh/agent.js` 的 `agentTeamChannelOf` 原判据是
//   `typeof serviceOf(ctx,'tools').probeTool === 'function'`
// —— 但 `serviceOf(ctx,'tools')` 取到的是**宿主** `ToolRuntime`（公开面
// `register/restrict/get/schemas/guard/execute`），**没有** `probeTool`；
// `probeTool` 是蟛蜞**端口**方法（`lib/provider-dsh/tools-http.js:106`，`createToolsPort` 产物）。
// ⇒ 排除支恒假 ⇒ `spawn_teammate` 被剔除时报 `{available:true, reason:null}` = **fail-open**。
//
// ## 修后判据（三态不得合并）
//   `createToolsPort(ctx).probeTool('spawn_teammate')`：
//     `absent`  ⇒ `{available:false, reason:'port-absent:agentTeam'}`
//     `present` ⇒ `{available:true,  reason:null}`（阳性对照）
//     `errored` ⇒ `{available:true,  reason:null}`（**探测坏 ≠ 能力缺**，保持可用）
//   「宿主 `get` 不是函数」（**不可内省**）⇒ **保持 `true`**：不能确认「不存在」就不宣称已排除，
//     但也不据此判死 —— `port-unavailable`（**不能检查**）≠ `absent`（**确认不存在**）。
//   「工具面整体缺失」（`ctx.tools` 不存在）⇒ **判 false**：面没装就是派不了，与改前同值。
//
// ## 判别力分布（为什么必须五档都写）
//   只有 ①（absent）能发现「fail-open」这个原始缺陷；只有 ③（errored）能发现
//   「把探测故障读成能力缺失」这个**反向**过度修复。②④⑤ 各自钉住一侧边界。
//   只写 ① 的话，把 `catch` 写成 `dUsable = false` 也能全绿 —— 那是另一种错。
import test from 'node:test';
import assert from 'node:assert/strict';

import { agentChannelFactsOf, createAgentPort } from '../lib/provider-dsh/agent.js';

// 宿主 `ToolRuntime` 的**忠实面**：`execute` + `get`（真实宿主恒有 `get`）。
// `getOf` 决定本档场景；`execute` 恒在（「工具面在位」这一腿不变）。
const hostToolsOf = (getOf) => ({ execute: async () => ({ isError: false }), get: getOf });

const D_ABSENT = { available: false, reason: 'port-absent:agentTeam' };
const D_PRESENT = { available: true, reason: null };

/** D 档单点读数（报告面与端口门禁面共用同一实现）。 */
const dOf = (ctx) => agentChannelFactsOf(ctx).agentTeam;

// ── ① absent：工具被剔除（宿主 `get` 按约定返回 `null`）⇒ **必须**报不可用 ────────────────────
//    这是 B-1 要消灭的假绿本身。修复前实测 `{available:true, reason:null}` ⇒ 本条 RED。
test('①absent：宿主忠实面 + spawn_teammate 被剔除 ⇒ agentTeam.available === false（禁 fail-open）', () => {
  const reading = dOf({ tools: hostToolsOf(() => null) });
  assert.deepEqual(reading, D_ABSENT,
    '档①：`get` 返回 null = 工具已剔除 ⇒ 必须报 `port-absent:agentTeam`；实测=' + JSON.stringify(reading));
});

// ── ② present：阳性对照（工具在位）⇒ 必须报可用 ───────────────────────────────────────────────
test('②present：宿主忠实面 + spawn_teammate 在位 ⇒ agentTeam = {available:true, reason:null}（阳性对照）', () => {
  const reading = dOf({ tools: hostToolsOf(() => ({ name: 'spawn_teammate' })) });
  assert.deepEqual(reading, D_PRESENT,
    '档②：`get` 返回定义对象 ⇒ 必须报可用（排除支不得误伤在位工具）；实测=' + JSON.stringify(reading));
});

// ── ③ errored：`get` 抛错 ⇒ **保持可用**（探测坏 ≠ 面没装）────────────────────────────────────
test('③errored：宿主 get 抛错 ⇒ agentTeam.available === true（禁把探测故障读成能力缺失）', () => {
  const reading = dOf({ tools: hostToolsOf(() => { throw new Error('host get blew up'); }) });
  assert.deepEqual(reading, D_PRESENT,
    '档③：查询失败是三态里的 errored，**不是** absent ⇒ 不得改判不可用；实测=' + JSON.stringify(reading));
});

// ── ④ 不可内省：宿主 `get` 不是函数 ⇒ 拿不到证据 ⇒ **保持可用**（不能确认就不宣称排除）────────────
// 【2026-11-06 Leader 授权修订（批 punky-engine-fix2-20261106 · 选项 A）】本档期望值由 `D_ABSENT` 翻为 `D_PRESENT`。
//   原因：用户裁决原文是「不可内省时**不得声称**已做 absent 排除」——只要求不宣称，**没要求判死**。
//   「不能检查（port-unavailable）」≠「确认不存在（absent）」；把前者读成后者会让真实宿主上
//   「工具面在、execute 可调、只是拿不到 get 内省」的形态被误判为 D 档不可用（正是上一批 A 类 6 红的总根）。
//   ⇒ 保持 `true`（可用），但**不声称**已做 absent 排除，二者不矛盾。
test('④不可内省：宿主 get 不是函数 ⇒ agentTeam.available === true（不能内省 ≠ 确认不存在）', () => {
  const reading = dOf({ tools: { execute: async () => ({ isError: false }) } });
  assert.deepEqual(reading, D_PRESENT,
    '档④：内省能力缺失 ⇒ 不得声称已完成 absent 排除，但也不据此判死（`port-unavailable` ≠ `absent`）；实测=' + JSON.stringify(reading));
});

// ── ⑤ 工具面整体缺失 ⇒ 不可用（与改前同值）─────────────────────────────────────────────────────
test('⑤工具面缺失：无 ctx.tools ⇒ agentTeam.available === false（与改前同值）', () => {
  const reading = dOf({});
  assert.deepEqual(reading, D_ABSENT,
    '档⑤：工具面整体缺失 ⇒ 不可用；实测=' + JSON.stringify(reading));
});

// ── ⑥ 聚合面跟随：D 档 false 时端口 `available` 不得靠 D 档撑起（C 档也缺 ⇒ 整体 false）─────────
//    `createAgentPort` 的 `available` = C || D（OR 聚合，环 1 口径）。
//    D 档塌了若仍报 true，说明读到的还是旧口径/另一份判断。
test('⑥聚合面向下传导：D 档 absent 且 C 档缺失 ⇒ 端口 available === false；D 档 present ⇒ available === true', () => {
  const dAbsent = createAgentPort({ tools: hostToolsOf(() => null) });
  assert.equal(dAbsent.available, false,
    'D 档 absent + C 档缺失 ⇒ 端口必须报不可用（D 档读数须真的进入聚合，而不是旁路一份）；实测=' + String(dAbsent.available));

  const dPresent = createAgentPort({ tools: hostToolsOf(() => ({ name: 'spawn_teammate' })) });
  assert.equal(dPresent.available, true,
    'D 档 present ⇒ OR 聚合下端口可用（阳性对照，防「一律 false」的过度修复）');
});
