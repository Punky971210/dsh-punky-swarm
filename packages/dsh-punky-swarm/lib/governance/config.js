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
// 默认值（蓝图 §7 yaml，【已敲定 2026-08-31】）：
//   enabled: true（可显式关闭）；rules: []（空表=零拦截）；defaults.deny: 'DENY'（fail-closed 兜底）；
//   flags: { pause: false, narrow: false, defer: false }（原语开关默认关 → P3/P4/P5 回退 DENY）
// as const：'DENY'/true/false 字面量派生（deny: 'DENY' 绑定 GovernancePrimitive 防漂移，纯类型层校验）
const GOVERNANCE_DEFAULTS_RAW = {
    enabled: true,
    rules: [],
    defaults: { deny: 'DENY' },
    flags: { pause: false, narrow: false, defer: false },
};
export const GOVERNANCE_DEFAULTS = Object.freeze(GOVERNANCE_DEFAULTS_RAW);
export function resolveGovernanceConfig(config) {
    const c = config ?? {};
    const d = (c.defaults && typeof c.defaults === 'object' && !Array.isArray(c.defaults)) ? c.defaults : {};
    const f = (c.flags && typeof c.flags === 'object' && !Array.isArray(c.flags)) ? c.flags : {};
    return {
        // 缺省 = GOVERNANCE_DEFAULTS.enabled(true)，显式 enabled:false 才关（对齐 resolveWatchConfig 注释）
        enabled: c.enabled !== false,
        rules: Array.isArray(c.rules) ? c.rules : [...GOVERNANCE_DEFAULTS.rules],
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
    };
}
