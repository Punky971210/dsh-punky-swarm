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

// dsh-punky-panel —— 面板 L1 子插件行（`cordis.patch.yml` 的 `name: 'dsh-punky-swarm/panel'`）。
//
// 本文件是**薄入口**（契约 §S-1.4：≤ 120 行）：装配体在 `./surface.js`，服务器侧实现在 `./api.js` /
// `./mcp/**` / `./discovery/**` / `./webui/**` —— 全部是本包内的**同一份**代码（`exports['./panel']` 子路径，
// 不是复制品），因此与 core 共享同一份 `lib/core-ports.js` 模块实例 ⇒ 端口是同进程同一对象。
//
// 三件职责（契约 §S-3.3，顺序是契约不是偏好）：
//   ① 登记第 8 个端口键 `panelSurface`（**唯一**由非 engine 行登记的键：它承载的正是「装配体」）；
//   ② 入口 B（MCP 自建 loopback 监听）—— **不得**放进 `build()`：`build` 只在 `webServer.available`
//      为真时才被调用，塞进去等于把入口 B 拖回宿主依赖，恰好废掉 L1 唯一的价值场景（headless 仍可用）；
//   ③ 催挂：`corePort('httpSurface').ensure()` —— engine 行装配时 webServer 可能还没到（延迟态），
//      本行 apply 完成后已经没有「晚登记的 builder 看不见」的问题了（core 每次 mount 重新取件）。
//
// inject 面（契约 C-6）：**空**。宿主 cordis 4.0.5 的 `inject` 无 optional 位 ⇒ 硬注入会让 headless 宿主
// 整块 pending；本行对宿主能力的全部需求经 `corePort` / `createHttpPort(ctx)` 端口层取得（与 engine 行同法）。

import { createPanelSurfaceBuilder, createConfigReader } from './surface.js';
import { createMcpHandler, MCP_PATH } from './mcp/data-plane-server.js';
import { installMcpLoopback } from './mcp/loopback-listener.js';
import { resolveMcpLoopbackConfig } from '../schema.js';
import { corePort, hasCorePort, registerCorePort, unregisterCorePort } from '../core-ports.js';

export const name = 'dsh-punky-panel';
/** 空声明：宿主服务名 ≠ 本行依赖（依赖全部经端口层，见文件头 C-6）。 */
export const inject = [];

export const apply = (ctx, config = {}) => {
  const readConfig = createConfigReader(ctx);

  // ① 登记装配体端口：**先摘后登**（同 `store`/`toolFace`/`presets` 口径）——
  //    同进程重建（热重载 / 多夹具）第二次 apply 否则抛 `DUPLICATE_CORE_PORT`。
  //    ⚠ 本键**不**写进 `rt`：`rt` 字段集被 `test/w7f-rt-write-surface.test.js` 冻结 19 项。
  const portImpl = { id: 'dsh-punky-swarm/panel', build: createPanelSurfaceBuilder(ctx) };
  unregisterCorePort('panelSurface');
  registerCorePort('panelSurface', portImpl);

  // ② 入口 B：MCP 面**自建** loopback 监听（L1 模式：不依赖宿主 webServer / gateway 策略）。
  //    归属纪律：**唯一创建点 = 本函数**，**唯一释放点 = `ctx.effect`**。
  //    handler 复用 `createMcpHandler`（与入口 A 同一工厂，禁第二套实现）；入口 B 不看 webServer 是否可用。
  //    无 `ctx.effect` ⇒ 没有释放保证 ⇒ **宁可不建监听器**，也不留孤儿（孤儿 ⇒ 下次装配 EADDRINUSE）。
  const loopbackConfig = resolveMcpLoopbackConfig(readConfig());
  let mcpLoopback = null;
  if (!loopbackConfig.enabled) {
    ctx?.logger?.debug?.('[mcp] loopback disabled by config.mcp.loopback.enabled=false');
  } else if (typeof ctx?.effect !== 'function') {
    ctx?.logger?.debug?.('[mcp] loopback skipped：ctx.effect 不可用（无释放保证 ⇒ 不建监听器）');
  } else {
    const { handler } = createMcpHandler(ctx, { logger: ctx?.logger });
    mcpLoopback = installMcpLoopback({
      handler,
      path: MCP_PATH,
      config: loopbackConfig,
      logger: ctx?.logger ?? null,
    });
    ctx.effect(() => mcpLoopback, 'dsh-punky-swarm/panel: mcp loopback listener');
  }

  // ③ 催挂：engine 行若已登记 `httpSurface`（正常行序下必然如此），把延迟态催成装配态。
  //    端口缺席 = 行序被改坏（panel 行跑到了 engine 行前面）⇒ **响亮留痕**，不静默跳过。
  if (hasCorePort('httpSurface')) {
    try {
      corePort('httpSurface').ensure();
    } catch (e) {
      ctx?.logger?.warn?.('[dsh-punky-swarm/panel] httpSurface.ensure() failed: ' + String(e?.message ?? e));
    }
  } else {
    ctx?.logger?.warn?.('[dsh-punky-swarm/panel] corePort("httpSurface") 缺席 ⇒ 本行未催挂 HTTP 面；'
      + '检查 cordis.patch.yml 中 panel 行是否排在 engine 行**之后**（行序硬约束）');
  }

  // ④ 卸载：**先**释放路由面（幂等）**再**摘 builder —— 顺序颠倒会留一批指向已卸载代码的路由。
  //    （入口 B 的监听器由 `ctx.effect` 负责，本处不重复释放。）
  return () => {
    if (hasCorePort('httpSurface')) {
      try { corePort('httpSurface').release('panel unload'); } catch (e) {
        ctx?.logger?.warn?.('[dsh-punky-swarm/panel] httpSurface.release() failed: ' + String(e?.message ?? e));
      }
    }
    // 只摘自己登记的那一份（同实例二次 apply 时，旧 disposer 不得摘掉接管者的端口）。
    if (hasCorePort('panelSurface') && corePort('panelSurface') === portImpl) unregisterCorePort('panelSurface');
  };
};
