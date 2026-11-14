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

// test/helpers/panel-row.mjs —— **真实宿主装配形态**（宿主按 `cordis.patch.yml` 第一条 `- insert:` 列表逐行组合）。
//
// 两次 L1 拆分把本 helper 从「两行」推到「三行」，而三行**行序是契约**：
//
//   ① `dsh-punky-guard`（判据源 `plan/guard-split-spec.md` §S-2.4 / C-1）
//      —— core 在装配期（`installGovernanceSurface`）**同步**消费 `corePort('guard')`；端口晚一步就位，
//      core 只能走「端口缺席 ⇒ 零拦截」降级路 = **漏拦**，而写反不报错、只多一条 warn。
//      ⇒ 护栏行**必须**排在引擎行**之前**（与面板行相反）。
//   ② `dsh-punky-swarm`（引擎行）
//   ③ `dsh-punky-panel`（判据源 `plan/panel-split-spec.md` §S-2.4）
//      —— HTTP **装配体**（`/api` 12 路由 + `/mcp` 入口 A + 发现服务 + `/config` 写通道 + SSE hub）在 panel 行；
//      只 apply 引擎行的夹具拿不到 `/api` 与 `/mcp`，core 的 `httpSurface.mount()` 会 fail-loud
//      （warn 一次 + 返回 false，`mounted` 保持 null）⇒ 面板行**必须**排在引擎行**之后**。
//
// 为什么必须走本 helper（不是「两行/三行都能跑」的口味问题）：
//   · 缺护栏行 ⇒ 引擎行装配期打一条 `guard 行缺席 ⇒ 工具护栏未装配` warn，且 `tools/pre-execute` 零 governance
//     订阅者 ⇒ 任何「治理拦截 / 拒绝收据 / preCount」断言都会**红在语义而不在语法**（K-4 静默红）；
//     任何「零 warn」断言会因那条 warn 直接红。
//   · 缺面板行 ⇒ 任何断言「HTTP 面 / `/mcp` / `GET /config`」的用例测的是「半装配宿主」，不是现网形态。
//   ⇒ 断言治理 / HTTP / 面板面的用例**一律走本 helper**。
//
// ⚠ 入口 B（面板自建 loopback 监听，出厂 `127.0.0.1:3918`）**默认关闭**：
//   ① 现网宿主本身就在 3918 上监听 ⇒ 测试里再 bind 必 `EADDRINUSE`，只会换来一条与被测面无关的 warn，
//      污染「零 warn」类断言；
//   ② 入口 B 的专项判据在 `test/mcp-loopback.test.js`，那里用**随机空闲端口**验证，不需要本 helper 代劳。
//   需要入口 B 的用例显式传 `config.mcp.loopback.enabled === true`（并自选空闲端口）即可恢复。

import { apply as applyGuardRow } from '../../lib/guard/index.js';
import { apply as applyEngineRow } from '../../lib/index.js';
import { apply as applyPanelRow } from '../../lib/panel/index.js';

/**
 * 按 patch 列表顺序 apply **三行**（guard → engine → panel），返回**逆序**卸载器（panel → engine → guard）。
 *
 * @param {object} ctx 宿主上下文
 * @param {object} [config] engine 行的 config
 *   （护栏行与面板行**都不写** `config:` —— 唯一源经 `corePort('config')` / `mount()` 入参，C-4 / N-12）
 * @returns {() => void} 聚合 disposer（幂等由三行各自的 disposer 保证）
 */
export function applyPatchRows(ctx, config = {}) {
  const loop = config?.mcp?.loopback ?? {};
  const engineConfig = loop.enabled === true
    ? config
    : { ...config, mcp: { ...(config?.mcp ?? {}), loopback: { ...loop, enabled: false } } };
  const disposeGuard = applyGuardRow(ctx, {});
  const disposeEngine = applyEngineRow(ctx, engineConfig);
  const disposePanel = applyPanelRow(ctx, {});
  return () => {
    try {
      disposePanel();
    } finally {
      try {
        if (typeof disposeEngine === 'function') disposeEngine();
      } finally {
        if (typeof disposeGuard === 'function') disposeGuard();
      }
    }
  };
}

/**
 * 旧名（8 个既有用例按此名导入）—— **语义已是三行全装配**，等价于 `applyPatchRows`。
 * 保留别名而非改名：改名只换来 8 个文件的机械 diff，不改变任何判据（「只碰必须碰的」）。
 */
export const applyEngineAndPanel = applyPatchRows;
