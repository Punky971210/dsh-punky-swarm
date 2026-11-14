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
// L1 拆分（批 `punky-panel-split-20261114`）：`/mcp` 的**两个创建点**与入口 B（自建 loopback）已整体迁到
//   `lib/panel/**`（入口 A → `lib/panel/surface.js#build`；入口 B → `lib/panel/index.js#apply`）。
//   本文件**不得**再留任何一个创建点：分居两侧会让同一 webServer 实例注册两次 `/mcp`
//   ⇒ 宿主抛 `webserver: duplicate exact route "/mcp"`（该失败模式是实测，不是推断）。
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
   * 缺省目标 = 构造本工具集时的 ctx（同进程单 scope 用法与单测）。
   *
   * @param {object} [targetCtx] 承接注册的 ctx（决定工具落在哪个 scope 层）
   * @param {{only?: string[]}} [options] `only` = 只注册名单里的名字（缺省全量）
   * @returns {() => void} 聚合 disposer —— **必须挂到 ctx.effect**，否则热重载对同层重复注册会抛
   *   `tool "X" is already registered`（宿主 tools/index.js:385）。
   */
  const register = (targetCtx = ctx, { only } = {}) => {
    buildCatalog();
    const allow = Array.isArray(only) ? new Set(only) : null;
    const disposers = [];
    for (const t of tools) {
      if (allow && !allow.has(t.name)) continue;
      const d = createToolsPort(targetCtx).registerTool(t);
      if (typeof d === 'function') disposers.push(d);
    }
    return () => {
      for (const d of disposers) {
        try { d(); } catch { /* 已释放 / 宿主已卸载：幂等 */ }
      }
    };
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
