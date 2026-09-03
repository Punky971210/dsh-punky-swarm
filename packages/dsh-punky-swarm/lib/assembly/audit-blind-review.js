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

// 盲审编排装配数据（review-workflow 借鉴）
// 纯数据 + 辅助函数，零依赖（被 assembly-schema.js 断言扩展视图引用，独立可加载）：
//   - BLIND_REVIEW_ROLES / BLIND_REVIEW_SKILLS：audit-panelist/audit-aggregate/audit-critic 三角色映射
//   - BLIND_REVIEW_TEMPLATES：六任务契约模板（bundle/panelist/aggregate/critic/checklist/config，键名固定供断言）
//   - applyAssemblyExtensions(assembly, extensions)：装配扩展合并（默认关——blindReview 未启用时原样返回，base 一字不改）
//   - buildAuditLaneSpec({panelistCount, deps})：Leader/Manager 建批用——生成盲审子 lane 任务包骨架
//     （consume/produce 契约 + 模板引用；不预写实现，0e 不越权；可直接喂 buildWavePlan 走 wavePlan 固定 DAG）
// 范围红线：零引擎改动（wave-plan.js / gates.js / store.js 等一律不碰）——盲审 = 装配数据 + 既有工具编排。

// ── 三角色映射（layer=audit，skills 手册前缀；Leader 显式声明或经 applyAssemblyExtensions 合并补全）──
export const BLIND_REVIEW_ROLES = ['audit-panelist', 'audit-aggregate', 'audit-critic'];

export const BLIND_REVIEW_SKILLS = {
  'audit-panelist': ['report-blind-audit', 'code-review-guideline'], // 事实核验 + 对抗式打分（rubric/checklist）
  'audit-aggregate': ['report-blind-audit'],                          // 锚定一致性 + Δ 分级裁决 + 加权聚合
  'audit-critic': ['report-blind-audit'],                             // 独立复核 + 三态决议（endorse/challenge/block）
};

// ── 叠加顺序（verify 自动证据 → 盲审可选 → needHuman 人工闸；verify blocked 直接升级人工不进入盲审）──
// 文档化常量：Leader/Manager 建批参照；三原则 = ① verify 内容证据底座（先跑、自动）② 盲审质量评审编排（后跑、可选）
// ③ needHuman 人工闸（最后、引擎强制 gates.js checkNeedHumanGate）。任一层的 produce 都进 Tier3 门禁（缺则拒 merged）。
export const BLIND_REVIEW_ORDER = Object.freeze({
  steps: ['verify 自动证据裁决（先：advisory 记录 / enforce 拦截；产物 audit/verify-verdict.md）',
    '盲审编排（可选：blindReview.enabled=true 时 panelist×N → aggregate → critic）',
    'needHuman 人工闸（后：引擎强制，merged 需 note 含 human:<裁决人>:<时间>:<结论> 证据）'],
  verifyBlocked: 'verify blocked（EVIDENCE_UNREADABLE/TRUNCATED）→ 直接升级人工（conflict/needHuman），不进入盲审——不可信证据不做评审',
  needHumanOwner: '盲审 lane 的 needHuman 声明落 aggregate 产物——人工闸裁决对象=聚合结论，非单 panelist',
});

// ── 六任务契约模板（键名固定，供 assertAssemblyCompleteness 扩展视图与 Leader/Manager 建批取用）──
const T_BUNDLE = `材料包准备（bundle，防评价污染 M6）：
- 事实摘录段：仅摘录 exec 产物事实，每条标注出处（file:line）；锚定对照声明前置（对照同 X 分锚定）；
- 禁评价词（好/差/优雅/低劣等主观词一律禁止——事实层与评价层分离是盲审有效性关键）；
- 材料完整性按 checklist 模板分级：阻塞缺失→中止；非阻塞→备注 + 对应维度扣分；用户确认降级为可选条款；
- 叠加顺序：先消费 verify 裁决报告（audit/verify-verdict.md）——verify 自动证据先行，盲审在其上做质量评审；
  verify blocked（EVIDENCE_UNREADABLE/TRUNCATED）→ 直接升级人工，不进入盲审（不可信证据不做评审）。`;

const T_PANELIST = `独立盲审打分（panelist）：
- 独立 subagent 互不可见（隔离盲审，各评各的）；按 rubric 逐维度评分 + 理由 + 低分修改建议；
- 锚定对照声明必填（对照同 X 分锚定——aggregate 阶段 1 依赖）；
- 失败重试 ≤3 次，仍失败标 DEGRADED（映射 skipped/低权重，不单评顶替）；
- 产物落盘 audit/panelist-<i>.md（Tier3 门禁：缺 produce 拒 merged，替代文本 checkpoint）。`;

const T_AGGREGATE = `聚合裁决（aggregate，锚定 + Δ 两阶段，M2）：
- 阶段 1 锚定一致性：各 panelist 锚定对照匹配同 X 分 → 进阶段 2；锚定分歧 → Chair 裁决（引用事实依据）；
- 阶段 2 Δ 分级：Δ=0 直接取；Δ=1 默认取低（可依理据采纳高）；Δ=2 Chair 裁决；Δ≥3 补理据重评，仍 ≥3 升级人工；
- 加权总分手算验证（Checkpoint 4）；聚合报告落盘 audit/aggregate.md；
- needHuman 声明落本产物（独立行 needHuman: true）——人工闸裁决对象=聚合结论，非单 panelist。`;

