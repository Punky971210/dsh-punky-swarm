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

// 治理配置默认值与解析（G5）：GOVERNANCE_DEFAULTS + resolveGovernanceConfig。
// 蓝图：m2-detailed.md §7（已敲定 2026-08-31：governance.hook.enabled=true 默认开启、可显式关闭）。
// M5-a（2026-09-02）：resolve 扩 escalation 段（D-5 敲定：扩 resolve 单点，remount JSON 比较器零改动——
//   escalation 任一子键变化经既有 dispose+重挂通道生效）。出厂默认关（enabled:false = 零计数零记录零升级）。
// M5-b（2026-09-03，preset-build）：resolve 扩 preset 装载键（preset-impl 设计 §2 敲定：引用键非路径）——
//   governance.hook.preset: string|string[] = 注册 preset id 枚举（loader 随包 PRESETS_DIR 装载展开）；
//   语义 = 保序拼接（preset 引用序展开 → inline rules 在后）→ 全表唯一性校验（validateRuleTable）→
//   重复/未知 id 装载失败回退 rules:[] + warn 逐条（宁空勿半，不 throw——resolve 在 boot/热更路径，
//   throw 爆炸面过大）；resolved 快照存展开后 rules（不存引用原值 → remount JSON 比较器零改动感知一切生效差异）；
//   出厂无 preset 键 → 空表零拦截不变（preset 不默认启用，cordis.patch.yml 不加默认值）。
// 对齐 resolveWatchConfig 模式（lib/schema.ts:236-255）：宽松输入接口（字段 unknown），
// 等价默认合并——缺省 = GOVERNANCE_DEFAULTS.enabled(true)，显式 enabled:false 才关。
// 空 rules → decide 恒 ALLOW（零行为变化，与 verify/watch/budget 默认开口径一致）。

import type { EscalationPrimitive, GovernanceConfig, GovernanceEscalationConfig, GovernancePrimitive, Rule } from './types.js';
import { isGovernancePrimitive } from './decisions.js';

// 默认值（蓝图 §7 yaml，【已敲定 2026-08-31】）：
//   enabled: true（可显式关闭）；rules: []（空表=零拦截）；defaults.deny: 'DENY'（fail-closed 兜底）；
//   flags: { pause: false, narrow: false, defer: false }（原语开关默认关 → P3/P4/P5 回退 DENY）
// M5-a escalation 默认（§4）：enabled:false（出厂零行为）/ threshold:3（与 failed-escalate 同值不同键）/
//   windowMs:600000（10 分钟滚动窗）/ primitives:['DENY','NARROW']（DEFER/PAUSE 默认不计可显式扩入）
// as const：'DENY'/true/false 字面量派生（deny: 'DENY' 绑定 GovernancePrimitive 防漂移，纯类型层校验）
const GOVERNANCE_DEFAULTS_RAW = {
  enabled: true,
  rules: [],
  defaults: { deny: 'DENY' },
  flags: { pause: false, narrow: false, defer: false },
  escalation: {
    enabled: false,
    threshold: 3,
    windowMs: 600000,
    primitives: ['DENY', 'NARROW'],
  },
} as const;

// escalation.primitives 合法值域（计入可配置子集；REQUIRE_APPROVAL 与状态门收据不可配入——§1.5 红线）
const ESCALATION_PRIMITIVES: readonly string[] = ['DENY', 'NARROW', 'DEFER', 'PAUSE'];

export const GOVERNANCE_DEFAULTS: Readonly<{
  enabled: boolean;
  rules: readonly Rule[];
  defaults: Readonly<{ deny: GovernancePrimitive }>;
  flags: Readonly<{ pause: boolean; narrow: boolean; defer: boolean }>;
  escalation: Readonly<GovernanceEscalationConfig>;
}> = Object.freeze({
  ...GOVERNANCE_DEFAULTS_RAW,
  escalation: Object.freeze({
    ...GOVERNANCE_DEFAULTS_RAW.escalation,
    primitives: Object.freeze([...GOVERNANCE_DEFAULTS_RAW.escalation.primitives]),
  }),
});

