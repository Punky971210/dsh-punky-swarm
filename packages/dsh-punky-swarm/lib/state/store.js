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

import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

// 事件 type 常量单点：newEvent 调用 type 一律引用本模块常量（禁止裸字面量）
import * as EVT from './event-types.js';
import { createGates } from './gates.js';
import { laneStateOf } from './lane-state.js';
import { loadRules } from './machine-rules.js';
import { createArchive } from './archive.js';
import { createCorruptRegistry } from './corrupt-registry.js';
import { isBatchTerminal } from '../schema.js';
import { isAtLeastAsTight } from '../governance/policy.js';

import { buildPaths } from './store/paths.js';
import { buildEvents } from './store/events.js';
import { buildBatch } from './store/batch.js';
import { buildPlanMutate } from './store/plan-mutate.js';
import { buildHandoffRecord } from './store/handoff.js'; // ④ 改名：与 `gates/handoff.js` 的判定构建（同名不同物）区分
import { buildHandoffAccept } from './store/handoff-accept.js';
import { buildLifecycle } from './store/lifecycle.js';
import { buildMemberGates } from './store/member-gates.js';
import { buildMemberExempt } from './store/member-exempt.js';
import { buildMember, CHECKPOINT_PRIMITIVES } from './store/member.js';
import { buildGovernance } from './store/governance.js';
import { gateEscapeEvents, gateDegradeEvents, contractMissingEvents, countConsecutiveFailedSettles } from './store/events.js';
export { gateEscapeEvents, contractMissingEvents, countConsecutiveFailedSettles };

export const EVT_LANE_EXEMPT_INHERITED = EVT.EVT_LANE_EXEMPT_INHERITED;
export const EVT_LANE_EXEMPT_CLEARED = EVT.EVT_LANE_EXEMPT_CLEARED;

const GATE_EVENT_CONST_MISSING = 'GATE_EVENT_CONST_MISSING';

// fail-closed 事件类型解析：常量必须是**非空字符串**才允许写盘（单一守卫，供 gate.escape / gate.degrade 共用）。
function requireEventType(evt, name) {
  const t = evt ? evt[name] : undefined;
  if (typeof t !== 'string' || t.length === 0) {
    throw new Error(GATE_EVENT_CONST_MISSING + ': event type constant "' + name
      + '" is absent/empty in lib/state/event-types.js ⇒ 拒绝写入（fail-closed：不得写 type:undefined；'
      + '请先落常量再由写端发射）');
  }
  return t;
}

function resolveGateEventTypes(evt = EVT) {
  return {
    escape: requireEventType(evt, 'EVT_GATE_ESCAPE'),
    degrade: requireEventType(evt, 'EVT_GATE_DEGRADE'),
    contractMissing: requireEventType(evt, 'EVT_GATE_CONTRACT_MISSING'),
  };
}
//      **同步等待**（不能 `await sleep`，那会把落盘点改成异步、破坏既有同步写路径语义）。

const ATOMIC_WRITE_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ATOMIC_WRITE_MAX_ATTEMPTS = 5;
const ATOMIC_WRITE_BACKOFF_MS = 2;
const ATOMIC_WRITE_BACKOFF_CAP_MS = 40;

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
    while (Date.now() < until) {  }
  }
}

/**
 * 原子落盘：写 `<目标名>.<每次唯一 token>.tmp` → `renameSync` 覆盖目标（原子替换，目标永不为半成品）。
 * @param {string} file 目标文件绝对路径
 * @param {unknown} data 待序列化并落盘的数据
 * @param {{renameFn?: (from: string, to: string) => void}} [opts] 可注入缝：
 */
