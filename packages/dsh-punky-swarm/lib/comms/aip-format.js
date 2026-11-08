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


export const AIP_COMMAND_TYPES = ['get', 'start', 'continue', 'cancel', 'complete', 're-stream'];

export const TASK_STATES = [
  'accepted', 'working', 'awaiting-input', 'awaiting-completion',
  'completed', 'canceled', 'failed', 'rejected',
];

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
    return [{ type: 'data', data: message }];
  }
  return undefined;
}

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
