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

// BatchStore：批次状态文件唯一事实源（原子写 + 事件日志 + 状态机迁移 + 恢复语义）
// v2：批次绑定 session——root/sessions/<sessionId>/batches/*.json；存量 root/batches 迁移到 legacy
// Tier3：层间门禁（entry/exit/Plan 契约/complete）由 state/gates.js 承担，createStore 经 createGates(root) 注入调用

import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto'; // L7：身份快照 sha256 + 原子写 tmp 唯一 token
// 【历史·已退役，保留可读】团队资产解析快照写单点（§8③：解析结果落会话级资产解析档 + 批次级指纹引用）——本文件只做**建批侧接线**：
//   解析 + 写档 + 字段/事件载荷的构建全在 lib/assembly/snapshot.js，store 不复制其语义
//   【2026-09-27 · 批 3】资产面全量退役 ⇒ 该接线（`import * as snapshot` + 建批侧写档）**已整条删除**。

// 事件 type 常量单点：newEvent 调用 type 一律引用本模块常量（禁止裸字面量）
import * as EVT from './event-types.js';
import { createGates } from './gates.js';
import { loadRules } from './machine-rules.js';
import { createArchive } from './archive.js'; // done→archive（complete 钩子）
import { createCorruptRegistry } from './corrupt-registry.js'; // 损坏批次旁路清单

// ── 波 3 拆分后的语义面 builder（子模块 ← 组合器，**单向依赖**；builder 不反向 import 本文件）──
import { buildPaths } from './store/paths.js';
import { buildEvents } from './store/events.js';
import { buildBatch } from './store/batch.js';
import { buildPlanMutate } from './store/plan-mutate.js';
import { buildHandoff } from './store/handoff.js';
// G-10（批 `g10-fix-20261012`）：受限反向声明写入口 —— 「下游经 `handoff_accept` 声明接受后置上游」。
//   与 `buildHandoff`（提交面）**分工不重叠**：本件只**补声明条目**（不提交、不改任何门判据）。
import { buildHandoffAccept } from './store/handoff-accept.js';
import { buildLifecycle } from './store/lifecycle.js';
import { buildMemberGates } from './store/member-gates.js';
import { buildMemberExempt } from './store/member-exempt.js';
import { buildMember } from './store/member.js';
import { buildGovernance } from './store/governance.js';
// 模块级事件载荷纯函数单点（仓内既有导入面：`import * as STORE from '../lib/state/store.js'`）
import { gateEscapeEvents, gateDegradeEvents, contractMissingEvents, countConsecutiveFailedSettles } from './store/events.js';
export { gateEscapeEvents, contractMissingEvents, countConsecutiveFailedSettles };

// D7（豁免继承/清退留痕）事件名 —— **单点已迁入 `lib/state/event-types.js`**（设计 §5.1「迁入」项；
//   原文案寄居本文件并自述「该文件在本批 writeForbidden 内」，该理由随 `event-types.js` 成为本批写域而失效）。
//   本文件**保留再导出**（R-32 断言再导出值逐字仍在）⇒ 既有导入面零破坏；
//   字面值逐字不变（`lib/watch/lane-heartbeat.js` 的 `exemptClearedAtOf` 按**同一字面量**反查，改值即静默断链）。
export const EVT_LANE_EXEMPT_INHERITED = EVT.EVT_LANE_EXEMPT_INHERITED;
export const EVT_LANE_EXEMPT_CLEARED = EVT.EVT_LANE_EXEMPT_CLEARED;

// ── V-4 写端（e2-gov-repair）：门禁逃生/降级载荷 → 批次事件 ─────────────────────────
// 契约（`plan/spec.md` §5.3 ＋ `plan/techdebt-design.md` §2.1）：
//   ① 门禁只**产载荷**（`{escape:{kind,…}}` / `{escapes:[…]}` / `{degrades:[…]}`）；落盘**唯一**在此写端，
//      且仅出现在**写路径**（`setMember` 的统一 atomicWrite 前）⇒ 只读视图（`gate_status`）绝不发射。
//   ② **fail-closed**：事件常量缺位时**抛明确错误**（`GATE_EVENT_CONST_MISSING`），
//      **绝不**写入 `type: undefined` / 空串（防「语义失名事件」污染审计面）。
//   ③ 载荷键 `escape.type` 属事件名，**不得**占用载荷 `type` 键 ⇒ 白名单式搬运（下方 *_OF 映射）。
const GATE_EVENT_CONST_MISSING = 'GATE_EVENT_CONST_MISSING';

