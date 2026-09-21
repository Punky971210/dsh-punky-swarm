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

// 蟛蜞模式治理核心工具（11 个），defineTool 规范含 output.schema + output.render
// 拆分自 lib/tools.js（core 域原样搬移，行为不变）
// 导出：createCoreTools(ctx, deps) => Array<defineTool>；installDifficultyGuard(ctx, deps)（难度门禁注册，原样搬移一字不改）
// 共享辅助（下沉至零依赖 shared.js）：TEXT_OUTPUT / sessionOf——本文件 re-export 保持对外导出兼容
//   （mailbox-tools/log-tools/lane-tools 已直引 shared.js；watch/lane-heartbeat 不再依赖 core.js）
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildWavePlan, validateWavePlan, normalizeAssemblyDecl, assemblyGate, handoffGateEnabledOf, handoffGateStateOf } from '../wave-plan.js';
import { resolveAssembly } from '../assembly.js';
import { resolveTeamRoles, unionRoleVocabulary, resolveTeamFlows, flowOf, packageRoot } from '../assembly/flows.js';
// 会话级临时团队资产根（teamsRoot）：加载期校验唯一入口（只读复用，不改 team-asset.js）
// P1（2026-09-16）追加读端：`teamAssetCandidates`（拒态文案点名候选路径）/ `TEAM_ASSET_SEVERITY`（挑首个 blocking 码原样透出）
import { loadTeamAsset, TEAM_ASSET_CODES, TEAM_ASSET_DIR, TEAM_ASSET_SEVERITY, teamAssetCandidates } from '../assembly/team-asset.js';
import { artifactTypesView } from '../artifact-types.js';
import * as lock from '../lock.js';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { isReadOnlyShellCall, SHELL_TOOLS } from './readonly.js';
// 悬挂成员告警**单点**（GAP-S3b 抽取；P3a control lane）：`batch_phase(aborted)` 与 `batch_control(abort)`
//   共用同一份实现（`lib/state/dangling.js`），禁第二份——判据与 `batch_status.danglingLanes` 同源。
import { warnAbortDangling, danglingLanesOf } from '../state/dangling.js';
// D6 批次级派生视图（只读投影）取**同源单点**：`laneStateOf`（lane 原始态）/ `isDanglingLane`（悬挂判定）
//   与 e1 探针（`lib/watch/lane-heartbeat.js`）**同一份实现、同一份语义**——不在本文件另写一套判定，
//   否则「同一 lane 的 state」会在工具面与探针面分裂（U-5 边界；依赖方向单向：core → watch，无环）。
import { laneStateOf, isDanglingLane } from '../watch/lane-heartbeat.js';
// 成员会话判定 + 只升不降档位（批次 `governance-member-isolation-20260915` · lane e2，规格 §2 规则 6/7）：
//   本文件的两处消费点（guard 的「成员只读继承」与 assign_check 的「跨会话写只升不降」）都调它，
//   禁在本文件另写一套判定（否则工具面与 guard 面的「谁是成员」会分裂——两套口径正是本批要修的缺陷）。
export { TEXT_OUTPUT, sessionOf }; // re-export：既有消费方（lib/tools/core.js 的 import 者）不受影响
// 事件字面量改引 EVT 常量单点（gate.role_* 发端）
import * as EVT from '../state/event-types.js';
import { parseLaneHandleFromText, verifyLaneHandle, textOfDispatchArgs } from '../bridge/lane-handle.js'; // 派发句柄（C 档派发唯一凭证）——本文件只用其**只读**面（档位门校验）；发放/消费随派发核心迁至 engine/dispatch.js（P2）
import {
  labelOf, evaluateTierCDispatch, // labelOf：既有导入（本批未增删其消费者；属既存未用项，按「精准修改」不清理）
  laneBindingOf, mailboxRootOf, REPORT_CHANNEL,
  modeActiveFor, presetOfSession, MODE_INACTIVE_CODE,
  dispatchLaneCore, // P2：派发核心（**唯一实现**：工具面 `lane_dispatch` 与链引擎自动推进共用）
  // 【已删 · 勿回加】`assertConcurrencyAdmit`（并发闸准入）：随 **Q-B 取消并发闸**（2026-09-18 用户裁决）删除——
  //   `member_status(status='running')` 直派面**不再做容量准入**（高并发不得被限流），
  //   故本文件对该导出**零引用**；`lib/engine/dispatch.js` 侧同批删除该导出（另一 lane 写域），两侧删齐即为终态。
} from '../engine/dispatch.js'; // 引擎自派（B1–B5 + P2 派发核心）+ C 阶段派发面门禁（软启用）+ D 阶段成员套件通信 + E 阶段模式跟随
// P2 推进链：① `chain` 声明八条静态校验（纯函数，构造期原样透出码面）；② 事件驱动自动推进；③ 读端回显投影
import { chainProblemsOf, chainOfBatch, chainEchoOf } from '../assembly/chain.js';
import { isMemberTerminal } from '../schema.js'; // N1-R4-1a：公共池「上游是否已结算」判据（终态单一真源，勿另写）

// N1-R4-1b：**派发面 owner 取值**（唯一来源 = 调用方 Agent 标识）。取不到 ⇒ `null` ⇒ `setMember` **零写入**
//   （既有行为不变）；这是刻意的 fail-open 边界：owner 是声明面，缺失只影响池视图，不阻断任何门禁。
const ownerOfExec = (exec) => exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;
// 【已清退 · 勿回加】`advanceChainAfterSettle`（`lib/engine/chain-runner.js`）的调用随 **G-02 死调用清退**
//   （批次 `engine-debt-cleanup-2-20260918`）一并删除：链推进已全退役（2026-09-18 Q-A=C）⇒ 该调用**零行为**，
//   结算后不再触发推进；推进缺口与 `chain.step` 冻结语义见 `lib/engine/chain-runner.js` 头注释。
// P3a 自动结算（规格 §2/§3）：**单点判定**（`lib/engine/auto-settle.js`）——本文件只用其兼底路入口
//   （`swarm_report(type='settle-request')` 显式交付意图）；主路 `subagent/end` 的装配期订阅在 `lib/index.js`，
//   两路共用同一判定函数（禁第二套口径）。
import { autoSettleLane, AUTO_SETTLE_TRIGGERS } from '../engine/auto-settle.js';
import * as swarmMailbox from '../comms/mailbox.js'; // 成员回报投递（文件 mailbox）

// 建批期告警码 → 事件 type 映射表（GAP-S9）：`wave_plan` 的告警事件化**按码映射**，不再把「非
//   `GATE_ROLE_MISSING`」的一切告警都事件化成 `gate.role_invalid`（后者会把 `GATE_COMPLETE_OUTCOMES_EMPTY`
//   误标成「role 非法」——载荷 `code` 正确、事件 type 误导读端）。
// 未命中映射的码**保持现状 = `EVT_GATE_ROLE_INVALID`**（向后兼容：`GATE_AUDIT_CONTRACT_EXEMPT` /
//   `GATE_SKILL_MISSING` 等既有码的事件 type 不迁移，避免既有断言与外部消费者漂移）。GAP-S9 残留：未来
//   把每个告警码都映射到专用类型（本任务不迁移）。
const WARN_EVENT_OF = {
  GATE_ROLE_MISSING: EVT.EVT_GATE_ROLE_MISSING,
  GATE_COMPLETE_OUTCOMES_EMPTY: EVT.EVT_GATE_COMPLETE_OUTCOMES_EMPTY,
};

// 执行型工具名单（有副作用/写盘/派发执行）：guard 计数与拦截用；可被 config.escalation.execTools 覆盖
// 注：shell 类（pwsh/bash）的**只读命令**不属执行型动作——由 lib/tools/readonly.js 判定后放行（只读侦察面），
//   任何评估状态下都放行且不计数；名单语义本身不变（名单外即豁免）。
export const EXEC_TOOLS = [
  'pwsh', 'bash', 'write', 'edit', 'run_code', 'workflow', 'ralph',
  'ssh_exec', 'ssh_cluster', 'ssh_upload', 'ssh_download', 'subagent', 'subagent_fork',
];

// G1（2026-09-14 用户裁决 B，**严格档**；2026-09-15 用户裁决 **Q2=B 收窄**）：**成员面动作只允许 C 档会话**——
//   ① 建批（`wave_plan`）；② 写成员状态（`member_status` / `member_settle`）。
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
  if (own === 'C') return;
  const batchId = opts.batchId ?? null;
  if (action !== 'batch' && batchId) {
    const b = store.readBatch(sessionId, batchId);          // 批归属会话 = sessionOf(args, exec)
    if (b && b.manager && caller && b.manager.agentId === caller) return; // 该批已登记的 Manager 可写成员状态
  }
  throw new Error(code + ': ' + what + ' 只允许出现在 **C 档**会话（本会话档位 = ' + String(own ?? '未评估')
    + (caller && caller !== sessionId ? '，批归属会话 = ' + sessionId : '') + '）——'
    + '成员协作只有一条轨道：Leader 先 assign_check({ difficulty: "C", rationale }) 再 wave_plan 建批 → **建批即拉起 Manager** → '
    + '由 Manager/Leader 按批内流程派发与结算。**成员仅作为会话存在，不可写成员状态**（2026-09-15 用户裁决 Q2=B）；'
    + 'A/B 档 subagent 仅限「不占主上下文的调研」或「已明确上下文的单步派发」，不得承担成员施工、不得建批、不得写成员状态。');
}

// E 阶段（2026-09-16 用户裁决）：**全局装载、不全局生效**——插件运作跟随模式开关（config.modes.gate）。
//   读端一律走 readLiveConfig（热更快照），故 runtime.json 改 modes.gate 即热生效、无需重启。
//   「不生效」的三种形态：guard 全放行且不计数 / 套件工具拒 GATE_MODE_INACTIVE / 治理状态零写入。
function readLiveConfig(deps) {
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
function clearPendingBatch(store, sessionId) {
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
  // N8 清债（2026-09-16 评审）：原此处绑定 `root: engineRoot` 并注释「供成员会话留痕写
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
      // ⓪′ 模式跟随（E 阶段，2026-09-16 用户裁决「全局装载、不全局生效」）：本模式不在 `config.modes.gate`
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
        reason = '[task-difficulty-gate] 本回合尚未进行任务难度评估（A/B/C）。**先用只读侦察摸清任务**'
          + '（read/glob/grep 与只读 shell 命令已开放），再 assign_check({ difficulty, rationale, scope: "full" })'
          + ' 写入难度与判据（判据必填，供审计），之后才能执行 ' + execution.name;
      } else if (g.lastAssign.form === 'C' && g.pendingBatch) {
        // 门禁 2：判 C 且未建批 → 拒绝执行型（必须先 wave_plan 建批）
        reason = '[task-difficulty-gate] 任务难度=C（集群方案），必须先 wave_plan 建批。已直做产物用 asset_claim 归位，然后建批派发。（口径：C 判据是**多线并行或多依赖**；**单线程任务**应重评为 A/B 带上下文直做，不必建批。）';
      } else if ((execution.name === 'subagent' || execution.name === 'subagent_fork') && g.lastAssign.form === 'A') {
        // 门禁 3（一致性）：A 类不派发 subagent（需要独立上下文请重评 B）
        reason = '[task-difficulty-gate] A 类任务不派发 subagent；如确实需要独立上下文请重评 B。';
      }
      // 门禁 4（派发面 · C 阶段，2026-09-16）：C 档下 `subagent`/`subagent_fork` 建议携带**有效 lane 句柄**；
      //   **B 档不受影响**（单步调研/单步派发）；A 档由门禁 3 拒（本判不重复）。
      //   【gate-lite 第二批 · B（2026-09-17 用户裁决）】**已改为只留痕不拦**：原 `GATE_SUBAGENT_OUTSIDE_LANES`
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

// ── 会话级临时团队资产根（teamsRoot）：词法/防逃逸 + 资产加载期校验 ───────────────
// 契约：`wave_plan` 显式给出 `teamsRoot` 时，团队资产根**替换**为 `<teamsRoot>/presets/<team>/`
//   （loader 口径 TEAM_ASSET_DIR='presets'）；**不回落**包内 `presets/`，也不走 legacy 兜底——
//   资产缺失 → GATE_TEAMS_ROOT_ASSET_NOT_FOUND；资产非法 → 原样透出原始 `TEAM_ASSET_*` 码；
//   `teamsRoot` / `team` 本身非法 → GATE_TEAMS_ROOT_INVALID。三者一律 **throw 拒建批**（fail-closed）。
// 判定位置理由：`resolveAssembly` 自身失败**不抛错**（按引擎基线处理——legacy 间接层已于 2026-09-15 完全清退），故「不静默回落」只能在此层完成。
// 顺序不可调换：① 词法/防逃逸（封堵 join 逃逸面）→ ② 资产加载期校验 → ③ 才进 resolve/build。
const TEAM_NAME_RE = /^[a-z][a-z0-9-]*$/; // 口径同 team-asset 的 ROLE_EXTRA_RE（kebab-case）

// ① teamsRoot 词法/防逃逸：非空字符串 + 绝对路径 + 不含 `..` 段；team 名过 kebab-case 白名单
//   （防 `join(root,'presets',team)` 逃逸：禁 `/`、`\`、`..`、空白、绝对路径片段）
export function assertTeamsRootLexical(team, teamsRoot) {
  if (typeof teamsRoot !== 'string' || teamsRoot.trim().length === 0) {
    throw new Error('GATE_TEAMS_ROOT_INVALID: teamsRoot must be a non-empty absolute path string (got: ' + JSON.stringify(teamsRoot ?? null) + ')');
  }
  if (teamsRoot.split(/[\\/]+/).includes('..')) {
    throw new Error('GATE_TEAMS_ROOT_INVALID: teamsRoot must not contain a ".." path segment (got: ' + teamsRoot + ')');
  }
  if (!isAbsolute(teamsRoot)) {
    throw new Error('GATE_TEAMS_ROOT_INVALID: teamsRoot must be an absolute path (got: ' + teamsRoot + ')');
  }
  if (typeof team !== 'string' || !TEAM_NAME_RE.test(team)) {
    throw new Error('GATE_TEAMS_ROOT_INVALID: team must match ' + TEAM_NAME_RE.source + ' when teamsRoot is given (got: ' + JSON.stringify(team ?? null) + ')');
  }
  return resolve(teamsRoot);
}

// ② 资产加载期校验（显式 teamsRoot 时）：缺失 → 新码；存在但非法 → 原样透出 TEAM_ASSET_* 码；不回落
function assertTeamsRootAsset(root, team) {
  const dir = join(root, TEAM_ASSET_DIR, team);
  const r = loadTeamAsset(root, team);
  if (!r.ok) {
    const problems = r.problems ?? [];
    if (problems.some((p) => p.code === TEAM_ASSET_CODES.NOT_FOUND)) {
      throw new Error('GATE_TEAMS_ROOT_ASSET_NOT_FOUND: no team asset under ' + dir + ' (expected team-asset.json / team-asset.yml; explicit teamsRoot does not fall back to the packaged presets/)');
    }
    const p = problems[0] ?? { code: TEAM_ASSET_CODES.NOT_FOUND, path: dir, message: 'team asset rejected without a problem entry' };
    throw new Error(p.code + ': ' + (p.path ? p.path + ' — ' : '') + p.message + ' (temporary team asset rejected; explicit teamsRoot does not fall back to the packaged presets/)');
  }
  // 前缀断言（双保险）：解析出的资产路径必须落在 <teamsRoot>/presets/<team>/ 之内
  const rel = relative(dir, r.path ?? '');
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('GATE_TEAMS_ROOT_INVALID: resolved team asset path escapes the temporary team dir (got: ' + String(r.path) + ', expected under: ' + dir + ')');
  }
  return r;
}

// 校验总入口：显式 teamsRoot 时返回规范化根（供 resolve/build 面**同源**使用）
export function resolveTeamsRootOption(team, teamsRoot) {
  const root = assertTeamsRootLexical(team, teamsRoot);
  assertTeamsRootAsset(root, team);
  return root;
}

// ── P1（2026-09-16，批次 p1-team-asset-mandatory-20260916）：团队资产**必填化** ──────────────
// 规格：`plan/spec.md` §1/§2/§3。**构造期拒的唯一落点 = 本工具 `wave_plan.execute` 前置段**
//   （`createBatch` 之前 throw ⇒ 拒后零批次 JSON 落盘、`pendingBatch` 不释放 ⇒ 补声明可重试）。
// 判定序（全 fail-closed，顺序不可调换——与 spec §1「判定序」逐条对齐）：
//   ① `team` 词法/必填（缺失/空串 ⇒ `TEAM_ASSET_MISSING_FIELD`；`generic` 已废除 ⇒ `TEAM_ASSET_NOT_FOUND`）
//   ② 资产加载 + 加载期不变量（无资产 ⇒ `TEAM_ASSET_NOT_FOUND`；非法 ⇒ **首个 blocking 码原样透出**）
//   ③ 资产 `layers.*.skills` **可解析**（宿主技能根不可用 ⇒ fail-closed **同码拒** `TEAM_ASSET_SKILLS_MISMATCH`）
//   ④ 才进 `buildWavePlan` / `createBatch`
// 码面**零新造**：一律复用 `lib/assembly/team-asset.js` 既有 `TEAM_ASSET_*` 码（不新码、不改码）。
// 命名空间消歧（Leader 口径 2026-09-16）：`presets/<team>/team-asset.{json,yml}` = **团队资产**（team 取值面）；
//   `presets/punky-preset/` = **预设（模式）资产**（`agent.cordis.yml` / `references/` …），**不是团队资产**——
//   故 `team:'punky-preset'` 属「无资产 ⇒ 拒」（本机实测该目录无 `team-asset.yml`），拒态文案必须点明此区别。
// 作用域：只保证**工具面**（本工具）。直调 `buildWavePlan` 不走同一门 = **已登记差异 W-2**，P1 **不消**（超范围）。
const RETIRED_TEAM_NAME = 'generic'; // 已废除的旧缺省团队名（P1 前读端兜底值；现建批面显式拒）

