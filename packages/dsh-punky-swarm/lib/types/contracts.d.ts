/** 成员状态：pending/running/review 迁移中态 + merged/failed/skipped/conflict 终态 + idle **空闲态**（8 值；idle = 字面意义的空闲，非崩溃态，返工/续跑可调用） */
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
    standalone?: boolean;
    standaloneReason?: string;
    targetsNoChange?: boolean;
    owner?: string | null;
    /** R-3（P4 授权修复批，2026-09-25）：lane ← **roster 成员名**承载（`docs/b5-teammate-seat-design-v1-2026-09-25.md` §1/§3）。
     *  语义 = 「team 通道执行者标识」：写权判据读端按「哪些 lane 的 `roster` = 我」定 lane 写权（池化时天然覆盖其多条 lane）。
     *  **不设唯一性约束**——同一 roster 名可出现在多条 lane（一成员多 lane）、同类型多成员各书其名，均合法。
     *  归一化（`buildWavePlan` **恒写**）：缺省/非字符串/空串/纯空白 ⇒ `null`；非空字符串 ⇒ `trim()` 原样保留。
     *  非法形态（trim 后非空且不匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`）⇒ 建批期拒 `GATE_ROSTER_INVALID`（fail-closed）。
     *  ⚠ **不参与 `sig` 指纹**（`computeTaskSig` 输入面逐字不变 ⇒ 既有 sig 基线零漂移）。 */
    roster?: string | null;
    sig?: string | null;
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
    standalone?: boolean;
    /** standalone 逃生理由（B7-b 补入类型面）：buildWavePlan 归一化**恒写**——字符串原样保留、非字符串（含缺省）落 null
     *  （与 targetsMarker 同风格：缺省落 null 不落 undefined）。写端 `lib/wave-plan.ts`（归一化保留）、
     *  读端 `lib/state/gates.ts` 的 `standaloneVerdict`（为空 ⇒ 拒 GATE_STANDALONE_UNJUSTIFIED）。 */
    standaloneReason?: string | null;
    targetsNoChange?: boolean;
    /** P1 交接门（M-6 双写，**只读回显**）：官方任务板 `team_task_create` 产出的 task id 镜像。
     *  **不参与任何判定**（判定只看黑板 `batch.handoffs`）；缺省 null = 未建官方 task（零感知）。 */
    officialTaskId?: string | null;
    /** N1-R4-1（K1 公共池）：任务**归属声明**——`null` = **在池内**（未派发）、非空 = 已出池。
     *  buildWavePlan 归一化**恒写**（非字符串含缺省 ⇒ `null`，与 `targetsMarker` 同风格：不落 undefined）。
     *  ⚠ **本字段只作声明面**：池 = `owner == null` 的**视图**（不是容器），不引入认领/claim 语义；
     *     派发仍由 Leader 单点发起（`lane_dispatch`）。写入方见 `docs/new-engine-blueprint-2026-09-21.md §7.4.2`。 */
    owner: string | null;
    /** R-3（P4 授权修复批，2026-09-25）：lane ← **roster 成员名**承载（team 通道执行者标识）。
     *  `buildWavePlan` 归一化**恒写**（缺省/非字符串/空串 ⇒ `null`，与 `targetsMarker` 同风格：不落 undefined）；
     *  非空字符串 ⇒ `trim()` 后原样保留（须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`，否则建批期拒 `GATE_ROSTER_INVALID`）。
     *  **不设唯一性约束**（一成员多 lane 合法、同类型多成员各书其名合法，均不产告警）；与 `owner` **并存互不替代**
     *  （`owner` 仍是公共池归属声明面、不参与门禁；`roster` 是 team 通道写权判据的输入）。
     *  ⚠ **不参与 `sig`**（`computeTaskSig` 输入面逐字不变）。 */
    roster: string | null;
    /** sig 任务内容指纹（N3-②）：`sha256(canonicalJSON({id,layer,role,deps,produce,outputs,cmd}))` 前 **16 hex**
     *  （用户 D-sig-1 裁定 = **不含 `assemblyRef`**，只含任务信息；D-sig-3 = 16 hex）。
     *  写端 `lib/wave-plan.ts`（`buildWavePlan` = **唯一计算入口**；`addPoolTasks`/`addTaskEdges` 经同一次重归一化
     *  分别做「新任务补算」「受影响任务重算、无关任务不变」）；`owner` 非空 ⇒ **冻结**（读旧值原样落盘）。
     *  读端 `lib/sig-fingerprint.js#sigOf`（非 16 hex ⇒ `null`；**存量批无该字段 = 零感知**）。
     *  ⚠ **不参与任何门禁判定**：sig 只作幂等判等的留痕依据（D-sig-2 = 不加新拒码、不阻断动作）。 */
    sig?: string | null;
}
/** 交接契约（下游据此取件；`consumedFrom` = 消费证据，替代消息 ack 语义） */
export interface LaneHandoffContract {
    consumedFrom: string;
    assertions: string[];
}
/** R-2（P4 授权修复批，2026-09-25 · `plan/fix-spec.md` §2.2）：交接**覆盖留痕**快照（`LaneHandoff.history` 元素形态）。
 *  语义 = 「被覆盖掉的**旧值**」：每次 `handoff_submit(overwrite:true)` 覆盖已 `submitted` 的边时 push 一条，
 *  **追加式**（不得替换或清空历史）⇒ `history.length` = 该边被覆盖的次数。 */
