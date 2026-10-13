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
// 命令门（`gate: <命令>` 确定性执行 + 退出码判定）+ cwd 解析——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。
import { runCommand } from '../command-exec.js';
import { flowOf, enabledByFlag, flagOf } from '../../assembly/flows.js';
import { taskOf, contractMissingPayload, detectNeedHuman, detectGate, detectGateOff, detectScriptAnchors, scriptTokensOf, normalizeScriptKey } from './detect.js';
import { reasonVocabularyNote } from './reason-vocabulary.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export function buildCommand(cx) {
    const { artifactsDirOf, flowsOf, reasonVocabularyVerdict, sessionDir, vocabOpts } = cx;
    // 命令 gate（V1）：exec 层产物声明行 `gate: <命令>` → merged 前置确定性执行 → 退出码判定
    // 签名与既有门禁一致（batch 显式传入，不持有状态）；执行器经 deps.runCommand 注入（DI，默认真实执行器，测试可注入 mock）
    // cwd 契约：lane worktree 根（若已建）→ GATE_REPO_ROOT（批次 repo 根配置，V1 env 注入）→ artifacts 根兜底
    // ⚠ 单点：解析根**只有这一处**（下方 `commandCwd` 即 `commandRoots().cwd`）。L8 的脚本候选解析与
    //   位置告警**同源复用**本函数（禁第二套 cwd 解析；否则同一批产物两处根不同 ⇒ 锚定永不命中）。
    function commandRoots(sessionId, batchId, lane) {
        const wt = path.join(sessionDir(sessionId), 'worktrees', batchId, lane);
        let cwd = null;
        try {
            if (fs.statSync(wt).isDirectory())
                cwd = wt;
        }
        catch { /* 未建 worktree，继续 */ }
        const repoRoot = process.env.GATE_REPO_ROOT;
        if (cwd === null && repoRoot) {
            try {
                if (fs.statSync(repoRoot).isDirectory())
                    cwd = repoRoot;
            }
            catch { /* 无效则跳过 */ }
        }
        return { laneRoot: wt, artifactsDir: artifactsDirOf(sessionId, batchId), cwd: cwd ?? artifactsDirOf(sessionId, batchId) };
    }
    function commandCwd(sessionId, batchId, lane) {
        return commandRoots(sessionId, batchId, lane).cwd;
    }
    // ── L8 判据脚本信任锚（2026-10-13 · 批 `punky-spec-adopt-p2-20261013`）判定面 ─────────────────────
    // 位置：**执行命令之前**的预扫（先扫全部 `gate:` 命令的脚本候选，再进执行循环）——因采预扫，
    //   锚定不符时**零命令被执行**（避免「首条已跑、次条才拒」的部分执行副作用）。
    // 三态（冻结）：有锚定且不符 ⇒ 拒 `GATE_SCRIPT_CHANGED`｜无锚定 ⇒ 告警 + 放行（零回归）｜
    //   脚本落在 lane worktree / 产物根内 ⇒ 告警（**位置缺口降级**：全仓无引擎强制的 lane 写域 ⇒
    //   「必须在 X 之外」没有可判的 X，硬凑只会得到可绕过的假约束）。
    const sha256OfFile = (file) => {
        try {
            return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
        catch {
            return null;
        }
    };
    const isInsideDir = (child, parent) => {
        const rel = path.relative(parent, child);
        return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    // 告警通道选择（**互斥使用**）：恰 1 条 ⇒ 单值 `escape`（冻结声明形态逐字点名 `escape{kind:…}`）；
    //   ≥2 条 ⇒ `escapes[]` 多值通道（与 `reason-vocabulary` 同一通道）。**二者不并用**——
    //   `lib/state/store/events.js:50-53#gateEscapeEvents` 把 `escape` 与 `escapes[]` **合并**成事件清单
    //   ⇒ 并用即同一事实**双事件**（留痕重复）。
    function escapeWarnings(list) {
        if (list.length === 0)
            return {};
        return list.length === 1 ? { escape: list[0] } : { escapes: list };
    }
    // ① 候选抽取（**纯 fs 探测**）：命令中「在解析根下确实存在的普通文件」token。
    //    无候选 ⇒ 调用方**不读**锚定文件 ⇒ 无脚本命令（`node -e '…'`）**零额外 IO、零感知**。
    function scriptCandidatesOf(commands, roots) {
        const candidates = [];
        for (const command of commands) {
            for (const token of scriptTokensOf(command)) {
                const abs = path.resolve(roots.cwd, token);
                let st;
                try {
                    st = fs.statSync(abs);
                }
                catch {
                    continue;
                }
                if (!st.isFile())
                    continue;
                // 候选**限于解析根内**（⇒ 键恒为根相对路径，与锚定声明的 `<相对路径>` 同口径；
                //   根外工具链（PATH 可执行、根外绝对路径）不进锚定面 ⇒ 不误报「无锚定」）。
                if (!isInsideDir(abs, roots.cwd))
                    continue;
                const key = normalizeScriptKey(path.relative(roots.cwd, abs));
                if (key.length === 0)
                    continue;
                if (!candidates.some((c) => c.abs === abs))
                    candidates.push({ command, key, abs });
            }
        }
        return candidates;
    }
    // ② 位置告警 + ③ 锚定比对（三态：拒 / 告警+放行 / 零感知）
    function scriptAnchorVerdict(candidates, roots, anchors, anchorPath) {
        const warnings = [];
        let reject = null;
        // 位置告警（**独立于锚定**：脚本落在被检方自身可写的根内 ⇒ 位置缺口可观测、降级不拒）
        for (const c of candidates) {
            if (isInsideDir(c.abs, roots.laneRoot) || isInsideDir(c.abs, roots.artifactsDir)) {
                warnings.push({
                    kind: 'gate-script-lane-local', gate: 'command', path: c.key,
                    reason: '被引用脚本落在 lane worktree / 产物根内（位置缺口：该根由被检方自身可写）⇒ 降级为告警，不拒',
                });
            }
        }
        // 锚定比对（有锚定且不符 ⇒ 拒；无锚定 ⇒ 告警 + 放行）
        for (const c of candidates) {
            const declared = anchors[c.key];
            if (declared === undefined) {
                warnings.push({
                    kind: 'gate-script-unanchored', gate: 'command', path: c.key,
                    reason: '被引用脚本无 `gate-script-sha256:` 锚定声明 ⇒ 内容不可判（告警 + 放行；存量产物零回归）',
                });
                continue;
            }
            const actual = sha256OfFile(c.abs);
            if (actual === null) {
                // 读不到 ⇒ 无法证实（唯一可达路径 = stat 成功后读失败/竞态删除）⇒ fail-open + **显式告警**留痕；
                //   不为它新造第二枚拒码（本批冻结「仅 1 枚新码」）⇒ 登记于 exec 产物「残余开口」。
                warnings.push({
                    kind: 'gate-script-unhashed', gate: 'command', path: c.key,
                    reason: '脚本可 stat 但内容不可读（哈希不可得）⇒ 无法比对，告警 + 放行',
                });
                continue;
            }
            if (actual !== declared) {
                reject = {
                    code: 'GATE_SCRIPT_CHANGED', command: c.command, exitCode: null,
                    script: c.key, expected: declared, actual, anchorPath,
                    detail: '脚本内容与锚定不符：' + c.key + ' 声明 ' + declared.slice(0, 12) + '… 实得 ' + actual.slice(0, 12)
                        + '…（脚本自声明之后被改）⇒ 拒（命令门不得被自我满足）',
                    problems: ['gate-script-sha256 mismatch: ' + c.key],
                };
                break;
            }
        }
        return { warnings, reject };
    }
    function checkCommandGate(sessionId, batchId, batch, lane, deps = {}) {
        // 总开关（GATE_ENABLED=false → 全部零感知，应急逃生阀）
        // S15（本批）：env 阀**保留**（应急必需），但命中时补 `escape{kind:'env-gate-disabled', gate:'command'}`
        //   载荷留痕（原留痕只在 `lib/index.js:117-119` 启动级 warn，🔴 域外不可改）⇒ 从启动日志升级为批次事件。
        if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') {
            return {
                ok: true, declared: false,
                escape: {
                    kind: 'env-gate-disabled', gate: 'command', lane,
                    reason: 'GATE_ENABLED=false（应急逃生阀）⇒ 命令门零感知放行（判定不变）＋留痕',
                },
            };
        }
        const t = taskOf(batch, lane);
        // S16（本批，**唯一行为扩张项**）：作用层由 `exec` 放宽到 **`exec ∪ audit`**——「验收侧自证命令不可执行」
        //   = 自证无效 ⇒ 假完成通道。K3 缓解三条：① `runCommand` 只读黑名单先行（`command-exec.js`，不改文件/
        //   不重定向的命令才可执行）；② 新语义只对新批生效（旧批已终态，不重跑 merged）；③ 反例由 e3 覆盖
        //   （R-23：黑名单命令不执行且拒 `GATE_EXIT_FORBIDDEN`）。
        if (!t || (t.layer !== 'exec' && t.layer !== 'audit'))
            return { ok: true, declared: false };
        // 声明开关 `flows.exec.gate_command`——**团队级**开关（设计 §2.8 S16 原文：「显式 false 则**本团队**
        //   不执行命令 gate」）⇒ exec / audit 两层的命令门一并跳过；缺声明 ⇒ 引擎基线启用（enabledByFlag strictDefault=true，非回落旧口径）。
        const efCommand = flowOf(flowsOf(batch).flows, 'exec');
        // B2（§8⑤ **P-4** gate_command）：命令门开关**未声明**（`flagOf(execFlow,'gate_command') === null`）⇒
        //   引擎基线启用 ⇒ 产首触载荷；**显式 false** 已有独立 `escape{kind:'command-declared-off'}` 面（下方分支不挂钩）。
        const cmCommand = flagOf(efCommand, 'gate_command') === null
            ? contractMissingPayload('gate_command', 'exec', 'engine:enabledByFlag(gate_command,true)', 'gate-command-engine-default-enabled', '团队资产未声明 flows.exec.gate_command ⇒ 引擎基线启用（缺声明不得放宽）；本事件为首触留痕，不改判定')
            : null;
        if (!enabledByFlag(efCommand, 'gate_command', true))
            return { ok: true, declared: false, disabledBy: 'team-asset:gate_command' };
        // produce ∪ outputs 并集（去重保序）
        const fields = [...new Set([...(t.produce ?? []), ...(t.outputs ?? [])])];
        const det = detectGate(artifactsDirOf(sessionId, batchId), fields);
        // ── C3 词表（R1 §2.4 #2）────────────────────────────────────────────────────────────────────
        // 位置（冻结）：`detectGate` 之后、`emptyCommand` 首判**之前** ⇒ 「`gate:` 未声明」与「`reason:` 未登记」
        //   两件事**各判各的**（后者不因前者早退而被遮蔽）。
        // 判据面 = 本 lane 的 `produce ∪ outputs`（`fields`，与 `gate:` 行族同扫描面）；判定调 E1 的**同一函数**
        //   `reasonVocabularyVerdict`（单点，禁两套口径）。未登记 ⇒ 拒 `GATE_TOKEN_UNKNOWN`；
        //   停用条目 ⇒ 放行 + `restated` 告警；词表不可用 ⇒ fail-open 降级留痕（`GATE_VOCAB_INVALID`，**不拒批**）。
        const vocabC3 = reasonVocabularyVerdict(artifactsDirOf(sessionId, batchId), fields, vocabOpts);
        const vocabNote = reasonVocabularyNote(vocabC3);
        if (!vocabC3.ok) {
            const first = vocabC3.unknown[0];
            // 载荷形状对齐既有失败分支（写端 `store.js` 读 `code` / `command` / `exitCode` / `detail` /
            //   `needHumanEscalation`）⇒ `detail` 必填，否则抛错文案退化为 'command gate failed'（不可读）。
            return {
                ok: false, code: 'GATE_TOKEN_UNKNOWN', lane, declared: false,
                command: null, exitCode: null, needHumanEscalation: false, path: first.path,
                token: first.token, source: 'reason',
                detail: first.path + ' 声明未登记的 reason token "' + first.token + '"（词表未登记 ⇒ 拒：Q-3=B 只对**新增写点**强制注册）',
                problems: vocabC3.unknown.map((u) => u.path + ' declares unregistered reason token "' + u.token + '"'),
            };
        }
        // S-F7（**首位判定**）：空 `gate:` 行 ⇒ 「已声明 + 命令解析为空」⇒ 拒 GATE_EXIT_NO_COMMAND。
        //   必须在 `!det.declared` 早退**之前**判定——否则空声明会与「完全未声明」同路零感知。
        //   `declared: true` 是刻意的：空声明**确实声明了**（`path` 带上便于返工定位；载荷与下文原分支逐字一致）。
        if (det.emptyCommand) {
            return {
                ok: false, code: 'GATE_EXIT_NO_COMMAND', command: null, exitCode: null,
                declared: true, needHumanEscalation: false, path: det.emptyCommand,
                detail: 'gate 行命中但命令解析为空（防空命令假通过）',
            };
        }
        if (!det.declared) {
            // S17（本批）：**显式禁用**（独立行 `gate: false`）与「未声明」两态可区分——前者补留痕，
            //   两者判定**相同**（皆放行）。
            // 【历史痕迹 · 审计追溯】本条注释原写「命令解析为空仍走下方 `GATE_EXIT_NO_COMMAND`（**不加宽**）」：
            //   该防护**曾长期不可达**（`GATE_LINE_RE` 的 `(.+)` 不命中空声明行 ⇒ `declared === false` 早退遮蔽了
            //   下方分支 ⇒ 死码从未执行），属「说已防护、实未防护」的注释漂移；**F-7 起该防护真正生效**——
            //   空声明已在上方 `emptyCommand` 首判短路为拒。本分支自此只承接「完全未声明」与「`gate: false` 显式
            //   禁用」两态，二者皆零感知放行（判定不变）。
            const off = detectGateOff(artifactsDirOf(sessionId, batchId), fields);
            if (off.declared) {
                return {
                    ok: true, declared: false,
                    escape: {
                        kind: 'command-declared-off', lane, path: off.path,
                        reason: '产物含独立行 `gate: false`（显式禁用声明）⇒ 命令门零感知放行（判定不变）＋留痕',
                    },
                    // R1 C3 放行侧载荷（`escapes[]` 多值通道，与上方单值 `escape` 互不覆盖）：两态可同时成立
                    //   （既显式禁用 `gate:`、产物又声明停用词条 / 词表不可用）⇒ 两条留痕各自可归因。
                    ...vocabNote,
                    ...(cmCommand ?? {}),
                };
            }
            return { ok: true, declared: false, ...(cmCommand ?? {}), ...vocabNote }; // 未声明 gate → 零感知（判定不变）+ 首触留痕
        }
        // S-F7：本位置原为 `if (det.commands.length === 0) return { code:'GATE_EXIT_NO_COMMAND' }` 三行——
        //   该分支**恒不可达**（`declared === commands.length > 0` ⇒ 到达此处 `commands.length` 必 > 0，
        //   被上方 `!det.declared` 早退完全遮蔽）⇒ 死码即假防护（留着会被读成「已防护」），已删；
        //   空声明的拒载改由上方 `emptyCommand` 首判承担。
        const run = deps.runCommand ?? runCommand;
        const results = [];
        let failed = null;
        let outputTruncated = false;
        // ── L8 判据脚本信任锚：**执行命令之前**的预扫（三态：拒 / 告警+放行 / 零感知）───────────────
        //   声明面 = 产物 `gate-script-sha256: <相对路径>=<64hex>`（可多行）；判定面 = 取解析根（`commandRoots`，
        //   与 `commandCwd` **同源**）下确实存在的普通文件 token 重算 sha256 比对。
        //   **锚定值不是信任根**（声明侧与脚本本体同一写者可写）⇒ 本层堵的是「**声明之后**内容被改」⇒ 拒。
        const roots = commandRoots(sessionId, batchId, lane);
        const scriptCandidates = scriptCandidatesOf(det.commands, roots);
        const anchorRead = scriptCandidates.length === 0
            ? { anchors: {}, path: null } // 无脚本候选 ⇒ **不读**锚定文件（零额外 IO）
            : detectScriptAnchors(artifactsDirOf(sessionId, batchId), fields);
        const anchorVerdict = scriptAnchorVerdict(scriptCandidates, roots, anchorRead.anchors, anchorRead.path);
        const anchorNotes = escapeWarnings(anchorVerdict.warnings);
        if (anchorVerdict.reject)
            failed = anchorVerdict.reject; // 预扫即拒 ⇒ 下列循环**零命令被执行**
        for (const command of det.commands) {
            if (failed)
                break; // 预扫已拒 ⇒ 不进执行（无「首条已跑、次条才拒」的部分执行副作用）
            const r = run({ command, cwd: commandCwd(sessionId, batchId, lane) });
            if (r.truncated)
                outputTruncated = true;
            const res = { command, exitCode: r.exitCode ?? null, durationMs: r.durationMs ?? 0 };
            results.push(res);
            if (r.forbidden) {
                failed = { code: 'GATE_EXIT_FORBIDDEN', command, exitCode: null, detail: '黑名单命中（只读守卫，不执行）' };
                break;
            }
            if (r.timedOut) {
                failed = { code: 'GATE_EXIT_TIMEOUT', command, exitCode: res.exitCode, detail: '命令超时（重试后仍超时）' };
                break;
            }
            if (r.error && r.error.startsWith('GATE_EXIT_SPAWN_FAIL')) {
                failed = { code: 'GATE_EXIT_SPAWN_FAIL', command, exitCode: null, detail: r.error };
                break;
            }
            if (r.error === 'GATE_EXIT_NO_COMMAND') {
                failed = { code: 'GATE_EXIT_NO_COMMAND', command, exitCode: null, detail: r.error };
                break;
            }
            if (!r.ok) {
                failed = { code: 'GATE_EXIT_NONZERO', command, exitCode: res.exitCode, detail: '退出码 ' + res.exitCode + '（非 0，重试后仍失败）' };
                break;
            }
        }
        if (failed) {
            // 失败且产物同时声明 needHuman → 转人工闸（不抛错，store 接线转 checkNeedHumanGate 语义）
            const nh = detectNeedHuman(artifactsDirOf(sessionId, batchId), fields);
            return { ok: false, ...failed, declared: true, needHumanEscalation: nh.declared, path: det.path, ...anchorNotes };
        }
        return { ok: true, declared: true, commands: det.commands, results, outputTruncated, path: det.path, ...(cmCommand ?? {}), ...vocabNote, ...anchorNotes };
    }
    return { checkCommandGate };
}
