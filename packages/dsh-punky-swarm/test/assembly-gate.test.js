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

// C+ 档装配门禁（wave_plan 建批静态校验）——spec D 测试矩阵（T1-T12 核心；T13 roles 文档核验为 audit 侧；T11 全量回归由 DoD gate 承担）
// 消费构建产物：lib/wave-plan.js（.ts 源码改后须 npm run build 再生再测）+ createTools harness + 宿主同款 dsh-tools DSL 编译断言
// 覆盖：纯函数（countExecLanes/isCPlusBatch/normalizeAssemblyDecl/assemblyGate）、工具 execute 集成（拒建批/持久化/
// pendingBatch 锁保留/告警留痕/层错配拒）、DSL 合规（defineTool 同编译路径，T9）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { valueSchemaSpecToJsonSchema, parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import {
  countExecLanes, isCPlusBatch, normalizeAssemblyDecl, assemblyGate, MANAGER_PLANS,
  buildWavePlan, validateWavePlan, ROLE_WHITELIST,
} from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

// ── fixtures ──

// 三层批任务样张：p1(plan/designer) + execN 个 exec/coder + a1(audit/supervisor)。
// exec≥3 即 C+（spec §2/§3.1）；角色齐备（plan designer / audit supervisor）→ 无 GATE_ROLE_MISSING 噪音
function cplusTasks(execN, { coordinator = false } = {}) {
  const tasks = [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/s.md'], cmd: 'spec' },
  ];
  if (coordinator) tasks.push({ id: 'c1', layer: 'plan', role: 'coordinator', deps: ['p1'], consume: ['plan/s.md'], produce: ['plan/tree.json'], cmd: 'split' });
  for (let i = 1; i <= execN; i++) {
    tasks.push({ id: 'e' + i, layer: 'exec', role: 'coder', consume: ['plan/s.md'], outputs: ['exec/e' + i + '/o.md'], deps: ['p1'], cmd: 'impl' });
  }
  tasks.push({ id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/s.md'], produce: ['audit/r.md'], deps: ['e' + execN], cmd: 'verify' });
  return tasks;
}

// §3.2 合规 assembly 值对象（DSL 编译断言与 core.js wave_plan 参数同形态；required 编译收集为布尔）
const ASSEMBLY_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    managerPlan: { type: 'string', required: true, enum: ['raise', 'leader-direct'], description: '编排牵头形态' },
    auditLane: { type: 'string', required: true, description: '验收归属 lane id' },
    coordinatorLane: { type: 'string', description: '可选' },
    roles: { type: 'array', items: { type: 'string' }, description: '可选' },
  },
};

// ── 工具 harness（每 suite 独立临时根；register.js 定义 wave_plan 时即编译参数 DSL——违规会在此炸） ──
function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-cpa-'));
  const store = createStore(root);
  const reg = [];
  const ctx = { tools: { register: (t) => reg.push(t) }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, store, byName };
}
const SESS = { agent: { session: { id: 'sess-cpa' } } };
function batchFileOf(root, sessionId, batchId) {
  return path.join(root, 'sessions', sessionId, 'batches', batchId + '.json');
}

// ── T1-T8 纯函数面 ──

test('T1 纯函数：C+（exec≥3 三层批）缺 assembly → GATE_ROLE_ASSEMBLY_MISSING', () => {
  const tasks = cplusTasks(3);
  assert.equal(countExecLanes(tasks), 3);
  assert.equal(isCPlusBatch(tasks), true);
  const r = assemblyGate(tasks, null);
  assert.notEqual(r, 'ok');
  assert.equal(r.code, 'GATE_ROLE_ASSEMBLY_MISSING');
  assert.match(r.message, /C\+ batch requires assembly declaration \(exec lanes >= 3\)/);
  assert.match(r.message, /pass assembly: \{ managerPlan: 'raise'\|'leader-direct', auditLane: '<audit lane id>' \}/);
});

