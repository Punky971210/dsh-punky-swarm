import type { Batch } from '../../types/contracts.js';
import type { GatesCx } from './cx.js';
export declare function buildHandoff(cx: GatesCx): {
    checkSettleHandoffGate: (sessionId: string, batchId: string, batch: Batch, lane: string, note?: string | null) => {
        ok: boolean;
        code: string | null;
        missing: string[];
        problems: string[];
        disabled?: boolean;
        smoke?: boolean;
        legacy?: boolean;
        humanException?: boolean;
        downstream?: string[];
    };
};
