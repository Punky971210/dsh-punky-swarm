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

// @ts-check

// 派发面 · 任务包组装：`composeWorkerPrompt` 及其角色指引段落。

import fs from 'node:fs';
import { SUITE_DENY_TOOLS } from './suite.js';
import { applyInjectionBudget } from '../comms/inject-budget.js';
import { resumeClauseFor } from '../wave-plan.js';
import { ROLE_SECTION_TITLES, roleCorpusRoot, resolveRoleRef, listOf } from './dispatch-role.js';
import { labelOf } from './dispatch-bind.js';
import { renderCheckpointsBlock, renderPreflightBlock, CP_SUPERSEDED_LINE } from './dispatch-preflight.js';
import { renderArchContext } from './arch-context.js';
import { dialectOfLane } from '../state/resume.js';

/**
 * 任务包入参**单点组装**（批 `punky-taskpack-cohesion-20261113`）。
 *
 * 为什么要有它：`composeWorkerPrompt` 的入参有 14 项来自 lane 黑板（cmd/layer/契约/产物/
 * checkpoints/subtasks/context/preflight/targets/resume/…），原先由**两个生产入口各自手抄一遍**：
 *   · 入口 A = `lib/engine/dispatch-core.js`（引擎自派）
 *   · 入口 B = `lib/tools/query-tools.js` 的 `taskpack_for`（人工取件）
 * 手抄面已经三次翻车（`team` 误绑定、`subtasks` 漏传、`checkpointDialect` 漏传），每次都会让
 * 「同一 lane 两档任务包不一致」。本函数把「lane 黑板 → composeWorkerPrompt 入参」的映射收敛成
 * **唯一一份**，两个入口只负责传**入口特有**的四项（firstLine / leaderPrompt / artifactsRoot /
 * injectBudget）与已解析的 role。
 *
 * 方言仍走单点：`dialectOfLane(batch, lane)`（与 G1/G2 门同源）；`batch` 缺省为 null 时回落
 * `null`（`composeWorkerPrompt` 内既有兼容三元兜底，仅供单测/直调老调用方）。
 *
 * @param {object} input
 * @param {string} input.batchId
 * @param {string} input.lane
 * @param {object|null} [input.laneTask] 该 lane 的 wavePlan task（黑板真源）
 * @param {object|null} [input.batch]    已读批次（方言判决用；禁为方言再读一次批文件）
 * @param {string|null} [input.sessionId] 批归属会话（渲染「批归属会话」行）
 * @param {object|null} [input.roleData] 已解析的 role（入口自行解析，两档解析口径各自负责）
 * @param {string|null} [input.role]     未解析时的 role 引用（直调老调用方）
 * @param {string|undefined} [input.firstLine] 自派档的首行（取件档为 undefined）
 * @param {string} [input.leaderPrompt]
 * @param {string|undefined} [input.artifactsRoot]
 * @param {object|null} [input.injectBudget]
 * @param {object|null} [input.logger]
 * @returns {object} 可直接展开进 `composeWorkerPrompt(...)` 的入参对象
 */
export function taskpackInputOf({
  batchId, lane, laneTask = null, batch = null, sessionId = null,
  roleData = null, role = null,
  firstLine = undefined, leaderPrompt = '', artifactsRoot = undefined,
  injectBudget = null, logger = null,
} = {}) {
  const t = laneTask ?? {};
  return {
    batchId, lane,
    cmd: t.cmd,
    layer: t.layer,
    role: roleData ?? role,
    consume: t.consume ?? [],
    produce: t.produce ?? [],
    outputs: t.outputs ?? [],
    firstLine,
    leaderPrompt,
    artifactsRoot,
    batchSessionId: sessionId,
    singleArtifactWrite: t.singleArtifactWrite === true,
    injectBudget,
    archContext: renderArchContext({ targets: t.targets ?? null }),
    preflight: t.preflight ?? null,
    context: t.context ?? null,
    checkpoints: t.checkpoints ?? null,
    subtasks: t.subtasks ?? null,
    //   方言：与门（G1/G2）同一份判决函数；batch 缺省 ⇒ null ⇒ composeWorkerPrompt 内兼容三元兜底。
    checkpointDialect: batch ? dialectOfLane(batch, lane) : null,
    resume: t.resume === true,
    logger,
  };
}