test('T2/T3 纯函数：C+ 带合规 assembly（raise/leader-direct + auditLane + coordinatorLane/roles）→ ok + 归一化', () => {
  for (const managerPlan of ['raise', 'leader-direct']) {
    const tasks = cplusTasks(3, { coordinator: true });
    const { decl } = normalizeAssemblyDecl({ managerPlan, auditLane: 'a1', coordinatorLane: 'c1', roles: ['designer', 'coder', 'supervisor'] });
    assert.equal(assemblyGate(tasks, decl), 'ok');
  }
});

test('normalizeAssemblyDecl：缺省/undefined → { decl: null, warnings: [] }；roles 合法大小写不敏感', () => {
  assert.deepEqual(normalizeAssemblyDecl(undefined), { decl: null, warnings: [] });
  assert.deepEqual(normalizeAssemblyDecl(null), { decl: null, warnings: [] });
  const { decl, warnings } = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', roles: ['Designer', 'Coder'] });
  assert.equal(warnings.length, 0);
  assert.deepEqual(decl, { managerPlan: 'raise', auditLane: 'a1', roles: ['Designer', 'Coder'] }); // 词条大小写原样透传（词法判定不敏感）
});

test('T4 纯函数：三层批 exec=2（<3）缺 assembly → 不强制（ok）', () => {
  const tasks = cplusTasks(2);
  assert.equal(countExecLanes(tasks), 2);
  assert.equal(isCPlusBatch(tasks), false);
  assert.equal(assemblyGate(tasks, null), 'ok');
});

test('T5 纯函数：generic 批（无 layer）缺 assembly / 带 assembly → ok', () => {
  const generic = [{ id: 'x' }, { id: 'y', deps: ['x'] }];
  assert.equal(isCPlusBatch(generic), false);
  assert.equal(assemblyGate(generic, null), 'ok');
  const { decl } = normalizeAssemblyDecl({ managerPlan: 'leader-direct', auditLane: 'x' });
  assert.equal(assemblyGate(generic, decl), 'ok');
});

test('T6 纯函数：assembly 结构非法 → GATE_ASSEMBLY_INVALID throw（fail-closed）', () => {
  assert.throws(() => normalizeAssemblyDecl('raise'), /GATE_ASSEMBLY_INVALID: assembly must be an object/);
  assert.throws(() => normalizeAssemblyDecl([]), /GATE_ASSEMBLY_INVALID: assembly must be an object/);
  assert.throws(() => normalizeAssemblyDecl({}), /GATE_ASSEMBLY_INVALID: assembly\.managerPlan must be one of raise\|leader-direct/);
  assert.throws(() => normalizeAssemblyDecl({ managerPlan: 'bogus', auditLane: 'a1' }), /GATE_ASSEMBLY_INVALID: assembly\.managerPlan must be one of raise\|leader-direct \(got: bogus\)/);
  assert.throws(() => normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 7 }), /GATE_ASSEMBLY_INVALID: assembly\.auditLane must be a non-empty string/);
  assert.throws(() => normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 7 }), /GATE_ASSEMBLY_INVALID: assembly\.coordinatorLane must be a non-empty string/);
});

test('T7 纯函数：auditLane/coordinatorLane 悬空 lane id → GATE_ASSEMBLY_INVALID throw', () => {
  const tasks = cplusTasks(3);
  const d1 = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'nope' }).decl;
  assert.throws(() => assemblyGate(tasks, d1), /GATE_ASSEMBLY_INVALID: assembly\.auditLane "nope" does not match any task id/);
  const d2 = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 'nope' }).decl;
  assert.throws(() => assemblyGate(tasks, d2), /GATE_ASSEMBLY_INVALID: assembly\.coordinatorLane "nope" does not match any task id/);
});

