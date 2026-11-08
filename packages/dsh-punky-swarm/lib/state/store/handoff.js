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


import * as EVT from '../event-types.js';
import * as schema from '../../schema.js';
import { laneHandoffGapPayload } from './events.js';
import { workerLanesOf } from '../dispatch-events.js';

/** 交接记录的**唯一形态**（建批播种 / 计划变更补种 / 收件补边三处写点共用）。
 *  基础 9 键固定；收件通道只多 `source` / `acceptedBy` 两个显式可选键。 */
export function pendingHandoffRecordOf({ from, to, batchId, ts, source = null, acceptedBy = null }) {
  const rec = {
    from, to, batch: batchId, step: null,
    artifacts: [], contract: { consumedFrom: from, assertions: [] },
    status: 'pending', ts, officialTaskId: null,
  };
  if (source !== null) rec.source = source;
  if (acceptedBy !== null) rec.acceptedBy = acceptedBy;
  return rec;
}

export function buildHandoff(cx) {
  const { readBatch, newEvent, commitBatch } = cx;

  const HANDOFF_MISSING = 'GATE_HANDOFF_MISSING';
  const HANDOFF_UNAUTHORIZED = 'GATE_HANDOFF_UNAUTHORIZED';
  const HANDOFF_IDENTITY_UNKNOWN = 'GATE_HANDOFF_IDENTITY_UNKNOWN';
  const HANDOFF_OVERWRITE_UNDECLARED = 'GATE_HANDOFF_OVERWRITE_UNDECLARED';
  function handoffAuthorityOf(batch, caller) {
    const raw = (caller && typeof caller === 'object') ? caller : {};
    const from = typeof raw.from === 'string' && raw.from ? raw.from : null;
    const callerSessionId = (() => {
      const sid = raw.sessionId !== undefined && raw.sessionId !== null ? raw.sessionId : raw.callerSessionId;
      return typeof sid === 'string' && sid.length ? sid : null;
    })();
    const rosterNames = Array.isArray(raw.rosterNames)
      ? raw.rosterNames.filter((n) => typeof n === 'string' && n.trim().length).map((n) => n.trim())
      : [];
    if (callerSessionId && callerSessionId === batch.sessionId) return { ok: true, role: 'owner' };
    if (callerSessionId && batch.manager && batch.manager.agentId === callerSessionId) return { ok: true, role: 'manager' };
    const dispatchLanes = workerLanesOf(batch, callerSessionId);
    if (dispatchLanes.length) {
      if (!from) return { ok: false, role: 'dispatch', allowedFrom: dispatchLanes };
      return dispatchLanes.includes(from) ? { ok: true, role: 'dispatch' } : { ok: false, role: 'dispatch', allowedFrom: dispatchLanes };
    }
    const rosterLanes = [];
    for (const w of batch.wavePlan ?? []) {
      for (const t of w?.tasks ?? []) {
        if (t && typeof t.id === 'string' && typeof t.roster === 'string' && t.roster && rosterNames.includes(t.roster)) {
          if (!rosterLanes.includes(t.id)) rosterLanes.push(t.id);
        }
      }
    }
    if (rosterLanes.length) {
      if (!from) return { ok: false, role: 'roster', allowedFrom: rosterLanes };
      return rosterLanes.includes(from) ? { ok: true, role: 'roster' } : { ok: false, role: 'roster', allowedFrom: rosterLanes };
    }
    return { ok: false, role: 'unresolved', allowedFrom: [], resolution: 'no-owner/manager/dispatch/roster match' };
  }
  function recordHandoff(sessionId, batchId, { from, to, artifacts, assertions, officialTaskId = null, overwrite = false, caller = null } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase
        + ' (terminal); handoff submit rejected（终态批不再接受交接提交）');
    }
    const fail = (problems, missing, { code = HANDOFF_MISSING, callerRole = null, write = true } = {}) => {
      const r = { ok: false, code, problems, missing };
      if (write) {
        batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, laneHandoffGapPayload({
          lane: to ?? null, code, callerRole, missing, problems,
        })));
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
      }
      return r;
    };
    const auth = handoffAuthorityOf(batch, caller ? { ...caller, from: from ?? caller.from ?? null } : null);
    if (!auth.ok) {
      if (auth.role === 'unresolved') {
        return fail(
          ['调用方身份不可解析（既非批 owner / 已登记 Manager，又无 member.dispatch 绑定、无 lane.roster 命中）⇒ fail-closed 拒（不猜、不静默）'],
          ['caller-identity'],
          { code: HANDOFF_IDENTITY_UNKNOWN, callerRole: 'unresolved', write: false },
        );
      }
      return fail(
        ['调用方（' + auth.role + '）对 lane "' + String(from ?? '') + '" 的出边无写权 ⇒ 越权写入被拒'],
        ['from:' + String(from ?? '')],
        { code: HANDOFF_UNAUTHORIZED, callerRole: auth.role, write: false },
      );
    }
    if (typeof from !== 'string' || !from.length) return fail(['handoff from 必填（上游 lane id）'], ['from']);
    if (typeof to !== 'string' || !to.length) return fail(['handoff to 必填（下游 lane id）'], ['to']);
    if (batch.handoffs == null || typeof batch.handoffs !== 'object' || Array.isArray(batch.handoffs)) {
      return fail(['本批无 `batch.handoffs`（存量批）⇒ 交接载体不存在，交接不予登记（新门只对新建批生效，裁决 ①=B）'], ['batch.handoffs']);
    }
    const list = Array.isArray(batch.handoffs[to]) ? batch.handoffs[to] : null;
    if (!list) return fail(['下游 lane ' + to + ' 无建批期交接声明（`deps` 入边未种条）⇒ 交接不成立'], ['edge:' + from + '->' + to]);
    const rec = list.find((r) => r && r.from === from) ?? null;
    if (!rec) return fail(['交接入边 ' + from + '->' + to + ' 不在建批期声明中（下游 deps 未含该上游）'], ['edge:' + from + '->' + to]);
    const arts = Array.isArray(artifacts) ? artifacts.filter((p) => typeof p === 'string' && p.trim().length > 0) : [];
    const asrt = Array.isArray(assertions) ? assertions.filter((a) => typeof a === 'string' && a.trim().length > 0) : [];
    const problems = [];
    const missing = [];
    if (arts.length === 0) { problems.push('artifacts 必填（至少一件上游交付产物）'); missing.push('artifacts'); }
    if (asrt.length === 0) { problems.push('contract.assertions 必填（至少一条下游可核断言）'); missing.push('contract.assertions'); }
    if (problems.length) return fail(problems, missing);
    const alreadySubmitted = rec.status === 'submitted';
    if (alreadySubmitted && overwrite !== true) {
      const existingAssertions = (rec.contract && Array.isArray(rec.contract.assertions)) ? rec.contract.assertions : [];
      const existingTs = rec.ts ?? null;
      const rejected = fail(
        ['入边 ' + from + '->' + to + ' 已 submitted ⇒ 重交须显式声明 overwrite:true（R-2 覆盖保护：禁静默覆盖）'],
        ['overwrite'],
        { code: HANDOFF_OVERWRITE_UNDECLARED, callerRole: auth.role, write: false },
      );
      return { ...rejected, existingAssertionsLength: existingAssertions.length, existingTs };
    }
    const prevArtifacts = Array.isArray(rec.artifacts) ? [...rec.artifacts] : [];
    const prevAssertions = (rec.contract && Array.isArray(rec.contract.assertions)) ? [...rec.contract.assertions] : [];
    if (alreadySubmitted) {
      const prev = {
        ts: rec.ts ?? null,
        artifacts: prevArtifacts,
        assertions: prevAssertions,
        officialTaskId: rec.officialTaskId ?? null,
      };
      rec.history = [...(Array.isArray(rec.history) ? rec.history : []), prev];
    }
    rec.artifacts = [...arts];
    rec.contract = { consumedFrom: from, assertions: [...asrt] };
    rec.status = 'submitted';
    rec.ts = new Date().toISOString();
    if (officialTaskId !== null && officialTaskId !== undefined) rec.officialTaskId = String(officialTaskId);
    batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF, {
      lane: to, from, to, artifacts: [...arts], assertions: [...asrt], handoffBatch: batchId,
      previousAssertions: [...prevAssertions],
      overwrite: alreadySubmitted,
      replaced: alreadySubmitted ? { artifacts: [...prevArtifacts], assertions: [...prevAssertions] } : null,
    }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    return {
      ok: true, code: null, from, to, artifacts: [...arts], assertions: [...asrt],
      overwrite: alreadySubmitted, previousAssertions: [...prevAssertions], record: { ...rec },
    };
  }

  return { recordHandoff };
}
