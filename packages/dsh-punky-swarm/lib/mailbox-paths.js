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

// mailbox 落盘根的**单一派生点**（`(lib-root)` 中立件，A1-P2-10）。
//
// 为什么落 `(lib-root)` 而**不落** `lib/comms/`：`.punky/arch.yml` 的 `allowed` 含
//   `engine -> comms` / `(lib-root) -> comms` / `comms -> (lib-root)` / `tools -> comms` / `panel -> comms` / `acps -> comms`，
//   但**不含** `watch -> comms` 与 `bridge -> comms` ⇒ 放 `comms/` 会让 `watch/heartbeat/context.js` 与
//   `bridge/trajectory.js` 各新增一条越界边、直接破棘轮（该白名单改动须 Leader 审核）。
//   而 `watch` / `bridge` / `engine` / `comms` 四个消费域到 `(lib-root)` 的四对**均已在册** ⇒ 零白名单变更。
//
// 语义红线：`root/sessions/<sessionId>/mailbox/<batchId>` 四级路径逐字不变，调用方负责 root 与 id 的取值。
//
// 唯一行为边界（有意变更，已在批次产物登记）：原 `lib/engine/dispatch.js` 的派生容忍 `null`/`undefined` root
//   （`String(engineRoot ?? '').replace(/[\\/]+$/,'') + '/sessions/…'` ⇒ 产出 `/sessions/<sid>/mailbox/<bid>`
//   这种**无根路径**）。收成单点后该退化档改为 **throw**（fail-closed）：无根是编程错误，不是可运行形态。
//   生产路径无此形态（三处 root 源分别是 `store.sessionsDir`、常量 `cx.engineRoot`（已守卫）、
//   装配层 `config.root`），故该档仅是错误面收严，不改任何正常入参的行为。
import { join } from 'node:path';

export function mailboxRootOf(root, sessionId, batchId) {
  if (!root) throw new Error('mailboxRootOf: root required (engine root / store.sessionsDir)');
  return join(root, 'sessions', sessionId, 'mailbox', batchId);
}
