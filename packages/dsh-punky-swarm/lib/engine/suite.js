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

// engine/suite.js —— **套件工具注册表单点**（SUITE_TOOLS）：
//   成员 deny 集（`memberDeny`）与模式门覆盖集（`modeGate`）此前各自散落在工具实现里
//   （`dispatch.js` 的 13 项字面量 + `core.js` 的 9 处 `assertModeActive` 调用点），
//   两侧口径靠人肉同步 ⇒ 本模块把「哪件工具属于哪一面」收敛成**一张表 + 两个派生函数**。
//
// 派生规则（纯函数，无副作用、无 IO）：
//   · `memberDenyTools()` ≡ `SUITE_TOOLS.filter(t => t.memberDeny).map(t => t.name)`
//   · `modeGateTools()`   ≡ `SUITE_TOOLS.filter(t => t.modeGate).map(t => t.name)`
//   · 结果集**冻结**：`SUITE_DENY_TOOLS`（14 项，== 重构前 `dispatch.js` 字面量 + `batch_control`）
//     / `MODE_GATED_TOOLS`（10 项，含 `batch_control`；P1 交接面**不入**两集，见 `handoff_submit` 条目注释）。
//   语义幂等：集合比对一律排序后比（表内条目顺序不构成语义）；唯一受顺序约束的是
//   `SUITE_DENY_TOOLS`——为使导出**逐字不变**，本表按 `memberDeny:true` 的原字面量顺序排布（见下方表头注释）。
//
// 字段语义（本批 `kind` / `write` 只作元数据、不派生行为）：
//   · `name`      唯一键，逐字等于 `defineTool({ name })`，禁别名；
//   · `kind`      门类：`governance` / `dispatch` / `comms` / `read`；
//   · `modeGate`  是否受模式门 `config.modes.gate` 约束（true ⇒ 该工具 `execute` 首行落 `assertModeActive`）；
//   · `memberDeny` 是否从成员调用面移除（true ⇒ 入 `SUITE_DENY_TOOLS`）；
//   · `write`     是否写面/副作用（元数据）。
//
// 口径边界（承 `dispatch.js` 原注释，勿丢）：
//   · 成员侧只禁「主 Agent 的派发工具」≡ 禁止成员嵌套派发 ⇒ `subagent` / `subagent_fork` 必须一并 deny；
//     宿主 `maxDepth` 判据是 `childDepth > maxDepth`（`dsh-subagent/lib/index.js:432-436`），
//     我们传的 `maxDepth:1` **只约束「创建该子会话」**、不约束子会话再派 ⇒ 此处的 deny 是**唯一落实点**。
//   · **MCP 等普通工具对成员全量开放**（同裁决）：本表只收治理/派发套件，`mcp__*` 不入表、不得扩到 deny 面。
//   · `modeGate` 覆盖集 = 该工具 `execute` **首行**调 `assertModeActive(deps, exec, '<动作名>')`（先于参数/状态校验），
//     使非生效模式下反向用例稳定命中 `GATE_MODE_INACTIVE` 且**零治理写入**。

/** 表条目构造器（冻结单条 + 五字段定形，防后续代码顺手加字段悄悄扩面）。 */
const entry = (name, kind, modeGate, memberDeny, write) => Object.freeze({ name, kind, modeGate, memberDeny, write });

/** 套件工具全集（**36 件** = 引擎注册套件工具 + 纳入治理的宿主派发工具 `subagent`/`subagent_fork`
 *  + P1 交接面 `handoff_submit`/`handoff_view` + S2 宿主连续控制族 4 件（`send_message`/`interrupt_agent`/
 *  `list_agents`/`wait_agent`，2026-09-22 one-shot 化））。
 *  ⚠ 顺序约定：**前 14 条**的相对顺序为冻结面（去掉 P3a 新增的 `batch_control` 后 == 重构前
 *  `dispatch.js` 的 `SUITE_DENY_TOOLS` 字面量顺序，要求逐字不变；`batch_control` **插在 `batch_phase` 之后**）。
 *  ⚠ `memberDeny:true` 共 **20** 条 = 冻结的 14 条 + 末尾追加的两件图变更写入口（`batch_tasks_add` / `task_update`）
 *  + S2 宿主连续控制族 4 件；追加位置在**冻结前缀之后** ⇒ 前 14 条相对顺序零变化（`SUITE_DENY_TOOLS` 前 14 项逐字不变）。
 *  第 15 条起为其余条目，顺序不构成语义。 */
