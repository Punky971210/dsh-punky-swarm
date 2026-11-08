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

/** 开工前必做 · MCP 项（`why` 必读：成员不知道拿它干什么就不会用）。
 *  渲染面：`why` 缺失/非字符串 ⇒ 归一化为 `''`，行尾渲染显式占位「（用途未声明）」（不静默丢项）。 */
export interface PreflightMcp { tool: string; why?: string }

/** 开工前必做 · 四段声明（全部可选；缺段渲染占位、全缺渲染警示行）。
 *  语义（D3 双轨）：本声明是**第三条渲染通道**（`## 开工前必做`），与 `task.skills`（装配前缀）
 *  / `role.skills`（role 三段内规格指向）**并存、不合并、不去重、不排序**；
 *  故 `preflight.skills` **不回写** `task.skills`、**不进** `cmd`、**不进** `sig`。
 *  ⚠ 归一化**恒写**（`WavePlanTask.preflight`）：缺省/非法形态 ⇒ `null`（= 未声明 ⇒ 渲染警示行），
 *  声明了但四段全空 ⇒ 仍是对象（= 声明了 ⇒ 渲染四段 + 每段占位）。归零 throw（全软，不拒建批）。 */
export interface PreflightDecl {
  kb?: string[];          // 知识库关键词（建议 2-3 个，具体到能直接粘进 weknora_search）
  skills?: string[];      // 技能名（确切名，不是「相关技能」）
  mcp?: PreflightMcp[];   // MCP 工具 + 用途
  checklist?: string[];   // 本任务相关检查表条目（内联，不让成员翻文档）
}

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
  /** R-3（P4 授权修复批，2026-09-25）：lane ← **roster 成员名**承载（`docs/b5-teammate-seat-design-v1-2026-09-25.md` §1/§3）。
   *  语义 = 「team 通道执行者标识」：写权判据读端按「哪些 lane 的 `roster` = 我」定 lane 写权（池化时天然覆盖其多条 lane）。
   *  **不设唯一性约束**——同一 roster 名可出现在多条 lane（一成员多 lane）、同类型多成员各书其名，均合法。
   *  归一化（`buildWavePlan` **恒写**）：缺省/非字符串/空串/纯空白 ⇒ `null`；非空字符串 ⇒ `trim()` 原样保留。
   *  非法形态（trim 后非空且不匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`）⇒ 建批期拒 `GATE_ROSTER_INVALID`（fail-closed）。
   *  ⚠ **不参与 `sig` 指纹**（`computeTaskSig` 输入面逐字不变 ⇒ 既有 sig 基线零漂移）。 */
  roster?: string | null;
  /** 开工前必做 · 四段声明（可选；归一化恒写、零 throw、不进 `sig`/`cmd`、不回写 `skills`）。 */
  preflight?: PreflightDecl;
  /** 【批 `ctx-fidelity-bing-20261108`】**项目上下文**（本 lane 执行时必须知道的背景：本域既有约定 /
   *  历史坑与已踩过的坑 / 当前进度与已完成面 / 边界禁令）。**渲染进任务包正文**（`## 项目上下文`），
   *  让成员拿到的「任务特有信息」不再只有 `cmd` 一句话。
   *  **与既有三个注入位的边界**（不重叠，禁合并）：
   *   · `cmd` = **做什么**（任务目标本身，进 `sig`）；
   *   · `leaderPrompt` = Leader 对**本次派发**的补充要点（落 `## 任务要点`，不进批次 JSON）；
   *   · `preflight` = **开工前查什么库/技能/MCP/检查表**（动作清单）；
   *   · 本字段 = **背景知识**（为什么要这样做 / 哪些坑已经踩过）。
   *  归一化**恒写**（缺省 / 非字符串 / 空 / 纯空白 ⇒ `null`，与 `targetsMarker` / `roster` 同风格：
   *  落 `null` 不落 `undefined`）；非空 ⇒ `trim()` 原样保留。
   *  ⚠ **不进 `sig`**（`computeTaskSig` 哈希输入面逐字不含本字段 ⇒ 既有 sig 基线零漂移）；
   *  ⚠ **不进 `cmd`**、**不回写 `skills`**（第五条渲染通道，与装配声明 / role 三段 / preflight 并存）；
   *  ⚠ 归一化**零 throw**（全软：形态不合法只降级，不拒建批、不打任何门禁码）。
   *  ⚠ IMM-2/3 兼容性：本字段**恒写 `null`** 使旧批（盘上无此键）重归一化后仍与旧值相等
   *  （`JSON.stringify(undefined ?? null)` === `JSON.stringify(null)`）⇒ 不会触发「字段被改写」拒。 */
  context?: string | null;
  /** 【批 `punky-type-assert-purge-20261103`】任务包计划清单（**复数**）。
   *  ⚠ 与上方 **`checkpoint`（单数）** 语义**完全不同**、互不影响：
   *    · `checkpoint`（单数）= **resume 契约**：lane **总步数上界**（供 `overBudgetOf` 判超界），fail-closed；
   *    · `checkpoints`（复数）= **任务包计划清单**（声明面，全软、永不抛、归一化后写盘）。
   *  ⇒ 本批**不改名**（改名会破存量批格式，另批裁决），只在此加区分注释。
   *  逐项为**原始输入**（归一化前的宽松形态）：`normalizeCheckpoints` 接收 `unknown` 并逐项校验，
   *  故此处字段均为 `unknown`（**不用 `any`**：仍需显式窄化才能使用）。
   *  ⚠ 归一化产物类型是 `wave-plan.ts` 的 `CheckpointItem`；此处**不 import** 它（`contracts.ts` 是
   *  `wave-plan.ts` 的上游，导入会成环）。 */
  checkpoints?: Array<{
    id?: unknown; target?: unknown; outputs?: unknown; acceptance?: unknown;
    rounds?: unknown; ctxBudget?: unknown;
    // 【fix2 · E4-K1】开工前必做四段（复用 `PreflightDecl` 形态：skills / kb / mcp / checklist）。
    //   与 `task.preflight`（任务级四段）**同形不同位**：本组是**每个 checkpoint 各自的**开工动作清单，
    //   渲染为该项下的缩进子行（`lib/engine/dispatch.js#renderCheckpointsBlock`）。
    //   ⚠ **建议性面**：非法/全缺 ⇒ 不拒建批、不抛、不打任何 `GATE_*`（E4-K3）；
    //   归一化在 `lib/wave-plan.ts#normalizeCheckpoints` 内逐项调用四段单点，**全空则不写四键**（= 未声明）。
    //   仍为 `unknown`（同一节奏：归一化前是宽松输入，需显式窄化才可用）。
    skills?: unknown; kb?: unknown; mcp?: unknown; checklist?: unknown;
  }>;
  /** 【同上批】`tasks[].contract` 契约引用：`{ id, sha256 }`。缺省不写键；非法 ⇒ **fail-closed 抛**（普通 `Error`）。 */
  contract?: { id: string; sha256: string | null } | null;
  /** 【同上批】单产物写声明（`true` = 该任务只写一个产物文件）。归一化恒写布尔：非 `true` ⇒ `false`。 */
  singleArtifactWrite?: boolean;
  sig?: string | null;          // sig 任务内容指纹（N3-②）：16 位小写 hex；**只由 buildWavePlan 计算落盘**（唯一计算入口），
                                //   `owner` 非空（已派发）⇒ 冻结不重算。**不参与任何门禁判定**、不进 `GateErrorCode` union；
                                //   缺省 / 非 16 hex（存量批亦然）⇒ 读取口径一律 `null`（见 lib/sig-fingerprint.js#sigOf）。
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
  /** R-3（P4 授权修复批，2026-09-25）：lane ← **roster 成员名**承载（team 通道执行者标识）。
   *  `buildWavePlan` 归一化**恒写**（缺省/非字符串/空串 ⇒ `null`，与 `targetsMarker` 同风格：不落 undefined）；
   *  非空字符串 ⇒ `trim()` 后原样保留（须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`，否则建批期拒 `GATE_ROSTER_INVALID`）。
   *  **不设唯一性约束**（一成员多 lane 合法、同类型多成员各书其名合法，均不产告警）；与 `owner` **并存互不替代**
   *  （`owner` 仍是公共池归属声明面、不参与门禁；`roster` 是 team 通道写权判据的输入）。
   *  ⚠ **不参与 `sig`**（`computeTaskSig` 输入面逐字不变）。 */
  roster: string | null;
  /** 开工前必做 · 四段声明（**归一化恒写**：缺省/非法形态 ⇒ `null`，与 `targetsMarker` 同风格不落 `undefined`；
   *  声明了但四段全空 ⇒ 对象本身（渲染四段 + 每段占位））。
   *  ⚠ **不进 `sig`**（`computeTaskSig` 输入面逐字不变 ⇒ 既有 sig 基线零漂移）、**不进 `cmd`**、
   *  **不回写 `skills`**（D3：第三条渲染通道，与装配声明并存不合并）。 */
  preflight: PreflightDecl | null;
  /** 项目上下文（**归一化恒写**：缺省/非字符串/空/纯空白 ⇒ `null`，与 `targetsMarker`/`roster` 同风格
   *  不落 `undefined`；非空 ⇒ `trim()` 原样保留）。渲染进任务包正文 `## 项目上下文`。
   *  ⚠ **不进 `sig`**（`computeTaskSig` 输入面逐字不变 ⇒ 既有 sig 基线零漂移）、**不进 `cmd`**、
   *  **不回写 `skills`**（第五条渲染通道，与装配声明 / role 三段 / preflight 并存不合并）。
   *  ⚠ IMM-2/3：恒写 `null` 使旧批重归一化后仍与旧值相等（`undefined ?? null` ≡ `null`）⇒ 不触发误拒。 */
  context: string | null;
  /** sig 任务内容指纹（N3-②）：`sha256(canonicalJSON({id,layer,role,deps,produce,outputs,cmd}))` 前 **16 hex**
   *  （用户 D-sig-1 裁定 = **不含 `assemblyRef`**，只含任务信息；D-sig-3 = 16 hex）。
   *  写端 `lib/wave-plan.ts`（`buildWavePlan` = **唯一计算入口**；`addPoolTasks`/`addTaskEdges` 经同一次重归一化
   *  分别做「新任务补算」「受影响任务重算、无关任务不变」）；`owner` 非空 ⇒ **冻结**（读旧值原样落盘）。
   *  读端 `lib/sig-fingerprint.js#sigOf`（非 16 hex ⇒ `null`；**存量批无该字段 = 零感知**）。
   *  ⚠ **不参与任何门禁判定**：sig 只作幂等判等的留痕依据（D-sig-2 = 不加新拒码、不阻断动作）。 */
  sig?: string | null;
}

