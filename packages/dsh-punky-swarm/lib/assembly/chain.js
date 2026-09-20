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

// assembly/chain.js —— 团队资产**推进链**（`chain`）声明：解析 + 加载期静态校验 + 拓扑查询（P2）。
// ─────────────────────────────────────────────────────────────────────────────
// 定位：`chain` 把「批内环节怎么顺次推进」从 Leader 手工派发搬进**每团队一份**的声明资产
//   （`presets/<team>/team-asset.yml`，规范位 = **顶层 `chain`**）。
//   本模块只做**纯函数**（无 IO、无副作用、不写盘）：解析 / 八条静态校验 / 拓扑查询。
//   写盘（`chain.step` 事件、`paused` 相位、自动派发）在 `lib/engine/chain-runner.js`；
//   构造期拒在 `lib/tools/core.js` 的 `wave_plan`（`createBatch` 之前 ⇒ 零批次 JSON 落盘）。
//
// 声明格式（与 `presets/engine-team/team-asset.yml:60-72` 同形；**规范位 = 顶层 `chain`**）：
//   chain: {
//     version: 1,
//     steps: [ { id, layer, role, next?, join?:'all'|'any', terminal?:true } ],
//     join: { anyFailure: 'pause'|'review'|'failed' },
//     onFail: 'pause'|'review'|'failed',          // 缺省 'pause'
//     rework: { allowed: bool, max_attempts: int, escalate: 'human'|'none' },
//   }
//   （**退役子键**不在本形状内、且**声明即拒**：`needHuman` —— 见文末「退役子键」）
//
// 唯一规范位（Leader 裁决 ①，2026-09-16）：`chain` **只认顶层**。增补草案的 `flows.chain` 位
//   **不写兼容分支**（禁双真源）——显式声明 `flows.chain` 即拒（复用既有 `TEAM_ASSET_FIELD_NOT_ALLOWED`，
//   零新造码）。注：该键本就会在同一次加载里被 `flows` 的层名白名单命中（`TEAM_ASSET_LAYER_UNKNOWN`）；
//   此处独立报码是为了让「规范位」成为**机器可判**的规则，不靠读者记忆。
//
// 八条静态校验（逐条复用既有 `TEAM_ASSET_*` 码面，**零新造码**）：
//   ① 层白名单      step.layer ∈ layers 键集                        → TEAM_ASSET_LAYER_UNKNOWN
//   ② 角色悬空      step.role ∈ layers[step.layer].roles             → TEAM_ASSET_LEAD_NOT_IN_LAYERS
//   ③ 悬空 next     目标 id ∈ steps[].id                            → TEAM_ASSET_MISSING_FIELD
//   ④ 到不了的环节  自链首步沿 `next`（v2/v3 另含 `deps`/`perLane`/`pair_with`）的可达集 = 全集 → TEAM_ASSET_MISSING_FIELD
//   ⑤ 环须由 rework 承认  存在回边 ⇒ rework.allowed===true；环数 ≤ max_attempts → TEAM_ASSET_REWORK_INVALID
//   ⑥ 链尾唯一      terminal:true 恰好一步                          → TEAM_ASSET_MISSING_FIELD
//   ⑦ join:any 必带 anyFailure  任一步 join==='any' ⇒ chain.join.anyFailure 必填 → TEAM_ASSET_MISSING_FIELD
//   ⑧ 只收枚举 token  `onFail`/`anyFailure` ∈ {pause,review,failed}；`join` ∈ {all,any}；**禁表达式**
//                                                                    → TEAM_ASSET_FIELD_NOT_ALLOWED
//
// 【M1 · 步级条件边 `on` **声明面已下线**（2026-09-17 用户裁决，批 `handoff-consolidation-m0m1-20260917`）】
//   原 W1-② 条件边（`on` = 成员终态键域 `{merged,fail,skipped,conflict}`，2026-09-16）**整体撤销**：
//   `on` 由「白名单键」变「未知键」⇒ **声明即拒**（校验 ⑧ 的拒绝面，报 `TEAM_ASSET_FIELD_NOT_ALLOWED`
//   @ `chain.steps.<id>.on`，三版本同拒）。**刻意不静默失能**：「只删校验」会让声明被忽略（写了不生效，
//   比拒更糟）⇒ 本模块显式拒，不设兼容分支、不读、不消费。
//   能力去处（外部台账 · `[docs-ref] handoff §10.1`）：
//     `merged` 分支 → `next`；失败面（`fail`/`conflict`）→ 批次级策略（`chain.join.anyFailure` / `chain.onFail`，
//     M4 迁 `rework`）；`skipped` 分支 → `deps` + Leader 裁决（**不静默推进**）。
//   兼容边界（**读侧保留面，禁顺手删**）：`chainEchoOf`（本文件末）不校验 `via` ⇒ 磁盘上历史 `on` 族
//     `chain.step` 事件照常回显；`countReworkAttempts`（`lib/engine/chain-runner.js`，K2）仍按历史 `via` 计数
//     （服务历史批的跨重启幂等）；本文件 `chainNextOf` 的回边预算段（K3）同样保留 —— 口径迁移归 M4/CH-2。
//
// 「口径」（统一口径句，逐字复用，禁各写各话）：
//   `chain` = **建批期展开 + 静态校验**（资产层模板：铺 lane、注入角色/skills、八条结构校验）；
//   **运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`**（`chain.step` 仅是推进留痕，随 M5′ 退出）。
//
// 「加载期」口径（本模块与 spec 的对齐）：八条校验是**纯函数**（无 IO、无副作用），加载期语义
//   由**单一强制点**承载 = 构造期（`wave_plan`，`createBatch` 之前 ⇒ 拒后零批次 JSON 落盘）。
//   **刻意不折进 `validateTeamAsset`**：折进去会让「同一份声明」经**两条通道重复报码**（本模块八条 +
//   资产层不变量各报一次）⇒ 改为**纯校验器单点**（本模块）+ 构造期原样透出首个问题码
//   （与 P1 `assertTeamAssetReady` 同形的 fail-closed 形态）。
//   【2026-09-17 订正】原文另给的「严重级不一致」理由**已失效**：本组码里 `LEAD_NOT_IN_LAYERS` /
//   `REWORK_INVALID` 是 warning 级，旧 `validateTeamAsset` 的 `ok = problems.length === 0` 会把它们判死，
//   故当时不能折入；现两侧 `ok` 已**同口径**（`ok = !hasBlockingProblems(problems)`，见本文件 `:190-203`
//   与 `team-asset.js` 的严重级段）⇒ 剩下的分离理由**只有「单一强制点 + 不重复报码」**这一条。
//
// 缺省口径（R5 向后兼容锁）：**无 `chain` 声明 ⇒ 不做任何推进**（引擎缺省退化链 = 现行 3 层直线链
//   `plan→exec→audit`，字段映射/门禁/事件逐字不变）；无链即无推进 ⇒ 不写 `chain.step`、
//   读端（`batch_status`）也不出现回显字段。
//
// 退役子键（`RETIRED_CHAIN_KEYS`，**声明即拒**：「写了不生效」比拒更糟，与步级 `on` 的 M1 裁决同款）：
//   `chain.needHuman`（链级人工闸提示）原为「只声明不消费」的未接线子键——**零运行期读点**
//   （人工闸的真实承载面 = 层声明 `flows.audit.needhuman` + Tier3 `checkNeedHumanGate`；同批五队资产亦已删除该键）
//   ⇒ 2026-09-18 清债轮（用户裁决「清理冗余设计与死代码」）**从声明位摘除**，声明即拒
//   `TEAM_ASSET_FIELD_NOT_ALLOWED`（复用既有码，零新造）。**唯一真源**：人工闸只认 `flows.audit.needhuman`。
//   与此同口径的退役键：`state_machine` / 顶层 `rework` / `flows.*.progress_contract`（见 `team-asset.js:60-63`）。
//   注：本键**不**登记进 `UNWIRED_DECLARATIONS`（那是**顶层键**台账，`chain` 已接线）。

//   说明（契约面）：上列文档**不在本包分发面内**（`package.json` `files[]` 只登记 `docs/` 下的对外件）。
//   `[docs-ref]` 展开如下（仅改注释、零语义：7 处引用逐条与出参逐字对齐）：
//     · `w2`          = `docs/w2-assembly-spec-20260916.md`（W2 装配面规格）
//     · `chain-model` = `docs/chain-model-upgrade-spec-20260916.md`（链模型升级规格）
//     · `handoff`     = `docs/handoff-semantics-consolidation-20260917.md`（交接语义归并）
//   `[docs-ref] <名> [§锚点]` = **外部台账**（workspace docs 树，本仓撰写期落盘处；该树未纳 VCS，
//   其时效以包外引擎台账为准）指引 —— 本包内无同名文件，故不以包内相对路径书写。`[docs-ref] id` 为
//   两日式短形（仅 `CHAIN_VERSIONS` 一处保留，兼容既有引用），按上列两条查名。

