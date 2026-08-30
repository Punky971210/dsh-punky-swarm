import type { Batch, LaneProgressMap } from '../types/contracts.js';
export declare const BATCH_SCHEMA_V3 = 3;
export declare function chainsDefaults(): {
    chains: {};
    order: never[];
};
export declare function laneProgressDefaults(): undefined;
export declare function isLaneProgress(v: unknown): v is LaneProgressMap;
export declare function conditionDefaults(): null;
export declare function migrateV2toV3(batch: unknown): Batch;
