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
//   档位门 G1 / pendingBatch 清理 / lane 锁路径 / 执行型工具名单 / 派发面 owner 取值。
//   导出面经 `lib/tools/core.js` re-export 逐字保持（既有消费方零感知）。
import { join } from 'node:path';
import { isReadOnlyShellCall, SHELL_TOOLS } from './readonly.js';
// 批次终态判定**单点**（`lib/schema.js#isBatchTerminal`）：本批门禁 5 的「活跃批」判据复用该单点
//   （与 `lib/state/store/governance.js#hasActiveBatch` **同源**）——禁另造第二套活跃判定。
import * as schema from '../schema.js';
import {
  labelOf, evaluateTierCDispatch, // labelOf：既有导入（本批未增删其消费者；属既存未用项，按「精准修改」不清理）
  modeActiveFor, presetOfSession, MODE_INACTIVE_CODE,
} from '../engine/dispatch.js'; // 引擎自派（B1–B5 + P2 派发核心）+ C 阶段派发面门禁（软启用）+ D 阶段成员套件通信 + E 阶段模式跟随
import { parseLaneHandleFromText, verifyLaneHandle, textOfDispatchArgs } from '../bridge/lane-handle.js'; // 派发句柄（C 档派发唯一凭证）——本文件只用其**只读**面（档位门校验）；发放/消费随派发核心迁至 engine/dispatch.js（P2）

// N1-R4-1b：**派发面 owner 取值**（唯一来源 = 调用方 Agent 标识）。取不到 ⇒ `null` ⇒ `setMember` **零写入**
//   （既有行为不变）；这是刻意的 fail-open 边界：owner 是声明面，缺失只影响池视图，不阻断任何门禁。
export const ownerOfExec = (exec) => exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;

// （`WARN_EVENT_OF` 建批期告警码映射表随 `wave_plan` 迁至 `lib/tools/wave-plan-tools.js`：其唯一消费点。）

// 执行型工具名单（有副作用/写盘/派发执行）：guard 计数与拦截用；可被 config.escalation.execTools 覆盖
// 注：shell 类（pwsh/bash）的**只读命令**不属执行型动作——由 lib/tools/readonly.js 判定后放行（只读侦察面），
//   任何评估状态下都放行且不计数；名单语义本身不变（名单外即豁免）。
export const EXEC_TOOLS = [
  'pwsh', 'bash', 'write', 'edit', 'run_code', 'workflow', 'ralph',
  'ssh_exec', 'ssh_cluster', 'ssh_upload', 'ssh_download', 'subagent', 'subagent_fork',
];

