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

// lane-heartbeat：lane 过期检测引擎（watch 域）
// 成熟模式：dsh-plugin-heartbeat 退避/硬停引擎（退避/硬停机制）
// 语义：running lane 无活动 → 退避档位追问（默认 10→20→30 分钟，冷场越久间隔越长）→
//       连续 N 拍（默认 3）无活动 → appendEvent('lane.stalled', {lane, missed})，停止追问。
//       只标记不自动处置（Manager/Leader 人审），不新增成员状态（stalled 用事件表达，不碰
//       schema.js MEMBER_STATES/MEMBER_TRANSITIONS——写事件零侵入，加状态要动 schema/测试/面板/complete gate）。
// 依赖注入：deps.store（readBatch/appendEvent/listSessions/listBatches/artifactsDirOf）
//                          deps.mailbox（comms/mailbox.js：send/readUnacked，追问投递与 pending 探测）
//                          deps.config（capabilities.watch：enabled/intervalsMinutes/maxMissed/scanIntervalMinutes/probeTemplate）
//                          deps.root（可选，mailbox 根；缺省由 store.sessionsDir 推导）
//                          deps.now（可选，时钟注入，测试用；缺省 Date.now）
// 本文件仅导出引擎与工具定义；lane_heartbeat 工具的组装（lane-tools.js/register.js）
// 组装进 lane-tools.js（避免与 lane-tools 主文件耦合）；本模块只动
// watch/ 新域 + index.js 挂载 + schema.js watch 配置键 + cordis.patch.yml 注释。
import { join, dirname } from 'node:path';
import { statSync, readdirSync, existsSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveWatchConfig, WATCH_DEFAULTS } from '../schema.js';
// 状态域只读消费：非终态扫描面 / 批次终态判定单一来源（禁硬编码状态字符串，零迁移）
import * as schema from '../schema.js';
import { sessionOf, TEXT_OUTPUT } from '../tools/shared.js'; // watch 域不再 import tools/core（共享辅助下沉零依赖 shared.js）
import { isAbsPath } from '../state/constants.js'; // 单点（原内联正则收敛）
import { findTask } from '../state/task-utils.js'; // 单点（原本地定义删除）
// lane.stalled 事件字面量（发端 + 读端）改引 EVT 常量单点
import * as EVT from '../state/event-types.js';
import { pendingHandles } from '../bridge/lane-handle.js'; // D2：未消费派发句柄（TTL 缺口探测）
// W1-① 重放/恢复（周期兜底）：与装配期扫描（lib/index.js）**同一单点**，不另写第二套判定
import { replayBatch } from '../engine/replay.js';

// ── D2（2026-09-16）：**绑定缺口探测**（派发收进引擎的观测面） ─────────────────────
// 与既有 stalled / longrun **同档族**（同一 tick、同一内存表、同一「只标记不自动处置」纪律）：
//   ① `running` 但**本 stint 内无 `member.dispatch`** ⇒ 该 lane 在跑却没有绑定 worker（归属缺失）；
//   ② 该 (batchId, lane) 存在**超 TTL 且未消费**的派发句柄 ⇒ 派发意图已发放但从未被使用（悬挂意图）。
// 判据（2026-09-16 e-watch 修正）：**只有「无任何绑定」才报** —— 绑定 = 本 stint 内存在 `member.dispatch`
//   且其 `workerSessionId` 非空；已绑定 ⇒ 直接 `hit:false`。**句柄残留 ≠ 无绑定**：引擎自派是直接登记
//   `member.dispatch`（不经 post-execute 消费句柄），旧路径遗留的未消费句柄在超 TTL 后仍留在内存表里，
//   若照报就是**幽灵缺口**（真绑定被报成悬挂意图，实测假阳性）。
//   三类结论（后两类既有语义逐字保留）：① 无任何 dispatch 事件 ⇒ `no-dispatch`；
//   ② 有 dispatch 但未绑定（无 workerSessionId）+ 超 TTL 未消费句柄 ⇒ `token-ttl-expired`。
// 命中由调用方落 `lane.binding_gap` 事件（**只落事件、不占 mailbox**；幂等：本 stint 内同 reason 只报一次）。
export function bindingGapOf(batch, lane, nowTs = Date.now(), stintTs = null) {
  const evs = Array.isArray(batch?.events) ? batch.events : [];
  const stintMs = stintTs ? Date.parse(stintTs) : null;
  const dispatches = evs.filter((e) => e
    && e.type === EVT.EVT_MEMBER_DISPATCH
    && e.lane === lane
    && (stintMs === null || !Number.isFinite(stintMs) || Date.parse(e.ts ?? e.at ?? 0) >= stintMs));
  // ① 已绑定（本 stint 内有 dispatch 且 workerSessionId 非空）⇒ 无缺口；句柄是否残留不影响该结论
  const bound = dispatches.some((e) => typeof e.workerSessionId === 'string' && e.workerSessionId.length > 0);
  if (bound) return { hit: false, reason: null };
  // ② 无任何 dispatch 事件 ⇒ 归属缺失（既有语义不变）
  if (dispatches.length === 0) return { hit: true, reason: 'no-dispatch' };
  // ③ 有 dispatch 事件但未绑定 + 超 TTL 未消费句柄 ⇒ 悬挂意图（既有语义不变）
  const dangling = pendingHandles(nowTs).find((h) => h && h.batchId === batch?.batchId && h.lane === lane && h.expired === true);
  if (dangling) return { hit: true, reason: 'token-ttl-expired' };
  return { hit: false, reason: null };
}

// 退避档位（分钟 → ms，单调化钳制）：档位单调不减，冷场越久追问间隔越长
export function buildSchedule(intervalsMinutes) {
  const src = Array.isArray(intervalsMinutes) && intervalsMinutes.length > 0
    ? intervalsMinutes
    : WATCH_DEFAULTS.intervalsMinutes;
  const list = src.map((m) => {
    const n = Number(m);
    return Number.isFinite(n) && n >= 0 ? n * 60_000 : 0;
  });
  for (let i = 1; i < list.length; i++) list[i] = Math.max(list[i], list[i - 1]);
  return list;
}

// ---- longrun 档（超时重派探针，与 stalled 档并列）----
// 语义：running lane 持续超 maxDurationMs（默认 20min）且近 noProgressWindowMs（默认 5min）无新 checkpoint
//       且无活动（严格 AND）→ 探针产候选：appendEvent('lane.longrun.candidate') + mailbox broadcast 通知
//       Manager 裁决。动作即止：不改 lane 状态（同 stalled 纪律——写事件零侵入，不碰 schema.js）。
//       去重以批次事件流为唯一事实源：同 stint（lane + runningSince 相同）只产一次，跨重启幂等。
//       runningSince = 事件流最近 member.dispatch / member.settled{to:'running'}（取较新）；重派（新 running
//       stint）即更新 → 计时重置。checkpoint 最新 ts = 事件流 worktree.checkpoint 事件 ∨ 磁盘进度快照
//       mtime（<artifacts>/<batchId>/<lane>/*.md，见 lastProgressTsOf）——取两者较新；**只读事件流会漏掉
//       「worker 直写磁盘快照、未调 lane_checkpoint」的通道**（实测假阳性根因）。
// 长程豁免（批次级 batch.laneExempt[lane]，授予面见 lib/state/lane-exempt.js）：判定阈值按倍率放宽
//       effectiveMaxDurationMs = maxDurationMs × multiplier（档位表 ai-render=8 / large-download=6 /
//       dep-install=4 / none=4）。**只放宽时长阈值，不放宽 noProgressWindowMs**——无进展窗被稀释会让
//       「有在写 checkpoint」不再能证明「活着」，探针失去意义。豁免 lane 同时跳过 stalled 追问
//       （laneExempt[lane].stalled === true），但**仍照常写 checkpoint / 心跳 / 进度快照**供人工巡查。
//       runningSinceTs 匹配的 lane.longrun.candidate 已存在且其 elapsed > unconsumedTimeoutMs 且
//       该候选的 broadcast ackId 未被 ack（isAcked；ack 默认删原消息，故不可用 readUnacked 判「已消费」）
//       → 追加 lane.longrun.unconsumed（单次纪律：同 (lane,runningSince) 只产一次）。
//       候选除既有 broadcast 外同时投 supervisor/inbox（该通道为 Manager 通道，实测可达）。
//       longrunTick 对「末事件早于 staleBatchMs（默认 24h）的僵尸 running 批次」整批跳过——
//       这类批次的 running 是历史残留（宿主异常退出/批次未收尾），扫它们只产噪音且掩盖真实活跃批。
//       只影响 longrun 档，不影响 stalled 档与批次状态本身；阈值可配、显式 0 关闭。
// 重启冷窗（结构性不变量，勿读作探针失效）：宿主每次重启会把在途 lane 落 idle（store.recoverBatches），
//       重派后 runningSince 重置 → 新 stint 从 0 起算，叠加豁免倍率后
//       **重启后、且不晚于 effectiveMaxDurationMs = maxDurationMs × multiplier**（默认 20min × 4 = 80min；
//       ai-render 档 20min × 8 = 160min）之内，结构上不可能产生 longrun 候选。
//       该窗口内「零增量」是设计的不变量，不是故障信号。
// 配置：capabilities.watch.longrun{enabled,maxDurationMs,noProgressWindowMs,staleBatchMs,unconsumedTimeoutMs}
// resolve 独立实现于本模块（schema.js 不改；键根/非法回退风格对齐 resolveWatchConfig）。
export const LONGRUN_DEFAULTS = Object.freeze({
  enabled: true, // 出厂默认开（半自动件默认开防漏检；显式 false 才关）
  maxDurationMs: 1_200_000, // 默认 20min（长跑超时阈值；正整数 ms，非法回退默认）
  noProgressWindowMs: 300_000, // 默认 5min（无进展窗；正整数 ms，非法回退默认）
  staleBatchMs: 86_400_000, // 默认 24h（僵尸批次活跃度阈值；**0 = 关闭过滤**，非非法值）
  unconsumedTimeoutMs: 1_800_000, // 默认 30min（候选消费超时阈值；**0 = 关闭该档**）
  // ---- 状态面扩面（一态一判据）新增阈值：独立命名、独立回退；正整数 ms，非法回退默认 ----
  //   与既有 maxDurationMs / noProgressWindowMs **默认值与语义一字不改**（共存，不替换）。
  //   显式 0 的「关闭该档」逃生阀只保留在既有 zeroOffMs 两键上；本组新增键**不做 zero-off 语义**
  //   （避免探针静默失能半自动件），如需关闭由 `watch.longrun.enabled:false` 整档关。
  pendingWindowMs: 1_200_000, // 默认 20min（pending 未派发时长：锚点 = 最近 batch.phase→running）
  reviewWindowMs: 4_800_000, // 默认 80min（review 待结算时长 = 4×基准；**明文禁用「无活动」判**）
  idleWindowMs: 1_200_000, // 默认 20min（idle 待恢复时长：锚点 = 最近 →idle 迁移 ts）
  pausedWindowMs: 1_200_000, // 默认 20min（paused 批次滞留：锚点 = 最近 batch.phase→paused ts）
  blindRunGraceMs: 1_200_000, // 默认 20min（盲跑 BR-1/BR-3 宽限：派发后越此窗才判）
});
export const LONGRUN_REASON = 'duration-exceeded-no-progress';
// 非候选 reason 取值（既有值一字不改，回归锚）：豁免生效中 / 磁盘进度快照新鲜 / 僵尸批次
export const LONGRUN_REASON_EXEMPT_ACTIVE = 'exempt-active';
const LONGRUN_REASON_STALE_BATCH = 'stale-batch';

