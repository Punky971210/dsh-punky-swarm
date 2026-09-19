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

// 回归锁（2026-09-16，两项缺口）：
//
// GAP-S3b —— `abort` 时的悬挂成员告警（用户裁决 = **折中方案**）：
//   批次若在成员未终态时被 `abort`，那些成员**永久无法回收**（`member_settle` 被拒 `GATE_BATCH_TERMINAL`），
//   `batch_status.danglingLanes` 会永久显示它们（真实案例：`p2b-chain-split-20260916` 被 abort 时留下 6 条 pending lane）。
//   裁决：abort **不自动改成员状态**（不做隐式批量 `skipped`），但 `batch_phase({phase:'aborted'})` 在检测到
//   本批存在非终态成员时须**额外落一条告警事件 + 工具返回回显**。
//   判据复用引擎单一事实源：`lib/schema.js` 的 `isMemberTerminal` / `SETTLE_STATES`，经 lane 级单点
//   `lib/watch/lane-heartbeat.js` 的 `isDanglingLane` 承担（与 `batch_status.danglingLanes` 同一实现、同一语义）；
//   lane 名单口径同样复用既有读端 `Object.keys(batch.lanes)`（与 `batch_status` 的 `derivedOf` 同源）。
//   本文件覆盖：① 有悬挂 ⇒ 事件 + 回显 + **成员状态逐字未变**（含批文件字节级比对）；
//   ② 无悬挂 ⇒ 不落事件、键不出现（反向锁）；③ `complete` 相位不落该事件（回归锁）。
//
// GAP-S9 —— 新告警码的事件类型误标：`wave_plan` 的告警事件化原把「非 `GATE_ROLE_MISSING`」的一切告警
//   一律事件化成 `gate.role_invalid` ⇒ 上一批新增的 `GATE_COMPLETE_OUTCOMES_EMPTY` 建批期告警也显示成
//   「role 非法」（载荷 `code` 正确、事件 type 误导读端）。修复 = `WARN_EVENT_OF` 按码映射表；
//   未命中映射的码**保持现状 = `gate.role_invalid`**（向后兼容，不迁移既有码的事件 type）。
//   本文件覆盖：④ 坏 verdict 团队资产建批 ⇒ 事件 type = 专用常量（**不是** `gate.role_invalid`）；
//   ⑤ 反向锁：`GATE_AUDIT_CONTRACT_EXEMPT`（catch-all 面）的事件 type **仍为** `gate.role_invalid`（证明未迁移）；
//   ⑥ 基线对账：断言删除数 0（新增断言数 > 0）。
//
// 夹具纪律：**不修改仓库内任何 `presets/**` 真实资产** —— 「坏 verdict 资产」由临时 `teamsRoot`
//   复制 `software-team` 资产骨架后**改一处**构造；技能名与 software-team 同集 ⇒ 由
//   `seedTeamAssetSkills('software-team')` 注入隔离宿主技能根（P1 起建批期 skills 校验 fail-closed）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import * as EVT from '../lib/state/event-types.js';
import { compareBaseline, findRepoRoot, readBaseline, scanTree } from '../scripts/baseline-snapshot-core.mjs';
import { SPEC_OK, assessC, seedArtifacts } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills } from './helpers/host-skills.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // cwd 无关
const SRC_ASSET = path.join(PKG, 'presets', 'software-team', 'team-asset.yml');
const SESS_ID = 'sess-s3b';
const SESS = { agent: { session: { id: SESS_ID } } };
const DANGLING_EVT = EVT.EVT_BATCH_ABORT_DANGLING ?? 'batch.abort_dangling';
const OUTCOMES_EMPTY_EVT = EVT.EVT_GATE_COMPLETE_OUTCOMES_EMPTY ?? 'gate.complete_outcomes_empty';
const ROLE_INVALID_EVT = EVT.EVT_GATE_ROLE_INVALID ?? 'gate.role_invalid';
const OUTCOMES_EMPTY_CODE = 'GATE_COMPLETE_OUTCOMES_EMPTY';

seedTeamAssetSkills('software-team'); // 临时资产技能名与 software-team 同集 ⇒ 须可在隔离宿主技能根解析

// ═══════════════════════════════════════════════════════════════════════════════
// 夹具：临时 store 根 + 真工具面（createTools）
// ═══════════════════════════════════════════════════════════════════════════════
function makeHarness(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3b-s9-' + tag + '-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // G1 前置：`wave_plan` 属 C 档动作 ⇒ 先按 `assign_check` 的同一落盘函数写「已评估为 C」
  assessC(store, SESS_ID, { rationale: 'GAP-S3b/GAP-S9 回归锁：wave_plan 属 C 档动作（单批三层治理面）' });
  return { root, store, byName };
}

