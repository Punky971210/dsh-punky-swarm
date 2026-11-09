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

import { serviceOf } from './tools-http.js';
import { governedToolNames } from '../engine/suite.js';


export const name = 'dsh-punky-swarm-provider-dsh';

// ── 本行 = **蟛蜞模式治理工具面的装配点**（丙 · 装配隔离，2026-11-08 用户裁决）──────────────
// 宿主工具注册表按 scope 分层：`ctx.tools.register()` 落入**本行 ctx 所属的 scope 层**。
// 本行只装在 `presets/punky-preset/agent.cordis.yml`（= `cordis.patch.yml` 的
//   `dsh-agent-preset-punky.config.plugins`）里 ⇒ 治理工具是**该 preset 的祖先层贡献**，
//   只有选用 punky-preset 的 agent 及其派生 worker 在工具目录里看得到。
// 装配声明（宿主服务名 tools/subagents + 引擎行服务 punkySwarmTools）在组合面，不在本文件。
export function apply(ctx) {
  const roster = serviceOf(ctx, 'agentTeams');
  const available = Boolean(roster) && typeof roster.listMembers === 'function';
  ctx?.logger?.info?.('[dsh-punky-swarm] optional service agentTeams=' + (available ? 'available' : 'unavailable')
    + '（可选服务，不进 inject；缺失时降级，不 pending）');

  // 工具集由引擎行 `ctx.provide('punkySwarmTools', …)` 给出：本行既不建 store 也不持有工具定义，
  //   只决定「注册到哪个 scope」——这正是装配隔离的全部内容。
  const toolkit = serviceOf(ctx, 'punkySwarmTools');
  if (!toolkit || typeof toolkit.registerTools !== 'function') {
    // 组合面已 `inject: punkySwarmTools` ⇒ 走到这里说明引擎行未 provide（版本不匹配/半装配）。
    // 响亮留痕即可：本行仍算装配成功，工具面缺席而非整块 pending，其余功能面不受影响。
    ctx?.logger?.warn?.('[dsh-punky-swarm] governance tool face absent: punkySwarmTools service unavailable（引擎行未提供工具集）');
    return;
  }
  // 【分层注册 · 2026-11-09】常驻黑板 7 件已由引擎行注册到 global 层（MCP 可见面，`RESIDENT_TOOL_NAMES`）；
  //   本行只注册**补集**（治理写/派发/门禁投影等）⇒ 该 preset 的 agent 视角 = global(7) + 本层(28) = 35 件，
  //   与既有一致；同层不重名（宿主 register 对同名抛错）。
  toolkit.registerTools(ctx, { only: governedToolNames() });
  ctx?.logger?.info?.('[dsh-punky-swarm] governance tool face mounted into preset scope: '
    + toolkit.toolNames.length + ' tools（仅 punky-preset 会话可见；常驻黑板 7 件在 global 层）');
}
