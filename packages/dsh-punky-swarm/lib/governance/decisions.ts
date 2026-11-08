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


import type { GovernancePrimitive } from './types.js';

export const GOVERNANCE_PRIMITIVES = [
  'ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'DEFER', 'NARROW', 'PAUSE',
] as const satisfies readonly GovernancePrimitive[];

const PRIMITIVE_LABELS: Record<GovernancePrimitive, string> = {
  ALLOW: '放行',
  DENY: '拒绝',
  REQUIRE_APPROVAL: '需审批',
  DEFER: '延后',
  NARROW: '收窄',
  PAUSE: '暂停',
};

export function isGovernancePrimitive(v: unknown): v is GovernancePrimitive {
  return GOVERNANCE_PRIMITIVES.includes(v as GovernancePrimitive);
}

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
    default:
      return { kind: 'deny', reason: `工具调用被治理护栏拒绝（原语 ${d}，${primitiveLabel(d)}）` };
  }
}

export function primitiveLabel(p: GovernancePrimitive): string {
  return PRIMITIVE_LABELS[p];
}
