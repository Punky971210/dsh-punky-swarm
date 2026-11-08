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


import * as schema from '../../schema.js';
import * as machine from '../machine.js';
import * as EVT from '../event-types.js';
import { laneProgressClear } from '../resume.js';
import { EXEMPT_GATE_CODES, normalizeExemptPayload } from '../lane-exempt.js';
import { countConsecutiveFailedSettles } from './events.js';
const EVT_LANE_EXEMPT_INHERITED = EVT.EVT_LANE_EXEMPT_INHERITED;

export function buildMember(cx) {
  const { gates, readBatch, newEvent, commitBatch, appendGatePayloadEvents, runMergedGateChain, laneExemptClear, applyLaneExemptOnDispatch, makeContractMissingSink, conditionFileExists, emitStateChange, escalatePausedWrite, ratchet } = cx;

  function setMember(sessionId, batchId, lane, to, note = null, exempt = undefined, owner = undefined) {
    let batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); member transition rejected');
    }
    schema.assertMemberState(to);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    if (exempt !== undefined && to !== 'running') {
      throw new Error(EXEMPT_GATE_CODES.NOT_DISPATCH
        + ': exempt 仅允许出现在派发面（to=running），当前 to=' + to + '（豁免只能在派发时附带授予）');
    }
    const from = batch.lanes[lane];
    const SETTLE_NOTE_REQUIRED = ['failed', 'skipped', 'conflict'];
    if (from === 'review' && SETTLE_NOTE_REQUIRED.includes(to)) {
      const reason = typeof note === 'string' ? note.trim() : '';
      if (reason.length === 0) {
        throw new Error('GATE_SETTLE_NOTE_MISSING: review -> ' + to + ' 必须携带非空 note（失败/跳过/冲突的理由，供审计复盘）；'
          + '实测 note=' + JSON.stringify(note ?? null) + ' ⇒ 拒结算（零写入）。'
          + '注：`merged` 不受本要求约束（其已由 Exit/Targets/Command/needHuman 四门把关）。');
      }
    }
    let exemptGrant = null;
    const gatePayloads = [];
    const collect = (kind, res) => { if (res) gatePayloads.push({ kind, res }); };
    const emitContractMissing = makeContractMissingSink(() => batch, () => lane);
    const mv = machine.applyMemberTransition(from, to, { rules: ratchet });
    const d4Hint = (from === 'running' && (to === 'merged' || to === 'skipped'))
      ? ' ⇒ 下一步：先 `member_set_status({ batchId, lane, status: "review" })` 置 review，再 `member_settle({ batchId, lane, status: "' + to + '" })`'
        + '（`running -> ' + to + '` 不在迁移表内；review 为合并/跳过的唯一中转）'
      : '';
    if (!mv.ok) throw new Error('invalid member transition: ' + from + ' -> ' + to + d4Hint);
    if (to === 'running') {
      const cond = machine.checkDispatchCondition(sessionId, batchId, batch, lane, { fileExists: conditionFileExists(sessionId, batchId) });
      if (!cond.ok) {
        const skip = machine.applyMemberTransition(from, 'skipped', { rules: ratchet });
        if (!skip.ok) {
          throw new Error('invalid member transition: ' + from + ' -> skipped (condition unmet: ' + cond.missing.join(', ') + '; ratchet forbids auto-skip)');
        }
        batch = laneProgressClear(batch, lane);
        batch.lanes[lane] = 'skipped';
        batch.events.push(newEvent(EVT.EVT_LANE_SKIPPED, { lane, from, note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.events.push(newEvent(EVT.EVT_MEMBER_SETTLED, { lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
        emitStateChange({ type: 'member.settled', sessionId, batchId, lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') });
        return batch;
      }
      const g = gates.checkEntryGate(sessionId, batchId, batch, lane);
      if (g.ok) collect('escape', g);
      emitContractMissing(g);
      if (!g.ok) {
        const detail = (g.missing && g.missing.length) ? g.missing : (g.problems ?? []);
        if (g.code === 'GATE_HANDOFF_MISSING') {
          batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, { lane, code: g.code, missing: g.missing ?? [], ...(g.problems ? { problems: g.problems } : {}) }));
        } else {
          batch.events.push(newEvent(EVT.EVT_GATE_ENTRY_MISSING, { lane, missing: g.missing ?? [], ...(g.problems ? { problems: g.problems } : {}) }));
        }
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
        throw new Error(g.code + (detail.length ? ': ' + detail.join(', ') : ''));
      }
      if (g.handoffLegacy === true) {
        batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, {
          lane, code: 'GATE_HANDOFF_LEGACY_PASSTHROUGH', legacy: true, missing: [],
          problems: ['本批无 `batch.handoffs` 字段（存量批）⇒ 未交接门整体放行；本 lane 开工**未**受交接约束（裁决 ①=B：不静默、不砸存量）'],
        }));
      }
      if (exempt != null) {
        exemptGrant = normalizeExemptPayload(exempt);
      }
    }
    if (to === 'review') {
      const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, null);
      collect('escape', nh);
      emitContractMissing(nh);
      if (nh.declared) batch.events.push(newEvent(EVT.EVT_LANE_NEEDHUMAN, { lane, path: nh.path }));
    }

    if (to === 'merged') {
      runMergedGateChain(batch, { sessionId, batchId, lane, note, collect, emitContractMissing });
    }

    if (schema.isMemberTerminal(to)) {
      batch = laneProgressClear(batch, lane);
      batch = laneExemptClear(batch, lane);
    }
    batch.lanes[lane] = to;
    if (to === 'running' && typeof owner === 'string' && owner.length > 0) {
      const wp = Array.isArray(batch.wavePlan) ? batch.wavePlan : [];
      for (let wi = 0; wi < wp.length; wi++) {
        const tasks = wp[wi]?.tasks;
        if (!Array.isArray(tasks)) continue;
        const ti = tasks.findIndex((x) => x && x.id === lane);
        if (ti < 0) continue;
        if (typeof tasks[ti].owner === 'string' && tasks[ti].owner.length > 0) break;
        batch.wavePlan = wp.map((w, i) => (i !== wi ? w : {
          ...w,
          tasks: w.tasks.map((t, j) => (j !== ti ? t : { ...t, owner })),
        }));
        batch.events.push(newEvent(EVT.EVT_TASK_OWNER_ASSIGNED, { lane, owner, from }));
        break;
      }
    }

    batch = applyLaneExemptOnDispatch(batch, { lane, from, to, exemptGrant });

    appendGatePayloadEvents(newEvent, batch, gatePayloads, lane);

    batch.events.push(newEvent(EVT.EVT_MEMBER_SETTLED, { lane, from, to, note: note ?? null }));
    let escalated = false;
    if (to === 'failed' && batch.phase === 'running') {
      const streak = countConsecutiveFailedSettles(batch.events);
      if (streak >= 3) {
        const bv = machine.applyBatchTransition('running', 'paused', { rules: ratchet });
        if (bv.ok) {
          escalatePausedWrite(batch, {
            reason: 'failed-escalate',
            eventType: EVT.EVT_BATCH_FAILED_ESCALATE,
            fields: { lane, count: streak },
          });
          escalated = true;
        }
      }
    }
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    emitStateChange({ type: 'member.settled', sessionId, batchId, lane, from, to, note: note ?? null });
    if (escalated) {
      emitStateChange({ type: 'batch.phase', sessionId, batchId, from: 'running', to: 'paused', reason: 'failed-escalate' });
    }
    return batch;
  }

  return { setMember };
}