export function renderRoleGuide(roleData) {
  const L = [];
  L.push(ROLE_SECTION_TITLES.responsibilities);
  const personaText = typeof roleData?.persona_text === 'string' ? roleData.persona_text.trim() : '';
  if (personaText) L.push('- **角色定位**：' + personaText);
  const mission = typeof roleData?.mission === 'string' ? roleData.mission.trim() : '';
  if (mission) L.push('- **使命**：' + mission);
  for (const r of listOf(roleData?.responsibilities)) L.push('- ' + r);
  L.push('');
  L.push(ROLE_SECTION_TITLES.authorities);
  const authorities = listOf(roleData?.authorities);
  if (authorities.length) for (const a of authorities) L.push('- ' + a);
  else L.push('- （role 未声明）');
  L.push('');
  L.push(ROLE_SECTION_TITLES.deliverables);
  const deliverables = listOf(roleData?.deliverables);
  for (const d of deliverables) {
    const form = (typeof d === 'string') ? d.trim() : String(d?.form ?? '').trim();
    const must = (d && typeof d === 'object' && Array.isArray(d.must_contain)) ? d.must_contain : [];
    L.push('- 交付件：' + (form || '（形态未声明）'));
    if (must.length) L.push('  - 必含结构：' + must.map((x) => '`' + x + '`').join(' / '));
  }
  const skills = listOf(roleData?.skills);
  if (skills.length) L.push('- 规格：见技能 ' + skills.map((s) => '`' + s + '`').join(' / '));
  const hints = listOf(roleData?.acceptance_hints);
  if (!deliverables.length && !skills.length && !hints.length) L.push('- （role 未声明）');
  for (const h of hints) L.push('- 达标提示：' + h);
  return L.join('\n');
}

function appendRoleSections(L, roleData) {
  L.push('');
  L.push(...renderRoleGuide(roleData).split('\n'));
}

function roleCellOf(roleRef, roleData) {
  const bare = (typeof roleRef === 'string' && roleRef.trim())
    ? roleRef.trim()
    : String(roleData?.id ?? roleData?.title ?? '-');
  return roleData?.title ? '`' + bare + '`（' + roleData.title + '）' : '`' + bare + '`';
}

export function memberDispatchBudgetKeyOf(injectBudget) {
  return injectBudget?.enabled === false ? { budgetEnabled: false } : {};
}