// 宽松输入接口（字段 unknown，只声明存在性，不预判合法值——resolve 内归一化守卫兜底）
interface ConfigGovernanceInput {
  enabled?: unknown;
  rules?: unknown;
  // M5-b：preset 装载引用键（string|string[] = 注册 preset id；宽松接口 unknown，resolve 内归一——
  // 仅接受注册 id 枚举，不接受任意路径：随包受控资产、确定性可校验、无路径逃逸/环境漂移面）
  preset?: unknown;
  defaults?: { deny?: unknown };
  flags?: { pause?: unknown; narrow?: unknown; defer?: unknown };
  escalation?: {
    enabled?: unknown;
    threshold?: unknown;
    windowMs?: unknown;
    primitives?: unknown;
  };
}

// ── M5-b 规则表校验纯函数（零 IO；resolve 与 preset-loader 共用，供单测直引）──

// 规则 match.op 合法值域 + violations.category 合法值域（对齐 types.ts Rule/Violation 契约，
// 与 classify.ts 消费面一致——非法 op/category 预设文件装载期早失败，见 validatePresetRules）
const RULE_MATCH_OPS: readonly string[] = ['eq', 'gt', 'gte', 'lt', 'lte', 'in', 'regex'];
const VIOLATION_CATEGORIES: readonly string[] = ['hard', 'pausable', 'narrowable', 'soft', 'manual_review', 'ftra', 'unknown'];

// 全表规则 id 唯一性校验（§2.2 F1 处置）：preset×preset / preset×inline / inline 内自重复 + 空/非 string id
//   → ok:false + 错误文案含重复 id 与次数。引擎 violations 不去重（kernel.ts:153 逐条 push）——
//   重复 id 同命中会双倍收据文案，故装载层拒绝（宁空勿半，绝不部分武装）。
export function validateRuleTable(rules: readonly unknown[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as Record<string, unknown> | null | undefined;
    if (!r || typeof r !== 'object') {
      errors.push(`rule[${i}] 非对象（规则须为对象）`);
      continue;
    }
    const id = (r as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`rule[${i}] id 缺失/非 string（收据 ruleRefs 溯源需要 id）`);
      continue;
    }
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) errors.push(`duplicate rule id '${id}' (${n}x)：id 须全局唯一（引擎 violations 不去重，重复会双倍收据文案）`);
  }
  return { ok: errors.length === 0, errors };
}

// 预设文件形状校验（§1.4，preset-loader 装载 preset 文件时执行——受控资产早失败）：
//   顶层 rules 数组；每条 id 非空 string / tools 可选（元素 string；内容规则显式白名单属语义约束
//   由 preset-rules 静态回归保证，不在此拒绝）/ match 对象（path 可选 string 以 / 开头或空、op 合法或缺省、
//   value/pattern 可选）/ violations 非空（code 非空 string、category 合法、message string、path 可选 string）/
//   narrow 可选数组（path 非空 string）；文件内 id 唯一；op==='regex' → pattern 非空且可编译。
//   （inline 规则形状沿现状宽容——不在此校验，仅 preset 文件受控资产早失败；唯一性对合并全表由 resolve 做。）
export function validatePresetRules(rules: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(rules)) {
    return { ok: false, errors: ['preset rules 顶层须为数组（wrapper 结构：{"_meta":{...},"rules":[...]}）'] };
  }
  const seenIds = new Map<string, number>();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as Record<string, unknown> | null | undefined;
    const at = `rule[${i}]`;
    if (!rule || typeof rule !== 'object') { errors.push(`${at} 非对象`); continue; }
    const id = rule.id;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`${at}.id 缺失/非 string`);
    } else {
      seenIds.set(id as string, (seenIds.get(id as string) ?? 0) + 1);
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
    } else {
      const match = m as Record<string, unknown>;
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
        } else {
          try { new RegExp(pat); } catch { errors.push(`${tag}.match.pattern 不可编译: ${pat}`); }
        }
      }
    }
    if (!Array.isArray(rule.violations) || rule.violations.length === 0) {
      errors.push(`${tag}.violations 缺失/为空（规则须产出违规描述）`);
    } else {
      for (const v of rule.violations) {
        const vo = v as Record<string, unknown> | null | undefined;
        if (!vo || typeof vo !== 'object') { errors.push(`${tag}.violations 含非对象`); continue; }
        if (typeof vo.code !== 'string' || vo.code.length === 0) errors.push(`${tag}.violations[].code 缺失`);
        if (!VIOLATION_CATEGORIES.includes(String(vo.category))) {
          errors.push(`${tag}.violations[].category 非法: ${String(vo.category)}`);
        }
        if (typeof vo.message !== 'string' || vo.message.length === 0) errors.push(`${tag}.violations[].message 缺失`);
        if (vo.path !== undefined && typeof vo.path !== 'string') errors.push(`${tag}.violations[].path 非法`);
      }
    }
    if (rule.narrow !== undefined) {
      if (!Array.isArray(rule.narrow) || rule.narrow.length === 0) {
        errors.push(`${tag}.narrow 非法（须为非空数组）`);
      } else {
        for (const b of rule.narrow) {
          const bo = b as Record<string, unknown> | null | undefined;
          if (!bo || typeof bo !== 'object' || typeof bo.path !== 'string' || bo.path.length === 0) {
            errors.push(`${tag}.narrow[].path 缺失/非法（须为非空 string）`);
          }
        }
      }
    }
  }
  for (const [id, n] of seenIds) {
    if (n > 1) errors.push(`duplicate rule id '${id}' (${n}x)：预设文件内 id 须唯一（跨 preset 重复由装载层 validateRuleTable 拒）`);
  }
  return { ok: errors.length === 0, errors };
}

