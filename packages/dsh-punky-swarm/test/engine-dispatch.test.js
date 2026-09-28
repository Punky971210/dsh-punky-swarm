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

// 引擎自派（B1–B6）单测：策略纯函数 + lane_dispatch 工具的真实 spawn 路径（注入 fake ctx.subagents）。
// 依据：2026-09-16 用户裁决「执行」（方案 C：本轮落 A+B）；调研结论 K4（能力位前置）、W5/W6（显式失败/唯一写路径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import { EVT_MEMBER_DISPATCH, EVT_SWARM_REPORT, EVT_SWARM_CC } from '../lib/state/event-types.js';
import {
  laneBindingOf, mailboxRootOf, REPORT_CHANNEL,
} from '../lib/engine/dispatch.js';
import { __resetLaneHandles } from '../lib/bridge/lane-handle.js';
import { SUITE_DENY_TOOLS, labelOf, composeWorkerPrompt, buildStartRequest, mapSpawnError, subagentRuntimeOf, evaluateTierCDispatch, readGateMode } from '../lib/engine/dispatch.js';
import { issueLaneHandle, LANE_HANDLE_TTL_MS } from '../lib/bridge/lane-handle.js';
import { bindingGapOf } from '../lib/watch/lane-heartbeat.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

function mkCtx(runtime) {
  const calls = { info: [], warn: [], error: [] };
  const ctx = {
    on() { return () => {}; },
    tools: { register() {} },
    logger: { info: (...a) => calls.info.push(a.join(' ')), warn: (...a) => calls.warn.push(a.join(' ')), error: (...a) => calls.error.push(a.join(' ')) },
    calls,
  };
  if (runtime) ctx.subagents = runtime;
  return ctx;
}
function seedBatch(root, sessionId, batchId, laneId = 'l1') {
  const store = createStore(root);
  // Tier3 entry 门：exec 层 lane 须声明 consume，且上游产物须落盘 ⇒ 夹具补 plan 产物
  const artRoot = path.join(root, 'sessions', sessionId, 'artifacts', batchId);
  fs.mkdirSync(path.join(artRoot, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(artRoot, 'plan', 'spec.md'), '# 规格夹具\n', 'utf8');
  store.createBatch(sessionId, {
    batchId,
    wavePlan: buildWavePlan({
      batchId,
      tasks: [
        { id: 'p1', cmd: 'plan 规格（夹具）', layer: 'plan', role: 'coordinator', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: laneId, cmd: '实现 X', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/' + laneId + '/outputs/x.md'] },
        { id: 'a-' + laneId, cmd: '按验收标准逐条核对', layer: 'audit', role: 'supervisor', deps: [laneId], consume: ['plan/spec.md'] },
      ],
    }),
    phase: 'running',
  });
  store.writeGovernance(sessionId, {
    lastAssign: { difficulty: 'C', form: 'C', scope: 'full', rationale: 'fixture：引擎自派前置评估（三层批 ⇒ C）', reasons: [], at: new Date().toISOString(), execCallsSince: 0 },
  });
  return store;
}

// ── P：策略纯函数 ──
;

test('P2 任务包骨架：含句柄首行 + lane/层/角色 + 消费产出 + 纪律 + Leader 要点', () => {
  const p = composeWorkerPrompt({
    batchId: 'b-1', lane: 'e1', cmd: '实现 X', layer: 'exec', role: 'coder',
    consume: ['plan/spec.md'], produce: ['exec/e1/'], outputs: ['exec/e1/outputs/x.md'],
    firstLine: '[swarm-lane:b-1/e1#0123456789abcdef]', leaderPrompt: '先读规格再动手', artifactsRoot: 'R:/artifacts/b-1',
  });
  assert.ok(p.startsWith('[swarm-lane:b-1/e1#0123456789abcdef]'), '首行必须是句柄（唯一凭证）');
  for (const k of ['`e1`', '`exec`', '`coder`', 'plan/spec.md', 'exec/e1/outputs/x.md', 'R:/artifacts/b-1', '禁 `git` 写', '先读规格再动手',
    // 【2026-09-27 引导缺口补强】交接纪律须进所有层的任务包（本会话 4 次漏交 audit lane ⇒ 停轮）
    'handoff_submit', 'GATE_HANDOFF_MISSING']) {
    assert.ok(p.includes(k), '任务包缺要素：' + k);
  }
  // exec 层**不应**带 plan 专属的六标题纪律（按层裁剪，防空转）
  assert.equal(p.includes('六个【裸标题】'), false, '非 plan 层不应带六标题纪律');
});

test('P2b 任务包骨架 · plan 层：额外带「六标题齐备」纪律（本会话 1 次缺 ## 约束 ⇒ GATE_PLAN_CONTRACT 停轮）', () => {
  const p = composeWorkerPrompt({
    batchId: 'b-2', lane: 'p1', cmd: '定规格', layer: 'plan', role: 'coordinator',
    produce: ['plan/spec.md'], firstLine: '[swarm-lane:b-2/p1#0123456789abcdef]', artifactsRoot: 'R:/artifacts/b-2',
  });
  for (const k of ['六个【裸标题】', '`## 概述`', '`## 问题`', '`## 方案`', '`## 需求`', '`## 验收标准`', '`## 约束`',
    '内容允许为空', 'GATE_PLAN_CONTRACT', 'handoff_submit']) {
    assert.ok(p.includes(k), 'plan 层任务包缺要素：' + k);
  }
});

// ── 【2026-09-27 · GR-12 / GR-13】任务包引导缺口两条新规则的**可达断言** ──
//   GR-12：exec/audit 报告的验收项编号以判据源 **§6** 为准，**不等于**判据源 `## 验收标准` 章内的**自检项**编号。
//   GR-13：「单件写盘 lane」（写盘约束 = 只写一件）与纪律「每步落 progress 快照」**直接冲突** ⇒ 引擎自动抑制。
//   ⚠ 两条断言均为**可达构造**（规则缺失即变红，禁空转 —— 纪律 §15⑤）：
//     GR-12 缺规则 ⇒ `§6` / `L-AC` 断言红；GR-13 缺分支 ⇒ 单件 lane 仍带默认 progress 行 ⇒ 反向断言红。
test('P2c 任务包骨架 · GR-12：验收项编号口径以判据源 §6 为准（≠ 判据源自检项编号）', () => {
  const p = composeWorkerPrompt({
    batchId: 'b-ac', lane: 'e1', cmd: '实现 X', layer: 'exec', role: 'coder',
    consume: ['plan/spec.md'], produce: ['exec/e1/'], outputs: ['exec/e1/outputs/x.md'],
    firstLine: '[swarm-lane:b-ac/e1#0123456789abcdef]', artifactsRoot: 'R:/artifacts/b-ac',
  });
  for (const k of ['§6', 'L-AC', '自检项', '照抄 §6 的编号']) {
    assert.ok(p.includes(k), 'GR-12 口径缺要素：' + k);
  }
});

test('P2d 任务包骨架 · GR-13 默认支：非单件写盘 lane 必须列 progress 快照行（纪律 §0i）', () => {
  const p = composeWorkerPrompt({
    batchId: 'b-sw0', lane: 'e1', cmd: '实现 X', layer: 'exec', role: 'coder',
    produce: ['exec/e1/'], outputs: ['exec/e1/outputs/x.md'], // 写盘面 2 件 ⇒ 非单件
    firstLine: '[swarm-lane:b-sw0/e1#0123456789abcdef]',
  });
  assert.ok(p.includes('progress/NN-<slug>.md'), '默认支须列 progress 快照行');
  assert.equal(p.includes('单件写盘 lane'), false, '非单件 lane 不得走抑制支');
});

test('P2e 任务包骨架 · GR-13 抑制支：audit 层 + 声明写盘面恰一件 ⇒ 自动抑制 progress 行（冲突时从更严者）', () => {
  const single = composeWorkerPrompt({
    batchId: 'b-sw1', lane: 'a1', cmd: '聚合验收', layer: 'audit', role: 'supervisor',
    consume: ['plan/spec.md'], produce: ['audit/slim-summary.md'], outputs: ['audit/slim-summary.md'],
    firstLine: '[swarm-lane:b-sw1/a1#0123456789abcdef]', artifactsRoot: 'R:/artifacts/b-sw1',
  });
  assert.ok(single.includes('单件写盘 lane'), '须显式声明本 lane 为单件写盘 lane');
  assert.ok(single.includes('自动抑制'), '须写明 progress 行被自动抑制');
  assert.equal(single.includes('progress/NN-<slug>.md'), false,
    '抑制支不得再出现默认 progress 行（否则两条纪律仍在打架）');
  // 显式声明位（直调逃生阀）：exec 层亦可强制走抑制支
  const forced = composeWorkerPrompt({
    batchId: 'b-sw2', lane: 'e2', cmd: '单件产出', layer: 'exec', role: 'coder',
    produce: ['exec/e2/'], outputs: ['exec/e2/one.md'], singleArtifactWrite: true,
    firstLine: '[swarm-lane:b-sw2/e2#0123456789abcdef]',
  });
  assert.ok(forced.includes('单件写盘 lane'), 'singleArtifactWrite:true ⇒ 显式走抑制支');
  // 反向：audit 层但声明写盘面 2 件 ⇒ **不**自动判单件（防过度抑制）
  const two = composeWorkerPrompt({
    batchId: 'b-sw3', lane: 'a3', cmd: '两份报告', layer: 'audit', role: 'supervisor',
    produce: ['audit/slim-summary.md', 'audit/gap-list.json'], outputs: [],
    firstLine: '[swarm-lane:b-sw3/a3#0123456789abcdef]',
  });
  assert.equal(two.includes('单件写盘 lane'), false, '写盘面 2 件不得自动判单件');
});

test('P3 startRequest（one-shot 平铺）：label + toolFilter.deny（套件自带 + 追加、去重）+ maxDepth=1 + parent', () => {
  const parent = { id: 'agent-1' };
  const request = buildStartRequest({ batchId: 'b-1', lane: 'e1', parent, prompt: 'task' });
  assert.equal(request.label, 'punky-swarm:b-1:e1');
  assert.equal(request.parent, parent);
  assert.equal(request.maxDepth, 1);
  assert.equal(request.prompt[0].text, 'task');
  assert.ok(request.toolFilter.deny.includes('assign_check') && request.toolFilter.deny.includes('wave_plan'));
  assert.ok(request.signal, 'one-shot 请求必须带自持 signal（禁透传 exec.signal，见头部纪律）');
  const request2 = buildStartRequest({ batchId: 'b', lane: 'l', parent, prompt: 'x', extraDeny: ['assign_check', 'my_tool'] });
  const d = request2.toolFilter.deny;
  assert.equal(d.filter((x) => x === 'assign_check').length, 1, '去重');
  assert.ok(d.includes('my_tool'), '追加生效');
  assert.ok(SUITE_DENY_TOOLS.includes('member_settle') && SUITE_DENY_TOOLS.includes('lane_dispatch'), '成员不得再派/写状态');
});

test('P4 mapSpawnError：能力位/ provider / 其它 三类归一（B4 能力位前置的可读码面）', () => {
  assert.equal(mapSpawnError(new Error('provider "x" cannot enforce toolFilter (no toolFilter capability)')).code, 'GATE_DISPATCH_CAPABILITY_MISSING');
  assert.equal(mapSpawnError(new Error('unknown provider: y')).code, 'GATE_DISPATCH_PROVIDER_INVALID');
  assert.equal(mapSpawnError(new Error('boom')).code, 'GATE_DISPATCH_FAILED');
});

test('P5 subagentRuntimeOf：仅当 start（one-shot 通道）可调用才算可用（否则降级）', () => {
  assert.equal(subagentRuntimeOf(mkCtx(null)), null);
  assert.equal(subagentRuntimeOf(mkCtx({})), null);
  assert.equal(subagentRuntimeOf(mkCtx({ start: () => {} })) !== null, true);
  assert.equal(subagentRuntimeOf(mkCtx({ startContinuable: () => {} })), null,
    '仅存 continuable 通道 ⇒ 不可用（2026-09-22 one-shot 化）');
});

// ── G：C 阶段派发面门禁（软启用；纯函数判定） ──
test('G1 缺省 warn：C 档无句柄 ⇒ 不拦、只留痕告警（防自锁）', () => {
  assert.equal(readGateMode({}), 'warn');
  assert.equal(readGateMode({ dispatch: { gate: 'enforce' } }), 'enforce');
  assert.equal(readGateMode({ dispatch: { gate: '别的东西' } }), 'warn', '非法值回落 warn（宁松不锁）');
  const dec = evaluateTierCDispatch({ tier: 'C', toolName: 'subagent', argsText: '普通任务包（无句柄）', config: {}, handleCheck: () => ({ ok: false, reason: 'no-handle' }) });
  assert.equal(dec.applies, true);
  assert.equal(dec.ok, true);
  assert.equal(dec.denyReason, null);
  assert.ok(dec.warnNote.includes('mode=warn') && dec.warnNote.includes('no-handle'));
});

// 【gate-lite 第二批 · B（2026-09-17 用户裁决）】**翻转**：原用例「G2 enforce ⇒ 拒
//   GATE_SUBAGENT_OUTSIDE_LANES」——该码已删（官方 profile 已 disable 宿主 subagent/subagent_fork）
//   ⇒ 现语义 = **两档皆不拦，只留痕**；保留原「文案含可照抄动作 + 回显句柄判据」两条结构断言。
test('G2 语义变迁（B 项）：enforce 档下 C 档无句柄 ⇒ **不再拒**（码已删）；留痕文案含可照抄动作', () => {
  const dec = evaluateTierCDispatch({ tier: 'C', toolName: 'subagent_fork', argsText: '', config: { dispatch: { gate: 'enforce' } }, handleCheck: () => ({ ok: false, reason: 'handle-expired' }) });
  assert.equal(dec.ok, true, '拒态已随码删除 ⇒ 恒放行');
  assert.equal(dec.denyReason, null, 'denyReason 恒 null（结构保留，读端零漂移）');
  assert.equal(dec.mode, 'enforce', 'mode 仍回显配置面事实（审计/热更可观测）');
  assert.ok(dec.warnNote.includes('lane_dispatch({ batchId, lane })') && dec.warnNote.includes('firstLine'), '留痕文案须给可照抄范式');
  assert.ok(dec.warnNote.includes('handle-expired'), '须回显句柄判据');
});

test('G3 有效句柄 ⇒ 放行（两档皆然）；B 档/非派发工具 ⇒ 本门不适用', () => {
  __resetLaneHandles();
  const h = issueLaneHandle({ batchId: 'b-g', lane: 'e1', sessionId: 's' });
  const check = (txt) => {
    const hh = /\[swarm-lane:[^\]]+\]/.exec(txt);
    return hh ? { ok: true } : { ok: false, reason: 'no-handle' };
  };
  for (const mode of ['warn', 'enforce']) {
    const dec = evaluateTierCDispatch({ tier: 'C', toolName: 'subagent', argsText: '首行 ' + h.firstLine, config: { dispatch: { gate: mode } }, handleCheck: check });
    assert.equal(dec.applies, true);
    assert.equal(dec.ok, true);
    assert.equal(dec.warnNote, null);
    assert.equal(dec.denyReason, null);
  }
  for (const t of ['B', 'A', null]) {
    const d = evaluateTierCDispatch({ tier: t, toolName: 'subagent', argsText: '', config: { dispatch: { gate: 'enforce' } }, handleCheck: () => ({ ok: false, reason: 'x' }) });
    assert.equal(d.applies, false, 'tier=' + t + ' 不受本门约束');
    assert.equal(d.ok, true);
  }
  const dTool = evaluateTierCDispatch({ tier: 'C', toolName: 'lane_heartbeat', argsText: '', config: { dispatch: { gate: 'enforce' } }, handleCheck: () => ({ ok: false, reason: 'x' }) });
  assert.equal(dTool.applies, false, '非派发工具不受本门约束');
  __resetLaneHandles();
});

// ── R：D 阶段 · 成员侧套件通信（swarm_report / swarm_cc） ──
test('R1 laneBindingOf：无登记 ⇒ null；有 member.dispatch ⇒ 反查 (sessionId, batchId, lane)', () => {
  const root = tempRoot('punky-edr1-');
  const store = seedBatch(root, 'sess-c', 'b-r1');
  assert.equal(laneBindingOf(store, 'ws-none'), null);
  store.appendEvent('sess-c', 'b-r1', EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'ws-b1' });
  assert.deepEqual(laneBindingOf(store, 'ws-b1'), { sessionId: 'sess-c', batchId: 'b-r1', lane: 'l1' });
});

