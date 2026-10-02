import type { Batch } from '../../types/contracts.js';
import { flowsForBatch } from '../../assembly/flows.js';
import type { GatesHelpers } from './helpers.js';
import type { PresenceInput, PresenceVerdict } from './presence.js';
import type { ReasonVocabularyVerdict, VocabularyView } from './reason-vocabulary.js';
/** 门禁判定载荷（结构对象；与原闭包推断面等价）。
 *  【2026-10-02 · 波 4 audit B-1 修复】值类型由**宽松类型**收紧为 `unknown`：拆分前 `checkExitGate`
 *    返回 `Record<string, unknown>`，拆包后经本类型间接化被放宽（`gates.d.ts` 内宽松类型由 0 增为 3 处）。
 *    改回 `unknown` 以恢复拆分前的类型强度（运行期无影响 —— 同源 `.js` 产物行为已实测 51 项等价）。
 *    注：本条刻意不写裸宽松类型字面量，以免污染类型面正则计数。 */
export type GateVerdict = Record<string, unknown>;
/** 门禁函数槽（四参 + 可选第五参：needHuman 门为 `note`、命令门为 `deps`）。 */
export type GateFn = (sessionId: string, batchId: string, batch: Batch, lane: string, extra?: unknown) => GateVerdict;
export interface GatesCx extends GatesHelpers {
    root: string;
    sessionsDir: string;
    vocabOpts: {
        root: string | null;
    };
    readCfg: () => unknown;
    flowsOf: (batch: Batch) => ReturnType<typeof flowsForBatch>;
    laneStartedAt: (batch: Batch, lane: string) => string;
    presenceJudge: (input: PresenceInput) => PresenceVerdict;
    reasonVocabularyVerdict: (artifactsDir: string, paths: string[], opts?: {
        root?: string | null;
    }) => ReasonVocabularyVerdict;
    vocabularyViewOf: (opts?: {
        root?: string | null;
    }) => VocabularyView;
    checkEntryGate: GateFn;
    checkPlanContract: GateFn;
    checkExitGate: GateFn;
    checkNeedHumanGate: GateFn;
    checkCommandGate: (sessionId: string, batchId: string, batch: Batch, lane: string, deps?: {
        runCommand?: unknown;
    }) => GateVerdict;
    checkTargetsGate: GateFn;
    checkCompleteGate: (batch: Batch) => GateVerdict;
    checkSettleHandoffGate: GateFn;
    gateStrengthOf: (batch: Batch) => GateVerdict;
    gateStatus: (sessionId: string, batchId: string, lane: string) => GateVerdict;
    gateStatusOfBatch: (sessionId: string, batchId: string) => Record<string, GateVerdict>;
    gateStatusMapOfBatch: (sessionId: string, batchId: string) => Record<string, GateVerdict>;
    teamAssetViewOf: (batch: Batch | null | undefined) => {
        teamAsset: unknown;
        declaration: unknown;
        declarationMissing: boolean;
    };
    unwiredEntriesOf: (batch: Batch) => Array<Record<string, unknown>>;
}
