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

// R3-2：无断言门禁**逐枚判读**后的补测（批次 `frozen-register-2026-09-21` §3 解冻口径）。
// ─────────────────────────────────────────────────────────────────────────────
// 上游 = `docs/frozen-register-2026-09-21.md` §3（9 枚无断言拒码，裁定 ② 后"冻结不删"）
//         + §6.5 纪律「缺断言 ⇒ 先补测；补测须走**生产路径 E2E**」
//         + `docs/gate-assertion-blueprint-2026-09-21.md` §6（R3-2 判读表）
//
// 判读结论（逐枚；本文件覆盖其中 4 枚**真缺口**，另 4 枚裁定见蓝图 §6）：
//   · 真缺口 → 本文件补测（4 枚 / 5 例）：
//       GATE_EXEC_INPUT_MISSING ×3（E-A 批级拒 + E-A 对照放行 + E-B 逐 lane 拒）
//   GATE_SKILL_MISSING      ×3（资产面声明不可解析技能 ⇒ 留痕 / 覆盖层声明不可解析技能 ⇒ 留痕 / 全可解析 ⇒ 零告警）
//       GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH ×1（出口门开启 + 存量批 ⇒ 放行 + 落码）
//       GATE_EVENT_CONST_MISSING ×2（围栏 + 前置面；**降级覆盖**，理由见该例注释）
//         → R3-4 已把该枚的 E2E 补上（`test/gate-event-const-e2e-r34.test.js`）；本两例保留为**源码面围栏**
//   · 假缺口·断言松动 → 收紧**既有**断言，不在本文件（governance.test.js ×4 行 / handoff-gate.test.js ×1 处）
//   · 假缺口·不可达内部分支 → `GATE_NO_DECLARATION`：`presenceJudge` 的内部 code，两处调用点
//       恒传 `declared:[p]`（长度 1），建批期空声明更早被 `GATE_PLAN_PRESENCE_MISSING` 拦下
//       （`lib/wave-plan.ts:519-522`）；其**外显形态**为 `GATE_PLAN_PRESENCE_MISSING`（建批期）
//       与 `GATE_EXIT_NO_DECLARATION`（运行期，`lib/state/gates.ts:1079`），二者均已有断言
//       （`test/gate-lite-smoke.test.js:92` · `test/gate-hardening-red.test.js:351,365,366,945,766`）。
//
// 纪律（本波）：**纯增量**——零生产代码改动（`lib/**` 零 diff）、零解冻、零门禁行为变更。
//   本文件全部断言走**工具面/门禁面真实调用**（不白盒直调 `createGates`）；唯一例外是
//   `GATE_EVENT_CONST_MISSING` 的两例，已在该例注释中显式标注"降级覆盖"及其不可 E2E 的实证理由。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { clearRoleCache } from '../lib/assembly/flows.js';
import { assessC, threeTierTasks } from './helpers/gate-fixture.mjs';
import { writeTempTeam, writeSyntheticTeam } from './helpers/team-fixture.mjs';
import * as EVT from '../lib/state/event-types.js';

const SESSION = 'sess-r32';
const SESS = { agent: { session: { id: SESSION } } };
const PROBE = 'probe-team';
const SETTLE_TEAM = 'r32-settle-team';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/**
 * 写一份临时团队资产：以包内 `software-team` 资产为骨架，按 `mutate` 改一处；返回 teamsRoot。
 * 骨架法（而非手搓资产）保证「除被检面外全部合规」⇒ 拒因可**归因**到唯一改动点。
 */

/** 最小三层资产（出口交接门用例专用）：exec `e1` 有下游 `a1` ⇒ 该 lane 结算受出口门约束。 */
function settleTeamAsset() {
  return {
    team: SETTLE_TEAM,
    layers: {
      plan: { roles: ['designer'], skills: { designer: ['r32-designer'] } },
      exec: { roles: ['coder'], skills: { coder: ['r32-coder'] } },
      audit: { roles: ['reviewer'], skills: { reviewer: ['r32-reviewer'] } },
    },
    flows: {
      plan: { produce_field: 'produce', entry_requires: [] },
      exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'] },
      audit: {
        produce_field: 'produce', entry_requires: ['consume'],
        audit_contract: { criteria_from: 'plan/**', verdict: ['pass', 'fail', 'skip'] },
      },
    },
  };
}

