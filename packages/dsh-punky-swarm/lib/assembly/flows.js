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

// flows 解析器：把「层语义」从门禁硬编码搬到团队声明。
// ─────────────────────────────────────────────────────────────────────────────
// 语义契约（**r2 拒绝免检版**，后续切片不得违背）：
//   ① **声明面只能收紧（tighten-only，原则①）**：读端的「缺声明」路径**一律按最严侧处置**，
//      不再回落成「免检」；
//   ② 声明存在但字段缺省 → 按该字段的 tighten-only 缺省（见各读端函数头注释），**不回落成放宽**；
//   ③ 声明的**新增强制**（如 entry_requires: ['consume']）只在声明显式写出时生效 —— 显式翻牌；
//      但「缺声明」不再是免检，而是**拒**（B1 零依赖拒派：consume 强制不依赖团队声明）。
//     legacy-retire-20260915（完全清退）：LEGACY_* 常量已删除——引擎基线常量 / 读端缺省是**唯一真源**
//     （`produceFieldOf` 缺声明返回 `null` = 信息性真空，与 `gateStrength.produceFieldDeclared` 同源）。
//
// 加载语义（**K1 订正，2026-09-14**）：**热生效**——缓存键含资产签名（路径 + mtime + size），
//   每次调用重验签名（`teamAssetSignature`）⇒ 资产改动在同进程内**下一次读端调用即生效（免重启）**。
//   原注释自述「冷加载 / 进程内缓存一次（重启生效）」与本模块实现**直接冲突**（convergence-design §10 K1），
//   此处**以实现为准**；独立印证：`docs/engine-intro.md:28`「资产改动以『路径 + mtime + size』签名判新旧，
//   改后即时生效（免重启）」。仍**不进** runtime.json 热更新面（热更新面仅 governance.hook 与 watch 探针参数）
//   —— 团队资产不是 config 覆盖层。
//
// 读端（见 lib/state/gates.js；**r2 生效口径**）：
//   entry      → entryRequiresOf(flow)（**缺声明 ⇒ enforced:true = 拒派**（tighten-only）；显式条目才按声明）
//                留痕读端 entryRequiresOf(flow)（区分「团队声明显式强制」与「引擎 tighten-only 缺省」）
//   plan 契约  → contractOf(flow)（缺声明 ⇒ null，调用方**必须**走引擎基线裸标题判据，禁空契约免检）
//                规范化展开读端 presenceGlobsOf(contract)（显式路径集合，**禁依赖末段回退**）
//   exit       → produceFieldsOf(flow, layer)（**恒为 produce ∪ outputs**，声明只能收窄不得放宽）
//                produceFieldOf(flow, layer) 降为**信息性**（声明字段名，仅用于降级留痕）
//   consume    → consumeFieldOf(flow, layer)（声明优先，缺省 `'consume'`；白名单外回落 + 问题可读）
//   零读端声明  → declarationSummaryOf(flows) 汇总 `unwired`（state_machine / progress_contract /
//                rework 的**未接线标注**，来源 team-asset.js 的台账；`consume_field` 已于 S19① 接线 ⇒ 不在台账）

import { fileURLToPath } from 'node:url';
import {
  loadTeamAsset, teamAssetSignature,
  TEAM_ASSET_CODES, TEAM_ASSET_SEVERITY, hasBlockingProblems, unwiredDeclarationsOf,
} from './team-asset.js';

/** 包根目录（lib/assembly/flows.js → 包根；与 lib/assets.js packageRoot 同源口径）。 */
export function packageRoot() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/**
 * 引擎基线：**验收标准（criteria）章节名** —— 判据「全中文」的**单一真源**（2026-09-21 用户裁定）。
 *
 * 消费者（两处 plan 判据门，**不许再写字面量**）：
 *   · `gates.ts` 锚点门 `GATE_AUDIT_CRITERIA_MISSING`（audit 派发前：consume 中的 plan 产物须带本章）；
 *   · `gates.ts` 契约门 `GATE_PLAN_CONTRACT` 的**缺声明分支**（见下 `ENGINE_BASELINE_PLAN_SECTIONS`）。
 *
 * **配置化通道**（声明面优先，缺声明回落本常量）：
 *   · plan 层内容契约：`flows.plan.contract.required_sections`（既有键）；
 *   · audit 层职责声明：`flows.audit.audit_contract.criteria_section`（本轮新增键）。
 *   ⇒ 规格与判据解耦：团队若用英文章节名，只需在资产里声明，代码零改动。
 */