test('R2 swarm_report：绑定成员 ⇒ 事件 swarm.report + Leader 通道（broadcast）双留痕', async () => {
  const root = tempRoot('punky-edr2-');
  const store = seedBatch(root, 'sess-c', 'b-r2');
  store.appendEvent('sess-c', 'b-r2', EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'ws-w1' });
  const ctx = mkCtx(null);
  const tools = createCoreTools(ctx, { store, root, config: {} });
  const rep = tools.find((t) => t.name === 'swarm_report');
  assert.ok(rep, 'swarm_report 已注册');
  const r = await rep.execute({ type: 'progress', summary: '工件已落盘', artifactPath: 'exec/l1/outputs/x.md' }, { agent: { session: { id: 'ws-w1' } } });
  assert.equal(r.delivered, true);
  assert.equal(r.batchId, 'b-r2');
  assert.equal(r.lane, 'l1');
  const evs = store.readBatch('sess-c', 'b-r2').events.filter((e) => e.type === EVT_SWARM_REPORT);
  assert.equal(evs.length, 1, '恰 1 条 swarm.report 事件');
  const boxRoot = mailboxRootOf(root, 'sess-c', 'b-r2');
  assert.equal(REPORT_CHANNEL.leader, 'broadcast');
  assert.ok(fs.existsSync(path.join(boxRoot, 'broadcast')), 'Leader 通道（broadcast）有落盘');
});

