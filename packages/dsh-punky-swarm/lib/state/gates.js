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
// Gates：Tier3 层间门禁——entry（consume 前置）/ exit（outputs/produce 前置 + Plan 契约 checkPlanContract）/ complete（audit 验收前置）
// ⚠ 本文件（`gates.ts`）与 `gates/**/*.ts` 是**手写源**；对应 `gates.js` / `gates.d.ts`（及 `gates/**` 产物）
//   由 `tsc -p tsconfig.build.json` + `scripts/copy-ts-built.mjs` 生成 ⇒ **只改 `.ts`**
//   （手改 `.js` / `.d.ts` 会被下一次构建静默回退）。
//   【2026-10-02 · 内务批 波 4 改写说明】原句为「本文件（`gates.ts`）是**唯一手写源**…只改 gates.ts」——
//   拆分后 `gates/**/*.ts` 同为手写源且同经该构建回拷，故按事实改写本段（其余注释逐字保留）。
// 纯函数闭包工厂：createGates(root) 注入 root；门禁函数签名 (sessionId, batchId, batch, lane)——batch 对象显式传入，不持有状态
// 类型化说明：wavePlan 任务属性访问经 taskOf 单点断言（findTask 保持 JS，返回 object|null → WavePlanTask，
//   断言依据：findTask 语义即"按 id 定位 buildWavePlan 持久形态任务"）；Batch/批事件判别联合收窄（零断言消解 TS2339）；
//   gate 函数返回类型沿用结构推断（消费方 store.js 等为 JS，无类型约束）——运行期语义零变更（断言纯类型层）。
// 【2026-10-02 · 内务批 波 4 · createGates 拆分】门禁各族下沉 `lib/state/gates/`（builder ← 组合器，单向依赖、零环）：
//   `detect` / `presence` / `reason-vocabulary`（模块级纯叶）· `helpers`（闭包共享辅助）· `entry` / `plan-contract` /
//   `exit` / `command` / `targets` / `complete` / `status` / `handoff`（八族 builder）。本文件保留**组合器** +
//   三个被既有**源码文本面断言**钉在本文件的构件（不得外移，撞锁即红）：
//     · `presenceJudge` —— `test/gate-hardening-red.test.js` L3：本文件内该函数的**定义**恰 1 处（`gates.js` 计数）；
//     · `reasonVocabularyVerdict` / `vocabularyViewOf` —— `test/gates-vocabulary-contract.test.js` P11：
//       `gates.js` 须含字面量 `GATE_TOKEN_UNKNOWN` / `VOCABULARY_REL`；
//     · `laneStartedAt` —— 同文件 U-2 断言：本文件内提及该时间字段的行数恰 2（锁在文件内，不得外移）。
//   三者均为「词表 / presence 判据单点 + lane 变更性基线」，与组合器职责自洽（不构成第二真源）。
// 依赖面登记（原文件头的 import 面登记注释**逐字保留**）：与仍在本文件的 import 相邻者为 isAbsPath /
//   词表读端 / EVT / 热配置四条；随消费点下沉的三条见 `gates/helpers.ts`（声明驱动 flows + team-asset 退役）、
//   `gates/detect.ts`（findTask 单点）、`gates/handoff.ts`（交接门开关唯一解析点）文件头。
import fs from 'node:fs';
import path from 'node:path';
// 单点收敛：SESSION_RE/isAbsPath 定义迁至 constants.js；isAbsPath 保持导出
// （既有消费方 import { isAbsPath } from './gates.js' 不受影响）。
import { isAbsPath } from './constants.js';
import { flowsForBatch } from '../assembly/flows.js';
// R1「契约三小件」·词表读端（exec-1 lane 交付 `lib/state/vocabulary.json` / `vocabulary.js`）。
//   本文件**只读**词表，不写、不改词表真源；判定**单点**复用 `reasonTokenKnown`（其内部 `knownOf` 是
//   gate/reason 两 kind 的唯一实现）⇒ entry 门（E1）与命令门（C3）共用同一 tokenOf，禁两套口径。
//   依赖方向：gates.ts → vocabulary.js（单向；vocabulary.js **不** import gates.ts —— 防环，其文件头明示）。
import { VOCABULARY_REL, loadVocabulary, reasonTokenKnown } from './vocabulary.js';
// 读端收敛：e.type 比较改引 EVT 常量单点（member.settled 读端）
import * as EVT from './event-types.js';
// 热配置**模块级生效快照**（未注入 readConfig 时的读端；与 `lib/hot/config-watch.js` 的 watcher 同一次写入）
import { readRuntimeSnapshot } from '../hot/config-watch.js';
export { isAbsPath };
// ── 波 4 拆分面（builder / 纯叶 / 类型单点；**单向依赖**：本文件 → 子文件，子文件不反向 import 本文件）──
import { buildHelpers } from './gates/helpers.js';
import { buildEntry } from './gates/entry.js';
import { buildPlanContract } from './gates/plan-contract.js';
import { buildExit } from './gates/exit.js';
import { buildCommand } from './gates/command.js';
import { buildTargets } from './gates/targets.js';
import { buildComplete } from './gates/complete.js';
import { buildStatus } from './gates/status.js';
import { buildHandoff } from './gates/handoff.js';
import { declaredKindOf, emptyReasonOf, substantiveContentOf, isInsideRoot } from './gates/presence.js';
import { detectReasonTokens } from './gates/reason-vocabulary.js';
// 再导出（**外部导出面逐字不变**：这些符号原本直接定义于本文件，拆分后由本文件转发）——
export { smokeOf, detectNeedHuman, detectPendingMarker, detectGate, TARGETS_CLAIMED_RE, GATE_LINE_RE, GATE_EMPTY_LINE_RE } from './gates/detect.js';
export { declaredKindOf };
// ─────────────────────────────────────────────────────────────────────────────
// R1 §2.4 #2/#5 ·「reason 词表」判据族 —— **单点实现**（entry 门 E1 与命令门 C3 共用，禁两套口径）
//   声明面（冻结，规格 §3 M-2）：产物内**行首锚定的独立行** `reason: <token>`。
//     与既有行族同构：`reason:` 类比 `gate:`（GATE_LINE_RE）/ `empty-reason:`（EMPTY_REASON_RE）/
//     `targets-claimed:`；`^reason:` **不匹配** `empty-reason:` ⇒ 既有载原因行族零误伤（逐字可机检）。
//   为什么是「独立行」而非 `t.reason`：`WavePlanTask`（`lib/types/contracts.ts`）**无 `reason` 字段**、
//     冻结面未授权新增任务字段 ⇒ 判定面落在**产物正文**（本规格 §3 M-2 冻结补全，唯一实现处 = 本处）。
//   读取纪律：与 `detectGate` / `detectNeedHuman` 同源——`produce ∪ outputs` 声明产物、缺失/空/目录跳过、
//     空 token 行不计入；**零写盘、零事件**（纯读）。
/** 词表只读视图（`gateStatusOfLane` 展示位 + 判据面自证；**零拒码、零判定**）。 */
function vocabularyViewOf(opts = {}) {
    const doc = loadVocabulary({ root: opts.root ?? null });
    if (doc.ok !== true)
        return { loaded: false, version: null, source: null };
    const meta = doc.meta;
    return {
        loaded: true,
        version: meta && typeof meta.version === 'number' ? meta.version : null,
        source: VOCABULARY_REL,
    };
}
/**
 * 词表判定（**单点**：`checkEntryGate` E1 与 `checkCommandGate` C3 同调本函数）：
 *   · 未登记 token ⇒ `ok:false` + `unknown[]` ⇒ 调用方拒 `GATE_TOKEN_UNKNOWN`（Q-3=B 的收紧面）；
 *   · 词条存在但 `enabled:false` ⇒ `restated[]`（**放行 + 告警**，禁用≠删除：既有产物仍解析通过）；
 *   · 词表不可用（缺文件 / 坏 JSON / schema 不过）⇒ **fail-open**：`ok:true` + `degrade`
 *     （`GATE_VOCAB_INVALID` 是**告警级**码，不是拒码 —— 词表损坏不得砸生产，§2.1(f)）。
 * 严格生效（U-2）：本函数**无**任何按批龄分流 / env 关阀 / 缺声明放宽分支；「存量不追溯」由词表内容
 *   承载（R1 交付形态 `entries: []` ⇒ 零 token 命中 ⇒ 零校验面），**不**由批次年龄承载。
 */