// fail-closed 事件类型解析：常量必须是**非空字符串**才允许写盘（单一守卫，供 gate.escape / gate.degrade 共用）。
// 抛出即停手（调用点不落盘）——「缺常量 ⇒ 明确错误」优先于「写一条无名事件」。
function requireEventType(evt, name) {
  const t = evt ? evt[name] : undefined;
  if (typeof t !== 'string' || t.length === 0) {
    throw new Error(GATE_EVENT_CONST_MISSING + ': event type constant "' + name
      + '" is absent/empty in lib/state/event-types.js ⇒ 拒绝写入（fail-closed：不得写 type:undefined；'
      + '请先落常量再由写端发射）');
  }
  return t;
}

// 事件类型解析（**注入式**，默认取单点常量表 `lib/state/event-types.js`）：
//   写端在**每次落盘前**解析常量 ⇒ 缺位即抛（fail-closed）。`evt` 参数为生产零改动前提下的
//   可注入缝（缺省 = EVT namespace import，逐字同源）、供探针以「人为缺常量」实测守卫行为。
function resolveGateEventTypes(evt = EVT) {
  return {
    escape: requireEventType(evt, 'EVT_GATE_ESCAPE'),
    degrade: requireEventType(evt, 'EVT_GATE_DEGRADE'),
    // B2（§8⑤）：契约缺声明首触留痕——与 escape/degrade 同一 fail-closed 守卫（缺位即抛，绝不写失名事件）。
    contractMissing: requireEventType(evt, 'EVT_GATE_CONTRACT_MISSING'),
  };
}
// ── L7 写路径原子性（批次 `punky-spec-adopt-p2-20261013` / lane `e1-l7-atomic`）────────────
// 三处改动，**全部落在既有单点内、不新增文件、不接锁**：
//   ① tmp 名每次调用唯一：原名仅含 `process.pid` ⇒ **同进程并发两次写到同一目标 = 同一 tmp 路径**（互踩：
//      内容可交错、两次 rename 竞争）。现名追加**每次调用唯一成分**（单调计数 + 随机后缀）。
//   ② 有界重试 + 显式耗尽：`renameSync` 对**可重试类**错误（EPERM/EBUSY/EACCES）做**有限次退避重试**；
//      耗尽后**显式抛**（带重试次数与最后错误）。**注意**：`renameSync` 是**同步** API ⇒ 退避必须是
//      **同步等待**（不能 `await sleep`，那会把落盘点改成异步、破坏既有同步写路径语义）。
//   ③ 文件身份快照 + 比对纯函数（**只读新增 API**，不触碰既有读路径）。
// **不变量**：① 原子性不变（目标文件永不为半成品）；② 单写成功路径**逐字不变**（仅在原先「必抛」处
//   改为「重试后可能成功」⇒ **不引入新失败**）；③ 重试有界且耗尽即抛（禁无限重试、禁静默吞错）。
//
// ⚠ **两条必须留在源码里的事实**（防后人误改；本 lane 直读实测）：
//   (a) 下方 `commitBatch` 的历史注释曾称「与 `lane_claim` 的单写者锁构成双层保证」——**该说法不成立**：
//       `lib/lock.js`（65 行）是**纯 O_EXCL 锁文件助手**，其 import 点**只有工具面**三处
//       （`lib/tools/handoff-tools.js:24` / `lib/tools/lane-tools.js:48` / `lib/tools/member-tools.js:23`），
//       本文件 `atomicWrite` 体内**零 `lock` 调用**。⇒ `lane_claim` 是**逻辑/协议层**锁，`commitBatch` 是
//       **无锁物理直写**；任何**绕过工具面**直接调 store 写函数的调用方（`member_settle`/`appendEvent`/
//       `handoff_submit`/`setPhase`/`setMember` 内部路径）**都不被锁挡**。本 lane **不**把锁接进写路径
//       （那会扩张并发语义）⇒ 该缺口的**可判能力**由 ③ 的读端身份快照承载。
//   (b) `EPERM` 的两条确切路径（**两种原先都无重试**）：**跨进程** —— 双方 tmp 名不同（含各自 pid）⇒ 不互踩
//       tmp，但后到的 `renameSync` 可能因目标被另一进程持有句柄而抛；**同进程并发** —— tmp 名**相同** ⇒
//       **互踩** ⇒ 内容可交错 + 两次 rename 竞争。② 的统一重试覆盖两者。

