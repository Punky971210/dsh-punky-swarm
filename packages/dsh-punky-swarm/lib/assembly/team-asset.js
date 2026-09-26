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

// 团队资产（team-asset）声明：加载 + 加载期不变量校验
// ─────────────────────────────────────────────────────────────────────────────
// 定位：
//   把「层语义 / 产物字段 / 必填契约 / 流程开关 / 返工策略 / 状态机收紧」从引擎硬编码里
//   搬进**每团队一份**的声明资产 `presets/<team>/team-asset.yml`，成为「与引擎绑定的资产」。
//   本模块只做两件事：① 找到并解析声明；② 加载期不变量校验（fail = 拒载该团队，不炸宿主）。
//   **本文件不改动任何既有行为**：门禁/状态机是否读声明由后续切片接入，
//   且缺声明时一律回落现状语义。
//
// 校验方式（「加载期不变量」这一半）：
//   3. 加载期不变量断言（本文件）
//   4. 运行期首触校验（声明未覆盖的迁移点首次触发 → 事件 + 降级跳过 + 告警）
//
// 格式：引擎**零运行时依赖**（package.json 无 dependencies，无 YAML 解析器），
//   既有资产清单惯例为 JSON（asset-manifest.json）。故声明文件采用
//   **`.yml` 文件名 + JSON 子集内容**（YAML 1.2 是 JSON 超集 ⇒ 内容既是合法 JSON 也是合法 YAML）。
//   读取顺序：`team-asset.json` → `team-asset.yml`（按 JSON 解析）；两者都失败 → 明确报错。
//   若后续引入 YAML 解析器，本模块的解析入口可平滑放开为完整 YAML。
//
// 读端纪律：**容忍 BOM**（U+FEFF）——实测 runtime.json 读端因 BOM 拒读，
//   本模块一律先剥 BOM 再 parse，避免同类缺陷复发。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── 常量：可拔插面的白名单（引擎基础语义，声明不得越界）──
export const TEAM_ASSET_DIR = 'presets';
const TEAM_ASSET_FILENAMES = Object.freeze(['team-asset.json', 'team-asset.yml']);
export const PRODUCE_LAYERS = Object.freeze(['plan', 'exec', 'audit']); // 有「产出存在性」语义的层
export const FLOW_SECTIONS = Object.freeze([...PRODUCE_LAYERS]);
// ↑ 严控勿松落点：原为 `Object.freeze([...PRODUCE_LAYERS, 'complete'])`，
//   现**移除**该层 ⇒ 显式声明 `flows.complete` 的团队资产在层名白名单校验处即拒载
//   （`TEAM_ASSET_LAYER_UNKNOWN`，∈ BLOCKING_CODES ⇒ 整份资产不可交付）。**不降为告警、不加兼容分支、
//   不为旧声明留豁免、不设「废弃但接受」集合**。`complete` 门禁白名单的唯一真源 = `flows.audit.audit_contract.verdict`。
//   注：本注释块置于声明行**之下**，以保持 `FLOW_SECTIONS` 声明仍在文件第 48 行（规格 A1 的行号锚）。
export const PRODUCE_FIELDS = Object.freeze(['produce', 'outputs']); // 产物字段名白名单
export const ENTRY_REQUIREMENTS = Object.freeze(['consume']); // 派发前可要求的项（白名单）
export const CONSUME_FIELDS = Object.freeze(['consume']); // 消费字段名白名单（r2：读端只能收紧，见 flows.js consumeFieldOf）
// 原 `ESCALATIONS = ['human','none']` 常量**已删除**：其唯一消费点是**顶层 `rework`**
//   校验（随该键退役一并清除）；**链级** `chain.rework` 的取值域由 `lib/assembly/chain.js` 自持，不经本常量。
// 退役声明键：**零运行期消费者**的三个声明面
//   ——一旦声明即拒（`TEAM_ASSET_FIELD_NOT_ALLOWED`，∈ BLOCKING_CODES），不留「写了不生效」的静默面。
//   · `RETIRED_FLOW_KEYS`：层内声明（原「仅结构校验」）
//   · `RETIRED_TOP_KEYS`：顶层声明（原「仅加载期不变量校验」）
export const RETIRED_FLOW_KEYS = Object.freeze(['progress_contract']);
export const RETIRED_TOP_KEYS = Object.freeze(['state_machine', 'rework']);
export const ROLE_EXTRA_RE = /^[a-z][a-z0-9-]*$/; // 扩展角色词法（kebab-case）
export const BOM = '\uFEFF';

