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

// test/tool-schema-conformance.test.js —— **全工具 output.schema 一致性普查**（task-26）
// ─────────────────────────────────────────────────────────────────────────────
// 命题（task-25 真实批次缺陷的横向清面）：工具**成功返回值必须满足其自身 `output.schema`**；
//   违反 ⇒ 宿主判 `invalid output` ⇒ **假失败**（数据已落盘却报错，调用方可能重试）。
//   既有夹具**全是行为面断言、无 schema 一致性维** ⇒ 本套件把该维度铺到**全部已注册工具**。
//
// 覆盖口径（每个工具三态之一，**禁静默跳过**）：
//   · `success`：夹具内可驱动出**返回值**的路径（含「返回型失败」如 `{ok:false,error}`——同样受 schema 约束）；
//   · `reject` ：可驱动出**拒态**的路径（抛业务错 ⇒ 断言错误形态非 schema 校验错；返回值 ⇒ 同样校验 schema）；
//   · `skip`   ：夹具内不可达时**显式给理由**（理由为空即测试失败）。
// 判据（本文件内自证，防"覆盖率虚高"）：
//   ① CASES 的键集与 `createTools` 实际注册的工具名集**双向相等**（多/少一件即失败）；
//   ② 每个工具至少命中 `success` 或 `reject` 之一，否则必须有非空 `skip`；
//   ③ 所有被检返回值 = **零 schema 违例**（共享 helper `helpers/schema-conformance.mjs`）；
//   ④ 与**宿主真实**校验函数（`@deepseek-ai/dsh-tools#validateJsonSchemaValue`）**双口径交叉一致**。
//
// 环境说明（如实登记）：本文件在 import 工具模块**之前**置 `PSWARM_HANDOFF_GATE='1'`（与
//   `handoff-gate.test.js` 同法），使 P1 交接两件在普查中为**生效态**；缺省关档态未覆盖（见 doc 未覆盖面）。
process.env.PSWARM_HANDOFF_GATE = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills, withDefaultTeam } from './helpers/host-skills.mjs';
import { outputSchemaOf, schemaViolations, crossCheckConformance, assertRejectionIsNotSchemaError }
  from './helpers/schema-conformance.mjs';

seedTeamAssetSkills('software-team'); // P1：团队资产的技能名须可在隔离宿主技能根解析

const SESSION = 'sess-schema-census';
const EXEC = { agent: { session: { id: SESSION } } };

/** 综合夹具：两个合规三层批（`census-1` 主用 / `census-2` 供写态类工具专用，避免互扰）。 */
async function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-schema-census-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const made = createTools(ctx, { store, root });
  const byName = withDefaultTeam(Object.fromEntries(made.tools.map((t) => [t.name, t])));
  assessC(store, SESSION, { rationale: 'schema 普查 fixture：C 档动作（建批/成员态）前置评估' });

  const mk = async (batchId, lanes) => {
    const auditId = lanes === 2 ? 'a1' : 'y1';
    await byName.wave_plan.execute({
      batchId, tasks: threeTierTasks(lanes === 2 ? ['e1'] : ['x1'], { auditId }),
      assembly: { auditLane: auditId }, concurrency: 3,
    }, EXEC);
    await byName.batch_phase.execute({ batchId, phase: 'running' }, EXEC);
    await byName.batch_phase.execute({ batchId, manager: { agentId: 'mgr-census' } }, EXEC);
    seedArtifacts(root, SESSION, batchId, lanes === 2 ? ['e1'] : ['x1']);
  };
  await mk('census-1', 2);
  await mk('census-2', 1);

  // P1 交接门（`PSWARM_HANDOFF_GATE='1'`）⇒ 下游 lane 的**入口门**要求其入边已交接。夹具把 census-1 的
  //   两条入边（p1→e1、e1→a1）与 census-2 的 p1→x1 预先交掉，使成员态/派发类工具能在夹具内走到真实返回值；
  //   `handoff_submit` 用例改用 census-2 未交接的 **x1→y1** 边（不与本预置冲突）。
  const submit = async (batchId, from, to, artifacts) => {
    try {
      await byName.handoff_submit.execute(
        { batchId, from, to, artifacts, assertions: ['普查 fixture：产物在场且可核'] }, EXEC);
    } catch (e) {
      throw new Error('夹具预置交接失败 ' + from + '->' + to + '（' + batchId + '）：' + String(e?.message ?? e));
    }
  };
  await submit('census-1', 'p1', 'e1', ['plan/spec.md']);
  await submit('census-1', 'e1', 'a1', ['exec/e1.md']);
  await submit('census-2', 'p1', 'x1', ['plan/spec.md']);

  const execDir = path.join(root, 'sessions', SESSION, 'artifacts', 'census-1', 'exec');
  return { root, store, byName, execDir };
}

