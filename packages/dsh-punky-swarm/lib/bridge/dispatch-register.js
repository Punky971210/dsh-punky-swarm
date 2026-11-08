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

import { EVT_MEMBER_DISPATCH } from '../state/event-types.js';
import { ownerSessionIdOfExec, dispatchIndexEntryOf } from '../engine/dispatch.js'; // 【本批 W-2】写侧取值/索引值构造单点（禁在本文件自写取值式或值形状）
import { sessionOf } from '../tools/shared.js'; // 会话解析与 swarm 工具同源（args.session ?? exec.agent.session.id）
import { parseLaneHandleFromText, consumeLaneHandle, textOfDispatchArgs } from './lane-handle.js'; // 派发句柄（C 档唯一凭证）
import { createRosterPort } from '../provider-dsh/roster.js';

export const DEFAULT_DISPATCH_TOOLS = ['subagent', 'subagent_fork', 'spawn_teammate'];

export function teammateTargetNameOf(result) {
  const v = (result && typeof result === 'object' && 'value' in result ? result.value : result) ?? {};
  const member = v && typeof v === 'object' ? v.member : null;
  const target = member && typeof member === 'object' ? member.target : null;
  return typeof target === 'string' && target.length ? target : null;
}

export function teammateWorkerSessionIdOf(ctx, agent, name, onRosterQueryFailed) {
  if (typeof name !== 'string' || !name) return null;
  const rosterPort = createRosterPort(ctx, agent);
  if (!rosterPort.available) return null; // 服务不可用 = 基线态（非异常）：不回调、不 warn（与旧行为一致）
  try {
    return rosterPort.sessionOf(name); // 三档：命中 ⇒ id；名不在名册 ⇒ null（正常态）；查询失败 ⇒ 抛
  } catch (e) {
    if (typeof onRosterQueryFailed === 'function') onRosterQueryFailed(e);
    return null;
  }
}

export function extractWorkerSessionId(exec, result) {
  if (!exec || typeof exec.name !== 'string') return null;
  const name = exec.name;
  if (name !== 'subagent' && name !== 'subagent_fork' && name !== 'send_message') return null; // 非派发类不提取
  if (result?.isError === true) return null; // 派发失败无 worker 会话（观察者仍透传，不登记）
  if (name === 'send_message') {
    const id = exec?.arguments?.agent_id ?? exec?.arguments?.subagent_id;
    return typeof id === 'string' && id.length ? id : null;
  }
  const v = (result && typeof result === 'object' && 'value' in result ? result.value : result) ?? {};
  if (v && typeof v === 'object') {
    if (v.kind === 'background' || v.kind === 'foreground') return null; // jobId/runId 非会话 id
    for (const k of ['subagentId', 'childId', 'agentId']) {
      if (typeof v[k] === 'string' && v[k].length) return v[k];
    }
  }
  const c = result?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c)
    ? c.map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : '')).join(' ')
    : '';
  const m = /(?:started\s+)?(?:subagent|agent)\s+([A-Za-z0-9._-]+)/i.exec(text);
  return m ? m[1] : null;
}

//   · ⇒ 裸取 `ctx?.agentTeams` 在真实宿主上**必抛**，且抛点（`mountDispatchRegistration`）位于 `apply`
//     执行期、不在加载门内 ⇒ 插件生产不可用（`bf091db` 引入，宿主级冒烟未执行故长期未暴露）。