// escalation 校验回退（§4 + §1.5）：
//   threshold 非法（非整数 / <1）→ 回退默认 3；windowMs 非法（非数 / <1000）→ 回退默认 600000；
//   primitives 仅接受 DENY/NARROW/DEFER/PAUSE（REQUIRE_APPROVAL 与状态门收据不可配入——非法值剔除，
//   剔空 → 回退默认 ['DENY','NARROW'] + warn 留痕（有 logger 时）。enabled 仅显式 true 才开（默认关）。
function resolveEscalationConfig(raw: ConfigGovernanceInput['escalation'], warn?: (msg: string) => void): GovernanceEscalationConfig {
  const e = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const d = GOVERNANCE_DEFAULTS.escalation;
  let threshold = d.threshold;
  if (typeof e.threshold === 'number' && Number.isInteger(e.threshold) && e.threshold >= 1) {
    threshold = e.threshold;
  } else if (e.threshold !== undefined) {
    warn?.('governance.hook.escalation.threshold 非法（需整数 ≥1），回退默认 ' + d.threshold);
  }
  let windowMs = d.windowMs;
  if (typeof e.windowMs === 'number' && Number.isFinite(e.windowMs) && e.windowMs >= 1000) {
    windowMs = e.windowMs;
  } else if (e.windowMs !== undefined) {
    warn?.('governance.hook.escalation.windowMs 非法（需毫秒数 ≥1000），回退默认 ' + d.windowMs);
  }
  let primitives: EscalationPrimitive[] = [];
  if (Array.isArray(e.primitives)) {
    const invalid = e.primitives.filter((p) => !ESCALATION_PRIMITIVES.includes(String(p)));
    if (invalid.length) warn?.('governance.hook.escalation.primitives 含不可配原语（REQUIRE_APPROVAL/状态门/未知值仅可 DENY/NARROW/DEFER/PAUSE）：' + invalid.join(', '));
    primitives = e.primitives.filter((p) => ESCALATION_PRIMITIVES.includes(String(p))) as EscalationPrimitive[];
  }
  if (!primitives.length) primitives = [...d.primitives]; // 未配置 / 全非法 → 回退默认
  return {
    enabled: e.enabled === true,
    threshold,
    windowMs,
    primitives,
  };
}

// preset 引用归一（§2.1/§2.3，纯函数）：undefined → null（未配置）；string → [string]；string[] 保序；
//   其余形态（数字/对象/数组内非 string/空串/空数组）→ errors（装载失败由 resolve 回退空表 + warn）。
function normalizePresetRefs(preset: unknown): { refs: string[] | null; errors: string[] } {
  const errors: string[] = [];
  if (preset === undefined) return { refs: null, errors };
  if (typeof preset === 'string') {
    if (preset.length === 0) errors.push('governance.hook.preset 为空串（须为注册 preset id）');
    return { refs: preset.length > 0 ? [preset] : null, errors };
  }
  if (Array.isArray(preset)) {
    if (preset.length === 0) {
      errors.push('governance.hook.preset 为空数组（空引用无意义，请省略该键或给注册 id）');
      return { refs: null, errors };
    }
    const refs: string[] = [];
    for (const p of preset) {
      if (typeof p !== 'string' || p.length === 0) errors.push(`governance.hook.preset 元素非法: ${JSON.stringify(p)}（须为注册 preset id string）`);
      else refs.push(p);
    }
    return { refs, errors };
  }
  errors.push(`governance.hook.preset 类型非法: ${JSON.stringify(preset)}（须为 string | string[] 注册 id）`);
  return { refs: null, errors };
}

