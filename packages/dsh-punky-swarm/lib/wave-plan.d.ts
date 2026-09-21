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
/**
 * 结构约束（两条，缺一不可）：
 *   ① **已声明在先**：`deps` 只许指向 tasks 数组中**位于自身之前**的任务（声明顺序 = 拓扑序依据）。
 *   ② **同层或上游层**：只许指向层级 ≤ 自身层级的任务（`plan(0) < exec(1) < audit(2)`）；
 *      `layer == null`（generic）**不参与**层序判定（既有批大量使用 generic，收紧会破坏存量）。
 *   ⇒ 两者成立 ⇒ 依赖图是**严格偏序** ⇒ **成环在结构上不可能** ⇒ 无需运行期成环断言
 *      （用户裁定：不给定「拒绝环」断言，引擎内不设成环回路即可）。
 *   违反 ⇒ 抛**普通 Error**（**不带 `GATE_` 前缀**：2026-09-21 裁定「暂不新建拒码，迁移门禁再议」）。
 */
export declare function validateDepsStructure(tasks: WaveTask[]): void;
/**
 * 判据（规格 `plan/debt-spec.md` §2.1 方案 R，**只读、零副作用**）：对每条 `layer === 'audit'` 的 task，
 * 取其 `deps` 中每条 `layer === 'exec'` 的入边 `E`（= 本 audit lane **认领**了一条 exec lane），
 * 若本 lane 的 `consume` **未覆盖 `E` 的任何交付产物**（`E.produce ∪ E.outputs`；两者皆空 ⇒ 视为覆盖缺失）
 * ⇒ 产一条**告警**（「疑似配对基数漂移：认领即须声明消费该 exec 的产物」+ 建议）。
 *
 * 【2026-09-18 · 替换判据（G-08）】**旧判据已退役**：它比较的是「上游 exec lane 的 `deps` 是否覆盖本 audit
 * lane 的 `deps` 且严格更大」——该判据在**任何合法拓扑下不可满足**（本 audit lane 的 `deps` 含该 exec lane
 * 自身，而任何 lane 的 `deps` 都不含自身；要满足覆盖即须自指环，而该构造在建批期先被 `topoWaves` 以
 * `cycle detected in task deps` 拒绝）⇒ 旧判据恒 `false`，是**零可达性的空转校验**（退役表达式原文与原始读数见
 * `exec/pairing-panel.md` §U-7 与探针 `exec-pairing-panel/probe/u7-reachability.json`，本 docstring 不复制该表达式）。
 * 替换判据与旧判据**注释自述的语义**同旨（「一条 exec lane 被 ≥2 条 audit lane 认领且认领集不同」）：
 * 认领集 = `deps ∩ exec`，覆盖面 = 本 lane 的 `consume`。可达性实证见 `test/wave-plan-pairing.test.js`
 * （六格构造：不可达 3 + 可达 3，逐格断言 + 原始读数）。
 *
 * **不得升级为拒建批**（与容忍口径同纪律）：现网 `leader-direct` 批的 audit lane 常为**单条聚合**
 * （`docs/engine-design-adjudication-20260918.md:46` 实证：声明 3 exec 分支 + `pair_with:"exec"`，实批 1 条聚合
 * audit lane）⇒ 硬拒会**立刻**打断既有建批。`pair_with` 退役后 1:1 配对改由 audit lane 显式 `deps` 表达
 * （`deps` **恰为** `[<对应 exec lane>]`）**并显式消费其交付产物**；跨层聚合由该 audit lane 显式声明全部目标 lane
 * 且逐条消费其产物（认领即须消费）。
 */
export declare function collectAuditPairingWarnings(tasks: WaveTask[]): WavePlanDoc['warnings'];
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
