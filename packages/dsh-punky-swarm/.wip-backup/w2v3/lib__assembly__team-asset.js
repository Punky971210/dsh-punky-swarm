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
import { MEMBER_STATES, MEMBER_TRANSITIONS } from '../schema.js';

// ── 常量：可拔插面的白名单（引擎基础语义，声明不得越界）──
export const TEAM_ASSET_DIR = 'presets';
export const TEAM_ASSET_FILENAMES = Object.freeze(['team-asset.json', 'team-asset.yml']);
export const PRODUCE_LAYERS = Object.freeze(['plan', 'exec', 'audit']); // 有「产出存在性」语义的层
export const FLOW_SECTIONS = Object.freeze([...PRODUCE_LAYERS]);
// ↑ F-4（2026-09-15 用户裁决 Q-D=A，严控勿松）落点：原为 `Object.freeze([...PRODUCE_LAYERS, 'complete'])`，
//   现**移除**该层 ⇒ 显式声明 `flows.complete` 的团队资产在层名白名单校验处即拒载
//   （`TEAM_ASSET_LAYER_UNKNOWN`，∈ BLOCKING_CODES ⇒ 整份资产不可交付）。**不降为告警、不加兼容分支、
//   不为旧声明留豁免、不设「废弃但接受」集合**。`complete` 门禁白名单的唯一真源 = `flows.audit.audit_contract.verdict`。
//   注：本注释块置于声明行**之下**，以保持 `FLOW_SECTIONS` 声明仍在文件第 48 行（规格 A1 的行号锚）。
export const PRODUCE_FIELDS = Object.freeze(['produce', 'outputs']); // 产物字段名白名单
export const ENTRY_REQUIREMENTS = Object.freeze(['consume']); // 派发前可要求的项（白名单）
export const CONSUME_FIELDS = Object.freeze(['consume']); // 消费字段名白名单（r2：读端只能收紧，见 flows.js consumeFieldOf）
export const ESCALATIONS = Object.freeze(['human', 'none']);
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
  STATE_OVERRIDE_UNKNOWN_STATE: 'TEAM_ASSET_STATE_OVERRIDE_UNKNOWN_STATE',
  STATE_OVERRIDE_WIDENS: 'TEAM_ASSET_STATE_OVERRIDE_WIDENS',
  STATE_KIND_INVALID: 'TEAM_ASSET_STATE_KIND_INVALID',
  REWORK_INVALID: 'TEAM_ASSET_REWORK_INVALID',
  LEAD_NOT_IN_LAYERS: 'TEAM_ASSET_LEAD_NOT_IN_LAYERS',
  // 旧泛键标废（B-3，2026-09-15 批次 core-techdebt-close-20260915）：`flows.audit.contract` 是 **旧泛键**，
  //   现役真源 = `flows.audit.audit_contract.*`（读端 `flows.js:496-509` `auditContract`，consumer 为 entry/建批/complete 三门）。
  //   旧泛键**无任何运行期读点**（`contractOf` 只取 plan 层），声明它 = 写了不生效 + 与 audit_contract 构成双真源隐患 ⇒ 标废。
  //   口径：**显式标废但不留兼容分支**——声明即在载入期产 blocking problem（不静默忽略、不当作 warning 降级）。
  CONTRACT_LEGACY: 'TEAM_ASSET_CONTRACT_LEGACY',
});

// ── 问题严重级（r2 强警示面，要求 5 / design §6 `flows-unresolved`） ──
// 定位：团队资产缺失 / 团队名不可解析（`GATE_TEAM_ASSET_MISSING`）在 r1 只以**文本告警**出现
//   （`lib/tools/core.js:241-243`），调用方无法机器化区分「资产完全不可用」与「可用但退化」。
//   r2 给每条问题附 `severity`，并导出 `blockingProblemsOf`：读端据此决定是否升级为强警示。
//   **本批口径 = 强警示，不阻断建批**（无资产是既有合法形态；发射点在域外只读文件）——
//   详见 `flows.js` 的 `teamAssetEscalationOf`。
export const TEAM_ASSET_SEVERITY = Object.freeze({ blocking: 'blocking', warning: 'warning' });