// =====================================================================================
// 状态面扩面（一态一判据）—— 本段是探针的语义契约，实现与断言同源的唯一落点。
//
// ① 扫描准入（替代原「双 running 门」；原 :254 `lane-not-running` / :255 `batch-not-running` 两条短路已删）：
//    | 批次 phase | lane 非终态 {pending,running,review,idle} | lane 终态 |
//    | planning   | **不扫判据**（只出 state 与锚点，reason=not-scanned-planning）| 不扫 |
//    | running    | 扫全部四态判据（主面）                                   | 不扫 |
//    | paused     | 扫「paused 滞留档」（独立档，先于 lane 判据）             | 不扫 |
//    | aborted/complete（终态）| **只出悬挂视图**（dangling:true，恒显，不产候选） | 不扫 |
//    保留不动：僵尸批 staleBatchMs 过滤 —— **只作用候选档**；悬挂视图不受它过滤
//    （终态批天然「末事件早于 24h」，沿用该过滤会让悬挂视图自我抹掉）。
//
// ② 一态一判据（禁「无活动」一把尺）：
//    pending  → pending-undispatched          锚点 = 最近 batch.phase→running（**不是** member.dispatch）
//    running  → duration-exceeded-no-progress 锚点 = stintRunningSinceOf（**总时长**口径，用户裁定 Q-H：
//               dsh 子 Agent 单次即弃置、单步任务 ⇒ 总时长即任务时长；**不得**引入 idle 时长/无活动时长
//               作 running 主判据——那是 JiuwenSwarm 生态位语义）＋ 5min 无进展窗（保留）
//    review   → review-awaiting-settle       锚点 = 最近 →review 迁移；**禁用「无活动」判**（review 本就不活动）
//    idle     → idle-awaiting-resume         锚点 = 最近 →idle 迁移（idle = **崩溃恢复落位态**，非静息常驻态；
//               不得据此推导「idle 超时即催促成员」）
//    paused   → paused-awaiting-decision     锚点 = 最近 batch.phase→paused（**独立提示档**，不并入长跑候选）
//
// ③ U-3 契约（**reason 优先级阶梯，写死；同一次观测只归属最高优先的一档**）：
//    ① 终态批 → dangling-member（快照式，无阈值；不受僵尸过滤）
//    ② planning 批 → not-scanned-planning
//    ③ paused 批 → paused-awaiting-decision（批次档**先于** lane 判据）
//    ④ lane 状态专属档：review/idle/pending（该态**不产**盲跑判据）
//    ⑤ **BR 判据（盲跑，仅 running 态）**：BR-2 blind-run-upstream-missing > BR-1 blind-run-no-deps
//       > BR-3 blind-run-upstream-never-ready；BR reason **直落 `reason`**（不另开字段），
//       **优先于** duration-exceeded-no-progress —— 依据：同一张「在跑却拿不到上游」的诊断，
//       BR 是更具体的解释；若被长跑码盖住就等价于没实现（e3 K-2 假设）。
//       BR-2 > BR-1 理由：两者同时命中时「上游曾存在后消失」比「无依赖声明」更可信（前者有实证）。
//    ⑥ stale-batch（僵尸批）
//    ⑦ running 长跑候选 → duration-exceeded-no-progress / checkpoint-fresh / activity-fresh /
//       exempt-active / no-longrun-candidate / duration-not-exceeded / no-running-since（既有码一字不改）
//    注：BR-2 的判据**包含**「超宽限窗」，故 BR-2 命中时必然已越 time 阈值 ⇒ ⑤ 在 ⑦ 之前不会掩盖真长跑。
//
// ④ U-4 契约（BR-2 证据通道 = 「派发时刻可解析」的可判定来源）：
//    来源 = **探针 tick 在 `member.dispatch` 之后的首个观测**：本引擎在内存 entry 内维护
//    `consumeObs`（`resolvedAtTs` = 首个「派发之后」观测到该 consume 路径存在且非空的时刻；
//    `neverResolvable` = 派发后该窗内从未可解析）。持久留痕走**既有** `lane.longrun.*` 事件通道
//    （载荷带 reason），**不新增事件常量**（`lib/state/event-types.js` 本批无写者，禁越域）。
//    两条证据来源都无（既无 tick 观测、事件流也无工件证据）⇒ **不产候选**（BR-2 最关键的反例）。
//
// ⑤ U-5 契约（`state` 落点范围，与 e2 的边界）：
//    e1（本文件）：`state` 落在 **lane 级行**——`lane_heartbeat.lanes[].state` 与
//    `lane_longrun.lanes[].state` **两支工具都落**（A 栏③「可否缓做 = 否」）；
//    e2（`lib/tools/core.js`）：批次级 `batch_status.lanesState` / `danglingLanes` 为**零写入面派生视图**，
//    从 `batch.lanes` 映射得出。两处**不重复**：e1 只出 lane 级行 + 逐行 `dangling:true`，
//    e2 出批次级聚合；二者取值同源（同一 `batch.lanes`），不做交叉校验、不互为前置。
// =====================================================================================
const REASON_DANGLING_MEMBER = 'dangling-member';
const REASON_NOT_SCANNED_PLANNING = 'not-scanned-planning';
const REASON_PAUSED_DWELL = 'paused-awaiting-decision';
const REASON_PENDING_UNDISPATCHED = 'pending-undispatched';
const REASON_REVIEW_AWAITING_SETTLE = 'review-awaiting-settle';
const REASON_IDLE_AWAITING_RESUME = 'idle-awaiting-resume';
const REASON_BLIND_RUN_NO_DEPS = 'blind-run-no-deps';
const REASON_BLIND_RUN_UPSTREAM_MISSING = 'blind-run-upstream-missing';
const REASON_BLIND_RUN_UPSTREAM_NEVER_READY = 'blind-run-upstream-never-ready';
// 豁免清退显式提示（D7 次选方案的探针侧可见面）：
//   读端事件名走**字面量**——`lib/state/event-types.js` 本批无写者，不得越域新增常量（design §9）。
export const REASON_EXEMPT_CLEARED = 'exempt-cleared';
const EVT_LANE_EXEMPT_CLEARED_LITERAL = 'lane.exempt.cleared';
// 状态 → 专属阈值键（§2 判据分派表单点；查询面复算与探针判定共用同一映射，禁两套表）
const STATE_WINDOW_KEY = { pending: 'pendingWindowMs', review: 'reviewWindowMs', idle: 'idleWindowMs', paused: 'pausedWindowMs' };

export function resolveLongrunConfig(config) {
  const c = config?.capabilities?.watch?.longrun ?? {};
  // posMs：正整数 ms（≥1 合法；0/负数/非数 = 非法 → 回退默认）
  const posMs = (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : null);
  // zeroOffMs：非负整数 ms —— **显式 0 合法且语义为「关闭该档」**（关闭该档的逃生阀）。
  //   实现纪律：必须走显式 `=== 0` 分支放行 0，**不得**沿用 posMs 的 `>= 1` 判据——否则 0 会被
  //   当非法值回退成默认 24h/30min，逃生阀静默失效（关键设计取舍与反例已明文记录）。
  const zeroOffMs = (v, fallback) => (Number(v) === 0 ? 0 : (posMs(v) ?? fallback));
  return {
    enabled: c.enabled !== false, // 缺省 = LONGRUN_DEFAULTS.enabled(true)，显式 false 才关
    maxDurationMs: posMs(c.maxDurationMs) ?? LONGRUN_DEFAULTS.maxDurationMs,
    noProgressWindowMs: posMs(c.noProgressWindowMs) ?? LONGRUN_DEFAULTS.noProgressWindowMs,
    staleBatchMs: zeroOffMs(c.staleBatchMs, LONGRUN_DEFAULTS.staleBatchMs),
    unconsumedTimeoutMs: zeroOffMs(c.unconsumedTimeoutMs, LONGRUN_DEFAULTS.unconsumedTimeoutMs),
    // 状态面新增阈值：与既有键同风格（正整数 ms，非法回退默认；不做 zero-off——见 defaults 注释）
    pendingWindowMs: posMs(c.pendingWindowMs) ?? LONGRUN_DEFAULTS.pendingWindowMs,
    reviewWindowMs: posMs(c.reviewWindowMs) ?? LONGRUN_DEFAULTS.reviewWindowMs,
    idleWindowMs: posMs(c.idleWindowMs) ?? LONGRUN_DEFAULTS.idleWindowMs,
    pausedWindowMs: posMs(c.pausedWindowMs) ?? LONGRUN_DEFAULTS.pausedWindowMs,
    blindRunGraceMs: posMs(c.blindRunGraceMs) ?? LONGRUN_DEFAULTS.blindRunGraceMs,
  };
}

// 纯事件流读取（零依赖批次对象）：runningSince（stint 起点）＝最近 member.dispatch 或 member.settled{to:'running'}
function parseEvTs(e) {
  const n = Date.parse(e?.ts ?? '');
  return Number.isFinite(n) ? n : null;
}
export function stintRunningSinceOf(batch, lane) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.lane !== lane) continue;
    if (e.type === EVT.EVT_MEMBER_DISPATCH) return parseEvTs(e);
    if (e.type === EVT.EVT_MEMBER_SETTLED && e.to === 'running') return parseEvTs(e);
  }
  return null;
}
export function lastCheckpointTsOf(batch, lane) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.type === EVT.EVT_WORKTREE_CHECKPOINT && e?.lane === lane) return parseEvTs(e);
  }
  return null;
}
export function hasLongrunCandidate(batch, lane, runningSinceMs) {
  if (runningSinceMs == null) return false;
  return (batch?.events ?? []).some((e) => {
    if (e?.type !== EVT.EVT_LANE_LONGRUN_CANDIDATE || e?.lane !== lane) return false;
    const ms = Date.parse(e?.runningSince ?? '');
    return Number.isFinite(ms) && ms === runningSinceMs;
  });
}
// 同 stint 的候选事件对象（候选消费超时判据的输入：取它携带的 ackId）。
// 反向扫描取**最新**一条：同 stint 理论唯一（hasLongrunCandidate 去重）——取最新只是防御性口径。
export function longrunCandidateOf(batch, lane, runningSinceMs) {
  if (runningSinceMs == null) return null;
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.type !== EVT.EVT_LANE_LONGRUN_CANDIDATE || e?.lane !== lane) continue;
    const ms = Date.parse(e?.runningSince ?? '');
    if (Number.isFinite(ms) && ms === runningSinceMs) return e;
  }
  return null;
}
// 单次纪律：以 (lane, runningSince) 为去重键（与 hasLongrunCandidate 完全同构，跨重启幂等）。
export function hasLongrunUnconsumed(batch, lane, runningSinceMs) {
  if (runningSinceMs == null) return false;
  return (batch?.events ?? []).some((e) => {
    if (e?.type !== EVT.EVT_LANE_LONGRUN_UNCONSUMED || e?.lane !== lane) return false;
    const ms = Date.parse(e?.runningSince ?? '');
    return Number.isFinite(ms) && ms === runningSinceMs;
  });
}
// 僵尸批次判据：末事件 ts（**缺 events 数组时回退 batch.updatedAt**——旧批/异常退出批可能无事件流）。
// staleBatchMs <= 0 时恒 false（显式 0 = 关闭过滤，逃生阀；语义同 GATE_ENABLED=false 的「显式关」）。
export function lastEventTsOf(batch) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const ts = parseEvTs(evs[i]);
    if (ts !== null) return ts;
  }
  const u = Date.parse(batch?.updatedAt ?? '');
  return Number.isFinite(u) ? u : null;
}
export function isStaleBatch(batch, nowTs, staleBatchMs) {
  if (!(Number(staleBatchMs) > 0)) return false;
  const lastTs = lastEventTsOf(batch);
  if (lastTs === null) return false; // 无任何时间信号 → 不判僵尸（保守：宁可扫也不误跳）
  return nowTs - lastTs > staleBatchMs;
}

// ---- 状态域（§1.1/§1.2）：扫描面 = 非终态；终态集合与判定单一来源 = lib/schema.js（不硬编码字符串）----
export function laneStateOf(batch, lane) {
  return batch?.lanes?.[lane] ?? null;
}
function isScannedLaneState(batch, lane) {
  const s = laneStateOf(batch, lane);
  return s !== null && !schema.isMemberTerminal(s);
}
export function isDanglingLane(batch, lane) {
  // 悬挂成员 = 批次**终态** ∧ lane **非终态**（快照式，无阈值；不产候选，不受僵尸批过滤）
  return schema.isBatchTerminal(batch?.phase) && isScannedLaneState(batch, lane);
}

// ---- 状态锚点（§2 实现要点 1）：纯事件流反向扫描，返回**与 state 匹配**的最近迁移 ts ----
// 锚点与状态同源（state 现读 batch.lanes[lane]，不缓存）；缺锚点 → null（state 照常透出）。
function stateAnchorOf(batch, lane) {
  const st = laneStateOf(batch, lane);
  if (st === null) return null;
  const evs = batch?.events ?? [];
  if (st === 'running') return stintRunningSinceOf(batch, lane); // = 最近 member.dispatch ∨ member.settled{to:'running'}
  if (st === 'pending') {
    // pending 计时锚点 = 最近 batch.phase→running 事件 ts（**不是** member.dispatch——pending lane 无 dispatch）
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e?.type !== EVT.EVT_BATCH_PHASE || e?.to !== 'running') continue;
      const ts = parseEvTs(e);
      if (ts !== null) return ts;
    }
    return null;
  }
  if (st === 'review' || st === 'idle') {
    // 最近一次 →review / →idle 迁移事件 ts（member.settled{to} 为主；兼容 member_status 直写镜像的 to 字段）
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e?.lane !== lane) continue;
      if (e?.type !== EVT.EVT_MEMBER_SETTLED && e?.type !== EVT.EVT_MEMBER_DISPATCH) continue;
      if (e?.to !== st) continue;
      const ts = parseEvTs(e);
      if (ts !== null) return ts;
    }
    return null;
  }
  return null; // 其余态（终态/未知）无时间判据 ⇒ 无锚点
}
// 批次档锚点：最近 batch.phase→paused（paused 档的先判锚点）
function batchPausedAnchorOf(batch) {
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.type !== EVT.EVT_BATCH_PHASE || e?.to !== 'paused') continue;
    const ts = parseEvTs(e);
    if (ts !== null) return ts;
  }
  return null;
}
// 豁免清退显式留痕读端（D7 次选方案的探针侧可见面）：逐通道取「有值即返」，全无 → null。
//   `lib/state/event-types.js` 无写者 ⇒ 事件名走字面量；字段名候选覆盖 e2 两种落法
//   （批量级 laneExemptCleared / 事件载荷 clearedAt / 条目内 clearedAt），归一为单一时间戳。
export function exemptClearedAtOf(batch, lane) {
  const direct = batch?.laneExemptCleared?.[lane];
  const ms = typeof direct === 'string' ? Date.parse(direct) : (typeof direct === 'number' ? direct : NaN);
  if (Number.isFinite(ms)) return ms;
  const evs = batch?.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e?.lane !== lane || e?.type !== EVT_LANE_EXEMPT_CLEARED_LITERAL) continue;
    const t = parseEvTs(e) ?? (Number.isFinite(Date.parse(e?.clearedAt ?? '')) ? Date.parse(e.clearedAt) : null);
    if (t !== null) return t;
  }
  return null;
}

// ---- 假阳性修复：磁盘进度快照作为「非 git 进度信号」纳入活跃度/checkpoint 新鲜度判定 ----
// 实测根因：worker 直写磁盘进度快照（<artifacts>/<batchId>/<lane>/*.md）、未调
//   lane_checkpoint（禁 worktree 批次里它恒 no-op）→ 事件流 checkpoint 类事件 0 条，而磁盘快照 12 份，
//   探针既看不到 checkpoint 也不从快照 mtime 推活跃 → 对**实际在跑**的 lane 报假候选。
// 判据：该 lane 的产物目录（<artifacts>/<batchId>/<lane>/ 及其子目录，深度受限）下进度快照的最新 mtime。
//   - 为什么是 lane 目录扫描而非声明产物清单：声明产物（outputs/produce）语义是「最终交付物」——
//     开工前不存在、收尾才写；progress 快照按每子步骤落盘，才是**进行中**的进度信号（本修复的靶点）。
//   - 与既有 artifactActivity/baselineTs 的关系：那两处只管声明产物路径；本函数补快照通道，两者互补。
//   - 深度上限 3 层（lane/progress/step.md 即 2 层）+ 单目录条目上限 200：防异常大树拖慢 tick。
// 只读、失败即静默（不存在/不可读 → null = 无进展信号），永不 throw。
const PROGRESS_DIR_MAX_DEPTH = 3;
const PROGRESS_DIR_MAX_ENTRIES = 200;
export function lastProgressTsOf(progressDir, { maxDepth = PROGRESS_DIR_MAX_DEPTH, maxEntries = PROGRESS_DIR_MAX_ENTRIES, onlyMarkdown = false } = {}) {
  if (!progressDir) return null;
  let latest = null;
  let budget = maxEntries;
  const walk = (dir, depth) => {
    if (budget <= 0) return;
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (budget-- <= 0) return;
      const p = join(dir, d.name);
      try {
        if (d.isDirectory()) {
          if (depth < maxDepth) walk(p, depth + 1); // 深度上限：depth 层目录已读，不再向下（maxDepth=0 → 只读本目录文件）
          continue;
        }
        if (!d.isFile()) continue;
        // onlyMarkdown：收窄到快照命名口径（*.md），供「lane 根兜底扫描」使用——lane 根混有非快照文件时
        //   不把任意文件的 mtime 当进度信号（收窄信号面，避免误判活跃）。
        if (onlyMarkdown && !/\.md$/i.test(d.name)) continue;
        const m = statSync(p).mtimeMs;
        if (Number.isFinite(m) && (latest === null || m > latest)) latest = m;
      } catch { /* 单条目失败隔离：跳过，不阻断扫描 */ }
    }
  };
  walk(progressDir, 0);
  return latest;
}