export const ENGINE_BASELINE_CRITERIA_SECTION = '## 验收标准';

/**
 * 引擎基线 plan 契约判据章节（E-2 正名，legacy-retire-20260915）：缺声明（无 contract）时的**唯一真源**。
 * 原 `LEGACY_PLAN_CONTRACT` 死常量已删除（lib/test 零 import，从未被读端消费）；本常量承接
 * `gates.ts` plan 契约门的缺声明判据。**从 `ENGINE_BASELINE_CRITERIA_SECTION` 派生**（首项恒为 criteria 章）
 * ⇒ 「验收标准」章节名全仓只有一个字面量。
 */
export const ENGINE_BASELINE_PLAN_SECTIONS = Object.freeze([ENGINE_BASELINE_CRITERIA_SECTION, '## 约束']);

const CACHE = new Map(); // key: `${pkgRoot}::${team}` → { sig, out }（sig = 资产路径+mtime+size；变了即重读）

/** 清缓存（测试/诊断用；生产不调用——声明是冷加载资产）。
 *  【C1 判读（N2 第一批，docs/c1-wiring-audit-2026-09-22.md）】降级为测试隔离钩，**不接热更**：
 *  缓存是 sig 自愈型（资产 mtime/size 变即重读），热更/资产变更无需清。 */
export function clearFlowCache() {
  CACHE.clear();
}

/**
 * 解析某团队的 flows 声明。
 * @returns {{ ok: boolean, team: string|null, flows: object|null, path: string|null, problems: string[],
 *            severity: 'none'|'strong'|'blocking', blocking: boolean, escalation: object|null }}
 *   缺声明/加载失败 → ok:false 且 flows:null（调用方按 **tighten-only** 处置：缺声明路径不得放宽，
 *   consume 强制不依赖团队声明，见 `entryRequiresOf`）。
 *   `severity` / `blocking` / `escalation` = **强警示面**（读端据此机器化分流「资产完全不可用」与「可用但退化」；
 *   要求 5 / design §6「flows-unresolved」降级项）；本批**不阻断建批**（理由见 `teamAssetEscalationOf`）。
 */
export function resolveTeamFlows(team, { root = packageRoot(), useCache = true } = {}) {
  const key = root + '::' + String(team);
  const sig = teamAssetSignature(root, team);
  if (useCache) {
    const hit = CACHE.get(key);
    if (hit && hit.sig === sig) return hit.out; // 同签名 ⇒ 同一份资产，零重读
  }
  let out;
  if (typeof team !== 'string' || team.trim().length === 0) {
    out = {
      ok: false, team: team ?? null, flows: null, path: null, problems: ['no-team'],
      severity: 'none', blocking: false, escalation: null,
    };
  } else {
    const r = loadTeamAsset(root, team);
    const rawProblems = Array.isArray(r.problems) ? r.problems : [];
    const problems = rawProblems.map((p) => p.code + (p.path ? '@' + p.path : ''));
    out = {
      ok: r.ok === true && r.asset != null,
      team,
      flows: r.ok === true && r.asset ? (r.asset.flows ?? null) : null,
      path: r.path ?? null,
      problems,
      severity: severityOfProblems(rawProblems),
      blocking: hasBlockingProblems(rawProblems),
      escalation: teamAssetEscalationOf(team, rawProblems),
    };
  }
  if (useCache) CACHE.set(key, { sig, out });
  return out;
}

