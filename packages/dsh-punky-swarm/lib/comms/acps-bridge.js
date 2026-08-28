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

// 文件 acps-bridge：内部 ACPs 桥接（file mailbox ↔ ACPs 消息，进程内双向，默认关）
// 零破坏：mailbox ackId 原子写、三 box、outbox lane 隔离语义逐字保留。
//
// 职责与红线：
// - inbound：外部 ACPs TaskCommand → mailbox 消息。**经 lib/comms/mailbox.js 公共接口原子写（ackId 由 mailbox
//   生成），绝不绕过、无旁路写**；写入目标仅 inbox（按 mentions/groupId 推导 lane 进 meta），outbox 不可由外部直接写。
// - outbound：mailbox 消息 → ACPs Message/TaskResult。复用 lib/comms/aip-format.js 三映射
//   （toAipMessage/toAipTask/toAipSession，本模块 re-export 供端点单一入口）；只投影/投递视图，不反写 mailbox 存储。
// - 零路径：enabled=false 时 mountBridge 返回 null（不实例化），模块顶层无任何副作用（无监听/定时器/订阅）；
//   桥不自带监听——/rpc 监听归 endpoint 侧（衔接点见 handleInbound/toTaskResult 签名）。
// - 生命周期：start/stop/dispose 幂等（开→关销毁、关→开重建，秒级无迁移）。

import { join } from 'node:path';
import * as mailbox from './mailbox.js';
import {
  toAipMessage,
  toAipTask,
  toAipSession,
  toAipDataItems,
  AIP_COMMAND_TYPES,
  TASK_STATES,
} from './aip-format.js';
import { resolveBridgeConfig } from '../schema.js';

// lane 合法性（与 mailbox.js sanitizeLane 同正则，fail-soft：外部输入不合法 → null 而非 throw）
const LANE_RE = /^[a-zA-Z0-9._-]+$/;

function boxRoot(root, sessionId, batchId) {
  return join(root, 'sessions', sessionId, 'mailbox', batchId);
}

// ── inbound：ACPs TaskCommand → mailbox 消息（纯转换，不写存储）──
// lane 推导：mentions 单元素数组/非 'all' 字符串 → 该值；否则 groupId；均非法 → null（inbox 无 lane 概念，
// lane 仅为路由元数据）。mentions='all'（广播语义）外部投递不支持 → null（外部不可写 broadcast，红线）。
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

// TaskCommand → mailbox { message, meta }（纯函数；command 枚举透传否则 start，与 aip-format.toAipTask 同语义）
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

// inbound 投递：经 mailbox.send 公共接口原子写 inbox（ackId 由 mailbox 生成）。
// inboundEnabled 缺省 false（默认关）：外部写 mailbox 需显式开启——调用方（endpoint /rpc）在
// bridge.inboundEnabled 门控通过后才传 { inboundEnabled: true }。
export function deliverInbound(root, sessionId, batchId, taskCommand, { inboundEnabled = false } = {}) {
  if (!inboundEnabled) {
    return { ok: false, code: 'INBOUND_DISABLED', detail: 'acps.bridge.inbound is false: external writes to mailbox disabled' };
  }
  const { message, meta } = taskCommandToInbound(taskCommand);
  const res = mailbox.send(boxRoot(root, sessionId, batchId), { type: 'inbox' }, message, meta);
  return { ok: res.ok, ackId: res.ackId, lane: meta.lane };
}

// ── outbound：mailbox 消息 → ACPs Message/TaskResult（纯投影，不反写 mailbox）──
// toTaskResult：outbox/broadcast 消息 → ACPs TaskResult。
// taskId ← message.taskId ?? meta.taskId ?? ackId；status.state 由调用方按成员状态映射（缺省 completed，
// 状态映射契约归 endpoint/Leader lane，见 exec/bridge.md 衔接点）；dataItems 复用 toAipDataItems（与 aip-format 同源）。
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

