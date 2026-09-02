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

// 6 治理原语枚举定义（G2）：常量数组 + 类型守卫 + 语义标签 + 原语→宿主决策映射。
// 蓝图：m2-detailed.md §3。纯函数、零依赖（结构映射，不 import 宿主）。
// 组合优先级（REQUIRE_APPROVAL > DENY > DEFER > NARROW > PAUSE）由 classify 归一（§4），本模块不做组合。

import type { GovernancePrimitive } from './types.js';

// 6 原语常量数组（单一事实源；satisfies 绑定 types.ts 联合防漂移，纯类型层校验）。
// 对照 hf.md:76-77（CAGE GovernanceDecision 六原语全在）。
export const GOVERNANCE_PRIMITIVES = [
  'ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'DEFER', 'NARROW', 'PAUSE',
] as const satisfies readonly GovernancePrimitive[];

// 中文语义标签（wiring 拒绝正文与收据 reason 用；U1-4 断言非空且互异）。
const PRIMITIVE_LABELS: Record<GovernancePrimitive, string> = {
  ALLOW: '放行',
  DENY: '拒绝',
  REQUIRE_APPROVAL: '需审批',
  DEFER: '延后',
  NARROW: '收窄',
  PAUSE: '暂停',
};

// 类型守卫：运行期等价 Array.includes 单点断言，断言仅类型层（对齐 schema.ts isMemberState 模式）。
export function isGovernancePrimitive(v: unknown): v is GovernancePrimitive {
  return GOVERNANCE_PRIMITIVES.includes(v as GovernancePrimitive);
}

// 原语 → 宿主 pre-execute 决策（蓝图 §3 映射列）：
//   DENY/DEFER/NARROW/PAUSE → {kind:'deny', reason}（2.2 简版统一 deny + 收据元信息）；
//   REQUIRE_APPROVAL → {kind:'ask', reason}（→ serviceAsk，HOST:3106,3303-3347）；
//   ALLOW → 'pass'（透传）。
export type PreDecision =
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string }
  | 'pass';

export function primitiveToPreDecision(d: GovernancePrimitive): PreDecision {
  switch (d) {
    case 'ALLOW':
      return 'pass';
    case 'REQUIRE_APPROVAL':
      return { kind: 'ask', reason: `工具调用需人工审批（原语 ${d}，${primitiveLabel(d)}）` };
    default: // DENY / DEFER / NARROW / PAUSE（2.2 统一 deny + 收据元信息）
      return { kind: 'deny', reason: `工具调用被治理护栏拒绝（原语 ${d}，${primitiveLabel(d)}）` };
  }
}

// 原语中文标签（测试断言与 decisions.ts 常量一致；实现可微调文案但须与此处一致）。
export function primitiveLabel(p: GovernancePrimitive): string {
  return PRIMITIVE_LABELS[p];
}