// blocking = **资产不可用**（结构/必填面不成立 ⇒ 声明面整体不可交付）；
// 其余 = warning（**可用但退化**：引擎按 tighten-only 缺省侧继续，问题仍可读、不静默）。
const BLOCKING_CODES = Object.freeze([
  TEAM_ASSET_CODES.NOT_FOUND,
  TEAM_ASSET_CODES.BAD_JSON,
  TEAM_ASSET_CODES.BAD_TYPE,
  TEAM_ASSET_CODES.MISSING_FIELD,
  TEAM_ASSET_CODES.FIELD_NOT_ALLOWED,
  TEAM_ASSET_CODES.LAYER_UNKNOWN,
  TEAM_ASSET_CODES.ENTRY_REQUIRE_UNKNOWN,
  TEAM_ASSET_CODES.SKILLS_MISMATCH,
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
  Object.freeze({
    key: 'state_machine', at: 'state_machine',
    consumer: 'lib/state/machine-rules.js / lib/state/store.js',
    status: 'unwired', readEnd: '（无）',
    note: '加载期不变量校验已生效（只许收紧、越界入 problems）；运行期消费点属域外 ⇒ 显式标注未接线。'
      + '区分度：本条指**顶层团队声明键** `state_machine`——**确无运行期消费者**（仅加载期不变量校验），与**引擎级配置键**'
      + ' `config.ratchet` 不同：后者已于 A-① 接线（装配期注入 `lib/index.js:108-112` ⇒ 读点 `lib/state/store.js:155`），'
      + '故在 `gateStrength.unwired`（`lib/state/gates.ts` `unwiredEntriesOf`）里是**独立台账条目** `status:\'wired\'`，不占本条。',
  }),
  Object.freeze({
    key: 'progress_contract', at: 'flows.<layer>.progress_contract',
    consumer: '（本仓无实现语义）',
    status: 'unwired', readEnd: '（无）',
    note: '仅加载期结构校验（dir/naming 必填）；无任何运行期消费者',
  }),
  Object.freeze({
    key: 'rework', at: 'rework',
    consumer: 'lib/state/store.js',
    status: 'unwired', readEnd: '（无）',
    note: '仅加载期结构校验（allowed/max_attempts/escalate）；无任何运行期消费者',
  }),
  // [历史条目 · 已移除] `chain`（P1，2026-09-16 批次 p1-team-asset-mandatory-20260916 登记为 `status:'unwired'`）——
  //   `chain` 已于 **P2 接线**（批次 p2-chain-autodrive-20260916，lane e-chain）：
  //     ① 加载期静态校验 = `lib/assembly/chain.js` 的八条校验（纯函数；构造期于 `wave_plan` 原样透出码面，
  //        `createBatch` 之前 throw ⇒ 拒后零批次 JSON 落盘）；
  //     ② 运行期消费 = `lib/engine/chain-runner.js` 的推进（`member.settled` ⇒ 算下一环 ⇒ 自动派发 +
  //        `chain.step` 事件）；
  //     ③ 读端回显 = `batch_status` 的 `chain` 字段（`lib/tools/core.js`）。
  //   ⇒ 不再是「未接线声明」，条目**整条删除**（只改 `status` 不能消除误报：读端 `unwiredDeclarationsOf`
  //   只按「该键是否被声明」过滤、不读 `status`）。缺省口径（R5 向后兼容）保持不变：
  //   无 `chain` 声明 ⇒ 引擎缺省退化链 = 现行 3 层直线链 `plan→exec→audit`，字段映射/门禁/事件逐字不变。
  //   ⚠ 测试耦合（已登记）：`test/team-asset-mandatory.test.js` 的 P1-4a 断言本条**存在**（`key:'chain'`），
  //   随本次接线**必须同步改为「不得登记」**——测试面属 `e-tests` lane 写域，不在本 lane（`lib/**`）域内。
]);

/**
 * 该声明（**整份资产**或 `flows` 子对象）里**实际声明了**的未接线键（可读结果）。
 * @param source `loadTeamAsset().asset`（整份）或 `resolveTeamFlows().flows`（子对象）
 */