/** 问题严重级（强警示面）：任一 blocking ⇒ 'blocking'；否则有 warning ⇒ 'strong'；无问题 ⇒ 'none'。 */
function severityOfProblems(problems) {
  const list = Array.isArray(problems) ? problems : [];
  if (list.some((p) => p && p.severity === TEAM_ASSET_SEVERITY.blocking)) return 'blocking';
  if (list.some((p) => p && p.severity === TEAM_ASSET_SEVERITY.warning)) return 'strong';
  return 'none';
}

/**
 * 团队资产解析失败的**强警示载荷**（要求 5；`severity` / `blocking` / `problems` 供读端分流）。
 * **原「团队资产缺失」码已删**（勿回加）
 *   （2026-09-21 可达性审计：**码名已字面删除**，避免 grep 误当活码）：
 *   该码是同一语义的**第二生产点**（第一处 `lib/tools/core.js` 的死推点已随 C 项删除），
 *   保留它会让「已判死码」在两处回生 ⇒ 本载荷**不带码**，只带 severity/blocking/problems/note
 *   （读端按 `blocking` 分流即可，不依赖码名）。
 * 逐条 `problems` 自带其原始 `TEAM_ASSET_*` 码 ⇒ 归因能力不丢。
 * 口径：**强警示（不阻断）**——无资产是既有合法形态，阻断化 = 扩张门禁面。
 */
function teamAssetEscalationOf(team, problems) {
  const list = Array.isArray(problems) ? problems : [];
  if (list.length === 0) return null;
  return {
    team: team ?? null,
    severity: severityOfProblems(list),
    blocking: hasBlockingProblems(list),
    problems: list.map((p) => p.code + (p.path ? '@' + p.path : '')),
    note: '强警示（r2 口径，非阻断）：资产不可用 ⇒ 该团队的装配前缀 / 声明面整体失效（假绿灯面）。'
      + '归因请看 problems 里的 `TEAM_ASSET_*` 码（本载荷不再自带汇总码）。',
  };
}

/** 批次 → flows（批次记录 team；无 team → 无声明；调用方按 **tighten-only** 处置，不再回落免检）。 */
export function flowsForBatch(batch, opts = {}) {
  const team = batch && typeof batch === 'object' ? batch.team : null;
  if (typeof team !== 'string' || team.trim().length === 0) {
    return {
      ok: false, team: null, flows: null, path: null, problems: ['batch-without-team'],
      severity: 'none', blocking: false, escalation: null,
    };
  }
  return resolveTeamFlows(team, opts);
}

/** 取某层声明（不存在 → null，调用方走**引擎基线** tighten-only 缺省判据，非回落旧口径）。 */
export function flowOf(flows, layer) {
  if (!flows || typeof flows !== 'object' || !layer) return null;
  const f = flows[layer];
  return f !== null && typeof f === 'object' ? f : null;
}

/**
 * 产物字段（**信息性，r2 已降级**）：返回资产**声明**的字段名；缺声明 ⇒ `null`（信息性真空）。
 * ⚠ r2 的**被检面**已改为 `produceFieldsOf`（**produce ∪ outputs 并集**，声明只能收窄不得放宽）——
 *   本函数不再决定「门禁查哪个字段」，只供 `gates.ts` 的 `degrades[{kind:'produce-field-widened'}]`
 *   留痕与 `gateStrength.produceFieldDeclared` 读端使用。
 * ⚠ legacy-retire-20260915（E-3）：缺声明回落 `LEGACY_PRODUCE_FIELD` 已清退——原先「无声明团队 + 任务只声明
 *   `outputs`」会把 declaredField 虚构为 `'produce'` ⇒ 误报 `produce-field-widened` 留痕（失真）；
 *   null 化后**不留痕**（如实）。这是本批**唯一允许的非判定面演进**（规格 E-3 行明示）：
 *   exit 门被检面（`declaredArtifactsOf`，gates.ts 恒 produce∪outputs）零变化。
 * @param _layer 保留形参（读端签名稳定；缺声明信息面 null 化后本函数不再按层回落）
 */
export function produceFieldOf(flow, _layer) {
  const f = flow && typeof flow.produce_field === 'string' ? flow.produce_field : null;
  return f ?? null;
}