/** 可重试类错误码（**只覆盖资源竞争类**；其余错误码一律立即上抛，不掩盖真实故障）。 */
const ATOMIC_WRITE_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** 重试上限（**有界**：总尝试次数 = 该值；耗尽即抛）。 */
const ATOMIC_WRITE_MAX_ATTEMPTS = 5;
/** 退避基数（毫秒）：第 n 次重试等待 `BASE * n`（线性退避，上限 `MAX`）。 */
const ATOMIC_WRITE_BACKOFF_MS = 2;
/** 退避单次等待上限（毫秒）。 */
const ATOMIC_WRITE_BACKOFF_CAP_MS = 40;

/** 每次调用唯一成分（单调计数 + 随机后缀）：同进程并发时两次调用的 tmp 名**必不相同**。 */
let atomicWriteSeq = 0;
function nextAtomicWriteToken() {
  atomicWriteSeq += 1;
  return process.pid + '.' + atomicWriteSeq + '.' + randomUUID().slice(0, 8);
}

/**
 * **同步**退避等待。`renameSync` 是同步 API ⇒ 不能 `await`（会把落盘点变异步）。
 * 优先 `Atomics.wait`（真阻塞、不烧 CPU）；不可用时回落 `Date.now()` 忙等（有界：单次 ≤ `BACKOFF_CAP`）。
 */
function sleepSyncSync(ms) {
  const budget = Math.max(0, Math.floor(ms));
  if (budget === 0) return;
  try {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(cell, 0, 0, budget);
    return;
  } catch {
    const until = Date.now() + budget;
    while (Date.now() < until) { /* 有界忙等：budget ≤ ATOMIC_WRITE_BACKOFF_CAP_MS */ }
  }
}

/**
 * 原子落盘：写 `<目标名>.<每次唯一 token>.tmp` → `renameSync` 覆盖目标（原子替换，目标永不为半成品）。
 * 对可重试类错误**有限次退避重试**；耗尽后抛错**带重试次数与最后错误**，并清理本次 tmp。
 * @param {string} file 目标文件绝对路径
 * @param {unknown} data 待序列化并落盘的数据
 * @param {{renameFn?: (from: string, to: string) => void}} [opts] 可注入缝：
 *   `renameFn` 缺省 = `fs.renameSync`（**生产路径逐字不变**）；仅供单测注入故障以实测重试语义。
 */
export function atomicWrite(file, data, { renameFn } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // tmp 名**一次生成、重试期间复用**（不在重试中换名 ⇒ 失败路径不遗留多份 tmp）
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + nextAtomicWriteToken() + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  const rename = typeof renameFn === 'function' ? renameFn : fs.renameSync;

  let lastErr = null;
  for (let attempt = 1; attempt <= ATOMIC_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      rename(tmp, file); // Windows: MoveFileEx REPLACE_EXISTING
      return;             // 成功路径：与改动前**逐字同效**（仅 tmp 名不同）
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      if (!ATOMIC_WRITE_RETRYABLE.has(code) || attempt >= ATOMIC_WRITE_MAX_ATTEMPTS) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort：目标文件不受影响 */ }
        // 不可重试类 ⇒ 立即上抛原错误（**不掩盖**）；耗尽 ⇒ 显式带次数与最后错误
        if (!ATOMIC_WRITE_RETRYABLE.has(code)) throw e;
        const err = new Error('atomicWrite 重试耗尽（尝试 ' + attempt + '/' + ATOMIC_WRITE_MAX_ATTEMPTS
          + '）：最后错误 ' + code + ' ' + String((lastErr && lastErr.message) || lastErr));
        err.code = code;
        err.attempts = attempt;
        err.retryExhausted = true;
        err.lastError = lastErr;
        err.target = file;
        throw err;
      }
      sleepSyncSync(Math.min(ATOMIC_WRITE_BACKOFF_MS * attempt, ATOMIC_WRITE_BACKOFF_CAP_MS));
    }
  }
}

