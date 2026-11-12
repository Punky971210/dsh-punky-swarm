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

// 证据捕获：订阅宿主 `tools/post-execute`，把「可复核产物类」工具调用追加成一行台账
//   （`<root>/verify/ledger-<sessionId>.jsonl`）。**落盘文件即对外契约**：进程内不提供读端，
//   消费方（audit lane / 外部分析）直接读该文件。捕获失败只 warn，绝不阻断下游调用。
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeArgs, stableHash } from './selector.js';
import { SESSION_RE } from '../state/constants.js';

// 只收「可复核产物」四类：命令输出 / 文件存在 / 定位引用 / 文件改动。
//   未列入者（控制面、治理面、纯查询）不产证据 —— 本表就是唯一判据，不另设排除名单。
const KIND_BY_TOOL = {
  pwsh: 'command_output', bash: 'command_output', run_code: 'command_output',
  ssh_exec: 'command_output', ssh_cluster: 'command_output',
  glob: 'file_exists',
  read: 'quote_with_location', grep: 'quote_with_location',
  write: 'file_diff', edit: 'file_diff',
};

function classifyEvidence(exec) {
  if (!exec || typeof exec.name !== 'string' || !exec.name.length) return null;
  return KIND_BY_TOOL[exec.name] ?? null;
}

function extractResultText(result) {
  if (!result) return '';
  const c = result.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (b === null || b === undefined) return '';
      if (typeof b === 'string') return b;
      if (typeof b === 'object' && typeof b.text === 'string') return b.text;
      return '';
    }).join('\n');
  }
  if (c === undefined || c === null) return '';
  try { return JSON.stringify(c); } catch { return String(c); }
}

function deriveEvidence(exec, result) {
  const kind = classifyEvidence(exec);
  if (!kind) return null;
  const args = exec && exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  const failed = Boolean(result && result.isError === true);
  return {
    kind,
    tool: exec.name,
    callId: exec.callId ?? null,
    selectorKey: stableHash({ tool: exec.name, args: canonicalizeArgs(args) }),
    ts: new Date().toISOString(),
    ok: !failed,
    error: failed ? String(result?.error?.message ?? result?.error ?? 'tool error') : null,
    summary: extractResultText(result).slice(0, 512),
  };
}

// 【④ 同名不同物改名】本函数与 `lib/governance/receipt-store.js` 的同名函数曾共用一名但落点不同。
//   本处落 `verify/ledger-<sid>.jsonl` ⇒ 改 `verifyLedgerFileOf`；两侧各自独立、**禁合并**（依据见 map.json G4-3）。
function verifyLedgerFileOf(root, sessionId) {
  if (!SESSION_RE.test(String(sessionId))) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'verify', 'ledger-' + sessionId + '.jsonl');
}

export function appendLedger(root, sessionId, entry) {
  const file = verifyLedgerFileOf(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

export function installEvidenceCapture(ctx, opts = {}) {
  const { root, enabled = false, onCaptured } = opts;
  if (enabled !== true || !root || typeof ctx?.on !== 'function') {
    return { dispose: () => {}, count: () => 0, installed: false, inert: true };
  }
  let captured = 0;
  const listener = (exec, result, next) => {
    try {
      const evidence = deriveEvidence(exec, result);
      if (evidence) {
        const sessionId = exec?.agent?.session?.id ?? 'cli';
        appendLedger(root, sessionId, evidence);
        captured++;
        if (typeof onCaptured === 'function') onCaptured(evidence);
      }
    } catch (e) {
      ctx.logger?.warn?.('[verify] evidence capture failed: ' + String(e?.message ?? e));
    }
    return next(); // pass-through：不断链（下游决策原样透传）
  };
  const dispose = ctx.on('tools/post-execute', listener);
  return { dispose, count: () => captured, installed: true };
}
