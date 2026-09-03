import type { GovernanceConfig, KernelDecision, RefusalReceipt } from './types.js';
export interface GovernanceKernel {
    decide(exec: {
        name: string;
        arguments: unknown;
    }): KernelDecision;
    getConfig(): GovernanceConfig;
}
export declare function createGovernanceKernel(config: GovernanceConfig): GovernanceKernel;
export declare function createRefusalReceipt(input: {
    tool: string;
    callId: string;
    sessionId: string | null;
    decision: KernelDecision;
    attemptedParams: unknown;
}): RefusalReceipt;
