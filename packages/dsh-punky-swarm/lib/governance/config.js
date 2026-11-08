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
import { isGovernancePrimitive } from './decisions.js';
const GOVERNANCE_DEFAULTS_RAW = {
    enabled: true,
    rules: [],
    toolBan: [],
    defaults: { deny: 'DENY' },
    flags: { pause: false, narrow: false, defer: false },
    escalation: {
        enabled: false,
        threshold: 3,
        windowMs: 600000,
        primitives: ['DENY', 'NARROW'],
    },
};
// escalation.primitives 合法值域（计入可配置子集；REQUIRE_APPROVAL 与状态门收据不可配入——红线）
const ESCALATION_PRIMITIVES = ['DENY', 'NARROW', 'DEFER', 'PAUSE'];
export const GOVERNANCE_DEFAULTS = Object.freeze({
    ...GOVERNANCE_DEFAULTS_RAW,
    escalation: Object.freeze({
        ...GOVERNANCE_DEFAULTS_RAW.escalation,
        primitives: Object.freeze([...GOVERNANCE_DEFAULTS_RAW.escalation.primitives]),
    }),
});
const RULE_MATCH_OPS = ['eq', 'gt', 'gte', 'lt', 'lte', 'in', 'regex'];
const VIOLATION_CATEGORIES = ['hard', 'pausable', 'narrowable', 'soft', 'manual_review', 'ftra', 'unknown'];
// 全表规则 id 唯一性校验（preset×preset / preset×inline / inline 内自重复 + 空/非 string id
//   → ok:false + 错误文案含重复 id 与次数。引擎 violations 不去重（kernel.ts 逐条 push）——
//   重复 id 同命中会双倍收据文案，故装载层拒绝（宁空勿半，绝不部分武装）。
export function validateRuleTable(rules) {
    const errors = [];
    const seen = new Map();
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r || typeof r !== 'object') {
            errors.push(`rule[${i}] 非对象（规则须为对象）`);
            continue;
        }
        const id = r.id;
        if (typeof id !== 'string' || id.length === 0) {
            errors.push(`rule[${i}] id 缺失/非 string（收据 ruleRefs 溯源需要 id）`);
            continue;
        }
        seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    for (const [id, n] of seen) {
        if (n > 1)
            errors.push(`duplicate rule id '${id}' (${n}x)：id 须全局唯一（引擎 violations 不去重，重复会双倍收据文案）`);
    }
    return { ok: errors.length === 0, errors };
}
export const TOOL_BAN_BEHAVIORS = ['file-write', 'tool-disabled', 'wait-sleep'];
export function validateToolBanEntries(entries) {
    const errors = [];
    if (!Array.isArray(entries))
        return { ok: false, errors: ['toolBan 须为数组'] };
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const at = `toolBan[${i}]`;
        if (!e || typeof e !== 'object') {
            errors.push(`${at} 非对象`);
            continue;
        }
        const tag = typeof e.id === 'string' && e.id.length > 0 ? `${at}(${String(e.id)})` : at;
        for (const k of ['id', 'code', 'message', 'tool']) {
            if (typeof e[k] !== 'string' || e[k].length === 0)
                errors.push(`${tag}.${k} 缺失/须为非空 string`);
        }
        if (!TOOL_BAN_BEHAVIORS.includes(String(e.behavior))) {
            errors.push(`${tag}.behavior 非法: ${String(e.behavior)}（合法: ${TOOL_BAN_BEHAVIORS.join('/')}）`);
        }
        if (e.category !== undefined && !VIOLATION_CATEGORIES.includes(String(e.category))) {
            errors.push(`${tag}.category 非法: ${String(e.category)}`);
        }
    }
    return { ok: errors.length === 0, errors };
}
export function validateToolBanTable(entries) {
    const errors = [];
    const seen = new Map();
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e || typeof e !== 'object') {
            errors.push(`toolBan[${i}] 非对象（条目须为对象）`);
            continue;
        }
        const id = e.id;
        if (typeof id !== 'string' || id.length === 0) {
            errors.push(`toolBan[${i}] id 缺失/非 string（收据 ruleRefs 溯源需要 id）`);
            continue;
        }
        seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    for (const [id, n] of seen) {
        if (n > 1)
            errors.push(`duplicate toolBan id '${id}' (${n}x)：id 须全局唯一（引擎 violations 不去重，重复会双倍收据文案）`);
    }
    return { ok: errors.length === 0, errors };
}
export function validatePresetRules(rules) {
    const errors = [];
    if (!Array.isArray(rules)) {
        return { ok: false, errors: ['preset rules 顶层须为数组（wrapper 结构：{"_meta":{...},"rules":[...]}）'] };
    }
    const seenIds = new Map();
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        const at = `rule[${i}]`;
        if (!rule || typeof rule !== 'object') {
            errors.push(`${at} 非对象`);
            continue;
        }
        const id = rule.id;
        if (typeof id !== 'string' || id.length === 0) {
            errors.push(`${at}.id 缺失/非 string`);
        }
        else {
            seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
        }
        const tag = typeof id === 'string' && id.length > 0 ? `${at}(${id})` : at;
        if (rule.tools !== undefined) {
            if (!Array.isArray(rule.tools) || !rule.tools.every((t) => typeof t === 'string' && t.length > 0)) {
                errors.push(`${tag}.tools 非法（须为 string 数组）`);
            }
        }
        const m = rule.match;
        if (!m || typeof m !== 'object') {
            errors.push(`${tag}.match 缺失/非对象（规则须声明匹配面）`);
        }
        else {
            const match = m;
            if (match.path !== undefined && (typeof match.path !== 'string' || !(match.path.startsWith('/') || match.path === ''))) {
                errors.push(`${tag}.match.path 非法（须为 JSON Pointer 或空串）`);
            }
            if (match.op !== undefined && !RULE_MATCH_OPS.includes(String(match.op))) {
                errors.push(`${tag}.match.op 非法: ${String(match.op)}（合法: ${RULE_MATCH_OPS.join('/')}）`);
            }
            if (String(match.op) === 'regex') {
                const pat = match.pattern;
                if (typeof pat !== 'string' || pat.length === 0) {
                    errors.push(`${tag}.match.pattern 缺失（regex 规则须带 pattern）`);
                }
                else {
                    try {
                        new RegExp(pat);
                    }
                    catch {
                        errors.push(`${tag}.match.pattern 不可编译: ${pat}`);
                    }
                }
            }
        }
        if (!Array.isArray(rule.violations) || rule.violations.length === 0) {
            errors.push(`${tag}.violations 缺失/为空（规则须产出违规描述）`);
        }
        else {
            for (const v of rule.violations) {
                const vo = v;
                if (!vo || typeof vo !== 'object') {
                    errors.push(`${tag}.violations 含非对象`);
                    continue;
                }
                if (typeof vo.code !== 'string' || vo.code.length === 0)
                    errors.push(`${tag}.violations[].code 缺失`);
                if (!VIOLATION_CATEGORIES.includes(String(vo.category))) {
                    errors.push(`${tag}.violations[].category 非法: ${String(vo.category)}`);
                }
                if (typeof vo.message !== 'string' || vo.message.length === 0)
                    errors.push(`${tag}.violations[].message 缺失`);
                if (vo.path !== undefined && typeof vo.path !== 'string')
                    errors.push(`${tag}.violations[].path 非法`);
            }
        }
        if (rule.narrow !== undefined) {
            if (!Array.isArray(rule.narrow) || rule.narrow.length === 0) {
                errors.push(`${tag}.narrow 非法（须为非空数组）`);
            }
            else {
                for (const b of rule.narrow) {
                    const bo = b;
                    if (!bo || typeof bo !== 'object' || typeof bo.path !== 'string' || bo.path.length === 0) {
                        errors.push(`${tag}.narrow[].path 缺失/非法（须为非空 string）`);
                    }
                }
            }
        }
    }
    for (const [id, n] of seenIds) {
        if (n > 1)
            errors.push(`duplicate rule id '${id}' (${n}x)：预设文件内 id 须唯一（跨 preset 重复由装载层 validateRuleTable 拒）`);
    }
    return { ok: errors.length === 0, errors };
}
function resolveEscalationConfig(raw, warn) {
    const e = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const d = GOVERNANCE_DEFAULTS.escalation;
    let threshold = d.threshold;
    if (typeof e.threshold === 'number' && Number.isInteger(e.threshold) && e.threshold >= 1) {
        threshold = e.threshold;
    }
    else if (e.threshold !== undefined) {
        warn?.('governance.hook.escalation.threshold 非法（需整数 ≥1），回退默认 ' + d.threshold);
    }
    let windowMs = d.windowMs;
    if (typeof e.windowMs === 'number' && Number.isFinite(e.windowMs) && e.windowMs >= 1000) {
        windowMs = e.windowMs;
    }
    else if (e.windowMs !== undefined) {
        warn?.('governance.hook.escalation.windowMs 非法（需毫秒数 ≥1000），回退默认 ' + d.windowMs);
    }
    let primitives = [];
    if (Array.isArray(e.primitives)) {
        const invalid = e.primitives.filter((p) => !ESCALATION_PRIMITIVES.includes(String(p)));
        if (invalid.length)
            warn?.('governance.hook.escalation.primitives 含不可配原语（REQUIRE_APPROVAL/状态门/未知值仅可 DENY/NARROW/DEFER/PAUSE）：' + invalid.join(', '));
        primitives = e.primitives.filter((p) => ESCALATION_PRIMITIVES.includes(String(p)));
    }
    if (!primitives.length)
        primitives = [...d.primitives];
    return {
        enabled: e.enabled === true,
        threshold,
        windowMs,
        primitives,
    };
}
function normalizePresetRefs(preset) {
    const errors = [];
    if (preset === undefined)
        return { refs: null, errors };
    if (typeof preset === 'string') {
        errors.push(`governance.hook.preset 单值字符串形态已废除（单选遗产）：'${preset}' → 请改数组 preset: ["${preset}"]（多选，可多项叠加）`);
        return { refs: null, errors };
    }
    if (Array.isArray(preset)) {
        if (preset.length === 0) {
            errors.push('governance.hook.preset 为空数组（空引用无意义，请省略该键或给注册 id）');
            return { refs: null, errors };
        }
        const refs = [];
        for (const p of preset) {
            if (typeof p !== 'string' || p.length === 0)
                errors.push(`governance.hook.preset 元素非法: ${JSON.stringify(p)}（须为注册 preset id string）`);
            else
                refs.push(p);
        }
        return { refs, errors };
    }
    errors.push(`governance.hook.preset 类型非法: ${JSON.stringify(preset)}（须为注册 preset id 数组，如 ["l1-sensitive","l3-tool-ban"]——多选语义，单值形态已废除）`);
    return { refs: null, errors };
}
export function resolveGovernanceConfig(config, opts) {
    const c = config ?? {};
    const warn = opts?.warn;
    const presetTable = opts?.presetTable;
    const presetBanTable = opts?.presetBanTable;
    const d = (c.defaults && typeof c.defaults === 'object' && !Array.isArray(c.defaults)) ? c.defaults : {};
    const f = (c.flags && typeof c.flags === 'object' && !Array.isArray(c.flags)) ? c.flags : {};
    let rules;
    let toolBan;
    if (c.preset !== undefined) {
        const { refs, errors: normErrors } = normalizePresetRefs(c.preset);
        const errs = [...normErrors];
        const merged = [];
        const mergedBan = [];
        if (refs !== null) {
            for (const ref of refs) {
                const found = presetTable?.[ref];
                const foundBan = presetBanTable?.[ref];
                const hasRules = Array.isArray(found);
                const hasBan = Array.isArray(foundBan);
                if (!hasRules && !hasBan) {
                    errs.push(`governance.hook.preset: 未知 preset id '${ref}'（注册 id 枚举：l1-sensitive / l2-resource / l3-tool-ban / l5-wait-ban；组合请用数组引用或直接写 inline rules / inline toolBan）`);
                }
                else {
                    if (hasRules)
                        merged.push(...found);
                    if (hasBan)
                        mergedBan.push(...foundBan);
                }
            }
        }
        const inline = Array.isArray(c.rules) ? c.rules : [];
        const inlineBan = Array.isArray(c.toolBan) ? c.toolBan : [];
        const finalBan = [...mergedBan, ...inlineBan];
        const final = [...merged, ...inline];
        const vBanEntries = validateToolBanEntries(finalBan);
        const vBan = validateToolBanTable(finalBan);
        if (errs.length > 0) {
            for (const e of errs)
                warn?.(`[governance] ${e}；装载失败回退空表（宁空勿半——出厂空表=零拦截，请修正后热更重挂生效）`);
            rules = [];
            toolBan = [];
        }
        else {
            if (vBanEntries.ok && vBan.ok) {
                toolBan = finalBan;
            }
            else {
                for (const e of vBanEntries.errors)
                    warn?.(`[governance] preset 装载失败（toolBan 形状）：${e}；回退空表（宁空勿半——修正后热更重挂生效）`);
                for (const e of vBan.errors)
                    warn?.(`[governance] preset 装载失败（toolBan）：${e}；回退空表（宁空勿半——修正重复 id 后热更重挂生效）`);
                toolBan = [];
            }
            const vShape = validatePresetRules(final);
            const v = validateRuleTable(final);
            if (vShape.ok && v.ok) {
                rules = final;
            }
            else {
                for (const e of vShape.errors)
                    warn?.(`[governance] preset 装载失败（rules 形状）：${e}；回退空表（宁空勿半——修正后热更重挂生效）`);
                for (const e of v.errors)
                    warn?.(`[governance] preset 装载失败：${e}；回退空表（宁空勿半——修正重复 id 后热更重挂生效）`);
                rules = [];
            }
        }
    }
    else {
        const inlineRules = Array.isArray(c.rules) ? c.rules : [...GOVERNANCE_DEFAULTS.rules];
        const vRulesShape = validatePresetRules(inlineRules);
        const vRulesTable = validateRuleTable(inlineRules);
        if (vRulesShape.ok && vRulesTable.ok) {
            rules = inlineRules;
        }
        else {
            for (const e of vRulesShape.errors)
                warn?.(`[governance] inline rules 装载失败（热加载通道 governance.hook.rules，形状）：${e}；回退空表（宁空勿半——修正后热更重挂生效）`);
            for (const e of vRulesTable.errors)
                warn?.(`[governance] inline rules 装载失败（热加载通道 governance.hook.rules）：${e}；回退空表（宁空勿半——修正重复 id 后热更重挂生效）`);
            rules = [];
        }
        const inlineBan = Array.isArray(c.toolBan) ? c.toolBan : [...GOVERNANCE_DEFAULTS.toolBan];
        const vBan = validateToolBanEntries(inlineBan);
        const uBan = validateToolBanTable(inlineBan);
        if (vBan.ok && uBan.ok) {
            toolBan = inlineBan;
        }
        else {
            for (const e of vBan.errors)
                warn?.(`[governance] inline toolBan 形状校验失败（热加载通道 governance.hook.toolBan）：${e}；回退空表（宁空勿半——修正坏条目后热更重挂生效）`);
            for (const e of uBan.errors)
                warn?.(`[governance] inline toolBan 装载失败（热加载通道 governance.hook.toolBan）：${e}；回退空表（宁空勿半——修正重复 id 后热更重挂生效）`);
            toolBan = [];
        }
    }
    return {
        enabled: c.enabled !== false,
        rules,
        toolBan,
        defaults: {
            deny: (isGovernancePrimitive(d.deny) && d.deny !== 'ALLOW') ? d.deny : GOVERNANCE_DEFAULTS.defaults.deny,
        },
        flags: {
            pause: f.pause === true,
            narrow: f.narrow === true,
            defer: f.defer === true,
        },
        escalation: resolveEscalationConfig(c.escalation, warn),
    };
}