export function installDispatchRegistration(ctx, deps = {}) {
  const { store, dispatchIndex, logger, resolveBatchContext, tools = DEFAULT_DISPATCH_TOOLS } = deps;
  const rosterAvailable = createRosterPort(ctx, null).available;
  const inert = (reason) => ({ installed: false, inert: true, reason, count: () => 0, mapping: () => ({}), dispose() {} });
  if (!store || typeof ctx?.on !== 'function') return inert('ctx.on unavailable or store missing');
  const toolSet = new Set(tools);
  const intentBySession = new Map();
  const indexMap = dispatchIndex instanceof Map ? dispatchIndex : null;
  let registered = 0;

  const intentEnqueue = (caller, intent) => {
    const q = intentBySession.get(caller);
    if (!Array.isArray(q)) { intentBySession.set(caller, [intent]); return; }
    if (q.some((v) => v.batchId === intent.batchId && v.lane === intent.lane && v.sessionId === intent.sessionId)) return;
    q.push(intent);
  };
  const intentShift = (caller) => {
    const q = intentBySession.get(caller);
    if (!Array.isArray(q) || q.length === 0) { intentBySession.delete(caller); return null; }
    if (q.length > 1) {
      logger?.warn?.('[dsh-punky-swarm] 同调用方多条派发意图待消费（caller=' + caller + ', pending=' + q.length
        + '）⇒ 取最早一条（FIFO）——后登记批次的归属无法从 exec 区分，本行只保证不丢失、不静默');
    }
    const head = q.shift();
    if (q.length === 0) intentBySession.delete(caller);
    return head;
  };

  const register = (sessionId, batchId, lane, workerSessionId, ownerSessionId = null) => {
    if (indexMap?.has(workerSessionId)) return false; // 幂等：已映射（含重启后重建）不重复登记
    const entry = ownerSessionId ? { lane, workerSessionId, ownerSessionId } : { lane, workerSessionId };
    store.appendEvent(sessionId, batchId, EVT_MEMBER_DISPATCH, entry);
    indexMap?.set(workerSessionId, dispatchIndexEntryOf(sessionId, batchId, lane, ownerSessionId));
    registered++;
    return true;
  };

  const listener = (exec, result, next) => {
    try {
      if (!exec || typeof exec.name !== 'string') return next();
      const caller = exec?.agent?.session?.id ?? 'cli';
      const ownerSessionId = ownerSessionIdOfExec(exec);
      if (exec.name === 'member_set_status') {
        const a = exec.arguments ?? {};
        if (a.status === 'running' && a.batchId && a.lane) {
          intentEnqueue(caller, { sessionId: sessionOf(a, exec), batchId: a.batchId, lane: a.lane });
        } else {
          intentBySession.delete(caller);
        }
        return next();
      }
      if (!toolSet.has(exec.name)) return next();
      const workerSessionId = extractWorkerSessionId(exec, result)
        ?? (exec.name === 'spawn_teammate'
          ? teammateWorkerSessionIdOf(ctx, exec?.agent, teammateTargetNameOf(result),
            (e) => logger?.warn?.('[dsh-punky-swarm] roster-query-failed: ' + String(e?.message ?? e)
              + '（tool=spawn_teammate · caller=' + caller + ' · target=' + JSON.stringify(teammateTargetNameOf(result))
              + '）⇒ 本次不登记；这是 roster 查询**失败**，不是「没有该成员」'))
          : null);
      if (!workerSessionId) {
        logger?.warn?.('[dsh-punky-swarm] dispatch register degraded（提取不到持久 worker 会话 ⇒ 本次不登记 · tool='
          + exec.name + ' · caller=' + caller + '）：键缺失/键名漂移，或结果为失败/非会话 id'
          + '（background jobId / foreground runId）——非静默降级，仅留痕不阻断'
          + (exec.name === 'spawn_teammate'
            ? '；D 档成因：spawn_teammate 结果不含 worker 会话 id（宿主 modelMember 丢弃 id），'
              + '且 roster 反查未命中（target=' + JSON.stringify(teammateTargetNameOf(result))
              + (rosterAvailable
                ? '，roster 面可用但无同名成员/成员 id 缺失'
                : '，roster 面不可用') + '）⇒ 不登记（**不用名字充数、不写查不到的记录**）'
            : ''));
        return next();
      }
      const handleText = textOfDispatchArgs(exec.arguments);
      const parsed = parseLaneHandleFromText(handleText);
      if (parsed) {
        const c = consumeLaneHandle(parsed.token, { batchId: parsed.batchId, lane: parsed.lane });
        if (c.ok) {
          if (register(c.entry.sessionId, c.entry.batchId, c.entry.lane, workerSessionId, ownerSessionId)) intentShift(caller);
          return next();
        }
        logger?.warn?.('[dsh-punky-swarm] lane handle rejected: ' + c.reason + '（lane=' + parsed.lane + '，退回意图路径）');
      } else if (exec.name === 'subagent' || exec.name === 'subagent_fork') {
        logger?.warn?.('[dsh-punky-swarm] dispatch without lane handle（' + exec.name + ' · caller=' + caller
          + '）⇒ 走意图兜底登记（**不设拒绝码**：宿主已注册委派工具、无句柄属常态路，本行只保证不静默）');
      }
      const hasResolver = typeof resolveBatchContext === 'function';
      const hit = hasResolver
        ? resolveBatchContext(exec, { workerSessionId, result })
        : (intentBySession.get(caller)?.[0] ?? null);
      if (!hit || !hit.sessionId || !hit.batchId || !hit.lane) {
        const cause = hit
          ? '批上下文不完整（缺 sessionId / batchId / lane）'
          : (hasResolver
            ? 'resolveBatchContext 反查无果（且该调用方无待消费派发意图）'
            : '该调用方无待消费派发意图（未注入 resolveBatchContext）');
        logger?.warn?.('[dsh-punky-swarm] dispatch register unbound（取不到批上下文 ⇒ 本次不登记 · tool='
          + exec.name + ' · caller=' + caller + '）：' + cause + '——非静默丢弃，仅留痕不阻断');
        return next();
      }
      if (register(hit.sessionId, hit.batchId, hit.lane, workerSessionId, ownerSessionId)) {
        intentShift(caller);
      }
    } catch (e) {
      logger?.warn?.('[dsh-punky-swarm] dispatch registration failed (isolated, does not block): ' + String(e?.message ?? e));
    }
    return next(); // pass-through：恒透传（观察者纪律）
  };
  const dispose = ctx.on('tools/post-execute', listener);
  return {
    installed: true,
    count: () => registered,
    mapping: () => (indexMap ? Object.fromEntries([...indexMap.entries()]) : {}),
    pendingIntents: () => [...intentBySession.entries()].flatMap(([s, q]) => (Array.isArray(q) ? q : [q])
      .map((v) => ({ caller: s, ...v }))),
    dispose() { try { if (typeof dispose === 'function') dispose(); } catch { /* 幂等 */ } },
  };
}
