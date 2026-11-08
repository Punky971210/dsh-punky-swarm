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


import { isAbsPath } from '../constants.js';
import { sessionDirOf, artifactsDirOf as artifactsDirOfAt, batchFilePathOf } from '../batch-paths.js';
import { flowOf, consumeFieldOf, flowsForBatch } from '../../assembly/flows.js';
import type { PresenceInput, PresenceVerdict } from './presence.js';
import type { Batch, Layer, WavePlanTask } from '../../types/contracts.js';
import fs from 'node:fs';
import path from 'node:path';

/** `buildHelpers` 的输入底座（组合器提供的闭包状态 + 模块级判据单点）。 */
export interface HelpersBase {
  sessionsDir: string;
  flowsOf: (batch: Batch) => ReturnType<typeof flowsForBatch>;
  presenceJudge: (input: PresenceInput) => PresenceVerdict;
}

/** 共享辅助面的完整类型（组合器与各 builder 据此做结构性装配）。 */
export type GatesHelpers = ReturnType<typeof buildHelpers>;

export function buildHelpers(cx: HelpersBase) {
  const { flowsOf, presenceJudge, sessionsDir } = cx;

  function sessionDir(sessionId: string) { return sessionDirOf(sessionsDir, sessionId); }
  function artifactsDirOf(sessionId: string, batchId: string) { return artifactsDirOfAt(sessionsDir, sessionId, batchId); }
  function batchFile(sessionId: string, batchId: string) { return batchFilePathOf(sessionsDir, sessionId, batchId); }
  function readBatch(sessionId: string, batchId: string): Batch | null {
    const file = batchFile(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Batch;
    } catch {
      return null;
    }
  }

  function resolveArtifact(sessionId: string, batchId: string, rel: string) {
    return isAbsPath(rel) ? rel : path.join(artifactsDirOf(sessionId, batchId), rel);
  }
  function declaredArtifactsOf(t: WavePlanTask | null | undefined): string[] {
    const out: string[] = [];
    if (!t) return out;
    const lists: Array<string[] | null | undefined> = [t.produce, t.outputs];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const p of list) if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p);
    }
    return out;
  }
  function consumeFieldNameOf(flows: unknown, layer: string | null): string {
    return layer ? (consumeFieldOf(flowOf(flows, layer), layer) as string) : 'consume';
  }
  function consumeArtifactsOf(t: WavePlanTask | null | undefined, field: string = 'consume'): string[] {
    const out: string[] = [];
    if (!t) return out;
    const list = (t as unknown as Record<string, unknown>)[field];
    if (!Array.isArray(list)) return out;
    for (const p of list) if (typeof p === 'string' && p.length > 0) out.push(p);
    return out;
  }
  function layersOf(batch: Batch): Record<Layer, string[]> {
    const layers: Record<Layer, string[]> = { plan: [], exec: [], audit: [] };
    for (const w of batch.wavePlan ?? []) for (const t of w.tasks ?? []) if (t && t.layer && layers[t.layer]) layers[t.layer].push(t.id);
    return layers;
  }
  function orphanProductsOf(batch: Batch): { plan: string[]; exec: string[]; audit: string[] } {
    const declared: Record<Layer, string[]> = { plan: [], exec: [], audit: [] };
    const consumed = new Set<string>();
    const flows = flowsOf(batch).flows;
    for (const w of batch.wavePlan ?? []) for (const t of w.tasks ?? []) {
      if (!t) continue;
      if (t.layer && declared[t.layer]) {
        for (const p of declaredArtifactsOf(t)) if (!declared[t.layer].includes(p)) declared[t.layer].push(p);
      }
      for (const c of consumeArtifactsOf(t, consumeFieldNameOf(flows, t.layer ?? null))) consumed.add(c);
    }
    const orphansOf = (layer: Layer) => declared[layer].filter((p) => !consumed.has(p));
    return { plan: orphansOf('plan'), exec: orphansOf('exec'), audit: orphansOf('audit') };
  }
  function completeOutcomesOf(batch: Batch) {
    const af = flowOf(flowsOf(batch).flows, 'audit');
    const verdict = af && af.audit_contract && Array.isArray(af.audit_contract.verdict) && af.audit_contract.verdict.length > 0
      ? (af.audit_contract.verdict as string[]) : null;
    const declaredSet: string[] | null = verdict;
    const values = declaredSet ? declaredSet.filter((v) => v === 'pass' || v === 'skip') : ['pass', 'skip'];
    const narrowed = declaredSet ? declaredSet.filter((v) => v !== 'pass' && v !== 'skip') : [];
    return {
      source: verdict ? 'flows.audit.audit_contract.verdict ∩ {pass,skip}' : 'engine:Q-7-baseline ∩ {pass,skip}',
      declared: declaredSet,
      values,
      narrowed,
      rejectedBy: ['fail', 'conflict'],
      escapeRoute: {
        phase: 'aborted' as const,
        reason: 'fail / conflict 为成员终态且均不得 complete ⇒ 批次经 batch_phase({phase:"aborted"}) 收口（可审计）或转人工闸；不得形成「既不能 complete 也无法推进」的僵局（D-8 终态可退出）',
      },
    };
  }
  function standaloneVerdict(batch: Batch, t: WavePlanTask): { ok: boolean; declared: boolean; code: string | null; reason: string } {
    const raw = (t as unknown as { standaloneReason?: unknown }).standaloneReason;
    const reason = typeof raw === 'string' ? raw.trim() : '';
    if (t.standalone === undefined || t.standalone === null || t.standalone === false) {
      return { ok: false, declared: false, code: null, reason };
    }
    if (t.standalone !== true) return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
    if (reason.length === 0) return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
    const availableUpstream = (batch.wavePlan ?? []).some((w) => (w.tasks ?? []).some((x) => x && x.layer === 'plan' && declaredArtifactsOf(x).length > 0));
    if (availableUpstream) return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
    return { ok: true, declared: true, code: null, reason };
  }
  function presenceOfArtifact(sessionId: string, batchId: string, layer: string | null, p: string) {
    return presenceJudge({
      mode: 'runtime', layer, declared: [p], declaredKind: 'array',
      abs: resolveArtifact(sessionId, batchId, p), artifactsRoot: artifactsDirOf(sessionId, batchId),
    });
  }

  function depsOf(t: WavePlanTask | null | undefined): string[] {
    const out: string[] = [];
    const list = (t as unknown as { deps?: unknown } | null | undefined)?.deps;
    if (!Array.isArray(list)) return out;
    for (const d of list) if (typeof d === 'string' && d.length > 0 && !out.includes(d)) out.push(d);
    return out;
  }

  function declaredInboundEdgesOf(
    batch: Batch | null | undefined, lane: string, t?: WavePlanTask | null,
  ): { edges: string[]; records: Record<string, unknown>[]; sources: Array<{ from: string; source: 'deps' | 'accept' }> } {
    const edges: string[] = [];
    const sources: Array<{ from: string; source: 'deps' | 'accept' }> = [];
    const push = (from: string, source: 'deps' | 'accept') => {
      if (edges.includes(from)) return;
      edges.push(from);
      sources.push({ from, source });
    };
    for (const d of depsOf(t)) push(d, 'deps');
    const map = (batch as unknown as { handoffs?: unknown } | null | undefined)?.handoffs;
    const records: Record<string, unknown>[] = [];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const list = (map as Record<string, unknown>)[lane];
      if (Array.isArray(list)) {
        for (const r of list) {
          if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
          const rec = r as Record<string, unknown>;
          records.push(rec);
          if (typeof rec.from === 'string' && rec.from.length > 0) {
            push(rec.from, rec.source === 'accept' ? 'accept' : 'deps');
          }
        }
      }
    }
    return { edges, records, sources };
  }
  function handoffRecordVerdict(
    sessionId: string, batchId: string, layer: string | null | undefined,
    rec: Record<string, unknown> | null, from: string, to: string,
  ): { ok: boolean; missing: string[]; problems: string[]; pending: boolean } {
    const missing: string[] = [];
    const problems: string[] = [];
    if (!rec) {
      missing.push('edge:' + from + '->' + to + ' (无交接声明)');
      problems.push('deps 入边 ' + from + '->' + to + ' 在本批 `handoffs` 中无任何交接记录（建批期声明的交接来源缺失 ⇒ 判不可开工）');
      return { ok: false, missing, problems, pending: false };
    }
    let pending = false;
    if (rec.status !== 'submitted') {
      pending = true;
      missing.push('edge:' + from + '->' + to + ' (未交接)');
      problems.push('上游 ' + from + ' 尚未提交交接（status=' + String(rec.status ?? '（缺）') + '）');
    }
    const arts: string[] = Array.isArray(rec.artifacts) ? (rec.artifacts as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
    if (arts.length === 0) {
      missing.push('edge:' + from + '->' + to + ' (artifacts 空)');
      problems.push('交接 ' + from + '->' + to + ' 未声明交付产物（artifacts 为空）');
    }
    for (const p of arts) {
      const v = presenceOfArtifact(sessionId, batchId, layer ?? null, p);
      if (!v.ok) {
        missing.push(p + ' (missing)');
        problems.push('交接产物不在场：' + p + (v.problems && v.problems.length ? '（' + v.problems.join('; ') + '）' : ''));
      }
    }
    const c = rec.contract;
    const cObj = (c && typeof c === 'object' && !Array.isArray(c)) ? (c as Record<string, unknown>) : null;
    if (!cObj || cObj.consumedFrom !== from) {
      missing.push('contract.consumedFrom@' + from + '->' + to);
      problems.push('交接契约缺失或 `consumedFrom` 不指回该入边（期望 ' + from + '）');
    }
    const asrt = cObj && Array.isArray(cObj.assertions) ? (cObj.assertions as unknown[]).filter((x) => typeof x === 'string' && (x as string).trim().length > 0) : [];
    if (asrt.length === 0) {
      missing.push('contract.assertions@' + from + '->' + to);
      problems.push('交接契约 `assertions` 为空（下游无可核断言可依）');
    }
    return { ok: missing.length === 0, missing, problems, pending };
  }

  function handoffVerdictOf(sessionId: string, batchId: string, batch: Batch, lane: string, t: WavePlanTask | null | undefined) {
    const { edges: deps, records } = declaredInboundEdgesOf(batch, lane, t);
    const map = (batch as unknown as { handoffs?: unknown }).handoffs;
    if (deps.length === 0) return { ok: true, legacy: false, missing: [], problems: [], pending: [] };
    if (map === undefined || map === null) return { ok: true, legacy: true, missing: [], problems: [], pending: [] };
    const missing: string[] = [];
    const problems: string[] = [];
    const pending: string[] = [];
    for (const from of deps) {
      const vr = handoffRecordVerdict(sessionId, batchId, t?.layer ?? null, records.find((r) => r.from === from) ?? null, from, lane);
      missing.push(...vr.missing);
      problems.push(...vr.problems);
      if (vr.pending) pending.push(from + '->' + lane);
    }
    return { ok: missing.length === 0, legacy: false, missing, problems, pending };
  }

  return { sessionDir, artifactsDirOf, batchFile, readBatch, resolveArtifact, declaredArtifactsOf, consumeFieldNameOf, consumeArtifactsOf, layersOf, orphanProductsOf, completeOutcomesOf, standaloneVerdict, presenceOfArtifact, depsOf, declaredInboundEdgesOf, handoffRecordVerdict, handoffVerdictOf };
}