export function resolveGovernanceConfig(
  config: ConfigGovernanceInput | null | undefined,
  opts?: { warn?: (msg: string) => void; presetTable?: Readonly<Record<string, readonly Rule[]>> },
): GovernanceConfig {
  const c = config ?? {};
  const warn = opts?.warn;
  const presetTable = opts?.presetTable;
  const d = (c.defaults && typeof c.defaults === 'object' && !Array.isArray(c.defaults)) ? c.defaults : {};
  const f = (c.flags && typeof c.flags === 'object' && !Array.isArray(c.flags)) ? c.flags : {};
  // M5-b preset 装载分支（§2.2 定稿：preset 展开序 → inline rules 在后；全表唯一性校验；失败回退空表+warn）：
  //   - 无 preset 键 → 完全沿现状（c.rules 直传/默认[]——零行为差强保证）；
  //   - preset 引用存在 → 归一/查表展开/拼接 inline → validateRuleTable；
  //     任一错误（类型非法/未知 id/重复 id/空 id）→ 回退 rules:[] + warn 逐条（宁空勿半、不 throw）。
  //   resolved 快照只存展开后 rules（不存引用原值）→ remount JSON 比较器零改动感知生效差异（§2.2.6）。
  let rules: Rule[];
  if (c.preset !== undefined) {
    const { refs, errors: normErrors } = normalizePresetRefs(c.preset);
    const errs = [...normErrors];
    const merged: Rule[] = [];
    if (refs !== null) {
      for (const ref of refs) {
        const found = presetTable?.[ref];
        // 缺 table（接线漏注入）或查无 → 未知 id 装载失败（出厂/缺省表不识别任何引用）
        if (!found || !Array.isArray(found)) {
          errs.push(`governance.hook.preset: 未知 preset id '${ref}'（注册 id 枚举：l1-sensitive / l2-resource / compose；自定义组合请用数组引用或直接写 inline rules）`);
        } else {
          merged.push(...found);
        }
      }
    }
    if (errs.length > 0) {
      for (const e of errs) warn?.(`[governance] ${e}；装载失败回退空表（宁空勿半——出厂空表=零拦截，请修正后热更重挂生效）`);
      rules = [];
    } else {
      const inline = Array.isArray(c.rules) ? c.rules as Rule[] : [];
      const final = [...merged, ...inline];
      const v = validateRuleTable(final);
      if (v.ok) {
        rules = final;
      } else {
        for (const e of v.errors) warn?.(`[governance] preset 装载失败：${e}；回退空表（宁空勿半——修正重复 id 后热更重挂生效）`);
        rules = [];
      }
    }
  } else {
    rules = Array.isArray(c.rules) ? c.rules as Rule[] : [...GOVERNANCE_DEFAULTS.rules];
  }
  return {
    // 缺省 = GOVERNANCE_DEFAULTS.enabled(true)，显式 enabled:false 才关（对齐 resolveWatchConfig 注释）
    enabled: c.enabled !== false,
    rules,
    // fail-closed 兜底（P0 硬化，harden-plan §5.1 B.3）：仅接受合法原语，否则 DENY；
    // 「兜底不可 ALLOW」——fail-closed 纪律（hook-eval A.4「unknown → DENY 绝不 ALLOW」）不允许把兜底配置成放行，
    //   defaults.deny==='ALLOW' → resolve 回退 DENY（推荐处置：回退+注释；classify 侧另有双保险防御）
    defaults: {
      deny: (isGovernancePrimitive(d.deny) && d.deny !== 'ALLOW') ? d.deny : GOVERNANCE_DEFAULTS.defaults.deny,
    },
    flags: {
      pause: f.pause === true,
      narrow: f.narrow === true,
      defer: f.defer === true,
    },
    // M5-a escalation 段（D-5）：并入 resolved 快照 → remount JSON 比较感知任一子键变化（默认关形态）
    escalation: resolveEscalationConfig(c.escalation, warn),
  };
}