/**
 * **文件身份快照**（只读）：`{size, mtimeMs, sha256, path}` —— 供读端判「读到的文件是否已被换过」。
 * 与 `atomicWrite` 的原子替换配合：读者读前取一份、读后取一份，`fileIdentityChanged` 为 true ⇒
 * 「本次读取期间文件被换过，读到的可能是旧/新混合视图」，调用方可据此重读（**可判**，非强制）。
 * @param {string} file 文件绝对路径
 */
export function fileIdentityOf(file) {
  const st = fs.statSync(file);
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { path: file, size: st.size, mtimeMs: st.mtimeMs, sha256 };
}

/**
 * 身份比对**纯函数**：判「文件是否已被换过」。
 * 口径（**显式**）：内容身份 = `size` **且** `sha256`；`mtimeMs` 仅作辅助信号、**不单独判不等**
 * （同内容重写会变 mtime）。⇒ 返回 true 的条件 = 一方缺位 ∨ size 不等 ∨ sha256 不等。
 * @param {{size?: number, sha256?: string}|null|undefined} before
 * @param {{size?: number, sha256?: string}|null|undefined} after
 */
export function fileIdentityChanged(before, after) {
  if (!before || !after) return true;
  return before.size !== after.size || before.sha256 !== after.sha256;
}


  // ── V-4 统一写盘点（e2-gov-repair）：逃生/降级载荷 → 批次事件 ──────────────────────────
  // 时序：在 member.settled 之前、统一 atomicWrite 之内 ⇒ 「门禁已判 + 留痕同批落盘」不可分割。
  // fail-closed：常量在此刻解析（`resolveGateEventTypes()`），缺位即抛 GATE_EVENT_CONST_MISSING
  //   ⇒ **不落盘**（原子写尚未执行）⇒ 绝不产生 `type:undefined` 事件。
  // 只写路径：本段仅存在于 `setMember`（写路径）；`gate_status` 等只读调用不经过本函数（R-04 可核）。
  // 【2026-10-02 · 波 3】本段降为**模块级单点**（无闭包状态，`newEvent` 由调用方注入）；上方契约逐字保留。
  function appendGatePayloadEvents(newEvent, batch, gatePayloads, lane) {
    if (gatePayloads.length > 0) {
      const evtTypes = resolveGateEventTypes();
      for (const item of gatePayloads) {
        const eventsOf = item.kind === 'degrade' ? gateDegradeEvents(item.res, lane) : gateEscapeEvents(item.res, lane);
        for (const ev of eventsOf) {
          batch.events.push(newEvent(item.kind === 'degrade' ? evtTypes.degrade : evtTypes.escape, ev.payload));
        }
      }
    }
  }