import { TEAM_ASSET_CODES, severityOfProblem, hasBlockingProblems, loadTeamAsset } from './team-asset.js';
import { packageRoot } from './flows.js';

/** 声明版本白名单：**v1 = 单路径链**（既有口径，向后兼容硬锁）；**v2 = DAG 边 + 分支配对**（P4a-pre）；
 *  **v3 = 装配图**（W2，2026-09-16：`branches` 层内并行链 + `pair_with` 配对别名 + `template` 插值）。
 *  ∈/∉ 白名单 ⇒ 拒，复用 `TEAM_ASSET_BAD_TYPE`（零新造码）。设计与语义见
 *  `[docs-ref] chain-model`、`[docs-ref] w2`。
 *  ⚠ 已知耦合（W2 施工批登记）：`test/chain-v2-declaration.test.js` 的 `V2-2` 断言白名单
 *  = `[1,2]` 且 `version:3` 必拒 ⇒ 本行扩为 `[1,2,3]` 后该例必红（属规格 §5「两处修订既有行为」的
 *  下游耦合，非放宽校验；修复方式 = 该测试属主同步改 3 行断言，见 W2 回报）。 */
export const CHAIN_VERSIONS = Object.freeze([1, 2, 3]);
/** v1（既有缺省口径；`CHAIN_VERSIONS[0]` = 缺省语义版本）。 */
export const CHAIN_VERSION = 1;
/** `join` 合法枚举（步级汇合语义：all = 全 merged 才推进；any = 首个 merged 即推进）。 */
const CHAIN_JOINS = Object.freeze(['all', 'any']);
/** `onFail` / `join.anyFailure` 合法 token（**只收枚举、禁表达式**）。 */
const CHAIN_ON_FAIL_TOKENS = Object.freeze(['pause', 'review', 'failed']);
/** `chain.step` 事件的 `via` 取值全集（推进命中的分支）。**这是读端白名单**：
 *  写侧只可能产生下列三值（M1 后步级条件边下线 ⇒ 不再有 `on` 族取值）。
 *  ⚠ 历史值：`on` + 四 token（`merged` / `fail` / `skipped` / `conflict`）曾是合法取值，**磁盘上仍有**真实记录
 *  （全 dsh 家目录唯一命中 = `session-2c6891df-e453-468d-9665-da242162d40c/batches/smoke-chain-20260916.json`
 *  的 `via` 字段）⇒ **读端兼容**：`chainEchoOf` 不校验 via（原样回显）、`countReworkAttempts` 仍按历史 via 计数。
 *  写侧不再产生 ⇒ **禁把它们加回本表**（加回 = 声明面已下线却仍能写入，自相矛盾；
 *  锁见 `test/m1-on-removed.test.js` 的 M1-5 / M1-7）。 */
export const CHAIN_STEP_VIA = Object.freeze(['next', 'onFail', 'anyFailure']);

/** 已退役的**链级**子键 → 退役事由（只读台账，报码文案；见文件头「退役子键」）。
 *  `RETIRED_CHAIN_KEYS` 由本表 `Object.keys` 派生（单一来源）⇒ 新增退役键必同时补事由，不留空话。 */
const RETIRED_CHAIN_REASONS = Object.freeze({
  needHuman: '链级人工闸提示已退役（2026-09-18 清债轮）：零运行期读点（原口径「只声明不消费」）；人工闸唯一承载面 = `flows.audit.needhuman` + Tier3 `checkNeedHumanGate`（不设双真源）',
});
/** 退役链级子键清单（**声明即拒** `TEAM_ASSET_FIELD_NOT_ALLOWED`）。 */
export const RETIRED_CHAIN_KEYS = Object.freeze(Object.keys(RETIRED_CHAIN_REASONS));

/** 【2026-09-18 · Q-A=C】已退役的**链声明键**台账（**只读**：仅登记事由与去处，**不接守门**）。
 *  ⚠ 为什么不与 `RETIRED_CHAIN_KEYS` 合并、为什么**不**接守门（三点，逐条写死）：
 *    ① **容忍口径**（本批硬约束）：五队资产今日仍带 `chain` 段（`progress/02-facts.json`：五队 `chainOk=true`）
 *       且 `presets/**` 归另一会话 ⇒ 此时把 `chain` 声明判成拒态 = **立刻打断既有建批**（破容忍口径）；
 *    ② 本批是「**已接线能力的有序退役**」，不是「声明了但没接线」的新债 ⇒ **不**写进
 *       `lib/assembly/team-asset.js` 的 `UNWIRED_DECLARATIONS`（那会污染「健康态 = 空数组」的既有断言）；
 *    ③ 升级为「声明即拒」的**四条触发条件**（全满足才可开）见 `plan/retire-spec.md` §3.3：
 *       资产面清零（另一会话书面回报）/ `lib/**` 零调用 / 历史批无未终态引用 / 另一会话交接。
 *  拓扑真源指针：运行期 DAG 真源 = 批次 `wavePlan[].tasks[].deps` + `batch.handoffs`（判定单点
 *    `lib/state/gates.js` 的 `handoffRecordVerdictOf`）—— `chain` 段自此**不参与任何运行期决策**。 */
const RETIRED_CHAIN_DECLARATION_REASONS = Object.freeze({
  steps: '步表（建批期展开 + 运行期推进的声明源）：已停消费 —— 拓扑改由 `tasks[].deps` 表达，推进改由 Leader/Manager 派发',
  branches: 'v3 分支展开声明（`branches[]` ⇒ 每分支一条 lane）：已停消费 —— lane 直接在建批 `tasks[]` 里显式声明',
  pair_with: '配对别名（配对步按上游每条 lane 实例化 1:1）：已停消费 —— 1:1 配对基数改由 audit lane 的 `deps` 表达（`deps` 恰为 `[<对应 exec lane>]`）',
  join: '步级汇合策略（`all`/`any` + `anyFailure`）：已停消费 —— 汇合由显式聚合 lane 的多条 `deps` + 交接门承担，步级 Join 不再需要',
  onFail: '链级失败策略（`pause`/`review`/`failed` 枚举 token）：已停消费 —— 不属当前引擎语义（失败 lane 为终态，重做 = 重开新批）',
  rework: '回边返工策略（`allowed`/`max_attempts`）：已停消费 —— `rework` 改用 gap-list 表达（`blocking`/`followup`）',
});
/** 退役链声明键清单（**只读台账**：`Object.keys` 派生自事由表 ⇒ 新增退役键必同时补事由，不留空话）。 */
const RETIRED_CHAIN_DECLARATIONS = Object.freeze(Object.keys(RETIRED_CHAIN_DECLARATION_REASONS));

// ── 【v3 · W2 装配图】声明面常量（`[docs-ref] w2 §2.1/§3.1`）──────────────
/** 仅 `chain.version=3` 允许的步级键（v1/v2 声明即拒 `TEAM_ASSET_FIELD_NOT_ALLOWED`，V1）。 */
export const CHAIN_V3_STEP_KEYS = Object.freeze(['branches', 'pair_with', 'template']);
/** `template` 允许的插值变量（**只许出现在 v3 `template` 内、且禁表达式**，V4）。 */
const CHAIN_TEMPLATE_VARS = Object.freeze(['lane', 'branch']);
/** `flows.<layer>.guidance.inject` 白名单（**结构化小节标题枚举**，禁自由文本）。 */
export const CHAIN_GUIDANCE_INJECTS = Object.freeze(['结论', '判据', '约束', '禁止事项']);

/** 插值探测：`${lane}` → `'lane'`（模板串 → 变量名清单）。 */
const templateTokensOf = (s) => {
  const out = [];
  if (typeof s !== 'string') return out;
  for (const m of s.matchAll(/\$\{([^}]*)\}/g)) out.push(String(m[1]).trim());
  return out;
};
/** 去掉合法插值后的剩余文本（「禁表达式」判据在此之上复用 `looksLikeExpression`）。 */
const withoutTemplateTokens = (s) => (typeof s === 'string' ? s.replace(/\$\{([^}]*)\}/g, '') : '');

/** 【v3】步的分支 id 清单（未声明 `branches` ⇒ 空数组）。 */
function branchIdsOf(step) {
  return Array.isArray(step?.branches)
    ? step.branches.filter((b) => isPlainObject(b) && isNonEmptyString(b.id)).map((b) => b.id)
    : [];
}

/** 【v3】配对实例 lane id 是否命中该步 `template.id` 的 `${lane}` 模式
 *  （`audit-${lane}` ⇒ `audit-exec-coder` 命中）。非配对步 / 无 `template.id` ⇒ false。 */
