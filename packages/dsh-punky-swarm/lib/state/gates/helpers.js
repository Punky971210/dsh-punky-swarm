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
// 门禁共享辅助（路径解析 / 产物清单 / 层划分 / 交接判据）——
//   `laneStartedAt` 不在本文件：它被源码文本面断言钉在 `gates.ts`（`batch.createdAt` 恰 2 行）。
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。
import { SESSION_RE, isAbsPath } from '../constants.js';
// 声明驱动：层语义（产物字段 / 入口要求 / 内容契约）改从团队声明读取——缺声明走**引擎基线**常量/缺省
//   （tighten-only；legacy-retire-20260915 清退后无 LEGACY_* 回落层）
// gate-techdebt 新增读端（G-2 / G-3 / S19①）：`entryRequiresOf`（入口要求的**真实来源**）/
//   `consumeFieldOf`（consume 字段名读端）/ `declarationSummaryOf`（声明面可读汇总，含**未接线台账**）——
//   三者均**只读复用** flows.js，不改该文件；`requiredBy` 标注取 `entryRequiresOf(flow).source`（G-3 修正）。
// 【2026-09-27 · team-asset 全量退役】原资产读端 import（装载器 + 未接线声明台账常量）**整体删除**：
//   flows / roles 面只走**引擎基线** ⇒ 本文件不再读任何团队资产（A-5 判据：import 面归零）。
import { flowOf, consumeFieldOf } from '../../assembly/flows.js';
import fs from 'node:fs';
import path from 'node:path';
export function buildHelpers(cx) {
    const { flowsOf, presenceJudge, sessionsDir } = cx;
    function sessionDir(sessionId) {
        if (!SESSION_RE.test(sessionId))
            throw new Error('invalid sessionId: ' + sessionId);
        return path.join(sessionsDir, sessionId);
    }
    function artifactsDirOf(sessionId, batchId) {
        return path.join(sessionDir(sessionId), 'artifacts', batchId);
    }
    function batchFile(sessionId, batchId) {
        if (!SESSION_RE.test(batchId))
            throw new Error('invalid batchId');
        return path.join(sessionDir(sessionId), 'batches', batchId + '.json');
    }
    function readBatch(sessionId, batchId) {
        const file = batchFile(sessionId, batchId);
        if (!fs.existsSync(file))
            return null;
        try {
            // 单点断言：批次 JSON 由 store.createBatch 写入（Batch 契约同源形态），JSON.parse 产物断言为 Batch
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        catch {
            // 损坏批次隔离：读路径不 throw——损坏 → null（登记在 store 旁路清单，本文件不重复）
            return null;
        }
    }
    function resolveArtifact(sessionId, batchId, rel) {
        return isAbsPath(rel) ? rel : path.join(artifactsDirOf(sessionId, batchId), rel);
    }
    // 退休（r2 拒绝免检）：原 `fileExistsNonEmpty`（`isDirectory() || size>0`）已被 `presenceJudge`
    //   （声明形态二分 + 0 字节判 missing + 空内容须载原因）整体取代；保留同名判据即构成「两套逻辑」
    //   （O-4.3 判据同源禁止），故随本批删除——门禁与 `gateStatus` 面板一律走 `presenceJudge`。
    // ── 拒绝免检辅助（三层门禁共用单点）──
    // 被检面 = produce ∪ outputs（去重保序；`produce_field` 降为信息性字段，S8）
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
    // consume 检面（S19① **判据同源**）：字段名由 `consumeFieldOf(flow, layer)` 决定——缺声明回落 `'consume'`、
    //   白名单外（`team-asset.js` CONSUME_FIELDS）**回落 + 问题可读**；同一个字段名同时用于 **entry 检面**与
    //   `gateStrength.consumeField`（禁第二套逻辑）。缺 flow（无声明 / 层缺失）⇒ `'consume'`。
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
    // 批次三层 lane 划分（B2 / B3 与 gateStrength 共用单点）
    function layersOf(batch) {
        const layers = { plan: [], exec: [], audit: [] };
        for (const w of batch.wavePlan ?? [])
            for (const t of w.tasks ?? [])
                if (t && t.layer && layers[t.layer])
                    layers[t.layer].push(t.id);
        return layers;
    }
    // A1 悬空产物（纯读 wavePlan，不读正文）：plan 悬空 ⇒ 拒；exec / audit 悬空 ⇒ 强告警 + 可见（有意不对称）
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
                // 判据同源（S19①）：被消费面同样按该层声明的 consume 字段名读（缺声明 ⇒ 'consume'）
                for (const c of consumeArtifactsOf(t, consumeFieldNameOf(flows, t.layer ?? null)))
                    consumed.add(c);
            }
        const orphansOf = (layer) => declared[layer].filter((p) => !consumed.has(p));
        return { plan: orphansOf('plan'), exec: orphansOf('exec'), audit: orphansOf('audit') };
    }
    // complete = 执行完成**且通过验收** ⇒ 有效白名单 = 声明 ∩ {pass, skip}；fail / conflict 恒拒
    function completeOutcomesOf(batch) {
        const af = flowOf(flowsOf(batch).flows, 'audit');
        const verdict = af && af.audit_contract && Array.isArray(af.audit_contract.verdict) && af.audit_contract.verdict.length > 0
            ? af.audit_contract.verdict : null;
        // E-4（legacy-retire-20260915）：`flows.complete.require_audit_outcomes` 双键回落已清退——
        //   complete 白名单**唯一声明真源** = verdict；缺声明 ⇒ 引擎基线 ['pass','skip']（零差异：
        //   四内置资产均声明 verdict，清退前实测不回落）。声明废键不产生任何门禁效果（正向清退断言锚定）。
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
    // standalone 逃生阀（B4）：显式授权 + 事实核验 + 留痕；自声明不足以放行
    //   返回 declared=false 表示「根本未声明 standalone」⇒ 按缺声明拒（B1），不套用 standalone 码。
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
    // 单件产物 presence 复核（运行期；判据同源 presenceJudge）
    function presenceOfArtifact(sessionId, batchId, layer, p) {
        return presenceJudge({
            mode: 'runtime', layer, declared: [p], declaredKind: 'array',
            abs: resolveArtifact(sessionId, batchId, p), artifactsRoot: artifactsDirOf(sessionId, batchId),
        });
    }
    // ── P1 交接门（handoff gate，2026-09-17）单点判定辅助 ───────────────────────────────────────
    // 判据（`p1-handoff-gate-changeplan-20260917`（原文档未随仓分发） §2/§3，**单点**：只在本函数判，禁第二处）：
    //   · 入边集合 = `task.deps`（DAG 入边，**每条入边 ⇔ 一条** `batch.handoffs[lane]` 记录）；
    //   · 每条记录须 `status:'submitted'` + `artifacts[]` 非空且**逐个存在** + `contract` 合规
    //     （`consumedFrom` 指回该入边 + `assertions[]` 非空字符串数组）；
    //   · **存量批**（`batch.handoffs === undefined`）⇒ 整门放行 + `legacy:true`（留痕由调用侧承担）；
    //   · **裁决 ②=A 的建批期判据**：`handoffs` 字段存在但**该入边的声明条目缺失**（= 建批期种条的来源没了）⇒ 拒。
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
    // ── 交接判据的**单点实现** ────────────────────────────────────────
    // 纪律（用户裁决）：「**复用**，禁在出口门里再写一遍判定逻辑」——故把「一条交接记录是否成立」抽成本函数，
    //   **entry 门（`handoffVerdictOf`）与出口门（`checkSettleHandoffGate`）两处都调它**。
    //   抽取面 = **单条记录的成立性**（status / artifacts 逐个在场 / contract{consumedFrom,assertions}）；
    //   两侧各自负责**集合语义**（entry = 每条 deps 入边都要成立；出口 = 至少一条 out 边成立）——
    //   集合语义不可共用（方向与量词都不同），但**判据标准单点**由此成立，不会漂移。
    //   `layer` 传入被检 lane 的 layer（产物在场判据按产品根解析，与 entry 门同源）。
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
        const deps = depsOf(t);
        const map = batch.handoffs;
        if (deps.length === 0)
            return { ok: true, legacy: false, missing: [], problems: [], pending: [] };
        // 存量批（无 `handoffs` 字段）⇒ 不受新门约束：放行 + 留痕（调用侧落 `lane.handoff.gap`）
        if (map === undefined || map === null)
            return { ok: true, legacy: true, missing: [], problems: [], pending: [] };
        const byTo = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
        const list = Array.isArray(byTo[lane]) ? byTo[lane] : [];
        const records = list.filter((r) => !!r && typeof r === 'object' && !Array.isArray(r));
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
    return { sessionDir, artifactsDirOf, batchFile, readBatch, resolveArtifact, declaredArtifactsOf, consumeFieldNameOf, consumeArtifactsOf, layersOf, orphanProductsOf, completeOutcomesOf, standaloneVerdict, presenceOfArtifact, depsOf, handoffRecordVerdict, handoffVerdictOf };
}
