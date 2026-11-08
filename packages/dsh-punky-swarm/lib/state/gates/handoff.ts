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


import { findTask } from '../task-utils.js';
import { taskOf, smokeOf } from './detect.js';
import { handoffGateEnabledOf } from '../handoff-gate.js';
import type { Batch } from '../../types/contracts.js';
import { humanEvidenceOf } from '../constants.js';

import type { GatesCx } from './cx.js';

export function buildHandoff(cx: GatesCx) {
  const { handoffRecordVerdict, readCfg, declaredInboundEdgesOf } = cx;

  function checkSettleHandoffGate(
    sessionId: string, batchId: string, batch: Batch, lane: string, note?: string | null,
  ): { ok: boolean; code: string | null; missing: string[]; problems: string[]; disabled?: boolean; smoke?: boolean; legacy?: boolean; humanException?: boolean; downstream?: string[] } {
    if (!handoffGateEnabledOf(readCfg(), 'settle')) return { ok: true, code: null, missing: [], problems: [], disabled: true };
    if (smokeOf(batch)) return { ok: true, code: null, missing: [], problems: [], smoke: true };
    const t = taskOf(batch, lane);
    const downstream: string[] = [];
    for (const w of batch.wavePlan ?? []) {
      for (const x of w.tasks ?? []) {
        if (!x || typeof x.id !== 'string' || x.id.length === 0 || x.id === lane) continue;
        const deps = Array.isArray((x as unknown as { deps?: unknown }).deps) ? ((x as unknown as { deps?: unknown }).deps as unknown[]) : [];
        const declared = declaredInboundEdgesOf(batch, x.id, x).edges;
        if (deps.some((d) => d === lane) || declared.includes(lane)) downstream.push(x.id);
      }
    }
    const nextOf = (t as unknown as { next?: unknown } | null | undefined)?.next;
    if (typeof nextOf === 'string' && nextOf.length > 0 && findTask(batch, nextOf)) downstream.push(nextOf);
    if (downstream.length === 0) return { ok: true, code: null, missing: [], problems: [], downstream: [] };
    const map = (batch as unknown as { handoffs?: unknown }).handoffs;
    if (map === undefined || map === null) {
      return { ok: true, code: null, missing: [], problems: [], legacy: true, downstream };
    }
    const records: Array<Record<string, unknown>> = [];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const list of Object.values(map as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        for (const r of list) if (r && typeof r === 'object' && !Array.isArray(r)) records.push(r as Record<string, unknown>);
      }
    }
    const problems: string[] = [];
    const missing: string[] = [];
    let anySatisfied = false;
    for (const rec of records) {
      if (rec.from !== lane) continue;
      const to = typeof rec.to === 'string' && rec.to.length > 0 ? rec.to : '?';
      const vr = handoffRecordVerdict(sessionId, batchId, t?.layer ?? null, rec, lane, to);
      if (vr.ok) { anySatisfied = true; break; }
      missing.push(...vr.missing);
      problems.push(...vr.problems);
    }
    if (anySatisfied) return { ok: true, code: null, missing: [], problems: [], downstream };
    const evidence = humanEvidenceOf(note);
    if (evidence) return { ok: true, code: null, missing: [], problems: [], downstream, humanException: true };
    missing.unshift('handoff:' + lane + '->(' + downstream.join('/') + ')');
    problems.unshift('lane ' + lane + ' 在 DAG 中有下游（' + downstream.join('/') + '）但**无一条已成立交接**'
      + '（`handoff_submit` 须 status=submitted + artifacts 逐个在场 + contract{consumedFrom,assertions} 合规）'
      + ' ——Leader 例外：merged 的 note 含 `human:<裁决人>:<时间>:<结论>` 可放行并留痕');
    return { ok: false, code: 'GATE_HANDOFF_MISSING', missing, problems, downstream };
  }

  return { checkSettleHandoffGate };
}