test('T12 纯函数：层错配拒建批（auditLane 非 audit 层 / coordinatorLane 非 plan 层 → GATE_ASSEMBLY_INVALID，spec §3.3/§3.5 结构前置）', () => {
  const tasks = cplusTasks(3); // p1=plan / e1..e3=exec / a1=audit
  // auditLane 指向 plan 层 / exec 层 lane
  const dPlan = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'p1' }).decl;
  assert.throws(() => assemblyGate(tasks, dPlan), /GATE_ASSEMBLY_INVALID: assembly\.auditLane "p1" must reference an audit-layer lane \(found layer: plan\)/);
  const dExec = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'e1' }).decl;
  assert.throws(() => assemblyGate(tasks, dExec), /must reference an audit-layer lane \(found layer: exec\)/);
  // coordinatorLane 指向 audit 层 / exec 层 lane（auditLane 合规为 audit 层 a1）
  const dCoordAudit = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 'a1' }).decl;
  assert.throws(() => assemblyGate(tasks, dCoordAudit), /GATE_ASSEMBLY_INVALID: assembly\.coordinatorLane "a1" must reference a plan-layer lane \(found layer: audit\)/);
  const dCoordExec = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 'e2' }).decl;
  assert.throws(() => assemblyGate(tasks, dCoordExec), /must reference a plan-layer lane \(found layer: exec\)/);
  // 层归属不限于 C+：三层批 exec=2（<3）携带 assembly 层错配同样拒（fail-closed，§3.3 行无条件）
  assert.throws(() => assemblyGate(cplusTasks(2), dPlan), /assembly\.auditLane "p1" must reference an audit-layer lane/);
  // generic 批跳过层归属（无层可归属；T5 语义：带 assembly 仅信息性持久化——由 T5 用例覆盖通过路径）
});

test('T8 纯函数：roles 词法非法 → GATE_ROLE_INVALID 告警（不 throw），批次仍可建', () => {
  const r1 = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', roles: ['designer', 'bogus-role'] });
  assert.equal(r1.warnings.length, 1);
  assert.equal(r1.warnings[0].code, 'GATE_ROLE_INVALID');
  assert.match(r1.warnings[0].message, /assembly\.roles entry "bogus-role" is not a valid role/);
  assert.deepEqual(r1.decl.roles, ['designer']); // 非法词条剔除，合法保留
  assert.equal(assemblyGate(cplusTasks(3), r1.decl), 'ok');
  // 非字符串词条 / roles 非数组 → 告警
  const r2 = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', roles: ['coder', 42] });
  assert.equal(r2.warnings.length, 1);
  const r3 = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', roles: 'coder' });
  assert.equal(r3.warnings.length, 1);
  assert.match(r3.warnings[0].message, /assembly\.roles must be an array of role strings/);
  // 合法角色集合包含装配扩展（盲审三角色），不误报
  const ext = [...ROLE_WHITELIST].find((r) => !['coordinator', 'manager', 'designer', 'coder', 'tester', 'reviewer', 'supervisor', 'doc-manager'].includes(r));
  assert.ok(ext, 'ROLE_WHITELIST 含扩展角色');
  const r4 = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', roles: [ext] });
  assert.equal(r4.warnings.length, 0);
});

test('countExecLanes/isCPlusBatch：边界口径（仅按 task.layer 计）', () => {
  assert.equal(countExecLanes([{ id: 'a', layer: 'exec' }, { id: 'b', layer: 'plan' }, { id: 'c' }]), 1);
  assert.equal(countExecLanes([{ id: 'a', layer: 'exec' }, { id: 'b', layer: 'exec' }]), 2);
  assert.equal(isCPlusBatch([{ id: 'a', layer: 'exec' }, { id: 'b', layer: 'exec' }]), false, 'exec<3 不触发');
  assert.equal(isCPlusBatch([{ id: 'x' }]), false, 'generic 不触发');
});

// ── T1-T8 工具 execute 集成面 ──