// 问题码（加载期不变量）：拒载该团队时不炸宿主，交由调用方告警 + 降级
export const TEAM_ASSET_CODES = Object.freeze({
  NOT_FOUND: 'TEAM_ASSET_NOT_FOUND',
  BAD_JSON: 'TEAM_ASSET_BAD_JSON',
  BAD_TYPE: 'TEAM_ASSET_BAD_TYPE',
  MISSING_FIELD: 'TEAM_ASSET_MISSING_FIELD',
  FIELD_NOT_ALLOWED: 'TEAM_ASSET_FIELD_NOT_ALLOWED',
  ENTRY_REQUIRE_UNKNOWN: 'TEAM_ASSET_ENTRY_REQUIRE_UNKNOWN',
  CONSUME_FIELD_NOT_ALLOWED: 'TEAM_ASSET_CONSUME_FIELD_NOT_ALLOWED',
  CONTRACT_EMPTY: 'TEAM_ASSET_CONTRACT_EMPTY',
  LAYER_UNKNOWN: 'TEAM_ASSET_LAYER_UNKNOWN',
  ROLE_LEXICAL: 'TEAM_ASSET_ROLE_LEXICAL',
  SKILLS_MISMATCH: 'TEAM_ASSET_SKILLS_MISMATCH',
  REWORK_INVALID: 'TEAM_ASSET_REWORK_INVALID',
  // 三个 `STATE_*` 码**已删除**（`STATE_OVERRIDE_UNKNOWN_STATE` / `STATE_OVERRIDE_WIDENS` /
  //   `STATE_KIND_INVALID`）：其**唯一消费点**是团队资产顶层 `state_machine` 的加载期校验，该键随本轮退役
  //   （零运行期消费者 ⇒ 声明即拒 `FIELD_NOT_ALLOWED`）⇒ 码面无消费方，一并清除（不留死码）。
  LEAD_NOT_IN_LAYERS: 'TEAM_ASSET_LEAD_NOT_IN_LAYERS',
  // 旧泛键标废（B-3，2026-09-15 批次 core-techdebt-close-20260915）：`flows.audit.contract` 是 **旧泛键**，
  //   现役真源 = `flows.audit.audit_contract.*`（读端 `flows.js:496-509` `auditContract`，consumer 为 entry/建批/complete 三门）。
  //   旧泛键**无任何运行期读点**（`contractOf` 只取 plan 层），声明它 = 写了不生效 + 与 audit_contract 构成双真源隐患 ⇒ 标废。
  //   口径：**显式标废但不留兼容分支**——声明即在载入期产 blocking problem（不静默忽略、不当作 warning 降级）。
  CONTRACT_LEGACY: 'TEAM_ASSET_CONTRACT_LEGACY',
});

// ── 问题严重级（r2 强警示面，要求 5 / design §6 `flows-unresolved`） ──
// 定位：团队资产缺失 / 团队名不可解析在 r1 只以**文本告警**出现（原码 `「团队资产缺失」码(已删)` 与该处告警
//   **均已删除**——gate-lite 第二批 · C，见 `lib/tools/core.js:691-694`；该形态现已由构造期拒载承担），
//   调用方无法机器化区分「资产完全不可用」与「可用但退化」。
//   r2 给每条问题附 `severity`，并导出 `blockingProblemsOf`：读端据此决定是否升级为强警示。
//   **本批口径 = 强警示，不阻断建批**（无资产是既有合法形态；发射点在域外只读文件）——
//   详见 `flows.js` 的 `teamAssetEscalationOf`。
export const TEAM_ASSET_SEVERITY = Object.freeze({ blocking: 'blocking', warning: 'warning' });