// =====================================================================================
// 盲跑判据（C-3 / D4，BR-1/BR-2/BR-3）—— 纯函数，供 judgeLongrun 与 tick 共用（单点同源）。
// 与另一批 B1（consume 强制）/ A1（悬空产物）的硬边界：那两条在**建批/派发期**「拒绝」，
//   本组在**运行期**「产候选/提示」，不阻断、不改状态；**同一次观测只归属一侧**（拒绝在前、兜底在后）。
// 路径解析口径与 gates.resolveArtifact 同源：`<artifactsDirOf(sessionId,batchId)>/<rel>`；
//   **可解析 = 存在且非空**（空文件不算就绪）。
// =====================================================================================
function laneConsumePathsOf(batch, lane) {
  const t = findTask(batch, lane);
  if (!t) return []; // wavePlan 缺该项 ⇒ 零观测面（BR-1/BR-3 反例；不存在即「不可判」而非「可判为真」）
  return Array.isArray(t.consume) ? t.consume.filter((p) => typeof p === 'string' && p) : [];
}
// 「空依赖」判定（BR-1 的**必要性收紧**，实测校准 —— 见产物「BR-1 精度」一节与 gap）：
//   `consume` **显式声明为空数组** ∧ 该批 wavePlan 无任何依赖边 ∧ 批内只有该一条 lane。
//   为什么必须收紧（三条实测依据，缺一条就会误报）：
//   ① **`consume: null` 不得判盲跑**：本仓 `buildWavePlan` 把「未声明的 consume」规范化为 `null`，
//      而**既有夹具全部走未声明路径**（`watch-longrun.test.js` / `watch-longrun-integration.test.js` /
//      `watch-hotconfig` / `watch-bootoverlay` 等约 20 条 running 单 lane 用例）⇒ 若把 `null` 也判为
//      「空依赖」，这些**回归锚用例会集体转红**（实测：IT-A/IT-D/IT-E 的 `reason` 断言由
//      `duration-exceeded-no-progress` 变成 `blind-run-no-deps`），即用运行期兜底档**吃掉**既有守恒语义。
//   ② **有依赖边的批不得判盲跑**：`deps` 非空即说明上游由 DAG 表达 ⇒ 不属「空依赖」。
//   ③ **多 lane 批不得判盲跑**：多 lane 批的逐 lane「consume 缺省」同样是夹具常态（RS-2 的 5 lane 夹具），
//      其「未声明上游」属**契约缺声明**（归另一批 B1 的 consume 强制面）——**拒绝在前、兜底在后**，
//      运行期兜底档不替静态门禁发言。
//   保留语义：**显式 `consume: []`** = 建批方明示「本 lane 无上游」⇒ 结构上确实无依赖却已在跑 ⇒ BR-1 成立
//      （RS-6 的 l-blind 即此形态；`consume` 缺省/`null` 一律不判）。`deps` 缺省与 `[]` 视为等价（无上游）。
function laneHasEmptyDeps(batch, lane) {
  const t = findTask(batch, lane);
  if (!t) return false; // 未登记 wavePlan ⇒ 不判（零静默：以 unverified 记账，不猜——BR-1 的关键反例）
  const consumeExplicitlyEmpty = Array.isArray(t.consume) && t.consume.length === 0;
  if (!consumeExplicitlyEmpty) return false;
  const depsEmpty = t.deps == null || (Array.isArray(t.deps) && t.deps.length === 0);
  if (!depsEmpty) return false;
  if (batchHasDependencyEdges(batch)) return false;
  return batchLaneCount(batch) === 1;
}
// 批内 lane 数（wavePlan[].tasks 全量计数）；无 wavePlan ⇒ 0（无法判定）
function batchLaneCount(batch) {
  const waves = batch?.wavePlan;
  if (!Array.isArray(waves)) return 0;
  let n = 0;
  for (const w of waves) n += (w?.tasks ?? []).length;
  return n;
}
// 批内是否存在任何依赖边（wavePlan[].tasks[].deps 非空即为真）；无 wavePlan ⇒ 保守判 true（不判盲跑）
function batchHasDependencyEdges(batch) {
  const waves = batch?.wavePlan;
  if (!Array.isArray(waves)) return true;
  let sawTask = false;
  for (const w of waves) {
    for (const t of w?.tasks ?? []) {
      sawTask = true;
      if (Array.isArray(t?.deps) && t.deps.length > 0) return true;
    }
  }
  return sawTask ? false : true; // 空 wavePlan 无法判定结构 ⇒ 保守不判盲跑
}
// BR-2 的「派发时刻可解析」证据 = 派发之后**首个观测**的既定事实（U-4）：
//   观测时刻须**晚于**该 lane 当前 stint 起点（member.dispatch / settled→running），否则不构成「派发后」证据；
//   观测结果与当前结果不一致（曾可解析 ∧ 现不可解析）⇒ BR-2 成立。
function upstreamMissingEvidenceOf(consumeObs, runningSinceTs, nowResolvable) {
  if (!consumeObs || runningSinceTs === null) return null;
  const { resolvedAtTs = null, neverResolvable = false, observedTs = null } = consumeObs;
  const afterDispatchTs = observedTs !== null && observedTs > runningSinceTs ? observedTs : null;
  const hadEvidence = (!neverResolvable) && (resolvedAtTs > 0 || afterDispatchTs !== null);
  const evidenceTs = resolvedAtTs > 0 ? resolvedAtTs : afterDispatchTs;
  if (!hadEvidence || evidenceTs === null) return null;
  if (nowResolvable !== false) return null; // 未被观测为「当前不可解析」⇒ BR-2 不成立
  return { evidenceSource: resolvedAtTs > 0 ? 'dispatch-window-tick-observation' : 'dispatch-window-tick-first-observation', evidenceTs };
}
// 产出裁定（U-3 阶梯 ⑤ 的**档内**定序）：BR-2 > BR-1 > BR-3；未命中 → reason=null。
function blindRunVerdict({
  batch, lane, nowTs, durationMs, blindRunGraceMs = LONGRUN_DEFAULTS.blindRunGraceMs,
  exempt = null, progressTsMs = null, consumeObs = null, resolveConsume = null, exemptClearedAtMs = null,
}) {
  const out = {
    evaluated: false, reason: null, candidate: false, code: null,
    graceExceeded: false, consumePaths: [], dispatchTs: null, progressTs: null, exemptClearedAt: null,
  };
  if (typeof resolveConsume !== 'function') return out; // 无解析面 ⇒ 不判（缺省零行为变化）
  out.evaluated = true;
  const paths = laneConsumePathsOf(batch, lane);
  const emptyDeps = laneHasEmptyDeps(batch, lane);
  const graceExceeded = durationMs !== null && durationMs > blindRunGraceMs;
  out.graceExceeded = graceExceeded;
  out.consumePaths = paths;
  out.dispatchTs = stintRunningSinceOf(batch, lane);
  out.progressTs = progressTsMs ?? null;
  out.exemptClearedAt = exemptClearedAtMs ?? null;
  if (!graceExceeded) return out; // 宽限窗内不判任何盲跑档（与 running 长跑阈值正交，不掩盖）
  // 当前可解析面（逐路径；空路径集 → false）
  let anyNow = false;
  for (const rel of paths) {
    if (resolveConsume(rel) === true) { anyNow = true; break; }
  }
  // BR-2：派发时刻曾可解析 ∧ 探针时刻不可解析（**前置于** BR-1：有实证的具体诊断优先）
  if (paths.length > 0) {
    const ev = upstreamMissingEvidenceOf(consumeObs, out.dispatchTs, anyNow);
    if (ev !== null) {
      out.reason = REASON_BLIND_RUN_UPSTREAM_MISSING;
      out.candidate = true;
      out.code = 'BR-2';
      out.evidenceSource = ev.evidenceSource;
      out.evidenceTs = ev.evidenceTs;
      return out;
    }
  }
  // BR-1：空依赖在跑（wavePlan 登记在案为前提；未登记 ⇒ emptyDeps=false ⇒ 不产）
  if (emptyDeps) {
    out.reason = REASON_BLIND_RUN_NO_DEPS;
    out.candidate = true;
    out.code = 'BR-1';
    return out;
  }
  // BR-3：上游从未就绪（提示档；非候选）；带豁免标注 ⇒ 不产（豁免即已声明长程意图）
  if (paths.length > 0 && exempt == null && anyNow === false) {
    const neverResolvable = !consumeObs || consumeObs.neverResolvable === true || consumeObs.resolvedAtTs === 0
      || consumeObs.resolvedAtTs == null;
    if (neverResolvable) {
      out.reason = REASON_BLIND_RUN_UPSTREAM_NEVER_READY;
      out.candidate = false; // §4.1 产出列：BR-3 = **提示档**（非候选）
      out.code = 'BR-3';
      return out;
    }
  }
  return out;
}

