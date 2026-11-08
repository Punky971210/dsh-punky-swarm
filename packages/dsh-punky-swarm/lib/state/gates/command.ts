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


import { runCommand } from '../command-exec.js';
import { flowOf, enabledByFlag, flagOf } from '../../assembly/flows.js';
import { taskOf, contractMissingPayload, detectNeedHuman, detectGate, detectGateOff,
  detectScriptAnchors, scriptTokensOf, normalizeScriptKey } from './detect.js';
import { reasonVocabularyNote } from './reason-vocabulary.js';
import type { Batch } from '../../types/contracts.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { GatesCx } from './cx.js';

export function buildCommand(cx: GatesCx) {
  const { artifactsDirOf, flowsOf, reasonVocabularyVerdict, sessionDir, vocabOpts } = cx;

  function commandRoots(sessionId: string, batchId: string, lane: string) {
    const wt = path.join(sessionDir(sessionId), 'worktrees', batchId, lane);
    let cwd: string | null = null;
    try { if (fs.statSync(wt).isDirectory()) cwd = wt; } catch { }
    const repoRoot = process.env.GATE_REPO_ROOT;
    if (cwd === null && repoRoot) { try { if (fs.statSync(repoRoot).isDirectory()) cwd = repoRoot; } catch { } }
    return { laneRoot: wt, artifactsDir: artifactsDirOf(sessionId, batchId), cwd: cwd ?? artifactsDirOf(sessionId, batchId) };
  }
  function commandCwd(sessionId: string, batchId: string, lane: string) {
    return commandRoots(sessionId, batchId, lane).cwd;
  }
  const sha256OfFile = (file: string): string | null => {
    try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
  };
  const isInsideDir = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child);
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  function escapeWarnings(list: Array<Record<string, unknown>>) {
    if (list.length === 0) return {};
    return list.length === 1 ? { escape: list[0] } : { escapes: list };
  }
  function scriptCandidatesOf(commands: string[], roots: { laneRoot: string; artifactsDir: string; cwd: string }) {
    const candidates: Array<{ command: string; key: string; abs: string }> = [];
    for (const command of commands) {
      for (const token of scriptTokensOf(command)) {
        const abs = path.resolve(roots.cwd, token);
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (!st.isFile()) continue;
        if (!isInsideDir(abs, roots.cwd)) continue;
        const key = normalizeScriptKey(path.relative(roots.cwd, abs));
        if (key.length === 0) continue;
        if (!candidates.some((c) => c.abs === abs)) candidates.push({ command, key, abs });
      }
    }
    return candidates;
  }
  function scriptAnchorVerdict(
    candidates: Array<{ command: string; key: string; abs: string }>,
    roots: { laneRoot: string; artifactsDir: string; cwd: string },
    anchors: Record<string, string>, anchorPath: string | null,
  ) {
    const warnings: Array<Record<string, unknown>> = [];
    let reject: {
      code: string; command: string; exitCode: number | null; detail: string;
      script: string; expected: string; actual: string; anchorPath: string | null; problems: string[];
    } | null = null;
    for (const c of candidates) {
      if (isInsideDir(c.abs, roots.laneRoot) || isInsideDir(c.abs, roots.artifactsDir)) {
        warnings.push({
          kind: 'gate-script-lane-local', gate: 'command', path: c.key,
          reason: '被引用脚本落在 lane worktree / 产物根内（位置缺口：该根由被检方自身可写）⇒ 降级为告警，不拒',
        });
      }
    }
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
  function checkCommandGate(
    sessionId: string, batchId: string, batch: Batch, lane: string,
    deps: { runCommand?: typeof runCommand } = {},
  ) {
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
    if (!t || (t.layer !== 'exec' && t.layer !== 'audit')) return { ok: true, declared: false };
    const efCommand = flowOf(flowsOf(batch).flows, 'exec');
    const cmCommand = flagOf(efCommand, 'gate_command') === null
      ? contractMissingPayload(
        'gate_command', 'exec', 'engine:enabledByFlag(gate_command,true)', 'gate-command-engine-default-enabled',
        '团队资产未声明 flows.exec.gate_command ⇒ 引擎基线启用（缺声明不得放宽）；本事件为首触留痕，不改判定',
      )
      : null;
    if (!enabledByFlag(efCommand, 'gate_command', true)) return { ok: true, declared: false, disabledBy: 'team-asset:gate_command' };
    const fields = [...new Set([...(t.produce ?? []), ...(t.outputs ?? [])])];
    const det = detectGate(artifactsDirOf(sessionId, batchId), fields);
    const vocabC3 = reasonVocabularyVerdict(artifactsDirOf(sessionId, batchId), fields, vocabOpts);
    const vocabNote = reasonVocabularyNote(vocabC3);
    if (!vocabC3.ok) {
      const first = vocabC3.unknown[0];
      return {
        ok: false, code: 'GATE_TOKEN_UNKNOWN', lane, declared: false,
        command: null, exitCode: null, needHumanEscalation: false, path: first.path,
        token: first.token, source: 'reason',
        detail: first.path + ' 声明未登记的 reason token "' + first.token + '"（词表未登记 ⇒ 拒：Q-3=B 只对**新增写点**强制注册）',
        problems: vocabC3.unknown.map((u) => u.path + ' declares unregistered reason token "' + u.token + '"'),
      };
    }
    if (det.emptyCommand) {
      return {
        ok: false, code: 'GATE_EXIT_NO_COMMAND', command: null, exitCode: null,
        declared: true, needHumanEscalation: false, path: det.emptyCommand,
        detail: 'gate 行命中但命令解析为空（防空命令假通过）',
      };
    }
    if (!det.declared) {
      const off = detectGateOff(artifactsDirOf(sessionId, batchId), fields);
      if (off.declared) {
        return {
          ok: true, declared: false,
          escape: {
            kind: 'command-declared-off', lane, path: off.path,
            reason: '产物含独立行 `gate: false`（显式禁用声明）⇒ 命令门零感知放行（判定不变）＋留痕',
          },
          ...vocabNote,
          ...(cmCommand ?? {}),
        };
      }
      return { ok: true, declared: false, ...(cmCommand ?? {}), ...vocabNote };
    }
    const run = deps.runCommand ?? runCommand;
    const results: Array<{ command: string; exitCode: number | null; durationMs: number }> = [];
    let failed: { code: string; command: string; exitCode: number | null; detail: string } | null = null;
    let outputTruncated = false;
    const roots = commandRoots(sessionId, batchId, lane);
    const scriptCandidates = scriptCandidatesOf(det.commands, roots);
    const anchorRead = scriptCandidates.length === 0
      ? { anchors: {} as Record<string, string>, path: null }
      : detectScriptAnchors(artifactsDirOf(sessionId, batchId), fields);
    const anchorVerdict = scriptAnchorVerdict(scriptCandidates, roots, anchorRead.anchors, anchorRead.path);
    const anchorNotes = escapeWarnings(anchorVerdict.warnings);
    if (anchorVerdict.reject) failed = anchorVerdict.reject;
    for (const command of det.commands) {
      if (failed) break;
      const r = run({ command, cwd: commandCwd(sessionId, batchId, lane) });
      if (r.truncated) outputTruncated = true;
      const res = { command, exitCode: r.exitCode ?? null, durationMs: r.durationMs ?? 0 };
      results.push(res);
      if (r.forbidden) { failed = { code: 'GATE_EXIT_FORBIDDEN', command, exitCode: null, detail: '黑名单命中（只读守卫，不执行）' }; break; }
      if (r.timedOut) { failed = { code: 'GATE_EXIT_TIMEOUT', command, exitCode: res.exitCode, detail: '命令超时（重试后仍超时）' }; break; }
      if (r.error && r.error.startsWith('GATE_EXIT_SPAWN_FAIL')) { failed = { code: 'GATE_EXIT_SPAWN_FAIL', command, exitCode: null, detail: r.error }; break; }
      if (r.error === 'GATE_EXIT_NO_COMMAND') { failed = { code: 'GATE_EXIT_NO_COMMAND', command, exitCode: null, detail: r.error }; break; }
      if (!r.ok) { failed = { code: 'GATE_EXIT_NONZERO', command, exitCode: res.exitCode, detail: '退出码 ' + res.exitCode + '（非 0，重试后仍失败）' }; break; }
    }
    if (failed) {
      const nh = detectNeedHuman(artifactsDirOf(sessionId, batchId), fields);
      return { ok: false, ...failed, declared: true, needHumanEscalation: nh.declared, path: det.path, ...anchorNotes };
    }
    return { ok: true, declared: true, commands: det.commands, results, outputTruncated, path: det.path, ...(cmCommand ?? {}), ...vocabNote, ...anchorNotes };
  }

  return { checkCommandGate };
}