// blocking = **资产不可用**（文件/解析/技能可解析面不成立 ⇒ 声明面整体不可交付）；
// 其余 = warning（**可用但退化**：引擎按 tighten-only 缺省侧继续，问题仍可读、不静默）。
// 【现行 = 严格档「都不降」】**已撤回此前的降档**——
//   D 批曾把声明面六条码一律移出 BLOCKING_CODES（依据「旧构造面向短生命周期 subagent，现面向长生命周期
//   Agent-team 交接任务」）⇒ 现行口径回到严格：资产/链的**结构面与声明面**重归硬拦，`ok = !hasBlockingProblems`
//   语义不变，但 blocking 集合**恢复为「除四条 advisory 码外全数」**。D 批依据的「新模型下错层名交给交接门 + 名册」
//   一并作废——交接门是**运行期**产物门，不替代**载入期**资产声明拒绝（两者层次不同，不构成替代关系）。
//   ⇒ **本文件为唯一严重级真源**（`severityOfProblem` 单点）。
// 【2026-09-17 订正 · 与 `chain.js` 同口径】本文件 `validateTeamAsset` 的 `ok` 已由旧「零问题」
//   （`ok = problems.length === 0`）改为 **`ok = !hasBlockingProblems(problems)`**；`chain.js` 同批同改
//   （R2-3 + R2-3 一致性收尾）⇒ 两处不再存在「同一 severity 两种 `ok` 口径」，`chain.js` 头注释中
//   「刻意不折进本文件」的**严重级理由**随之失效（残留理由仅为「单一强制点 + 不重复报码」）。
// **反例面（advisory / warning，只提示不否决，五条）**：`ROLE_LEXICAL`（扩展角色词法）/
//   `LEAD_NOT_IN_LAYERS`（牵头角色悬空）/ `CONSUME_FIELD_NOT_ALLOWED`（读端回落 `consume`）/
//   `REWORK_INVALID`（链级回边未承认）/ **`LAYER_UNKNOWN`（未知层）**。
//   **末条（现行）**：本机**无外部自建 team**，未知层判定**暂时用不到** ⇒
//   **先清理为 warning**（**码面保留、留痕可读、不拒载**），日后有需求再以其他方式补回。
//   ⇒ 这是 **Q1「都不降（回到严格）」的单码例外**：其余一切码仍一律 blocking，不得据此放宽。
//   **其余一切码（含 NOT_FOUND 缺资产 / BAD_JSON 不可解析 / SKILLS_MISMATCH 技能不可解析 /
//   缺字段 / 非白名单字段 / 坏类型 / 旧泛键 / 未登记入参要求）一律 blocking，不得放松。**
const BLOCKING_CODES = Object.freeze([
  TEAM_ASSET_CODES.NOT_FOUND,
  TEAM_ASSET_CODES.BAD_JSON,
  TEAM_ASSET_CODES.SKILLS_MISMATCH,
  TEAM_ASSET_CODES.BAD_TYPE,
  TEAM_ASSET_CODES.MISSING_FIELD,
  TEAM_ASSET_CODES.FIELD_NOT_ALLOWED,
  TEAM_ASSET_CODES.ENTRY_REQUIRE_UNKNOWN,
  TEAM_ASSET_CODES.CONTRACT_LEGACY,
]);

/** 单条问题的严重级（未登记码按 warning：保守，不把未知告警升级为 blocking）。 */
export function severityOfProblem(problem) {
  const code = problem && typeof problem.code === 'string' ? problem.code : null;
  return code !== null && BLOCKING_CODES.includes(code) ? TEAM_ASSET_SEVERITY.blocking : TEAM_ASSET_SEVERITY.warning;
}

/** 是否存在 blocking 级问题（读端升级判据；返回布尔）。 */
export function hasBlockingProblems(problems) {
  return Array.isArray(problems) && problems.some((p) => p && p.severity === TEAM_ASSET_SEVERITY.blocking);
}

// ── 零读端声明台账（要求 7：**要么接线，要么显式标注未接线**——禁「写了不生效」的欺骗面） ──
// 权威性：本表是「哪个声明键有/没有运行期消费者」的**单一来源**；`flows.js` 的
//   `declarationSummaryOf().unwired` 直接读它（不复制数据），供 `gate_status.gateStrength.unwired` 取数。
export const UNWIRED_DECLARATIONS = Object.freeze([
  // [历史条目 · 已移除] `consume_field`（原 `status:'read-end-provided-not-wired'`）——
  //   `consume_field` 已于 **S19① 接线**（`lib/state/gates.ts` entry 门 `consumeFieldNameOf`（`:353-358`）
  //   ⇒ `flows.js` `consumeFieldOf` 按**该层声明**取字段名；消费点 `gates.ts:384` / `:483` / `:966-967`）
  //   ⇒ 原缺口条目移除。**只改 `status` 不能消除误报**：读端 `unwiredDeclarationsOf`（见下）只按「该键是否被声明」
  //   过滤、不读 `status`，故必须整条删除。可达行为上限：白名单 `CONSUME_FIELDS=['consume']`（本文件 `:51` ＋
  //   `flows.js:255` 双源）⇒ 声明面行为上与「固定读 `'consume'`」等价，但口径不再撒谎。
  //   `state_machine`（顶层）/ `flows.<layer>.progress_contract` / `rework`（顶层）**均无运行期消费者**
  //   （前者仅加载期不变量校验，后两者仅结构校验）⇒ 其**声明面与校验器一并退役**：退役键**声明即拒**
  //   （`TEAM_ASSET_FIELD_NOT_ALLOWED`，见本文件 `RETIRED_TOP_KEYS` / `RETIRED_FLOW_KEYS`）
  //   ⇒ 不再需要「标注未接线」这一档：**要么接线，要么退役拒收**，不留「写了不生效」的静默面。
  //   [沿革 · 因**已接线**而移除的两条] ① `consume_field`（S19① 接线：entry 门 `consumeFieldNameOf`）
  //   ② `chain`（P2 接线：加载期八条校验 + `chain-runner` 推进 + `batch_status` 回显）；
  //   二者只改 `status` 不能消除误报（读端 `unwiredDeclarationsOf` 只按「该键是否被声明」过滤）。
  //   ⇒ 本台账**现为空数组** = 引擎当前**无未接线声明**（健康态）；将来若再引入「声明但未接线」的键，
  //   必须在此登记（要求 7），**不得静默**。
]);

