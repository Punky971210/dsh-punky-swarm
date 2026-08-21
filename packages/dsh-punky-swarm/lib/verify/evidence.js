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

// verify/evidence.js —— post-execute 捕获 + 内容寻址 blob（C3 成熟模式：dsh-verification CapturedEvidence）
// 订阅宿主 tools/post-execute（cordis waterfall，pass-through 不断链），从真实 ToolExecutionResult 派生证据；
// 内容寻址存储（key=contentHash，tmp+rename 原子写，读校验损坏 fail closed，>256KB 截断标记），同内容去重；
// 控制面工具不产证据。纯逻辑 + 文件 blob（root/verify/blobs + root/verify/ledger-<session>.jsonl，引擎状态根）。
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeArgs, stableHash } from './selector.js';

// 256KB 截断阈值（对齐 dsh-verification evidence-store 超限截断语义）
export const MAX_BLOB_BYTES = 256 * 1024;

const SESSION_RE = /^[a-zA-Z0-9._-]+$/;

// 控制面工具名单：治理/协调/宿主控制面工具不产证据（结果非领域产出，含本批后续挂载工具）
export const CONTROL_PLANE_TOOLS = new Set([
  // 蟛蜞治理 core 11 + mailbox 3
  'wave_plan', 'batch_phase', 'batch_status', 'artifact_types', 'assign_check', 'asset_claim',
  'gate_status', 'lane_claim', 'lane_release', 'member_settle', 'member_status',
  'mailbox_send', 'mailbox_read', 'mailbox_ack',
  // 本批后续能力（watch/worktree/budget/trajectory 装配后同样控制面）
  'lane_heartbeat', 'lane_worktree_create', 'lane_worktree_merge', 'lane_checkpoint',
  // 宿主控制/会话面
  'ask_user_question', 'describe_image', 'read_image', 'todo_write', 'list_agents',
  'send_message', 'interrupt_agent', 'job_list', 'job_output', 'job_kill',
  'memory_save', 'memory_search', 'memory_list', 'memory_update', 'memory_delete', 'memory_archive', 'memory_forget',
]);

// 证据分类表：工具 → 证据类别（4 类；未映射工具不产证据，保守兜底）
const KIND_BY_TOOL = {
  // 命令输出：执行型工具的 stdout/结果文本
  pwsh: 'command_output', bash: 'command_output', run_code: 'command_output',
  ssh_exec: 'command_output', ssh_cluster: 'command_output',
  // 文件存在：目录/文件探测结果
  glob: 'file_exists',
  // 带定位引用：read/grep 行号定位文本
  read: 'quote_with_location', grep: 'quote_with_location',
  // 文件差异：写/编辑产生的变更证据
  write: 'file_diff', edit: 'file_diff',
};

export function classifyEvidence(exec) {
  if (!exec || typeof exec.name !== 'string' || !exec.name.length) return null;
  if (CONTROL_PLANE_TOOLS.has(exec.name)) return null;
  return KIND_BY_TOOL[exec.name] ?? null;
}

// 从 ToolExecutionResult 提取展示文本（content 块兼容 string/array/object；失败/空 → ''）
export function extractResultText(result) {
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

// 派生证据（纯函数）：控制面/未知工具 → null；其余 → 结构化证据（含 selectorKey 供审计侧全等匹配）
export function deriveEvidence(exec, result) {
  const kind = classifyEvidence(exec);
  if (!kind) return null;
  const args = exec && exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  const failed = Boolean(result && result.isError === true);
  return {
    kind,
    tool: exec.name,
    callId: exec.callId ?? null,
    // 与 freezeSelector.argsHash 同源计算（stableHash({tool, canonicalArgs})），审计侧按此匹配 AC
    selectorKey: stableHash({ tool: exec.name, args: canonicalizeArgs(args) }),
    ts: new Date().toISOString(),
    ok: !failed,
    error: failed ? String(result?.error?.message ?? result?.error ?? 'tool error') : null,
    summary: extractResultText(result).slice(0, 512),
  };
}

// ---- 内容寻址 blob 存储（引擎状态根 root/verify/blobs/） ----
function blobDirOf(root) { return path.join(root, 'verify', 'blobs'); }
function blobPathOf(root, key) { return path.join(blobDirOf(root), key + '.json'); }

// 内容哈希：只对证据的规范字段求值（不含 blobKey 元数据），读校验与写校验共用同一函数
export function evidenceKey(evidence) {
  return stableHash({
    kind: evidence.kind,
    tool: evidence.tool,
    selectorKey: evidence.selectorKey,
    ok: evidence.ok,
    summary: evidence.summary ?? null,
  });
}

// 原子写 + 写后读校验（损坏 fail closed：删除损坏文件并抛错，不留半成品）
function writeBlobAtomic(root, key, payload) {
  fs.mkdirSync(blobDirOf(root), { recursive: true });
  const file = blobPathOf(root, key);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, payload, 'utf8');
  try {
    const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    // truncated 记录只保留截断摘要，内容哈希必然不等于原始 key → 仅校验 key 字段；
    // 完整记录才做内容哈希核对（写后读校验，fail closed）
    if (written.key !== key) throw new Error('write verify failed: key mismatch');
    if (written.truncated !== true && evidenceKey(written) !== key) throw new Error('write verify failed: content hash mismatch');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error('blob write failed (fail closed): ' + key + ' — ' + String(e?.message ?? e));
  }
  return key;
}

// 内容寻址写入：key=contentHash；同内容去重（已存在直接返回既有 key，不重写）；>256KB 截断标记
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

// 读校验：损坏 fail closed（key 不匹配 / 内容哈希不匹配 / 不可解析 → 抛错，绝不以损坏内容裁决）
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

// ---- 每会话捕获台账（jsonl 追加写；审计 lane 按会话/selectorKey 消费） ----
function ledgerFileOf(root, sessionId) {
  if (!SESSION_RE.test(String(sessionId))) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'verify', 'ledger-' + sessionId + '.jsonl');
}

export function appendLedger(root, sessionId, entry) {
  const file = ledgerFileOf(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

// 读取台账：可按 selectorKey / tool 过滤；损坏行跳过（台账尽力而为，blob 仍可单查）
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

// ---- 证据绑定注册表（audit lane 侧：按 AC 冻结 selector 匹配台账 → bindEvidence → 供裁决） ----
export function createEvidenceRegistry() {
  const bindings = new Map(); // acId -> [{ selectorRef, blobKey }]

  return {
    // 捕获 → 绑定：同一 AC 同 blobKey 幂等（去重）
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

// ---- post-execute 捕获安装（enabled 缺省关，V5：enabled=false 零运行时开销） ----
// 订阅宿主 tools/post-execute waterfall：观察派生证据 → 落 blob + 台账；pass-through 不断链（return next()）。
// 捕获失败只记录不抛（观察者不得破坏工具执行链）。
export function installEvidenceCapture(ctx, opts = {}) {
  const { root, enabled = false, onCaptured } = opts;
  if (enabled !== true || !root || typeof ctx?.on !== 'function') {
    return { dispose: () => {}, count: () => 0, installed: false };
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
