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

// @ts-check

// 派发面 · 派发执行：启动请求构造、spawn 错误映射、one-shot 追踪、`dispatchLaneCore`。

import { issueLaneHandle, consumeLaneHandle } from '../bridge/lane-handle.js';
import { renderArchContext } from './arch-context.js';
import { createAgentPort } from '../provider-dsh/agent.js';
import { EVT_MEMBER_DISPATCH } from '../state/event-types.js';
import { SUITE_DENY_TOOLS } from './suite.js';
import { readCapability } from '../assembly/schema.js';
import { expectedWorkerSessionOf } from '../state/dispatch-events.js';
import { roleCorpusRoot, resolveRoleRef, deriveDenyTools, personaOfRole } from './dispatch-role.js';
import { ownerOfExec, labelOf, ownerSessionIdOfExec, dispatchIndexEntryOf } from './dispatch-bind.js';
import { composeWorkerPrompt } from './dispatch-taskpack.js';

export function buildStartRequest({
  batchId, lane, parent, prompt, denyTools = SUITE_DENY_TOOLS, extraDeny = [], persona, role, roleRoot, roleTeam,
  maxDepth = 1, signal,
}) {
  const roleData = resolveRoleRef(role, { root: roleRoot ?? roleCorpusRoot(), team: roleTeam });
  const effectivePersona = persona !== undefined ? persona : personaOfRole(roleData);
  // 【R-3 · deny 纯单据化（2026-11-10 裁决）】收窄**只**由显式 deny 单据决定
  //   = `SUITE_DENY_TOOLS`（治理套件，唯一持有者 = `suite.js`）∪ `config.dispatch.denyTools`（用户点名单件）。
  //   role frontmatter 的 `tools.allow` **降级为意图声明**：缺省**不**据此反推 deny 补集。
  //   旧行为（本批停用）：`deriveDenyTools(allow)` = 「全部 role 的 allow 并集 − 本 role 的 allow」，
  //   会把 `edit` / `memory_search` / `memory_save` / `web_search` 等从成员面剜掉（见判据源 §P-1 / §P-5）。
  //   逃生阀：role 显式声明 `tools.deny_derived: true` 时才走 legacy 反推（本批已把 21 份 role 该位全置 `false`）。
  const derivedDeny = roleData?.tools?.deny_derived === true
    ? deriveDenyTools(roleData?.tools?.allow, { root: roleRoot ?? roleCorpusRoot() })
    : [];
  return {
    label: labelOf(batchId, lane),
    signal: signal ?? new AbortController().signal,
    parent,
    prompt: [{ type: 'text', text: prompt }],
    toolFilter: { deny: [...new Set([...denyTools, ...derivedDeny, ...extraDeny])] },
    ...(effectivePersona !== undefined ? { persona: effectivePersona } : {}),
    maxDepth,
  };
}

export function mapSpawnError(err) {
  const raw = String(err?.message ?? err ?? '');
  if (/capabilit|toolFilter|depthLimit/i.test(raw)) {
    return { code: 'GATE_DISPATCH_CAPABILITY_UNAVAILABLE', message: 'provider 能力位不足（toolFilter/depthLimit）⇒ 拒派，不以弱换强：' + raw };
  }
  if (/provider|unknown provider|not resolvable/i.test(raw)) {
    return { code: 'GATE_DISPATCH_PROVIDER_INVALID', message: 'provider 不可解析（检查 config.dispatch.provider）：' + raw };
  }
  return { code: 'GATE_DISPATCH_FAILED', message: '引擎自派失败：' + raw };
}

export function workerSessionIdOf(start, warn) {
  if (!start || typeof start !== 'object') return null;
  if (typeof start.id === 'string' && start.id) return start.id;
  for (const k of ['childId', 'subagentId']) {
    if (typeof start[k] === 'string' && start[k]) {
      warn?.('start 未返回实现面字段 `id` → 回落 `' + k + '`（continuable 时代契约字段，防御性保留；若两者皆缺请查宿主返回形态）');
      return start[k];
    }
  }
  return null;
}