// 组合器：仅做导出面装配（键序与原 `return` 逐字一致 ⇒ 消费方零感知）
//   【2026-10-02 · 波 3】`createStore` 降为 ≤40 行组合器，导出面装配移出为模块级函数；
//   原 `return {...}` 字面量（含其历史登记注释）逐字保留于下方。
function composeStore(cx) {
  const {
    createBatch, readBatch, readBatchResult, isCorrupt, listBatches, listSessions, listAllBatches,
    setMember, setPhase, appendEvent, claimAsset,
    addPoolTasks, addTaskEdges,
    recordHandoff, recordHandoffAccept, markManagerRaised, revokeLaneExempt, recordGovernanceRefusal,
    declaredInboundEdgesOf, // 【G-10 · e3-toolface】门禁侧「已声明入边」单点（只读透出，见下方导出注释）
    readChains, updateChains, updateLaneProgress,
    batchSettled, batchAutoReleaseable,
    recoverBatches, recycleStalledLane, migrateLegacy, batchFile, artifactsDirOf,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    sessionsDir, gates, corruptRegistry, archive,
  } = cx;

  return {
    createBatch, readBatch, readBatchResult, isCorrupt, listBatches, listSessions, listAllBatches,
    setMember, setPhase, appendEvent, claimAsset,
    addPoolTasks, // N1-R4-1c：池内追加任务（图变更唯一写入口；单次 atomicWrite，只增不改）
    addTaskEdges, // N1-R4-2：池内任务**加边**（只增不删；已派发即冻结 K1；单次 atomicWrite）
    recordHandoff, // P1 交接门：交接记录唯一写入入口（`batch.handoffs` + `lane.handoff` 事件同一次 atomicWrite）
    // G-10：受限反向声明唯一写入入口（**写方 = 下游**）—— 只补 `handoffs[to]` 声明条目 + `plan.mutated{accepts}`
    //   留痕 + `planRevision+1`；**不写 `deps`**、不提交任何交接、不改任何门判据（净收紧：补一条声明义务）。
    recordHandoffAccept,
    // 【G-10 修复 · lane `e3-toolface`】门禁侧「已声明入边」单点（`deps(lane) ∪ {handoffs[lane].from}`，逐边带来源）
    //   **只读透出**给读端：唯一读端 = `lib/tools/handoff-tools.js#handoff_view`（修前该视图只读 `deps` ⇒
    //   `handoff_accept` 声明的入边在视图**结构性不可见** ⇒ 视图与门禁口径分叉，`L-AC-9` fail）。
    //   本键即 `lib/state/gates.ts` 透出的**同一函数实例**（红线 C-4 单点判定：视图与门禁同源，禁第二套）。
    declaredInboundEdgesOf: gates.declaredInboundEdgesOf,
    markManagerRaised, // Manager 拉起登记唯一入口（批 event + 批字段，不改成员状态）
    revokeLaneExempt, // longrun 豁免撤销唯一入口（显式调用；不改成员状态）
    recordGovernanceRefusal, // 违规计数记录 + 窗口评估 + 升级（批事件流单一事实源）
    readChains, updateChains, updateLaneProgress, // laneProgress 断点指针持久化
    batchSettled, batchAutoReleaseable,
    recoverBatches, recycleStalledLane, migrateLegacy, batchFile, sessionsDir, artifactsDirOf, gateStatus: gates.gateStatus,
    // TD-21 / N-13（2026-09-18 清理波）：批级门禁视图单点暴露（一次读批 → `{lane: gateView}`）——
    //   `lib/api.js` 的 `lanesGate` 投影唯一读端；与逐 lane 兼容外壳 `gateStatus` 同源同实现（`gates.ts`
    //   的 `gateStatusOfLane` 单点），差别只在读盘次数（投影段由 N 次降为 1 次）。
    gateStatusOfBatch: gates.gateStatusOfBatch,
    gateStatusMapOfBatch: gates.gateStatusMapOfBatch,
    // §8③ 快照读端（只读视图：实现为 `lib/state/gates/complete.js:142-144` 的**常量返回**
    //   `{teamAsset:null, declaration:null, declarationMissing:true}`——零 I/O、不读档、不回落现算；
    //   **不参与任何门禁判定**、读路径不 throw）
    teamAssetViewOf: gates.teamAssetViewOf,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    // 损坏旁路清单：幂等登记 / 只读清单 / 人工修复后清除标记（透传 corrupt-registry）
    corruptRegistry: { markBatchCorrupt: corruptRegistry.markBatchCorrupt, listCorruptBatches: corruptRegistry.listCorruptBatches, clearCorruptMark: corruptRegistry.clearCorruptMark, corruptFileOf: corruptRegistry.corruptFileOf },
    // 归档只读/幂等面（batch_status 面板与审计查询用）
    archive: { archiveBatch: archive.archiveBatch, readManifest: archive.readManifest, listArchived: archive.listArchived },
  };
}

