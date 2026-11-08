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

// 设计纲（用户裁定）：引擎只管问适配器要功能；宿主差异全部关在适配层内。
//   ⇒ 本文件是 `ctx.subagents` 的**唯一**合法消费面（引擎侧不得再 `typeof rt.startActivation === 'function'` 自己判形态）。

import { serviceOf, HOST_PORT_QUERY_FAILED, createToolsPort } from './tools-http.js';
// 【ly-impl】D 通道成功判据的第二腿 = 名册反查（复用 provider 自己的名册面，禁第二套探测）。
import { createRosterPort } from './roster.js';

export const HOST_PORT_UNSUPPORTED = 'host-port-unsupported:';

function formOf(rt) {
  if (!rt || typeof rt !== 'object') return null;
  if (typeof rt.startActivation === 'function') return 'activation';
  if (typeof rt.start === 'function') return 'start';
  return null;
}

function subagentChannelOf(rt) {
  const form = formOf(rt);
  if (form !== null) return { available: true, reason: null };
  return { available: false, reason: rt ? 'no-start-entry' : 'runtime-unavailable' };
}

function agentTeamChannelOf(ctx) {
  const toolFace = serviceOf(ctx, 'tools');
  let dUsable = Boolean(toolFace) && typeof toolFace.execute === 'function';
  if (dUsable) {
    try {
      const p = createToolsPort(ctx).probeTool('spawn_teammate');
      if (p && p.state === 'absent' && p.reason !== 'port-unavailable') dUsable = false;
    } catch {  }
  }
  return dUsable
    ? { available: true, reason: null }
    : { available: false, reason: 'port-absent:agentTeam' };
}

export function agentChannelFactsOf(ctx) {
  const subagent = subagentChannelOf(serviceOf(ctx, 'subagents'));
  const agentTeam = agentTeamChannelOf(ctx);
  return { probed: true, subagent, agentTeam };
}

/**
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
  const rt = serviceOf(ctx, 'subagents');
  const subagentChannel = subagentChannelOf(rt);
  const form = formOf(rt);
  const agentTeamChannel = agentTeamChannelOf(ctx);
  const available = subagentChannel.available === true || agentTeamChannel.available === true;
  const reason = available === true ? null : subagentChannel.reason;
  const caps = opts.capabilities ?? (rt && typeof rt === 'object' ? rt.capabilities : undefined) ?? null;
  const capsKnown = caps !== null && typeof caps === 'object' && Object.keys(caps).length > 0;
  const presetFor = typeof opts.presetFor === 'function' ? opts.presetFor : () => null;
  const delivery = opts.delivery === 'caller' ? 'caller' : 'parent';

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

  const needNarrowOf = (ask) => {
    const tf = ask?.toolFace;
    const denyLen = Array.isArray(tf?.deny) ? tf.deny.length : 0;
    const allowLen = Array.isArray(tf?.allow) ? tf.allow.length : 0;
    const hasPersona = typeof ask?.persona === 'string' && ask.persona.length > 0;
    return denyLen > 0 || allowLen > 0 || hasPersona;
  };

  const narrowVia = !subagentChannel.available ? 'none'
    : form === 'start' ? 'request'
      : (witnessOf(undefined)?.hasWitness ? 'preset' : 'none');
  const depthVia = subagentChannel.available ? (capsKnown && caps.depthLimit === false ? 'none' : 'request') : 'none';

  // 语义（用户裁决）：`push_execute(spec, options?)` = **按 `ExecSpec` 把一个 lane 任务推给一个成员执行**。
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

  const emptyExecResultOf = () => ({ timedOut: false, exitCode: null, signal: null, writes: [], evidence: [] });

  const pushViaSubagent = async (spec, options) => {
    const spawned = await port.spawn({
      provider: options?.provider,
      label: options?.label ?? spec?.taskPkg?.id,
      prompt: options?.prompt,
      parent: options?.parent,
      signal: options?.signal,
      role: options?.role ?? spec?.member?.title,
      toolFace: options?.toolFace,
      persona: options?.persona,
      maxDepth: options?.maxDepth,
    });
    return {
      ...emptyExecResultOf(),
      ...spawned,
      via: 'subagent',
      run: spawned?.run ?? null,
      sessionId: spawned?.run?.id ?? null,
    };
  };

  const pushViaAgentTeam = async (spec, options) => {
    const toolFace = serviceOf(ctx, 'tools');
    if (!toolFace || typeof toolFace.execute !== 'function') {
      throw new Error(HOST_PORT_UNSUPPORTED + ' push_execute(D): 工具面不可调，无法发起 spawn_teammate');
    }
    const targetName = typeof spec?.targetId === 'string' && spec.targetId.length > 0 ? spec.targetId : null;
    if (!targetName) {
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
      throw new Error(HOST_PORT_QUERY_FAILED + ' push_execute(D) 调用面失败: ' + String(e?.message ?? e));
    }
    if (r && r.isError === true) {
      return { ...emptyExecResultOf(), exitCode: 1, errorCode: 'PUSH_FAILED', errorFamily: 'dispatch',
        via: 'agentTeam', sessionId: null, run: null };
    }
    let sid = null;
    try {
      sid = createRosterPort(ctx, options?.agent ?? null).sessionOf(targetName);
    } catch { sid = null; }
    if (!sid) {
      return { ...emptyExecResultOf(), errorCode: 'PUSH_UNCONFIRMED', errorFamily: 'dispatch-unconfirmed',
        via: 'agentTeam', sessionId: null, run: null };
    }
    return { ...emptyExecResultOf(), via: 'agentTeam', sessionId: sid, run: null };
  };

  const port = {
    available,
    reason,
    form,
    capsKnown,
    narrowVia,
    toolFaceVia: narrowVia,
    personaVia: narrowVia,
    depthVia,
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
      const spec = { provider, label, request, signal: effectiveSignal, delivery };
      const run = await rt.startActivation(spec);
      return { run, form, narrowVia, depthVia, preset };
    },

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

    notifyLeader({ sessionId, message } = {}) {
      const agents = serviceOf(ctx, 'agents');
      if (!agents || typeof agents.get !== 'function') return { delivered: false, reason: 'agent-runtime-unavailable' };
      if (typeof sessionId !== 'string' || sessionId.length === 0) return { delivered: false, reason: 'session-required' };
      let target = null;
      try { target = agents.get(sessionId) ?? null; } catch { return { delivered: false, reason: 'lookup-failed' }; }
      if (!target || typeof target.followup !== 'function') return { delivered: false, reason: 'leader-not-live' };
      try { target.followup(message); } catch (e) {
        return { delivered: false, reason: 'deliver-failed: ' + String(e?.message ?? e) };
      }
      return { delivered: true, reason: null };
    },

    async push_execute(spec = {}, options = {}) {
      const via = pickChannelOf(spec);
      return via === 'agentTeam'
        ? await pushViaAgentTeam(spec, options)
        : await pushViaSubagent(spec, options);
    },
  };
  return port;
}
