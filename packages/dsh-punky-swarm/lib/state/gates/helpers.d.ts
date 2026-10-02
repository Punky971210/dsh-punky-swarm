import { flowsForBatch } from '../../assembly/flows.js';
import type { PresenceInput, PresenceVerdict } from './presence.js';
import type { Batch, Layer, WavePlanTask } from '../../types/contracts.js';
/** `buildHelpers` 的输入底座（组合器提供的闭包状态 + 模块级判据单点）。 */
export interface HelpersBase {
    sessionsDir: string;
    flowsOf: (batch: Batch) => ReturnType<typeof flowsForBatch>;
    presenceJudge: (input: PresenceInput) => PresenceVerdict;
}
/** 共享辅助面的完整类型（组合器与各 builder 据此做结构性装配）。 */
export type GatesHelpers = ReturnType<typeof buildHelpers>;
export declare function buildHelpers(cx: HelpersBase): {
    sessionDir: (sessionId: string) => string;
    artifactsDirOf: (sessionId: string, batchId: string) => string;
    batchFile: (sessionId: string, batchId: string) => string;
    readBatch: (sessionId: string, batchId: string) => Batch | null;
    resolveArtifact: (sessionId: string, batchId: string, rel: string) => string;
    declaredArtifactsOf: (t: WavePlanTask | null | undefined) => string[];
    consumeFieldNameOf: (flows: unknown, layer: string | null) => string;
    consumeArtifactsOf: (t: WavePlanTask | null | undefined, field?: string) => string[];
    layersOf: (batch: Batch) => Record<Layer, string[]>;
    orphanProductsOf: (batch: Batch) => {
        plan: string[];
        exec: string[];
        audit: string[];
    };
    completeOutcomesOf: (batch: Batch) => {
        source: string;
        declared: string[] | null;
        values: string[];
        narrowed: string[];
        rejectedBy: string[];
        escapeRoute: {
            phase: "aborted";
            reason: string;
        };
    };
    standaloneVerdict: (batch: Batch, t: WavePlanTask) => {
        ok: boolean;
        declared: boolean;
        code: string | null;
        reason: string;
    };
    presenceOfArtifact: (sessionId: string, batchId: string, layer: string | null, p: string) => PresenceVerdict;
    depsOf: (t: WavePlanTask | null | undefined) => string[];
    handoffRecordVerdict: (sessionId: string, batchId: string, layer: string | null | undefined, rec: Record<string, unknown> | null, from: string, to: string) => {
        ok: boolean;
        missing: string[];
        problems: string[];
        pending: boolean;
    };
    handoffVerdictOf: (sessionId: string, batchId: string, batch: Batch, lane: string, t: WavePlanTask | null | undefined) => {
        ok: boolean;
        legacy: boolean;
        missing: string[];
        problems: string[];
        pending: string[];
    };
};
