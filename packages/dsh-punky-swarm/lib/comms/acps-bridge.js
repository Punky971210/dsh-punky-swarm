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

// - inbound：外部 ACPs TaskCommand → mailbox 消息。**经 lib/comms/mailbox.js 公共接口原子写（ackId 由 mailbox
//   生成），绝不绕过、无旁路写**；写入目标仅 inbox（lane 只落 meta.lane 元数据，**零消费方、不构成投递目标**
//   ——不支持 lane 定向投递：mailbox 是批级单目录），outbox 不可由外部直接写。

import * as mailbox from './mailbox.js';
import { mailboxRootOf } from './mailbox-paths.js';
import {
  toAipMessage,
  toAipTask,
  toAipSession,
  toAipDataItems,
  AIP_COMMAND_TYPES,
  TASK_STATES,
} from './aip-format.js';
import { resolveBridgeConfig } from '../schema.js';

const LANE_RE = /^[a-zA-Z0-9._-]+$/;
const isSafePathSegment = (v) => typeof v === 'string' && LANE_RE.test(v) && v !== '.' && v !== '..';

export function deriveLane(taskCommand) {
  const mentions = taskCommand?.mentions;
  let candidate = null;
  if (Array.isArray(mentions) && mentions.length === 1 && typeof mentions[0] === 'string' && mentions[0] !== 'all') {
    candidate = mentions[0];
  } else if (typeof mentions === 'string' && mentions.length > 0 && mentions !== 'all') {
    candidate = mentions;
  } else if (typeof taskCommand?.groupId === 'string' && taskCommand.groupId.length > 0) {
    candidate = taskCommand.groupId;
  }
  return candidate !== null && LANE_RE.test(candidate) ? candidate : null;
}

export function taskCommandToInbound(taskCommand) {
  const command = AIP_COMMAND_TYPES.includes(taskCommand?.command) ? taskCommand.command : 'start';
  const message = {
    command,
    ...(taskCommand?.commandParams !== undefined ? { commandParams: taskCommand.commandParams } : {}),
    ...(taskCommand?.taskId !== undefined ? { taskId: taskCommand.taskId } : {}),
  };
  const meta = {
    sessionId: taskCommand?.sessionId ?? null,
    taskId: taskCommand?.taskId ?? null,
    lane: deriveLane(taskCommand), // 路由元数据（可为 null）
  };
  return { message, meta };
}

export function deliverInbound(root, sessionId, batchId, taskCommand, { inboundEnabled = false } = {}) {
  if (!inboundEnabled) {
    return { ok: false, code: 'INBOUND_DISABLED', detail: 'acps.bridge.inbound is false: external writes to mailbox disabled' };
  }
  if (!isSafePathSegment(sessionId) || !isSafePathSegment(batchId)) {
    return { ok: false, code: 'INVALID_CONTEXT', detail: 'sessionId/batchId must match /^[a-zA-Z0-9._-]+$/ and must not be "." or ".."' };
  }
  const { message, meta } = taskCommandToInbound(taskCommand);
  const res = mailbox.send(mailboxRootOf(root, sessionId, batchId), { type: 'inbox' }, message, meta);
  return { ok: res.ok, ackId: res.ackId, lane: meta.lane };
}

export function toTaskResult(msg, { state = 'completed', stateChangedAt = null, products = null } = {}) {
  const taskId = msg?.message?.taskId ?? msg?.meta?.taskId ?? msg?.ackId ?? null;
  const lane = msg?.box?.lane ?? msg?.meta?.lane ?? msg?.meta?.sender ?? 'worker';
  const status = {
    state: TASK_STATES.includes(state) ? state : 'completed', // fail-soft：非枚举 → completed
    stateChangedAt: stateChangedAt ?? msg?.ts ?? new Date().toISOString(),
  };
  const dataItems = toAipDataItems(msg?.message);
  if (dataItems) status.dataItems = dataItems;
  const out = {
    type: 'task-result',
    id: msg?.ackId ?? null,
    sentAt: msg?.ts ?? null,
    senderRole: 'partner', // outbox=worker→Leader=partner（与 aip-format.toAipMessage 方向语义一致）
    senderId: lane,
    taskId,
    status,
  };
  if (products) out.products = products;
  if (msg?.meta?.sessionId) out.sessionId = msg.meta.sessionId;
  return out;
}

