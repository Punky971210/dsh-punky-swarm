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
import { createRequire } from 'node:module';
import * as schema from '../../schema.js';
import * as machine from '../machine.js';
import * as EVT from '../event-types.js';
import { humanEvidenceOf } from '../constants.js';
import { findTask } from '../task-utils.js';
import { declaredArtifactsOf } from '../../wave-plan.js';
import { resolveArtifactIn } from '../batch-paths.js';
import { laneHandoffGapPayload } from './events.js';

const RULE_PROPAGATION_MODULE = '../rule-propagation.js';
const MEMORY_STALE_MANIFEST_FILE = 'memory-stale-recommended.json';
const requireOfPackage = createRequire(import.meta.url);
let rulePropagationModule = null;
let rulePropagationLoadError = null;

/** 惰性取 L4 判定器；缺席/异常 ⇒ `{ fn: null, error: <原因> }`（**不抛**，fail-safe）。 */
export function rulePropagationEvaluatorOf() {
  if (rulePropagationModule === null && rulePropagationLoadError === null) {
    try {
      rulePropagationModule = requireOfPackage(RULE_PROPAGATION_MODULE);
    } catch (err) {
      rulePropagationLoadError = String((err && err.message) || err);
    }
  }
  const fn = rulePropagationModule && typeof rulePropagationModule.evaluateRulePropagation === 'function'
    ? rulePropagationModule.evaluateRulePropagation
    : null;
  return { fn, error: rulePropagationLoadError };
}

/** 调用 L4 判定器（**唯一调用点**）；返回冻结签名四字段，或 `null`（模块缺席/调用抛错，均不静默）。 */
export function evaluatePropagationOf(batch, rules) {
  const { fn, error } = rulePropagationEvaluatorOf();
  if (!fn) {
    return error
      ? { affected: [], changed: false, version: null, detail: ['rule-propagation unavailable: ' + error] }
      : { affected: [], changed: false, version: null, detail: ['rule-propagation module absent (e2-l4-propagate 未产出/未回拷)'] };
  }
  try {
    return fn({ batch, rules });
  } catch (err) {
    return { affected: [], changed: false, version: null, detail: ['rule-propagation threw: ' + String((err && err.message) || err)] };
  }
}

export function isTerminalPhase(phase) {
  return schema.isBatchTerminal(phase) === true;
}

/** L9：清单落点 = **批次产物根**（`<sessionsDir>/<sessionId>/artifacts/<batchId>/`），**不落工作区根**。 */
export function memoryStaleManifestPathOf(sessionId, batchId, artifactsDirOfFn) {
  const dir = typeof artifactsDirOfFn === 'function'
    ? artifactsDirOfFn(sessionId, batchId)
    : path.join(String(sessionId), 'artifacts', String(batchId));
  return path.join(dir, MEMORY_STALE_MANIFEST_FILE);
}

export function memoryStaleItemsOf(batch) {
  const lanes = (batch && typeof batch.lanes === 'object' && batch.lanes !== null && !Array.isArray(batch.lanes))
    ? batch.lanes : {};
  const items = [];
  for (const [lane, state] of Object.entries(lanes)) {
    if (!schema.isMemberTerminal(state)) continue;
    items.push({
      batchId: batch.batchId ?? null,
      lane,
      state,
      source: 'batch:' + String(batch.batchId ?? '') + '/lane:' + lane,
      action: 'archive',
      reversible: true,
    });
  }
  items.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
  return items;
}

export const PREFLIGHT_REPORT_FIELDS = Object.freeze(['knowledge_hits', 'skills_used', 'mcp_used']);

const PREFLIGHT_LINE_RES = Object.freeze({
  knowledge_hits: /^knowledge_hits:[ \t]*(.*)$/m,
  skills_used: /^skills_used:[ \t]*(.*)$/m,
  mcp_used: /^mcp_used:[ \t]*(.*)$/m,
});

/**
 * 取一个字段的**值原文**（首行值 + 缩进续行双读）。
 * @returns {string|null} `null` = 无匹配行（`missing`）；`''` = 行在但值为空（`empty`）
 */
function preflightValueOf(content, lineRe) {
  const m = lineRe.exec(content);
  if (!m) return null;
  const first = String(m[1] ?? '').trim();
  if (first) return first;
  const lines = content.slice(m.index + m[0].length).split('\n');
  const parts = [];
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') break;
    if (/^[a-z][a-z0-9_]*:/.test(raw)) break;
    if (!/^(?: {2,}|\t|- )/.test(raw)) break;
    parts.push(raw.trim().replace(/^-\s*/, ''));
  }
  return parts.join(' ').trim();
}

/** 四态判定（**单点**）：`missing` / `empty` / `none-no-reason` / `ok`（仅 `ok` 计入通过）。 */
function preflightStateOf(value) {
  if (value === null) return 'missing';
  if (value === '') return 'empty';
  if (/^none\s*$/.test(value) || /^none:[ \t]*$/.test(value)) return 'none-no-reason';
  return 'ok';
}

