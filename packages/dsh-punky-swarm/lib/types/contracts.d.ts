/** 成员状态：pending/running/review 迁移中态 + merged/failed/skipped/conflict 终态 + idle 恢复态（8 值） */
export type MemberState = 'pending' | 'running' | 'review' | 'merged' | 'failed' | 'skipped' | 'conflict' | 'idle';
/** 批次阶段：planning/running/paused 非终态 + aborted/complete 终态（5 值） */
export type BatchPhase = 'planning' | 'running' | 'paused' | 'aborted' | 'complete';
/** 结算终态三值（isMemberTerminal 判定 = SETTLE_STATES.includes(s) || s === 'conflict'） */
export type SettleState = 'merged' | 'failed' | 'skipped';
/** 成员迁移表：from 态 → 合法 to 态列表（只读；运行期只复制后写，不原地改常量） */
export type TransitionTable = Record<MemberState, readonly MemberState[]>;
/** 批次阶段迁移表（同 TransitionTable 语义） */
export type BatchTransitionTable = Record<BatchPhase, readonly BatchPhase[]>;
/** 任务分层：plan（规划）/ exec（执行）/ audit（验收）——Tier3 三层门禁 */
export type Layer = 'plan' | 'exec' | 'audit';
/** 条件子句：产物根内相对路径存在性（normalizeCondition 归一后的对象形态） */
export interface ConditionClause {
    path: string;
    exists: true;
}
/** 建批输入条件：对象数组（主形态）或字符串简写数组；null/缺省 = 恒满足 */
export type ConditionInput = ConditionClause[] | string[] | null | undefined;
/** 输入形态：wave_plan 建批工具 tasks 入参（id 必填，其余可选） */
export interface WavePlanTaskInput {
    id: string;
    cmd?: string;
    deps?: string[];
    model?: string;
    tools?: string[];
    layer?: Layer;
    role?: string;
    skills?: string[];
    consume?: string[];
    produce?: string[];
    outputs?: string[];
    condition?: ConditionInput;
    checkpoint?: {
        steps: number;
    };
    resume?: boolean;
    targets?: string[];
    targetsMarker?: string | null;
}
/** 持久形态：buildWavePlan 规范化产物（gates.ts / validateWavePlan / findTask 消费面） */
export interface WavePlanTask {
    id: string;
    cmd: string;
    deps: string[];
    model: string | null;
    tools: string[] | null;
    layer: Layer | null;
    role: string | null;
    skills: string[] | null;
    consume: string[] | null;
    produce: string[] | null;
    outputs: string[] | null;
    condition: ConditionClause[] | null;
    checkpoint: {
        steps: number;
    } | null;
    resume: boolean;
    targets: string[] | null;
    targetsMarker: string | null;
}
/** 单 wave 层：wave 序号 + 该层任务列表（topoWaves 分层产物） */
export interface Wave {
    wave: number;
    tasks: WavePlanTask[];
}
/** buildWavePlan 返回值（建批产物文档） */
export interface WavePlanDoc {
    schema: number;
    batchId: string;
    team: string;
    wavePlan: Wave[];
    concurrency: number;
    warnings: Array<{
        code: string;
        task?: string;
        layer?: string;
        role?: string;
        missing?: string;
        message: string;
    }>;
}
/** 环防护记账状态（C4 mailbox；batch JSON 唯一事实源，v3 字段） */
export interface ChainsState {
    chains: Record<string, {
        edges: Record<string, number>;
        said: Record<string, string>;
    }>;
    order: string[];
}
/** 断点进度（laneProgress 值形态；status 与成员态对齐，不新增成员态） */
export interface LaneProgress {
    step: number;
    total: number;
    status: 'running' | 'review';
    updatedAt: string;
}
/** 断点进度表：laneId → 进度（批次级可选字段；缺省 undefined = 无断点记录） */
export type LaneProgressMap = Record<string, LaneProgress>;
/** 批次对象（v3：store.js createBatch 运行时形态 + schema-v3.js migrateV2toV3 兜底字段） */
export interface Batch {
    schema: 3;
    sessionId: string;
    batchId: string;
    phase: BatchPhase;
    concurrency: number;
    team: string;
    wavePlan: Wave[];
    lanes: Record<string, MemberState>;
    chains: ChainsState;
    archived: boolean;
    laneProgress?: LaneProgressMap;
    events: BatchEvent[];
    createdAt: string;
    updatedAt: string;
}
/** Lane 视图类型（lanes 记录 + laneProgress 指针的投影；工具/面板消费） */
export interface Lane {
    id: string;
    state: MemberState;
    progress?: LaneProgress;
}
/** 事件基座：ts + type 必备（store.js newEvent 工厂 = { ts, type, ...fields }） */
export interface BatchEventBase {
    ts: string;
    type: string;
}
/**
 * 批次事件判别联合：按 lib/state/event-types.js EVT_* 常量值登记 + 兜底分支。
 * 判别字段 type 与 EVT 常量值绑定（常量仍为运行期事实源；gates.ts 内
 * `e.type === EVT.EVT_MEMBER_SETTLED` 与字面量比较两写法并存均可收窄）。
 * 尾部兜底分支保证未知/未来事件不报错（R-01 扩面事件：lane.stalled /
 * lane.over-budget / budget.rejected / worktree.* / gate.role_* /
 * archive.done / system.restored 等——ts+type 必备，其余字段 unknown 可读）。
 */
