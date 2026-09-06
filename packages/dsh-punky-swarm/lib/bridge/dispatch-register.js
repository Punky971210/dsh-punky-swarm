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

// bridge/dispatch-register.js —— 派发登记点（dispatch registration）：装配层观察派发工具，把
//   「worker 会话 → { sessionId, batchId, lane }」写为 member.dispatch 批次事件。
// 背景：归属读侧骨架（dispatchIndex，从批次事件 member.dispatch 幂等重建）依赖写侧登记；
//   本模块经装配层 post-execute 观察 Manager 派发（member_status(status=running) 意图）
//   → resolveBatchContext 得当前批/lane → store.appendEvent 写 member.dispatch
//   （与读侧骨架对接零改动生效：启动重建 + miss 惰性重建，幂等）；
//   未取到批上下文（非 Manager 派发场景）→ 不登记（无登记静默降级语义）。
// 零宿主改造：仅订阅宿主既有 tools/post-execute waterfall（pass-through 恒 next()）；
//   swarm 自身工具（member_status 等）同样流经该 waterfall → 兜底解析 = 观察同会话
//   member_status(status=running) 的派发意图（时序：先置 running 再派发 worker）。
// 语义红线：漏计不误暂停（安全侧）——解析不出批上下文宁可跳过；不引入任何批级状态迁移。
import { EVT_MEMBER_DISPATCH } from '../state/event-types.js';
import { sessionOf } from '../tools/shared.js'; // 会话解析与 swarm 工具同源（args.session ?? exec.agent.session.id）

// 派发类工具名单（装配注入可经 deps.tools 覆盖/扩列）；send_message 为既有 worker 唤醒（0g），
// 其 childId 取 args.subagent_id（注册目标 = 被唤醒 worker 会话——若 spawn 时漏登可兜底补登）。
export const DEFAULT_DISPATCH_TOOLS = ['subagent', 'subagent_fork', 'send_message'];

// 从 post-execute (exec, result) 提取被派发 worker 会话 id（childId/agentId）。
// 宿主结构化 result：subagent → ToolExecutionResult.value = {kind:'continuable', subagentId}（continuable 后台模式，
// subagentId = startContinuable childId = 会话 id）；background jobId / foreground runId 非会话 id（不登记——
// 无持久 worker 会话可归属，T16 静默）；send_message → 目标在 args.subagent_id。提取不到 → null（不登记）。
export function extractWorkerSessionId(exec, result) {
  if (!exec || typeof exec.name !== 'string') return null;
  const name = exec.name;
  if (name !== 'subagent' && name !== 'subagent_fork' && name !== 'send_message') return null; // 非派发类不提取
  if (result?.isError === true) return null; // 派发失败无 worker 会话（观察者仍透传，不登记）
  if (name === 'send_message') {
    const id = exec?.arguments?.subagent_id;
    return typeof id === 'string' && id.length ? id : null;
  }
  // subagent / subagent_fork：结构化 value（host ToolExecutionResult）或平铺 result 兼容
  const v = (result && typeof result === 'object' && 'value' in result ? result.value : result) ?? {};
  if (v && typeof v === 'object') {
    if (v.kind === 'background' || v.kind === 'foreground') return null; // jobId/runId 非会话 id
    for (const k of ['subagentId', 'childId', 'agentId']) {
      if (typeof v[k] === 'string' && v[k].length) return v[k];
    }
  }
  // 兼容文本形态（部分宿主 result 仅 content 文本）：started subagent <id> / subagent <id>
  const c = result?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c)
    ? c.map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : '')).join(' ')
    : '';
  const m = /(?:started\s+)?(?:subagent|agent)\s+([A-Za-z0-9._-]+)/i.exec(text);
  return m ? m[1] : null;
}

// 装配层登记点（对齐 mountVerify/installGovernanceHook 模式）：
//   订阅 ctx.on('tools/post-execute')——识别派发类工具 → 提取 workerSessionId → resolveBatchContext(exec)
//   （deps 显式注入优先；缺省 = 同会话 member_status(running) 派发意图兜底）→ 命中批上下文则 appendEvent
//   member.dispatch {lane, workerSessionId}（读侧骨架零改动生效）；未命中 → 不登记。
//   幂等守卫：dispatchIndex.has(workerSessionId) 已映射 → 跳过（防 send_message 重复唤醒重复登记）。
//   观察者纪律：任一失败仅 warn，恒 return next()（不阻断、不抛错）。
// 返回 { installed, dispose, count, mapping }；ctx.on 缺失 → inert 静默降级（宿主能力缺失不炸）。
export function installDispatchRegistration(ctx, deps = {}) {
  const { store, dispatchIndex, logger, resolveBatchContext, tools = DEFAULT_DISPATCH_TOOLS } = deps;
  const inert = (reason) => ({ installed: false, reason, count: () => 0, mapping: () => ({}), dispose() {} });
  if (!store || typeof ctx?.on !== 'function') return inert('ctx.on unavailable or store missing');
  const toolSet = new Set(tools);
  // 兜底意图表：callerSession -> { sessionId, batchId, lane }（member_status(status=running) 观察落点，
  //   0g 时序「先置 running 再派发 worker」；注册成功后消费（delete）——一次 running 对应一次 worker 派发，
  //   防 stale intent 误归属后续无关 subagent）
  const intentBySession = new Map();
  const indexMap = dispatchIndex instanceof Map ? dispatchIndex : null;
  let registered = 0;

  const register = (sessionId, batchId, lane, workerSessionId) => {
    if (indexMap?.has(workerSessionId)) return false; // 幂等：已映射（含重启后重建）不重复登记
    store.appendEvent(sessionId, batchId, EVT_MEMBER_DISPATCH, { lane, workerSessionId });
    indexMap?.set(workerSessionId, { sessionId, batchId, lane });
    registered++;
    return true;
  };

  const listener = (exec, result, next) => {
    try {
      if (!exec || typeof exec.name !== 'string') return next();
      const caller = exec?.agent?.session?.id ?? 'cli';
      // ① member_status(status=running) → 记录派发意图（swarm 工具同流经 post-execute；非 running 清意图防 stale）
      if (exec.name === 'member_status') {
        const a = exec.arguments ?? {};
        if (a.status === 'running' && a.batchId && a.lane) {
          intentBySession.set(caller, { sessionId: sessionOf(a, exec), batchId: a.batchId, lane: a.lane });
        } else {
          intentBySession.delete(caller);
        }
        return next();
      }
      // ② 非派发类工具 → 不登记（透传）
      if (!toolSet.has(exec.name)) return next();
      const workerSessionId = extractWorkerSessionId(exec, result);
      if (!workerSessionId) return next(); // 无持久 worker 会话（background/foreground/失败）→ 不登记
      // ③ resolveBatchContext(exec)：显式注入优先，缺省 = 同会话派发意图兜底（装配注入 resolveBatchContext 兜底）
      const hit = typeof resolveBatchContext === 'function'
        ? resolveBatchContext(exec, { workerSessionId, result })
        : (intentBySession.get(caller) ?? null);
      if (!hit || !hit.sessionId || !hit.batchId || !hit.lane) return next(); // 未取到批上下文 → 不登记
      if (register(hit.sessionId, hit.batchId, hit.lane, workerSessionId)) {
        intentBySession.delete(caller); // 消费意图（一次 running → 一次派发登记）
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
    pendingIntents: () => [...intentBySession.entries()].map(([s, v]) => ({ caller: s, ...v })),
    dispose() { try { if (typeof dispose === 'function') dispose(); } catch { /* 幂等 */ } },
  };
}