const C1 = 'census-1';
const C2 = 'census-2';

/** 建一个只含单条 exec lane 的**独立批**（供锁类工具用，避免与夹具批的交接占锁互扰）。 */
async function freshBatch(h, batchId) {
  await h.byName.wave_plan.execute({
    batchId, tasks: threeTierTasks(['l1'], { auditId: 'la1' }),
    assembly: { auditLane: 'la1' }, concurrency: 2,
  }, EXEC);
  return batchId;
}

/** 逐工具三态用例表（键集必须 = 注册工具名集）。 */
const CASES = {
  wave_plan: {
    success: async (h) => h.byName.wave_plan.execute({
      batchId: 'census-3', tasks: threeTierTasks(['z1'], { auditId: 'za1' }),
      assembly: { auditLane: 'za1' }, concurrency: 2,
    }, EXEC),
    reject: async (h) => h.byName.wave_plan.execute({ batchId: 'census-bad', tasks: [] }, EXEC),
  },
  batch_phase: {
    success: async (h) => h.byName.batch_phase.execute({ batchId: C2, phase: 'running' }, EXEC),
    reject: async (h) => h.byName.batch_phase.execute({ batchId: C2, phase: 'bogus' }, EXEC),
  },
  batch_control: {
    success: async (h) => h.byName.batch_control.execute({ batchId: C2, action: 'pause' }, EXEC),
    reject: async (h) => h.byName.batch_control.execute({ batchId: C2, action: 'bogus' }, EXEC),
  },
  batch_status: {
    success: async (h) => {
      const single = await h.byName.batch_status.execute({ batchId: C1 }, EXEC);
      assert.deepEqual(schemaViolations(single, outputSchemaOf(h.byName.batch_status)), [], '单批形态须过 schema');
      const list = await h.byName.batch_status.execute({}, EXEC);
      assert.deepEqual(schemaViolations(list, outputSchemaOf(h.byName.batch_status)), [], '列表形态须过 schema');
      return single;
    },
    reject: async (h) => h.byName.batch_status.execute({ batchId: 'ghost-batch' }, EXEC),
  },
  artifact_types: {
    success: async (h) => h.byName.artifact_types.execute({}, EXEC),
    skip: '参数面为空（无 required/properties）⇒ 夹具内无合法拒态输入；成功路径已覆盖',
  },
  assign_check: {
    // ⚠ 用**独立会话**：`assign_check` 会覆写该会话的 `lastAssign`，若写在夹具会话上会把 C 档降为 A
    //   ⇒ 其后 `wave_plan`/`member_*`/`lane_dispatch` 的 C 档门（G1）一律拒 ⇒ 覆盖率虚高。
    success: async (h) => h.byName.assign_check.execute(
      { difficulty: 'A', rationale: '普查 fixture：单线程低风险可自验', session: 'sess-census-probe' }, EXEC),
    reject: async (h) => h.byName.assign_check.execute(
      { difficulty: 'X', rationale: '普查：非法档位', session: 'sess-census-probe' }, EXEC),
  },
  asset_claim: {
    success: async (h) => h.byName.asset_claim.execute(
      { batchId: C1, source: path.join(h.execDir, 'e1.md'), target: 'exec/claimed.md' }, EXEC),
    reject: async (h) => h.byName.asset_claim.execute(
      { batchId: C1, source: path.join(h.execDir, 'ghost.md'), target: 'exec/ghost.md' }, EXEC),
  },
  gate_status: {
    success: async (h) => h.byName.gate_status.execute({ batchId: C1 }, EXEC),
    reject: async (h) => h.byName.gate_status.execute({ batchId: 'ghost-batch' }, EXEC),
  },
  lane_claim: {
    // ⚠ 用**独立批 + 独立 lane**：`handoff_submit` 会做「写权转移」（提交成功即 from 释放 / to 获取锁）
    //   ⇒ 夹具批里的下游 lane 锁已被交接占着，直接 claim 会恒冲突（那是合法返回值，但不是"认领成功"路径）。
    success: async (h) => {
      await freshBatch(h, 'census-lock1');
      return h.byName.lane_claim.execute({ batchId: 'census-lock1', lane: 'l1' }, EXEC);
    },
    reject: async (h) => {
      await freshBatch(h, 'census-lock2');
      await h.byName.lane_claim.execute({ batchId: 'census-lock2', lane: 'l1' }, EXEC);
      return h.byName.lane_claim.execute({ batchId: 'census-lock2', lane: 'l1' }, EXEC); // 二次认领 ⇒ 冲突值
    },
  },
  lane_release: {
    success: async (h) => {
      await freshBatch(h, 'census-lock3');
      const c = await h.byName.lane_claim.execute({ batchId: 'census-lock3', lane: 'l1' }, EXEC);
      assert.equal(c.ok, true, '前置：新建批的 lane 可认领（' + JSON.stringify(c) + '）');
      return h.byName.lane_release.execute({ batchId: 'census-lock3', lane: 'l1', token: c.token }, EXEC);
    },
    reject: async (h) => {
      await freshBatch(h, 'census-lock4');
      const c = await h.byName.lane_claim.execute({ batchId: 'census-lock4', lane: 'l1' }, EXEC);
      assert.equal(c.ok, true, '前置：新建批的 lane 可认领');
      return h.byName.lane_release.execute({ batchId: 'census-lock4', lane: 'l1', token: 'bogus-token' }, EXEC);
    },
  },
  member_settle: {
    success: async (h) => {
      await h.byName.member_status.execute({ batchId: C1, lane: 'e1', status: 'running' }, EXEC);
      await h.byName.member_status.execute({ batchId: C1, lane: 'e1', status: 'review' }, EXEC);
      return h.byName.member_settle.execute({ batchId: C1, lane: 'e1', status: 'merged' }, EXEC);
    },
    reject: async (h) => h.byName.member_settle.execute({ batchId: C1, lane: 'a1', status: 'bogus' }, EXEC),
  },
  handoff_submit: {
    success: async (h) => h.byName.handoff_submit.execute(
      { batchId: C2, from: 'x1', to: 'y1', artifacts: ['exec/x1.md'], assertions: ['x1 产物可被 y1 直接消费'] }, EXEC),
    reject: async (h) => h.byName.handoff_submit.execute(
      { batchId: C1, from: 'p1', to: 'e1', artifacts: ['plan/ghost.md'], assertions: ['x'] }, EXEC),
  },
  handoff_view: {
    success: async (h) => h.byName.handoff_view.execute({ batchId: C1, lane: 'a1' }, EXEC), // 已交接 ⇒ ready 态
    reject: async (h) => h.byName.handoff_view.execute({ batchId: 'ghost-batch', lane: 'a1' }, EXEC),
  },
  lane_dispatch: {
    success: async (h) => h.byName.lane_dispatch.execute({ batchId: C2, lane: 'x1' }, EXEC),
    reject: async (h) => h.byName.lane_dispatch.execute({ batchId: C2, lane: 'ghost-lane' }, EXEC),
  },
  swarm_report: {
    success: async (h) => h.byName.swarm_report.execute(
      { type: 'progress', summary: '普查：进度回报', batchId: C1, lane: 'p1' }, EXEC),
    reject: async (h) => h.byName.swarm_report.execute({ type: 'bogus', summary: 'x' }, EXEC),
  },
  swarm_cc: {
    // `swarm_cc` 的 `type` 是 **Manager 抄送族**三值枚举（anomaly / decision-request / longrun-candidate），
    //   与 `swarm_report` 的 progress 族不同（同族误用即参数面拒）。
    success: async (h) => h.byName.swarm_cc.execute(
      { type: 'anomaly', summary: '普查：抄送回报', batchId: C1, lane: 'p1' }, EXEC),
    reject: async (h) => h.byName.swarm_cc.execute({ type: 'progress', summary: 'x' }, EXEC),
  },
  member_status: {
    success: async (h) => h.byName.member_status.execute({ batchId: C1, lane: 'a1', status: 'running' }, EXEC),
    reject: async (h) => h.byName.member_status.execute({ batchId: C1, lane: 'a1', status: 'bogus' }, EXEC),
  },
  mailbox_send: {
    success: async (h) => h.byName.mailbox_send.execute(
      { batchId: C1, box: 'inbox', message: { kind: 'census', text: '普查消息' } }, EXEC),
    reject: async (h) => h.byName.mailbox_send.execute({ batchId: C1, box: 'bogus', message: {} }, EXEC),
  },
  mailbox_read: {
    success: async (h) => h.byName.mailbox_read.execute({ batchId: C1, box: 'inbox' }, EXEC),
    reject: async (h) => h.byName.mailbox_read.execute({ batchId: C1, box: 'bogus' }, EXEC),
  },
  mailbox_ack: {
    success: async (h) => {
      const sent = await h.byName.mailbox_send.execute(
        { batchId: C1, box: 'inbox', message: { kind: 'census' } }, EXEC);
      return h.byName.mailbox_ack.execute({ batchId: C1, box: 'inbox', ackId: sent.ackId }, EXEC);
    },
    reject: async (h) => h.byName.mailbox_ack.execute(
      { batchId: C1, box: 'inbox', ackId: 'ghost-ack' }, EXEC),
  },
  lane_heartbeat: {
    success: async (h) => h.byName.lane_heartbeat.execute({ batchId: C1 }, EXEC),
    reject: async (h) => h.byName.lane_heartbeat.execute({ batchId: 'ghost-batch' }, EXEC),
  },
  lane_longrun: {
    success: async (h) => h.byName.lane_longrun.execute({ batchId: C1 }, EXEC),
    reject: async (h) => h.byName.lane_longrun.execute({ batchId: 'ghost-batch' }, EXEC),
  },
  lane_worktree_create: {
    // 夹具无 git 仓 ⇒ 预期走**返回型失败** `{ok:false,error}`（merge-agent.test.js T2.5 同口径）；
    //   该返回值同样必须满足自身 schema（这正是本普查要抓的面）。
    success: async (h) => h.byName.lane_worktree_create.execute({ batchId: C1, laneId: 'e1' }, EXEC),
    reject: async (h) => h.byName.lane_worktree_create.execute({ batchId: C1 }, EXEC),
  },
  lane_worktree_merge: {
    success: async (h) => h.byName.lane_worktree_merge.execute({ batchId: C1, laneId: 'e1' }, EXEC),
    reject: async (h) => h.byName.lane_worktree_merge.execute({ batchId: C1 }, EXEC),
  },
  lane_checkpoint: {
    success: async (h) => h.byName.lane_checkpoint.execute(
      { batchId: C1, laneId: 'e1', message: '普查 checkpoint' }, EXEC),
    reject: async (h) => h.byName.lane_checkpoint.execute({ batchId: C1, laneId: 'e1' }, EXEC),
  },
  lane_checkpoint_status: {
    success: async (h) => h.byName.lane_checkpoint_status.execute({ batchId: C1, laneId: 'e1' }, EXEC),
    reject: async (h) => h.byName.lane_checkpoint_status.execute({ batchId: C1 }, EXEC),
  },
  // N1-R4-1a：公共池只读视图。拒态 = 批次不存在（工具面抛业务错，非 schema 错）⇒ 亦被普查接受。
  task_pool: {
    success: async (h) => h.byName.task_pool.execute({ batchId: C1 }, EXEC),
    reject: async (h) => h.byName.task_pool.execute({ batchId: 'census-nope' }, EXEC),
  },
  // N1-R4-1c：池内追加任务（图变更写入口）。拒态 = 任务 id 与既有重复 ⇒ 抛普通错误（不新建 GATE_ 码）。
  batch_tasks_add: {
    success: async (h) => h.byName.batch_tasks_add.execute({ batchId: C2, tasks: [{ id: 'pool-add-1', layer: 'exec', role: 'coder' }], reason: '普查 fixture：池内追加' }, EXEC),
    reject: async (h) => h.byName.batch_tasks_add.execute({ batchId: C2, tasks: [{ id: 'p1' }] }, EXEC),
  },
  // N1-R4-2：池内任务**加边**（图变更写入口 #2）。夹具 = **独立批**（`freshBatch` ⇒ 三层链 p1→l1→la1），
  //   给 audit lane 追加**同批 plan lane** 的入边（已声明在先 + 上游层 ⇒ 通过结构约束；上游未结算 ⇒ 可加）。
  //   拒态 = 目标任务不存在 ⇒ 抛普通错误（不新建 `GATE_` 码）。
  task_update: {
    success: async (h) => h.byName.task_update.execute({
      batchId: await freshBatch(h, 'census-edge'),
      edges: [{ id: 'la1', add: ['p1'] }], reason: '普查 fixture：池内加边',
    }, EXEC),
    reject: async (h) => h.byName.task_update.execute({ batchId: C2, edges: [{ id: 'no-such-task', add: ['p1'] }] }, EXEC),
  },
};

