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
const FRIA_CONFIDENCE_THRESHOLD = 0.70;
const FALLBACK_PRIORITY = 7;
function messagesOf(violations, category) {
    const msgs = violations.filter((v) => v.category === category).map((v) => v.message);
    return msgs.length > 0 ? msgs.join('; ') : category;
}
export function classifyViolation(input) {
    const { violations, flags } = input;
    const has = (cat) => violations.some((v) => v.category === cat);
    const hasHard = has('hard');
    const conf = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
        ? input.confidence
        : 0;
    if (has('ftra')) {
        return { primitive: 'REQUIRE_APPROVAL', priority: 0, reason: `[P0] 边界人工介入（ftra）: ${messagesOf(violations, 'ftra')}` };
    }
    if (has('manual_review') && !hasHard) {
        return { primitive: 'REQUIRE_APPROVAL', priority: 1, reason: `[P1] 需人工复核（manual_review）: ${messagesOf(violations, 'manual_review')}` };
    }
    if (hasHard) {
        return { primitive: 'DENY', priority: 2, reason: `[P2] 硬性违规（hard）: ${messagesOf(violations, 'hard')}` };
    }
    if (has('pausable')) {
        return flags.pause
            ? { primitive: 'PAUSE', priority: 3, reason: `[P3] 暂停执行（pausable）: ${messagesOf(violations, 'pausable')}` }
            : { primitive: 'DENY', priority: 3, reason: `[P3] 可暂停违规（pausable，flag 未开启）回退拒绝: ${messagesOf(violations, 'pausable')}` };
    }
    if (has('narrowable')) {
        return flags.narrow
            ? { primitive: 'NARROW', priority: 4, reason: `[P4] 参数收窄（narrowable）: ${messagesOf(violations, 'narrowable')}` }
            : { primitive: 'DENY', priority: 4, reason: `[P4] 可收窄违规（narrowable，flag 未开启）回退拒绝（含收窄指引语义）: ${messagesOf(violations, 'narrowable')}` };
    }
    if (has('soft') && conf < FRIA_CONFIDENCE_THRESHOLD) {
        return flags.defer
            ? { primitive: 'DEFER', priority: 5, reason: `[P5] 软违规延后（soft, confidence=${conf.toFixed(2)}）: ${messagesOf(violations, 'soft')}` }
            : { primitive: 'DENY', priority: 5, reason: `[P5] 软违规（soft, confidence=${conf.toFixed(2)}，flag 未开启）回退拒绝: ${messagesOf(violations, 'soft')}` };
    }
    if (has('soft') && conf >= FRIA_CONFIDENCE_THRESHOLD) {
        return { primitive: 'REQUIRE_APPROVAL', priority: 6, reason: `[P6] 软违规置信达标转人工审批（soft, confidence=${conf.toFixed(2)}）: ${messagesOf(violations, 'soft')}` };
    }
    const unclassified = violations.filter((v) => v.category === 'unknown' || v.category === undefined);
    const unclassifiedMsgs = unclassified.length > 0
        ? unclassified.map((v) => v.message).join('; ')
        : '未分类违规';
    const denyConfig = input.defaults?.deny ?? 'DENY';
    const denyPrimitive = denyConfig === 'ALLOW' ? 'DENY' : denyConfig;
    return {
        primitive: denyPrimitive,
        priority: FALLBACK_PRIORITY,
        reason: `[fail-closed] 未分类违规 → ${denyPrimitive}: ${unclassifiedMsgs}`,
    };
}
