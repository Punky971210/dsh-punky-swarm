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


import { CAPABILITY_REGISTRY, readCapability } from './assembly/schema.js';

export const HOST_FACE_KEYS = ['toolSurface', 'httpSurface', 'agentRuntime', 'rosterSource'];

/**
 * 各面**`available:false` 时的成因词**覆盖（缺省 = `'face-unavailable: <面名>'`）。
 *
 * **Q-E=乙 后本表为空**：原先 `rosterSource` 复用 `'service-unavailable'`（因为那时它探宿主团队服务）；
 *   现在该面判**自建表就绪**（`lib/tools/host-surface.js#rosterTableReadyOf`），成因由端口自己给
 *   （`'roster-table-unwired: …'`），端口成因**优先** ⇒ 此覆盖不再需要，留空表作为将来的扩展位。
 */
const FACE_UNAVAILABLE_REASON = {};

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
 *   · 功能面缺 = **宿主能力缺**（正常形态之一）⇒ **不抛**（回显 `available:false` + `reason`）。
 */
export const KERNEL_KEYS = ['runtime', 'audit'];

/** 内部能力键集：**派生**自 `CAPABILITY_REGISTRY`（禁手抄；顺序即注册表顺序）。 */
export const CAPABILITY_KEYS = CAPABILITY_REGISTRY.map((entry) => entry.key);

/**
 * 单个功能面的探活：**判端口 `available`**，不读宿主 ctx 属性。
 *
 * **`available` 三态**（批 `punky-arch-refine-20261101` · Q-E=乙「废除降级」后的唯一可用性位）：
 *   · `available: true`  = **功能在**（该面可发起动作）；
 *   · `available: false` = **面没装** —— 词表内有该面，但**装配根没给出端口实例**（`port-absent:`），
 *     或端口在位而自报不可用（端口给的成因词）；
 *   · `available: null`  = **未探明** —— 装配根**根本没传 `ports`**（`unprobed:`）。
 *     ⚠ **绝不并成 `false`**：那会把「没探到」伪装成「没有」= 新的静默缺陷。
 *
 * ⇒ **没有「半可用」中间态**（`degraded` 已废除）：有就是有，没有就是没有，不知道就是不知道。
 *
 * @param {object|null} ports 功能面端口实例表
 * @param {string} faceKey 面键
 * @param {string|null} [unavailableReason] 该面 `false` 时的成因词覆盖（缺省 `'face-unavailable: <面名>'`）
 * @returns {{probed: boolean, available: boolean|null, reason: string|null}}
 */
function faceProbeOf(ports, faceKey, unavailableReason = null) {
  if (!ports || typeof ports !== 'object') {
    return { probed: false, available: null, reason: 'unprobed: ports not supplied' };
  }
  const port = ports[faceKey] ?? null;
  if (port == null || typeof port !== 'object') {
    return { probed: true, available: false, reason: 'port-absent: ' + faceKey };
  }
  if (port.available === true) return { probed: true, available: true, reason: null };
  if (port.available === false) {
    // 端口自己报的成因**优先**（它最知道为什么拿不到）；没给才回落到面级缺省词。
    const given = typeof port.reason === 'string' && port.reason.length > 0 ? port.reason : null;
    return { probed: true, available: false, reason: given ?? (unavailableReason ?? ('face-unavailable: ' + faceKey)) };
  }
  // 端口在位但**没有给出可判读的 available**（不是 true / 不是 false）⇒ 未探明，不得当 false
  return { probed: false, available: null, reason: 'unprobed: port availability not supplied' };
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
 *   ② 每个通道归成 `{available: boolean|null, reason: string|null}`，**`available` 三态**（Q-E=乙）：
 *      `true` = 该通道功能在｜`false` = 面没装（`port-absent:` 或 provider 给的成因）｜`null` = 未探明。
 *      且 **`available===true` 时 `reason` 强制 `null`**（否则出现「可用但带不可用成因」的自相矛盾读数）；
 *   ③ `probed` 只认 `=== true`（其余一律按未探明，不参与 OR 聚合）。
 *
 * ⚠ **`available` 里没有第四种取值**：层设计 §③B 明确「『能发起但不能确认』不属能力位」——
 *   那是**调用结果**（`ExecResult.errorCode:'PUSH_UNCONFIRMED'`），不抬成 per-capability 读数。
 *
 * ⚠ `reason` 词表**零新增**：正常路径原样透传 provider 的成因读数；只有「通道对象就缺失」这种
 *   畸形输入才回落到本文件既有的 `'unprobed: …'` / `'port-absent: …'` 前缀风格（与 `faceProbeOf` 同式）。
 *
 * @param {object|null} raw provider 的通道读数
 * @returns {{probed: boolean, subagent: {available: boolean|null, reason: string|null},
 *            agentTeam: {available: boolean|null, reason: string|null}} | null}
 */
function channelFactsOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const channelOf = (c, channelName) => {
    if (!c || typeof c !== 'object') {
      return { available: false, reason: 'port-absent: ' + channelName };
    }
    const given = typeof c.reason === 'string' && c.reason.length > 0 ? c.reason : null;
    if (c.available === true) return { available: true, reason: null };
    if (c.available === false) return { available: false, reason: given ?? ('face-unavailable: ' + channelName) };
    // 通道对象在位但没给出可判读的 available ⇒ 未探明，不得并成 false
    return { available: null, reason: 'unprobed: channel availability not supplied' };
  };
  return {
    probed: raw.probed === true,
    subagent: channelOf(raw.subagent, 'subagent'),
    agentTeam: channelOf(raw.agentTeam, 'agentTeam'),
  };
}

