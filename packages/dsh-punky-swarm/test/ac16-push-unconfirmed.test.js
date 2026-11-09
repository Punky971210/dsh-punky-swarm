// test/ac16-push-unconfirmed.test.js
//
// 【批 `punky-align-residual-20261102` · lane `ac16-test` · 消费 spec ② AC-16】
//
// ## 这条用例咬的是什么
//   `pushViaAgentTeam`（`lib/provider-dsh/agent.js`）在「**工具 ok 但名册反查未命中**」时
//   返回 `errorCode:'PUSH_UNCONFIRMED'` + `sessionId:null` —— 这是「**不可确认**」，
//   **不是**失败也不是成功；上层（`lib/engine/dispatch.js:1333-1335`）据此**不写 member.dispatch**
//   （防幽灵绑定）。
//
// ## 夹具（**真 provider + 假宿主 ctx**，对 `lib/**` 零改动）
//   ① `ctx.tools.execute` 返回 `{ isError:false }`（工具 ok；同形先例 `agent-channels.test.js:46`）
//   ② `ctx.agentTeams.listMembers` 只返回**别人的**行 ⇒ `sessionOf(target)` **未命中**
//   ③ **不提供 `ctx.subagents`** ⇒ `pickChannelOf` 必选 `agentTeam`（D 档）
//   夹具全部内联在本文件（**不建** `test/helpers/**`，避开同批 `t26-baseline` 的命名撞车）。
//
// ## ⚠ 覆盖面边界（如实登记，见 `exec/ac16.md` §可达性）
//   本用例断言的是**provider 侧**（`push_execute` 的两通道实现与「不可确认」契约）。
//   **`dispatchLaneCore` 侧的 ②-1/②-2/②-3/②-4 当前不可达** —— 根因：
//     · `lib/engine/dispatch.js:1294` `bindingMap instanceof Map ? bindingMap.get(lane) : null`，
//       而 `laneBindingOf`（同文件 `:1455`）返回的是**普通对象**（`{sessionId,batchId,lane}`）**不是 Map**
//       ⇒ `boundSessionId` **恒 null** ⇒ `pickChannelOf` 的「有绑定 ⇒ agentTeam」规则**永不成立**；
//     · 于是：C 可用 ⇒ 必选 `subagent`；C 不可用 ⇒ `dispatch.js:1186` 早退（`spawned:false`）
//       ⇒ **`pushViaAgentTeam` 在 `dispatchLaneCore` 路径上结构不可达**
//       ⇒ `:1333-1335` 的短路在该路径上是**死码**。
//   ⇒ 故本用例**不**假装覆盖 ②-2/②-3（那需要改 `lib/**`，越本 lane 写域）。已回报 Lead。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentPort } from '../lib/provider-dsh/agent.js';

// ── 夹具（内联） ─────────────────────────────────────────────────────────────

/** 假宿主 ctx：`get()` 与裸属性双通道（`serviceOf` 两条路都覆盖）。 */
const hostCtxOf = (map) => ({ get: (n) => map[n], ...map });

/** 最小合法 `ExecSpec`（七字段；`session.id=null` ⇒ 无绑定）。 */
const execSpecOf = (targetId) => ({
  runId: 'ac16-fixture-token',
  targetId,
  member: { id: targetId },
  session: { id: null, params: null },
  taskPkg: { id: targetId },
  contract: { id: targetId, sha256: null },
});

/**
 * D 档夹具：工具面 ok + 名册**不命中** target。
 * `membersNow` 可变 —— 第二次调用可让它命中（用于正控）。
 */
const dFixtureOf = (targetId) => {
  const calls = [];
  let members = [{ name: 'someone-else', id: 'sess-other' }];
  const ctx = hostCtxOf({
    tools: {
      // 【0.2.2-rc.1 批式契约】`execute({ calls:[{id,name,arguments}], signal })` ⇒ 桩需解包首条 call，
      //   返回 `{ results:[{callId,result}] }`；`calls` 记录仍保留「工具名 + 参数」的调用证据。
      execute: async (input) => {
        const call = input?.calls?.[0] ?? {};
        calls.push({ name: call.name, arguments: call.arguments });
        return { results: [{ callId: call.id, result: { isError: false } }] };
      },
    },
    agentTeams: { listMembers: () => members },
  });
  return {
    ctx,
    calls,
    hitRosterWith: (id) => { members = [{ name: targetId, id }]; },
    port: createAgentPort(ctx, {}),
  };
};

// ── ②-0 通道自证（前置，防假绿） ────────────────────────────────────────────

test('②-0 通道自证：假成功走的是 **D 档 agentTeam**（且工具面真被调用 1 次）', async () => {
  const fx = dFixtureOf('a1');
  const r = await fx.port.push_execute(execSpecOf('a1'), { agent: { id: 'leader-agent' } });
  // 自证一：provider 自报 via（恰一条路径）
  assert.equal(r.via, 'agentTeam', '必须是 D 档（agentTeam）；实测 via=' + JSON.stringify(r.via));
  // 自证二：D 档**真的经工具面**发起（不是空跑）—— 工具恰调 1 次且工具名是 spawn_teammate
  assert.equal(fx.calls.length, 1, '工具面必须恰被调用 1 次；实测=' + fx.calls.length);
  assert.equal(fx.calls[0]?.name, 'spawn_teammate', 'D 档必须经 spawn_teammate；实测=' + JSON.stringify(fx.calls[0]?.name));
});