// ── 工厂（进程内双向；enabled 门控，inbound 子门控）──
export function createBridge({ root, config = {}, mailbox: mb = mailbox, logger = null } = {}) {
  const cfg = resolveBridgeConfig(config);
  const enabled = cfg.enabled;
  const inboundEnabled = cfg.enabled && cfg.inbound;
  let mounted = false;

  // endpoint /rpc 衔接点：收到 TaskCommand 后调用 handleInbound(taskCommand, { sessionId, batchId })。
  // inbound 关（默认）→ 拒绝（视图只读）；缺 sessionId/batchId → 拒绝（mailbox 按会话/批次隔离，缺上下文不可投递）。
  function handleInbound(taskCommand, { sessionId, batchId } = {}) {
    if (!enabled) return { ok: false, code: 'BRIDGE_DISABLED', detail: 'acps.bridge.enabled is false' };
    if (!inboundEnabled) return { ok: false, code: 'INBOUND_DISABLED', detail: 'acps.bridge.inbound is false' };
    if (!sessionId || !batchId) {
      return { ok: false, code: 'MISSING_CONTEXT', detail: 'sessionId/batchId required for mailbox write' };
    }
    return deliverInbound(root, sessionId, batchId, taskCommand, { inboundEnabled: true });
  }

  return {
    enabled,
    inboundEnabled,
    mode: cfg.mode,
    // inbound 衔接点（endpoint /rpc 调用）
    handleInbound,
    // outbound 衔接点（endpoint/视图调用；Message 投影复用 aip-format，单一入口）
    toOutbound: (msg) => toAipMessage(msg),
    toTaskResult,
    // 生命周期：桥不自带监听/定时器（/rpc 监听归 endpoint 侧）；start/stop 幂等标记
    start() { mounted = true; return { mounted }; },
    stop() { mounted = false; return { mounted }; },
    dispose() { mounted = false; },
    get mounted() { return mounted; },
  };
}

// ── 装配短路：enabled=false → null，不实例化（零路径）。index.js 装配处唯一调用点。──
export function mountBridge(config, deps) {
  if (!resolveBridgeConfig(config).enabled) return null;
  return createBridge({ ...deps, config });
}

// ── endpoint /rpc → bridge inbound 接线 ──
// createEndpointRpcHandler(bridge) 生成适配 createAcpsServer 的 rpcHandler（server.js:269 注入点）：
//   (command, ctx) → TaskResult。行为：
//   - bridge 未装配（null）→ fallback（缺省独立回执 accepted，不落 mailbox）；
//   - sessionId/batchId 上下文注入：sessionId ← command.sessionId（ACPs Message 基类字段,
//     aip_base_model.py:151）?? command.commandParams.sessionId；batchId ← command.commandParams.batchId；
//   - bridge.handleInbound 成功 → TaskResult accepted（任务已入 inbox 待派发）；
//   - bridge 拒绝（BRIDGE_DISABLED/INBOUND_DISABLED/MISSING_CONTEXT）→ TaskResult rejected
//     （协议级拒绝，AIP TaskState.rejected，aip_base_model.py:33；status.dataItems 附 code/detail），
//     HTTP 200 返回——传输成功、协议层拒绝（对端可消费，不触发 AipRpcClient 传输错误路径）。
export function createEndpointRpcHandler(bridge, { logger = null } = {}) {
  return function endpointRpcHandler(command, ctx = {}) {
    if (!bridge) {
      // bridge 未装配：独立行为（回 accepted 但不落 mailbox，向后兼容）
      return acceptedInboundResult(command, ctx);
    }
    const sessionId = command?.sessionId ?? command?.commandParams?.sessionId ?? null;
    const batchId = command?.commandParams?.batchId ?? null;
    const res = bridge.handleInbound(command, { sessionId, batchId });
    if (!res.ok) {
      logger?.warn?.('[dsh-punky-swarm] acps /rpc inbound rejected: ' + res.code + ' ' + (res.detail ?? ''));
      return rejectedInboundResult(command, ctx, res);
    }
    return acceptedInboundResult(command, ctx);
  };
}

// inbound 回执 TaskResult 构造：
//   accepted = 任务已入 inbox；rejected = bridge 拒绝（INBOUND_DISABLED 等，status.dataItems 附 code/detail）
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

// re-export aip-format 三映射 + 枚举（端点单一入口；与投影层同源，保证 ACPs 形态一致）
export { toAipMessage, toAipTask, toAipSession, toAipDataItems, AIP_COMMAND_TYPES, TASK_STATES };