export function createBridge({ root, config = {}, mailbox: mb = mailbox, logger = null } = {}) {
  const cfg = resolveBridgeConfig(config);
  const enabled = cfg.enabled;
  const inboundEnabled = cfg.enabled && cfg.inbound;
  const inboundTarget = (isSafePathSegment(cfg.inboundSessionId) && isSafePathSegment(cfg.inboundBatchId))
    ? { sessionId: cfg.inboundSessionId, batchId: cfg.inboundBatchId }
    : null;
  if (inboundEnabled && !inboundTarget) {
    const keyState = [
      ['acps.bridge.inboundSessionId', cfg.inboundSessionId],
      ['acps.bridge.inboundBatchId', cfg.inboundBatchId],
    ].map(([key, v]) => ({ key, value: v, state: v == null ? 'missing' : (isSafePathSegment(v) ? 'ok' : 'invalid') }));
    const bad = keyState.filter((k) => k.state !== 'ok');
    const detail = bad.map((k) => (k.state === 'missing'
      ? k.key + ' 未配置'
      : k.key + '=' + JSON.stringify(k.value) + ' 值非法')).join('；');
    const kind = bad.every((k) => k.state === 'missing')
      ? (bad.length === 2 ? '两键均未配置' : '只配置了一个')
      : '配置值非法';
    logger?.warn?.('[dsh-punky-swarm] acps.bridge.inbound=true 但投递目标不可用（' + kind
      + '；fail-closed：inbound 一律拒收、零落盘）：' + detail
      + '（id 须匹配 /^[a-zA-Z0-9._-]+$/ 且非 "." / ".."）。'
      + '配置方式：config.acps.bridge.inboundSessionId=<主 Agent 会话 id>，'
      + 'config.acps.bridge.inboundBatchId=<该会话下的目标批次 id>；改后须重启插件（acps.* 无 remounter，不会热生效）。');
  }

  let mounted = false;

  function handleInbound(taskCommand) {
    if (!enabled) return { ok: false, code: 'BRIDGE_DISABLED', detail: 'acps.bridge.enabled is false' };
    if (!inboundEnabled) return { ok: false, code: 'INBOUND_DISABLED', detail: 'acps.bridge.inbound is false' };
    if (!inboundTarget) {
      return { ok: false, code: 'INBOUND_UNAVAILABLE', detail: 'inbound target (acps.bridge.inboundSessionId/inboundBatchId) missing or invalid' };
    }
    return deliverInbound(root, inboundTarget.sessionId, inboundTarget.batchId, taskCommand, { inboundEnabled: true });
  }

  return {
    enabled,
    inboundEnabled,
    mode: cfg.mode,
    inboundTarget,
    handleInbound,
    toOutbound: (msg) => toAipMessage(msg),
    toTaskResult,
    start() { mounted = true; return { mounted }; },
    stop() { mounted = false; return { mounted }; },
    dispose() { mounted = false; },
    get mounted() { return mounted; },
  };
}

export function mountBridge(config, deps) {
  if (!resolveBridgeConfig(config).enabled) return null;
  return createBridge({ ...deps, config });
}

export function createEndpointRpcHandler(bridge, { logger = null, inboundRequested = false } = {}) {
  return function endpointRpcHandler(command, ctx = {}) {
    if (!bridge) {
      if (inboundRequested) {
        const res = { code: 'INBOUND_UNAVAILABLE', detail: 'acps.bridge.inbound=true but acps.bridge.enabled=false: nothing will be persisted' };
        logger?.warn?.('[dsh-punky-swarm] acps /rpc inbound rejected: ' + res.code + ' ' + res.detail);
        return rejectedInboundResult(command, ctx, res);
      }
      return acceptedInboundResult(command, ctx);
    }
    const requestedSessionId = command?.sessionId ?? command?.commandParams?.sessionId ?? null;
    const requestedBatchId = command?.commandParams?.batchId ?? null;
    if (bridge.inboundEnabled && (requestedSessionId !== null || requestedBatchId !== null)) {
      logger?.warn?.('[dsh-punky-swarm] acps /rpc: report-supplied sessionId/batchId ignored'
        + '（目标由 acps.bridge.inboundSessionId/inboundBatchId 钉死）');
    }
    const res = bridge.handleInbound(command);
    if (!res.ok) {
      logger?.warn?.('[dsh-punky-swarm] acps /rpc inbound rejected: ' + res.code + ' ' + (res.detail ?? ''));
      return rejectedInboundResult(command, ctx, res);
    }
    return acceptedInboundResult(command, ctx);
  };
}

export function selectRpcHandler({ bridge, inboundRequested = false, logger = null } = {}) {
  if (bridge) return createEndpointRpcHandler(bridge, { logger });
  if (inboundRequested) {
    logger?.warn?.('[dsh-punky-swarm] acps.bridge.inbound=true 但 acps.bridge.enabled=false：'
      + '/acps/rpc 将一律回 rejected INBOUND_UNAVAILABLE（不会落盘）——请开启 acps.bridge.enabled 或关闭 inbound');
    return createEndpointRpcHandler(null, { logger, inboundRequested: true });
  }
  return undefined;
}

function inboundResult(taskCommand, state, ctx = {}) {
  const now = new Date().toISOString();
  const taskId = typeof taskCommand?.taskId === 'string' && taskCommand.taskId.length > 0
    ? taskCommand.taskId
    : (typeof taskCommand?.id === 'string' ? taskCommand.id : 'task-' + Date.now().toString(36));
  const out = {
    type: 'task-result',
    id: typeof taskCommand?.id === 'string' ? taskCommand.id : taskId,
    sentAt: now,
    senderRole: 'partner',
    senderId: ctx?.peerAic ?? 'dsh-punky-swarm',
    taskId,
    status: { state, stateChangedAt: now },
    commandHistory: [taskCommand],
  };
  return out;
}

function acceptedInboundResult(taskCommand, ctx) {
  return inboundResult(taskCommand, 'accepted', ctx);
}

function rejectedInboundResult(taskCommand, ctx, res) {
  const out = inboundResult(taskCommand, 'rejected', ctx);
  out.status.dataItems = [{ type: 'data', data: { code: res?.code ?? 'INBOUND_REJECTED', detail: res?.detail ?? null } }];
  return out;
}

export { toAipMessage, toAipTask, toAipSession, toAipDataItems, AIP_COMMAND_TYPES, TASK_STATES };
