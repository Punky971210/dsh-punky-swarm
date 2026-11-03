// test/ring1-or-aggregate.test.js
//
// 【批 `punky-ring1-oraggregate-20261102` · lane `impl`】环 1：D 档可用性 OR 聚合的**可达用例**。
//
// ## 修的是什么
// 报告面 `capabilities.js` 早就按「任一通道 true ⇒ 面在」聚合（OR），而端口门禁面
// `provider-dsh/agent.js` 的 `available` **只取 C 档** ⇒ 「C 不可 + D 可用」时端口报不可用
// ⇒ `push_execute` 的 D 档结构性不可达（双通道只通一条）。本批把 `available` 改为 OR。
//
// ## 三个连带面为何必须一起换锚
//   · `narrowVia`：`form`（`formOf`）是 **C 档形态**、`witnessOf` 依赖 C 档 `presetFor`
//     ⇒ 沿用面级会在「C 不可 + D 可用」时 `form=null` 落第三支 ⇒ 若 `presetFor` 有配置就报
//     `'preset'` = **虚假收窄证据**；
//   · `depthVia`：`caps` 来自 `rt.capabilities`（C 档能力位）⇒ C 不可时 `caps=null`，
//     沿用面级会报 `'request'` = **无依据的声称**；
//   · `reason`：对齐报告面「`available===true ⇒ reason=null`」。
//
// ## ⚠ 判别力分布（决定必须写哪几条）
//   **只有 V-1（C 不可 + D 可用）能发现本批变异**；V-2 / V-3 在新旧口径下**同值** ⇒
//   只写它们等于本批改动**无任何用例可验证**。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentPort, agentChannelFactsOf } from '../lib/provider-dsh/agent.js';

// C 档夹具：宿主 subagent 服务（有 start 入口即算可用）
const SUBAGENTS = { start: async () => ({}) };
// D 档夹具：宿主工具面（有 execute 即可发起 spawn_teammate）
const TOOLS = { execute: async () => ({ isError: false }) };

/** 只取四个读数的端口快照（避免把整个端口对象塞进断言消息）。 */
const readingsOf = (ctx) => {
  const p = createAgentPort(ctx);
  return { available: p.available, reason: p.reason, narrowVia: p.narrowVia, depthVia: p.depthVia };
};

test('V-1【C 不可 + D 可用】⇒ available:true / reason:null / narrowVia:none / depthVia:none（本批唯一有判别力的场景）', () => {
  const r = readingsOf({ tools: TOOLS });
  assert.deepEqual(r, { available: true, reason: null, narrowVia: 'none', depthVia: 'none' },
    'OR 聚合后 D 档可发起派发 ⇒ 面可用；但收窄/深度读数必须归 zero（它们只有 C 档有依据）；实测=' + JSON.stringify(r));
  // 分项断言（失败时能一眼看出是哪一条塌了）
  assert.equal(r.available, true, 'available 必须 OR 到 D 档（改动前的实现这里是 false ⇒ D 档不可达）');
  assert.equal(r.reason, null, 'available===true ⇒ reason 必须为 null');
  assert.equal(r.narrowVia, 'none', 'narrowVia 必须换锚到 subagentChannel.available（否则报虚假 preset 证据）');
  assert.equal(r.depthVia, 'none', 'depthVia 必须换锚（否则在 caps=null 时报无依据的 request）');
});

test('V-2【C 可用】⇒ 三读数与改前逐字相同（C 档不得回退）', () => {
  const r = readingsOf({ subagents: SUBAGENTS });
  assert.deepEqual(r, { available: true, reason: null, narrowVia: 'request', depthVia: 'request' },
    'C 可用时新旧口径同值：available=true、reason=null、form=start ⇒ narrowVia=request、capsKnown ⇒ depthVia=request；实测=' + JSON.stringify(r));
});

test('V-3【两档都不可】⇒ available:false 且 reason 非空（fail-closed，且报 C 档成因）', () => {
  const r = readingsOf({});
  assert.equal(r.available, false, '两档都不可 ⇒ 端口必须报不可用（fail-closed）');
  assert.equal(typeof r.reason, 'string', 'reason 必须给出成因');
  assert.ok(r.reason.length > 0, 'reason 非空');
  assert.equal(r.narrowVia, 'none', '不可用时收窄读数归 zero');
  assert.equal(r.depthVia, 'none', '不可用时深度读数归 zero');
});

test('V-1b 别名跟随：personaVia / toolFaceVia 是 narrowVia 的别名 ⇒ 三读数恒等（diff 应为空）', () => {
  const p = createAgentPort({ tools: TOOLS });
  assert.equal(p.personaVia, p.narrowVia, 'personaVia 必须是 narrowVia 的别名（自动跟随换锚）');
  assert.equal(p.toolFaceVia, p.narrowVia, 'toolFaceVia 必须是 narrowVia 的别名');
  assert.equal(p.narrowVia, 'none', 'V-1 场景下三者同为 none');
});

test('V-4 变异（改回 C 档口径）：V-1 场景新旧口径读数**不同** ⇒ 该场景有判别力；V-2/V-3 同值 ⇒ 无判别力', () => {
  // 旧口径 = 只看 C 档（不 OR D 档）。用**报告面**取到 C 档读数即可模拟，无需改 lib。
  const facts = agentChannelFactsOf({ tools: TOOLS });
  const oldAvailable = facts.subagent.available;   // 旧口径：C 档
  const newAvailable = createAgentPort({ tools: TOOLS }).available; // 新口径：OR

  assert.equal(facts.subagent.available, false, 'V-1 夹具下 C 档确实不可用');
  assert.equal(facts.agentTeam.available, true, 'V-1 夹具下 D 档确实可用');
  assert.equal(oldAvailable, false, '旧口径（只看 C）⇒ false');
  assert.equal(newAvailable, true, '新口径（C || D）⇒ true');
  assert.notEqual(oldAvailable, newAvailable,
    'V-1 两侧读数**不同** ⇒ 变异（改回只取 C 档）会被 V-1 抓住');

  // ⚠ 明确登记：V-2 / V-3 在新旧口径下**同值** ⇒ 它们抓不到本变异（只写它们 = 本批改动无可验证）
  const v2 = { c: agentChannelFactsOf({ subagents: SUBAGENTS }).subagent.available, n: createAgentPort({ subagents: SUBAGENTS }).available };
  const v3 = { c: agentChannelFactsOf({}).subagent.available, n: createAgentPort({}).available };
  assert.equal(v2.c, v2.n, 'V-2 两侧同值（true===true）⇒ 无判别力');
  assert.equal(v3.c, v3.n, 'V-3 两侧同值（false===false）⇒ 无判别力');
});
