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

// 盲审编排装配数据测试（决策包 punky-assembly §5.4 验收标准 A3.1-A3.7）
// 覆盖：三角色映射 / 六模板契约 / applyAssemblyExtensions 开关语义 / buildAuditLaneSpec DAG 契约 / 叠加顺序条款 / 默认关零破坏
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLIND_REVIEW_ROLES, BLIND_REVIEW_SKILLS, BLIND_REVIEW_TEMPLATES, BLIND_REVIEW_ORDER,
  applyAssemblyExtensions, buildAuditLaneSpec,
} from '../lib/assembly/audit-blind-review.js';
import { buildWavePlan } from '../lib/wave-plan.js';

// fixture skillCatalog：断言"skill 名可解析"用（生产调用方传 ~/.agents/skills 存在性解析器）
const SKILL_CATALOG = new Set(['report-blind-audit', 'code-review-guideline']);
const hasSkill = (name) => SKILL_CATALOG.has(name);

// fixture 装配：形状对齐 lib/assembly.js DEFAULT_ASSEMBLY（audit 层 3 角色）
const BASE_ASSEMBLY = {
  team: 'jiufeng',
  layers: {
    plan: { roles: ['coordinator'], skills: { coordinator: ['dev-planner'] } },
    exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } },
    audit: { roles: ['reviewer', 'supervisor'], skills: { reviewer: ['code-review-guideline'], supervisor: ['report-blind-audit'] } },
  },
};

test('A3.1 三角色映射非空且 skill 名可解析', () => {
  assert.equal(BLIND_REVIEW_ROLES.length, 3);
  for (const role of BLIND_REVIEW_ROLES) {
    const skills = BLIND_REVIEW_SKILLS[role];
    assert.ok(Array.isArray(skills) && skills.length > 0, role + ' skills 非空');
    assert.ok(skills.every(hasSkill), role + ' 所有 skill 可解析');
  }
  // 三角色全部落在 audit 层（盲审是 audit 子 lane）
  const expected = new Set(['audit-panelist', 'audit-aggregate', 'audit-critic']);
  assert.deepEqual(new Set(BLIND_REVIEW_ROLES), expected);
});

test('A3.2 六模板键齐备且含全部契约条款', () => {
  assert.deepEqual(Object.keys(BLIND_REVIEW_TEMPLATES).sort(), ['aggregate', 'bundle', 'checklist', 'config', 'critic', 'panelist']);
  const b = BLIND_REVIEW_TEMPLATES.bundle;
  assert.ok(b.includes('事实摘录'), 'bundle 事实摘录段');
  assert.ok(b.includes('file:line'), 'bundle 每条标出处');
  assert.ok(b.includes('禁评价词'), 'bundle 禁评价词（M6 防污染）');
  assert.ok(b.includes('锚定对照'), 'bundle 锚定对照前置');
  const p = BLIND_REVIEW_TEMPLATES.panelist;
  assert.ok(p.includes('rubric'), 'panelist rubric 逐维度');
  assert.ok(p.includes('互不可见'), 'panelist 隔离盲审');
  assert.ok(p.includes('DEGRADED'), 'panelist 失败重试 ≤3 → DEGRADED');
  assert.ok(p.includes('锚定对照'), 'panelist 锚定对照声明必填');
  const a = BLIND_REVIEW_TEMPLATES.aggregate;
  assert.ok(a.includes('锚定一致性'), 'aggregate 阶段 1 锚定一致性');
  for (const frag of ['Δ=0', 'Δ=1', 'Δ=2', 'Δ≥3', '升级人工']) assert.ok(a.includes(frag), 'aggregate Δ 分级含 ' + frag);
  assert.ok(a.includes('加权总分'), 'aggregate 加权总分手算验证');
  const c = BLIND_REVIEW_TEMPLATES.critic;
  for (const frag of ['endorse', 'challenge', 'block', '独立 session']) assert.ok(c.includes(frag), 'critic 三态含 ' + frag);
  assert.ok(c.includes('不允许跳过'), 'critic block 不允许跳过');
  const cl = BLIND_REVIEW_TEMPLATES.checklist;
  assert.ok(cl.includes('阻塞') && cl.includes('非阻塞'), 'checklist 阻塞/非阻塞分级');
  const cfg = BLIND_REVIEW_TEMPLATES.config;
  assert.equal(cfg.panelistCount, 2, 'config panelistCount 默认 2');
  assert.equal(typeof cfg.threshold, 'number', 'config threshold');
  assert.equal(cfg.criticRequired, true, 'config criticRequired 默认 true');
});