test('R3 swarm_cc：绑定成员 ⇒ 事件 swarm.cc + Manager 通道（supervisor/inbox）双留痕', async () => {
  const root = tempRoot('punky-edr3-');
  const store = seedBatch(root, 'sess-c', 'b-r3');
  store.appendEvent('sess-c', 'b-r3', EVT_MEMBER_DISPATCH, { lane: 'l1', workerSessionId: 'ws-w2' });
  const ctx = mkCtx(null);
  const tools = createCoreTools(ctx, { store, root, config: {} });
  const cc = tools.find((t) => t.name === 'swarm_cc');
  assert.ok(cc, 'swarm_cc 已注册');
  await cc.execute({ type: 'anomaly', summary: '上游产物缺失' }, { agent: { session: { id: 'ws-w2' } } });
  assert.equal(store.readBatch('sess-c', 'b-r3').events.filter((e) => e.type === EVT_SWARM_CC).length, 1);
  assert.equal(REPORT_CHANNEL.manager, 'inbox');
  assert.ok(fs.existsSync(path.join(mailboxRootOf(root, 'sess-c', 'b-r3'), 'supervisor', 'inbox')), 'Manager 通道（supervisor/inbox）有落盘');
});

// gate-lite Q-G2（2026-09-17 用户裁决「**删除这一项**」）：身份门已删 ⇒ 未绑定**不再拒**。
//  官方 Team 成员由宿主 `spawn_teammate` 拉起，**天然无 `member.dispatch` 绑定**（常态，非异常）——
//  本条是「删除门」后的**新语义回归锁**（不是删用例）：消息照发（`delivered:true`）、如实回显
//  `unbound:true`，且**无 batchId 时不落事件**（`eventWritten:false`——无批次文件即无事件面，
//  如实回显、不静默、不谎报成功）。
test('R4 未绑定会话调套件通信 ⇒ 放行 + 如实回显（Q-G2：官方成员无 lane 绑定为常态，不再拒）', async () => {
  const root = tempRoot('punky-edr4-');
  const store = seedBatch(root, 'sess-c', 'b-r4');
  const ctx = mkCtx(null);
  const tools = createCoreTools(ctx, { store, root, config: {} });
  for (const [name, type] of [['swarm_report', 'progress'], ['swarm_cc', 'anomaly']]) {
    const t = tools.find((x) => x.name === name);
    const r = await t.execute({ type, summary: 'x' }, { agent: { session: { id: 'sess-orphan' } } });
    assert.equal(r.delivered, true, name + ' 未绑定仍须投递（消息照发，不改一处既有投递语义）');
    assert.equal(r.unbound, true, name + ' 须如实回显 unbound:true');
    assert.equal(r.eventWritten, false, name + ' 无 batchId ⇒ 事件未落（如实回显，不静默）');
    assert.equal(r.batchId, '(unbound)', name + ' 无批次可解析 ⇒ 批次占位 `(unbound)` 可读');
  }
  assert.equal(store.readBatch('sess-c', 'b-r4').events.filter((e) => e.type === EVT_SWARM_REPORT || e.type === EVT_SWARM_CC).length, 0, '未绑定且未自报批次 ⇒ 不落批事件（结构性断言保留）');
});