/**
 * 产物字段**被检面**（tighten-only，原则① / spec §3）：**恒为 `['produce','outputs']`**。
 * 依据：`plan/spec.md` §2.1 S8「`produce_field` 缩窄被检面 ⇒ 拒」——声明的产物字段**不得**把
 * 「另一字段里声明的产物」排除出被检面；`produce_field` 因此降为信息性字段（与 e1 的并集实现同源）。
 * @param _flow 保留形参（读端签名与 spec §3 逐字一致；本函数不读声明 ⇒ 恒并集）
 * @param _layer 同上
 */
export function produceFieldsOf(_flow, _layer) {
  return ['produce', 'outputs'];
}

/**
 * entry 强制的**留痕读端**（可读结果，不丢来源）：区分「团队资产显式声明」与「引擎 tighten-only 缺省」。
 * 用途：`gates.ts` 的 `requiredBy` 标注**已**改取本函数的 `source`（R-05 落地）——
 *   显式声明 ⇒ `team-asset:entry_requires`；缺声明/无资产 ⇒ `tighten-only-default`（引擎缺省）。
 *   该标注**只留痕、不参与判定**（B1 零依赖拒派不读它）。
 * ⚠ legacy-retire-20260915（E-5）：原布尔读端 `enforcesConsumeEntry`（lib 内零行为消费的死函数）已删除，
 *   本函数是 entry 强制面的**唯一读端**（`enforced` 布尔承载同一判定语义）。
 * @returns {{enforced: boolean, declared: boolean, values: string[], source: 'team-asset:entry_requires'|'tighten-only-default'}}
 */
export function entryRequiresOf(flow) {
  const declared = flow && Array.isArray(flow.entry_requires) ? flow.entry_requires : null;
  if (declared) {
    return {
      enforced: declared.includes('consume'), declared: true, values: [...declared],
      source: 'team-asset:entry_requires',
    };
  }
  return {
    enforced: true, declared: false, values: [],
    source: 'tighten-only-default',
  };
}

/**
 * 内容契约：声明优先；缺省 → `null`。
 * ⚠ tighten-only 要求：返回 `null` 时调用方**必须**走引擎基线裸标题判据
 *   （`## 验收标准` / `## 约束`，见 `gates.ts` 的 `planCriteriaProblems`）——**不得**把
 *   「无 contract」当作「无内容判据」（空契约免检）。本函数的 `null` 只是「无声明」事实，
 *   不是「免检」结论（spec §约束 8）。
 */
export function contractOf(flow) {
  const c = flow && flow.contract;
  return c !== null && typeof c === 'object' ? c : null;
}

/** 布尔开关：声明显式给出才生效（返回 true/false）；未给出 → null（= tighten-only 的「门禁生效」侧）。 */
export function flagOf(flow, name) {
  return flow && typeof flow[name] === 'boolean' ? flow[name] : null;
}

/** 是否启用某开关（**tighten-only**，原则① / design §7）。
 *  缺声明 ⇒ `true`（门禁**生效**侧）；放宽**只能**由资产显式写 `false`（逃生阀须显式声明 + 每次使用留痕）
 *  ⇒ 以 `false` 作为缺省值属「用缺省放宽」，直接拒（fail-closed）。
 *  @param strictDefault 缺声明时的取值；**只接受 true**（既有调用点 `gates.ts:575/604/650` 均传 true）
 */
export function enabledByFlag(flow, name, strictDefault = true) {
  if (strictDefault !== true) {
    throw new Error('enabledByFlag: strictDefault must be true — tighten-only 缺声明不得放宽（放宽须由资产显式声明 '
      + String(name) + ': false，见 design §7 逃生阀统一口径）');
  }
  const v = flagOf(flow, name);
  return v === null ? true : v;
}

/** `consume_field` 白名单（引擎基础语义，声明不得越界；与 team-asset.js 的 `CONSUME_FIELDS` 同源读端）。 */
export const CONSUME_FIELDS = Object.freeze(['consume']);

