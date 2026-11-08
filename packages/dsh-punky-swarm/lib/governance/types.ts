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


import type { NarrowBounds, NarrowResult } from './narrow.js';


export interface DeferMeta {
  deferId: string;
  retryAfterMs: number;
  until: string;
}

export interface PauseMeta {
  pauseToken: string;
  until: string;
}

export interface ReceiptAskMeta {
  channel: 'host-serviceAsk';
  initiated: string;
  requestId: string;
  outcome?: 'denied-no-approval' | 'denied-no-agent' | 'denied-rejected' | 'denied-cancelled' | 'unavailable' | 'allowed-once';
}

export type GovernancePrimitive =
  | 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'DEFER' | 'NARROW' | 'PAUSE';

export type EscalationPrimitive = 'DENY' | 'NARROW' | 'DEFER' | 'PAUSE';

export interface GovernanceEscalationConfig {
  enabled: boolean;
  threshold: number;
  windowMs: number;
  primitives: readonly EscalationPrimitive[];
}

export type ViolationCategory =
  | 'hard' | 'pausable' | 'narrowable' | 'soft' | 'manual_review' | 'ftra' | 'unknown';

export interface Violation {
  code: string;
  category: ViolationCategory;
  severity?: number;
  message: string;
  path?: string;
}

export interface Rule {
  id: string;
  tools?: string[];
  match: {
    path?: string;
    pattern?: string;
    op?: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'regex';
    value?: unknown;
  };
  violations: Violation[];
  narrow?: NarrowBounds[];
}

// 语义 = 「写通道路由」纪律：Agent 写文件走 edit / write / str-replace-editor 等在册工具，
//   不经 shell（pwsh）自建写路径落盘（编码头/BOM 易被写盘破坏，且不可逆）。
export type ToolBanBehavior = 'file-write' | 'tool-disabled' | 'wait-sleep';

export interface ToolBanEntry {
  id: string;
  tool: string;
  behavior: ToolBanBehavior;
  code: string;
  category?: ViolationCategory;
  message: string;
}

export interface GovernanceConfig {
  enabled: boolean;
  rules: Rule[];
  toolBan: ToolBanEntry[];
  defaults: { deny: GovernancePrimitive };
  flags: { pause: boolean; narrow: boolean; defer: boolean };
  escalation: GovernanceEscalationConfig;
}

export interface ReceiptAnchor {
  version: 1;
  alg: 'sha256';
  prevHash: string | null;
  hash: string;
}

export interface RefusalReceipt {
  receiptId: string;
  ts: string;
  tool: string; callId: string; sessionId: string | null;
  decision: { primitive: GovernancePrimitive; priority: number | null; reason: string };
  attemptedParams: unknown;
  narrowedParams?: NarrowResult;
  deferMeta?: DeferMeta;
  pauseMeta?: PauseMeta;
  ask?: ReceiptAskMeta;
  anchor?: ReceiptAnchor;
  ruleRefs: string[];
}

export interface KernelDecision {
  primitive: GovernancePrimitive;
  priority: number;
  reason: string;
  narrowedParams?: NarrowResult;
  ruleRefs: string[];
}