// ── B2：D2 绑定缺口探测（心跳档族内的纯判定） ──
test('B2 bindingGapOf：无 dispatch ⇒ no-dispatch；有 dispatch 且无悬挂句柄 ⇒ 无缺口；未绑定 + 超 TTL 未消费句柄 ⇒ token-ttl-expired；已绑定 ⇒ hit:false', () => {
  __resetLaneHandles();
  const t0 = 1_700_000_000_000;
  const b0 = { batchId: 'b-gap', events: [] };
  assert.deepEqual(bindingGapOf(b0, 'l1', t0, null), { hit: true, reason: 'no-dispatch' });
  // ⚠ 夹具**刻意不带** `workerSessionId`（P2 e-tests 修，2026-09-16）：本变量要构造的是「有派发事件但
  //   **未绑定**」形态。原夹具带 `workerSessionId:'ws-1'` ⇒ 命中 e-watch 落地的「**无绑定才报**」判据
  //   （已绑定 ⇒ 直接 `hit:false`）⇒ 下方 `token-ttl-expired` 分支**永不可达**（断言成了死码）。
  const withDispatch = { batchId: 'b-gap', events: [{ type: 'member.dispatch', lane: 'l1', ts: new Date(t0 - 60_000).toISOString() }] };
  assert.deepEqual(bindingGapOf(withDispatch, 'l1', t0, null), { hit: false, reason: null });
  // stint 起点晚于 dispatch ⇒ 视为本 stint 未绑定
  assert.equal(bindingGapOf(withDispatch, 'l1', t0, new Date(t0 - 30_000).toISOString()).reason, 'no-dispatch');
  // 超 TTL 未消费句柄 ⇒ 悬挂意图
  issueLaneHandle({ batchId: 'b-gap', lane: 'l1', sessionId: 's', now: t0 });
  assert.equal(bindingGapOf(withDispatch, 'l1', t0 + LANE_HANDLE_TTL_MS + 1, null).reason, 'token-ttl-expired');
  // TTL 内 ⇒ 不算缺口（给派发留时间窗）
  assert.equal(bindingGapOf(withDispatch, 'l1', t0 + 1000, null).hit, false);
  // 【P2 补钉】**已绑定**（dispatch 带非空 workerSessionId）⇒ 即便同一 (batch,lane) 残留**超 TTL 未消费**
  //   句柄，也不得报缺口：句柄残留 ≠ 无绑定（否则引擎自派后的旧句柄会把真绑定报成「幽灵悬挂意图」）。
  const bound = { batchId: 'b-gap', events: [{ type: 'member.dispatch', lane: 'l1', ts: new Date(t0 - 60_000).toISOString(), workerSessionId: 'ws-1' }] };
  assert.deepEqual(bindingGapOf(bound, 'l1', t0 + LANE_HANDLE_TTL_MS + 1, null), { hit: false, reason: null },
    '已绑定 + 超 TTL 残句柄 ⇒ 零假 gap（判据 = 无绑定才报）');
  __resetLaneHandles();
});

