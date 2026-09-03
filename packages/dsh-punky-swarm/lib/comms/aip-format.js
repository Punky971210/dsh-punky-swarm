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

// 文件 aip-format：ACPs AIP 消息/任务/会话结构投影（ACPs 交互，参考实现 ACPs v2.1.0）
// 契约：字段级汇总（AIP spec 原文）
// 三函数均为纯函数：输入引擎自有结构 → 输出 ACPs AIP 兼容结构；不做任何文件/存储写操作，
// mailbox 的 ackId 原子写、inbox/outbox/broadcast 三 box、outbox lane 隔离、ack 语义全部保留（红线：既有 mailbox 行为不变）。
//
// 字段对齐原则（spec.md §3.6 与 AIP 规范原文核对）：
// - Message 基类字段：type(id) / id / sentAt / senderRole("leader"|"partner") / senderId / mentions? / dataItems? / groupId? / sessionId?
// - TaskCommand extends Message：type="task-command" / command(TaskCommandType) / commandParams? / taskId?
// - Session：id / taskResults[] / taskCommands[] / createdAt / updatedAt
// - 引擎自推导字段（messageId/timestamp/sender/receiver/channel/contentType/content/meta；
//   dependencies/inputContract/outputContract/executor/executionModel；agentIds/state/taskIds/concurrency）
//   在 ACPs 结构中不存在 → 剔除或移入 commandParams（值域开放，注明引擎扩展键），不在顶层臆造。

// TaskCommandType 枚举（参考实现原文，逐字）
export const AIP_COMMAND_TYPES = ['get', 'start', 'continue', 'cancel', 'complete', 're-stream'];

// TaskState 枚举（aip_base_model.py:23-33；任务状态枚举唯一源——acps-bridge/server 经 re-export 消费，禁止再自持定义）
export const TASK_STATES = [
  'accepted', 'working', 'awaiting-input', 'awaiting-completion',
  'completed', 'canceled', 'failed', 'rejected',
];

// Message 基类投影：mailbox payload { ackId, ts, box, message, meta } → ACPs Message 结构
// type 值 'message' 为投影标记（Message 基类 type 值域未限定，子类型如 task-command 由任务投影覆盖）；
// senderRole/senderId 由 box 方向推导（inbox=Leader→worker=leader；outbox=worker→Leader=partner；
// broadcast=Leader 广播=leader；引擎无 AIC，senderId 保留引擎侧标识，注明为占位）。
export function toAipMessage(msg) {
  const box = msg?.box ?? {};
  const type = box.type;
  let senderRole;
  let senderId;
  let mentions;
  if (type === 'broadcast') {
    senderRole = 'leader';
    senderId = msg?.meta?.sender ?? 'broadcaster';
    mentions = 'all';
  } else if (type === 'outbox') {
    senderRole = 'partner';
    senderId = msg?.meta?.sender ?? box.lane ?? 'worker';
  } else {
    // inbox（含缺省）：Leader 发往 worker
    senderRole = 'leader';
    senderId = msg?.meta?.sender ?? 'leader';
  }
  const out = {
    type: 'message',
    id: msg?.ackId ?? null,
    sentAt: msg?.ts ?? null,
    senderRole,
    senderId,
  };
  const dataItems = toAipDataItems(msg?.message);
  if (dataItems) out.dataItems = dataItems;
  if (mentions) out.mentions = mentions;
  if (msg?.meta?.sessionId) out.sessionId = msg.meta.sessionId;
  return out;
}

// 引擎 message → ACPs DataItem[]（Text/File/Structured 联合；null/undefined → undefined 省略）
export function toAipDataItems(message) {
  if (message === null || message === undefined) return undefined;
  if (typeof message === 'string') return [{ type: 'text', text: message }];
  if (typeof message === 'object') {
    if (message.type === 'text' && typeof message.text === 'string') return [{ type: 'text', text: message.text }];
    if (message.type === 'file') {
      const item = { type: 'file' };
      if (message.name) item.name = message.name;
      if (message.mimeType) item.mimeType = message.mimeType;
      if (message.uri) item.uri = message.uri;
      if (message.bytes) item.bytes = message.bytes;
      return [item];
    }
    if (message.type === 'data' && message.data !== undefined) return [{ type: 'data', data: message.data }];
    // 结构化兜底：任意对象 → StructuredDataItem（注明：非 ACPs 判别器推导，投影层包装）
    return [{ type: 'data', data: message }];
  }
  return undefined;
}

// 任务命令投影：wavePlan task → ACPs TaskCommand 结构
// ACPs 无独立『任务定义』对象——任务由 TaskCommand（命令）+ TaskResult（状态/结果）承载（spec.md §3.6）。
// wavePlan task 派发语义 = start 命令；task.cmd 若本身命中 TaskCommandType 枚举则透传，否则默认 'start'（注明推导）。
// 引擎自有键（layer/role/skills/deps/consume/produce/outputs/cmd/model/tools）移入 commandParams（值域开放，非 ACPs 顶层字段）。
export function toAipTask(task) {
  const rawCmd = String(task?.cmd ?? '');
  const command = AIP_COMMAND_TYPES.includes(rawCmd) ? rawCmd : 'start';
  return {
    type: 'task-command',
    id: task?.id ?? null,
    sentAt: null, // 引擎 wavePlan task 无时间戳（AIP sentAt 必填 ISO 8601，由派发侧注入；此处如实置 null）
    senderRole: 'leader', // Leader 派发推导（引擎无 AIC，占位）
    senderId: 'leader',
    command,
    commandParams: {
      // —— 以下为引擎扩展键（非 ACPs 顶层字段，注明）——
      cmd: rawCmd || null,
      layer: task?.layer ?? null,
      role: task?.role ?? null,
      skills: task?.skills ?? null,
      deps: task?.deps ?? null,
      consume: task?.consume ?? null,
      produce: task?.produce ?? task?.outputs ?? null,
      model: task?.model ?? null,
      tools: task?.tools ?? null,
    },
    taskId: task?.id ?? null,
  };
}

// 会话投影：批次状态 { sessionId, phase, concurrency, wavePlan, lanes, createdAt, updatedAt, ... } → ACPs Session
// ACPs Session 只存在于 Leader，仅 sessionId 进消息（spec.md §3.6）；taskResults 引擎无数据 → 空数组（如实）；
// taskCommands ← wavePlan 任务投影；agentIds/state/taskIds/concurrency 非 ACPs 字段 → 剔除（agentIds 由消息 senderId 表达、
// 状态由 TaskResult.status 表达、taskIds 由 taskCommands[].taskId 表达、并发为引擎调度参数，均非 Session 契约）。
export function toAipSession(session) {
  const waves = session?.wavePlan ?? [];
  const tasks = waves.flatMap((w) => w.tasks ?? []);
  return {
    id: session?.sessionId ?? null,
    taskResults: [],
    taskCommands: tasks.map((t) => toAipTask(t)),
    createdAt: session?.createdAt ?? null,
    updatedAt: session?.updatedAt ?? null,
  };
}
