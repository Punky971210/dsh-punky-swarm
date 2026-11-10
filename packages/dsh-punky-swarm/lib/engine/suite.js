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

// @ts-check

//     我们传的 `maxDepth:1` **只约束「创建该子会话」**、不约束子会话再派 ⇒ 此处的 deny 是**唯一落实点**。
//   · **MCP 等普通工具对成员全量开放**（同裁决）：本表只收治理/派发套件，`mcp__*` 不入表、不得扩到 deny 面。

const entry = (name, kind, modeGate, memberDeny, write) => Object.freeze({ name, kind, modeGate, memberDeny, write });

export const SUITE_TOOLS = Object.freeze([
  entry('assign_check', 'governance', true, true, true),
  entry('wave_plan', 'blackboard', true, true, true),
  entry('member_set_status', 'blackboard', true, true, true),
  entry('member_settle', 'blackboard', true, true, true),
  entry('batch_phase', 'blackboard', true, true, true),
  entry('batch_control', 'blackboard', true, true, true),
  entry('lane_dispatch', 'dispatch', true, true, true),
  entry('lane_claim', 'dispatch', true, true, true),
  entry('lane_release', 'dispatch', true, true, true),
  entry('gate_status', 'blackboard', false, false, false),
  entry('artifact_types', 'read', false, false, false),
  entry('asset_claim', 'blackboard', false, false, true),
  entry('subagent', 'dispatch', false, true, true),
  entry('subagent_fork', 'dispatch', false, true, true),
  entry('batch_status', 'blackboard', false, false, false),
  entry('log_export', 'blackboard', false, false, true),
  entry('lane_checkpoint_status', 'read', false, false, false),
  entry('swarm_report', 'comms', false, false, true),
  entry('swarm_cc', 'comms', false, false, true),
  entry('lane_worktree_create', 'dispatch', false, false, true),
  entry('lane_worktree_merge', 'dispatch', false, true, true),
  entry('lane_checkpoint', 'dispatch', false, false, true),
  entry('handoff_submit', 'blackboard', false, false, true),
  entry('handoff_view', 'blackboard', false, false, false),
  entry('task_pool', 'blackboard', false, false, false),
  entry('batch_tasks_add', 'blackboard', true, true, true),
  entry('task_update', 'blackboard', true, true, true),
  entry('send_message', 'comms', false, false, true),
  entry('interrupt_agent', 'comms', false, true, true),
  entry('list_agents', 'read', false, true, false),
  entry('wait_agent', 'read', false, true, false),
  //   ⇒ 成员**不得自行拉起 teammate** —— 席位是 Leader / 官方 roster 的面；成员侧自行拉起即**绕过 lane 派发
  //   与三层门禁**（无 lane 绑定、无产物契约、无交接门）。⇒ 入 deny。
  entry('spawn_teammate', 'dispatch', false, true, true),
  entry('role_guide', 'read', false, false, false),
  entry('taskpack_for', 'read', false, false, false),
  entry('handoff_accept', 'blackboard', false, false, true),
]);

function memberDenyTools() {
  return SUITE_TOOLS.filter((t) => t.memberDeny).map((t) => t.name);
}

function modeGateTools() {
  return SUITE_TOOLS.filter((t) => t.modeGate).map((t) => t.name);
}

// 【R-3 · deny 纯单据化】本表 = 治理套件收窄的**唯一持有者**。
//   成员面收窄只走两张显式单据：本表 ∪ `config.dispatch.denyTools`（用户点名单件追加）。
//   ⇒ **不**在此另立缺省值、**不**把 role 的 `tools.allow` 反推成 deny 补集（第二真源 ⇒ 表演进时静默漂移）。
export const SUITE_DENY_TOOLS = Object.freeze(memberDenyTools());
export const MODE_GATED_TOOLS = Object.freeze(modeGateTools());

// ── MCP 常驻面（2026-11-09 用户裁决：MCP 数据面常驻为「通用任务黑板」）─────────────────────
//   逐件裁定（取证见 punky-recon/survey/mcp-resident-tool-triage.md）：
//     保留 = 纯读黑板/交接 + 交接事实写入（均无模式门、靠 `args.session` 可工作）；
//     排除 = 门禁投影（gate_status）/ 静态元数据（artifact_types）/ 审计导出（log_export）/
//            宿主成员面（list_agents / wait_agent，硬依赖 exec.agent）/ 会话内专用（lane_checkpoint_status）/
//            产物归位（asset_claim，MCP 不作为产出方）。
//   ⚠ 必须**显式名单**：排除项横跨 blackboard/read 两族且含宿主面，kind 派生表达不了逐件取舍；
//     名单漂移由 `validateResidentTools()` 机检（成员必须都在 SUITE_TOOLS 内）。
export const RESIDENT_TOOL_NAMES = Object.freeze([
  'batch_status',
  'handoff_view',
  'task_pool',
  'taskpack_for',
  'role_guide',
  'handoff_submit',
  'handoff_accept',
]);

/** 常驻名单自检：成员必须是 suite 内真实工具名（防手抄漂移 / 防改名后静默丢件）。 */
export function validateResidentTools() {
  const known = new Set(SUITE_TOOLS.map((t) => t.name));
  return RESIDENT_TOOL_NAMES.filter((n) => !known.has(n));
}

/** 常驻补给：preset 行只注册补集（否则同层重名抛错，且根层已被常驻件占用）。 */
export function governedToolNames() {
  return SUITE_TOOLS.map((t) => t.name).filter((n) => !RESIDENT_TOOL_NAMES.includes(n));
}