// G1（**严格档**，后经 Q2=B 收窄）：**成员面动作只允许 C 档会话**——
//   ① 建批（`wave_plan`）；② 写成员状态（`member_status` / `member_settle`）。
//   **D 档并入**（Q-3=B / P-1，2026-10-01 裁决）：D = team 方案、与 C 同属集群建批档 ⇒ 同受本门。
//   （函数名保留 `assertMemberActionTierC` 不动：改名会牵动导入面与既有读端，属零收益改名。）
//   动机（用户口径，2026-09-14）：成员协作只有一条轨道——**Leader 先评 C → `wave_plan` 建批 → 建批即拉起 Manager →
//   由 Manager/Leader 调度、成员大规模并行**；**不是** Leader 以 A/B 档手工逐个 `subagent` 派单再手工 `member_status`
//   管状态——那既与并行执行模式相悖，又会让批次落在 worker 会话名下（归属错位）。
//   严格档：**未评估也拒**（必须先 `assign_check({ difficulty: 'C', rationale })`）；无默认档、无静默放行。
//   **2026-09-15 收窄（用户裁决 Q2=B：「成员仅会话，不可写状态」）**——**取消父档继承**：
//     · 建批：**只认本会话自己的 C 档**（worker / Manager 子会话一律建不了批；B 档仅单步独立任务，不入 wave_plan）；
//     · 成员状态：**本会话自己 C（Leader）** 或 **调用方会话 = 该批已登记的 Manager**（`batch.manager.agentId`，
//       判据来源 `lib/bridge/dispatch-register.js`：宿主 continuable 的 `subagentId = childId = 会话 id`，故登记值与
//       Manager 会话 id 同值）。**其余任何子会话（含 C 档父会话下的 exec worker）一律拒**。
export function assertMemberActionTierC(store, sessionId, exec, action, opts = {}, deps = null) {
  // E 阶段（模式跟随）先于 G1：本模式未启用蟛蜞治理 ⇒ 明确报「模式未启用」，而不是抛蟛蜞内部档位语义。
  if (deps) assertModeActive(deps, exec, action === 'batch' ? '建批（wave_plan）' : '写成员状态（member_status / member_settle）');
  const tierOf = (sid) => (sid ? (store.readGovernance(sid)?.lastAssign?.difficulty ?? null) : null);
  const code = action === 'batch' ? 'GATE_BATCH_REQUIRES_C' : 'GATE_MEMBER_REQUIRES_C';
  const what = action === 'batch' ? '建批（wave_plan）' : '写成员状态（member_status / member_settle）';
  const caller = exec?.agent?.session?.id ?? null;          // 调用方自己的会话（≠ 批归属会话）
  const own = tierOf(caller ?? sessionId);                  // 判据落在**调用方**，不落批归属会话（否则 worker 借 C 档批会话绕过）
  if (own === 'C' || own === 'D') return; // P-1：D 与 C 同属建批档
  const batchId = opts.batchId ?? null;
  if (action !== 'batch' && batchId) {
    const b = store.readBatch(sessionId, batchId);          // 批归属会话 = sessionOf(args, exec)
    if (b && b.manager && caller && b.manager.agentId === caller) return; // 该批已登记的 Manager 可写成员状态
  }
  throw new Error(code + ': ' + what + ' 只允许出现在 **C 档**会话（本会话档位 = ' + String(own ?? '未评估')
    + (caller && caller !== sessionId ? '，批归属会话 = ' + sessionId : '') + '）——'
    + '成员协作只有一条轨道：Leader 先 assign_check({ difficulty: "C" 或 "D", rationale }) 再 wave_plan 建批 → **建批即拉起 Manager** → '
    + '由 Manager/Leader 按批内流程派发与结算。**成员仅作为会话存在，不可写成员状态**（2026-09-15 用户裁决 Q2=B）；'
    + 'A/B 档 subagent 仅限「不占主上下文的调研」或「已明确上下文的单步派发」，不得承担成员施工、不得建批、不得写成员状态。');
}

// E 阶段（2026-09-16 用户裁决）：**全局装载、不全局生效**——插件运作跟随模式开关（config.modes.gate）。
//   读端一律走 readLiveConfig（热更快照），故 runtime.json 改 modes.gate 即热生效、无需重启。
//   「不生效」的三种形态：guard 全放行且不计数 / 套件工具拒 GATE_MODE_INACTIVE / 治理状态零写入。
export function readLiveConfig(deps) {
  try {
    const f = deps?.readConfig;
    const live = typeof f === 'function' ? f() : null;
    return live ?? deps?.config ?? {};
  } catch {
    return deps?.config ?? {};
  }
}

// 非生效模式的告警**每会话一次**（防刷屏；上限防无界增长）。返回 true 表示本次应打印。
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

// 清 pendingBatch（wave_plan 建批 / 批次 complete|aborted 后调用；无治理状态时不创建文件）
// session-compat：本会话曾把评估镜像到执行会话（mirroredTo）时，解锁同步传播到镜像会话，
// 避免 C@命名会话建批后，执行会话 guard 残留「先建批」幻觉锁
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


