import type { GovernanceConfig, GovernanceEscalationConfig, GovernancePrimitive, Rule } from './types.js';
export declare const GOVERNANCE_DEFAULTS: Readonly<{
    enabled: boolean;
    rules: readonly Rule[];
    defaults: Readonly<{
        deny: GovernancePrimitive;
    }>;
    flags: Readonly<{
        pause: boolean;
        narrow: boolean;
        defer: boolean;
    }>;
    escalation: Readonly<GovernanceEscalationConfig>;
}>;
interface ConfigGovernanceInput {
    enabled?: unknown;
    rules?: unknown;
    preset?: unknown;
    defaults?: {
        deny?: unknown;
    };
    flags?: {
        pause?: unknown;
        narrow?: unknown;
        defer?: unknown;
    };
    escalation?: {
        enabled?: unknown;
        threshold?: unknown;
        windowMs?: unknown;
        primitives?: unknown;
    };
}
export declare function validateRuleTable(rules: readonly unknown[]): {
    ok: boolean;
    errors: string[];
};
export declare function validatePresetRules(rules: unknown): {
    ok: boolean;
    errors: string[];
};
export declare function resolveGovernanceConfig(config: ConfigGovernanceInput | null | undefined, opts?: {
    warn?: (msg: string) => void;
    presetTable?: Readonly<Record<string, readonly Rule[]>>;
}): GovernanceConfig;
export {};
