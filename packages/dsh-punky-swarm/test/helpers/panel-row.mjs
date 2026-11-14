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

// test/helpers/panel-row.mjs —— 面板 L1 拆分（批 `punky-panel-split-20261114`）后的**真实宿主装配形态**。
//
// 为什么需要它：宿主按 `cordis.patch.yml` 第一条 `- insert:` 列表逐行组合，顺序 = engine 行 → panel 行。
//   拆分把 HTTP **装配体**（`/api` 12 路由 + `/mcp` 入口 A + 发现服务 + `/config` 写通道 + SSE hub）
//   移进了 panel 行 ⇒ **只 apply engine 行的夹具拿不到 `/api` 与 `/mcp`**：core 的 `httpSurface.mount()`
//   会按契约 §S-2.4 步骤 1 **fail-loud**（warn 一次 + 返回 false，`mounted` 保持 null）。
//   ⇒ 任何断言「HTTP 面 / `/mcp` / `GET /config`」的用例必须走本 helper（两行齐备），
//     否则测的是「半装配宿主」，不是现网形态。
//
// ⚠ 入口 B（面板自建 loopback 监听，出厂 `127.0.0.1:3918`）**默认关闭**：
//   ① 现网宿主本身就在 3918 上监听 ⇒ 测试里再 bind 必 `EADDRINUSE`，只会换来一条与被测面无关的 warn，
//     污染「零 warn」类断言；
//   ② 入口 B 的专项判据在 `test/mcp-loopback.test.js`，那里用**随机空闲端口**验证，不需要本 helper 代劳。
//   需要入口 B 的用例显式传 `config.mcp.loopback.enabled === true`（并自选空闲端口）即可恢复。

import { apply as applyEngineRow } from '../../lib/index.js';
import { apply as applyPanelRow } from '../../lib/panel/index.js';

/**
 * 按 patch 列表顺序 apply 两行（engine → panel），返回**逆序**卸载器（panel 先卸、engine 后卸）。
 *
 * @param {object} ctx 宿主上下文
 * @param {object} [config] engine 行的 config（panel 行**不写** `config:` —— 唯一源经 `corePort('config')`，C-4）
 * @returns {() => void} 聚合 disposer（幂等由两行各自的 disposer 保证）
 */
export function applyEngineAndPanel(ctx, config = {}) {
  const loop = config?.mcp?.loopback ?? {};
  const engineConfig = loop.enabled === true
    ? config
    : { ...config, mcp: { ...(config?.mcp ?? {}), loopback: { ...loop, enabled: false } } };
  const disposeEngine = applyEngineRow(ctx, engineConfig);
  const disposePanel = applyPanelRow(ctx, {});
  return () => {
    try { disposePanel(); } finally { if (typeof disposeEngine === 'function') disposeEngine(); }
  };
}
