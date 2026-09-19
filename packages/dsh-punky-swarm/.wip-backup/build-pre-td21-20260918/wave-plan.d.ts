import type { ConditionClause, ConditionInput, Layer, WavePlanAssemblyDecl, WavePlanDoc, WavePlanTask, WavePlanTaskInput } from './types/contracts.js';
type WaveTask = WavePlanTaskInput | WavePlanTask;
export declare const LAYERS: readonly ["plan", "exec", "audit"];
export declare const VALID_ROLES: readonly ["coordinator", "manager", "designer", "coder", "tester", "reviewer", "supervisor", "doc-manager"];
export declare const ROLE_EXTENSIONS: string[];
export declare const ROLE_WHITELIST: Set<string>;
export declare function normalizeRole(role: unknown, extraRoles?: string[] | null): string | null;
export declare function defaultRoleForLayer(layer: Layer | null | undefined): string | null;
export declare const PLAN_LEAD_ROLES: Set<string>;
export declare const AUDIT_LEAD_ROLES: Set<string>;
export declare function isCClassBatch(tasks: WaveTask[], waves: string[][]): boolean;
export declare function collectRoleCompletenessWarnings(tasks: WaveTask[], waves: string[][], opts?: {
    extraRoles?: string[];
    planLeads?: string[];
    auditLeads?: string[];
}): ({
    code: string;
    layer: string;
    missing: string;
    message: string;
} | {
    role: string;
    message: string;
    layer?: Layer | undefined;
    code: string;
    task: string;
    missing?: undefined;
})[];
export declare const MANAGER_PLANS: readonly ["raise", "leader-direct"];
export declare function countExecLanes(tasks: WaveTask[]): number;
export declare function isCPlusBatch(tasks: WaveTask[]): boolean;
export declare function requiresAssemblyDecl(tasks: WaveTask[]): boolean;
export declare function normalizeAssemblyDecl(input: unknown, extraRoles?: string[] | null): {
    decl: WavePlanAssemblyDecl | null;
    warnings: WavePlanDoc['warnings'];
};
export type AssemblyGateResult = 'ok' | {
    code: 'GATE_ROLE_ASSEMBLY_MISSING';
    message: string;
};
export declare function assemblyGate(tasks: WaveTask[], decl: WavePlanAssemblyDecl | null): AssemblyGateResult;
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
    targetsNoChange: boolean;
};
export declare const RESUME_CLAUSE = "\u82E5\u672C lane \u5B58\u5728 checkpoint\uFF08lane_checkpoint_status \u53EF\u67E5\uFF09\uFF0C\u987B\u5148\u67E5\u8BE2 checkpoint \u5386\u53F2\uFF0C\u4ECE\u6700\u540E\u5DF2 checkpoint \u7684\u6B65\u9AA4\u4E4B\u540E\u7EE7\u7EED\uFF0C\u7981\u6B62\u91CD\u505A\u5DF2\u5B8C\u6210\u6B65\u9AA4\uFF1B\u6BCF\u5B8C\u6210\u4E00\u4E2A\u5B50\u6B65\u9AA4\u7ACB\u5373 lane_checkpoint\uFF08\u643A\u5E26 progress\uFF09\uFF0C\u7981\u6B62\u6512\u6279\u3002";
export declare function resumeClauseFor(task: WavePlanTask | null): string | null;
/** 任务声明面并集（`produce ∪ outputs`，**保留声明原文**，去重保序）。 */
export declare function declaredArtifactsOf(t: WaveTask): string[];
/**
 * A1 悬空产物（plan 层）：被声明的 plan 产物**无任何 lane 的 `consume` 引用**（纯读声明面，不读文件正文）。
 * 有意不对称（`design §11.A`）：exec / audit 层产物悬空**不在此列**（exec 产物可能本就是终端交付物）；
 * 它们由运行期 `gateStrength.orphanProducts` 强告警可见（不拒）。
 */
export declare function orphanPlanProductsOf(tasks: WaveTask[]): string[];
export declare function assembleCmd(role: string | null, skills: string[] | null | undefined, cmd: string): string;
export declare const HANDOFF_GATE_ENV = "PSWARM_HANDOFF_GATE";
export type HandoffGateStage = 'entry' | 'settle';
export interface HandoffGateState {
    entry: boolean;
    settle: boolean;
    source: 'runtime' | 'env' | 'default';
}
/** 解析门态（**唯一真源**）。优先级（**逐段独立**）：段级 runtime 键 > 段内 `enabled` > env 兜底 > 缺省关。
 *  「逐段独立」的理由：`{ handoff: { settle: true } }` 这类**只写一段**的配置若整体回落 env，会出现
 *  「写了 settle 却把 entry 交给环境变量」的静默半开面（实测踩点：ambient env 可让本意只开一段的配置
 *  连带开另一段）⇒ 未显式声明的段一律走 `enabled`/env/缺省，不连坐。 */
export declare function handoffGateStateOf(liveConfig: unknown, env?: Record<string, string | undefined>): HandoffGateState;
/** 单段判定（薄封装；三处消费点用这个）。 */
export declare function handoffGateEnabledOf(liveConfig: unknown, stage?: HandoffGateStage, env?: Record<string, string | undefined>): boolean;
export declare function checkHandoffDeclarations(tasks: WaveTask[], opts?: {
    smoke?: boolean;
    handoffGate?: boolean;
}): void;
export declare function buildWavePlan({ batchId, tasks, concurrency, team, assembly, teamsRoot, smoke, handoffGate }: {
    batchId: string;
    tasks: WavePlanTaskInput[];
    concurrency?: number;
    team: string;
    assembly?: {
        layers?: Record<string, {
            skills?: Record<string, string[]>;
        }>;
    } | null;
    teamsRoot?: string;
    smoke?: boolean;
    /** P1 交接门策略（`task-27`）：由**调用方**（工具面持 liveConfig）经 `handoffGateEnabledOf` 解析后传入；
     *  缺省 undefined ⇒ 本函数内按**缺省配置**兜底解析（env → 缺省关），直调调用方行为不变。 */
    handoffGate?: boolean;
}): WavePlanDoc;
export declare function validateWavePlan(plan: WavePlanDoc, opts?: {
    smoke?: boolean;
}): boolean;
export {};
