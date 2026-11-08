import type { Batch, LaneHandoffMap } from '../types/contracts.js';
export declare const BATCH_SCHEMA_V3 = 3;
export declare function handoffsDefaults(): LaneHandoffMap;
export declare function chainsDefaults(): {
    chains: {};
    order: never[];
};
export declare function conditionDefaults(): null;
export declare function migrateV2toV3(batch: unknown): Batch;
