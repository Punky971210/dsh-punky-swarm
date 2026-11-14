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

// lib/panel/surface.js —— 面板 HTTP **装配体**（L1 拆分：自 `lib/index.js#createHttpSurface` 整段平移）
//
// 归属划分（契约 §S-3，本文件是「panel 供装配体」那一半）：
//   · **core 保生命周期**：`internal/service` 订阅、`mounted` 幂等、聚合释放的**调用时机**、
//     `httpSurface` 端口状态机 —— 全部留在 `lib/index.js#bindHttpSurfaceDeferred`，不得出现第二份。
//   · **panel 供装配体**（本文件）：`/api` 12 路由 + `/mcp` 入口 A + 发现服务 + `/config` 写通道 + SSE hub，
//     经 `panelSurface.build(deps)` 交 core 调用；装配出来的**一次性聚合释放器**也由本文件持有并交回。
//
// 依赖纪律（契约 §S-4.1）：本文件在墙内 ⇒ 对 core 只许「端口面（`corePort`/`hasCorePort`）+ PEER_LEAVES」。
//   `deps` 是唯一允许穿越的非端口依赖（**冻结 7 键**，见 `build` 形参；多一/少一即违约）。
//
// 尺寸上限（契约 §S-1.4）：≤ 180 行 —— 超了说明有东西没搬对，不是「写长了」。

import { createApi } from './api.js';
import { createDiscoveryService } from './discovery/service.js';
import { createStreamHub } from './stream.js';
import { createRuntimeConfigService } from './webui/runtime-config.js';
import { installMcpDataPlane } from './mcp/data-plane-server.js';
import { resolveDiscoveryConfig } from '../schema.js';
import { corePort, hasCorePort } from '../core-ports.js';

const PANEL_ID = 'dsh-punky-swarm/panel';

/**
 * 生效配置的**唯一**读取面：`corePort('config').read()`（契约 C-4：panel 行**不写** `config:`）。
 *
 * 端口缺席（engine 行尚未 apply / 无装配夹具）⇒ 按出厂缺省 `{}` 装配，并 **warn 一次**——
 * 静默用空配置会让「面板少一半面」变成无声故障，而配置单源被破坏必须留痕。
 * @param {object} ctx 宿主上下文（只用于 logger）
 * @returns {() => object} 读取函数（每次调用都重新取件 ⇒ 热更后自然生效）
 */
export function createConfigReader(ctx) {
  let warned = false;
  return () => {
    if (hasCorePort('config')) return corePort('config').read();
    if (!warned) {
      warned = true;
      ctx?.logger?.warn?.('[' + PANEL_ID + '] corePort("config") 未就绪 ⇒ 本次装配按出厂缺省（{}）；'
        + '若持续如此，检查 cordis.patch.yml 中 panel 行是否排在 engine 行**之后**（行序硬约束）');
    }
    return {};
  };
}

/**
 * 造 `panelSurface.build`（由 `lib/panel/index.js` 的 apply 登记进端口）。
 *
 * @param {object} ctx panel 行自己的宿主上下文（closes over ⇒ 不进 `deps` 冻结面）
 * @returns {(deps: object) => {dispose: () => void, panelStream: object|null, apiDispose: Function|null}}
 */