/** DAG：p1 → e1 → a1（`a1.deps=['e1']` ⇒ e1 有下游 ⇒ 出口交接门在 e1 结算时可判）。 */
function settleTasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'build-it' },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'verify-it' },
  ];
}

/** 合规三层 tasks（plan 产物被 exec 与 audit 双重消费 ⇒ 满足 A1 主防线与 B5 锚点）。 */
function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'], cmd: 'code' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'], cmd: 'accept' },
  ];
}

/**
 * 建 harness。`opts.config` 透传 `deps.config`（`lib/tools/core.js:610` 的 `config.assembly` 读端）。
 *
 * 【task-27 纪律 · 同 p2-settle-handoff】测试**不得依赖 ambient env**：宿主/父进程可能已带
 *   `PSWARM_HANDOFF_GATE=1`（本机实测即如此）⇒ 不中和会让"以为门关"的建批步骤被 entry 门介入。
 *   故此处保存并清除，`cleanup` 还原（进程级 env 归零，语义完全由本套件控制）。
 */
function makeHarness({ config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-r32-'));
  const savedEnv = process.env.PSWARM_HANDOFF_GATE;
  delete process.env.PSWARM_HANDOFF_GATE;
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root, config });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：R3-2 门禁断言补测的建批前置评估（三层批多依赖 ⇒ C 档）' });
  clearRoleCache();
  return { root, store, byName, savedEnv };
}

function cleanup(h) {
  if (h.savedEnv === undefined) delete process.env.PSWARM_HANDOFF_GATE;
  else process.env.PSWARM_HANDOFF_GATE = h.savedEnv; // 还原 ambient 兜底（不污染同进程后续用例）
  fs.rmSync(h.root, { recursive: true, force: true });
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESSION, 'batches', batchId + '.json');
const seedArtifact = (root, batchId, rel) => {
  const abs = path.join(root, 'sessions', SESSION, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'out');
};
const eventsOf = (store, batchId) => store.readBatch(SESSION, batchId)?.events ?? [];

// ── 真缺口 ①：`GATE_EXEC_INPUT_MISSING`（exec 消费门，E-A 批级 / E-B 逐 lane）──────────────
// 抛出点：`lib/tools/core.js:739`（E-A）· `:749`（E-B）；二者同址同形于 audit 的 `consumes_required`
//   （`:715`，该码 `GATE_AUDIT_INPUT_MISSING` 已有 `test/audit-contract-gate.test.js:127-137` 覆盖）。
// 缺口成因：既有套件里 `consumes_required` 全部指**audit 契约面**；exec 面只以「资产已声明且满足」
//   的**通过态**被顺带走到，**拒态从未被断言**。

test('R3-2 E-A：flows.exec.consumes_required 未被满足 ⇒ 拒建批 GATE_EXEC_INPUT_MISSING（零批次落盘）', async () => {
  const h = makeHarness();
  try {
    // 唯一改动点：批级要求 exec lane 消费 `exec/` 前缀 —— 而本批 exec lane 只消费 `plan/spec.md`。
    const teamsRoot = writeTempTeam('punky-r32-ea-', PROBE, (a) => {
      a.flows.exec.consumes_required = ['exec/'];
    });
    await assert.rejects(
      () => h.byName.wave_plan.execute({
        batchId: 'r32-ea', team: PROBE, teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' },
      }, SESS),
      /GATE_EXEC_INPUT_MISSING: flows\.exec\.consumes_required not satisfied for \["exec\/"\]/,
    );
    assert.equal(fs.existsSync(batchFileOf(h.root, 'r32-ea')), false, '拒后零批次 JSON 落盘');
  } finally { cleanup(h); }
});

