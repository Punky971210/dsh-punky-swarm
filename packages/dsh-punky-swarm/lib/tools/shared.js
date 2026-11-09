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

// lib/tools/shared.js —— 工具域零依赖共享辅助
// 为避免 watch → tools/core 整模块依赖，下沉至本零依赖模块——零 import 防循环依赖）。
// 红线：本文件不得 import 任何模块（零依赖设计，防循环依赖）。

export const TEXT_OUTPUT = (text) => [{ type: 'text', text }];

/**
 * 会话回落**来源单点**（B-1）：与 `sessionOf` 逐级同序同判据，额外回报命中的那一级。
 *
 * `source ∈ {'arg','bound','agent','fallback'}`：
 *   · `arg`      —— `args.session` 非空字符串（**优先级最高，首行短路**，C-9）；
 *   · `bound`    —— `resolveBatchSession(exec)` 返回非空字符串（派发绑定）；
 *   · `agent`    —— `exec.agent.session.id` 在场（宿主内 agent 调用）；
 *   · `fallback` —— 三者皆无（MCP 直连等无调用方会话的入口）⇒ `sessionId` 仍是哨兵 `'cli'`（B-3 不改）。
 *
 * 为什么要它：`'cli'` 是「**没有调用方会话**」的哨兵，却被 `batch_status` 的列表读面当成真实会话读盘
 *   ⇒ MCP 面恒空。**只把这一处**从「拿哨兵当会话」升级为「哨兵 ⇒ 全会话」，不改 `sessionOf` 的全局回落
 *   （17 个调用点 + 写族 + 7 件常驻面的错误形态都不动）。
 *
 * 语义等价（AC-9）：`sessionOf(...) === sessionOfResolved(...).sessionId` 对同一输入逐例相等。
 *   末级刻意写成 `!== undefined && !== null` 而非「非空串」，与 `exec?.agent?.session?.id ?? 'cli'`
 *   的 `??` 语义**逐字等价**（空串在场时也不回落 —— 保持既有行为零变化）。
 */
export function sessionOfResolved(args, exec, resolveBatchSession) {
  if (args && typeof args.session === 'string' && args.session.length) {
    return { sessionId: args.session, source: 'arg' };
  }
  if (typeof resolveBatchSession === 'function') {
    let bound = null;
    try { bound = resolveBatchSession(exec); } catch { bound = null; }
    if (typeof bound === 'string' && bound.length) return { sessionId: bound, source: 'bound' };
  }
  const agentSessionId = exec?.agent?.session?.id;
  if (agentSessionId !== undefined && agentSessionId !== null) {
    return { sessionId: agentSessionId, source: 'agent' };
  }
  return { sessionId: 'cli', source: 'fallback' };
}

export function sessionOf(args, exec, resolveBatchSession) {
  return sessionOfResolved(args, exec, resolveBatchSession).sessionId;
}