export function unwiredDeclarationsOf(source) {
  if (source === null || typeof source !== 'object') return [];
  const hasFlows = source.flows !== null && typeof source.flows === 'object';
  const flows = hasFlows ? source.flows : source;
  const flowHas = (key) => Object.values(flows ?? {}).some((f) => f !== null && typeof f === 'object' && f[key] != null);
  const topHas = (key) => hasFlows && source[key] != null;
  const declared = {
    // `consume_field` 键已随台账条目一并移除（S19① 已接线 ⇒ 不再是「未接线声明」；见 UNWIRED_DECLARATIONS 注）
    state_machine: topHas('state_machine'),
    progress_contract: flowHas('progress_contract'),
    rework: topHas('rework'),
    // `chain` 键已随台账条目一并移除（P2 已接线 ⇒ 不再入未接线台账；见 UNWIRED_DECLARATIONS 注）
  };
  return UNWIRED_DECLARATIONS.filter((d) => declared[d.key] === true).map((d) => ({ ...d }));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);

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
      for (const key of ['plan_leads', 'audit_leads']) {
        if (asset.roles[key] == null) continue;
        if (!Array.isArray(asset.roles[key])) { push(TEAM_ASSET_CODES.BAD_TYPE, 'roles.' + key, key + ' 必须是数组'); continue; }
        const seenLead = new Set();
        for (const r of asset.roles[key]) {
          if (!isNonEmptyString(r) || !ROLE_EXTRA_RE.test(r)) push(TEAM_ASSET_CODES.ROLE_LEXICAL, 'roles.' + key, `牵头角色词法非法：${JSON.stringify(r)}（要求 kebab-case）`);
          else if (seenLead.has(r)) push(TEAM_ASSET_CODES.ROLE_LEXICAL, 'roles.' + key, `牵头角色重复：${r}`);
          else {
            seenLead.add(r);
            if (!allLayerRoles.has(r)) push(TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS, 'roles.' + key, `牵头角色 ${r} 未出现在任何 layers[*].roles（声明悬空）`);
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

      // complete 段（**F-4 已清退**，2026-09-15 用户裁决 Q-D=A）：
      //   ① `require_audit_outcomes` 类型校验已删（E-4，legacy-retire-20260915）；`complete` 白名单**唯一真源**
      //      = `flows.audit.audit_contract.verdict`（读端 gates.ts `completeOutcomesOf`）。
      //   ② `'complete'` 已从上方 `FLOW_SECTIONS` **移除** ⇒ 显式声明 `flows.complete` 在**层名白名单校验处**
      //      即命中 `TEAM_ASSET_LAYER_UNKNOWN`（∈ BLOCKING_CODES）⇒ **整份资产拒载**（不降为告警、不加兼容分支、
      //      不为旧声明留豁免；历史 E-4 的「complete 层保留为合法声明位 + continue 短路」口径已被本条翻牌清退）。
      //   注：下方 `if (layer === 'complete') continue;` 自 F-4 起为**不可达死码**（白名单校验已 continue）；
      //   按「精准修改」本批不清理，登记为 gap-list G-1（独立清理项）。
      if (layer === 'complete') continue;

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

      for (const flag of ['targets', 'gate_command', 'needhuman']) {
        if (flow[flag] != null && typeof flow[flag] !== 'boolean') push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.${flag}`, `${flag} 必须是布尔`);
      }

      if (flow.contract != null) {
        if (!isPlainObject(flow.contract)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.contract`, 'contract 必须是对象');
        else {
          if (!isStringArray(flow.contract.artifact_globs)) push(TEAM_ASSET_CODES.CONTRACT_EMPTY, `${at}.contract.artifact_globs`, 'artifact_globs 必填（非空字符串数组）');
          if (!isStringArray(flow.contract.required_sections)) push(TEAM_ASSET_CODES.CONTRACT_EMPTY, `${at}.contract.required_sections`, 'required_sections 必填（非空字符串数组）');
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

      // audit_contract（P2，2026-09-14 用户裁决 B）：audit 层的**职责声明**——与 `contract`（产出内容契约：
      //   artifact_globs/required_sections）**不同键**，避免语义混淆。结构校验（存在性由建批期门禁负责）：
      //   { criteria_from?: string, consumes_required?: string[], verdict?: string[],
      //     exempt?: boolean, reason?: string }
      //   （`checklist_anchor` 于 2026-09-14「A 方案」移除：自由文本不可机器判定 ⇒ 归技能手册/文档面，不占声明面）
      if (flow.audit_contract != null) {
        if (!isPlainObject(flow.audit_contract)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract`, 'audit_contract 必须是对象');
        else {
          const ac = flow.audit_contract;
          if (ac.criteria_from != null && !isNonEmptyString(ac.criteria_from)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.criteria_from`, 'criteria_from 必须是非空字符串');
          if (ac.consumes_required != null && !isStringArray(ac.consumes_required)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.consumes_required`, 'consumes_required 必须是非空字符串数组');
          if (ac.verdict != null && !isStringArray(ac.verdict)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.verdict`, 'verdict 必须是非空字符串数组');
          if (ac.exempt != null && typeof ac.exempt !== 'boolean') push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.exempt`, 'exempt 必须是布尔');
          if (ac.reason != null && !isNonEmptyString(ac.reason)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.audit_contract.reason`, 'reason 必须是非空字符串');
        }
      }

      if (flow.progress_contract != null) {
        if (!isPlainObject(flow.progress_contract)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.progress_contract`, 'progress_contract 必须是对象');
        else {
          if (!isNonEmptyString(flow.progress_contract.dir)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.progress_contract.dir`, 'dir 必填');
          if (!isNonEmptyString(flow.progress_contract.naming)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.progress_contract.naming`, 'naming 必填');
        }
      }
    }
  }

  // ④ state_machine：只允许收紧/白名单扩展，不得删减内核态（S-2）
  if (asset.state_machine != null) {
    const sm = asset.state_machine;
    if (!isPlainObject(sm)) push(TEAM_ASSET_CODES.BAD_TYPE, 'state_machine', 'state_machine 必须是对象');
    else {
      if (sm.kind !== 'tighten-only') push(TEAM_ASSET_CODES.STATE_KIND_INVALID, 'state_machine.kind', `kind 必须是 'tighten-only'（收到：${JSON.stringify(sm.kind)}）`);
      if (sm.overrides != null) {
        if (!isPlainObject(sm.overrides)) push(TEAM_ASSET_CODES.BAD_TYPE, 'state_machine.overrides', 'overrides 必须是对象');
        else for (const [from, tos] of Object.entries(sm.overrides)) {
          const at = `state_machine.overrides.${from}`;
          if (!Object.prototype.hasOwnProperty.call(MEMBER_TRANSITIONS, from)) {
            push(TEAM_ASSET_CODES.STATE_OVERRIDE_UNKNOWN_STATE, at, `未知内核态：${from}（内核态：${MEMBER_STATES.join('/')}）`);
            continue;
          }
          if (!Array.isArray(tos)) { push(TEAM_ASSET_CODES.BAD_TYPE, at, '必须是数组'); continue; }
          const allowed = MEMBER_TRANSITIONS[from] ?? [];
          for (const to of tos) {
            if (!allowed.includes(to)) push(TEAM_ASSET_CODES.STATE_OVERRIDE_WIDENS, at, `只允许收紧：${from}→${to} 不在内核图谱内（内核允许：${allowed.join('/') || '（无）'}）`);
          }
        }
      }
    }
  }

  // ⑤ rework：返工策略（专业流程语义，可拔插）
  if (asset.rework != null) {
    const rw = asset.rework;
    if (!isPlainObject(rw)) push(TEAM_ASSET_CODES.BAD_TYPE, 'rework', 'rework 必须是对象');
    else {
      if (rw.allowed != null && typeof rw.allowed !== 'boolean') push(TEAM_ASSET_CODES.REWORK_INVALID, 'rework.allowed', '必须是布尔');
      if (rw.max_attempts != null && (!Number.isInteger(rw.max_attempts) || rw.max_attempts < 1)) push(TEAM_ASSET_CODES.REWORK_INVALID, 'rework.max_attempts', '必须是正整数');
      if (rw.escalate != null && !ESCALATIONS.includes(rw.escalate)) push(TEAM_ASSET_CODES.REWORK_INVALID, 'rework.escalate', `必须是 ${ESCALATIONS.join('/')}`);
    }
  }

  return { ok: problems.length === 0, problems, unwired: unwiredDeclarationsOf(asset) };
}

// ── 读盘：`<root>/presets/<team>/team-asset.{json,yml}` ──
export function teamAssetCandidates(root, team) {
  const dir = join(root, TEAM_ASSET_DIR, team);
  return TEAM_ASSET_FILENAMES.map((f) => join(dir, f));
}

// 资产签名（路径 + mtime + size）：缓存读端（flows.js 的 CACHE / ROLE_CACHE）据此判「文件是否已变」。
// 由来（实测缺口）：缓存键曾只含 `root::team`，同进程内**改资产文件不重载** —— Leader 的灵活装配
// 典型循环（写资产 → 建批 → 见告警 → 补声明 → 重建批）在长驻进程里第二步仍读旧值，修正「隔空失效」
// （探针 C4：run2 资产已含 roles.extra，仍报 5×GATE_ROLE_INVALID + 2×GATE_ROLE_MISSING）。
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