export function createStore(root, { rules, logger, onStateChange, readConfig } = {}) {
  const sessionsDir = path.join(root, 'sessions');
  const legacyDir = path.join(root, 'batches');
  // 门禁侧的**热配置读取器**（`task-27`）：装配点可注入（与工具面 `deps.readConfig` 同源）；
  //   未注入 ⇒ 门禁闭包回落 `lib/hot/config-watch.js` 的模块级生效快照（`createGates` 内处理）。
  //   本文件**只传递**，不解析门开关、不读 env（门顺序与既有语义一字不动）。
  const gates = createGates(root, typeof readConfig === 'function' ? { readConfig } : {});
  // 损坏批次旁路清单：与 governance.json 同层；批次 JSON 结构零变更
  const corruptRegistry = createCorruptRegistry(root);
  // 留痕日志（可选注入；缺省 console——与 index.js ctx.logger 解耦，保持 createStore 既有调用点零改动）
  const log = logger ?? console;
  // 棘轮规则表（createStore(root, { rules }) 注入 loadRules 产物；未注入 = 默认规则 = schema 常量同引用，行为不变）
  // **接线已落地（A-①）**：装配点 `lib/index.js:108-112` 传 `rules: loadRules(config)`（**整份 config**
  //   ⇒ loadRules 内部自取 `config.ratchet`，machine-rules.js:78）⇒ 生产链路可达，`config.ratchet` 不再是死配置。
  //   本行形态**保持** `rules ?? loadRules()` 不变：无参兜底只服务「不传 rules 的调用方」（工具/测试直建 store），
  //   其返回与注入默认表**同引用**（machine-rules.js:82-84）⇒ 缺省零差异。
  const ratchet = rules ?? loadRules();
  // 归档器装配（createStore 签名不变；归档目标 = <root>/sessions/<sid>/archive/<bid>/）
  const archive = createArchive(root);

  // ── 波 3：闭包上下文 `cx`（每 createStore 实例一份；禁提升为模块级单例）+ 写面单点 ──
  const cx = { root, sessionsDir, legacyDir, gates, corruptRegistry, log, ratchet, archive,
    onStateChange, atomicWrite, resolveGateEventTypes, appendGatePayloadEvents, commitBatch };
  Object.assign(cx, buildPaths(cx));
  const { batchFile } = cx;
  // 构建顺序 = 依赖拓扑序（子模块 ← 组合器，单向依赖；各 builder 仅定义函数、无副作用）
  for (const build of [buildEvents, buildBatch, buildPlanMutate, buildHandoff, buildHandoffAccept, buildLifecycle,
    buildMemberExempt, buildMemberGates, buildMember, buildGovernance]) Object.assign(cx, build(cx));

  // 批次 JSON 的**统一落盘点**（单写者真源）：凡以 `batchFile(sessionId, batchId)` 定位的写路径
  //   一律经此函数落盘 ⇒ 写面单点不分散。
  //   ⚠ **订正（L7 / lane `e1-l7-atomic`，直读实测）**：本注释原称「与 `lane_claim` 的单写者锁构成
  //   **双层保证**」——**该说法不成立，已据实更正**：`lib/lock.js` 的 import 点**只有工具面三处**
  //   （`lib/tools/handoff-tools.js:24` / `lib/tools/lane-tools.js:48` / `lib/tools/member-tools.js:23`），
  //   `atomicWrite` 体内**零 `lock` 调用** ⇒ `lane_claim` 是**逻辑层**锁、本函数是**无锁物理直写**；
  //   **绕过工具面**直接调 store 写函数的路径**都不被锁挡**。详见上方 L7 段 `(a)`。
  function commitBatch(sessionId, batchId, batch) {
    atomicWrite(batchFile(sessionId, batchId), batch);
  }
  return composeStore(cx);
}