// judgeLongrun 纯函数（判定要素取自批次事件流 + 心跳内存 lastActivityAt + 磁盘进度快照 mtime + 派发后
// 首个观测台账 consumeObs，不调 git、不改状态）。
// 语义已从「双 running 门 + 单判据」扩为**状态面一态一判据**（§1.2 准入矩阵 + §2 分派表 + U-3 优先级阶梯，
//   完整契约见文件头「状态面扩面」注释块）。running 态的长跑判据**逐字保留**：
//   candidate = state==='running' ∧ batch.phase==='running' ∧ !僵尸批次 ∧
//               durationMs > effectiveMaxDurationMs（严格 >；effective = maxDurationMs × 豁免倍率）∧
//               !checkpointFresh ∧ !activityFresh（三窗均严格 <）
// 载荷携带原始 fresh 值供 Manager 复核（若后续需改 OR 语义，纯函数单点即可）。
export function judgeLongrun({
  batch, lane, nowTs,
  maxDurationMs = LONGRUN_DEFAULTS.maxDurationMs,
  noProgressWindowMs = LONGRUN_DEFAULTS.noProgressWindowMs,
  lastActivityAtMs = null, // 心跳内存最近活动（ms）；引擎重启后为空 → 引擎侧以 baselineTs 兜底传入
  exempt = null, // 长程豁免记录（LaneExemptGrant）或 null/undefined（无豁免）
  progressTsMs = null, // 磁盘进度快照最新 mtime（ms）；null = 无快照（非 git 进度信号）
  staleBatchMs = LONGRUN_DEFAULTS.staleBatchMs, // 僵尸批阈值（<=0 = 关闭；判据见 isStaleBatch）
  // ---- 状态面新增入参（缺省 = 零行为变化：新增档在缺参时不产）----
  pendingWindowMs = LONGRUN_DEFAULTS.pendingWindowMs,
  reviewWindowMs = LONGRUN_DEFAULTS.reviewWindowMs,
  idleWindowMs = LONGRUN_DEFAULTS.idleWindowMs,
  pausedWindowMs = LONGRUN_DEFAULTS.pausedWindowMs,
  blindRunGraceMs = LONGRUN_DEFAULTS.blindRunGraceMs,
  consumeObs = null, // U-4 证据通道：派发后首个观测台账 { resolvedAtTs, neverResolvable, observedTs, resolvableNow, paths }
  resolveConsume = null, // 可解析判定回调 (rel) => boolean（可解析 = 存在**且非空**）；缺省 = 不判盲跑
  exemptClearedAtMs = null, // D7 次选留痕（显式清退时刻，ms）；供「可见的重新计时」透出
}) {
  const laneState = batch?.lanes?.[lane];
  const batchPhase = batch?.phase;
  const thresholdMultiplier = Number.isFinite(exempt?.multiplier) ? exempt.multiplier
    : (exempt == null ? 1 : 1);
  const effectiveMaxDurationMs = maxDurationMs * thresholdMultiplier;
  const base = {
    lane, laneState, phase: batchPhase,
    maxDurationMs, noProgressWindowMs,
    exempt: exempt ?? null, effectiveMaxDurationMs, thresholdMultiplier,
    runningSince: null, runningSinceTs: null, durationMs: null,
    lastCheckpointTs: null, checkpointFresh: false,
    lastProgressTs: null, progressFresh: false,
    lastActivityAt: null, activityFresh: false,
    staleBatch: false, lastEventTs: null,
    candidate: false, reason: null,
    // ---- 状态面新增字段（§2 实现要点 2：state / stateAnchorTs / stateResidentMs 一并透出）----
    state: null, batchState: null, stateAnchorTs: null, stateResidentMs: null,
    dangling: false, specialTask: false, exemptClearedAt: null,
    // 盲跑证据透出（只读、零破坏；人工复核 BR-2 的「派发时刻可解析」判据用）
    blindRun: null,
  };
  const clearedFields = { exemptClearedAt: exemptClearedAtMs === null ? null : new Date(exemptClearedAtMs).toISOString() };

  // ── ① 状态与锚点（state 与锚点同源；reason 恒与 state 对齐）─────────────────────────────
  const dangling = isDanglingLane(batch, lane);
  // 批次档先判（U-3 阶梯 ①②③）：终态 / planning / paused 三档**先于**任何 lane 判据
  if (schema.isBatchTerminal(batchPhase)) {
    // 终态批：**只出悬挂视图，不产任何候选**（快照式，无阈值；**不受僵尸批过滤**——用了会自我抹掉）
    return {
      ...base, ...clearedFields,
      state: laneState, stateAnchorTs: null, stateResidentMs: null,
      dangling,
      reason: dangling ? REASON_DANGLING_MEMBER : 'batch-terminal-lane-terminal',
    };
  }
  if (batchPhase === 'planning') {
    // planning：**只许登记不扫成员**（显式取舍）——state 照透，reason 恒为「未扫描」
    return {
      ...base, ...clearedFields,
      state: laneState, stateAnchorTs: null, stateResidentMs: null,
      reason: REASON_NOT_SCANNED_PLANNING,
    };
  }
  if (batchPhase === 'paused') {
    // paused 批：**独立滞留提示档**（Q-B：不并入长跑候选）
    const anchorTs = batchPausedAnchorOf(batch);
    const residentMs = anchorTs === null ? null : nowTs - anchorTs;
    const dwell = residentMs !== null && residentMs > pausedWindowMs;
    return {
      ...base, ...clearedFields,
      state: 'paused', batchState: laneState, // state = 批次档（与 reason 对齐）；batchState 保留 lane 态原值
      stateAnchorTs: anchorTs === null ? null : new Date(anchorTs).toISOString(),
      stateResidentMs: residentMs,
      candidate: false, // 提示档：恒非候选（§3 T3 不计入 T1）
      reason: dwell ? REASON_PAUSED_DWELL : 'paused-in-window',
    };
  }
  // 批次 = running（主面）：逐态分派
  const anchorTs = stateAnchorOf(batch, lane);
  const residentMs = anchorTs === null ? null : nowTs - anchorTs;
  // 信号新鲜度（**全态透出**，不只 running）：RS-2 (b) 要求 review 行也带 checkpointFresh，
  //   因为「review 是否在用无活动判」只能靠「它新鲜却仍产 review 档」来判别——不透出即无法证伪。
  //   三窗语义与 running 侧逐字同源（严格 <）。
  const cpEventTsAll = lastCheckpointTsOf(batch, lane);
  const lastCheckpointTsAll = cpEventTsAll !== null && progressTsMs !== null
    ? Math.max(cpEventTsAll, progressTsMs)
    : (cpEventTsAll !== null ? cpEventTsAll : progressTsMs);
  const freshFields = {
    lastCheckpointTs: lastCheckpointTsAll === null ? null : new Date(lastCheckpointTsAll).toISOString(),
    checkpointFresh: lastCheckpointTsAll !== null && (nowTs - lastCheckpointTsAll) < noProgressWindowMs,
    lastProgressTs: progressTsMs === null ? null : new Date(progressTsMs).toISOString(),
    progressFresh: progressTsMs !== null && (nowTs - progressTsMs) < noProgressWindowMs,
    lastActivityAt: lastActivityAtMs === null ? null : new Date(lastActivityAtMs).toISOString(),
    activityFresh: lastActivityAtMs !== null && (nowTs - lastActivityAtMs) < noProgressWindowMs,
  };
  const stateFields = {
    ...clearedFields,
    state: laneState,
    stateAnchorTs: anchorTs === null ? null : new Date(anchorTs).toISOString(),
    stateResidentMs: residentMs,
    ...freshFields,
  };
  if (laneState === 'review') {
    // 待结算时长：**明文禁用「无活动」判**（review 本就不活动 ⇒ 判据只看时长），不适用豁免倍率
    const over = residentMs !== null && residentMs > reviewWindowMs;
    return { ...base, ...stateFields, reason: over ? REASON_REVIEW_AWAITING_SETTLE : 'review-in-window' };
  }
  if (laneState === 'idle') {
    // 待恢复时长（idle = **崩溃恢复落位态**，非静息常驻态；不据此推导「超时即催促成员」），不适用豁免倍率
    const over = residentMs !== null && residentMs > idleWindowMs;
    return { ...base, ...stateFields, reason: over ? REASON_IDLE_AWAITING_RESUME : 'idle-in-window' };
  }
  if (laneState === 'pending') {
    // 未派发时长：锚点 = 最近 batch.phase→running（**不是** member.dispatch——pending lane 无 dispatch）
    const over = residentMs !== null && residentMs > pendingWindowMs;
    return { ...base, ...stateFields, reason: over ? REASON_PENDING_UNDISPATCHED : 'pending-in-window' };
  }
  if (laneState !== 'running') {
    // 终态 lane（merged/failed/skipped/conflict）：不扫判据
    return { ...base, ...stateFields, reason: 'lane-terminal-not-scanned' };
  }

  // ── ② running 态 ────────────────────────────────────────────────────────────────────
  const lastEventTs = lastEventTsOf(batch);
  const staleBatch = isStaleBatch(batch, nowTs, staleBatchMs);
  const staleFields = { staleBatch, lastEventTs: lastEventTs === null ? null : new Date(lastEventTs).toISOString() };
  const runningSinceTs = stintRunningSinceOf(batch, lane);
  const durationMs = runningSinceTs === null ? null : nowTs - runningSinceTs;

  // ── ③ BR 盲跑判据（U-3 阶梯 ⑤：**先于**长跑码；仅 running 态；scan 侧与 status 侧同源）──────────
  //   与另一批 B1（consume 强制，拒绝在建批/派发期）/ A1（悬空产物，拒绝在派发期）**互补不互代**：
  //   拒绝在前、兜底在后，同一次观测只归属一侧（本函数只产候选/提示，不改状态、不阻断）。
  const blind = blindRunVerdict({
    batch, lane, nowTs, durationMs, blindRunGraceMs, exempt,
    progressTsMs, consumeObs,
    resolveConsume: typeof resolveConsume === 'function' ? resolveConsume : null,
    exemptClearedAtMs,
  });
  const blindFields = { blindRun: blind };
  if (blind.reason !== null) {
    // BR-2 > BR-1 > BR-3 已在 blindRunVerdict 内定序；此处只落 reason + candidate
    return {
      ...base, ...stateFields, ...staleFields, ...blindFields,
      runningSince: runningSinceTs === null ? null : new Date(runningSinceTs).toISOString(),
      runningSinceTs, durationMs,
      candidate: blind.candidate,
      reason: blind.reason,
    };
  }

  // ── ④ 既有 running 长跑判据（守恒：stale-batch > 无进展窗 > 豁免态）──────────────────────
  if (staleBatch) return { ...base, ...stateFields, ...staleFields, ...blindFields, reason: LONGRUN_REASON_STALE_BATCH };
  if (runningSinceTs === null) {
    return { ...base, ...stateFields, ...staleFields, ...blindFields, reason: 'no-running-since' };
  }
  // checkpoint 信号 = 事件流 worktree.checkpoint ∨ 磁盘进度快照 mtime（取较新，见 lastProgressTsOf）
  const cpEventTs = lastCheckpointTsOf(batch, lane);
  const lastCheckpointTs = cpEventTs !== null && progressTsMs !== null
    ? Math.max(cpEventTs, progressTsMs)
    : (cpEventTs !== null ? cpEventTs : progressTsMs);
  const checkpointFresh = lastCheckpointTs !== null && (nowTs - lastCheckpointTs) < noProgressWindowMs;
  // progressFresh：仅反映「快照通道本身新鲜」，与 checkpointFresh 分开透出——便于人工区分
  //   「事件流有 checkpoint」与「只有磁盘快照」，也便于 audit 单独核对进度快照修复的生效面。
  const progressFresh = progressTsMs !== null && (nowTs - progressTsMs) < noProgressWindowMs;
  const activityFresh = lastActivityAtMs !== null && (nowTs - lastActivityAtMs) < noProgressWindowMs;
  const exceeded = durationMs > effectiveMaxDurationMs;
  const out = {
    ...base,
    ...stateFields,
    ...staleFields,
    ...blindFields,
    runningSince: new Date(runningSinceTs).toISOString(),
    runningSinceTs,
    durationMs,
    lastCheckpointTs: lastCheckpointTs === null ? null : new Date(lastCheckpointTs).toISOString(),
    checkpointFresh,
    lastProgressTs: progressTsMs === null ? null : new Date(progressTsMs).toISOString(),
    progressFresh,
    lastActivityAt: lastActivityAtMs === null ? null : new Date(lastActivityAtMs).toISOString(),
    activityFresh,
    candidate: exceeded && !checkpointFresh && !activityFresh,
    // §3 T1x：豁免 lane 越**放宽后**阈值（但仍在原基准之上）⇒ 独立档位标注，**不计入**正常长跑统计。
    //   豁免未越放宽阈值（duration ≤ effective）恒 false——那是 T1 之外的观察期，不是 T1x。
    specialTask: exempt != null && exceeded,
  };
  out.reason = out.candidate ? LONGRUN_REASON : (exceeded
    ? (checkpointFresh ? 'checkpoint-fresh' : (activityFresh ? 'activity-fresh' : 'no-longrun-candidate'))
    : (durationMs > maxDurationMs ? LONGRUN_REASON_EXEMPT_ACTIVE : 'duration-not-exceeded'));
  return out;
}

