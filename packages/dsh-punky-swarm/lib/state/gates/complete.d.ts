import type { Batch } from '../../types/contracts.js';
import type { GatesCx } from './cx.js';
export declare function buildComplete(cx: GatesCx): {
    checkCompleteGate: (batch: Batch) => Record<string, unknown>;
    teamAssetViewOf: (_batch: Batch | null | undefined) => {
        teamAsset: unknown;
        declaration: unknown;
        declarationMissing: boolean;
    };
    unwiredEntriesOf: (_batch: Batch) => Array<Record<string, unknown>>;
};