/** 宿主技能根：`USERPROFILE || HOME` + `.agents/skills`（与建批期 `GATE_SKILL_MISSING` 判定**同源**，不新增 env）。 */
export function hostSkillsRoot() {
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? join(home, '.agents', 'skills') : null;
}

/**
 * 宿主技能根的可解析名集合：技能**目录名** ∪ 各 `SKILL.md` frontmatter 的 `name`（加载名，二者常不一致）。
 * `ok:false` = 技能根**不存在 / 不可读** —— 这是 **fail-closed 信号**：调用方**不得**当作「无缺失」放行
 * （P1 §3 / D-2：技能根不可用 ⇒ 同码拒 `TEAM_ASSET_SKILLS_MISMATCH`，不放行、不静默跳过）。
 * 本函数是「技能可解析面」的**单一实现**：构造期 skills 门与 `GATE_SKILL_MISSING` 告警共用，禁各写一套。
 * @returns {{ ok: boolean, reason: string|null, root: string|null, known: Set<string> }}
 */
function resolvableSkillNames() {
  const skillsRoot = hostSkillsRoot();
  if (!skillsRoot || !existsSync(skillsRoot)) {
    return { ok: false, reason: 'skills-root-missing', root: skillsRoot, known: new Set() };
  }
  const known = new Set();
  try {
    for (const d of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      known.add(d.name);
      const md = join(skillsRoot, d.name, 'SKILL.md');
      if (!existsSync(md)) continue;
      try {
        const head = readFileSync(md, 'utf8').slice(0, 400); // 只读头部取 frontmatter
        const m = head.match(/^name:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m);
        if (m) known.add(m[1]);
      } catch { /* 单文件读取失败忽略 */ }
    }
  } catch {
    return { ok: false, reason: 'skills-root-unreadable', root: skillsRoot, known };
  }
  return { ok: true, reason: null, root: skillsRoot, known };
}

/** 资产声明的全部技能名（各层 × 各 role，去重）；**按资产面**判可解析（`config.assembly` 覆盖层不属资产）。 */
function declaredSkillNamesOf(asset) {
  const out = new Set();
  const layers = asset && typeof asset === 'object' && asset.layers && typeof asset.layers === 'object' ? asset.layers : {};
  for (const def of Object.values(layers)) {
    const skills = def && typeof def === 'object' ? def.skills : null;
    if (!skills || typeof skills !== 'object') continue;
    for (const arr of Object.values(skills)) {
      for (const s of Array.isArray(arr) ? arr : []) if (typeof s === 'string' && s.length > 0) out.add(s);
    }
  }
  return [...out];
}

/**
 * 本包内**有资产**的团队名（供拒态文案给可自救替代项；扫不到 ⇒ `[]`，文案退为通用指引）。
 * 判据自真源：`presets/<team>/team-asset.{json,yml}`（`teamAssetCandidates` 同源，通配写作 `presets/<any-team>/`），不硬编码清单（防漂移）。
 * 可测性（Leader 口径）：枚举结果**必然 ⊆** 实际存在 `team-asset.*` 的 `presets/*` 目录。
 */
function packagedTeamsWithAsset(root = packageRoot()) {
  try {
    const dir = join(root, TEAM_ASSET_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => teamAssetCandidates(root, name).some((p) => existsSync(p)))
      .sort();
  } catch {
    return [];
  }
}

/** 拒态自救指引（三条同类拒**文案风格统一**：点名原因 → 给替代 → 消歧两个命名空间）。 */
function teamRecoveryHint(root) {
  const teams = packagedTeamsWithAsset(root);
  const head = '团队必须有**团队资产** `presets/<team>/team-asset.{json,yml}`'
    + '（`presets/punky-preset/` 是**预设（模式）资产**——`agent.cordis.yml`/`references/`——**不是团队资产**，不可当 team 名使用）';
  if (teams.length > 0) {
    return head + '；当前实际可解析团队（运行时枚举）：' + teams.join(' / ') + '；会话级临时团队请用 `teamsRoot` 提供资产。';
  }
  return head + '；本包内**当前未发现任何团队资产**（`presets/*/team-asset.{json,yml}` 零命中）——请新增该团队资产，或用 `teamsRoot` 提供临时团队资产。';
}

/**
 * P1 判定 ①：`team` 词法/必填（缺失/空串 ⇒ `TEAM_ASSET_MISSING_FIELD`；`generic` 已废除 ⇒ `TEAM_ASSET_NOT_FOUND`）。
 * 单独导出以便**判定序**可读：本步先于 teamsRoot 面（否则缺 `team` 时会先落 `GATE_TEAMS_ROOT_*`，与 spec §2 码表不符）。
 */
export function assertTeamNameRequired(team) {
  if (typeof team !== 'string' || team.trim().length === 0) {
    throw new Error(TEAM_ASSET_CODES.MISSING_FIELD + ': team 必填（非空字符串）——建批必须显式声明团队；'
      + teamRecoveryHint(packageRoot()));
  }
  if (team.trim() === RETIRED_TEAM_NAME) {
    throw new Error(TEAM_ASSET_CODES.NOT_FOUND + ': team "' + RETIRED_TEAM_NAME + '" 已废除'
      + '（P1，2026-09-16：取消缺省团队名，读端 `?? \'generic\'` 兜底同批清退）——'
      + '建批必须声明**有资产**的团队；' + teamRecoveryHint(packageRoot()));
  }
  return team.trim();
}

/**
 * P1 判定 ②③：资产加载 + 加载期不变量 + `skills` 可解析（全 fail-closed；throw 于 `createBatch` 之前）。
 * @param team 团队名（应先过 `assertTeamNameRequired`；本函数亦**幂等复检**，直调亦安全）
 * @param root 资产根：packaged 面 = `packageRoot()`；`teamsRoot` 面 = 规范化后的临时根
 * @returns 已加载的资产对象（`loadTeamAsset().asset`）
 */
export function assertTeamAssetReady(team, { root = packageRoot() } = {}) {
  const name = assertTeamNameRequired(team);
  // ② 资产加载 + 加载期不变量：无资产 ⇒ NOT_FOUND；非法 ⇒ 首个 blocking 码**原样透出**（零新造码）
  const r = loadTeamAsset(root, name);
  const problems = Array.isArray(r.problems) ? r.problems : [];
  const candidates = teamAssetCandidates(root, name);
  if (problems.some((p) => p && p.code === TEAM_ASSET_CODES.NOT_FOUND)) {
    throw new Error(TEAM_ASSET_CODES.NOT_FOUND + ': team "' + name + '" 解析不到团队资产（候选：'
      + candidates.join(' | ') + '）——' + teamRecoveryHint(root));
  }
  if (!r.ok || !r.asset) {
    const p = problems.find((x) => x && x.severity === TEAM_ASSET_SEVERITY.blocking)
      ?? problems[0]
      ?? { code: TEAM_ASSET_CODES.NOT_FOUND, path: candidates.join(' | '), message: '团队资产被拒但无 problem 条目' };
    throw new Error(p.code + ': ' + (p.path ? p.path + ' — ' : '') + p.message
      + '（团队资产非法 ⇒ 构造期拒建批；请修好资产后重试，拒后零批次落盘）');
  }
  // ③ skills 可解析（D-2 fail-closed：技能根不存在/不可读 ⇒ 同码拒）
  const declared = declaredSkillNamesOf(r.asset);
  if (declared.length > 0) {
    const at = 'layers.*.skills（团队 "' + name + '"）';
    const res = resolvableSkillNames();
    if (!res.ok) {
      throw new Error(TEAM_ASSET_CODES.SKILLS_MISMATCH + ': ' + at + ' 无法校验——宿主技能根'
        + (res.root ? ' `' + res.root + '` ' : '（`USERPROFILE`/`HOME` 未设置）')
        + (res.reason === 'skills-root-missing' ? '不存在' : '不可读')
        + ' ⇒ fail-closed 同码拒（不放行、不静默跳过）；请确认宿主技能根可读后重试。');
    }
    const missing = declared.filter((n) => !res.known.has(n));
    if (missing.length > 0) {
      throw new Error(TEAM_ASSET_CODES.SKILLS_MISMATCH + ': ' + at + ' 声明的技能在宿主技能根不可解析：'
        + missing.join(', ') + '（技能根 `' + res.root + '`；可解析名 = 目录名 ∪ SKILL.md frontmatter `name`）'
        + ' ——请改用可加载的技能名，或从团队资产中移除该技能。');
    }
  }
  return r.asset;
}

/**
 * P2 推进链的**构造期强制点**（`wave_plan`；`createBatch` 之前 ⇒ 拒后零批次 JSON 落盘）。
 * 判据 = `lib/assembly/chain.js` 的八条静态校验（纯函数，**零新造码**：逐条复用既有 `TEAM_ASSET_*`）。
 * 无 `chain` 声明 ⇒ 放行（R5 向后兼容锁：无链 = 无推进，行为逐字不变）。
 * 首个问题**原样透出**码面（与 `assertTeamAssetReady` 同形的 fail-closed 形态，便于反例用例逐码断言）。
 * 为何不折进 `validateTeamAsset`：那里的码面按 `BLOCKING_CODES` 分严重级，而本组码里
 * `TEAM_ASSET_LEAD_NOT_IN_LAYERS` / `TEAM_ASSET_REWORK_INVALID` 是 warning 级 —— 折进去会让同一份声明
 * 经两条严重级通道重复报告；本函数是**单一强制点**（详见 `lib/assembly/chain.js` 头注释「加载期口径」）。
 */
export function assertChainReady(team, { root = packageRoot() } = {}) {
  const r = loadTeamAsset(root, team);
  if (!r.ok || !r.asset) return null; // 资产本身不可用 ⇒ 由 `assertTeamAssetReady` 报（不重复报码）
  const c = chainProblemsOf(r.asset);
  if (!c.ok && c.chain != null) {
    const p = c.problems.find((x) => x && x.severity === TEAM_ASSET_SEVERITY.blocking) ?? c.problems[0];
    throw new Error(p.code + ': ' + (p.path ? p.path + ' — ' : '') + p.message
      + '（团队 "' + team + '" 的 `chain` 声明非法 ⇒ 构造期拒建批、零批次 JSON 落盘；'
      + '链校验共 8 条，详见 lib/assembly/chain.js 头注释）');
  }
  return c.chain;
}

// ── gate-lite Q-G2（2026-09-17 用户裁决：「**删除这一项**」）：成员回报**目标解析**（身份门已删） ──────
// 背景（普查 `docs/gate-census-20260917.md` + 本轮实测）：官方 Team 成员由宿主 `spawn_teammate` 拉起，
//   **天然无 `member.dispatch` 绑定** ⇒ 「未绑定」是该场景的**常态**而非异常；原
//   `GATE_SWARM_UNBOUND_REPORT` 把常态当拒绝（实测命中：`replay-lock` / `asset-chain` 两个官方成员的回报）。
// 现口径 = **不再拒**，改 best-effort 解析（不猜批次、不静默）：
//   ① 有 dispatch 绑定 ⇒ 既有路径逐字不变（owner 会话 + 绑定批次 + 绑定 lane）；
//   ② 无绑定 ⇒ 目标批次由调用方**显式** `batchId` 给出（可选参数，缺省即无批次面），归属会话取宿主父会话
//      （官方成员的 Leader 会话）→ 本会话兜底；`lane` 缺省 `(unbound)` 仅作展示占位。
// 消息**照发**（Leader / Manager 通道 mailbox 落盘；未绑定时批次键 `(unbound)`，读端仍可见文件）；
//   批次事件**仅在目标批次真实存在时**可写（无批次文件即无事件面）——失败不回滚、不抛、不静默：
//   回显 `eventWritten:false` + `notice`，使「消息已投递 / 事件未落」这一真实状态对调用方与审计都可见。
const UNBOUND_BATCH_KEY = '(unbound)';
const UNBOUND_LANE_KEY = '(unbound)';

function reportTargetOf(store, exec, args) {
  const caller = exec?.agent?.session?.id ?? null;
  const bind = laneBindingOf(store, caller);
  const declaredBatchId = typeof args?.batchId === 'string' && args.batchId.trim() ? args.batchId.trim() : null;
  const declaredLane = typeof args?.lane === 'string' && args.lane.trim() ? args.lane.trim() : null;
  if (bind) {
    return { caller, bound: true, sessionId: bind.sessionId, batchId: declaredBatchId ?? bind.batchId, lane: declaredLane ?? bind.lane };
  }
  return {
    caller, bound: false,
    sessionId: exec?.agent?.session?.header?.parentSession ?? caller,
    batchId: declaredBatchId,
    lane: declaredLane ?? UNBOUND_LANE_KEY,
  };
}

/** 投递成员消息（无 sessionId ⇒ 无处可投，回 false，绝不抛——Q-G2「不再因身份未绑定而拒」）。 */
function deliverSwarmMessage(root, tgt, box, args, kind) {
  if (!tgt.sessionId) return false;
  swarmMailbox.send(mailboxRootOf(root, tgt.sessionId, tgt.batchId ?? UNBOUND_BATCH_KEY), { type: box },
    { lane: tgt.lane, kind, summary: args.summary, artifactPath: args.artifactPath ?? null, from: tgt.caller, unbound: !tgt.bound });
  return true;
}

/** 批次事件留痕（唯一写路径 = store.appendEvent）：批次不可解析/已损坏 ⇒ 回 false（消息已投递，事件面如实回显）。 */
function appendSwarmEventOf(store, tgt, evtType, kind) {
  if (!tgt.batchId || !tgt.sessionId) return false;
  try {
    store.appendEvent(tgt.sessionId, tgt.batchId, evtType, { lane: tgt.lane, kind, unbound: !tgt.bound });
    return true;
  } catch {
    return false;
  }
}

// ── gate-lite 第二批 · A2：Manager「在册」判定的**官方 roster 承抽**读端 ──────────────────
// 设计四问的完整论证见产出文档 §A；此处是**唯一实现**（禁第二套判定）：
//   ① 映射口径：Manager = 官方 Team roster 中**具名成员**，约定名 `manager`（lower-kebab-case，
//      满足 `spawn_teammate` 的 name 约束）。官方 roster 行形状 `TeamMemberView`（`role:'lead'|'teammate'`）
//      **没有 manager role 枚举** ⇒ 只能**按约定名判**（显式取舍，写进文档）；Lead 伪行为 `name:'lead'`
//      （官方 `roster.list` 首行 ❰dsh-experimental-agent-team/lib/index.js:439-446❱）⇒ 不会与 Manager 撞名。
//   ② 判据 API：`agentTeams.listMembers(agent)`（宿主 service 名 `agentTeams`，官方注册 `lib/index.js:1680`
//      `super(ctx, "agentTeams")`、实现 `:1731`；typert 契约 `lib/typert.host.js:231`
//      `listMembers(agent: Agent): TeamMemberView[]`）。凭据 = **live Team member 的 agent**（传 `exec.agent`）。
//   ③ 取用口：cordis `ctx.get('agentTeams')` —— 官方语义「Read a service from the store **without the inject
//      requirement** … returns the service value, or **undefined** when not (yet) provided」
//      （`@deepseek-ai/cordis/lib/types/reflect.d.ts:6-16` / 实现 `lib/index.js:754-771`）⇒ **不在本插件
//      `inject` 里加硬依赖**（加硬 inject 会使本插件在**未挂官方 team 插件**的宿主上失去加载能力）。
//   ④ 降级（禁静默，四级可辨）：service 不可用 ⇒ `reason:'service-unavailable'`（非官方宿主**基线态**，
//      由回显承担可读性）；调用抛错（调用方非 Team 成员等）⇒ `reason:'not-a-team-member: …'`（异常态，
//      上抛 `logger.warn` + 回显）；roster 可读但无该成员 ⇒ `inRoster:false`（本批事实 ⇒ **落
//      `gate.manager_roster_gap` 事件**）；命中 ⇒ `inRoster:true` + `member` 行（id/name/role/status）。
//   **本判定不拒任何调用**（Manager 四码按用户裁决整体删除后无拒态；读端只回显事实）。
const MANAGER_ROSTER_NAME = 'manager';
function managerRosterOf(ctx, exec) {
  let svc = null;
  try { svc = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : null; } catch { svc = null; }
  if (!svc || typeof svc.listMembers !== 'function') {
    return { ok: false, source: 'roster', inRoster: false, reason: 'service-unavailable', rosterName: MANAGER_ROSTER_NAME };
  }
  let rows = null;
  try { rows = svc.listMembers(exec?.agent); } catch (e) {
    return { ok: false, source: 'roster', inRoster: false, reason: 'not-a-team-member: ' + String(e?.message ?? e), rosterName: MANAGER_ROSTER_NAME };
  }
  const list = Array.isArray(rows) ? rows : [];
  const hit = list.find((m) => m && m.name === MANAGER_ROSTER_NAME) ?? null;
  return {
    ok: true, source: 'roster', inRoster: !!hit, rosterName: MANAGER_ROSTER_NAME, memberCount: list.length,
    member: hit ? { id: hit.id ?? null, name: hit.name, role: hit.role ?? null, status: hit.status ?? null } : null,
  };
}