/**
 * @param {string} artifactsDir 批次产物根（`artifactsDirOf(sessionId, batchId)`）
 * @param {string[]} paths 相对产物根的声明路径（保序）
 * @returns {{ok:boolean, reason:'fields-missing'|'no-declared-artifacts'|null,
 *   fields:Record<string,string>, missing:string[], artifacts:string[]}}
 */
export function detectPreflightReport(artifactsDir, paths) {
  const fields = {};
  for (const f of PREFLIGHT_REPORT_FIELDS) fields[f] = 'missing';
  const declared = Array.isArray(paths) ? paths : [];
  const artifacts = [];
  const contents = [];
  for (const p of declared) {
    if (typeof p !== 'string' || p.length === 0) continue;
    let abs;
    try { abs = resolveArtifactIn(artifactsDir, p); } catch { continue; }
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    artifacts.push(p);
    contents.push(content);
  }
  if (declared.length === 0) {
    return { ok: true, reason: 'no-declared-artifacts', fields, missing: [], artifacts };
  }
  const missing = [];
  for (const f of PREFLIGHT_REPORT_FIELDS) {
    let value = null;
    for (const content of contents) {
      value = preflightValueOf(content, PREFLIGHT_LINE_RES[f]);
      if (value !== null) break;
    }
    const state = preflightStateOf(value);
    fields[f] = state;
    if (state !== 'ok') missing.push(f);
  }
  return {
    ok: missing.length === 0,
    reason: missing.length === 0 ? null : 'fields-missing',
    fields, missing, artifacts,
  };
}

