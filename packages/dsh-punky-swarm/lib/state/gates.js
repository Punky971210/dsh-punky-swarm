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

// Gates：Tier3 层间门禁（设计 §3.3/§四/§五/§15）——entry（consume 前置）/ exit（outputs/produce 前置 + Plan 契约 checkPlanContract）/ complete（audit 验收前置）
// 纯函数闭包工厂：createGates(root) 注入 root；门禁函数签名 (sessionId, batchId, batch, lane)——batch 对象显式传入，不持有状态
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../schema.js';

// 会话名校验（与 store.js 同源；gates 独立持有以避免 store→gates→store 循环依赖）
const SESSION_RE = /^[a-zA-Z0-9._-]+$/;

export function isAbsPath(p) {
  return /^[A-Za-z]:[\\/]|^\\|^\//.test(p);
}

// needHuman：audit 产物人工裁决声明检测（纯函数，与 checkExitGate 同源文件解析）——
// 产物含独立行 `needHuman: true`（正则 /^needHuman:\s*true$/m）即声明人工裁决需求；
// 缺失/空文件/目录跳过（零感知：缺产物由 exit gate 既有语义拒，本函数不补刀）
export function detectNeedHuman(artifactsDir, producePaths) {
  if (!Array.isArray(producePaths) || producePaths.length === 0) return { declared: false, path: null };
  for (const p of producePaths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (/^needHuman:\s*true$/m.test(content)) return { declared: true, path: p };
  }
  return { declared: false, path: null };
}

