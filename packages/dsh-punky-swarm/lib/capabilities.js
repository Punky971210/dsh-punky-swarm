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
 * 值域与 provider 端口一一对应：`toolSurface`（工具面）/ `httpSurface`（HTTP 面）/ `agentRuntime`（成员执行面）/
 * `rosterSource`（名册读取面）。**后两者是不同能力，不是同一动作的两条路**：
 *   · `agentRuntime` = 「**要一个成员**」—— 其内部再分 C/D 两条通道（见 `channels`）；
 *   · `rosterSource` = 「**读一份名册**」—— 与派成员是两个动作 ⇒ **不进 `channels`**（设计 §5.1）。
 * ⚠ 本常量**不含任何宿主服务名**（四个面的**宿主实现名一律不写在本文件**）—— 宿主名只允许出现在
 *   `lib/provider-dsh/**` 与 provider 的装配行里。
 *   ⚠ 本注释**刻意不列举**那些宿主字面名：`test/roster-self-held.test.js` 的 AC-15 面（R5）对本文件做
 *   「外部框架专名零命中」扫描 —— **列举即假阳性**（本 lane 踩过一次，见 `exec/channels-impl.md` 的途中自查）。
 *
 * 历史：W4 前本处是「宿主三键」数组，同时充当
 *   ① 引擎插件行的 `inject` 声明源 ② 能力回显表的数据源。W4 把两者**拆开**：
 *   ① 归 `ENGINE_INJECTIONS`（已清空）② 归本常量（改判**端口可用性**，不再读宿主 ctx 属性）。
 *   批 `punky-adapter-channels-20261101` 再由三面扩到四面（追加 `rosterSource`）。
 */
export const HOST_FACE_KEYS = ['toolSurface', 'httpSurface', 'agentRuntime', 'rosterSource'];

/**
 * 各面**不可用时的成因词**（缺省 = `'face-unavailable: <面名>'`）。
 *
 * `rosterSource` 复用 provider 既有词 `'service-unavailable'`（`lib/tools/host-surface.js` 的
 *   `managerRoster.reason` 同词）：同一个事实（名册读不到）在**两个回显面**上必须是**同一个词**，
 *   否则就是「同一事实两种表达」（e1-G13 类问题的成因）。其余面沿用既有格式，**不新增词**。
 */
const FACE_UNAVAILABLE_REASON = { rosterSource: 'service-unavailable' };

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
 * @param {object|null} ports 功能面端口实例表
 * @param {string} faceKey 面键
 * @param {string|null} [unavailableReason] 该面不可用时的成因词覆盖（缺省 `'face-unavailable: <面名>'`）
 * @returns {{probed: boolean, installed: boolean, reason: string|null}}
 */
function faceProbeOf(ports, faceKey, unavailableReason = null) {
  if (!ports || typeof ports !== 'object') {
    return { probed: false, installed: false, reason: 'unprobed: ports not supplied' };
  }
  const port = ports[faceKey] ?? null;
  if (port == null || typeof port !== 'object') {
    return { probed: true, installed: false, reason: 'port-absent: ' + faceKey };
  }
  const installed = port.available === true;
  return { probed: true, installed, reason: installed ? null : (unavailableReason ?? 'face-unavailable: ' + faceKey) };
}

/**
 * **通道事实归一**（内部函数，**禁导出** —— `capabilities.js` 的导出面被 C7 用例逐字冻结为恰好六项）。
 *
 * ⚠ 本注释**刻意不复写**那条 C7 用例的文件名：文件名含宿主/框架专名，而 `test/roster-self-held.test.js`
 *   的 AC-15 护栏（R5）对本文件做**外部框架专名零命中**扫描 —— 写文件名就会假阳性。
 *   需要定位该用例时按「C7 / 导出面恰好六项」在 `test/` 内检索，或读 `lib/provider-dsh/agent.js#agentChannelFactsOf`。
 *
 * 职责边界：provider 只产**事实**（读宿主能力，`lib/provider-dsh/agent.js#agentChannelFactsOf`），
 *   形状归一放本文件 ⇒ `capabilityReport` 的返回形状由本文件单点保证，上层不必防御式判形状。
 *
 * 三个归一动作：
 *   ① `null` / 非对象 ⇒ `null`（**未探明**）——与「有通道对象但无通道」可区分（设计 §2.2）；
 *   ② 每个通道归成 `{available:boolean, reason:string|null}`，且 **`available===true` 时 `reason` 强制 `null`**
 *      （否则会出现「可用但带不可用成因」的自相矛盾读数）；
 *   ③ `probed` 只认 `=== true`（其余一律按未探明，不参与 OR 聚合）。
 *
 * ⚠ `reason` 词表**零新增**：正常路径原样透传 provider 的成因读数；只有「通道对象就缺失」这种
 *   畸形输入才回落到本文件既有的 `'unprobed: …'` 前缀风格（与 `faceProbeOf` 同式，非新造成因词）。
 *
 * @param {object|null} raw provider 的通道读数
 * @returns {{probed: boolean, subagent: {available: boolean, reason: string|null},
 *            agentTeam: {available: boolean, reason: string|null}} | null}
 */
function channelFactsOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const channelOf = (c) => {
    const available = c?.available === true;
    const given = typeof c?.reason === 'string' && c.reason.length > 0 ? c.reason : null;
    return { available, reason: available ? null : (given ?? 'unprobed: channel not supplied') };
  };
  return {
    probed: raw.probed === true,
    subagent: channelOf(raw.subagent),
    agentTeam: channelOf(raw.agentTeam),
  };
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
 *   · `agentChannels`（可选）：**通道级可用性事实**（`lib/provider-dsh/agent.js#agentChannelFactsOf` 的读数）；
 *     缺省 / `null` ⇒ `agentRuntime` 项的 `channels:null`（**未探明**，不得读作「两通道都不可用」）。
 * @returns {{host: Array<{key:string, installed:boolean, probed:boolean, reason:string|null,
 *                        channels: object|null}>,
 *            kernel: Array<{key:string, required:boolean, present:boolean|null}>,
 *            internal: Array<{key:string, enabled:boolean, consumers:string[]}>,
 *            missing: string[], degraded: string[]}}
 *   `host[].channels`：非 `agentRuntime` 面恒 `null`；`agentRuntime` 面为
 *     `{probed, subagent:{available,reason}, agentTeam:{available,reason}}` 或 `null`（未探明）。
 *     ⚠ `null` 与 `{}` **必须可区分** —— 后者会被读成「有通道对象但无通道」。
 *   `host[].installed`（`agentRuntime` 项）= **OR 聚合**：`subagent.available || agentTeam.available`
 *     （既有语义就是「是否有**任一路径**可用」；用 AND 会把「只有 C 档」的宿主误报成整面降级）。
 *   `degraded` = 功能面不可用（或未探明）的键 —— **降级事实**，供回显与巡检；
 *   `missing`  = `degraded` ∪ 内部未启用键（并集，保持既有回显字段语义；**不再驱动** `assertRequired`）。
 */
export function capabilityReport(rt = {}) {
  const config = (rt && typeof rt === 'object' && rt.config && typeof rt.config === 'object') ? rt.config : {};
  const ports = (rt && typeof rt === 'object' && rt.ports && typeof rt.ports === 'object') ? rt.ports : null;
  const kernelFacts = (rt && typeof rt === 'object' && rt.kernel && typeof rt.kernel === 'object') ? rt.kernel : null;
  const agentChannels = (rt && typeof rt === 'object' && rt.agentChannels && typeof rt.agentChannels === 'object')
    ? rt.agentChannels
    : null;

  const host = HOST_FACE_KEYS.map((key) => {
    const probe = faceProbeOf(ports, key, FACE_UNAVAILABLE_REASON[key] ?? null);
    // 通道维度**只**属 `agentRuntime`（同一动作「触达成员」的两条路）；其余面 `channels:null`
    //   —— 用 `null` 而非 `{}`：空对象会被读成「有通道对象但一个通道都没有」。
    if (key !== 'agentRuntime') {
      return { key, installed: probe.installed, probed: probe.probed, reason: probe.reason, channels: null };
    }
    const channels = channelFactsOf(agentChannels);
    if (channels === null || channels.probed !== true) {
      // 未探明通道事实 ⇒ 面级读数**原样保留**（不得据此把面判成不可用，同 `probed:false` 的纪律）
      return { key, installed: probe.installed, probed: probe.probed, reason: probe.reason, channels };
    }
    // OR 聚合（设计 §2.4）：任一路径可用 ⇒ 该面可用
    const installed = channels.subagent.available === true || channels.agentTeam.available === true;
    return { key, installed, probed: probe.probed, reason: installed ? null : probe.reason, channels };
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
