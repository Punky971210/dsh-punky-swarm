import type { BatchTransitionTable, TransitionTable } from '../types/contracts.js';
export declare const DEFAULT_MEMBER_RULES: TransitionTable;
export declare const DEFAULT_BATCH_RULES: BatchTransitionTable;
export declare function loadRules(config: {
    ratchet?: {
        memberRules?: unknown;
        batchRules?: unknown;
        allowRelax?: boolean;
    };
} | null | undefined): {
    memberRules: TransitionTable;
    batchRules: BatchTransitionTable;
    source: 'default' | 'config';
};