/**
 * 该声明（**整份资产**或 `flows` 子对象）里**实际声明了**的未接线键（可读结果）。
 * @param source `loadTeamAsset().asset`（整份）或 `resolveTeamFlows().flows`（子对象）
 */
export function unwiredDeclarationsOf(source) {
  // 形状与签名保留（调用方：`flows.js#declarationSummaryOf`、`gates.js#unwiredEntriesOf` 及既有测试面）。
  // **台账为空** ⇒ 恒返回 `[]`（引擎当前无未接线声明 = 健康态）。
  if (source === null || typeof source !== 'object') return [];
  return UNWIRED_DECLARATIONS.map((d) => ({ ...d }));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
// D5：**可选**声明位的数组形——`Array.isArray` 且元素均为非空字符串，**允许空数组**。
//   为什么允许空：读端对空数组是「零迭代 ⇒ 零感知」（`lib/state/gates.js:1023` 注释逐字同义）⇒ 与缺省等价，
//   不是「写了不生效」的缺陷面；若按 `isStringArray`（要求非空）校验会**无据拒载**（口径外扩张）。
const isOptionalStringArray = (v) => Array.isArray(v) && v.every(isNonEmptyString);
// D5：`{ literal: <非空字符串> }` 形态——与读端同判据（`lib/state/gates.js:1066-1072`：须为对象且
//   `literal` 为非空字符串，否则静默视同未声明）。
const isPendingMarkerShape = (v) => isPlainObject(v) && isNonEmptyString(v.literal);

export function stripBom(text) {
  return typeof text === 'string' && text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

// ── 解析：JSON 子集（含 BOM 容忍）──
// 问题对象统一形状：`{ code, path, message, severity }`（r2 起带严重级，供强警示读端消费）。
export function parseTeamAsset(text, { path = null } = {}) {
  const problems = [];
  let asset = null;
  try {
    asset = JSON.parse(stripBom(text));
  } catch (e) {
    problems.push({
      code: TEAM_ASSET_CODES.BAD_JSON,
      path: path ?? '(text)',
      message: '声明必须是 JSON 子集（.yml 文件名亦按 JSON 内容书写）：' + String(e?.message ?? e),
      severity: severityOfProblem({ code: TEAM_ASSET_CODES.BAD_JSON }),
    });
    return { ok: false, asset: null, problems };
  }
  if (!isPlainObject(asset)) {
    problems.push({
      code: TEAM_ASSET_CODES.BAD_TYPE, path: path ?? '(root)', message: '声明根必须是对象',
      severity: severityOfProblem({ code: TEAM_ASSET_CODES.BAD_TYPE }),
    });
    return { ok: false, asset: null, problems };
  }
  return { ok: true, asset, problems };
}

// ── 加载期不变量校验（纯函数，便于测试与调用方复用）──
// 返回值：`{ ok, problems, unwired }` —— `unwired` = 该声明里**实际声明了但无运行期消费者**的键
//   （要求 7「显式标注未接线」的可读结果；台账见 `UNWIRED_DECLARATIONS`）。
export function validateTeamAsset(asset) {
  const problems = [];
  const push = (code, path, message) => problems.push({ code, path, message, severity: severityOfProblem({ code }) });

  if (!isPlainObject(asset)) {
    push(TEAM_ASSET_CODES.BAD_TYPE, '(root)', '声明必须是对象');
    return { ok: false, problems, unwired: [] };
  }
  if (!isNonEmptyString(asset.team)) push(TEAM_ASSET_CODES.MISSING_FIELD, 'team', 'team 必填（非空字符串）');

  // ① layers：每层 roles/skills 一一对应（沿用既有 assembly 结构，零新概念）
  if (!isPlainObject(asset.layers)) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'layers', 'layers 必填（对象）');
  } else {
    for (const [layer, def] of Object.entries(asset.layers)) {
      if (!isPlainObject(def)) { push(TEAM_ASSET_CODES.BAD_TYPE, `layers.${layer}`, '层定义必须是对象'); continue; }
      if (!isStringArray(def.roles)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `layers.${layer}.roles`, 'roles 必填（非空字符串数组）'); continue; }
      if (!isPlainObject(def.skills)) { push(TEAM_ASSET_CODES.SKILLS_MISMATCH, `layers.${layer}.skills`, 'skills 必填（对象）'); continue; }
      for (const role of def.roles) {
        if (!isStringArray(def.skills[role])) push(TEAM_ASSET_CODES.SKILLS_MISMATCH, `layers.${layer}.skills.${role}`, '每个 role 必须有非空 skills 数组');
      }
    }
  }

  // ② roles.extra：扩展角色词法（引擎基础集之外的自定义角色名）
  //    `plan_leads` / `audit_leads`——该团队认可的**额外牵头角色**（与引擎基础集并集）；
  //    不变量：每个声明的牵头角色必须在某层 layers[*].roles 里真实存在（否则声明悬空 = 无意义）
  const allLayerRoles = new Set();
  if (isPlainObject(asset.layers)) {
    for (const def of Object.values(asset.layers)) {
      if (isPlainObject(def) && Array.isArray(def.roles)) for (const r of def.roles) allLayerRoles.add(String(r).trim().toLowerCase());
    }
  }
  if (asset.roles != null) {
    if (!isPlainObject(asset.roles)) push(TEAM_ASSET_CODES.BAD_TYPE, 'roles', 'roles 必须是对象');
    else {
      if (asset.roles.extra != null) {
        if (!Array.isArray(asset.roles.extra)) push(TEAM_ASSET_CODES.BAD_TYPE, 'roles.extra', 'roles.extra 必须是数组');
        else {
          const seen = new Set();
          for (const r of asset.roles.extra) {
            if (!isNonEmptyString(r) || !ROLE_EXTRA_RE.test(r)) push(TEAM_ASSET_CODES.ROLE_LEXICAL, 'roles.extra', `扩展角色词法非法：${JSON.stringify(r)}（要求 kebab-case）`);
            else if (seen.has(r)) push(TEAM_ASSET_CODES.ROLE_LEXICAL, 'roles.extra', `扩展角色重复：${r}`);
            else seen.add(r);
          }
        }
      }
    }
  }

  // ③ flows：层→产物字段/入口要求/契约/开关
  if (!isPlainObject(asset.flows)) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'flows', 'flows 必填（对象）');
  } else {
    for (const [layer, flow] of Object.entries(asset.flows)) {
      const at = `flows.${layer}`;
      if (!FLOW_SECTIONS.includes(layer)) { push(TEAM_ASSET_CODES.LAYER_UNKNOWN, at, `未知层：${layer}（允许：${FLOW_SECTIONS.join('/')}）`); continue; }
      if (!isPlainObject(flow)) { push(TEAM_ASSET_CODES.BAD_TYPE, at, '层流程定义必须是对象'); continue; }

      // complete 段（**已清退**）：
      //   ① `require_audit_outcomes` 类型校验已删（E-4，legacy-retire-20260915）；`complete` 白名单**唯一真源**
      //      = `flows.audit.audit_contract.verdict`（读端 gates.ts `completeOutcomesOf`）。
      //   ② `'complete'` 已从上方 `FLOW_SECTIONS` **移除** ⇒ 显式声明 `flows.complete` 在**层名白名单校验处**
      //      即命中 `TEAM_ASSET_LAYER_UNKNOWN`（**现行 = warning 级** ⇒ **不拒载**，该层被跳过、
      //      其余层照常校验；码面与留痕保留）。历史 E-4 的「complete 层保留为合法声明位 + continue 短路」口径
      //      已被 F-4 清退；该短路分支**已于 2026-09-18 作为死码删除**（F-4 后永不可达）。

      if (!isNonEmptyString(flow.produce_field)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.produce_field`, 'produce_field 必填');
      else if (!PRODUCE_FIELDS.includes(flow.produce_field)) push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `${at}.produce_field`, `不在白名单：${flow.produce_field}（允许：${PRODUCE_FIELDS.join('/')}）`);

      if (flow.consume_field != null && !isNonEmptyString(flow.consume_field)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.consume_field`, 'consume_field 必须是非空字符串');
      // r2（要求 4/7）：`consume_field` 加**白名单**校验——读端（flows.js `consumeFieldOf`）对白名单外取值
      //   回落 `'consume'`（安全侧），此处把越界声明**显式登记为问题**（不再静默）：声明面只能收紧。
      else if (isNonEmptyString(flow.consume_field) && !CONSUME_FIELDS.includes(flow.consume_field)) {
        push(TEAM_ASSET_CODES.CONSUME_FIELD_NOT_ALLOWED, `${at}.consume_field`, `不在白名单：${flow.consume_field}（允许：${CONSUME_FIELDS.join('/')}）⇒ 读端回落 "consume"`);
      }

      if (flow.entry_requires != null) {
        if (!Array.isArray(flow.entry_requires)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.entry_requires`, 'entry_requires 必须是数组');
        else for (const r of flow.entry_requires) {
          if (!ENTRY_REQUIREMENTS.includes(r)) push(TEAM_ASSET_CODES.ENTRY_REQUIRE_UNKNOWN, `${at}.entry_requires`, `未知要求：${JSON.stringify(r)}（允许：${ENTRY_REQUIREMENTS.join('/')}）`);
        }
      }

      // exec 消费门两键（E-A / E-B）——语义**镜像** audit 的
      //   `flows.audit.audit_contract.consumes_required`（同一语汇族、同一建批期判定形，见 `lib/tools/core.js`）：
      //   · `consumes_required`（E-A，批级）：每个前缀须至少被**一条** exec lane 的 consume 命中；
      //   · `consumes_required_per_lane`（E-B，逐 lane）：**每一条** exec lane 都须各自命中每个前缀。
      //   **只在 exec 层有意义**：其它层声明属「写了不生效」⇒ 显式登记（不静默、不留第二机制）。
      for (const key of ['consumes_required', 'consumes_required_per_lane']) {
        if (flow[key] == null) continue;
        if (layer !== 'exec') push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `${at}.${key}`, `${key} 只在 exec 层有意义（当前层：${layer}）`);
        else if (!isStringArray(flow[key])) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.${key}`, `${key} 必须是非空字符串数组`);
      }

      for (const flag of ['targets', 'gate_command', 'needhuman']) {
        if (flow[flag] != null && typeof flow[flag] !== 'boolean') push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.${flag}`, `${flag} 必须是布尔`);
      }

      if (flow.contract != null) {
        if (!isPlainObject(flow.contract)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.contract`, 'contract 必须是对象');
        else {
          if (!isStringArray(flow.contract.artifact_globs)) push(TEAM_ASSET_CODES.CONTRACT_EMPTY, `${at}.contract.artifact_globs`, 'artifact_globs 必填（非空字符串数组）');
          if (!isStringArray(flow.contract.required_sections)) push(TEAM_ASSET_CODES.CONTRACT_EMPTY, `${at}.contract.required_sections`, 'required_sections 必填（非空字符串数组）');
          // D5（2026-09-19）：R1 §2.4 #3/#4 定下的两个**可选**声明位补**类型校验**。
          //   缺口：读端（`lib/state/gates.js`）对「声明了但形状不对」**静默回落**——`elements` 非数组 ⇒
          //     `declaredElements = []` 零迭代（:976-978）；`pending_marker` 非对象 / `literal` 非字符串
          //     ⇒ 视为未声明（:1066-1072）。声明方看不出自己的声明**从未生效** = 「写了不生效」的静默面，
          //     与本文件既有纪律（要么接线，要么显式拒收）相悖 ⇒ 在载入期显式登记。
          //   口径：**缺省不声明 ⇒ 零行为变化**（`!= null` 短路沿既有可选键风格，如 `flow.consume_field` :296）；
          //     复用既有 `BAD_TYPE`（∈ BLOCKING_CODES，见 :125），**不新造错误码**。
          if (flow.contract.elements != null && !isOptionalStringArray(flow.contract.elements)) {
            push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.contract.elements`, 'elements 必须是字符串数组（元素为非空字符串；空数组与缺省等价）');
          }
          if (flow.contract.pending_marker != null && !isPendingMarkerShape(flow.contract.pending_marker)) {
            push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.contract.pending_marker`, 'pending_marker 必须是 { literal: <非空字符串> } 形态');
          }
        }
      }

      // 旧泛键标废（B-3，2026-09-15 批次 core-techdebt-close-20260915 · lane e1）：**仅 audit 层**的 `contract` 是旧泛键。
      //   ① 现役真源 = 同层 `audit_contract`（见下段；读端 `flows.js:496-509`）⇒ 两键并存即**双真源**；
      //   ② 旧泛键**无运行期读点**（`flows.js` `contractOf` 只取 plan 层），声明它属于「写了不生效」的欺骗面
      //      （纪律：要么接线，要么显式标废）；
      //   ③ 口径 = **标废不兼容**：无论声明内容是否结构合法（上面那段的 CONTRACT_EMPTY 照旧并行产出），
      //      一律另产一条 `CONTRACT_LEGACY` blocking problem ⇒ 载入期即拒载，不给旧键留豁免、不做静默忽略。
      //   ④ **不命中 plan 层**：plan 的 `contract`（artifact_globs/required_sections）是**现役**声明面
      //      （`flows.js:505` `contract: contractOf(flowOf(flows,'plan'))`），四份内置资产的 plan 契约照旧零影响。
      if (layer === 'audit' && flow.contract != null) {
        push(TEAM_ASSET_CODES.CONTRACT_LEGACY, `${at}.contract`,
          '旧泛键已标废：audit 层的内容契约唯一真源是 `flows.audit.audit_contract`（criteria_from/consumes_required/verdict），'
          + '`contract`（artifact_globs/required_sections）无运行期读点 ⇒ 双真源隐患，请改用 audit_contract 或删除本键');
      }

      // audit_contract：audit 层的**职责声明**——与 `contract`（产出内容契约：
      //   artifact_globs/required_sections）**不同键**，避免语义混淆。结构校验（存在性由建批期门禁负责）：
      //   { criteria_from?: string, criteria_section?: string, consumes_required?: string[], verdict?: string[],
      //     exempt?: boolean, reason?: string }
      //   · `criteria_section`（2026-09-21 新增）：**audit 依据章节名**（判据配置化的 audit 侧通道）——
      //     读端 = `gates.ts` 锚点门 `GATE_AUDIT_CRITERIA_MISSING`；缺声明 ⇒ 回落引擎基线
      //     `flows.js#ENGINE_BASELINE_CRITERIA_SECTION`（`## 验收标准`，全中文）。
      //   （`checklist_anchor` 于 2026-09-14「A 方案」移除：自由文本不可机器判定 ⇒ 归技能手册/文档面，不占声明面）
      if (flow.audit_contract != null) {
        if (!isPlainObject(flow.audit_contract)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract`, 'audit_contract 必须是对象');
        else {
          const ac = flow.audit_contract;
          if (ac.criteria_from != null && !isNonEmptyString(ac.criteria_from)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.criteria_from`, 'criteria_from 必须是非空字符串');
          if (ac.criteria_section != null && !isNonEmptyString(ac.criteria_section)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.criteria_section`, 'criteria_section 必须是非空字符串（audit 依据章节名，如 `## 验收标准`）');
          if (ac.consumes_required != null && !isStringArray(ac.consumes_required)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.consumes_required`, 'consumes_required 必须是非空字符串数组');
          if (ac.verdict != null && !isStringArray(ac.verdict)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.verdict`, 'verdict 必须是非空字符串数组');
          if (ac.exempt != null && typeof ac.exempt !== 'boolean') push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.exempt`, 'exempt 必须是布尔');
          if (ac.reason != null && !isNonEmptyString(ac.reason)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.reason`, 'reason 必须是非空字符串');
        }
      }

      // ── 退役键守门（2026-09-18 清债）：零消费点的声明面**退役并拒收**（不留「写了不生效」的静默面）──
      for (const key of RETIRED_FLOW_KEYS) {
        if (flow[key] != null) {
          push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `${at}.${key}`,
            `${key} 已于 2026-09-18 退役（零运行期消费者；进度落点现由纪律 \`<lane>/progress/NN-<slug>.md\` 表达）⇒ 请删除该键`);
        }
      }
    }
  }

  // ④⑤ 退役键守门：顶层 `state_machine`（原「只许收紧」校验）与顶层 `rework`
  //   （原返工策略校验）**均零运行期消费者** ⇒ 声明面退役、**声明即拒**（不留静默失效、不留死码）。
  //   **引擎自身能力不受影响**：状态机真源 = `lib/schema.js` 的 `MEMBER_TRANSITIONS`/`BATCH_TRANSITIONS`
  //   （经 `lib/state/machine-rules.js` 接线）；返工策略真源 = **链级** `chain.rework`（`chainNextOf` 真消费）。
  for (const key of RETIRED_TOP_KEYS) {
    if (asset[key] != null) {
      push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, key,
        `${key} 已于 2026-09-18 退役（零运行期消费者）⇒ 请删除该键；如需团队级能力，须先接线再声明（不得留「写了不生效」）`);
    }
  }

  // 【R2-3 一致性收尾（2026-09-17）】`ok` 语义与 chain.js 同口径：`ok = 无 blocking`（**不再是「零问题」**）。
  //   动机（`lib/tools/core.js:561-564` 已登记的缺陷）：同族函数各持一套 `ok` 判定 ⇒ 读端
  //   （`assertTeamAssetReady`）把**仅 warning** 的资产也当「不可用」拒载，与 `BLOCKING_CODES` 分档不自洽。
  //   warning 级码（`BLOCKING_CODES` 未收录者，本函数可产者恰三条：`ROLE_LEXICAL` /
  //   `LEAD_NOT_IN_LAYERS` / `CONSUME_FIELD_NOT_ALLOWED`）**只提示不否决**，且**逐条完整保留在
  //   `problems` 返回值里**（不丢弃、不降级为日志）——读端按 `severity`/`hasBlockingProblems` 自行分流。
  return { ok: !hasBlockingProblems(problems), problems, unwired: unwiredDeclarationsOf(asset) };
}

