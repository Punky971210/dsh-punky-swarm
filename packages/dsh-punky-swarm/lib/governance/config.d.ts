import type { GovernanceConfig, GovernancePrimitive, Rule } from './types.js';
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
}>;
interface ConfigGovernanceInput {
    enabled?: unknown;
    rules?: unknown;
    defaults?: {
        deny?: unknown;
    };
    flags?: {
        pause?: unknown;
        narrow?: unknown;
        defer?: unknown;
    };
}
export declare function resolveGovernanceConfig(config: ConfigGovernanceInput | null | undefined): GovernanceConfig;
export {};