/**
 * consume 字段读端（spec §3）：声明优先（**限白名单**），缺省/越界 ⇒ 回落 `'consume'`。
 * 越界声明**不静默**：经 `consumeFieldProblemOf` 读出问题串（可读结果，不再丢弃 problems）。
 * ⚠ 接线状态：**已接线**（S19① 判据同源）——`lib/state/gates.ts` 经 `consumeFieldNameOf`（`:353-358`）用本读端
 *   取字段名，消费点 = entry 门 `:483` ／ 悬空产物面 `:384` ／ `gateStrength.consumeField` `:966-967`。
 *   可达行为受白名单 `CONSUME_FIELDS=['consume']` 限制（越界回落 + 问题可读）⇒ 已从台账 `UNWIRED_DECLARATIONS`
 *   移除（不再以「未接线」语义出现；禁「写了不生效」的欺骗面）。
 */
export function consumeFieldOf(flow, layer) {
  const f = flow && typeof flow.consume_field === 'string' ? flow.consume_field : null;
  if (f && CONSUME_FIELDS.includes(f)) return f;
  return 'consume';
}

/** `consume_field` 越界/非法声明的问题串（无问题 ⇒ null）。 */
function consumeFieldProblemOf(flow, layer) {
  const f = flow && typeof flow.consume_field === 'string' ? flow.consume_field : null;
  if (f === null || CONSUME_FIELDS.includes(f)) return null;
  return 'flows.' + String(layer ?? '(layer)') + '.consume_field=' + JSON.stringify(f)
    + ' 不在白名单 ' + JSON.stringify([...CONSUME_FIELDS]) + ' ⇒ 回落 "consume"（声明面只能收紧）';
}

// ── 团队角色集（可拔插）──
// 语义（三条，缺声明/加载失败 → 空集 ⇒ 调用方按引擎基础角色集判定）：
//   ① `layers[layer].roles` = 该团队的**角色清单**（技能映射的键、建批 lane 的 role 取值来源）；
//   ② `roles.extra` = 引擎基础集之外的**补充**角色名（与 ① 并集；可与 ① 重叠）；
//   ③ `roles.plan_leads` / `roles.audit_leads` = 该团队认可的**额外牵头角色**（与引擎基础牵头集并集，不替换）。
// 缺口修复（实测，2026-09-14）：`extra` 曾只读 ②，于是「按资产把自有角色写进 layers」这种最自然写法
//   建批时每个自定义角色被判 `GATE_ROLE_INVALID`——指引（放开层/角色/技能组装）
//   与白名单（8 基础角色 ∪ 盲审三角色）对不上。现以 `unionRoleVocabulary` 把 ①∪② 作为**该团队的角色词法集**，
//   白名单与资产声明面**同源**：声明了 = 可用（②变成可选补充，不再是隐藏必填项）。
const ROLE_CACHE = new Map(); // key → { sig, out }（sig 同 CACHE：改资产即时生效，不需重启）
/** 清角色缓存（测试隔离钩；C1 判读 = 降级不接热更，理由同 clearFlowCache——sig 自愈）。 */
export function clearRoleCache() {
  ROLE_CACHE.clear();
}
// 角色词法集（建批/装配声明共用的单一读端）：① 各层声明角色 ∪ ② roles.extra → 小写去重。
export function unionRoleVocabulary(teamRoles) {
  if (!teamRoles || typeof teamRoles !== 'object') return [];
  const out = [];
  const seen = new Set();
  const src = [
    ...(Array.isArray(teamRoles.layerRoles) ? teamRoles.layerRoles : []),
    ...(Array.isArray(teamRoles.extra) ? teamRoles.extra : []),
  ];
  for (const r of src) {
    if (typeof r !== 'string') continue;
    const n = r.trim().toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
export function resolveTeamRoles(team, { root = packageRoot(), useCache = true } = {}) {
  const key = root + '::' + String(team);
  const sig = teamAssetSignature(root, team);
  if (useCache) {
    const hit = ROLE_CACHE.get(key);
    if (hit && hit.sig === sig) return hit.out;
  }
  const empty = { ok: false, team: team ?? null, extra: [], layerRoles: [], layerRolesByLayer: {}, path: null, problems: [] };
  let out = empty;
  if (typeof team === 'string' && team.trim().length > 0) {
    const r = loadTeamAsset(root, team);
    if (r.ok && r.asset) {
      const roles = r.asset.roles && typeof r.asset.roles === 'object' ? r.asset.roles : {};
      const byLayer = {};
      const flat = [];
      const seen = new Set();
      const layers = r.asset.layers && typeof r.asset.layers === 'object' ? r.asset.layers : {};
      for (const [layer, def] of Object.entries(layers)) {
        const list = [];
        for (const raw of (def && Array.isArray(def.roles) ? def.roles : [])) {
          if (typeof raw !== 'string') continue;
          const n = raw.trim().toLowerCase();
          if (!n) continue;
          list.push(n);
          if (!seen.has(n)) { seen.add(n); flat.push(n); }
        }
        byLayer[layer] = list;
      }
      out = {
        ok: true,
        team,
        extra: Array.isArray(roles.extra) ? [...roles.extra] : [],
        layerRoles: flat,
        layerRolesByLayer: byLayer,
        path: r.path ?? null,
        problems: [],
      };
    } else {
      out = { ...empty, problems: (r.problems ?? []).map((p) => p.code) };
    }
  }
  if (useCache) ROLE_CACHE.set(key, { sig, out });
  return out;
}

/** 简易 glob（`*` 不跨 `/`；`**` 跨目录）→ 全串匹配；路径分隔符归一为 `/`。 */export function matchGlob(pattern, relPath) {
  if (typeof pattern !== 'string' || typeof relPath !== 'string') return false;
  const p = relPath.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^/]*';
    } else if ('\\^$.|?+()[]{}'.includes(ch)) {
      re += '\\' + ch;
    } else re += ch;
  }
  try {
    return new RegExp('^' + re + '$').test(p);
  } catch {
    return false;
  }
}