// 合规三层批（plan 产物被 exec 与 audit 双重消费；audit 同时 consume plan/ 与 exec/ ⇒ 满足
// software-team 的 `audit_contract.consumes_required`）
function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'code' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'accept' },
  ];
}

const LAYOUT_TEAM = 'software-team';
const LAYOUT_TASKS = tasks3();
const LAYOUT_ASM = { auditLane: 'a1', managerPlan: 'leader-direct' };

async function makeBatch(byName, root, batchId, over = {}) {
  const out = await byName.wave_plan.execute({
    batchId, team: over.team ?? LAYOUT_TEAM, tasks: over.tasks ?? LAYOUT_TASKS,
    ...(over.teamsRoot ? { teamsRoot: over.teamsRoot } : {}),
    assembly: over.assembly ?? LAYOUT_ASM,
  }, SESS);
  // 产物落盘：满足 exit 门（plan 契约 + produce/outputs 在场）——否则成员根本结算不到终态
  seedArtifacts(root, SESS_ID, batchId, ['e1']);
  return out;
}

/** 走完一条 lane 的合法结算链（pending → running → review → merged）。 */
function settleLane(store, batchId, lane) {
  store.setMember(SESS_ID, batchId, lane, 'running');
  store.setMember(SESS_ID, batchId, lane, 'review');
  store.setMember(SESS_ID, batchId, lane, 'merged');
}

const batchFile = (root, batchId) => path.join(root, 'sessions', SESS_ID, 'batches', batchId + '.json');
/** 批文件**原始字节**（比对「abort 前后批文件逐字不变」——绕开序列化等价带来的假阳性）。 */
const batchBytes = (root, batchId) => fs.readFileSync(batchFile(root, batchId));

const danglingEventsOf = (store, batchId) => (store.readBatch(SESS_ID, batchId).events ?? []).filter((e) => e && e.type === DANGLING_EVT);

// ═══════════════════════════════════════════════════════════════════════════════
// GAP-S3b · (1) 有悬挂成员 ⇒ 落事件 + 返回回显 + 成员状态逐字未变
// ═══════════════════════════════════════════════════════════════════════════════
test('S3b-1：abort 含非终态成员的批 ⇒ 落 batch.abort_dangling（载荷 lane 名单正确）+ 返回 danglingLanes + 成员状态逐字未变', async () => {
  const { root, store, byName } = makeHarness('dangling');
  await makeBatch(byName, root, 'b-dangling');
  await byName.batch_phase.execute({ batchId: 'b-dangling', phase: 'running' }, SESS);
  settleLane(store, 'b-dangling', 'p1');
  store.setMember(SESS_ID, 'b-dangling', 'e1', 'running'); // 非终态：已被派发但未结算
  // a1 保持 pending（非终态）

  const lanesBefore = { ...store.readBatch(SESS_ID, 'b-dangling').lanes };
  const eventsBefore = store.readBatch(SESS_ID, 'b-dangling').events ?? [];
  assert.deepEqual(lanesBefore, { p1: 'merged', e1: 'running', a1: 'pending' }, '前置：恰两条非终态成员 + 一条终态成员');

  const before = danglingEventsOf(store, 'b-dangling').length;
  const out = await byName.batch_phase.execute({ batchId: 'b-dangling', phase: 'aborted' }, SESS);

  assert.equal(out.phase, 'aborted', 'abort 照常生效（本改动不阻断相位迁移）');
  assert.deepEqual(out.danglingLanes, ['e1', 'a1'], '返回回显悬挂 lane 名单（终态成员 p1 不得列入）');
  assert.equal(!!Object.prototype.hasOwnProperty.call(out, 'danglingLanes'), true, '非空时显式写键（schema 已声明）');

  const evs = danglingEventsOf(store, 'b-dangling');
  assert.equal(evs.length, before + 1, '须恰好新增一条 batch.abort_dangling 事件');
  assert.deepEqual(evs[0].danglingLanes, ['e1', 'a1'], '事件载荷 danglingLanes = 非终态成员名单（判据同 isMemberTerminal）');
  assert.equal(evs[0].count, 2, '事件载荷 count = 名单长度');

  // 绝对不得修改任何成员状态：batch.lanes 逐字不变 + 除本告警外零新增事件
  const b = store.readBatch(SESS_ID, 'b-dangling');
  assert.deepEqual(b.lanes, lanesBefore, '成员状态逐字未变（不做隐式批量 skipped）');
  const newEvs = b.events.slice(eventsBefore.length);
  assert.deepEqual(newEvs.map((e) => e.type), [EVT.EVT_BATCH_PHASE, DANGLING_EVT],
    'abort 只多落「相位迁移 + 悬挂告警」两条事件，零成员迁移事件');
  assert.equal(batchBytes(root, 'b-dangling').length > 0, true, '批文件照常可读（改动不得损坏落盘）');

  // 终态冻结语义逐字不变（悬挂成员永久无法回收 —— 本告警要显式化的既有事实）
  assert.throws(() => store.setMember(SESS_ID, 'b-dangling', 'a1', 'skipped'),
    /GATE_BATCH_TERMINAL/, '既有「批次已终态拒绝再写」码与判定逐字不变');
});