test('T1 引擎自派成功：写 member.dispatch（B5 唯一写路径）+ 返回 workerSessionId + 按次收窄（B2）', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-ed1-');
  const store = seedBatch(root, 'sess-c', 'b-ed1');
  let captured = null;
  const ctx = mkCtx({ start: async (provider, request) => { captured = { provider, ...request }; return { id: 'ws-eng-1', result: Promise.resolve({ output: [], stopReason: 'completed' }) }; } });
  const tools = createCoreTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  const exec = { agent: { session: { id: 'sess-c' } } };
  const r = await ld.execute({ batchId: 'b-ed1', lane: 'l1', prompt: '要点：先读规格' }, exec);
  assert.equal(r.spawned, true);
  assert.equal(r.workerSessionId, 'ws-eng-1');
  assert.equal(r.status, 'running');
  // B2 按次收窄 + B3 label + B1 任务包（one-shot 平铺形态；provider 由 rt.start 首参直传）
  assert.equal(captured.provider, 'spawn-in-process');
  assert.equal(captured.label, 'punky-swarm:b-ed1:l1');
  assert.ok(captured.toolFilter.deny.includes('wave_plan'));
  assert.equal(captured.parent, exec.agent);
  assert.ok(captured.prompt[0].text.includes(r.firstLine), '任务包含句柄首行');
  assert.ok(captured.prompt[0].text.includes('要点：先读规格'), 'Leader 要点已拼接');
  // B5：引擎直接登记（不依赖 post-execute 观察）
  const b = store.readBatch('sess-c', 'b-ed1');
  const dis = b.events.filter((e) => e.type === EVT_MEMBER_DISPATCH);
  assert.equal(dis.length, 1);
  assert.equal(dis[0].workerSessionId, 'ws-eng-1');
  assert.equal(dis[0].lane, 'l1');
  __resetLaneHandles();
});