export interface LaneHandoffHistoryEntry {
    ts: string;
    artifacts: string[];
    assertions: string[];
    officialTaskId?: string | null;
}
/** 单条交接记录（`batch.handoffs[toLaneId][]` 值形态） */
export interface LaneHandoff {
    from: string;
    to: string;
    batch: string;
    step?: string | null;
    artifacts: string[];
    contract: LaneHandoffContract;
    status: 'pending' | 'submitted';
    ts: string;
    /** 官方任务板镜像（M-6 双写，**只读回显**）：由 Leader 侧 `team_task_create` 后回填；
     *  **不参与任何判定**（判定只看黑板 = 本字段所在对象），写失败只落 `mirror.gap`、不进拒绝路径。 */
    officialTaskId?: string | null;
    /** R-2（P4 授权修复批，2026-09-25）：覆盖历史（追加式；缺省 undefined / 空数组 = 从未被覆盖 ⇒ 存量边零感知）。
     *  读端 `handoff_view` 与审计据此核「旧值留痕」；**不参与写权判定**。 */
    history?: LaneHandoffHistoryEntry[];
}
/** 交接表：**toLaneId** → 该 lane 的入边交接列表（批次级可选字段；缺省 undefined = 存量批 ⇒ 门整体放行 + 留痕） */
export type LaneHandoffMap = Record<string, LaneHandoff[]>;
/** 交接门判定结果（`gates.ts` 内部使用；`missing` 须能让下游看出**缺哪条边 / 缺哪件产物**） */
export interface HandoffVerdict {
    ok: boolean;
    legacy?: boolean;
    missing: string[];
    problems: string[];
    pending?: string[];
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
    team: string | null;
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
/** 编排牵头形态：raise=拉起 Manager lane 代管调度；leader-direct=Leader 直管派发（无 Manager 批，O0f 兜底协议） */
export type ManagerPlan = 'raise' | 'leader-direct';
/** R-5（P4 授权修复批，2026-09-25 · `plan/fix-spec.md` §2.4）：批级**通道归属声明**枚举。
 *  `dispatch` = 现有 dispatch 通道语义（**缺省**，存量批零变化）；`team` = roster 席位通道；
 *  `mixed` = 两者并存。归一化/静态校验单点 = `lib/wave-plan.js#normalizeChannelDecl`（非法值拒 `GATE_CHANNEL_INVALID`、
 *  与 lane `roster` 分布矛盾拒 `GATE_CHANNEL_UNRESOLVED`）；落盘位 = `Batch.channel`。 */
export type ChannelDecl = 'dispatch' | 'team' | 'mixed';
/**
 * 批次级装配声明（建批方随 wave_plan 传入；normalizeAssemblyDecl 归一化后经 createBatch
 * 持久化为 batch JSON 顶层可选字段，schema 不升、旧批零迁移）。
 * 入参必填：auditLane（验收归属 lane id，须存在于 tasks 且为 audit 层 lane）；
 * 入参可选：managerPlan（编排牵头形态，**缺省 raise** —— 2026-09-14 用户裁决「Manager 见批即默认」；
 *  升格为**引擎可核事实**：归一化后恒有值，收口告警按该声明触发，见 state/store.js）、
 *  coordinatorLane（协调细拆 lane id，须存在于 tasks 且为 plan 层 lane）、roles（参与角色集，词法校验软告警）。
 * 注：本接口描述的是**归一化后的 decl**（managerPlan 恒有值）；建批入参的必填/缺省口径见 core.js wave_plan 参数面。
 */
export interface WavePlanAssemblyDecl {
    managerPlan: ManagerPlan;
    auditLane: string;
    coordinatorLane?: string;
    roles?: string[];
}
/** 环防护记账状态（mailbox 环防护；batch JSON 唯一事实源，v3 字段） */
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
/** 豁免类型白名单（四值；未知值拒 GATE_EXEMPT_TYPE_UNKNOWN，不静默取默认档） */
export type LaneExemptType = 'ai-render' | 'large-download' | 'dep-install' | 'none';
/** 派发面来源（结构性证据：豁免只能由 pending→running / idle→running 写入） */
export type LaneExemptGrantedFrom = 'pending' | 'idle';
/**
 * 单 lane 豁免授予记录（batch.laneExempt[laneId] 值形态）。
 * tierMultiplier = 档位表原始默认（审计用：可辨「用户显式覆盖倍率」与「档位默认」）；
 * multiplier = 生效倍率（显式 > 档位表）；stalled = 是否同时豁免 heartbeat stalled 追问。
 */
export interface LaneExemptGrant {
    grantedAt: string;
    grantedFrom: LaneExemptGrantedFrom;
    type: LaneExemptType;
    multiplier: number;
    tierMultiplier: number;
    stalled: boolean;
}
/** 豁免表：laneId → 授予记录（批次级可选字段；缺省 undefined = 无豁免，读取兼容零迁移） */
export type LaneExemptMap = Record<string, LaneExemptGrant>;
/** 团队资产解析快照的**批次级指纹引用**（§8③，批次 `a3-snapshot-b1-20260915`）。
 *  · 纯增量可选字段（缺省 undefined = 旧批/未落盘，读取兼容零迁移）；`schema` 不升（仍为 3）。
 *  · **只引用不复制**：完整解析结果在会话级正档 `<sessionDir>/team-assets/<team>.<hash>.json`，
 *    本字段只带指纹 + 键级摘要（不含资产正文、不含完整 summary）。
 *  · **不参与任何门禁判定**：派生观察面；缺档 ⇒ `gate_status` 回 `declarationMissing:true`（不回落现算）。
 *  · 无资产批（`generic` / 拼错 / 退役团队）：本字段照落（`ok:false`、指纹为 null），**不写档、不落事件**。
 *  · 写档失败 ⇒ `snapshotWriteFailed:true`（告警 + 留痕，**不拒建批**：观察面故障不升级为治理面拒态）。 */
export interface TeamAssetRef {
    team: string;
    root: string;
    rootKind: 'package' | 'teams-root';
    assetPath: string | null;
    assetHash: string | null;
    assetSig: string | null;
    snapshotPath: string | null;
    resolvedAt: string;
    ok: boolean;
    severity: 'none' | 'strong' | 'blocking';
    snapshotWriteFailed?: boolean;
    summaryKeys: {
        produceFields: string[];
        consumeFields: Record<string, string>;
        entryRequiresSource: Record<string, 'team-asset:entry_requires' | 'tighten-only-default' | null>;
        flagsResolved: Record<string, {
            declared: boolean;
            value: boolean | null;
            effective: boolean;
        }>;
        contractSections: string[] | null;
        unwiredKeys: string[];
    };
}
/** 批次对象（v3：store.js createBatch 运行时形态 + schema-v3.js migrateV2toV3 兜底字段） */
export interface Batch {
    schema: 3;
    sessionId: string;
    batchId: string;
    phase: BatchPhase;
    concurrency: number;
    team: string | null;
    wavePlan: Wave[];
    lanes: Record<string, MemberState>;
    chains: ChainsState;
    archived: boolean;
    assembly?: WavePlanAssemblyDecl | null;
    teamsRoot?: string;
    laneProgress?: LaneProgressMap;
    handoffs?: LaneHandoffMap;
    laneExempt?: LaneExemptMap;
    /** sig 任务内容指纹（N3-②）· **纯去重记账**（形态同 laneProgress 惯用法：缺省 undefined = 无记录）。
     *  键 = `<lane>|<对端 lane:态, …>`（`lib/sig-fingerprint.js#recordSigDuplicate` 产出），值恒 `true`。
     *  **零判定读端**：只用于「同 (lane, 对端集合) 只落一条 `sig.duplicate_detected`」的去重记账，
     *  不参与任何门禁判定、不进 `GateErrorCode`（D-sig-2：留痕不阻断）。 */
    sigDuplicateLogged?: Record<string, boolean>;
    teamAsset?: TeamAssetRef;
    /** R-5（P4 授权修复批，2026-09-25 · `plan/fix-spec.md` §2.4.3）：批级**通道归属声明**真源。
     *  · **纯增量可选字段**（缺省 `undefined` = 存量批/未声明）⇒ 读端放行 + 可核留痕，与 `handoffs` 存量口径同形。
     *  · **未声明时不写键**（键不存在），**不落 `'dispatch'` 默认值**——「缺省 `dispatch`」是**归一化读端**的
     *    有效值（`normalizeChannelDecl` 回 `{ channel:'dispatch', declared:false }`），不是落盘值；故建无 `channel`
     *    字段的批读端零感知、零写入（R5-a/R5-d 的实现取值，见 `exec/contract-change.md`）。
     *  · 写端 = 建批路径（`lib/tools/core.js` 消费 `normalizeChannelDecl` 后落盘）；**单点判定**，运行期不再二次判定。
     *  · 禁双真源：通道归属真源**恒** `batch.channel`，不得从事件流事后重建（`plan/fix-spec.md` §约束 6）。 */
    channel?: ChannelDecl;
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
 * 尾部兜底分支保证未知/未来事件不报错（lane.stalled /
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
    type: 'lane.handoff';
    lane: string;
    from: string;
    to: string;
    artifacts: string[];
    assertions: string[];
    handoffBatch: string;
} | {
    type: 'lane.handoff.gap';
    lane: string;
    code: string;
    missing: string[];
    legacy?: boolean;
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
    type: 'gate.contract_missing';
    cause: 'undeclared' | 'declared-off' | 'unresolvable';
    gateKind: string;
    layer: string | null;
    lane: string | null;
    declared: boolean;
    source: string;
    degrade: {
        kind: string;
        note: string;
    };
    problems: string[];
} | {
    type: 'archive.failed';
    reason: string;
} | {
    type: 'sig.duplicate_detected';
    lane: string;
    sig: string;
    matches: Array<{
        lane: string;
        state: string;
    }>;
    notice: Array<{
        lane: string;
        state: string;
        layer: string | null;
    }>;
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
export type GateErrorCode = 'GATE_ENTRY_MISSING' | 'GATE_HANDOFF_MISSING' | 'GATE_AUDIT_INPUT_MISSING' | 'GATE_AUDIT_CRITERIA_MISSING' | 'GATE_BATCH_REQUIRES_C' | 'GATE_MEMBER_REQUIRES_C' | 'GATE_PLAN_CONTRACT' | 'GATE_TOKEN_UNKNOWN' | 'GATE_VOCAB_INVALID' | 'GATE_EXIT_MISSING_EXEC' | 'GATE_EXIT_MISSING_AUDIT' | 'GATE_NEEDHUMAN_PENDING' | 'GATE_EXIT_NO_COMMAND' | 'GATE_EXIT_FORBIDDEN' | 'GATE_EXIT_TIMEOUT' | 'GATE_EXIT_SPAWN_FAIL' | 'GATE_EXIT_NONZERO' | 'GATE_TARGET_MISSING' | 'GATE_TARGET_UNCHANGED' | 'GATE_COMPLETE_NO_AUDIT' | 'GATE_EXIT_PENDING_AUDIT' | 'GATE_COMPLETE_AUDIT_FAILED' | 'GATE_COMPLETE_EXEC_PENDING' | 'GATE_COMPLETE_OUTCOMES_EMPTY' | 'GATE_SETTLE_NOTE_MISSING' | 'GATE_EXEMPT_NOT_DISPATCH' | 'GATE_EXEMPT_INVALID' | 'GATE_EXEMPT_TYPE_UNKNOWN' | 'GATE_EXEMPT_REVOKE_REQUIRED' | 'GATE_HANDOFF_UNAUTHORIZED' | 'GATE_HANDOFF_IDENTITY_UNKNOWN' | 'GATE_HANDOFF_OVERWRITE_UNDECLARED' | 'GATE_ROSTER_INVALID' | 'GATE_CHANNEL_INVALID' | 'GATE_CHANNEL_UNRESOLVED';
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