test('A3.3 applyAssemblyExtensions：关 → 原样返回（零变化）；开 → 三角色合并且 base 不变', () => {
  // 关（缺省 / enabled:false）：同一引用返回
  assert.equal(applyAssemblyExtensions(BASE_ASSEMBLY), BASE_ASSEMBLY, '缺省 extensions → 原样');
  assert.equal(applyAssemblyExtensions(BASE_ASSEMBLY, {}), BASE_ASSEMBLY, '空 extensions → 原样');
  assert.equal(applyAssemblyExtensions(BASE_ASSEMBLY, { blindReview: { enabled: false } }), BASE_ASSEMBLY, 'enabled:false → 原样');
  // 开：三角色合入 audit.roles + skills，base 一字不变
  const merged = applyAssemblyExtensions(BASE_ASSEMBLY, { blindReview: { enabled: true } });
  assert.notEqual(merged, BASE_ASSEMBLY, '开 → 新对象');
  assert.deepEqual(BASE_ASSEMBLY, {
    team: 'jiufeng',
    layers: {
      plan: { roles: ['coordinator'], skills: { coordinator: ['dev-planner'] } },
      exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } },
      audit: { roles: ['reviewer', 'supervisor'], skills: { reviewer: ['code-review-guideline'], supervisor: ['report-blind-audit'] } },
    },
  }, 'base 装配一字不改（零破坏）');
  for (const role of BLIND_REVIEW_ROLES) {
    assert.ok(merged.layers.audit.roles.includes(role), role + ' 入 audit.roles');
    assert.deepEqual(merged.layers.audit.skills[role], BLIND_REVIEW_SKILLS[role], role + ' skills 映射');
  }
  assert.equal(merged.layers.audit.roles.length, 2 + 3, 'audit roles = 原 2 + 新增 3');
  assert.deepEqual(merged.layers.plan, BASE_ASSEMBLY.layers.plan, '非 audit 层不变');
});

test('A3.4 buildAuditLaneSpec：DAG 契约（aggregate deps=全部 panelist、critic deps=aggregate）经 buildWavePlan 通过', () => {
  const deps = ['exec/artifact.md', 'audit/verify-verdict.md'];
  const spec = buildAuditLaneSpec({ panelistCount: 2, deps });
  assert.equal(spec.tasks.length, 4, 'panelist×2 + aggregate + critic');
  assert.equal(spec.config.panelistCount, 2);
  assert.deepEqual(spec.config.threshold, BLIND_REVIEW_TEMPLATES.config.threshold);
  assert.equal(spec.config.criticRequired, true);
  // DAG 契约
  const byId = new Map(spec.tasks.map((t) => [t.id, t]));
  assert.deepEqual(byId.get('audit-aggregate').deps, ['audit-panelist-1', 'audit-panelist-2'], 'aggregate deps=全部 panelist');
  assert.deepEqual(byId.get('audit-critic').deps, ['audit-aggregate'], 'critic deps=aggregate');
  assert.deepEqual(byId.get('audit-panelist-1').deps, [], 'panelist 无内部依赖');
  // consume/produce 契约：aggregate 消费全部 panelist 产物；critic 消费聚合产物
  assert.ok(byId.get('audit-aggregate').consume.includes('audit/panelist-1.md') && byId.get('audit-aggregate').consume.includes('audit/panelist-2.md'));
  assert.ok(byId.get('audit-critic').consume.includes('audit/aggregate.md'));
  for (const t of spec.tasks) assert.ok(t.consume.includes('exec/artifact.md'), t.id + ' 消费外部产物');
  // 喂 buildWavePlan（三层契约静态校验 + 装配 skill 补全）——全链路可用
  const plan = buildWavePlan({
    batchId: 'blind-review-dag',
    tasks: spec.tasks,
    team: 'jiufeng',
    assembly: applyAssemblyExtensions(BASE_ASSEMBLY, { blindReview: { enabled: true } }),
  });
  assert.equal(plan.wavePlan.length, 3, 'panelists wave1 → aggregate wave2 → critic wave3');
  const wave1 = new Set(plan.wavePlan[0].tasks.map((t) => t.id));
  assert.deepEqual(wave1, new Set(['audit-panelist-1', 'audit-panelist-2']));
  assert.equal(plan.wavePlan[1].tasks[0].id, 'audit-aggregate');
  assert.equal(plan.wavePlan[2].tasks[0].id, 'audit-critic');
  // 装配补全生效：未显式声明 skills 的任务按角色注入手册前缀
  const panelistTask = plan.wavePlan[0].tasks.find((t) => t.id === 'audit-panelist-1');
  assert.deepEqual(panelistTask.skills, ['report-blind-audit', 'code-review-guideline'], '角色 skills 经装配补全');
  assert.equal(panelistTask.role, 'audit-panelist');
});

