import type { GovernancePrimitive } from './types.js';
export declare const GOVERNANCE_PRIMITIVES: readonly ["ALLOW", "DENY", "REQUIRE_APPROVAL", "DEFER", "NARROW", "PAUSE"];
export declare function isGovernancePrimitive(v: unknown): v is GovernancePrimitive;
export type PreDecision = {
    kind: 'deny';
    reason: string;
} | {
    kind: 'ask';
    reason: string;
} | 'pass';
export declare function primitiveToPreDecision(d: GovernancePrimitive): PreDecision;
export declare function primitiveLabel(p: GovernancePrimitive): string;
