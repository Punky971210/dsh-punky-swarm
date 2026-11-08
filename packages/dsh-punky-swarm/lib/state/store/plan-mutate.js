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
import * as EVT from '../event-types.js';
import { buildWavePlan, LAYERS } from '../../wave-plan.js';
import { pendingHandoffRecordOf } from './handoff.js';

export function buildPlanMutate(cx) {
  const { readBatch, newEvent, commitBatch } = cx;

  function addPoolTasks(sessionId, batchId, incoming, { reason = null, author = null, handoffGate = undefined, hostRoster = [] } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId + ' @' + sessionId);
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); task append rejected');
    }
    const list = Array.isArray(incoming) ? incoming : [];
    if (list.length === 0) throw new Error('task append rejected: tasks 为空（须至少给出一条）');
    const existing = new Set(Object.keys(batch.lanes ?? {}));
    const ids = [];
    for (const t of list) {
      const id = t && typeof t.id === 'string' ? t.id.trim() : '';
      if (!id) throw new Error('task append rejected: 任务 id 须为非空字符串（实际=' + JSON.stringify(t?.id ?? null) + '）');
      if (existing.has(id)) throw new Error('task append rejected: 任务 id 已存在 ⇒ ' + id + '（本接口只增不改）');
      if (ids.includes(id)) throw new Error('task append rejected: 本次追加内 id 重复 ⇒ ' + id);
      ids.push(id);
    }
    const layerIdx = (v) => (v == null ? null : LAYERS.indexOf(String(v)));
    for (const t of list) {
      const id = String(t.id).trim();
      const deps = t && Array.isArray(t.deps) ? t.deps : [];
      const cur = layerIdx(t.layer ?? null);
      for (const d of deps) {
        if (typeof d !== 'string' || d.trim().length === 0) {
          throw new Error('task append rejected: deps 元素须为非空字符串（任务 ' + id + '）');
        }
        if (!existing.has(d)) {
          throw new Error('task append rejected: deps 只能指向批次内**既有**任务 ⇒ ' + d
            + '（不得指向本次新增的任务，亦不得自指；这是「不成环」的**结构性保证**，非断言检查）');
        }
        const up = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []))
          .find((x) => x && x.id === d);
        const upl = layerIdx(up?.layer ?? null);
        if (cur != null && upl != null && upl > cur) {
          throw new Error('task append rejected: deps 只许指向**同层或上游层** ⇒ 任务 ' + id
            + '（层 ' + String(t.layer) + '）不得依赖下游层 ' + d + '（层 ' + String(up?.layer) + '）');
        }
      }
    }
    const baseTasks = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    const merged = [...baseTasks, ...list.map((t) => ({ ...t, id: String(t.id).trim() }))];
    const plan = buildWavePlan({
      batchId, tasks: merged, team: batch.team, concurrency: batch.concurrency ?? 5,
      smoke: batch.smoke === true,
      ...(handoffGate === undefined ? {} : { handoffGate }),
      hostRoster: Array.isArray(hostRoster) ? hostRoster : [],
    });
    const lanes = { ...batch.lanes };
    const handoffs = { ...(batch.handoffs ?? {}) };
    const ts = new Date().toISOString();
    const declared = [];
    for (const t of list) {
      const id = String(t.id).trim();
      lanes[id] = 'pending';
      const deps = Array.isArray(t.deps) ? t.deps.filter((d) => typeof d === 'string' && d.length > 0) : [];
      if (deps.length === 0) continue;
      handoffs[id] = deps.map((from) => pendingHandoffRecordOf({ from, to: id, batchId, ts }));
      for (const from of deps) declared.push({ from, to: id });
    }
    const revision = (batch.planRevision ?? 0) + 1;
    const next = {
      ...batch,
      wavePlan: plan.wavePlan,
      lanes,
      handoffs,
      planRevision: revision,
      updatedAt: ts,
      events: [...(batch.events ?? []), newEvent(EVT.EVT_PLAN_MUTATED, {
        added: ids, declared, reason: reason ?? null, author: author ?? null, revision,
      })],
    };
    commitBatch(sessionId, batchId, next);
    return next;
  }

  function addTaskEdges(sessionId, batchId, edges, { reason = null, author = null, handoffGate = undefined, hostRoster = [] } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId + ' @' + sessionId);
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); task edge rejected');
    }
    const list = Array.isArray(edges) ? edges : [];
    if (list.length === 0) throw new Error('task edge rejected: edges 为空（须至少给出一条）');
    if (batch.handoffs === undefined || batch.handoffs === null) {
      throw new Error('task edge rejected: 该批为**存量形态**（无 `handoffs` 字段）⇒ 加边会改变交接门语义（legacy 放行 → 受门约束）'
        + ' ⇒ 拒；请在新建批（带交接面）上操作');
    }
    const baseTasks = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    const orderOf = new Map();
    const byId = new Map();
    baseTasks.forEach((t, i) => {
      if (t && typeof t.id === 'string' && t.id) { orderOf.set(t.id, i); byId.set(t.id, t); }
    });
    const lanes = batch.lanes ?? {};
    const layerIdx = (v) => (v == null ? null : LAYERS.indexOf(String(v)));
    const planEntries = [];
    for (const e of list) {
      const id = e && typeof e.id === 'string' ? e.id.trim() : '';
      if (!id) throw new Error('task edge rejected: 任务 id 须为非空字符串');
      const target = byId.get(id);
      if (!target) throw new Error('task edge rejected: 任务不存在 ⇒ ' + id + '（本接口只给**既有**任务加边）');
      const owner = typeof target.owner === 'string' && target.owner ? target.owner : null;
      const laneState = lanes[id] ?? null;
      if (owner !== null || (laneState !== null && laneState !== 'pending')) {
        throw new Error('task edge rejected: 任务 ' + id + ' 已出池（owner=' + String(owner)
          + ' lane=' + String(laneState) + '）⇒ **已派发即冻结**（K1：层内不重算 · 非改派）；'
          + '如需变更，走「作废 + 池内新增替代任务 + gap-list 留痕」');
      }
      const addRaw = Array.isArray(e.add) ? e.add : [];
      const existingDeps = Array.isArray(target.deps) ? target.deps.filter((d) => typeof d === 'string' && d) : [];
      const fresh = [];
      for (const d0 of addRaw) {
        if (typeof d0 !== 'string' || d0.trim().length === 0) {
          throw new Error('task edge rejected: add 元素须为非空字符串（任务 ' + id + '）');
        }
        const d = d0.trim();
        if (existingDeps.includes(d) || fresh.includes(d)) continue;
        if (d === id) throw new Error('task edge rejected: 任务 ' + id + ' 不得自指（deps 不得指向自身）');
        const up = byId.get(d);
        if (!up) throw new Error('task edge rejected: 上游任务不存在 ⇒ ' + d + '（加边只许指向批次内既有任务）');
        if (!(orderOf.get(d) < orderOf.get(id))) {
          throw new Error('task edge rejected: deps 只许指向**已声明在先**的任务 ⇒ ' + id + ' ← ' + d
            + '（这是「不成环」的**结构性保证**：依赖序严格前进，非成环断言）');
        }
        const cur = layerIdx(target.layer ?? null);
        const upl = layerIdx(up.layer ?? null);
        if (cur != null && upl != null && upl > cur) {
          throw new Error('task edge rejected: deps 只许指向**同层或上游层** ⇒ 任务 ' + id + '（层 ' + String(target.layer)
            + '）不得依赖下游层 ' + d + '（层 ' + String(up.layer) + '）');
        }
        if (schema.isMemberTerminal(lanes[d])) {
          throw new Error('task edge rejected: 上游 ' + d + ' 已结算（lane=' + String(lanes[d])
            + '）⇒ 该边**无交接可等**（终态 lane 无法再提交交接）⇒ 结构性无法满足。'
            + '若你只是需要其产物在场，请用 `consume` 声明；若确需等待交接，须在**建批期**声明该 deps');
        }
        fresh.push(d);
      }
      planEntries.push({ id, fresh });
    }
    if (planEntries.every((p) => p.fresh.length === 0)) {
      throw new Error('task edge rejected: 本次**零新增边**（全部已存在）⇒ 不落盘');
    }
    const merged = baseTasks.map((t) => {
      const hit = planEntries.find((p) => p.id === t.id);
      if (!hit || hit.fresh.length === 0) return t;
      const old = Array.isArray(t.deps) ? t.deps : [];
      return { ...t, deps: [...old, ...hit.fresh] };
    });
    const plan = buildWavePlan({
      batchId, tasks: merged, team: batch.team, concurrency: batch.concurrency ?? 5,
      smoke: batch.smoke === true,
      ...(handoffGate === undefined ? {} : { handoffGate }),
      hostRoster: Array.isArray(hostRoster) ? hostRoster : [],
    });
    const handoffs = { ...batch.handoffs };
    const ts = new Date().toISOString();
    const edgesLog = [];
    for (const p of planEntries) {
      if (p.fresh.length === 0) continue;
      const after = merged.find((t) => t.id === p.id);
      const deps = (Array.isArray(after?.deps) ? after.deps : []).filter((d) => typeof d === 'string' && d);
      const prev = Array.isArray(handoffs[p.id]) ? handoffs[p.id] : [];
      const retain = [];
      const seenFrom = new Set();
      for (const r of prev) {
        retain.push(r);
        if (r && typeof r.from === 'string') seenFrom.add(r.from);
      }
      for (const from of deps) {
        if (seenFrom.has(from)) continue;
        retain.push(pendingHandoffRecordOf({ from, to: p.id, batchId, ts }));
      }
      const acceptBefore = prev.filter((r) => r && r.source === 'accept').length;
      const acceptAfter = retain.filter((r) => r && r.source === 'accept').length;
      if (acceptAfter !== acceptBefore) {
        throw new Error('task edge rejected: 净收紧边（source=accept）被丢弃 '
          + acceptBefore + '→' + acceptAfter + '（lane=' + p.id + '）；这是计划图不变量，不可静默回退');
      }
      handoffs[p.id] = retain;
      edgesLog.push({ id: p.id, add: p.fresh });
    }
    const revision = (batch.planRevision ?? 0) + 1;
    const next = {
      ...batch,
      wavePlan: plan.wavePlan,
      handoffs,
      planRevision: revision,
      updatedAt: ts,
      events: [...(batch.events ?? []), newEvent(EVT.EVT_PLAN_MUTATED, {
        edges: edgesLog, reason: reason ?? null, author: author ?? null, revision,
      })],
    };
    commitBatch(sessionId, batchId, next);
    return next;
  }

  return { addPoolTasks, addTaskEdges };
}