export function reasonVocabularyVerdict(artifactsDir, paths, opts = {}) {
    const root = opts.root ?? null;
    const declarations = detectReasonTokens(artifactsDir, paths);
    const doc = loadVocabulary({ root });
    if (doc.ok !== true) {
        return {
            ok: true, declarations, unknown: [], restated: [],
            degrade: {
                kind: 'vocabulary-unavailable', code: 'GATE_VOCAB_INVALID',
                problems: Array.isArray(doc.problems) ? doc.problems : [],
            },
        };
    }
    const unknown = [];
    const restated = [];
    for (const d of declarations) {
        const r = reasonTokenKnown(d.token, { root });
        if (r.known !== true) {
            unknown.push(d);
            continue;
        }
        if (r.restated === true) {
            const entry = r.entry;
            restated.push({ ...d, entryId: entry && typeof entry.id === 'string' ? entry.id : null });
        }
    }
    return { ok: unknown.length === 0, declarations, unknown, restated, degrade: null };
}
// ─────────────────────────────────────────────────────────────────────────────
// 拒绝免检（presence 硬约束）判据族 —— **唯一实现 presenceJudge**（判据同源，O-4.3）
//   mode:'declare' = 建批期静态面（P1–P5；调用点 lib/wave-plan.ts，e2 导入）
//   mode:'runtime' = 运行期含文件面（P1–P9；调用点本文件的 entry / plan / exit 三门）
// 口径：声明的产物**必须在场**（不存在 / 0 字节 / 形态不符 ⇒ 拒）；
//   空内容唯一合法通道 = 独立行 `empty-reason: <非空文本>`（有 ⇒ 放行 + 留痕；无 ⇒ 拒）。
// 两条 Leader 裁定的实现口径：
//   · R-1（声明形态二分，**按声明原文判定，禁尾斜杠规范化**）：`/` 结尾 ⇒ 目录语义（须存在且非空）；
//     不以 `/` 结尾 ⇒ 文件语义（须为非空文件；给目录 ⇒ 拒）。
//   · R-2（行首锚定，不容前导空白，与 TARGETS_CLAIMED_RE 同族 `^...$`）。
//   · O-4.2：真实 0 字节文件一律判 missing（0 字节不可能自带原因行）。
// ─────────────────────────────────────────────────────────────────────────────
/**
 * presence 判据唯一实现（判据同源：建批期 `mode:'declare'` / 运行期 `mode:'runtime'`）。
 * `abs` / `content` 只对**单件声明**有效（多件声明由调用方逐件调用，或建批期只走静态面）。
 */