test('R3-2 E-A 对照：同一夹具仅把 consumes_required 改回已满足 ⇒ 建批通过（拒因可归因）', async () => {
  const h = makeHarness();
  try {
    // 与上例的**唯一差异** = 声明改为 `['plan/']`（exec lane 的 consume=['plan/spec.md'] 命中）
    //   ⇒ 反向锁：过与不过只由被检面决定，不由夹具其它部分决定。
    const teamsRoot = writeTempTeam('punky-r32-eaok-', PROBE, (a) => {
      a.flows.exec.consumes_required = ['plan/'];
    });
    const out = await h.byName.wave_plan.execute({
      batchId: 'r32-eaok', team: PROBE, teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' },
    }, SESS);
    assert.equal(out.batchId, 'r32-eaok');
    assert.equal(fs.existsSync(batchFileOf(h.root, 'r32-eaok')), true, '放行 ⇒ 批次 JSON 落盘');
  } finally { cleanup(h); }
});

test('R3-2 E-B：flows.exec.consumes_required_per_lane 未被满足 ⇒ 拒建批 GATE_EXEC_INPUT_MISSING', async () => {
  const h = makeHarness();
  try {
    // E-B 语义：**每一条** exec lane 须各自命中**每个**前缀。此处追加 `audit/`（无 exec lane 消费它）
    //   ⇒ 逐 lane 判据失配；E-A 保持 software-team 原值 `['plan/']`（已满足）⇒ 拒因只能来自 E-B。
    const teamsRoot = writeTempTeam('punky-r32-eb-', PROBE, (a) => {
      a.flows.exec.consumes_required = ['plan/'];
      a.flows.exec.consumes_required_per_lane = ['plan/', 'audit/'];
    });
    await assert.rejects(
      () => h.byName.wave_plan.execute({
        batchId: 'r32-eb', team: PROBE, teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' },
      }, SESS),
      /GATE_EXEC_INPUT_MISSING: flows\.exec\.consumes_required_per_lane not satisfied — exec lane\(s\) missing required consume prefix: \["e1:audit\/"\]/,
    );
    assert.equal(fs.existsSync(batchFileOf(h.root, 'r32-eb')), false, '拒后零批次 JSON 落盘');
  } finally { cleanup(h); }
});

// ── 真缺口 ②：`GATE_SKILL_MISSING`（技能名存在性告警）────────────────────────────────────
// 推入点：`lib/tools/core.js#wave_plan.execute` 的告警块（`plan.warnings.push`，非阻断）。**判定面 = 两源并集**
//   （2026-09-25 recommend 起）：① **资产面** `declaredSkillNamesOf(teamAsset)`；② `config.assembly` 覆盖层
//   `assembly.layers[*].skills[*]`（`assembly = resolveAssembly(teamName, config.assembly, …)`）——
//   两源并入**同一 Set**（同名消重），走同一 `GATE_SKILL_MISSING` 码与同一事件通道。
// 【retire（2026-09-25）】原注释命题「资产面已由构造期硬门 `TEAM_ASSET_SKILLS_MISMATCH` 把关
//   （`lib/tools/core.js:460-477`）⇒ 无覆盖时本告警恒不触发」**已失效**：该构造期硬门已按用户裁决
//   （「技能、工具进任务包是 recommend 式，不是装配式」）撤销 ⇒ 资产面同样只留痕、不拒建批。
//   相应新增资产面用例（下一条）——原「覆盖层 ×2」扩为「×3」。
// 缺口成因（历史）：既有套件从未注入 `config.assembly`（全仓 grep `config.assembly` 在 `test/` 零命中）。

