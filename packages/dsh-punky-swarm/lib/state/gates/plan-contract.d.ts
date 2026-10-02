import type { Batch } from '../../types/contracts.js';
import type { GatesCx } from './cx.js';
export declare function buildPlanContract(cx: GatesCx): {
    checkPlanContract: (sessionId: string, batchId: string, batch: Batch, lane: string) => Record<string, unknown>;
};