function pairTemplateMatches(step, laneId) {
  if (!isNonEmptyString(laneId)) return false;
  if (!isNonEmptyString(step?.pair_with) && !isNonEmptyString(step?.perLane)) return false;
  const tpl = isPlainObject(step.template) && isNonEmptyString(step.template.id) ? step.template.id : null;
  if (!tpl || !tpl.includes('${lane}')) return false;
  const body = tpl.split('${lane}').map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)');
  return new RegExp('^' + body + '$').test(laneId);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
/** 表达式探测（check ⑧「禁表达式」）：声明面只收**裸 token/id**，不收模板/比较/逻辑运算。 */
const looksLikeExpression = (s) => /[$<>{}()\[\]!?|&]|==|!=|&&|\|\|/.test(s);

/** 步级分支边的产出口（纯函数）：仅 `next`（步级条件边已下线，M1 2026-09-17）。
 *  ⚠ 即便对象上残留已下线的键（未过校验的输入），本函数也**不再产出对应边**——拓扑面只认 `next`
 *  （`deps` / `perLane` / `pair_with` 的隐式入边在 `validateChain` 内单独收集）。 */
export function edgesOfStep(step) {
  const out = [];
  if (!isPlainObject(step)) return out;
  if (isNonEmptyString(step.next)) out.push({ from: step.id, to: step.next, via: 'next' });
  return out;
}

/**
 * 解析声明位（**只认顶层 `chain`**）：返回原始声明 + 「位置非法」问题（不做八条校验）。
 * @param asset `loadTeamAsset().asset`（`validateTeamAsset` 入参同形）
 * @returns {{chain: object|null, problems: Array<object>}}
 */
export function resolveChainOf(asset) {
  const problems = [];
  if (!isPlainObject(asset)) return { chain: null, problems };
  // 唯一规范位（Leader 裁决 ①）：`flows.chain` **不是**声明位，不解析、不合并、不留兼容分支。
  const flowsChain = isPlainObject(asset.flows) ? asset.flows.chain : null;
  if (flowsChain != null) {
    problems.push({
      code: TEAM_ASSET_CODES.FIELD_NOT_ALLOWED,
      path: 'flows.chain',
      message: '`chain` 的唯一规范位是**顶层** `chain`（`presets/<team>/team-asset.yml` 与顶层平级）；'
        + '`flows.chain` 不是声明位（禁双真源，不设兼容分支）——请把声明移到顶层。',
      severity: severityOfProblem({ code: TEAM_ASSET_CODES.FIELD_NOT_ALLOWED }),
    });
  }
  return { chain: asset.chain == null ? null : asset.chain, problems };
}

/**
 * 八条静态校验（纯函数）。
 * @param chain 顶层 `chain` 声明对象
 * @param layers `asset.layers`（`{ <layer>: { roles: [...] } }`）；非对象 ⇒ ①② 由 `validateTeamAsset`
 *   的 `layers` 必填面承担（本函数不重复报码，避免同一声明双报）
 * @returns {{ok: boolean, problems: Array<{code,path,message,severity}>}}
 *
 * `ok` 语义（**R2-3 裁决 B，2026-09-17 改语义**）：`ok = 无 blocking`（`!hasBlockingProblems(problems)`），
 *   **不再**是「零问题」。warning 级问题（severity 取自 `severityOfProblem`：本组码里
 *   `TEAM_ASSET_LEAD_NOT_IN_LAYERS` / `TEAM_ASSET_REWORK_INVALID` 落在 warning 侧）**只提示不否决**，
 *   且**逐条完整保留在 `problems` 返回值里**（不丢弃、不降级成日志）——读端自行按 severity 分流。
 *   旧语义（`problems.length === 0`）与 `team-asset.js` 的 `BLOCKING_CODES` 分档**不自洽**：
 *   它把本模块头注释已登记的两条 warning 码（`:70-73`）也判成「链不可用」。改后与
 *   `loadTeamAsset` 同口径（blocking 否决 / warning 退化），构造期强制点（`assertChainReady`）
 *   与运行期读端（`chain-runner` / `replay`）行为随之对齐。
 */
