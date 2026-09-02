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
  defaults?: { deny?: unknown };
  flags?: { pause?: unknown; narrow?: unknown; defer?: unknown };
  escalation?: {
    enabled?: unknown;
    threshold?: unknown;
    windowMs?: unknown;
    primitives?: unknown;
  };
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

export function resolveGovernanceConfig(config: ConfigGovernanceInput | null | undefined, opts?: { warn?: (msg: string) => void }): GovernanceConfig {
  const c = config ?? {};
  const warn = opts?.warn;
  const d = (c.defaults && typeof c.defaults === 'object' && !Array.isArray(c.defaults)) ? c.defaults : {};
  const f = (c.flags && typeof c.flags === 'object' && !Array.isArray(c.flags)) ? c.flags : {};
  return {
    // 缺省 = GOVERNANCE_DEFAULTS.enabled(true)，显式 enabled:false 才关（对齐 resolveWatchConfig 注释）
    enabled: c.enabled !== false,
    rules: Array.isArray(c.rules) ? c.rules as Rule[] : [...GOVERNANCE_DEFAULTS.rules],
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