export function atomicWrite(file, data, { renameFn } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + nextAtomicWriteToken() + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  const rename = typeof renameFn === 'function' ? renameFn : fs.renameSync;

  let lastErr = null;
  for (let attempt = 1; attempt <= ATOMIC_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      rename(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      if (!ATOMIC_WRITE_RETRYABLE.has(code) || attempt >= ATOMIC_WRITE_MAX_ATTEMPTS) {
        try { fs.unlinkSync(tmp); } catch {  }
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
 * @param {string} file 文件绝对路径
 */
export function fileIdentityOf(file) {
  const st = fs.statSync(file);
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { path: file, size: st.size, mtimeMs: st.mtimeMs, sha256 };
}

/**
 * 身份比对**纯函数**：判「文件是否已被换过」。
 * @param {{size?: number, sha256?: string}|null|undefined} before
 * @param {{size?: number, sha256?: string}|null|undefined} after
 */
export function fileIdentityChanged(before, after) {
  if (!before || !after) return true;
  return before.size !== after.size || before.sha256 !== after.sha256;
}


  // fail-closed：常量在此刻解析（`resolveGateEventTypes()`），缺位即抛 GATE_EVENT_CONST_MISSING
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

//      比对**必须紧邻** `atomicWrite`（= 本函数内），不能上移到写函数入口：否则窗口含整段门禁执行
const BATCH_REV_KEY = '__rev';

function revOf(obj) {
  const v = obj ? obj[BATCH_REV_KEY] : undefined;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

function diskRevOf(file, batchId) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('batch file is not valid JSON, refuse to overwrite: ' + batchId
      + ' (' + String((err && err.message) || err) + ')');
  }
  return revOf(parsed);
}

/**
 * rev 冲突错误（**普通错误**，**非 `GATE_` 前缀**；不参与任何门禁语义）。
 * 为何带修复提示：本仓纪律「报错必须自带下一步」（同 `store/member.js` 的 `d4Hint`）——
 */
function batchVersionConflictOf(batchId, expected, actual) {
  const err = new Error(
    'batch version conflict: ' + batchId
    + ' —— 本次读取的 __rev=' + expected + '，盘上已是 __rev=' + actual
    + '；有并发写者在本轮读取之后提交过。本次写入未落盘（零副作用）。'
    + '修复：重新读取该批次后重试（store.readBatch → 同一写函数；或先 batch_status 确认盘上状态）。',
  );
  err.code = 'BATCH_VERSION_CONFLICT';
  err.batchId = batchId;
  err.expected = expected;
  err.actual = actual;
  return err;
}

function composeStore(cx) {
  const {
    createBatch, readBatch, readBatchResult, isCorrupt, listBatches, listSessions, listAllBatches, recentBatches,
    setMember, setPhase, appendEvent, claimAsset,
    commitBatch,
    addPoolTasks, addTaskEdges,
    recordHandoff, recordHandoffAccept, recordGovernanceRefusal,
    readChains, updateChains, updateLaneProgress,
    batchSettled, batchAutoReleaseable,
    recoverBatches, recycleStalledLane, migrateLegacy, batchFile, artifactsDirOf,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    sessionsDir, gates, corruptRegistry, archive,
  } = cx;

  const readBatchMap = (sessionId, ids) => {
    const out = new Map();
    const wanted = Array.isArray(ids) && ids.length > 0 ? ids : null;
    if (wanted === null) {
      for (const id of listBatches(sessionId)) {
        const b = readBatch(sessionId, id);
        if (b) out.set(id, b);
      }
      return out;
    }
    if (wanted.length === 1) {
      const b = readBatch(sessionId, wanted[0]);
      if (b) out.set(wanted[0], b);
      return out;
    }
    for (const id of wanted) {
      const b = readBatch(sessionId, id);
      if (b) out.set(id, b);
    }
    return out;
  };

  return {
    // 【②-丙 裁决】白盒写入口：原 `commitBatchLocked`（= `withBatchRowLock` 串行 + `commitBatch`）已删除。
    //   理由：26 个写点的包裹函数**全部同步**，一次「读-改-写」在单线程下整体原子 ⇒ 进程内串行器
    //   提供不了 CAS 之外的保护；它也不做跨进程互斥（只是 promise 链）。故直接暴露 `commitBatch`
    //   （CAS → IMM/交接校验 → `assertBatchWriteAllowed` → `atomicWrite`，判据面一个不少）。
    readBatchMap,
    commitBatch,
    createBatch, readBatch, readBatchResult, isCorrupt, listBatches, listSessions, listAllBatches, recentBatches,
    setMember, setPhase, appendEvent, claimAsset,
    addPoolTasks,
    addTaskEdges,
    recordHandoff,
    recordHandoffAccept,
    // 交接面两个判定单点**直接透出 gates 的同一函数实例**（视图与门禁不得各写一份）
    declaredInboundEdgesOf: gates.declaredInboundEdgesOf,
    handoffRecordVerdict: gates.handoffRecordVerdict,
    recordGovernanceRefusal,
    recordGovernanceRefusal,
    readChains, updateChains, updateLaneProgress,
    batchSettled, batchAutoReleaseable,
    recoverBatches, recycleStalledLane, migrateLegacy, batchFile, sessionsDir, artifactsDirOf, gateStatus: gates.gateStatus,
    gateStatusOfBatch: gates.gateStatusOfBatch,
    gateStatusMapOfBatch: gates.gateStatusMapOfBatch,
    teamAssetViewOf: gates.teamAssetViewOf,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    corruptRegistry: { markBatchCorrupt: corruptRegistry.markBatchCorrupt, listCorruptBatches: corruptRegistry.listCorruptBatches, clearCorruptMark: corruptRegistry.clearCorruptMark, corruptFileOf: corruptRegistry.corruptFileOf },
    archive: { archiveBatch: archive.archiveBatch, readManifest: archive.readManifest, listArchived: archive.listArchived },
  };
}

// 纯增量边界（红线）：只**追加** `lanes` 键（追加在事件对象键序末尾），**不改/不删任何既有键**；

/**
 * 采样时刻的 lane 态快照。
 */
function laneSnapshotOf(batch) {
  const lanes = {};
  for (const laneId of Object.keys(batch?.lanes ?? {})) lanes[laneId] = laneStateOf(batch, laneId);
  return lanes;
}

/**
 * 纯增量戳记：给**尚无** `lanes` 键的 `gate.*` 事件补上当前 lane 态快照。
 *   `gate.passed` 会在第 5 次提交时被**改写成第 5 波的 lane 态** ⇒ 快照失真且不可复原。
 */
function stampGateLaneSnapshot(batch) {
  if (!batch || !Array.isArray(batch.events)) return;
  let snapshot = null;
  for (const e of batch.events) {
    if (!e || typeof e.type !== 'string' || !e.type.startsWith('gate.')) continue;
    if (Object.prototype.hasOwnProperty.call(e, 'lanes')) continue;
    if (snapshot === null) snapshot = laneSnapshotOf(batch);
    e.lanes = { ...snapshot };
  }
}


export function createStore(root, { rules, logger, onStateChange, readConfig, revRaceHook } = {}) {
  const sessionsDir = path.join(root, 'sessions');
  const legacyDir = path.join(root, 'batches');
  // 【批 `punky-ckpt-followup-20261112` · lane `e1-impl` · s2】checkpoint 判据原料经 DI 缝注入 `createGates`
  //   ⇒ 投影单点（`gates/status.js` 的 subtask 计数）与门族（`gates/checkpoints.js`）**共用同一个 frozen 对象**
  //   （`store/member.js` 的 `CHECKPOINT_PRIMITIVES`），禁第二份表；也避免 `gates → resume` 成环（C-1）。
  const gates = createGates(root, {
    ...(typeof readConfig === 'function' ? { readConfig } : {}),
    checkpointPrimitives: CHECKPOINT_PRIMITIVES,
  });
  const corruptRegistry = createCorruptRegistry(root);
  const log = logger ?? console;
  const ratchet = rules ?? loadRules();
  const archive = createArchive(root, { commitBatch });

  const cx = { root, sessionsDir, legacyDir, gates, corruptRegistry, log, ratchet, archive,
    onStateChange, atomicWrite, resolveGateEventTypes, appendGatePayloadEvents, commitBatch,
    revRaceHook };
  Object.assign(cx, buildPaths(cx));
  const { batchFile } = cx;
  for (const build of [buildEvents, buildBatch, buildPlanMutate, buildHandoffRecord, buildHandoffAccept, buildLifecycle,
    buildMemberExempt, buildMemberGates, buildMember, buildGovernance]) Object.assign(cx, build(cx));

  //   `deps` 只读；**未派发**任务的追加 / 加边**仍允许**，但图变更必须在**同一次落盘**内留 `plan.mutated`
  function assertWavePlanImmutable(sessionId, batchId, batch) {
    const prev = cx.readBatch(sessionId, batchId);
    if (!prev || typeof prev !== 'object') return;
    const flatTasks = (b) => (Array.isArray(b?.wavePlan) ? b.wavePlan : [])
      .flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    const asArr = (v) => (Array.isArray(v) ? v : []);
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const reject = (invariant, taskId, detail) => {
      throw new Error('[wave-plan-immutable] batch=' + batchId + ' lane=' + String(taskId)
        + ' ' + invariant + ': ' + detail);
    };
    const byId = (b) => new Map(flatTasks(b).filter((t) => t && typeof t.id === 'string').map((t) => [t.id, t]));
    const prevTasks = byId(prev);
    const nextTasks = byId(batch);
    const SKIP_FIELDS = new Set(['deps', 'owner', 'wave', 'sig']);
    for (const id of prevTasks.keys()) {
      if (!nextTasks.has(id)) reject('IMM-1', id, '既有任务被删除（任务集合只增不删）');
    }
    for (const [id, p] of prevTasks) {
      const n = nextTasks.get(id);
      if (!n) continue;
      const dispatched = typeof p.owner === 'string' && p.owner.length > 0;
      for (const k of new Set([...Object.keys(p), ...Object.keys(n)])) {
        if (SKIP_FIELDS.has(k)) continue;
        if (!same(p[k], n[k])) reject(dispatched ? 'IMM-2' : 'IMM-3', id, '字段被改写: ' + k);
      }
      if (dispatched) {
        if (!same(asArr(p.deps), asArr(n.deps))) reject('IMM-2', id, '已派发任务 deps 被改写');
        if (!same(p.owner, n.owner)) reject('IMM-2', id, '已派发任务 owner 被改写');
      } else {
        const pd = asArr(p.deps);
        const nd = asArr(n.deps);
        if (nd.length < pd.length || !pd.every((d, i) => nd[i] === d)) {
          reject('IMM-3', id, '未派发任务 deps 非「旧边前缀 + 新尾」');
        }
        if (p.owner != null && p.owner !== n.owner) reject('IMM-3', id, '未派发任务 owner 非空后被改写');
      }
    }
    // IMM-4：图变更（新增任务 / deps 变长）必须在**本次** commit 的**追加段**内留 `plan.mutated`
    const added = [...nextTasks.keys()].filter((id) => !prevTasks.has(id));
    const grownId = [...prevTasks.keys()].find((id) => {
      const n = nextTasks.get(id);
      return n !== undefined && asArr(prevTasks.get(id).deps).length !== asArr(n.deps).length;
    });
    if (added.length > 0 || grownId !== undefined) {
      const before = asArr(prev.events).length;
      const trailed = asArr(batch.events).slice(before);
      if (!trailed.some((e) => e && e.type === EVT.EVT_PLAN_MUTATED)) {
        reject('IMM-4', added[0] ?? grownId, '图变更无 plan.mutated 留痕（须经 plan-mutate 入口）');
      }
    }
  }

        /**
   * ## 为什么需要（缺口事实）
   * ## 判据（与 IMM-4 同构，fail-closed）
   * `handoffs` 的 **status 或条目集合**发生变化 ⇒ **本次 commit 的追加段**必须出现
   */
  function assertHandoffsIntegrity(sessionId, batchId, batch) {
    const prev = cx.readBatch(sessionId, batchId);
    if (!prev || typeof prev !== 'object') return;
    const sigOf = (b) => {
      const map = b?.handoffs;
      if (map === null || typeof map !== 'object') return null;
      const rows = [];
      for (const to of Object.keys(map)) {
        const list = Array.isArray(map[to]) ? map[to] : [];
        for (const r of list) {
          if (!r || typeof r.from !== 'string') continue;
          rows.push(to + '\u0000' + r.from + '\u0000' + String(r.status ?? ''));
        }
      }
      rows.sort();
      return rows.join('\u0001');
    };
    const prevSig = sigOf(prev);
    const nextSig = sigOf(batch);
    if (prevSig === nextSig) return;
    const before = Array.isArray(prev.events) ? prev.events.length : 0;
    const trailed = (Array.isArray(batch.events) ? batch.events : []).slice(before);
    const hasTrace = trailed.some((e) => e
      && (e.type === EVT.EVT_LANE_HANDOFF || e.type === EVT.EVT_PLAN_MUTATED));
    if (!hasTrace) {
      throw new Error('[handoffs-integrity] batch=' + batchId
        + ' handoffs 的 status 或条目集合发生变化，但本次 commit 追加段**无** `lane.handoff` / `plan.mutated` 留痕'
        + ' ⇒ 疑似手改批 JSON 伪造交接状态（正常写路径自带事件；本守卫与 IMM 同属写前拒，拒则零落盘）');
    }
  }

  function assertBatchWriteAllowed(sessionId, batchId, batch, { action = 'commit' } = {}) {
    const prev = cx.readBatch(sessionId, batchId);
    if (!prev || typeof prev !== 'object') return;
    const deny = (detail) => {
      throw new Error('deny-zero-write: batch=' + String(batchId) + ' action=' + String(action) + ' ' + detail);
    };
    if (isBatchTerminal(prev.phase) && batch.phase !== prev.phase) {
      deny('D-1 终态相位迁移被拒（盘上 phase=' + String(prev.phase) + '，本次 phase=' + String(batch.phase) + '）');
    }
    if (batch.policy !== undefined && prev.policy !== undefined) {
      if (!isAtLeastAsTight(prev.policy, batch.policy)) {
        deny('D-2 策略非单调（放宽/擦除）被拒：allowed 只减、denied 只增、limits 只降');
      }
    }
  }

  function commitBatch(sessionId, batchId, batch) {
    const file = batchFile(sessionId, batchId);
    const expected = revOf(batch);
    if (typeof revRaceHook === 'function') {
      //   否则观测不到「对手刚提交」这一时序（构造无效）。缝自身抛错**不阻断**写路径。
      try { revRaceHook({ sessionId, batchId, file, expected }); } catch {  }
    }
    const actual = diskRevOf(file, batchId);
    if (actual !== expected) throw batchVersionConflictOf(batchId, expected, actual);
    assertWavePlanImmutable(sessionId, batchId, batch);
    //   位置纪律同 IMM（三条缺一不可）：CAS 之后（冲突零副作用）／`stampGateLaneSnapshot` 之前／
    assertHandoffsIntegrity(sessionId, batchId, batch);
    assertBatchWriteAllowed(sessionId, batchId, batch, { action: 'commit' });
    stampGateLaneSnapshot(batch);
    // 回写**先于**落盘（契约 ③）：即便 `atomicWrite` 抛（重试耗尽 / 不可重试码），调用方对象已带新 rev
    batch[BATCH_REV_KEY] = actual + 1;
    atomicWrite(batchFile(sessionId, batchId), batch);
  }
  // 【B-05】实例级 dispose（幂等）：摘掉本实例在 governance 模块级刷盘表里的全部条目，并在**最后**一个
  //   实例退出时清掉进程级刷盘定时器。供装配层 `releaseAll` 在「已尽力落盘」之后调用 ——
  //   热重载后旧实例不再被模块表/定时器持有，也不再向旧 root 落盘（否则 = 数据双写 + 实例不可回收）。
  //   新增键：不改 composeStore 既有键集（契约 §与消费方（宿主）的契约面）。
  let disposed = false;
  const store = composeStore(cx);
  store.dispose = () => {
    if (disposed) return false;
    disposed = true;
    if (typeof cx.disposeGovernance === 'function') cx.disposeGovernance();
    return true;
  };
  return store;
}
