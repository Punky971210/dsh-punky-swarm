import type { BatchTransitionTable, TransitionTable } from '../types/contracts.js';
export declare const DEFAULT_MEMBER_RULES: TransitionTable;
export declare const DEFAULT_BATCH_RULES: BatchTransitionTable;
/** 对任意规则载荷取内容指纹（sha256 前 16 hex）。**单一计算点**（传播模块复用本函数，禁第二套）。 */
export declare function rulesFingerprint(payload: unknown): string;
/** 默认规则表的内容指纹（模块加载期算一次即固定）——「规则是否非默认」的判据锚点。 */
export declare const DEFAULT_RULES_VERSION: string;
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
    version: string;
    changedAt: string;
};
