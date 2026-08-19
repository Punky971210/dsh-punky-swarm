// BatchStore：批次状态文件唯一事实源（原子写 + 事件日志 + 状态机迁移 + 恢复语义）
// v2：批次绑定 session——root/sessions/<sessionId>/batches/*.json；存量 root/batches 迁移到 legacy
// Tier3：层间门禁（设计 §3.3/§四/§五/§15）——entry（consume 前置）/ exit（outputs/produce 前置 + L0 checkPlanContract）/ complete（audit 验收前置）
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.js';

const STORE_SCHEMA = 2;
const SESSION_RE = /^[a-zA-Z0-9._-]+$/;

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // Windows: MoveFileEx REPLACE_EXISTING
}

export function createStore(root) {
  const sessionsDir = path.join(root, 'sessions');
  const legacyDir = path.join(root, 'batches');

  function sessionDir(sessionId) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionsDir, sessionId);
  }
  function batchesDirOf(sessionId) {
    return path.join(sessionDir(sessionId), 'batches');
  }
  function artifactsDirOf(sessionId, batchId) {
    return path.join(sessionDir(sessionId), 'artifacts', batchId);
  }

  // 存量迁移：root/batches/*.json -> sessions/legacy/batches/（一次，幂等）
  function migrateLegacy() {
    if (!fs.existsSync(legacyDir)) return 0;
    let moved = 0;
    for (const f of fs.readdirSync(legacyDir)) {
      if (!f.endsWith('.json')) continue;
      const dst = path.join(batchesDirOf('legacy'), f);
      fs.mkdirSync(batchesDirOf('legacy'), { recursive: true });
      fs.renameSync(path.join(legacyDir, f), dst);
      moved++;
    }
    try { fs.rmdirSync(legacyDir); } catch {}
    return moved;
  }

  function batchFile(sessionId, batchId) {
    if (!/^[a-zA-Z0-9._-]+$/.test(batchId)) throw new Error('invalid batchId');
    return path.join(batchesDirOf(sessionId), batchId + '.json');
  }

  function newEvent(type, fields = {}) {
    return { ts: new Date().toISOString(), type, ...fields };
  }

  // ---- Tier3 门禁辅助 ----
  function isAbsPath(p) {
    return /^[A-Za-z]:[\\/]|^\\|^\//.test(p);
  }
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
    try { return fs.statSync(p).size > 0; } catch { return false; }
  }
  // Entry Gate（设计 §四）：exec lane 派发前 consume 必须全部存在且非空
  function checkEntryGate(sessionId, batchId, batch, lane) {
    const t = findTask(batch, lane);
    if (!t || t.layer !== 'exec' || !Array.isArray(t.consume) || t.consume.length === 0) return { ok: true };
    const missing = t.consume.filter((p) => !fileExistsNonEmpty(resolveArtifact(sessionId, batchId, p)));
    return missing.length ? { ok: false, code: 'GATE_ENTRY_MISSING', missing } : { ok: true };
  }
  // L0 产物结构校验（设计 §3.3/§15.3 N5）：仅 plan 产物——spec 必填章节 + task-tree JSON 可解析
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
  // Exit Gate（设计 §五）：exec→outputs 存在；audit→produce 存在；plan→L0 契约
  function checkExitGate(sessionId, batchId, batch, lane) {
    const t = findTask(batch, lane);
    if (!t || !t.layer) return { ok: true };
    if (t.layer === 'plan') return checkPlanContract(sessionId, batchId, batch, lane);
    const field = t.layer === 'exec' ? 'outputs' : (t.layer === 'audit' ? 'produce' : null);
    if (!field || !Array.isArray(t[field]) || t[field].length === 0) return { ok: true };
    const missing = t[field].filter((p) => !fileExistsNonEmpty(resolveArtifact(sessionId, batchId, p)));
    return missing.length ? { ok: false, code: 'GATE_EXIT_MISSING_' + t.layer.toUpperCase(), missing } : { ok: true };
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

  function createBatch(sessionId, { batchId, wavePlan, concurrency = 5, phase = 'planning' }) {
    schema.assertBatchPhase(phase);
    const file = batchFile(sessionId, batchId);
    if (fs.existsSync(file)) throw new Error('batch already exists: ' + batchId);
    const lanes = {};
    for (const w of wavePlan.wavePlan) {
      for (const t of w.tasks) lanes[t.id] = 'pending';
    }
    const batch = {
      schema: STORE_SCHEMA,
      sessionId,
      batchId,
      phase,
      concurrency,
      team: wavePlan.team ?? 'generic',
      wavePlan: wavePlan.wavePlan,
      lanes,
      events: [newEvent('batch.created', { batchId, sessionId })],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(file, batch);
    return batch;
  }

  function readBatch(sessionId, batchId) {
    const file = batchFile(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function listBatches(sessionId) {
    const dir = batchesDirOf(sessionId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  function listSessions() {
    if (!fs.existsSync(sessionsDir)) return [];
    return fs.readdirSync(sessionsDir)
      .filter((s) => SESSION_RE.test(s) && fs.existsSync(batchesDirOf(s)) && fs.readdirSync(batchesDirOf(s)).some((f) => f.endsWith('.json')))
      .sort();
  }

  function setMember(sessionId, batchId, lane, to, note = null) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    schema.assertMemberState(to);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    const from = batch.lanes[lane];
    schema.assertMemberTransition(from, to);
    // Tier3 门禁：派发（entry）与结算（exit/L0）
    if (to === 'running') {
      const g = checkEntryGate(sessionId, batchId, batch, lane);
      if (!g.ok) {
        batch.events.push(newEvent('gate.entry.missing', { lane, missing: g.missing }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + ': ' + g.missing.join(', '));
      }
    }
    if (to === 'merged') {
      const g = checkExitGate(sessionId, batchId, batch, lane);
      if (!g.ok) {
        batch.events.push(newEvent('gate.exit.missing', { lane, code: g.code, detail: g.problems ?? g.missing }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + ': ' + (g.problems ?? g.missing).join(', '));
      }
      batch.events.push(newEvent('gate.passed', { lane, gate: 'exit' }));
    }
    batch.lanes[lane] = to;
    batch.events.push(newEvent('member.settled', { lane, from, to, note: note ?? null }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return batch;
  }

  function setPhase(sessionId, batchId, to) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    schema.assertBatchPhase(to);
    const from = batch.phase;
    schema.assertBatchTransition(from, to);
    if (to === 'complete') {
      const g = checkCompleteGate(batch);
      if (!g.ok) {
        batch.events.push(newEvent('gate.complete_blocked', { code: g.code, pending: g.pending }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + (g.pending ? ': ' + g.pending.join(', ') : ''));
      }
    }
    batch.phase = to;
    batch.events.push(newEvent('batch.phase', { from, to }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return batch;
  }

  function appendEvent(sessionId, batchId, type, fields = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    batch.events.push(newEvent(type, fields));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return batch;
  }

  // asset_claim 归位（设计 6.3/§4）：Leader 已直做产物复制进批次 artifacts/<batchId>/（保留内容，不移动），事件留痕。
  // 安全：target 必须是批次内相对路径——拒绝绝对路径、盘符前缀、.. / . / 空段；解析后仍须落在 artifacts 目录内（纵深防御）。
  function claimAsset(sessionId, batchId, { source, target }) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (typeof target !== 'string' || !target.length) throw new Error('invalid target path: ' + target + ' (must be batch-relative)');
    if (isAbsPath(target) || /^[A-Za-z]:/.test(target)) throw new Error('invalid target path: ' + target + ' (must be batch-relative, no absolute path)');
    const segments = target.split(/[\\/]+/);
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error('invalid target path: ' + target + ' (must be batch-relative, no .. or empty segment)');
    }
    let st;
    try { st = fs.statSync(source); } catch { throw new Error('source not found: ' + source); }
    if (!st.isFile()) throw new Error('source is not a file: ' + source);
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    const dest = path.join(artifactsDir, ...segments);
    const base = path.resolve(artifactsDir) + path.sep;
    if (!path.resolve(dest).startsWith(base)) throw new Error('target escapes artifacts dir: ' + target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest); // 保留内容，不移动（避免破坏已引用）
    batch.events.push(newEvent('asset.claimed', { lane: null, source, target }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return { ok: true, claimedPath: target, batchId };
  }

  function batchSettled(batch) {
    const lanes = Object.values(batch.lanes ?? {});
    return batch.phase === 'running' && lanes.length > 0 && lanes.every(schema.isMemberTerminal);
  }

  function batchAutoReleaseable(batch) {
    const lanes = Object.values(batch.lanes ?? {});
    if (!batch || lanes.length === 0) return false;
    return batch.phase === 'running' && lanes.every((s) => s === 'merged');
  }

  function recoverBatches() {
    const recovered = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) {
        const batch = readBatch(sessionId, batchId);
        if (!batch || schema.isBatchTerminal(batch.phase)) continue;
        let changed = false;
        for (const [lane, state] of Object.entries(batch.lanes)) {
          if (state === 'running' || state === 'review') {
            batch.lanes[lane] = 'idle';
            changed = true;
          }
        }
        if (changed) {
          batch.events.push(newEvent('system.recovered', { batchId, sessionId, recoveredLanes: Object.keys(batch.lanes).filter((l) => batch.lanes[l] === 'idle') }));
          batch.updatedAt = new Date().toISOString();
          atomicWrite(batchFile(sessionId, batchId), batch);
          recovered.push(sessionId + '/' + batchId);
        }
      }
    }
    return recovered;
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

  function listAllBatches() {
    const all = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) all.push({ sessionId, batchId });
    }
    return all;
  }

  // ---- 会话级治理状态（governance.json v2，design task-difficulty-gate §4）----
  // 每回合任务难度评估（A/B/C）的事实源：lastAssign + history 审计 + 执行型工具计数 + pendingBatch
  const GOV_SCHEMA = 2;
  function govDefaults() {
    return { schema: GOV_SCHEMA, execToolCount: 0, pendingBatch: false, pendingSince: null, lastAssign: null, history: [] };
  }
  function governanceFile(sessionId) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionDir(sessionId), 'governance.json');
  }
  // 无文件/损坏 → 返回默认（调用方无需判空）
  function readGovernance(sessionId) {
    const file = governanceFile(sessionId);
    if (!fs.existsSync(file)) return govDefaults();
    try { return { ...govDefaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch { return govDefaults(); }
  }
  // 原子写：读当前（或默认）→ 合并 patch → 落盘
  function writeGovernance(sessionId, patch) {
    const next = { ...readGovernance(sessionId), ...patch };
    atomicWrite(governanceFile(sessionId), next);
    return next;
  }
  // 执行型工具调用计数：execToolCount 累计 + lastAssign.execCallsSince 递增（评估后窗口内调用数）
  function bumpExecCount(sessionId) {
    const g = readGovernance(sessionId);
    g.execToolCount = (g.execToolCount ?? 0) + 1;
    if (g.lastAssign) g.lastAssign.execCallsSince = (g.lastAssign.execCallsSince ?? 0) + 1;
    atomicWrite(governanceFile(sessionId), g);
    return g;
  }
  // 评估过期判定：从未评估 / execCallsSince≥maxCalls(20) / 距 lastAssign.at≥maxAgeMs(30min)
  function stale(sessionId, { maxCalls = 20, maxAgeMs = 30 * 60 * 1000 } = {}) {
    const g = readGovernance(sessionId);
    if (!g.lastAssign) return true;
    if ((g.lastAssign.execCallsSince ?? 0) >= maxCalls) return true;
    const at = Date.parse(g.lastAssign.at);
    if (!Number.isFinite(at)) return true; // 时间戳非法按过期处理（宁严勿松）
    return Date.now() - at >= maxAgeMs;
  }
  // 会话内是否有活跃（非终态）批次：pendingBatch 语义基于此（建批后清锁、批次终态后旧锁失效）
  function hasActiveBatch(sessionId) {
    return listBatches(sessionId).some((id) => {
      const b = readBatch(sessionId, id);
      return b && !schema.isBatchTerminal(b.phase);
    });
  }

  return {
    createBatch, readBatch, listBatches, listSessions, listAllBatches,
    setMember, setPhase, appendEvent, claimAsset,
    batchSettled, batchAutoReleaseable,
    recoverBatches, migrateLegacy, batchFile, sessionsDir, artifactsDirOf, gateStatus,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
  };
}
