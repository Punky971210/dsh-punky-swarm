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


import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../../schema.js';
import * as machine from '../machine.js';
import * as EVT from '../event-types.js';
import { SESSION_RE } from '../constants.js';
import { countGovernanceRefusals, DEFAULT_ESCALATION_PRIMITIVES } from '../../governance/escalation.js';

const EXEC_FLUSH_EVERY = envPositiveInt('PUNKY_GOV_EXEC_FLUSH_EVERY', 10);
const EXEC_FLUSH_INTERVAL_MS = envPositiveInt('PUNKY_GOV_EXEC_FLUSH_INTERVAL_MS', 30 * 1000);

function envPositiveInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const GOV_HISTORY_MAX = envPositiveInt('PUNKY_GOV_HISTORY_MAX', 100);

let govStoreSeq = 0;
const govPending = new Map();
const govSnapshot = new Map();
const govFlushers = new Map();
let govFlushTimer = null;
let govExitBound = false;
// 【B-05】存活实例前缀集合：定时器是**进程级唯一**的，而实例归属是 `govKeyPrefix`。
//   只有集合清空（最后一个实例也 dispose）才允许清定时器 —— 否则会误杀同进程新实例的定时器。
const govLivePrefixes = new Set();

// ── 【N-03】落盘失败 / 读档损坏的**显式信号面**（判据 RQ-11：不得 `catch {}` 后当成成功）──
//   原实现两处吞错（`flushDirtyGovernance` 的 `catch {}`、定时器的 `catch {}`）与读坏回落
//   （`readGovernanceDisk` 的 `catch { return govDefaults() }`）把失败变成**零信息**：工具回成功、
//   盘上没数据、日志无痕。本改**只加信号**、不改行为（pending 仍保留待重试 / 读坏仍回默认），
//   并留只读投影 `governanceFlushStatus()` 供探针与诊断面消费。
const govSignals = { flushAttempts: 0, flushFailures: 0, corruptReads: 0, lastError: null, lastAt: null };
const govCorruptNoted = new Set();
let govWarn = (m) => { if (typeof console?.warn === 'function') console.warn('[dsh-punky-swarm] ' + m); };

/** 注入告警通道（装配期由 `buildGovernance` 接到 store 的 logger；未注入时走 `console.warn`）。 */
export function setGovernanceWarn(fn) { if (typeof fn === 'function') govWarn = fn; }

/** 只读信号投影：`{flushAttempts, flushFailures, corruptReads, lastError, lastAt}`。 */
export function governanceFlushStatus() { return { ...govSignals }; }

function noteGovernanceSignal(kind, error, detail = '') {
  govSignals.lastError = String((error && error.message) || error);
  govSignals.lastAt = new Date().toISOString();
  govWarn(kind + (detail ? '（' + detail + '）' : '') + '：' + govSignals.lastError);
}

export function flushDirtyGovernance() {
  for (const flush of [...govFlushers.values()]) {
    govSignals.flushAttempts += 1;
    try { flush(); } catch (error) {
      govSignals.flushFailures += 1;
      noteGovernanceSignal('governance 刷盘失败，pending 保留待下次重试', error);
    }
  }
  return governanceFlushStatus();
}

function bindExecFlushHooks() {
  if (!govExitBound) {
    govExitBound = true;
    process.once('exit', () => { flushDirtyGovernance(); });
  }
  if (govFlushTimer) return;
  govFlushTimer = setInterval(() => {
    try { flushDirtyGovernance(); } catch (error) {
      govSignals.flushFailures += 1;
      noteGovernanceSignal('governance 定时刷盘异常', error);
    }
  }, EXEC_FLUSH_INTERVAL_MS);
  govFlushTimer.unref?.();
}