// ── P1 交接门（handoff gate；R2/P1 批次，2026-09-17）──
// 定位（`p1-handoff-gate-changeplan-20260917`（原文档未随仓分发） §2/§3）：**长生命周期成员 DAG 交接模型的核心硬门**——
//   「保证 DAG 内下游成员可以稳定拿到上游产出的依赖」（用户 M-7 裁决 = 验收核心）。
// 真源分工（禁双真源）：**读端真源 = `batch.handoffs`**（不做事后事件流重建，避免 O(n) 扫描）；
//   审计真源 = 事件 `lane.handoff`（每次提交一条）；缺口留痕 = 事件 `lane.handoff.gap`（拒下游时落）。
// 建批期意图声明（本门判据来源）：`buildWavePlan` 按 `task.deps` 的每条入边**种一条 pending 交接**——
//   ⇒ 「该 lane 有交接声明来源」在建批期即成**机器可判事实**（下游定义了 deps 却解析不到上游声明 ⇒ 建批期拒）。
// 缺省口径：存量批无 `batch.handoffs` 字段 ⇒ 未交接门**整体放行 + 落 `lane.handoff.gap` 告警**
//   （不静默、不砸存量）；新建批一律带该字段（空对象 = 无 deps 的批）。

/** 交接契约（下游据此取件；`consumedFrom` = 消费证据，替代消息 ack 语义） */
export interface LaneHandoffContract {
  consumedFrom: string;         // 下游承认的消费来源（恒 = from lane id；用于审计可核）
  assertions: string[];         // 上游给出的**可核断言**（下游对照用；非空）
}

