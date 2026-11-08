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

import { reconcileRoster } from '../roster.js';
import { createRosterPort } from '../provider-dsh/roster.js';













const MANAGER_ROSTER_NAME = 'manager';

//   宿主 roster（无论哪家宿主、以何形态取到）**只用于对账，不得作为权威**（与 `lib/ports.ts#RosterSource` 同源）。
const seatOf = (batch) => {
  const seat = batch?.managerSeat ?? null;
  if (!seat || typeof seat.seatId !== 'string' || seat.seatId.length === 0) return null;
  if (seat.source !== 'engine-registry') return null;
  return seat;
};

const inRosterOf = (batch, rosterMatched) => (batch ? Boolean(seatOf(batch)) : rosterMatched);

export function managerRosterOf(ctx, exec, batch) {
  // ⚠ **两处提前 return 也必须带上表读数**：否则「表已登记 + roster 服务不可用」会退化为 `inRoster:false`
  const seatInRoster = inRosterOf(batch, false);
  //   `available` = 功能面读数（不可用 ⇒ 可判定降级，不抛宿主原生错）；`read()` 查询失败 ⇒ 抛（可辨异常态）。
  const rosterPort = createRosterPort(ctx, exec?.agent);
  if (!rosterPort.available) {
    return { ok: false, source: 'roster', inRoster: seatInRoster, reason: 'service-unavailable', rosterName: MANAGER_ROSTER_NAME };
  }
  let list = null;
  try { list = rosterPort.read(); } catch (e) {
    return { ok: false, source: 'roster', inRoster: seatInRoster, reason: 'not-a-team-member: ' + String(e?.message ?? e), rosterName: MANAGER_ROSTER_NAME };
  }
  const reconcile = reconcileRoster(list);
  const hit = list.find((m) => m && m.name === MANAGER_ROSTER_NAME) ?? null;
  return {
    ok: true, source: 'roster', inRoster: inRosterOf(batch, reconcile.matched.includes(MANAGER_ROSTER_NAME)), rosterName: MANAGER_ROSTER_NAME, memberCount: list.length,
    member: hit ? { id: hit.id ?? null, name: hit.name, role: hit.role ?? null, status: hit.status ?? null } : null,
  };
}

/** Manager 读端**统一形态**：在册判定（表）与 roster 对账面（`roster`）/ legacy 字段（`batch.manager`）并列回显。 */
export function managerViewOf(ctx, exec, batch) {
  const roster = managerRosterOf(ctx, exec, batch);
  const legacy = batch && batch.manager ? { agentId: batch.manager.agentId ?? null, raisedAt: batch.manager.raisedAt ?? null } : null;
  return { roster, legacy, managerPlan: batch?.assembly?.managerPlan ?? null };
}

//   各写一份，就是**两套判定**（本仓红线），且那两个文件**拿不到算差集所需的输入**（六键不含 roster 名单）。
/** `mismatch` / `seatReason` 的**唯一计算点**（纯函数：只读既有输出，不做任何判定/写入）。 */
export function managerSeatFaceOf(batch, rosterView) {
  const seat = seatOf(batch ?? null);
  const seatReason = seat ? null : 'seat-not-registered';
  // roster 不可读 ⇒ 对账面**无事实**：返回 null（不静默降级成「一致」，也不伪造差集）。
  if (!rosterView || !rosterView.ok) return { seatReason, mismatch: null };
  const rosterHasManager = Boolean(rosterView.member);
  const tableOnly = seat && !rosterHasManager ? [MANAGER_ROSTER_NAME] : [];
  const rosterOnly = !seat && rosterHasManager ? [MANAGER_ROSTER_NAME] : [];
  return { seatReason, mismatch: { tableOnly, rosterOnly } };
}

//   **不再探测宿主 `agentTeams` 服务**（旧抽象把「宿主没有团队服务」读成「名册不可用」= 被废除的降级）。
// @param {object} store 引擎 store（`lib/state/store.js#createStore` 的产物）
// @returns {{available: boolean, reason: string|null}}
export function rosterTableReadyOf(store) {
  const missing = [];
  if (!store || typeof store !== 'object') {
    missing.push('store');
  } else {
    if (typeof store.readBatch !== 'function') missing.push('store.readBatch');
    if (typeof store.listBatches !== 'function') missing.push('store.listBatches');
    if (typeof store.markManagerRaised !== 'function') missing.push('store.markManagerRaised');
  }
  let discriminates = false;
  try {
    const good = seatOf({ managerSeat: { seatId: 'probe', role: 'manager', source: 'engine-registry' } });
    const empty = seatOf({});
    const forged = seatOf({ managerSeat: { seatId: 'probe', role: 'manager', source: 'host-roster' } });
    discriminates = Boolean(good) && empty === null && forged === null;
  } catch {
    discriminates = false;
  }
  if (!discriminates) missing.push('seatOf-discriminator');
  return missing.length === 0
    ? { available: true, reason: null }
    : { available: false, reason: 'roster-table-unwired: ' + missing.join('+') };
}

// 分工（禁双套判据）：**裁决**在唯一写路径 `lib/state/store.js#recordHandoff`（与写入同点的 fail-closed）；
//     服务不可用（非官方宿主基线态）/调用抛错 ⇒ **空数组**（= 该身份面无事实，交由 ③④⑤ 继续判定，不伪造）；
export function handoffCallerIdentityOf(ctx, exec, args) {
  const sessionId = exec?.agent?.session?.id
    ?? (typeof args?.session === 'string' && args.session.length ? args.session : null);
  const rosterNames = [];
  try {
    for (const m of createRosterPort(ctx, exec?.agent).read()) {
      if (m && typeof m.name === 'string' && m.name.trim()) rosterNames.push(m.name.trim());
    }
  } catch {  }
  return { source: 'handoff-caller-identity', sessionId, rosterNames };
}
