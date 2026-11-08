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

// 治理门禁底层单点（自 `lib/tools/core.js` **原样搬移**，行为零变更）：难度 guard 注册 / 模式门（E 阶段）/
import { join } from 'node:path';
import { createToolsPort } from '../provider-dsh/tools-http.js';
import { isReadOnlyShellCall, SHELL_TOOLS } from './readonly.js';
import * as schema from '../schema.js';
import {
  labelOf, evaluateTierCDispatch,
  modeActiveFor, presetOfSession, MODE_INACTIVE_CODE,
} from '../engine/dispatch.js';
import { parseLaneHandleFromText, verifyLaneHandle, textOfDispatchArgs } from '../bridge/lane-handle.js';
import { decide as decideAllowlist, canonicalDigest } from '../governance/allowlist.js';
import { classifyDenial } from '../governance/denial.js';

export const ASK_REQUIRED_409 = 'approval-needed-409:';
export const ASK_APPROVAL_ARGS_MISMATCH = 'approval-args-mismatch:';

const denialTextOf = (denial) => {
  const { errorFamily, errorCode, action } = classifyDenial(denial);
  return denial.message + ' [errorFamily=' + errorFamily + ' errorCode=' + errorCode + ' repair=' + action + ']';
};

export const ownerOfExec = (exec) => exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;


export const EXEC_TOOLS = [
  'pwsh', 'bash', 'write', 'edit', 'run_code', 'workflow', 'ralph',
  'ssh_exec', 'ssh_cluster', 'ssh_upload', 'ssh_download', 'subagent', 'subagent_fork',
];

//   严格档：**未评估也拒**（必须先 `assign_check({ difficulty: 'C', rationale })`）；无默认档、无静默放行。
export function assertMemberActionTierC(store, sessionId, exec, action, opts = {}, deps = null) {
  if (deps) assertModeActive(deps, exec, action === 'batch' ? '建批（wave_plan）' : '写成员状态（member_set_status / member_settle）');
  const tierOf = (sid) => (sid ? (store.readGovernance(sid)?.lastAssign?.difficulty ?? null) : null);
  const code = action === 'batch' ? 'GATE_BATCH_REQUIRES_C' : 'GATE_MEMBER_REQUIRES_C';
  const what = action === 'batch' ? '建批（wave_plan）' : '写成员状态（member_set_status / member_settle）';
  const caller = exec?.agent?.session?.id ?? null;
  const own = tierOf(caller ?? sessionId);                  // 判据落在**调用方**，不落批归属会话（否则 worker 借 C 档批会话绕过）
  if (own === 'C' || own === 'D') return;
  throw new Error(code + ': ' + what + ' 只允许出现在 **C 档**会话（本会话档位 = ' + String(own ?? '未评估')
    + (caller && caller !== sessionId ? '，批归属会话 = ' + sessionId : '') + '）——'
    + '成员协作只有一条轨道：Leader 先 assign_check({ difficulty: "C" 或 "D", rationale }) 再 wave_plan 建批 → '
    + '按批内流程派发与结算（调度真源 = 任务黑板 `batch.lanes` / `batch.wavePlan`）。**成员仅作为会话存在，不可写成员状态**'
    + '（2026-09-15 用户裁决 Q2=B）；A/B 档 subagent 仅限「不占主上下文的调研」或「已明确上下文的单步派发」，'
    + '不得承担成员施工、不得建批、不得写成员状态。');
}

export function readLiveConfig(deps) {
  try {
    const f = deps?.readConfig;
    const live = typeof f === 'function' ? f() : null;
    return live ?? deps?.config ?? {};
  } catch {
    return deps?.config ?? {};
  }
}

const modeInactiveNoted = new Set();
function shouldNoteModeInactive(sessionId) {
  if (!sessionId || modeInactiveNoted.has(sessionId)) return false;
  if (modeInactiveNoted.size >= 500) modeInactiveNoted.clear();
  modeInactiveNoted.add(sessionId);
  return true;
}

/** 套件工具面的模式门（E 阶段）：本模式未启用蟛蜞治理 ⇒ 明确拒、且不写任何治理状态。 */
export function assertModeActive(deps, exec, where) {
  const warn = (m) => deps?.ctx?.logger?.warn?.('[dsh-punky-swarm] ' + m);
  if (modeActiveFor(readLiveConfig(deps), exec, warn)) return;
  const preset = presetOfSession(exec);
  throw new Error(MODE_INACTIVE_CODE + ': 本会话所属模式（agent preset = ' + String(preset ?? '（未记录）') + '）'
    + '不在 `config.modes.gate` 白名单内 ⇒ 蟛蜞治理不介入本模式，' + where + ' 不予执行。'
    + '如需治理：切到白名单内的模式，或把该 preset id 加入 modes.gate（支持 runtime.json 热更，无需重启）。');
}