/**
 * glob 与产物路径匹配（含**末段回退**）：`plan/*spec.md` 这类带目录前缀的 glob，
 * 对**绝对路径产物**（`D:\\...\\plan\\spec.md`）不应失配——否则内容契约会被静默跳过，
 * 比 legacy 的「以 spec.md 结尾即校验」口径更松（复核发现的回归点）。
 * 回退规则：glob 的末段（最后一个 `/` 之后）与路径末段做 glob 匹配。
 */
export function globMatchesPath(pattern, relPath) {
  if (matchGlob(pattern, relPath)) return true;
  // 末段回退**仅对绝对路径**生效（动机同述：绝对路径产物带目录前缀不该失配），且需满足两条防「静默放宽」：
  //   ① 末段不得是纯通配 `**`（`**` 作末段会退化成「匹配任意路径」⇒ `plan/**` 命中 `exec/e1/o.md`）；
  //   ② **目录段也须对齐**：pattern 的目录段须按序出现在路径末段之前的对应位置
  //      （否则 `plan/*spec.md` 会命中 `D:/…/exec/design-spec.md` —— 只比文件名不跨不了目录）。
  // 2026-09-14 修复（两条均在实测中复现）。
  const raw = String(relPath).replace(/\\/g, '/');
  const isAbs = /^([A-Za-z]:)?\//.test(raw);
  if (!isAbs) return false;
  const patSegs = String(pattern).replace(/\\/g, '/').split('/');
  const patTail = patSegs[patSegs.length - 1];
  if (!patTail || patTail === '**') return false;
  const dirSegs = patSegs.slice(0, -1);
  const pathSegs = raw.split('/');
  const start = pathSegs.length - 1 - dirSegs.length;
  if (start < 0) return false;
  for (let i = 0; i < dirSegs.length; i++) {
    if (dirSegs[i] === '**') continue; // `**` 目录段 = 任意层级，跳过
    if (!matchGlob(dirSegs[i], pathSegs[start + i])) return false;
  }
  return matchGlob(patTail, pathSegs[pathSegs.length - 1]);
}

