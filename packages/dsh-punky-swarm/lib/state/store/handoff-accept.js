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

export function buildHandoffAccept(cx) {
  const { readBatch, newEvent, commitBatch } = cx;

  function acceptRecordOf(from, to, batchId, ts) {
    return {
      from, to, batch: batchId, step: null,
      artifacts: [], contract: { consumedFrom: from, assertions: [] },
      status: 'pending', ts, officialTaskId: null,
      source: 'accept', acceptedBy: { lane: to, ts },
    };
  }

  function recordHandoffAccept(sessionId, batchId, { from, to, reason = null, author = null } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId + ' @' + sessionId);
    if (typeof from !== 'string' || !from.trim().length) throw new Error('handoff accept rejected: from 必填（上游 lane id）');
    if (typeof to !== 'string' || !to.trim().length) throw new Error('handoff accept rejected: to 必填（下游 lane id）');
    const fromId = from.trim();
    const toId = to.trim();
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); handoff accept rejected');
    }
    if (batch.handoffs === undefined || batch.handoffs === null
      || typeof batch.handoffs !== 'object' || Array.isArray(batch.handoffs)) {
      throw new Error('handoff accept rejected: 该批为**存量形态**（无 `batch.handoffs` 字段）⇒ 补声明会改变交接门语义'
        + '（legacy 放行 → 受门约束）⇒ 拒；请在新建批（带交接面）上操作');
    }
    const tasks = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    const orderOf = new Map();
    const byId = new Map();
    tasks.forEach((t, i) => {
      if (t && typeof t.id === 'string' && t.id) { orderOf.set(t.id, i); byId.set(t.id, t); }
    });
    const target = byId.get(toId);
    if (!target) throw new Error('handoff accept rejected: 下游 lane 不存在 ⇒ ' + toId + '（须为批次内**已声明**的 lane）');
    if (target.layer !== 'audit') {
      throw new Error('handoff accept rejected: 下游 lane ' + toId + ' 的 layer = ' + String(target.layer ?? null)
        + ' ≠ audit ⇒ 本通道首版**只开 audit 面**（声明方必须是消费方 / 验收方，不接受任意层间补边）');
    }
    const lanes = batch.lanes ?? {};
    if (schema.isMemberTerminal(lanes[fromId])) {
      throw new Error('handoff accept rejected: 上游 ' + fromId + ' 已结算（lane=' + String(lanes[fromId])
        + '）⇒ 该边**无交接可等**（终态 lane 无法再提交交接）⇒ 结构性无法满足，拒');
    }
    if (schema.isMemberTerminal(lanes[toId])) {
      throw new Error('handoff accept rejected: 下游 ' + toId + ' 已结算（lane=' + String(lanes[toId])
        + '）⇒ 声明一条无法再被消费的入边会改变其已成立的入场判定 ⇒ 拒');
    }
    const appended = new Set();
    for (const e of batch.events ?? []) {
      if (!e || e.type !== EVT.EVT_PLAN_MUTATED) continue;
      for (const id of Array.isArray(e.added) ? e.added : []) if (typeof id === 'string' && id) appended.add(id);
    }
    if (!appended.has(fromId)) {
      throw new Error('handoff accept rejected: 上游 ' + fromId + ' 不是**批运行中追加的**后置 lane'
        + '（真源 = 批事件 `plan.mutated.added[]` 之并集）⇒ 本通道只服务「追加 lane 无声明位」这一缺口，'
        + '建批期即存在的 lane 请走建批期 `deps` 声明路径（勿把本通道当通用补边工具）');
    }
    const fromTask = byId.get(fromId);
    if (!fromTask) throw new Error('handoff accept rejected: 上游 lane 不存在于当前 wavePlan ⇒ ' + fromId);
    if (!(orderOf.get(fromId) < orderOf.get(toId))) {
      throw new Error('handoff accept rejected: 声明序违约 ⇒ orderOf(' + fromId + ') 不小于 orderOf(' + toId + ')'
        + '（后置 lane 只能被**更早声明**的下游接受；本通道不新增任何拓扑保证，也不给更晚的下游留条）');
    }
    if (fromId === toId) throw new Error('handoff accept rejected: from 与 to 不得相同 ⇒ ' + fromId);
    const list = Array.isArray(batch.handoffs[toId]) ? batch.handoffs[toId] : [];
    const existing = list.find((r) => r && r.from === fromId) ?? null;
    if (existing) {
      return {
        ok: true, idempotent: true, from: fromId, to: toId, revision: batch.planRevision ?? 0,
        record: { ...existing },
      };
    }
    const ts = new Date().toISOString();
    const rec = acceptRecordOf(fromId, toId, batchId, ts);
    const revision = (batch.planRevision ?? 0) + 1;
    const next = {
      ...batch,
      handoffs: { ...batch.handoffs, [toId]: [...list, rec] },
      planRevision: revision,
      updatedAt: ts,
      events: [...(batch.events ?? []), newEvent(EVT.EVT_PLAN_MUTATED, {
        accepts: [{ from: fromId, to: toId }], reason: reason ?? null, author: author ?? null, revision,
      })],
    };
    commitBatch(sessionId, batchId, next);
    return { ok: true, idempotent: false, from: fromId, to: toId, revision, record: { ...rec } };
  }

  return { recordHandoffAccept };
}
