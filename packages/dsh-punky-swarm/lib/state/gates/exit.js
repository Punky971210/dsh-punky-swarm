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
import { flowOf, produceFieldOf, enabledByFlag, flagOf } from '../../assembly/flows.js';
import { taskOf, smokeOf, contractMissingPayload, detectNeedHuman } from './detect.js';
import { humanEvidenceOf } from '../constants.js';
export function buildExit(cx) {
    const { artifactsDirOf, checkPlanContract, declaredArtifactsOf, flowsOf, presenceOfArtifact, standaloneVerdict } = cx;
    function checkExitGate(sessionId, batchId, batch, lane) {
        const t = taskOf(batch, lane);
        if (!t)
            return { ok: false, code: 'GATE_LANE_NOT_IN_PLAN', lane, missing: [], problems: [lane + ' not in wavePlan.tasks'] };
        if (!t.layer)
            return { ok: false, code: 'GATE_LANE_LAYER_MISSING', lane, missing: [], problems: [lane + ': no layer declared (generic exemption retired, Q-6①)'] };
        if (t.layer === 'plan')
            return checkPlanContract(sessionId, batchId, batch, lane);
        if (smokeOf(batch))
            return { ok: true, lane, smoke: true, smokeSkipped: 'exit-produce' };
        const flow = flowOf(flowsOf(batch).flows, t.layer);
        const declaredField = produceFieldOf(flow, t.layer);
        const declared = declaredArtifactsOf(t);
        const degrades = [];
        if (declaredField && declared.length > 0) {
            const narrowedField = Array.isArray(t[declaredField]) ? t[declaredField] : [];
            const otherField = declaredField === 'produce' ? 'outputs' : 'produce';
            const other = Array.isArray(t[otherField]) ? t[otherField] : [];
            if (narrowedField.length === 0 && other.length > 0) {
                degrades.push({ kind: 'produce-field-widened', declaredField, effective: ['produce', 'outputs'] });
            }
        }
        if (declared.length === 0) {
            const s = standaloneVerdict(batch, t);
            if (s.ok)
                return { ok: true, lane, standalone: true, escape: { kind: 'standalone', lane, reason: s.reason } };
            return {
                ok: false, code: 'GATE_EXIT_NO_DECLARATION', lane, missing: [], problems: [lane + ': no produce/outputs declared'],
                ...(degrades.length ? { degrades } : {}),
                ...(s.declared ? { standaloneProblem: s.code ?? 'GATE_STANDALONE_UNJUSTIFIED' } : {}),
            };
        }
        const failed = [];
        const codes = [];
        const problems = [];
        for (const p of declared) {
            const v = presenceOfArtifact(sessionId, batchId, t.layer, p);
            if (!v.ok) {
                failed.push(p);
                if (v.code)
                    codes.push(v.code);
                for (const prob of v.problems)
                    problems.push(prob);
            }
        }
        if (failed.length) {
            const order = ['GATE_ARTIFACT_OUTSIDE_ROOT', 'GATE_ARTIFACT_NOT_A_FILE', 'GATE_ARTIFACT_EMPTY_NO_REASON', 'GATE_ARTIFACT_MISSING'];
            const picked = order.find((c) => codes.includes(c)) ?? 'GATE_ARTIFACT_MISSING';
            const code = picked === 'GATE_ARTIFACT_MISSING' ? 'GATE_EXIT_MISSING_' + t.layer.toUpperCase() : picked;
            return { ok: false, code, lane, missing: failed, problems, ...(degrades.length ? { degrades } : {}) };
        }
        return { ok: true, lane, ...(degrades.length ? { degrades } : {}) };
    }
    function checkNeedHumanGate(sessionId, batchId, batch, lane, note) {
        const t = taskOf(batch, lane);
        if (!t || t.layer !== 'audit')
            return { ok: true, declared: false, path: null };
        const fields = [...new Set([
                ...(Array.isArray(t.produce) ? t.produce : []),
                ...(Array.isArray(t.outputs) ? t.outputs : []),
            ])];
        if (fields.length === 0)
            return { ok: true, declared: false, path: null };
        const af = flowOf(flowsOf(batch).flows, 'audit');
        const cmNeedhuman = flagOf(af, 'needhuman') === null
            ? contractMissingPayload('needhuman', 'audit', 'engine:enabledByFlag(needhuman,true)', 'needhuman-engine-default-enabled', '团队资产未声明 flows.audit.needhuman ⇒ 引擎基线启用（缺声明不得放宽）；本事件为首触留痕，不改判定')
            : null;
        if (!enabledByFlag(af, 'needhuman', true)) {
            return {
                ok: true, declared: false, path: null, disabledBy: 'team-asset:needhuman',
                escape: {
                    kind: 'needhuman-off', lane,
                    reason: '团队资产显式声明 flows.audit.needhuman=false ⇒ 人工闸停用（放行判定不变）＋留痕',
                },
            };
        }
        const det = detectNeedHuman(artifactsDirOf(sessionId, batchId), fields);
        if (!det.declared)
            return { ok: true, declared: false, path: null, ...(cmNeedhuman ?? {}) };
        const evidence = humanEvidenceOf(note);
        if (evidence)
            return { ok: true, declared: true, path: det.path, evidence, ...(cmNeedhuman ?? {}) };
        return {
            ok: false, code: 'GATE_NEEDHUMAN_PENDING', declared: true, path: det.path,
            message: 'audit lane 声明 needHuman，须 Manager 转达人工裁决（merged 需 note 含 human: 证据 / conflict 驳回）',
        };
    }
    return { checkExitGate, checkNeedHumanGate };
}