/**
 * 能力快照（**纯函数**，无 I/O、无副作用、不改入参）。
 *
 * @param {object} rt 运行时上下文的最小视图：
 *   · `ctx` / `config`（可选，供装配开关面）；
 *   · `ports`（可选）：功能面**端口实例** `{ toolSurface, httpSurface, agentRuntime, rosterSource }` ——
 *     由装配根（`lib/index.js` 的 `apply`）传入；缺省时功能面一律记为**未探明**（`available:null`，不报成缺失）；
 *   · `kernel`（可选）：内核端口在位事实 `{ runtime: boolean, audit: boolean }`；
 *     缺省时记为 `present:null`（未探明）⇒ 不构成拒绝（不可对没探测过的东西 fail-closed）。
 *   · `agentChannels`（可选）：**通道级可用性事实**（`lib/provider-dsh/agent.js#agentChannelFactsOf` 的读数）；
 *     缺省 / `null` ⇒ `agentRuntime` 项的 `channels:null`（**未探明**，不得读作「两通道都不可用」）。
 * @returns {{host: Array<{key:string, available:boolean|null, reason:string|null, channels: object|null}>,
 *            kernel: Array<{key:string, required:boolean, present:boolean|null}>,
 *            internal: Array<{key:string, enabled:boolean, consumers:string[]}>,
 *            unavailable: string[], disabled: string[]}}
 *   **`host[]` 每项键集恰为 `{key, available, reason, channels}`**（Q-E=乙：可用性只有一个位）。
 *   · `available` **三态**：`true` 功能在｜`false` 面没装｜`null` 未探明（**绝不并成 `false`**）。
 *   · **面本身不存在**（不在 `HOST_FACE_KEYS`）⇒ **本数组里没有这一项**（不是 `available:false`）。
 *   · `channels`：非 `agentRuntime` 面恒 `null`；`agentRuntime` 面为
 *     `{probed, subagent:{available,reason}, agentTeam:{available,reason}}` 或 `null`（未探明）。
 *     ⚠ `null` 与 `{}` **必须可区分** —— 后者会被读成「有通道对象但无通道」。
 *     通道的 `available` 同为**三态**（层设计 §③A）：`true` 功能在｜`false` 面没装｜`null` 未探明。
 *   · `agentRuntime.available` = 通道的 **OR 聚合（三态）**：任一 `true` ⇒ `true`；两通道都 `false` ⇒ `false`；
 *     有任一 `null` ⇒ `null`（未探明不冒充「没有」）。
 *   · `unavailable` = 我方面 **`available === false`** 的键（**不含** `null`：未探明不是不可用）；
 *   · `disabled`   = 内部能力未启用键（**策略停用**，与「能力不可用」语义分开，禁再并成一个数组）。
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
      return { key, available: probe.available, reason: probe.reason, channels: null };
    }
    const channels = channelFactsOf(agentChannels);
    if (channels === null || channels.probed !== true) {
      // 未探明通道事实 ⇒ 面级读数**原样保留**（不得据此把面判成不可用，同 `available:null` 的纪律）
      return { key, available: probe.available, reason: probe.reason, channels };
    }
    // OR 聚合（三态，Q-E=乙）：任一通道 `true` ⇒ 面在；两通道都 `false` ⇒ 面没装；
    //   只要有一个 `null`（未探明）⇒ 面 `null` —— **未探明不冒充「没有」**。
    const sub = channels.subagent.available;
    const team = channels.agentTeam.available;
    let available;
    if (sub === true || team === true) available = true;
    else if (sub === false && team === false) available = false;
    else available = null;
    const reason = available === true
      ? null
      : (available === null ? 'unprobed: channels partially probed' : probe.reason);
    return { key, available, reason, channels };
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

  const unavailable = host.filter((h) => h.available === false).map((h) => h.key);
  const disabled = internal.filter((c) => !c.enabled).map((c) => c.key);
  return { host, kernel, internal, unavailable, disabled };
}

/**
 * 必需能力断言（**fail-closed 面 = 内核端口**，不是宿主能力）。
 *
 * W4 语义变更（**这是本批最容易审歪的一条**）：
 *   · **内核端口**（`runtime` / `audit`）缺失 ⇒ 抛（装配缺陷必须当场暴露）；
 *   · **功能面**（清单以 `HOST_FACE_KEYS` 为准，**不在此重列**）不可用 ⇒ **不抛**（宿主能力差异属正常形态，
 *     由 `capabilityReport().host` / `unavailable` 回显 + 调用点 warn 保证**降级但不静默**）。
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
