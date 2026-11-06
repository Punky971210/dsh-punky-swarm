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

// 宿主端口面 · **成员执行面（agentRuntime）**：把「我们怎么要一个成员」收成**具名语义**端口。
//
// 设计纲（用户裁定）：引擎只管问适配器要功能；宿主差异全部关在适配层内。
//   ⇒ 本文件是 `ctx.subagents` 的**唯一**合法消费面（引擎侧不得再 `typeof rt.startActivation === 'function'` 自己判形态）。
//
// 契约取证（**禁凭文档猜**；以下为实测来源）：
//   `D:/DSH/kernel/0.2.1-rc.2/node_modules/@deepseek-ai/dsh-subagent/lib/types/types.d.ts`
//   · `:25-36`  `SubagentActivationSpec = { provider, label, childId?, request: Omit<SubagentStartRequest,'label'|'signal'>, signal, delivery }`
//   · `:115-122` `SubagentCapabilities = { agentOptions, agentPreset, outputSchema, depthLimit }`
//                ⇒ **没有 `toolFilter`、没有 `persona`**（persona 只能经 `agentPreset` 组 composition）
//   · `:168-173` `SubagentStartRequest.maxDepth?: number` ⇒ **`maxDepth` 在 activation 形态里原生可用**
//                （`request` 是 `Omit<SubagentStartRequest,'label'|'signal'>` ⇒ 含 `maxDepth`）
//
// ⇒ 两种形态的能力差异（本端口的**判定依据**，不是印象）：
//   | 能力 | `start(provider, request)` | `startActivation(spec)` |
//   |---|---|---|
//   | 按次收窄工具面（`toolFilter`） | ✅ `request.toolFilter` | ❌ 无此字段 ⇒ **只能经 `agentPreset`** |
//   | 人格（`persona`）                | ✅ `request.persona`   | ❌ 无此名 ⇒ **只能经 `agentPreset`** |
//   | 委派深度（`maxDepth`）           | ✅ `request.maxDepth`  | ✅ `request.maxDepth`（原生可用，受 `capabilities.depthLimit` 约束） |

// 【W4 批 `w4-inject-teardown`】宿主服务取值一律走 `serviceOf`（裸读优先 + `ctx.get` 回落），
//   不再在本文件裸读 `ctx.subagents` —— 引擎行清空 `inject` 后，未声明的 ctx 上裸读**会抛**
//   （活体实证见 `exec/inject-teardown.md` 的宿主级 RED→GREEN）。
// 【批 `punky-engine-fix-20261106` · lane `e1-fix-b1` · B1-S1】追加 `createToolsPort`：
//   D 档内省必须走**端口** `probeTool`（宿主演具面没有该方法，见 `agentTeamChannelOf` 注释）。
//   本行已从 `./tools-http.js` 导入两个符号 ⇒ **不新增模块依赖边**。
import { serviceOf, HOST_PORT_QUERY_FAILED, createToolsPort } from './tools-http.js';
// 【ly-impl】D 通道成功判据的第二腿 = 名册反查（复用 provider 自己的名册面，禁第二套探测）。
import { createRosterPort } from './roster.js';

export const HOST_PORT_UNSUPPORTED = 'host-port-unsupported:';

/** 形态判别（**端口内部单点**；引擎侧不得重复判）。判序固定：新形态优先（宿主若两入口并存，产物面按新形态）。 */
function formOf(rt) {
  if (!rt || typeof rt !== 'object') return null;
  if (typeof rt.startActivation === 'function') return 'activation';
  if (typeof rt.start === 'function') return 'start';
  return null;
}

/**
 * **C 档通道读数**（一次性 Subagent / `lane_dispatch`）—— **单点**。
 *
 * 为什么抽出来（批 `punky-adapter-channels-20261101` · lane `ch-impl`）：
 *   端口自身的 `available`/`reason` 与上报给引擎的 `channels.subagent` 必须是**同一个判定**。
 *   若两处各判一次，就会出现「面说可用、通道说不可用」的读数分歧 —— 而那正是本批要消灭的东西。
 *   判序与原实现逐条等价（零语义增删）：
 *     ① 取不到宿主服务（含 cordis 注入守卫抛错，`serviceOf` 已吞）⇒ `runtime-unavailable`
 *     ② 服务在位但两种启动入口都不可调用                                ⇒ `no-start-entry`
 *
 * @param {object|null} rt `serviceOf(ctx,'subagents')` 的读数
 * @returns {{available: boolean, reason: string|null}}
 */
function subagentChannelOf(rt) {
  const form = formOf(rt);
  if (form !== null) return { available: true, reason: null };
  return { available: false, reason: rt ? 'no-start-entry' : 'runtime-unavailable' };
}