test('②-0′ 反假绿对照：提供 ctx.subagents 时 via 必须变成 **subagent**（证明自证不是恒真）', async () => {
  const ctx = hostCtxOf({
    tools: { execute: async () => ({ isError: false }) },
    subagents: { start: async () => ({ id: 'sess-c' }) },
  });
  // C 档的 `spawn` 需要 `options.provider`（端口不猜 provider）；缺它会 fail-closed 抛
  //   `host-port-unsupported: spawn 需要 provider` —— 故此处必须给 provider。
  const r = await createAgentPort(ctx, {})
    .push_execute(execSpecOf('a1'), { agent: { id: 'leader-agent' }, provider: 'dsh' });
  assert.equal(r.via, 'subagent', '有 C 档时选 C（规则②）⇒ 反证 ②-0 的 via 断言有判别力；实测=' + JSON.stringify(r.via));
  assert.equal(r.sessionId, 'sess-c', 'C 档会话 id 来自 run；实测=' + JSON.stringify(r.sessionId));
});

// ── ②-1′ provider 侧「不可确认」契约 ────────────────────────────────────────

test('②-1′ 工具 ok + 名册未命中 ⇒ **不可确认**（errorCode=PUSH_UNCONFIRMED、sessionId=null、run=null）', async () => {
  const fx = dFixtureOf('a1');
  const r = await fx.port.push_execute(execSpecOf('a1'), { agent: { id: 'leader-agent' } });
  assert.equal(r.errorCode, 'PUSH_UNCONFIRMED', '实测=' + JSON.stringify(r.errorCode));
  assert.equal(r.errorFamily, 'dispatch-unconfirmed', '必须与「执行失败」分族；实测=' + JSON.stringify(r.errorFamily));
  assert.equal(r.sessionId, null, '**未命中 ⇒ 不得给出会话 id**（上层据此不写绑定）；实测=' + JSON.stringify(r.sessionId));
  assert.equal(r.run, null, 'D 档无子会话句柄；实测=' + JSON.stringify(r.run));
});

test('②-2′ 不可确认 ≠ 失败：`PUSH_UNCONFIRMED` 不得与 `PUSH_FAILED` 混淆（两者分族）', async () => {
  const fx = dFixtureOf('a1');
  const unconfirmed = await fx.port.push_execute(execSpecOf('a1'), { agent: { id: 'leader-agent' } });
  assert.notEqual(unconfirmed.errorCode, 'PUSH_FAILED', '「观测面缺失」不得被读成「执行失败」');
  // 失败对照：工具返回 `isError:true` ⇒ 走 `PUSH_FAILED`（同族返回，不抛）
  //   ⚠ 与「工具面**抛错**」要分开：抛错走 `host-port-query-failed`（**抛出**，非返回）。
  const ctxFail = hostCtxOf({
    tools: {
      execute: async (input) => {
        const call = input?.calls?.[0] ?? {};
        return { results: [{ callId: call.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } }] };
      },
    },
    agentTeams: { listMembers: () => [] },
  });
  const failed = await createAgentPort(ctxFail, {}).push_execute(execSpecOf('a1'), { agent: { id: 'leader-agent' } });
  assert.equal(failed.errorCode, 'PUSH_FAILED', '工具 isError:true ⇒ PUSH_FAILED（与不可确认分族）；实测=' + JSON.stringify(failed.errorCode));
  assert.notEqual(failed.errorCode, unconfirmed.errorCode, '两族必须可区分');
});

// ── ②-4′ provider 侧正控：名册命中 ⇒ 给出会话 id（上层才可写绑定） ──────────

test('②-4′ 名册命中 ⇒ sessionId 为**真实会话 id**（不可确认解除，上层可写绑定）', async () => {
  const fx = dFixtureOf('a1');
  fx.hitRosterWith('sess-bound');
  const r = await fx.port.push_execute(execSpecOf('a1'), { agent: { id: 'leader-agent' } });
  assert.equal(r.sessionId, 'sess-bound', '命中后必须回填名册反查到的会话 id；实测=' + JSON.stringify(r.sessionId));
  assert.equal(r.errorCode, undefined, '命中时不得再带 PUSH_UNCONFIRMED；实测=' + JSON.stringify(r.errorCode));
  assert.equal(r.via, 'agentTeam', '仍是 D 档；实测=' + JSON.stringify(r.via));
});

// ── 防回归：D 档判据前提是 **tools 面**，不是 agents ────────────────────────

test('②-5′ D 档可用性判据 = `tools` 面（`probeTool(' + "'spawn_teammate'" + ') === absent` ⇒ 不可用）', async () => {
  // 【2026-11-06 Leader 授权修订（批 punky-engine-fix2-20261106 · 选项 A）】夹具补 `get`：
  //   本用例要表达的是「**明确的** absent」；而 `createToolsPort().probeTool` 只读 `tools.get`
  //   （`lib/provider-dsh/tools-http.js:106-110`），无 `get` 时它返回 `{state:'absent', reason:'port-unavailable'}`
  //   —— 那是「**不能内省**」而非「确认不存在」。原夹具缺 `get`，故它此前能绿完全是靠
  //   「把 port-unavailable 读成 absent」的旧判据（已被用户裁决否掉）。
  //   ⇒ 补 `get: () => null`（端口据此给出**无 reason 的** `{state:'absent'}`），断言与期望值**一字未改**。
  const ctxAbsent = hostCtxOf({
    tools: {
      execute: async (input) => {
        const call = input?.calls?.[0] ?? {};
        return { results: [{ callId: call.id, result: { isError: false } }] };
      },
      get: () => null,
    },
    agentTeams: { listMembers: () => [] },
  });
  await assert.rejects(
    () => createAgentPort(ctxAbsent, {}).push_execute(execSpecOf('a1'), { agent: { id: 'leader-agent' } }),
    /无可用通道|HOST_PORT_UNSUPPORTED/,
    '`spawn_teammate` 明确 absent ⇒ D 不可用且无 C ⇒ 必须 fail-closed 抛（不返回空结果冒充成功）',
  );
});