/**
 * plan 契约 `artifact_globs` 的**规范化展开**（spec §3 / §验收标准 I-41）：把 glob 展开为
 * 「**显式路径集合** + **目录锚定模式**」，使命中判定**不依赖 `globMatchesPath` 的末段回退**。
 *
 * 展开结果（可读结果，问题不丢）：
 *   - `explicit`   ：**无通配符**的字面路径 ⇒ 直接相等即命中（零匹配歧义）；
 *   - `anchored`   ：`{ dir, tail }`——末段**非** `**` 的目录锚定模式（如 `plan/*spec.md` ⇒
 *                    `{dir:'plan', tail:'*spec.md'}`）⇒ 目录段必须按序对齐，**不跨目录放宽**；
 *   - `unexpandable`：**无法显式化**的声明（末段为纯通配 `**`，如 `plan/**`）——`**` 作末段会退化成
 *                    「匹配任意路径」（末段回退缺陷的成因）⇒ 如实列出，要求声明方**显式枚举**，
 *                    不得依赖回退兜底（回归点：`test/audit-contract-gate.test.js:141-148`）。
 * @returns {{globs: string[], explicit: string[], anchored: {dir: string|null, tail: string}[], unexpandable: string[]}}
 */
function presenceGlobsOf(contract) {
  const globs = contract && Array.isArray(contract.artifact_globs) ? contract.artifact_globs : [];
  const explicit = [];
  const anchored = [];
  const unexpandable = [];
  const kept = [];
  for (const raw of globs) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const g = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    kept.push(g);
    const segs = g.split('/');
    const tail = segs[segs.length - 1];
    if (tail === '**') { unexpandable.push(g); continue; } // `**` 末段：无法锚定 ⇒ 须显式枚举
    if (!g.includes('*') && !g.includes('?') && !g.includes('[')) {
      if (!explicit.includes(g)) explicit.push(g);
      continue;
    }
    const dir = segs.slice(0, -1).filter((s) => s !== '').join('/');
    anchored.push({ dir: dir.length ? dir : null, tail });
  }
  return { globs: kept, explicit, anchored, unexpandable };
}

/**
 * 契约命中判定（**单点**）：显式路径集合优先，其余走结构匹配。
 * 结构匹配复用 `globMatchesPath`（其内建两条防静默放宽守卫：末段 `**` 不参与回退、目录段须对齐）⇒
 * 与 `test/audit-contract-gate.test.js:141-148` 的回归口径**同源**，本函数不引入第二套匹配逻辑。
 */
function presenceGlobMatches(expanded, relPath) {
  const ex = expanded && typeof expanded === 'object' ? expanded : { globs: [], explicit: [] };
  const raw = String(relPath ?? '').replace(/\\/g, '/');
  if (Array.isArray(ex.explicit) && ex.explicit.includes(raw)) return true;
  const globs = Array.isArray(ex.globs) ? ex.globs : [];
  return globs.some((g) => globMatchesPath(g, raw));
}

/**
 * 内容契约校验（声明驱动）：返回问题串数组（空 = 通过）。
 * 未命中 glob 的产物不做章节校验（JSON 可解析性由 gates 既有分支负责，与声明无关）。
 * r2 改动（spec §验收标准 I）：命中判定改由 `presenceGlobsOf` 的**规范化展开视图**驱动
 *   （`presenceGlobMatches`）——「放宽口径必须显式展开、不得依赖末段回退」由此**接线为唯一入口**。
 *   语义与改动前**逐字等价**（`plan/**` 对 exec 路径本就 false、`plan/*spec.md` 的跨目录回退本就被禁）。
 */
export function sectionProblemsOf(relPath, content, contract) {
  if (!contract) return [];
  const expanded = presenceGlobsOf(contract);
  const sections = Array.isArray(contract.required_sections) ? contract.required_sections : [];
  if (!presenceGlobMatches(expanded, relPath)) return [];
  const text = typeof content === 'string' ? content : '';
  return sections.filter((s) => !text.includes(s)).map((s) => relPath + ' lacks "' + s + '"');
}

