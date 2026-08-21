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

// 文件 aip-format：国标消息/任务/会话映射（P2-9 纯映射，只读不改存储）
// 契约：artifacts/punky-aip/plan/aip-decision.md §3（P2-9）
// 三函数均为纯函数：输入引擎自有结构 → 输出国标兼容结构；不做任何文件/存储写操作，
// mailbox 的 ackId 原子写、inbox/outbox/broadcast 三 box、outbox lane 隔离、ack 语义全部保留（红线：既有 mailbox 行为不变）。

// 国标消息映射：mailbox payload { ackId, ts, box, message, meta } → AIP 消息结构
// 派生规则见决策包 §3.2：messageId←ackId / timestamp←ts / sender←box.type
// （inbox→Leader、outbox→worker(meta.sender ?? lane)、broadcast→broadcaster）/
// receiver←box.lane（outbox）或 "*"（inbox/broadcast）/ channel←point-to-point|group
export function toAipMessage(msg) {
  const box = msg?.box ?? {};
  const type = box.type;
  let sender;
  let receiver;
  let channel;
  if (type === 'broadcast') {
    sender = 'broadcaster';
    receiver = '*';
    channel = 'group';
  } else if (type === 'outbox') {
    sender = msg?.meta?.sender ?? box.lane ?? 'worker';
    receiver = box.lane ?? '*';
    channel = 'point-to-point';
  } else {
    // inbox（含缺省）
    sender = 'Leader';
    receiver = '*';
    channel = 'point-to-point';
  }
  return {
    messageId: msg?.ackId ?? null,
    timestamp: msg?.ts ?? null,
    sender,
    receiver,
    channel,
    contentType: msg?.message?.type ?? 'text',
    content: msg?.message ?? null,
    meta: msg?.meta ?? null,
  };
}

// 国标任务映射：wavePlan task { id, cmd, deps?, model?, tools?, layer?, role?, skills?, consume?, produce?, outputs? } → AIP 任务结构
// 派生规则见决策包 §3.3：taskId←id / dependencies←deps / inputContract←consume /
// outputContract←produce（优先）?? outputs / executor←role / executionModel←model ?? tools / layer 原样透传
export function toAipTask(task) {
  return {
    taskId: task?.id ?? null,
    dependencies: task?.deps ?? null,
    inputContract: task?.consume ?? null,
    outputContract: task?.produce ?? task?.outputs ?? null,
    executor: task?.role ?? null,
    executionModel: task?.model ?? task?.tools ?? null,
    skills: task?.skills ?? null,
    cmd: task?.cmd ?? null,
    layer: task?.layer ?? null,
  };
}

// 国标会话映射：批次状态 { sessionId, batchId, phase, concurrency, lanes, wavePlan } → AIP 会话结构
// 派生规则见决策包 §3.4：sessionId 透传 / agentIds←lanes keys + wavePlan roles（P1-3 规则
// `${team}.${layer}.${role}`，lane 兜底为 lane id）/ state←phase / taskIds←wavePlan 全部任务 id 平铺
export function toAipSession(session) {
  const team = session?.team ?? 'generic';
  const waves = session?.wavePlan ?? [];
  const tasks = waves.flatMap((w) => w.tasks ?? []);
  const agentIds = [];
  const seen = new Set();
  const push = (id) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      agentIds.push(id);
    }
  };
  for (const t of tasks) {
    push(t.role ? [team, t.layer, t.role].filter(Boolean).join('.') : t.id);
  }
  for (const laneId of Object.keys(session?.lanes ?? {})) push(laneId);
  return {
    sessionId: session?.sessionId ?? null,
    agentIds,
    state: session?.phase ?? null,
    taskIds: tasks.map((t) => t.id),
    concurrency: session?.concurrency ?? null,
  };
}
