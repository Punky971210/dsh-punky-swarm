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

// flows 解析器：把「层语义」从门禁硬编码搬到团队声明，**缺声明逐字回落现状**。
// ─────────────────────────────────────────────────────────────────────────────
// 语义契约（三条，后续切片不得违背）：
//   ① 缺声明 / 团队无声明（如 generic、或声明加载失败）→ 全部读端走 LEGACY_* 常量 = 与重构前逐字一致；
//   ② 声明存在但字段缺省 → 该字段回落 LEGACY_*（逐字段回落，不是整份回落）；
//   ③ 声明的**新增强制**（如 entry_requires: ['consume']）只在声明显式写出时生效 —— 显式翻牌，
//      绝不由「声明存在」隐式改变行为。
//
// 冷加载语义：声明是**包内资产**，随包分发、进程内缓存一次（重启生效），
//   不进 runtime.json 热更新面（热更新面仅 governance.hook 与 watch 探针参数）。
//
// 读端（见 lib/state/gates.js）：
//   entry     → enforcesConsumeEntry(flow)（legacy = consume 非空才校验）
//   plan 契约 → contractOf(flow)（legacy = 仅 `*spec.md` 查 `## 验收标准`/`## 约束`）
//   exit      → produceFieldOf(flow, layer)（legacy = exec→outputs / audit→produce / plan→produce）

import { fileURLToPath } from 'node:url';
import { loadTeamAsset } from './team-asset.js';

/** 包根目录（lib/assembly/flows.js → 包根；与 lib/assets.js packageRoot 同源口径）。 */
export function packageRoot() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/** legacy 产物字段（缺声明时逐字回落）。 */
export const LEGACY_PRODUCE_FIELD = Object.freeze({ plan: 'produce', exec: 'outputs', audit: 'produce' });

/** legacy plan 契约：仅对 `*spec.md` 逐个校验两个裸标题（子串包含）。 */
export const LEGACY_PLAN_CONTRACT = Object.freeze({
  artifact_globs: Object.freeze(['plan/*spec.md', '**/spec.md']),
  required_sections: Object.freeze(['## 验收标准', '## 约束']),
  legacySuffixMatch: true, // 额外保留「以 spec.md 结尾即校验」的旧口径（见 gates 实现）
});

const CACHE = new Map(); // key: `${pkgRoot}::${team}` → { ok, flows, path, problems, team }

/** 清缓存（测试/诊断用；生产不调用——声明是冷加载资产）。 */
export function clearFlowCache() {
  CACHE.clear();
}

/**
 * 解析某团队的 flows 声明。
 * @returns {{ ok: boolean, team: string|null, flows: object|null, path: string|null, problems: string[] }}
 *   缺声明/加载失败 → ok:false 且 flows:null（调用方一律回落 legacy）。
 */
export function resolveTeamFlows(team, { root = packageRoot(), useCache = true } = {}) {
  const key = root + '::' + String(team);
  if (useCache && CACHE.has(key)) return CACHE.get(key);
  let out;
  if (typeof team !== 'string' || team.trim().length === 0) {
    out = { ok: false, team: team ?? null, flows: null, path: null, problems: ['no-team'] };
  } else {
    const r = loadTeamAsset(root, team);
    out = {
      ok: r.ok === true && r.asset != null,
      team,
      flows: r.ok === true && r.asset ? (r.asset.flows ?? null) : null,
      path: r.path ?? null,
      problems: (r.problems ?? []).map((p) => p.code + (p.path ? '@' + p.path : '')),
    };
  }
  if (useCache) CACHE.set(key, out);
  return out;
}

/** 批次 → flows（批次记录 team；无 team → 无声明 → legacy）。 */
export function flowsForBatch(batch, opts = {}) {
  const team = batch && typeof batch === 'object' ? batch.team : null;
  if (typeof team !== 'string' || team.trim().length === 0) {
    return { ok: false, team: null, flows: null, path: null, problems: ['batch-without-team'] };
  }
  return resolveTeamFlows(team, opts);
}

/** 取某层声明（不存在 → null，调用方回落 legacy）。 */
export function flowOf(flows, layer) {
  if (!flows || typeof flows !== 'object' || !layer) return null;
  const f = flows[layer];
  return f !== null && typeof f === 'object' ? f : null;
}

