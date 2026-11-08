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
import { flowOf, consumeFieldOf } from '../../assembly/flows.js';
import fs from 'node:fs';
import path from 'node:path';
export function buildHelpers(cx) {
    const { flowsOf, presenceJudge, sessionsDir } = cx;
    function sessionDir(sessionId) { return sessionDirOf(sessionsDir, sessionId); }
    function artifactsDirOf(sessionId, batchId) { return artifactsDirOfAt(sessionsDir, sessionId, batchId); }
    function batchFile(sessionId, batchId) { return batchFilePathOf(sessionsDir, sessionId, batchId); }
    function readBatch(sessionId, batchId) {
        const file = batchFile(sessionId, batchId);
        if (!fs.existsSync(file))
            return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        catch {
            return null;
        }
    }
    function resolveArtifact(sessionId, batchId, rel) {
        return isAbsPath(rel) ? rel : path.join(artifactsDirOf(sessionId, batchId), rel);
    }
    function declaredArtifactsOf(t) {
        const out = [];
        if (!t)
            return out;
        const lists = [t.produce, t.outputs];
        for (const list of lists) {
            if (!Array.isArray(list))
                continue;
            for (const p of list)
                if (typeof p === 'string' && p.length > 0 && !out.includes(p))
                    out.push(p);
        }
        return out;
    }
    function consumeFieldNameOf(flows, layer) {
        return layer ? consumeFieldOf(flowOf(flows, layer), layer) : 'consume';
    }
    function consumeArtifactsOf(t, field = 'consume') {
        const out = [];
        if (!t)
            return out;
        const list = t[field];
        if (!Array.isArray(list))
            return out;
        for (const p of list)
            if (typeof p === 'string' && p.length > 0)
                out.push(p);
        return out;
    }
    function layersOf(batch) {
        const layers = { plan: [], exec: [], audit: [] };
        for (const w of batch.wavePlan ?? [])
            for (const t of w.tasks ?? [])
                if (t && t.layer && layers[t.layer])
                    layers[t.layer].push(t.id);
        return layers;
    }
    function orphanProductsOf(batch) {
        const declared = { plan: [], exec: [], audit: [] };
        const consumed = new Set();
        const flows = flowsOf(batch).flows;
        for (const w of batch.wavePlan ?? [])
            for (const t of w.tasks ?? []) {
                if (!t)
                    continue;
                if (t.layer && declared[t.layer]) {
                    for (const p of declaredArtifactsOf(t))
                        if (!declared[t.layer].includes(p))
                            declared[t.layer].push(p);
                }
                for (const c of consumeArtifactsOf(t, consumeFieldNameOf(flows, t.layer ?? null)))
                    consumed.add(c);
            }
        const orphansOf = (layer) => declared[layer].filter((p) => !consumed.has(p));
        return { plan: orphansOf('plan'), exec: orphansOf('exec'), audit: orphansOf('audit') };
    }
    function completeOutcomesOf(batch) {
        const af = flowOf(flowsOf(batch).flows, 'audit');
        const verdict = af && af.audit_contract && Array.isArray(af.audit_contract.verdict) && af.audit_contract.verdict.length > 0
            ? af.audit_contract.verdict : null;
        const declaredSet = verdict;
        const values = declaredSet ? declaredSet.filter((v) => v === 'pass' || v === 'skip') : ['pass', 'skip'];
        const narrowed = declaredSet ? declaredSet.filter((v) => v !== 'pass' && v !== 'skip') : [];
        return {
            source: verdict ? 'flows.audit.audit_contract.verdict ∩ {pass,skip}' : 'engine:Q-7-baseline ∩ {pass,skip}',
            declared: declaredSet,
            values,
            narrowed,
            rejectedBy: ['fail', 'conflict'],
            escapeRoute: {
                phase: 'aborted',
                reason: 'fail / conflict 为成员终态且均不得 complete ⇒ 批次经 batch_phase({phase:"aborted"}) 收口（可审计）或转人工闸；不得形成「既不能 complete 也无法推进」的僵局（D-8 终态可退出）',
            },
        };
    }
    function standaloneVerdict(batch, t) {
        const raw = t.standaloneReason;
        const reason = typeof raw === 'string' ? raw.trim() : '';
        if (t.standalone === undefined || t.standalone === null || t.standalone === false) {
            return { ok: false, declared: false, code: null, reason };
        }
        if (t.standalone !== true)
            return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
        if (reason.length === 0)
            return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
        const availableUpstream = (batch.wavePlan ?? []).some((w) => (w.tasks ?? []).some((x) => x && x.layer === 'plan' && declaredArtifactsOf(x).length > 0));
        if (availableUpstream)
            return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
        return { ok: true, declared: true, code: null, reason };
    }
    function presenceOfArtifact(sessionId, batchId, layer, p) {
        return presenceJudge({
            mode: 'runtime', layer, declared: [p], declaredKind: 'array',
            abs: resolveArtifact(sessionId, batchId, p), artifactsRoot: artifactsDirOf(sessionId, batchId),
        });
    }
    function depsOf(t) {
        const out = [];
        const list = t?.deps;
        if (!Array.isArray(list))
            return out;
        for (const d of list)
            if (typeof d === 'string' && d.length > 0 && !out.includes(d))
                out.push(d);
        return out;
    }
    function declaredInboundEdgesOf(batch, lane, t) {
        const edges = [];
        const sources = [];
        const push = (from, source) => {
            if (edges.includes(from))
                return;
            edges.push(from);
            sources.push({ from, source });
        };
        for (const d of depsOf(t))
            push(d, 'deps');
        const map = batch?.handoffs;
        const records = [];
        if (map && typeof map === 'object' && !Array.isArray(map)) {
            const list = map[lane];
            if (Array.isArray(list)) {
                for (const r of list) {
                    if (!r || typeof r !== 'object' || Array.isArray(r))
                        continue;
                    const rec = r;
                    records.push(rec);
                    if (typeof rec.from === 'string' && rec.from.length > 0) {
                        push(rec.from, rec.source === 'accept' ? 'accept' : 'deps');
                    }
                }
            }
        }
        return { edges, records, sources };
    }
    function handoffRecordVerdict(sessionId, batchId, layer, rec, from, to) {
        const missing = [];
        const problems = [];
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
        const arts = Array.isArray(rec.artifacts) ? rec.artifacts.filter((p) => typeof p === 'string' && p.length > 0) : [];
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
        const cObj = (c && typeof c === 'object' && !Array.isArray(c)) ? c : null;
        if (!cObj || cObj.consumedFrom !== from) {
            missing.push('contract.consumedFrom@' + from + '->' + to);
            problems.push('交接契约缺失或 `consumedFrom` 不指回该入边（期望 ' + from + '）');
        }
        const asrt = cObj && Array.isArray(cObj.assertions) ? cObj.assertions.filter((x) => typeof x === 'string' && x.trim().length > 0) : [];
        if (asrt.length === 0) {
            missing.push('contract.assertions@' + from + '->' + to);
            problems.push('交接契约 `assertions` 为空（下游无可核断言可依）');
        }
        return { ok: missing.length === 0, missing, problems, pending };
    }
    function handoffVerdictOf(sessionId, batchId, batch, lane, t) {
        const { edges: deps, records } = declaredInboundEdgesOf(batch, lane, t);
        const map = batch.handoffs;
        if (deps.length === 0)
            return { ok: true, legacy: false, missing: [], problems: [], pending: [] };
        if (map === undefined || map === null)
            return { ok: true, legacy: true, missing: [], problems: [], pending: [] };
        const missing = [];
        const problems = [];
        const pending = [];
        for (const from of deps) {
            const vr = handoffRecordVerdict(sessionId, batchId, t?.layer ?? null, records.find((r) => r.from === from) ?? null, from, lane);
            missing.push(...vr.missing);
            problems.push(...vr.problems);
            if (vr.pending)
                pending.push(from + '->' + lane);
        }
        return { ok: missing.length === 0, legacy: false, missing, problems, pending };
    }
    return { sessionDir, artifactsDirOf, batchFile, readBatch, resolveArtifact, declaredArtifactsOf, consumeFieldNameOf, consumeArtifactsOf, layersOf, orphanProductsOf, completeOutcomesOf, standaloneVerdict, presenceOfArtifact, depsOf, declaredInboundEdgesOf, handoffRecordVerdict, handoffVerdictOf };
}
