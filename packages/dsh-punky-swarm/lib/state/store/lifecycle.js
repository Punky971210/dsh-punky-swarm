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
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) {
        const batch = readBatch(sessionId, batchId);
        if (!batch) {
          if (isCorrupt(sessionId, batchId)) corrupt.push(sessionId + '/' + batchId);
          continue;
        }
        if (schema.isBatchTerminal(batch.phase)) continue;
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
            try { fs.rmSync(path.join(sessionsDir, sessionId, '.locks', batchId + '.' + lane + '.lock'), { force: true }); } catch { }
          }
          batch.events.push(newEvent(EVT.EVT_SYSTEM_RECOVERED, { batchId, sessionId, recoveredLanes, detail }));
          batch.updatedAt = new Date().toISOString();
          commitBatch(sessionId, batchId, batch);
          recovered.push(sessionId + '/' + batchId);
        }
      }
    }
    recovered.corrupt = corrupt;
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

  return { listBatches, listSessions, listAllBatches, lastActiveAtOf, producedOf, recoverBatches, recycleStalledLane };
}
