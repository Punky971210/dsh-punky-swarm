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

// lib/types/contracts.ts —— 契约类型层（jiufeng-ts-phase12 · Phase 1 · coder）
//
// type-only：本文件只含 type/interface 声明，零值导出、零运行期产物（编译产物为空模块）。
//   消费方式：
//     - Phase 2 的 5 个模块（schema/schema-v3/machine-rules/gates/wave-plan）转 .ts 后
//       `import type { ... } from '../types/contracts.js'`（import type 编译期擦除）；
//     - JS 侧 JSDoc 纯类型引用：`/** @type {import('../types/contracts.js').Batch} */`
//       （JSDoc 类型注解编译期擦除，零运行时 require——JS 文件本身不得 import 本文件）。
//
// 单一事实源：字面量联合（MemberState/BatchPhase/SettleState）与 lib/schema.js 常量
//   MEMBER_STATES/BATCH_PHASES/SETTLE_STATES 逐值一致。Phase 1 自包含定义（schema.js
//   尚为 JS、无类型导出，`import type { ... } from '../schema.js'` 不可行）；Phase 2
//   schema.js→schema.ts 转换后按设计 §1.1/§2 改为从 '../schema.js' re-export 派生类型
//   （两处字面量结构等价，切换零风险）。派生方向单向：schema(常量+派生) → contracts(通用形状)
//   → 消费 .ts；类型层 import 全部擦除，无运行期循环依赖风险。

// ── §1 甲：枚举字面量联合（与 lib/schema.js 常量逐值一致）──

/** 成员状态：pending/running/review 迁移中态 + merged/failed/skipped/conflict 终态 + idle 恢复态（8 值） */
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

// ── §1 乙：迁移表（通用 Record 形态；schema.ts 常量以 satisfies 绑定防漂移）──

/** 成员迁移表：from 态 → 合法 to 态列表（只读；运行期只复制后写，不原地改常量） */
export type TransitionTable = Record<MemberState, readonly MemberState[]>;

/** 批次阶段迁移表（同 TransitionTable 语义） */
export type BatchTransitionTable = Record<BatchPhase, readonly BatchPhase[]>;

// ── §1 丙：WavePlanTask（输入/持久双形态）──

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
  targets?: string[];           // O2：批次产物根外绝对路径目标文件
  targetsMarker?: string | null;
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
  team: string;                 // 'generic' 兜底
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

// ── §1 丁：Batch / Lane / BatchEvent ──

/** 环防护记账状态（C4 mailbox；batch JSON 唯一事实源，v3 字段） */
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
  laneProgress?: LaneProgressMap; // v3 可选字段；非法形态经 migrateV2toV3 归一为 undefined（不写字段）
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
 * 尾部兜底分支保证未知/未来事件不报错（R-01 扩面事件：lane.stalled /
 * lane.over-budget / budget.rejected / worktree.* / gate.role_* /
 * archive.done / system.restored 等——ts+type 必备，其余字段 unknown 可读）。
 */
