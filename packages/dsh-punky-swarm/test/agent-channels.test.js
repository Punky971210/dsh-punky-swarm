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

// test/agent-channels.test.js —— **通道级可用性**的钉死用例
// （批 `punky-adapter-channels-20261101` · lane `ch-impl` · A 段）
//
// 用户裁决（H1/H2/H3）：能力面是**一个**（`agentRuntime` 不拆），但引擎调用走**两条不同通道**，
//   适配器必须**分别**报「该通道能否用」：
//     · **C 档** = 一次性 Subagent（`execute` / `lane_dispatch`）⇒ 依赖宿主 `subagents` 服务
//     · **D 档** = agentTeams 唤醒（`notifyLeader` / `spawn_teammate`）⇒ 依赖宿主 `agents` 服务
//
// 本文件的核心命题（用户澄清的**全部意义**）：**「缺 C 档」与「缺 D 档」必须能区分**。
//   ⇒ 不是只核「`channels` 字段存在」，而是**两个只缺一档的夹具各报出不同的通道**。
//   ⇒ 若有人把两档合回一个布尔（或把聚合从 OR 改成 AND），本文件必红（见 AC-6 变异自证）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { capabilityReport } from '../lib/capabilities.js';
import { agentChannelFactsOf } from '../lib/provider-dsh/agent.js';

/** 宿主夹具：`cap` ∈ 见下。三档端口实例只为让 `faceProbeOf` 有对象可判。 */
const portsOf = (available) => ({
  toolSurface: { available },
  httpSurface: { available },
  agentRuntime: { available },
});
const SUBAGENTS = { start: async () => ({}) };          // C 档物理基础：宿主 subagent 服务
const AGENTS = { get: () => null };                    // D 档物理基础：宿主 agents 服务
const factsOf = (ctx) => agentChannelFactsOf(ctx);
const agentOf = (report) => report.host.find((h) => h.key === 'agentRuntime');

// ── AC-1：**缺 D 档**（宿主有 subagent、无 agents）⇒ 报出「agentTeam 不可用」而 subagent 可用 ──────────
test('AC-1 只缺 D 档：channels.subagent 可用、channels.agentTeam 不可用且带成因', () => {
  const report = capabilityReport({
    ports: portsOf(false),
    agentChannels: factsOf({ subagents: SUBAGENTS }), // 有 C，无 D
  });
  const ch = agentOf(report).channels;
  assert.ok(ch, 'channels 必须存在（本夹具已传通道事实）');
  assert.equal(ch.probed, true, 'channels.probed 必须为 true');
  assert.equal(ch.subagent.available, true, 'C 档可用：宿主 subagents 在位且有 start 入口');
  assert.equal(ch.subagent.reason, null, 'C 档可用时 reason 必须为 null');
  assert.equal(ch.agentTeam.available, false, 'D 档不可用：宿主无 agents 服务');
  assert.equal(ch.agentTeam.reason, 'agent-runtime-unavailable', 'D 档成因须为既有词 `agent-runtime-unavailable`');
});

// ── AC-2：**缺 C 档**（宿主有 agents、无 subagent）⇒ 报出「subagent 不可用」而 agentTeam 可用 ──────────
test('AC-2 只缺 C 档：channels.agentTeam 可用、channels.subagent 不可用且带成因', () => {
  const report = capabilityReport({
    ports: portsOf(false),
    agentChannels: factsOf({ agents: AGENTS }), // 有 D，无 C
  });
  const ch = agentOf(report).channels;
  assert.equal(ch.probed, true);
  assert.equal(ch.agentTeam.available, true, 'D 档可用：宿主 agents 在位且 get 可调用');
  assert.equal(ch.agentTeam.reason, null);
  assert.equal(ch.subagent.available, false, 'C 档不可用：宿主无 subagents 服务');
  assert.equal(ch.subagent.reason, 'runtime-unavailable', 'C 档成因须为既有词 `runtime-unavailable`');
});

// ── AC-3：**本项的全部意义** —— 两个夹具报出**不同的通道**（不是只核字段在场）──────────────────────
test('AC-3 缺 C 档与缺 D 档必须可区分：两夹具的不可用通道不同，且成因不同', () => {
  const faceD = agentOf(capabilityReport({ ports: portsOf(false), agentChannels: factsOf({ subagents: SUBAGENTS }) }));
  const faceC = agentOf(capabilityReport({ ports: portsOf(false), agentChannels: factsOf({ agents: AGENTS }) }));
  const missingD = faceD.channels;
  const missingC = faceC.channels;

  // ① 不可用**通道**不同（这是「分别报通」的实质，不是形状）
  assert.notDeepEqual(missingD, missingC, '两夹具的 channels 必须不同（否则等于又合回一个布尔）');
  assert.equal(missingD.agentTeam.available, false);
  assert.equal(missingC.agentTeam.available, true, '缺 C 档时 D 档**必须**仍报可用（否则分不出缺的是哪一档）');
  assert.equal(missingC.subagent.available, false);
  assert.equal(missingD.subagent.available, true, '缺 D 档时 C 档**必须**仍报可用');

  // ② 成因词不同（两档物理基础不同，成因不得混同）
  assert.notEqual(missingD.agentTeam.reason, missingC.subagent.reason,
    '两档成因词必须不同：`agent-runtime-unavailable`（D）≠ `runtime-unavailable`（C）');

  // ③ 阳性对照（**本用例判别力的来源**）：只报**面级一个布尔**（`installed`）时，
  //    两夹具读数**完全相同**（OR 下都是 true）⇒ 证明「合回一个布尔」确实分不出缺的是哪一档。
  //    ⇒ `channels` 的必要性由此成立，而不是靠「字段在场」这种形状修辞。
  assert.equal(faceD.installed, faceC.installed,
    '阳性对照：只取面级 installed 时两夹具读数相同 ⇒ 面级布尔分不出两档');
  assert.equal(faceD.installed, true, '两夹具在 OR 下都判面可用 —— 正因如此，分歧只能靠 channels 表达');
});

