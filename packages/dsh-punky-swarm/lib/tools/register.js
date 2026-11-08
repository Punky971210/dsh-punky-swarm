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

// 蟛蜞模式治理工具聚合注册入口（core 11 ＋ lane/worktree 工具族 + 可选能力组；可选组按装配键
import { createCoreTools, installDifficultyGuard } from './core.js';
import { createToolsPort } from '../provider-dsh/tools-http.js';
import { installWriteProvenanceGuard } from './write-provenance-guard.js';
import { installMcpDataPlane } from '../mcp/data-plane-server.js';
import { createLaneTools } from './lane-tools.js';
import { createLogTools } from './log-tools.js';
import { buildToolCatalog, engineVersion } from '../aip/tool-descriptor.js';
import { buildAgentCatalog } from '../aip/agent-descriptor.js';
import { resolveAssembly, DEFAULT_ASSEMBLY } from '../assembly.js';
import * as aipFormat from '../comms/aip-format.js';
import { readCapability } from '../assembly/schema.js';

export function createTools(ctx, deps) {
  installDifficultyGuard(ctx, deps);
  installWriteProvenanceGuard(ctx, deps);
  // MCP 数据面（`/mcp` 路由）的 disposer **必须挂到本 fiber**：宿主 `webServer.register()` 的路由
  //   不随插件卸载自动摘除 ⇒ 热重载/开关插件时第二次注册直接炸
  //   `webserver: duplicate exact route "/mcp"`（2026-11-08 活体实测：插件管理器关→开即复现）。
  //   `ctx.effect` 随 fiber 卸载执行；`verify`/`governance` 的挂载各走自己的 dispose 面，不经 `ctx.effect`。
  const mcpPlaneDispose = installMcpDataPlane(ctx, deps);
  if (typeof mcpPlaneDispose === 'function' && typeof ctx?.effect === 'function') {
    ctx.effect(() => mcpPlaneDispose, 'dsh-punky-swarm: mcp data plane');
  }
  //   ⚠ `deps.dispatchIndex` 不可序列化（Map 实例）⇒ 只走 JS 侧装配（`lib/index.js` 直传），yml 静态块不适用；
  const tools = [
    ...createCoreTools(ctx, deps),
    ...createLaneTools(ctx, deps),
    ...createLogTools(ctx, deps),
    //   本处只保留**语义判据**：两次装载的工具名差集恒 = `['log_export']`，且裸配置里它必须缺席（证明该开关是真开关）。
  ];

  // 生成器只读遍历 tools，不替换、不包装任何已注册工具对象（红线：既有工具契约不变）。
  const aipEnabled = readCapability(deps?.config, 'aip')?.enabled === true;
  let catalog = null;
  let agentCatalog = null;

  /** 生成 AIP 目录（幂等）。**不绑在注册上**：引擎要在挂 `/tools`、`/discover` 前就读到它，
   *  而注册已移到 preset 行（丙：装配隔离）——目录与注册时序解耦，谁先谁后都不影响读数。 */
  const buildCatalog = () => {
    if (!aipEnabled || catalog !== null) return catalog;
    catalog = buildToolCatalog(tools, { version: engineVersion(), config: deps?.config });
    const aipCfg = deps?.config?.aip ?? {};
    const assembly = resolveAssembly(aipCfg.team ?? 'punky-preset', deps?.config?.assembly) ?? DEFAULT_ASSEMBLY;
    const { owner, skillMeta, endPoints, securitySchemes, capabilities, defaultInputModes, defaultOutputModes } = aipCfg;
    agentCatalog = buildAgentCatalog(assembly, {
      version: engineVersion(),
      generatedAt: new Date().toISOString(),
      owner, skillMeta, endPoints, securitySchemes, capabilities, defaultInputModes, defaultOutputModes,
    });
    return catalog;
  };

  /**
   * 注册到**目标 ctx 所属的 scope 层**。
   *
   * 宿主语义（`@deepseek-ai/dsh-tools`）：`tools.register()` 落入**调用方** ctx 的 scope 层，
   *   不是进程全局 ⇒ 传 preset 组合里那一行的 ctx，工具就只对该 preset 的 agent（及其派生 worker）可见。
   * 缺省目标 = 构造本工具集时的 ctx（同进程单 scope 用法与单测）；生产由 preset 行显式传自己的 ctx。
   *
   * @param {object} [targetCtx] 承接注册的 ctx（决定工具落在哪个 scope 层）
   */
  const register = (targetCtx = ctx) => {
    buildCatalog();
    for (const t of tools) createToolsPort(targetCtx).registerTool(t);
  };

  return {
    tools,
    register,
    buildCatalog,
    get catalog() { return catalog; },
    get agentCatalog() { return agentCatalog; },
    // api.js 只读端点消费（缺省传入时端点不附投影，既有行为不变；红线：不改 mailbox 存储）
    get aipFormat() { return aipFormat; },
  };
}
