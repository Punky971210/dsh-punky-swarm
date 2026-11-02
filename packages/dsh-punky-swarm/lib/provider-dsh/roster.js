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

// ── DSH provider · **名册面**（`RosterSource` 的 DSH 实现）─────────────────────────────
//
// 归属（J6 / R-2 三层职责）：宿主服务名只允许出现在**本目录**；引擎只向适配层要「名册功能」，
//   不得知道宿主服务叫什么、以何形态取到。
//
// 契约（`lib/ports.ts:215-235` `RosterSource`，**不改契约**）：
//   · `read()`          → 成员清单，**仅用于与内建职位名表对账**，不得作为在册权威
//                        （在册真源 = 引擎自建表 `batch.managerSeat`，`source:'engine-registry'`）；
//   · `sessionOf(name)` → 按名反查会话标识，**三档语义必须可辨**：
//                         名在场 ⇒ 会话 id ｜ 名**不在**名册 ⇒ `null`（正常态）｜ 查询本身失败 ⇒ **抛**。
//
// ⚠ **同步返回是有意的**（不是漏写 `async`）：
//   宿主侧 `listMembers(agent)` 是**同步方法、无 IO**（`exec/r1-port.md` 与 `dispatch-register.js:63`
//   既有实证）；且本仓 `RosterSource` 的 **null 适配器亦同步返回**（`lib/bus/index.js` 的
//   `roster: { read: () => [] }`，而 `route()` 以 `await source.read()` 消费）⇒ 同步值对 `await`
//   **完全兼容**（`await` 非 thenable 直接取值）⇒ 契约的 Promise 形态在两种调用方式下都成立。
//   若将来某家宿主的 roster 变成异步，**本模块是唯一要改的地方**（引擎调用面按 await 兼容书写）。
//
// 取服务：复用 `tools-http.js#serviceOf`（**裸读优先 + `ctx.get` 回落**）—— 与 S-3 的
//   `tools` / `webServer` / `subagents` 三处**同一形态**，不新造第二套取法。
import { serviceOf } from './tools-http.js';

/** 查询失败拒态前缀（**普通 Error**；与 `host-port-query-failed:` 同族，用于区分「查不到」与「查询坏了」）。 */
export const ROSTER_QUERY_FAILED = 'roster-query-failed:';

/** 宿主 roster 行的名字字段（`name` / `target` 双键容错：宿主字段名漂移时不静默漏判）。 */
const nameOfRow = (row) => (row && typeof row === 'object')
  ? (typeof row.name === 'string' ? row.name : (typeof row.target === 'string' ? row.target : null))
  : null;
/** 宿主 roster 行的标识字段（`id` / `sessionId` 双键容错）。 */
const idOfRow = (row) => (row && typeof row === 'object')
  ? (typeof row.id === 'string' ? row.id : (typeof row.sessionId === 'string' ? row.sessionId : null))
  : null;

/**
 * **成员身份锚**（Q-E=乙 ·「在适配器端可以拿 Subagent ID 或其他锚定 Subagent 身份的信息」）。
 *
 * 为什么需要它：自建名册（`batch.managerSeat`）需要一个**不依赖宿主名册**的主键 —— 以前 `seatId`
 *   只能来自宿主成员名，导致「宿主 roster 缺席 ⇒ 自建表也无从落笔」。有了本函数，C 档（一次性
 *   subagent 派发）返回的 **Subagent ID** 也能当锚 ⇒ 自建表在非 Team 宿主上依然可写、可判在册。
 *
 * ⚠ **不进 `lib/ports.ts`**：这是 provider 的**额外导出**，不是 `RosterSource` 契约成员
 *   （与 `agentChannelFactsOf` 同理，避免动 W1 冻结契约）。
 * ⚠ **不伪造**：取不到任何可用锚时返回 `{ seatId: null, anchorKind: null }` —— 由调用方决定不写，
 *   **不得**用宿主名/时间戳等凑一个假 id（那会让自建表长得像登记过）。
 *
 * 锚的取值域与优先级（**稳定优先**）：
 *   ① `subagent-id`：C 档派发结果上的 `id`/`sessionId`/`subagentId`（一次性 subagent 的身份）；
 *   ② `agent-team-name`：D 档的成员名（`name`/`target`，与 `sessionOf` 入参同域）。
 *
 * @param {object|null} spawnResult 一次派发的产物（不同宿主的字段名差异在此收敛）
 * @returns {{seatId: string|null, anchorKind: 'subagent-id'|'agent-team-name'|null}}
 */