const T_CRITIC = `独立复核（critic，三态决议 M3）：
- 独立 session（不复用聚合上下文，避免偏见）；输入 bundle + 全部 panelist 评分 + 聚合报告 + rubric；
- 流程合规检查 + 逐维度理据挑战 + 跨维度一致性检查；
- 三态决议：endorse（通过→merged）/ challenge（Chair 逐条响应→conflict/重审）/ block（退回聚合，不允许跳过）；
- 产物落盘 audit/critic.md（audit produce，Tier3 缺则拒 merged）；顺序约束：critic 必须等 aggregate 完成后启动。`;

const T_CHECKLIST = `材料完整性分级（checklist，M4）：
- 阻塞项缺失 → 中止（Tier3 硬门禁为默认，引擎强制不后退到自觉）；
- 非阻塞项缺失 → 备注 + 对应维度扣分；
- 用户确认降级为可选条款（audit 层检查通过但标注降级）。`;

const T_CONFIG = {
  panelistCount: 2,     // 评委数默认 2（关键 lane 才启用、默认单审，防流程膨胀）
  threshold: 3.5,       // 评分阈值（如 rubric 均分 ≥3.5 为通过线，Leader/Manager 可按项目覆写）
  criticRequired: true, // critic 默认必跑（三态决议兜底；显式 false 可跳过，不建议）
  note: 'config 为建批默认值；Leader/Manager 经 buildAuditLaneSpec 覆写（panelistCount/threshold/criticRequired）',
};

export const BLIND_REVIEW_TEMPLATES = Object.freeze({
  bundle: T_BUNDLE,
  panelist: T_PANELIST,
  aggregate: T_AGGREGATE,
  critic: T_CRITIC,
  checklist: T_CHECKLIST,
  config: T_CONFIG,
});

// ── 装配扩展合并（extensions.blindReview 默认关）──
// blindReview.enabled !== true → 原样返回（base DEFAULT_ASSEMBLY 一字不改 → buildAgentDescriptors 输出不变，兼容）；
// enabled === true → 返回合并副本（三角色入 layers.audit.roles + skills，其他层/角色共享引用，base 不被 mutate）。
export function applyAssemblyExtensions(assembly, extensions) {
  const br = (extensions && extensions.blindReview) || (assembly && assembly.extensions && assembly.extensions.blindReview);
  if (!br || br.enabled !== true) return assembly; // 默认关：零变化
  if (!assembly || typeof assembly !== 'object' || !assembly.layers || !assembly.layers.audit) return assembly;
  const out = {
    ...assembly,
    layers: {
      ...assembly.layers,
      audit: {
        ...assembly.layers.audit,
        roles: [...(assembly.layers.audit.roles ?? [])],
        skills: { ...(assembly.layers.audit.skills ?? {}) },
      },
    },
  };
  for (const role of BLIND_REVIEW_ROLES) {
    if (!out.layers.audit.roles.includes(role)) out.layers.audit.roles.push(role);
    out.layers.audit.skills[role] = BLIND_REVIEW_SKILLS[role];
  }
  return out;
}

// ── 盲审子 lane 任务包骨架（Leader/Manager 建批用）──
// 返回 { config, templates, tasks }：tasks 可直接喂 buildWavePlan（固定 DAG：panelist×N → aggregate → critic；
// aggregate deps=全部 panelist、critic deps=aggregate）；consume/produce 契约 + 模板引用齐备，不预写实现（0e）。
// deps = 外部依赖路径数组（如 exec 产物 + audit/verify-verdict.md），作为 panelist/aggregate/critic 的共享 consume。
export function buildAuditLaneSpec({ panelistCount, deps = [], threshold, criticRequired } = {}) {
  const n = Number.isInteger(panelistCount) && panelistCount >= 1 ? panelistCount : T_CONFIG.panelistCount;
  const depList = Array.isArray(deps) ? deps : [];
  const panelists = [];
  for (let i = 1; i <= n; i++) {
    panelists.push({
      id: 'audit-panelist-' + i,
      layer: 'audit',
      role: 'audit-panelist',
      deps: [],
      consume: [...depList],
      produce: ['audit/panelist-' + i + '.md'],
      template: 'panelist',
      cmd: '盲审打分（模板 panelist）：rubric 逐维度评分 + 理由 + 低分建议 + 锚定对照声明；产物 audit/panelist-' + i + '.md',
    });
  }
  const panelistIds = panelists.map((p) => p.id);
  const panelistProduces = panelists.map((p) => p.produce[0]);
  const aggregate = {
    id: 'audit-aggregate',
    layer: 'audit',
    role: 'audit-aggregate',
    deps: [...panelistIds],
    consume: [...depList, ...panelistProduces],
    produce: ['audit/aggregate.md'],
    template: 'aggregate',
    cmd: '聚合裁决（模板 aggregate）：锚定一致性 + Δ 分级裁决 + 加权聚合 + needHuman 声明；产物 audit/aggregate.md',
  };
  const critic = {
    id: 'audit-critic',
    layer: 'audit',
    role: 'audit-critic',
    deps: ['audit-aggregate'],
    consume: [...depList, ...panelistProduces, 'audit/aggregate.md'],
    produce: ['audit/critic.md'],
    template: 'critic',
    cmd: '独立复核（模板 critic）：流程合规 + 逐维度理据挑战 + 三态决议 endorse/challenge/block；产物 audit/critic.md',
  };
  return {
    config: {
      panelistCount: n,
      threshold: threshold ?? T_CONFIG.threshold,
      criticRequired: criticRequired ?? T_CONFIG.criticRequired,
    },
    templates: BLIND_REVIEW_TEMPLATES,
    tasks: [...panelists, aggregate, critic],
  };
}
