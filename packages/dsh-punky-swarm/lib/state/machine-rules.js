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
// Phase 2 类型化：validateOverride 泛型化（T = MemberState|BatchPhase，覆盖表 Record<T, readonly T[]>）；
//   override 为配置输入 unknown（运行期校验兜底，fail-closed 语义零变更）；棘轮 throw 逻辑一字不动。
import { MEMBER_TRANSITIONS, BATCH_TRANSITIONS } from '../schema.js';
// 默认 = 现行强约束（与 schema 常量同引用，非拷贝）
// 显式标注通用形态：satisfies 字面量（8 键/5 键）经泛型 Record 匹配时推断不稳定（空数组元素 never 污染），
// 标注后 validateOverride<T> 稳定推断 T=MemberState/BatchPhase（运行期零变更，纯类型层）
export const DEFAULT_MEMBER_RULES = MEMBER_TRANSITIONS;
export const DEFAULT_BATCH_RULES = BATCH_TRANSITIONS;
// 棘轮校验：覆盖表 must be 默认表的子集（按 from 键逐项：值必须是字符串数组且 ⊆ 默认 to 列表）。
// allowRelax=true 时仅做结构校验（键存在、值数组），放行新增迁移（显式逃生门）。
function validateOverride(defaultTable, override, kind, allowRelax) {
    if (override == null)
        return null;
    if (typeof override !== 'object' || Array.isArray(override)) {
        throw new Error('ratchet ' + kind + ' must be an object of { from: [to...] }');
    }
    const next = { ...defaultTable };
    for (const [from, tos] of Object.entries(override)) {
        if (!(from in defaultTable)) {
            throw new Error('ratchet ' + kind + ': unknown state "' + from + '" (ratchet cannot add states)');
        }
        const fromKey = from; // 单点断言：'from in defaultTable' 守卫后 from 必为 T 键（运行期守卫语义不变）
        if (!Array.isArray(tos) || tos.some((t) => typeof t !== 'string' || !t)) {
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
// 返回 { memberRules, batchRules, source: 'default'|'config' }。
export function loadRules(config) {
    const ratchet = config && typeof config === 'object' ? config.ratchet : undefined;
    const allowRelax = ratchet?.allowRelax === true;
    const memberOverride = ratchet?.memberRules;
    const batchOverride = ratchet?.batchRules;
    if (memberOverride == null && batchOverride == null) {
        return { memberRules: DEFAULT_MEMBER_RULES, batchRules: DEFAULT_BATCH_RULES, source: 'default' };
    }
    const memberRules = validateOverride(DEFAULT_MEMBER_RULES, memberOverride, 'memberRules', allowRelax) ?? DEFAULT_MEMBER_RULES;
    const batchRules = validateOverride(DEFAULT_BATCH_RULES, batchOverride, 'batchRules', allowRelax) ?? DEFAULT_BATCH_RULES;
    return { memberRules, batchRules, source: 'config' };
}
