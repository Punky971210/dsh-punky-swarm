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
import { flowOf, contractOf, sectionProblemsOf, ENGINE_BASELINE_PLAN_SECTIONS } from '../../assembly/flows.js';
import { taskOf, smokeOf, contractMissingPayload, detectPendingMarker } from './detect.js';
import { sectionLineHit, elementLineHit } from './presence.js';
import fs from 'node:fs';
import { resolveArtifactIn } from '../batch-paths.js';
export function buildPlanContract(cx) {
    const { artifactsDirOf, declaredArtifactsOf, flowsOf, presenceJudge, resolveArtifact } = cx;
    function checkPlanContract(sessionId, batchId, batch, lane) {
        const t = taskOf(batch, lane);
        if (!t)
            return { ok: false, code: 'GATE_LANE_NOT_IN_PLAN', lane, problems: [lane + ' not in wavePlan.tasks'], missing: [] };
        if (t.layer !== 'plan')
            return { ok: true, lane };
        if (smokeOf(batch))
            return { ok: true, lane, smoke: true, smokeSkipped: 'plan-contract' };
        const declared = declaredArtifactsOf(t);
        if (declared.length === 0) {
            return { ok: false, code: 'GATE_PLAN_NO_DECLARATION', lane, problems: [lane + ': no produce/outputs declared'], missing: [] };
        }
        const contract = contractOf(flowOf(flowsOf(batch).flows, 'plan'));
        const cmContract = contract === null
            ? contractMissingPayload('contract', 'plan', 'engine:ENGINE_BASELINE_PLAN_SECTIONS', 'plan-contract-engine-baseline', '团队资产未声明 flows.plan.contract ⇒ 引擎基线判据（' + ENGINE_BASELINE_PLAN_SECTIONS.join(' / ') + '）接管；本事件为首触留痕，不改判定')
            : null;
        const requiredSections = contract && Array.isArray(contract.required_sections) && contract.required_sections.length > 0
            ? contract.required_sections : ENGINE_BASELINE_PLAN_SECTIONS;
        const declaredElements = contract && Array.isArray(contract.elements)
            ? contract.elements.filter((x) => typeof x === 'string' && x.trim().length > 0)
            : [];
        const declaredSubsections = (() => {
            const s = contract ? contract.subsections : null;
            if (Array.isArray(s))
                return s.filter((x) => typeof x === 'string' && x.trim().length > 0);
            if (s !== null && typeof s === 'object')
                return Object.keys(s).filter((k) => k.trim().length > 0);
            return [];
        })();
        const problems = [];
        const notes = [];
        let present = 0;
        let criteriaHit = false;
        for (const p of declared) {
            const abs = resolveArtifact(sessionId, batchId, p);
            const v = presenceJudge({
                mode: 'runtime', layer: 'plan', declared: [p], declaredKind: 'array',
                abs, artifactsRoot: artifactsDirOf(sessionId, batchId),
            });
            if (!v.ok) {
                for (const prob of v.problems)
                    problems.push(prob);
                continue;
            }
            present += 1;
            for (const n of v.notes)
                notes.push(n);
            if (v.notes.length > 0) {
                criteriaHit = true;
                continue;
            }
            let content = '';
            try {
                content = fs.readFileSync(abs, 'utf8');
            }
            catch {
                problems.push(p + ' unreadable');
                continue;
            }
            // R-1（批 `punky-gate-fix` / lane `e2-plan-tighten`；判据源 §修复 3 · AC-9）：
            //   六裸标题**全需**。修前为 `requiredSections.some(...)` ⇒ **六缺五也放行**（fail-open），
            //   且 `*spec.md` 另有一条 `content.includes(s)` 的**子串特权**分支（`### 概述` / ` ## 概述` /
            //   `> ## 概述` / 围栏内标题皆算命中）。现两处统一为 `sectionLineHit`（行首锚 + 整行 + 尾随空白
            //   容忍，`presence.js:37-42` 的**匹配器本体不改**），特权分支整块删除。
            //   `sectionsMissed.length === 0` ≡ 原语 `requiredSections.every((s) => sectionLineHit(content, s))`
            //   ——单遍求值即可同时供判定与逐章诊断，不重复跑正则。
            const sectionsMissed = requiredSections.filter((s) => !sectionLineHit(content, s));
            if (sectionsMissed.length === 0)
                criteriaHit = true;
            else if (!contract && p.endsWith('.md')) {
                // 逐章诊断：无团队契约声明时（生产常态 —— `flows.js:54-65` 硬编码 `flows:null`
                // ⇒ 上文 `contract` 恒为 `null`）由本处点名缺哪几章。
                // 契约在场时逐章诊断已由 `sectionProblemsOf`（`flows.js:308-315`）承担，此处不重复报。
                //
                // **口径收紧到 `.md`（有意，非疏漏）**：六裸标题是 **Markdown 标题**规格，只对**判据源/文档类**
                // 产物成立。数据件（`*.json` / `*.txt` / …）若也逐章报缺，会把「合规 md 判据源 + 合法 json 数据件」
                // 这种正常声明组合打成拒（`punky-gate-fix/e2-plan-tighten/probe/probe-overreach.mjs` 的 B/C 例实测），
                // 属**超出 AC-9 的打回面扩张**。非 .md 件仍受各自专项检查（`.json` ⇒ 下文 `JSON.parse`）。
                for (const s of sectionsMissed)
                    problems.push(p + ' lacks "' + s + '"');
            }
            if (contract) {
                for (const prob of sectionProblemsOf(p, content, contract))
                    problems.push(prob);
                for (const el of declaredElements) {
                    if (!elementLineHit(content, el))
                        problems.push(p + ' lacks element "' + el + '"');
                }
                for (const ss of declaredSubsections) {
                    if (!sectionLineHit(content, ss))
                        problems.push(p + ' lacks subsection "' + ss + '"');
                }
            }
            if (p.endsWith('.json')) {
                try {
                    JSON.parse(content);
                }
                catch {
                    problems.push(p + ' invalid JSON');
                }
            }
        }
        if (present > 0 && !criteriaHit)
            problems.push(lane + ': no plan artifact carries a criteria section (' + requiredSections.join(' / ') + ')');
        if (problems.length) {
            problems.push('【怎么做】plan 产物正文须含六个【裸标题】（行首恰为该串，非 `###`、无缩进/前缀）：'
                + '`## 概述` / `## 问题` / `## 方案` / `## 需求` / `## 验收标准` / `## 约束`'
                + ' —— **内容允许为空，标题一个都不能缺**（本门只校标题在场，不校内容）。'
                + ' 改完产物后重跑即可；若是交接后才补，重新 `handoff_submit` 该边。');
            return { ok: false, code: 'GATE_PLAN_CONTRACT', lane, problems, missing: [] };
        }
        const markerLiteral = (() => {
            const pm = contract ? contract.pending_marker : null;
            if (pm === null || typeof pm !== 'object')
                return null;
            const lit = pm.literal;
            return typeof lit === 'string' && lit.length > 0 ? lit : null;
        })();
        if (markerLiteral !== null && t.layer === 'plan') {
            for (const p of declared) {
                let abs;
                try {
                    abs = resolveArtifactIn(artifactsDirOf(sessionId, batchId), p);
                }
                catch {
                    continue;
                }
                let content = '';
                try {
                    const st = fs.statSync(abs);
                    if (st.isDirectory() || st.size === 0)
                        continue;
                    content = fs.readFileSync(abs, 'utf8');
                }
                catch {
                    continue;
                }
                const pm = detectPendingMarker(content, markerLiteral);
                if (pm.declared) {
                    return {
                        ok: false, code: 'GATE_NEEDHUMAN_PENDING', lane, missing: [],
                        problems: [p + ' contains pending marker ' + JSON.stringify(markerLiteral)],
                        pendingMarker: { path: p, index: pm.index },
                        message: 'plan lane 产物含人工待确认字面量 ' + JSON.stringify(markerLiteral)
                            + '（团队资产 `flows.plan.contract.pending_marker` 声明位生效）⇒ 须人工裁决后再 merged'
                            + '（复用既有 GATE_NEEDHUMAN_PENDING，不造新码）',
                    };
                }
            }
        }
        const pass = { ok: true, lane, ...(cmContract ?? {}) };
        if (notes.length) {
            pass.escapes = notes.map((n) => ({ kind: 'empty-artifact-noted', artifact: n.artifact, reason: n.reason }));
            pass.escape = pass.escapes[0];
            pass.emptyNoted = notes;
        }
        return pass;
    }
    return { checkPlanContract };
}
