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
//   生成），绝不绕过、无旁路写**；写入目标仅 inbox（lane 只落 meta.lane 元数据，**零消费方、不构成投递目标**
//   ——不支持 lane 定向投递：mailbox 是批级单目录），outbox 不可由外部直接写。
// - 【ACPS-01/05 · 批 punky-acps-closeout-20261023】投递目标**只**由装配期配置钉死
//   （`acps.bridge.inboundSessionId` + `acps.bridge.inboundBatchId`）：报文自带的 `sessionId` /
//   `commandParams.batchId` 一律**丢弃并留痕**（warn）；两键缺失/非法 ⇒ **fail-closed 拒收**
//   （`INBOUND_UNAVAILABLE` / `INVALID_CONTEXT`），**绝不**静默投递到空目标 / 默认会话 / 第一条批。
//   双层防预：① 装配期 `createBridge` 解析目标时先判合法性（不合法 ⇒ inboundTarget=null）；
//   ② 落盘前 `deliverInbound` 对**最终** sessionId/batchId 再判一次（路径段闸口，ACPS-01 唯一落盘闸口）。
//   ⚠ 该闸口**不下沉**到 `lib/mailbox-paths.js`（4 个消费方，收紧 = 全库行为变更）。
//   三条已知限制（本批登记不修）见 createBridge 内注释块。
// - outbound：mailbox 消息 → ACPs Message/TaskResult。复用 lib/comms/aip-format.js 三映射
//   （toAipMessage/toAipTask/toAipSession，本模块 re-export 供端点单一入口）；只投影/投递视图，不反写 mailbox 存储。
// - 零路径：enabled=false 时 mountBridge 返回 null（不实例化），模块顶层无任何副作用（无监听/定时器/订阅）；
//   桥不自带监听——/rpc 监听归 endpoint 侧（衔接点见 handleInbound/toTaskResult 签名）。
// - 生命周期：start/stop/dispose 幂等（开→关销毁、关→开重建，秒级无迁移）。

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