export type BatchEvent = BatchEventBase & ({
    type: 'batch.created';
    batchId: string;
    sessionId: string;
} | {
    type: 'batch.phase';
    from: BatchPhase;
    to: BatchPhase;
    reason?: string;
} | {
    type: 'batch.failed-escalate';
    lane: string;
    count: number;
} | {
    type: 'batch.governance-escalate';
    count: number;
    windowMs: number;
    lane: string;
    receiptIds: string[];
} | {
    type: 'governance.refusal';
    lane: string;
    receiptId: string;
    primitive: string;
    ruleRefs: string[];
    tool: string;
} | {
    type: 'member.settled';
    lane: string;
    from: MemberState;
    to: MemberState;
    note: string | null;
} | {
    type: 'lane.skipped';
    lane: string;
    from: MemberState;
    note: string;
} | {
    type: 'lane.needhuman';
    lane: string;
    path: string | null;
} | {
    type: 'lane.recycled';
    lane: string;
    from: string;
    reason: string;
    note: string | null;
} | {
    type: 'human.decision';
    lane: string;
    note: string | null;
} | {
    type: 'asset.claimed';
    lane: string | null;
    source: string;
    target: string;
} | {
    type: 'gate.entry.missing';
    lane: string;
    missing: string[];
} | {
    type: 'gate.exit.missing';
    lane: string;
    code: string;
    detail: unknown;
} | {
    type: 'gate.passed';
    lane: string;
    gate: string;
} | {
    type: 'gate.target_blocked';
    lane: string;
    code: string;
    missing: string[];
    unchanged: string[];
} | {
    type: 'gate.target.passed';
    lane: string;
    mode: string;
    targets: string[];
} | {
    type: 'gate.exit_blocked';
    lane: string;
    code: string;
    command: string | null;
    exitCode: number | null;
    detail: string | null;
    escalation: boolean;
} | {
    type: 'gate.exit';
    lane: string;
    commands: string[];
    results: unknown[];
    outputTruncated: boolean;
} | {
    type: 'gate.needhuman_blocked';
    lane: string;
    code: string;
    path: string | null;
} | {
    type: 'gate.complete_blocked';
    code: string;
    pending?: string[];
} | {
    type: 'archive.failed';
    reason: string;
} | {
    type: 'system.recovered';
    batchId: string;
    sessionId: string;
    recoveredLanes: string[];
    detail: unknown[];
} | {
    type: string;
    [k: string]: unknown;
});
/** 门禁失败错误码全量枚举（按层后缀/门禁族；不设通配符，保持穷尽性收益） */
export type GateErrorCode = 'GATE_ENTRY_MISSING' | 'GATE_PLAN_CONTRACT' | 'GATE_EXIT_MISSING_EXEC' | 'GATE_EXIT_MISSING_AUDIT' | 'GATE_NEEDHUMAN_PENDING' | 'GATE_EXIT_NO_COMMAND' | 'GATE_EXIT_FORBIDDEN' | 'GATE_EXIT_TIMEOUT' | 'GATE_EXIT_SPAWN_FAIL' | 'GATE_EXIT_NONZERO' | 'GATE_TARGET_MISSING' | 'GATE_TARGET_UNCHANGED' | 'GATE_COMPLETE_NO_AUDIT' | 'GATE_EXIT_PENDING_AUDIT' | 'GATE_COMPLETE_AUDIT_FAILED' | 'GATE_COMPLETE_EXEC_PENDING';
/** 门禁通过：ok: true + 各门禁可选载荷 */
export interface GateOk {
    ok: true;
    declared?: boolean;
    commands?: string[];
    results?: Array<{
        command: string;
        exitCode: number | null;
        durationMs: number;
    }>;
    outputTruncated?: boolean;
    path?: string | null;
    mode?: 'mtime' | 'marker';
    targets?: string[];
    missing?: [];
    unchanged?: [];
}
/** 门禁失败：ok: false + code + 载荷（按门禁族可选携带） */
export interface GateFail {
    ok: false;
    code: GateErrorCode;
    missing?: string[];
    problems?: string[];
    pending?: string[];
    command?: string | null;
    exitCode?: number | null;
    detail?: string | null;
    declared?: boolean;
    path?: string | null;
    needHumanEscalation?: boolean;
    mode?: 'mtime' | 'marker';
    targets?: string[];
    unchanged?: string[];
    message?: string;
}
/** 门禁结果判别联合：`if (g.ok)` 分支后即可访问 fail/ok 专属载荷字段 */
export type GateResult = GateOk | GateFail;