export function buildGovernance(cx) {
  const { readBatch, newEvent, commitBatch, escalatePausedWrite, emitStateChange, ratchet, sessionDir, atomicWrite, listBatches } = cx;

  // 【N-03】把 store 的 logger 接到告警通道（`createStore` 的 `log = logger ?? console`）：
  //   生产宿主走宿主 logger（可被审计面收走），探针/测试未注入时回落 `console.warn`。
  if (typeof cx.log?.warn === 'function') setGovernanceWarn((m) => cx.log.warn('[dsh-punky-swarm] ' + m));

  function recordGovernanceRefusal(sessionId, batchId, { lane, receiptId, primitive, ruleRefs, tool, escalation = {} } = {}) {
    if (escalation.enabled !== true) return null;
    if (!Array.isArray(ruleRefs) || ruleRefs.length === 0) return null;
    const primSet = new Set(escalation.primitives ?? DEFAULT_ESCALATION_PRIMITIVES);
    if (!primSet.has(primitive)) return null;
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    batch.events.push(newEvent(EVT.EVT_GOVERNANCE_REFUSAL, { lane, receiptId, primitive, ruleRefs, tool }));
    let escalated = false;
    if (batch.phase === 'running') {
      const now = Date.now();
      const count = countGovernanceRefusals(batch.events, {
        windowMs: escalation.windowMs,
        primitives: escalation.primitives,
        now,
      });
      if (count >= (escalation.threshold ?? 3)) {
        const bv = machine.applyBatchTransition('running', 'paused', { rules: ratchet });
        if (bv.ok) {
          const receiptIds = [];
          for (const e of batch.events) {
            if (!e || e.type !== EVT.EVT_GOVERNANCE_REFUSAL) continue;
            if (e.receiptId === undefined || e.receiptId === null) continue;
            const tsMs = typeof e.ts === 'number' ? e.ts : Date.parse(String(e.ts ?? ''));
            if (Number.isNaN(tsMs)) continue;
            if (now - tsMs > escalation.windowMs) continue;
            receiptIds.push(e.receiptId);
          }
          escalatePausedWrite(batch, {
            reason: 'governance-escalate',
            eventType: EVT.EVT_BATCH_GOVERNANCE_ESCALATE,
            fields: { count, windowMs: escalation.windowMs, lane, receiptIds },
          });
          escalated = true;
        }
      }
    }
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    if (escalated) {
      emitStateChange({ type: 'batch.phase', sessionId, batchId, from: 'running', to: 'paused', reason: 'governance-escalate' });
    }
    return batch;
  }

  const GOV_SCHEMA = 2;
  function govDefaults() {
    return { schema: GOV_SCHEMA, execToolCount: 0, pendingBatch: false, pendingSince: null, lastAssign: null, history: [] };
  }
  function governanceFile(sessionId) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionDir(sessionId), 'governance.json');
  }
  const govKeyPrefix = 'gov#' + (++govStoreSeq) + '|';
  const govKeyOf = (sessionId) => govKeyPrefix + governanceFile(sessionId);
  // 【B-05】登记本实例存活（装配点）；与下方 disposeGovernance 的摘除配对。
  govLivePrefixes.add(govKeyPrefix);

  function mergeExecPending(base, pend) {
    const next = { ...base };
    if (!pend) return next;
    next.execToolCount = (base.execToolCount ?? 0) + pend.count;
    if (next.lastAssign) {
      next.lastAssign = { ...next.lastAssign, execCallsSince: (next.lastAssign.execCallsSince ?? 0) + pend.callsSince };
    }
    return next;
  }
  function boundHistory(g) {
    const hist = Array.isArray(g?.history) ? g.history : [];
    const droppedNow = hist.length - GOV_HISTORY_MAX;
    if (droppedNow <= 0) return g;
    const kept = hist.slice(-GOV_HISTORY_MAX);
    const prev = g.historyTruncated ?? null;
    return {
      ...g,
      history: kept,
      historyTruncated: {
        dropped: (prev?.dropped ?? 0) + droppedNow,
        since: kept[0]?.at ?? prev?.since ?? null,
      },
    };
  }
  function readGovernanceBounded(sessionId) { return boundHistory(readGovernanceDisk(sessionId)); }

  function readGovernanceDisk(sessionId) {
    const file = governanceFile(sessionId);
    if (!fs.existsSync(file)) return govDefaults();
    try { return { ...govDefaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (error) {
      //   【N-03】读坏不再「零信号回落默认」：回落行为保留（一个坏档不该打挂整条链），但必须留痕。
      //   去噪：每个文件每进程只报一行（该函数在热路径上，逐次报会刷屏）；文件名用 basename，
      //   不外泄绝对路径（错误信息泄露面见 exec/data-plane/report.md L-05）。
      govSignals.corruptReads += 1;
      if (!govCorruptNoted.has(file)) {
        govCorruptNoted.add(file);
        noteGovernanceSignal('governance.json 读坏，已按默认值继续（可能丢 lastAssign/pendingBatch/mirror）', error, path.basename(file));
      }
      return govDefaults();
    }
  }
  function readGovernance(sessionId) {
    const disk = readGovernanceBounded(sessionId);
    const key = govKeyOf(sessionId);
    govSnapshot.set(key, disk);
    return mergeExecPending(disk, govPending.get(key));
  }
  function writeGovernance(sessionId, patch) {
    const key = govKeyOf(sessionId);
    const next = boundHistory({ ...readGovernance(sessionId), ...patch });
    atomicWrite(governanceFile(sessionId), next);
    govPending.delete(key);
    govFlushers.delete(key);
    govSnapshot.set(key, next);
    return next;
  }
  function flushExecCount(sessionId) {
    const key = govKeyOf(sessionId);
    const pend = govPending.get(key);
    if (!pend) return false;
    const next = boundHistory(mergeExecPending(readGovernanceBounded(sessionId), pend));
    atomicWrite(governanceFile(sessionId), next);
    govPending.delete(key);
    govFlushers.delete(key);
    govSnapshot.set(key, next);
    return true;
  }
  function seedExecSnapshot(sessionId, key) {
    const boundedDisk = readGovernanceBounded(sessionId);
    govSnapshot.set(key, boundedDisk);
    return boundedDisk;
  }
  function bumpExecCount(sessionId) {
    const key = govKeyOf(sessionId);
    let pend = govPending.get(key);
    if (!pend) { pend = { count: 0, callsSince: 0, since: Date.now() }; govPending.set(key, pend); }
    pend.count += 1;
    pend.callsSince += 1;
    if (!govFlushers.has(key)) govFlushers.set(key, () => { flushExecCount(sessionId); });
    bindExecFlushHooks();
    if (pend.count >= EXEC_FLUSH_EVERY || Date.now() - pend.since >= EXEC_FLUSH_INTERVAL_MS) {
      flushExecCount(sessionId);
    }
    const base = govSnapshot.get(key) ?? seedExecSnapshot(sessionId, key);
    return mergeExecPending(base, govPending.get(key));
  }
  function stale(sessionId, { maxAgeMs = 30 * 60 * 1000 } = {}) {
    const g = readGovernance(sessionId);
    if (!g.lastAssign) return true;
    const at = Date.parse(g.lastAssign.at);
    if (!Number.isFinite(at)) return true;
    return Date.now() - at >= maxAgeMs;
  }
  function hasActiveBatch(sessionId) {
    return listBatches(sessionId).some((id) => {
      const b = readBatch(sessionId, id);
      return b && !schema.isBatchTerminal(b.phase);
    });
  }

  /**
   * 【B-05】实例级 dispose（幂等）：按本实例 `govKeyPrefix` 前缀从三张模块级表里摘掉**本实例**的全部条目，
   *   并从存活集合移除；**仅当存活集合为空**才 `clearInterval` 并置 `govFlushTimer = null`。
   *
   * 为什么必须先「尽力落盘」再调本函数（调用方 = `lib/index.js` 的 `releaseAll`）：前缀删表会连
   *   本实例的 `govPending`（未落盘增量）一起摘掉 —— 顺序颠倒就是**静默丢数据**。
   * 为什么只删本实例前缀：同进程可能并存多个 store（热重载交替期 / 双装配），全局清表会把**新实例**的
   *   未落盘增量一起丢掉（契约 §语义口径冻结 B-05 明禁）。
   * 定时器代际：全空后置 `null` ⇒ 新实例再次 `bumpExecCount` 时由 `bindExecFlushHooks` 重建，
   *   旧定时器不会与新实例共用；`process.once('exit')` 绑定保持进程级唯一（`govExitBound` 不动）。
   */
  let govDisposed = false;
  function disposeGovernance() {
    if (govDisposed) return false;
    govDisposed = true;
    for (const table of [govPending, govSnapshot, govFlushers]) {
      for (const key of [...table.keys()]) {
        if (key.startsWith(govKeyPrefix)) table.delete(key);
      }
    }
    govLivePrefixes.delete(govKeyPrefix);
    if (govLivePrefixes.size === 0 && govFlushTimer) {
      clearInterval(govFlushTimer);
      govFlushTimer = null;
    }
    return true;
  }

  return { recordGovernanceRefusal, govDefaults, governanceFile, readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, disposeGovernance };
}
