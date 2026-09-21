/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// lib/types/contracts.ts —— 契约类型层
//
// type-only：本文件只含 type/interface 声明，零值导出、零运行期产物（编译产物为空模块）。
//   消费方式：
//     - schema/schema-v3/machine-rules/gates/wave-plan 等 .ts 模块
//       `import type { ... } from '../types/contracts.js'`（import type 编译期擦除）；
//     - JS 侧 JSDoc 纯类型引用：`/** @type {import('../types/contracts.js').Batch} */`
//       （JSDoc 类型注解编译期擦除，零运行时 require——JS 文件本身不得 import 本文件）。
//
// 单一事实源：字面量联合（MemberState/BatchPhase/SettleState）与 lib/schema.js 常量
//   MEMBER_STATES/BATCH_PHASES/SETTLE_STATES 逐值一致；schema.ts 派生类型从 '../schema.js'
//   re-export（两处字面量结构等价）。派生方向单向：schema(常量+派生) → contracts(通用形状)
//   → 消费 .ts；类型层 import 全部擦除，无运行期循环依赖风险。

// ── 枚举字面量联合（与 lib/schema.js 常量逐值一致）──

/** 成员状态：pending/running/review 迁移中态 + merged/failed/skipped/conflict 终态 + idle **空闲态**（8 值；idle = 字面意义的空闲，非崩溃态，返工/续跑可调用） */
export type MemberState =
  | 'pending'
  | 'running'
  | 'review'
  | 'merged'
  | 'failed'
  | 'skipped'
  | 'conflict'
  | 'idle';

/** 批次阶段：planning/running/paused 非终态 + aborted/complete 终态（5 值） */
export type BatchPhase = 'planning' | 'running' | 'paused' | 'aborted' | 'complete';

/** 结算终态三值（isMemberTerminal 判定 = SETTLE_STATES.includes(s) || s === 'conflict'） */
export type SettleState = 'merged' | 'failed' | 'skipped';

// ── 迁移表（通用 Record 形态；schema.ts 常量以 satisfies 绑定防漂移）──

/** 成员迁移表：from 态 → 合法 to 态列表（只读；运行期只复制后写，不原地改常量） */
export type TransitionTable = Record<MemberState, readonly MemberState[]>;

/** 批次阶段迁移表（同 TransitionTable 语义） */
export type BatchTransitionTable = Record<BatchPhase, readonly BatchPhase[]>;

// ── WavePlanTask（输入/持久双形态）──

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
  checkpoint?: { steps: number };
  resume?: boolean;
  targets?: string[];           // 批次产物根外绝对路径目标文件
  targetsMarker?: string | null;
  standalone?: boolean;         // 无上游消费声明（entry_requires 强制时的显式逃生；缺省 false）
  standaloneReason?: string;    // standalone 逃生**理由**（B7-b：必填事实字段，建批入参形态 = string，见下 WavePlanTask 持久形态）
  targetsNoChange?: boolean;    // 零改动声明（只核 targets 存在性，跳过变更性判定；缺省 false）
  owner?: string | null;        // N1-R4-1（K1 公共池）：任务**归属声明**。缺省/非字符串 ⇒ 归一化落 `null` = **在池内**
                                //   （未派发）；非空 = 已出池（已归属某执行方）。⚠ 本字段**只作声明面**，写方见 §7.4.2。
}

