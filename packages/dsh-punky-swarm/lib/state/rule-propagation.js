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
// RulePropagation：治理配置「变更 ⇒ 影响谁」的判定内核（L4 规则变更传播）。
//
// 定位：**纯函数内核**（无 IO、无全局状态、不抛），由调用方注入两个入参：
//   · `batch` —— 批次记录（形状 = 既有 store 记录）：`phase` + `lanes`（`{ laneId → 成员态 }` 映射）
//   · `rules` —— `loadRules(config)` 的返回值（含 `version` / `source` / `changedAt`）
// 本模块**只判定**；「打标落盘 / 事件留痕」的接线点归调用方（L9 侧单写），故此处不写盘、不发事件。
//
// 受影响集口径（与本批设计正文冻结一致）：
//   受影响集 = 批次内「**批未终态 ∧ lane 未终态**」的 lane
//   理由：本仓**没有「规则 → lane」的语义映射结构** ⇒ 细粒度归因**不可判**；而「非终态 lane」
//   **可枚举、可留痕、可判** ⇒ **宁可粗而可判，不要细而不可判**。
//   终态判定**单点复用** `lib/schema.js` 的 `isMemberTerminal` / `isBatchTerminal`（**禁**自建终态表）。
//
// 变更判定（`changed`）：
//   以 `rules.version`（**内容指纹**，单一计算点在 `state/machine-rules`）与**默认表指纹**比对
//   ⇒ **内容级**判定，而不是「配置里写没写」：一份恰好等于默认表的覆盖配置 ⇒ 内容未变 ⇒ `changed=false`。
//   `version` 缺失时（调用方未走 `loadRules`，但给了规则表）**就地补算**同一指纹；两者都不可得时
//   回落到 `source === 'config'` —— 该回落会在 `detail` 中**点名**，不静默。
//
// 变更面边界（**如实登记，不假装覆盖**）：本签名入参只有 `{ batch, rules }`，故**可判**的变更面是
//   `memberRules` / `batchRules`（内容指纹的真实覆盖面）。`capabilities.*` 与 `governance.hook.rules`
//   位于配置的其它分支、**不在本签名的入参可达范围内** ⇒ 本模块**不计入**其变更，只在 `detail` 里
//   点名「哪些面参与、哪些面不在本签名的可达面」。调用方若要在那两面变更时触发传播，须在其触发点
//   各判一次（或后续波次把这两面纳入入参），**不得**据本模块的 `changed=false` 反推「配置没变」。
import { isMemberTerminal, isBatchTerminal } from '../schema.js';
import { DEFAULT_RULES_VERSION, rulesFingerprint } from './machine-rules.js';
/** 变更面在配置上的候选位置（第 3、4 面**不在本签名入参可达范围内**，仅用于点名，不参与指纹）。 */
const FACE_KEYS = [
    ['memberRules', 'ratchet.memberRules'],
    ['batchRules', 'ratchet.batchRules'],
    ['capabilities', 'capabilities.*'],
    ['governance', 'governance.hook.rules'],
];
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
/** 取规则内容指纹：透传 `rules.version`；缺失则按规则表就地补算；均不可得 ⇒ null。 */
function versionOf(rules) {
    if (rules && typeof rules.version === 'string' && rules.version)
        return rules.version;
    if (rules && rules.memberRules && rules.batchRules) {
        return rulesFingerprint({ memberRules: rules.memberRules, batchRules: rules.batchRules });
    }
    return null;
}
/**
 * 判定「规则变更 ⇒ 哪些在途 lane 需复核」。
 *
 * **不抛**：形状不可判时返回空受影响集并在 `detail` 里**响亮点名** —— 本模块在被注入引擎热路径
 * （批次相位迁移）时，抛错会**阻断迁移**；而「打标」是**附加留痕**，其失败不应改变引擎行为。
 * ⇒ 宁可「少打标 + 点名」，不可「因附加面异常而阻断主流程」。
 */
export function evaluateRulePropagation(input) {
    const detail = [];
    const batch = asRecord(input?.batch);
    const rules = asRecord(input?.rules);
    // ── 变更判定 ──────────────────────────────────────────────────────────
    const version = versionOf(rules);
    let changed;
    if (version !== null) {
        changed = version !== DEFAULT_RULES_VERSION;
    }
    else {
        changed = rules?.source === 'config';
        detail.push('版本指纹不可得（既无 version 亦无 memberRules+batchRules）⇒ changed 回落为 source === \'config\'');
    }
    const facesOn = FACE_KEYS.filter(([key]) => rules != null && rules[key] != null).map(([, label]) => label);
    const facesOff = FACE_KEYS.filter(([key]) => rules == null || rules[key] == null).map(([, label]) => label);
    detail.push('规则指纹：' + (version ?? '(不可得)') + '；默认表指纹：' + DEFAULT_RULES_VERSION + ' ⇒ changed=' + String(changed));
    detail.push('参与判定的变更面：' + (facesOn.length > 0 ? facesOn.join(', ') : '(无)')
        + '；不在本签名可达面的变更面：' + facesOff.join(', '));
    // ── 受影响集判定 ──────────────────────────────────────────────────────
    if (!batch) {
        detail.push('⚠ 批次入参不可判（缺 batch 或非对象）⇒ 受影响集取空，**不冒险打标**');
        return { affected: [], changed, version, detail };
    }
    const phase = batch.phase;
    if (isBatchTerminal(phase)) {
        detail.push('批已终态（phase=' + String(phase) + '）⇒ 无在途 lane 需复核，受影响集取空');
        return { affected: [], changed, version, detail };
    }
    const lanes = asRecord(batch.lanes);
    if (!lanes) {
        detail.push('⚠ 批次 lane 面不可判（缺 lanes 或非对象映射）⇒ 受影响集取空，**不冒险打标**');
        return { affected: [], changed, version, detail };
    }
    detail.push('批未终态（phase=' + String(phase) + '）⇒ 逐 lane 判定');
    const affected = [];
    for (const laneId of Object.keys(lanes).sort()) {
        const state = lanes[laneId];
        if (isMemberTerminal(state)) {
            detail.push('lane ' + laneId + '=' + String(state) + ' 已终态 ⇒ 不打标');
        }
        else {
            affected.push(laneId);
            detail.push('lane ' + laneId + '=' + String(state) + ' 非终态 ⇒ **打「需复核」标**');
        }
    }
    detail.push('受影响集 = ' + String(affected.length) + ' / 总 lane ' + String(Object.keys(lanes).length));
    return { affected, changed, version, detail };
}