/** Manager 读端**统一形态**（roster 承抽）：官方 roster 优先，批次 legacy 字段（`batch.manager`）并列回显。 */
function managerViewOf(ctx, exec, batch) {
  const roster = managerRosterOf(ctx, exec);
  const legacy = batch && batch.manager ? { agentId: batch.manager.agentId ?? null, raisedAt: batch.manager.raisedAt ?? null } : null;
  return { roster, legacy, managerPlan: batch?.assembly?.managerPlan ?? null };
}

// ── P2-B（2026-09-17）：**legacy 标注**（用户裁决 Q2 暂缓 ⇒ **只标注不改行为**）────────────────────
// 事实（`docs/member-governance-redesign-20260917.md` §7.1 事实分工）：**成员身份/状态的真源 = 官方 roster（5 态）**；
//   引擎的 `member.*` **八态**（`pending/running/review/merged/failed/skipped/conflict/idle`）是**引擎侧投影**，
//   `member.settled` / `member_status` / `member_settle` 写的是这八态 ⇒ 一律**标 legacy**（不改判定、不删字段、
//   不新增事件；仅回显面标注，使读端能看出「这是引擎投影、非官方真源」）。
// 回显纪律（禁静默）：`batch_status` 单批与列表两形态**都带**标注键，且 `source` 二值可辨（`engine` = 引擎投影 /
//   `roster` = 官方真源）——`P2-B` 只做标注，真正的状态来源切换归后续批次（Q2 暂缓）。
const MERGE_STATE_SOURCE = {
  engine: 'engine', // 引擎侧 `member.*` 八态投影（legacy 标注对象）
  roster: 'roster', // 官方 roster 5 态（成员身份/状态真源）
};
const MEMBER_STATES_LEGACY = true; // 八态 = legacy 投影；真源 = 官方 roster 5 态