test('R3-2 GATE_SKILL_MISSING【资产面】：资产层声明不可解析技能 ⇒ 留痕告警且不阻断建批', async () => {
  const h = makeHarness(); // 无 `config.assembly` ⇒ 判定面只剩**资产面**
  try {
    // `threeTierSyntheticTeam` 的三个声明名（r32-designer / r32-coder / r32-reviewer）在隔离 HOME 下
    //   **无宿主技能根**（不造桩、不写 SKILL.md）——但按现行语义：技能根不可用 ⇒ 守 `if (res.ok)` 守卫 ⇒
    //   **不告警**。故先 `mkdirSync` 一个**空技能根目录**（零 SKILL.md、零技能名目录），使 `res.ok === true`，
    //   资产面的三个名才落到 ② 态（点名告警）——这是本用例告警可被断言所必需的**可达构造**。
    fs.mkdirSync(path.join(process.env.USERPROFILE, '.agents', 'skills'), { recursive: true });
    const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-r32-asset-'));
    writeSyntheticTeam(teamsRoot, SETTLE_TEAM, settleTeamAsset());
    const out = await h.byName.wave_plan.execute({
      batchId: 'r32-sk-asset', team: SETTLE_TEAM, teamsRoot, tasks: settleTasks(),
      assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
    }, SESS);
    const w = out.warnings.find((x) => x.code === 'GATE_SKILL_MISSING');
    assert.ok(w, '资产面的不可解析技能须落 GATE_SKILL_MISSING 告警（recommend 留痕）：' + JSON.stringify(out.warnings));
    assert.match(String(w.missing ?? ''), /r32-coder/, '须点名缺失技能：' + JSON.stringify(w));
    assert.equal(fs.existsSync(batchFileOf(h.root, 'r32-sk-asset')), true, 'recommend 语义：不阻断建批');
  } finally { cleanup(h); }
});

test('R3-2 GATE_SKILL_MISSING：config.assembly 覆盖层声明不可解析技能 ⇒ 留痕告警且不阻断建批', async () => {
  const h = makeHarness({
    config: {
      assembly: {
        layers: {
          plan: { roles: ['designer'], skills: { designer: ['r32-nope-designer'] } },
          exec: { roles: ['coder'], skills: { coder: ['r32-nope-coder'] } },
          audit: { roles: ['reviewer'], skills: { reviewer: ['r32-nope-reviewer'] } },
        },
      },
    },
  });
  try {
    const teamsRoot = writeTempTeam('punky-r32-sk-', PROBE);
    const out = await h.byName.wave_plan.execute({
      batchId: 'r32-sk', team: PROBE, teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' },
    }, SESS);
    const w = out.warnings.find((x) => x.code === 'GATE_SKILL_MISSING');
    assert.ok(w, '覆盖层的不可解析技能须落 GATE_SKILL_MISSING 告警：' + JSON.stringify(out.warnings));
    assert.match(String(w.missing ?? ''), /r32-nope-coder/, '须点名缺失技能：' + JSON.stringify(w));
    assert.equal(fs.existsSync(batchFileOf(h.root, 'r32-sk')), true, 'warning 语义：不阻断建批');
  } finally { cleanup(h); }
});

test('R3-2 GATE_SKILL_MISSING 对照：覆盖层技能全可解析 ⇒ 零该码告警（拒因可归因）', async () => {
  const h = makeHarness({
    config: {
      assembly: {
        layers: {
          plan: { roles: ['designer'], skills: { designer: ['r32-designer'] } },
          exec: { roles: ['coder'], skills: { coder: ['r32-coder'] } },
          audit: { roles: ['reviewer'], skills: { reviewer: ['r32-reviewer'] } },
        },
      },
    },
  });
  try {
    // ⚠ 【如实登记 · lane 未自行改断言】原 setup 用**已删除的写盘夹具**（三件退役符号之一，见批
    //   `onto-fixture-purge-20260925` 的删除清单；本文件内已**零字面引用**）把三个覆盖层名造成可解析；该夹具
    //   已按用户裁决撤除（「不造空桩」）⇒ 本 lane 只删该行、**未改下方断言**。结果是本用例在改后**转红**，
    //   且**红因正当**：2026-09-25 recommend 起资产面声明名一并进同一判定面（`declaredSkillNamesOf(teamAsset)`），
    //   而本用例的 `probe-team` 资产以包内 `software-team` 为骨架（声明 13 个技能名），隔离 HOME 下宿主技能根
    //   无内容 ⇒ 这批名必然不可解析 ⇒ 必然落 `GATE_SKILL_MISSING`。即「全可解析 ⇒ 零该码告警」这一命题的
    //   **可达构造**在本批环境约束下已不存在（构造它要么造桩、要么造技能名目录，两件都被本批红线禁止）。
    //   ⇒ 提请 Leader 裁认（见 lane 产物 `exec/tests-c.md` §偏离 D-2）：本用例需按 recommend 语义重述
    //   （属「改断言」，超出本 lane 授权）。
    const teamsRoot = writeTempTeam('punky-r32-skok-', PROBE);
    fs.mkdirSync(path.join(process.env.USERPROFILE, '.agents', 'skills'), { recursive: true });
    const out = await h.byName.wave_plan.execute({
      batchId: 'r32-skok', team: PROBE, teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' },
    }, SESS);
    assert.equal(out.warnings.some((x) => x.code === 'GATE_SKILL_MISSING'), false,
      '全可解析 ⇒ 不得误报：' + JSON.stringify(out.warnings));
  } finally { cleanup(h); }
});