export function composeWorkerPrompt({
  batchId, lane, cmd, layer, role, consume = [], produce = [], outputs = [], firstLine, leaderPrompt = '', artifactsRoot,
  batchSessionId,
  singleArtifactWrite = false,
  roleRoot, roleTeam,
  checkpoints = null,
  // 【批 `punky-checkpoint-enforce-20261112` · lane e1-schema】`subtasks`（checkpoint 强制面）。
  //   ⚠ 两处调用方（`dispatch-core.js` 自派档 / `query-tools.js` 取件档）**各只透传本参数一行**，
  //     方言回落与「subtasks 优先」判据**只在本函数决定一次**（spec §R-4「单侧决定」）——
  //     否则同一 lane 在两档的任务包会不一致（V-13）。
  subtasks = null,
  // 【批 `punky-ckpt-followup-20261112` · lane e1-impl · s1】lane 级方言（由两个生产入口各自
  //   用**已读到的** batch 调 `dialectOfLane(batch, lane)` 算好传入）。本函数**不再自判方言**：
  //   判据只剩 `lib/state/resume.js` 一份（门与渲染同源，G-04 分叉收口）。
  //   缺省 `null` 仅为**单测/直调老调用方**（`lib/engine/dispatch.js` 对外导出本函数）零破坏；
  //   生产两入口必须显式传值（`test/dispatch-prompt-compose` 与 V-4 的四行锁）。
  checkpointDialect = null,
  context = null,
  resume = false,
  injectBudget = null,
  archContext = null,
  preflight = null,
  logger = null,
}) {
  const roleData = resolveRoleRef(role, { root: roleRoot ?? roleCorpusRoot(), team: roleTeam });
  const budgeted = injectBudget?.enabled === true;
  const cmdBudget = budgeted
    ? applyInjectionBudget(String(cmd ?? '（未声明 cmd）'), { surface: 'taskpack.cmd', thresholds: injectBudget, kind: 'perItem' }).text
    : cmd;
  const leaderPromptBudget = budgeted
    ? applyInjectionBudget(leaderPrompt, { surface: 'taskpack.leaderPrompt', thresholds: injectBudget, kind: 'perItem' }).text
    : leaderPrompt;
  const archContextBudget = budgeted && typeof archContext === 'string' && archContext.length > 0
    ? applyInjectionBudget(archContext, { surface: 'taskpack.archContext', thresholds: injectBudget, kind: 'perItem' }).text
    : archContext;
  const L = [];
  L.push(firstLine);
  L.push('');
  L.push('# 任务包（引擎自派 · ' + labelOf(batchId, lane) + '）');
  L.push('- **lane**：`' + lane + '`｜**层**：`' + (layer ?? '-') + '`｜**角色**：' + roleCellOf(role, roleData));
  L.push('- **目标**：' + String(cmdBudget ?? '（未声明 cmd）'));
  if (consume.length) L.push('- **消费件**：' + consume.map((p) => '`' + p + '`').join('、'));
  if (produce.length) L.push('- **产出面**：' + produce.map((p) => '`' + p + '`').join('、'));
  if (outputs.length) L.push('- **产物**：' + outputs.map((p) => '`' + p + '`').join('、'));
  if (artifactsRoot) L.push('- **批次产物根**：`' + artifactsRoot + '`（产物落此处，勿落工作区根）');
  if (typeof batchSessionId === 'string' && batchSessionId.length > 0) {
    L.push('- **批归属会话**：`' + batchSessionId + '`——**调用治理工具（`lane_checkpoint` / `handoff_submit` / `mailbox_*` / '
      + '`member_settle` / `asset_claim` / `log_export` 等）时必须显式传 `session:"' + batchSessionId + '"`**；'
      + '省略时引擎按 worker 绑定自动归属（重启重建窗口内可能解析不到 ⇒ 显式传参是唯一可靠路径）。');
  }
  if (roleData) appendRoleSections(L, roleData);
  if (typeof archContextBudget === 'string' && archContextBudget.length > 0) {
    L.push('');
    L.push(archContextBudget);
  }
  const contextBudget = budgeted && typeof context === 'string' && context.length > 0
    ? applyInjectionBudget(context, { surface: 'taskpack.context', thresholds: injectBudget, kind: 'perItem' }).text
    : context;
  if (typeof contextBudget === 'string' && contextBudget.length > 0) {
    L.push('');
    L.push('## 项目上下文');
    L.push(contextBudget);
  }
  let preflightBlock;
  try {
    preflightBlock = renderPreflightBlock(preflight, { injectBudget });
  } catch (e) {
    try {
      logger?.warn?.('[dsh-punky-swarm] composeWorkerPrompt: 开工前必做段渲染失败 ⇒ 降级为警示行（不阻断派发）：'
        + String(e?.message ?? e));
    } catch {  }
    preflightBlock = renderPreflightBlock(null, { injectBudget });
  }
  let checkpointsBlock = '';
  try {
    //   方言取源**单侧决定**：入参 `checkpointDialect` 由 `taskpackInputOf` 用 `dialectOfLane(batch, lane)`
    //   算好传入（与 G1/G2 门同一实现）；本文件**不自判方言**。
    //   ⚠ 右侧三元 `(subtasks != null ? 'subtasks' : 'legacy')` 是**兼容兜底**：只在调用方不传
    //   `checkpointDialect`（单测直调 / 老调用方）时命中。两个生产入口经 `taskpackInputOf` 后
    //   **恒传显式值** ⇒ 该分支在活体路径上不可达；删除会破坏直调方零兜底，故保留并在此标注。
    //   渲染源同时决定：有 `subtasks` 就用它，否则回退既有 `checkpoints`（spec §R-3 / §R-4）。
    const dialect = checkpointDialect ?? (subtasks != null ? 'subtasks' : 'legacy');
    checkpointsBlock = renderCheckpointsBlock(subtasks ?? checkpoints, { layer, dialect });
    //   双声明（同 lane 同时声明两者）⇒ 渲染块**首行**注明 checkspoints 已被取代（spec §4.2 第 3 行）。
    //   只有本层同时看得到两份声明面，故取代说明落在这里、而不是渲染函数里。
    if (checkpointsBlock && subtasks != null && checkpoints != null) {
      checkpointsBlock = CP_SUPERSEDED_LINE + '\n' + checkpointsBlock;
    }
  } catch (e) {
    try {
      logger?.warn?.('[dsh-punky-swarm] composeWorkerPrompt: checkpoint 计划段渲染失败 ⇒ 跳过该段（不阻断派发）：'
        + String(e?.message ?? e));
    } catch {  }
    checkpointsBlock = '';
  }
  if (checkpointsBlock) {
    L.push('');
    L.push(...String(checkpointsBlock).split('\n'));
  }
  const resumeClause = resumeClauseFor({ resume });
  if (resumeClause) {
    L.push('');
    L.push(resumeClause);
  }
  L.push('');
  L.push(...String(preflightBlock).split('\n'));
  L.push('');
  L.push('## 纪律');
  const roleAllowFace = listOf(roleData?.tools?.allow)
    .filter((x) => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
  if (roleAllowFace.length > 0) {
    // 【R-11 · 2026-11-10】原文案把 `tools.allow`（**意图声明**）渲染成**可执行约束**（逐字旧文案见判据源 §P-1）——
    //   那是**假声明**：`tools.allow` 不产生任何技术限制，成员实际可见工具 = preset 组合面产出 − deny 单据。
    //   三个害处：① 假声明；② 诱使成员放弃实机自证（本批 7 条 lane 全部据此不查库）；③ 与下方纪律 3
    //   「断言『没有某工具/技能』前先实机核」自相矛盾。⇒ 改口径为「意图声明（**非**可见面保证）」+ 实机自证指引。
    L.push('本 lane 角色的**工具面意图声明**（role frontmatter `tools.allow`）：'
      + roleAllowFace.map((t) => '`' + t + '`').join(' / ') + '。');
    L.push('⚠ 这**不是**实际可见面的保证 —— 实际可见工具 = **preset 组合面产出 − deny 单据**'
      + '（`SUITE_DENY_TOOLS` ∪ `config.dispatch.denyTools`）。'
      + '**判断某工具在不在，禁凭本行断言：须按名直调看回执，或按协议面读工具目录实机自证。**');
    // 【⑤-1 · 裁决乙 2026-11-09】原文案写「已由引擎在 preset 面技术禁用」，对 `activation` 形态是**假声明**：
    //   该形态不承载 toolFilter（`provider-dsh/agent.js` 的 startActivation 分支只注入 agentPreset），
    //   引擎**不校验 preset 内容是否真的排除了这些工具**，只核「可解析且可核收窄」，不可核即拒派。
    //   ⇒ 按两形态分别如实陈述；真正补端口（让 activation 也承载 toolFilter）已登记为宿主需求，不在本批。
    L.push('（治理类工具 ' + SUITE_DENY_TOOLS.length + ' 件：`start` 形态由引擎注入 toolFilter **技术禁用**；'
      + '`activation` 形态改由 `agentPreset` 承载 —— 引擎只核 preset 可解析且可核收窄，'
      + '**不校验其内容是否真的排除了这些工具**，不可核即拒派（不以弱换强）。'
      + '其余角色边界靠本条约束 —— 引擎不为角色面提供技术沙箱。）');
  }
  let ruleNo = 0;
  const rule = (text) => { ruleNo += 1; L.push(ruleNo + '. ' + text); };
  rule('写盘只用 `edit`/`write`；临时件用 `node -e` 的 `fs`；UTF-8 无 BOM、LF。');
  rule('禁 `git` 写；禁重启宿主；只碰本 lane 文件域。');
  rule('断言「没有某工具/技能」前先实机核：`grep`/`glob` 扫宿主安装面与引擎源码，或按名直调看回执（折叠 ≠ 禁用），勿凭印象断言「没有」。');
  rule('完成/失败均**显式回报**（不给静默降级）；回报只给元数据与结论，不复制正文。');
  rule('**【交接】完成时必须 `handoff_submit` 向【本 lane 的全部出边】交接**（含**聚合 audit lane**）——');
  L.push('   若本批含 audit 层而本 lane 是 plan/exec 层，则该边**必须交**；漏交会被 `GATE_HANDOFF_MISSING` 拒（**仅当 `gates.handoff.entry` 开启（runtime `gates.handoff.*` 或 env `PSWARM_HANDOFF_GATE`）时拦截**），');
  L.push('   批会被停轮。对 `a1-*` 这类**聚合 audit lane**（有多个入边），**每条上游线都要各自交一次**。');
  if (layer === 'plan') {
    rule('**【plan 产物】正文必须含六个【裸标题】**（行首恰为该串，非 `###`、无缩进/前缀）：');
    L.push('   `## 概述` / `## 问题` / `## 方案` / `## 需求` / `## 验收标准` / `## 约束`；');
    L.push('   **内容允许为空，标题一个都不能缺** —— 缺任一即被 `GATE_PLAN_CONTRACT` 拒（内容不校，只校标题）。');
  }
  rule('**【回报编号口径】**本 lane 的**验收项**编号以**判据源中承载 exec 验收项的那一章**为准（**章号与编号形态随判据源自定**：如 `§6` + `L-AC-1..N`，或 `V-1..V-28`）；');
  L.push('   判据源 `## 验收标准` 章内的自检项编号属于**规格自检**，**不是**本 lane 的验收项。');
  L.push('   回报引用验收项时：**照抄该章的编号 + 原文**（禁自行重排、禁把自检项编号当作验收项回填）。');
  const writeTargets = [...new Set([...produce, ...outputs].filter((p) => typeof p === 'string' && p.trim().length > 0))];
  const singleArtifactWriteLane = singleArtifactWrite === true || (layer === 'audit' && writeTargets.length === 1);
  if (singleArtifactWriteLane) {
    rule('**【progress 快照 · 本 lane = 单件写盘 lane】**写盘约束 = **只写声明的这一件产物**；');
    L.push('   ⇒ 本任务包**自动抑制**「每完成一子步骤即落 progress 快照」一行（该纪律与本 lane 的**单件写盘约束直接冲突**，'
      + '两条打架时**以更严者为准** = 单件约束）；');
    L.push('   子步骤记录写进**该件产物正文**或**汇报**里，**不得**另开进度快照文件（多写一件即越界）。');
  } else {
    rule('**【progress 快照】**每完成一个子步骤即落 `<lane>/progress/NN-<slug>.md`（禁攒批；崩溃后新 worker 据此跳过已完成步骤）。');
  }
  if (leaderPromptBudget) {
    L.push('');
    L.push('## 任务要点（Leader 补充）');
    L.push(leaderPromptBudget);
  }
  const composed = L.join('\n');
  if (!budgeted) return composed;
  return applyInjectionBudget(composed, { surface: 'taskpack.total', thresholds: injectBudget, kind: 'total' }).text;
}
