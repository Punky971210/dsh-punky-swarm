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

// 能力声明面（批 `punky-g1-declare-2026-10-29` · lane `e1-capability`）：
//   把「能力」从**散落的隐式假设**收成一份**可读、可断言、可回显**的声明。
//
// 两类能力（构造注入、**部署期固定**、运行期无提权路径）：
//   · **host**（必需宿主注入）：插件靠 cordis `inject` 声明的宿主服务键。缺一个 ⇒ 插件根本不该被加载，
//     故这里做 **fail-closed**：`assertRequired` 抛错（普通 Error，非拒码），不静默降级。
//   · **internal**（引擎内部能力）：`assembly/schema.js#CAPABILITY_REGISTRY` 的 13 键（aip / acps / identity /
//     discovery / verify / watch / worktree / budget / injectBudget / trajectory / auditlog / logs / topic）。
//     缺（= 显式关闭或未启用）⇒ **不抛**，只进 `report.missing` 供回显与巡检。
//
// **不造第二真源**（本批硬约束）：键集**只从** `CAPABILITY_REGISTRY` **派生**（`CAPABILITY_KEYS`），
//   本文件不复制任何键名字面量清单、不复制判定逻辑（启用判据复用单点读端 `readCapability`）。
//   若将来新增/删除能力键，改注册表即可，本文件零改动。
import { CAPABILITY_REGISTRY, readCapability } from './assembly/schema.js';

/**
 * 必需宿主注入键（与 `lib/index.js` 的 `export const inject` **同一份**，本文件是定义点）。
 *
 * 三键全部**必需**（本批不降级任何宿主键）：`webServer` 保持必需 ⇒ 加载面行为与本批前零差异。
 * 宿主缺任一键时 cordis 不会挂载本插件；`assertRequired` 是「万一挂载了也要立刻炸」的兜底。
 */
export const HOST_INJECTIONS = ['tools', 'webServer', 'subagents'];

/** 内部能力键集：**派生**自 `CAPABILITY_REGISTRY`（禁手抄；顺序即注册表顺序）。 */
export const CAPABILITY_KEYS = CAPABILITY_REGISTRY.map((entry) => entry.key);

/** 宿主键缺失的判定：值在场且非 `null` / `undefined` / `false` 才算装上。 */
function hostInstalled(hostCtx, key) {
  const v = hostCtx?.[key];
  return v !== undefined && v !== null && v !== false;
}

/**
 * 能力快照（**纯函数**，无 I/O、无副作用、不改入参）。
 *
 * @param {object} rt 运行时上下文的最小视图；接受两种形态：
 *   · `{ ctx, config }`（推荐：装配点显式传宿主 ctx 与生效配置）；
 *   · 直接传宿主 ctx 本体（`tools`/`webServer`/`subagents` 在其上，此时 config 缺省 `{}`）。
 * @returns {{host: Array<{key: string, installed: boolean, reason: string|null}>,
 *            internal: Array<{key: string, enabled: boolean, consumers: string[]}>,
 *            missing: string[]}}
 *   `missing` = 必需宿主缺失键 ∪ 内部未启用键（**并集**，供回显与巡检）；
 *   其中**必需宿主缺失**才是 `assertRequired` 的抛错面。
 */
export function capabilityReport(rt = {}) {
  const hostCtx = (rt && typeof rt === 'object' && rt.ctx && typeof rt.ctx === 'object') ? rt.ctx : (rt ?? {});
  const config = (rt && typeof rt === 'object' && rt.config && typeof rt.config === 'object') ? rt.config : {};
  const host = HOST_INJECTIONS.map((key) => {
    const installed = hostInstalled(hostCtx, key);
    return { key, installed, reason: installed ? null : 'missing host injection: ' + key };
  });
  const internal = CAPABILITY_KEYS.map((key, i) => {
    const entry = CAPABILITY_REGISTRY[i] ?? {};
    const resolved = readCapability(config, key);
    return {
      key,
      enabled: resolved?.enabled === true,
      consumers: Array.isArray(entry.consumers) ? [...entry.consumers] : [],
    };
  });
  const missing = [
    ...host.filter((h) => !h.installed).map((h) => h.key),
    ...internal.filter((c) => !c.enabled).map((c) => c.key),
  ];
  return { host, internal, missing };
}

/**
 * 必需能力断言（**fail-closed**）：必需宿主键缺失 ⇒ 抛**普通 `Error`**，不新增拒码。
 *
 * 形态（本批钉死，t1/a1 独立断言）：消息以固定前缀 `capability-missing:` 开头、后接**缺失键名逐个**
 * （例：`capability-missing: webServer`）；**不设 `err.code`**、不以 `GATE_` 开头
 * （拒码集合是契约面，不为能力缺失扩面 —— 同仓先例 `state/store/plan-mutate.js:39-40`）。
 *
 * @returns {true} 必需能力齐备时返回 `true`（调用方可直接断言）。
 */
export function assertRequired(report) {
  const host = Array.isArray(report?.host) ? report.host : [];
  const requiredMissing = host.filter((h) => !h.installed).map((h) => h.key);
  if (requiredMissing.length > 0) {
    throw new Error('capability-missing: ' + requiredMissing.join(','));
  }
  return true;
}