export const SUITE_TOOLS = Object.freeze([
  entry('assign_check', 'governance', true, true, true), // 难度评估：成员不写难度（既裁）
  entry('wave_plan', 'governance', true, true, true), // 建批：只认本会话 C 档（G1）
  entry('member_status', 'governance', true, true, true), // 成员状态写
  entry('member_settle', 'governance', true, true, true),
  entry('batch_phase', 'governance', true, true, true),
  entry('batch_control', 'governance', true, true, true), // P3a 最小干预面（pause/resume/abort）：人工介入面，成员不得干预批次相位
  entry('lane_dispatch', 'dispatch', true, true, true),
  entry('lane_claim', 'dispatch', true, true, true), // lane 锁：归 Leader/Manager
  entry('lane_release', 'dispatch', true, true, true),
  entry('gate_status', 'read', false, true, false), // 治理读面（成员看产物即可）
  entry('artifact_types', 'read', false, true, false),
  entry('asset_claim', 'governance', true, true, true),
  entry('subagent', 'dispatch', false, true, true), // 禁成员嵌套派发（2026-09-16 用户裁决补入）
  entry('subagent_fork', 'dispatch', false, true, true),
  // ── 以下不入 deny、不占模式门（元数据面） ──────────────────────────────────────
  entry('batch_status', 'read', false, false, false),
  entry('log_export', 'read', false, false, false),
  entry('lane_heartbeat', 'read', false, false, false),
  entry('lane_longrun', 'read', false, false, false),
  entry('lane_checkpoint_status', 'read', false, false, false), // 读事件流、不调 git ⇒ 只读
  entry('mailbox_read', 'read', false, false, false),
  entry('mailbox_ack', 'read', false, false, false),
  entry('swarm_report', 'comms', false, false, true),
  entry('swarm_cc', 'comms', false, false, true),
  entry('mailbox_send', 'comms', false, false, true),
  entry('lane_worktree_create', 'dispatch', false, false, true),
  entry('lane_worktree_merge', 'dispatch', false, false, true),
  entry('lane_checkpoint', 'dispatch', false, false, true), // git add -A && commit ⇒ 写面
  // ── P1 交接门（`p1-handoff-gate-20260917`）：黑板交接面（登记使锁真生效，非仅静态面多一件）──────
  // `handoff_submit`：**归 `comms` 族（成员面）**——`modeGate: false`（`execute` 内**不**落 `assertModeActive`）
  //   + `memberDeny: false`（**成员可调用**）。依据（`task-22` 裁决 ①）：**交接是生产者的动作**，引擎侧需要的
  //   是**第一手**交接声明，而非 Leader/Manager 转写（转写会退化成手工记账）；形态对齐既有 `swarm_report`
  //   （`comms` / modeGate:false / memberDeny:false / write:true）。**单件不变**：不新增第二件面向成员的工具，
  //   Leader/Manager 仍调用同一件。
  //   与 `SC-1 ⑤` 不变量（`模式门覆盖集 ⊆ deny 集`）无冲突：本件既不落模式门、也不入 deny。
  entry('handoff_submit', 'comms', false, false, true),
  // `handoff_view`：只读取件面（M-7 验收核心 = 下游成员要能稳定取件）⇒ **成员可用**（`memberDeny:false`）、
  //   不落模式门（只读，不写治理面）。
  entry('handoff_view', 'read', false, false, false),
  // ── N1-R4-1a（K1 公共池）────────────────────────────────────────────────────────
  // `task_pool`：**只读**视图（池 = `owner == null` 的筛选面，不是容器）⇒ 不入 deny（成员亦可只读核查）、
  //   不占模式门（零写入、不触治理面）。追加在**第 15 条之后的非 deny 区块** ⇒ 前 14 条 deny 冻结序列零变化。
  entry('task_pool', 'read', false, false, false),
  // `batch_tasks_add`：**图变更写入口**（池内追加任务）⇒ 入 deny（成员不得改图）+ 入模式门（写治理面）。
  entry('batch_tasks_add', 'governance', true, true, true),
  // ── N1-R4-2（K1 公共池）──────────────────────────────────────────────────────────
  // `task_update`：**池内任务加边**（图变更写入口 #2）⇒ 入 deny（成员不得改图）+ 入模式门（写治理面）。
  //   ⚠ 非 deny 区块的 `task_pool` 仍是只读；本件是它唯一的写侧对应物，二者不构成第二套语义。
  entry('task_update', 'governance', true, true, true),
  // ── S2（2026-09-22 · dispatch one-shot 化，用户裁定「彻底功能分离」）：宿主连续控制族 ─────────
  // durable 会话控制面（`dsh-tool-subagent-control` / agent-team）对成员**整体 deny**：one-shot worker
  // 无可唤醒/续聊/等待/打断的对象（dispatch 已改一次性执行器语义，见 `dispatch.js` 头部「one-shot 化」；
  // continuous 能力归 teammate runner，`docs/agent-team-bridge-design-draft-v0-2026-09-21.md` §4/B5）。
  // 该族是**宿主工具**（非引擎注册）⇒ `modeGate:false`（无 `assertModeActive` 落点，同 `subagent`/`subagent_fork`
  // 先例）；`SC-1` 不变量「模式门覆盖集 ⊆ deny 集」不受影响。登记入表 = 单点注册表原则（"哪件工具属于
  // 哪一面"一张表）；追加位置在冻结前缀之后 ⇒ 既有 deny 序列零变化。
  entry('send_message', 'comms', false, true, true), // 成员不得互唤/唤 Lead（durable 信箱面；one-shot 无对象可唤）
  entry('interrupt_agent', 'comms', false, true, true), // 成员不得打断他人回合（控制权归 Leader，黑板面表达）
  entry('list_agents', 'read', false, true, false), // 成员名册只读面一并收（成员面无协作语义）
  entry('wait_agent', 'read', false, true, false), // 等待他人变化 = continuous 语义，一次性执行器无此面
]);

/** 成员 deny 集（派生）：名字数组，顺序 == 重构前字面量顺序。 */
function memberDenyTools() {
  return SUITE_TOOLS.filter((t) => t.memberDeny).map((t) => t.name);
}

/** 模式门覆盖集（派生）：`execute` 首行须落 `assertModeActive` 的工具名。 */
function modeGateTools() {
  return SUITE_TOOLS.filter((t) => t.modeGate).map((t) => t.name);
}

/** 冻结派生结果（消费方 `dispatch.js` 再导出；`Object.freeze` 保持既有不可变契约）。 */
export const SUITE_DENY_TOOLS = Object.freeze(memberDenyTools());
export const MODE_GATED_TOOLS = Object.freeze(modeGateTools());