/** 持久形态：buildWavePlan 规范化产物（gates.ts / validateWavePlan / findTask 消费面） */
export interface WavePlanTask {
  id: string;
  cmd: string;                  // assembleCmd 产物，恒 string（缺省 ''）
  deps: string[];               // 缺省 []
  model: string | null;         // 缺省 null
  tools: string[] | null;       // 缺省 null
  layer: Layer | null;          // 缺省 null（generic 任务）
  role: string | null;          // 归一化小写规范名；非法角色保留原值（GATE_ROLE_INVALID 告警）
  skills: string[] | null;      // 缺省 null（装配补全或显式声明后为数组）
  consume: string[] | null;     // 缺省 null
  produce: string[] | null;     // 缺省 null
  outputs: string[] | null;     // 缺省 null
  condition: ConditionClause[] | null; // normalizeCondition 产物：统一对象数组；null = 恒满足
  checkpoint: { steps: number } | null; // normalizeResumeContract 产物
  resume: boolean;              // 缺省 false
  targets: string[] | null;     // 缺省 null（绝对路径数组）
  targetsMarker: string | null; // 缺省 null
  standalone?: boolean;         // buildWavePlan 恒写；缺省 false（无上游消费声明）
  /** standalone 逃生理由（B7-b 补入类型面）：buildWavePlan 归一化**恒写**——字符串原样保留、非字符串（含缺省）落 null
   *  （与 targetsMarker 同风格：缺省落 null 不落 undefined）。写端 `lib/wave-plan.ts`（归一化保留）、
   *  读端 `lib/state/gates.ts` 的 `standaloneVerdict`（为空 ⇒ 拒 GATE_STANDALONE_UNJUSTIFIED）。 */
  standaloneReason?: string | null;
  targetsNoChange?: boolean;    // buildWavePlan 恒写；缺省 false（零改动声明）
  /** P1 交接门（M-6 双写，**只读回显**）：官方任务板 `team_task_create` 产出的 task id 镜像。
   *  **不参与任何判定**（判定只看黑板 `batch.handoffs`）；缺省 null = 未建官方 task（零感知）。 */
  officialTaskId?: string | null;
  /** N1-R4-1（K1 公共池）：任务**归属声明**——`null` = **在池内**（未派发）、非空 = 已出池。
   *  buildWavePlan 归一化**恒写**（非字符串含缺省 ⇒ `null`，与 `targetsMarker` 同风格：不落 undefined）。
   *  ⚠ **本字段只作声明面**：池 = `owner == null` 的**视图**（不是容器），不引入认领/claim 语义；
   *     派发仍由 Leader 单点发起（`lane_dispatch`）。写入方见 `docs/new-engine-blueprint-2026-09-21.md §7.4.2`。 */
  owner: string | null;
}

// ── P1 交接门（handoff gate；R2/P1 批次，2026-09-17）──
// 定位（`docs/p1-handoff-gate-changeplan-20260917.md` §2/§3）：**长生命周期成员 DAG 交接模型的核心硬门**——
//   「保证 DAG 内下游成员可以稳定拿到上游产出的依赖」（用户 M-7 裁决 = 验收核心）。
// 真源分工（禁双真源）：**读端真源 = `batch.handoffs`**（不做事后事件流重建，避免 O(n) 扫描）；
//   审计真源 = 事件 `lane.handoff`（每次提交一条）；缺口留痕 = 事件 `lane.handoff.gap`（拒下游时落）。
// 建批期意图声明（裁决 ②=A 的判据来源）：`buildWavePlan` 按 `task.deps` 的每条入边**种一条 pending 交接**——
//   ⇒ 「该 lane 有交接声明来源」在建批期即成**机器可判事实**（下游定义了 deps 却解析不到上游声明 ⇒ 建批期拒）。
// 缺省口径（裁决 ①=B）：存量批无 `batch.handoffs` 字段 ⇒ 未交接门**整体放行 + 落 `lane.handoff.gap` 告警**
//   （不静默、不砸存量）；新建批一律带该字段（空对象 = 无 deps 的批）。

/** 交接契约（下游据此取件；`consumedFrom` = 消费证据，替代消息 ack 语义） */
export interface LaneHandoffContract {
  consumedFrom: string;         // 下游承认的消费来源（恒 = from lane id；用于审计可核）
  assertions: string[];         // 上游给出的**可核断言**（下游对照用；非空）
}

