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
import { installMcpDataPlane, createMcpHandler, MCP_PATH } from '../mcp/data-plane-server.js';
import { installMcpLoopback } from '../mcp/loopback-listener.js';
import { resolveMcpLoopbackConfig } from '../schema.js';
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
  // 【exactly-once（批 `punky-prerelease-scan` · D-05 / AC-16）】本 disposer 有**两个持有者**：
  //   下面的 `ctx.effect`（fiber 卸载面）与 `lib/index.js#bindHttpSurfaceDeferred` 的聚合释放
  //   （`mount()` 的 adopt 分支会把它接管为 `/mcp` 路由的持有者，见 `index.js:512`）。
  //   宿主 `webserver.register` 的 disposer 是 `table.delete(path)`（重复调用本身无害），但「调用次数」
  //   是本批的验收读数（`register('/mcp') === dispose('/mcp')`）⇒ 在**创建点**收敛为一次性，
  //   两个持有者共享同一包装对象（`mcpPlaneOf()` 透传的就是它 ⇒ 接管方拿到的必然是包装，绕不过守卫）。
  //   `installed` 原样透传：`index.js:511` 的 adopt 判据读的就是它，语义一字不改。
  const mcpPlaneRaw = installMcpDataPlane(ctx, deps);
  const mcpPlaneDispose = (() => {
    let spent = false;
    const guarded = () => {
      if (spent) return;
      spent = true;
      mcpPlaneRaw();
    };
    guarded.installed = mcpPlaneRaw.installed;
    return guarded;
  })();
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => mcpPlaneDispose, 'dsh-punky-swarm: mcp data plane');
  }
  // ── 入口 B：MCP 面**自建** loopback 监听（L1 模式：不依赖宿主 webServer / gateway 策略）─────────────
  //   归属纪律（R-8）：**唯一创建点 = 本函数**，**唯一释放点 = `ctx.effect`**。
  //   ⚠ 不得放进 `lib/index.js` 的 http surface `mount()`（那里以 `webServer.available` 早退 ⇒ 把入口 B
  //     拖回宿主依赖，废掉 L1）；也不得放进上面刚调用的 `installMcpDataPlane`（同样 early-return）。
  //   handler 复用 `createMcpHandler`（与入口 A 同一工厂，禁第二套实现）；入口 B **不看** webServer 是否可用。
  //   无 `ctx.effect` ⇒ 没有释放保证 ⇒ **宁可不建监听器**，也不留孤儿（孤儿 ⇒ 下次装配 EADDRINUSE）。
  const mcpLoopback = (() => {
    const loopbackConfig = resolveMcpLoopbackConfig(deps?.config);
    if (!loopbackConfig.enabled) {
      (deps?.logger ?? ctx?.logger)?.debug?.('[mcp] loopback disabled by config.mcp.loopback.enabled=false');
      return null;
    }
    if (typeof ctx?.effect !== 'function') {
      (deps?.logger ?? ctx?.logger)?.debug?.('[mcp] loopback skipped：ctx.effect 不可用（无释放保证 ⇒ 不建监听器）');
      return null;
    }
    const { handler } = createMcpHandler(ctx, deps);
    const listener = installMcpLoopback({
      handler,
      path: MCP_PATH,
      config: loopbackConfig,
      logger: deps?.logger ?? ctx?.logger ?? null,
    });
    ctx.effect(() => listener, 'dsh-punky-swarm: mcp loopback listener');
    return listener;
  })();
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
    // 【方案 A · 延迟绑定】`/mcp` 的「是否已有真实挂载」判定口（消费方 = `lib/index.js#bindHttpSurfaceDeferred`）：
    //   本函数开头的 `installMcpDataPlane` 可能**早退**（`webServer` 尚未就绪 ⇒ 返回 `installed === false`
    //   的 no-op disposer），那次尝试**不构成持有者**；延迟装配据此判断要不要重试挂载（禁双挂）。
    //   `installed` 是 `data-plane-server.js:266/277` 的既有两态标志，本处只透传、不新造标记。
    mcpPlaneDispose,
    // 【入口 B · 可观测面】自建 loopback 监听器的 disposer（未装 / 关闭 / 无 `ctx.effect` 时为 `null`）。
    //   测试与验收据此取 `.ready`（含 installed/port/error）、`.server`（listening / hasRef 读数）。
    mcpLoopback,
    get catalog() { return catalog; },
    get agentCatalog() { return agentCatalog; },
    // api.js 只读端点消费（缺省传入时端点不附投影，既有行为不变；红线：不改 mailbox 存储）
    get aipFormat() { return aipFormat; },
  };
}