/** 单次探测：返回值 ⇒ 逐条 schema 校验（双口径）；抛错 ⇒ 断言非 schema 形态。 */
async function probe(fn, h, tool) {
  const schema = outputSchemaOf(tool);
  assert.ok(schema, tool.name + ' 必须暴露 output.schema');
  try {
    const value = await fn(h);
    const local = schemaViolations(value, schema);
    const cross = await crossCheckConformance(value, schema);
    return { mode: 'value', value, local, cross };
  } catch (e) {
    assertRejectionIsNotSchemaError(e);
    return { mode: 'throw', message: String(e?.message ?? e) };
  }
}

test('TSC-1 全工具 output.schema 一致性普查：29 件逐工具三态（成功 / 拒态 / 显式 SKIPPED）', async () => {
  const h = await makeHarness();
  const names = h.byName && Object.keys(h.byName);
  const registered = Object.keys(CASES).filter((n) => h.byName[n]);
  assert.deepEqual(registered.slice().sort(), names.slice().sort(),
    'CASES 键集必须与已注册工具名集**双向相等**（禁漏测/禁多写）');

  const rows = [];
  const findings = [];
  const skips = [];
  let hostChecked = 0;
  for (const name of names.slice().sort()) {
    const tool = h.byName[name];
    const c = CASES[name];
    assert.ok(c, '缺用例：' + name);
    const row = { tool: name, success: '-', reject: '-', note: '' };

    if (typeof c.success === 'function') {
      const r = await probe(c.success, h, tool);
      assert.deepEqual(r.local ?? [], [], name + ' 成功路径返回值违反自身 output.schema：' + JSON.stringify(r.local));
      assert.notEqual(r.cross?.agree, false, name + ' 成功路径：本地口径与宿主口径不一致');
      if (r.cross?.host !== null && r.cross?.host !== undefined) hostChecked += 1;
      row.success = r.mode === 'value' ? '值已核' : '（抛：' + r.message.slice(0, 40) + '）';
      if (r.mode === 'throw') skips.push(name + '.success: 夹具内该路径抛业务错 ⇒ 无返回值可核');
    } else {
      row.success = 'SKIPPED';
      skips.push(name + '.success: ' + String(c.skip ?? '未给理由'));
    }

    if (typeof c.reject === 'function') {
      const r = await probe(c.reject, h, tool);
      if (r.mode === 'value') {
        assert.deepEqual(r.local ?? [], [], name + ' 拒态返回值违反自身 output.schema：' + JSON.stringify(r.local));
        row.reject = '返回值已核';
      } else {
        row.reject = '抛业务错（非 schema 错）';
      }
    } else {
      row.reject = 'SKIPPED';
      skips.push(name + '.reject: ' + String(c.skip ?? '未给理由'));
    }

    assert.ok((c.success || c.reject) || (typeof c.skip === 'string' && c.skip.trim().length > 0),
      name + ' 既未覆盖任何一态、又未给 SKIPPED 理由（禁静默跳过）');
    rows.push(row);
  }

  assert.deepEqual(findings, [], '普查发现缺陷（须逐个修复）：' + JSON.stringify(findings));
  assert.ok(hostChecked > 0, '双口径交叉校验须**真实生效**（宿主校验函数不可用 ⇒ 本项退化为空转，禁假绿）');
  console.log('TSC-TABLE\n' + rows.map((r) => [r.tool, r.success, r.reject].join(' | ')).join('\n'));
  console.log('TSC-SKIPS\n' + (skips.length ? skips.join('\n') : '（无）'));
  console.log('TSC-HOST 宿主口径交叉核验生效件数=' + hostChecked + '/' + names.length);
});