/**
 * **通道级可用性读数**（C 档 / D 档分开报）—— 批 `punky-adapter-channels-20261101` 的 H3 落点。
 *
 * 用户裁决：能力面是**一个**（`agentRuntime` 不拆），但引擎调用走**两条不同通道**，
 *   适配器必须**分别**报「该通道能否用」。两通道的物理基础本就是两个不同宿主能力：
 *   · **C 档** = 一次性 Subagent（`execute` / `lane_dispatch`）⇒ 依赖宿主 `subagents` 服务；
 *   · **D 档** = agentTeams 唤醒（`notifyLeader` / `spawn_teammate`）⇒ 依赖宿主 `agents` 服务。
 *   ⇒ 「缺 C 档」与「缺 D 档」是**两件不同的事**，用一个布尔概括会把另一档的缺失变不可见。
 *
 * `reason` **词表零新增**（复用既有成因读数）：
 *   · C 档：`runtime-unavailable` / `no-start-entry`（与本端口 `available` 同源，见 `subagentChannelOf`）；
 *   · D 档：`agent-runtime-unavailable`（与 `notifyLeader` 的守卫**逐字同词同判据**，见本文件 `notifyLeader`）。
 *
 * ⚠ **不放 `lib/capabilities.js`**：该文件的导出面被 `test/no-agentTeams-batch.test.js`（C7）逐字冻结为**恰好六项**
 *   ⇒ 通道事实函数放 provider 侧是硬约束，不是偏好（设计 §3.2）。
 *
 * @param {object} ctx 宿主上下文
 * @returns {{probed: boolean, subagent: {available: boolean, reason: string|null},
 *            agentTeam: {available: boolean, reason: string|null}}}
 *   `probed:true` = 本次已实际探过（本函数只在**能读**时被调用；未读到时上层给 `channels:null`）。
 */
/**
 * D 档（agentTeams）可用性**单点**（批 `punky-ring1-oraggregate-20261102` 抽出）。
 *
 * ## 为什么抽出来
 * 报告面 `channels.agentTeam` 与端口门禁面 `available` 原先**各算一份 D 档**（两处同构代码）
 * ⇒ 修一处不修另一处必然复发（环 1 就是「报告面 OR 聚合、门禁面只取 C 档」的口径分裂造成的）。
 * 现在两处都调本函数 ⇒ 同一读数只实现一次。
 *
 * ## 判据（与 `ly-impl` 的 D 档判据源切换一致，语义零改）
 * D 档派发不经 `agents`（它只有 get+followup），而是「引擎经**工具面**调 `spawn_teammate`」
 * ⇒ 可用性按**能不能发起派发**判：**工具面在 ∧ `execute` 可调**；可内省时再用 `probeTool`
 * 排除明确的 `absent`。
 * ⚠ 探测**抛错**不得当成「面没装」（那是探测坏，不是能力缺）⇒ 保持 `dUsable` 不变。
 * 成因词 `port-absent:agentTeam`（与 `dg-impl` 的三态归一 / `WIRED_ISSUE_RE` 合流）。
 *
 * ## 【批 `punky-engine-fix-20261106` · lane `e1-fix-b1` · B-1 = Q-F 甲】内省改读**端口**
 *
 * 修前的排除支是 `typeof serviceOf(ctx,'tools').probeTool === 'function'` —— **恒假**：
 * `serviceOf(ctx,'tools')` 取到的是**宿主** `ToolRuntime`（公开面只有
 * `register / restrict / get / schemas / guard / execute`），`probeTool` 是**我方端口**方法
 * （`tools-http.js:106`，`createToolsPort(ctx)` 的产物）⇒ 排除支**结构性不可达**
 * ⇒ `spawn_teammate` 被剔除时仍报 `{available:true, reason:null}` = **fail-open**。
 *
 * ⇒ 改从端口取（`createToolsPort(ctx).probeTool(...)`），**不自建第二套探测判据**：
 * 端口是**三态**（`present` / `absent` / `errored`），且其 `:107` 已处理「宿主 `get` 不存在」这一路；
 * 直调 `toolFace.get(...)` 会把 `errored` 与 `absent` 揉成一个 `null` ⇒ 等于在 `agent.js` 里
 * 再写一遍探测判定（本仓禁「第二套判据」）。
 *
 * 三/四态语义（**不得合并**）：
 *   · `present` ⇒ 可用（工具在位）；
 *   · `absent` 且 `reason !== 'port-unavailable'` ⇒ **不可用**（**明确的**「没有」）；
 *   · `absent` 且 `reason === 'port-unavailable'` ⇒ **保持可用**（**不可内省 ≠ 不存在**：
 *     `tools-http.js:107` 用 `state:'absent'` 承载「宿主 `tools` 没有 `get`、拿不到内省能力」，
 *     那是「**不能检查**」，不是「确认不存在」——判成不可用就是把读不到证据读成反面结论）；
 *   · `errored` ⇒ **保持可用**（探测坏 ≠ 面没装）。
 *
 * ⚠ 批 `punky-engine-fix2-20261106` · lane `e1-red` · D-1=甲 订正：本段原写「`absent` ⇒ 不可用
 * （明确的「没有」，**含**「拿不到内省能力」= `port-unavailable`）」，与该文件 `tools-http.js:102`
 * 的「⚠ 查询失败**不得**降级为「不存在」」直接相反（自述与实现相反，按 D-8 口径改自述/判据）。
 * 改后本函数**不再声称**对 `port-unavailable` 做过 absent 排除 —— 没证据就不宣称，但也不据此判死。
 *
 * ⚠ 真实宿主的 `ToolRuntime` 恒有 `get`（公开面 `register/restrict/get/schemas/guard/execute`）
 * ⇒ `port-unavailable` 该档只在畸形夹具里可达，生产读数不受影响。
 *
 * @returns {{available: boolean, reason: string|null}} **二态 boolean**（端口契约要求，见 `ports.ts`）
 */
