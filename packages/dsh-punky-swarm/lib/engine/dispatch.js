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

// engine/dispatch.js —— **引擎自派**（engine-side dispatch）：C 档集群派发的执行通道。
// 定位：
//   · **可见性期收窄是唯一按次可用的收窄通道**：宿主 `subagent` 工具的模型面参数**不含** `toolFilter`
//     （`dsh-tool-subagent/lib/index.js:402-428`；`toolFilter` 只在插件配置 zod schema `:255-269` = 部署期静态），
//     而 `ctx.subagents.start(name, request)` 的 `request.toolFilter` 是**按次**的（one-shot 与 continuable 走
//     **同一** `applyChildComposition`，`dsh-subagent-in-process-driver/lib/index.js:173-176`）
//     ⇒ 只有程序化调用者（= 本模块）能按次收窄。
//   · **能力位前置**（调研收敛点 K4，5 源共识）：provider 不支持 `toolFilter` 时**拒派**，不「以弱换强」。
//   · **唯一写路径**（改善 W6）：自派成功后由引擎**直接写** `member.dispatch{lane, workerSessionId}`，
//     不再依赖 post-execute 事后观察（观察保留为兜底，覆盖 Leader 直派旧形态）。
//   · **失败显式**（修 W5）：任何失败路径都给出可读原因，不静默降级。
// 本模块是**纯函数 + 策略常量**（便于单测）；真正的 spawn 调用在 `lib/tools/core.js` 的 `lane_dispatch` 内
//   （必须在**工具流水线内**执行：`exec.agent` 在场，子会话才能正确挂到本会话）。
//
// ── 【2026-09-22 · one-shot 化（用户裁定「dispatch 彻底改为一次性执行器语义」）】 ──────────
//   · **spawn 通道**：`startContinuable` → **`rt.start(provider, request)`**（one-shot，fire-and-forget）：
//     run 生命周期属主 = 本模块 `activeRuns` 持有的 run 对象（`dsh-subagent-in-process-driver` 文件头：
//     "the one quiescent lifecycle owner held by the provider's caller"），**与 Leader 工具回合无关**；
//     引擎持引用、不调 `dispose` ⇒ worker 跑到完成（V-1 三层互证，见活体核报告）。
//   · **signal 纪律（禁透传 `exec.signal`）**：官方工具 foreground 用 `exec.signal`、background **故意新建
//     controller**（`dsh-tool-subagent/lib/index.js:559 / :543`）——`exec.signal` 随工具调用结束而中止 ⇒
//     本模块缺省**自持永不中止 signal**（`new AbortController().signal`），保 worker 跨回合跑完。
//   · **能力退役**：引擎侧**零** steer/queuePrompt/coldResume 依赖（2026-09-22 全库取证，19 条命中逐条判读）；
//     send_message worker 唤醒（continuous 专属）随 S2 退役。durable 会话/唤醒/续跑等 continuous 能力
//     **全部归 teammate runner**（agent-team 方案，`docs/agent-team-bridge-design-draft-v0-2026-09-21.md` §4/B5）
//     —— 两方案共用黑板与门禁，**不共用会话语义**。
//   · 依据：`docs/dispatch-one-shot-redesign-plan-2026-09-21.md` + 活体核
//     `docs/dispatch-one-shot-verification-2026-09-21.md`（V-1/V-2/V-3 全过）。
import { issueLaneHandle, consumeLaneHandle, firstLineOf } from '../bridge/lane-handle.js';
// 派发登记事件常量（原在 `lib/tools/core.js` 侧引用；派发核心抽出后由本模块写，故此处直引）
// 【2026-09-18 · Q-B 取消并发闸】原同址直引的 `EVT_GATE_CONCURRENCY_BLOCKED` 已从本模块写端移除（唯一写点
//   随闸删除）；常量本体仍在 `lib/state/event-types.js` **冻结保留**（历史批磁盘事件面读端逐字不变）。
import { EVT_MEMBER_DISPATCH } from '../state/event-types.js';
// 【2026-09-18 · Q-B】原 `isBatchTerminal` 只为并发闸判据的「让位面」而引（`concurrencyVerdictOf`
//   的 `batch-terminal` 分支）；闸取消后本模块**零读点** ⇒ import 一并删除（不保留第二套批终态判据）。

