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
export type GovernancePrimitive = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'DEFER' | 'NARROW' | 'PAUSE';
export type EscalationPrimitive = 'DENY' | 'NARROW' | 'DEFER' | 'PAUSE';
export interface GovernanceEscalationConfig {
    enabled: boolean;
    threshold: number;
    windowMs: number;
    primitives: readonly EscalationPrimitive[];
}
export type ViolationCategory = 'hard' | 'pausable' | 'narrowable' | 'soft' | 'manual_review' | 'ftra' | 'unknown';
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
export interface GovernanceConfig {
    enabled: boolean;
    rules: Rule[];
    defaults: {
        deny: GovernancePrimitive;
    };
    flags: {
        pause: boolean;
        narrow: boolean;
        defer: boolean;
    };
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
    tool: string;
    callId: string;
    sessionId: string | null;
    decision: {
        primitive: GovernancePrimitive;
        priority: number | null;
        reason: string;
    };
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