test('T2 宿主无 ctx.subagents ⇒ 优雅降级「仅发句柄」（spawned:false + 原因，不静默）', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-ed2-');
  const store = seedBatch(root, 'sess-c', 'b-ed2');
  const ctx = mkCtx(null);
  const tools = createCoreTools(ctx, { store, root, config: {} });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  const r = await ld.execute({ batchId: 'b-ed2', lane: 'l1' }, { agent: { session: { id: 'sess-c' } } });
  assert.equal(r.spawned, false);
  assert.ok(r.spawnNote && r.spawnNote.includes('ctx.subagents'), '须给出可读原因');
  assert.ok(r.firstLine.startsWith('[swarm-lane:b-ed2/l1#'), '句柄照常发放');
  __resetLaneHandles();
});

test('T3 未配置 provider ⇒ **降级为仅发句柄**（N1 清债：不再抛错丢句柄；B4：仍不猜 provider）', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-ed3-');
  const store = seedBatch(root, 'sess-c', 'b-ed3');
  const ctx = mkCtx({ start: async () => ({ id: 'ws-x', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) });
  const tools = createCoreTools(ctx, { store, root, config: {} });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  // 【2026-09-16 评审 N1】旧契约：抛 `GATE_DISPATCH_CAPABILITY_MISSING`——但那会**丢掉刚发的句柄**，
  //   留下「lane=running、无 worker、无句柄」僵尸态。新契约：与「宿主无 ctx.subagents」同族 ⇒ 降级为
  //   「仅发句柄」（lane 保持 running、句柄原样返回），Leader 可补配置重派或用 firstLine 直派。
  const r = await ld.execute({ batchId: 'b-ed3', lane: 'l1' }, { agent: { session: { id: 'sess-c' } } });
  assert.equal(r.spawned, false, '不猜 provider ⇒ 不派');
  assert.ok(r.firstLine && r.firstLine.includes('swarm-lane:'), '必须把句柄交回（旧契约在此处丢句柄）');
  assert.match(String(r.spawnNote), /provider/);
  assert.equal(store.readBatch('sess-c', 'b-ed3').lanes.l1, 'running', 'lane 置 running 且句柄在手上 ⇒ 可补配重派/直派');
  assert.equal(store.readBatch('sess-c', 'b-ed3').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 0, '未自派即不得落登记');
  __resetLaneHandles();
});

test('T4 provider 缺 toolFilter 能力（宿主拒绝）⇒ 归一为 GATE_DISPATCH_CAPABILITY_MISSING（B6 失败显式）', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-ed4-');
  const store = seedBatch(root, 'sess-c', 'b-ed4');
  const ctx = mkCtx({ start: async () => { throw new Error('tool-subagent: provider "p" cannot enforce toolFilter (no toolFilter capability)'); } });
  const tools = createCoreTools(ctx, { store, root, config: { dispatch: { provider: 'p' } } });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  await assert.rejects(() => ld.execute({ batchId: 'b-ed4', lane: 'l1' }, { agent: { session: { id: 'sess-c' } } }), /GATE_DISPATCH_CAPABILITY_MISSING/);
  // 失败不得落登记（不留「幽灵绑定」）
  assert.equal(store.readBatch('sess-c', 'b-ed4').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 0);
  __resetLaneHandles();
});
