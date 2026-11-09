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

// lib/mcp/loopback-listener.js —— MCP 面**入口 B**：插件自建 `node:http` 监听（L1 模式）。
//
// 存在理由（判据源 `plan/mcp-loopback-wiring.md` §3.1 + 事实 5）：宿主 gateway 的 `policy()` 只包住
//   「经 `webServer.register` / `registerFallback` 注册的路由」；本文件用 `node:http` 自建 server
//   **不经过**那两个入口 ⇒ **结构性地**落在 gate 作用域之外。要点不是「找到放行开关」，而是「不注册」。
//
// 分工红线（判据源 C-1 / C-2）：
//   · 本文件**只管**「监听 / 生命周期 / 端口日志」，**零** MCP 协议逻辑 —— handler 由调用方注入
//     （`createMcpHandler` 产出，两入口同一份逻辑）；本文件连 JSON-RPC 帧都不自己写
//     （降级帧走 `data-plane-server.js` 的 `mcpInternalErrorFrame` 单点构造）。
//   · 依赖：`node:http` + 仓内两个窄件（`json-response.js` / `data-plane-server.js`），**零新增依赖**。
//     ⚠ 不引入 `node:fs` —— 端口发现文件已被 Leader 裁决 A-1 否决（见下）。
//
// 端口策略（Leader 裁决 **A-1**，覆盖判据源 §3.4 / R-6 / AC-5 的「顺序扫描 + 回落 0 + mcp-port.json」）：
//   `port` 恒等使用；冲突**不迁移、不扫描、不写发现文件** ⇒ `EADDRINUSE` 一律 warn + `installed === false`。
//   理由：MCP 客户端配置是一次填写、长期使用的稳定契约；端口会变等于每次启动都要重填或先读发现文件。
//
// 退出面（裁决 **A-2**）：`listen` 成功后必须 `server.unref()` —— listening 句柄会占住 event loop，
//   阻退 `dsh web` 这类靠 event loop 清空退出的进程。⚠ `server.hasRef` **不是** Node 公开 API
//   （实测 `typeof server.hasRef === 'undefined'`），只能读内部 `_handle.hasRef()`，测试侧已注明。

import http from 'node:http';
import { sendJson } from '../json-response.js';
import { mcpInternalErrorFrame } from './data-plane-server.js';

/**
 * 绑定主机 **硬钉**（C-3）：不绑 `0.0.0.0`、不从配置取通配地址。
 * 同机进程访问是本方案的固有前提；要跨机需另开增强项（不在本批）。
 */
export const MCP_LOOPBACK_HOST = '127.0.0.1';

/** 未安装时的同形 disposer（保证调用方 `.installed` / `.ready` / `.server` 三处取件都不抛）。 */
function notInstalled() {
  const dispose = () => {};
  dispose.installed = false;
  dispose.ready = Promise.resolve({ installed: false, port: null, error: null });
  dispose.closed = Promise.resolve();
  dispose.server = null;
  dispose.address = () => null;
  return dispose;
}

/**
 * 安装入口 B。
 *
 * @param {object} options
 * @param {(req: object, res: object) => Promise<unknown>} options.handler 与入口 A 共用的 handler
 * @param {string} options.path 本入口负责的路径（`MCP_PATH`）；其余路径一律 404
 * @param {{enabled: boolean, port: number, host?: string, rejectedHost?: string|null}} options.config
 *        `resolveMcpLoopbackConfig(config)` 的归一化结果
 * @param {object} [options.logger]
 * @returns {(() => void) & {installed: boolean, ready: Promise<object>, closed: Promise<void>, server: object|null, address: () => object|null}}
 *   disposer：幂等；`installed` 是**活读数**（`server.listening`），只表达「监听器已开」，与宿主路由注册结果**解耦**（R-9）。
 */
