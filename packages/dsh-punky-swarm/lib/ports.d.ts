/**
 * `lib/ports.ts` —— 内核端口与执行契约的**纯类型骨架**（G0 冻结件）。
 *
 * ## 约束（本文件的存在条件，改动前必读）
 * 1. **零运行期 import**：全文不得出现任何 `import` / `require` 语句——
 *    机核 `grep -cE '^(import|require)' lib/ports.ts` 必须为 **0**。
 *    因此本文件引用的每个结构都在此**就地声明**（结构型最小形状），不做跨模块类型引用。
 * 2. **只写类型、不接线**：无实现、无副作用、无运行期导出值。任何模块 import 本文件
 *    只应取 `type`，不得依赖其运行期存在。
 * 3. **零业务行为**：本文件不参与波次 / 门禁 / 交接 / 结算任何判定路径。
 *
 * ## 为什么单独成件
 * 端口表是「内核依赖什么」与「宿主提供什么」之间的**唯一契约面**。把它冻结成纯类型后，
 * 后续阶段（适配器总线、null 适配器、抽象泄漏探针）才有可对照的声明面；
 * 在它落地之前，能力声明只存在于 `inject = [...]` 的服务名清单里（逐名 required、无 optional 位）。
 *
 * ## 与蓝图的关系
 * 字段集对齐 `punky-refactor-blueprint-v4.md` §3.1（端口）与 §3.3（执行契约）。
 * 刻意**不含** `stopReason`：活性由内核从证据推导，不由执行体声明。
 *
 * ## 回拷登记
 * 本文件已登记进 `scripts/copy-ts-built.mjs` 回拷清单（`ports.js` / `ports.d.ts`）。
 * 漏登记的症状是「`.tsbuild` 里有、运行期 `ERR_MODULE_NOT_FOUND`」——已在 `rule-propagation.ts`
 * 上取到过一次 RED 读数，故此处先登记后接线。
 */
/**
 * 成员执行运行时。**唯一的执行动词是 `execute`**（收窄自「回读 / 注入 / 驱动」三动作：
 * 名册与工具面归内核自持后，回读与注入不再是端口，而是初次装配的一次性动作）。
 */
export interface AgentRuntime {
    /** 执行一次成员 spec，返回结果；适配器不得自选或扩员 target。 */
    execute(spec: ExecSpec): Promise<ExecResult>;
    /** 请求取消；语义为「停止等待」，不得把未知当已停。 */
    cancel?(runId: string): Promise<void>;
}
/** 审计出口。**恒自持，永不开放替换**——即使宿主提供同类能力也不接管。 */
export interface AuditSink {
    /** 追加一条审计事件（内核已定型的 event 对象，sink 只落盘不改义）。 */
    append(event: Readonly<Record<string, unknown>>): void;
}
/** 名册来源。缺失 ⇒ 内核使用内建 roster（不是「不支持」）。 */
export interface RosterSource {
    /** 读取宿主侧名册，仅用于与内建 roster **对账**，不得作为权威。 */
    read(): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
}
/** 工具面。缺失 ⇒ 内核自持注册表（默认不向宿主申请工具面）。 */
export interface ToolSurface {
    register(tool: Readonly<Record<string, unknown>>): void;
}
/** HTTP 面。缺失 ⇒ 内核自起 loopback。 */
export interface HttpSurface {
    handle(route: string, handler: (...args: unknown[]) => unknown): void;
}
/**
 * 内核端口集合。
 *
 * - `runtime` / `audit` **必需**：前者是执行面唯一来源，后者恒自持不可替换；
 * - `roster` / `tools` / `http` **可选**：缺失的语义是「内核自建」，**不是**「不支持」。
 *
 * 读取规则：可选端口缺失时走内建路径，且**降级必须可见**（回显字段或事件），禁静默降级。
 */
export interface KernelPorts {
    /** 必须：成员执行与 loop。 */
    runtime: AgentRuntime;
    /** 恒自持，永不开放替换。 */
    audit: AuditSink;
    /** 缺失 → 内建 roster。 */
    roster?: RosterSource;
    /** 缺失 → 内核自持注册表（默认不申请宿主）。 */
    tools?: ToolSurface;
    /** 缺失 → 自起 loopback。 */
    http?: HttpSurface;
}
/**
 * 一次成员执行的输入。派发输入是**不可变**的：
 * 恢复挂起执行时必须逐项比对持久化值与当前值，任一不符即拒绝恢复（绑定校验）。
 */
