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

import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeArgs, stableHash } from './selector.js';
import { SESSION_RE } from '../state/constants.js'; // 单点（原定义迁出）

const MAX_BLOB_BYTES = 256 * 1024;

export const CONTROL_PLANE_TOOLS = new Set([
  'wave_plan', 'batch_phase', 'batch_status', 'artifact_types', 'assign_check', 'asset_claim',
  'gate_status', 'lane_claim', 'lane_release', 'member_settle', 'member_set_status',
  'lane_worktree_create', 'lane_worktree_merge', 'lane_checkpoint',
  'ask_user_question', 'describe_image', 'read_image', 'todo_write', 'list_agents',
  'send_message', 'interrupt_agent', 'job_list', 'job_output', 'job_kill',
  'memory_save', 'memory_search', 'memory_list', 'memory_update', 'memory_delete', 'memory_archive', 'memory_forget',
]);

const KIND_BY_TOOL = {
  pwsh: 'command_output', bash: 'command_output', run_code: 'command_output',
  ssh_exec: 'command_output', ssh_cluster: 'command_output',
  glob: 'file_exists',
  read: 'quote_with_location', grep: 'quote_with_location',
  write: 'file_diff', edit: 'file_diff',
};

function classifyEvidence(exec) {
  if (!exec || typeof exec.name !== 'string' || !exec.name.length) return null;
  if (CONTROL_PLANE_TOOLS.has(exec.name)) return null;
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

function blobDirOf(root) { return path.join(root, 'verify', 'blobs'); }
function blobPathOf(root, key) { return path.join(blobDirOf(root), key + '.json'); }

function evidenceKey(evidence) {
  return stableHash({
    kind: evidence.kind,
    tool: evidence.tool,
    selectorKey: evidence.selectorKey,
    ok: evidence.ok,
    summary: evidence.summary ?? null,
  });
}

function writeBlobAtomic(root, key, payload) {
  fs.mkdirSync(blobDirOf(root), { recursive: true });
  const file = blobPathOf(root, key);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, payload, 'utf8');
  try {
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (written.key !== key) throw new Error('write verify failed: key mismatch');
    if (written.truncated !== true && evidenceKey(written) !== key) throw new Error('write verify failed: content hash mismatch');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error('blob write failed (fail closed): ' + key + ' — ' + String(e?.message ?? e));
  }
  return key;
}

export function storeBlob(root, evidence) {
  if (!evidence || typeof evidence.kind !== 'string') throw new Error('storeBlob: invalid evidence');
  const key = evidenceKey(evidence);
  const file = blobPathOf(root, key);
  if (fs.existsSync(file)) return key; // 去重：同内容只存一份，blobKey 稳定
  const payload = JSON.stringify({ key, ...evidence }, null, 2);
  if (Buffer.byteLength(payload, 'utf8') > MAX_BLOB_BYTES) {
    const truncated = {
      key, truncated: true, kind: evidence.kind, tool: evidence.tool,
      selectorKey: evidence.selectorKey, ok: evidence.ok,
      summary: (evidence.summary ?? '').slice(0, 2000),
      note: 'evidence truncated at ' + MAX_BLOB_BYTES + ' bytes',
    };
    writeBlobAtomic(root, key, JSON.stringify(truncated, null, 2));
    return key;
  }
  writeBlobAtomic(root, key, payload);
  return key;
}

export function readBlob(root, key) {
  if (typeof key !== 'string' || !key.length) throw new Error('readBlob: key required');
  const file = blobPathOf(root, key);
  if (!fs.existsSync(file)) throw new Error('blob not found: ' + key);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('blob corrupted (unparseable): ' + key); }
  if (data.key !== key) throw new Error('blob corrupted (key mismatch): ' + key);
  if (data.truncated !== true && evidenceKey(data) !== key) {
    throw new Error('blob corrupted (content hash mismatch): ' + key);
  }
  return data;
}

function ledgerFileOf(root, sessionId) {
  if (!SESSION_RE.test(String(sessionId))) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'verify', 'ledger-' + sessionId + '.jsonl');
}