function agentTeamChannelOf(ctx) {
  const toolFace = serviceOf(ctx, 'tools');
  let dUsable = Boolean(toolFace) && typeof toolFace.execute === 'function';
  if (dUsable) {
    try {
      const p = createToolsPort(ctx).probeTool('spawn_teammate');
      // 只有**明确的**「不存在」才判不可用：`port-unavailable`（宿主 `tools` 无 `get` 可内省，
      //   见 `tools-http.js:107`）是「**不能检查**」而不是「确认不存在」⇒ 保持可用（不声称已做排除）。
      if (p && p.state === 'absent' && p.reason !== 'port-unavailable') dUsable = false;
    } catch { /* 探测坏 ≠ 面没装：保持 dUsable 不变（禁把故障读成能力缺失） */ }
  }
  return dUsable
    ? { available: true, reason: null }
    : { available: false, reason: 'port-absent:agentTeam' };
}

export function agentChannelFactsOf(ctx) {
  const subagent = subagentChannelOf(serviceOf(ctx, 'subagents'));
  // D 档读数走**单点** `agentTeamChannelOf`（与 `createAgentPort` 的门禁面共用同一实现）。
  const agentTeam = agentTeamChannelOf(ctx);
  return { probed: true, subagent, agentTeam };
}

/**
 * 成员执行端口。
 *
 * @param {object} ctx      宿主上下文（只读 `ctx.subagents`）
 * @param {object} [opts]
 * @param {object} [opts.capabilities] 宿主能力位快照（缺省尝试 `ctx.subagents.capabilities`；取不到按「未知」处理）
 * @param {(args: object) => string|null} [opts.presetFor]
 *        **activation 形态的收窄解析器**：给定 `{ role, toolFace, persona }` 返回 `agentPreset` 名（或 null）。
 *        这是「toolFace/persona 经 preset 生效」的**唯一来源**；解析不到 ⇒ 端口**拒**（`host-port-unsupported:`），
 *        **禁静默当成已收窄**（那正是本批要消灭的「以弱换强」）。
 * @param {'parent'|'caller'} [opts.delivery] activation 的交付策略（缺省 `'parent'`：结果回父会话）
 */
