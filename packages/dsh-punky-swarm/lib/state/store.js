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

// BatchStore：批次状态文件唯一事实源（原子写 + 事件日志 + 状态机迁移 + 恢复语义）
// v2：批次绑定 session——root/sessions/<sessionId>/batches/*.json；存量 root/batches 迁移到 legacy
// Tier3：层间门禁（entry/exit/Plan 契约/complete）由 state/gates.js 承担，createStore 经 createGates(root) 注入调用
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../schema.js';
import { createGates, isAbsPath } from './gates.js';
import { BATCH_SCHEMA_V3, migrateV2toV3, chainsDefaults, conditionDefaults } from './schema-v3.js';
import * as machine from './machine.js';
import { loadRules } from './machine-rules.js';
import { createArchive } from './archive.js'; // done→archive（complete 钩子）

const STORE_SCHEMA = BATCH_SCHEMA_V3;
const SESSION_RE = /^[a-zA-Z0-9._-]+$/;

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // Windows: MoveFileEx REPLACE_EXISTING
}

export function createStore(root, { rules } = {}) {
  const sessionsDir = path.join(root, 'sessions');
  const legacyDir = path.join(root, 'batches');
  const gates = createGates(root);
  // 棘轮规则表（createStore(root, { rules }) 可选注入 loadRules 产物；未注入 = 默认规则 = schema 常量同引用，行为不变）
  const ratchet = rules ?? loadRules();
  // 归档器装配（createStore 签名不变；归档目标 = <root>/sessions/<sid>/archive/<bid>/）
  const archive = createArchive(root);

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
  // condition 校验的 fileExists DI（machine 纯逻辑，路径解析在本侧）——相对路径解析到批次产物根，绝对路径直接用；存在性判定（existsSync）
  function conditionFileExists(sessionId, batchId) {
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    return (p) => fs.existsSync(isAbsPath(p) ? p : path.join(artifactsDir, p));
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
      chains: chainsDefaults(), // C4：mailbox 环防护记账状态（v3 字段，唯一事实源）
      archived: false, // 单向归档标记（v3 可选字段，缺省 false；complete 归档后置 true）
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
    // 迁移判定走 machine（rules 可注入；默认规则与 schema 常量同引用，行为不变）
    const mv = machine.applyMemberTransition(from, to, { rules: ratchet });
    if (!mv.ok) throw new Error('invalid member transition: ' + from + ' -> ' + to);
    // Tier3 门禁：派发（condition + entry）与结算（exit/Plan 契约）+ needHuman（review 挂起检测 / merged 人工裁决闸）
    if (to === 'running') {
      // 派发前条件校验（lane.condition 静态声明，DI fileExists）——不满足 → 不派发、自动落 skipped（既有终态迁移）+ lane.skipped 事件；wavePlan 不动不重算
      const cond = machine.checkDispatchCondition(sessionId, batchId, batch, lane, { fileExists: conditionFileExists(sessionId, batchId) });
      if (!cond.ok) {
        // 落 skipped 同样过棘轮表（fail-closed 优先：收紧配置删掉 from→skipped 时拒绝自动跳过，不绕过规则表）
        const skip = machine.applyMemberTransition(from, 'skipped', { rules: ratchet });
        if (!skip.ok) {
          throw new Error('invalid member transition: ' + from + ' -> skipped (condition unmet: ' + cond.missing.join(', ') + '; ratchet forbids auto-skip)');
        }
        batch.lanes[lane] = 'skipped'; // pending→skipped 既有合法迁移
        batch.events.push(newEvent('lane.skipped', { lane, from, note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.events.push(newEvent('member.settled', { lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        return batch;
      }
      const g = gates.checkEntryGate(sessionId, batchId, batch, lane);
      if (!g.ok) {
        batch.events.push(newEvent('gate.entry.missing', { lane, missing: g.missing }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + ': ' + g.missing.join(', '));
      }
    }
    if (to === 'review') {
      // audit lane 产物含 needHuman 声明 → 事件 lane.needhuman 留痕（Manager 转达人工裁决）
      const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, null);
      if (nh.declared) batch.events.push(newEvent('lane.needhuman', { lane, path: nh.path }));
    }
    if (to === 'merged') {
      const g = gates.checkExitGate(sessionId, batchId, batch, lane);
      if (!g.ok) {
        batch.events.push(newEvent('gate.exit.missing', { lane, code: g.code, detail: g.problems ?? g.missing }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + ': ' + (g.problems ?? g.missing).join(', '));
      }
      batch.events.push(newEvent('gate.passed', { lane, gate: 'exit' }));
      // needHuman 人工闸（merged 前置，与 checkExitGate 并列）——声明 lane 缺 human: 证据 → 拒 GATE_NEEDHUMAN_PENDING
      const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, note);
      if (!nh.ok) {
        batch.events.push(newEvent('gate.needhuman_blocked', { lane, code: nh.code, path: nh.path }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(nh.code + ': ' + nh.message);
      }
      if (nh.declared) batch.events.push(newEvent('human.decision', { lane, note })); // 人工裁决留痕（note 可回溯）
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
    // 批次阶段迁移判定走 machine（rules 可注入；默认规则与 schema 常量同引用，行为不变）
    const bv = machine.applyBatchTransition(from, to, { rules: ratchet });
    if (!bv.ok) throw new Error('invalid batch phase transition: ' + from + ' -> ' + to);
    if (to === 'complete') {
      const g = gates.checkCompleteGate(batch);
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
    // complete 钩子——门禁通过 + phase 写入后自动归档（单向、幂等）；
    // 失败仅记录 archive.failed（archiveBatch 内部处理），不阻断 complete；try/catch 兜底意外异常（如批次文件不可读）
    if (to === 'complete') {
      try {
        archive.archiveBatch(sessionId, batchId);
      } catch (err) {
        try {
          const b = readBatch(sessionId, batchId);
          if (b) {
            b.events.push(newEvent('archive.failed', { reason: String((err && err.message) || err) }));
            b.updatedAt = new Date().toISOString();
            atomicWrite(batchFile(sessionId, batchId), b);
          }
        } catch { /* 兜底也失败：静默（complete 已置位，审计可经 archive/ 目录状态判断） */ }
      }
    }
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

  // ---- C4 budget：chains 状态读写（批次 v3 字段，原子写复用 atomicWrite）----
  // readChains：读 batch.chains；v2 存量批次经 migrateV2toV3 幂等补默认（只读不落盘）
  function readChains(sessionId, batchId) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) return null;
    return migrateV2toV3(batch).chains ?? chainsDefaults();
  }
  // updateChains：patch = 完整新 chains 状态（recordChain 纯函数产出），原子写；v2 存量批次迁移落盘（schema 升 3 + chains 补全）
  function updateChains(sessionId, batchId, patch) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = migrateV2toV3(batch);
    next.chains = patch ?? chainsDefaults();
    next.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), next);
    return next.chains;
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

  // ---- 恢复审计辅助（只读探测，无副作用）----
  // task 契约查找（与 gates.findTask 同遍历语义：wavePlan[].tasks 按 id 匹配）
  function findTask(batch, lane) {
    for (const w of batch.wavePlan ?? []) {
      for (const t of w.tasks) if (t.id === lane) return t;
    }
    return null;
  }
  // lastActiveAt（上次活动时间）：events 中该 lane 最近一条带 lane 字段事件（member.settled / worktree.checkpoint /
  // lane.skipped / lane.needhuman 等）的 ts；无 lane 事件 → 回退 batch.updatedAt
  function lastActiveAtOf(batch, lane) {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].lane === lane && evs[i].ts) return evs[i].ts;
    }
    return batch.updatedAt;
  }
  // produced（已产出产物清单）：复用 gate 语义（gates.js fileExistsNonEmpty 同款判定：目录或 size>0）——
  // 契约字段 exec→outputs / plan·audit→produce，逐项探测 artifactsDirOf 下解析路径存在且非空；
  // 产出清单 = 契约中已存在的相对路径数组（绝对路径契约按 resolveArtifact 语义直接探测）
  function producedOf(sessionId, batchId, batch, lane) {
    const t = findTask(batch, lane);
    if (!t) return [];
    const field = t.layer === 'exec' ? 'outputs' : (t.layer === 'plan' || t.layer === 'audit' ? 'produce' : null);
    if (!field || !Array.isArray(t[field])) return [];
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    const existsNonEmpty = (p) => {
      try {
        const st = fs.statSync(isAbsPath(p) ? p : path.join(artifactsDir, p));
        return st.isDirectory() || st.size > 0;
      } catch { return false; }
    };
    return t[field].filter(existsNonEmpty);
  }

  function recoverBatches() {
    const recovered = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) {
        const batch = readBatch(sessionId, batchId);
        if (!batch || schema.isBatchTerminal(batch.phase)) continue;
        const recoveredLanes = [];
        const detail = [];
        for (const [lane, state] of Object.entries(batch.lanes)) {
          if (state === 'running' || state === 'review') {
            batch.lanes[lane] = 'idle';
            recoveredLanes.push(lane);
            // 审计详情：from 原态 / lastActiveAt 反查 / produced 复用 gate 语义（置 idle 前采集，只读不改产物）
            detail.push({ lane, from: state, lastActiveAt: lastActiveAtOf(batch, lane), produced: producedOf(sessionId, batchId, batch, lane) });
          }
        }
        if (recoveredLanes.length > 0) {
          // 保留 recoveredLanes（向后兼容，既有测试断言其存在），新增 detail 审计详情数组
          batch.events.push(newEvent('system.recovered', { batchId, sessionId, recoveredLanes, detail }));
          batch.updatedAt = new Date().toISOString();
          atomicWrite(batchFile(sessionId, batchId), batch);
          recovered.push(sessionId + '/' + batchId);
        }
      }
    }
    return recovered;
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
    readChains, updateChains,
    batchSettled, batchAutoReleaseable,
    recoverBatches, migrateLegacy, batchFile, sessionsDir, artifactsDirOf, gateStatus: gates.gateStatus,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    // 归档只读/幂等面（batch_status 面板与审计查询用）
    archive: { archiveBatch: archive.archiveBatch, readManifest: archive.readManifest, listArchived: archive.listArchived },
  };
}