// ── 真缺口 ③：`GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH`（出口侧存量批放行留痕）──────────────
// 落点：`lib/state/store.js:742`（`batch.events.push(newEvent(EVT_LANE_HANDOFF_GAP, {code: …}))`）。
// 触发条件（`lib/state/gates.ts:1676-1695`，三条**全须**成立）：
//   ① 出口门开启（`handoffGateEnabledOf(readCfg(),'settle')`，缺省关）→ 否则 `disabled:true` 早退；
//   ② 该 lane 在 DAG 中**有下游**（他人 `deps` 引用 / 本 lane `next` 指向存在的步）；
//   ③ `batch.handoffs === undefined | null`（存量批形态）。
// 缺口成因：入口侧同族码 `GATE_HANDOFF_LEGACY_PASSTHROUGH` 有 `handoff-gate.test.js` P1-H6 覆盖，
//   **出口侧从未被驱动**（全仓 `LEGACY_PASSTHROUGH` 在 `test/` 零命中）。

test('R3-2 GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH：存量批 + 出口门开启 ⇒ 放行并落码留痕', async () => {
  const h = makeHarness();
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-r32-settle-'));
  try {
    // F2：合成资产（本用例要的是「无 chain / 简化 flows」的受控形态）⇒ 走单点写入。
    writeSyntheticTeam(teamsRoot, SETTLE_TEAM, settleTeamAsset());

    await h.byName.wave_plan.execute({
      batchId: 'r32-sl', team: SETTLE_TEAM, teamsRoot, tasks: settleTasks(), assembly: { auditLane: 'a1' },
    }, SESS);
    // 前置：**存量批形态须显式构造**。`store.createBatch` **恒写** `handoffs`（`lib/state/store.js:318-321`：
    //   "新建批恒写 handoffs（空对象 = 该批无 deps ⇒ 未交接门恒放行）"），并随后按 `task.deps` 逐边种
    //   `status:'pending'` 条（`:341-356`）——**与门开关无关**（门关只免掉建批期的声明校验，不免字段）。
    //   故「本批无 `batch.handoffs` 字段 = 存量批」这一判据只能靠**显式删字段**复现（与 `handoff-gate.test.js`
    //   P1-H6 同法）；删前先断言前置确实存在，避免"删了个不存在的东西"这种假通过。
    const slFile = batchFileOf(h.root, 'r32-sl');
    const slBatch = JSON.parse(fs.readFileSync(slFile, 'utf8'));
    assert.notEqual(slBatch.handoffs, undefined, '前置：新建批恒写 handoffs（本用例要显式退回存量形态）');
    delete slBatch.handoffs;
    fs.writeFileSync(slFile, JSON.stringify(slBatch), 'utf8');
    assert.equal(h.store.readBatch(SESSION, 'r32-sl').handoffs, undefined, '前置：已退回存量批形态');

    // e1 的 exit 门（本 lane 自证产出）与 audit 锚点先满足 ⇒ 结算的**唯一可拒面**只剩出口交接门
    seedArtifact(h.root, 'r32-sl', 'exec/e1.md');
    seedArtifact(h.root, 'r32-sl', 'plan/spec.md');
    await h.byName.member_status.execute({ batchId: 'r32-sl', lane: 'e1', status: 'running' }, SESS);
    await h.byName.member_status.execute({ batchId: 'r32-sl', lane: 'e1', status: 'review' }, SESS);

    process.env.PSWARM_HANDOFF_GATE = '1'; // 结算当刻择入出口门（每例 try/finally 还原）
    let r;
    try {
      r = await h.byName.member_settle.execute({ batchId: 'r32-sl', lane: 'e1', status: 'merged' }, SESS);
    } finally {
      delete process.env.PSWARM_HANDOFF_GATE;
    }
    assert.equal(r.status, 'merged', '存量批 + 裁决 ①=B ⇒ 放行（不砸存量）：' + JSON.stringify(r));

    const gap = eventsOf(h.store, 'r32-sl')
      .filter((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP && e.code === 'GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH');
    assert.equal(gap.length, 1, '放行须留痕（不静默）：' + JSON.stringify(eventsOf(h.store, 'r32-sl').map((e) => [e.type, e.code])));
    assert.equal(gap[0].legacy, true, '须标 legacy 供审计判别');
    assert.equal(gap[0].lane, 'e1');
  } finally { cleanup(h); fs.rmSync(teamsRoot, { recursive: true, force: true }); }
});

// ── 真缺口 ④：`GATE_EVENT_CONST_MISSING`（fail-closed 守卫）——**降级覆盖** ────────────────
// 落点：`lib/state/store.js:75`（`requireEventType` 唯一守卫）。设计自述（`store.js:146-148`）它是
//   「写端在每次落盘前解析常量 ⇒ 缺位即抛」的 fail-closed 守卫，并**预留了注入缝** `resolveGateEventTypes(evt = EVT)`
//   「供探针以『人为缺常量』实测守卫行为」。
//
// **为什么本波不写 E2E（实证，非推测）**：该缝**未导出**（`resolveGateEventTypes` 是模块私有；
//   且它已登记在 C1「未接线」清单 `docs/audit-2026-09-21-unwired.json` —— 导出它 = **解冻 C1 项**，本波禁止）。
//   而默认实参取的是 ESM 命名空间 `import * as EVT`，**实测不可改**：
//     `Object.isExtensible(ns) === false`；`delete ns.EVT_GATE_ESCAPE` ⇒ `TypeError: Cannot delete property
//     'EVT_GATE_ESCAPE' of [object Module]`（Node 22.22.2 实测）。
//   ⇒ 触发它只能靠 (a) 导出注入缝（= 解冻）或 (b) 子进程 module-loader 钩子改写 `event-types.js`
//   （机器成本高、且是对「源被改」的二阶模拟）。
//
// **真实威胁模型**：本守卫只会在「有人改动 `lib/state/event-types.js` 把常量删掉/改名」时触发 ——
//   那是**源码面事件**，不是运行期事件。故本波按本仓既有围栏惯例（`gate-lite-batch2.test.js` 的
//   「源码面不得再出现该字面量」· `gate-hardening-red.test.js` T35 的 L3 源码唯一性）落**围栏断言**。
//   **如实标注：围栏 ≠ §6.5 要求的「生产路径 E2E」**。
//
// 【R3-4 更新（2026-09-21）】该 E2E **已落地**：`test/gate-event-const-e2e-r34.test.js`（加载期改写
//   `event-types.js` 源码 = 忠实模拟"有人删/改常量"这一**源码面事件**，子进程驱动生产路径，
//   断言「抛 + 零落盘 + 零失名事件」，另有负向对照档证明判别力）。结论与实证见蓝图 §9。
//   ⇒ 本文件下方两例**保留**，但角色已从"降级替代品"变为**与之互补的源码面围栏**：
//     E2E 证**行为**（缺位时的运行期后果）；本两例证**形态**（抛点唯一 / 判据是非空字符串 /
//     三常量全经同一守卫解析 / 解析早于原子写）——后者能在 E2E 之外独立发现"结构被绕开"。

test('R3-2【围栏·非 E2E】GATE_EVENT_CONST_MISSING：fail-closed 抛点唯一且在 atomicWrite 之前', () => {
  const src = fs.readFileSync(path.join(PKG, 'lib', 'state', 'store.js'), 'utf8');

  // ① 抛点唯一：守卫函数 `requireEventType` 内**恰好一处**该码的 throw（禁第二套判定）
  const throws = (src.match(/new Error\(GATE_EVENT_CONST_MISSING/g) ?? []).length;
  assert.equal(throws, 1, 'fail-closed 抛点须恰好 1 处（单一守卫），实测=' + throws);

  // ② 判据形态：非空字符串才算合格 ⇒ 绝不写 `type: undefined` / 空串（防「语义失名事件」污染审计面）
  assert.match(src, /if \(typeof t !== 'string' \|\| t\.length === 0\) \{/,
    '守卫判据须为「非空字符串」，否则 `type:undefined` 可穿透');
  // ②b 【本条**刻意不写** · 记录理由】曾拟用「源码里不得出现 `type: undefined` 字面量」当判据 ⇒ **弃用**：
  //   该串在 `store.js` 里恰好只出现在**文档注释 / 错误文案**中（`:61` `:76` `:820`，语义正是"绝不这样写"）
  //   ⇒ 断言它恒为 false 等于**把注释当判据**，与 R3-1 定位的「乐观方向污染」（注释被当成断言）同型。
  //   本波改为下方 ③④⑤ 三条**结构性判据**（绕过 / 单点解析 / 时序），不碰注释文案。

  // ③ 无绕过：写端**不得**以裸常量形态构造 gate 事件（裸取 `EVT.EVT_GATE_*` 即跳过 fail-closed 守卫）
  for (const name of ['EVT_GATE_ESCAPE', 'EVT_GATE_DEGRADE', 'EVT_GATE_CONTRACT_MISSING']) {
    assert.equal(new RegExp('newEvent\\(EVT\\.' + name).test(src), false,
      name + ' 不得被裸取后直接 newEvent（绕过 fail-closed 守卫）');
  }

  // ③ 三个消费常量**全经**同一守卫解析（禁绕过：不得直接取 `EVT.EVT_GATE_*` 去 newEvent）
  const resolver = src.slice(src.indexOf('function resolveGateEventTypes'));
  for (const name of ['EVT_GATE_ESCAPE', 'EVT_GATE_DEGRADE', 'EVT_GATE_CONTRACT_MISSING']) {
    assert.match(resolver.slice(0, 600), new RegExp("requireEventType\\(evt, '" + name + "'\\)"),
      name + ' 须经 requireEventType 解析（fail-closed），不得裸取常量');
  }

  // ④ 时序：V-4 写盘点**先解析常量、后原子写** ⇒ 缺常量时"抛出即停手、零落盘"
  //    （`store.js:817-830` 解析 → `:855` `atomicWrite(batchFile(...), batch)`）
  const resolveAt = src.indexOf('const evtTypes = resolveGateEventTypes();');
  const writeAt = src.lastIndexOf('atomicWrite(batchFile(sessionId, batchId), batch)');
  assert.notEqual(resolveAt, -1, 'V-4 写盘点须显式解析常量（缺位即抛）');
  assert.notEqual(writeAt, -1, '须存在统一写盘点');
  assert.ok(resolveAt < writeAt, '常量解析必须早于原子写（否则会落下失名事件）：' + resolveAt + ' < ' + writeAt);
});

test('R3-2【前置面】GATE_EVENT_CONST_MISSING：守卫所解析的 3 个常量在现场存在且非空', () => {
  // 上例证明"抛点仍在 + 时序正确"；本例证明**会活配置**满足守卫的前置条件
  //   ⇒ 二者合起来覆盖守卫可被改动的全部两个面（守卫本体 / 其依赖常量）。
  for (const name of ['EVT_GATE_ESCAPE', 'EVT_GATE_DEGRADE', 'EVT_GATE_CONTRACT_MISSING']) {
    assert.equal(typeof EVT[name], 'string', name + ' 未导出或非字符串：' + typeof EVT[name]);
    assert.ok(EVT[name].length > 0, name + ' 为空串 ⇒ 守卫会拒写（本波基线不应如此）');
  }
});