export function appendLedger(root, sessionId, entry) {
  const file = ledgerFileOf(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

export function readLedger(root, sessionId, { selectorKey, tool } = {}) {
  const file = ledgerFileOf(root, sessionId);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (selectorKey && e.selectorKey !== selectorKey) continue;
      if (tool && e.tool !== tool) continue;
      out.push(e);
    } catch { /* 跳过损坏行 */ }
  }
  return out;
}

export function createEvidenceRegistry() {
  const bindings = new Map(); // acId -> [{ selectorRef, blobKey }]

  return {
    bindEvidence(acId, selectorRef, blobKey) {
      if (typeof acId !== 'string' || !acId.length) throw new Error('bindEvidence: acId required');
      if (typeof selectorRef !== 'string' || !selectorRef.length) throw new Error('bindEvidence: selectorRef required');
      if (typeof blobKey !== 'string' || !blobKey.length) throw new Error('bindEvidence: blobKey required');
      const list = bindings.get(acId) ?? [];
      if (!list.some((b) => b.blobKey === blobKey && b.selectorRef === selectorRef)) {
        list.push({ selectorRef, blobKey });
      }
      bindings.set(acId, list);
      return { acId, selectorRef, blobKey, bound: true };
    },
    bindingsFor(acId) { return bindings.get(acId) ?? []; },
    all() { return [...bindings.entries()].map(([acId, list]) => ({ acId, evidence: list })); },
    size() { return bindings.size; },
    clear() { bindings.clear(); },
  };
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
        const blobKey = storeBlob(root, evidence);
        const sessionId = exec?.agent?.session?.id ?? 'cli';
        appendLedger(root, sessionId, { blobKey, ...evidence });
        captured++;
        if (typeof onCaptured === 'function') onCaptured({ blobKey, ...evidence });
      }
    } catch (e) {
      ctx.logger?.warn?.('[verify] evidence capture failed: ' + String(e?.message ?? e));
    }
    return next(); // pass-through：不断链（下游决策原样透传）
  };
  const dispose = ctx.on('tools/post-execute', listener);
  return { dispose, count: () => captured, installed: true };
}

// 分级按**根因**（`errorFamily` 由产生点按成因直接给出），**不按 message 文本匹配** ——
//   文案一改就失效，靠正则从消息里猜族是最脆的形态。
// 同一族的不同码 ⇒ **同一动作**：动作取决于「哪一类原因」，不取决于「具体哪一个码」；

export const ERROR_FAMILY_UNMAPPED = 'error-family-unmapped:';

export const DENIAL_FAMILIES = Object.freeze(['tier', 'mode', 'allowlist', 'approval']);

const REPAIR_ACTION_BY_FAMILY = Object.freeze({
  tier: 'assess', // 先做只读侦察再 assign_check，写入难度与判据
  mode: 'switch-mode', // 当前模式不生效 ⇒ 换到该模式允许的路径
  allowlist: 'grant-allowlist', // 不在白名单 ⇒ 由调用方把工具/参数加进 tools.allowlist
  approval: 'obtain-approval', // 需批准 ⇒ 取得批准票据（摘要须与当前参数一致）
});

export function repairActionOf(errorFamily) {
  if (typeof errorFamily !== 'string' || errorFamily.length === 0) {
    throw new Error(ERROR_FAMILY_UNMAPPED + ' <empty>（族名须为非空字符串）');
  }
  const action = REPAIR_ACTION_BY_FAMILY[errorFamily];
  if (action === undefined) {
    throw new Error(ERROR_FAMILY_UNMAPPED + ' ' + errorFamily + '（已映射族：' + DENIAL_FAMILIES.join('/') + '）');
  }
  return action;
}

export function classifyDenial(denial) {
  const errorFamily = denial?.errorFamily;
  const errorCode = denial?.errorCode;
  if (typeof errorCode !== 'string' || errorCode.length === 0) {
    throw new Error(ERROR_FAMILY_UNMAPPED + ' ' + String(errorFamily) + ' <errorCode 缺失>（每个拒码都必须有动作）');
  }
  return { errorFamily, errorCode, action: repairActionOf(errorFamily) };
}