export type BatchEvent = BatchEventBase & (
  | { type: 'batch.created'; batchId: string; sessionId: string }                     // EVT_BATCH_CREATED
  | { type: 'batch.phase'; from: BatchPhase; to: BatchPhase; reason?: string }        // EVT_BATCH_PHASE
  | { type: 'batch.failed-escalate'; lane: string; count: number }                    // EVT_BATCH_FAILED_ESCALATE
  | { type: 'batch.governance-escalate'; count: number; windowMs: number; lane: string; receiptIds: string[] } // EVT_BATCH_GOVERNANCE_ESCALATE（M5-a C6）
  | { type: 'governance.refusal'; lane: string; receiptId: string; primitive: string; ruleRefs: string[]; tool: string } // EVT_GOVERNANCE_REFUSAL（M5-a C4）
  | { type: 'member.settled'; lane: string; from: MemberState; to: MemberState; note: string | null } // EVT_MEMBER_SETTLED
  | { type: 'lane.skipped'; lane: string; from: MemberState; note: string }           // EVT_LANE_SKIPPED
  | { type: 'lane.needhuman'; lane: string; path: string | null }                     // EVT_LANE_NEEDHUMAN
  | { type: 'lane.recycled'; lane: string; from: string; reason: string; note: string | null } // EVT_LANE_RECYCLED
  | { type: 'human.decision'; lane: string; note: string | null }                     // EVT_HUMAN_DECISION
  | { type: 'asset.claimed'; lane: string | null; source: string; target: string }    // EVT_ASSET_CLAIMED
  | { type: 'gate.entry.missing'; lane: string; missing: string[] }                   // EVT_GATE_ENTRY_MISSING
  | { type: 'gate.exit.missing'; lane: string; code: string; detail: unknown }        // EVT_GATE_EXIT_MISSING
  | { type: 'gate.passed'; lane: string; gate: string }                               // EVT_GATE_PASSED
  | { type: 'gate.target_blocked'; lane: string; code: string; missing: string[]; unchanged: string[] } // EVT_GATE_TARGET_BLOCKED
  | { type: 'gate.target.passed'; lane: string; mode: string; targets: string[] }     // EVT_GATE_TARGET_PASSED
  | { type: 'gate.exit_blocked'; lane: string; code: string; command: string | null; exitCode: number | null; detail: string | null; escalation: boolean } // EVT_GATE_EXIT_BLOCKED
  | { type: 'gate.exit'; lane: string; commands: string[]; results: unknown[]; outputTruncated: boolean } // EVT_GATE_EXIT
  | { type: 'gate.needhuman_blocked'; lane: string; code: string; path: string | null } // EVT_GATE_NEEDHUMAN_BLOCKED
  | { type: 'gate.complete_blocked'; code: string; pending?: string[] }               // EVT_GATE_COMPLETE_BLOCKED
  | { type: 'archive.failed'; reason: string }                                        // EVT_ARCHIVE_FAILED
  | { type: 'system.recovered'; batchId: string; sessionId: string; recoveredLanes: string[]; detail: unknown[] } // EVT_SYSTEM_RECOVERED
  // 兜底：R-01 扩面事件（lane.stalled / lane.over-budget / budget.rejected /
  //   worktree.created|checkpoint|merged|merge.conflict|merge.resolved /
  //   gate.role_missing / gate.role_invalid / archive.done / system.restored 等）
  //   与未来新增事件——ts+type 必备，其余字段保持 unknown 可读
  | { type: string; [k: string]: unknown }
);

// ── §1 戊：GateResult 判别联合（gates.js 全部返回点；核心形态 + 载荷可选字段）──

/** 门禁失败错误码全量枚举（按层后缀/门禁族；不设通配符，保持穷尽性收益） */
export type GateErrorCode =
  // entry（consume 前置）
  | 'GATE_ENTRY_MISSING'
  // plan 契约
  | 'GATE_PLAN_CONTRACT'
  // exit（按层后缀）
  | 'GATE_EXIT_MISSING_EXEC' | 'GATE_EXIT_MISSING_AUDIT'
  // needHuman 人工闸
  | 'GATE_NEEDHUMAN_PENDING'
  // 命令 gate（V1）——GATE_EXIT_* 全族
  | 'GATE_EXIT_NO_COMMAND' | 'GATE_EXIT_FORBIDDEN' | 'GATE_EXIT_TIMEOUT'
  | 'GATE_EXIT_SPAWN_FAIL' | 'GATE_EXIT_NONZERO'
  // targets 门禁（O2）
  | 'GATE_TARGET_MISSING' | 'GATE_TARGET_UNCHANGED'
  // complete 门禁
  | 'GATE_COMPLETE_NO_AUDIT' | 'GATE_EXIT_PENDING_AUDIT'
  | 'GATE_COMPLETE_AUDIT_FAILED' | 'GATE_COMPLETE_EXEC_PENDING';

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