// ── 声明面**可读汇总**（`gate_status.gateStrength` 的**数据来源**，要求 6 / design §6） ──
// 定位：`gates.ts` 的 `gateStrengthOf(batch)` 现**内联**从原始 flow 对象取值（`produceField` 恒并集、
//   `produceFieldDeclared` 读 `produce_field`、`entryRequires` 读 `entry_requires`、`consumeField` 恒
//   `{exec:'consume',audit:'consume'}`、`unwired` 恒硬编码）。本函数把同一批语义收敛成**单一读端**，
//   供 gateStrength / 诊断面板取数（接线点在 `gates.ts` = e1 写域、本批冻结 ⇒ 登记 gap）。
/**
 * flows 声明的**tighten-only 生效视图**（纯函数，不读盘）。
 * @param flows `resolveTeamFlows().flows`（原始声明；**本函数不改写它**——原样保留是 T18/T15 的前提）
 * @param asset 可选：`loadTeamAsset().asset`（用于读出**未接线声明**台账；缺省时按 flows 的键推断）
 */
export function declarationSummaryOf(flows, asset = null) {
  const layers = ['plan', 'exec', 'audit'];
  const produceFields = {};
  const produceFieldDeclared = {};
  const consumeFields = {};
  const consumeProblems = [];
  const entryRequires = {};
  const flags = {};
  for (const l of layers) {
    const f = flowOf(flows, l);
    produceFields[l] = [...produceFieldsOf(f, l)];
    produceFieldDeclared[l] = f && typeof f.produce_field === 'string' ? f.produce_field : null;
    consumeFields[l] = consumeFieldOf(f, l);
    const p = consumeFieldProblemOf(f, l);
    if (p) consumeProblems.push(p);
    entryRequires[l] = entryRequiresOf(f);
    for (const flag of ['targets', 'gate_command', 'needhuman']) {
      const v = flagOf(f, flag);
      if (v !== null) flags[l + '.' + flag] = v;
    }
  }
  const af = flowOf(flows, 'audit');
  const ac = af && af.audit_contract && typeof af.audit_contract === 'object' ? af.audit_contract : null;
  return {
    resolved: flows != null && typeof flows === 'object',
    produceFields,                             // 被检面（恒并集，tighten-only）
    produceFieldDeclared,                      // 信息性（不再决定被检面）
    consumeFields,                             // consume 字段（缺省/越界回落 'consume'）
    consumeProblems,                           // 越界声明的问题串（不丢）
    entryRequires,                             // { enforced, declared, values, source }
    flags,                                     // 显式声明的布尔开关（缺声明不出现 ⇒ 门禁生效侧）
    contract: contractOf(flowOf(flows, 'plan')),
    presenceGlobs: presenceGlobsOf(contractOf(flowOf(flows, 'plan'))), // plan 契约 glob 的规范化展开
    auditContract: ac
      ? { criteriaFrom: ac.criteria_from ?? null, consumesRequired: ac.consumes_required ?? null, verdict: ac.verdict ?? null, source: 'team-asset' }
      : null,
    // 零读端声明的**显式未接线标注**（要求 7）：来自 team-asset.js 的声明台账（单一来源）
    unwired: unwiredDeclarationsOf(asset ?? flows),
  };
}

/**
 * 团队声明面的端到端可读结果（解析 + 生效视图 + 强警示）：**gateStrength / 诊断面板的取数入口**。
 * 缺资产时 `flows:null` + `severity`/`escalation` 取强警示载荷，`summary` 仍给出 tighten-only 缺省语义。
 */
export function flowsDeclarationOf(team, opts = {}) {
  const r = resolveTeamFlows(team, opts);
  return {
    ok: r.ok, team: r.team, path: r.path, problems: r.problems,
    severity: r.severity, blocking: r.blocking, escalation: r.escalation,
    summary: declarationSummaryOf(r.flows),
  };
}