export function anchorOf(spawnResult) {
  if (!spawnResult || typeof spawnResult !== 'object') return { seatId: null, anchorKind: null };
  for (const key of ['subagentId', 'id', 'sessionId']) {
    const v = spawnResult[key];
    if (typeof v === 'string' && v.length > 0) return { seatId: v, anchorKind: 'subagent-id' };
  }
  const name = nameOfRow(spawnResult);
  if (typeof name === 'string' && name.length > 0) return { seatId: name, anchorKind: 'agent-team-name' };
  return { seatId: null, anchorKind: null };
}

/**
 * 名册端口。
 *
 * @param {object} ctx   插件上下文（**只在本文件被用来取宿主服务**）
 * @param {object} [agent] 查询凭据（宿主 `listMembers(agent)` 要求「live Team member 的 agent」）
 * @returns {{available:boolean, read:Function, sessionOf:Function}}
 */
export function createRosterPort(ctx, agent) {
  const svc = serviceOf(ctx, 'agentTeams');
  const available = Boolean(svc) && typeof svc.listMembers === 'function';

  /** 原始行（宿主形状）；查询失败**抛**（由 `read`/`sessionOf` 各自决定语义）。 */
  const rowsOf = () => {
    const rows = svc.listMembers(agent);
    return Array.isArray(rows) ? rows : [];
  };

  return {
    /** 名册功能是否可用（不可用时两个方法都走**可判定**的空/`null`，不抛宿主原生错）。 */
    available,

    /**
     * 读成员清单（**对账面**）。
     * 归一成契约的 `RosterRow`（`name` / `id?` / `role?` / `status?`）⇒ 宿主字段名差异不再外泄。
     * @returns {Array<{name:string,id?:string,role?:string,status?:string}>}
     * @throws {Error} 查询失败（前缀 `roster-query-failed:`）；**不可用时不抛**（返回 `[]`）
     */
    read() {
      if (!available) return [];
      let rows;
      try { rows = rowsOf(); } catch (e) {
        throw new Error(ROSTER_QUERY_FAILED + ' ' + String(e?.message ?? e));
      }
      return rows.map((row) => ({
        name: nameOfRow(row) ?? '',
        ...(idOfRow(row) ? { id: idOfRow(row) } : {}),
        ...(row && typeof row === 'object' && typeof row.role === 'string' ? { role: row.role } : {}),
        ...(row && typeof row === 'object' && typeof row.status === 'string' ? { status: row.status } : {}),
      }));
    },

    /**
     * 按名反查会话标识（**三档语义，禁归并**）。
     * @param {string} name
     * @returns {string|null} 名在场 ⇒ 会话 id；名**不在**名册 ⇒ `null`（正常态，调用方不得当失败）；
     *                        不可用 ⇒ `null`（调用方应先看 `available` 以区分「无此服务」）
     * @throws {Error} 查询本身失败（前缀 `roster-query-failed:`）——「查不到」与「查询坏了」必须可辨
     */
    sessionOf(name) {
      if (!available || typeof name !== 'string' || name.length === 0) return null;
      let rows;
      try { rows = rowsOf(); } catch (e) {
        throw new Error(ROSTER_QUERY_FAILED + ' ' + String(e?.message ?? e));
      }
      for (const row of rows) {
        if (nameOfRow(row) !== name) continue;
        const id = idOfRow(row);
        if (id) return id;
      }
      return null; // 「名不在名册」= 正常态：**不抛**
    },
  };
}