test('T1 execute：C+ 缺 assembly → reject（GATE_ROLE_ASSEMBLY_MISSING）+ 无批次 JSON + pendingBatch 锁保留', async () => {
  const { root, store, byName } = makeHarness();
  store.writeGovernance('sess-cpa', { lastAssign: { form: 'C', at: new Date().toISOString() }, pendingBatch: true, pendingSince: new Date().toISOString() });
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'cpa-t1', tasks: cplusTasks(3) }, SESS),
    /GATE_ROLE_ASSEMBLY_MISSING: C\+ batch requires assembly declaration \(exec lanes >= 3\)/,
  );
  assert.equal(fs.existsSync(batchFileOf(root, 'sess-cpa', 'cpa-t1')), false, '拒建批：无批次 JSON 落盘');
  assert.equal(store.readGovernance('sess-cpa').pendingBatch, true, '拒建批：pendingBatch 锁保留（Leader 补声明后重试解锁）');
});

test('T2 execute：C+ 带合规 assembly → 通过 + batch JSON 顶层 assembly 持久化 + 返回含 assembly + warnings 无新增', async () => {
  const { root, store, byName } = makeHarness();
  const decl = { managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 'c1', roles: ['designer', 'coder', 'supervisor'] };
  const out = await byName.wave_plan.execute({ batchId: 'cpa-t2', tasks: cplusTasks(3, { coordinator: true }), assembly: decl }, SESS);
  assert.equal(out.batchId, 'cpa-t2');
  assert.deepEqual(out.assembly, decl, '返回含归一化 assembly 视图');
  assert.equal(out.warnings.length, 0, '合规声明 warnings 无新增');
  const raw = JSON.parse(fs.readFileSync(batchFileOf(root, 'sess-cpa', 'cpa-t2'), 'utf8'));
  assert.equal(raw.schema, 3, 'batch schema 不升');
  assert.deepEqual(raw.assembly, decl, 'batch JSON 顶层持久化 assembly（归一化 decl）');
  assert.equal(store.readGovernance('sess-cpa').pendingBatch, false, '建批成功解锁');
});

test('T3 execute：C+ 带 leader-direct → 通过（枚举两值皆合法）', async () => {
  const { byName } = makeHarness();
  const out = await byName.wave_plan.execute({ batchId: 'cpa-t3', tasks: cplusTasks(3), assembly: { managerPlan: 'leader-direct', auditLane: 'a1' } }, SESS);
  assert.deepEqual(out.assembly, { managerPlan: 'leader-direct', auditLane: 'a1' });
});

test('T4 execute：三层批 exec=2（<3）缺 assembly → 通过（行为与现状一致，不强制）', async () => {
  const { root, byName } = makeHarness();
  const out = await byName.wave_plan.execute({ batchId: 'cpa-t4', tasks: cplusTasks(2) }, SESS);
  assert.ok(out.lanes.p1 === 'pending');
  const raw = JSON.parse(fs.readFileSync(batchFileOf(root, 'sess-cpa', 'cpa-t4'), 'utf8'));
  assert.equal('assembly' in raw, false, 'exec<3 缺声明：batch JSON 不写 assembly 键（零噪音）');
});

test('T5 execute：generic 批无 assembly 通过；带 assembly 亦通过（仅持久化，声明无害）', async () => {
  const { root, byName } = makeHarness();
  const g1 = await byName.wave_plan.execute({ batchId: 'cpa-t5a', tasks: [{ id: 'x' }, { id: 'y' }] }, SESS);
  assert.ok(g1.lanes.x === 'pending');
  assert.equal('assembly' in g1, false);
  const raw1 = JSON.parse(fs.readFileSync(batchFileOf(root, 'sess-cpa', 'cpa-t5a'), 'utf8'));
  assert.equal('assembly' in raw1, false);
  const g2 = await byName.wave_plan.execute({ batchId: 'cpa-t5b', tasks: [{ id: 'x' }, { id: 'y' }], assembly: { managerPlan: 'leader-direct', auditLane: 'x' } }, SESS);
  assert.deepEqual(g2.assembly, { managerPlan: 'leader-direct', auditLane: 'x' });
  const raw2 = JSON.parse(fs.readFileSync(batchFileOf(root, 'sess-cpa', 'cpa-t5b'), 'utf8'));
  assert.deepEqual(raw2.assembly, { managerPlan: 'leader-direct', auditLane: 'x' });
});

