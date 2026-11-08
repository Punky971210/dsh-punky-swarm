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
import { flowOf, enabledByFlag, flagOf } from '../../assembly/flows.js';
import { taskOf, smokeOf, contractMissingPayload, TARGETS_CLAIMED_RE } from './detect.js';
import fs from 'node:fs';
export function buildTargets(cx) {
    const { flowsOf, laneStartedAt } = cx;
    function checkTargetsGate(sessionId, batchId, batch, lane) {
        if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') {
            return {
                ok: true, declared: false,
                escape: {
                    kind: 'env-gate-disabled', gate: 'targets', lane,
                    reason: 'GATE_ENABLED=false（应急逃生阀）⇒ targets 门零感知放行（判定不变）＋留痕',
                },
            };
        }
        const t = taskOf(batch, lane);
        if (!t || t.layer !== 'exec' || !Array.isArray(t.targets) || t.targets.length === 0) {
            return { ok: true, declared: false };
        }
        if (smokeOf(batch))
            return { ok: true, declared: false, disabledBy: 'batch:smoke' };
        const efTargets = flowOf(flowsOf(batch).flows, 'exec');
        const cmTargets = flagOf(efTargets, 'targets') === null
            ? contractMissingPayload('targets', 'exec', 'engine:enabledByFlag(targets,true)', 'targets-engine-default-enabled', '团队资产未声明 flows.exec.targets ⇒ 引擎基线启用（缺声明不得放宽）；本事件为首触留痕，不改判定')
            : null;
        if (!enabledByFlag(efTargets, 'targets', true)) {
            return {
                ok: true, declared: false, disabledBy: 'team-asset:targets',
                escape: {
                    kind: 'targets-off', lane,
                    reason: '团队资产显式声明 flows.exec.targets=false ⇒ targets 门停用（放行判定不变）＋留痕',
                },
            };
        }
        const startAt = laneStartedAt(batch, lane);
        const startMs = Date.parse(startAt);
        const markerMode = (typeof t.targetsMarker === 'string' && t.targetsMarker.length > 0)
            || String(process.env.GATE_TARGETS_MODE).toLowerCase() === 'marker';
        const noChange = t.targetsNoChange === true;
        const modeOf = () => (noChange ? 'no-change' : (markerMode ? 'marker' : 'mtime'));
        const missing = [];
        const unchanged = [];
        for (const target of t.targets) {
            let st;
            try {
                st = fs.statSync(target);
            }
            catch {
                missing.push(target);
                continue;
            }
            if (!st.isFile()) {
                missing.push(target);
                continue;
            }
            if (markerMode) {
                let claimed = false;
                try {
                    claimed = TARGETS_CLAIMED_RE.test(fs.readFileSync(target, 'utf8'));
                }
                catch { }
                if (claimed)
                    continue;
                unchanged.push(target);
                continue;
            }
            if (noChange)
                continue;
            const mtimeMs = new Date(st.mtime).getTime();
            if (!(Number.isFinite(mtimeMs) && Number.isFinite(startMs) && mtimeMs > startMs))
                unchanged.push(target);
        }
        if (missing.length > 0) {
            return { ok: false, declared: true, code: 'GATE_TARGET_MISSING', missing, unchanged: [], mode: modeOf(), targets: [...t.targets] };
        }
        if (unchanged.length > 0) {
            return { ok: false, declared: true, code: 'GATE_TARGET_UNCHANGED', missing: [], unchanged, mode: modeOf(), targets: [...t.targets] };
        }
        return { ok: true, declared: true, missing: [], unchanged: [], mode: modeOf(), skippedChange: noChange, targets: [...t.targets], ...(cmTargets ?? {}) };
    }
    return { checkTargetsGate };
}