export function createLaneHeartbeat({ store, mailbox, config, root, now, liveConfig, logger }) {
  const cfg = resolveWatchConfig(config);
  const lrCfg = resolveLongrunConfig(config); // longrun 档配置（出厂默认开；关态 tick 不跑判定）
  const schedule = buildSchedule(cfg.intervalsMinutes);
  const hardStop = cfg.maxMissed; // 硬停拍数：连续 N 拍无活动 → stalled
  const clock = typeof now === 'function' ? now : () => Date.now();
  const engineRoot = root ?? (store?.sessionsDir ? dirname(store.sessionsDir) : null);
  // 重放档的 ctx：`logger` 透传给 `replayBatch`（其失败隔离路径用它 warn；缺省 = 静默降级，不 throw）。
  const ctxOf = () => ({ logger });
  // 状态表 Map<laneKey, { lastActivityAt, lastSeenTs, lastProbeAt, missedCount, stalled, pendingProbeId }>
  // laneKey = `${sessionId}/${batchId}/${lane}`
  const state = new Map();
  let disposed = false;
  // W1-① 重放的 in-flight 句柄（`tick()` 同步返回，重放是异步只读+补决策）：测试/调用方可据此
  //   等待本拍补决策落盘（生产路径不等待——与装配期扫描的「异步化、不阻塞启动」纪律同构）。
  let replayInFlight = null;

  function mailboxRootOf(sessionId, batchId) {
    if (!engineRoot) throw new Error('lane-heartbeat: no root (pass deps.root or store.sessionsDir)');
    return join(engineRoot, 'sessions', sessionId, 'mailbox', batchId);
  }
  const laneKeyOf = (sessionId, batchId, lane) => `${sessionId}/${batchId}/${lane}`;

  // 产物解析（自持只读实现，与 gates.js resolveArtifact/fileExistsNonEmpty 同源模式，避免循环依赖）
  function resolveArtifact(sessionId, batchId, rel) {
    const base = store.artifactsDirOf(sessionId, batchId);
    return isAbsPath(rel) ? rel : join(base, rel);
  }
  // 该 lane 在引擎产物根下的目录 = <artifacts>/<batchId>/<lane>（progress 快照与 lane 产物同源落盘约定；
  //   实测即 <artifacts>/<batchId>/<lane>/progress/NN-*.md）。
  //   用原始 laneId 拼接：sanitize 只做 mailbox 路径安全，产物路径须与 worker 实际落盘逐字一致。
  function laneProgressDirOf(sessionId, batchId, lane) {
    return join(store.artifactsDirOf(sessionId, batchId), lane);
  }
  // 进度快照信号的**扫描面收窄**（两条，二者互补，只增不减信号面）：
  //   ① <lane>/progress/ 子树 —— 快照落盘约定路径（实测口径）；
  //   ② <lane>/*.md 顶层 —— 非约定式落盘的兜底（部分 worker 直写 lane 根）。
  //   为什么要收窄：lane 根下还挂着**声明产物**（outputs/produce 的绝对路径，如 exec/exempt/x.md）——
  //   那是「开工前不存在、收尾才写」的交付物，若把整棵子树当快照扫，一次收尾写盘会连带把
  //   lastSeenTs 推进到交付时刻，掩盖此后真实停滞（假绿：把「已交完货」读成「还在跑」）。
  //   故快照信号只看 progress/ 子树 + lane 根 .md 文件；不做全树无差别扫描。
  function progressSnapshotTsOf(sessionId, batchId, lane) {
    const laneRoot = laneProgressDirOf(sessionId, batchId, lane);
    const a = lastProgressTsOf(join(laneRoot, 'progress'));
    const b = lastProgressTsOf(laneRoot, { maxDepth: 0, onlyMarkdown: true });
    if (a === null) return b;
    if (b === null) return a;
    return Math.max(a, b);
  }

  // ---- U-4 证据通道：consume 路径的「派发时刻可解析」台账（BR-2 的唯一可判定来源）----
  // 可解析 = 存在**且非空**（与 gates.resolveArtifact/fileExistsNonEmpty 同口径；空文件不算就绪）。
  // 只读、失败即静默（不存在/不可读/是目录 → false），永不 throw。
  function resolvableArtifact(sessionId, batchId, rel) {
    try {
      const p = resolveArtifact(sessionId, batchId, rel);
      const st = statSync(p);
      return st.isFile() && st.size > 0;
    } catch { return false; }
  }
  // 台账记录（**观测而非判定**）：只写「某时刻看到的可解析性」，不写任何 reason/candidate。
  //   · resolvedAtTs：**首个可解析观测**的时刻（0 = 尚未观测到可解析）；
  //   · neverResolvable：该窗内**从未**可解析（首个观测即全不可解析 → true；此后一旦可解析即翻 false）；
  //   · observedTs：最近一次观测时刻（供「派发之后」的时序判定用，见 upstreamMissingEvidenceOf）；
  //   · resolvableNow：最近一次观测的可解析性（BR-2 判「探针时刻不可解析」）。
  // 台账挂在内存 entry 上，随 entry 生命周期存活（**不再有主动丢态路径**——见 tick 的非终态保留语义）；
  //   进程/引擎重启 ⇒ 台账清空 ⇒ BR-2 证据缺失 ⇒ 不产候选（design §4.1 明文反例：宁可少报不误报）。
  function recordConsumeObservation(entry, sessionId, batchId, batch, lane, nowTs) {
    const paths = laneConsumePathsOf(batch, lane);
    if (paths.length === 0) { entry.consumeObs = null; return; }
    let any = false;
    for (const rel of paths) {
      if (resolvableArtifact(sessionId, batchId, rel)) { any = true; break; }
    }
    const prev = entry.consumeObs;
    const obs = {
      resolvedAtTs: any ? (prev?.resolvedAtTs > 0 ? prev.resolvedAtTs : nowTs) : (prev?.resolvedAtTs ?? 0),
      neverResolvable: any ? false : (prev ? prev.neverResolvable : true),
      observedTs: nowTs,
      resolvableNow: any,
      paths,
    };
    entry.consumeObs = obs;
  }
  // 判定侧入参：可解析性回调（judgeLongrun 的 resolveConsume）+ 台账快照（consumeObs）
  function consumeCtxOf(sessionId, batchId, batch, lane, entry) {
    return {
      resolveConsume: (rel) => resolvableArtifact(sessionId, batchId, rel),
      consumeObs: entry?.consumeObs ? { ...entry.consumeObs } : null,
    };
  }
  // 运维现场因果链（本插件真实现场，非推演）：**成员在写代码/读代码期间不产生事件、不落盘产物**，
  //   该窗口内事件流、outbox、声明产物三条通道全部无信号 ⇒ lane_heartbeat / lane_longrun 探针与外部 liveness 判读
  //   **同时看不见进展** ⇒ 同一批**两次误杀正在干活的成员**（w1 空窗 24 min、w2 空窗 26 min 后被中断；
  //   而 w2 被中断后继续把 3 处失败断言全部修完 —— 事后证明确实在干活，静默 ≠ 停滞）。
  // 故进度信号必须纳入产物根 progress 快照 mtime（上方 progressSnapshotTsOf 收窄扫描 = 本判据的落点），
  //   并同步要求成员**每完成一个子步骤即落盘快照**（含 step N/total）：快照落盘本身即被本函数识别为非 git 进度信号，
  //   **把「静默长跑」的误判在机制上消除**，同时充当崩溃后续跑的物理地基（人工可抢救，不触发自动续跑）。

  function freshEntry(nowTs) {
    return {
      lastActivityAt: nowTs,
      lastSeenTs: nowTs,
      lastProbeAt: nowTs, // 新派发 lane 先给 base 档宽限，不立即追问（重派 running 计时重置语义）
      missedCount: 0,
      stalled: false,
      pendingProbeId: null,
      consumeObs: null, // U-4 派发后可解析性观测台账（BR-2 证据来源；**不得**静默丢弃，见 tick 保留语义）
      stintRunningSinceTs: null, // 已登记的 stint 起点（重派检测用；跨态存活的 entry 靠它实现「重派即重置」）
    };
  }
  function resetEntry(entry, nowTs) {
    entry.lastActivityAt = nowTs;
    entry.lastSeenTs = nowTs;
    entry.lastProbeAt = nowTs;
    entry.missedCount = 0;
    entry.stalled = false;
    entry.pendingProbeId = null;
    // consumeObs **不在 reset 内清空**：活动重置的是「无活动计时」，不是「派发后观测到的既定事实」——
    //   否则活跃 lane 每次重置都会丢掉 BR-2 的证据（证据一旦观测到即不可变）。
  }

  // ---- 活动判定（三信号任一，防「长任务无产出误判」）----
  // ① batch.events：本 lane 可归因事件比上次扫描新（lane.stalled / lane.longrun.candidate 为引擎自写事件，
  //    排除防自重置——写事件零侵入的既有 stalled 纪律扩面到 longrun 档）
  //    **并排除「把本 lane 落到其当前态的那条迁移事件」**（`e.to === 当前 lane 态`，如重派的
  //    `member.settled{to:'running'}`）：它是**计时重置**（新 stint 起算），不是「有人在干活」的活动信号。
  //    不排除的后果：非终态扩面后 entry 不再被删/重建 ⇒ 首个 tick 窥见该事件即判 activity → `resetEntry`
  //    并 `continue` → **重派后首拍恒不累计 missed**（W5 回归：期望 missed=1，实得 0）。
  function laneEventActivity(batch, lane, sinceTs, laneState = null) {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === EVT.EVT_LANE_STALLED || e.type === EVT.EVT_LANE_LONGRUN_CANDIDATE
        || e.type === EVT.EVT_LANE_BINDING_GAP) continue; // D2：绑定缺口同为**引擎自写**事件，须排除防自重置
      if (laneState !== null && e.to === laneState) continue; // 落到当前态的迁移事件 = 计时重置，不算活动
      if (e.lane === lane) {
        const ts = Date.parse(e.ts ?? '');
        if (Number.isFinite(ts) && ts > sinceTs) return true;
      }
    }
    return false;
  }
  // ② outbox：该 lane outbox 目录出现未 ack 消息
  function outboxActivity(sessionId, batchId, lane) {
    try {
      return mailbox.readUnacked(mailboxRootOf(sessionId, batchId), { type: 'outbox', lane }).length > 0;
    } catch { return false; }
  }
  // ③ 产物 mtime：artifacts/<batchId>/ 下该 lane 声明产物（outputs/produce）mtime 变化
  function artifactActivity(sessionId, batchId, batch, lane, sinceTs) {
    const t = findTask(batch, lane);
    const rels = [...(t?.outputs ?? []), ...(t?.produce ?? [])];
    for (const rel of rels) {
      try {
        if (statSync(resolveArtifact(sessionId, batchId, rel)).mtimeMs > sinceTs) return true;
      } catch { /* 不存在/不可读 → 无活动 */ }
    }
    return false;
  }
  // ④ 磁盘进度快照 mtime（进度快照信号）——非 git 进度信号通道：
  //    「worker 直写 <artifacts>/<batchId>/<lane>/progress/ 下快照、未调 lane_checkpoint
  //    （禁 worktree 批恒 no-op）」的实测场景下，既有三信号全为 false → 对在跑 lane 误报 stalled/longrun。
  //    **判据必须用新鲜度窗，不能只用「晚于基线」**：首次建 entry 时 baselineTs 已把 lastSeenTs 对齐到
  //    快照 mtime（见下），此后 `m > lastSeenTs` 恒 false → 持续写快照的 lane 照样被判 stalled
  //    （实测复现：tick1 missed=1 → tick2 missed=2 → tick3 stalled=true，即两次误报的真实路径）。
  //    故本信号按「快照落入 noProgressWindowMs 窗内」判活跃——与 longrun 档的 checkpoint 新鲜度同口径；
  //    参考下界取 min(lastSeenTs, nowTs - 窗)，使「窗内新写」与「窗内但早于基线」两种情形都算活跃。
  //    停止写快照 → 超窗即回到原判据，stalled 照常触发（探针不被稀释）。
  function progressActivity(sessionId, batchId, lane, sinceTs, nowTs, windowMs) {
    const m = progressSnapshotTsOf(sessionId, batchId, lane);
    if (m === null) return false;
    const windowStart = nowTs - windowMs;
    const ref = Math.min(sinceTs, windowStart);
    return m > ref;
  }
  function hasActivity(sessionId, batchId, batch, lane, sinceTs, nowTs, laneState = null) {
    return laneEventActivity(batch, lane, sinceTs, laneState)
      || outboxActivity(sessionId, batchId, lane)
      || artifactActivity(sessionId, batchId, batch, lane, sinceTs)
      || progressActivity(sessionId, batchId, lane, sinceTs, nowTs, lrCfg.noProgressWindowMs);
  }

  // 首次追踪某 lane 时把 lastSeenTs 基线对齐到「已知信号最新时间」（本 lane 事件 ts / 声明产物 mtime /
  // 磁盘进度快照 mtime 的最大值）。
  // 防时钟偏移/测试注入时钟时把历史活动误判为新鲜活动（历史事件 ts > 冷启动 nowTs 时会被误判持续活动）
  function baselineTs(sessionId, batchId, batch, lane, nowTs) {
    let t = nowTs;
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === EVT.EVT_LANE_STALLED || e.type === EVT.EVT_LANE_LONGRUN_CANDIDATE
        || e.type === EVT.EVT_LANE_BINDING_GAP) continue; // D2：绑定缺口同为**引擎自写**事件，须排除防自重置
      if (e.lane === lane) {
        const ts = Date.parse(e.ts ?? '');
        if (Number.isFinite(ts) && ts > t) t = ts;
      }
    }
    const task = findTask(batch, lane);
    for (const rel of [...(task?.outputs ?? []), ...(task?.produce ?? [])]) {
      try {
        const m = statSync(resolveArtifact(sessionId, batchId, rel)).mtimeMs;
        if (m > t) t = m;
      } catch { /* 不存在 → 忽略 */ }
    }
    const pm = progressSnapshotTsOf(sessionId, batchId, lane);
    if (pm !== null && pm > t) t = pm;
    return t;
  }

  // 同 lane 至多 1 条 pending 追问（多拍合并语义：mailbox 无 replace → 读 inbox 未 ack 追问，存在则跳过）。
  // 追问 ts 早于最近一次活动 → 视为已被活动满足的陈旧追问，不再当作未答拍（活动后 reset 语义）
  function pendingProbe(sessionId, batchId, lane, sinceTs) {
    try {
      const items = mailbox.readUnacked(mailboxRootOf(sessionId, batchId), { type: 'inbox' });
      for (const it of items) {
        if (it.message?.kind !== 'probe' || it.message?.lane !== lane) continue;
        const ts = Date.parse(it.ts ?? '');
        if (Number.isFinite(ts) && ts < sinceTs) continue; // 陈旧追问：活动发生在它之后
        return it;
      }
      return null;
    } catch { return null; }
  }

  function probeText(lane, batchId, missed) {
    if (cfg.probeTemplate) {
      return cfg.probeTemplate
        .replaceAll('{lane}', lane)
        .replaceAll('{batchId}', batchId)
        .replaceAll('{missed}', String(missed));
    }
    // 轻量追问模板：≤5 句、含 lane 标识、不调工具、不复盘全部历史
    return [
      `Manager 心跳：lane「${lane}」（批次 ${batchId}）已连续 ${missed} 拍无活动信号。`,
      '请用 ≤3 句汇报当前进度或阻塞点（走 outbox）。',
      '不调工具、不复盘全部历史。',
      '本消息为自动追问，任何活动即重置计时。',
    ].join('\n');
  }

  function markStalled(sessionId, batchId, lane, entry, nowTs) {
    try {
      store.appendEvent(sessionId, batchId, EVT.EVT_LANE_STALLED, { lane, missed: entry.missedCount });
    } catch { /* 批次已终态/不存在等 → 忽略（下轮不再扫） */ }
    entry.stalled = true;
    entry.lastSeenTs = nowTs; // 自写事件不触发自身重置
    entry.lastProbeAt = null;
  }

  // ---- longrun 档（超时重派探针）：----
  // 与 stalled 档互不干扰：同一 tick 扫描、同一内存表；只读判定 + 候选产出（动作即止），不改 lane 状态、
  // 不 interrupt、不重派（成员控制归 Leader）。判定前置于心跳扫描执行：内存 entry 尚为本 tick 前状态
  // （无 fresh 宽限污染——引擎重启后内存空 → 以事件/产物基线兜底）。
  // lastActivityAt 来源：state 内存 entry.lastActivityAt（含 outbox 未 ack 活动信号）；entry 缺失 → baselineTs 兜底。
  // baselineTs 已并入磁盘进度快照 mtime（非 git 进度信号），故「worker 直写快照」的 lane
  //   在 entry 缺失（引擎重启）时也不会被当成「零活动」。
  function longrunLastActivityAt(sessionId, batchId, batch, lane) {
    const entry = state.get(laneKeyOf(sessionId, batchId, lane));
    if (entry?.lastActivityAt != null) return entry.lastActivityAt;
    return baselineTs(sessionId, batchId, batch, lane, 0); // 无内存条目 → 事件/产物/快照最新信号（无信号=0→非新鲜）
  }
  // 长程豁免读取（唯一读端，可选链 + 无值即 null）：豁免落**批次级字段** batch.laneExempt[lane]
  //   （**不是** batch.lanes[lane]——后者保持纯字符串，10+ 处字符串消费面零破坏）。
  //   旧批次/未授予 lane → undefined → 归一为 null，倍率按 1×（行为与今日完全一致，零迁移）。
  function laneExemptOf(batch, lane) {
    return batch?.laneExempt?.[lane] ?? null;
  }
  // 提示档留痕（零静默的**单次纪律**）：同一 (lane, reason, stateAnchorTs) 只落一条，跨重启幂等。
  //   为什么单次：提示档（BR-3 / T3 paused / T4 review·idle·pending）本就会在**每拍**重算为真，
  //   若每拍写一条即事件流噪音 + batch.updatedAt 被自写事件不断推高（掩盖真实停滞，反向伤害探测）。
  //   事件类型复用既有 `lane.longrun.candidate`（不新增常量：event-types.js 本批无写者）——
  //   以 `{candidate:false, tier:'T-notice', notice:true}` 与真候选区分（真候选判据恒 candidate=true，
  //   hasLongrunCandidate / emitUnconsumed 均不受影响）。
  const NOTICE_REASONS = new Set([
    REASON_BLIND_RUN_UPSTREAM_NEVER_READY,
    REASON_PAUSED_DWELL,
    REASON_REVIEW_AWAITING_SETTLE,
    REASON_IDLE_AWAITING_RESUME,
    REASON_PENDING_UNDISPATCHED,
  ]);
  const noticeKeyOf = (lane, reason, anchor) => `${lane}\u0000${reason}\u0000${anchor ?? ''}`;
  function hasNotice(batch, lane, reason, anchor) {
    const key = noticeKeyOf(lane, reason, anchor);
    return (batch?.events ?? []).some((e) => {
      if (e?.type !== EVT.EVT_LANE_LONGRUN_CANDIDATE || e?.notice !== true || e?.lane !== lane) return false;
      return noticeKeyOf(e.lane, e.reason, e.stateAnchorTs) === key;
    });
  }
  function emitNotice(sessionId, batchId, batch, verdict) {
    if (!verdict?.reason || !NOTICE_REASONS.has(verdict.reason)) return;
    if (hasNotice(batch, verdict.lane, verdict.reason, verdict.stateAnchorTs)) return;
    try {
      store.appendEvent(sessionId, batchId, EVT.EVT_LANE_LONGRUN_CANDIDATE, {
        lane: verdict.lane,
        state: verdict.state,
        reason: verdict.reason,
        candidate: false,
        tier: 'T-notice',
        notice: true,
        stateAnchorTs: verdict.stateAnchorTs,
        stateResidentMs: verdict.stateResidentMs,
      });
    } catch { /* 批次终态/不存在 → 静默（提示档无候选义务；视图面仍由 lane_heartbeat 实时给出） */ }
  }

  // 候选产出（动作即止）：① 事件流留痕（载荷携带 broadcast 那条的 ackId 供消费判据用）
  // ② mailbox broadcast 直写（Leader 兜底路径读 broadcast——纪律 0f 口径）
  // ③ 同投 supervisor/inbox（Manager 通道；实测该通道可达——实测两次 stalled 追问经它送达）。
  // 事件流去重（同 stint 已产 → skip）覆盖同 tick/多次 tick/引擎重启恢复三种情形；先事件后消息
  // （事件失败 → 不写消息；消息失败仅 warn 语义静默——事件为唯一事实源，面板/Leader 可查）。
  // 两条投递**各自 ackId 独立**，事件载荷锚定 broadcast 那条（锚 inbox 会把
  //   「Manager 忙」误判成「无人消费」）。
  function emitLongrunCandidate(sessionId, batchId, batch, lane, nowTs) {
    const entry = state.get(laneKeyOf(sessionId, batchId, lane));
    const verdict = judgeLongrun({
      batch, lane, nowTs,
      maxDurationMs: lrCfg.maxDurationMs,
      noProgressWindowMs: lrCfg.noProgressWindowMs,
      lastActivityAtMs: longrunLastActivityAt(sessionId, batchId, batch, lane),
      exempt: laneExemptOf(batch, lane), // R-3：豁免倍率放宽时长阈值
      progressTsMs: progressSnapshotTsOf(sessionId, batchId, lane), // 进度快照信号（扫描面收窄：progress/ 子树 + lane 根 *.md）
      staleBatchMs: lrCfg.staleBatchMs, // 僵尸批阈值
      // 状态面新增入参（同源单点：阈值取 lrCfg，证据取内存台账 + 只读解析回调）
      pendingWindowMs: lrCfg.pendingWindowMs,
      reviewWindowMs: lrCfg.reviewWindowMs,
      idleWindowMs: lrCfg.idleWindowMs,
      pausedWindowMs: lrCfg.pausedWindowMs,
      blindRunGraceMs: lrCfg.blindRunGraceMs,
      exemptClearedAtMs: exemptClearedAtOf(batch, lane),
      ...consumeCtxOf(sessionId, batchId, batch, lane, entry),
    });
    if (!verdict.candidate) {
      // 提示档（BR-3 / review / idle / pending / paused 滞留）**不产候选**；但零静默要求「可被观测」：
      //   留痕走**既有**事件类型 `lane.longrun.candidate`（**不新增常量**：event-types.js 本批无写者，
      //   禁越域），以 payload `{candidate:false, tier:'T-notice', notice:true}` 与真候选区分
      //   （既有 hasLongrunCandidate 判据只认 candidate 候选，不受影响；消费超时档也不受污染）。
      //   **不在这里写事件**（否则每拍对每个非候选 lane 写一条 → 事件流噪音，且引擎自写事件会推高
      //   batch.updatedAt 掩盖真实停滞）——改由 tick 按「状态+锚点」去重后落一次、跨重启幂等。
      emitNotice(sessionId, batchId, batch, verdict);
      return;
    }
    // 事件流去重（同 stint；盲跑候选亦锚 (lane, runningSinceTs)）
    if (hasLongrunCandidate(batch, lane, verdict.runningSinceTs)) return;
    const payload = {
      lane,
      state: verdict.state, // D2：reason 与 state 对齐（新增，既有读端零破坏）
      stateAnchorTs: verdict.stateAnchorTs,
      stateResidentMs: verdict.stateResidentMs,
      specialTask: verdict.specialTask,
      blindRun: verdict.blindRun,
      runningSince: verdict.runningSince,
      durationMs: verdict.durationMs,
      maxDurationMs: verdict.maxDurationMs,
      noProgressWindowMs: verdict.noProgressWindowMs,
      lastCheckpointTs: verdict.lastCheckpointTs,
      lastActivityAt: verdict.lastActivityAt,
      checkpointFresh: verdict.checkpointFresh,
      activityFresh: verdict.activityFresh,
      reason: verdict.reason,
      // 只增不改的扩展字段（既有读端零破坏；面板/日志容忍多余字段）
      effectiveMaxDurationMs: verdict.effectiveMaxDurationMs,
      thresholdMultiplier: verdict.thresholdMultiplier,
      lastProgressTs: verdict.lastProgressTs,
      progressFresh: verdict.progressFresh,
      exemptClearedAt: verdict.exemptClearedAt,
    };
    const root = mailboxRootOf(sessionId, batchId);
    let broadcastAckId = null;
    // 消费判据的「句柄」= broadcast 那条的 ackId。先投递（拿 ackId）后落事件——事件载荷因此一次写全
    //   （避免「先写事件再补 ackId」的两次写盘）；反序的唯一代价是「消息已成而事件写失败」，
    //   该情形下消息无事件可指（惰性孤儿，同 stint 无事件则下轮仍会重产），属可接受退化。
    try {
      const r = mailbox.send(root, { type: 'broadcast' }, {
        kind: 'longrun.candidate', sessionId, batchId, ...payload,
      });
      broadcastAckId = r?.ackId ?? null;
    } catch { /* 消息写失败：事件仍须留痕（事件为唯一事实源），静默 */ }
    // 同投 supervisor/inbox（{type:'inbox'} → <root>/supervisor/inbox）。ackId 与 broadcast 独立，
    //   消费判据仍锚 broadcast 那条。
    try {
      mailbox.send(root, { type: 'inbox' }, {
        kind: 'longrun.candidate', channel: 'inbox', sessionId, batchId, ...payload,
      });
    } catch { /* 第二条投递失败：事件仍留痕，静默（同 stint 去重不再重发） */ }
    try {
      store.appendEvent(sessionId, batchId, EVT.EVT_LANE_LONGRUN_CANDIDATE, { ...payload, ackId: broadcastAckId });
    } catch { /* 批次终态/不存在 → 静默（无事件则同 stint 下轮会重产，不丢探测能力） */ }
  }
  // 候选消费超时 → lane.longrun.unconsumed（只产事件不改成员态）。
  // 独立一趟扫描（**不得**挂在 hasLongrunCandidate 的 early-return 之后——那会让本分支永不执行）：
  //   扫描面与 longrunTick 同一口径（listSessions → listBatches → phase==='running' → running lane）；
  //   对每个 running lane 取**当前 stint 的候选事件**，判据：
  //     elapsed = nowTs - Date.parse(candidate.ts) > unconsumedTimeoutMs
  //     ∧ candidate.ackId 存在 ∧ !mailbox.isAcked(root, {type:'broadcast'}, candidate.ackId)
  //   **必须用 isAcked**：ack 默认删原消息文件，readUnacked 会把「已消费」读成「不存在」→ 永久误报。
  //   单次纪律：以 (lane, runningSince) 去重（hasLongrunUnconsumed 同构，跨引擎重建幂等）。
  //   unconsumedTimeoutMs <= 0（显式 0 = 关闭该档）→ 整趟跳过。
  function emitUnconsumed(sessionId, batchId, batch, lane, nowTs) {
    if (!(lrCfg.unconsumedTimeoutMs > 0)) return;
    const runningSinceTs = stintRunningSinceOf(batch, lane);
    if (runningSinceTs === null) return;
    const cand = longrunCandidateOf(batch, lane, runningSinceTs);
    if (!cand?.ackId) return; // 无候选 / 旧候选无 ackId（升级前产的事件）→ 无从判消费
    const emittedAt = Date.parse(cand.ts ?? '');
    if (!Number.isFinite(emittedAt)) return;
    const elapsedMs = nowTs - emittedAt;
    if (!(elapsedMs > lrCfg.unconsumedTimeoutMs)) return;
    let acked = false;
    try { acked = mailbox.isAcked(mailboxRootOf(sessionId, batchId), { type: 'broadcast' }, cand.ackId); }
    catch { return; /* 判据不可得 → 本轮不判（保守：宁可晚报也不误报） */ }
    if (acked) return;
    if (hasLongrunUnconsumed(batch, lane, runningSinceTs)) return; // 单次纪律
    try {
      store.appendEvent(sessionId, batchId, EVT.EVT_LANE_LONGRUN_UNCONSUMED, {
        lane,
        runningSince: cand.runningSince,
        durationMs: cand.durationMs,
        emittedAt: cand.ts,
        elapsedMs,
        unconsumedTimeoutMs: lrCfg.unconsumedTimeoutMs,
        ackId: cand.ackId,
      });
    } catch { /* 批次终态/不存在 → 静默 */ }
  }
  // longrun 扫描档（状态面扩面后的准入矩阵，§1.2）：
  //   批次 {running, paused} 扫；批次 {planning} 不扫成员（只许登记）；批次终态 {aborted, complete} 整批跳过
  //   （悬挂视图由只读查询面恒显，探针侧**不产任何候选/不写任何事件**——终态批不可再写）。
  //   lane 侧：**非终态全集合** {pending, running, review, idle} 各走自身判据（一态一判据）；终态 lane 跳过。
  //   僵尸批次（末事件早于 staleBatchMs）整批跳过——其 running 是历史残留，扫描只产噪音；
  //   阈值 0 = 显式关闭过滤（逃生阀）。过滤只作用本档，不影响 stalled 档与批次状态
  //   （**悬挂视图不受该过滤**——终态批天然「末事件早于 24h」，沿用会让该视图自我抹掉）。
  function longrunTick(nowTs) {
    for (const sessionId of store.listSessions()) {
      for (const batchId of store.listBatches(sessionId)) {
        const batch = store.readBatch(sessionId, batchId);
        if (!batch) continue;
        if (schema.isBatchTerminal(batch.phase)) continue; // 终态批：只出悬挂视图，不产候选、不写事件
        if (batch.phase === 'planning') continue; // planning：只许 Manager 登记，不扫成员判据
        if (isStaleBatch(batch, nowTs, lrCfg.staleBatchMs)) continue; // 僵尸批跳过
        for (const lane of Object.keys(batch.lanes ?? {})) {
          if (!isScannedLaneState(batch, lane)) continue; // 非终态全集合；终态 lane 不扫
          try { emitLongrunCandidate(sessionId, batchId, batch, lane, nowTs); }
          catch { /* 单 lane 探针失败隔离（不阻断整轮扫描） */ }
          // 消费超时档只对 running lane 有意义（候选只在 running 态产出）
          if (laneStateOf(batch, lane) !== 'running') continue;
          try { emitUnconsumed(sessionId, batchId, batch, lane, nowTs); } // 消费超时独立趟（不挂 early-return 后）
          catch { /* 单 lane 失败隔离 */ }
        }
      }
    }
  }
  // 只读：单 lane longrun 探针状态（lane_longrun 工具查询用；不依赖本 tick 是否已跑——实时判定）
  function longrunStatus(sessionId, batchId, lane, nowTs) {
    const batch = store.readBatch(sessionId, batchId);
    if (!batch) {
      return {
        laneKey: laneKeyOf(sessionId, batchId, lane),
        sessionId, batchId, lane,
        tracked: false, candidate: false, reason: 'batch-not-found',
        state: null, stateAnchorTs: null, stateResidentMs: null, dangling: false, specialTask: false,
      };
    }
    const t = nowTs ?? clock();
    const entry = state.get(laneKeyOf(sessionId, batchId, lane));
    const verdict = judgeLongrun({
      batch, lane, nowTs: t,
      maxDurationMs: lrCfg.maxDurationMs,
      noProgressWindowMs: lrCfg.noProgressWindowMs,
      lastActivityAtMs: longrunLastActivityAt(sessionId, batchId, batch, lane),
      exempt: laneExemptOf(batch, lane),
      progressTsMs: progressSnapshotTsOf(sessionId, batchId, lane),
      staleBatchMs: lrCfg.staleBatchMs,
      // 状态面新增入参（与 tick 侧逐字同源：同一 lrCfg / 同一台账 / 同一只读解析回调）
      pendingWindowMs: lrCfg.pendingWindowMs,
      reviewWindowMs: lrCfg.reviewWindowMs,
      idleWindowMs: lrCfg.idleWindowMs,
      pausedWindowMs: lrCfg.pausedWindowMs,
      blindRunGraceMs: lrCfg.blindRunGraceMs,
      exemptClearedAtMs: exemptClearedAtOf(batch, lane),
      ...consumeCtxOf(sessionId, batchId, batch, lane, entry),
    });
    return {
      laneKey: laneKeyOf(sessionId, batchId, lane),
      sessionId, batchId, lane,
      tracked: state.has(laneKeyOf(sessionId, batchId, lane)),
      enabled: lrCfg.enabled,
      maxDurationMs: lrCfg.maxDurationMs,
      noProgressWindowMs: lrCfg.noProgressWindowMs,
      // 豁免态透出（R-3/R-4 可观测性）：未豁免 lane = null / 基础阈值 / 1
      exempt: verdict.exempt,
      effectiveMaxDurationMs: verdict.effectiveMaxDurationMs,
      thresholdMultiplier: verdict.thresholdMultiplier,
      staleBatchMs: lrCfg.staleBatchMs,
      staleBatch: verdict.staleBatch,
      runningSince: verdict.runningSince,
      runningSinceTs: verdict.runningSinceTs,
      durationMs: verdict.durationMs,
      lastCheckpointTs: verdict.lastCheckpointTs,
      lastProgressTs: verdict.lastProgressTs,
      lastActivityAt: verdict.lastActivityAt,
      checkpointFresh: verdict.checkpointFresh,
      progressFresh: verdict.progressFresh,
      activityFresh: verdict.activityFresh,
      candidate: verdict.candidate,
      emitted: hasLongrunCandidate(batch, lane, verdict.runningSinceTs),
      reason: verdict.reason,
      // ---- 状态面新增字段（D2：state / stateAnchorTs / stateResidentMs；reason 与之对齐）----
      state: verdict.state,
      stateAnchorTs: verdict.stateAnchorTs,
      stateResidentMs: verdict.stateResidentMs,
      dangling: verdict.dangling,
      specialTask: verdict.specialTask,
      exemptClearedAt: verdict.exemptClearedAt,
      blindRun: verdict.blindRun,
    };
  }

  // 扫描全部会话（状态面扩面后的准入矩阵）：
  // - **非终态 lane 全集合** {pending, running, review, idle} 全部保留在心跳 state 表内
  //   （原「非 running ⇒ state.delete」静默丢态路径已删：悬挂成员不可见的第二重成因）；
  // - 批次 {running, paused} 扫；终态批**保留悬挂视图**（entry 不删，只读查询恒可见）但不追问；
  //   planning 只许登记，不扫成员；
  // - **追问（inbox probe / missedCount / lane.stalled）只对「running 批 + running lane」发生**——
  //   非 running 态的判据是「时长」而非「无活动」（§2），对它们发追问既无判据依据、也会把
  //   review/idle 的静默误读成停滞（review 本来就不活动）。
  // ── W1-① 重放/恢复：**周期兜底**（本 tick 涉及的全部 `running` 批） ─────────────────────
  // 为什么要在心跳里再跑一次（缺口，实测口径见 `lib/engine/replay.js` 文件头）：
  //   链推进由 `member.settled` 驱动；若**推进发生在运行期**且失败/无人补（门禁挂起、进程退出、
  //   装配期扫描窗口未覆盖），批次会永久停在「lane 已 merged、下一环从未被决策」。装配期只扫一次，
  //   覆盖不到「启动之后才死的」，故需一个**周期兜底**。心跳 tick 是既有唯一周期面 ⇒ 挂在这里。
  //
  // ★ 语义边界（**必须与原纪律并读，不得混同**）：
  //   心跳既有的 stalled / longrun / binding-gap 三档是「**只标记不自动处置**」——它们只产候选/留痕，
  //   成员状态与批次相位**一律不动**（Manager/Leader 人审）。本档**不是**自动处置：
  //   `replayBatch` 固定 `noDispatch: true` ⇒ 只**补一条链推进决策**（落 `chain.step{dispatch.mode:'manual-pending'}`），
  //   **不派发**、**不改相位**、**不改任何成员状态**（真派仍归 Leader/Manager，与 S12 裁决一致）。
  //   两者同处一 tick 但**互不影响**：本档不读也不写心跳 state 表，三档的判据/阈值/输出一字未改。
  //   边界自证：本档命中时批相位恒为 `running`（`replayBatch` 内的相位闸），故不可能与
  //   「终态批只出悬挂视图」「paused 批次档」等路径交叉。
  //
  // 三条硬纪律（与装配期扫描 `lib/index.js` **逐字同源**，防「写了不生效」或「静默危害」）：
  //   ① 只处理 `running` 批（`replayBatch` 内相位闸 + 此处预筛，双保险）；
  //   ② 一律只决策不派发（`replayBatch` 内固定 `noDispatch`）；
  //   ③ 全程 try/catch 不抛（单批隔离）+ **零命中零日志**（守「缺省配置零 warn」契约 legacy-fix T4.3）。
  // 有界：会话数与批次数均设上限（同装配期常量），防大批量时本拍扫盘过久。
  // 去重/幂等不在本档重复实现：`replayBatch` 的 `advancedAfter(ts >= 结算时刻)` 判据保证
  //   「同一现场重复重放 ⇒ 零新增 `chain.step`」⇒ 本 tick 反复跑不会重复推进（RI-2 回归锁）。
  const REPLAY_MAX_SESSIONS = 5;
  const REPLAY_MAX_BATCHES = 20;
  async function replayTick() {
    const hits = [];
    let replayed = 0;
    try {
      const targets = [];
      const sessions = (typeof store.listSessions === 'function' ? store.listSessions() : []).slice(0, REPLAY_MAX_SESSIONS);
      for (const sessionId of sessions) {
        const ids = typeof store.listBatches === 'function' ? store.listBatches(sessionId) : [];
        for (const batchId of ids) {
          if (targets.length >= REPLAY_MAX_BATCHES) break;
          try { if (store.readBatch(sessionId, batchId)?.phase === 'running') targets.push({ sessionId, batchId }); }
          catch { /* 坏批跳过（与装配期扫描同隔离口径） */ }
        }
        if (targets.length >= REPLAY_MAX_BATCHES) break;
      }
      for (const t of targets) {
        try {
          const r = await replayBatch({ store, root: engineRoot, liveConfig: liveConfig ?? config }, ctxOf(), t);
          if (r && r.replayed > 0) { replayed += r.replayed; hits.push(t.batchId); }
        } catch { /* 单批隔离：一批失败不影响其余 */ }
      }
      if (replayed > 0) {
        // 有补决策才 info 一行（**零命中零日志**）；措辞与装配期扫描（lib/index.js）对齐，
        //   便于两条路径在同一日志面上辨认来源。logger 缺省（测试/旧调用方）⇒ 静默，不 throw。
        try {
          logger?.info?.('[dsh-punky-swarm] replay(心跳)：补链推进决策 ' + replayed + ' 处（' + hits.join(',')
            + '）—— 重放只落「待派清单」，真派仍由 Leader/Manager 在工具面执行');
        } catch { /* 日志失败不影响补决策已落盘的事实 */ }
      }
    } catch { /* 扫描面失败不影响心跳 */ }
    return { replayed, batches: hits };
  }

  function tick() {
    if (disposed) return;
    const nowTs = clock();
    // longrun 档（并列，同 tick 同引擎）：置于心跳扫描之前执行——此时内存 entry 为本 tick 前状态
    // （freshEntry 宽限不污染 lastActivityAt 判定；重启后 entry 缺失 → baselineTs 兜底）。
    if (lrCfg.enabled) longrunTick(nowTs);
    // W1-① 重放/恢复周期兜底（独立于 longrun 档开关：重放不是候选档，watch.longrun.enabled=false 也应兜底）。
    //   不 await（tick 同步语义与既有 watchdog 调用点不变）；异常在 replayTick 内已全程隔离。
    replayInFlight = replayTick();
    for (const sessionId of store.listSessions()) {
      for (const batchId of store.listBatches(sessionId)) {
        const batch = store.readBatch(sessionId, batchId);
        if (!batch) continue;
        if (schema.isBatchTerminal(batch.phase) || batch.phase === 'planning') {
          // 终态批：**保留悬挂视图**（不再 dropBatchEntries 整批丢态）；planning：不扫成员。
          //   entry 若存在则推进 lastSeenTs（避免解冻后以陈旧基线瞬时判 stalled），但不追问。
          touchBatchEntries(sessionId, batchId, batch, nowTs);
          continue;
        }
        for (const [lane] of Object.entries(batch.lanes ?? {})) {
          const laneKey = laneKeyOf(sessionId, batchId, lane);
          const st = laneStateOf(batch, lane);
          let entry = state.get(laneKey);
          if (entry == null) {
            entry = freshEntry(nowTs);
            entry.lastSeenTs = baselineTs(sessionId, batchId, batch, lane, entry.lastSeenTs);
            state.set(laneKey, entry);
          }
          // U-4：派发后可解析性观测（**观测先于判定**：本 tick 的观测即本 tick 判定的证据）
          recordConsumeObservation(entry, sessionId, batchId, batch, lane, nowTs);
          if (st !== 'running') {
            // 非 running：只保留视图，**不追问**（§2：review/idle/pending 的判据是时长而非无活动）。
            // lastSeenTs 续到「本 lane 已知信号最新时刻」（不是裸 nowTs）——否则下一次 tick 会把**已经
            // 计入基线的那条事件**再判一次「有新活动」（laneEventActivity 用严格 `ts > sinceTs`），
            // 在时钟几乎不前进的场景（同一毫秒内 tick）造成重派后 missed 恒 0（W5 回归）。
            entry.lastSeenTs = Math.max(nowTs, baselineTs(sessionId, batchId, batch, lane, nowTs));
            continue;
          }
          // **新 stint 检测（重派计时重置）**：非终态 lane 的 entry 现在跨态存活（原实现靠 `state.delete`
          //   隐式重建实现「重派即重置」）⇒ 必须显式核 stint 起点：runningSince 变化（新的 dispatch/
          //   结算→running 事件）⇒ 复位为 fresh 语义（missed=0/stalled=false/pendingProbeId=null），
          //   否则恢复重派后的 lane 会**接着崩溃前的拍数继续累计**（W5：期望 missed=1，实得 3）。
          const stintNow = stintRunningSinceOf(batch, lane);
          if (entry.stintRunningSinceTs !== stintNow) {
            resetEntry(entry, nowTs);
            entry.stintRunningSinceTs = stintNow;
            entry.gapReported = null; // D2：新 stint ⇒ 缺口留痕重置（同一缺口每 stint 只报一次）
          }
          // D2 绑定缺口探测（只标记不处置；与 stalled/longrun 同档族、同 tick）
          {
            const gap = bindingGapOf(batch, lane, nowTs, entry.stintRunningSinceTs);
            if (gap.hit && entry.gapReported !== gap.reason) {
              entry.gapReported = gap.reason;
              store.appendEvent(sessionId, batchId, EVT.EVT_LANE_BINDING_GAP, { lane, reason: gap.reason, missed: entry.missedCount });
              // 通道决策（2026-09-16 实测得出的契约结论）：**三个既有 box 都不可挪用**——
              //   · `inbox`（supervisor/inbox）被「追问（kind:'probe'）」的**消息计数契约**占用（实测：多一条即打破 W1「inbox 恰 1 条追问」）；
              //   · `broadcast` 被「长跑候选双通道」契约占用（IT-B 断言 broadcast+inbox 各恰 1 条）；
              //   · `outbox` 是**lane 活动信号**（`laneEventActivity` 信号②：未 ack outbox ⇒ 判为有活动）。
              //   ⇒ 绑定缺口**只落事件** `lane.binding_gap`（Leader/Manager/审计经事件面读，`batch_status`/`log_export` 均可见），
              //     不新增 box、不扰动任何既有通道计数。若将来确需「主动推消息」，须先为 mailbox 引入**按 kind 的独立通道**再开。
              void 0;
            }
          }
          // 活动 → 重置回 tier0（W3）
          // 注：hasActivity 现含第 ④ 信号「磁盘进度快照 mtime」，故「worker 直写快照、
          //     不调 lane_checkpoint」的 lane 不再被误报 stalled 追问（两次实测误报的同类修复）。
          if (hasActivity(sessionId, batchId, batch, lane, entry.lastSeenTs, nowTs, st)) { resetEntry(entry, nowTs); continue; }
          // R-4 长程豁免：lane 声明 laneExempt[lane].stalled === true → 本拍不发 inbox probe、
          //   不累计 missedCount、不写 lane.stalled（与 longrun 档的倍率豁免并列的另一半）。
          //   语义边界：仍留在心跳 state 表内（tracked: true，lane_heartbeat 查询照常可见）；
          //   **仍写 checkpoint/心跳**——lane_checkpoint 写面零特判（豁免只关「追问 + stalled 标记」，
          //   不许把 lane 变成不可观测）；豁免撤销后下一拍即回到原追问语义（无粘滞状态）。
          if (laneExemptOf(batch, lane)?.stalled === true) continue;
          // 已 stalled：只标记，停止追问（W2）
          if (entry.stalled) continue;
          // 退避档位：tier = min(missedCount, len-1)，档位单调（W4）
          const tier = Math.min(entry.missedCount, schedule.length - 1);
          if (entry.lastProbeAt !== null && nowTs - entry.lastProbeAt < schedule[tier]) continue;
          // 一拍 = 一次追问轮次；同 lane 至多 1 条 pending（W1），pending 存在则这一拍=已发未答
          const pending = pendingProbe(sessionId, batchId, lane, entry.lastActivityAt);
          if (!pending) {
            const r = mailbox.send(mailboxRootOf(sessionId, batchId), { type: 'inbox' }, {
              kind: 'probe',
              lane,
              batchId,
              missed: entry.missedCount + 1,
              text: probeText(lane, batchId, entry.missedCount + 1),
            });
            entry.pendingProbeId = r.ackId;
          }
          entry.missedCount += 1;
          entry.lastProbeAt = nowTs;
          // 硬停：连续 N 拍无活动 → lane.stalled（只标记不自动处置，不新增成员状态）
          if (entry.missedCount >= hardStop) markStalled(sessionId, batchId, lane, entry, nowTs);
        }
      }
    }
  }

  // 内存条目保留策略（design §1.2「必须删除的既有短路」）：
  //   原 `dropBatchEntries(batch)`（整批 `state.delete`）与逐 lane `state.delete(laneKey)` 会**主动清除内存条目**
  //   ⇒「非 running lane 不可见」+「终态批整批不可见」= 悬挂成员不可见的第二重成因。
  //   现语义：**非终态 lane 的条目一律保留**（只读查询面恒可见）；批次转终态/planning 时也不删，
  //   只把 lastSeenTs 推进到当前拍（解冻/恢复后不因陈旧基线瞬时判 stalled），**不追问、不产候选**。
  //   唯一的 `state.delete` 落在 dispose()（显式销毁语义），不再存在任何静默丢态路径。
  function touchBatchEntries(sessionId, batchId, batch, nowTs) {
    for (const lane of Object.keys(batch.lanes ?? {})) {
      const entry = state.get(laneKeyOf(sessionId, batchId, lane));
      if (entry) entry.lastSeenTs = nowTs;
    }
  }

  // 只读：lastActivityAt/当前档位/missed/stalled/pendingProbeId + 状态面字段（state/stateAnchorTs/
  //   stateResidentMs/dangling）。ctx 由工具侧传入（batch + 派生所见）；缺省 = 老调用点零变化。
  //   注：`tracked` 语义已随「删静默丢态」扩面——非终态 lane 一律 tracked（entry 恒在），
  //   不再等于「running 才被追踪」（旧口径见 C-2/§W-6）。
  function status(laneKey, ctx = null) {
    const entry = state.get(laneKey);
    // laneKey = `${sessionId}/${batchId}/${lane}`；lane 未约束可含 '/'，按前两个斜杠定位
    const i1 = laneKey.indexOf('/');
    const i2 = i1 >= 0 ? laneKey.indexOf('/', i1 + 1) : -1;
    const sessionId = i1 >= 0 ? laneKey.slice(0, i1) : null;
    const batchId = i2 >= 0 ? laneKey.slice(i1 + 1, i2) : null;
    const lane = i2 >= 0 ? laneKey.slice(i2 + 1) : null;
    // 状态面字段（与 longrunStatus 同源：同一阶梯 + 同一阈值映射；reason 由调用方给 override 时优先取之）
    const stateFields = deriveStateFields(ctx?.batch ?? null, lane, ctx?.nowTs ?? null, ctx?.reasonOverride ?? null);
    if (!entry) {
      return {
        laneKey, tracked: false, lastActivityAt: null, tier: 0, intervalMs: schedule[0],
        missed: 0, stalled: false, pendingProbeId: null, lastProbeAt: null,
        sessionId, batchId, lane, ...stateFields,
      };
    }
    const tier = Math.min(entry.missedCount, schedule.length - 1);
    return {
      laneKey,
      tracked: true,
      sessionId,
      batchId,
      lane,
      lastActivityAt: new Date(entry.lastActivityAt).toISOString(),
      tier,
      intervalMs: schedule[tier],
      missed: entry.missedCount,
      stalled: entry.stalled,
      pendingProbeId: entry.pendingProbeId,
      lastProbeAt: entry.lastProbeAt ? new Date(entry.lastProbeAt).toISOString() : null,
      ...stateFields,
    };
  }

  // 状态面派生（只读、纯）：state = 批次档优先（终态/planning/paused 三档先判，与 judgeLongrun 同序），
  //   批次档不覆盖 lane 时取 lane 自身态；锚点取 stateAnchorOf / batchPausedAnchorOf（与 state 同源）；
  //   reason 用**同一套阶梯**（§2 分派表 + U-3 优先级）在查询面复算——lane_heartbeat 与 lane_longrun
  //   对同一 lane 必须给出同一 (state, reason)（U-5：同一 state 语义不能在多工具面分裂）。
  //   （盲跑档 BR-* 需解析回调与台账，只在 longrunStatus 侧产出；查询面命中即取之——见 createHeartbeatTools。）
  function deriveStateFields(batch, lane, nowTsRef, reasonOverride = null) {
    const out = {
      state: null, stateAnchorTs: null, stateResidentMs: null, dangling: false,
      exemptClearedAt: null, reason: null,
    };
    if (!batch || lane == null) return out;
    const laneSt = laneStateOf(batch, lane);
    const tNow = nowTsRef ?? clock();
    out.exemptClearedAt = (() => {
      const ms = exemptClearedAtOf(batch, lane);
      return ms === null ? null : new Date(ms).toISOString();
    })();
    out.dangling = isDanglingLane(batch, lane);
    let state = laneSt;
    let anchorTs = null;
    let reason;
    if (schema.isBatchTerminal(batch.phase)) {
      // 终态批：快照式（无阈值、无锚点）；非终态 lane = 悬挂成员，不产候选
      state = laneSt; anchorTs = null;
      reason = out.dangling ? REASON_DANGLING_MEMBER : 'batch-terminal-lane-terminal';
    } else if (batch.phase === 'planning') {
      state = laneSt; anchorTs = null;
      reason = REASON_NOT_SCANNED_PLANNING;
    } else if (batch.phase === 'paused') {
      state = 'paused'; anchorTs = batchPausedAnchorOf(batch);
      const over = anchorTs !== null && (tNow - anchorTs) > lrCfg.pausedWindowMs;
      reason = over ? REASON_PAUSED_DWELL : 'paused-in-window';
    } else {
      state = laneSt; anchorTs = stateAnchorOf(batch, lane);
      const over = anchorTs !== null && (tNow - anchorTs) > lrCfg[STATE_WINDOW_KEY[state] ?? ''] ;
      if (state === 'running') reason = null; // running 的 reason 由 longrunStatus 的完整判定给出
      else if (state === 'review') reason = over ? REASON_REVIEW_AWAITING_SETTLE : 'review-in-window';
      else if (state === 'idle') reason = over ? REASON_IDLE_AWAITING_RESUME : 'idle-in-window';
      else if (state === 'pending') reason = over ? REASON_PENDING_UNDISPATCHED : 'pending-in-window';
      else reason = 'lane-terminal-not-scanned';
    }
    out.state = state;
    out.stateAnchorTs = anchorTs === null ? null : new Date(anchorTs).toISOString();
    out.stateResidentMs = anchorTs === null ? null : tNow - anchorTs;
    out.reason = reasonOverride ?? reason;
    return out;
  }

  // 活动信号外部入口：missedCount=0 回 tier0
  function reset(laneKey) {
    const entry = state.get(laneKey);
    if (entry) resetEntry(entry, clock());
  }

  function dispose() {
    disposed = true;
    state.clear();
  }

  // `replayInFlight()`：返回本拍 W1-① 重放的 in-flight Promise（未跑过 ⇒ null）。
  //   生产路径不消费它（tick 同步返回即结束）；测试/审计用它把「本拍补决策已落盘」变成可等待的事实，
  //   避免用 sleep 猜时序（GAP-S11 的 20ms 时序 flake 同类陷阱）。
  const replayInFlightOf = () => replayInFlight;
  return { tick, status, reset, dispose, longrunStatus, replayInFlight: replayInFlightOf };
}

