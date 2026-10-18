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

// JSON 响应写端**单点**（`(lib-root)` 中立件）：只读治理 API（`lib/api.js`）与 ACPs 端点
//   （`lib/acps/server.js`）原先各持一份逐字同体的 `sendJson` ⇒ 收敛于此，两处 import 调用（W1a / A-1）。
// 语义红线：status 由调用方给定；Content-Type 固定 `application/json; charset=utf-8`；body 走 JSON.stringify。
export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