/** 产物字段：声明优先，缺省回落 legacy。返回 null 表示该层无产物存在性校验（legacy 行为同样如此）。 */
export function produceFieldOf(flow, layer) {
  const f = flow && typeof flow.produce_field === 'string' ? flow.produce_field : null;
  if (f) return f;
  return LEGACY_PRODUCE_FIELD[layer] ?? null;
}

/** entry 强制项：**仅**显式声明 `entry_requires: ['consume']` 才返回 true（legacy = false）。 */
export function enforcesConsumeEntry(flow) {
  return !!(flow && Array.isArray(flow.entry_requires) && flow.entry_requires.includes('consume'));
}

/** 内容契约：声明优先；缺省 → null（调用方走 legacy 两标题口径）。 */
export function contractOf(flow) {
  const c = flow && flow.contract;
  return c !== null && typeof c === 'object' ? c : null;
}

/** 布尔开关：声明显式给出才生效（返回 true/false）；未给出 → null（= legacy 启用）。 */
export function flagOf(flow, name) {
  return flow && typeof flow[name] === 'boolean' ? flow[name] : null;
}

/** 是否启用某开关（legacyDefault 为缺声明时的现状取值）。 */
export function enabledByFlag(flow, name, legacyDefault = true) {
  const v = flagOf(flow, name);
  return v === null ? legacyDefault : v;
}

// ── 团队角色集（可拔插）──
// 语义：`roles.extra` = 引擎基础集之外的自定义角色名（词法 kebab-case）；
//       `roles.plan_leads` / `roles.audit_leads` = 该团队认可的**额外牵头角色**（与引擎基础集**并集**，不替换）。
// 缺声明/加载失败 → `{ ok:false, extra:[], planLeads:[], auditLeads:[] }`（调用方按 legacy 基础集判定）。
const ROLE_CACHE = new Map();
export function clearRoleCache() {
  ROLE_CACHE.clear();
}
export function resolveTeamRoles(team, { root = packageRoot(), useCache = true } = {}) {
  const key = root + '::' + String(team);
  if (useCache && ROLE_CACHE.has(key)) return ROLE_CACHE.get(key);
  const empty = { ok: false, team: team ?? null, extra: [], planLeads: [], auditLeads: [], path: null, problems: [] };
  let out = empty;
  if (typeof team === 'string' && team.trim().length > 0) {
    const r = loadTeamAsset(root, team);
    if (r.ok && r.asset) {
      const roles = r.asset.roles && typeof r.asset.roles === 'object' ? r.asset.roles : {};
      out = {
        ok: true,
        team,
        extra: Array.isArray(roles.extra) ? [...roles.extra] : [],
        planLeads: Array.isArray(roles.plan_leads) ? [...roles.plan_leads] : [],
        auditLeads: Array.isArray(roles.audit_leads) ? [...roles.audit_leads] : [],
        path: r.path ?? null,
        problems: [],
      };
    } else {
      out = { ...empty, problems: (r.problems ?? []).map((p) => p.code) };
    }
  }
  if (useCache) ROLE_CACHE.set(key, out);
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
  const patTail = String(pattern).replace(/\\/g, '/').split('/').pop();
  const pathTail = String(relPath).replace(/\\/g, '/').split('/').pop();
  return !!patTail && matchGlob(patTail, pathTail);
}

/**
 * 内容契约校验（声明驱动）：返回问题串数组（空 = 通过）。
 * 未命中 glob 的产物不做章节校验（JSON 可解析性由 gates 既有分支负责，与声明无关）。
 */
export function sectionProblemsOf(relPath, content, contract) {
  if (!contract) return [];
  const globs = Array.isArray(contract.artifact_globs) ? contract.artifact_globs : [];
  const sections = Array.isArray(contract.required_sections) ? contract.required_sections : [];
  if (!globs.some((g) => globMatchesPath(g, relPath))) return [];
  const text = typeof content === 'string' ? content : '';
  return sections.filter((s) => !text.includes(s)).map((s) => relPath + ' lacks "' + s + '"');
}
