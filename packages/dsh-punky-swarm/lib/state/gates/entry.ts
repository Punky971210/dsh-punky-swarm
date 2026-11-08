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


import { flowOf, entryRequiresOf, globMatchesPath, ENGINE_BASELINE_CRITERIA_SECTION } from '../../assembly/flows.js';
import { taskOf, smokeOf, contractMissingPayload } from './detect.js';
import { reasonVocabularyNote } from './reason-vocabulary.js';
import { handoffGateEnabledOf } from '../handoff-gate.js';
import type { Batch } from '../../types/contracts.js';
import fs from 'node:fs';
import { resolveArtifactIn } from '../batch-paths.js';

import type { GatesCx } from './cx.js';

export function buildEntry(cx: GatesCx) {
  const { artifactsDirOf, consumeArtifactsOf, consumeFieldNameOf, declaredArtifactsOf, flowsOf, handoffVerdictOf, presenceOfArtifact, readCfg, reasonVocabularyVerdict, resolveArtifact, standaloneVerdict, vocabOpts } = cx;

  function checkEntryGate(sessionId: string, batchId: string, batch: Batch, lane: string) {
    const t = taskOf(batch, lane);
    if (!t) return { ok: false, code: 'GATE_LANE_NOT_IN_PLAN', lane, missing: [], problems: [lane + ' not in wavePlan.tasks'] };
    if (t.layer !== 'exec' && t.layer !== 'audit') return { ok: true, lane };
    const flows = flowsOf(batch).flows;
    const flow = flowOf(flows, t.layer);
    const teamNote: Record<string, unknown> = { requiredBy: entryRequiresOf(flow).source };
    const hv = handoffGateEnabledOf(readCfg(), 'entry')
      ? handoffVerdictOf(sessionId, batchId, batch, lane, t)
      : { ok: true, legacy: false, missing: [], problems: [], pending: [] };
    const hvLegacy = hv.legacy === true;
    const cmEntry = entryRequiresOf(flow).source === 'tighten-only-default'
      ? contractMissingPayload(
        'entry_requires', t.layer, entryRequiresOf(flow).source, 'entry-requires-tighten-only-default',
        '团队资产未声明 flows.<layer>.entry_requires ⇒ 引擎 tighten-only 缺省接管（入口 consume 强制恒生效）；本事件为首触留痕，不改判定',
      )
      : null;
    const state = batch.lanes ? batch.lanes[lane] : null;
    const recovery = state === 'idle';
    const reject = (payload: { code: string; missing?: string[]; problems?: string[] } & Record<string, unknown>) => {
      if (recovery) {
        return {
          ok: true, lane, recovered: true, state,
          missing: payload.missing ?? [], problems: payload.problems ?? [],
          escape: {
            kind: 'idle-recovery-passthrough', lane,
            reason: 'G-1 空闲态不堵：lane 处于 idle（空闲态——返工/续跑可调用；进程重启亦会把在途 lane 落回 idle），严进条件不满足（' + payload.code + '）⇒ 降级为告警放行 + 留痕；首次派发（pending）仍严格',
          },
          ...(cmEntry ?? {}),
        };
      }
      return { ok: false, lane, ...payload, ...teamNote, handoffLegacy: hvLegacy, missing: payload.missing ?? [] };
    };
    const vocabE1 = reasonVocabularyVerdict(artifactsDirOf(sessionId, batchId), declaredArtifactsOf(t), vocabOpts);
    const vocabNote = reasonVocabularyNote(vocabE1);
    if (!vocabE1.ok) {
      const first = vocabE1.unknown[0];
      return reject({
        code: 'GATE_TOKEN_UNKNOWN', source: 'reason', token: first.token, path: first.path, missing: [],
        problems: vocabE1.unknown.map((u) => u.path + ' declares unregistered reason token "' + u.token
          + '"（词表未登记 ⇒ 拒：Q-3=B 只对**新增写点**强制注册）'),
      });
    }
    const bAsm = batch as unknown as { assembly?: { managerPlan?: string } | null; manager?: unknown };
    void bAsm;
    if (smokeOf(batch)) {
      return { ok: true, lane, smoke: true, smokeSkipped: 'entry-consume', ...(cmEntry ?? {}), ...vocabNote };
    }
    if (!hv.ok) {
      return reject({
        code: 'GATE_HANDOFF_MISSING',
        missing: hv.missing,
        problems: [
          ...hv.problems,
          '【怎么做】用 `handoff_submit({ batchId, from: "<本 lane>", to: "<下游 lane>", '
          + 'artifacts: [<产物相对路径…>], assertions: [<下游可核断言…>] })` 向【本 lane 的全部出边】交接 —— '
          + '**含聚合 audit lane**（`a1-*` 这类多入边 lane，**每条上游线各自交一次**）。'
          + ' `artifacts` 里每个路径**必须已在场**（缺则仍拒）；`assertions` 不得为空。',
        ],
      });
    }
    if (hvLegacy) {
      (teamNote as Record<string, unknown>).handoffLegacy = true;
    }
    const consume = consumeArtifactsOf(t, consumeFieldNameOf(flows, t.layer));
    if (consume.length === 0) {
      const s = standaloneVerdict(batch, t);
      if (s.ok) return { ok: true, lane, standalone: true, escape: { kind: 'standalone', lane, reason: s.reason }, ...teamNote, ...(cmEntry ?? {}), ...vocabNote };
      if (s.declared) {
        return reject({ code: 'GATE_STANDALONE_UNJUSTIFIED', missing: [], problems: [lane + ': standalone 声明不成立（须布尔 true + 非空 standaloneReason + 批次内确实无可用上游）'] });
      }
      return reject({ code: 'GATE_ENTRY_MISSING', missing: [], problems: [lane + ': no consume declared（B1 零依赖拒派）'] });
    }
    const failed: string[] = [];
    const shapeProblems: string[] = [];
    for (const p of consume) {
      const v = presenceOfArtifact(sessionId, batchId, t.layer, p);
      if (!v.ok) { failed.push(p); for (const pr of v.problems) shapeProblems.push(pr); }
    }
    if (failed.length) {
      return reject({
        code: 'GATE_ENTRY_MISSING',
        missing: failed,
        problems: [
          ...shapeProblems,
          '【怎么做】本 lane 的入口门要求**上游产物已在场**：'
          + '① 先用 `handoff_view({ batchId, lane })` 看入边是否 `submitted` —— 未交则等上游交；'
          + '② 若上游 lane 还没派 ⇒ 报 Leader 派（本 lane 不自行派发）；'
          + '③ 若 `consume` 的路径声明本身就写错 ⇒ 由 Leader 用 `task_update` 改声明。',
        ],
      });
    }
    if (t.layer === 'audit') {
      const planProducts = new Set<string>();
      for (const w of batch.wavePlan ?? []) {
        for (const x of w.tasks ?? []) {
          if (x.layer !== 'plan') continue;
          for (const p of [...(x.produce ?? []), ...(x.outputs ?? [])]) planProducts.add(p);
        }
      }
      const isPlanProduct = (p: string) => (typeof p === 'string' && p.startsWith('plan/')) || planProducts.has(p);
      const ac = flow?.audit_contract ?? null;
      const criteriaFrom = ac && typeof ac.criteria_from === 'string' && ac.criteria_from.trim() ? ac.criteria_from.trim() : null;
      const anchors = criteriaFrom
        ? consume.filter((p: string) => globMatchesPath(criteriaFrom, p))
        : consume.filter((p: string) => isPlanProduct(p));
      if (anchors.length === 0) {
        return reject({ code: 'GATE_AUDIT_INPUT_MISSING', problems: consume, ...(criteriaFrom ? { criteriaFrom } : {}) });
      }
      const criteriaSection = ac && typeof ac.criteria_section === 'string' && ac.criteria_section.trim()
        ? ac.criteria_section.trim()
        : ENGINE_BASELINE_CRITERIA_SECTION;
      const problems: string[] = [];
      let okAnchor = false;
      for (const p of anchors) {
        try {
          if (fs.readFileSync(resolveArtifactIn(artifactsDirOf(sessionId, batchId), p), 'utf8').includes(criteriaSection)) { okAnchor = true; break; }
          problems.push(p + ' lacks "' + criteriaSection + '"');
        } catch { problems.push(p + ' unreadable'); }
      }
      if (!okAnchor) {
        return reject({
          code: 'GATE_AUDIT_CRITERIA_MISSING',
          problems: [
            ...problems,
            '【怎么做】audit lane 的判据源只能是 **plan 层产物**（本 lane `consume` 里 `plan/` 前缀的件），'
            + '其正文须含裸标题行 `' + criteriaSection + '`（**行首恰为该串**，非 `###`、无编号前缀）。'
            + ' plan 产物缺它 ⇒ **回 plan 层补该标题**（内容可空），**不得在本 lane 自造判据**。',
          ],
        });
      }
    }
    return { ok: true, lane, handoffLegacy: hvLegacy, ...(cmEntry ?? {}), ...vocabNote };
  }

  return { checkEntryGate };
}
