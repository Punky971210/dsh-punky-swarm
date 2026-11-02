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
import { serviceOf } from './tools-http.js';

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
export function agentChannelFactsOf(ctx) {
  const subagent = subagentChannelOf(serviceOf(ctx, 'subagents'));
  const agents = serviceOf(ctx, 'agents');
  // D 档判据与 `notifyLeader` 的入参守卫**同式**：取到服务且其 `get` 可调用才算可用。
  //   注意「取到之后能不能投递」不在此判（那是调用时的事实，属 `notifyLeader` 的 `reason` 域）。
  const agentTeam = (agents && typeof agents.get === 'function')
    ? { available: true, reason: null }
    : { available: false, reason: 'agent-runtime-unavailable' };
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
  const available = subagentChannel.available;
  /** 不可用成因（功能面三态；`available===true` 时恒 `null`）。 */
  const reason = subagentChannel.reason;
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
  const narrowVia = !available ? 'none'
    : form === 'start' ? 'request'
      : (witnessOf(undefined)?.hasWitness ? 'preset' : 'none');
  // 深度经哪条路 —— 两形态都在 request 内；宿主 `depthLimit` 明确 false ⇒ 不传（`none`，非静默降级）。
  const depthVia = available ? (capsKnown && caps.depthLimit === false ? 'none' : 'request') : 'none';

  return {
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
      return rt.cancel(...args);
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
  };
}
