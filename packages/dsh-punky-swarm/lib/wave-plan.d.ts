import type { ConditionClause, ConditionInput, Layer, WavePlanDoc, WavePlanTask, WavePlanTaskInput } from './types/contracts.js';
type WaveTask = WavePlanTaskInput | WavePlanTask;
export declare const LAYERS: readonly ["plan", "exec", "audit"];
export declare const VALID_ROLES: readonly ["coordinator", "manager", "designer", "coder", "tester", "reviewer", "supervisor", "doc-manager"];
export declare const ROLE_EXTENSIONS: string[];
export declare const ROLE_WHITELIST: Set<string>;
export declare function normalizeRole(role: unknown): string | null;
export declare function defaultRoleForLayer(layer: Layer | null | undefined): string | null;
export declare const PLAN_LEAD_ROLES: Set<string>;
export declare const AUDIT_LEAD_ROLES: Set<string>;
export declare function isCClassBatch(tasks: WaveTask[], waves: string[][]): boolean;
export declare function collectRoleCompletenessWarnings(tasks: WaveTask[], waves: string[][]): {
    code: string;
    layer: string;
    missing: string;
    message: string;
}[];
export declare function topoWaves(tasks: WaveTask[]): {
    waves: string[][];
    order: string[];
};
export declare function normalizeCondition(cond: ConditionInput): ConditionClause[] | null;
export declare function normalizeResumeContract(t: WavePlanTaskInput): {
    checkpoint: {
        steps: number;
    } | null;
    resume: boolean;
};
export declare function normalizeTargetsContract(t: WavePlanTaskInput): {
    targets: string[] | null;
    targetsMarker: string | null;
};
export declare const RESUME_CLAUSE = "\u82E5\u672C lane \u5B58\u5728 checkpoint\uFF08lane_checkpoint_status \u53EF\u67E5\uFF09\uFF0C\u987B\u5148\u67E5\u8BE2 checkpoint \u5386\u53F2\uFF0C\u4ECE\u6700\u540E\u5DF2 checkpoint \u7684\u6B65\u9AA4\u4E4B\u540E\u7EE7\u7EED\uFF0C\u7981\u6B62\u91CD\u505A\u5DF2\u5B8C\u6210\u6B65\u9AA4\uFF1B\u6BCF\u5B8C\u6210\u4E00\u4E2A\u5B50\u6B65\u9AA4\u7ACB\u5373 lane_checkpoint\uFF08\u643A\u5E26 progress\uFF09\uFF0C\u7981\u6B62\u6512\u6279\u3002";
export declare function resumeClauseFor(task: WavePlanTask | null): string | null;
export declare function assembleCmd(role: string | null, skills: string[] | null | undefined, cmd: string): string;
export declare function buildWavePlan({ batchId, tasks, concurrency, team, assembly }: {
    batchId: string;
    tasks: WavePlanTaskInput[];
    concurrency?: number;
    team?: string;
    assembly?: {
        layers?: Record<string, {
            skills?: Record<string, string[]>;
        }>;
    } | null;
}): WavePlanDoc;
export declare function validateWavePlan(plan: WavePlanDoc): boolean;
export {};
