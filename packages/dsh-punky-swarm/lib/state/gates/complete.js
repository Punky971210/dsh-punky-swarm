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
import { taskOf, smokeOf, contractMissingPayload } from './detect.js';
export function buildComplete(cx) {
    const { completeOutcomesOf, declaredArtifactsOf, layersOf, orphanProductsOf } = cx;
    function checkCompleteGate(batch) {
        const layers = layersOf(batch);
        const smoke = smokeOf(batch);
        if (layers.exec.length === 0 && layers.audit.length === 0) {
            return {
                ok: false, code: 'GATE_COMPLETE_NO_TIER', pending: [],
                problems: ['batch has neither exec nor audit lane ⇒ 零执行零验收不得 complete（Q-6①，generic 豁免已废除）'],
            };
        }
        const laneState = (id) => batch.lanes[id];
        const allTerminal = (ids) => ids.every((id) => schema.isMemberTerminal(laneState(id)));
        if (layers.audit.length === 0)
            return { ok: false, code: 'GATE_COMPLETE_NO_AUDIT' };
        if (!allTerminal(layers.audit))
            return { ok: false, code: 'GATE_EXIT_PENDING_AUDIT', pending: layers.audit.filter((id) => !schema.isMemberTerminal(laneState(id))) };
        const outcomes = completeOutcomesOf(batch);
        const cmComplete = outcomes.source.startsWith('engine:Q-7-baseline')
            ? contractMissingPayload('complete', 'audit', outcomes.source, 'complete-outcomes-Q-7-baseline', '团队资产未声明 flows.audit.audit_contract.verdict ⇒ 引擎 Q-7 基线 {pass,skip} 接管；本事件为首触留痕，不改判定')
            : null;
        const outcomeOf = (s) => (s === 'merged' ? 'pass' : s === 'skipped' ? 'skip' : s === 'failed' ? 'fail' : s === 'conflict' ? 'conflict' : null);
        const offenders = layers.audit.filter((id) => !outcomes.values.includes(String(outcomeOf(laneState(id)))));
        if (offenders.length) {
            const emptyOutcomes = outcomes.values.length === 0;
            return {
                ok: false, code: emptyOutcomes ? 'GATE_COMPLETE_OUTCOMES_EMPTY' : 'GATE_COMPLETE_AUDIT_FAILED',
                ...(emptyOutcomes ? { declared: outcomes.declared, narrowed: outcomes.narrowed, values: outcomes.values } : {}),
                offenders: offenders.map((id) => ({ lane: id, state: laneState(id) })),
                requiredOutcomes: outcomes.values,
                narrowedOutcomes: outcomes.narrowed,
                rejectedBy: outcomes.rejectedBy,
                escapeRoute: outcomes.escapeRoute,
                completeOutcomes: outcomes,
            };
        }
        if (layers.exec.length && !allTerminal(layers.exec))
            return { ok: false, code: 'GATE_COMPLETE_EXEC_PENDING', pending: layers.exec.filter((id) => !schema.isMemberTerminal(laneState(id))) };
        const orphans = orphanProductsOf(batch);
        if (!smoke && orphans.plan.length > 0) {
            return {
                ok: false, code: 'GATE_ORPHAN_PRODUCT', orphans: orphans.plan, orphanProducts: orphans,
                problems: ['plan 层产物无任何 lane consume（悬空产物）：' + orphans.plan.join(', ')],
                escapeRoute: { phase: 'aborted', reason: '悬空产物使「plan 产物指导下游执行」不成立 ⇒ 修正 wavePlan 后重开新批，或经 batch_phase({phase:"aborted"}) 收口' },
            };
        }
        const pass = { ok: true, ...(smoke ? { smoke: true, smokeSkipped: 'complete-orphan-product' } : {}), ...(cmComplete ?? {}) };
        const degrades = [];
        if (orphans.exec.length > 0 || orphans.audit.length > 0) {
            pass.orphanProducts = orphans;
            degrades.push({ kind: 'orphan-product-nonblocking', layers: { exec: orphans.exec, audit: orphans.audit } });
        }
        const execTerminalWithoutPresence = layers.exec.filter((id) => {
            const st = laneState(id);
            if (st !== 'failed' && st !== 'skipped')
                return false;
            const t = taskOf(batch, id);
            return t ? declaredArtifactsOf(t).length > 0 : false;
        });
        if (execTerminalWithoutPresence.length > 0) {
            degrades.push({
                kind: 'exec-terminal-without-presence',
                lanes: execTerminalWithoutPresence,
                reason: 'exec lane 已终态（failed / skipped）且曾声明非空产物 ⇒ 产物义务未落地；非阻断降级留痕（不改变 complete 判定）',
            });
        }
        if (degrades.length > 0)
            pass.degrades = degrades;
        return pass;
    }
    function unwiredEntriesOf(_batch) {
        const out = [];
        out.push({
            name: 'config.ratchet', at: 'config.ratchet', status: 'wired',
            readEnd: 'lib/index.js:108-112（装配点 createStore 注入 `rules: loadRules(config)`，**整份 config** ⇒ 内部取 config.ratchet）⇒ lib/state/store.js:155（`rules ?? loadRules()`）⇒ 消费点 :331 / :462 / :690',
            consumer: '装配点 lib/index.js:108-112（rules: loadRules(config)）／读点 lib/state/store.js:155（原注 :79 为过期行号）／消费点 lib/state/store.js:331（批次迁移）· :462（成员迁移）· :690（批次阶段迁移）',
            note: '引擎级配置键（**非团队声明键**）：**已接线**（A-① 落地——注入端 lib/index.js:108-112 ⇒ 读点 store.js:155）。缺省（无 config.ratchet 键）⇒ 返回默认表且与 schema 常量**同引用**（machine-rules.js:82-84，行为零差异）；非法棘轮配置在**装配期 throw**（fail-closed，不静默回落默认规则）。本条目保留「引擎级配置键可读性」既有能力（R-14 依赖其在列）',
        });
        return out;
    }
    function teamAssetViewOf(_batch) {
        return { teamAsset: null, declaration: null, declarationMissing: true };
    }
    return { checkCompleteGate, teamAssetViewOf, unwiredEntriesOf };
}