export function buildMemberGates(cx) {
  const { gates, readBatch, newEvent, emitStateChange, makeContractMissingSink, archive, ratchet, commitBatch, artifactsDirOf, log } = cx;

  function runMergedGateChain(batch, { sessionId, batchId, lane, note, collect, emitContractMissing }) {
  const g = gates.checkExitGate(sessionId, batchId, batch, lane);
  if (g.ok) collect('degrade', g);
  emitContractMissing(g);
  if (!g.ok) {
    batch.events.push(newEvent(EVT.EVT_GATE_EXIT_MISSING, { lane, code: g.code, detail: g.problems ?? g.missing }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    throw new Error(g.code + ': ' + (g.problems ?? g.missing).join(', '));
  }
  batch.events.push(newEvent(EVT.EVT_GATE_PASSED, { lane, gate: 'exit' }));
  const tg = gates.checkTargetsGate(sessionId, batchId, batch, lane);
  collect('escape', tg);
  emitContractMissing(tg);
  if (!tg.ok) {
    batch.events.push(newEvent(EVT.EVT_GATE_TARGET_BLOCKED, { lane, code: tg.code, missing: tg.missing ?? [], unchanged: tg.unchanged ?? [] }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    throw new Error(tg.code + ': targets 未通过校验（missing=' + (tg.missing ?? []).join(', ') + '; unchanged=' + (tg.unchanged ?? []).join(', ') + '）');
  }
  if (tg.declared) {
    batch.events.push(newEvent(EVT.EVT_GATE_TARGET_PASSED, { lane, mode: tg.mode ?? 'mtime', targets: tg.targets ?? [] }));
  }
  const cg = gates.checkCommandGate(sessionId, batchId, batch, lane);
  collect('escape', cg);
  emitContractMissing(cg);
  if (!cg.ok) {
    batch.events.push(newEvent(EVT.EVT_GATE_EXIT_BLOCKED, { lane, code: cg.code, command: cg.command ?? null, exitCode: cg.exitCode ?? null, detail: cg.detail ?? null, escalation: cg.needHumanEscalation === true }));
    if (cg.needHumanEscalation) {
      const evidence = humanEvidenceOf(note);
      if (!evidence) {
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
        throw new Error('GATE_NEEDHUMAN_PENDING: 命令 gate 失败（' + cg.code + '）且产物声明 needHuman，merged 须 note 含 human: 证据');
      }
      batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note }));
    } else {
      batch.updatedAt = new Date().toISOString();
      commitBatch(sessionId, batchId, batch);
      throw new Error(cg.code + ': ' + (cg.detail ?? 'command gate failed'));
    }
  } else if (cg.declared) {
    batch.events.push(newEvent(EVT.EVT_GATE_EXIT, { lane, commands: cg.commands ?? [], results: cg.results ?? [], outputTruncated: cg.outputTruncated === true }));
  }
  const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, note);
  collect('escape', nh);
  emitContractMissing(nh);
  if (!nh.ok) {
    batch.events.push(newEvent(EVT.EVT_GATE_NEEDHUMAN_BLOCKED, { lane, code: nh.code, path: nh.path }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    throw new Error(nh.code + ': ' + nh.message);
  }
  if (nh.declared) batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note }));
  const shg = gates.checkSettleHandoffGate(sessionId, batchId, batch, lane, note);
  if (shg.legacy === true) {
    batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, laneHandoffGapPayload({
      lane, code: 'GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH', legacy: true,
      problems: ['本批无 `batch.handoffs` 字段（存量批）⇒ 出口侧交接门放行；本 lane 结算**未**受交接约束（不静默、不砸存量）'],
    })));
  } else if (!shg.ok) {
    batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, laneHandoffGapPayload({
      lane, code: shg.code, missing: shg.missing, problems: shg.problems,
    })));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    throw new Error(shg.code + ': ' + (shg.missing ?? []).join(', ') + (shg.problems?.length ? ' ——' + shg.problems[0] : ''));
  } else if (shg.humanException === true) {
    batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note: 'handoff-exception: ' + String(note ?? '') }));
  }
  const preflightTask = findTask(batch, lane);
  const preflight = detectPreflightReport(
    artifactsDirOf(sessionId, batchId),
    declaredArtifactsOf(preflightTask),
  );
  if (preflight.reason !== null) {
    batch.events.push(newEvent(EVT.EVT_PREFLIGHT_REPORT_MISSING, {
      lane,
      reason: preflight.reason,
      missing: preflight.missing,
      states: preflight.fields,
      artifacts: preflight.artifacts,
      soft: true,
    }));
    try {
      const warnOf = (log && typeof log.warn === 'function') ? log.warn.bind(log) : console.warn;
      warnOf('[dsh-punky-swarm] lane ' + lane + ' merged 放行，但回报三字段不全：'
        + (preflight.missing.length
          ? preflight.missing.map((f) => f + ':' + preflight.fields[f]).join(' ')
          : '（无声明产物，无可核产物 ' + preflight.reason + '）')
        + '（软检查，不阻断；audit 验收会核）');
    } catch { }
  }
  }

  function setPhase(sessionId, batchId, to, { reason = null } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const emitContractMissing = makeContractMissingSink(() => batch, () => null);
    schema.assertBatchPhase(to);
    const from = batch.phase;
    const reasonStr = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
    const bv = machine.applyBatchTransition(from, to, { rules: ratchet });
    if (!bv.ok) throw new Error('invalid batch phase transition: ' + from + ' -> ' + to);
    if (to === 'complete') {
      const g = gates.checkCompleteGate(batch);
      emitContractMissing(g);
      if (!g.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_COMPLETE_BLOCKED, { code: g.code, pending: g.pending }));
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
        throw new Error(g.code + (g.pending ? ': ' + g.pending.join(', ') : ''));
      }
    }
    batch.phase = to;
    batch.events.push(newEvent(EVT.EVT_BATCH_PHASE, reasonStr ? { from, to, reason: reasonStr } : { from, to }));
    const propagation = evaluatePropagationOf(batch, ratchet);
    let memoryStale = null;
    if (isTerminalPhase(to)) {
      const items = memoryStaleItemsOf(batch);
      const manifestPath = memoryStaleManifestPathOf(sessionId, batchId, artifactsDirOf);
      memoryStale = {
        trigger: to,
        items,
        manifestPath,
        written: false,
        writeError: null,
        propagation,
      };
      try {
        if (typeof artifactsDirOf === 'function') {
          fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
          fs.writeFileSync(manifestPath, JSON.stringify({
            schema: 'punky-memory-stale-recommended@1',
            batchId,
            phase: to,
            generatedAt: new Date().toISOString(),
            manifestPath,
            executor: 'leader',
            reversible: true,
            actionNote: 'action 仅为建议；实际 memory_archive / memory_forget 由 Leader 执行，两者均可逆（不删）',
            items,
            propagation,
          }, null, 2) + '\n', 'utf8');
          memoryStale.written = true;
        } else {
          memoryStale.writeError = 'artifactsDirOf-unavailable';
        }
      } catch (err) {
        memoryStale.writeError = String((err && err.message) || err);
      }
      try {
        batch.events.push(newEvent(EVT.EVT_MEMORY_STALE_RECOMMENDED, {
          phase: to,
          count: items.length,
          lanes: items.map((it) => it.lane),
          manifest: manifestPath,
          manifestWritten: memoryStale.written,
          ...(memoryStale.writeError ? { manifestError: memoryStale.writeError } : {}),
          executor: 'leader',
          reversible: true,
          ...(propagation ? { propagationAffected: propagation.affected, propagationVersion: propagation.version } : {}),
        }));
      } catch { }
    }
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    emitStateChange({ type: 'batch.phase', sessionId, batchId, from, to, ...(reasonStr ? { reason: reasonStr } : {}) });
    if (to === 'complete') {
      try {
        archive.archiveBatch(sessionId, batchId);
      } catch (err) {
        try {
          const b = readBatch(sessionId, batchId);
          if (b) {
            b.events.push(newEvent(EVT.EVT_ARCHIVE_FAILED, { reason: String((err && err.message) || err) }));
            b.updatedAt = new Date().toISOString();
            commitBatch(sessionId, batchId, b);
          }
        } catch { }
      }
    }
    return batch;
  }

  return { runMergedGateChain, setPhase };
}