/** 单条交接记录（`batch.handoffs[toLaneId][]` 值形态） */
export interface LaneHandoff {
  from: string;                 // 上游 lane id（= 下游 deps 的某条入边）
  to: string;                   // 下游 lane id
  batch: string;                // 批次 id（跨批引用留痕；本 P1 只支持批内）
  step?: string | null;         // 可选：链步 id（有 chain 的批用于对齐推进链）
  artifacts: string[];          // 上游交付产物（相对批次产物根的路径）；**逐个存在**才算交接成立
  contract: LaneHandoffContract;
  status: 'pending' | 'submitted'; // pending = 建批期种的声明（未交接）；submitted = handoff_submit 已落
  ts: string;                   // ISO（最后更新时刻）
  /** 官方任务板镜像（M-6 双写，**只读回显**）：由 Leader 侧 `team_task_create` 后回填；
   *  **不参与任何判定**（判定只看黑板 = 本字段所在对象），写失败只落 `mirror.gap`、不进拒绝路径。 */
  officialTaskId?: string | null;
}

/** 交接表：**toLaneId** → 该 lane 的入边交接列表（批次级可选字段；缺省 undefined = 存量批 ⇒ 门整体放行 + 留痕） */
export type LaneHandoffMap = Record<string, LaneHandoff[]>;

/** 交接门判定结果（`gates.ts` 内部使用；`missing` 须能让下游看出**缺哪条边 / 缺哪件产物**） */
export interface HandoffVerdict {
  ok: boolean;
  legacy?: boolean;             // true = 存量批（无 handoffs 字段）⇒ 放行 + 留痕
  missing: string[];            // 缺口清单（'edge:<from>->' / '<artifact> (missing)' / 'contract.assertions' …）
  problems: string[];
  pending?: string[];           // 建批期种下但尚未 submitted 的入边（审计可读）
}

/** 单 wave 层：wave 序号 + 该层任务列表（topoWaves 分层产物） */
export interface Wave {
  wave: number;
  tasks: WavePlanTask[];
}

/** buildWavePlan 返回值（建批产物文档） */
export interface WavePlanDoc {
  schema: number;               // SCHEMA_VERSION = 1
  batchId: string;
  team: string;                 // P1（2026-09-16）：必填、无缺省（原 `'generic'` 兜底已废除）
  wavePlan: Wave[];
  concurrency: number;          // 正整数兜底 5
  warnings: Array<{
    code: string;
    task?: string;
    layer?: string;
    role?: string;
    missing?: string;
    message: string;
  }>;
}

// ── 批次级装配声明（C+ 档门禁；wave_plan 可选顶层参数 assembly 的归一化产物）──

/** 编排牵头形态：raise=拉起 Manager lane 代管调度；leader-direct=Leader 直管派发（无 Manager 批，O0f 兜底协议） */
export type ManagerPlan = 'raise' | 'leader-direct';

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
  auditLane: string;            // 验收归属 lane id（须为 audit 层 lane；悬空/层错配 → GATE_ASSEMBLY_INVALID 拒建批）
  coordinatorLane?: string;     // 可选：协调/细拆 lane id（须为 plan 层 lane；声明后承担 CBM 代码摸底→细拆履职）
  roles?: string[];             // 可选：声明参与角色集（词法白名单校验；非法词条 → GATE_ROLE_INVALID 告警，批次照建）
}

// ── Batch / Lane / BatchEvent ──

/** 环防护记账状态（mailbox 环防护；batch JSON 唯一事实源，v3 字段） */
export interface ChainsState {
  chains: Record<string, { edges: Record<string, number>; said: Record<string, string> }>;
  order: string[];
}

/** 断点进度（laneProgress 值形态；status 与成员态对齐，不新增成员态） */
export interface LaneProgress {
  step: number;
  total: number;
  status: 'running' | 'review';
  updatedAt: string;            // ISO
}

/** 断点进度表：laneId → 进度（批次级可选字段；缺省 undefined = 无断点记录） */
export type LaneProgressMap = Record<string, LaneProgress>;