/** R-2（P4 授权修复批，2026-09-25 · `plan/fix-spec.md` §2.2）：交接**覆盖留痕**快照（`LaneHandoff.history` 元素形态）。
 *  语义 = 「被覆盖掉的**旧值**」：每次 `handoff_submit(overwrite:true)` 覆盖已 `submitted` 的边时 push 一条，
 *  **追加式**（不得替换或清空历史）⇒ `history.length` = 该边被覆盖的次数。 */
export interface LaneHandoffHistoryEntry {
  ts: string;                   // 旧值时刻（ISO；= 被覆盖前记录的 ts）
  artifacts: string[];          // 旧 artifacts（整体快照）
  assertions: string[];         // 旧 contract.assertions（整体快照）
  officialTaskId?: string | null; // 旧官方 task 镜像（可空；M-6 双写未启用时恒 null）
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
  /** R-2（P4 授权修复批，2026-09-25）：覆盖历史（追加式；缺省 undefined / 空数组 = 从未被覆盖 ⇒ 存量边零感知）。
   *  读端 `handoff_view` 与审计据此核「旧值留痕」；**不参与写权判定**。 */
  history?: LaneHandoffHistoryEntry[];
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
  team: string | null;          // 【2026-09-27】可选标签：`null` = 无团队标签（原「P1 起必填、无缺省」已按用户裁决退役）
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
  team: string | null;          // 【2026-09-27】建批 `team` 降为可选标签 ⇒ 无标签批落 `null`（读端按「非字符串 = 无团队」处置）
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
  /** R-5（P4 授权修复批，2026-09-25 · `plan/fix-spec.md` §2.4.3）：批级**通道归属声明**真源。
   *  · **纯增量可选字段**（缺省 `undefined` = 存量批/未声明）⇒ 读端放行 + 可核留痕，与 `handoffs` 存量口径同形。
   *  · **未声明时不写键**（键不存在），**不落 `'dispatch'` 默认值**——「缺省 `dispatch`」是**归一化读端**的
   *    有效值（`normalizeChannelDecl` 回 `{ channel:'dispatch', declared:false }`），不是落盘值；故建无 `channel`
   *    字段的批读端零感知、零写入（R5-a/R5-d 的实现取值，见 `exec/contract-change.md`）。
   *  · 写端 = 建批路径（`lib/tools/core.js` 消费 `normalizeChannelDecl` 后落盘）；**单点判定**，运行期不再二次判定。
   *  · 禁双真源：通道归属真源**恒** `batch.channel`，不得从事件流事后重建（`plan/fix-spec.md` §约束 6）。 */
  channel?: ChannelDecl;
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
  // 【2026-09-28 · 批 `cleanup-tail-20260927` E-4 删净】原「团队资产解析」事件的联合成员**已删**：
  //   该事件常量零发射点（写端随批 3 删除）⇒ 本批连同其读端（面板分类器 / locale 键）一并删净，
  //   其码已并入退役锁。历史批数据仍经下方 `{ type: string; [k: string]: unknown }` 兜底可读。
  | { type: 'archive.failed'; reason: string }                                        // EVT_ARCHIVE_FAILED
  | { type: 'system.recovered'; batchId: string; sessionId: string; recoveredLanes: string[]; detail: unknown[] } // EVT_SYSTEM_RECOVERED
  // 兜底：扩展事件（lane.stalled / lane.over-budget / budget.rejected /
  //   worktree.created|checkpoint|merged|merge.conflict|merge.resolved /
  //   gate.role_invalid / archive.done / system.restored 等）
  //   与未来新增事件——ts+type 必备，其余字段保持 unknown 可读
  //   【2026-09-28 · 批 `cleanup-tail-20260927` E-5】原枚举里的 role 缺失码名已随其零发射点删除
  //   （事件常量与 `lib/tools/core.js` 的映射行同批删除）⇒ 本枚举不再点名已删码。
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
  // 命令 gate 之 **L8 判据脚本信任锚**（2026-10-13 · 批 `punky-spec-adopt-p2-20261013`）：产物声明的
  //   `gate-script-sha256: <路径>=<64hex>` 锚定值与脚本**实际内容**不符（脚本自声明之后被改）⇒ 拒。
  //   **不复用** `GATE_EXIT_FORBIDDEN`——其现语义 = **只读黑名单命中（不执行）** ⇒ 复用即两拒因共一码，
  //   与本 union 内 `GATE_HANDOFF_MISSING` 的既有取向（「新造独立码…语义独立、审计可辨」）相悖。
  //   全批仅此 1 枚新码。写端 = `lib/state/gates/command.ts#checkCommandGate`：**执行命令之前**预扫全部
  //   `gate:` 命令的脚本候选，锚定不符即拒；因采预扫，拒时**零命令被执行**（无部分执行副作用）。
  //   无锚定声明 ⇒ 告警（`escape{kind:'gate-script-unanchored'}`）+ 放行（存量产物**零回归**）。
  | 'GATE_SCRIPT_CHANGED'
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
  | 'GATE_SETTLE_NOTE_MISSING'   // review→failed/skipped/conflict 缺非空 note（`lib/state/store/member.js#setMember` 直抛）
  //   派发面豁免参数非法（常量单点 lib/state/lane-exempt.js:53-58）
  | 'GATE_EXEMPT_NOT_DISPATCH'   // exempt 出现在 to!=='running'；或 revoke 与 status 并用（lane-exempt.js:54 常量 → `lib/state/store/member.js#setMember` 拒；工具面 `lib/tools/member-tools.js` 的两处 GATE_EXEMPT_NOT_DISPATCH throw 直抛）
  | 'GATE_EXEMPT_INVALID'        // 载荷结构非法（lane-exempt.js:55 常量 → normalizeExemptPayload lane-exempt.js:94 抛）
  | 'GATE_EXEMPT_TYPE_UNKNOWN'   // type 不在四值白名单（lane-exempt.js:56 常量 → normalizeExemptPayload lane-exempt.js:98 抛）
  // 【已删 · 2026-11-05】原 `GATE_EXEMPT_REVOKE_REQUIRED`（撤销面专用拒码）随撤销面整体移除
  //   （用户裁决「删掉 revokeExempt」；该码只在 `revokeLaneExempt` 内抛，函数已删 ⇒ 码不再可达）
  // ── P4 授权修复批（2026-09-25 · `plan/fix-spec.md` §8「新拒码登记：6 码入 union（两处同改）」）──
  //   R-1 写权校验（Layer 2）· 2 码：判据链 ⑤fail-closed 与「有身份但无权」分码。
  | 'GATE_HANDOFF_UNAUTHORIZED'      // 调用方身份可解析、但对该 lane 出边**无写权**（`lib/state/store.js` recordHandoff）
  | 'GATE_HANDOFF_IDENTITY_UNKNOWN' // 调用方身份**不可解析**（既非 owner/Manager，又无 dispatch 绑定）⇒ fail-closed 拒
  //   R-2 覆盖显式化 · 1 码：同边二次提交但未声明 `overwrite: true`。
  | 'GATE_HANDOFF_OVERWRITE_UNDECLARED' // 入边已 `submitted` 且 `overwrite !== true`（`handoff_submit` 唯一判点）
  //   R-3 roster 承载 · 1 码：`roster` 词法非法（trim 后非空且不匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`）。
  //     与 `role` 的**软告警**口径不同：roster 是 team 通道写权判据的输入 ⇒ 只能拒（fail-closed）。
  //     写端 = `lib/wave-plan.ts` `buildWavePlan`（建批期，抛点带 `task` 与 `value`）。
  | 'GATE_ROSTER_INVALID'
  //   R-5 通道归属 · 2 码：枚举非法 与 一致性矛盾（单点判定 = `lib/wave-plan.ts#normalizeChannelDecl`）。
  | 'GATE_CHANNEL_INVALID'          // `channel` 非 `dispatch|team|mixed`（回显原值）
  | 'GATE_CHANNEL_UNRESOLVED'      // 声明与 lane `roster` 分布自相矛盾（team 缺 roster／dispatch 带 roster／mixed 零 roster）
  // ── 建批期 `consume` × `deps` 不对称（2026-10-04 · 批 `consume-deps-guard-20261004`）──────────────
  //   本门 = 建批期（**单点判定** = `lib/wave-plan.ts#validateLayerContract`）：lane `L` 的某个 `consume` 项 `c`
  //   被**他 lane** `T` 以 `produce ∪ outputs` 声明（**精确字符串相等**，与 `orphanPlanProductsOf` 同口径，
  //   不做 glob／目录语义）、但 `T.id ∉ L.deps` ⇒ 分域处置：
  //     · `T.layer !== 'plan'`（**强制域** = audit 面 ∪ 同层链）⇒ 抛本码（一次聚合抛，消息逐缺口回显，零批次落盘）；
  //     · `T.layer === 'plan'` 且 `L.layer !== 'audit'`（**观察面**）⇒ **非拒**，落事件 `gate.consume_deps_asymmetry`
  //       并在 `wave_plan` 返回值回显 `consumeDepsAsymmetry`；
  //     · `T.layer === 'plan'` 且 `L.layer === 'audit'`（**静默豁免**：audit 消费 plan 判据源属**批级**不变量）。
  //   与 `GATE_HANDOFF_MISSING` / `GATE_ORPHAN_PRODUCT` 同族（产物契约类）⇒ `smoke: true` 批同键豁免。
  | 'GATE_CONSUME_DEPS_ASYMMETRY'
  // ── 真发射码**补登记**（2026-10-24 · 批 `punky-iter-a-20261024` / 裁决 Q-I = R-01／R-02「修 union 源头」）──
  //   问题：以下码在 `lib/**` 有**真实发射位**，但此前只抛不枚举 ⇒ 本 union 不再穷尽。
  //     危害面不在「少几行类型」而在**词表底料**：`lib/state/vocabulary.json` 的底料源唯一 = 本 union，
  //     漏登记 ⇒ 这些码未入词表 ⇒ 判定面（`knownOf` 单点）一旦按词表收紧就会把**真发射码**误拒。
  //   定位：本段是**补登记**，不是造码 —— 码值、发射位、拒/告警语义在本批之前即已存在，本段**零行为变更**
  //     （仅类型面登记）。审计可核：本段每个码都有 `lib/**/*.ts` 的 `code:` 或 `throw new Error('<码>: …')` 发射位。
  //   机检：`scripts/check-vocab-counts.mjs` 职责①「发射码 ⊆ 词表」以**本 union 为底料源**判缺口 ⇒ 补漏后缺口为 0。
  //   **成员数以本 union 自身为唯一真源**：本段及全文注释一律不记数（写死数字即漂移源，
  //   对齐 `lib/sig-fingerprint.js` 的既有教训）。
  //   · complete 门（写端 `lib/state/gates/complete.ts#checkCompleteGate`）
  | 'GATE_COMPLETE_NO_TIER'          // 批次既无 exec 也无 audit（或 wavePlan 全无 `layer`）⇒ 拒（Q-6① 定稿）
  | 'GATE_ORPHAN_PRODUCT'           // plan 层**悬空产物** ⇒ 拒；exec／audit 悬空为**强告警**（同码不同档）：`gates/complete.ts` + `lib/wave-plan.ts#checkPlanPresenceContract`
  //   · exit／层族门（写端 `lib/state/gates/exit.ts#checkExitGate`；`GATE_LANE_NOT_IN_PLAN` 三处同码）
  | 'GATE_LANE_NOT_IN_PLAN'         // lane 不在 `wavePlan.tasks`（entry／exit／plan-contract 三门共用，语义独立于 `GATE_ENTRY_MISSING`）
  | 'GATE_LANE_LAYER_MISSING'       // lane 无 `layer` 声明（generic 层级豁免已退役，Q-6①）
  | 'GATE_EXIT_NO_DECLARATION'      // exec／audit 未声明 `produce`／`outputs`（**plan 层归** `GATE_PLAN_NO_DECLARATION`，两码分工）
  //   · presence 判据族（写端 `lib/state/gates.ts#presenceJudge` = 唯一实现，declare／runtime 两模共用）
  | 'GATE_NO_DECLARATION'           // 产物声明清单为空 ⇒ presence 判据无对象（不是「声明了但缺失」，后者归 `_MISSING` 族）
  //   · plan 契约门（运行期写端 `lib/state/gates/plan-contract.ts#checkPlanContract`；建批期写端 `lib/wave-plan.ts#checkPlanPresenceContract`）
  | 'GATE_PLAN_NO_DECLARATION'      // plan lane 未声明产物（**运行期** plan 契约门）
  | 'GATE_PLAN_PRESENCE_MISSING'    // 同一事实的**建批期**形态：`lib/wave-plan.ts#checkPlanPresenceContract` 直抛（拒建批，零批次落盘）
  //   · entry 门 · `standalone` 声明（写端 `lib/state/gates/entry.ts#checkEntryGate` / `lib/state/gates/helpers.ts`）
  | 'GATE_STANDALONE_UNJUSTIFIED'   // `standalone` 声明不成立：须布尔 `true` ＋ 非空 `standaloneReason` ＋ 批次内确无可用上游
  //   · 建批期**装配声明门**／角色面（写端 `lib/wave-plan.ts`：`#normalizeAssemblyDecl`、`#assemblyGate`、`#buildWavePlan`）
  //     拒／告警分档是**语义要求**（不合并成同一码）：
  | 'GATE_ASSEMBLY_INVALID'          // `assembly` 结构非法或引用悬空／层错配 ⇒ **throw**（fail-closed 拒建批）
  | 'GATE_ROLE_ASSEMBLY_MISSING'     // 含 audit 层的三层批缺 `assembly` 声明 ⇒ 拒建批（GATE_ROLE_ASSEMBLY_MISSING）
  | 'GATE_ROLE_INVALID'             // `roles` 词法非法 ⇒ **告警**（批次照建；与拒态分码，防「告警被读成拒」）
  | 'GATE_ROLE_MANAGER_AS_LANE'     // Manager 被登记为普通 lane ⇒ **告警**（角色完整性，非拒态）
  // 【批 `preset-per-role-20261108`】建批期「role ↔ preset 覆盖面」冲突 ⇒ **告警**。
  //   ⚠ **不进本 union**：union 是**冻结面**（`test/gate-lane-snapshot.test.js` 的 `P2-1` 用
  //     `EXPECTED_GATE_CODES` 硬锁 62 个码，要求「集合身份不变」）⇒ 新增观察码一律用 `WARN_` 前缀
  //     且不进 union/词表（同族先例 = 那个「未知席位」告警码：同为 `WARN_` 前缀、且在静默集内）。
  //     ⚠ 本注释**刻意不写出**该先例码的字面量：`test/warn-silent-codes.test.js` 的 `WS-4` 用
  //     `unionBlock.includes(<该码名>)`（纯字符串包含、注释也算）判「它不得进 union」⇒ 写出来即判红。
  //   `WARN_ROLE_PRESET_MISMATCH` 的发射位 = `lib/tools/wave-plan-tools.js#presetMismatchWarnings`
  //   （`code:` 字面量），事件 = `gate.role_preset_mismatch`（`WARN_EVENT_OF` 映射，非静默集）。
  //   · 建批期**配对基数漂移**（写端 `lib/wave-plan.ts#validateLayerContract`）
  | 'GATE_PAIRING_CARDINALITY_DRIFT'
  // ── 手写 `.js` 发射码**补登记**（2026-11-01 · 批 `punky-adapter-split-20261031` / lane `w4-codename`）──
  //   问题（`punky-adapter-p0-20261031/plan/ts-gate-spec.md` §S3.2 实测 12 码）：以下码在 `lib/**` 有**真实发射位**，
  //     但**发射位全在手写 `.js`**（无 `.ts` 源）；而词表校验与 `accept-pack2` 的发射码扫描面 = `lib/**/*.ts`
  //     ⇒ 这 12 码在扫描面上**结构性不可见**，「发射码 ⊆ 词表」对该族**恒真**（确定性假绿，`p1-G01`）。
  //   本段只做**类型面 + 词表底料登记**，码值/发射位/拒态语义**零行为变更**（本批零新造码）。
  //   ⚠ **与上一段（`lib/**/*.ts` 面）的差别**：本段的发射位**不在** `.ts` 面，故扫描面加宽（`.ts` ∪ 手写 `.js` ∪ `.mjs`，
  //     排 `.d.ts`）由 **`w4-ts-gate`** 承接 —— 本段登记后 `scripts/check-vocab-counts.mjs` 仍 exit 0（验证口径见 lane 产物）。
  //   ⚠ 其中 `GATE_DISPATCH_CAPABILITY_UNAVAILABLE` = **改名后**的新码（旧 `..._MISSING` 已入退役锁，永不回生）。
  //   机检：`test/accept-pack2-vocabulary.test.js` 的 `AC-pack2-3`（词表 gate ↔ 本 union **双向相等**）＋ `AC-pack2-2`（缺口 0）。
  //   “成员数以本 union 自身为唯一真源”——本段同样**不记数**（写死数字即漂移源）。
  //   · 批次控制 / 批次终态（写端 `lib/engine/tree-control.js`、`lib/tools/core.js`、`lib/state/store/{handoff-accept,member,plan-mutate}.js`）
  | 'GATE_BATCH_CONTROL_ACTION_INVALID'
  | 'GATE_BATCH_TERMINAL'
  //   · 难度门禁族（写端 `lib/tools/assign-tools.js`、`lib/tools/wave-plan-tools.js`）
  | 'GATE_DIFFICULTY_CHANNEL_UNRESOLVED'
  | 'GATE_DIFFICULTY_INVALID'
  | 'GATE_DIFFICULTY_MISMATCH'
  | 'GATE_DIFFICULTY_RATIONALE_MISSING'
  //   · 派发族（写端 `lib/engine/dispatch.js`：`mapSpawnError` 三档归一 + 能力位前置拒派两分支）
  | 'GATE_DISPATCH_CAPABILITY_UNAVAILABLE'
  | 'GATE_DISPATCH_FAILED'
  | 'GATE_DISPATCH_PROVIDER_INVALID'
  //   · 交接族（写端 `lib/tools/handoff-tools.js`、`lib/state/store/{member,member-gates}.js`）
  | 'GATE_HANDOFF_ARTIFACT_MISSING'
  | 'GATE_HANDOFF_LEGACY_PASSTHROUGH'
  | 'GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH';



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
