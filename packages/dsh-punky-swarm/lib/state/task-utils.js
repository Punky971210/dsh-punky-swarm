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

// lib/state/task-utils.js —— 任务定位纯函数单点（替代多处同构遍历）

/**
 * 在 wavePlan 中按 lane id 定位任务（语义：遍历 wavePlan[].tasks 按 t.id === lane 匹配）。
 * @param {object|null} batch 批次对象（可能为 null / 缺 wavePlan）
 * @param {string} lane lane 任务 ID
 * @returns {object|null} 命中返回任务对象；未命中 / 输入不完整返回 null
 */
export function findTask(batch, lane) {
  if (!batch) return null;
  for (const w of batch.wavePlan ?? []) {
    if (!w || !Array.isArray(w.tasks)) continue;
    for (const t of w.tasks) {
      if (t && t.id === lane) return t;
    }
  }
  return null;
}
