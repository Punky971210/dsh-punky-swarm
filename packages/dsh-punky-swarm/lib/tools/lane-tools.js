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
// -----------------------------------------------------------------------------
// 原骨架仅导出签名，本文件补齐 3 个 worktree 治理工具。实现契约要点：
//   - lane_worktree_create  : git worktree 建 lane 隔离工作树（幂等；集成分支 punky/orch 常驻，
//                             lane 分支 punky/<laneId> 从 orch HEAD 基线；残留先清理）
//   - lane_worktree_merge   : 串行 merge lane 分支进 orch（merge 队列锁 = serializedMerge 纪律；
//                             成功清理 worktree+分支；失败保留现场 + 冲突文件清单，不自动处置）
//   - lane_checkpoint       : lane 内 git add -A + commit（无变更 no-op）；这是续跑增强恢复
//                             的物理保全地基——崩溃后 checkpoint 保住产物、
//                             人工可抢救（git log 可查），不触发任何自动恢复（守「不做续跑」红线）
//   - lane_checkpoint_status: 只读查询该 lane checkpoint 历史与 latest 进度（读事件流不调 git；
//                             resume 契约唯一查询入口——新 worker 查 checkpoint 跳过已完成步骤）
// lane_heartbeat 工具由 lib/watch/lane-heartbeat.js 注入组装（enabled 门控由该模块自持；
// 守卫式加载：既有 lane 未合入时静默降级，本模块照常注册 worktree 四工具，互不阻塞。
//
// 装配开关：经 readCapability(config,'worktree') 合并注册表 default（缺省默认开，显式 enabled:false 可关）；
// lane_checkpoint 可选 progress={step,total}（commit message + 事件 step/total + laneProgress 断点指针写）+ 只读 lane_checkpoint_status。
//
// 与 lane_claim 逻辑锁的互补关系：
//   - lane_claim（既有）：同一 lane 的【逻辑写】锁——批次/成员状态文件、产物落盘路径并发防写；
//     管「写谁的」（治理状态层），维持现状是正确性底线。
//   - 本组工具（新增）：不同 lane 在【同一 git 仓库】的【物理写】——工作目录/分支/文件树；
//     管「写到哪」（工作区层），仅当 C 类批次多 lane 作用于同一 git 仓库时启用（Manager 在 exec
//     派发前先 lane_worktree_create 并把路径注入 worker 任务包作 cwd 契约）。
//   两者不能互相替代（worktree 不管状态文件并发；lane_claim 不管文件系统冲突），叠加才完整。
// -----------------------------------------------------------------------------

import { readCapability } from '../assembly/schema.js'; // 装配开关缺省合并读取（注册表 default 同源口径）
import { worktreeToolCreate, worktreeToolMerge, worktreeToolCheckpoint, worktreeToolCheckpointStatus } from './lane-worktree-tools.js';

// ---- 依赖注入：随 B1 删除 lane_heartbeat / lane_longrun 两工具，
//   原「守卫式加载 ../watch/lane-heartbeat.js」的动态 import 一并移除（模块本身与引擎实现保留）。


// ---- 组装：仅 worktree 四工具（B1 起 lane_heartbeat / lane_longrun 已删除，不再有组装面）----
export function createLaneTools(ctx, deps) {
  const config = deps?.config ?? {};
  const tools = [];
  // worktree 四工具（create/merge/checkpoint/checkpoint_status）：缺省默认开（readCapability 合并注册表 default，显式 enabled:false 可关）
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
