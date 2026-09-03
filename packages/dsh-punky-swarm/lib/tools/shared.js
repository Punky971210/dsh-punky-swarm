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

// lib/tools/shared.js —— 工具域零依赖共享辅助（P2-01 下沉）
// 承载 TEXT_OUTPUT / sessionOf（原 lib/tools/core.js 导出，watch 域 lane-heartbeat 亦消费，
// 为避免 watch → tools/core 整模块依赖，下沉至本零依赖模块——零 import 防循环依赖）。
// 消费方：core.js（re-export 保持对外导出兼容）、mailbox-tools.js / log-tools.js /
//         lane-tools.js / lane-heartbeat.js。
// 红线：本文件不得 import 任何模块（零依赖设计，防循环依赖）。

// 工具输出渲染辅助：{ type: 'text', text } 数组（defineTool output.render 返回契约）
export const TEXT_OUTPUT = (text) => [{ type: 'text', text }];

// 会话 ID 解析：args.session 显式优先，缺省回退 exec.agent.session.id，无则 'cli'（共享黑板兜底）
export function sessionOf(args, exec) {
  if (args && typeof args.session === 'string' && args.session.length) return args.session;
  return exec?.agent?.session?.id ?? 'cli';
}
