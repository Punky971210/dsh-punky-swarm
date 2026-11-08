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

export function sessionOf(args, exec, resolveBatchSession) {
  if (args && typeof args.session === 'string' && args.session.length) return args.session;
  if (typeof resolveBatchSession === 'function') {
    let bound = null;
    try { bound = resolveBatchSession(exec); } catch { bound = null; }
    if (typeof bound === 'string' && bound.length) return bound;
  }
  return exec?.agent?.session?.id ?? 'cli';
}