export function clearPendingBatch(store, sessionId) {
  const g = store.readGovernance(sessionId);
  const mirroredTo = g.mirroredTo ?? null;
  if (g.pendingBatch || g.pendingSince || g.lastAssign || mirroredTo) {
    store.writeGovernance(sessionId, { pendingBatch: false, pendingSince: null, mirroredTo: null });
  }
  if (mirroredTo && mirroredTo !== sessionId) {
    const gm = store.readGovernance(mirroredTo);
    if (gm.mirror?.from === sessionId) {
      store.writeGovernance(mirroredTo, { pendingBatch: false, pendingSince: null, mirror: null });
    }
  }
}

export function lockPath(root, sessionId, batchId, lane) { return join(root, 'sessions', sessionId, '.locks', batchId + '.' + lane + '.lock'); }


export function installDifficultyGuard(ctx, deps) {
  const { store, config = {} } = deps;
  const port = createToolsPort(ctx);
  {
    port.installGuard((execution) => {
      const header = execution?.agent?.session?.header;
      if (header && (header.delegationDepth > 0 || header.parentSession)) return undefined;
      const sessionId = execution?.arguments?.session ?? execution?.agent?.session?.id;
      if (!sessionId) return undefined;
      if (!modeActiveFor(readLiveConfig(deps), execution, (m) => {
        if (shouldNoteModeInactive(sessionId)) ctx.logger?.warn?.('[dsh-punky-swarm] ' + m);
      })) return undefined;
      // 【装配隔离配套 · 2026-11-08 活体实测死锁】门禁只对**能看到治理工具面**的会话生效。
      //   工具面已改为装配隔离（只在 punky-preset 的 scope 层注册），而本门按**会话 header 的 preset id**
      //   判定 —— 两者可能不一致：会话若在工具面注册**之前**创建、或 preset 重挂换代（老会话链到旧
      //   generation），header 仍写 `punky-preset` ⇒ 门禁照旧生效，但该会话看不到 `assign_check`，
      //   于是「被拦 + 无工具可解套」= 死锁（实测：宿主 pwsh / edit 全被本门拒绝）。
      //   判据取**真实注册表**（调用方 agent 视角）三态：`absent` 才放宽（该会话确实无法评估）；
      //   `visible` 走下面原文分支一字不动；`unknown`（夹具 / 无真注册表）**保留旧行为** ——
      //   否则测试与半装配宿主里的门禁会被静默关掉。
      if (port.toolVisibilityFor(execution?.agent, 'assign_check') === 'absent') return undefined;
      const execTools = config?.escalation?.execTools ?? EXEC_TOOLS;
      //     「评估→被拦→无法评估」死循环（worker 被派发后须先读状态再干活，读状态不能被门禁卡死）。
      if (!execTools.includes(execution.name)) return undefined;
      //   必须看 guard 时刻的**真实形状**才能定案（`arguments` 是否为 JSON 字符串？命令键名不同？）。
      if (SHELL_TOOLS.includes(execution.name) && !isReadOnlyShellCall(execution)) {
        if (shouldNoteModeInactive('readonly-shape:' + sessionId)) {
          const a = execution?.arguments;
          const isObj = !!a && typeof a === 'object';
          ctx.logger?.info?.('[dsh-punky-swarm] readonly-shape probe: ' + JSON.stringify({
            tool: execution.name,
            argType: typeof a,
            argKeys: isObj ? Object.keys(a) : null,
            cmdType: isObj ? typeof a.command : undefined,
            cmdLen: isObj && typeof a.command === 'string' ? a.command.length : null,
            rawLen: typeof a === 'string' ? a.length : null,
          }));
        }
      }
      if (isReadOnlyShellCall(execution)) return undefined;
      const g = store.readGovernance(sessionId);
      let reason;
      if (!g?.lastAssign?.form || !g?.lastAssign?.difficulty || store.stale(sessionId)) {
        reason = '[task-difficulty-gate] 本回合尚未进行任务难度评估（A/B/C/D）。**先用只读侦察摸清任务**'
          + '（read/glob/grep 与只读 shell 命令已开放），再 assign_check({ difficulty, rationale, scope: "full" })'
          + ' 写入难度与判据（判据必填，供审计），之后才能执行 ' + execution.name;
      } else if ((g.lastAssign.form === 'C' || g.lastAssign.form === 'D') && g.pendingBatch) {
        reason = '[task-difficulty-gate] 任务难度=' + g.lastAssign.form + '（集群方案），必须先 wave_plan 建批。已直做产物用 asset_claim 归位，然后建批派发。（口径：C 判据是**多线并行或多依赖**；**单线程任务**应重评为 A/B 带上下文直做，不必建批；D = team 方案（建批档 + team 通道），同受本门 —— 通道面未落实（derivedChannel=dispatch）时，须先重评 durableSeats:true 或显式降级为 C，再建批。）';
      } else if ((execution.name === 'subagent' || execution.name === 'subagent_fork') && g.lastAssign.form === 'A') {
        reason = '[task-difficulty-gate] A 类任务不派发 subagent；如确实需要独立上下文请重评 B。';
      }
      if (!reason && g.lastAssign.difficulty === 'D' && g.lastAssign.derivedChannel === 'dispatch'
        && execution.name !== 'wave_plan') {
        const channelOk = store.listBatches(sessionId).some((id) => {
          const b = store.readBatch(sessionId, id);
          return Boolean(b) && !schema.isBatchTerminal(b.phase) && (b.channel === 'team' || b.channel === 'mixed');
        });
        if (!channelOk) {
          reason = 'GATE_DIFFICULTY_CHANNEL_UNRESOLVED: 本会话声明 difficulty=D，但通道轴推导为 dispatch'
            + '（assign_check 未声明 durableSeats）——**D ≡ 建批档 + team 通道**，通道未落实前不得执行 ' + execution.name + '。'
            + '两条正范式：① 确需 durable 席位 ⇒ 重评 assign_check({ difficulty:"D", durableSeats:true, rationale, scope:"full" })，'
            + '再以 channel:"team"|"mixed" 建批；② 确属引擎自派 ⇒ 显式降级为 C（rationale 写明降级原因，'
            + '与 discipline.md §0b 十四⑤「团队面缺失须显式降级、禁静默降级」同源）。';
        }
      }
      //   拒态随码删除。**结论方向**：**不得**据此假设「派发工具恒缺席」——工具面随宿主 / deployment
      //   装配而变，任何单份快照都不能当恒定事实。
      if (!reason && (execution.name === 'subagent' || execution.name === 'subagent_fork')) {
        const dec = evaluateTierCDispatch({
          tier: g?.lastAssign?.difficulty ?? null,
          toolName: execution.name,
          argsText: textOfDispatchArgs(execution.arguments),
          handleCheck: (t) => {
            const h = parseLaneHandleFromText(t);
            return h ? verifyLaneHandle(h.token, { batchId: h.batchId, lane: h.lane }) : { ok: false, reason: 'no-handle' };
          },
        });
        if (dec.warnNote) ctx.logger?.warn?.('[dsh-punky-swarm] ' + dec.warnNote);
      }
      //   位置纪律：本条 `return` 必须早于**任何** store 写（下方 `bumpExecCount` 就是 store 写 ⇒
      //   拒时不得执行）⇒ 「拒 = 零预写」由**行序**即成立，不是靠事后回滚或调用方自觉。
      const allowlistConfig = config?.tools?.allowlist;
      if (!reason && Array.isArray(allowlistConfig)) {
        const fullArgs = execution.arguments ?? {};
        const approval = fullArgs.approval && typeof fullArgs.approval === 'object' ? fullArgs.approval : null;
        const businessArgs = { ...fullArgs };
        delete businessArgs.approval;
        const argsDigest = canonicalDigest(businessArgs);
        if (approval !== null && approval.digest !== argsDigest) {
          reason = denialTextOf({
            errorFamily: 'approval',
            errorCode: 'approval-args-mismatch',
            message: ASK_APPROVAL_ARGS_MISMATCH + ' ' + execution.name,
          });
        }
        if (!reason) {
          const allowDec = decideAllowlist({
            toolName: execution.name,
            args: businessArgs,
            allowlist: allowlistConfig,
            // 票据与参数同源（digest 相符）才算"已批准"⇒ 走 allow；否则交回 decide 判 ask
            facts: { approval: approval !== null && approval.digest === argsDigest },
          });
          if (allowDec.decision === 'ask') {
            reason = denialTextOf({
              errorFamily: 'approval',
              errorCode: 'approval-needed',
              message: ASK_REQUIRED_409 + ' ' + execution.name,
            });
          } else if (allowDec.decision !== 'allow') {
            reason = denialTextOf({
              errorFamily: 'allowlist',
              errorCode: 'allowlist-not-permitted',
              message: allowDec.reason,
            });
          }
        }
      }
      if (reason) return reason;
      store.bumpExecCount(sessionId);
      return reason;
    });
  }
}