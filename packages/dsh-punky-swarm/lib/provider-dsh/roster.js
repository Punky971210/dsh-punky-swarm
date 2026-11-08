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

// 归属（J6 / R-2 三层职责）：宿主服务名只允许出现在**本目录**；引擎只向适配层要「名册功能」，
//   不得知道宿主服务叫什么、以何形态取到。
//   · `read()`          → 成员清单，**仅用于与内建职位名表对账**，不得作为在册权威
//    （宿主名册只用于身份读端；引擎侧不再维护任何席位登记表）
import { serviceOf } from './tools-http.js';

export const ROSTER_QUERY_FAILED = 'roster-query-failed:';

const nameOfRow = (row) => (row && typeof row === 'object')
  ? (typeof row.name === 'string' ? row.name : (typeof row.target === 'string' ? row.target : null))
  : null;
const idOfRow = (row) => (row && typeof row === 'object')
  ? (typeof row.id === 'string' ? row.id : (typeof row.sessionId === 'string' ? row.sessionId : null))
  : null;

/**
 * @param {object} ctx   插件上下文（**只在本文件被用来取宿主服务**）
 * @param {object} [agent] 查询凭据（宿主 `listMembers(agent)` 要求「live Team member 的 agent」）
 * @returns {{available:boolean, read:Function, sessionOf:Function}}
 */
export function createRosterPort(ctx, agent) {
  const svc = serviceOf(ctx, 'agentTeams');
  const available = Boolean(svc) && typeof svc.listMembers === 'function';

  const rowsOf = () => {
    const rows = svc.listMembers(agent);
    return Array.isArray(rows) ? rows : [];
  };

  return {
    available,

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
      return null;
    },
  };
}
