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
import { flowOf, produceFieldsOf, entryRequiresOf } from '../../assembly/flows.js';
import { taskOf } from './detect.js';
import * as EVT from '../event-types.js';
import fs from 'node:fs';
export function buildStatus(cx) {
    const { batchFile, checkPlanContract, completeOutcomesOf, consumeFieldNameOf, flowsOf, laneStartedAt, layersOf, orphanProductsOf, presenceOfArtifact, readBatch, unwiredEntriesOf, vocabOpts, vocabularyViewOf } = cx;
    function gateStrengthOf(batch) {
        const layers = layersOf(batch);
        const flows = flowsOf(batch).flows;
        const layerFlow = (l) => flowOf(flows, l);
        const declaredProduce = {};
        const entryRequires = {};
        for (const l of ['plan', 'exec', 'audit']) {
            const f = layerFlow(l);
            declaredProduce[l] = f && typeof f.produce_field === 'string' ? f.produce_field : null;
            entryRequires[l] = entryRequiresOf(f);
        }
        const af = layerFlow('audit');
        const ef = layerFlow('exec');
        const disabled = [];
        if (af && af.needhuman === false)
            disabled.push('needhuman@team-asset');
        if (ef && ef.gate_command === false)
            disabled.push('gate_command@team-asset');
        if (ef && ef.targets === false)
            disabled.push('targets@team-asset');
        if (String(process.env.GATE_ENABLED).toLowerCase() === 'false')
            disabled.push('all-gates@env');
        const evs = (batch.events ?? []);
        const escapes = evs.filter((e) => e && e.type === EVT.EVT_GATE_ESCAPE).map((e) => ({ kind: typeof e.kind === 'string' ? e.kind : null }));
        const degrades = evs.filter((e) => e && e.type === EVT.EVT_GATE_DEGRADE).map((e) => ({ kind: typeof e.kind === 'string' ? e.kind : null }));
        const outcomes = completeOutcomesOf(batch);
        return {
            level: layers.exec.length === 0 && layers.audit.length === 0 ? 'none' : 'strict',
            lanes: { plan: layers.plan.length, exec: layers.exec.length, audit: layers.audit.length },
            produceField: {
                plan: [...produceFieldsOf(layerFlow('plan'), 'plan')],
                exec: [...produceFieldsOf(layerFlow('exec'), 'exec')],
                audit: [...produceFieldsOf(layerFlow('audit'), 'audit')],
            },
            produceFieldDeclared: declaredProduce,
            entryRequires,
            consumeField: {
                exec: consumeFieldNameOf(flows, 'exec'),
                audit: consumeFieldNameOf(flows, 'audit'),
            },
            escapes,
            degrades,
            disabled,
            unwired: unwiredEntriesOf(batch),
            evaluatedAt: ['running', 'merged'],
            orphanProducts: orphanProductsOf(batch),
            emptyNoted: [],
            auditContract: null,
            completeOutcomes: outcomes,
            completeSemantics: 'Q-7：complete = 执行完成且通过验收 ⇒ 仅 pass / skip 可 complete；fail / conflict 恒拒且带 escapeRoute{phase:"aborted"}（D-8 终态可退出）',
        };
    }
    function gateStatus(sessionId, batchId, lane) {
        const batch = readBatch(sessionId, batchId);
        if (!batch) {
            if (fs.existsSync(batchFile(sessionId, batchId))) {
                return { lane, layer: null, state: null, team: null, corrupt: true, consume: [], produce: [], outputs: [], consumeMissing: [], outputsMissing: [], produceMissing: [], contractProblems: null, targets: [], targetsMissing: [], targetsUnchanged: [] };
            }
            throw new Error('batch not found: ' + batchId);
        }
        return gateStatusOfLane(sessionId, batchId, batch, lane);
    }
    function gateStatusOfLane(sessionId, batchId, batch, lane) {
        const t = taskOf(batch, lane);
        if (!t) {
            return {
                lane, layer: null, state: batch.lanes[lane], gates: 'orphan', team: batch.team,
                consume: [], produce: [], outputs: [], consumeMissing: [], outputsMissing: [], produceMissing: [],
                contractProblems: null, targets: [], targetsMissing: [], targetsUnchanged: [],
                gateStrength: gateStrengthOf(batch),
                vocabulary: vocabularyViewOf(vocabOpts),
            };
        }
        const missing = (field) => {
            const list = Array.isArray(t[field]) ? t[field] : [];
            return list.filter((p) => !presenceOfArtifact(sessionId, batchId, t.layer ?? null, p).ok);
        };
        const contract = t.layer === 'plan' ? checkPlanContract(sessionId, batchId, batch, lane) : null;
        const targets = Array.isArray(t.targets) ? [...t.targets] : [];
        const startAt = laneStartedAt(batch, lane);
        const startMs = Date.parse(startAt);
        const statFile = (p) => { try {
            const st = fs.statSync(p);
            return st.isFile() ? st : null;
        }
        catch {
            return null;
        } };
        const targetsMissing = targets.filter((p) => statFile(p) === null);
        const targetsUnchanged = targets.filter((p) => {
            if (targetsMissing.includes(p))
                return false;
            const st = statFile(p);
            if (!st)
                return true;
            const mtimeMs = new Date(st.mtime).getTime();
            return !(Number.isFinite(mtimeMs) && Number.isFinite(startMs) && mtimeMs > startMs);
        });
        return {
            lane, layer: t.layer ?? null, state: batch.lanes[lane], team: batch.team,
            gates: t.layer ? 'in-plan' : 'no-layer',
            consume: t.consume ?? [], produce: t.produce ?? [], outputs: t.outputs ?? [],
            consumeMissing: missing('consume'), outputsMissing: missing('outputs'), produceMissing: missing('produce'),
            contractProblems: contract && !contract.ok ? contract.problems : null,
            targets, targetsMissing, targetsUnchanged,
            gateStrength: gateStrengthOf(batch),
            vocabulary: vocabularyViewOf(vocabOpts),
        };
    }
    function gateStatusOfBatch(sessionId, batchId) {
        const batch = readBatch(sessionId, batchId);
        if (!batch) {
            if (fs.existsSync(batchFile(sessionId, batchId)))
                return {};
            throw new Error('batch not found: ' + batchId);
        }
        const view = {};
        for (const lane of Object.keys(batch.lanes ?? {}))
            view[lane] = gateStatusOfLane(sessionId, batchId, batch, lane);
        return view;
    }
    function gateStatusMapOfBatch(sessionId, batchId) {
        return gateStatusOfBatch(sessionId, batchId);
    }
    return { gateStrengthOf, gateStatus, gateStatusOfBatch, gateStatusMapOfBatch, gateStatusOfLane };
}