export interface ExecSpec {
    /** 运行标识；绑定校验的锚点之一。 */
    runId: string;
    /** target 由 Leader 给定，适配器**不得自选、不得扩员**。 */
    targetId: string;
    /** 成员描述（最小集；`budget` 用于预算硬停，属准入前置而非产物判定）。 */
    member: {
        id: string;
        title?: string;
        callsign?: string;
        model?: string;
        budget?: number;
    };
    /** 会话下发由黑板持有；`params` 为透传参数，`id` 为空表示新会话。 */
    session: {
        id: string | null;
        params: Record<string, unknown> | null;
    };
    /** 任务包引用（`wave` / `deps` 供恢复期拓扑校验）。 */
    taskPkg: {
        id: string;
        wave?: number;
        deps?: readonly string[];
    };
    /** 完成契约引用（`sha256` 参与绑定校验，契约变更须留痕）。 */
    contract: {
        id: string;
        sha256: string;
    };
    /**
     * 宿主 **agent preset** 表达位（批 G1 · D-4/N-7）：宿主按 agent preset 组子会话时使用的入参位。
     *
     * ⚠ **纯类型声明位：本批不接线**。适配器当前**不读取**该字段，宿主 `startActivation` 形态下的
     * 派发**运行仍拒派**（`engine/dispatch.js` 的 `GATE_DISPATCH_CAPABILITY_MISSING` 原样保留，本批未改）。
     * 之所以先落类型位：让「声明面」与「运行面」的差距**显式可见**，而不是靠文档口头承诺；
     * **禁**据此字段对外宣称「收窄能力已生效」或「投产可用」——能力位是否生效**只以运行期判据为准**。
     */
    agentPreset?: string;
    /**
     * 子会话 **composition** 表达位（批 G1 · D-4/N-7）：一次执行期望的子会话组成（谁、什么角色）。
     *
     * ⚠ 同上：**本批不接线**。形状只用于表达「期望组成」，**不参与**任何运行期判定与派发决策；
     * `dispatch.js` 的能力位拒派逻辑本批一字未动 ⇒ **运行仍拒派**。
     */
    composition?: {
        /** 期望的子会话席位（有序；空/缺省 = 未声明期望组成）。 */
        seats?: readonly {
            /** 席位名（与 `roster` 职位的命名口径一致，仅作表达，不做运行期解析）。 */
            role: string;
            /** 该席位的适配器标识（表达位；缺省 = 由宿主决定）。 */
            adapter?: string;
        }[];
        /** 期望的并行度上限（表达位；缺省 = 由宿主/引擎决定，不做运行期裁剪）。 */
        maxParallel?: number;
    };
}
/**
 * 一次成员执行的结果。
 *
 * **不含 `stopReason`**：活性分类由内核从证据（`writes` / `evidence` / usage）推导，
 * 不由执行体声明。执行体只回报可被核对的证据，避免「谎报停止原因」的攻防成本。
 */
export interface ExecResult {
    /** 是否超时。超时只针对**已结算的执行**，思考阶段不计时。 */
    timedOut: boolean;
    exitCode: number | null;
    signal: string | null;
    /** 可诊断拒因：家族 + 码 + 最早可重试时刻（用于把失败路由到修复动作）。 */
    errorCode?: string | null;
    errorFamily?: string | null;
    retryNotBefore?: string | null;
    /** 用量摘要。 */
    usage?: UsageSummary;
    /** 用量口径**必须显式声明**，不得靠 session id 推断（禁 `never infer cumulative from a reused session`）。 */
    usageBasis?: 'per_run' | 'session_cumulative';
    /** 会话回写：`sessionParams` 更新与 `clearSession` 清空。 */
    sessionParams?: Record<string, unknown> | null;
    clearSession?: boolean;
    /** 证据：本次写入清单（内核据此判定是否「有进展」）。 */
    writes?: string[];
    /** 证据引用，供内核交叉核对声明与事实是否相配。 */
    evidence?: ExecEvidence[];
}
/** 单条证据引用。 */
export interface ExecEvidence {
    kind: string;
    ref: string;
    outcome?: string;
}
/** 用量摘要（最小集；口径由 `ExecResult.usageBasis` 声明）。 */
export interface UsageSummary {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
}
