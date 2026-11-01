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
 * **功能面键**（宿主中立词表）—— J6-d / AC-9b 的落点。
 *
 * 值域与 provider 端口一一对应：`toolSurface`（工具面）/ `httpSurface`（HTTP 面）/ `agentRuntime`（成员执行面）。
 * ⚠ 本常量**不含任何宿主服务名**（`tools` / `webServer` / `subagents`）—— 那三项是**宿主的**名字，
 *   只允许出现在 `lib/provider-dsh/**` 与 provider 的装配行里（`test/g2-ports-contract.test.js` 的泄漏面判据）。
 *
 * 历史：W4 前本处是 `HOST_INJECTIONS = ['tools','webServer','subagents']`，同时充当
 *   ① 引擎插件行的 `inject` 声明源 ② 能力回显表的数据源。W4 把两者**拆开**：
 *   ① 归 `ENGINE_INJECTIONS`（已清空）② 归本常量（改判**端口可用性**，不再读宿主 ctx 属性）。
 */
export const HOST_FACE_KEYS = ['toolSurface', 'httpSurface', 'agentRuntime'];

/**
 * 引擎插件行的 `inject` 声明面：**W4 起为空**（J4'-a）。
 *
 * 为什么可以为空：宿主服务的**唯一声明落点**已迁到 provider 行
 *   （`cordis.patch.yml` 的 `dsh-punky-swarm-provider-dsh` 行 `inject: [tools, webServer, subagents]`）；
 *   引擎侧取得功能一律经**端口读数**（`ports[eFace].available`）与 `ctx.get` 探测，
 *   因而**不再需要**在 inject 里声明宿主依赖，也不会再因宿主缺服务而整块 pending。
 *
 * ⚠ 兼容形态（`p2-deps-compat` / `esm-first-eval` 要求）：`lib/index.js` 必须写成
 *   `export const inject = <单一标识符>;`（禁手写数组字面量）⇒ 本常量就是那个「单一来源标识符」。
 */
export const ENGINE_INJECTIONS = [];

/**
 * **内核端口**键（`KernelPorts` 的必需位）：缺失 ⇒ fail-closed。
 *
 * 与「功能面」是**两个不同的失败语义**：
 *   · 内核端口缺 = **装配缺陷**（引擎自己没装好）⇒ 拒（抛 `capability-missing: <key>`）；
 *   · 功能面缺 = **宿主能力缺**（正常形态之一）⇒ **降级但不静默**（回显 `installed:false` + `reason`，不抛）。
 */
export const KERNEL_KEYS = ['runtime', 'audit'];

/** 内部能力键集：**派生**自 `CAPABILITY_REGISTRY`（禁手抄；顺序即注册表顺序）。 */
export const CAPABILITY_KEYS = CAPABILITY_REGISTRY.map((entry) => entry.key);

/**
 * 单个功能面的探活：**判端口 `available`**，不读宿主 ctx 属性。
 *
 * 三态（**不得混同**）：
 *   · `probed:false` = **未探明**（装配根没传端口实例）——**不是**「未安装」；
 *   · `probed:true, installed:false` = 端口在位但**本宿主拿不到该功能**（正常降级形态）；
 *   · `probed:true, installed:true` = 可用。
 *
 * @returns {{probed: boolean, installed: boolean, reason: string|null}}
 */
function faceProbeOf(ports, faceKey) {
  if (!ports || typeof ports !== 'object') {
    return { probed: false, installed: false, reason: 'unprobed: ports not supplied' };
  }
  const port = ports[faceKey] ?? null;
  if (port == null || typeof port !== 'object') {
    return { probed: true, installed: false, reason: 'port-absent: ' + faceKey };
  }
  const installed = port.available === true;
  return { probed: true, installed, reason: installed ? null : 'face-unavailable: ' + faceKey };
}

