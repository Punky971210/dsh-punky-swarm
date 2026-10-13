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
// 承载 TEXT_OUTPUT / sessionOf（原 lib/tools/core.js 导出，watch 域 lane-heartbeat 亦消费，
// 为避免 watch → tools/core 整模块依赖，下沉至本零依赖模块——零 import 防循环依赖）。
// 消费方：core.js（re-export 保持对外导出兼容）、mailbox-tools.js / log-tools.js /
//         lane-tools.js / lane-heartbeat.js。
// 红线：本文件不得 import 任何模块（零依赖设计，防循环依赖）。

// 工具输出渲染辅助：{ type: 'text', text } 数组（defineTool output.render 返回契约）
export const TEXT_OUTPUT = (text) => [{ type: 'text', text }];

// 会话 ID 解析（**四级**）：args.session 显式优先 → 注入 resolver 命中（worker ⇒ 批归属会话）
//   → exec.agent.session.id → 'cli'（共享黑板兜底）。
//
// 【批 d-override-fix-20261011 · lane e4-session-bind】第三参数 `resolveBatchSession` = **调用方注入的函数**
//   `(exec) => string | null`（缺省 `undefined` ⇒ **逐字回落原三级路径，零行为变化**）。
//   缺陷背景（实测）：引擎自派 worker 是**子会话**，其 `exec.agent.session.id` = workerSessionId，
//   而批次归属键 = 派发方（Leader）会话 ⇒ 未传 `args.session` 的治理工具调用一律落到子会话，
//   被 `store.readBatch` 拒（原始回执：`Error: batch not found: <batchId> @<workerSessionId>`）。
//   修法 = 在「显式值」与「执行会话」之间插入**注入式**归属解析（worker→批 索引由装配层单点给出）。
//
// 红线（**不得违反**）：
//   ① 本文件**零 import**（见 :23）⇒ resolver 只接受**注入的函数**，此地不 import 任何模块、
//      不持有任何索引、不自造第二套回落顺序（**单点判定**：顺序只此一处）。
//   ② `'cli'` 兜底语义与取值式**逐字不变**（Leader 会话 / 无绑定会话 ⇒ resolver 不命中 ⇒ 原路径）。
//   ③ resolver 抛错/返回非字符串/空串 ⇒ 视为**不命中**，静默回落（工具面工具不得因归属解析而炸）。
export function sessionOf(args, exec, resolveBatchSession) {
  if (args && typeof args.session === 'string' && args.session.length) return args.session;
  if (typeof resolveBatchSession === 'function') {
    let bound = null;
    try { bound = resolveBatchSession(exec); } catch { bound = null; }
    if (typeof bound === 'string' && bound.length) return bound;
  }
  return exec?.agent?.session?.id ?? 'cli';
}