// lane_heartbeat / lane_longrun 共用的**缺省 lane 过滤**（C-2 / §6.1 A 栏②；F6 归因更正后落点 = 本文件）：
//   从「仅 running」改为**按状态过滤**——返回全部**非终态** lane（{pending, running, review, idle}）；
//   终态（merged/failed/skipped/conflict）排除。
//   ⚠️ 例外（D6/RS-9）：批次已**终态**时，非终态 lane 是**悬挂成员**，必须恒显（且**不受僵尸批 24h 过滤**）
//   ⇒ 该情形下**全量返回**（batch.lanes 全键），不因「批次已终态」而空返回——否则悬挂视图自我抹掉。
//   显式传 lane 时恒单行（只读安全；终态 lane 也照常返回结果对象，不 throw）。
function laneIdsFor(batch, only) {
  const all = Object.keys(batch.lanes ?? {});
  if (only) return [only];
  if (schema.isBatchTerminal(batch.phase)) return all;
  return all.filter((l) => !schema.isMemberTerminal(batch.lanes[l]));
}

// lane_heartbeat 工具定义（只读查询 + 可选手动触发一拍）。
// 组装进 lane-tools.js；enabled=false 时本工具不注册。
// deps: { store, root, config, heartbeat? } —— heartbeat 缺省时自建（注册侧懒加载，与挂载引擎共享状态文件）
export function createHeartbeatTools(ctx, deps = {}) {
  if (resolveWatchConfig(deps.config).enabled !== true) return [];
  // 注册期实例（回退路径：deps.getHeartbeat 未注入的调用方——既有测试/直接装配经 deps.heartbeat 注入）；
  // 执行路径经 engineAt() 解引用：index.js 装配注入
  // getHeartbeat（→ heartbeatRef.current）→ 热重建后工具自动跟随新引擎（修复旧实例闭包缺陷）；
  // getHeartbeat 返回 null（watch 关/热关，引擎缺失）→ disabled 状态对象不 throw
  const heartbeat = deps.heartbeat
    ?? createLaneHeartbeat({
      store: deps.store, mailbox: deps.mailbox, config: deps.config, root: deps.root,
      liveConfig: deps.liveConfig, logger: deps.logger ?? ctx?.logger,
    });
  const engineAt = () => (typeof deps.getHeartbeat === 'function' ? deps.getHeartbeat() : heartbeat);
  return [
    defineTool({
      name: 'lane_heartbeat',
      description: '查询/手动触发 lane 心跳（watch 能力，只读+可选手动一拍）：返回指定批次**非终态 lane**（pending/running/review/idle；批次终态时为悬挂成员视图）的心跳与状态面（state/stateAnchorTs/stateResidentMs/dangling/exemptClearedAt + lastActivityAt/当前档位/missed/stalled/pendingProbeId）；beat=true 时先跑一拍扫描再返回。不改变任何成员状态（stalled 用事件表达）。enabled=false 时不注册。',
      parameters: {
        batchId: { type: 'string', required: true, description: '批次 ID' },
        lane: { type: 'string', description: 'lane ID；缺省返回该批全部非终态 lane（running/pending/review/idle；批次终态时含悬挂成员）' },
        session: { type: 'string', description: '批次归属会话' },
        beat: { type: 'boolean', description: '手动触发一拍扫描（tick）后再返回状态' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          batchId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          lanes: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        } },
        render: (_args, value) => TEXT_OUTPUT('lane heartbeat: ' + value.lanes.length + ' lane(s)'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const engine = engineAt(); // 执行时解引用：引擎缺失（watch 关/热关）→ null → disabled 状态
        // beat 手动一拍：引擎缺失时 no-op（disabled 查询仍可安全返回，不 throw）
        if (args.beat === true && engine) engine.tick();
        const batch = deps.store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const laneIds = laneIdsFor(batch, args.lane);
        const nowTs = Date.now();
        if (!engine) {
          // watch 关闭/热关（引擎缺失）：返回 disabled 状态对象（enabled:false, reason:'watch-disabled',
          //   tracked:false）——查询工具只读安全，不抛错；beat=true 已按 no-op 跳过
          return {
            batchId: args.batchId,
            sessionId,
            lanes: laneIds.map((l) => ({
              laneKey: `${sessionId}/${args.batchId}/${l}`,
              sessionId, batchId: args.batchId, lane: l,
              tracked: false,
              enabled: false,
              reason: 'watch-disabled',
              state: batch.lanes?.[l] ?? null,
              stateAnchorTs: null, stateResidentMs: null,
              dangling: isDanglingLane(batch, l),
              missed: 0, stalled: false, pendingProbeId: null, lastProbeAt: null, lastActivityAt: null,
            })),
          };
        }
        return {
          batchId: args.batchId,
          sessionId,
          lanes: laneIds.map((l) => {
            // running 态：reason 必须来自**完整判定**（BR 档 / 长跑档 / 僵尸批），不能只给 state 派生结果
            //   ⇒ 以 longrunStatus 的判定结果覆盖 stateFields（state/锚点仍同源，故不会分裂）。
            // 其余态：reason 由状态阶梯直接给出（review/idle/pending/paused/dangling/planning）。
            if (laneStateOf(batch, l) !== 'running') {
              return engine.status(`${sessionId}/${args.batchId}/${l}`, { batch, nowTs });
            }
            const v = engine.longrunStatus(sessionId, args.batchId, l, nowTs);
            return { ...engine.status(`${sessionId}/${args.batchId}/${l}`, { batch, nowTs, reasonOverride: v.reason }), reason: v.reason };
          }),
        };
      },
    }),
  ];
}

