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
import { callerSessionIdOf } from '../state/session-authority.js';

// 分工（禁双套判据）：**裁决**在唯一写路径 `lib/state/store.js#recordHandoff`（与写入同点的 fail-closed）；
//   服务不可用（非官方宿主基线态）/调用抛错 ⇒ **空数组**（= 该身份面无事实，不伪造）；
//
// 【N-04 · 两个面取值**刻意**不对称，且方向是防御性的 —— 禁止「统一」】
//   · 路径面（产物写哪里）= `lib/tools/shared.js#sessionOf`：`args.session` **优先**（首行短路）；
//   · 身份面（谁有权写）  = 本函数：`exec.agent.session.id` **优先**，`args.session` 仅作回落。
//   ⇒ 攻击者把 `args.session` 指向受害者会话时，产物路径会写向受害者会话根，但**授权侧看到的是
//     真实调用方** ⇒ `GATE_HANDOFF_UNAUTHORIZED` / `GATE_HANDOFF_IDENTITY_UNKNOWN` 拒（fail-closed）。
//   反方向（把本函数改成 args 优先以「统一」）会立刻把它翻成 fail-open —— 后来者不得改动此处取值顺序；
//   身份取值已下沉到 `state/session-authority.js#callerSessionIdOf`（与写族属主门同源）。
export function handoffCallerIdentityOf(ctx, exec, args) {
  const sessionId = callerSessionIdOf(exec)
    ?? (typeof args?.session === 'string' && args.session.length ? args.session : null);
  const rosterNames = [];
  try {
    for (const m of createRosterPort(ctx, exec?.agent).read()) {
      if (m && typeof m.name === 'string' && m.name.trim()) rosterNames.push(m.name.trim());
    }
  } catch {  }
  return { source: 'handoff-caller-identity', sessionId, rosterNames };
}
