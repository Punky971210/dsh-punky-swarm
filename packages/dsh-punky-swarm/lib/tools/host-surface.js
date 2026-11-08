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

// 宿主身份读端（本模块**唯一**对外职责）：交接提交时的调用方身份（sessionId + 宿主名册名）。
//   Manager 席位登记 / 在册对账 / 缺口事件整块已删除 —— 调度真源是任务黑板（`batch.lanes` +
//   `batch.wavePlan`），不再存在「独立 Manager 成员」这一层。
import { createRosterPort } from '../provider-dsh/roster.js';

// 分工（禁双套判据）：**裁决**在唯一写路径 `lib/state/store.js#recordHandoff`（与写入同点的 fail-closed）；
//   服务不可用（非官方宿主基线态）/调用抛错 ⇒ **空数组**（= 该身份面无事实，不伪造）；
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