export function createGates(root) {
  const sessionsDir = path.join(root, 'sessions');

  function sessionDir(sessionId) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionsDir, sessionId);
  }
  function artifactsDirOf(sessionId, batchId) {
    return path.join(sessionDir(sessionId), 'artifacts', batchId);
  }
  function batchFile(sessionId, batchId) {
    if (!/^[a-zA-Z0-9._-]+$/.test(batchId)) throw new Error('invalid batchId');
    return path.join(sessionDir(sessionId), 'batches', batchId + '.json');
  }
  function readBatch(sessionId, batchId) {
    const file = batchFile(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // ---- Tier3 门禁辅助 ----
  function findTask(batch, lane) {
    for (const w of batch.wavePlan ?? []) {
      for (const t of w.tasks) if (t.id === lane) return t;
    }
    return null;
  }
  function resolveArtifact(sessionId, batchId, rel) {
    return isAbsPath(rel) ? rel : path.join(artifactsDirOf(sessionId, batchId), rel);
  }
  function fileExistsNonEmpty(p) {
    try {
      const st = fs.statSync(p);
      return st.isDirectory() || st.size > 0;
    } catch { return false; }
  }
  // Entry Gate（设计 §四）：exec lane 派发前 consume 必须全部存在且非空
  function checkEntryGate(sessionId, batchId, batch, lane) {
    const t = findTask(batch, lane);
    if (!t || t.layer !== 'exec' || !Array.isArray(t.consume) || t.consume.length === 0) return { ok: true };
    const missing = t.consume.filter((p) => !fileExistsNonEmpty(resolveArtifact(sessionId, batchId, p)));
    return missing.length ? { ok: false, code: 'GATE_ENTRY_MISSING', missing } : { ok: true };
  }
  // Plan 契约产物结构校验：仅 plan 产物——spec 必填章节 + task-tree JSON 可解析
  function checkPlanContract(sessionId, batchId, batch, lane) {
    const t = findTask(batch, lane);
    if (!t || t.layer !== 'plan' || !Array.isArray(t.produce)) return { ok: true };
    const problems = [];
    for (const p of t.produce) {
      const abs = resolveArtifact(sessionId, batchId, p);
      if (!fileExistsNonEmpty(abs)) { problems.push(p + ' missing'); continue; }
      const content = fs.readFileSync(abs, 'utf8');
      if (p.endsWith('spec.md')) {
        if (!content.includes('## 验收标准')) problems.push(p + ' lacks "## 验收标准"');
        if (!content.includes('## 约束')) problems.push(p + ' lacks "## 约束"');
      } else if (p.endsWith('.json')) {
        try { JSON.parse(content); } catch { problems.push(p + ' invalid JSON'); }
      }
    }
    return problems.length ? { ok: false, code: 'GATE_PLAN_CONTRACT', problems } : { ok: true };
  }
  // Exit Gate（设计 §五）：exec→outputs 存在；audit→produce 存在；plan→Plan 契约
  function checkExitGate(sessionId, batchId, batch, lane) {
    const t = findTask(batch, lane);
    if (!t || !t.layer) return { ok: true };
    if (t.layer === 'plan') return checkPlanContract(sessionId, batchId, batch, lane);
    const field = t.layer === 'exec' ? 'outputs' : (t.layer === 'audit' ? 'produce' : null);
    if (!field || !Array.isArray(t[field]) || t[field].length === 0) return { ok: true };
    const missing = t[field].filter((p) => !fileExistsNonEmpty(resolveArtifact(sessionId, batchId, p)));
    return missing.length ? { ok: false, code: 'GATE_EXIT_MISSING_' + t.layer.toUpperCase(), missing } : { ok: true };
  }
  // needHuman Gate（复用 review 态挂起）：audit lane 产物声明 needHuman →
  // review→merged 前置人工裁决证据（note 契约 `human:<裁决人>:<时间>:<结论>`，如 human:user@2026-08-21:accept）
  // 缺证据 → GATE_NEEDHUMAN_PENDING；conflict 驳回不强制（评审驳回/人工否决语义）；
  // 未声明/非 audit lane → 零感知（{ ok: true, declared: false }）
  function checkNeedHumanGate(sessionId, batchId, batch, lane, note) {
    const t = findTask(batch, lane);
    if (!t || t.layer !== 'audit' || !Array.isArray(t.produce) || t.produce.length === 0) {
      return { ok: true, declared: false, path: null };
    }
    const det = detectNeedHuman(artifactsDirOf(sessionId, batchId), t.produce);
    if (!det.declared) return { ok: true, declared: false, path: null };
    const evidence = typeof note === 'string' ? (note.match(/^human:.+/m) ?? [null])[0] : null;
    if (evidence) return { ok: true, declared: true, path: det.path, evidence };
    return {
      ok: false, code: 'GATE_NEEDHUMAN_PENDING', declared: true, path: det.path,
      message: 'audit lane 声明 needHuman，须 Manager 转达人工裁决（merged 需 note 含 human: 证据 / conflict 驳回）',
    };
  }
  // Complete Gate（设计 §5.2）：audit 层必须存在且全部 settled 且无 failed/conflict；exec 层全部 settled
  function checkCompleteGate(batch) {
    const layers = { plan: [], exec: [], audit: [] };
    for (const w of batch.wavePlan ?? []) {
      for (const t of w.tasks) if (t.layer && layers[t.layer]) layers[t.layer].push(t.id);
    }
    if (layers.exec.length === 0 && layers.audit.length === 0) return { ok: true }; // generic 批次
    const laneState = (id) => batch.lanes[id];
    const allTerminal = (ids) => ids.every((id) => schema.isMemberTerminal(laneState(id)));
    if (layers.audit.length === 0) return { ok: false, code: 'GATE_COMPLETE_NO_AUDIT' };
    if (!allTerminal(layers.audit)) return { ok: false, code: 'GATE_EXIT_PENDING_AUDIT', pending: layers.audit.filter((id) => !schema.isMemberTerminal(laneState(id))) };
    if (layers.audit.some((id) => ['failed', 'conflict'].includes(laneState(id)))) return { ok: false, code: 'GATE_COMPLETE_AUDIT_FAILED' };
    if (layers.exec.length && !allTerminal(layers.exec)) return { ok: false, code: 'GATE_COMPLETE_EXEC_PENDING', pending: layers.exec.filter((id) => !schema.isMemberTerminal(laneState(id))) };
    return { ok: true };
  }
  // 门禁状态查询（gate_status 工具用，设计 §8 M1）：lane 的 layer/契约字段/缺失清单/plan 契约问题
  function gateStatus(sessionId, batchId, lane) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const t = findTask(batch, lane);
    if (!t) return { lane, layer: null, state: batch.lanes[lane], gates: 'generic', team: batch.team };
    const missing = (field) => (Array.isArray(t[field]) ? t[field] : []).filter((p) => !fileExistsNonEmpty(resolveArtifact(sessionId, batchId, p)));
    const contract = t.layer === 'plan' ? checkPlanContract(sessionId, batchId, batch, lane) : null;
    return {
      lane, layer: t.layer ?? null, state: batch.lanes[lane], team: batch.team,
      consume: t.consume ?? [], produce: t.produce ?? [], outputs: t.outputs ?? [],
      consumeMissing: missing('consume'), outputsMissing: missing('outputs'), produceMissing: missing('produce'),
      contractProblems: contract && !contract.ok ? contract.problems : null,
    };
  }

  return { checkEntryGate, checkPlanContract, checkExitGate, checkNeedHumanGate, checkCompleteGate, gateStatus };
}
