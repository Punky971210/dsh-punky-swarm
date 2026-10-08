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
import { buildWavePlan, assembleCmd } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import { EVT_MEMBER_DISPATCH, EVT_SWARM_REPORT, EVT_SWARM_CC } from '../lib/state/event-types.js';
import {
  laneBindingOf, mailboxRootOf, REPORT_CHANNEL,
} from '../lib/engine/dispatch.js';
import { __resetLaneHandles } from '../lib/bridge/lane-handle.js';
import { SUITE_DENY_TOOLS, labelOf, composeWorkerPrompt, buildStartRequest, mapSpawnError, subagentRuntimeOf, evaluateTierCDispatch, readGateMode } from '../lib/engine/dispatch.js';
// 【2026-10-07 · P2（批 role-injection-refactor-20261006 / lane e02-inject）】role 数据面注入面的读端。
// 【2026-10-08 · 本批 role-deliverable-inject-fix-20261008 / lane e01-impl】补 `ROLE_MANDATORY_FIELDS`（R-1 判据面）
//   与 `roleCorpusRoot`（L-AC-9 的仓库面扫描起点）。
import { resolveRoleRef, deriveDenyTools, roleToolVocabulary, ROLE_SECTION_TITLES, ROLE_UNRESOLVED_CODE, ROLE_MANDATORY_FIELDS, roleCorpusRoot } from '../lib/engine/dispatch.js';
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
function seedBatch(root, sessionId, batchId, laneId = 'l1', laneRole = 'coder') {
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
        { id: laneId, cmd: '实现 X', layer: 'exec', role: laneRole, deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/' + laneId + '/outputs/x.md'] },
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

// ── 【2026-10-07 · P2（批 `role-injection-refactor-20261006` / lane `e02-inject`）】role 数据面三处注入 ──
// 判据源 = `plan/role-injection-spec.md`：R-3（任务级三段）/ R-4（persona）/ R-5（allow 反推 deny），
// 对应验收项 **L-AC-3 / L-AC-4 / L-AC-5**；`L-AC-12 / L-AC-13` 为批级共用项（本节给 lane 侧自证面）。
// ⚠ 全部断言为**可达构造**（行为缺失即变红，禁空转，纪律 §15⑤）：裸标题逐行比对 / 集合包含 / 逐字 substring / 抛错码面。

// ── 【2026-10-08 · 本批 `role-deliverable-inject-fix-20261008` / lane `e01-impl`】注入面去路径化判据助手 ──
// 判据源 = `plan/scope-spec.md`（R-1..R-6 / L-AC-1..L-AC-9）；两个助手的口径与判据源 §5 附探针**逐字一致**。
// ⚠ 执行面提示：本检出缺 `@deepseek-ai/dsh-tools`（判据源 §7.2-2）⇒ 本文件当前不可执行；
//   机检读数以判据源 §5 附探针为准，本节断言为**词法面**（`baseline-snapshot` 可扫、可核）。

/** `## 交付要求` **段**提取（判据源 §5 口径：行首**恰为**该串起，至下一个行首 `## ` 前）。 */
function deliverablesSectionOf(promptText) {
  const lines = String(promptText).split('\n');
  const at = lines.findIndex((l) => l === ROLE_SECTION_TITLES.deliverables);
  if (at < 0) return null;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** 段内「路径噪声」五项计数（判据源 §5 逐字口径：出现**次数**，非布尔）。 */
function pathNoiseOf(sectionText) {
  const t = String(sectionText ?? '');
  return {
    j1: (t.match(/[^\s`]\/[^\s`]/g) ?? []).length,          // 无空白紧邻的斜杠
    j2: t.split('artifacts/').length - 1,                    // 宿主视角产物前缀
    j3: t.split('<batchId>').length - 1,                     // 批次占位符
    j4: (t.match(/\.(md|json|ya?ml|txt)\b/g) ?? []).length,  // 文件名后缀形态
    j5: (t.match(/``/g) ?? []).length,                       // 空反引号对
  };
}

const ROLE_FIXTURE = {
  title: 'T', mission: 'M', responsibilities: ['r1', 'r2'], authorities: ['a1'],
  // 【本批 R-2/R-5】夹具同步去路径化：`deliverables` 只声明**形态**（`form`），`path` 键不再参与渲染。
  deliverables: [{ form: '来源分级清单（Markdown）', must_contain: ['## 来源分级'] }], acceptance_hints: ['h1'],
  skills: ['spec-writing'],
  tools: { allow: ['read', 'write'], deny_derived: true },
};
const ROLE_IDS = ['coder', 'coordinator', 'designer', 'doc-manager', 'reviewer', 'supervisor', 'tester',
  'research-planner', 'researcher', 'research-auditor'];
// 「引擎治理面」= worker 必备的回报 / 交接 / 检查点 / 状态读面（deny 掉任一件即功能自毁）。
const GOVERNANCE_FACES = [...SUITE_DENY_TOOLS, 'handoff_submit', 'handoff_view', 'swarm_report', 'swarm_cc',
  'lane_checkpoint', 'lane_checkpoint_status', 'batch_status', 'gate_status', 'artifact_types', 'asset_claim',
  'task_pool', 'log_export', 'mailbox_read', 'mailbox_ack', 'mailbox_send', 'send_message'];

test('RO-1 L-AC-3：role 驱动任务级三段（裸标题行各 ≥1 ＋ 逐条命中 ＋ 结构隔离）', () => {
  const p = composeWorkerPrompt({
    batchId: 'b-ro', lane: 'l1', cmd: 'c', layer: 'exec', role: ROLE_FIXTURE,
    firstLine: '[swarm-lane:b-ro/l1#0123456789abcdef]', leaderPrompt: 'LEADER-ONLY-TEXT', artifactsRoot: 'R:/x',
  });
  const lines = p.split('\n');
  for (const t of [ROLE_SECTION_TITLES.responsibilities, ROLE_SECTION_TITLES.authorities, ROLE_SECTION_TITLES.deliverables]) {
    assert.equal(lines.filter((l) => l === t).length, 1, '裸标题行须**行首逐字**存在（不得带后缀）：' + t);
  }
  for (const r of ROLE_FIXTURE.responsibilities) assert.ok(p.includes(r), '职责逐条命中：' + r);
  assert.ok(p.includes('## 来源分级'), 'deliverables[].must_contain 逐条命中');
  assert.ok(p.includes('h1'), 'acceptance_hints 命中');
  assert.ok(p.includes('M'), 'mission 命中（R-3 口径含 mission）');
  // 【本批 R-2/R-3】渲染色三要素：形态（**不加反引号**）＋ 必含结构 ＋ 规格指向；且**零路径**。
  assert.ok(p.includes('- 交付件：来源分级清单（Markdown）'), 'R-3(a)：形态逐字渲染，且不得包反引号');
  assert.equal(p.includes('- 交付件：`'), false, 'R-2：形态**不得**加反引号（旧写法 `- 交付件：\\`…\\``）');
  assert.ok(p.includes('- 规格：见技能 `spec-writing`'), 'R-4：role 的 skills 字段成为注入源（规格指向行）');
  const sec = deliverablesSectionOf(p);
  assert.deepEqual(pathNoiseOf(sec), { j1: 0, j2: 0, j3: 0, j4: 0, j5: 0 },
    'R-2：交付要求段零路径（j1..j4）＋ 零空反引号（j5）');
  // 结构隔离（计划 §2.4）：Leader 文本只能在 `## 任务要点（Leader 补充）`，不得进 role 三段
  const three = p.slice(p.indexOf(ROLE_SECTION_TITLES.responsibilities), p.indexOf('## 纪律'));
  assert.equal(three.includes('LEADER-ONLY-TEXT'), false, 'Leader 文本不得出现在 role 三段内');
  assert.ok(p.indexOf('LEADER-ONLY-TEXT') > p.indexOf('## 任务要点'), 'Leader 文本只在任务要点段');
});

test('RO-2 L-AC-4：persona 与 toolFilter.deny 由 role 派生（⊇ 反推集 ＋ 冻结集不缩水 ＋ 无重复）', () => {
  const req = buildStartRequest({ batchId: 'b-ro', lane: 'l1', parent: {}, prompt: 't', role: ROLE_FIXTURE });
  assert.equal(typeof req.persona, 'string', 'persona 须为非空字符串');
  assert.ok(req.persona.length > 0);
  assert.ok(req.persona.includes('T') && req.persona.includes('M'), 'persona 含 title + mission 逐字（2/2）');
  const deny = new Set(req.toolFilter.deny);
  const derived = deriveDenyTools(ROLE_FIXTURE.tools.allow);
  assert.ok(derived.length > 0, '反推集须非空（否则本断言为空转）');
  for (const t of derived) assert.ok(deny.has(t), 'deny ⊇ deriveDeny(allow)：' + t);
  for (const t of SUITE_DENY_TOOLS) assert.ok(deny.has(t), 'deny ⊇ SUITE_DENY_TOOLS（冻结集不缩水）：' + t);
  assert.equal(req.toolFilter.deny.length, deny.size, 'deny 去重后长度相等（无重复项）');
});

test('RO-3 反向断言：十件 role 的反推集 ∩ 引擎治理面 = ∅（worker 回报/交接面不可被 deny）', () => {
  const all = [...new Set(ROLE_IDS.flatMap((id) => deriveDenyTools(resolveRoleRef(id).tools.allow)))];
  assert.ok(all.length > 0, '反推集非空（构造可达）');
  const clash = all.filter((t) => GOVERNANCE_FACES.includes(t));
  assert.deepEqual(clash, [], '反推不得 deny 引擎治理面：' + JSON.stringify(clash));
  // 词汇表本身也不得含治理面（结构安全的**根因**：词汇表只由 role 语料自身生成）
  const vocab = roleToolVocabulary();
  assert.ok(vocab.length > 0);
  assert.deepEqual(vocab.filter((t) => GOVERNANCE_FACES.includes(t)), [], '工具词汇表 ∩ 治理面 = ∅');
});

test('RO-4 语料可达：十件 role 逐件解析出 title/responsibilities/deliverables/tools.allow', () => {
  let n = 0;
  for (const id of ROLE_IDS) {
    const d = resolveRoleRef(id);
    assert.equal(typeof d.title, 'string', id + ' · title');
    assert.ok(d.title.length > 0, id + ' · title 非空');
    assert.ok(Array.isArray(d.responsibilities) && d.responsibilities.length > 0, id + ' · responsibilities');
    assert.ok(Array.isArray(d.deliverables) && d.deliverables.length > 0, id + ' · deliverables');
    // 【本批 R-2/R-5】形态面：逐条须有非空 `form`，且**不得**保留 `path` 键（去路径化的单元级判据）。
    for (const it of d.deliverables) {
      assert.equal(typeof it.form, 'string', id + ' · deliverables[].form 须为形态串');
      assert.ok(it.form.trim().length > 0, id + ' · form 非空');
      assert.equal('path' in it, false, id + ' · 不得保留 path 键');
    }
    assert.ok(Array.isArray(d.tools?.allow) && d.tools.allow.length > 0, id + ' · tools.allow');
    n++;
  }
  assert.equal(n, 10, '逐件解析件数');
});

test('RO-5 L-AC-5：role 查不到 ⇒ 拒派（GATE_ROLE_UNRESOLVED）；未声明 ⇒ 维持既有骨架（零回归）', () => {
  assert.throws(() => resolveRoleRef('no-such-role-xyz'),
    (e) => e.message.includes(ROLE_UNRESOLVED_CODE) && e.message.includes('no-such-role-xyz'));
  assert.throws(() => composeWorkerPrompt({ batchId: 'b', lane: 'l', cmd: 'c', layer: 'exec', role: 'no-such-role-xyz', firstLine: 'h' }),
    /GATE_ROLE_UNRESOLVED/);
  // 未声明 role（null/undefined/空串）**不是**「查不到」⇒ 既有形态零变化
  const legacy = composeWorkerPrompt({ batchId: 'b', lane: 'l', cmd: 'c', layer: 'exec', role: null, firstLine: 'h' });
  assert.ok(legacy.includes('**角色**：`-`'), '未声明 role ⇒ 头行保持既有形态');
  assert.equal(legacy.includes('## 你的职责'), false, '未声明 role 不得注入三段');
  const noRole = buildStartRequest({ batchId: 'b', lane: 'l', parent: {}, prompt: 'x' });
  assert.deepEqual(noRole.toolFilter.deny, [...SUITE_DENY_TOOLS], '无 role ⇒ deny 逐位等于冻结集');
  assert.equal(noRole.persona, undefined, '无 role ⇒ 不写 persona 字段');
});

test('RO-6 派发真形态：字符串 role id ⇒ 三段出现且头行**保留裸名**（既有读端零破）', () => {
  const p = composeWorkerPrompt({ batchId: 'b', lane: 'l1', cmd: 'c', layer: 'exec', role: 'coder', firstLine: 'h' });
  assert.ok(p.includes('`coder`（'), '头行须保留裸 role 名并补 title');
  assert.ok(p.includes(ROLE_SECTION_TITLES.responsibilities), '字符串 id ⇒ 三段生效');
  const req = buildStartRequest({ batchId: 'b', lane: 'l1', parent: {}, prompt: 'x', role: 'coder' });
  assert.ok(req.persona.includes(resolveRoleRef('coder').title), 'persona 由 role 派生（含 title）');
});

test('RO-7 未声明 tools.allow ⇒ 不反推（返回 []／deny 保持冻结集，防误禁阉割）', () => {
  assert.deepEqual(deriveDenyTools(undefined), []);
  assert.deepEqual(deriveDenyTools([]), []);
  const r = buildStartRequest({ batchId: 'b', lane: 'l', parent: {}, prompt: 'x', role: { title: 'T', mission: 'M' } });
  assert.deepEqual(r.toolFilter.deny, [...SUITE_DENY_TOOLS], '未声明 allow ⇒ 不得强加收窄');
});

test('RO-8 拒派先于状态变更：role 查不到 ⇒ 抛 GATE_ROLE_UNRESOLVED 且 lane 仍 pending、零登记', async () => {
  __resetLaneHandles();
  const root = tempRoot('punky-ro8-');
  const store = seedBatch(root, 'sess-c', 'b-ro8', 'l1', 'no-such-role-xyz');
  const ctx = mkCtx({ start: async () => { throw new Error('不该被调用：role 查不到必须先拒派'); } });
  const tools = createCoreTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  await assert.rejects(() => ld.execute({ batchId: 'b-ro8', lane: 'l1' }, { agent: { session: { id: 'sess-c' } } }),
    /GATE_ROLE_UNRESOLVED/);
  assert.equal(store.readBatch('sess-c', 'b-ro8').lanes.l1, 'pending', '拒派零状态变更（lane 仍 pending）');
  assert.equal(store.readBatch('sess-c', 'b-ro8').events.filter((e) => e.type === EVT_MEMBER_DISPATCH).length, 0, '拒派零登记');
  __resetLaneHandles();
});

// ── 【2026-10-08 · 本批 `role-deliverable-inject-fix-20261008` / lane `e01-impl`】R-1..R-6 判据面（L-AC-1..L-AC-9）──
// 分母一律写死（判据源 §6 口径）；断言均为**可达构造**，行为回退即变红。

test('RO-9 L-AC-1：ROLE_MANDATORY_FIELDS 收缩为五元组（deliverables 转可选、skills 不入表）', () => {
  assert.deepEqual([...ROLE_MANDATORY_FIELDS], ['id', 'title', 'layer', 'mission', 'responsibilities']);
  assert.equal(ROLE_MANDATORY_FIELDS.length, 5, 'R-1a：元组长度 = 5');
  assert.equal(ROLE_MANDATORY_FIELDS.includes('deliverables'), false, 'R-1a：deliverables 必须移出必填表');
  assert.equal(ROLE_MANDATORY_FIELDS.includes('skills'), false, 'R-4：skills 保持可选（不进必填表）');
});

test('RO-10 L-AC-2：无 deliverables 的 role 文件不判缺、不抛、裸标题恰 1 行、回退占位在场', () => {
  const root = tempRoot('punky-lac2-');
  const dir = path.join(root, 'skills', 'software-team', 'references', 'roles');
  fs.mkdirSync(dir, { recursive: true });
  // 夹具 frontmatter **只含五必填**（无 deliverables / 无 skills / 无 acceptance_hints）
  fs.writeFileSync(path.join(dir, 'probe-nodeadline.md'), [
    '---', 'id: probe-nodeadline', 'title: 无 deliverables 夹具', 'layer: exec',
    'mission: 验证 deliverables 缺席不判缺', 'responsibilities:', '  - 占位', '---', '',
  ].join('\n'), 'utf8');
  const d = resolveRoleRef('probe-nodeadline', { root });
  assert.ok(d && typeof d === 'object', 'R-1b：缺席不得拒派（须返回对象，而非抛 GATE_ROLE_UNRESOLVED）');
  assert.equal(d.deliverables, undefined, 'R-1b：缺席 ⇒ undefined（不回落、不造默认值）');
  assert.ok(d.title.length > 0 && d.responsibilities.length > 0, 'R-1b：其余必填面不受影响');
  const p = composeWorkerPrompt({
    batchId: 'b-lac2', lane: 'l1', cmd: 'c', layer: 'exec', role: 'probe-nodeadline', firstLine: 'h', roleRoot: root,
  });
  assert.equal(p.split('\n').filter((l) => l === ROLE_SECTION_TITLES.deliverables).length, 1, 'R-2b：裸标题行恰 1 行');
  // 段末自带一个空行（`composeWorkerPrompt` 在段后推 `''` 再推 `## 纪律`）⇒ 比对前 trim。
  assert.equal((deliverablesSectionOf(p) ?? '').trim(), '- （role 未声明）',
    'R-2：deliverables ∧ skills ∧ hints 三者皆空 ⇒ 回退占位（零静默）');
});

test('RO-11 L-AC-3/L-AC-4：十件 role 交付要求段零路径（j1..j4）＋ 零空反引号（j5）', () => {
  const agg = { j1: 0, j2: 0, j3: 0, j4: 0, j5: 0 };
  for (const id of ROLE_IDS) {
    const d = resolveRoleRef(id);
    const p = composeWorkerPrompt({ batchId: 'b-lac3', lane: 'l1', cmd: 'c', layer: d.layer, role: id, firstLine: 'h' });
    const sec = deliverablesSectionOf(p);
    assert.ok(sec !== null && sec.length > 0, id + ' · 交付要求段须在场且非空');
    const n = pathNoiseOf(sec);
    for (const k of Object.keys(agg)) agg[k] += n[k];
  }
  // 判据源 L-AC-3 分母 = 10 件合计**出现次数**（等价于 40 个布尔读数全 0）
  assert.deepEqual(agg, { j1: 0, j2: 0, j3: 0, j4: 0, j5: 0 }, 'R-2a/R-2b：段内路径噪声与空反引号合计须为 0');
});

test('RO-12 L-AC-5/L-AC-6：三要素齐备（形态 ≥18 ＋ must_contain 43/43 ＋ 规格指向 10/10）＋ skills 16/16', () => {
  let formLines = 0, specLines = 0, mustTotal = 0, mustHit = 0, skillTotal = 0, skillHit = 0;
  for (const id of ROLE_IDS) {
    const d = resolveRoleRef(id);
    const p = composeWorkerPrompt({ batchId: 'b-lac5', lane: 'l1', cmd: 'c', layer: d.layer, role: id, firstLine: 'h' });
    const sec = deliverablesSectionOf(p);
    const secLines = sec.split('\n');
    formLines += secLines.filter((l) => l.startsWith('- 交付件：')).length;
    specLines += secLines.filter((l) => l.startsWith('- 规格：见技能')).length;
    for (const it of (d.deliverables ?? [])) {
      for (const m of (it?.must_contain ?? [])) { mustTotal++; if (sec.includes('`' + m + '`')) mustHit++; }
    }
    for (const s of (d.skills ?? [])) { skillTotal++; if (sec.includes('`' + s + '`')) skillHit++; }
  }
  assert.ok(formLines >= 18, 'R-3(a)：形态行 ≥ 18，实得 ' + formLines);
  assert.equal(mustTotal, 43, 'R-3(b) 分母：10 件 must_contain 合计 43 条');
  assert.equal(mustHit, mustTotal, 'R-3(b)：必含结构逐条命中 ' + mustHit + '/' + mustTotal);
  assert.equal(specLines, 10, 'R-3(c)：规格指向行 10/10（每件恰 1 行）');
  assert.equal(skillTotal, 16, 'R-4a 分母：10 件 skills 合计 16 条');
  assert.equal(skillHit, skillTotal, 'R-4a：skills 逐条命中 ' + skillHit + '/' + skillTotal);
});

test('RO-13 L-AC-8：十件语料去路径化（frontmatter path: 0 / form: 18 / 全文产物前缀 0 / must_contain 18）', () => {
  // 拆段拼接构造产物前缀 token：避免本断言自身的源码文本构成「仍保留路径」的假样本。
  const artefactPrefix = ['artifacts', '<batchId>'].join('/');
  let files = 0, pathKey = 0, formKey = 0, mustKey = 0, artefact = 0;
  for (const id of ROLE_IDS) {
    const src = resolveRoleRef(id).source;
    assert.equal(typeof src, 'string', id + ' · source 须为语料文件绝对路径');
    files++;
    const text = fs.readFileSync(src, 'utf8');
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    pathKey += (head.match(/path:/g) ?? []).length;
    formKey += (head.match(/form:/g) ?? []).length;
    mustKey += (head.match(/must_contain:/g) ?? []).length;
    artefact += text.split(artefactPrefix).length - 1;
  }
  assert.equal(files, 10, 'R-5 面内文件数 = 10（7 件 software-team ＋ 3 件 research-team）');
  assert.equal(pathKey, 0, 'R-5：frontmatter path: 须归零');
  assert.equal(formKey, 18, 'R-5：frontmatter form: 须为 18 条');
  assert.equal(artefact, 0, 'R-5：全文产物前缀须归零（正文同步去路径化）');
  assert.equal(mustKey, 18, 'R-5：must_contain 键 18 —— 语义面零丢失');
});

test('RO-14 L-AC-7③：双通道写死 —— role 语料 skills 不回填装配前缀通道', () => {
  assert.equal(assembleCmd('designer', null, 'c'), '[role=designer] c', 'R-4b：null ⇒ 无 skills 前缀段');
  assert.equal(assembleCmd('designer', [], 'c'), '[role=designer] c', 'R-4b：[] ⇒ 无 skills 前缀段');
  assert.equal(assembleCmd('designer', ['a', 'b'], 'c'), '[role=designer] [skills=a,b] c', 'R-4b：显式 t.skills ⇒ 出段');
});

test('RO-15 L-AC-9：负判据 —— 未新增 deliverables × produce 一致性检查（字面量命中 0）', () => {
  // 自指护栏：模式**拆段拼接**构造（本行因此不含被禁字面量本身，否则断言自己的源码就会命中 ⇒ 假红）。
  const FORBIDDEN = new RegExp(['role' + '_deliverable', 'ROLE' + '_DELIVERABLE', 'deliverable' + '_mismatch'].join('|'), 'i');
  const scan = (dir, hits) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return hits; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full, hits);
      else if (/\.(m?[jt]s)$/.test(e.name) && FORBIDDEN.test(fs.readFileSync(full, 'utf8'))) hits.push(full);
    }
    return hits;
  };
  const pkg = roleCorpusRoot();
  const hits = ['lib', 'test', 'scripts'].flatMap((s) => scan(path.join(pkg, s), []));
  assert.deepEqual(hits, [], 'R-6：不得出现一致性检查字面量（不落事件、不落门禁）');
});