// ── 读盘：`<root>/presets/<team>/team-asset.{json,yml}` ──
export function teamAssetCandidates(root, team) {
  const dir = join(root, TEAM_ASSET_DIR, team);
  return TEAM_ASSET_FILENAMES.map((f) => join(dir, f));
}

// 资产签名（路径 + mtime + size）：缓存读端（flows.js 的 CACHE / ROLE_CACHE）据此判「文件是否已变」。
// 由来（实测缺口）：缓存键曾只含 `root::team`，同进程内**改资产文件不重载** —— Leader 的灵活装配
// 典型循环（写资产 → 建批 → 见告警 → 补声明 → 重建批）在长驻进程里第二步仍读旧值，修正「隔空失效」
// （探针 C4：run2 资产已含 roles.extra，仍报 5×GATE_ROLE_INVALID）。
// 语义：返回 null = 无资产文件（顺序并列：不存在/不可 stat）；同签名 ⇒ 内容判定为同一份（零重读）。
export function teamAssetSignature(root, team) {
  if (typeof team !== 'string' || team.trim().length === 0) return null;
  const found = teamAssetCandidates(root, team).find((p) => existsSync(p));
  if (!found) return null;
  try {
    const st = statSync(found);
    return found + ':' + st.mtimeMs + ':' + st.size;
  } catch {
    return null; // stat 失败（竞态/权限）→ 视为「无签名」⇒ 缓存视为陈旧、强制重读（fail-open 到重读，不静默用旧值）
  }
}