/**
 * 能力快照（**纯函数**，无 I/O、无副作用、不改入参）。
 *
 * @param {object} rt 运行时上下文的最小视图：
 *   · `ctx` / `config`（可选，供装配开关面）；
 *   · `ports`（可选）：功能面**端口实例** `{ toolSurface, httpSurface, agentRuntime }` ——
 *     由装配根（`lib/index.js` 的 `apply`）传入；缺省时功能面一律记为**未探明**（不报成缺失）；
 *   · `kernel`（可选）：内核端口在位事实 `{ runtime: boolean, audit: boolean }`；
 *     缺省时记为 `present:null`（未探明）⇒ 不构成拒绝（不可对没探测过的东西 fail-closed）。
 * @returns {{host: Array<{key:string, installed:boolean, probed:boolean, reason:string|null}>,
 *            kernel: Array<{key:string, required:boolean, present:boolean|null}>,
 *            internal: Array<{key:string, enabled:boolean, consumers:string[]}>,
 *            missing: string[], degraded: string[]}}
 *   `degraded` = 功能面不可用（或未探明）的键 —— **降级事实**，供回显与巡检；
 *   `missing`  = `degraded` ∪ 内部未启用键（并集，保持既有回显字段语义；**不再驱动** `assertRequired`）。
 */
export function capabilityReport(rt = {}) {
  const config = (rt && typeof rt === 'object' && rt.config && typeof rt.config === 'object') ? rt.config : {};
  const ports = (rt && typeof rt === 'object' && rt.ports && typeof rt.ports === 'object') ? rt.ports : null;
  const kernelFacts = (rt && typeof rt === 'object' && rt.kernel && typeof rt.kernel === 'object') ? rt.kernel : null;

  const host = HOST_FACE_KEYS.map((key) => {
    const probe = faceProbeOf(ports, key);
    return { key, installed: probe.installed, probed: probe.probed, reason: probe.reason };
  });

  const kernel = KERNEL_KEYS.map((key) => ({
    key,
    required: true,
    // `null` = 未探明（调用方没给事实）⇒ assertRequired 不据此拒绝
    present: kernelFacts && Object.prototype.hasOwnProperty.call(kernelFacts, key)
      ? kernelFacts[key] === true
      : null,
  }));

  const internal = CAPABILITY_KEYS.map((key, i) => {
    const entry = CAPABILITY_REGISTRY[i] ?? {};
    const resolved = readCapability(config, key);
    return {
      key,
      enabled: resolved?.enabled === true,
      consumers: Array.isArray(entry.consumers) ? [...entry.consumers] : [],
    };
  });

  const degraded = host.filter((h) => h.installed !== true).map((h) => h.key);
  const missing = [
    ...degraded,
    ...internal.filter((c) => !c.enabled).map((c) => c.key),
  ];
  return { host, kernel, internal, missing, degraded };
}

/**
 * 必需能力断言（**fail-closed 面 = 内核端口**，不是宿主能力）。
 *
 * W4 语义变更（**这是本批最容易审歪的一条**）：
 *   · **内核端口**（`runtime` / `audit`）缺失 ⇒ 抛（装配缺陷必须当场暴露）；
 *   · **功能面**（`toolSurface` / `httpSurface` / `agentRuntime`）不可用 ⇒ **不抛**（宿主能力差异属正常形态，
 *     由 `capabilityReport().host` / `degraded` 回显 + 调用点 warn 保证**降级但不静默**）。
 *   · `present === null`（未探明）⇒ **不抛**：不可对没有探测过的东西做 fail-closed。
 *
 * 形态不变（既有消费方与用例零破坏）：消息以固定前缀 `capability-missing:` 开头、后接**缺失键名逐个**；
 *   **不设 `err.code`**、不以 `GATE_` 开头。
 *
 * @returns {true} 内核端口齐备（或未探明）时返回 `true`。
 */
export function assertRequired(report) {
  const kernel = Array.isArray(report?.kernel) ? report.kernel : [];
  const missingKernel = kernel.filter((k) => k.present === false).map((k) => k.key);
  if (missingKernel.length > 0) {
    throw new Error('capability-missing: ' + missingKernel.join(','));
  }
  return true;
}