function spawnNoteOf(reason) {
  const tail = '⇒ 仅发句柄（请把 firstLine 交给直派形态；该形态门禁属 C 阶段）';
  if (reason === 'runtime-unavailable') {
    return '适配层 agent 功能面不可用（端口 `available=false`，成因 runtime-unavailable：服务未注入，或取值被 provider 侧守卫拒绝）' + tail;
  }
  return '适配层 agent 功能面**在位但不含可用启动入口**（成因 no-start-entry：两个入口皆不可调用；入口选择属 provider 内部）' + tail;
}

const activeRuns = new Map();
function trackOneShotRun(workerSessionId, run, warn) {
  if (!run || typeof run !== 'object' || !(run.result instanceof Promise)) {
    warn?.('start 返回载荷缺 `result`（Promise）⇒ run 终态不可跟踪（留痕不阻断；若宿主形态变更请按本载荷适配）');
    return;
  }
  activeRuns.set(workerSessionId, run);
  run.result.then(
    () => { activeRuns.delete(workerSessionId); },
    (e) => {
      activeRuns.delete(workerSessionId);
      warn?.('one-shot worker run 失败（留痕不进判定，结算走门禁）：' + String(e?.message ?? e) + ' · worker=' + workerSessionId);
    },
  );
}

// ── 派发核心（**唯一实现**：工具面与链引擎共用，禁第二套） ──────────────────────
export async function dispatchLaneCore({ ctx, store, root, liveConfig, exec, sessionId, batchId, lane, leaderPrompt = '', exempt, dispatchIndex }) {
  let laneTask = null;
  try {
    const wp = store.readBatch(sessionId, batchId)?.wavePlan ?? [];
    const flat = Array.isArray(wp) ? wp.flatMap((w) => w?.tasks ?? []) : (wp.tasks ?? []);
    laneTask = flat.find((t) => t && t.id === lane) ?? null;
  } catch { laneTask = null; }
  const roleData = resolveRoleRef(laneTask?.role, { warn: (m) => ctx?.logger?.warn?.(m) });
  const denyAllForAsk = [...new Set([...SUITE_DENY_TOOLS, ...(liveConfig?.dispatch?.denyTools ?? [])])];
  const askToolFace = { deny: denyAllForAsk };
  const askPersona = liveConfig?.dispatch?.persona !== undefined
    ? liveConfig.dispatch.persona
    : personaOfRole(roleData);
  const agentPort = createAgentPort(ctx, {
    presetFor: (ask) => {
      const presetId = typeof liveConfig?.dispatch?.agentPreset === 'string'
        && liveConfig.dispatch.agentPreset.length > 0
        ? liveConfig.dispatch.agentPreset
        : null;
      if (!presetId) return null;
      const coverage = liveConfig?.dispatch?.presetCoverage;
      const entry = coverage !== null && typeof coverage === 'object' ? coverage[presetId] : null;
      const tools = entry !== null && typeof entry === 'object' && Array.isArray(entry.tools) ? entry.tools : null;
      if (tools === null) return presetId;
      const deny = Array.isArray(ask?.toolFace?.deny) ? ask.toolFace.deny : [];
      if (deny.some((t) => tools.includes(t))) return null;
      return { preset: presetId, covers: [...tools] };
    },
  });
  if (agentPort.available && !agentPort.canNarrow({ role: laneTask?.role, toolFace: askToolFace, persona: askPersona })) {
    const presetConfigured = typeof liveConfig?.dispatch?.agentPreset === 'string'
      && liveConfig.dispatch.agentPreset.length > 0;
    const rejectedOf = (note) => ({
      batchId,
      lane,
      status: 'pending',
      spawned: false,
      mode: 'rejected',
      code: 'GATE_DISPATCH_CAPABILITY_UNAVAILABLE',
      spawnNote: note,
    });
    if (!presetConfigured) {
      return rejectedOf('通道在，但本次 ask 的收窄不可核：未配置 `config.dispatch.agentPreset`（无收窄见证）⇒ 拒派，不以弱换强。'
        + '功能面读数 = agent 端口 `available=true` 但 `canNarrow(本次 ask)` = false（收窄只能经 `agentPreset` 组 composition）；'
        + ' ⚠ 但 **`maxDepth` 原生可用**（`request.maxDepth`，受 `capabilities.depthLimit` 约束）——不是「什么都做不了」。'
        + ' 填 `config.dispatch.agentPreset`（指向已按 toolFace 收窄的 preset）后即可正常自派。'
        + ' ｜ 拒派打在状态变更之前：lane=' + lane + ' 保持待派发（无句柄、无 `member.dispatch` 事件、批相位不变）。');
    }
    return rejectedOf('通道在，但本次 ask 的收窄不可核：已配置 `config.dispatch.agentPreset`，'
      + '但适配层**无法核对**它对**本次**请求的收窄（真读数口径，P0-6 D-2）：需要 '
      + '`config.dispatch.presetCoverage[<preset 名>].tools` 声明该 preset **实际拿到**的工具面，'
      + '且该声明必须**非空**、并与本次要禁的工具集**不相交**（「声明为空集」不算收窄 —— 空集与任何集的交集恒为空，'
      + '那会让判据退化成恒真）。'
      + ' ⚠ **这不是「配置问题」**：`a1-gate` 上批实测 —— 纯 D 宿主**已配** `agentPreset` + `presetCoverage` 仍被拒，'
      + '成因是「**本次 ask** 的收窄不可核」，不是配置缺项、也不是通道不存在。'
      + ' ⇒ 拒派（不宣称未核实的收窄）｜ lane=' + lane + ' 保持待派发（无句柄、无 `member.dispatch` 事件、批相位不变）。');
  }
  const artifactsRoot = root
    ? String(root).replace(/[\\/]+$/, '') + '/sessions/' + sessionId + '/artifacts/' + batchId
    : undefined;
  const b = store.setMember(sessionId, batchId, lane, 'running', null, exempt, ownerOfExec(exec));
  const h = issueLaneHandle({ batchId, lane, sessionId });
  const base = { batchId, lane, status: b.lanes[lane], token: h.token, firstLine: h.firstLine, ttlMs: h.ttlMs };
  if (!agentPort.available) {
    return { ...base, spawned: false, mode: 'degraded', spawnNote: spawnNoteOf(agentPort.reason) };
  }
  const provider = liveConfig?.dispatch?.provider ?? null;
  if (!provider) {
    ctx?.logger?.warn?.('[dsh-punky-swarm] lane_dispatch: 未配置 config.dispatch.provider ⇒ 仅发句柄（不猜 provider）· lane=' + lane);
    return { ...base, spawned: false, mode: 'degraded', spawnNote: '未配置 config.dispatch.provider ⇒ 仅发句柄（补配置后重派，或用 firstLine 直派）' };
  }
  const injectBudget = readCapability(liveConfig, 'injectBudget');
  const prompt = composeWorkerPrompt({
    batchId, lane, cmd: laneTask?.cmd, layer: laneTask?.layer, role: roleData,
    consume: laneTask?.consume ?? [], produce: laneTask?.produce ?? [], outputs: laneTask?.outputs ?? [],
    firstLine: h.firstLine, leaderPrompt, artifactsRoot,
    batchSessionId: sessionId,
    singleArtifactWrite: laneTask?.singleArtifactWrite === true,
    injectBudget,
    archContext: renderArchContext({ targets: laneTask?.targets ?? null }),
    preflight: laneTask?.preflight ?? null,
    context: laneTask?.context ?? null,
    checkpoints: laneTask?.checkpoints ?? null,
    subtasks: laneTask?.subtasks ?? null,
    resume: laneTask?.resume === true,
    logger: ctx?.logger ?? null,
  });
  let start = null;
  try {
    if (!exec?.agent) throw new Error('缺少调用方 Agent —— 派发必须在工具流水线内调用（exec.agent 决定子会话挂载点）');
    const denyAll = [...new Set([...SUITE_DENY_TOOLS, ...(liveConfig?.dispatch?.denyTools ?? [])])];
    const denyDropped = new Set();
    for (let attempt = 0; ; attempt++) {
      try {
        const builtRequest = buildStartRequest({
          batchId, lane, parent: exec.agent, prompt,
          denyTools: denyAll.filter((n) => !denyDropped.has(n)),
          extraDeny: [],
          persona: liveConfig?.dispatch?.persona,
          role: roleData,
        });
        const boundSessionId = expectedWorkerSessionOf(store.readBatch(sessionId, batchId), lane);
        const pushed = await agentPort.push_execute(
          {
            runId: h.token,
            targetId: laneTask?.roster ?? lane,
            member: { id: laneTask?.roster ?? lane, title: laneTask?.role ?? undefined },
            session: { id: boundSessionId, params: null },
            taskPkg: { id: lane, wave: laneTask?.wave, deps: laneTask?.deps ?? [] },
            contract: {
              id: laneTask?.contract?.id ?? lane,
              sha256: laneTask?.contract?.sha256 ?? null,
            },
          },
          {
            provider,
            label: builtRequest.label,
            prompt: builtRequest.prompt,
            parent: exec.agent,
            signal: builtRequest.signal,
            role: laneTask?.role,
            toolFace: builtRequest.toolFilter,
            persona: builtRequest.persona,
            maxDepth: builtRequest.maxDepth,
            agent: exec.agent,
          },
        );
        if (pushed && pushed.errorCode === 'PUSH_UNCONFIRMED') {
          return { ...base, spawned: false, mode: 'degraded', unconfirmed: true, reason: 'PUSH_UNCONFIRMED' };
        }
        start = pushed?.run ?? { id: pushed?.sessionId ?? null };
        break;
      } catch (e) {
        const um = /unknown global tools?\s+["'`]?([A-Za-z0-9_.:-]+)/i.exec(String(e?.message ?? e));
        const unknownName = um ? um[1] : null;
        if (unknownName && !denyDropped.has(unknownName) && denyDropped.size < 8) {
          denyDropped.add(unknownName);
          ctx?.logger?.warn?.('[dsh-punky-swarm] lane_dispatch: 宿主工具面无 "' + unknownName
            + '" ⇒ 从 deny 名单移除后重试（0.1.7 兼容自愈，第 ' + (attempt + 1) + ' 次）');
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    const m = mapSpawnError(e);
    try { store.setMember(sessionId, batchId, lane, 'failed', 'dispatch-failed'); } catch {  }
    try { consumeLaneHandle(h.token, { batchId, lane }); } catch {  }
    throw new Error(m.code + ': ' + m.message
      + ' ｜ 已将 lane=' + lane + ' 置 failed（无 worker 挂载；派发失败即终态）⇒ 恢复步骤：记入 gap-list 并开新任务批次，'
      + '**不可原地重派**（K3：返工边 review→running 已去除，重派会被 `invalid member transition` 拒）；'
      + '如需人工核查：`gate_status({ batchId: "' + batchId + '", lane: "' + lane + '" })`。');
  }
  const workerSessionId = workerSessionIdOf(start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  if (!workerSessionId) {
    throw new Error('GATE_DISPATCH_FAILED: rt.start 未返回 worker 会话 id（载荷=' + JSON.stringify(start)
      + '） —— 契约字段为 `id`（`SubagentRun.id` = 子会话 id；与 `subagent/end` 事件 `info.id` 同源）；'
      + '宿主返回形态若变更请按本载荷适配。');
  }
  trackOneShotRun(workerSessionId, start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  const ownerSessionId = ownerSessionIdOfExec(exec);
  const budgetKey = injectBudget?.enabled === false ? { budgetEnabled: false } : {};
  store.appendEvent(sessionId, batchId, EVT_MEMBER_DISPATCH, ownerSessionId
    ? { lane, workerSessionId, ownerSessionId, ...budgetKey }
    : { lane, workerSessionId, ...budgetKey });
  if (dispatchIndex instanceof Map && workerSessionId && !dispatchIndex.has(workerSessionId)) {
    dispatchIndex.set(workerSessionId,
      dispatchIndexEntryOf(sessionId, batchId, lane, ownerSessionId));
  }
  try { consumeLaneHandle(h.token, { batchId, lane }); } catch {  }
  return { ...base, spawned: true, workerSessionId };
}

// C 档无句柄派发：**只有一档生效 = 留痕不拦**（`enforce` 拒态已随码删除，勿回加）。
//   原 `config.dispatch.gate` 键已删：它只改留痕文案、从不改变判定 ⇒ 零行为开关 + 误导性观测面。