test('TSC-2 负控（防假绿）：同一校验器对「非法返回值」判违例、对真实返回值零误报', async () => {
  const h = await makeHarness();
  const submit = h.byName.handoff_submit;
  const schema = outputSchemaOf(submit);
  assert.ok(schema, '前置：handoff_submit 须暴露 output.schema');
  // 负控 = task-25 的真实缺陷形态（成功返回值 `code: null`，而 schema 要求 string）
  const bad = {
    ok: true, code: null, from: 'p1', to: 'e1', artifacts: ['plan/spec.md'], assertions: ['x'],
    missing: [], problems: [],
  };
  const local = schemaViolations(bad, schema);
  assert.ok(local.length > 0, '负控：code:null 必须被判违例（否则校验器无牙 ⇒ 普查假绿）：' + JSON.stringify(local));
  const cross = await crossCheckConformance(bad, schema);
  assert.notEqual(cross.host, null, '宿主校验函数须可用（@deepseek-ai/dsh-tools#validateJsonSchemaValue）');
  assert.ok(cross.host.length > 0, '宿主口径亦须判违例（双口径同判）');
  // 正控：真实成功返回值不得误报
  const real = await submit.execute(
    { batchId: C2, from: 'x1', to: 'y1', artifacts: ['exec/x1.md'], assertions: ['x1 产物可被 y1 消费'] }, EXEC);
  assert.deepEqual(schemaViolations(real, schema), [], '真实成功返回值不得误报（正控）');
});
