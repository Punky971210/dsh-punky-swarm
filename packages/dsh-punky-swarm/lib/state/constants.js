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

// lib/state/constants.js —— 标识符/路径校验常量单点（P1-07 收敛）
// 零依赖纯常量/纯函数模块：不 import 任何本包模块（避免循环依赖）。
// 消费方：store/gates/archive/corrupt-registry/evidence/log-tools/lane-tools/
//         wave-plan/lane-heartbeat/client/panel 等（见契约 P1-07 消费点清单）。
// 浏览器端面板段（lib/panel/*.js 与 lib/client.js 合成 bundle）无 ESM import 能力，
// 其 TERMINAL 为手工同步副本（见该处注释），Node 端单点以本文件为准。

// 会话/批次/lane ID 合法字符集（原先散落 6 处：store/gates/archive/corrupt-registry/evidence/log-tools/lane-tools）
export const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

// 兼容别名（既有消费方以 SESSION_RE 命名的正则，与 SAFE_ID 同款同引用）
export const SESSION_RE = SAFE_ID;

// 绝对路径判定（原 gates.js isAbsPath 现实现：盘符前缀 / UNC 反斜杠 / POSIX 根斜杠）
export function isAbsPath(p) {
  return /^[A-Za-z]:[\\/]|^\\|^\//.test(p);
}

// 成员终态数组（原散落 3 处：log-tools / client.js / panel main.js；batch-list/batch-detail 引用共享段定义）
export const TERMINAL = ['merged', 'failed', 'skipped', 'conflict'];