// 任务难度值门禁注册：guard 逻辑原样搬移自 lib/tools.js（一字不改），注册顺序保持现状（createTools 开头）
export function installDifficultyGuard(ctx, deps) {
  // 原此处绑定 `root: engineRoot` 并注释「供成员会话留痕写
  //   <root>/governance/member-session-trace.log」——该绑定**全函数未使用**、该日志面**未实现**（grep 零命中），
  //   属死绑定 + 错注释（误导后来者以为有该日志面）。已删；确实需要审计日志面时另立设计，不再挂在 guard 里。
  const { store, config = {} } = deps;
  // 任务难度值门禁（引擎强制不依赖自觉）：执行型工具前置 guard
  // 同步签名 (execution) => string | undefined；execution 含 name / agent.session.id；返回 string 即拒绝
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard((execution) => {
      // ② subagent 降级豁免（guard 开头）：subagent/subagent_fork 派发的 worker 会话
      //   （delegationDepth>0 或带 parentSession）继承 Leader 侧已评估的任务形态，难度门禁不重复评估——
      //   会话隔离（worker 无 Leader 侧 lastAssign）+ 同块并行时序下重复评估必然误拦。豁免仅限难度门禁，
      //   其余 guard 语义（EXEC_TOOLS 名单、计数）不受影响；Leader 会话（无 header）仍走完整门禁。
      const header = execution?.agent?.session?.header;
      if (header && (header.delegationDepth > 0 || header.parentSession)) return undefined;
      // ③′ session 解析对称：与 sessionOf 同序——execution.arguments.session 优先，缺省回退 agent.session.id。
      // 修复显式传 session 时评估（args.session 落点）与拦截（只认 agent.session）不同步导致的误拦
      const sessionId = execution?.arguments?.session ?? execution?.agent?.session?.id;
      if (!sessionId) return undefined;
      // ⓪′ 模式跟随（「全局装载、不全局生效」）：本模式不在 `config.modes.gate`
      //   白名单 ⇒ 难度门禁整体不介入——全放行且**不计数**（不写任何治理状态），其他模式零影响。
      //   判据缺省 = 全模式生效（向后兼容）；子会话继承父会话模式（见 dispatch.js modeActiveFor）。
      if (!modeActiveFor(readLiveConfig(deps), execution, (m) => {
        if (shouldNoteModeInactive(sessionId)) ctx.logger?.warn?.('[dsh-punky-swarm] ' + m);
      })) return undefined;
      const execTools = config?.escalation?.execTools ?? EXEC_TOOLS;
      // ① 非执行型：放行（治理/查询，防死锁）
      // ⚠ 治理工具豁免边界（明示）：
      //   - 豁免类别：治理/查询类工具（batch_status/gate_status/member_status/artifact_types/lane_checkpoint_status/
      //     lane_heartbeat 等不在 EXEC_TOOLS 名单者）+ 非执行型写（如 mailbox_read 读回执、assign_check 评估本身）。
      //   - 豁免理由：防死锁——难度门禁是「先评估后执行」的护栏，评估/查询动作若也被拦截将形成
      //     「评估→被拦→无法评估」死循环（worker 被派发后须先读状态再干活，读状态不能被门禁卡死）。
      //   - 豁免范围：仅限难度门禁（本 guard）；其余 guard 语义（EXEC_TOOLS 计数 bumpExecCount、
      //     执行型调用次数统计）不受影响——下方 store.bumpExecCount 仍对所有执行型调用计数。
      //   - 名单可覆盖：config.escalation.execTools 可增减执行型名单（名单外即豁免）。
      if (!execTools.includes(execution.name)) return undefined;
      // ⓪ 只读侦察面（对标梁神模式的两阶段锚定）：只读 shell 命令**不是执行型动作** ⇒ 任何评估状态下放行，
      //    且**不计数**（不占 stale 评估窗口）。动机 = 修「零信息评档」：评估前跑不了任何命令 ⇒ 只能凭猜
      //    取默认档 ⇒ C 建批错派。判定为**启发式、非沙箱**（边界与判定链见 lib/tools/readonly.js 头部声明）。
      // ⓠ D-6 常驻取证（2026-09-16）：shell 类工具被判**非只读**时打印一次参数形状（按会话去重）。
      //   动机：离线用同一命令原文判定为只读、活体却按执行型走（计数 +1 且未评估态会被拦）⇒
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
      // 门禁 1：从未评估 / 旧记录缺 difficulty（升级前写法，按未评估处理：宁严勿松）/ 已过期 → 要求先侦察再评估
      if (!g?.lastAssign?.form || !g?.lastAssign?.difficulty || store.stale(sessionId)) {
        reason = '[task-difficulty-gate] 本回合尚未进行任务难度评估（A/B/C/D）。**先用只读侦察摸清任务**'
          + '（read/glob/grep 与只读 shell 命令已开放），再 assign_check({ difficulty, rationale, scope: "full" })'
          + ' 写入难度与判据（判据必填，供审计），之后才能执行 ' + execution.name;
      } else if ((g.lastAssign.form === 'C' || g.lastAssign.form === 'D') && g.pendingBatch) {
        // 门禁 2：判 C/D 且未建批 → 拒绝执行型（必须先 wave_plan 建批）；D 与 C 同属建批档（P-1）
        reason = '[task-difficulty-gate] 任务难度=' + g.lastAssign.form + '（集群方案），必须先 wave_plan 建批。已直做产物用 asset_claim 归位，然后建批派发。（口径：C 判据是**多线并行或多依赖**；**单线程任务**应重评为 A/B 带上下文直做，不必建批；D = team 方案（建批档 + team 通道），同受本门 —— 通道面未落实（derivedChannel=dispatch）时，须先重评 durableSeats:true 或显式降级为 C，再建批。）';
      } else if ((execution.name === 'subagent' || execution.name === 'subagent_fork') && g.lastAssign.form === 'A') {
        // 门禁 3（一致性）：A 类不派发 subagent（需要独立上下文请重评 B）
        reason = '[task-difficulty-gate] A 类任务不派发 subagent；如确实需要独立上下文请重评 B。';
      }
      // 门禁 5（D 档通道一致性 · **Q-2 硬消费**，本批 `d-override-fix-20261011`；编号避开既有
      //   「门禁 4 = 派发面 lane 句柄留痕」——该支紧随本支之后，其编号与语义**逐字不动**）：D 的正当形态 ≡
      //   **建批档 + team 通道**（`derivedChannel='team'`，由 `assign_check({durableSeats:true})` 推出）⇒ 通道轴为
      //   `dispatch` 时本会话**不得开工**（先重评或显式降级为 C）。这是 `derivedChannel` 的**机器读端**（真消费端，
      //   非死声明——消 S-1「消费端空转」）。
      //   【门序】本支**必须**排在门禁 1/2/3 **之后**：门禁 1（未评估/过期）须先行，否则未评估态也会报通道错（误导）。
      //   【白名单（三条，供 audit 核）】
      //     ① `wave_plan`：**放行**——建批面自带正式判定（`lib/tools/wave-plan-tools.js` 的 D×通道硬拒），
      //        本支若也拦它即形成「拒建批 ⇒ 无法消解 ⇒ 死锁」；D 的通道面正是**靠建批**落地的。
      //     ② 只读面（`isReadOnlyShellCall`）：**已在 `:186` 先行放行**（本支到不了）；
      //     ③ 治理/查询类（`batch_status` / `gate_status` / `member_status` / `handoff_view` 等）：**本就不在
      //        `EXEC_TOOLS`**（`:165` 已先行放行）⇒ 本支对它们不可能生效。
      //   【已有 team 批则不拦】：该会话任一**活跃（非终态）**批的 `batch.channel ∈ {team,mixed}` ⇒ 通道事实已成立
      //     （真消费事实在场，避免与建批面口径冲突）。「活跃」判据复用 `schema.isBatchTerminal` 单点（与
      //     `store.hasActiveBatch` 同源），不另造第二套活跃判定。
      //   【缺省零破坏】旧 `governance.json` 无 `derivedChannel` ⇒ 严格等于 `'dispatch'` 不成立 ⇒ 本支不生效
      //     （旧记录不被误拦），与判据源「缺省读法」一致。
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
      // 门禁 4（派发面 · C 阶段，2026-09-16）：C 档下 `subagent`/`subagent_fork` 建议携带**有效 lane 句柄**；
      //   **B 档不受影响**（单步调研/单步派发）；A 档由门禁 3 拒（本判不重复）。
      //   **已改为只留痕不拦**，
      //   拒态随码删除（官方 agent-team profile 已 disable 宿主 `subagent`/`subagent_fork` ⇒ 官方场景下无拦截对象）。
      //   `dec.denyReason` 恒为 null（保留分支读法 = 结构不变，防读端漂移）；无句柄一律走 `warnNote` 留痕。
      //   句柄面：`lane_dispatch` 发放（一次性 + TTL）；引擎只读 `exec.arguments`，故句柄由任务包文本携带。
      if (!reason && (execution.name === 'subagent' || execution.name === 'subagent_fork')) {
        const dec = evaluateTierCDispatch({
          tier: g?.lastAssign?.difficulty ?? null,
          toolName: execution.name,
          argsText: textOfDispatchArgs(execution.arguments),
          config: readLiveConfig(deps), // N2 清债：档位×派发面门禁同样读**热更快照**（`dispatch.gate` 真热更）
          handleCheck: (t) => {
            const h = parseLaneHandleFromText(t);
            return h ? verifyLaneHandle(h.token, { batchId: h.batchId, lane: h.lane }) : { ok: false, reason: 'no-handle' };
          },
        });
        if (dec.denyReason) reason = dec.denyReason;
        else if (dec.warnNote) ctx.logger?.warn?.('[dsh-punky-swarm] ' + dec.warnNote);
      }
      store.bumpExecCount(sessionId); // 计数与拦截分离：无论是否拦截，执行型调用都计（机制 A 观察）
      return reason;
    });
  }
}