export function createCoreTools(ctx, deps) {
  const { store, root, config = {} } = deps;
  // P1 交接门工具面（`handoff_submit` / `handoff_view`）：**恒注册（常驻）**——「**工具是机制、门是策略**」：
  //   机制不随策略开关出现/消失（`task-22` 裁决 ②）。收益：门关闭的休眠期也能积累
  //   真实交接数据（翻牌时以证据决策），且下游取件面（`handoff_view`）始终可用。
  //   开关经**唯一解析点** `lib/wave-plan.js#handoffGateEnabledOf`（真源 = `<root>/config/runtime.json` 的
  //   `gates.handoff.*`；env 仅兜底）只控制 entry 门**拦不拦**，不再控制工具**有没有**。
  //   族位：`handoff_submit` = `comms`（成员面，**不落模式门**——交接是生产者的动作，引擎要第一手声明；
  //   形态对齐 `swarm_report`）；`handoff_view` = `read`（成员可用）。见 `lib/engine/suite.js`。

  return [
    defineTool({
      name: "wave_plan",      description: "把任务按 DAG 依赖分层为 waves 并持久化为批次（wavePlan 固定语义，绝不在中途重算）。Tier3：任务可声明 layer(plan/exec/audit)/consume/produce/outputs/role/skills，建批时做三层契约静态校验；team 装配按 role 注入 skill 前缀（可插拔，不绑定 punky-preset）。【P1 · 2026-09-16】`team` **必填且必须有资产**：无资产（含已废除的 `generic`）/资产非法/资产 `skills` 在宿主技能根不可解析 ⇒ **构造期拒建批**（复用既有 `TEAM_ASSET_*` 码、零批次落盘、`pendingBatch` 保留可补声明重试）。**含 audit 层的三层批**建批必须携带批次级装配声明 assembly：{ managerPlan?: 'raise'|'leader-direct'（**缺省 raise**）, auditLane: '<audit lane id>', coordinatorLane?, roles? }——缺失/结构非法/悬空 lane id 拒建批（GATE_ROLE_ASSEMBLY_MISSING / GATE_ASSEMBLY_INVALID），roles 词法非法告警（GATE_ROLE_INVALID）。**缺省即 raise**（建批即拉起 Manager 代管调度轮；收口按声明核验，未登记 Manager 落 `gate.manager_missing`）；确需 Leader 直驱时显式写 leader-direct。批次绑定当前会话。产物落盘契约：引擎产物根 = <~/.dsh/punky-preset>/sessions/<sessionId>/artifacts/<batchId>/，consume/produce/outputs 相对路径均解析到该根下（worker 落盘按此根，勿落工作区根）。【装配门作用域｜当前态】assembly 门**只在工具面（本工具）生效**：**直调 `buildWavePlan` 不走本门**（不抛 GATE_ROLE_ASSEMBLY_MISSING）——这是**已登记的有意差异**，登记于 `plan/techdebt-design.md §3`（决策 D-③；反例判据 R-DE-1/R-DE-2/R-DE-3/R-DE-4）。【当前态｜W-2 批将移除本句：Q6=A 已裁「门下沉到 buildWavePlan 本体」，届时本句作废，直调亦受同一门约束】`chain`（团队资产顶层）只做**建批期展开 + 静态校验**；运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`，本工具不重算拓扑。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID（kebab-case）"},"tasks":{"type":"array","required":true,"description":"任务列表 [{id, cmd, deps?, model?, tools?, layer?, role?, skills?, consume?, produce?, outputs?}]","items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","description":"并发**声明**（默认 5）；**已不参与运行期准入**（Q-B 取消并发闸，2026-09-18）：不再有超限拒绝与排队，字段仅落盘声明 + 回显（面板数字照显、`batch_status.concurrency` 照回）"},"smoke":{"type":"boolean","description":"**冒烟/探针批豁免键**（gate-lite Q-G1 · 2026-09-17 用户裁决「开显式豁免键」）：显式 `true` ⇒ 本批为 smoke ⇒ **跳过产物契约类门**（建批 GATE_PLAN_PRESENCE_MISSING / GATE_ORPHAN_PRODUCT；运行期 entry consume、exit produce∪outputs、targets、complete 的 plan 悬空产物判定），**行为安全门一字不减**（派发准入：lane 存在性 + Manager 拉起；单写者锁；终态冻结 GATE_BATCH_TERMINAL；needHuman；命令门；验收判据门）。建批成功即落 `batch.smoke` 事件（留痕）+ `batch_status.smoke` 回显（读端可见）。缺省（不传）⇒ 既有行为逐字不变。"},"team":{"type":"string","required":true,"description":"装配团队（**P1 起必填**，无缺省值）：必须解析到**团队资产** `presets/<team>/team-asset.{json,yml}`（显式 teamsRoot 时改按 `<teamsRoot>/presets/<team>/…`）——无资产 / 资产非法 / 资产声明的 skills 在宿主技能根 `~/.agents/skills` 不可解析 ⇒ **构造期拒建批**（零批次 JSON 落盘；码面零新造，复用既有 TEAM_ASSET_* 码，文案给可自救替代团队）。`team:'generic'` 已废除；注意 `presets/punky-preset/` 是**预设（模式）资产**、不是团队资产，不可当 team 名。实际可解析团队 = 运行时枚举 `presets/*/team-asset.*`（如 engine-team / software-team）。"},"teamsRoot":{"type":"string","description":"会话级临时团队资产根（绝对路径，可选）：给出时团队声明改按 <teamsRoot>/presets/<team>/team-asset.{json,yml} 解析（loader 口径 TEAM_ASSET_DIR='presets'），**不回落**包内 presets/ 与 legacy 兜底——资产缺失拒建批（GATE_TEAMS_ROOT_ASSET_NOT_FOUND）、资产非法原样透出 TEAM_ASSET_* 码、teamsRoot 非绝对路径/含 .. 段或 team 非 kebab-case 拒 GATE_TEAMS_ROOT_INVALID。缺省 = 既有行为逐字不变（包内 presets/ + legacy 兜底）。"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"},"assembly":{"type":"object","additionalProperties":false,"description":"批次级装配声明（可选顶层参数，与 batchId/tasks 平级）：**含 audit 层的三层批**必填（2026-09-14 扩面，原为「exec 层 lane≥3」）——managerPlan 编排牵头形态（**缺省 = raise**：建批即拉起 Manager 代管调度；leader-direct：Leader 直驱，须显式写出以退出默认）+ auditLane 验收归属 lane id；coordinatorLane/roles 可选；缺失/结构/引用非法拒建批（GATE_ROLE_ASSEMBLY_MISSING / GATE_ASSEMBLY_INVALID），roles 词法非法告警（GATE_ROLE_INVALID）","properties":{"managerPlan":{"type":"string","enum":["raise","leader-direct"],"description":"编排牵头形态（**缺省 = raise**）：raise=建批即拉起 Manager 代管调度（可省略）；leader-direct=Leader 直管派发（须显式写出）"},"auditLane":{"type":"string","required":true,"description":"验收归属 lane id：本批承担最终验收的 lane（须为 audit 层 lane 且存在于 tasks；层错配/悬空 → 拒建批 GATE_ASSEMBLY_INVALID）"},"coordinatorLane":{"type":"string","description":"可选：协调/细拆 lane id（须为 plan 层 lane 且存在于 tasks；声明后承担 CBM 代码摸底→细拆履职）；缺省无"},"roles":{"type":"array","items":{"type":"string"},"description":"可选：本批声明参与的角色集（词法白名单校验；非法词条 → GATE_ROLE_INVALID 告警，批次照建）"}}}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"wavePlan":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","required":true},"lanes":{"type":"object","required":true,"additionalProperties":true},"warnings":{"type":"array","items":{"type":"object","additionalProperties":true}},"assembly":{"type":"object","additionalProperties":true},"smoke":{"type":"boolean"},"managerPlan":{"type":"string"},"managerRoster":{"type":"object","additionalProperties":true}}},
        render: (_args, value) => TEXT_OUTPUT('wavePlan created: ' + value.batchId + ' @' + value.sessionId + ' (' + value.wavePlan.length + ' waves)' + (value.smoke ? '; SMOKE (产物契约类门已豁免)' : '') + (value.warnings?.length ? '; role warnings: ' + value.warnings.length : '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        assertMemberActionTierC(store, sessionId, exec, 'batch', {}, deps); // G1（Q2=B 收窄）：建批只认**本会话自己的 C 档**（无父档继承）
        // P1（2026-09-16）构造期拒（**唯一落点**，全在 createBatch 之前）：判定序 ① team 词法/必填（含 `generic` 废除）
        //   → ② teamsRoot 面（既有 GATE_TEAMS_ROOT_* 码，行为不变）→ ③ 资产加载 + 不变量 + `skills` 可解析（TEAM_ASSET_* 码原样透出）。
        //   顺序不可调换：team 必填先于 teamsRoot 面（否则缺 team 会先落 GATE_TEAMS_ROOT_*，与 spec §2 码表不符）。
        //   拒后：**零批次 JSON 落盘**、pendingBatch 不释放（补声明可重试）。作用域 = 工具面（直调 buildWavePlan 属已登记差异 W-2，P1 不消）。
        const teamName = assertTeamNameRequired(args.team); // 判定 ①：词法/必填（返回归一化（trim）后的团队名，全流程同源）
        // teamsRoot（会话级临时团队资产根）：显式给出时才走新面——先词法/防逃逸，再资产加载期校验
        // （缺失/非法一律 throw 拒建批，**不回落**包内 presets/ 与 legacy 兜底）；缺省 null = 既有行为逐字不变
        const teamsRoot = args.teamsRoot === undefined ? null : resolveTeamsRootOption(teamName, args.teamsRoot);
        // P1 判定 ②③：packaged 面按包根、teamsRoot 面按临时根——判据与 `resolveAssembly` 的根选择**同源**
        assertTeamAssetReady(teamName, { root: teamsRoot ?? packageRoot() });
        // P2 判定 ④：`chain` 声明八条静态校验（纯函数，**首个问题码原样透出**）。
        //   与 P1 三项同族：全在 `createBatch` 之前 throw ⇒ 拒后零批次 JSON 落盘、pendingBatch 保留可重试。
        //   无 `chain` 声明 ⇒ 放行（向后兼容锁）；`flows.chain` 位非法 ⇒ 本步以 FIELD_NOT_ALLOWED 拒。
        assertChainReady(teamName, { root: teamsRoot ?? packageRoot() });
        const assembly = resolveAssembly(teamName, config.assembly, teamsRoot ? { root: teamsRoot } : {});
        const smoke = args.smoke === true; // gate-lite Q-G1：显式豁免键（非真值一律 false ⇒ 既有行为零变化）
        // P1 交接门策略（`task-27`）：由**工具面**用热更快照经**唯一解析点**解析后传入建批——单一真源 =
        //   `wave-plan.ts#handoffGateEnabledOf`（runtime.json `gates.handoff.entry` > env 兜底 > 缺省关）；
        //   `wave-plan` 自身不再读 env/config（禁两套读取）。
        const planArgs = { batchId: args.batchId, tasks: args.tasks, concurrency: args.concurrency ?? 5, team: teamName, assembly, smoke, handoffGate: handoffGateEnabledOf(readLiveConfig(deps), 'entry') };
        if (teamsRoot) planArgs.teamsRoot = teamsRoot; // 透传（缺省不写键 = 既有签名语义不变）
        const plan = buildWavePlan(planArgs);
        validateWavePlan(plan, { smoke }); // gate-lite Q-G1：二级校验与建批同一豁免口径（否则 smoke 批仍被 GATE_PLAN_PRESENCE_MISSING 拒）
        // 批次装配门禁（建批时刻，validateWavePlan 后、createBatch 前）：**含 audit 层的三层批**必须携带
        // 批次级装配声明 assembly（auditLane 必填；managerPlan **缺省 = raise**）。拒建批（throw：GATE_ROLE_ASSEMBLY_MISSING 缺声明 /
        // GATE_ASSEMBLY_INVALID 结构/引用非法）→ 无批次 JSON 落盘、pendingBatch 锁保留（Leader 补声明后重试）；
        // 通过 → 归一化 decl 随 createBatch 持久化（batch JSON 顶层可选字段，schema 不升）；roles 词法告警并入返回 warnings
        // 复核补齐：装配声明面同样接受团队声明的角色（与 buildWavePlan 同源读端：各层声明角色 ∪ roles.extra）
        // 给出 teamsRoot 时技能前缀面与建批面**同源**（同一临时根），否则装配声明的扩展角色仍读包内
        const teamRolesForAssembly = resolveTeamRoles(args.team, teamsRoot ? { root: teamsRoot } : {});
        const asm = normalizeAssemblyDecl(args.assembly, teamRolesForAssembly.ok ? unionRoleVocabulary(teamRolesForAssembly) : []); // { decl, warnings }；结构非法 → GATE_ASSEMBLY_INVALID throw
        const asmGate = assemblyGate(plan.wavePlan.flatMap((w) => w.tasks), asm.decl); // C+ 缺声明 → 拒；悬空 lane id → throw
        if (asmGate !== 'ok') throw new Error(asmGate.code + ': ' + asmGate.message);
        // P2（2026-09-14 用户裁决 B）：**audit 职责声明化**——批次含 audit lane 且**解析到团队资产**时，
        //   `flows.audit.audit_contract` 必须存在（fail-closed：既然声明了流程，就必须声明 audit 职责）；
        //   缺 → 拒建批 `GATE_AUDIT_CONTRACT_MISSING`；**显式空 `{}` 或 `{exempt:true}`** → 放行但落 warning
        //   留痕 `GATE_AUDIT_CONTRACT_EXEMPT`（带 `reason` 时一并记）。**无团队资产**（generic / 退役团队 → legacy
        //   flows）→ 跳过（零感知，不新增强制面）。仅批次含 audit lane 时生效。
        if (plan.wavePlan.some((w) => (w.tasks ?? []).some((t) => t.layer === 'audit'))) {
          const tf = resolveTeamFlows(args.team, teamsRoot ? { root: teamsRoot } : {});
          const auditFlow = tf && tf.ok && tf.flows ? flowOf(tf.flows, 'audit') : null;
          if (auditFlow) {
            const ac = auditFlow.audit_contract;
            if (ac == null) {
              throw new Error('GATE_AUDIT_CONTRACT_MISSING: team "' + args.team + '" declares flows.audit but no audit_contract — '
                + '声明 audit 职责（criteria_from / consumes_required / verdict），或显式写空 `audit_contract: {}` 表示无契约（会留痕告警）');
            }
            // GAP-S2（B，2026-09-16）：`verdict` **已声明**却与 complete 白名单 `{pass,skip}` **交集为空**
            //   ⇒ 建批期**留痕告警**（批次照建、不拒建批）。动机 = 补上「写了不生效」的静默面：该资产下
            //   audit lane 即使 merged，complete 也会被拒（运行期专用码 GATE_COMPLETE_OUTCOMES_EMPTY，见
            //   lib/state/gates.ts 的 checkCompleteGate）；本告警让故障在**建批当刻**可见，而非等到收口。
            //   通道 = 既有 `plan.warnings`（`output.schema.warnings` + render `role warnings: N`），
            //   与 `GATE_AUDIT_CONTRACT_EXEMPT` / `GATE_SKILL_MISSING` 同形（warning 语义：事件留痕、不阻断建批）。
            //   **不走** `lib/assembly/team-asset.js` 的 `problems` 通道：本告警的语义是「**非阻断**的建批留痕」，
            //   而 `problems` 通道承载的是「资产声明面是否可用」的**加载期判定**（两条通道语义不同，禁混用）。
            //   【2026-09-17 订正 · 原 GAP-S7 已闭合】本注释原写「那里 `ok = problems.length === 0` ⇒ 任何
            //   severity 的 problem 都会把 `ok` 打成 false ⇒ 误拒建批（缺口 GAP-S7，不修仅绕开）」——
            //   该前提**已失效**：`chain.js`（R2-3）与 `team-asset.js`（R2-3 一致性收尾）的 `ok` 均已改为
            //   「**无 blocking**」（`ok = !hasBlockingProblems(problems)`），warning 只提示不否决。
            //   故现在**即使**走 `problems` 通道也不会因 warning 误拒建批；本处仍走 `plan.warnings` 的
            //   理由只剩上面那条**语义分工**（非阻断留痕 vs 加载期判定），不再有「绕开缺口」的成分。
            if (Array.isArray(ac.verdict) && ac.verdict.length > 0
              && !ac.verdict.some((v) => v === 'pass' || v === 'skip')) {
              plan.warnings.push({
                code: 'GATE_COMPLETE_OUTCOMES_EMPTY', team: args.team,
                declared: ac.verdict, values: [],
                message: 'flows.audit.audit_contract.verdict 与 complete 白名单 {pass,skip} 交集为空（declared='
                  + JSON.stringify(ac.verdict) + '）——该批 audit lane 即使 merged 也会被 complete 门拒；'
                  + '请把 verdict 改用成员终态词 {pass,fail,skip,conflict} 且至少含 pass 或 skip'
                  + '（留痕告警，不阻断建批）',
              });
            }
            if (Object.keys(ac).length === 0 || ac.exempt === true) {
              plan.warnings.push({
                code: 'GATE_AUDIT_CONTRACT_EXEMPT', team: args.team, ...(ac.reason ? { reason: ac.reason } : {}),
                message: 'audit_contract 显式豁免（空声明 / exempt:true）——本批 audit 职责无契约约束（留痕告警，不阻断）',
              });
            } else if (Array.isArray(ac.consumes_required) && ac.consumes_required.length > 0) {
              // A 方案（2026-09-14）：`consumes_required` **接消费**——团队声明「audit 必须覆盖哪些层前缀」
              //   （如 ['plan/','exec/']），本层把它变成**确定性建批门禁**：每个前缀须至少有一条 audit lane 的
              //   consume 命中。引擎默认面（`plan/` 前缀 ∨ 由 plan lane 声明产出）仍由 wave-plan 的 P1-a 兜底，
              //   本项是**团队可加强**的叠加约束（缺省零感知）。复用同码 `GATE_AUDIT_INPUT_MISSING`（同语义族）。
              const auditLanes = plan.wavePlan.flatMap((w) => w.tasks ?? []).filter((t) => t.layer === 'audit');
              const gaps = ac.consumes_required.filter((prefix) => !auditLanes.some((t) => (t.consume ?? []).some((p) => typeof p === 'string' && p.startsWith(prefix))));
              if (gaps.length > 0) {
                throw new Error('GATE_AUDIT_INPUT_MISSING: audit_contract.consumes_required not satisfied for ' + JSON.stringify(gaps)
                  + ' — no audit lane consumes a product under those prefixes (team "' + args.team + '")');
              }
            }
          }
        }
        // exec 消费门（2026-09-18 用户裁决：E-A/E-B 一并加）——与上方 audit 的 `consumes_required` **同址同形**，
        //   把「**exec 依赖 plan 产物执行**」从建批声明约定升为**引擎门禁**（拒建批、零批次落盘、未声明零感知）：
        //   · E-A `flows.exec.consumes_required`（**批级**）：每个声明前缀须至少被**一条** exec lane 的 consume 命中；
        //   · E-B `flows.exec.consumes_required_per_lane`（**逐 lane**）：**每一条** exec lane 须各自命中每个前缀。
        //   语义镜像 audit 的**双消费**（audit = `plan/` ＋ 上游 `exec/`；exec lane = `plan/` ＋ 可选上游 exec 产物）
        //   ⇒ **不排斥**「reviewer 同时消费 tester 产物与 plan 产物」这类合法形态，只排除「**没有 plan 依据的 exec lane**」。
        //   拒绝码 `GATE_EXEC_INPUT_MISSING` 与 `GATE_AUDIT_INPUT_MISSING` 同族同位置（对称性优先）。
        if (plan.wavePlan.some((w) => (w.tasks ?? []).some((t) => t.layer === 'exec'))) {
          const tfExec = resolveTeamFlows(args.team, teamsRoot ? { root: teamsRoot } : {});
          const execFlow = tfExec && tfExec.ok && tfExec.flows ? flowOf(tfExec.flows, 'exec') : null;
          if (execFlow) {
            const execLanes = plan.wavePlan.flatMap((w) => w.tasks ?? []).filter((t) => t.layer === 'exec');
            const hitsPrefix = (t, prefix) => (t.consume ?? []).some((p) => typeof p === 'string' && p.startsWith(prefix));
            const batchReq = Array.isArray(execFlow.consumes_required) ? execFlow.consumes_required : [];
            const perLaneReq = Array.isArray(execFlow.consumes_required_per_lane) ? execFlow.consumes_required_per_lane : [];
            if (batchReq.length > 0) {
              const gaps = batchReq.filter((prefix) => !execLanes.some((t) => hitsPrefix(t, prefix)));
              if (gaps.length > 0) {
                throw new Error('GATE_EXEC_INPUT_MISSING: flows.exec.consumes_required not satisfied for ' + JSON.stringify(gaps)
                  + ' — no exec lane consumes a product under those prefixes (team "' + args.team + '")');
              }
            }
            if (perLaneReq.length > 0) {
              const offenders = [];
              for (const t of execLanes) {
                for (const prefix of perLaneReq) if (!hitsPrefix(t, prefix)) offenders.push(String(t.id) + ':' + prefix);
              }
              if (offenders.length > 0) {
                throw new Error('GATE_EXEC_INPUT_MISSING: flows.exec.consumes_required_per_lane not satisfied — exec lane(s) missing required consume prefix: '
                  + JSON.stringify(offenders) + ' (team "' + args.team + '")');
              }
            }
          }
        }
        if (asm.warnings.length > 0) plan.warnings.push(...asm.warnings); // roles 词法告警并入（事件随既有循环留痕、返回值暴露）
        // 团队资产缺失告警（B4）：**已删码**（gate-lite 第二批 · C，2026-09-17）——原码 `GATE_TEAM_ASSET_MISSING`
        //   自述「P1 后不可达」（无资产已在构造期前置为拒 `TEAM_ASSET_NOT_FOUND`/`TEAM_ASSET_SKILLS_MISMATCH`，
        //   `createBatch` 之前 throw）⇒ 死码占用告警通道且与「无资产即拒」的口径自相矛盾，按普查结论整条删除；
        //   防回生断言见 `test/gate-lite-batch2.test.js`（源码面不得再出现该字面量）。
        // 技能名存在性告警（B6）：装配里写了不存在 / 已退役的技能名 → worker「少一份手册而无人报错」。
        // 判定面 = **宿主技能根**（worker 实际的可加载面）；技能根不存在（隔离测试 HOME）时跳过，避免噪声；
        // 告警不阻断建批（与既有 warning 通道一致）。
        // 2026-09-16（P1）：技能根 + 可解析名集合改取**单一实现** `resolvableSkillNames()`（原内联块外提，
        //   与构造期 skills 门**同源**；语义不变：根不可用 ⇒ 跳过本告警，不误报「全部缺失」）。
        const skillNames = new Set();
        for (const layer of Object.values((assembly && assembly.layers) || {})) {
          for (const arr of Object.values((layer && layer.skills) || {})) for (const s of arr || []) skillNames.add(s);
        }
        if (skillNames.size > 0) {
          const res = resolvableSkillNames();
          if (res.ok) {
            // 可解析名集合 = 宿主技能**目录名** ∪ 各 SKILL.md frontmatter 的 `name`（加载名）——
            // 二者常不一致（如加载名 ara-compiler 落在目录 research-compiler），只按目录名判会误报缺失。
            const missingSkills = [...skillNames].filter((n) => !res.known.has(n));
            if (missingSkills.length > 0) {
              plan.warnings.push({ code: 'GATE_SKILL_MISSING', missing: missingSkills.join('|'), message: 'skills not resolvable in host skill root: ' + missingSkills.join(', ') });
            }
          }
        }
        const batch = store.createBatch(sessionId, { batchId: plan.batchId, wavePlan: plan, concurrency: plan.concurrency, assembly: asm.decl ?? undefined, ...(teamsRoot ? { teamsRoot } : {}) });
        // gate-lite Q-G1（2026-09-17 用户裁决「开显式豁免键」）：**冒烟/探针批**留痕——建批成功当刻落一条
        //   `batch.smoke` 事件（常量登记于 `lib/state/event-types.js`）⇒ 门禁读端（`lib/state/gates.ts#smokeOf`）
        //   与读端回显（`batch_status.smoke`）取**同一事实源**；批次 JSON 不新增字段（`store.createBatch`
        //   不在本批写域，且事件流本就是批次级留痕的既有载体，与 `laneStartedAt`/`gateStrengthOf` 同法读取）。
        //   零静默：跳过什么、保留什么见 event-types.js 常量处的语义边界声明。
        if (smoke) store.appendEvent(sessionId, plan.batchId, EVT.EVT_BATCH_SMOKE, { batchId: plan.batchId });
        // role 校验告警留痕（GATE_ROLE_INVALID / GATE_ROLE_MISSING / assembly.roles 词法告警，warning 语义：事件留痕、不阻断建批；Leader 经返回值 warnings 可见）
        // GAP-S9：事件 type 改走 `WARN_EVENT_OF` 按码映射（`GATE_COMPLETE_OUTCOMES_EMPTY` 有自己的专用类型）；
        //   未命中映射的码**逐字保持现状** = `gate.role_invalid`；载荷字段形态**零增删**（`code` 仍在）。
        for (const w of plan.warnings ?? []) {
          store.appendEvent(sessionId, plan.batchId, WARN_EVENT_OF[w.code] ?? EVT.EVT_GATE_ROLE_INVALID, { code: w.code, task: w.task ?? null, role: w.role ?? null, layer: w.layer ?? null, missing: w.missing ?? null });
        }
        clearPendingBatch(store, sessionId); // 建批解锁：判 C 后 pendingBatch=false
        // gate-lite 第二批 · A2（Manager 承抽）：`assembly.managerPlan` 的**消费点改读官方 roster** ——
        //   声明 `raise` 的批若 roster 可读且确无约定名 `manager` 成员 ⇒ 落 `gate.manager_roster_gap`
        //   （可核事实；**非拒态**——Manager 四码已按用户裁决整体删除）。roster 服务不可用（非官方宿主
        //   基线态）或调用抛错（非 Team 成员）⇒ **只回显 + 异常态 warn**，不把环境事实写成本批事实。
        const managerRoster = managerRosterOf(ctx, exec);
        const managerPlan = asm.decl ? (asm.decl.managerPlan ?? null) : null;
        if (managerPlan === 'raise' && managerRoster.ok && !managerRoster.inRoster) {
          store.appendEvent(sessionId, plan.batchId, EVT.EVT_GATE_MANAGER_ROSTER_GAP, {
            managerPlan, rosterName: managerRoster.rosterName, memberCount: managerRoster.memberCount ?? 0,
          });
        } else if (managerPlan === 'raise' && !managerRoster.ok && managerRoster.reason !== 'service-unavailable') {
          ctx.logger?.warn?.('[dsh-punky-swarm] managerPlan=raise 但官方 roster 读取失败（' + managerRoster.reason
            + '）⇒ 无法核验 Manager 在册；已回显 managerRoster，不落批次事件');
        }
        const out = { batchId: plan.batchId, sessionId, wavePlan: plan.wavePlan, concurrency: plan.concurrency, lanes: batch.lanes, warnings: plan.warnings ?? [], ...(smoke ? { smoke: true } : {}), ...(managerPlan ? { managerPlan, managerRoster } : {}) };
        if (asm.decl) out.assembly = asm.decl; // 归一化装配声明视图（closed output.schema 已扩 properties；未声明不写键）
        return out;
      },
    }),
    defineTool({
      name: "batch_phase",
      description: "批次阶段迁移：planning->running->paused->aborted|complete（终态后拒绝再写）。complete 前置：audit 层验收齐备（Tier3 门禁）。可选 manager={agentId,note?}：**legacy 登记面**（写批次字段 manager + batch.manager.raised 事件，只登记不改阶段，可单独调用）——【gate-lite 第二批 · A】Manager 在册判定的**新真源 = 官方 roster**（`ctx.get('agentTeams')` → `listMembers`；经 wave_plan/batch_status 的 `managerRoster` 回显，声明 raise 而无 Manager 落 `gate.manager_roster_gap`）；本登记**不再按 phase/agentId 拒绝**（原 GATE_MANAGER_TERMINAL / _PHASE_INVALID / _AGENT_ID_REQUIRED 三码已按用户裁决删除；空 agentId ⇒ 不写记录、不抛错）。批次按会话隔离，缺省取当前执行会话。迁移事由随事件落盘（`reason`），暂停类迁移缺省自动回填 `manual:batch_phase:<phase>`，不静默。",
      parameters: {"batchId":{"type":"string","required":true},"phase":{"type":"string","enum":["running","paused","aborted","complete"]},"reason":{"type":"string","description":"相位迁移事由（写入 batch.phase 事件；缺省 manual:batch_phase:<phase>）"},"manager":{"type":"object","description":"Manager **legacy 登记**载荷：{agentId: 非空字符串, note?: 说明}；任意 phase 均可登记（含终态；幂等）；空/缺 agentId ⇒ 不写记录（返回 null，调用方按「既无 phase 又无 manager」如实报错）。**不构成在册判据**——在册以官方 roster 为准（managerRoster 回显）","additionalProperties":false,"properties":{"agentId":{"type":"string"},"note":{"type":"string"}}},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true},"manager":{"type":"object","additionalProperties":true},"danglingLanes":{"type":"array","items":{"type":"string"}}}},
        render: (_args, value) => TEXT_OUTPUT((value.manager ? ('batch ' + value.batchId + ' manager.raised -> ' + value.manager.agentId) : ('batch ' + value.batchId + ' phase -> ' + value.phase))
          + (value.danglingLanes?.length ? '; dangling lanes: ' + value.danglingLanes.length : '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '批次阶段迁移（batch_phase）'); // 模式门（E 阶段）：非生效模式零治理写入，先于参数/状态校验
        const sessionId = sessionOf(args, exec);
        // Manager legacy 登记（留痕入口）：可与阶段迁移同一次调用。
        // 顺序：**先登记、后迁移**——这样「同一次调用里从 running 迁走」也能正常登记。
        // 【gate-lite 第二批 · A（2026-09-17 用户裁决「全删」）】原「准入 = 批次非终态 + agentId 必填」
        //   两处硬判**已删**（`GATE_MANAGER_TERMINAL` / `_PHASE_INVALID` / `_AGENT_ID_REQUIRED` 三码不存在）：
        //   · 任意 phase 均可登记事实（幂等；不改阶段、不改成员状态）；
        //   · 空/缺 `agentId` ⇒ `markManagerRaised` 返回 null ⇒ 走下方「既无 phase 又无 manager」显式报错
        //     （不写垃圾记录、不静默）。
        //   **在册判据不在此处**：以官方 roster 为准（读端 `managerRosterOf` / `managerViewOf`，见 wave_plan、
        //   batch_status）；本登记降级为 legacy 观察字段。
        const manager = args.manager ? store.markManagerRaised(sessionId, args.batchId, args.manager) : undefined;
        if (!args.phase) {
          if (!manager) throw new Error('batch_phase requires "phase" or "manager"');
          const cur = store.readBatch(sessionId, args.batchId);
          return { batchId: args.batchId, phase: cur ? cur.phase : 'unknown', manager };
        }
        const b = store.setPhase(sessionId, args.batchId, args.phase, { reason: args.reason ?? ('manual:batch_phase:' + args.phase) });
        if (b.phase === 'complete' || b.phase === 'aborted') clearPendingBatch(store, sessionId); // 兜底清理旧锁
        const out = { batchId: args.batchId, phase: b.phase };
        if (manager) out.manager = manager;
        // GAP-S3b（2026-09-16 用户裁决 = 折中方案）：`aborted` 收口时若本批仍存在**非终态成员**，
        //   **额外落一条告警事件 + 工具返回回显**（提醒「这批留了悬挂」）。
        // P3a control lane **抽取**：本判定的实现已移入单点 `lib/state/dangling.js` 的 `warnAbortDangling`
        //   ——`batch_phase`（本处）与新增 `batch_control(abort)` **共用同一份**，禁第二份实现。
        //   该单点内部判据零新口径：lane 级判定 = `isDanglingLane`（`lib/watch/lane-heartbeat.js`，与
        //   `batch_status.danglingLanes` 同源），lane 名单 = `Object.keys(b.lanes)`（与 `derivedOf` 同源）。
        // 纪律（逐字不变）：**绝对不改任何成员状态**（不做隐式批量 `skipped`）：`batch.lanes` 在 abort 前后
        //   **逐字不变**，只多落一条事件（那些成员在终态批上永久无法回收 —— `member_settle` 拒
        //   `GATE_BATCH_TERMINAL` —— 正是本告警要显式化的既有事实）。
        // 相位面：仅 `aborted` 判定 ⇒ `running` / `paused` / `complete` 三相位**逐字零差异**（尤其 complete
        //   不得因此新增事件）；无悬挂成员（全终态）的批 ⇒ **不落事件、不写 `danglingLanes` 键**（反例锁）。
        const dg = warnAbortDangling(store, sessionId, args.batchId, b);
        if (dg) out.danglingLanes = dg.danglingLanes;
        return out;
      },
    }),
    defineTool({
      // P3a 最小干预面（规格 §5）：停轮批的**唯一恢复入口**（`resume`）+ 人工介入（`pause`）+ 收口（`abort`）。
      // 与 `batch_phase` 的关系（规格 §5「与既有相位机/batch_phase 语义不冲突」）：
      //   · **同一个相位机**（`BATCH_TRANSITIONS` / `store.setPhase`），本工具不自造码、不绕门禁；
      //   · `batch_phase` 本阶段**照常在册、行为逐字不变**（收内是 P3b 的事，故二者并存而非替换）；
      //   · 差异只在**调用面**：`batch_phase` 是原始相位写入口（受 `args.phase` 白名单，
      //     `running|paused|aborted|complete`），`batch_control` 是**人工干预动作面**——把
      //     「停轮后从哪恢复」显式化为 `action:'resume'`（规格 §6：恢复的唯一入口）。
      // 边界（硬性）：
      //   · **不得改任何成员状态**（`batch.lanes` 前后逐字不变；停轮/收口只动相位与留痕）；
      //   · 幂等：目标相位已达成 ⇒ no-op（**不重复写相位事件**）；终态批上的 abort ⇒ no-op
      //     （既有的 `batch.abort_dangling` 告警也不重复落）；
      //   · 非法迁移逐字沿用既有报错码 `invalid batch phase transition: <from> -> <to>`（不自造码）。
      name: "batch_control",
      description: "最小干预面（P3a 规格 §5）：对批次的**人工干预动作**——`pause`（running→paused，人工介入即停止自动推进）/ `resume`（paused→running，**停轮批的唯一恢复入口**，规格 §6 防竞态）/ `abort`（→aborted，收口；有悬挂成员时复用既有 `batch.abort_dangling` 告警 + `danglingLanes` 回显）。幂等：目标相位已达成 ⇒ no-op（不重复写相位事件）。**绝不改任何成员状态**（停轮/收口只动相位与留痕）；非法迁移走既有相位机报错码，不新增/自造码。既有 `batch_phase` 本阶段照常在册、行为不变（收内属 P3b）。批次按会话隔离，缺省取当前执行会话。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"action":{"type":"string","required":true,"enum":["pause","resume","abort"],"description":"干预动作：pause=停轮（人工介入即停止自动推进）/ resume=paused→running（唯一恢复入口）/ abort=收口（不可逆）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true},"action":{"type":"string","required":true},"noop":{"type":"boolean"},"danglingLanes":{"type":"array","items":{"type":"string"}}}},
        render: (_args, value) => TEXT_OUTPUT('batch ' + value.batchId + ' control ' + value.action + ' -> ' + value.phase
          + (value.noop ? ' (no-op: already ' + value.phase + ')' : '')
          + ((value.danglingLanes ?? []).length ? '; dangling lanes: ' + value.danglingLanes.length : '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '批次干预（batch_control）'); // 模式门（E 阶段）：非生效模式零治理写入，先于参数/状态校验
        const sessionId = sessionOf(args, exec);
        const action = args.action;
        if (!['pause', 'resume', 'abort'].includes(action)) {
          throw new Error('GATE_BATCH_CONTROL_ACTION_INVALID: batch_control action 只允许 pause|resume|abort（收到 ' + JSON.stringify(action ?? null) + '）');
        }
        // 相位取值**直读批次 JSON**（判据唯一事实源；不由调用方传 phase ⇒ 无第二个相位入口）。
        const cur = store.readBatch(sessionId, args.batchId);
        if (!cur) throw new Error('batch not found: ' + args.batchId);
        const idempotent = (phase) => {
          const out = { batchId: args.batchId, phase, action, noop: true };
          if (action === 'abort' && phase === 'aborted') { // 已终态的 abort：回显既有悬挂事实，**不重复落告警**
            const lanes = danglingLanesOf(store.readBatch(sessionId, args.batchId));
            if (lanes.length > 0) out.danglingLanes = lanes;
          }
          return out;
        };
        if (action === 'pause' && cur.phase === 'paused') return idempotent('paused');
        if (action === 'resume' && cur.phase === 'running') return idempotent('running');
        if (action === 'abort' && cur.phase === 'aborted') return idempotent('aborted');
        const target = action === 'pause' ? 'paused' : (action === 'resume' ? 'running' : 'aborted');
        // 迁移判定/落盘**全部**走既有 `store.setPhase`（内含 `BATCH_TRANSITIONS` 校验 + `batch.phase` 事件
        //   + complete 门禁）——本工具不复制任何迁移逻辑；非法迁移按既有码抛（逐字透传，不改写）。
        const b = store.setPhase(sessionId, args.batchId, target, { reason: 'manual:batch_control.' + action });
        if (b.phase === 'complete' || b.phase === 'aborted') clearPendingBatch(store, sessionId); // 兜底清理旧锁（同 batch_phase 口径）
        const out = { batchId: args.batchId, phase: b.phase, action };
        // abort 收口告警：**复用** `batch_phase(aborted)` 的同一实现（单点 `lib/state/dangling.js`）——
        //   仅 `aborted` 相位且存在悬挂成员时落事件 + 回显；`pause`/`resume` 相位面零差异。
        const dg = action === 'abort' ? warnAbortDangling(store, sessionId, args.batchId, b) : null;
        if (dg) out.danglingLanes = dg.danglingLanes;
        return out;
      },
    }),
    defineTool({
      name: "batch_status",
      description: "查询批次状态（唯一事实源）：phase/lanes/wavePlan/事件摘要 + 状态面派生视图 lanesState（lane→成员态映射，原 lanes 保留）/ danglingLanes（**悬挂成员**：批次已终态而成员非终态的 lane 名单，恒显、不产候选、不受僵尸批过滤）。悬挂成员是「批次已了结、成员未了结」的信号，供 Manager/Leader 只读核查收口遗漏。不传 batchId 则列出当前会话全部批次。可用 session 指定会话。`chain` 回显 = 建批期声明投影 + 历史 `chain.step` 事件（**不是**运行期真源）；**`chain` = 建批期展开 + 静态校验；运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`**（逐边取件见 `handoff_view`）。",
      parameters: {"batchId":{"type":"string","description":"批次 ID；缺省时列出该会话全部"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"phase":{"type":"string"},"concurrency":{"type":"integer"},"lanes":{"type":"object","additionalProperties":true},"lanesState":{"type":"object","additionalProperties":true},"danglingLanes":{"type":"array","items":{"type":"string"}},"wavePlan":{"type":"array","items":{"type":"object","additionalProperties":true}},"manager":{"type":"object","additionalProperties":true},"managerRoster":{"type":"object","additionalProperties":true},"teamAsset":{"type":"object","additionalProperties":true},"chain":{"type":"object","additionalProperties":true},"smoke":{"type":"boolean"},"eventCount":{"type":"integer"},"recentEvents":{"type":"array","items":{"type":"object","additionalProperties":true}},"settled":{"type":"boolean"},"sessionId":{"type":"string"},"batches":{"type":"array","items":{"type":"object","additionalProperties":true}},"stateSource":{"type":"string"},"memberStatesLegacy":{"type":"boolean"},"handoffGate":{"type":"object","additionalProperties":true}}},
        // 【task-27】渲染面**必须**显示门态与成员态来源（缺省关是策略、不得隐形；P2-B 两字段由此获得消费者）：
        //   `state=engine(legacy)`（引擎八态为 legacy 投影，真源 = 官方 roster 5 态）
        //   `handoffGate=entry:on/settle:on(src:runtime|env|default)`
        render: (_args, value) => {
          const hg = value.handoffGate ?? null;
          const hgTxt = hg ? ' handoffGate=entry:' + (hg.entry === 'enforced' ? 'on' : 'off') + '/settle:' + (hg.settle === 'enforced' ? 'on' : 'off') + '(src:' + String(hg.source ?? 'default') + ')' : '';
          const stateTxt = value.stateSource ? ' state=' + String(value.stateSource) + (value.memberStatesLegacy ? '(legacy)' : '') : '';
          return value.batchId
            ? TEXT_OUTPUT('batch ' + value.batchId + ' phase=' + value.phase + ' settled=' + value.settled + (value.manager ? ' manager=' + value.manager.agentId : '') + (value.smoke ? ' SMOKE(产物契约类门豁免)' : '') + stateTxt + hgTxt + ((value.danglingLanes ?? []).length ? ' ⚠ dangling=' + value.danglingLanes.length : ''))
            : TEXT_OUTPUT('batches: ' + (value.batches ?? []).length + stateTxt + hgTxt);
        },
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        // D6 批次级派生视图（零写入面纯投影）：取值与探针面**同源**（`laneStateOf` / `isDanglingLane` 两个
        //   单点，均来自 lib/watch/lane-heartbeat.js），本文件不另写任何状态判定。
        //   · lanesState = lane→**成员原态**映射（不取批次档覆盖值）：与 batch.lanes 同为原始态读端，
        //     故对同一 lane 恒有 lanesState[lane] === lanes[lane]；它存在的意义是给读端一个**显式命名**的
        //     状态面键，使悬挂/待恢复等语义不必靠 lanes 的隐式约定解读。
        //   · danglingLanes = 批次终态 ∧ 成员非终态的 lane（悬挂成员），恒显（无阈值、不受 staleBatchMs 过滤）。
        const derivedOf = (b) => {
          const laneIds = Object.keys(b.lanes ?? {});
          const lanesState = {};
          for (const l of laneIds) lanesState[l] = laneStateOf(b, l);
          return { lanesState, danglingLanes: laneIds.filter((l) => isDanglingLane(b, l)) };
        };
        // gate-lite Q-G1 读端：`smoke` 判定与门禁读端（`lib/state/gates.ts#smokeOf`）**同源** —— 同一事件、
        //   同一判据（`batch.smoke`）；此处只读投影，零写入（与 derivedOf 同为批次级派生视图）。
        const smokeOf = (b) => (b?.events ?? []).some((e) => e && e.type === EVT.EVT_BATCH_SMOKE);
        // ── P2-B 回显标注（2026-09-17；**只标注不改行为**）─────────────────────────────────────
        // ① 成员态来源标注：`source: engine|roster` 的**二值可辨**——引擎八态为 legacy 投影（`stateSource:'engine'`
        //    + `memberStatesLegacy:true`），官方 roster 5 态为真源（`managerRoster.source:'roster'`）。
        //    消费者 = 本工具的**渲染面**（`state=engine(legacy)`），不再「写了不生效」（`task-27` 增量裁决）。
        // ② P1/P2 交接门**策略态**（`task-27`）：经**唯一解析点** `handoffGateStateOf(readLiveConfig(deps))` 取值
        //    ⇒ 真源 = runtime.json `gates.handoff.{entry,settle}`（env 兜底、缺省关）；`source` 如实回显
        //    （`runtime|env|default`）；渲染面同样显示（缺省关是策略、**不得隐形**）。
        const stateAnnotation = { stateSource: MERGE_STATE_SOURCE.engine, memberStatesLegacy: MEMBER_STATES_LEGACY };
        const hgState = handoffGateStateOf(readLiveConfig(deps));
        const handoffGateView = {
          enabled: hgState.entry || hgState.settle,
          entry: hgState.entry ? 'enforced' : 'observation',
          settle: hgState.settle ? 'enforced' : 'observation',
          source: hgState.source,
        };
        if (!args.batchId) {
          return { sessionId, batches: store.listBatches(sessionId).map((id) => { const b = store.readBatch(sessionId, id); return { batchId: id, sessionId, phase: b.phase, lanes: b.lanes, ...derivedOf(b), ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation }; }), ...stateAnnotation, handoffGate: handoffGateView };
        }
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
        // P2（RK1）推进链回显面：`{ version, steps[], lastStep, edges[{from,to,via}] }`——命中边**显式可见**
        //   （不必翻事件流即可看出这一批实际走了哪几跳、上一跳是什么）。
        //   取值 = 当场按批次根解析团队资产（与 `gate_status.declaration` 同法，不另立冻结面）；
        //   **无 `chain` 声明 ⇒ 不写键**（无链即无推进，读端保持既有形状——向后兼容锁）。
        //   本批不新造工具名（`batch_view` 属 P4）。
        // 【冻结 · 兼容读 · 勿删】（链声明退役 2026-09-18 · Q-A=C 弃用链声明）
        //   保住理由（唯一一条）：磁盘**历史批**仍有建批期 `chain` 声明投影与 `chain.step` 事件，删本行则历史批
        //   读端立即丢面（读侧兼容是硬锁）。本回显**不新增写点、不参与任何运行期决策**。
        //   拓扑口径：运行期 DAG 真源 = 批次 `wavePlan[].tasks[].deps` + `batch.handoffs`（逐边取件见 `handoff_view`），
        //   不是本回显（详见 `docs/chain-retirement-and-topology-20260918.md`）。
        //   **同源约束**：本行与 `lib/api.js` 的 `batch_status` 读端是**同一实现**（`chainEchoOf + chainOfBatch`）
        //   ⇒ 两处必须逐字同源，**禁一删一留、禁只改单侧**（单侧改动 = 两个读端口径分裂）。
        const chainView = chainEchoOf(b, chainOfBatch(b).chain);
        return { batchId: b.batchId, sessionId, phase: b.phase, concurrency: b.concurrency, lanes: b.lanes, ...derivedOf(b), wavePlan: b.wavePlan, ...(b.manager ? { manager: b.manager } : {}), managerRoster: { ...managerViewOf(ctx, exec, b), source: MERGE_STATE_SOURCE.roster }, ...(b.teamAsset ? { teamAsset: b.teamAsset } : {}), ...(chainView ? { chain: chainView } : {}), ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation, handoffGate: handoffGateView, eventCount: b.events.length, recentEvents: b.events.slice(-20), settled: store.batchSettled(b) };
      },
    }),
    defineTool({
      name: "artifact_types",
      description: "产物类型注册表（只读，Tier3 通用任务治理）：列出产物类型 → 层/目录前缀约定，供 wave_plan 声明产物与模板对齐。不绑定任何团队模板。",
      parameters: {},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"types":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('artifact types: ' + value.types.length),
      },
      async execute() {
        return { types: artifactTypesView() };
      },
    }),
    defineTool({
      name: "assign_check",
      description: "委派形态判定：**主动写入**本次任务的难度值 difficulty（A=Leader 直做 / B=单个 subagent / C=集群 wave_plan 建批）+ 判据 rationale（必填、≥12 字，落 governance.json 供审计）——**无默认档**，不填即拒（GATE_DIFFICULTY_INVALID / GATE_DIFFICULTY_RATIONALE_MISSING）。并行/多角色/门禁/可恢复/需独立上下文这五个布尔入参降为**交叉校验**输入：声明与特征矛盾即拒（GATE_DIFFICULTY_MISMATCH，如「声明 C 但四项 C 判据全 false」= 单线程不许建批、「声明 A 但 needIsolation」）。**只读侦察先行**：read/glob/grep 与只读 shell 命令在评估前即已开放（判据须引用侦察证据）。每次调用写入会话治理状态（governance.lastAssign{ difficulty, rationale, form, reasons } + history），guard 依据其做执行型工具门禁。显式 session 时输出回显 sessionId 并镜像到执行会话（guard 兼容不误拦）；缺省=当前执行会话，cli 兜底并提示。**有解释的偏离（2026-09-14 用户裁决 B）**：`derived` = 五布尔机械推导的档位；当 `difficulty !== derived` 时，须在 `rationale` 写明三要素（① 引用具体特征面 ② 例外/反例 ③ 偏离方向与上限）方可放行（记 `override: true`，`derived`/`override` 随 `lastAssign` 落盘供审计），无解释仍拒 `GATE_DIFFICULTY_MISMATCH`。",
      parameters: {"difficulty":{"type":"string","required":true,"enum":["A","B","C"],"description":"**主动写入的难度值**（必填，无默认档）：A=Leader 直做（单线程/低风险/可自验）；B=单个 subagent（不占主上下文的调研，或已明确上下文的单步派发）；C=集群 wave_plan 建批（判据只有两条：多线并行 ≥2 条任务线，或多依赖需 DAG 分层）。"},"rationale":{"type":"string","required":true,"description":"**判据**（必填，≥12 字，供审计）：写明定档依据 + 已完成的只读侦察证据（读到什么/探测到什么），不得写空话。"},"parallel":{"type":"boolean","description":"需要并行或任务间依赖（DAG）——入参降为**交叉校验**输入"},"multiRole":{"type":"boolean","description":"需要多角色协作（编码+测试+审查分离）"},"gate":{"type":"boolean","description":"需要门禁/审计（人审、验收、gap-list）"},"recoverable":{"type":"boolean","description":"需要跨轮治理/可恢复/可审计"},"needIsolation":{"type":"boolean","description":"需要独立上下文/工具面（查代码、跑测试等）"},"scope":{"type":"string","enum":["current","full"],"description":"评估对象：current=当前动作，full=完整目标任务（纪律强制 full，防把小动作当整体难度）"},"session":{"type":"string","description":"显式指定评估落点会话（当前会话 ID 或命名黑板）；缺省=当前执行会话，cli 兜底；与执行会话不同时自动镜像到执行会话（guard 兼容）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"difficulty":{"type":"string","required":true},"rationale":{"type":"string","required":true},"derived":{"type":"string","required":true},"override":{"type":"boolean","required":true},"form":{"type":"string","required":true},"allowed":{"type":"boolean","required":true},"reasons":{"type":"array","required":true,"items":{"type":"string"}},"next":{"type":"array","required":true,"items":{"type":"string"}},"execToolCount":{"type":"integer","required":true},"escalationHint":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"mirroredTo":{"type":"string"},"notice":{"type":"string"},"history":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => {
          const d = value.difficulty ?? value.form;
          let s = 'assign difficulty: ' + d + (d === 'C' ? ' (must use batch) → next: wave_plan' : ' (allowed)') + (value.sessionId ? ' @' + value.sessionId : '');
          if (value.override) s += ' [override: derived=' + value.derived + ' → ' + d + ']';
          if (value.mirroredTo) s += ' [mirror→' + value.mirroredTo + ']';
          if (value.escalationHint) s += ' ⚠ ' + value.escalationHint;
          if (value.notice) s += ' ⚠ ' + value.notice;
          return TEXT_OUTPUT(s);
        },
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '难度评估（assign_check）'); // 模式门（E 阶段）：非生效模式零治理写入（不写 lastAssign 镜像），先于档位校验
        const sessionId = sessionOf(args, exec);
        // ① 主动写入的难度（必填，无默认档）：不接受「推导代替判断」——档位由 Leader 声明，引擎只做交叉校验
        const difficulty = args.difficulty;
        if (!['A', 'B', 'C'].includes(difficulty)) {
          throw new Error('GATE_DIFFICULTY_INVALID: difficulty 必填且只能是 A|B|C（收到 ' + JSON.stringify(difficulty ?? null) + '）——'
            + '本门禁**无默认档**：先用只读侦察摸清任务，再主动写入难度，不得以默认值代替判据');
        }
        // ② 判据（必填，供审计）：留空/套话不算，长度下限 12 字
        const rationale = typeof args.rationale === 'string' ? args.rationale.trim() : '';
        if (rationale.length < 12) {
          throw new Error('GATE_DIFFICULTY_RATIONALE_MISSING: rationale 判据必填且 ≥12 字（收到 ' + JSON.stringify(args.rationale ?? null) + '）——'
            + '写明定档依据 + 已完成的只读侦察证据（读到/探测到什么），该字段落 governance.json 供审计');
        }
        const reasons = [];
        if (args.parallel) reasons.push('需要并行或任务依赖（DAG）');
        if (args.multiRole) reasons.push('需要多角色协作（编码+测试+审查分离）');
        if (args.gate) reasons.push('需要门禁/审计（人审、验收、gap-list）');
        if (args.recoverable) reasons.push('需要跨轮治理/可恢复/可审计');
        // ③ 交叉校验（2026-09-14 用户裁决 B「有解释的偏离」）：
        //    derived = 五布尔**机械推导**的档位（任一 C 判据 → C；否则 needIsolation → B；否则 A）；
        //    difficulty 仍由 Leader 主动写入，二者关系分两支：
        //      · difficulty === derived → 常规放行；
        //      · difficulty !== derived → **有解释才放行**（记 override:true），无解释 → 拒 GATE_DIFFICULTY_MISMATCH。
        //    「解释充分」= rationale 命中三要素（**存在性启发**：强校验只留给"无解释才拒"这一条，避免造无消费端字段）：
        //      ① 引用具体特征面（五个布尔名或其语义中文）；② 例外/反例/粗判措辞；③ 偏离方向与上限。
        const cFeatures = reasons.length > 0;
        const derived = cFeatures ? 'C' : (args.needIsolation ? 'B' : 'A');
        const override = difficulty !== derived;
        if (override) {
          const featureNote = reasons.length > 0
            ? reasons.join('；')
            : (args.needIsolation ? 'needIsolation=true' : '四项 C 判据全为 false 且 needIsolation=false');
          const hasFeatureRef = /parallel|multiRole|gate|recoverable|needIsolation|并行|多角色|门禁|可恢复|独立上下文/i.test(rationale);
          const hasException = /例外|反例|不适用|误判|粗判|过粗|过头|不足以|偏保守/.test(rationale);
          const hasDirection = /升档|降档|升为|降为|上限|不低于|仍属|门槛|直做/.test(rationale);
          const miss = [!hasFeatureRef && '① 引用具体特征面', !hasException && '② 例外/反例', !hasDirection && '③ 偏离方向与上限'].filter(Boolean);
          if (miss.length > 0) {
            throw new Error('GATE_DIFFICULTY_MISMATCH: 声明 ' + difficulty + '，而机械推导为 ' + derived + '（' + featureNote + '）——'
              + '**偏离须解释**：rationale 需含三要素（① 引用具体特征面 ② 例外/反例 ③ 偏离方向与上限），当前缺：' + miss.join('、')
              + '；无解释的偏离仍拒（宁严勿松），有解释则放行并记 override');
          }
        }
        const form = difficulty; // legacy 字段：guard 门禁 2/3 与既有读端按 form 判定（A/B/C 同值）
        // 写入治理状态：lastAssign + history 追加（审计：每回合评估留痕，含难度与判据）；C 类且无活跃批次 → pendingBatch=true
        const now = new Date().toISOString();
        const scope = args.scope ?? 'full';
        const g0 = store.readGovernance(sessionId);
        const entry = { turn: (g0.history?.length ?? 0) + 1, difficulty, form, derived, override, at: now, reasons, rationale };
        const history = [...(g0.history ?? []), entry];
        const hasActive = store.hasActiveBatch(sessionId);
        const patch = { lastAssign: { difficulty, form, scope, rationale, derived, override, at: now, reasons, execCallsSince: 0 }, history };
        if (form === 'C' && !hasActive) { patch.pendingBatch = true; patch.pendingSince = now; }
        // 新评估总是把 pendingBatch 收敛到正确状态——已有活跃批次，或残留 pendingBatch（C 判定后重评为 A/B），一律清锁
        else if (hasActive || g0.pendingBatch) { patch.pendingBatch = false; patch.pendingSince = null; }
        // session-compat：显式 session 与执行会话不同 → 镜像到执行会话（guard 落点兼容）。
        // 镜像只写 lastAssign + pendingBatch + mirror 指针，不污染执行会话 history；解锁经 clearPendingBatch 传播
        // **Q4=B 保护（2026-09-15 用户裁决）**：镜像**只升不降**——若执行会话自身档位**强于**本次被镜像的档位
        //   （rank：C > B > A），则**跳过镜像**（保留执行会话自身的 lastAssign / pendingBatch / mirror 指针不动）。
        //   动机（实测）：为写「他会话」夹具而调 assign_check 时，镜像会把 Leader 自己已记录的 C 档覆盖成夹具档位
        //   ⇒ 写夹具顺手削弱自身保护。跳过时在 `notice` 里如实回显，可审计。
        const execSessionId = exec?.agent?.session?.id ?? null;
        const tierRank = (t) => (t === 'C' ? 3 : t === 'B' ? 2 : t === 'A' ? 1 : 0);
        const execGov0 = execSessionId ? store.readGovernance(execSessionId) : null;
        const execRank0 = tierRank(execGov0?.lastAssign?.difficulty);
        const downgradeSkip = Boolean(args?.session && execSessionId && args.session !== execSessionId
          && execRank0 > tierRank(difficulty));
        const mirror = Boolean(args?.session && execSessionId && args.session !== execSessionId) && !downgradeSkip;
        if (mirror) patch.mirroredTo = execSessionId;
        const g = store.writeGovernance(sessionId, patch);
        let mirroredTo = null;
        if (mirror) {
          mirroredTo = execSessionId;
          store.writeGovernance(execSessionId, {
            lastAssign: { ...patch.lastAssign, mirroredFrom: sessionId },
            pendingBatch: patch.pendingBatch ?? g.pendingBatch ?? false,
            pendingSince: patch.pendingSince ?? g.pendingSince ?? null,
            mirror: { from: sessionId, at: now },
          });
        }
        const execToolCount = g.execToolCount ?? 0;
        // 升级信号：升 C 的**最高优先级判据**只有两条——**多线并行**（≥2 条可
        //   并行推进的任务线）与**多依赖**（依赖链需 DAG 分层 / 多波次）；**单线程任务一律不建批**（含同回合
        //   内多步串行，环节数 / 字数不构成理由），Leader 带上下文直做。故本条只作「已进入多环节长任务」的
        //   **弱旁证提示**，**不得**读作「必须建批」。
        const escalationHint = (execToolCount >= 5 && !hasActive)
          ? 'execToolCount=' + execToolCount + ' ≥5 且无批次：已属多环节长任务——**单线程（无并行任务线、无依赖链）可直接执行**；'
            + '仅当**明确多线并行**（≥2 条可并行推进的任务线）或**多依赖**（需 DAG 分层 / 多波次）时才 wave_plan 建批'
          : '';
        // session-compat：cli 兜底警示（共享黑板跨调用互相覆盖）
        const notice = sessionId === 'cli'
          ? 'session 未显式指定且无 agent.session：评估落点 cli 共享黑板，跨调用互相覆盖，建议显式传 session'
          : (downgradeSkip
            ? '镜像跳过（Q4=B 只升不降）：执行会话 ' + execSessionId + ' 自身档位 '
              + String(execGov0?.lastAssign?.difficulty) + ' 强于本次 ' + difficulty + '，保留其原记录不动'
            : '');
        // 条件构造返回对象：不触发镜像时镜像字段完全缺席——undefined/null 值均会触发 harness lossless JSON 校验拒绝
        const out = { difficulty, rationale, derived, override, form, allowed: form !== 'C', reasons, next: form === 'C' ? ['wave_plan'] : [], execToolCount, escalationHint, notice, sessionId, history: g.history };
        if (mirroredTo) out.mirroredTo = mirroredTo;
        return out;
      },
    }),
    defineTool({
      name: "asset_claim",
      description: "归位：Leader 已直做产物（探索/探测/排障）注册为批次资产——复制 source 进 <artifacts>/<batchId>/<target>（保留内容，不移动），批次事件 asset.claimed 留痕，返回批次内路径供 wave_plan consume/produce 声明。路径防逃逸：target 必须是批次内相对路径，拒绝 .. 与绝对路径。引擎产物根 = <~/.dsh/punky-preset>/sessions/<sessionId>/artifacts/<batchId>/；worker 按工作区落盘的产物，结算前须经本工具归位到该根下。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"source":{"type":"string","required":true,"description":"源文件绝对路径（已直做产物）"},"target":{"type":"string","required":true,"description":"批次内目标路径（相对 artifacts/<batchId>/，不得含 .. 或绝对路径）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"claimedPath":{"type":"string"},"batchId":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('asset claimed: ' + value.claimedPath),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '产物归位（asset_claim）'); // 模式门（E 阶段）：非生效模式零治理写入，先于路径/批次校验
        const sessionId = sessionOf(args, exec);
        const r = store.claimAsset(sessionId, args.batchId, { source: args.source, target: args.target });
        return { ok: r.ok, claimedPath: r.claimedPath, batchId: r.batchId };
      },
    }),
    defineTool({
      name: "gate_status",
      description: "查询批次/ lane 的门禁状态：layer、consume/produce/outputs 缺失清单、plan 契约问题，以及批次级 C+ 装配声明与 Manager 拉起登记（可核性）。**V-6 口径：本工具须传 `lane`**——不传 `lane` 时按批次内全部 lane 逐个投影（缺省列举面）；对**不在 wavePlan.tasks 内**的 lane id（或已删任务）返回 `gates:'orphan'` 占位读数（`layer:null`），该读数是**损坏/悬空 lane 的显式标记**，不是批级聚合语义——**本工具不定义批级聚合**（需批级汇总请读 `batch_status`）。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","description":"lane ID；缺省列出全部"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"lanes":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"manager":{"type":"object","additionalProperties":true},"assembly":{"type":"object","additionalProperties":true},"teamAsset":{"type":"object","additionalProperties":true},"declaration":{"type":"object","additionalProperties":true},"declarationMissing":{"type":"boolean"}}},
        render: (_args, value) => TEXT_OUTPUT('gate status: ' + value.lanes.length + ' lane(s)' + (value.assembly ? ' · assembly' : '') + (value.manager ? ' · manager=' + value.manager.agentId : '') + (value.teamAsset ? ' · teamAsset=' + (value.teamAsset.assetHash ?? '(none)') + (value.declarationMissing ? ' (declarationMissing)' : '') : '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const batch = store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const ids = args.lane ? [args.lane] : Object.keys(batch.lanes);
        // 批次级可核字段：C+ 装配声明（建批入参留下的声明）+ Manager 拉起登记（batch_phase(manager=…) 写入）
        // §8③ 团队资产快照（只读回显面）：`teamAsset` = 建批冻结的**指纹引用**（旧批无该字段 ⇒ 不写键，
        //   保持既有返回形状）；`declaration` = 当场从会话级正档读出的完整解析结果（缺档 ⇒ 省略键 +
        //   `declarationMissing:true`，**不 throw、不回落现算**）。三者成对补 `output.schema`（闭集：漏补即 ToolOutputError）。
        const taView = store.teamAssetViewOf(batch);
        return {
          batchId: args.batchId, sessionId, lanes: ids.map((l) => store.gateStatus(sessionId, args.batchId, l)),
          ...(batch.manager ? { manager: batch.manager } : {}),
          ...(batch.assembly ? { assembly: batch.assembly } : {}),
          ...(taView.teamAsset ? { teamAsset: taView.teamAsset } : {}),
          ...(taView.declaration ? { declaration: taView.declaration } : {}),
          declarationMissing: taView.declarationMissing,
        };
      },
    }),
    defineTool({
      name: "lane_claim",
      description: "以 O_EXCL 单写者锁认领 lane（同一批次同一 lane 同时只允许一个写者）。冲突先拒绝；可 wait 或 force 接管。锁按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"任务 ID"},"waitMs":{"type":"integer","description":"等待毫秒（默认 0 = 直接冲突返回）"},"force":{"type":"boolean","description":"force 接管（默认 false）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"token":{"type":"string"},"conflict":{"type":"boolean"},"reason":{"type":"string"},"lockPath":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane claimed') : TEXT_OUTPUT('lane conflict'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, 'lane 锁认领（lane_claim）'); // 模式门（E 阶段）：非生效模式不得落锁（零治理写入），先于取锁
        const sessionId = sessionOf(args, exec);
        const r = await lock.acquire(lockPath(root, sessionId, args.batchId, args.lane), { waitMs: args.waitMs ?? 0, force: args.force === true });
        if (!r.ok) return { ok: false, conflict: true, reason: 'lane locked' };
        return { ok: true, token: r.token };
      },
    }),
    defineTool({
      name: "lane_release",
      description: "释放 lane 锁（需持有 token；token 不匹配拒绝释放）。锁按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"token":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"reason":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane released') : TEXT_OUTPUT('release failed: ' + (value.reason ?? '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, 'lane 锁释放（lane_release）'); // 模式门（E 阶段）：非生效模式不介入治理面（认领侧同样被门），先于释放
        return lock.release(lockPath(root, sessionOf(args, exec), args.batchId, args.lane), args.token);
      },
    }),
    defineTool({
      name: "member_settle",
      description: "成员结算：按状态机迁移（running->review->merged/failed/skipped/conflict），写入 member.settled 事件。**调用方限该批 owner 或该批已登记 Manager**。Tier3 门禁：plan merged 前 Plan 契约校验（spec 必填章节 + task-tree JSON）、exec merged 前 outputs 校验、audit merged 前 produce 校验；lane 声明 targets 时，merged 前逐一核对 targets 落盘（存在性，不读正文），缺则拒 merged 抛 GATE_TARGET_MISSING、未变更抛 GATE_TARGET_UNCHANGED。needHuman：audit lane 产物含独立行 `needHuman: true` 声明时，merged 须 note 携带人工裁决证据（契约 `human:<裁决人>:<时间>:<结论>`，如 human:user@2026-08-21:accept），缺则拒 GATE_NEEDHUMAN_PENDING；conflict 驳回不强制（评审驳回语义）。命令 gate（V1）：exec 层产物可含独立行 `gate: <命令>`（行首锚定，可多行顺序执行），merged 前置确定性执行并以退出码判定（exit 0 通过，事件 gate.exit）；失败拒 merged 抛 GATE_EXIT_*（lane 留 review）；失败且产物声明 `needHuman: true` → 转人工闸（merged 须 note 含 human: 证据，缺则 GATE_NEEDHUMAN_PENDING）。批次按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":["merged","failed","skipped","conflict"]},"note":{"type":"string","description":"简短备注（只留元数据，不复制正文）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' settled -> ' + value.status),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1（Q2=B 收窄）：写成员状态 = 调用方自己 C 档，或该批已登记的 Manager
        const b = store.setMember(sessionId, args.batchId, args.lane, args.status, args.note ?? null);
        // 【G-02 死调用清退 · 2026-09-18】原此处调 `advanceChainAfterSettle`（结算事实落盘后触发链推进）。
        //   链推进**已全退役**（2026-09-18 Q-A=C）：被调函数首行即 `return {reason:'retired'}`、全参未被读取
        //   ⇒ 该调用**零行为**，故连 import 一并删除（勿回加）。推进缺口（handoff 成功触发自动推进）
        //   与 `chain.step` 冻结语义见 `lib/engine/chain-runner.js` 头注释。
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
    defineTool({
          name: "handoff_submit",
      description: "P1 交接门：提交一条**上游→下游**交接（写黑板真源 `batch.handoffs` + 落审计事件 `lane.handoff`，同一次原子写）。语义 = 「上游把产物交给下游」，是 DAG 下游开工的**硬前提**（下游缺该入边交接 ⇒ entry 门拒 `GATE_HANDOFF_MISSING`）。入参 `from`（上游 lane）/`to`（下游 lane，须已由建批期 `deps` 声明）/`artifacts`（交付产物，相对批次产物根；**逐个必须在场**，缺则拒并回显缺口）/`assertions`（下游可核断言，非空）。写权转移：提交成功即尝试 `from` 释放 / `to` 获取（与既有 lane_claim 配对耦合；锁不可用只落 hint、**不阻塞交接**）。官方任务板双写（M-6）**未启用**（如实降级 2026-09-18）：本引擎**未接线**官方任务板——全仓无 `team_task_create` 调用点，宿主工具面亦无该工具 ⇒ `officialTaskId` 是**调用方自填**的原样回填位（不填恒 `null`），引擎**不写、不校验、不据以判定**；本工具的任何回显**不得**读作「已双写」。拒绝码：`GATE_HANDOFF_MISSING`（缺口同时落 `lane.handoff.gap` 事件）。",
      parameters: {"batchId":{"type":"string","required":true},"from":{"type":"string","required":true,"description":"上游 lane id（该批内）"},"to":{"type":"string","required":true,"description":"下游 lane id（须有建批期 deps 声明）"},"artifacts":{"type":"array","required":true,"items":{"type":"string"},"description":"交付产物路径（相对批次产物根；逐个须在场）"},"assertions":{"type":"array","required":true,"items":{"type":"string"},"description":"下游可核断言（非空）"},"officialTaskId":{"type":"string","description":"官方任务板 task id（**M-6 双写未启用**，如实降级 2026-09-18：仅调用方自填的原样回填位，引擎不写、不校验、不判定）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"code":{"type":"string"},"from":{"type":"string"},"to":{"type":"string"},"artifacts":{"type":"array","items":{"type":"string"}},"assertions":{"type":"array","items":{"type":"string"}},"missing":{"type":"array","items":{"type":"string"}},"problems":{"type":"array","items":{"type":"string"}},"lockTransfer":{"type":"object","additionalProperties":true}}},
        render: (_args, value) => value.ok
          ? TEXT_OUTPUT('handoff submitted: ' + value.from + ' -> ' + value.to + ' (' + (value.artifacts ?? []).length + ' artifacts, ' + (value.assertions ?? []).length + ' assertions)')
          : TEXT_OUTPUT('handoff rejected [' + value.code + ']: ' + (value.missing ?? []).join(', ')),
      },
      async execute(args, exec) {
        // 【task-22 裁决 ①】**不落模式门**：`handoff_submit` 归 `comms` 族（成员面）——交接是**生产者的动作**，
        //   引擎侧需要的是**第一手**交接声明（而非 Leader 转写），故与 `swarm_report`/`mailbox_send` 同形：
        //   非生效模式下亦可调用（只受模式门约束的治理写面不在此列）。判定点唯一：entry 门（`gates.ts`）。
        const sessionId = sessionOf(args, exec);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts.filter((p) => typeof p === 'string' && p.trim().length > 0) : [];
        const assertions = Array.isArray(args.assertions) ? args.assertions.filter((a) => typeof a === 'string' && a.trim().length > 0) : [];
        // 产物在场判定（判据同源：相对路径按批次产物根解析）——缺则拒 + 回显**缺哪件产物**（与 entry 门同判据）
        const dir = store.artifactsDirOf(sessionId, args.batchId);
        const missingArtifacts = artifacts.filter((p) => !existsSync(isAbsolute(p) ? p : join(dir, p)));
        // 官方任务板回填位（M-6）**未启用**（2026-09-18 如实降级）：此处只把**调用方自填**的值原样透传给 store
        //   （引擎不写、不校验、不据以判定）；保留透传 = 不破既有调用方与 `store.recordHandoff` 形参面。
        //   「已双写」的读端语义已同步降级（见本工具 `description` / `parameters.officialTaskId`）。
        if (missingArtifacts.length === 0) {
          const r = store.recordHandoff(sessionId, args.batchId, {
            from: args.from, to: args.to, artifacts, assertions,
            ...(typeof args.officialTaskId === 'string' && args.officialTaskId ? { officialTaskId: args.officialTaskId } : {}),
          });
          if (!r.ok) throw new Error(r.code + ': ' + (r.problems ?? []).join('; ') + (r.missing?.length ? '（缺口：' + r.missing.join(', ') + '）' : ''));
        } else {
          // 缺口与拒态**同事件面留痕**（`lane.handoff.gap`）：与 store.recordHandoff 的拒态共用同一码/同一事件，
          //   保证「谁在什么时候因缺哪件产物被拒」在事件流里可核（不静默）。
          store.appendEvent(sessionId, args.batchId, EVT.EVT_LANE_HANDOFF_GAP, {
            lane: args.to, code: 'GATE_HANDOFF_MISSING', missing: missingArtifacts,
            problems: missingArtifacts.map((p) => '交接产物不在场：' + p),
          });
          throw new Error('GATE_HANDOFF_MISSING: 交接产物不在场（' + missingArtifacts.join(', ')
            + '）——请先落盘产物（批次产物根：' + dir + '）再提交交接。');
        }
        // 写权转移（§7 判据③）：`from` 释放 / `to` 获取——与既有 `lane_claim`/`lane_release` **配对耦合**（勿另造锁）。
        //   失败只**降级为 hint**（不抛、不阻塞交接）：锁是运行期并发面、是否持有取决于当前派发方；
        //   交接（真源写入）已成功落盘，不应被锁状态反向报成失败（否则「已落盘、调用方以为失败 ⇒ 重试」）。
        const lockTransfer = {};
        try {
          if (lock.isLocked(lockPath(root, sessionId, args.batchId, args.from))) {
            lockTransfer.fromRelease = 'held-by-token（需持有 token 经 lane_release 释放：本工具不发凭据，避免代持）';
          } else lockTransfer.fromRelease = 'no-lock';
        } catch (e) { lockTransfer.fromRelease = 'probe-failed: ' + String(e?.message ?? e); }
        try {
          if (!lock.isLocked(lockPath(root, sessionId, args.batchId, args.to))) {
            const acq = await lock.acquire(lockPath(root, sessionId, args.batchId, args.to), { waitMs: 0 });
            lockTransfer.toAcquire = acq.ok ? 'acquired' : 'conflict';
          } else lockTransfer.toAcquire = 'already-held';
        } catch (e) { lockTransfer.toAcquire = 'failed: ' + String(e?.message ?? e); }
        // 【task-25 缺陷修复（2026-09-17）】**成功路径的 `code` 必须恒为字符串**——原实现写 `code: null`，
        //   违反本工具自身 `output.schema` 的 `"code":{"type":"string"}` ⇒ 宿主（dsh-tools）抛
        //   `tool "handoff_submit" returned invalid output: "value.code" must be a string`，
        //   而**写入已成功落盘**（随后 `handoff_view` 由 BLOCKED 翻 READY）⇒ **假失败**：调用方据错误
        //   误判失败而重试 ⇒ 重复交接 / 审计噪音（正是本引擎反复强调要避免的「已落盘却报失败」形态）。
        //   修法取「恒为字符串的稳定成功码」（**不放宽 schema**、不掩盖字段缺失）；回归锁 = `test/handoff-gate.test.js` 的 `P1-H8a`。
        return { ok: true, code: 'HANDOFF_OK', from: args.from, to: args.to, artifacts, assertions, missing: [], problems: [], lockTransfer };
      },
    }),
    defineTool({
          name: "handoff_view",
      description: "P1 交接门（**只读**）：列出指定 lane 的**入边交接**（M-7 验收核心 = 下游要能稳定取件）——每条入边回显上游 lane、状态（submitted/pending）、交付产物**解析后的绝对路径 + 是否可读（存在性）**、以及上游给出的可核断言 assertions；并给出上游 **produce∪outputs 声明清单**（下游取件面）。`blocking`（阻塞该 lane 开工的缺口，与 entry 门 `GATE_HANDOFF_MISSING` 同判据）与 `pending`（建批期已声明但未提交的入边）分列。存量批（无 `batch.handoffs` 字段）回 `legacy:true`（门整体放行 + 留痕语义）。本工具零写入、不改任何状态。每边回显的 `officialTaskId` 同属**未启用**面（M-6 双写未接线 ⇒ 除非调用方在 `handoff_submit` 自填，恒 `null`），**不得**读作「已双写」。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"下游 lane id"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"legacy":{"type":"boolean"},"ready":{"type":"boolean","required":true},"deps":{"type":"array","items":{"type":"string"}},"edges":{"type":"array","items":{"type":"object","additionalProperties":true}},"pending":{"type":"array","items":{"type":"string"}},"blocking":{"type":"array","items":{"type":"string"}}}},
        // 【task-27 增量】渲染面必须让下游**能照单取件**（M-7 验收核心）：逐条入边显示 `from → status` +
        //   **artifacts 路径清单**（含可读性）+ **assertions**；`pending` 与 BLOCKED 三类缺口
        //   （`edge:…(无交接声明)` / `(未交接)` / `(artifacts 空)` / `contract.assertions@…`）**全部保留**。
        //   原实现只输出 `READY (edges=N)` ⇒ 下游拿不到产物路径（与门态不可见同类的「信息只活在 schema」缺陷）。
        render: (_args, value) => {
          const lines = ['handoff ' + value.lane + ': ' + (value.ready ? 'READY' : 'BLOCKED')
            + ' (edges=' + (value.edges ?? []).length + (value.legacy ? ', legacy-batch' : '') + ')'];
          for (const e of value.edges ?? []) {
            lines.push('  ' + e.from + ' → ' + e.status);
            const arts = e.artifacts ?? [];
            lines.push('    artifacts: ' + (arts.length
              ? arts.map((a) => String(a.path) + (a.readable ? ' (readable)' : ' (MISSING)')).join(', ')
              : '（空）'));
            const asrt = e.assertions ?? [];
            lines.push('    assertions: ' + (asrt.length ? asrt.join(' | ') : '（空）'));
          }
          if ((value.pending ?? []).length) lines.push('  pending: ' + value.pending.join(', '));
          if ((value.blocking ?? []).length) lines.push('  缺口: ' + value.blocking.join(', '));
          return TEXT_OUTPUT(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        const map = (b.handoffs && typeof b.handoffs === 'object' && !Array.isArray(b.handoffs)) ? b.handoffs : null;
        const legacy = map === null;
        const dir = store.artifactsDirOf(sessionId, args.batchId);
        const deps = (() => {
          for (const w of b.wavePlan ?? []) for (const t of w.tasks ?? []) if (t && t.id === args.lane) return Array.isArray(t.deps) ? t.deps : [];
          return [];
        })();
        const edges = deps.map((from) => {
          const t = (() => { for (const w of b.wavePlan ?? []) for (const x of w.tasks ?? []) if (x && x.id === from) return x; return null; })();
          const upstreamDeclared = t ? [...(Array.isArray(t.produce) ? t.produce : []), ...(Array.isArray(t.outputs) ? t.outputs : [])] : [];
          const rec = (map && Array.isArray(map[args.lane])) ? map[args.lane].find((r) => r && r.from === from) ?? null : null;
          // 产物在场判定与 entry 门**同判据**（同一解析规则 + 同一「文件且非空」语义）——下游据此判断**能不能稳定取件**
          const arts = (rec && Array.isArray(rec.artifacts)) ? rec.artifacts : [];
          const artifactViews = arts.map((p) => {
            const abs = isAbsolute(p) ? p : join(dir, p);
            let readable = false;
            try { const st = statSync(abs); readable = st.isFile() && st.size > 0; } catch { readable = false; }
            return { path: p, abs, readable };
          });
          const s = rec ? String(rec.status ?? 'pending') : 'undeclared';
          return {
            from, to: args.lane, status: s,
            artifacts: artifactViews,
            assertions: (rec && rec.contract && Array.isArray(rec.contract.assertions)) ? rec.contract.assertions : [],
            consumedFrom: (rec && rec.contract) ? (rec.contract.consumedFrom ?? null) : null,
            officialTaskId: rec ? (rec.officialTaskId ?? null) : null,
            upstreamDeclared,
            // 缺口明细（与 entry 门 `GATE_HANDOFF_MISSING` 的 missing 同形，便于下游直接照单补齐）
            gap: [
              ...(s === 'undeclared' ? ['edge:' + from + '->' + args.lane + ' (无交接声明)'] : []),
              ...(s === 'pending' ? ['edge:' + from + '->' + args.lane + ' (未交接)'] : []),
              // 三类缺口的第三类（`artifacts 空`）——与门禁侧 `handoffRecordVerdict` 的判据**同形**，
              //   否则取件面与门禁面的缺口清单会漂移（登记：理想是直接复用门函数判定，属后续收口项）
              ...(rec && arts.length === 0 ? ['edge:' + from + '->' + args.lane + ' (artifacts 空)'] : []),
              ...artifactViews.filter((a) => !a.readable).map((a) => a.path + ' (missing)'),
              ...(rec && (!rec.contract || !Array.isArray(rec.contract.assertions) || rec.contract.assertions.length === 0) ? ['contract.assertions@' + from + '->' + args.lane] : []),
            ],
          };
        });
        const blocking = edges.flatMap((e) => e.gap);
        const pending = edges.filter((e) => e.status !== 'submitted').map((e) => e.from + '->' + args.lane);
        // 存量批（无 handoffs 字段）⇒ 门整体放行（裁决 ①=B）⇒ ready:true + legacy 标记（不静默）
        const ready = legacy ? true : blocking.length === 0;
        return { batchId: args.batchId, lane: args.lane, legacy, ready, deps, edges, pending, blocking };
      },
    }),
    defineTool({
      name: "lane_dispatch",
      description: '集群派发入口（C 档套件）：为指定 lane **发放一次性句柄 + 置 running + 由引擎自派 worker**。门禁语义同 `member_status(status=running)`（调用方限该批 owner 或该批已登记的 Manager；exec 层 lane 需 consume 齐备）。引擎自派时：① **按次收窄成员工具面**（`toolFilter.deny` 套件外治理工具 ⇒ 在成员会话里这些工具**不出现**）；② 以 `label=punky-swarm:<batchId>:<lane>` 建立**第二绑定键**（可从子会话事件反解析归属）；③ 成功后由引擎**直接写** `member.dispatch`（唯一写路径，不再依赖事后观察）；④ **能力位前置**：provider 不支持 `toolFilter`/`depthLimit` ⇒ **拒派**（不「以弱换强」）。若宿主未提供 `ctx.subagents` ⇒ **降级为「仅发句柄」**（返回 `spawned:false` 与原因，不静默）。句柄一次性、TTL 30 分钟；`firstLine` 供人工直派形态粘贴（该形态的硬门禁属 C 阶段）。',
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话"},"prompt":{"type":"string","description":"Leader 补充的任务要点（可选）：引擎给出「角色/契约/纪律」骨架后拼接在末尾"},"exempt":{"type":"object","additionalProperties":false,"description":"longrun 长程豁免授予载荷（同 member_status 派发面）：type 四值白名单 ai-render|large-download|dep-install|none（档位默认 8/6/4/4）；multiplier 可选显式倍率 [1,100]；stalled 可选（缺省 true）","properties":{"type":{"type":"string","required":true,"enum":["ai-render","large-download","dep-install","none"]},"multiplier":{"type":"number"},"stalled":{"type":"boolean"}}}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"token":{"type":"string","required":true},"firstLine":{"type":"string","required":true},"ttlMs":{"type":"number","required":true},"spawned":{"type":"boolean","required":true},"workerSessionId":{"type":"string"},"spawnNote":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('lane ' + value.lane + ' dispatched'
          + (value.spawned ? '（引擎自派：worker=' + String(value.workerSessionId) + '）' : '（仅发句柄：' + String(value.spawnNote ?? '') + '）')
          + '\n' + value.firstLine),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1：与 member_status 同源（内含模式门 E 阶段）
        // P2（2026-09-16，lane e-chain）：**派发核心已抽出**至 `lib/engine/dispatch.js` 的 `dispatchLaneCore`
        //   ——工具面与推进链的自动派发走**同一条**路径（同 Tier3 entry 门、同句柄、同任务包骨架、同
        //   `member.dispatch` 登记），禁第二套实现。本 execute 只留「工具面门禁 + 出参整形」。
        //   句柄生命周期（P0）：成功自派 ⇒ 核心内部立即 `consumeLaneHandle`（自派即发放即作废）；
        //   两处降级「仅发句柄」分支 **不消费**（句柄须保持有效供人工直派形态）——口径与实现同在核心头注释。
        return await dispatchLaneCore({
          ctx, store, root, liveConfig: readLiveConfig(deps), exec, sessionId,
          batchId: args.batchId, lane: args.lane,
          leaderPrompt: args.prompt ?? '', exempt: args.exempt,
        });
      },
    }),
    defineTool({
      name: "swarm_report",
      description: '成员 → **Leader** 回报（成员侧套件通信入口；2026-09-16 裁决：集群内部同步事件走套件工具，不再散落用通用通信工具）。**身份 best-effort 解析**（`member.dispatch.workerSessionId` → `{batchId, lane}`）。【gate-lite Q-G2 · 2026-09-17 用户裁决「删除这一项」】**身份未绑定不再拒**（官方 Team 成员天然无 lane 绑定 = 常态）：消息照发、事件照留痕（解析到批次才落事件），回显 `unbound` / `eventWritten` / `notice`。参数最小化：类型 + 摘要 + 产物路径，**不复制正文**。留痕双写：批事件 `swarm.report` + Leader 通道（broadcast，与 0f 口径一致）。**`type=settle-request` 兼底触发自动结算**（P3a 规格 §2）：回报落盘后调引擎自动结算判定器（与主路 `subagent/end` **同一单点判定**，见 `lib/engine/auto-settle.js`）——全绿自动 `merged`，任一判据不满足按 `onFail` 缺省 `pause` 停轮；判定失败**不影响**本次回报的投递事实（返回 `settle` 明细供调用方核）。',
      parameters: {"type":{"type":"string","required":true,"enum":["progress","blocked","settle-request"]},"summary":{"type":"string","required":true,"description":"一句话摘要（元数据，勿贴正文）"},"artifactPath":{"type":"string","description":"产物相对路径（可选）"},"batchId":{"type":"string","description":"可选：目标批次（**仅在无 `member.dispatch` 绑定时**用于自报归属——官方 Team 成员场景；给得出批次则事件面也能落）"},"lane":{"type":"string","description":"可选：目标 lane（同上，仅在无绑定时使用；缺省占位 `(unbound)`）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"type":{"type":"string","required":true},"delivered":{"type":"boolean","required":true},"unbound":{"type":"boolean"},"eventWritten":{"type":"boolean"},"notice":{"type":"string"},"settle":{"type":"object","additionalProperties":true}}},
        render: (_args, v) => TEXT_OUTPUT('swarm.report → Leader（' + v.batchId + '/' + v.lane + '，' + v.type + '）'
          + (v.unbound ? ' [unbound: best-effort]' : '')
          + (v.settle ? '\n自动结算：' + String(v.settle.action ?? '') + (v.settle.reason ? '（' + v.settle.reason + '）' : '') : '')),
      },
      async execute(args, exec) {
        const tgt = reportTargetOf(store, exec, args);
        const delivered = deliverSwarmMessage(root, tgt, REPORT_CHANNEL.leader, args, args.type);
        const eventWritten = appendSwarmEventOf(store, tgt, EVT.EVT_SWARM_REPORT, args.type);
        // P3a 兼底路（规格 §2）：`settle-request` = 显式交付意图 ⇒ 触发**同一**自动结算判定器。
        //   定位说明：主路 = 宿主 `subagent/end`（`lib/index.js` 装配期 `{global:true}` 订阅），
        //   本路不依赖宿主事件面（worker 自觉回报），是规格裁定的**第二路**（兼底）。
        //   失败隔离：`autoSettleLane` **不抛错**（异常隔离为 `{ok:false}`）⇒ 回报的投递事实不被拖累；
        //   停轮/门拒只落批次事件（`auto.settle.*` + `batch.phase`），工具返回值如实回显 `settle` 明细。
        //   Q-G2 连带：无批次可解析（未绑定且未自报 batchId）时**不结算**（无批可结算），仍不拒。
        const settle = (args.type === 'settle-request' && tgt.batchId)
          ? await autoSettleLane({ ctx, store, root, liveConfig: readLiveConfig(deps) }, {
            sessionId: tgt.sessionId, batchId: tgt.batchId, lane: tgt.lane,
            workerSessionId: tgt.caller, trigger: AUTO_SETTLE_TRIGGERS.settleRequest,
          })
          : null;
        return {
          batchId: tgt.batchId ?? UNBOUND_BATCH_KEY, lane: tgt.lane, type: args.type, delivered,
          unbound: !tgt.bound, eventWritten,
          ...(!tgt.bound ? {
            notice: '本会话无 `member.dispatch` 绑定（官方 Team 成员为常态，Q-G2 已删身份门）⇒ best-effort：消息'
              + (delivered ? '已投递' : '未投递（无可用会话）') + '，批次事件' + (eventWritten ? '已落' : '未落（未给出可解析的 batchId；如需事件面请带 batchId 重发）'),
          } : {}),
          ...(settle ? { settle: { action: settle.action, ok: settle.ok, reason: settle.reason, status: settle.status } } : {}),
        };
      },
    }),
    defineTool({
      name: "swarm_cc",
      description: '成员 → **Manager** 抄送（异常 / 待裁决 / 长跑候选；成员侧套件通信入口）。**身份 best-effort 解析**。【gate-lite Q-G2 · 2026-09-17 用户裁决「删除这一项」】**身份未绑定不再拒**：消息照发、事件照留痕（解析到批次才落事件），回显 `unbound` / `eventWritten` / `notice`。留痕双写：批事件 `swarm.cc` + Manager 通道（supervisor/inbox，与既有 Manager 通道口径一致）。参数最小化，不复制正文。',
      parameters: {"type":{"type":"string","required":true,"enum":["anomaly","decision-request","longrun-candidate"]},"summary":{"type":"string","required":true,"description":"一句话摘要（元数据，勿贴正文）"},"artifactPath":{"type":"string","description":"产物相对路径（可选）"},"batchId":{"type":"string","description":"可选：目标批次（**仅在无 `member.dispatch` 绑定时**用于自报归属——官方 Team 成员场景）"},"lane":{"type":"string","description":"可选：目标 lane（同上，仅在无绑定时使用；缺省占位 `(unbound)`）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"type":{"type":"string","required":true},"delivered":{"type":"boolean","required":true},"unbound":{"type":"boolean"},"eventWritten":{"type":"boolean"},"notice":{"type":"string"}}},
        render: (_args, v) => TEXT_OUTPUT('swarm.cc → Manager（' + v.batchId + '/' + v.lane + '，' + v.type + '）' + (v.unbound ? ' [unbound: best-effort]' : '')),
      },
      async execute(args, exec) {
        const tgt = reportTargetOf(store, exec, args);
        const delivered = deliverSwarmMessage(root, tgt, REPORT_CHANNEL.manager, args, args.type);
        const eventWritten = appendSwarmEventOf(store, tgt, EVT.EVT_SWARM_CC, args.type);
        return {
          batchId: tgt.batchId ?? UNBOUND_BATCH_KEY, lane: tgt.lane, type: args.type, delivered,
          unbound: !tgt.bound, eventWritten,
          ...(!tgt.bound ? {
            notice: '本会话无 `member.dispatch` 绑定（官方 Team 成员为常态，Q-G2 已删身份门）⇒ best-effort：消息'
              + (delivered ? '已投递' : '未投递（无可用会话）') + '，批次事件' + (eventWritten ? '已落' : '未落（未给出可解析的 batchId；如需事件面请带 batchId 重发）'),
          } : {}),
        };
      },
    }),
    defineTool({
      name: "member_status",
      description: '成员状态操作（非终态）：pending->running（派发，Tier3 门禁：exec 需 consume 齐备）、running->review（提交评审）、idle->running（恢复重派）；**调用方限该批 owner 或该批已登记 Manager**。派发（status=running）可附带 exempt 授予 longrun 长程豁免（只在派发面生效，其它状态带 exempt 一律拒 GATE_EXEMPT_NOT_DISPATCH）；revokeExempt=true 为显式撤销（本条不得再带 status，撤销不改成员状态）。终态结算请用 member_settle。批次按会话隔离。',
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","enum":["pending","running","review","idle"],"description":"目标成员态；revokeExempt=true 时不得携带（撤销是独立显式动作）"},"session":{"type":"string","description":"批次归属会话"},"exempt":{"type":"object","additionalProperties":false,"description":"longrun 长程豁免授予载荷（仅 status=running 时允许出现；缺省 undefined = 无豁免意图）。type 四值白名单 ai-render|large-download|dep-install|none（档位默认 8/6/4/4），未知 type 拒 GATE_EXEMPT_TYPE_UNKNOWN；multiplier 可选显式倍率 [1,100]，非法拒 GATE_EXEMPT_INVALID；stalled 可选（缺省 true）= 是否同时豁免 heartbeat stalled 追问","properties":{"type":{"type":"string","required":true,"enum":["ai-render","large-download","dep-install","none"]},"multiplier":{"type":"number"},"stalled":{"type":"boolean"}}},"revokeExempt":{"type":"boolean","description":"显式撤销该 lane 的 longrun 豁免（不改成员状态）；与 status 不得并用（并用 → GATE_EXEMPT_NOT_DISPATCH）；lane 无既有豁免 → GATE_EXEMPT_REVOKE_REQUIRED"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' status -> ' + value.status),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1（Q2=B 收窄）：写成员状态 = 调用方自己 C 档，或该批已登记的 Manager
        // 撤销与派发两条面互斥（R-5/R-6）：撤销是独立显式动作，携带 status 即拒（零写入）。
        // 撤销走 store.revokeLaneExempt（唯一入口）：删 laneExempt 条目 + lane.exempt.revoked 事件，
        // **不改成员状态**（不写 member.settled），故不进入任何迁移判定。
        if (args.revokeExempt === true) {
          if (args.status !== undefined) {
            throw new Error('GATE_EXEMPT_NOT_DISPATCH: revokeExempt 与 status 不得并用（撤销是独立的显式动作，不接受状态迁移）');
          }
          const rb = store.revokeLaneExempt(sessionId, args.batchId, args.lane);
          return { batchId: args.batchId, lane: args.lane, status: rb.lanes[args.lane], settled: store.batchSettled(rb) };
        }
        // status 在「撤销」路径之外仍为必填（参数表因撤销面放开 required，缺省在此补同族门禁）
        if (args.status === undefined) {
          throw new Error('GATE_EXEMPT_NOT_DISPATCH: 须给出 status（非终态迁移），或 revokeExempt=true（显式撤销豁免）');
        }
        // 【已删 · 勿回加】原「并发闸（批级容量准入）」段（段头注释 + `assertConcurrencyAdmit` 调用）随
        //   **Q-B 取消并发闸**（2026-09-18 用户裁决）整体删除：`member_status(status='running')` 直派面
        //   **不再做容量准入**（高并发不得被限流），`running` 迁移一律照常放行；本文件对该符号**零引用**。
        // 第 6 参 exempt：undefined = 既有行为零变化；非空对象 = 派发面授予（参数面强校验在 store 内）
        // 第 7 参 owner：仅 `to==='running'`（派发面）写入 ⇒ 派发即出池（K1）；非派发面传值亦被忽略。
        const b = store.setMember(sessionId, args.batchId, args.lane, args.status, null, args.exempt, ownerOfExec(exec));
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
    // ── N1-R4-1a（K1 公共池）：`task_pool` = 只读视图 ────────────────────────────────
    // 定位：池 = `owner == null` 的**筛选视图**（蓝图 §3.2 P-A），**不是容器**（P-B 撞 H3 不取）。
    //   ⇒ 本工具**只读**：不授权、不认领（不引入 claim）、不改任何状态；派发仍由 Leader 单点发起，派发即门禁。
    //   ⇒ 已出池（`owner` 非空）的任务**不在池内**——这是 K1「层内不重算 · 非改派」的读端表达。
    defineTool({
      name: "task_pool",
      description: "查询**公共池**（只读视图）：列出批次内**未派发**任务（`owner == null`）+ 每条的「可派发性」判定（上游 deps 是否已结算、lane 是否已被派发）。⚠ 池 = 视图不是容器：本工具**不授权、不认领、不改任何状态**；派发仍由 Leader 单点经 lane_dispatch 发起（K1：不引入 claim 自领），派发即门禁；已派发/已启动任务不在池内（层内不重算 · 非改派）。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"sessionId":{"type":"string"},"pooled":{"type":"integer"},"dispatched":{"type":"integer"},"pool":{"type":"array","items":{"type":"object","additionalProperties":true}},"note":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('pool ' + value.batchId + ': pooled=' + value.pooled
          + ' dispatched=' + value.dispatched
          + ' 可派发=' + (value.pool ?? []).filter((t) => t.dispatchable).length),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
        const lanes = b.lanes ?? {};
        const tasks = (b.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
        const pool = [];
        let dispatched = 0;
        for (const t of tasks) {
          if (!t || typeof t.id !== 'string') continue;
          // 出池判据 = **声明面** `owner` 非空（唯一真源；不靠 lane 状态反推——状态是执行面，二者不许混用）。
          const owner = typeof t.owner === 'string' ? t.owner : null;
          if (owner !== null) { dispatched += 1; continue; }
          const laneState = lanes[t.id] ?? null;
          const deps = Array.isArray(t.deps) ? t.deps : [];
          const blockers = [];
          for (const d of deps) {
            if (!isMemberTerminal(lanes[d])) {
              blockers.push('GATE_HANDOFF_MISSING: 上游 ' + d + ' 未结算（当前 ' + String(lanes[d] ?? 'unknown') + '）');
            }
          }
          // K1：已派发/已启动（lane 已离开 `pending`）⇒ 冻结，不得视为可重派对象。
          if (laneState !== null && laneState !== 'pending') {
            blockers.push('ALREADY_DISPATCHED: lane=' + t.id + ' 状态 ' + laneState + '（已派发即冻结，K1）');
          }
          pool.push({
            id: t.id, layer: t.layer ?? null, role: t.role ?? null, cmd: t.cmd ?? '',
            deps, owner: null, laneState,
            dispatchable: blockers.length === 0,
            blockers,
          });
        }
        return {
          batchId: args.batchId, sessionId,
          pooled: pool.length, dispatched,
          pool,
          note: '池 = `owner == null` 的**视图**（不是容器）：本工具只读、不认领；派发 = Leader 单点（`lane_dispatch`），派发即门禁。',
        };
      },
    }),
    // ── N1-R4-1c（K1 公共池）：`batch_tasks_add` = **图变更的唯一写入口** ─────────────
    // 用户裁定（2026-09-21 13:3x）：plan 层的**调查摸底/拆分本身就是独立任务**，其产物由下游 exec/audit
    //   层 `consume` ⇒ **不存在「拆父任务」语义** ⇒ 原 `task_split` 设计前提不成立（已舍弃，见蓝图 §7.4.2）。
    //   本工具只做一件事：**往池里加任务**（追加 lane），单次原子写完成归一化 + 播种 + 留痕 + 重跑分层校验。
    //   ⚠ 只增不改：既有任务（含未派发的）一概不动（已派发即冻结）。
    defineTool({
      name: "batch_tasks_add",
      description: "向批次**池内追加任务**（图变更的唯一写入口）：单次原子写完成「归一化 + lanes 播种 + handoffs 播种 + `plan.mutated` 留痕」，并重跑建批期分层/环检测（判据与 `wave_plan` 同源）。⚠ **只增不改**：既有任务（含未派发的）一概不动（K1：已派发即冻结）；新任务 `owner` 缺省 `null` = **在池内**，须经 Leader 派发（`lane_dispatch`）才出池。plan 层的调查摸底/拆分本身即独立任务——其产物由下游 exec/audit 层 consume，**不存在「拆父任务」语义**。非法输入（id 重复/为空、deps 成环或悬空、批不存在）抛**普通错误**（不带 `GATE_` 前缀）；批次已终态抛 `GATE_BATCH_TERMINAL`。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"tasks":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true},"description":"追加的任务数组；每项须含唯一非空 `id`，可选 `layer`/`role`/`cmd`/`deps`/`consume`/`produce`/`outputs`。`owner` 缺省 `null` = 在池内"},"reason":{"type":"string","description":"追加理由（落 `plan.mutated` 留痕，供审计复盘）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"added":{"type":"array","items":{"type":"string"}},"planRevision":{"type":"integer"},"lanesCount":{"type":"integer"},"note":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('tasks added to ' + value.batchId + ': ' + (value.added ?? []).join(', ')
          + ' (revision=' + value.planRevision + ', lanes=' + value.lanesCount + ')'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '池内追加任务（batch_tasks_add）'); // 模式门（E 阶段）：非生效模式零治理写入，先于参数/状态校验
        const sessionId = sessionOf(args, exec);
        const list = Array.isArray(args.tasks) ? args.tasks : [];
        const b = store.addPoolTasks(sessionId, args.batchId, list, {
          reason: args.reason ?? null,
          author: ownerOfExec(exec),
        });
        return {
          batchId: args.batchId,
          added: list.map((t) => String(t?.id ?? '')),
          planRevision: b.planRevision ?? 1,
          lanesCount: Object.keys(b.lanes ?? {}).length,
          note: '追加的任务已在池内（`owner=null`）⇒ 须经 Leader 派发才出池；本次变更已落 `plan.mutated`。',
        };
      },
    }),
  ];
}