export function createAgentPort(ctx, opts = {}) {
  // 【W3-S2 · 批 `punky-adapter-split-20261031` · lane `w3-engine-entry`】不可用**成因**由本端口给出。
  //
  // 动机（J6-e 的**精确形态**）：引擎**可以**因「功能拿不到」而拒/降级，**不可以**因「宿主长什么样」而判。
  //   ⇒ 成因判定从引擎（原 `subagentRuntimeProbeOf`）**搬进 provider**，引擎只读**功能面读数**。
  //   这是**搬迁**：判定序与原探针逐条等价，语义零增删：
  //     ① 取值抛错（cordis 注入守卫）/ 取不到服务 ⇒ `'runtime-unavailable'`
  //     ② 服务在位但两种入口都不可调用           ⇒ `'no-start-entry'`
  //   ⚠ `reason` 是**功能面**语义（"拿不到什么"），**不是**宿主形态值；
  //     「是哪一形态」由内部 `form` 承载，仍**不外泄**（AC-5″）。
  const rt = serviceOf(ctx, 'subagents'); // 裸读优先 + `ctx.get` 回落（W4：不依赖 inject 声明）
  // C 档读数走**单点**（`subagentChannelOf`）：端口 `available` 与 `channels.subagent.available`
  //   若各判一次就会分歧 —— 那正是本批要消灭的读数不一致（见该函数注释）。
  const subagentChannel = subagentChannelOf(rt);
  const form = formOf(rt);
  // 【环 1 · 批 `punky-ring1-oraggregate-20261102`】**OR 聚合**（任一通道可发起派发 ⇒ 面可用）。
  //   与报告面 `capabilities.js` 同口径（「任一通道 true ⇒ 面在」）；D 档读数走单点 `agentTeamChannelOf`。
  //   ⚠ `available` **保持 boolean 二态**（`ports.ts` 三处契约 + `subagentChannelOf` 的 @returns）；
  //     「未探明」由**报告面** `channels: null` 表达，端口层 `false` = 不能派（fail-closed 正确）。
  const agentTeamChannel = agentTeamChannelOf(ctx);
  const available = subagentChannel.available === true || agentTeamChannel.available === true;
  /** 不可用成因（功能面；`available===true` 时恒 `null`）。 */
  //   口径（对齐 `capabilities.js` 的 `available===true ⇒ reason=null`）：
  //   · C 不可但 D 可用 ⇒ `null`（面可用则无面级成因；**D 档成因不进面级 reason** —— 面级是单值字符串，
  //     装不下两档；想知道缺哪档请读 `agentChannelFactsOf().channels`）；
  //   · 两档都不可 ⇒ 报 **C 档成因**（主派发通道）；
  //   · **禁造 `'c:…;d:…'` 复合串**（会破坏既有 reason 消费方）。
  const reason = available === true ? null : subagentChannel.reason;
  const caps = opts.capabilities ?? (rt && typeof rt === 'object' ? rt.capabilities : undefined) ?? null;
  const capsKnown = caps !== null && typeof caps === 'object' && Object.keys(caps).length > 0;
  const presetFor = typeof opts.presetFor === 'function' ? opts.presetFor : () => null;
  const delivery = opts.delivery === 'caller' ? 'caller' : 'parent';

  // ── 收窄见证（**单点**：`narrowVia` / `canNarrow` / `spawn` 三处共用，禁各自判）─────────────
  //
  // 【W3 · 真读数（p0-6 · D-1/D-2）】原实现把「能按次收窄」等价于「`presetFor` 回了非空字符串」
  //   —— 但 preset **id 不含工具面内容**（宿主 `SubagentStartRequest.agentPreset?: string` 只收 id）
  //   ⇒ 「配了名字」≠「收窄发生了」。本函数把解析器结果归一成**可判定的见证**：
  //
  //   解析器（`opts.presetFor`）允许三种返回：
  //     · `null`               ⇒ 无可宣称的事实（未配置 / 该 preset 覆盖不了本次请求）
  //     · `'<id>'`（裸字符串） ⇒ **有 id、无覆盖声明** ⇒ `hasWitness:false`（C-1 反例：看似能、实则不能）
  //     · `{ preset, covers }` ⇒ 有见证：`covers` = 该 preset 实际拿到的工具面数组
  //
  //   ⇒ `hasWitness` 只表「**有没有覆盖事实**」；「该事实是否满足本次请求」由 `canNarrow` 判（D-2 的
  //     `deny ∩ covers = ∅` + 非空）。两者分开，是为了让「能力位」（`narrowVia`）与「本次是否成立」
  //     （`canNarrow(ask)`）不互相冒充。
  const witnessOf = (ask) => {
    let raw;
    try { raw = presetFor(ask); } catch { raw = null; }
    if (typeof raw === 'string' && raw.length > 0) {
      return { preset: raw, covers: null, hasWitness: false };
    }
    if (raw !== null && typeof raw === 'object' && typeof raw.preset === 'string' && raw.preset.length > 0) {
      const covers = Array.isArray(raw.covers) ? raw.covers : null;
      return { preset: raw.preset, covers, hasWitness: covers !== null };
    }
    return null;
  };

  /** 本次是否**提出**了收窄需求（p0-6 · D-1）。无需求 ⇒ 不构成「以弱换强」。 */
  const needNarrowOf = (ask) => {
    const tf = ask?.toolFace;
    const denyLen = Array.isArray(tf?.deny) ? tf.deny.length : 0;
    const allowLen = Array.isArray(tf?.allow) ? tf.allow.length : 0;
    const hasPersona = typeof ask?.persona === 'string' && ask.persona.length > 0;
    return denyLen > 0 || allowLen > 0 || hasPersona;
  };

  // 收窄/人格经哪条路生效 —— **实测结果**，不是形态派生（p0-6 · D-3；T-2R 成对判据）。
  //   · `'request'`：`start` 通道的 `request.toolFilter` 由宿主强制生效 ⇒ 自见证；
  //   · `'preset'` ：`activation` 通道**且解析器给得出覆盖事实**（`hasWitness`）才敢这么报；
  //   · `'none'`  ：其余（含「只有 preset id、没有覆盖声明」—— 裸 id 不得声称已收窄）。
  //   ⚠ 本读数是**能力位**（该端口**能不能**给见证），不含 `ask`；「本次是否成立」归 `canNarrow(ask)`。
  //   【环 1 连带面 · 1/2】锚点从面级 `available` 换成 **`subagentChannel.available`**：
  //     `form`（`formOf(rt)`）是 **C 档形态**、`witnessOf` 依赖 C 档 `presetFor` ⇒ 只有 C 档可用时这些读数才有依据。
  //     沿用面级会在「C 不可 + D 可用」时让 `form=null` 落到第三支 ⇒ 若 `presetFor` 有配置就报 `'preset'`
  //     = **虚假收窄证据**（声称收窄了，实际 C 通道根本没在用）。
  const narrowVia = !subagentChannel.available ? 'none'
    : form === 'start' ? 'request'
      : (witnessOf(undefined)?.hasWitness ? 'preset' : 'none');
  // 深度经哪条路 —— 两形态都在 request 内；宿主 `depthLimit` 明确 false ⇒ 不传（`none`，非静默降级）。
  //   【环 1 连带面 · 2/2】同样换锚：`caps` 来自 `rt.capabilities`（**C 档能力位**）⇒ C 不可时 `caps=null`，
  //   沿用面级 `available` 会报 `'request'` = **无依据的声称**（D 档派发压根不传 depthLimit）。
  const depthVia = subagentChannel.available ? (capsKnown && caps.depthLimit === false ? 'none' : 'request') : 'none';

  // ── 【ly-impl · 批 `punky-arch-refine-20261101`】`push_execute` 的两通道实现 ──────────────
  //
  // 语义（用户裁决）：`push_execute(spec, options?)` = **按 `ExecSpec` 把一个 lane 任务推给一个成员执行**。
  //   `spec` = 契约面（W1 冻结，`ExecSpec` 七字段）；`options` = **非契约第二参**（R-5 已批），
  //   承载 `provider/label/prompt/parent/signal/role/toolFace/persona/maxDepth/agent`
  //   —— `options.toolFace` **必须原样到 C 通道**（F-3 复发防线，AC-9）。
  //
  // 选路（确定性，**单点**）：
  //   ① `spec.session.id` 非空 ∧ D 可用 ⇒ `agentTeam`（续用黑板绑定会话；走 C 会新起 subagent 破坏绑定）
  //   ② 否则 C 可用 ⇒ `subagent`
  //   ③′ C 不可但 D 可用（无绑定）⇒ `agentTeam`（明明能发却抛 = 把可用通道当不可用）
  //   ③ 两条都不可用 ⇒ **fail-closed 抛**（不返回空 ExecResult 冒充成功）
  //   ⚠ **规则 ④**：本次「不可确认」（名册未命中）**不构成**切换通道的理由 —— 确认失败是观测面问题，
  //     不是通道能力问题；回头改走 C 会丢弃持久绑定（比「不可确认」严重得多）。
  const pickChannelOf = (spec) => {
    const facts = agentChannelFactsOf(ctx);
    const dUsable = facts.agentTeam.available === true;
    const cUsable = facts.subagent.available === true;
    const bound = typeof spec?.session?.id === 'string' && spec.session.id.length > 0;
    if (bound && dUsable) return 'agentTeam';
    if (cUsable) return 'subagent';
    if (dUsable) return 'agentTeam';
    throw new Error(HOST_PORT_UNSUPPORTED + ' push_execute: 无可用通道（subagent / agentTeam 皆不可用）');
  };

  /** `ExecResult` 的**空壳**（键集严格对齐契约；`via`/`sessionId`/`run` 是非契约诊断面）。 */
  const emptyExecResultOf = () => ({ timedOut: false, exitCode: null, signal: null, writes: [], evidence: [] });

  /** C 通道（**直接派发**）：经 `subagents` 服务（复用既有 `spawn` 原子步骤，不改其语义）。 */
  const pushViaSubagent = async (spec, options) => {
    const spawned = await port.spawn({
      provider: options?.provider,
      label: options?.label ?? spec?.taskPkg?.id,
      prompt: options?.prompt,
      parent: options?.parent,
      signal: options?.signal,
      role: options?.role ?? spec?.member?.title,
      toolFace: options?.toolFace, // ★ R-5 / AC-9：不得丢键（丢 = 收窄通道静默失效）
      persona: options?.persona,
      maxDepth: options?.maxDepth,
    });
    return {
      ...emptyExecResultOf(),
      // ⚠ 保住 `spawn` 的**既有回显键**（`form` / `narrowVia` / `depthVia` / `preset` 等）：
      //   这些是 `lane_dispatch` 的既有可观测面，`push_execute` 包装时**不得丢**（否则旧读端静默失明）。
      ...spawned,
      via: 'subagent',
      run: spawned?.run ?? null,
      sessionId: spawned?.run?.id ?? null,
    };
  };

  /**
   * D 通道（**间接派发**）：引擎 → 工具面 `spawn_teammate` → 宿主拉起成员。
   *
   * **成功判据（两层，缺一不可）**：
   *   ① 工具调用返回 `isError !== true`；
   *   ② `RosterSource.sessionOf(targetId)` **命中会话 id**（D 档拿 id 的唯一既有真源 = 名册反查：
   *      宿主 `modelMember()` 会丢弃 `id`，取证见 `lib/bridge/dispatch-register.js` 注释）。
   * ⚠ **不用 `post-execute` 事件**：自派会产生「自己调、自己观察」的归属混淆，且登记面同一监听器
   *   会重复登记 ⇒ 成功语义必须落在**同步可判**的两层上。
   * ⚠ 工具 ok 但名册未命中 ⇒ **不可确认**（`errorCode:'PUSH_UNCONFIRMED'`、`sessionId:null`）：
   *   既不是失败（宿主可能真拉起了，只是观测缺失），也不是成功 ⇒ **上层不得据此写绑定**。
   */
  const pushViaAgentTeam = async (spec, options) => {
    const toolFace = serviceOf(ctx, 'tools');
    if (!toolFace || typeof toolFace.execute !== 'function') {
      throw new Error(HOST_PORT_UNSUPPORTED + ' push_execute(D): 工具面不可调，无法发起 spawn_teammate');
    }
    const targetName = typeof spec?.targetId === 'string' && spec.targetId.length > 0 ? spec.targetId : null;
    if (!targetName) {
      // AC-8：`targetId` 由 Leader 给定，适配器**不得自选成员**、不得扩员。
      throw new Error(HOST_PORT_UNSUPPORTED + ' push_execute(D): spec.targetId 缺失（适配器不得自选成员）');
    }
    const args = {
      name: targetName,
      ...(typeof options?.prompt === 'string' ? { prompt: options.prompt } : {}),
      ...(typeof options?.callsign === 'string' ? { callsign: options.callsign } : {}),
    };
    let r = null;
    try {
      r = await toolFace.execute({ name: 'spawn_teammate', arguments: args });
    } catch (e) {
      // 调用面本身失败（工具面炸）⇒ 明确失败，**不与「不可确认」混同**。
      throw new Error(HOST_PORT_QUERY_FAILED + ' push_execute(D) 调用面失败: ' + String(e?.message ?? e));
    }
    if (r && r.isError === true) {
      return { ...emptyExecResultOf(), exitCode: 1, errorCode: 'PUSH_FAILED', errorFamily: 'dispatch',
        via: 'agentTeam', sessionId: null, run: null };
    }
    let sid = null;
    try {
      sid = createRosterPort(ctx, options?.agent ?? null).sessionOf(targetName);
    } catch { sid = null; } // 查询面坏 = 不可确认（与「名不在名册」同档下游处置）
    if (!sid) {
      return { ...emptyExecResultOf(), errorCode: 'PUSH_UNCONFIRMED', errorFamily: 'dispatch-unconfirmed',
        via: 'agentTeam', sessionId: null, run: null };
    }
    return { ...emptyExecResultOf(), via: 'agentTeam', sessionId: sid, run: null };
  };

  const port = {
    available,
    reason,                   // 'runtime-unavailable' | 'no-start-entry' | null —— **功能面**成因（引擎据此分档降级文案）
    form,                     // 端口内部状态（引擎只读 `available`/`reason`，**不得**读本键：AC-5″）
    capsKnown,
    narrowVia,                // 'request' | 'preset' | 'none'  —— 收窄通道的**实测**取值（非形态派生）
    // 显式别名（契约面要求逐名可读；`toolFaceVia` / `personaVia` 与 `narrowVia` **同源同值**，
    //   禁两处各判：三者取自同一 `narrowVia`，不是三次独立推导）。
    toolFaceVia: narrowVia,   // 工具面收窄经哪条路：'request'（toolFilter）| 'preset'（agentPreset）| 'none'
    personaVia: narrowVia,    // 人格经哪条路：'request'（persona）| 'preset'（agentPreset）| 'none'
    depthVia,                 // 'request' | 'none'
    /**
     * 能否按**本次请求**收窄（p0-6 · D-1 两段式）。
     *
     * 判序（**每一段都不可省**）：
     * ① `available===false` ⇒ `false`（拿不到功能）；
     * ② **无收窄需求**（`toolFace` 两集皆空且无 `persona`）⇒ `true`（不构成「以弱换强」）；
     *    ⚠ 这个 `true` **不得**被读作「该 lane 已被收窄」—— 它只表示「本次没要求收窄」；
     * ③ `start` 通道 ⇒ `true`（`request.toolFilter` 自见证，W-1）；
     * ④ `activation` 通道 ⇒ 必须有见证（裸 preset id 无见证 ⇒ `false`，反例 C-1）；
     * ⑤ 见证的 `covers` **为空** ⇒ `false`（反例 C-5：`∅∩∅=∅` 恒成立，空集不是「全收窄」是「未声明」）；
     * ⑥ `deny ∩ covers = ∅` ⇒ 收窄成立；有交集 ⇒ `false`（该 preset 实际拿到了本次要禁的工具）。
     */
    canNarrow(ask = {}) {
      if (!available) return false;
      if (!needNarrowOf(ask)) return true;
      if (form === 'start') return true;
      const w = witnessOf(ask);
      if (!w || !w.hasWitness) return false;
      if (!w.covers || w.covers.length === 0) return false;
      const deny = Array.isArray(ask?.toolFace?.deny) ? ask.toolFace.deny : [];
      return !deny.some((t) => w.covers.includes(t));
    },
    /**
     * 要一个成员（**两种形态各走自己的入口**；调用方不需要知道是哪一种）。
     *
     * @param {object} args
     * @param {string} args.provider   后端 provider 名（由配置给出，端口不猜）
     * @param {string} args.label      子会话标签（cataloged membership 可见）
     * @param {string} args.prompt     任务包文本（内部包成 `[{type:'text',text}]`）
     * @param {object} args.parent     父会话/agent（宿主决定挂载点）
     * @param {AbortSignal} [args.signal] 缺省自持永不中止（与 `buildStartRequest` 同纪律：**不透传** `exec.signal`）
     * @param {string} [args.role]     仅用于 `presetFor` 解析（不传给宿主）
     * @param {object} [args.toolFace] 工具面（`start` 形态 → `toolFilter`；`activation` 形态 → preset）
     * @param {string} [args.persona]  人格（同上）
     * @param {number} [args.maxDepth] 委派深度（两形态都走 `request.maxDepth`）
     * @param {string} [args.cwd]      `activation` 形态的显式工作目录（可选）
     * @returns {Promise<{ run: object, form: string, narrowVia: string, depthVia: string, preset: string|null }>}
     */
    async spawn({ provider, label, prompt, parent, signal, role, toolFace, persona, maxDepth, cwd } = {}) {
      if (!available) throw new Error(HOST_PORT_UNSUPPORTED + ' ctx.subagents 无可用启动入口（既无 startActivation 也无 start）');
      if (typeof provider !== 'string' || provider.length === 0) {
        throw new Error(HOST_PORT_UNSUPPORTED + ' spawn 需要 provider（端口不猜 provider）');
      }
      const effectiveSignal = signal ?? new AbortController().signal;
      const promptBlocks = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;

      if (form === 'start') {
        const request = {
          label,
          signal: effectiveSignal,
          parent,
          prompt: promptBlocks,
          ...(toolFace !== undefined ? { toolFilter: toolFace } : {}),
          ...(persona !== undefined ? { persona } : {}),
          ...(maxDepth !== undefined && depthVia === 'request' ? { maxDepth } : {}),
        };
        const run = await rt.start(provider, request);
        return { run, form, narrowVia, depthVia, preset: null };
      }

      // ---- activation 形态：收窄/人格**只能**经 agentPreset ----
      //   见证解析走**同一单点** `witnessOf`（与 `canNarrow` / `narrowVia` 同源，禁第二套判据）。
      //   ⚠ 端口层**不替闸判**「covers 是否满足本次请求」—— 那是 `canNarrow(ask)` 的职责，引擎在派发前已问；
      //     本处只保底「有 id 才能派发」，否则抛 `host-port-unsupported:`（既有的端口自足拒态，T-3 用例锁）。
      const witness = witnessOf({ role, toolFace, persona });
      const preset = witness?.preset ?? null;
      if (typeof preset !== 'string' || preset.length === 0) {
        throw new Error(HOST_PORT_UNSUPPORTED + ' startActivation 形态不承载 toolFilter/persona，'
          + '且未能解析出 agentPreset（宿主会按父会话 composition 组子会话 ⇒ worker 拿到未收窄工具面）'
          + ' ⇒ 拒派（不以弱换强）：role=' + String(role ?? '(未声明)'));
      }
      const request = {
        parent,
        prompt: promptBlocks,
        agentPreset: preset,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(maxDepth !== undefined && depthVia === 'request' ? { maxDepth } : {}),
      };
      // ⚠ `request` **不含** `toolFilter`/`persona`：宿主 schema 无此字段（见文件头契约取证）。
      const spec = { provider, label, request, signal: effectiveSignal, delivery };
      const run = await rt.startActivation(spec);
      return { run, form, narrowVia, depthVia, preset };
    },

    // ---- 其余成员面对（薄转发；缺面即抛 `host-port-unsupported:`，禁静默成功） ----
    async send(...args) {
      if (typeof rt?.send !== 'function') throw new Error(HOST_PORT_UNSUPPORTED + ' ctx.subagents.send 不可用');
      return rt.send(...args);
    },
    async wait(...args) {
      if (typeof rt?.await !== 'function' && typeof rt?.wait !== 'function') {
        throw new Error(HOST_PORT_UNSUPPORTED + ' ctx.subagents.await 不可用');
      }
      return (rt.await ?? rt.wait).apply(rt, args);
    },
    async cancel(...args) {
      if (typeof rt?.cancel !== 'function') throw new Error(HOST_PORT_UNSUPPORTED + ' ctx.subagents.cancel 不可用');
      // 【T-B · 批 `punky-three-tasks-20261103`】**归一宿主返回为三态 `CancelResult`**（契约见 `ports.ts`）。
      //   纪律来源：契约注释「语义为『停止等待』，**不得把未知当已停**」——
      //   原实现 `return rt.cancel(...)` 把宿主形态**原样透出**，而契约原本零回报 ⇒ 调用方无从判断。
      //   归一规则（**fail-closed 在最后一条**）：
      //     · 对象且 `outcome` ∈ 三态 ⇒ 透出（`reason` 非空字符串才带）；
      //     · 布尔 `true` ⇒ `cancelled`、`false` ⇒ `skipped`（宿主常见的布尔取消原语）；
      //     · **其余（undefined / null / 不可识别）⇒ `rejected` + reason —— 不得当已停**。
      const raw = await rt.cancel(...args);
      const OUTCOMES = ['cancelled', 'skipped', 'rejected'];
      if (raw && typeof raw === 'object' && OUTCOMES.includes(raw.outcome)) {
        return typeof raw.reason === 'string' && raw.reason.length > 0
          ? { outcome: raw.outcome, reason: raw.reason }
          : { outcome: raw.outcome };
      }
      if (raw === true) return { outcome: 'cancelled' };
      if (raw === false) return { outcome: 'skipped', reason: 'host-reported-not-cancelled' };
      return { outcome: 'rejected', reason: 'host-return-unrecognized' };
    },
    list(...args) {
      if (typeof rt?.list !== 'function') throw new Error(HOST_PORT_UNSUPPORTED + ' ctx.subagents.list 不可用');
      return rt.list(...args);
    },
    interrupt(...args) {
      if (typeof rt?.interrupt !== 'function') throw new Error(HOST_PORT_UNSUPPORTED + ' ctx.subagents.interrupt 不可用');
      return rt.interrupt(...args);
    },

    /**
     * 唤醒会话所有者（**Leader 唤醒通路**；契约 `lib/ports.ts:147-154` `AgentRuntime.notifyLeader`）。
     *
     * 收窄自「先取宿主会话句柄、再调其推送原语」两步 ⇒ **调用方拿不到、也解引用不到**任何宿主句柄
     * （AC-5″ 的同源纪律：引擎只许要功能，不许持有宿主对象）。
     *
     * 纪律（契约明令）：
     *   · **不抛**：不可用 / 查不到 / 投递失败一律以 `{ delivered:false, reason }` 表达；
     *   · `reason` 只用**功能面词汇**（禁宿主服务名/入口名）⇒ 归因不泄漏宿主实现。
     *
     * ⚠ **同步返回**（await 兼容）：宿主 `agents.get(id)` 与 `Agent.followup(msg)` 均同步调用，
     *   而本仓**既有调用面是同步的**（`lib/tools/swarm-comms.js#wakeLeaderForReport` 及其
     *   `test/worker-notify-wake.test.js`、`test/swarm-wake-addressing.test.js` 直接读返回值）
     *   ⇒ 返回同步值，`await` 对非 thenable 直接取值，两种写法都成立。
     *
     * @param {{sessionId?: string, message?: object}} [request]
     * @returns {{delivered: boolean, reason: string|null}}
     */
    notifyLeader({ sessionId, message } = {}) {
      // 取「会话服务」：与本端口其余取法同源（`serviceOf`：裸读优先 + `ctx.get` 回落）。
      const agents = serviceOf(ctx, 'agents');
      if (!agents || typeof agents.get !== 'function') return { delivered: false, reason: 'agent-runtime-unavailable' };
      if (typeof sessionId !== 'string' || sessionId.length === 0) return { delivered: false, reason: 'session-required' };
      let target = null;
      try { target = agents.get(sessionId) ?? null; } catch { return { delivered: false, reason: 'lookup-failed' }; }
      // 查不到 / 句柄不可推送 ⇒ 同一功能面成因（引擎据此外化为 `leader-not-live`）。
      if (!target || typeof target.followup !== 'function') return { delivered: false, reason: 'leader-not-live' };
      try { target.followup(message); } catch (e) {
        return { delivered: false, reason: 'deliver-failed: ' + String(e?.message ?? e) };
      }
      return { delivered: true, reason: null };
    },

    /**
     * 按 `ExecSpec` 把一个 lane 任务**推给一个成员执行**（契约 `AgentRuntime.push_execute`）。
     *
     * 与旧 `execute` 的关系：**同一动作换了名字**（用户裁决：避免与「成员自身的执行」混淆）。
     * 与 `spawn` 的关系：`spawn` 降为**内部原子步骤**（C 通道的「下发」），本方法是**唯一派发动词**。
     *
     * @param {object} spec      `ExecSpec`（W1 冻结面；本方法只读，**不写状态** —— AC-5）
     * @param {object} [options] **非契约第二参**（R-5）：`provider/label/prompt/parent/signal/role/
     *                            toolFace/persona/maxDepth/agent`（`toolFace` 必须原样到 C 通道）
     * @returns {Promise<object>} `ExecResult` + 非契约诊断键 `via` / `sessionId` / `run`
     *   ⚠ `errorCode === 'PUSH_UNCONFIRMED'` 时 `sessionId` 为 `null` ⇒ **上层不得写绑定**（AC-16）
     * @throws {Error} 两条通道都不可用（fail-closed）；工具调用面失败（`host-port-query-failed:`）
     */
    async push_execute(spec = {}, options = {}) {
      const via = pickChannelOf(spec); // 选路单点（AC-3）
      return via === 'agentTeam'
        ? await pushViaAgentTeam(spec, options)
        : await pushViaSubagent(spec, options);
    },
  };
  return port;
}
