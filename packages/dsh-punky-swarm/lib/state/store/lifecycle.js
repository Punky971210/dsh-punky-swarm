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
import { findTask } from '../task-utils.js';
import { SESSION_RE } from '../constants.js';
import { resolveArtifactIn } from '../batch-paths.js';
import * as EVT from '../event-types.js';

function laneIdleOnRecovery(batch, lane) {
  const from = batch?.lanes?.[lane];
  if (!schema.RECOVERY_IDLE_FROM.includes(from)) {
    throw new Error('recovery idle edge not declared: ' + from + ' -> idle (lane ' + lane + ')');
  }
  batch.lanes[lane] = 'idle';
  return from;
}

export function buildLifecycle(cx) {
  const { sessionsDir, batchesDirOf, readBatch, isCorrupt, newEvent, commitBatch, artifactsDirOf, log } = cx;

  function listBatches(sessionId) {
    const dir = batchesDirOf(sessionId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  function listSessions() {
    if (!fs.existsSync(sessionsDir)) return [];
    return fs.readdirSync(sessionsDir)
      .filter((s) => SESSION_RE.test(s) && fs.existsSync(batchesDirOf(s)) && fs.readdirSync(batchesDirOf(s)).some((f) => f.endsWith('.json')))
      .sort();
  }

  function lastActiveAtOf(batch, lane) {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].lane === lane && evs[i].ts) return evs[i].ts;
    }
    return batch.updatedAt;
  }
  function producedOf(sessionId, batchId, batch, lane) {
    const t = findTask(batch, lane);
    if (!t) return [];
    const field = t.layer === 'exec' ? 'outputs' : (t.layer === 'plan' || t.layer === 'audit' ? 'produce' : null);
    if (!field || !Array.isArray(t[field])) return [];
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    const existsNonEmpty = (p) => {
      try {
        const st = fs.statSync(resolveArtifactIn(artifactsDir, p));
        return st.isDirectory() || st.size > 0;
      } catch { return false; }
    };
    return t[field].filter(existsNonEmpty);
  }

  function recoverBatches() {
    const recovered = [];
    const corrupt = [];
    // B-02 逐批隔离的记账面：一条坏批（写盘失败 / 权限错）只跳过它自己并在此留痕，
    //   不得让整趟恢复中断——否则后续批次的成员态永久滞留 running/review。
    const unhandled = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) {
        const batch = readBatch(sessionId, batchId);
        if (!batch) {
          if (isCorrupt(sessionId, batchId)) corrupt.push(sessionId + '/' + batchId);
          continue;
        }
        if (schema.isBatchTerminal(batch.phase)) continue;
        // 单批处理体整体失败隔离（B-02）：commitBatch 抛错时盘上 JSON 保持原样
        //   ⇒ 坏批既不删也不改相位，仅「跳过 + 记账」，本趟继续扫后续批次。
        try {
          const recoveredLanes = [];
          const detail = [];
          for (const [lane, state] of Object.entries(batch.lanes)) {
            if (state === 'running' || state === 'review') {
              const from = laneIdleOnRecovery(batch, lane);
              recoveredLanes.push(lane);
              detail.push({ lane, from, lastActiveAt: lastActiveAtOf(batch, lane), produced: producedOf(sessionId, batchId, batch, lane), outcome: 'crashed' });
            }
          }
          if (recoveredLanes.length > 0) {
            for (const lane of recoveredLanes) {
              try {
                fs.rmSync(path.join(sessionsDir, sessionId, '.locks', batchId + '.' + lane + '.lock'), { force: true });
              } catch (e) {
                // 锁清退失败同样不得静默（原 `catch {}` 会把失败彻底吞掉）：
                //   只记账不抛——本批成员态仍按恢复处理，残留锁的收口属 B-03 的显式修复入口。
                unhandled.push({ sessionId, batchId, error: 'lock-remove: ' + String(e) });
              }
            }
            batch.events.push(newEvent(EVT.EVT_SYSTEM_RECOVERED, { batchId, sessionId, recoveredLanes, detail }));
            batch.updatedAt = new Date().toISOString();
            commitBatch(sessionId, batchId, batch);
            recovered.push(sessionId + '/' + batchId);
          }
        } catch (e) {
          unhandled.push({ sessionId, batchId, error: String(e) });
          continue;
        }
      }
    }
    recovered.corrupt = corrupt;
    recovered.unhandled = unhandled;
    if (corrupt.length) {
      log.warn?.('[dsh-punky-swarm] recovery skipped ' + corrupt.length + ' corrupt batch(es): ' + corrupt.join(', '));
    }
    return recovered;
  }

  function recycleStalledLane(sessionId, batchId, lane) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    if (batch.lanes[lane] !== 'running') throw new Error('lane not running: ' + lane + ' (state=' + batch.lanes[lane] + ')');
    const hasStalled = (batch.events ?? []).some((e) => e.type === EVT.EVT_LANE_STALLED && e.lane === lane);
    if (!hasStalled) throw new Error('no lane.stalled event for lane: ' + lane + ' (recycle requires stalled evidence)');
    laneIdleOnRecovery(batch, lane);
    batch.events.push(newEvent(EVT.EVT_LANE_RECYCLED, { lane, from: 'running', reason: 'stalled', outcome: 'interrupted', note: null }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    return { ok: true, lane, from: 'running', to: 'idle' };
  }

  function listAllBatches() {
    const all = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) all.push({ sessionId, batchId });
    }
    return all;
  }

  /**
   * 批次清单按**最近活跃**降序给出（可选截断）。读面专用，不参与任何写路径。
   *
   * 为什么用文件 mtime 而不是 `batch.updatedAt`：后者必须 `readBatch`（读全文 + JSON.parse）
   *   才知道——单批实测 ~1.73ms，511 批并集就是 770ms，**这正是本函数要治的开销**；
   *   而 mtime 一次 `statSync` 即得（同口径实测 ~0.1ms/批）。`commitBatch` 走原子写
   *   （临时文件 + rename），每次落盘必然刷新 mtime ⇒ 与「最近活跃」同向，不会漏更新。
   *
   * 语义边界（读面契约）：
   *   · `total` 恒为**裁剪前**候选总数 ⇒ 调用方能把「裁剪」与「真的只有这么多」区分开。
   *   · `limit` 非正整数（含 0 / 负数 / 小数）⇒ 不截断；`opts.sessionId` 给定时只扫该会话。
   *   · 排序键确定性：mtime 相同（同毫秒落盘）时按 `sessionId` 再按 `batchId` 升序
   *     ⇒ 同一盘面两次调用结果逐元素相等（可复算，便于断言与排障）。
   *   · `statSync` 失败（并发删除 / 权限）⇒ 该批 `lastWriteMs=0` 排末位且**不抛错**：
   *     读面不该因为一个坏批文件而整体失败（与 `readBatch` 返回 null 的宽容口径一致）。
   */
  function recentBatches(opts = {}) {
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 0;
    const roots = opts.sessionId ? [opts.sessionId] : listSessions();
    const all = [];
    for (const sessionId of roots) {
      const dir = batchesDirOf(sessionId);
      for (const batchId of listBatches(sessionId)) {
        let lastWriteMs = 0;
        try {
          lastWriteMs = fs.statSync(path.join(dir, batchId + '.json')).mtimeMs;
        } catch {
          lastWriteMs = 0;
        }
        all.push({ sessionId, batchId, lastWriteMs });
      }
    }
    all.sort((a, b) => (b.lastWriteMs - a.lastWriteMs)
      || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
      || (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0));
    return { total: all.length, items: limit > 0 ? all.slice(0, limit) : all };
  }

  return { listBatches, listSessions, listAllBatches, recentBatches, lastActiveAtOf, producedOf, recoverBatches, recycleStalledLane };
}