test('T6 execute：assembly 结构非法 → 拒建批（arg 校验宿主等价 ToolArgsError + 内部 fail-closed GATE_ASSEMBLY_INVALID），批次不落盘', async () => {
  const { root, byName } = makeHarness();
  // 宿主路径：defineTool 编译参数 DSL 后，execute 前 arg 校验即拒（与真宿主同一条校验路径——结构非法不进 execute）
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t6a', tasks: cplusTasks(3), assembly: 'raise' }, SESS), /invalid arguments: "assembly" must be an object/);
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t6b', tasks: cplusTasks(3), assembly: { managerPlan: 'bogus', auditLane: 'a1' } }, SESS), /invalid arguments: "assembly\.managerPlan" must be one of \["raise","leader-direct"\]/);
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t6c', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: 7 } }, SESS), /invalid arguments: "assembly\.auditLane" must be a string/);
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t6d', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: 'a1', zzz: 1 } }, SESS), /invalid arguments: "assembly\.zzz" is not a declared property/);
  // 内部 fail-closed 路径：DSL 无法表达的形态（空/空白 auditLane 通过 arg 校验）→ execute 内 normalizeAssemblyDecl 抛 GATE_ASSEMBLY_INVALID
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t6e', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: '' } }, SESS), /GATE_ASSEMBLY_INVALID: assembly\.auditLane must be a non-empty string/);
  for (const id of ['cpa-t6a', 'cpa-t6b', 'cpa-t6c', 'cpa-t6e']) {
    assert.equal(fs.existsSync(batchFileOf(root, 'sess-cpa', id)), false, '拒建批：' + id + ' 无批次 JSON 落盘');
  }
});

test('T7 execute：assembly 悬空 lane id → reject（GATE_ASSEMBLY_INVALID）', async () => {
  const { root, byName } = makeHarness();
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t7', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: 'no-such-lane' } }, SESS), /GATE_ASSEMBLY_INVALID: assembly\.auditLane "no-such-lane" does not match any task id/);
  assert.equal(fs.existsSync(batchFileOf(root, 'sess-cpa', 'cpa-t7')), false);
});

test('T12 execute：层错配（auditLane 非 audit 层 / coordinatorLane 非 plan 层）→ 拒建批（GATE_ASSEMBLY_INVALID），批次不落盘', async () => {
  const { root, byName } = makeHarness();
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t12a', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: 'p1' } }, SESS), /GATE_ASSEMBLY_INVALID: assembly\.auditLane "p1" must reference an audit-layer lane \(found layer: plan\)/);
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t12b', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 'e1' } }, SESS), /GATE_ASSEMBLY_INVALID: assembly\.coordinatorLane "e1" must reference a plan-layer lane \(found layer: exec\)/);
  await assert.rejects(() => byName.wave_plan.execute({ batchId: 'cpa-t12c', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 'a1' } }, SESS), /GATE_ASSEMBLY_INVALID: assembly\.coordinatorLane "a1" must reference a plan-layer lane \(found layer: audit\)/);
  for (const id of ['cpa-t12a', 'cpa-t12b', 'cpa-t12c']) {
    assert.equal(fs.existsSync(batchFileOf(root, 'sess-cpa', id)), false, '层错配拒建批：' + id + ' 无批次 JSON 落盘');
  }
});

