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

const STORE_SCHEMA = BATCH_SCHEMA_V3;


import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../../schema.js';
import { BATCH_SCHEMA_V3, migrateV2toV3, chainsDefaults, conditionDefaults, handoffsDefaults } from '../schema-v3.js';
import { laneProgressWrite } from '../resume.js';
import { isAbsPath } from '../constants.js';
import * as EVT from '../event-types.js';
import { resolveWriteTargetIn } from '../batch-paths.js';

/** `asset_claim` 的 rev 冲突重试上限（**有界**；仅对 `BATCH_VERSION_CONFLICT` 重试，其它错误立即上抛）。 */
const REV_RETRY_MAX = 3;

export function buildBatch(cx) {
  const { batchFile, artifactsDirOf, corruptRegistry, log, commitBatch, newEvent, emitStateChange } = cx;


  function createBatch(sessionId, { batchId, wavePlan, concurrency = 5, phase = 'planning', assembly, channel }) {
    //   本函数**只落盘**归一化结果，不做任何判定（单点判定 = `lib/wave-plan.ts#normalizeChannelDecl`，
    //   由建批路径 `lib/tools/core.js` 在 `createBatch` 之前调用并 throw）。
    schema.assertBatchPhase(phase);
    const file = batchFile(sessionId, batchId);
    if (fs.existsSync(file)) throw new Error('batch already exists: ' + batchId);
    const lanes = {};
    for (const w of wavePlan.wavePlan) {
      for (const t of w.tasks) lanes[t.id] = 'pending';
    }
    const team = wavePlan.team;
    const batch = {
      schema: STORE_SCHEMA,
      sessionId,
      batchId,
      phase,
      concurrency,
      team,
      wavePlan: wavePlan.wavePlan,
      lanes,
      chains: chainsDefaults(),
      handoffs: handoffsDefaults(),
      archived: false,
      ...(assembly !== undefined ? { assembly } : {}),
      ...(channel !== undefined ? { channel } : {}),
      events: [
        newEvent(EVT.EVT_BATCH_CREATED, { batchId, sessionId }),
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    for (const w of batch.wavePlan ?? []) {
      for (const t of w.tasks ?? []) {
        if (!t || typeof t.id !== 'string') continue;
        const deps = Array.isArray(t.deps) ? t.deps.filter((d) => typeof d === 'string' && d.length > 0) : [];
        if (deps.length === 0) continue;
        const list = [];
        for (const from of deps) {
          list.push({
            from, to: t.id, batch: batchId, step: null,
            artifacts: [], contract: { consumedFrom: from, assertions: [] },
            status: 'pending', ts: batch.createdAt, officialTaskId: null,
          });
        }
        batch.handoffs[t.id] = list;
      }
    }
    commitBatch(sessionId, batchId, batch);
    return batch;
  }

  function readBatchResult(sessionId, batchId) {
    const file = batchFile(sessionId, batchId);
    if (!fs.existsSync(file)) return { status: 'missing' };
    try {
      return { status: 'ok', batch: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      return { status: 'corrupt', error: err };
    }
  }

  function readBatch(sessionId, batchId) {
    const res = readBatchResult(sessionId, batchId);
    if (res.status === 'corrupt') {
      const r = corruptRegistry.markBatchCorrupt(sessionId, batchId, res.error);
      if (r.first) {
        log.warn?.('[dsh-punky-swarm] corrupt batch isolated: ' + sessionId + '/' + batchId
          + ' (' + ((res.error && res.error.message) || res.error) + ')；已登记 corrupt-batches.json，'
          + '修复/删除文件后经 clearCorruptMark 清除标记');
      }
      return null;
    }
    return res.batch;
  }

  function isCorrupt(sessionId, batchId) {
    return corruptRegistry.isCorrupt(sessionId, batchId);
  }

  function markManagerRaised(sessionId, batchId, payload = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const agentId = typeof payload.agentId === 'string' ? payload.agentId.trim() : '';
    if (!agentId) return null;
    // 【字段命名（禁改）】**不得**叫 `builtinRoster` / `engineRoster`：仓内「内建 roster」已有所指
    //   = `lib/roster.js#BUILTIN_ROLES` 那张**静态职位名表**（本仓认为该有哪些席位），
    //   与本表的**席位登记**（谁真的在座）**不同源、不同写入者、不同生命周期**——
    //   前者是常量、零写入；后者由本函数写、随批落盘。同名字段会让读端把两者当一件事。
    const sameSeat = Boolean(batch.managerSeat) && batch.managerSeat.seatId === agentId;
    const sameLegacy = Boolean(batch.manager) && batch.manager.agentId === agentId;
    if (sameSeat && sameLegacy) return batch.manager;
    const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : undefined;
    const at = new Date().toISOString();
    batch.managerSeat = { seatId: agentId, role: 'manager', source: 'engine-registry', registeredAt: at, registeredBy: 'batch_phase' };
    if (!sameLegacy) batch.manager = note ? { agentId, raisedAt: at, note } : { agentId, raisedAt: at };
    batch.events.push(newEvent(EVT.EVT_BATCH_MANAGER_RAISED, note ? { agentId, note } : { agentId }));
    batch.updatedAt = at;
    commitBatch(sessionId, batchId, batch);
    emitStateChange({ type: EVT.EVT_BATCH_MANAGER_RAISED, sessionId, batchId, agentId });
    return batch.manager;
  }

  function appendEvent(sessionId, batchId, type, fields = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    batch.events.push(newEvent(type, fields));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    return batch;
  }

  function readChains(sessionId, batchId) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) return null;
    return migrateV2toV3(batch).chains ?? chainsDefaults();
  }
  function updateChains(sessionId, batchId, patch) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = migrateV2toV3(batch);
    next.chains = patch ?? chainsDefaults();
    next.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, next);
    return next.chains;
  }

  function updateLaneProgress(sessionId, batchId, lane, progress) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = laneProgressWrite(batch, lane, progress);
    next.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, next);
    return next;
  }

  function claimAsset(sessionId, batchId, { source, target }) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (typeof target !== 'string' || !target.length) throw new Error('invalid target path: ' + target + ' (must be batch-relative)');
    if (isAbsPath(target) || /^[A-Za-z]:/.test(target)) throw new Error('invalid target path: ' + target + ' (must be batch-relative, no absolute path)');
    const segments = target.split(/[\\/]+/);
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error('invalid target path: ' + target + ' (must be batch-relative, no .. or empty segment)');
    }
    let st;
    try { st = fs.statSync(source); } catch { throw new Error('source not found: ' + source); }
    if (!st.isFile()) throw new Error('source is not a file: ' + source);
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    const dest = resolveWriteTargetIn(artifactsDir, path.join(artifactsDir, ...segments));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 【F2-G10 · TOCTOU-RESIDUAL】判据 → `copyFileSync` 之间仍有窗口。本**复判**消除下面这一**具体**路径：
    //   首判时中间段尚不存在（由本次 `mkdirSync` 创建）⇒ 复判时它已存在 ⇒ `nearestExistingAncestorOf`
    //   取到它 ⇒ `realpathSync` 暴露「刚创建就被换成 junction/软链」。窗口因此从「首判 → copy 全程
    //   （含 mkdir 的 I/O）」收窄到「复判 → copyFileSync」之间的**一次 syscall 间隙**。
    //   残余（**未闭合，勿表述为已闭合**）：该间隙内祖先被替换仍可把写入重定向到根外；彻底闭合需
    //   `openat`/`O_NOFOLLOW` 语义（Node 跨平台不可用）或文件锁（K-1 已否决）。
    //   威胁模型：与引擎同用户、能建 junction/symlink 的本地进程 —— 此类主体已具备与引擎**相同的写权限**
    //   ⇒ **不构成提权**；本判据保证的是「引擎不把写入送到根外」，不承诺对同权限竞争者的物理隔离。
    resolveWriteTargetIn(artifactsDir, dest);
    fs.copyFileSync(source, dest);
    let attempt = 1;
    for (;;) {
      const cur = attempt === 1 ? batch : readBatch(sessionId, batchId);
      if (!cur) throw new Error('batch not found: ' + batchId);
      cur.events.push(newEvent(EVT.EVT_ASSET_CLAIMED, { lane: null, source, target }));
      cur.updatedAt = new Date().toISOString();
      try {
        commitBatch(sessionId, batchId, cur);
        break;
      } catch (err) {
        if (!(err && err.code === 'BATCH_VERSION_CONFLICT') || attempt >= REV_RETRY_MAX) throw err;
        attempt += 1;
      }
    }
    return { ok: true, claimedPath: target, batchId };
  }

  function batchSettled(batch) {
    const lanes = Object.values(batch.lanes ?? {});
    return batch.phase === 'running' && lanes.length > 0 && lanes.every(schema.isMemberTerminal);
  }

  function batchAutoReleaseable(batch) {
    const lanes = Object.values(batch.lanes ?? {});
    if (!batch || lanes.length === 0) return false;
    return batch.phase === 'running' && lanes.every((s) => s === 'merged');
  }

  return { createBatch, readBatchResult, readBatch, isCorrupt, markManagerRaised, appendEvent, readChains, updateChains, updateLaneProgress, claimAsset, batchSettled, batchAutoReleaseable };
}
