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
// Entry 门（派发前 consume 前置 + presence 硬约束 + 判据来源门 + 词表早期拒 + P1 交接门）——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。
import { flowOf, entryRequiresOf, globMatchesPath, ENGINE_BASELINE_CRITERIA_SECTION } from '../../assembly/flows.js';
import { taskOf, smokeOf, contractMissingPayload } from './detect.js';
import { reasonVocabularyNote } from './reason-vocabulary.js';
import { handoffGateEnabledOf } from '../../wave-plan.js';
import fs from 'node:fs';
// 产物声明路径解析单点（WD-3b）：判据源直读改走 fail-closed 解析（逃逸 ⇒ 既有 catch 记 unreadable）
import { resolveArtifactIn } from '../batch-paths.js';
export function buildEntry(cx) {
    const { artifactsDirOf, consumeArtifactsOf, consumeFieldNameOf, declaredArtifactsOf, flowsOf, handoffVerdictOf, presenceOfArtifact, readCfg, reasonVocabularyVerdict, resolveArtifact, standaloneVerdict, vocabOpts } = cx;
    // Entry Gate：exec / audit lane 派发前 consume 必须**已声明且全部在场**
    //   ① 零依赖拒派（B1）：consume 空 / 未声明 / 非数组 ⇒ 拒，**不依赖团队是否声明 entry_requires**；
    //   ② presence 硬约束：声明的上游产物必须在场（形态二分：`/` 结尾 ⇒ 目录语义，须存在且非空）；
    //   ③ audit 判据来源门（B-10）：**逐字保留**（criteria_from 锚点 + 裸标题内容面）；
    //   ④ G-1 空闲态不堵（2026-09-15 用户澄清）：lane 处于 `idle` = **字面意义的空闲态**（成员当前无在跑动作，
    //      **返工 / 续跑可调用**；进程重启也会把在途 lane 落回 idle）——此时严进不满足 ⇒ **降级为告警放行**
    //      并产 `gate.escape{kind:'idle-recovery-passthrough'}`；首次派发（pending）仍严格。
    function checkEntryGate(sessionId, batchId, batch, lane) {
        const t = taskOf(batch, lane);
        if (!t)
            return { ok: false, code: 'GATE_LANE_NOT_IN_PLAN', lane, missing: [], problems: [lane + ' not in wavePlan.tasks'] };
        // plan 层结构性无上游 ⇒ entry 豁免（B1 明示）；无 layer 的 lane 不在本门（B2 由 exit 门与 gateStatus 处置）
        if (t.layer !== 'exec' && t.layer !== 'audit')
            return { ok: true, lane };
        const flows = flowsOf(batch).flows;
        const flow = flowOf(flows, t.layer);
        // 团队声明只用于**留痕标注**，不作为「是否强制 consume」的开关（缺声明亦拒——B1 零依赖拒派）
        // G-3 修正：标注取**真实来源** `entryRequiresOf(flow).source`——显式声明过 ⇒ `team-asset:entry_requires`；
        //   缺声明/无资产 ⇒ `tighten-only-default`（引擎缺省）。该字段**只用于留痕**（不参与判定）
        //   ⇒ 值变化不改任何判定结果（正向对照见 R-06）。
        const teamNote = { requiredBy: entryRequiresOf(flow).source };
        // ── P1 交接门（**先**未交接门 **后**既有 consume 在场门；裁决 ②=A）───────────────────────────
        // 判定时机说明：本门在**本函数头部**求值一次（而非排在 smoke 分支之后），因为 `reject()` 闭包需要
        //   `handoffLegacy` 标记（存量批放行面）；smoke 豁免仍由**既有分支**在下方统一承担（`handoffLegacy`
        //   只在「无 handoffs 字段且确有 deps 入边」时为真，smoke 批在该分支直接返回 ⇒ 不进留痕面）。
        // 判据（§2/§3 单点）：入边集合 = `task.deps`；每条入边 ⇔ 一条 `batch.handoffs[lane]` 记录（submitted +
        //   artifacts 逐个在场 + contract{consumedFrom, assertions} 合规）；存量批（无该字段）⇒ 整门放行 + legacy 留痕。
        const hv = handoffGateEnabledOf(readCfg(), 'entry')
            ? handoffVerdictOf(sessionId, batchId, batch, lane, t)
            : { ok: true, legacy: false, missing: [], problems: [], pending: [] };
        const hvLegacy = hv.legacy === true;
        // B2（§8⑤ **P-1** entry_requires）：入口要求面**未声明**（`entryRequiresOf().source === 'tighten-only-default'`
        //   ⇒ 引擎缺省接管）⇒ 产首触载荷（只产不落盘）。**仅放行/降级侧**挂钩：拒侧（`!g.ok`）由写端不采
        //   （与既有「拒侧不落 escape/degrade、由其专用事件留痕」口径同构）。
        const cmEntry = entryRequiresOf(flow).source === 'tighten-only-default'
            ? contractMissingPayload('entry_requires', t.layer, entryRequiresOf(flow).source, 'entry-requires-tighten-only-default', '团队资产未声明 flows.<layer>.entry_requires ⇒ 引擎 tighten-only 缺省接管（入口 consume 强制恒生效）；本事件为首触留痕，不改判定')
            : null;
        const state = batch.lanes ? batch.lanes[lane] : null;
        const recovery = state === 'idle'; // G-1：唯一降级面（首次派发 pending 仍严格）
        const reject = (payload) => {
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
        // ── E1 词表早期拒（R1 §2.4 #5）────────────────────────────────────────────────────────────
        // 位置（冻结）：**晚于** lane 存在性（上方 `!t` 早退）与 plan 豁免（上方 `t.layer` 早退）、
        //   **早于** smoke 豁免（下方 `smokeOf(batch)`）⇒ 冒烟/探针批同样受「未登记 reason token」约束
        //   （词表面属**行为安全**面，不属产物契约豁免面）。判定与命令门 C3 **同调** `reasonVocabularyVerdict`
        //   （**同一 tokenOf 单点**，禁两套口径）。
        // 严格生效（U-2）：无按批龄分流 / 无 env 关阀；「存量不追溯」由词表内容承载（`entries: []` ⇒ 零命中）。
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
        // G2：**建批即拉起**——声明 `managerPlan: 'raise'` 的批，**首个 exec 派发前**必须已
        //   登记 Manager（`batch_phase({ manager: { agentId } })` 写批字段 `batch.manager`）。动机（用户口径）：执行模式
        //   应为「建批 → **建批即拉起 Manager** → Manager 调度、成员大规模并行（coder 施工与 tester 备测同 wave）」，
        //   而原实现只有**批次收口时的告警**（仅 exec≥3 的批；**该收口告警已删**——2026-09-22 用户裁定）⇒ 「拉起」实为自觉。
        //   此处把时序前置到**派发面**。边界：只拦 **exec** lane（plan 层的设计/计划允许先于拉起）；走 `reject()`
        //   ⇒ 自动继承 G-1「空闲态不堵」（lane 为 idle 时降级为告警放行 + 留痕）。
        // 【改造为官方 roster 承抽】
        //   **原「未拉起 Manager」硬门已删**（2026-09-21 可达性审计：**码名已字面删除**，避免 grep 误当活码）：
        //   Manager 在册判定改由**官方 roster** 承抽
        //   （读端 `lib/tools/core.js#managerRosterOf` / `managerViewOf`：`ctx.get('agentTeams')` →
        //   `listMembers(agent)`；建批期落 `gate.manager_roster_gap` 事件、`wave_plan`/`batch_status` 回显）。
        //   派发面**不再因未登记 Manager 而拒**——本 engine 层不再持有第二套「拉起」口径。
        //   下列为史迹：原实现把「建批即拉起 Manager」前置到 exec 派发面（走 `reject()` ⇒ 继承 G-1 空闲态不堵）。
        const bAsm = batch;
        void bAsm; // 保留锚点：`assembly.managerPlan` 的消费点已迁至 core.js 的 roster 承抽读端（本处不再判定）
        // gate-lite Q-G1：冒烟/探针批 ⇒ 跳过**产物契约类** entry 门（consume 在场 / audit 判据来源）。
        //   位置：Manager 拉起门**之后**（派发准入属行为安全门，一字不减）；lane 存在性门更在其前。
        if (smokeOf(batch)) {
            return { ok: true, lane, smoke: true, smokeSkipped: 'entry-consume', ...(cmEntry ?? {}), ...vocabNote };
        }
        // ── P1 交接门拒态判定（判据在函数头部求值，见 `hv`）─────────────────────────────────────────
        if (!hv.ok) {
            // 【2026-09-27 用户裁决 · 运行时回调指引】拒的同时给出「怎么做」（见 GATE_PLAN_CONTRACT 处同段说明）
            //   实证（批 onto-engine-slim-20260926）：**4 次停轮**源于「exec 线漏向聚合 audit lane 交接」
            //   ⇒ 若此处直接给出 `handoff_submit` 的正确调用形态与「含聚合 audit lane」的提醒，worker 当场可自救。
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
            // 放行侧标记：写端据此落 `lane.handoff.gap{legacy:true}` 告警（不静默、不砸存量）
            teamNote.handoffLegacy = true;
        }
        // S19①（判据同源）：被检字段名由该层 `consume_field` 声明决定（缺声明/越界 ⇒ 回落 'consume'）
        const consume = consumeArtifactsOf(t, consumeFieldNameOf(flows, t.layer));
        if (consume.length === 0) {
            const s = standaloneVerdict(batch, t);
            if (s.ok)
                return { ok: true, lane, standalone: true, escape: { kind: 'standalone', lane, reason: s.reason }, ...teamNote, ...(cmEntry ?? {}), ...vocabNote };
            if (s.declared) {
                return reject({ code: 'GATE_STANDALONE_UNJUSTIFIED', missing: [], problems: [lane + ': standalone 声明不成立（须布尔 true + 非空 standaloneReason + 批次内确实无可用上游）'] });
            }
            return reject({ code: 'GATE_ENTRY_MISSING', missing: [], problems: [lane + ': no consume declared（B1 零依赖拒派）'] });
        }
        const failed = [];
        const shapeProblems = [];
        for (const p of consume) {
            const v = presenceOfArtifact(sessionId, batchId, t.layer, p);
            if (!v.ok) {
                failed.push(p);
                for (const pr of v.problems)
                    shapeProblems.push(pr);
            }
        }
        if (failed.length) {
            // 【2026-09-27 用户裁决 · 运行时回调指引】拒的同时给出「怎么做」（同 GATE_PLAN_CONTRACT 段说明）
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
        // P1 内容面（**全局生效**）：**audit 的判据来源内容校验**——其 `consume` 中的
        //   plan 层产物至少有一份正文含裸标题行 `## 验收标准`（与 `GATE_PLAN_CONTRACT` 同判据）；否则拒派
        //   `GATE_AUDIT_CRITERIA_MISSING`。建批期已锚定「存在 plan 产物」；本层补「该产物真的带验收标准」——
        //   路径锚上而内容是空壳/跑题 ⇒ audit 仍无标准可依（长跑根因 R1 的另一半）。
        if (t.layer === 'audit') {
            const planProducts = new Set();
            for (const w of batch.wavePlan ?? []) {
                for (const x of w.tasks ?? []) {
                    if (x.layer !== 'plan')
                        continue;
                    for (const p of [...(x.produce ?? []), ...(x.outputs ?? [])])
                        planProducts.add(p);
                }
            }
            const isPlanProduct = (p) => (typeof p === 'string' && p.startsWith('plan/')) || planProducts.has(p);
            // A 方案（2026-09-14）：`criteria_from` **接消费**——声明存在时按其 glob **指名**锚点产物；
            //   缺省 → 回落既有口径（consume 中的 plan 层产物任一）。指名可消除「多份 plan 产物时判错对象」的隐患。
            const ac = flow?.audit_contract ?? null;
            const criteriaFrom = ac && typeof ac.criteria_from === 'string' && ac.criteria_from.trim() ? ac.criteria_from.trim() : null;
            const anchors = criteriaFrom
                ? consume.filter((p) => globMatchesPath(criteriaFrom, p))
                : consume.filter((p) => isPlanProduct(p));
            if (anchors.length === 0) {
                return reject({ code: 'GATE_AUDIT_INPUT_MISSING', problems: consume, ...(criteriaFrom ? { criteriaFrom } : {}) });
            }
            // ── 判据章节名（**配置化**，2026-09-21 用户裁定「判据改为全中文，且配置化」）──────────────
            //   取值优先序：① `flow.audit_contract.criteria_section`（声明面，本轮新增键）
            //             ② 回落引擎基线 `ENGINE_BASELINE_CRITERIA_SECTION`（全中文，单一真源）
            //   ⇒ 规格与判据解耦：团队若用英文章节名（如 `## Acceptance Criteria`），声明即可，代码零改动。
            const criteriaSection = ac && typeof ac.criteria_section === 'string' && ac.criteria_section.trim()
                ? ac.criteria_section.trim()
                : ENGINE_BASELINE_CRITERIA_SECTION;
            const problems = [];
            let okAnchor = false;
            for (const p of anchors) {
                try {
                    if (fs.readFileSync(resolveArtifactIn(artifactsDirOf(sessionId, batchId), p), 'utf8').includes(criteriaSection)) {
                        okAnchor = true;
                        break;
                    }
                    problems.push(p + ' lacks "' + criteriaSection + '"');
                }
                catch {
                    problems.push(p + ' unreadable');
                }
            }
            if (!okAnchor) {
                // 【2026-09-27 用户裁决 · 运行时回调指引】拒的同时给出「怎么做」（同 GATE_PLAN_CONTRACT 段说明）
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
        // 放行侧回传（P1 交接门）：`handoffLegacy` = 存量批标记——写端（`store.setMember`）据此落
        //   `lane.handoff.gap{legacy:true}` 告警（不静默、不砸存量）。**仅新增本键**：其余放行载荷逐字不变。
        // R1 词表 E1 放行侧载荷（`vocabNote`）：`{}` = 零感知；有停用词条命中 ⇒ `escapes[{kind:'vocabulary-restated'}]`；
        //   词表不可用 ⇒ `escapes[{kind:'vocabulary-unavailable'}]` + `vocabCode:'GATE_VOCAB_INVALID'`（告警级，不拒批）。
        //   形态为 `escapes[]` **多值通道** ⇒ 与其它分支自带的单值 `escape`（`standalone` / `idle-recovery-passthrough`）
        //   互不覆盖：两态可同时成立且各自可归因（写端消费两者）。
        return { ok: true, lane, handoffLegacy: hvLegacy, ...(cmEntry ?? {}), ...vocabNote };
    }
    return { checkEntryGate };
}
