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

// 治理内核公共面收敛（G7）：re-export 6 个内核组件（ESM .js 后缀，对齐 PK 编译回拷模式）。
// 蓝图：m2-detailed.md §2 表 G7。消费方 = wiring.js（G8）与测试。

export * from './types.js';
export * from './decisions.js';
export * from './classify.js';
export * from './narrow.js';
export * from './kernel.js';
export * from './config.js';
