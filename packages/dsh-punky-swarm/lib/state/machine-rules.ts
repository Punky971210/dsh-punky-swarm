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

// MachineRules：状态迁移规则表（棘轮形式化）
// 单一事实源：引用 lib/schema.ts 的 MEMBER_TRANSITIONS / BATCH_TRANSITIONS（不拷贝，schema.ts 零改动）
// 棘轮语义：默认规则 = 现行强约束（行为不变）；配置覆盖只许删（收紧）不许增（放宽）——
//   覆盖表出现默认表中不存在的迁移 → loadRules throw（启动即失败，fail-closed，棘轮不可绕过）；
//   allowRelax: true 为显式逃生门（默认 false，仅在部署侧明确授权时可用）。
// 纯逻辑零依赖（无 IO），可独立单测。
// 类型化说明：validateOverride 泛型化（T = MemberState|BatchPhase，覆盖表 Record<T, readonly T[]>）；
//   override 为配置输入 unknown（运行期校验兜底，fail-closed 语义零变更）；棘轮 throw 逻辑一字不动。
import { createHash } from 'node:crypto';

import { MEMBER_TRANSITIONS, BATCH_TRANSITIONS } from '../schema.js';
import type { MemberState, BatchPhase } from '../schema.js';
import type { BatchTransitionTable, TransitionTable } from '../types/contracts.js';

// 默认 = 现行强约束（与 schema 常量同引用，非拷贝）
// 显式标注通用形态：satisfies 字面量（8 键/5 键）经泛型 Record 匹配时推断不稳定（空数组元素 never 污染），
// 标注后 validateOverride<T> 稳定推断 T=MemberState/BatchPhase（运行期零变更，纯类型层）
export const DEFAULT_MEMBER_RULES: TransitionTable = MEMBER_TRANSITIONS;
export const DEFAULT_BATCH_RULES: BatchTransitionTable = BATCH_TRANSITIONS;

// ── 版本化（本批新增）：内容指纹 + 装配时刻 ────────────────────────────────
// version = 规则内容的 sha256 前 16 hex，**由内容计算**（非人工维护、非计数器）：
//   · 内容一变，version 必变；内容不变，version 跨进程恒等（可作对账锚点）；
//   · 规范化口径 = 递归**按键名排序**后序列化；**数组顺序不参与规范化** ——
//     无法在不引入语义假设的前提下判定某个数组是否「无序」（如 `memberRules[from]` 的目标集语义无序，
//     而其它数组可能有序）⇒ 保守取「顺序变了也算变」：宁可多报一次「需复核」，不可漏报。
// changedAt = 本次装配时刻（`loadRules` 调用时刻）的 ISO 串。**它不是「上次变更时间」**：
//   本仓唯一来源信号是 `source` 二元标记，无持久化变更历史 ⇒ 要给出「上次变更时间」必须引入持久化面
//   （超出本批范围）；此处如实以装配时刻承担该字段，**不假装知道历史**。
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

/** 对任意规则载荷取内容指纹（sha256 前 16 hex）。**单一计算点**（传播模块复用本函数，禁第二套）。 */
export function rulesFingerprint(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 16);
}

/** 默认规则表的内容指纹（模块加载期算一次即固定）——「规则是否非默认」的判据锚点。 */
export const DEFAULT_RULES_VERSION: string = rulesFingerprint({
  memberRules: DEFAULT_MEMBER_RULES,
  batchRules: DEFAULT_BATCH_RULES,
});

// 棘轮校验：覆盖表 must be 默认表的子集（按 from 键逐项：值必须是字符串数组且 ⊆ 默认 to 列表）。
// allowRelax=true 时仅做结构校验（键存在、值数组），放行新增迁移（显式逃生门）。
function validateOverride<T extends MemberState | BatchPhase>(
  defaultTable: Record<T, readonly T[]>,
  override: unknown,
  kind: string,
  allowRelax: boolean,
): Record<T, readonly T[]> | null {
  if (override == null) return null;
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('ratchet ' + kind + ' must be an object of { from: [to...] }');
  }
  const next = { ...defaultTable };
  for (const [from, tos] of Object.entries(override)) {
    if (!(from in defaultTable)) {
      throw new Error('ratchet ' + kind + ': unknown state "' + from + '" (ratchet cannot add states)');
    }
    const fromKey = from as T; // 单点断言：'from in defaultTable' 守卫后 from 必为 T 键（运行期守卫语义不变）
    if (!Array.isArray(tos) || tos.some((t: string) => typeof t !== 'string' || !t)) {
      throw new Error('ratchet ' + kind + '[' + from + '] must be an array of non-empty strings');
    }
    if (new Set(tos).size !== tos.length) {
      throw new Error('ratchet ' + kind + '[' + from + '] has duplicate targets');
    }
    if (!allowRelax) {
      for (const to of tos) {
        if (!defaultTable[fromKey].includes(to)) {
          throw new Error('ratchet ' + kind + ': relaxing transition "' + from + ' -> ' + to + '" is not allowed (ratchet; set allowRelax: true to override)');
        }
      }
    }
    next[fromKey] = [...tos];
  }
  return next;
}

// 加载规则表：config.ratchet = { memberRules?, batchRules?, allowRelax: false }（可选键，schema.ts Config 说明）
// 未配置 → 默认表（= 现行约束，行为不变）；配置覆盖 → 棘轮校验（非法 throw，fail-closed）。
// 返回 { memberRules, batchRules, source: 'default'|'config', version, changedAt }。
//   version / changedAt 为**本批新增的只增字段**（既有消费方按字段取用，不破坏形状）；
//   `source` 二元标记**保留**（既有读端与热更守卫依赖它）。
export function loadRules(
  config: { ratchet?: { memberRules?: unknown; batchRules?: unknown; allowRelax?: boolean } } | null | undefined,
): {
  memberRules: TransitionTable;
  batchRules: BatchTransitionTable;
  source: 'default' | 'config';
  version: string;
  changedAt: string;
} {
  const ratchet = config && typeof config === 'object' ? config.ratchet : undefined;
  const allowRelax = ratchet?.allowRelax === true;
  const memberOverride = ratchet?.memberRules;
  const batchOverride = ratchet?.batchRules;
  const changedAt = new Date().toISOString(); // 装配时刻（见上方 changedAt 说明）
  if (memberOverride == null && batchOverride == null) {
    return {
      memberRules: DEFAULT_MEMBER_RULES,
      batchRules: DEFAULT_BATCH_RULES,
      source: 'default',
      version: DEFAULT_RULES_VERSION,
      changedAt,
    };
  }
  const memberRules = validateOverride(DEFAULT_MEMBER_RULES, memberOverride, 'memberRules', allowRelax) ?? DEFAULT_MEMBER_RULES;
  const batchRules = validateOverride(DEFAULT_BATCH_RULES, batchOverride, 'batchRules', allowRelax) ?? DEFAULT_BATCH_RULES;
  return {
    memberRules,
    batchRules,
    source: 'config',
    version: rulesFingerprint({ memberRules, batchRules }),
    changedAt,
  };
}