test('T8 execute：roles 词条非法 → 告警（GATE_ROLE_INVALID warning + gate.role_invalid 事件），批次照建', async () => {
  const { root, byName } = makeHarness();
  const out = await byName.wave_plan.execute({ batchId: 'cpa-t8', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: 'a1', roles: ['coder', 'bogus-role'] } }, SESS);
  assert.ok(out.lanes.a1 === 'pending', '批次照建');
  assert.ok(out.warnings.some((w) => w.code === 'GATE_ROLE_INVALID' && /bogus-role/.test(w.message)), 'roles 告警并入返回 warnings');
  const raw = JSON.parse(fs.readFileSync(batchFileOf(root, 'sess-cpa', 'cpa-t8'), 'utf8'));
  assert.ok(raw.events.some((e) => e.type === 'gate.role_invalid'), 'gate.role_invalid 事件留痕（复用既有通道）');
  assert.deepEqual(raw.assembly.roles, ['coder'], '非法词条不落盘，合法保留');
});

// ── T9 schema DSL 合规（宿主注册等价：defineTool/DSL 编译同一条路径）──

test('T9 DSL：§3.2 合规形态编译通过，required 正确收集为 ["managerPlan","auditLane"]', () => {
  const js = valueSchemaSpecToJsonSchema(ASSEMBLY_VALUE_SCHEMA);
  assert.deepEqual(js.required, ['managerPlan', 'auditLane']);
  // 根参数对象为隐式开放 ParameterSchemaSpec：新增顶层 assembly 键编译通过
  const pjs = parameterSchemaSpecToJsonSchema({ batchId: { type: 'string', required: true }, assembly: ASSEMBLY_VALUE_SCHEMA });
  assert.ok(pjs.properties.assembly, 'parameters 顶层含 assembly 键');
});

test('T9 DSL：5 类违规写法全部拒绝（报错分支即约束文档，摸底 §5.1）', () => {
  const bad = {
    missingAdditional: { type: 'object', properties: { managerPlan: { type: 'string', required: true } } },
    topRequiredArray: { type: 'object', additionalProperties: false, required: ['managerPlan'], properties: { managerPlan: { type: 'string', required: true } } },
    typeArray: { type: ['string', 'number'] },
    typePlusOneOf: { type: 'string', oneOf: [{ type: 'string' }, { type: 'number' }] },
    emptyEnum: { type: 'string', enum: [] },
  };
  const expected = {
    missingAdditional: /schema\.additionalProperties must be explicitly true or false/,
    topRequiredArray: /schema\.required is not supported by the value schema DSL/,
    typeArray: /schema\.type must be string\/number\/integer\/boolean\/null\/array\/object\/json, or use oneOf/,
    typePlusOneOf: /schema cannot declare both type and oneOf/,
    emptyEnum: /schema\.enum must be a non-empty array of .* values/,
  };
  for (const [k, shape] of Object.entries(bad)) {
    assert.throws(() => valueSchemaSpecToJsonSchema(shape), expected[k], k + ' 必须拒绝');
  }
});

// ── T10 validateWavePlan：doc 形态不变（assembly 不入 doc）──

test('T10 validateWavePlan：带 assembly 声明建批的 plan 仍通过（assembly 不入 doc、不入 validateWavePlan 视野）', () => {
  const plan = buildWavePlan({ batchId: 'cpa-t10', tasks: cplusTasks(3) });
  assert.equal(validateWavePlan(plan), true);
  assert.equal('assembly' in plan, false, 'assembly 是批次级非 doc 级字段（经 createBatch 独立持久化）');
});

// ── 既有导出零破坏（spec §5 禁改面锚点）──

test('既有导出签名零破坏：buildWavePlan/validateWavePlan/MANAGER_PLANS 常量', () => {
  assert.deepEqual(MANAGER_PLANS, ['raise', 'leader-direct']);
  const plan = buildWavePlan({ batchId: 'cpa-z', tasks: [{ id: 'a' }] });
  assert.equal(validateWavePlan(plan), true);
  assert.equal(plan.schema, 1);
});
