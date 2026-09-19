import type { Batch, LaneHandoffMap, LaneProgressMap } from '../types/contracts.js';
export declare const BATCH_SCHEMA_V3 = 3;
/** P1 交接表缺省（**新建批**用；空对象 = 该批无 deps ⇒ 未交接门恒放行） */
export declare function handoffsDefaults(): LaneHandoffMap;
/** P1 交接表形态校验（批次级 plain object；值级校验见 gates.ts `handoffVerdictOf`） */
export declare function isHandoffs(v: unknown): v is LaneHandoffMap;
export declare function chainsDefaults(): {
    chains: {};
    order: never[];
};
export declare function laneProgressDefaults(): undefined;
export declare function isLaneProgress(v: unknown): v is LaneProgressMap;
export declare function conditionDefaults(): null;
export declare function migrateV2toV3(batch: unknown): Batch;