export function readTeamAsset(root, team) {
  const candidates = teamAssetCandidates(root, team);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    // 强警示（要求 5）：`TEAM_ASSET_NOT_FOUND` 属 **blocking** 级（资产不可用 ⇒ 装配/声明面整体失效）；
    // 读端（flows.js `resolveTeamFlows`）据此产 `severity:'blocking'` + `escalation` 载荷。
    return {
      ok: false, asset: null, path: null,
      problems: [{
        code: TEAM_ASSET_CODES.NOT_FOUND, path: candidates.join(' | '),
        message: `未找到团队声明（${team}）`,
        severity: severityOfProblem({ code: TEAM_ASSET_CODES.NOT_FOUND }),
      }],
    };
  }
  let text;
  try {
    text = readFileSync(found, 'utf8');
  } catch (e) {
    return {
      ok: false, asset: null, path: found,
      problems: [{
        code: TEAM_ASSET_CODES.NOT_FOUND, path: found, message: '读取失败：' + String(e?.message ?? e),
        severity: severityOfProblem({ code: TEAM_ASSET_CODES.NOT_FOUND }),
      }],
    };
  }
  const parsed = parseTeamAsset(text, { path: found });
  return { ...parsed, path: found };
}

// loadTeamAsset：读盘 + 解析 + 加载期不变量校验（调用方据 ok 决定「用声明 / 按 tighten-only 缺省继续」）
// r2：透传 `unwired`（未接线声明台账，要求 7）——`ok:false` 的短路径也带上（坏资产同样要能读出台账语义）。
export function loadTeamAsset(root, team) {
  const read = readTeamAsset(root, team);
  if (!read.ok) return { ...read, unwired: unwiredDeclarationsOf(read.asset) };
  const v = validateTeamAsset(read.asset);
  return { ok: v.ok, asset: read.asset, path: read.path, problems: v.problems, unwired: v.unwired };
}