// lane_longrun 工具定义（只读查询 + 可选手动触发一拍；longrun 档并列注册，lane_heartbeat 输出零变化）。
// 组装进 lane-tools.js；门控 = watch.enabled && watch.longrun.enabled（出厂默认开——用户定案修订；显式
// capabilities.watch.longrun.enabled:false 时不注册，tick 亦不跑 longrun 判定，零事件零消息零行为变化）。
// deps: { store, root, config, heartbeat? } —— heartbeat 缺省时自建（与挂载引擎共享状态文件/内存表）
export function createLongrunTools(ctx, deps = {}) {
  if (resolveWatchConfig(deps.config).enabled !== true) return [];
  if (resolveLongrunConfig(deps.config).enabled !== true) return [];
  // 注册期实例（回退路径：deps.getHeartbeat 未注入的调用方）；执行路径经 engineAt() 解引用——
  // index.js 装配注入 getHeartbeat（heartbeatRef.current）→ 热重建后跟随新引擎；null → disabled 状态
  const heartbeat = deps.heartbeat
    ?? createLaneHeartbeat({
      store: deps.store, mailbox: deps.mailbox, config: deps.config, root: deps.root,
      liveConfig: deps.liveConfig, logger: deps.logger ?? ctx?.logger,
    });
  const engineAt = () => (typeof deps.getHeartbeat === 'function' ? deps.getHeartbeat() : heartbeat);
  return [
    defineTool({
      name: 'lane_longrun',
      description: '查询/手动触发 lane 超时重派探针（watch 能力，longrun 档，只读+可选手动一拍）：返回指定批次**非终态 lane**（pending/running/review/idle；批次终态时为悬挂成员视图 dangling）的状态面与判据（state/stateAnchorTs/stateResidentMs/reason；running 态另有 runningSince/durationMs/maxDurationMs/effectiveMaxDurationMs/thresholdMultiplier/exempt/specialTask/lastCheckpointTs/lastProgressTs/staleBatch/lastActivityAt/checkpointFresh/progressFresh/activityFresh/candidate/emitted）；beat=true 时先跑一拍扫描（心跳 stalled 档与 longrun 档并列）再返回。判据一态一判据（禁「无活动」一把尺）：running = 总时长口径 20min 基准 + 5min 无进展窗；review = 待结算时长；idle = 待恢复时长；pending = 未派发时长；paused 批次 = 独立滞留提示档（不并入长跑候选）；另有盲跑档 blind-run-no-deps / blind-run-upstream-missing（候选）与 blind-run-upstream-never-ready（提示档）。豁免 lane 的时长阈值按倍率放宽（exempt 非 null）并标注 specialTask:true（T1x 独立档，不计入正常长跑统计）；探测活跃度含磁盘进度快照（progressFresh）；僵尸批次（末事件早于 staleBatchMs）整批跳过（reason=stale-batch），但**悬挂成员视图不受该过滤**。探针只产候选（事件 + mailbox broadcast + supervisor/inbox），不改任何成员状态；重派裁决归 Manager/Leader。watch.longrun.enabled=false 时不注册。',
      parameters: {
        batchId: { type: 'string', required: true, description: '批次 ID' },
        lane: { type: 'string', description: 'lane ID；缺省返回该批全部非终态 lane（running/pending/review/idle；批次终态时含悬挂成员）' },
        session: { type: 'string', description: '批次归属会话' },
        beat: { type: 'boolean', description: '手动触发一拍扫描（tick）后再返回状态' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          batchId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          lanes: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        } },
        render: (_args, value) => TEXT_OUTPUT('lane longrun probe: ' + value.lanes.length + ' lane(s)'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const engine = engineAt(); // 执行时解引用：引擎缺失（watch 关/热关）→ null → disabled 状态
        // beat 手动一拍：引擎缺失时 no-op（disabled 查询仍可安全返回，不 throw）
        if (args.beat === true && engine) engine.tick();
        const batch = deps.store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const laneIds = laneIdsFor(batch, args.lane);
        if (!engine) {
          // watch 关闭/热关（引擎缺失）：返回 disabled 状态对象（enabled:false, reason:'watch-disabled',
          //   tracked:false）——查询工具只读安全，不抛错；beat=true 已按 no-op 跳过
          return {
            batchId: args.batchId,
            sessionId,
            lanes: laneIds.map((l) => ({
              laneKey: `${sessionId}/${args.batchId}/${l}`,
              sessionId, batchId: args.batchId, lane: l,
              enabled: false,
              reason: 'watch-disabled',
              tracked: false,
              candidate: false,
              emitted: false,
              runningSince: null, runningSinceTs: null, durationMs: null,
              lastCheckpointTs: null, lastProgressTs: null, lastActivityAt: null,
              checkpointFresh: false, progressFresh: false, activityFresh: false,
              maxDurationMs: null, noProgressWindowMs: null,
              // 豁免态透出（与 enabled 路径同形：关闭态不假装知道豁免，一律缺省值）
              exempt: null, effectiveMaxDurationMs: null, thresholdMultiplier: 1,
              staleBatchMs: null, staleBatch: false,
              // 状态面字段（同上：关闭态给 lane 原始态，不假装知道判据）
              state: batch.lanes?.[l] ?? null, stateAnchorTs: null, stateResidentMs: null,
              dangling: isDanglingLane(batch, l), specialTask: false, exemptClearedAt: null,
            })),
          };
        }
        return {
          batchId: args.batchId,
          sessionId,
          lanes: laneIds.map((l) => engine.longrunStatus(sessionId, args.batchId, l, null)),
        };
      },
    }),
  ];
}