// ── AC-4：聚合规则 = **OR**（任一路径可用 ⇒ 面可用）────────────────────────────────────────────
test('AC-4 面级 installed 按 OR 聚合：只有一条通道可用时该面仍判可用', () => {
  const onlyC = agentOf(capabilityReport({ ports: portsOf(false), agentChannels: factsOf({ subagents: SUBAGENTS }) }));
  const onlyD = agentOf(capabilityReport({ ports: portsOf(false), agentChannels: factsOf({ agents: AGENTS }) }));
  const neither = agentOf(capabilityReport({ ports: portsOf(false), agentChannels: factsOf({}) }));

  assert.equal(onlyC.installed, true, '只有 C 档可用 ⇒ 面可用（OR，不是 AND）');
  assert.equal(onlyD.installed, true, '只有 D 档可用 ⇒ 面可用（OR，不是 AND）');
  assert.equal(neither.installed, false, '两档都不可用 ⇒ 面不可用');
  assert.equal(onlyC.reason, null, '面可用时 reason 必须为 null');
  assert.ok(typeof neither.reason === 'string' && neither.reason.length > 0, '面不可用时 reason 必须非空');
});

// ── AC-5：`channels: null`（未探明）与 `{}`（有对象无通道）**必须可区分**，且缺省不把面判死 ────────────
test('AC-5 未探明 ≠ 不可用：缺省 channels 为 null、不影响 installed；`{}` 不得冒充 null', () => {
  const absent = agentOf(capabilityReport({ ports: portsOf(true) })); // 未传 agentChannels
  assert.equal(absent.channels, null, '未传通道事实 ⇒ channels 必须是 null（不是 {}）');
  assert.equal(absent.installed, true, '未探明通道事实**不得**把面判成不可用（同 probed:false 纪律）');

  const probedFalse = agentOf(capabilityReport({ ports: portsOf(true), agentChannels: { probed: false } }));
  assert.ok(probedFalse.channels, 'pass 了对象但 probed:false ⇒ channels 仍是对象（形状可读）');
  assert.equal(probedFalse.channels.probed, false, 'probed:false = 未探明');
  assert.equal(probedFalse.installed, true, 'probed:false 时**不参与 OR 聚合**，面读数原样保留');

  // 其余面**恒** null（该面无通道维度）——用 null 而非 {}，否则「有空对象但无通道」
  for (const key of ['toolSurface', 'httpSurface']) {
    const face = capabilityReport({ ports: portsOf(true), agentChannels: factsOf({ subagents: SUBAGENTS }) })
      .host.find((h) => h.key === key);
    assert.equal(face.channels, null, key + ' 无通道维度 ⇒ channels 必须为 null');
  }
});

// ── AC-6：变异自证 —— 把聚合改回 **AND** 必须让 AC-4 的判据失效（判别力，不是声明）───────────────
test('AC-6 变异自证：把 OR 换成 AND 时，「只有一档可用」的两种宿主都会被判面不可用', () => {
  const and = (ch) => ch.subagent.available && ch.agentTeam.available;
  const onlyC = factsOf({ subagents: SUBAGENTS });
  const onlyD = factsOf({ agents: AGENTS });
  const both = factsOf({ subagents: SUBAGENTS, agents: AGENTS });

  const or = (ch) => ch.subagent.available || ch.agentTeam.available;
  assert.equal(or(onlyC), true, 'OR：只有 C 档 ⇒ 可用（这是 AC-4 采纳的规则）');
  assert.equal(and(onlyC), false, '变异：AND 会把「只有 C 档」判成不可用 ⇒ AC-4 必红');
  assert.equal(and(onlyD), false, '变异：AND 会把「只有 D 档」判成不可用 ⇒ AC-4 必红');
  assert.equal(and(both), true, 'AND 只在两档齐时成立 —— 证明该变异不是「恒假」而是语义替换');
  assert.equal(or(both), true, 'OR 在两档齐时同样成立（两规则在此夹具上不分歧，故 AC-4 需单档夹具）');
});