// ── longrun 长程豁免（批次级 laneExempt；授予只能发生在派发面，见 lib/state/lane-exempt.js）──

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
  grantedAt: string;                 // ISO（pump 授予时刻）
  grantedFrom: LaneExemptGrantedFrom;
  type: LaneExemptType;
  multiplier: number;                // 生效倍率（1..100）
  tierMultiplier: number;            // 档位表原始默认（审计留痕）
  stalled: boolean;                  // 缺省 true
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
  rootKind: 'package' | 'teams-root';   // 解析根类别（DI 缝 flowsRoot 在建批侧不可达 ⇒ 不写该值）
  assetPath: string | null;
  assetHash: string | null;             // sha256(资产原始字节) 前 16 位 hex（内容等价 ⇒ 同档名）
  assetSig: string | null;              // 路径:mtimeMs:size（缓存新旧判定用，与 assetHash 不互替）
  snapshotPath: string | null;          // 相对 <sessionDir>，如 'team-assets/software-team.ab12cd34ef567890.json'
  resolvedAt: string;                   // ISO
  ok: boolean;
  severity: 'none' | 'strong' | 'blocking';
  snapshotWriteFailed?: boolean;
  summaryKeys: {
    produceFields: string[];                                            // 恒 ['produce','outputs']（平面化）
    consumeFields: Record<string, string>;
    entryRequiresSource: Record<string, 'team-asset:entry_requires' | 'tighten-only-default' | null>;
    flagsResolved: Record<string, { declared: boolean; value: boolean | null; effective: boolean }>;
    contractSections: string[] | null;
    unwiredKeys: string[];
  };
}