export function createPanelSurfaceBuilder(ctx) {
  const readConfig = createConfigReader(ctx);
  // `/mcp` 入口 A 的**唯一持有者**（契约 N-9 / D-05 / AC-16 语义搬入）：
  //   · `installed === false`（webServer 缺席的早退 no-op / 注册被拒）**不构成持有者** ⇒ 下次 build 仍要真装；
  //   · 聚合释放摘掉路由后置空 ⇒ core `release()` 之后重新 `mount()` 走重装，不会撞
  //     宿主 `webserver: duplicate exact route "/mcp"`；也不会因「旧 disposer 指向已消失的 webServer」而空转。
  let mcpRouteHolder = null;

  /** @param {object} deps 冻结 7 键（root / catalog / agentCatalog / agentDescriptors / aipFormat / getWatchInstalledCfg / getGovernanceInstalledCfg） */
  const build = (deps) => {
    const {
      root, catalog, agentCatalog, agentDescriptors, aipFormat,
      getWatchInstalledCfg, getGovernanceInstalledCfg,
    } = deps;
    const config = readConfig();

    // ① `/mcp` 入口 A（adopt-or-install）——**唯一**路由创建点（入口 B 在 `lib/panel/index.js#apply`，
    //    两处必须同边：分居两侧会让同一实例注册两次 `/mcp` ⇒ 宿主抛 duplicate exact route）。
    let mcpDispose = null;
    if (mcpRouteHolder && mcpRouteHolder.installed === true) {
      // 接管上一轮的真挂载（同实例二次 build 的兜底）：由本次聚合释放摘除，**不**再装一次。
      mcpDispose = mcpRouteHolder;
    } else {
      const dispose = installMcpDataPlane(ctx, { logger: ctx?.logger });
      if (dispose && dispose.installed === true) {
        mcpRouteHolder = dispose;
        mcpDispose = dispose;
      } else {
        ctx?.logger?.warn?.('[' + PANEL_ID + '] /mcp 入口 A 未挂载（webServer 不可用或注册被拒 ⇒ installed=false，保持未挂载）');
      }
    }

    // ② 发现服务（ADP）：capabilities.discovery.enabled（默认开）时装配。
    //    `agentDescriptors` 的**回落分支留在 core**（含 `DEFAULT_ASSEMBLY`/`engineVersion`），本文件只消费结果。
    const discoveryCfg = resolveDiscoveryConfig(config);
    let discovery = null;
    if (discoveryCfg.enabled) {
      discovery = createDiscoveryService({ catalog, agentDescriptors, config: discoveryCfg });
      ctx?.logger?.info?.('[dsh-punky-swarm] discovery capability enabled: POST /discover + /.well-known/aip mounted ('
        + discovery.stats().entries + ' entries)');
    }

    // ③ SSE hub：**唯一**建造点（`api.js` 的回落建点只对「无装配夹具」生效，装配态恒经 deps 注入）。
    const panelStream = createStreamHub({ root, logger: ctx?.logger });

    // ④ `/api` 十二路由：批状态/事件/门禁一律经 `store` 端口读面，判据三纯函数经 `store.project`（同一引用）。
    const apiDispose = createApi(ctx, {
      store: corePort('store').read, root, catalog, agentCatalog, aipFormat, discovery, panelStream,
      project: corePort('store').project,
      configEndpoints: {
        runtimeConfig: createRuntimeConfigService({ root, logger: ctx?.logger }),
        trustedHosts: Array.isArray(config?.trustedHosts) ? config.trustedHosts : [],
        // applied / appliedWatch / presets = **惰性 getter**：`rt.governanceInstalledCfg` 等读位在 core 的
        //   apply 后段才回填，HTTP 请求时求值无 TDZ（与改造前闭包 getter 同一时序）。presets 走端口（P0·X-4）。
        applied: () => getGovernanceInstalledCfg(),
        appliedWatch: () => getWatchInstalledCfg(),
        presets: () => corePort('presets').list(),
      },
    }).dispose;

    // ⑤ 一次性聚合释放器（逆序 `/api` → SSE hub → `/mcp`）。**唯一调用者** = core 的 `mounted.dispose`
    //    （`rt.apiDispose` 指向同一个函数，自带一次性守卫 ⇒ 不会重复摘路由）。
    let spent = false;
    const dispose = () => {
      if (spent) return;
      spent = true;
      try { apiDispose?.(); } catch (e) { ctx?.logger?.warn?.('[' + PANEL_ID + '] /api dispose failed: ' + String(e?.message ?? e)); }
      try { panelStream?.dispose(); } catch (e) { ctx?.logger?.warn?.('[' + PANEL_ID + '] stream hub dispose failed: ' + String(e?.message ?? e)); }
      try { mcpDispose?.(); } catch (e) { ctx?.logger?.warn?.('[' + PANEL_ID + '] /mcp dispose failed: ' + String(e?.message ?? e)); }
      mcpRouteHolder = null; // 旧 webServer 实例已消失 ⇒ 下一轮必须自己真装（N-9）
    };

    return { dispose, panelStream, apiDispose };
  };

  return build;
}