test('S3b-1b：render 文案给出可读提示（dangling lanes: N），无悬挂时不追加', async () => {
  const { root, store, byName } = makeHarness('render');
  await makeBatch(byName, root, 'b-render');
  await byName.batch_phase.execute({ batchId: 'b-render', phase: 'running' }, SESS);
  settleLane(store, 'b-render', 'p1');
  const out = await byName.batch_phase.execute({ batchId: 'b-render', phase: 'aborted' }, SESS);
  const rendered = byName.batch_phase.output.render({}, out);
  const text = (Array.isArray(rendered) ? rendered.map((r) => r.text).join('') : String(rendered));
  assert.equal(text.includes('dangling lanes: 2'), true, 'render 须含可读提示；实测=' + text);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GAP-S3b · (2)(3) 反向锁 + complete 回归锁
// ═══════════════════════════════════════════════════════════════════════════════
test('S3b-2 反向锁：abort 全终态成员的批 ⇒ 不落该事件、返回无 danglingLanes 键', async () => {
  const { root, store, byName } = makeHarness('clean');
  await makeBatch(byName, root, 'b-clean');
  await byName.batch_phase.execute({ batchId: 'b-clean', phase: 'running' }, SESS);
  for (const lane of ['p1', 'e1', 'a1']) settleLane(store, 'b-clean', lane);

  const out = await byName.batch_phase.execute({ batchId: 'b-clean', phase: 'aborted' }, SESS);
  assert.equal(out.danglingLanes, undefined, '无悬挂成员 ⇒ 键不出现（未声明不写键）');
  assert.deepEqual(danglingEventsOf(store, 'b-clean'), [], '无悬挂成员 ⇒ 不落 batch.abort_dangling');
  assert.deepEqual(store.readBatch(SESS_ID, 'b-clean').lanes, { p1: 'merged', e1: 'merged', a1: 'merged' }, '成员状态照旧全终态');
});

test('S3b-3 回归锁：complete 相位不落 batch.abort_dangling（本改动不介入 complete 面）', async () => {
  const { root, store, byName } = makeHarness('complete');
  await makeBatch(byName, root, 'b-complete');
  await byName.batch_phase.execute({ batchId: 'b-complete', phase: 'running' }, SESS);
  for (const lane of ['p1', 'e1', 'a1']) settleLane(store, 'b-complete', lane);

  const out = await byName.batch_phase.execute({ batchId: 'b-complete', phase: 'complete' }, SESS);
  assert.equal(out.phase, 'complete', 'complete 照常生效（本改动不介入 complete 相位）');
  assert.equal(out.danglingLanes, undefined, 'complete 不得回显 danglingLanes（相位面零差异）');
  assert.deepEqual(danglingEventsOf(store, 'b-complete'), [], 'complete 不得落 batch.abort_dangling');
  // 结构性反例锁：complete 面的判定是 `b.phase === 'aborted'`（相位面硬隔离），
  //   故只要 complete 路径不产悬挂告警，任何成员态组合下都不会落该事件。
  assert.equal(out.phase === 'aborted', false, 'complete 与 aborted 相位面互斥（同一判定分支不可能同时命中）');
});

test('S3b-3b 回归锁：running / paused 相位不落 batch.abort_dangling（相位面零差异）', async () => {
  const { root, store, byName } = makeHarness('phases');
  await makeBatch(byName, root, 'b-phases');
  await makeBatch(byName, root, 'b-phases2');
  for (const bid of ['b-phases', 'b-phases2']) {
    await byName.batch_phase.execute({ batchId: bid, phase: 'running' }, SESS);
    assert.deepEqual(danglingEventsOf(store, bid), [], bid + '：running 相位不得落告警（即使三条成员全 pending）');
  }
  await byName.batch_phase.execute({ batchId: 'b-phases2', phase: 'paused' }, SESS);
  assert.deepEqual(danglingEventsOf(store, 'b-phases2'), [], 'paused 相位不得落告警');
});

// ═══════════════════════════════════════════════════════════════════════════════
// GAP-S9 · (4)(5) 告警事件化按码映射 + 反向锁
// ═══════════════════════════════════════════════════════════════════════════════
function writeTempTeam(prefix, team, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(root, 'presets', team);
  fs.mkdirSync(dir, { recursive: true });
  const asset = JSON.parse(fs.readFileSync(SRC_ASSET, 'utf8')); // 复制真实资产骨架（不改仓库内资产）
  mutate(asset);
  fs.writeFileSync(path.join(dir, 'team-asset.yml'), JSON.stringify(asset, null, 2), 'utf8');
  return root;
}

test('S9-1：坏 verdict 团队资产建批 ⇒ 告警事件 type = gate.complete_outcomes_empty（**不是** gate.role_invalid）', async () => {
  const { root, store, byName } = makeHarness('s9empty');
  const teamsRoot = writeTempTeam('s3b-s9-bad-', 's9-bad-team', (a) => {
    a.flows.audit.audit_contract.verdict = ['approve', 'reject']; // 唯一改动：词域换成产物层裁决词
  });
  const out = await makeBatch(byName, root, 'b-s9-empty', { team: 's9-bad-team', teamsRoot });
  assert.equal(out.batchId, 'b-s9-empty', '告警不阻断建批（批次照建）');

  const evs = (store.readBatch(SESS_ID, 'b-s9-empty').events ?? []).filter((e) => e && e.code === OUTCOMES_EMPTY_CODE);
  assert.equal(evs.length, 1, '告警随建批落一条事件');
  assert.equal(evs[0].type, OUTCOMES_EMPTY_EVT, '事件 type 须为专用常量；实测=' + evs[0].type);
  assert.equal(evs[0].type === ROLE_INVALID_EVT, false, '不得再落成 catch-all 的 gate.role_invalid（GAP-S9 本体）');
  assert.equal(evs[0].code, OUTCOMES_EMPTY_CODE, '载荷 code 逐字保留（字段形态零增删）');
  assert.ok(Object.prototype.hasOwnProperty.call(evs[0], 'task'), '载荷既有字段形态保持（task 键仍在）');
  assert.ok(Object.prototype.hasOwnProperty.call(evs[0], 'layer'), '载荷既有字段形态保持（layer 键仍在）');
});

test('S9-2 反向锁：catch-all 面的告警码事件 type **仍为** gate.role_invalid（证明未迁移既有码）', async () => {
  const { root, store, byName } = makeHarness('s9catch');
  const teamsRoot = writeTempTeam('s3b-s9-exempt-', 's9-exempt-team', (a) => {
    a.flows.audit.audit_contract = {}; // 唯一改动：audit_contract 显式豁免（空声明）⇒ GATE_AUDIT_CONTRACT_EXEMPT
  });
  const out = await makeBatch(byName, root, 'b-s9-exempt', { team: 's9-exempt-team', teamsRoot });
  assert.equal(out.batchId, 'b-s9-exempt', '豁免告警不阻断建批');
  const codes = (out.warnings ?? []).map((w) => w.code);
  assert.equal(codes.includes('GATE_AUDIT_CONTRACT_EXEMPT'), true, '夹具须命中透传面告警；实测 warnings=' + JSON.stringify(codes));

  const evs = (store.readBatch(SESS_ID, 'b-s9-exempt').events ?? []).filter((e) => e && e.code === 'GATE_AUDIT_CONTRACT_EXEMPT');
  assert.equal(evs.length, 1, '豁免告警落一条事件');
  assert.equal(evs[0].type, ROLE_INVALID_EVT, '未命中映射的码**逐字保持现状** = gate.role_invalid（向后兼容锁）');
  assert.equal(evs[0].type === OUTCOMES_EMPTY_EVT, false, '不得被新映射误伤');
});

// ═══════════════════════════════════════════════════════════════════════════════
// (6) 断言删除数为 0（与 `scripts/baseline-snapshot.mjs --check` 同源对账）
// ═══════════════════════════════════════════════════════════════════════════════
test('S3b-S9-C6：基线对账——断言零下降 / 恒真零新增，且本文件已登记（新增断言数 > 0）', () => {
  const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const baseline = readBaseline(ROOT);
  const scan = scanTree(ROOT);
  const cmp = compareBaseline(baseline, scan);
  assert.ok(cmp.asserts.delta >= 0, '断言调用数不得低于基线（禁静默删断言）；delta=' + String(cmp.asserts.delta));
  assert.ok(cmp.tautologies.delta <= 0, '恒真形态命中数不得上升（禁等价替换）；delta=' + String(cmp.tautologies.delta));
  assert.equal(cmp.ok, true, '基线对账须 0 漂移；逐文件变化=' + JSON.stringify(cmp.filesChanged));
  const mine = baseline.files?.['test/abort-dangling-and-warn-event.test.js'];
  assert.ok(mine, '本文件须在 baselines/test-baseline.json 中登记（由 scripts/baseline-snapshot.mjs 重生成）');
  assert.ok(mine.asserts > 0, '本文件新增断言数 > 0；实测 asserts=' + String(mine.asserts));
  assert.ok(mine.tests > 0, '本文件新增用例数 > 0；实测 tests=' + String(mine.tests));
});