export function presenceJudge(input = {}) {
    const mode = input.mode === 'declare' ? 'declare' : 'runtime';
    const layer = typeof input.layer === 'string' ? input.layer : null;
    const declaredKind = typeof input.declaredKind === 'string' ? input.declaredKind : null;
    const declaredList = Array.isArray(input.declared)
        ? input.declared.filter((p) => typeof p === 'string' && p.trim().length > 0)
        : [];
    const problems = [];
    const notes = [];
    const base = { mode, layer, declaredKind, problems, notes };
    if (declaredList.length === 0) {
        return { ...base, ok: false, path: null, kind: 'file', code: 'GATE_NO_DECLARATION', problems: ['no declared artifacts'] };
    }
    let code = null;
    let lastPath = null;
    let lastKind = 'file';
    for (const decl of declaredList) {
        const kind = declaredKindOf(decl);
        lastPath = decl;
        lastKind = kind;
        if (mode === 'declare') {
            // P2 路径契约（静态面；相对路径必须落在 plan/|exec/|audit/ 命名空间内）
            if (!isAbsPath(decl) && !/^(plan|exec|audit)\//.test(decl)) {
                problems.push(decl + ' outside layer namespace (expect plan/|exec/|audit/)');
                code = code ?? 'GATE_ARTIFACT_OUTSIDE_ROOT';
            }
            continue; // 文件面（P6–P9）只在 runtime 判（静态面拿不到文件事实）
        }
        const abs = isAbsPath(decl) ? decl : (typeof input.abs === 'string' && input.abs.length > 0 ? input.abs : null);
        if (abs === null) {
            problems.push(decl + ' missing');
            code = code ?? (kind === 'dir' ? 'GATE_ARTIFACT_NOT_A_FILE' : 'GATE_ARTIFACT_MISSING');
            continue;
        }
        if (typeof input.artifactsRoot === 'string' && !isInsideRoot(abs, input.artifactsRoot)) {
            problems.push(decl + ' outside batch artifacts root');
            code = code ?? 'GATE_ARTIFACT_OUTSIDE_ROOT';
            continue;
        }
        let st;
        try {
            st = fs.statSync(abs);
        }
        catch {
            if (kind === 'dir') {
                problems.push(decl + ' is not an existing directory');
                code = code ?? 'GATE_ARTIFACT_NOT_A_FILE';
            }
            else {
                problems.push(decl + ' missing');
                code = code ?? 'GATE_ARTIFACT_MISSING';
            }
            continue;
        }
        if (kind === 'dir') {
            // 目录语义（R-1）：声明以 `/` 结尾 ⇒ 须**存在且非空**
            if (!st.isDirectory()) {
                problems.push(decl + ' declared as directory but is not a directory');
                code = code ?? 'GATE_ARTIFACT_NOT_A_FILE';
                continue;
            }
            let entries = [];
            try {
                entries = fs.readdirSync(abs);
            }
            catch {
                entries = [];
            }
            if (entries.length === 0) {
                problems.push(decl + ' empty directory (no entries, no empty-reason)');
                code = code ?? 'GATE_ARTIFACT_EMPTY_NO_REASON';
            }
            continue;
        }
        // 文件语义（R-1）：须为**非空普通文件**；给目录 ⇒ 拒
        if (st.isDirectory()) {
            problems.push(decl + ' is a directory (declared as file)');
            code = code ?? 'GATE_ARTIFACT_NOT_A_FILE';
            continue;
        }
        if (st.size === 0) {
            problems.push(decl + ' missing');
            code = code ?? 'GATE_ARTIFACT_MISSING';
            continue;
        } // O-4.2：0 字节一律判 missing
        let text = typeof input.content === 'string' ? input.content : null;
        if (text === null) {
            try {
                text = fs.readFileSync(abs, 'utf8');
            }
            catch {
                text = null;
            }
        }
        if (text === null) {
            problems.push(decl + ' unreadable');
            code = code ?? 'GATE_ARTIFACT_MISSING';
            continue;
        }
        if (substantiveContentOf(text).trim().length === 0) {
            const reason = emptyReasonOf(text);
            if (reason !== null) {
                notes.push({ artifact: decl, reason });
                continue;
            } // 唯一空内容通道：放行 + 留痕
            problems.push(decl + ' empty and lacks an independent `empty-reason:` line with non-empty text');
            code = code ?? 'GATE_ARTIFACT_EMPTY_NO_REASON';
        }
    }
    return { ...base, ok: problems.length === 0, path: lastPath, kind: lastKind, code: problems.length ? code : null };
}
// ---- Tier3 门禁辅助 ----
// lane 变更性基线（targets 门禁基准）：events 末尾向前反查最近一条 `member.settled` 且 lane 匹配且
// to==='running' 且 **from!=='idle'** 的事件 ts（ISO）——
// · 返工（review→running）会 push 新的 running 结算事件 → 基准重置（重新计时），语义不变（test/gates.test.js O2 T8 锚）；
// · **排除 idle→running 恢复重派**（system.recovered 落 idle 后按 G-1 重派 ⇒ 基线不得后移——否则恢复后的 lane
//   因 targets 门永远判「未变更」而无法收口，与 G-1「恢复路径永不可堵」/引擎 D-8「不得出现僵局」相悖；
//   实证：gate-techdebt/e2-gov-repair 于 18:11:26.031Z idle→running 重派后基线后移，store.js mtime 17:41:06Z
// · 无可用事件 → 回退 batch.createdAt（防御；正常 merged 必有 running 事件）。遍历模式仿 store.js lastActiveAtOf。
// e.type === EVT 常量值（'member.settled'）在 BatchEvent 判别联合下收窄；兜底分支字段 unknown 与 === 比较不受影响
function laneStartedAt(batch, lane) {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i];
        if (e && e.type === EVT.EVT_MEMBER_SETTLED && e.lane === lane && e.to === 'running' && e.ts && e.from !== 'idle')
            return e.ts;
    }
    return batch.createdAt;
}
// 组合器：仅做 cx 组装 + 构建 + 导出面装配（键序与原 `return` 逐字一致 ⇒ 消费方零感知）
//   【2026-10-02 · 内务批 波 4】`createGates` 降为 ≤40 行组合器；构建序 = 依赖拓扑序
//   （builder 只定义函数、零副作用；每个 builder 返回后**立即**并入 `cx` ⇒ 后续 builder 的构建期解构可命中前序槽位）。
export function createGates(root, opts = {}) {
    const sessionsDir = path.join(root, 'sessions');
    // 【2026-09-27 · team-asset 全量退役】原「声明解析根」DI 缝（`opts.flowsRoot` → 临时包根）
    //   **已无对象**：团队资产不再被解析 ⇒ 无根可注入。签名里的 `flowsRoot` 字段**保形保留**
    //   （调用方与测试签名零变化），读端**不再消费**它，也不得据此恢复读盘。
    // R1 词表读取根（DI 缝，与 `flowsRoot` **同形**：测试可指向临时包根；生产缺省 = 包根 ⇒ 零行为变化）。
    //   存在理由：S-④ 要求「停用词条 ⇒ 既有产物解析通过 / 新写点被拒」的**两态可分**用例必须注入
    //   私有词表夹具；而交付物 `lib/state/vocabulary.json` 不得被测试污染（exec-1 同口径）。
    const vocabularyRoot = opts && typeof opts.vocabularyRoot === 'string' ? opts.vocabularyRoot : null;
    const vocabOpts = { root: vocabularyRoot };
    // 热配置读取器（`task-27`）：门开关策略**只在门禁侧解析一次**（单一解析点 `handoffGateEnabledOf`）。
    //   优先用装配点注入的 `readConfig`（工具面同源热更快照）；未注入（单测直建 store / 早期装配）⇒ 读
    //   `lib/hot/config-watch.js` 的**模块级生效快照**（与 watcher 同一次写入，非第二套读路径）；
    //   两者皆空 ⇒ 解析点顺次回落 env → 缺省关（既有行为零变化）。
    const readCfg = (opts && typeof opts.readConfig === 'function')
        ? opts.readConfig
        : () => readRuntimeSnapshot({});
    // 声明解析（【2026-09-27 · team-asset 全量退役】资产根面已不存在）：
    //   原优先级 ① 批次级 `teamsRoot`（临时团队资产）→ ② DI 缝 `flowsRoot` → ③ 包根 三态**全部作废**：
    //   团队资产不再被解析 ⇒ `flowsForBatch` 恒回「无声明」⇒ 读端一律走**引擎基线**（tighten-only 缺省）。
    //   形参 `flowsRoot` **保形保留**（DI 缝，测试签名零变化）；现已不被读，也不得据此恢复读盘。
    const flowsOf = (batch) => flowsForBatch(batch);
    // ── 波 4：闭包上下文 `cx`（每 createGates 实例一份；禁提升为模块级单例）──
    // 断言依据：`GatesCx` 的基础槽位在本语句后立即由 `Object.assign` 补齐（builder 槽位由 `assembleGates` 逐次并入）。
    const cx = {};
    Object.assign(cx, { root, sessionsDir, vocabOpts, readCfg, flowsOf, laneStartedAt, presenceJudge, reasonVocabularyVerdict, vocabularyViewOf });
    const parts = assembleGates(cx);
    // 【G-10 修复 · lane `e3-toolface`】「已声明入边」单点**透出给读端**（唯一读端 = `lib/tools/handoff-tools.js#handoff_view`）：
    //   取的是 `assembleGates` 首行 `Object.assign(cx, buildHelpers(cx))` 装进 `cx` 的**同一个函数实例**
    //   ⇒ 视图与门禁**同源**、非新增实现、非二次实例（红线 C-4：禁第二套边校验）。
    //   既有 13 键**逐字不变**（键序即对外契约）⇒ 新键**追加在末尾**。
    return { ...composeGates(parts), declaredInboundEdgesOf: cx.declaredInboundEdgesOf };
}
/** 逐 builder 构建并**立即并入 cx**（构建期解构依赖前序槽位；返回面由 {@link composeGates} 装配）。 */
function assembleGates(cx) {
    Object.assign(cx, buildHelpers(cx));
    const e = buildEntry(cx);
    Object.assign(cx, e);
    const p = buildPlanContract(cx);
    Object.assign(cx, p);
    const x = buildExit(cx);
    Object.assign(cx, x);
    const c = buildCommand(cx);
    Object.assign(cx, c);
    const t = buildTargets(cx);
    Object.assign(cx, t);
    const m = buildComplete(cx);
    Object.assign(cx, m);
    const s = buildStatus(cx);
    Object.assign(cx, s);
    const f = buildHandoff(cx);
    Object.assign(cx, f);
    return { ...e, ...p, ...x, ...c, ...t, ...m, ...s, ...f };
}
/** 导出面装配（原 `return {...}` 字面量逐字保留于下方；键序即对外契约）。 */
function composeGates(parts) {
    // TD-21 / N-13：`gateStatus`（兼容外壳）+ 两个批级入口（`gateStatusOfBatch` / `gateStatusMapOfBatch`）同面导出。
    return { checkEntryGate: parts.checkEntryGate, checkPlanContract: parts.checkPlanContract, checkExitGate: parts.checkExitGate, checkNeedHumanGate: parts.checkNeedHumanGate, checkCommandGate: parts.checkCommandGate, checkTargetsGate: parts.checkTargetsGate, checkCompleteGate: parts.checkCompleteGate, checkSettleHandoffGate: parts.checkSettleHandoffGate, gateStatus: parts.gateStatus, gateStatusOfBatch: parts.gateStatusOfBatch, gateStatusMapOfBatch: parts.gateStatusMapOfBatch, teamAssetViewOf: parts.teamAssetViewOf, presenceJudge };
}