test('A3.5 叠加顺序 D-A7：文档化 + 模板文本含顺序条款（verify 先行 / blocked 升级人工 / needHuman 落 aggregate）', () => {
  assert.equal(BLIND_REVIEW_ORDER.steps.length, 3, '三步叠加顺序');
  assert.ok(BLIND_REVIEW_ORDER.steps[0].includes('verify'), '第 1 步 verify 自动证据');
  assert.ok(BLIND_REVIEW_ORDER.steps[2].includes('needHuman'), '第 3 步 needHuman 人工闸');
  assert.ok(BLIND_REVIEW_ORDER.verifyBlocked.includes('不进入盲审'), 'verify blocked 不进入盲审');
  assert.ok(BLIND_REVIEW_ORDER.needHumanOwner.includes('聚合结论'), 'needHuman 裁决对象=聚合结论');
  // 模板文本含顺序条款
  assert.ok(BLIND_REVIEW_TEMPLATES.bundle.includes('verify 自动证据先行'), 'bundle 含 verify 先行条款');
  assert.ok(BLIND_REVIEW_TEMPLATES.bundle.includes('不可信证据不做评审'), 'bundle 含 blocked 升级人工条款');
  assert.ok(BLIND_REVIEW_TEMPLATES.aggregate.includes('needHuman: true'), 'aggregate 含 needHuman 声明条款');
  assert.ok(BLIND_REVIEW_TEMPLATES.aggregate.includes('聚合结论'), 'aggregate 明确裁决对象=聚合结论');
});

test('A3.6 默认不启用：base 装配一字不变 + 装配扩展默认关', () => {
  // 缺省 extensions → applyAssemblyExtensions 恒原样返回（零变化）
  assert.equal(applyAssemblyExtensions(BASE_ASSEMBLY), BASE_ASSEMBLY);
  // 默认 config 形态（无 extensions 键）下装配不变——与 lib/assembly.js DEFAULT_ASSEMBLY 对齐检查：
  // 默认装配 audit 层只有 reviewer/supervisor/doc-manager，无盲审三角色
  const defaultAssembly = { layers: { audit: { roles: ['reviewer', 'supervisor', 'doc-manager'] } } };
  const out = applyAssemblyExtensions(defaultAssembly);
  assert.equal(out, defaultAssembly, '默认装配（无 extensions）零变化');
  assert.ok(!out.layers.audit.roles.includes('audit-panelist'), '默认装配不含盲审角色');
  // 开启后的合并副本不污染默认装配（重复调用幂等，不重复追加）
  const merged = applyAssemblyExtensions(BASE_ASSEMBLY, { blindReview: { enabled: true } });
  const merged2 = applyAssemblyExtensions(merged, { blindReview: { enabled: true } });
  assert.equal(merged2.layers.audit.roles.length, merged.layers.audit.roles.length, '重复启用幂等，不重复追加');
});

test('A3.7 buildAuditLaneSpec 参数容错：panelistCount 非法回退默认 2', () => {
  assert.equal(buildAuditLaneSpec({ panelistCount: 0 }).config.panelistCount, 2);
  assert.equal(buildAuditLaneSpec({ panelistCount: 3 }).config.panelistCount, 3);
  assert.equal(buildAuditLaneSpec({ panelistCount: 3 }).tasks.length, 5);
  assert.equal(buildAuditLaneSpec().config.panelistCount, 2, '缺省参数回退');
});
