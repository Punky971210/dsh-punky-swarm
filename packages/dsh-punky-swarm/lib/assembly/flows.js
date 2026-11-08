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



/** 包根目录：**单点** = `lib/assets.js`（W1a/A-4 收敛；本文件不再自算 `import.meta.url` 深度）。 */
export { packageRoot } from '../assets.js';

export const ENGINE_BASELINE_CRITERIA_SECTION = '## 验收标准';

export const ENGINE_BASELINE_REQUIRED_SECTIONS = Object.freeze(['## 概述', '## 问题', '## 方案', '## 需求']);

export const ENGINE_BASELINE_PLAN_SECTIONS = Object.freeze([
  ...ENGINE_BASELINE_REQUIRED_SECTIONS,
  ENGINE_BASELINE_CRITERIA_SECTION,
  '## 约束',
]);

export function clearFlowCache() {
  // no-op：本模块已无缓存（`CACHE` 随资产面退役删除）。
}

/**
 * 解析某团队的 flows 声明。
 *
 * 【2026-09-27 · team-asset 全量退役】**资产读端已整体删除**：不再读盘、不再有缓存与资产签名，
 *   引擎也不再消费任何团队声明 ⇒ 本函数恒返回「**无声明**」事实（`ok:false` / `flows:null`）。
 *   下游一律按 **tighten-only 缺省** 处置 ⇒ flows 面**只走引擎基线**
 *   （`ENGINE_BASELINE_PLAN_SECTIONS` / `ENGINE_BASELINE_CRITERIA_SECTION` / `entryRequiresOf` 缺省侧）。
 *   导出**保形保留**（调用方形状零变化）；本身零副作用、零 I/O。
 * 【2026-10-08 · 批 `engine-techdebt-cleanup-20261008` G-1 评估（**T-4**，Leader 裁决 D-3）】
 *   复核消费者：**外部 lib 零消费**（除本文件内部自调用外无 importer）；**内部生产调用点 = 2**（`:140` `flowsForBatch` ← 被 `lib/state/gates.js:44` 消费；`:477` `flowsDeclarationOf`）
 *   ／测试消费者 = 3 文件／`scripts/audit/out/dead-code-classified.json` 既有计数 `prod:14 / testUse:14`。
 *   ⇒ **非死代码**：「被内部调用」即本函数的**正常形态**；(a) 内联/降私有属**风格优化、非债清理**，
 *   且须改**活门禁路径**而收益为 0、牵动 3 个测试文件 ⇒ **采 (b) 保留 + 订正注释**。
 * @returns {{ ok: boolean, team: string|null, flows: object|null, path: string|null, problems: string[],
 *            severity: 'none'|'strong'|'blocking', blocking: boolean, escalation: object|null }}
 *   恒 `flows:null` ⇒ 调用方按 **tighten-only** 处置（consume 强制不依赖团队声明，见 `entryRequiresOf`）。
 */
export function resolveTeamFlows(team, _opts = {}) {
  return {
    ok: false,
    team: typeof team === 'string' && team.trim().length > 0 ? team : (team ?? null),
    flows: null,
    path: null,
    problems: [],
    severity: 'none',
    blocking: false,
    escalation: null,
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

export function clearRoleCache() {
  // no-op：本模块已无角色缓存（`ROLE_CACHE` 随资产面退役删除）。
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
export function resolveTeamRoles(team, _opts = {}) {
  return {
    ok: false,
    team: typeof team === 'string' && team.trim().length > 0 ? team : (team ?? null),
    extra: [],
    layerRoles: [],
    layerRolesByLayer: {},
    path: null,
    problems: [],
  };
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

export function globMatchesPath(pattern, relPath) {
  if (matchGlob(pattern, relPath)) return true;
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

function presenceGlobMatches(expanded, relPath) {
  const ex = expanded && typeof expanded === 'object' ? expanded : { globs: [], explicit: [] };
  const raw = String(relPath ?? '').replace(/\\/g, '/');
  if (Array.isArray(ex.explicit) && ex.explicit.includes(raw)) return true;
  const globs = Array.isArray(ex.globs) ? ex.globs : [];
  return globs.some((g) => globMatchesPath(g, raw));
}

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
 * @param asset **【2026-09-27 已失效】**原为 `loadTeamAsset().asset`（读出未接线声明台账）；
 *   资产面退役后**不再被读**（`unwired` 恒 `[]`），形参保形保留以免调用方签名漂移。
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
    auditContract: null,
    unwired: [],
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
