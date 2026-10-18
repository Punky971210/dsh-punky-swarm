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

// mailbox 落盘根**单点**（`comms` 域）：ACPs 桥接（`acps-bridge.js`）、topic 分发（`topic.js`）、
//   mailbox 工具面（`tools/mailbox-tools.js`）原先各持一份逐字同体的路径拼接 ⇒ 收敛于此（W1b / A-5）。
// 语义红线：root/sessions/<sessionId>/mailbox/<batchId> 四级路径逐字不变，调用方负责 root 与 id 的取值。
import { join } from 'node:path';

export function mailboxRootOf(root, sessionId, batchId) {
  return join(root, 'sessions', sessionId, 'mailbox', batchId);
}