// lane 合法性（与 mailbox.js sanitizeLane 同正则，fail-soft：外部输入不合法 → null 而非 throw）
const LANE_RE = /^[a-zA-Z0-9._-]+$/;
// 【ACPS-01】路径段判定**单点**：`LANE_RE` 放行 "." 与 ".."（二者都是合法正则匹配）⇒ 显式排除。
// 字符集与 `lib/state/constants.js:26` 的 `SAFE_ID` **逐字同体**（`/^[a-zA-Z0-9._-]+$/`）；此处**不 import
// SAFE_ID**：`state` 域是跨域依赖，import 会新增 `comms → state` 边、突破 arch-check 棘轮
// （allowedPairs=63），故复用本域既有常量（= 规格 C1-4「禁第二套正则」）。
const isSafePathSegment = (v) => typeof v === 'string' && LANE_RE.test(v) && v !== '.' && v !== '..';

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
// 【ACPS-01】**唯一落盘闸口**：sessionId/batchId 直接进 path.join 作路径段 ⇒ 在此判定，不合法一律拒绝
//   （不做静默归一化 / 不重写 / 不夹带 fallback 目标）。这是「双层防预」的第二层——第一层在 createBridge
//   解析 inboundTarget 时（配置值非法 ⇒ 目标为 null ⇒ 根本走不到这里）。
export function deliverInbound(root, sessionId, batchId, taskCommand, { inboundEnabled = false } = {}) {
  if (!inboundEnabled) {
    return { ok: false, code: 'INBOUND_DISABLED', detail: 'acps.bridge.inbound is false: external writes to mailbox disabled' };
  }
  // 【ACPS-01】落盘前唯一闸口：id 即 path.join 的段 ⇒ 不合法一律拒绝（不做静默归一化/重写）
  if (!isSafePathSegment(sessionId) || !isSafePathSegment(batchId)) {
    return { ok: false, code: 'INVALID_CONTEXT', detail: 'sessionId/batchId must match /^[a-zA-Z0-9._-]+$/ and must not be "." or ".."' };
  }
  const { message, meta } = taskCommandToInbound(taskCommand);
  const res = mailbox.send(mailboxRootOf(root, sessionId, batchId), { type: 'inbox' }, message, meta);
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

// ── 工厂（单向 inbound；enabled 门控，inbound 子门控，目标由装配期配置钉死）──
// 注意：`mailbox: mb` 形参**保留原样**——ACPS-11（注入缝失效）属 S4「只登记不改」（规格 N4），勿顺手清死代码。
export function createBridge({ root, config = {}, mailbox: mb = mailbox, logger = null } = {}) {
  const cfg = resolveBridgeConfig(config);
  const enabled = cfg.enabled;
  const inboundEnabled = cfg.enabled && cfg.inbound;
  // 【ACPS-05】投递目标只认装配期声明；报文/调用方给的 sessionId/batchId 不再参与寻址（结构性保证：
  //   handleInbound 的上下文参数已移除，调用方**没有**传目标的入口）。此处是「双层防预」的第一层。
  const inboundTarget = (isSafePathSegment(cfg.inboundSessionId) && isSafePathSegment(cfg.inboundBatchId))
    ? { sessionId: cfg.inboundSessionId, batchId: cfg.inboundBatchId }
    : null;
  // 【ACPS-04/05 · fail-closed】声明了 inbound 却无合法目标 ⇒ 装配期一次 warn（不留到请求期才发现），
  //   文本点名**缺哪个键**与**怎么配**。inbound=false（默认档）时本分支整体不进入 ⇒ 零新日志零新 IO。
  if (inboundEnabled && !inboundTarget) {
    // 【ACPS-04 可观测性 · 批 punky-acps-closeout-20261023 / lane c4-acps04】本闸口有**三条**装配期拒收路径
    //   （① 缺键 ② 只配一个 ③ 值非法），三者都落 inboundTarget=null ⇒ 只能在**文本**上区分。
    //   旧文本把 ②③ 写成同一句「…未配置或不合法」（实测逐字相同）⇒ 无法定位成因；故按**每键状态**定性：
    //   missing（未配置/空）vs invalid（配了但不是合法路径段）。
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

  // ── 三条已知限制（本批登记，不修；写在此处防后人误读为「已处理」）────────────────────────
  // ① 目标是**静态配置**：inboundBatchId 指向的批次收口后，ACPS 仍会往该死批 inbox 写 ⇒ 无人读取（静默死信）。
  //    mitigation（本批只文档化）：换批时同步改两键 + 重启插件（见 ②）。
  //    「写前校验批相位、非活跃批 warn/拒收」= **未实现的 followup**：读相位须 import lib/state/** 治理面，
  //    会新增 comms → state 跨域边（突破 arch-check 棘轮 allowedPairs=63）并与「ACPS 不 import 治理面」
  //    边界冲突（规格 §3.6 L2 同口径登记）。
  // ② `acps.*` 热更无 remounter（ACPS-08，S4 只登记不改）⇒ 换批/改目标**必须重启插件**；
  //    不重启则仍投旧目标（旧批已收口 ⇒ 落进死信，见 ①）。
  // ③ 「宿主自动注入会话身份」= **未实现的 followup**（本批没有、也没打算自动）：装配期 `ctx` 只提供
  //    tools / webServer / subagents 服务句柄（index.js inject 面），**取不到会话身份**；会话 id 仅在
  //    **工具执行期**可得（`exec.agent.session.id`，lib/tools/shared.js:50）。⇒ 目标**只能**经配置键在
  //    装配期注入（mountBridge 是注入面）。**勿**误以为已自动绑定本实例会话。
  let mounted = false;

  // endpoint /rpc 衔接点：收到 TaskCommand 后调用 handleInbound(taskCommand)。
  // 【ACPS-05】目标 = inboundTarget（装配期配置），**不接受**调用方/报文覆盖——第二参数已移除，
  //   这是「调用方无法传入目标」的结构性保证（不是靠调用纪律）。
  // inbound 关（默认）→ 拒绝（视图只读）；目标未配置/非法 → 拒绝（INBOUND_UNAVAILABLE，不落盘、不静默）。
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
    // 目标只读回显（观测/测试用；ids 非机密）。null ⇒ inbound 必然 INBOUND_UNAVAILABLE。
    inboundTarget,
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
// createEndpointRpcHandler(bridge, { logger, inboundRequested }) 生成适配 createAcpsServer 的 rpcHandler
// （server.js:264 `rpcHandler ?? defaultRpcHandler` 注入点）：(command, ctx) → TaskResult。行为：
//   - bridge 未装配（null）+ **未**声明 inbound → 独立回执 accepted（向后兼容，不落 mailbox）；
//   - bridge 未装配（null）+ **声明了** inbound → 【ACPS-04】rejected INBOUND_UNAVAILABLE + warn
//     （不再静默 accepted——外部不会误以为投递成功）；
//   - bridge 在位：报文自带的 sessionId / commandParams.batchId **一律丢弃**（仅 warn 一次留痕，
//     【ACPS-05】目标由 acps.bridge.inboundSessionId/inboundBatchId 钉死）；
//   - bridge.handleInbound 成功 → TaskResult accepted（任务已入 inbox 待派发）；
//   - bridge 拒绝（BRIDGE_DISABLED/INBOUND_DISABLED/INBOUND_UNAVAILABLE/INVALID_CONTEXT）→ TaskResult rejected
//     （协议级拒绝，AIP TaskState.rejected，aip_base_model.py:33；status.dataItems 附 code/detail），
//     HTTP 200 返回——传输成功、协议层拒绝（对端可消费，不触发 AipRpcClient 传输错误路径）。
export function createEndpointRpcHandler(bridge, { logger = null, inboundRequested = false } = {}) {
  return function endpointRpcHandler(command, ctx = {}) {
    if (!bridge) {
      // 【ACPS-04】声明了 inbound 却无桥 ⇒ 协议级拒绝（不再静默 accepted）；
      //   未声明 inbound ⇒ 逐字保留既有「独立回执 accepted」向后兼容行为。
      if (inboundRequested) {
        const res = { code: 'INBOUND_UNAVAILABLE', detail: 'acps.bridge.inbound=true but acps.bridge.enabled=false: nothing will be persisted' };
        logger?.warn?.('[dsh-punky-swarm] acps /rpc inbound rejected: ' + res.code + ' ' + res.detail);
        return rejectedInboundResult(command, ctx, res);
      }
      return acceptedInboundResult(command, ctx);
    }
    // 【ACPS-05】报文自选的 sessionId/batchId 一律丢弃（仅一次 warn 留痕，不改变投递结果）。
    //   ⚠ 丢弃此刻**仍**是「无对象的静默」：只告警、不报错——对端可继续带，但不再影响落点。
    //   warn 被 `bridge.inboundEnabled` 前置：inbound=false（默认档）时零噪声。
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

// 【ACPS-04】rpcHandler 选择**单点**（装配面唯一决策点，可单测；index.js:463 只调本函数，禁第二套分支）：
//   - bridge 在位 → 桥适配器（既有行为逐字不变）；
//   - bridge 不在位 + 声明了 inbound → 显式拒绝适配器 + 一次启动 warn；
//   - bridge 不在位 + 未声明 inbound → undefined（回落 server.js:264 defaultRpcHandler，行为逐字不变）。
export function selectRpcHandler({ bridge, inboundRequested = false, logger = null } = {}) {
  if (bridge) return createEndpointRpcHandler(bridge, { logger });
  if (inboundRequested) {
    logger?.warn?.('[dsh-punky-swarm] acps.bridge.inbound=true 但 acps.bridge.enabled=false：'
      + '/acps/rpc 将一律回 rejected INBOUND_UNAVAILABLE（不会落盘）——请开启 acps.bridge.enabled 或关闭 inbound');
    return createEndpointRpcHandler(null, { logger, inboundRequested: true });
  }
  return undefined;
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