/** 批次对象（v3：store.js createBatch 运行时形态 + schema-v3.js migrateV2toV3 兜底字段） */
export interface Batch {
  schema: 3;                    // BATCH_SCHEMA_V3
  sessionId: string;
  batchId: string;
  phase: BatchPhase;
  concurrency: number;
  team: string;
  wavePlan: Wave[];             // 注意：是 Wave 数组（buildWavePlan 产物 .wavePlan 字段）
  lanes: Record<string, MemberState>; // laneId → 成员态（建批全 'pending'）
  chains: ChainsState;          // v3 字段（chainsDefaults 兜底）
  archived: boolean;            // v3 字段（false 缺省；complete 归档后置 true）
  assembly?: WavePlanAssemblyDecl | null; // v3 纯增量可选字段（缺省 undefined = 未声明/旧批，读取兼容零迁移；C+ 批建批时归一化落盘，auditLane/coordinatorLane 层归属已静态校验）
  teamsRoot?: string; // v3 纯增量可选字段（缺省 undefined = 内置团队，flows 按包根解析）：会话级**临时团队资产根**（绝对路径）——门禁读端据此解析该团队的 flows 声明（entry_requires/contract/produce_field/needhuman/audit_contract.verdict；complete 白名单唯一真源 = verdict，E-4 清退后无 flows.complete 键）
  laneProgress?: LaneProgressMap; // v3 可选字段；非法形态经 migrateV2toV3 归一为 undefined（不写字段）
  handoffs?: LaneHandoffMap;      // P1 交接门：v3 纯增量可选字段。**缺省 undefined = 存量批** ⇒ 未交接门放行 + 落 `lane.handoff.gap`（裁决 ①=B）；新建批恒写（空对象 = 无 deps 的批，字段存在即「本批受新门约束」）
  laneExempt?: LaneExemptMap;     // v3 纯增量可选字段（缺省 undefined = 无豁免；空表整键删除，不写键；探针层只读消费）
  teamAsset?: TeamAssetRef;       // §8③ 团队资产解析快照的批次级指纹引用（建批事务内落盘；不参与门禁判定）
  events: BatchEvent[];
  createdAt: string;            // ISO
  updatedAt: string;            // ISO
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
export type BatchEvent = BatchEventBase & (
  | { type: 'batch.created'; batchId: string; sessionId: string }                     // EVT_BATCH_CREATED
  | { type: 'batch.phase'; from: BatchPhase; to: BatchPhase; reason?: string }        // EVT_BATCH_PHASE
  | { type: 'batch.failed-escalate'; lane: string; count: number }                    // EVT_BATCH_FAILED_ESCALATE
  | { type: 'batch.governance-escalate'; count: number; windowMs: number; lane: string; receiptIds: string[] } // EVT_BATCH_GOVERNANCE_ESCALATE
  | { type: 'governance.refusal'; lane: string; receiptId: string; primitive: string; ruleRefs: string[]; tool: string } // EVT_GOVERNANCE_REFUSAL
  | { type: 'member.settled'; lane: string; from: MemberState; to: MemberState; note: string | null } // EVT_MEMBER_SETTLED
  | { type: 'lane.skipped'; lane: string; from: MemberState; note: string }           // EVT_LANE_SKIPPED
  | { type: 'lane.needhuman'; lane: string; path: string | null }                     // EVT_LANE_NEEDHUMAN
  | { type: 'lane.recycled'; lane: string; from: string; reason: string; note: string | null } // EVT_LANE_RECYCLED
  | { type: 'human.decision'; lane: string; note: string | null }                     // EVT_HUMAN_DECISION
  | { type: 'asset.claimed'; lane: string | null; source: string; target: string }    // EVT_ASSET_CLAIMED
  | { type: 'lane.handoff'; lane: string; from: string; to: string; artifacts: string[]; assertions: string[]; handoffBatch: string } // EVT_LANE_HANDOFF（载荷键纪律：`type` 承载事件名，故批 id 写 handoffBatch）
  | { type: 'lane.handoff.gap'; lane: string; code: string; missing: string[]; legacy?: boolean } // EVT_LANE_HANDOFF_GAP（拒下游 / 存量批放行时落，含缺哪条边、缺哪件产物）
  | { type: 'gate.entry.missing'; lane: string; missing: string[] }                   // EVT_GATE_ENTRY_MISSING
  | { type: 'gate.exit.missing'; lane: string; code: string; detail: unknown }        // EVT_GATE_EXIT_MISSING
  | { type: 'gate.passed'; lane: string; gate: string }                               // EVT_GATE_PASSED
  | { type: 'gate.target_blocked'; lane: string; code: string; missing: string[]; unchanged: string[] } // EVT_GATE_TARGET_BLOCKED
  | { type: 'gate.target.passed'; lane: string; mode: string; targets: string[] }     // EVT_GATE_TARGET_PASSED
  | { type: 'gate.exit_blocked'; lane: string; code: string; command: string | null; exitCode: number | null; detail: string | null; escalation: boolean } // EVT_GATE_EXIT_BLOCKED
  | { type: 'gate.exit'; lane: string; commands: string[]; results: unknown[]; outputTruncated: boolean } // EVT_GATE_EXIT
  | { type: 'gate.needhuman_blocked'; lane: string; code: string; path: string | null } // EVT_GATE_NEEDHUMAN_BLOCKED
  | { type: 'gate.complete_blocked'; code: string; pending?: string[] }               // EVT_GATE_COMPLETE_BLOCKED
  // EVT_GATE_CONTRACT_MISSING（B2 §8⑤ 运行期首触校验）：团队资产未声明某检查项 ⇒ 引擎缺省接管时**首次触发**。
  //   非拒态（**不是** GateErrorCode，故不进下方枚举）；去重键 (batchId, gateKind, layer)「只报一次/批」；
  //   只由 store 写路径发射（只读视图零事件）。载荷键**不占用 `type`**（事件名槽位）。
  | { type: 'gate.contract_missing'; cause: 'undeclared' | 'declared-off' | 'unresolvable'; gateKind: string; layer: string | null; lane: string | null; declared: boolean; source: string; degrade: { kind: string; note: string }; problems: string[] } // EVT_GATE_CONTRACT_MISSING
  | { type: 'batch.team-asset.resolved'; team: string; root: string; rootKind: 'package' | 'teams-root'; assetPath: string | null; assetHash: string | null; ok: boolean; severity: 'none' | 'strong' | 'blocking'; snapshotPath: string | null; snapshotWriteFailed?: boolean; problems: string[]; unwiredKeys: string[] } // EVT_BATCH_TEAM_ASSET_RESOLVED（载荷键不占用 type 槽位）
  | { type: 'archive.failed'; reason: string }                                        // EVT_ARCHIVE_FAILED
  | { type: 'system.recovered'; batchId: string; sessionId: string; recoveredLanes: string[]; detail: unknown[] } // EVT_SYSTEM_RECOVERED
  // 兜底：扩展事件（lane.stalled / lane.over-budget / budget.rejected /
  //   worktree.created|checkpoint|merged|merge.conflict|merge.resolved /
  //   gate.role_missing / gate.role_invalid / archive.done / system.restored 等）
  //   与未来新增事件——ts+type 必备，其余字段保持 unknown 可读
  | { type: string; [k: string]: unknown }
);

// ── GateResult 判别联合（gates.js 全部返回点；核心形态 + 载荷可选字段）──

/** 门禁失败错误码全量枚举（按层后缀/门禁族；不设通配符，保持穷尽性收益） */
export type GateErrorCode =
  // entry（consume 前置）
  | 'GATE_ENTRY_MISSING'
  | 'GATE_HANDOFF_MISSING'   // P1 交接门（裁决 ④=A）：**新造独立码**，不复用 GATE_ENTRY_MISSING（语义独立、审计可辨）
  // entry（audit 判据来源锚定，P1，2026-09-14）
  | 'GATE_AUDIT_INPUT_MISSING'
  | 'GATE_AUDIT_CRITERIA_MISSING'
  // 【gate-lite 第二批 · A（2026-09-17 用户裁决「全删 + 改造为官方 roster 承抽」）】原枚举成员
  //   `'「未拉起 Manager」码(已删)'` 已删除：Manager 在册判定改由**官方 roster** 承抽
  //   （读端 `lib/tools/core.js#managerRosterOf`；建批期落 `gate.manager_roster_gap`）⇒ 派发面无拒态。
  // 成员面档位一致性（G1，2026-09-14，严格档）
  | 'GATE_BATCH_REQUIRES_C'
  | 'GATE_MEMBER_REQUIRES_C'
  // plan 契约
  | 'GATE_PLAN_CONTRACT'
  // R1「契约三小件」·词表面（`docs/r1-blueprint-spec.md` §2.1(f) 冻结 2 条）——
  //   写端 = `lib/state/gates.ts` 的 entry 门 E1（`:checkEntryGate`）与命令门 C3（`:checkCommandGate`），
  //   两者**同一 tokenOf 单点**（`reasonVocabularyVerdict` ⇒ `vocabulary.js#reasonTokenKnown`），禁两套口径。
  //   · `GATE_TOKEN_UNKNOWN`：**新增写点**在产物内声明了未登记的 `kind=gate|reason` token ⇒ **拒**
  //     （Q-3=B 只对新增码强制注册；存量不追溯由词表内容承载：`entries: []` ⇒ 零 token 命中）。
  //   · `GATE_VOCAB_INVALID`：`vocabulary.json` 自身 schema 校验不过 ⇒ **告警级（fail-open，不拒批）**——
  //     只作 `escapes[{kind:'vocabulary-unavailable'}]` 的**可读码**经 `vocabCode` 回显（词表损坏不得砸生产）。
  | 'GATE_TOKEN_UNKNOWN'
  | 'GATE_VOCAB_INVALID'
  // exit（按层后缀）
  | 'GATE_EXIT_MISSING_EXEC' | 'GATE_EXIT_MISSING_AUDIT'
  // needHuman 人工闸
  | 'GATE_NEEDHUMAN_PENDING'
  // 命令 gate（V1）——GATE_EXIT_* 全族
  | 'GATE_EXIT_NO_COMMAND' | 'GATE_EXIT_FORBIDDEN' | 'GATE_EXIT_TIMEOUT'
  | 'GATE_EXIT_SPAWN_FAIL' | 'GATE_EXIT_NONZERO'
  // targets 门禁
  | 'GATE_TARGET_MISSING' | 'GATE_TARGET_UNCHANGED'
  // complete 门禁
  | 'GATE_COMPLETE_NO_AUDIT' | 'GATE_EXIT_PENDING_AUDIT'
  | 'GATE_COMPLETE_AUDIT_FAILED' | 'GATE_COMPLETE_EXEC_PENDING'
  // complete 门**专用诊断码**（GAP-S2，2026-09-16）：`flows.audit.audit_contract.verdict` 已声明，却与
  //   `{pass,skip}` **交集为空**（有效白名单 `values.length === 0`）⇒ 与「审计真没通过」分码，使
  //   「资产词表写成产物层词（approve/reject）」不再被静默读成验收未过。
  //   写端 = `lib/state/gates.ts` `checkCompleteGate`（载荷回显 declared / narrowed / values）。
  //   非语义放宽：`ok:false` 与既有一切拒判逐字不变（fail / conflict 恒拒不变），仅换码 + 补诊断字段。
  | 'GATE_COMPLETE_OUTCOMES_EMPTY'
  // 本会话新增拒绝码（B7-a 盲审缺口；此前 **只抛不枚举** —— 抛点在本面之外被穷尽枚举漏采，
  //   检索口径：全仓 `GATE_[A-Z_]+` 字面量与 `code:` 抛点逐枚对照，见 exec/e4/outputs/fix-e4.md 对照表）。
  //   成员面/批次面参数非法（store.js 直抛，无 GateResult 载荷）
  | 'GATE_SETTLE_NOTE_MISSING'   // review→failed/skipped/conflict 缺非空 note（lib/state/store.js:541）
  // 【gate-lite 第二批 · A（2026-09-17 用户裁决「全删」）】原枚举成员 `'「Manager 终态」码(已删)'` /
  //   `'「Manager 相位非法」码(已删)'` 已删除：Manager 登记面**不再按 phase 拒绝**（任意 phase 均可登记事实；
  //   在册判定改由官方 roster 承抽，见 `lib/tools/core.js#managerRosterOf`）⇒ 两码无拒态、不占码表。
  //   注：`'「Manager agentId 必填」码(已删)'` 从来只在 store 直抛、未入本枚举；同批一并删除（空 agentId ⇒ 返回
  //   null 不写垃圾记录，由调用方走「既无 phase 又无 manager」的显式报错分支，**不静默**）。
  //   派发面豁免参数非法（常量单点 lib/state/lane-exempt.js:53-58）
  | 'GATE_EXEMPT_NOT_DISPATCH'   // exempt 出现在 to!=='running'；或 revoke 与 status 并用（lane-exempt.js:54 常量 → store.js:527 抛；工具面 lib/tools/core.js:612/619 直抛）
  | 'GATE_EXEMPT_INVALID'        // 载荷结构非法（lane-exempt.js:55 常量 → normalizeExemptPayload lane-exempt.js:94 抛）
  | 'GATE_EXEMPT_TYPE_UNKNOWN'   // type 不在四值白名单（lane-exempt.js:56 常量 → normalizeExemptPayload lane-exempt.js:98 抛）
  | 'GATE_EXEMPT_REVOKE_REQUIRED'; // revokeExempt 但该 lane 无既有豁免（lane-exempt.js:57 常量 → store.js:463 抛）
  // 【2026-09-18 · Q-B **取消并发闸**】原枚举成员 `'GATE_CONCURRENCY_EXCEEDED'` 已删除：闸（判据纯函数 /
  //   拒码常量 / 拒态事件写点 / 三条派发面的准入调用）随 Q-B 整体退役
  //   （`docs/engine-design-adjudication-20260918.md:182`）⇒ 该码**无任何拒态来源**，不占码表（与
  //   `'「Manager 终态」码(已删)'` / `'GATE_SUBAGENT_OUTSIDE_LANES'` 等「无拒态即不占码表」同口径）。
  //   ⚠ 兼容面：磁盘历史批事件载荷里的 `code` 是 **string 数据**，不受本联合型收窄影响 ⇒ 历史读端
  //   （`log_export` 的 `gate.*` 过滤 / `batch_status` 事件清单）逐字不变；类型面无遗留消费者。
  //   ⚠ 生成物同步：本文件（源）与 `lib/types/contracts.d.ts`（生成物）**手工同改**（本批禁 `npm run build`，
  //   否则下一次 build 会以 `.ts` 产物回写覆盖 `.d.ts`）；`lib/types/contracts.js` 仅 `export {}`（680 B，
  //   无码表内容）⇒ **无需改**。

