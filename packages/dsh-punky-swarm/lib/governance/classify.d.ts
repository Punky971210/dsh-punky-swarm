import type { GovernancePrimitive, GovernanceConfig, Violation } from './types.js';
export interface ClassifyInput {
    tool: string;
    params: unknown;
    violations: Violation[];
    confidence?: number;
    flags: GovernanceConfig['flags'];
    defaults?: GovernanceConfig['defaults'];
}
export interface ClassifyOutput {
    primitive: GovernancePrimitive;
    priority: number;
    reason: string;
}
export declare function classifyViolation(input: ClassifyInput): ClassifyOutput;