/** 成员 deny 集（B2 的 deny 清单，S2 起含宿主连续控制族 4 件 ⇒ 20 项）+ 模式门覆盖集：**单点注册表在 `engine/suite.js`**（`SUITE_TOOLS`），
 *  本模块 `import` 后**再导出**（导出名不变、内容随注册表演进；不得退回字面量）。
 *  ⚠ 必须 `import` + `export {}` 两句分开写：`export … from` 只做透传、**不建本地绑定**，
 *  而本模块的 `buildStartRequest({ denyTools = SUITE_DENY_TOOLS })` 缺省值依赖本地符号（活体实测报 ReferenceError）。
 *  口径边界、`subagent`/`subagent_fork` 必 deny 的理由、以及 `mcp__*` 不入表的口径，均随实现迁至 `suite.js` 表头注释。 */
import { SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from './suite.js';
export { SUITE_DENY_TOOLS, MODE_GATED_TOOLS };

/**
 * 第二绑定键（B3，学 agent-teams 的 label 做法）：可从**子会话事件/描述**反解析 (batchId, lane)，
 * 不依赖引擎内存，重启后仍可核。
 */
const LABEL_PREFIX = 'punky-swarm:';

// N1-R4-1b：**派发面 owner 取值**（唯一来源 = 调用方 Agent 标识）。取不到 ⇒ `null` ⇒ `setMember` **零写入**
//   （既有行为不变）——owner 是声明面，缺失只影响池视图，不阻断任何门禁。
const ownerOfExec = (exec) => exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;
export function labelOf(batchId, lane) {
  return LABEL_PREFIX + String(batchId) + ':' + String(lane);
}

/**
 * 成员任务包**骨架**（B1）：引擎侧给出「角色 / 目标 / 契约 / 产物 / 纪律」，Leader 的 `prompt` 作为任务要点追加。
 * 契约要点（与 discipline §0e 一致）：只给要素、不写实现；写盘走 edit/write；产物落批次产物根。
 */
export function composeWorkerPrompt({
  batchId, lane, cmd, layer, role, consume = [], produce = [], outputs = [], firstLine, leaderPrompt = '', artifactsRoot,
}) {
  const L = [];
  L.push(firstLine); // 首行：句柄标记（唯一凭证；引擎只读 exec.arguments，不注入参数）
  L.push('');
  L.push('# 任务包（引擎自派 · ' + labelOf(batchId, lane) + '）');
  L.push('- **lane**：`' + lane + '`｜**层**：`' + (layer ?? '-') + '`｜**角色**：`' + (role ?? '-') + '`');
  L.push('- **目标**：' + String(cmd ?? '（未声明 cmd）'));
  if (consume.length) L.push('- **消费件**：' + consume.map((p) => '`' + p + '`').join('、'));
  if (produce.length) L.push('- **产出面**：' + produce.map((p) => '`' + p + '`').join('、'));
  if (outputs.length) L.push('- **产物**：' + outputs.map((p) => '`' + p + '`').join('、'));
  if (artifactsRoot) L.push('- **批次产物根**：`' + artifactsRoot + '`（产物落此处，勿落工作区根）');
  L.push('');
  L.push('## 纪律');
  L.push('1. 写盘只用 `edit`/`write`；临时件用 `node -e` 的 `fs`；UTF-8 无 BOM、LF。');
  L.push('2. 禁 `git` 写；禁重启宿主；只碰本 lane 文件域。');
  L.push('3. 工具被折叠 ≠ 不存在：先 `tools_schema`/`tools_search` 检索，勿凭印象断言「没有」。');
  L.push('4. 完成/失败均**显式回报**（不给静默降级）；回报只给元数据与结论，不复制正文。');
  if (leaderPrompt) {
    L.push('');
    L.push('## 任务要点（Leader 补充）');
    L.push(leaderPrompt);
  }
  return L.join('\n');
}

/** 组装 `rt.start(provider, request)` 的 **one-shot 请求载荷**（纯函数，便于单测）。
 *  【2026-09-22 · one-shot 化】原 `buildStartSpec`（continuable 嵌套形态 `{provider,label,signal,request:{…}}`）
 *  改为**平铺 one-shot 请求**（`SubagentStartRequest`：`{label,prompt,parent,signal,toolFilter,persona?,maxDepth}`）；
 *  `provider` 改由调用方直传 `rt.start(provider, request)`（原 `spec.provider` 字段随形态删除）。
 *  ⚠ 活体实测（2026-09-16，批次 `suite-live-20260916` 首派第二层报错抓出）：宿主 `signal` 是**运行时必需字段**
 *  （缺它即抛 `Cannot read properties of undefined (reading 'throwIfAborted')`，由本模块 `mapSpawnError`
 *  归一为 `GATE_DISPATCH_FAILED`）——本字段纪律延续。
 *  ⚠ **signal 纪律（one-shot 化新增，禁透传 `exec.signal`）**：缺省给**自持永不中止**的 signal（worker 不随
 *  Leader 回合取消而中断；官方 background 分支实证 `exec.signal` 会随工具调用结束 abort，见头部「signal 纪律」）；
 *  调用方可注入自有 signal 以显式支持取消。
 *  `label`（B3）由宿主快照进子会话 descriptor（`dsh-subagent/lib/index.js:3155-3159`）⇒ 重启后仍可核。 */
export function buildStartRequest({
  batchId, lane, parent, prompt, denyTools = SUITE_DENY_TOOLS, extraDeny = [], persona, maxDepth = 1, signal,
}) {
  return {
    label: labelOf(batchId, lane),
    signal: signal ?? new AbortController().signal,
    parent,
    prompt: [{ type: 'text', text: prompt }],
    toolFilter: { deny: [...new Set([...denyTools, ...extraDeny])] },
    ...(persona !== undefined ? { persona } : {}),
    maxDepth,
  };
}

/**
 * spawn 失败的**显式映射**（B4 能力位前置 + B6 失败显式）：
 * 宿主在 provider 缺 `toolFilter`/`depthLimit` 能力时会自行拒绝（`dsh-tool-subagent/lib/index.js:370/377`），
 * 本函数把其文案归一到我们的码面，便于调用方与审计识别。
 * @returns {{code: string, message: string}}
 */
export function mapSpawnError(err) {
  const raw = String(err?.message ?? err ?? '');
  if (/capabilit|toolFilter|depthLimit/i.test(raw)) {
    return { code: 'GATE_DISPATCH_CAPABILITY_MISSING', message: 'provider 能力位不足（toolFilter/depthLimit）⇒ 拒派，不以弱换强：' + raw };
  }
  if (/provider|unknown provider|not resolvable/i.test(raw)) {
    return { code: 'GATE_DISPATCH_PROVIDER_INVALID', message: 'provider 不可解析（检查 config.dispatch.provider）：' + raw };
  }
  return { code: 'GATE_DISPATCH_FAILED', message: '引擎自派失败：' + raw };
}

/** `rt.start` 返回的 `SubagentRun` → worker 会话 id（one-shot 化语义）。
 *  **主字段 = `id`**（`SubagentRun.id` = 子会话 id，`dsh-subagent-in-process-driver` :166/:219 实证；
 *  与宿主 `subagent/end` 事件的 `info.id` 同源 —— V-3 已核，S3 观察桥据此对齐）。
 *  兼容回落 `childId`/`subagentId`（continuable 时代契约字段，防御宿主形态漂移）：回落命中**显式告警**。
 *  旧写法 `start.id ?? start.subagentId ?? start.childId` 是**猜字段且不告警**：宿主形态一变即静默 null。
 *  取不到时**不静默**：返回 null，由调用方带**原始载荷**报错。
 *  ⚠ 勿与 `runId`（宿主观察 id，`observeRun` 的 `SubagentRunId(randomUUID())`）混淆 —— 登记面只用**会话 id**。 */
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

/** `ctx.subagents` 是否可用（能力探测；缺省即降级为「仅发句柄」，不硬失败）。
 *  ⚠ 活体实测（2026-09-16，本批 suite-live-20260916 首派抓出）：cordis 对**未在 inject 声明的服务**
 *  在取属性时**直接抛** `cannot get property "subagents" without inject`（不是返回 undefined）
 *  ⇒ 取用必须包 try/catch，否则引擎自派以原始 cordis 错崩掉，而不是走既定的「仅发句柄」降级分支（B1 语义）。
 *  正解是 `lib/index.js` 的 `inject` 补 `subagents`（声明依赖）；本 try/catch 是兜底不崩。
 *  【2026-09-22 · one-shot 化】探测面 `startContinuable` → **`start`**（one-shot 唯一通道）。 */
export function subagentRuntimeOf(ctx) {
  let rt = null;
  try {
    rt = ctx?.subagents ?? null;
  } catch {
    return null; // 未注入/注入守卫抛错 ⇒ 视为不可用（降级为「仅发句柄」，不崩）
  }
  return rt && typeof rt.start === 'function' ? rt : null;
}

// ── 【2026-09-22 · one-shot 化】run 生命周期属主登记 ──────────────────────────────
// `activeRuns` = 本进程在飞的 one-shot worker run 表（key = workerSessionId）。**唯一的 quiescent
//   lifecycle owner 是调用方持有的 run 对象**（driver 文件头明言）⇒ 引擎必须持引用直到 result settle，
//   既防 GC 语义歧义，也为将来「批次中止 ⇒ 取消 worker」留取消入口（`run.dispose()`，本批不接线）。
//   result settle ⇒ 自动摘除；rejection ⇒ **显式告警留痕**（一次性 run 失败不许静默），**不进黑板判定**
//   （结算仍走门禁——"事件由引擎写、结算走门禁"纪律不变）。
const activeRuns = new Map();
/** one-shot run 终态跟踪（非抛出：跟踪失败只告警，绝不影响派发成功路径）。 */
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
/** 在飞 one-shot worker 数（观测面；测试与心跳探针用，**零判定**）。 */
export function activeRunCount() {
  return activeRuns.size;
}


// ── 派发核心（**唯一实现**：工具面与链引擎共用，禁第二套） ──────────────────────
// P2（批次 `p2-chain-autodrive-20260916`，lane e-chain）抽出：原实现内联在
//   `lib/tools/core.js` 的 `lane_dispatch.execute`；推进链的自动派发（`lib/engine/chain-runner.js`）
//   必须与工具面**走同一条**派发路径（同 Tier3 entry 门、同句柄、同 worker 任务包骨架、同
//   `member.dispatch` 登记），否则「链自派」与「人工派发」会在门禁/登记面分裂。
//
// 句柄生命周期口径（P0 修复，Leader 裁决 ⑤，2026-09-16）——**自派即发放即作废、仅直派形态需长期有效**：
//   · **成功自派**：`member.dispatch` 登记后会立即 `consumeLaneHandle` ⇒ 句柄从 `pendingHandles` 摘除
//     （形态：引擎已把 worker 拉起来，句柄的「派发凭证」使命已完成；留着只会让绑定缺口探针
//     `bindingGapOf` 把已绑定的 lane 误报成 `token-ttl-expired` 幽灵信号）。
//   · **降级「仅发句柄」两分支**（宿主无 `ctx.subagents` / 未配置 `config.dispatch.provider`）：
//     **不得消费**——此时句柄是 Leader **人工直派形态**的唯一凭证（把 `firstLine` 原样写进子代理
//     任务包首行），消费掉它等于把「直派形态」堵死；该形态的硬门禁属 C 阶段。
//   · **失败路径**：维持既有消费（派发失败已把 lane 置 `failed`（K3 起；此前为 `review`），句柄若留在 pending 会被探针
//     报成悬挂意图）；语义等价「已回收」。
//
// @returns {Promise<{batchId, lane, status, token, firstLine, ttlMs, spawned: boolean,
//                    workerSessionId?: string, spawnNote?: string}>}
//   硬失败（spawn 抛错 / 取不到 worker 会话 id）**抛错**：错误文案自带回滚事实与恢复步骤。
export async function dispatchLaneCore({ ctx, store, root, liveConfig, exec, sessionId, batchId, lane, leaderPrompt = '', exempt }) {
  // ⓿ 【2026-09-18 · Q-B 取消并发闸】原「闸位单点」调用 `assertConcurrencyAdmit(...)` 已删 ⇒ 本函数
  //   **零容量判定**（高并发不得被限流；`batch.concurrency` 只作声明 + 回显）。删除面与理由见本文件
  //   「并发闸 · 退役登记」段。
  // ① 置 running（含 Tier3 entry 门：consume 齐备 / condition / Manager 拉起）
  // 第 7 参 owner：派发面写入 ⇒ **派发即出池**（K1）；取不到 ⇒ null ⇒ 零写入（行为不变）。
  const b = store.setMember(sessionId, batchId, lane, 'running', null, exempt, ownerOfExec(exec));
  // ② 发放一次性句柄（任务包首行形态）
  const h = issueLaneHandle({ batchId, lane, sessionId });
  const base = { batchId, lane, status: b.lanes[lane], token: h.token, firstLine: h.firstLine, ttlMs: h.ttlMs };
  // ③ 能力探测（缺 ctx.subagents ⇒ 优雅降级为「仅发句柄」，**不消费句柄**）
  const rt = subagentRuntimeOf(ctx);
  if (!rt) {
    return { ...base, spawned: false, spawnNote: '宿主未提供 ctx.subagents ⇒ 仅发句柄（请把 firstLine 交给直派形态；该形态门禁属 C 阶段）' };
  }
  // N2/D6 三事实（2026-09-18 债清 3 · 逐条实测，勿再按印象改写）：
  //   ① **可热更**：`dispatch` 在 `lib/hot/config-watch.js:80` 的 `ALLOWED_TOP_KEYS` 白名单内
  //      ⇒ `<root>/config/runtime.json` 的 `dispatch.*` 改动经 watcher 生效，**无需重启宿主**。
  //      （白名单外的顶层键会被 `validateOverlay` 判 unknown 后**静默保持旧快照**——本类改动的经典坑。）
  //   ② **读端是热更快照**：`lib/index.js:282` 的 `readConfig` 注入 = `hotConfig.readSnapshot()`
  //      ⇒ 本行 `liveConfig?.dispatch?.provider` 取的是**当前生效快照**，不是启动期静态 config。
  //   ③ **「改不生效」的第一因不是代码，是配置缺失**：现网 `C:\Users\Administrator\.dsh\punky-preset\config\runtime.json`
  //      （2026-09-18 实读 573 B）顶层键只有 `gates` / `governance` / `capabilities`，**没有 `dispatch` 段**
  //      ⇒ `liveConfig.dispatch` 为 undefined ⇒ `provider` 恒 null ⇒ 走「仅发句柄」降级分支（下文 B4）。
  //      **排查顺序**：先看 `runtime.json` 有没有写 `dispatch.provider`，再怀疑热更链路。
  //   · **调用点唯 1 处**：`lib/tools/core.js:1369`（`lane_dispatch` 工具面）。
  //     历史「多调用点」表述随链推进全退役（2026-09-18 Q-A=C，`lib/engine/chain-runner.js:51`
  //     已改为「派发只剩工具面单通道」）**作废**，勿回加。
  const provider = liveConfig?.dispatch?.provider ?? null; // 热更快照（见上三事实；原读静态 config ⇒ 假热更）
  if (!provider) {
    // B4 能力位/配置前置：不猜 provider、不「以弱换强」。
    // ⚠ N1 清债（2026-09-16 评审）：此处**不得抛错**——抛错会**丢掉刚发放的句柄**，留下
    //   「lane=running、无 worker、无句柄」的僵尸态（只能靠心跳 `lane.binding_gap` 事后发现）。
    //   与「宿主无 ctx.subagents」同族 ⇒ 同走**降级为仅发句柄**：lane 保持 running、句柄原样返回
    //   （**不消费**，见本函数头 P0 口径），Leader 可补配置后重派，或用返回的 `firstLine` 走直派形态。
    ctx?.logger?.warn?.('[dsh-punky-swarm] lane_dispatch: 未配置 config.dispatch.provider ⇒ 仅发句柄（不猜 provider）· lane=' + lane);
    return { ...base, spawned: false, spawnNote: '未配置 config.dispatch.provider ⇒ 仅发句柄（补配置后重派，或用 firstLine 直派）' };
  }
  // ④ 任务包骨架：lane 契约 + 纪律 + 句柄首行（B2/B3 由 buildStartRequest 注入 toolFilter/label）
  // ⚠ 活体实测（2026-09-16，批次 suite-live-20260916 首派成功后发现）：`batch.wavePlan` 存的是
  //   **wave 数组**（`[{ wave, tasks:[…] }]`），旧写法读 `wavePlan.tasks` **恒取不到** ⇒ 任务包「目标」位
  //   退化成 `（未声明 cmd）`。此处拍平所有 wave 的 tasks。
  let laneTask = null;
  try {
    const wp = store.readBatch(sessionId, batchId)?.wavePlan ?? [];
    const flat = Array.isArray(wp) ? wp.flatMap((w) => w?.tasks ?? []) : (wp.tasks ?? []);
    laneTask = flat.find((t) => t && t.id === lane) ?? null;
  } catch { laneTask = null; }
  const artifactsRoot = root
    ? String(root).replace(/[\\/]+$/, '') + '/sessions/' + sessionId + '/artifacts/' + batchId
    : undefined;
  const prompt = composeWorkerPrompt({
    batchId, lane, cmd: laneTask?.cmd, layer: laneTask?.layer, role: laneTask?.role,
    consume: laneTask?.consume ?? [], produce: laneTask?.produce ?? [], outputs: laneTask?.outputs ?? [],
    firstLine: h.firstLine, leaderPrompt, artifactsRoot,
  });
  // 【2026-09-22 · one-shot 化】`startContinuable(spec)` → **`rt.start(provider, request)`**：
  //   one-shot 请求**平铺**（label/prompt/parent/signal/toolFilter/persona/maxDepth 同层）；
  //   **只 await 启动、不 await `run.result`**（fire-and-forget，保住「不阻塞 Leader 回合」）；
  //   run 交 `trackOneShotRun` 持引用（终态自动摘除，失败显式告警不进判定）。
  let start = null;
  try {
    if (!exec?.agent) throw new Error('缺少调用方 Agent —— 派发必须在工具流水线内调用（exec.agent 决定子会话挂载点）');
    // 【2026-09-24 · 0.1.7-rc.1 兼容自愈（A 方案）】宿主 `tools.restrict()` 对 `toolFilter.deny` 里的
    //   **未知工具名严格抛错**（不忽略）⇒ 名单残留一个**「该 scope 不可 restrict」**的名字即触发（实例：
    //   `wait_agent` —— 它由 agent-team 层注册，**仅在启用该层的 profile 上可 restrict**；未启用则不在
    //   `restrictableNames` 内），本次自派
    //   即**确定性失败**、lane 落 `failed` 终态（K3 不可原地重派 ⇒ 代价 = 整批作废）。
    //   自愈口径：从错误文案解析未知名 → **仅从本次 deny 名单移除** → **同一次派发内重试**（句柄只发放
    //   一次、不重复消费）；非该形态的错误**照旧抛出**（绝不吞错，守 B6「失败显式」纪律）。
    const denyAll = [...new Set([...SUITE_DENY_TOOLS, ...(liveConfig?.dispatch?.denyTools ?? [])])];
    const denyDropped = new Set();
    for (let attempt = 0; ; attempt++) {
      try {
        start = await rt.start(provider, buildStartRequest({
          batchId, lane, parent: exec.agent, prompt,
          // denyTools/persona 同样读**热更快照**
          denyTools: denyAll.filter((n) => !denyDropped.has(n)),
          extraDeny: [], // 已并入 denyAll（合并后再过滤，避免两路名单各有未知名时自愈失效）
          persona: liveConfig?.dispatch?.persona,
        }));
        break;
      } catch (e) {
        // 【P-2 修正（2026-09-24，独立复核发现）】宿主模板对 **≥2 个未知名** 用**复数**文案
        //   `unknown global tools "X", "Y"`（`${unknown.length > 1 ? 's' : ''}`）⇒ 正则须收 `tools?`，
        //   否则复数形态失配、`unknownName=null`、自愈静默退化为原始确定性失败（＝白做）。
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
    const m = mapSpawnError(e); // B6 失败显式：归一为可读码面，绝不静默
    // D-3（2026-09-16 清债）：派发失败**必须回滚 lane**——否则 lane 停在 `running` 却无 worker。
    //   K3（2026-09-21）改判：返工边 `review→running` 已去除 ⇒ 回滚到 `review` 会把 lane 卡在**非终态且无法重派**。
    //   回滚目标改取 `failed`（`running→failed` 在迁移表内，**零新增边**）：派发失败即终态，
    //   恢复按 K3 走「gap-list + 新任务批次」，**不再原地重派**。回滚为 best-effort，**不吞原始错误**。
    try { store.setMember(sessionId, batchId, lane, 'failed', 'dispatch-failed'); } catch { /* best-effort */ }
    // N5 清债（2026-09-16 评审）：失败路径**必须作废已发放的句柄**——否则它留在 `pendingHandles` 里，
    //   绑定缺口观测（`bindingGapOf`）会把它报成 `token-ttl-expired` 幽灵信号。句柄面没有 revoke API，
    //   故用一次性消费（`consumeLaneHandle`）把它从 pending 中摘除：token 从此作废，语义等价「已回收」。
    try { consumeLaneHandle(h.token, { batchId, lane }); } catch { /* best-effort */ }
    throw new Error(m.code + ': ' + m.message
      + ' ｜ 已将 lane=' + lane + ' 置 failed（无 worker 挂载；派发失败即终态）⇒ 恢复步骤：记入 gap-list 并开新任务批次，'
      + '**不可原地重派**（K3：返工边 review→running 已去除，重派会被 `invalid member transition` 拒）；'
      + '如需人工核查：`gate_status({ batchId: "' + batchId + '", lane: "' + lane + '" })`。');
  }
  // worker 会话 id **定点取值**（`SubagentRun.id` = 子会话 id），不再静默猜字段；
  //   兼容回落会**显式告警**，取不到则带原始载荷显式报错（不静默 null ⇒ 不留「绑定失败但无根因」）。
  const workerSessionId = workerSessionIdOf(start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  if (!workerSessionId) {
    throw new Error('GATE_DISPATCH_FAILED: rt.start 未返回 worker 会话 id（载荷=' + JSON.stringify(start)
      + '） —— 契约字段为 `id`（`SubagentRun.id` = 子会话 id；与 `subagent/end` 事件 `info.id` 同源）；'
      + '宿主返回形态若变更请按本载荷适配。');
  }
  // 【2026-09-22 · one-shot 化】run 生命周期属主登记（持引用防 GC 语义歧义；终态自动摘除；失败显式告警）。
  trackOneShotRun(workerSessionId, start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  // ⑤ B5 唯一写路径：自派成功即由引擎直接登记（不依赖 post-execute 事后观察）
  store.appendEvent(sessionId, batchId, EVT_MEMBER_DISPATCH, { lane, workerSessionId });
  // ⑥ **P0**：成功自派 ⇒ 立即作废句柄（口径见本函数头「自派即发放即作废、仅直派形态需长期有效」）。
  //   顺序要点：必须在 `member.dispatch` 登记**之后**——先有绑定事实、再无悬赏意图，
  //   否则「无 dispatch 事件 + 句柄已消费」会在探针面构造成一个无人认领的中间态。
  try { consumeLaneHandle(h.token, { batchId, lane }); } catch { /* best-effort：句柄面为进程内单例，不该抛 */ }
  return { ...base, spawned: true, workerSessionId };
}

// ── C 阶段：C 档派发面门禁（**软启用**，防自锁） ─────────────────────────────────
// 语义（「不写 token 即禁止派发」）：
//   · **B 档**：`subagent`/`subagent_fork` **一律放行**（单步调研/单步派发，无 lane 绑定）；
//   · **A 档**：由既有门禁 3 拒（本函数不重复判）；
//   · **C 档**：须携带**有效 lane 句柄**（`lane_dispatch` 发放；一次性 + TTL）。
// 落地形态 = `config.dispatch.gate`：`'warn'`（缺省，**只留痕告警不拦**）。
// **`'enforce'` 拒态已删**（勿回加）—— 原码
//   `subagent`/`subagent_fork`（`dsh-experimental-agent-team-profile/cordis.patch.yml:10-14`）
//   ⇒ 闸门拦的工具在官方场景不存在。现语义 = **只留痕不拦**（`evaluateTierCDispatch` 恒 `ok:true`
//   + `warnNote`）；`readGateMode` 保留（配置面仍在，供审计/热更观测，不再决定拦截）。
export function readGateMode(config) {
  const m = config?.dispatch?.gate;
  return m === 'enforce' ? 'enforce' : 'warn';
}

// ── D 阶段：成员侧套件通信（`swarm_report` → Leader / `swarm_cc` → Manager） ─────────
// 身份**由引擎反查绑定**（不靠成员自报）：`member.dispatch` 的 workerSessionId → { batchId, lane }。
// 【gate-lite 第一批 · E① 清理（2026-09-17）】**已删 `UNBOUND_REPORT_CODE` 导出与「未绑定即拒」语义**：
//   官方 Team 成员（宿主 `spawn_teammate` 拉起）**天然无 lane 绑定** ⇒ 未绑定是**常态**，硬拒即误拦
//   （实测命中 `replay-lock` / `asset-chain`）。现口径 = best-effort：消息照发、事件按「批次可否解析」
//   如实落/不落、回显 `unbound`/`eventWritten`/`notice`（唯一实现见 `lib/tools/core.js#reportTargetOf`）。
//   本段只留史迹，**不再提供常量导出**（防读端回生旧语义）。

/** 从批次事件流反查该会话绑定的 lane（worksWith 引擎自派与直派两种登记形态）。 */
export function laneBindingOf(store, sessionId) {
  if (!sessionId || !store || typeof store.listAllBatches !== 'function') return null;
  let all = [];
  try { all = store.listAllBatches() ?? []; } catch { return null; }
  for (const { sessionId: ownerSession, batchId } of all) {
    let b = null;
    try { b = store.readBatch(ownerSession, batchId); } catch { continue; }
    for (const ev of b?.events ?? []) {
      if (ev?.type === 'member.dispatch' && ev.workerSessionId === sessionId && ev.lane) {
        return { sessionId: ownerSession, batchId, lane: ev.lane };
      }
    }
  }
  return null;
}

/** 批次邮箱根（与 lane-heartbeat 同口径）：<engineRoot>/sessions/<sessionId>/mailbox/<batchId>。 */
export function mailboxRootOf(engineRoot, sessionId, batchId) {
  return String(engineRoot ?? '').replace(/[\\/]+$/, '') + '/sessions/' + sessionId + '/mailbox/' + batchId;
}

/** 成员回报的通路（0f/Manager 通道口径）：Leader 读 broadcast；Manager 读 supervisor/inbox。 */
export const REPORT_CHANNEL = Object.freeze({ leader: 'broadcast', manager: 'inbox' });

/**
 * 纯函数：给定档位/工具名/参数文本/配置，判定 C 档派发面的**留痕**处置。
 * **恒 `ok:true`（不再拒）**：原 `mode==='enforce'`
*   分支已随码删除（官方 profile 已 disable 宿主 `subagent`/`subagent_fork`）。
 *   `mode` 仍回显（`warn`/`enforce` = 配置面事实，供审计观测），但**不再影响判定**；无有效句柄一律产 `warnNote`。
 * @returns {{applies: boolean, ok: boolean, mode: 'warn'|'enforce', handleReason: string|null, denyReason: null, warnNote: string|null}}
 */
export function evaluateTierCDispatch({ tier, toolName, argsText, config, handleCheck }) {
  const mode = readGateMode(config);
  const isDispatchTool = toolName === 'subagent' || toolName === 'subagent_fork';
  if (!isDispatchTool || tier !== 'C') {
    return { applies: false, ok: true, mode, handleReason: null, denyReason: null, warnNote: null };
  }
  const r = typeof handleCheck === 'function' ? handleCheck(argsText) : { ok: false, reason: 'no-handle-check' };
  if (r.ok) return { applies: true, ok: true, mode, handleReason: null, denyReason: null, warnNote: null };
  const handleReason = r.reason ?? 'invalid-handle';
  return {
    applies: true, ok: true, mode, handleReason, denyReason: null,
    warnNote: 'dispatch without valid lane handle under tier C（mode=' + mode
      + '，留痕不拦；原 enforce 拒态已随码删除）'
      + ' · tool=' + toolName + ' · handle=' + handleReason
      + ' —— 仍建议：先 `lane_dispatch({ batchId, lane })` 取句柄并把 `firstLine` 写入子代理任务包首行。',
  };
}

// ── E 阶段：模式跟随（全局装载、不全局生效） ────────────────────────────────────
// 用户裁决（2026-09-16）：插件绑定指引使用，切到别的模式后门禁仍开着会把没有蟛蜞指引的 Agent
//   直接卡死。诉求 = 「全局装载，但不全局生效」——**运作跟随模式开关**（静态 config 或热更入口）。
// 语义（`config.modes.gate`）：
//   · 未配置 / `null` → **全模式生效**（旧行为；包缺省保持向后兼容，不因升级悄悄开启或关闭任何人）；
//   · 字符串数组      → **白名单**：只有 `header.agentPreset ∈ 白名单` 的会话启用蟛蜞治理
//     （门禁、执行型计数、套件工具一律不介入其他模式）；
//   · `[]`            → 显式停用（谁都不生效）；
//   · 其它形态        → 回落「全模式生效」+ 告警（防拼写漂移悄悄关掉门禁；宁可见旧行为也不要幽灵配置）。
// 读端：传入的 config 必须是**当前生效快照**（index.js 注入热更快照读取器）⇒ 改 runtime.json 的
//   `modes.gate` 即热生效，无需重启。
export const MODE_INACTIVE_CODE = 'GATE_MODE_INACTIVE';

/** 会话所属模式（agent preset id）：来自会话 header 的创建事实（宿主 dsh-session 校验为 string）。 */
export function presetOfSession(exec) {
  const p = exec?.agent?.session?.header?.agentPreset;
  return typeof p === 'string' && p ? p : null;
}

/** 子会话（Manager / worker）：宿主语义下 join 父会话的 standing 组合 ⇒ 模式随父，不因缺 header 被误判。 */
export function isChildSession(exec) {
  const h = exec?.agent?.session?.header;
  return !!(h && (h.delegationDepth > 0 || h.parentSession));
}

/** 归一 `config.modes.gate`（纯函数，可单测）：null = 全模式生效；数组 = 白名单。 */
export function normalizeModeGate(raw, warn) {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const bad = raw.filter((x) => typeof x !== 'string' || x === '');
    if (bad.length) {
      warn?.('modes.gate 元素须为非空字符串（got ' + JSON.stringify(bad) + '）⇒ 回落「全模式生效」');
      return null;
    }
    return [...raw];
  }
  warn?.('modes.gate 须为字符串数组或 null（got ' + JSON.stringify(raw) + '）⇒ 回落「全模式生效」');
  return null;
}

/**
 * 本会话是否启用蟛蜞治理（纯函数）。
 * @param config 当前生效配置快照
 * @param exec   工具调用上下文
 * @returns {boolean} true = 启用（旧行为）；false = 本模式不生效 ⇒ 门禁/计数/套件工具全部不介入
 */
export function modeActiveFor(config, exec, warn) {
  const gate = normalizeModeGate(config?.modes?.gate, warn);
  if (gate === null) return true;
  if (isChildSession(exec)) return true; // 子会话继承父会话模式（Manager 结算面不被误锁）
  const preset = presetOfSession(exec);
  return preset !== null && gate.includes(preset);
}