  // 派发套件（2026-09-15 用户裁决：C 档派发须携 lane 句柄；成员侧通信走套件工具）
  // 【gate-lite 第二批 · B（2026-09-17 用户裁决）】原枚举成员 `'GATE_SUBAGENT_OUTSIDE_LANES'` 已删除：
  //   官方 agent-team profile 已 `disabled` 掉宿主 `subagent` / `subagent_fork`
  //   （`dsh-experimental-agent-team-profile/cordis.patch.yml:10-14`）⇒ 闸门拦的工具在官方场景**不存在**；
  //   `config.dispatch.gate` 收敛为**只留痕不拦**（`evaluateTierCDispatch` 恒 `ok:true` + `warnNote`）。
  // 【gate-lite 第一批 · E② 清理（2026-09-17）】原枚举成员 `'GATE_SWARM_UNBOUND_REPORT'` 已删除：
  //   该身份门随 Q-G2 用户裁决「删除这一项」整条移除（官方 Team 成员无 lane 绑定是常态，不是异常）；
  //   成员回报改为 best-effort（消息照发 + 回显 `unbound`/`eventWritten`/`notice`），**无拒态** ⇒ 不占码表。

/** 门禁通过：ok: true + 各门禁可选载荷 */
export interface GateOk {
  ok: true;
  // 载荷（各门禁可选携带）：
  declared?: boolean;           // needHuman / command / targets 门禁的声明探测结果
  commands?: string[];          // command gate：已执行命令（保序）
  results?: Array<{ command: string; exitCode: number | null; durationMs: number }>;
  outputTruncated?: boolean;
  path?: string | null;
  mode?: 'mtime' | 'marker';    // targets 门禁判定模式
  targets?: string[];           // targets 门禁声明清单
  missing?: []; unchanged?: []; // ok 分支恒空数组（与 fail 分支对称，便于调用方统一读取）
}

/** 门禁失败：ok: false + code + 载荷（按门禁族可选携带） */
export interface GateFail {
  ok: false;
  code: GateErrorCode;
  missing?: string[];           // entry / targets / exit missing
  problems?: string[];          // plan 契约问题清单
  pending?: string[];           // complete 门禁 pending lane 清单
  command?: string | null;      // command gate
  exitCode?: number | null;
  detail?: string | null;
  declared?: boolean;
  path?: string | null;
  needHumanEscalation?: boolean; // command gate 失败 + 产物声明 needHuman → 转人工闸
  mode?: 'mtime' | 'marker';
  targets?: string[];
  unchanged?: string[];
  message?: string;             // needHuman 门禁提示语
}

/** 门禁结果判别联合：`if (g.ok)` 分支后即可访问 fail/ok 专属载荷字段 */
export type GateResult = GateOk | GateFail;