export function validateChain(chain, layers) {
  const problems = [];
  const push = (code, path, message) => problems.push({ code, path, message, severity: severityOfProblem({ code }) });

  if (!isPlainObject(chain)) {
    push(TEAM_ASSET_CODES.BAD_TYPE, 'chain', 'chain 必须是对象（未声明 ⇒ 不写本键 = 不做推进）');
    return { ok: false, problems };
  }
  if (!CHAIN_VERSIONS.includes(chain.version)) {
    push(TEAM_ASSET_CODES.BAD_TYPE, 'chain.version', `chain.version 必须是 ${CHAIN_VERSIONS.join('|')}（收到：${JSON.stringify(chain.version ?? null)}）`);
  }
  if (!Array.isArray(chain.steps) || chain.steps.length === 0) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'chain.steps', 'chain.steps 必填（非空数组）');
    return { ok: false, problems };
  }

  // 步形状 + id 唯一（后续各条校验的前提面）
  const byId = new Map();
  const order = [];
  for (let i = 0; i < chain.steps.length; i++) {
    const s = chain.steps[i];
    const at = `chain.steps[${i}]`;
    if (!isPlainObject(s)) { push(TEAM_ASSET_CODES.BAD_TYPE, at, '链步必须是对象'); continue; }
    if (!isNonEmptyString(s.id)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.id`, '步 id 必填（非空字符串）'); continue; }
    if (byId.has(s.id)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.id`, `步 id 重复：${s.id}（id 唯一）`); continue; }
    byId.set(s.id, s);
    order.push(s.id);
  }
  if (byId.size === 0) return { ok: false, problems };

  // ⑨【v2 新增 · P4a-pre 2026-09-16】分支配对 `perLane` 与显式 DAG 边 `deps`（**结构面**校验）
  //   · **仅 `version: 2` 允许声明**；v1 声明即拒（`FIELD_NOT_ALLOWED`）——「v1 语义逐字不变」是硬锁，
  //     防止老资产被新键悄悄改变拓扑。
  //   · 此处只判「形状 + 悬空 + 自指 + 重复」；**实例化与推进语义**在 `lib/engine/chain-runner.js`
  //     （本模块是纯函数面，不碰 lane/事件/相位）。两键意义见 `[docs-ref] chain-model §2.1`。
  const isV2 = chain.version === 2;
  const isV3 = chain.version === 3;
  for (const [id, s] of byId) {
    if (s.perLane !== undefined) {
      if (!isV2 && !isV3) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.perLane`,
          'perLane 仅 chain.version=2|3 允许（v1 语义逐字不变：请先升 version）');
      } else if (!isNonEmptyString(s.perLane) || !byId.has(s.perLane)) {
        push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.perLane`,
          `perLane 目标悬空：${JSON.stringify(s.perLane ?? null)} 不在 steps[].id（${order.join('/')}）`);
      } else if (s.perLane === id) {
        push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.perLane`,
          'perLane 不得指向自身（自身实例化没有可展开的上游 lane）');
      }
    }
    if (s.deps !== undefined) {
      if (!isV2 && !isV3) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.deps`,
          'deps 仅 chain.version=2|3 允许（v1 语义逐字不变：请先升 version）');
      } else if (!Array.isArray(s.deps) || s.deps.length === 0) {
        push(TEAM_ASSET_CODES.BAD_TYPE, `chain.steps.${id}.deps`,
          'deps 必须是**非空**数组（不声明 = 沿用 next/on 拓扑）');
      } else {
        const seenDep = new Set();
        for (const d of s.deps) {
          if (!isNonEmptyString(d) || !byId.has(d)) {
            push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.deps`,
              `悬空依赖：${JSON.stringify(d ?? null)} 不在 steps[].id（${order.join('/')}）`);
            continue;
          }
          if (d === id) { push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.deps`, 'deps 不得自指'); continue; }
          if (seenDep.has(d)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.deps`, `重复依赖：${d}`); continue; }
          seenDep.add(d);
        }
      }
    }
  }

  // ①② 层白名单 / 角色悬空
  const hasLayers = isPlainObject(layers);
  const layerKeys = hasLayers ? Object.keys(layers) : [];
  for (const [id, s] of byId) {
    if (!hasLayers) break; // 缺 layers ⇒ validateTeamAsset 的 layers 必填面已拒，不重复报
    if (!isNonEmptyString(s.layer) || !layerKeys.includes(s.layer)) {
      push(TEAM_ASSET_CODES.LAYER_UNKNOWN, `chain.steps.${id}.layer`,
        `未知层：${JSON.stringify(s.layer ?? null)}（允许：${layerKeys.join('/') || '（无）'}）`);
      continue; // 层未定 ⇒ 角色判据无意义，跳过（避免级联双报）
    }
    const def = layers[s.layer];
    const roles = isPlainObject(def) && Array.isArray(def.roles) ? def.roles.map((r) => String(r).trim().toLowerCase()) : [];
    if (!isNonEmptyString(s.role) || !roles.includes(String(s.role).trim().toLowerCase())) {
      push(TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS, `chain.steps.${id}.role`,
        `步角色悬空：role=${JSON.stringify(s.role ?? null)} 不在 layers.${s.layer}.roles（${roles.join('/') || '（无）'}）`);
    }
  }

  // ── 【v3 · W2 装配图】声明面校验（**仅 `version:3` 生效**；v1/v2 只判「键不允许」= 语义逐字不变）──
  //   键：`branches`（层内并行链：**分支 id 逐字 = 本批 lane id**）/ `pair_with`（`perLane` 的**可读别名**，
  //   同一校验器、同一实例化代码路径）/ `template`（该步或分支实例化 lane 的 `id`/`cmd`/`produce`
  //   模板，只许 `${lane}` / `${branch}` 插值）。
  //   码表（**零新造码**，V1–V10 见 `[docs-ref] w2 §5`）：
  //     V1 非 v3 声明三键 → FIELD_NOT_ALLOWED；V2 分支 id 空/重复/与 `steps[].id` 撞名 → MISSING_FIELD；
  //     V3 配对步 `template` 缺 `${lane}`（id/cmd/produce 任一）→ MISSING_FIELD；
  //     V4 非配对步用 `${lane}` / 未知插值 / 裸露表达式 → FIELD_NOT_ALLOWED；
  //     V5 `pair_with`+`perLane` 同声明 / 悬空 / 自指 → MISSING_FIELD；V7 分支角色悬空 → 沿用 v1 两码；
  //     V10 `terminal` 唯一 —— **分支不是步**，天然不占 `terminal` 位（下方 ⑥ 原样复用，无需新判）。
  /** `template` 单点校验（步级/分支级共用；`pairing=true` ⇒ 强制 `${lane}`）。 */
  const checkTemplate = (at, tpl, { pairing = false } = {}) => {
    if (!isPlainObject(tpl)) {
      push(TEAM_ASSET_CODES.BAD_TYPE, at, 'template 必须是对象（{ id?, cmd, produce[] }）');
      return;
    }
    if (tpl.id != null && !isNonEmptyString(tpl.id)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.id`, 'template.id 必须是非空字符串（配对步 = lane id 模板）');
    if (tpl.cmd != null && !isNonEmptyString(tpl.cmd)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.cmd`, 'template.cmd 必须是非空字符串');
    if (tpl.produce != null && (!Array.isArray(tpl.produce) || tpl.produce.length === 0 || tpl.produce.some((x) => !isNonEmptyString(x)))) {
      push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.produce`, 'template.produce 必须是非空字符串数组');
    }
    if (pairing) {
      // V3：配对步 N 条实例共用一个命令/产物名 = N 条 lane 同名撞车 ⇒ `id`/`cmd`/每个 `produce` 项都必含 `${lane}`
      if (!isNonEmptyString(tpl.id) || !templateTokensOf(tpl.id).includes('lane')) {
        push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.id`,
          '配对步必须用 `${lane}` 插值声明 lane id（如 `audit-${lane}`）——缺则 N 条实例同名撞车');
      }
      if (!isNonEmptyString(tpl.cmd)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.cmd`, '配对步必须声明 template.cmd（且含 `${lane}`）');
      if (!Array.isArray(tpl.produce) || tpl.produce.length === 0) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.produce`, '配对步必须声明 template.produce（每项含 `${lane}`）');
    }
    const fields = [];
    if (typeof tpl.id === 'string') fields.push(['id', tpl.id]);
    if (typeof tpl.cmd === 'string') fields.push(['cmd', tpl.cmd]);
    if (Array.isArray(tpl.produce)) tpl.produce.forEach((v, i) => { if (typeof v === 'string') fields.push([`produce[${i}]`, v]); });
    for (const [k, v] of fields) {
      const p = `${at}.${k}`;
      const toks = templateTokensOf(v);
      const bad = toks.filter((t) => !CHAIN_TEMPLATE_VARS.includes(t));
      if (bad.length > 0) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, p,
          `${k} 只允许 ${CHAIN_TEMPLATE_VARS.map((x) => '${' + x + '}').join('/')} 插值（收到未知变量：${bad.join(',')}）`);
      }
      if (looksLikeExpression(withoutTemplateTokens(v))) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, p,
          `${k} 禁表达式（template 内只许 ${CHAIN_TEMPLATE_VARS.map((x) => '${' + x + '}').join('/')} 插值；收到：${JSON.stringify(v)}）`);
      }
      if (pairing && k !== 'id' && !toks.includes('lane')) {
        push(TEAM_ASSET_CODES.MISSING_FIELD, p, `配对步的 ${k} 必须含 \`\${lane}\`（N 条实例同名 ⇒ 配对产物撞车）`);
      }
      if (!pairing && toks.includes('lane')) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, p,
          '`${lane}` 只允许**配对步**（`pair_with`/`perLane`）使用——非配对步没有可插值的上游 lane');
      }
    }
  };

  if (!isV3) {
    // V1：三键仅 v3 允许（v1/v2 语义逐字不变 ⇒ 显式声明即拒，不静默忽略、不兼容分支）
    for (const [id, s] of byId) {
      for (const k of CHAIN_V3_STEP_KEYS) {
        if (s[k] === undefined) continue;
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.${k}`,
          `${k} 仅 chain.version=3 允许（v1/v2 语义逐字不变：请先升 version）`);
      }
    }
  } else {
    const rolesOfLayer = (layer) => (isPlainObject(layers) && isPlainObject(layers[layer]) && Array.isArray(layers[layer].roles))
      ? layers[layer].roles.map((r) => String(r).trim().toLowerCase())
      : null;
    // V2：分支形状 + id 全链唯一（= 本批 lane id；与 `steps[].id` 同池判重）
    const branchIds = new Set();
    for (const [id, s] of byId) {
      if (s.branches === undefined) continue;
      if (!Array.isArray(s.branches) || s.branches.length === 0) {
        push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.branches`,
          'branches 必须是**非空**数组（分支 = 本批 lane；空数组 ⇒ 该步零 lane）');
        continue;
      }
      for (let i = 0; i < s.branches.length; i++) {
        const b = s.branches[i];
        const at = `chain.steps.${id}.branches[${i}]`;
        if (!isPlainObject(b)) { push(TEAM_ASSET_CODES.BAD_TYPE, at, '分支必须是对象'); continue; }
        if (!isNonEmptyString(b.id)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.id`, '分支 id 必填（分支 id 直接作为本批 lane id）'); continue; }
        if (byId.has(b.id)) {
          push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.id`, `分支 id 与链步 id 撞名：${b.id}（分支 id 须与 steps[].id 同池唯一）`);
          continue;
        }
        if (branchIds.has(b.id)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.id`, `分支 id 重复：${b.id}（= 本批 lane id，撞名 ⇒ 配对/lane 归属不可判）`); continue; }
        branchIds.add(b.id);
      }
    }
    // V7 分支角色 / 分支内 `deps` / 分支 `template`（非配对面：禁 `${lane}`）
    for (const [id, s] of byId) {
      if (!Array.isArray(s.branches) || s.branches.length === 0) continue;
      const roles = rolesOfLayer(s.layer);
      const localIds = new Set(branchIdsOf(s));
      for (let i = 0; i < s.branches.length; i++) {
        const b = s.branches[i];
        if (!isPlainObject(b)) continue;
        const at = `chain.steps.${id}.branches[${i}]`;
        if (b.role != null) {
          // 层未定 ⇒ 已由 ① 报 LAYER_UNKNOWN，此处跳过（避免级联双报）
          if (roles !== null && (!isNonEmptyString(b.role) || !roles.includes(String(b.role).trim().toLowerCase()))) {
            push(TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS, `${at}.role`,
              `分支角色悬空：role=${JSON.stringify(b.role ?? null)} 不在 layers.${s.layer}.roles（${roles.join('/') || '（无）'}）`);
          } else if (roles === null && !isNonEmptyString(b.role)) {
            push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.role`, '分支 role 必须是非空字符串（缺省 = 继承步 role）');
          }
        }
        if (b.skills != null && (!Array.isArray(b.skills) || b.skills.length === 0 || b.skills.some((x) => !isNonEmptyString(x)))) {
          push(TEAM_ASSET_CODES.SKILLS_MISMATCH, `${at}.skills`, 'branches[].skills 必须是非空字符串数组（资产级技能收窄/补充）');
        }
        if (b.deps !== undefined) {
          if (!Array.isArray(b.deps) || b.deps.length === 0) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.deps`, '分支 deps 必须是**非空**数组（同层有向：本步内分支 id）');
          else {
            const seen = new Set();
            for (const d of b.deps) {
              if (!isNonEmptyString(d) || !localIds.has(d)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.deps`, `分支 deps 悬空：${JSON.stringify(d ?? null)} 不在本步分支 id（${[...localIds].join('/') || '（无）'}）`);
              else if (d === b.id) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.deps`, '分支 deps 不得自指');
              else if (seen.has(d)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.deps`, `分支 deps 重复：${d}`);
              else seen.add(d);
            }
          }
        }
        if (b.template !== undefined) checkTemplate(`${at}.template`, b.template, { pairing: false });
      }
    }
    // V5 / V3：`pair_with`（= `perLane` 别名）与配对步 `template`
    for (const [id, s] of byId) {
      const pairingId = isNonEmptyString(s.pair_with) ? 'pair_with' : null;
      if (s.pair_with !== undefined) {
        if (s.perLane !== undefined) {
          push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.pair_with`,
            '`pair_with` 与 `perLane` 是同一语义的两个键，**禁同时声明**（不设双真源；只声明 `perLane` ⇒ 等价放行）');
        } else if (!isNonEmptyString(s.pair_with) || !byId.has(s.pair_with)) {
          push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.pair_with`,
            `pair_with 目标悬空：${JSON.stringify(s.pair_with ?? null)} 不在 steps[].id（${order.join('/')}）`);
        } else if (s.pair_with === id) {
          push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.pair_with`, 'pair_with 不得指向自身（自身实例化没有可展开的上游 lane）');
        }
      }
      if (pairingId) {
        if (s.template === undefined) {
          push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.template`, '配对步必须声明 template（`id`/`cmd`/`produce` 均含 `${lane}`）');
        } else {
          checkTemplate(`chain.steps.${id}.template`, s.template, { pairing: true });
        }
      } else if (s.template !== undefined && isNonEmptyString(s.perLane)) {
        // `perLane` 是 v2 键（v2 无 `template`）；v3 里用 `pair_with` 表达配对 —— v3 同时声明 perLane+template 时按配对步校验
        checkTemplate(`chain.steps.${id}.template`, s.template, { pairing: true });
      } else if (s.template !== undefined) {
        checkTemplate(`chain.steps.${id}.template`, s.template, { pairing: false });
      }
    }
  }

  // ③ 悬空 `next` 目标（先收集边，④⑤ 复用）
  //   M1（2026-09-17）后**本处只判 `next`**：步级条件边已下线 ⇒ 其悬空目标面随之消失
  //   （声明 `on` 命中 ⑧ 的**拒绝面**，不再进本处逐键判悬空——避免「已下线键」仍产生子键报码）。
  const edges = [];
  for (const [id, s] of byId) {
    if (isNonEmptyString(s.next) && !byId.has(s.next)) {
      push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.next`,
        `悬空目标：${s.next} 不在 steps[].id（${order.join('/')}）`);
    }
    for (const e of edgesOfStep(s)) if (byId.has(e.to) && e.to !== e.from) edges.push(e);
    // v2：显式依赖边（dep → 本步）与 `perLane` 隐式入边（上游步 → 本步）。二者**只进拓扑面**
    //   （④ 可达 / ⑤ 环检测 / 聚合顺序），**不参与** `chain.step.via` 取值（`CHAIN_STEP_VIA` 不含
    //   `deps`/`perLane` ⇒ 不会泄漏到事件载荷）。
    if (Array.isArray(s.deps)) {
      for (const d of s.deps) if (isNonEmptyString(d) && byId.has(d) && d !== id) edges.push({ from: d, to: id, via: 'deps' });
    }
    if (isNonEmptyString(s.perLane) && byId.has(s.perLane) && s.perLane !== id) {
      edges.push({ from: s.perLane, to: id, via: 'perLane' });
    }
    // v3：`pair_with` 的隐式入边（与 `perLane` 同义；`via:'pair_with'` 只进拓扑面，不在 `CHAIN_STEP_VIA` ⇒ 不泄漏到事件载荷）
    if (isNonEmptyString(s.pair_with) && byId.has(s.pair_with) && s.pair_with !== id) {
      edges.push({ from: s.pair_with, to: id, via: 'pair_with' });
    }
  }

  // ④ 到不了的环节（自链首步可达集 = 全集）
  const adj = new Map(order.map((id) => [id, []]));
  for (const e of edges) adj.get(e.from).push(e.to);
  const seen = new Set([order[0]]);
  const stack = [order[0]];
  while (stack.length) {
    for (const nx of adj.get(stack.pop()) ?? []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
  }
  const orphans = order.filter((id) => !seen.has(id));
  if (orphans.length > 0) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'chain.steps',
      `自链首步（${order[0]}）沿 next 不可达的孤儿步：${orphans.join(', ')}（可达集须 = steps[] 全集）`);
  }

  // ⑤ 环须由 rework 承认（回边计数 ≤ rework.max_attempts）
  const color = new Map(); // 0 未访问 / 1 在栈上 / 2 已完成
  let backEdges = 0;
  const dfs = (id) => {
    color.set(id, 1);
    for (const nx of adj.get(id) ?? []) {
      const c = color.get(nx) ?? 0;
      if (c === 1) backEdges++;            // 指向「在栈上」的节点 = 回边（环）
      else if (c === 0) dfs(nx);
    }
    color.set(id, 2);
  };
  for (const id of order) if ((color.get(id) ?? 0) === 0) dfs(id);
  const rw = isPlainObject(chain.rework) ? chain.rework : null;
  if (backEdges > 0) {
    if (!rw || rw.allowed !== true) {
      push(TEAM_ASSET_CODES.REWORK_INVALID, 'chain.rework',
        `链内存在 ${backEdges} 条回边（环），须由 \`rework.allowed: true\` 承认（当前：${JSON.stringify(chain.rework ?? null)}）`);
    } else if (!Number.isInteger(rw.max_attempts) || rw.max_attempts < 1) {
      push(TEAM_ASSET_CODES.REWORK_INVALID, 'chain.rework.max_attempts',
        `有回边 ⇒ max_attempts 必填（正整数）；收到：${JSON.stringify(rw.max_attempts ?? null)}`);
    } else if (backEdges > rw.max_attempts) {
      push(TEAM_ASSET_CODES.REWORK_INVALID, 'chain.rework.max_attempts',
        `链内环数 ${backEdges} 超 rework.max_attempts=${rw.max_attempts}（回边须被返工预算承认）`);
    }
  }

  // ⑥ 链尾唯一（terminal:true 恰好一步）
  const terminals = [...byId.values()].filter((s) => s.terminal === true).map((s) => s.id);
  if (terminals.length !== 1) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'chain.steps',
      `链尾（terminal:true）须**恰好一步**，当前 ${terminals.length} 个：${terminals.join('/') || '（无）'}`);
  }

  // ⑦ join:any 必带 anyFailure
  const anySteps = [...byId.values()].filter((s) => s.join === 'any').map((s) => s.id);
  const anyFailure = isPlainObject(chain.join) ? chain.join.anyFailure : undefined;
  if (anySteps.length > 0 && anyFailure == null) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'chain.join.anyFailure',
      `步 ${anySteps.join('/')} 声明 join:'any' ⇒ chain.join.anyFailure 必填（落败分支的收口口径）`);
  }

  // ⑧ 只收枚举 token（on 键 / onFail / anyFailure / join 值；禁表达式）
  if (chain.on != null) push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, 'chain.on', '`on` 只允许出现在 step 内（步级分支面）');
  // ⑧b 退役**链级**子键：声明即拒（**不静默失能**）——与步级 `on`（M1）同款口径：这些键已无运行期读点，
  //   若只删校验会退化成「写了不生效」的静默失能。事由表见 `RETIRED_CHAIN_REASONS`（单一来源）。
  for (const k of RETIRED_CHAIN_KEYS) {
    if (chain[k] == null) continue;
    push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.${k}`,
      `chain.${k} 已退役，声明即拒：${RETIRED_CHAIN_REASONS[k]}`);
  }
  if (chain.join != null && !isPlainObject(chain.join)) {
    push(TEAM_ASSET_CODES.BAD_TYPE, 'chain.join', 'chain.join 必须是对象（{ anyFailure }）');
  }
  const tokenAt = (path, value) => {
    if (value == null) return;
    if (typeof value !== 'string' || looksLikeExpression(value) || !CHAIN_ON_FAIL_TOKENS.includes(value)) {
      push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, path,
        `${path} 只收枚举 token ${CHAIN_ON_FAIL_TOKENS.join('/')}（禁表达式；收到：${JSON.stringify(value)}）`);
    }
  };
  tokenAt('chain.onFail', chain.onFail);
  tokenAt('chain.join.anyFailure', anyFailure);
  for (const [id, s] of byId) {
    if (s.join != null && !CHAIN_JOINS.includes(s.join)) {
      push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.join`,
        `join 只收 ${CHAIN_JOINS.join('/')}（收到：${JSON.stringify(s.join)}）`);
    }
    if (s.on == null) continue;
    // ⑧【M1，2026-09-17 用户裁决】`on`（步级条件边）声明面**已下线** ⇒ 声明即拒（**不静默失能**）。
    //   `on` 从「白名单键」变为「未知键」，若只删校验会**静默忽略**（写了不生效，比拒更糟）⇒ 故必须显式拒。
    //   能力去处（外部台账 · `[docs-ref] handoff §10.1`）：
    //     `merged` 分支 → `next`；失败面（`fail`/`conflict`）→ 批次级策略
    //     （`chain.join.anyFailure` / `chain.onFail`，M4 迁 `rework`）；`skipped` 分支 → `deps` + Leader 裁决。
    //   报码路径 = **父键 `on`**（不按旧键域逐键报）；三版本（v1/v2/v3）同拒。
    push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.on`,
      '`on`（步级条件边）已下线（M1，2026-09-17）：正路路由用 `next`，失败面用批次级策略 '
      + '(`chain.join.anyFailure` / `chain.onFail`)；声明即拒，能力面变更须走规格。');
  }

  return { ok: !hasBlockingProblems(problems), problems };
}

/** 解析 + 校验（纯函数，`asset` 入参同 `validateTeamAsset`）：`{ chain, problems, ok }`。 */
export function chainProblemsOf(asset) {
  const resolved = resolveChainOf(asset);
  if (resolved.chain == null) return { chain: null, problems: resolved.problems, ok: !hasBlockingProblems(resolved.problems) };
  const v = validateChain(resolved.chain, isPlainObject(asset) ? asset.layers : null);
  const problems = [...resolved.problems, ...v.problems];
  return { chain: resolved.chain, problems, ok: !hasBlockingProblems(problems) };
}

/**
 * 按批次解析该团队的推进链（**根解析优先级与门禁/快照同源**：批次 `teamsRoot` → 包根）。
 * 无资产 / 资产无 `chain` ⇒ `chain:null`（= 无推进，向后兼容锁）。
 * @returns {{ok: boolean, chain: object|null, problems: Array<object>, path: string|null, root: string}}
 */
export function loadChainOf({ team, teamsRoot = null } = {}) {
  const root = teamsRoot ?? packageRoot();
  if (!isNonEmptyString(team)) return { ok: false, chain: null, problems: [], path: null, root };
  const r = loadTeamAsset(root, team);
  if (!r.ok || !r.asset) return { ok: false, chain: null, problems: r.problems ?? [], path: r.path ?? null, root };
  const c = chainProblemsOf(r.asset);
  return { ok: c.ok, chain: c.chain, problems: c.problems, path: r.path ?? null, root };
}

/** 批次侧便捷读端（`batch.team` + `batch.teamsRoot`；无 team ⇒ 无链）。 */
export function chainOfBatch(batch) {
  const team = isPlainObject(batch) ? batch.team : null;
  if (!isNonEmptyString(team)) return { ok: false, chain: null, problems: [], path: null, root: packageRoot() };
  return loadChainOf({ team, teamsRoot: isNonEmptyString(batch.teamsRoot) ? batch.teamsRoot : null });
}

// ── lane → step 映射（fail-closed，禁猜） ─────────────────────────────────────
// 规则（Leader 裁决 ④，2026-09-16）：
//   ① `step.id === lane.id` **优先**（显式命名即显式归属）；
//   ② 否则按 `(layer, role)` 命中链步 —— **多 lane 命中同一步 = 同层共享该步**，
//      推进时机由该步的 `join` 决定（software-team 的 `exec-work` 双 exec lane 因此不歧义）；
//   ③ 同一 `(layer, role)` 命中 **≥2 个不同 step** ⇒ **歧义**（fail-closed，调用方停轮）；
//   ④ 无命中 ⇒ 链外 lane（手工派发语义不变，不参与推进）。
/**
 * @returns {{ok: boolean, step: object|null, reason: string|null}}
 *   `ok:false` + `reason:'ambiguous-mapping'` = 歧义（调用方须停轮）；`step:null` = 链外 lane。
 */
// 【冻结 · 2026-09-18 Q-A=C 退役】运行期**零消费**（唯一调用方 `chain-runner`/`replay` 的链推进已删）；
//   符号本体与纯函数语义逐字保留：服务既有纯函数用例与历史读端/迁移工具。**禁在 `lib/` 内新增调用**。
export function chainStepForLane(chain, laneId, { layer = null, role = null } = {}) {
  if (!isPlainObject(chain) || !Array.isArray(chain.steps)) return { ok: true, step: null, reason: null };
  const steps = chain.steps.filter((s) => isPlainObject(s) && isNonEmptyString(s.id));
  if (isNonEmptyString(laneId)) {
    const byId = steps.find((s) => s.id === laneId);
    if (byId) return { ok: true, step: byId, reason: null };
  }
  // ── 【v3 · W2 装配图】lane 归属 = **展开规则**，不靠 (layer,role) 猜 ──────────────────────────
  //   判据（按序）：① `lane.id === step.id`（上方，显式命名）；② `lane.id === branches[].id`
  //   （分支 id **逐字**即本批 lane id，§2.1）；③ 配对实例 lane id 命中 `template.id` 的 `${lane}` 模式
  //   （`audit-${lane}` ⇒ `audit-exec-coder`）。
  //   **v3 步一律不参与 (layer,role) 兜底**（两条理由，均写死在注释里，禁「各读各写」）：
  //     ① 展开后的 lane id 已是稳定真源，再按 (layer,role) 猜会带来**非预期归属**——普通批次的
  //        `e1`/`a1` 之类手工 lane 会被同层同角色的链步「顺手捕获」⇒ 误推进/停轮（W2 施工实测风险面）；
  //     ② v1/v2 资产的 (layer,role) 兜底语义**逐字不变**（本分支只对 `version:3` 生效，硬锁①）。
  //   已知偏离（登记，交 Leader 裁决）：§8 反例 R4「同一层两个同角色步 ⇒ ambiguous-mapping」只对
  //     v1/v2 步成立；v3 装配图以「分支 id / 模板模式」替代该兜底判据。
  if (chain.version === 3) {
    if (!isNonEmptyString(laneId)) return { ok: true, step: null, reason: null };
    const hits = steps.filter((s) => branchIdsOf(s).includes(laneId) || pairTemplateMatches(s, laneId));
    if (hits.length === 0) return { ok: true, step: null, reason: null };
    const v3distinct = new Set(hits.map((s) => s.id));
    if (v3distinct.size > 1) {
      return { ok: false, step: null, reason: 'ambiguous-mapping: lane ' + laneId + ' 命中 ' + v3distinct.size + ' 个链步（' + [...v3distinct].join('/') + '）' };
    }
    return { ok: true, step: hits[0], reason: null };
  }
  if (!isNonEmptyString(layer) || !isNonEmptyString(role)) return { ok: true, step: null, reason: null };
  const hits = steps.filter((s) => s.layer === layer && String(s.role ?? '').toLowerCase() === String(role).toLowerCase());
  if (hits.length === 0) return { ok: true, step: null, reason: null };
  const distinct = new Set(hits.map((s) => s.id));
  if (distinct.size > 1) {
    return { ok: false, step: null, reason: 'ambiguous-mapping: (' + layer + ',' + role + ') 命中 ' + distinct.size + ' 个链步（' + [...distinct].join('/') + '）' };
  }
  return { ok: true, step: hits[0], reason: null };
}

/**
 * 某链步在**本批 wavePlan 内**对应的 lane 集（顺序 = wavePlan 顺序）。
 * 语义：lane→step 映射（`chainStepForLane`）的**反向投影**——不存在于本批的链步 ⇒ 空集
 * （推进目标无 lane 时调用方停轮上报，**绝不新造 lane / 不改 wavePlan 分层**，RK2）。
 * @param tasks 本批全部任务（`wavePlan[].tasks` 拍平）
 */
// 【冻结 · 2026-09-18 Q-A=C 退役】运行期**零消费**（唯一调用方已删）；语义逐字保留，禁在 `lib/` 内新增调用。
export function chainLanesOfStep(chain, stepId, tasks) {
  const lanes = [];
  let ambiguous = null;
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!isPlainObject(t) || !isNonEmptyString(t.id)) continue;
    const m = chainStepForLane(chain, t.id, { layer: t.layer, role: t.role });
    if (!m.ok) { ambiguous = ambiguous ?? m.reason; continue; }
    if (m.step && m.step.id === stepId) lanes.push(t.id);
  }
  return { lanes, ambiguous };
}

/** 【v2 · P4a-pre】`perLane` 目标步查询（纯函数）：`stepId` 的后继中若有声明 `perLane === stepId` 的步，
 *  返回该步；否则 `null`。用途 = `chain-runner` 判定「本跳是否要走**分支级 1:1**（不作同层汇合等待）」。
 *  【v3 · W2】`pair_with` 是 `perLane` 的**可读别名**（§2.4「同一校验器、同一实例化代码路径」）⇒ 本读端
 *  一并匹配之：漏加会让 v3 资产声明 `pair_with` 后**配对在运行期静默失效**（写了不生效）。 */
// 【冻结 · 2026-09-18 Q-A=C 退役】`pair_with`/`perLane` 的**运行期读端已删**（配对基数改由 `tasks[].deps` 表达，
//   见 `RETIRED_CHAIN_DECLARATIONS.pair_with`）；符号保留 = 既有纯函数用例与迁移工具，禁在 `lib/` 内新增调用。
export function perLaneTargetOf(chain, stepId) {
  if (!isPlainObject(chain) || !Array.isArray(chain.steps) || !isNonEmptyString(stepId)) return null;
  const hit = chain.steps.find((s) => isPlainObject(s)
    && s.id !== stepId
    && (s.perLane === stepId || s.pair_with === stepId));
  return hit ?? null;
}

/** 【v2 · P4a-pre】配对 lane 解析（纯函数，**禁猜**）：在 `targetLanes` 中找 `deps` **恰为** `[sourceLane]`
 *  的那条 lane —— 判据 = wavePlan 任务自带的 `deps`（Batch II 的 `submit_batch` 会按 `pair` 模板为每个
 *  上游 lane 生成一条 `deps:[<上游 lane>]` 的配对 lane）。
 *  找不到 ⇒ 返回 `null`；调用方须**停轮上报**（不顺序兜底、不静默改派、不新造 lane —— RK2 禁改分层）。 */
// 【冻结 · 2026-09-18 Q-A=C 退役】运行期**零消费**（配对推进已删）；纯函数语义逐字保留，禁在 `lib/` 内新增调用。
export function pairedLaneOf(targetLanes, sourceLane, tasks) {
  if (!isNonEmptyString(sourceLane)) return null;
  const ids = Array.isArray(targetLanes) ? targetLanes : [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!isPlainObject(t) || !isNonEmptyString(t.id)) continue;
    if (!ids.includes(t.id)) continue;
    const deps = Array.isArray(t.deps) ? t.deps.filter(isNonEmptyString) : [];
    if (deps.length === 1 && deps[0] === sourceLane) return t.id;
  }
  return null;
}

// ── 推进判定（纯函数：给定「已结算的 lane + 结果」，算下一环） ────────────────────
/**
 * @param chain   顶层 chain 声明
 * @param step    触发步（`chainStepForLane` 命中）
 * @param outcome `'merged'|'failed'|'conflict'|'skipped'`
 * @param opts.stepLanes 触发步在本批的 lane 集（`chainLanesOfStep`）
 * @param opts.laneStates `{ [lane]: state }`（批次 `batch.lanes`）
 * @returns {{action:'advance'|'pause'|'hold'|'wait'|'none', to:string|null, via:string|null,
 *            pending?:string[], reason:string|null}}
 *   `advance` = 推进到 `to` 步；`pause` = 停轮且**批次转 paused**；`hold` = 停轮但**不改批次相位**
 *   （`onFail` 的 review/failed 两 token：交还 Leader/Manager 裁决，引擎不自动判死）；
 *   `wait` = 汇合未齐（`join:all` 尚有未结算 lane）；`none` = 不推进（链外/链尾/skipped **未声明显式边**）。
 */
// 【冻结 · 2026-09-18 Q-A=C 退役】链运行期**推进判定已删**（`chain-runner` 改首行 no-op）⇒ 本函数在 `lib/` 内
//   **零消费**；判定语义逐字保留：服务既有纯函数用例（`w1-conditional-edges` / `m1-on-removed` / `p2-chain-autodrive`）
//   与历史口径迁移。**禁在 `lib/` 内新增调用**、**禁**据此重建第二套推进（禁双推进源）。
export function chainNextOf(chain, step, outcome, { stepLanes = [], laneStates = {}, reworkAttempts = 0 } = {}) {
  if (!isPlainObject(chain) || !isPlainObject(step)) return { action: 'none', to: null, via: null, reason: 'no-step' };

  // ── `skipped` 的推进边界（M1 后口径**收窄为一条，禁各读各写**）───────────────────────────────
  //   M1（2026-09-17）删去步级条件边 ⇒ `skipped` 只剩一种结局：**不推进**
  //   （`{action:'none', reason:'skipped-no-advance'}`，**逐字沿用「未声明」的旧语义** = W1-② 硬锁①）。
  //   边界（未变）：本规则只覆盖**触发面**（该 lane 自己结算 `skipped` 时是否推进），**不改汇合面**——
  //   `join:'all'` 下某兄弟 lane 结算 `skipped`、另一 lane 结算 `merged` 时，它仍算 `pending` ⇒ `wait`
  //   （`merged` 分支的 `pending` 过滤未变；汇合语义由作者用 `join` 声明，与边语义正交）。
  //   去处：需要「跳过也推进」的资产改走 `deps` + Leader 裁决（**不静默推进**，见头注释 M1 段）。
  if (outcome === 'skipped') {
    return { action: 'none', to: null, via: null, reason: 'skipped-no-advance' };
  }

  const join = step.join === 'any' ? 'any' : 'all'; // 缺省 all（spec §推进规则）
  const rw = isPlainObject(chain.rework) ? chain.rework : null;
  const maxAttempts = Number.isInteger(rw?.max_attempts) ? rw.max_attempts : 0;

  if (outcome === 'merged') {
    // 汇合闸：`join:all` 须同一步全部 lane 已 merged（skipped 视为**未完成**，不推进）
    if (join === 'all') {
      const pending = stepLanes.filter((l) => (laneStates[l] ?? 'pending') !== 'merged');
      if (pending.length > 0) return { action: 'wait', to: null, via: null, pending, reason: 'join-all-pending' };
    }
    if (typeof step.next === 'string' && step.next) return { action: 'advance', to: step.next, via: 'next', reason: null };
    // M1：`merged` 的第二级兜底（原「步级条件边把 merged 指到别处」）已随声明面一并删除
    //   ⇒ 未声明 `next` 即「链尾 / 无后继」（`reason:'chain-end'`，逐字沿用旧兜底文案）。
    return { action: 'none', to: null, via: null, reason: 'chain-end' }; // 链尾（terminal）或未声明后继
  }

  // 失败面（failed / conflict）：M1 后只余**两级** —— `join:any` 的 `anyFailure` → 链级 `onFail`。
  //   （原步级两级「最具体者优先」已随声明面删除；`conflict` 与 `failed` **逐字同路**。）
  //   命中后共用同一段后处理（枚举 token ⇒ pause/hold；步 id ⇒ 返工预算硬限后 advance）⇒ 语义一致、零第二套。
  const tokenOfAnyFailure = isPlainObject(chain.join) ? chain.join.anyFailure : null;
  const tokenOfOnFail = typeof chain.onFail === 'string' ? chain.onFail : 'pause'; // 缺省 pause（停轮上报）
  let via = null;
  let to = null;
  if (join === 'any' && typeof tokenOfAnyFailure === 'string' && tokenOfAnyFailure) {
    via = 'anyFailure'; to = tokenOfAnyFailure;
  } else {
    via = 'onFail'; to = tokenOfOnFail;
  }
  if (CHAIN_ON_FAIL_TOKENS.includes(to)) {
    // 枚举 token（非步 id）：pause ⇒ 批次 paused（停轮上报，不写 failed、不 abort）；
    // review/failed ⇒ 只留痕停轮（不改相位，处置交还 Leader/Manager）。
    return { action: to === 'pause' ? 'pause' : 'hold', to: null, via, reason: 'onFail-' + to };
  }
  // ── K3（**保留面，禁删**）：返工预算硬限 —— 超限停轮（绝不改 wavePlan 分层，RK2）──────────────
  //   【M1 后状态登记（2026-09-17）】M1 前本段由**步级条件边把失败面指向步 id** 触发；M1 删去该声明面后
  //     `to` 只可能来自批次级 `anyFailure` / `onFail`（二者取值是枚举 token，非步 id）⇒ **本段失去新触发路径**，
  //     `chain.rework.max_attempts` 变成「只对历史批有效」的影子配置。
  //   **仍保留代码**（不删）的判据：删则静默丢掉 rework 语义（历史批的跨重启幂等 + M4 口径迁移都要用），
  //     与 `countReworkAttempts`（`lib/engine/chain-runner.js`，K2）**同一口径、同一注记**。
  //   口径迁移归 **M4 / CH-2**（本批不含）。
  if (maxAttempts > 0 && reworkAttempts >= maxAttempts) {
    return { action: 'pause', to: null, via, reason: 'rework-max-attempts(' + reworkAttempts + '/' + maxAttempts + ')' };
  }
  return { action: 'advance', to, via, reason: null };
}

// ── 【v3 · W2 装配图】分支展开（纯函数；W3 提交面的**声明增量**来源） ──────────────────────────
/**
 * 把 v3 装配图展开为**本批 lane 声明**（无 IO / 无副作用 / 不改任何状态）。
 * 语义（`[docs-ref] w2 §2.1/§2.3/§7`，逐条写死）：
 *   · `branches[]` ⇒ **每分支一条 lane**，`id` **逐字 = 分支 id**（禁「写了不生效」）；
 *   · `pair_with`（= `perLane`）步 ⇒ 按**上游步在本批的每条 lane** 实例化一条（1:1），
 *     lane id = `template.id` 的 `${lane}` 插值（`audit-${lane}` ⇒ `audit-exec-coder`），
 *     `deps` **恰为** `[上游 lane]`（V8 / `pairedLaneOf` 判据的唯一真源）；
 *   · 普通步 / 聚合步（`join:'all'` + `terminal`）⇒ **一条** lane，id = `template.id` 插值 ?? 步 id。
 * 产物只含**声明增量**（layer/role/skills/deps/cmd/produce）；跨层 `consume`、门禁、产物在场等**归 W3 提交面**
 *   ——本函数不猜、不代造（与 §7「分工」一致）。
 * 自证（禁「写了不生效」）：每条展开 lane 必须经 `chainStepForLane` **反投影回其来源步**，
 *   否则产 `TEAM_ASSET_MISSING_FIELD`（= 展开规则与 lane→step 映射不自洽 ⇒ 运行期必然停轮）。
 * @returns {{ok: boolean, lanes: Array<{id,stepId,branch,instance,layer,role,skills,deps,cmd,produce}>, problems: Array<object>}}
 */
export function expandChainBranches(chain) {
  const problems = [];
  const push = (path, message) => problems.push({
    code: TEAM_ASSET_CODES.MISSING_FIELD, path, message,
    severity: severityOfProblem({ code: TEAM_ASSET_CODES.MISSING_FIELD }),
  });
  const lanes = [];
  const lanesOfStep = new Map();
  if (!isPlainObject(chain) || !Array.isArray(chain.steps)) return { ok: false, lanes, problems };
  const interp = (tpl, vars) => typeof tpl === 'string'
    ? tpl.replace(/\$\{([^}]*)\}/g, (m, name) => {
      const k = String(name).trim();
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
    })
    : '';
  const produceOf = (tpl, vars) => (Array.isArray(tpl.produce) ? tpl.produce.map((x) => interp(x, vars)) : []);
  for (const s of chain.steps) {
    if (!isPlainObject(s) || !isNonEmptyString(s.id)) continue;
    const layer = isNonEmptyString(s.layer) ? s.layer : null;
    const tpl = isPlainObject(s.template) ? s.template : {};
    if (Array.isArray(s.branches) && s.branches.length > 0) {
      const ids = [];
      for (const b of s.branches) {
        if (!isPlainObject(b) || !isNonEmptyString(b.id)) continue;
        const vars = { branch: b.id, lane: b.id };
        lanes.push({
          id: b.id, stepId: s.id, branch: b.id, instance: null, generated: true, layer,
          role: isNonEmptyString(b.role) ? b.role : (isNonEmptyString(s.role) ? s.role : null),
          skills: Array.isArray(b.skills) ? [...b.skills] : [],
          deps: Array.isArray(b.deps) ? [...b.deps] : [],
          cmd: interp(tpl.cmd, vars), produce: produceOf(tpl, vars),
        });
        ids.push(b.id);
      }
      lanesOfStep.set(s.id, ids);
      continue;
    }
    const pairTarget = isNonEmptyString(s.pair_with) ? s.pair_with : (isNonEmptyString(s.perLane) ? s.perLane : null);
    if (pairTarget) {
      const upstream = lanesOfStep.get(pairTarget) ?? [];
      const ids = [];
      for (const up of upstream) {
        const vars = { lane: up, branch: s.id };
        const laneId = isNonEmptyString(tpl.id) ? interp(tpl.id, vars) : '';
        if (!laneId) { push(`chain.steps.${s.id}.template.id`, '配对步必须声明 template.id（含 `${lane}`）——lane id 的生成来源'); continue; }
        lanes.push({
          id: laneId, stepId: s.id, branch: null, instance: up, generated: true, layer,
          role: isNonEmptyString(s.role) ? s.role : null, skills: [],
          deps: [up], cmd: interp(tpl.cmd, vars), produce: produceOf(tpl, vars),
        });
        ids.push(laneId);
      }
      lanesOfStep.set(s.id, ids);
      continue;
    }
    const vars = { lane: s.id, branch: s.id };
    const laneId = isNonEmptyString(tpl.id) ? interp(tpl.id, vars) : s.id;
    lanes.push({
      id: laneId, stepId: s.id, branch: null, instance: null, generated: false, layer,
      role: isNonEmptyString(s.role) ? s.role : null, skills: [], deps: [],
      cmd: interp(tpl.cmd, vars), produce: produceOf(tpl, vars),
    });
    lanesOfStep.set(s.id, [laneId]);
  }
  for (const l of lanes) {
    const m = chainStepForLane(chain, l.id, { layer: l.layer, role: l.role });
    if (!m.ok) { push(`chain.steps.${l.stepId}`, `展开 lane ${l.id} 的步归属歧义：${m.reason}`); continue; }
    if (!m.step || m.step.id !== l.stepId) {
      push(`chain.steps.${l.stepId}`, `展开 lane ${l.id} 反投影不到来源步（实际映射到：${m.step ? m.step.id : '链外'}）——展开规则与 lane→step 映射不自洽`);
    }
  }
  // 【与 `validateChain`/`chainProblemsOf` 同口径（R2-3 裁决 B，2026-09-17）】本函数的 `push` **只产
  //   `TEAM_ASSET_MISSING_FIELD`（∈ BLOCKING_CODES）**，故这行改动**行为等价**（今天两种写法同结果）；
  //   一致化动机 = `lib/tools/core.js:561-564` 已登记的坑：同族函数各持一套 `ok` 判定 ⇒ 读端易误判。
  return { ok: !hasBlockingProblems(problems), lanes, problems };
}
// ── 读端回显投影（`batch_status`；RK1） ───────────────────────────────────────
/**
 * `chain` 回显面：`{ version, steps[], lastStep, edges[{from,to,via}] }`。
 * 无链 ⇒ `null`（读端**不出现**回显字段——无链即无推进，零差异）。
 * 事件面取值 = 批次事件流里的 `chain.step`（**唯一事实源**，不另设内存态）。
 * 【K1（**保留面，本批零改动**）】本函数**不校验 `via`**（直取 `e.via`）⇒ 磁盘上历史 `on` 族的
 *   `chain.step` 事件照常回显（`batch_status.chain.edges` / `log_export` 均不受 M1 影响）。
 *   M1 只收窄**写侧**白名单（`CHAIN_STEP_VIA`）⇒ 新旧数据共存且语义可判；**禁在此新增校验**。
 */
export function chainEchoOf(batch, chain) {
  if (!isPlainObject(chain)) return null;
  const events = (Array.isArray(batch?.events) ? batch.events : []).filter((e) => e && e.type === 'chain.step');
  const edges = [];
  const seen = new Set();
  for (const e of events) {
    const key = String(e.from) + '→' + String(e.to) + '#' + String(e.via);
    if (seen.has(key)) continue; // 图语义去重（重复命中次数由事件流本身可核：log_export）
    seen.add(key);
    edges.push({ from: e.from ?? null, to: e.to ?? null, via: e.via ?? null });
  }
  const last = events.length ? events[events.length - 1] : null;
  return {
    version: chain.version ?? null,
    steps: Array.isArray(chain.steps) ? chain.steps : [],
    lastStep: last ? { from: last.from ?? null, to: last.to ?? null, via: last.via ?? null, lane: last.lane ?? null } : null,
    edges,
  };
}
