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

// 蟛蜞模式 lane 工具（worktree 物理隔离 + checkpoint 提交）
//                             人工可抢救（git log 可查），不触发任何自动恢复（守「不做续跑」红线）
//   两者不能互相替代（worktree 不管状态文件并发；lane_claim 不管文件系统冲突），叠加才完整。

import { readCapability } from '../assembly/schema.js';
import { worktreeToolCreate, worktreeToolMerge, worktreeToolCheckpoint, worktreeToolCheckpointStatus } from './lane-worktree-tools.js';



export function createLaneTools(ctx, deps) {
  const config = deps?.config ?? {};
  const tools = [];
  if (readCapability(config, 'worktree')?.enabled === true) {
    tools.push(
      worktreeToolCreate(ctx, deps),
      worktreeToolMerge(ctx, deps),
      worktreeToolCheckpoint(ctx, deps),
      worktreeToolCheckpointStatus(ctx, deps),
    );
  }
  return tools;
}