export function installMcpLoopback({ handler, path: routePath, config, logger } = {}) {
  const log = logger ?? null;

  // 装配缺陷不静默（禁「看起来装上了、其实没有」）。
  if (typeof handler !== 'function') {
    log?.warn?.('[mcp] loopback not installed：handler 缺失（装配缺陷）');
    return notInstalled();
  }
  const cfg = (config && typeof config === 'object') ? config : {};
  if (cfg.enabled !== true) {
    log?.debug?.('[mcp] loopback disabled（config.mcp.loopback.enabled !== true）');
    return notInstalled();
  }
  // host 不参与取值（C-3）；被拒的原值**显式**留痕，不静默丢弃。
  if (cfg.rejectedHost != null) {
    log?.warn?.('[mcp] loopback host 不可配（收到 ' + String(cfg.rejectedHost) + '）⇒ 强制 ' + MCP_LOOPBACK_HOST);
  }
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    log?.warn?.('[mcp] loopback not installed：port 非法（收到 ' + String(cfg.port) + '）');
    return notInstalled();
  }

  const server = http.createServer((req, res) => {
    // ── 路径判定（R-4 / AC-12）：入口 A 靠宿主路由 `kind:'exact'` 完成这件事，入口 B 没人替它做 ⇒ 必须自判。
    //    否则 `POST /任意路径` 都会打到 MCP 面（面比契约宽）。
    const url = String(req?.url ?? '').split('?')[0];
    if (url !== routePath) {
      log?.debug?.('[mcp] loopback rejected path: ' + url);
      return sendJson(res, 404, { error: 'not-found', path: url, hint: 'MCP loopback 只接受 ' + routePath });
    }
    // ── 异常兜底（R-5 / AC-11 ①）：handler 是 `async`，裸 `createServer` 下 reject 会升级为**进程级**
    //    `unhandledRejection`（照 `lib/acps/server.js:199-204` 的 `.catch` 范式）。此处本地兜死，绝不上抛。
    return Promise.resolve()
      .then(() => handler(req, res))
      .catch((e) => {
        log?.warn?.('[mcp] loopback handler failed（已兜底，不升级为宿主级 unhandledRejection）: '
          + String(e?.message ?? e));
        try {
          if (!res.headersSent) sendJson(res, 500, mcpInternalErrorFrame('internal error'));
          else res.end();
        } catch { /* 对端已断 ⇒ 无处可写，静默收场（本层不制造第二个异常） */ }
      });
  });

  // ── 畸形 HTTP（非法请求行等）**不得**断进程（AC-11 ②）：照 acps 的 clientError 纪律，销毁该连接即可。
  server.on('clientError', (err, socket) => {
    log?.debug?.('[mcp] loopback clientError: ' + String(err?.code ?? err?.message ?? err));
    try { socket?.destroy?.(); } catch { /* 已断 */ }
  });

  /** 一次装配的收敛读数（`ready` 解析值）。 */
  let settled = { installed: false, port: null, error: null };
  let tornDown = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  const ready = new Promise((resolve) => {
    const finish = (state) => { settled = state; resolve(state); };

    //  ⚠ 必须是 `on` 而非 `once`（Leader 复核发现）：`once` 在首次触发后自动摘除监听器，而下方
    //    「已在监听之后发生的错误」分支是**留痕后 return** —— 若用 `once`，该分支一触发监听器就消失，
    //    再来一个运行期 error（如 accept 期 `EMFILE`）就成了**无监听器的 `error` 事件**，EventEmitter
    //    会直接 throw ⇒ 进程崩溃。`finish()` 赋值 + `resolve()` 天然幂等，重复触发无害。
    server.on('error', (e) => {
      const code = String(e?.code ?? '');
      // 已在监听之后发生的错误 = **运行期**错误（不是绑定失败）⇒ 只留痕，不得改写 installed 语义。
      if (server.listening) {
        log?.warn?.('[mcp] loopback runtime error: ' + (code || 'unknown') + ' / ' + String(e?.message ?? e));
        return;
      }
      if (code === 'EADDRINUSE') {
        // 定稿文案（裁决 A-1）：含端口 + 可执行处置提示。**不迁移端口**。
        log?.warn?.('[mcp] loopback listen failed: port ' + port + ' in use（MCP 自建入口未启动；'
          + '改 config.mcp.loopback.port 后重启）');
      } else {
        log?.warn?.('[mcp] loopback listen failed: ' + MCP_LOOPBACK_HOST + ':' + port
          + '（' + (code || 'unknown') + ' / ' + String(e?.message ?? e) + '）');
      }
      finish({ installed: false, port, error: { code, message: String(e?.message ?? e) } });
      resolveClosed();
    });

    server.listen(port, MCP_LOOPBACK_HOST, () => {
      // 拆装竞态：dispose 先到、listen 后成功 ⇒ 立刻收口，**不留孤儿**（AC-9 ③ 的同一个病根）。
      if (tornDown) {
        server.close(() => resolveClosed());
        server.closeAllConnections?.();
        finish({ installed: false, port, error: { code: 'TORN_DOWN', message: 'disposed before listening' } });
        return;
      }
      // A-2：listening 句柄不得阻退宿主进程
      server.unref?.();
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      // 端口日志必打（A-1 单分支下「实际端口 = 配置端口」，仍如实打出，便于真机对照）
      log?.info?.('[mcp] loopback listening at http://' + MCP_LOOPBACK_HOST + ':' + actualPort + String(routePath ?? '')
        + '（MCP L1 自建入口，不经宿主 gateway；端口为**静态配置**，改 config.mcp.loopback.port 后需重启）');
      finish({ installed: true, port: actualPort, error: null });
    });
  });

  const disposer = () => {
    tornDown = true;
    if (!server.listening) { resolveClosed(); return; } // 幂等（R-7 / AC-6）：已关、从未开、绑定失败 ⇒ 零副作用
    try {
      server.close(() => { resolveClosed(); log?.debug?.('[mcp] loopback listener closed'); });
      // keep-alive 连接会挂住 close（RK-4）⇒ 照 `lib/acps/server.js:274` 断掉全部连接
      server.closeAllConnections?.();
    } catch (e) {
      log?.warn?.('[mcp] loopback dispose failed: ' + String(e?.message ?? e));
      resolveClosed();
    }
  };
  disposer.ready = ready;
  disposer.closed = closed;
  /** 只读观测面（AC-6 `listening` / AC-13 `_handle.hasRef()` 断言用；**勿**据此改监听配置）。 */
  disposer.server = server;
  disposer.address = () => server.address();
  // `installed` = 「监听器已开」的**活读数**（R-9）：与宿主路由注册结果无耦合，任何分支都能如实反映。
  Object.defineProperty(disposer, 'installed', { get: () => server.listening, enumerable: true });
  disposer.settled = () => settled;
  return disposer;
}
