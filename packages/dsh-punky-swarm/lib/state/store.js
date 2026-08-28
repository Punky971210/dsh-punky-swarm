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
import { createCorruptRegistry } from './corrupt-registry.js'; // 损坏批次旁路清单（v2-node-robustness ②）
import { SESSION_RE } from './constants.js'; // P1-07 单点（原本文件 :32 定义迁出）
import { laneProgressClear, laneProgressWrite } from './resume.js'; // P1-02 断点指针：结算终态清退 + 原子写合并（纯函数，本文件落盘）
// P1-04 单点：findTask 收敛至 task-utils.js（原 :430 本地定义删除）
import { findTask } from './task-utils.js';
// P2-07 事件 type 常量单点：newEvent 调用 type 一律引用本模块常量（禁止裸字面量）
import * as EVT from './event-types.js';

const STORE_SCHEMA = BATCH_SCHEMA_V3;

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // Windows: MoveFileEx REPLACE_EXISTING
}

// C 子项：连续失败升级（spec C）——计数纯函数（顶层导出，供单测）：
// 从事件流末尾向前扫描，统计连续 member.settled 且 to === 'failed' 的事件数（含本次刚 push 的结算）；
// 遇 member.settled 但 to !== 'failed'（merged/conflict/skipped/review/running 等）即停止（归零语义 C-计数）；
// 非 member.settled 事件（worktree.checkpoint / batch.phase / gate.* 等）不打断计数。
export function countConsecutiveFailedSettles(events) {
  const evs = events ?? [];
  let count = 0;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (!e || e.type !== EVT.EVT_MEMBER_SETTLED) continue;
    if (e.to === 'failed') count++;
    else break;
  }
  return count;
}

export function createStore(root, { rules, logger, onStateChange } = {}) {
  const sessionsDir = path.join(root, 'sessions');
  const legacyDir = path.join(root, 'batches');
  const gates = createGates(root);
  // 损坏批次旁路清单（②，D-001）：与 governance.json 同层；批次 JSON 结构零变更
  const corruptRegistry = createCorruptRegistry(root);
  // 留痕日志（可选注入；缺省 console——与 index.js ctx.logger 解耦，保持 createStore 既有调用点零改动）
  const log = logger ?? console;
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
    if (!SESSION_RE.test(batchId)) throw new Error('invalid batchId');
    return path.join(batchesDirOf(sessionId), batchId + '.json');
  }

  function newEvent(type, fields = {}) {
    return { ts: new Date().toISOString(), type, ...fields };
  }

  // R2 状态事件发布钩子（topic 接线）：setMember/setPhase 调用点埋点——
  // appendEvent 为闭包内部函数，外部 wrap 该导出属性无法拦截内部迁移（设计 §3.2.3 固化），
  // 故必须在调用点埋（设计 §4.3/§5.3 风险点 2）。onStateChange 缺省未装配（topic 默认关）→ 零行为变化；
  // 异常隔离（发布失败不阻断状态机）。载荷为纯数据摘要，topic 命名由装配侧（topic-runtime）负责。
  function emitStateChange(ev) {
    try { onStateChange?.(ev); } catch { /* 隔离：topic 发布失败不阻断状态机 */ }
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
      events: [newEvent(EVT.EVT_BATCH_CREATED, { batchId, sessionId })],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(file, batch);
    return batch;
  }

  // 三态读取基础函数（readBatch 的语义来源，纯读取无副作用）：
  //   { status:'ok', batch } | { status:'missing' } | { status:'corrupt', error }
  function readBatchResult(sessionId, batchId) {
    const file = batchFile(sessionId, batchId);
    if (!fs.existsSync(file)) return { status: 'missing' };
    try {
      return { status: 'ok', batch: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      return { status: 'corrupt', error: err };
    }
  }

  function readBatch(sessionId, batchId) {
    const res = readBatchResult(sessionId, batchId);
    if (res.status === 'corrupt') {
      // 损坏隔离（②，P0，D-001）：幂等登记旁路清单；仅首次登记时 warn 留痕（INV-2 不重复刷日志）；
      // 损坏与不存在共用 null 返回值——需区分语义的调用方走 isCorrupt() 二次查询
      const r = corruptRegistry.markBatchCorrupt(sessionId, batchId, res.error);
      if (r.first) {
        log.warn?.('[dsh-punky-swarm] corrupt batch isolated: ' + sessionId + '/' + batchId
          + ' (' + ((res.error && res.error.message) || res.error) + ')；已登记 corrupt-batches.json，'
          + '修复/删除文件后经 clearCorruptMark 清除标记');
      }
      return null;
    }
    return res.batch; // ok → batch；missing → undefined（调用点按 null 语义处理）
  }

  // 区分「损坏」与「不存在」（readBatch 两者均返回 null）
  function isCorrupt(sessionId, batchId) {
    return corruptRegistry.isCorrupt(sessionId, batchId);
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
    let batch = readBatch(sessionId, batchId); // let：P1-02 终态清退经 laneProgressClear 返回新 batch（不突变入参）
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
        // P1-02：condition 自动 skipped 亦为结算终态——清退 laneProgress 断点指针（不残留脏指针）
        batch = laneProgressClear(batch, lane);
        batch.lanes[lane] = 'skipped'; // pending→skipped 既有合法迁移
        batch.events.push(newEvent(EVT.EVT_LANE_SKIPPED, { lane, from, note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.events.push(newEvent(EVT.EVT_MEMBER_SETTLED, { lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        // R2 调用点埋点：condition 自动 skipped 亦为结算终态（member.settled 事件发布）
        emitStateChange({ type: 'member.settled', sessionId, batchId, lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') });
        return batch;
      }
      const g = gates.checkEntryGate(sessionId, batchId, batch, lane);
      if (!g.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_ENTRY_MISSING, { lane, missing: g.missing }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + ': ' + g.missing.join(', '));
      }
    }
    if (to === 'review') {
      // audit lane 产物含 needHuman 声明 → 事件 lane.needhuman 留痕（Manager 转达人工裁决）
      const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, null);
      if (nh.declared) batch.events.push(newEvent(EVT.EVT_LANE_NEEDHUMAN, { lane, path: nh.path }));
    }
    if (to === 'merged') {
      const g = gates.checkExitGate(sessionId, batchId, batch, lane);
      if (!g.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_EXIT_MISSING, { lane, code: g.code, detail: g.problems ?? g.missing }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + ': ' + (g.problems ?? g.missing).join(', '));
      }
      batch.events.push(newEvent(EVT.EVT_GATE_PASSED, { lane, gate: 'exit' }));
      // targets 门禁（O2，设计 §1.3）：exec 层声明 targets（批次产物根外目标文件）→ merged 前置校验——
      // exit gate 之后、command gate 之前（增量接线，不改既有门禁顺序与语义）。
      // 失败（missing/unchanged）→ gate.target_blocked 事件 + 抛错拒 merged（lane 留 review，成员态不变，与 exit gate 同语义）；
      // 通过且 declared → gate.target.passed 事件留痕；未声明/非 exec/逃生阀 → 零感知（无事件）。
      const tg = gates.checkTargetsGate(sessionId, batchId, batch, lane);
      if (!tg.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_TARGET_BLOCKED, { lane, code: tg.code, missing: tg.missing ?? [], unchanged: tg.unchanged ?? [] }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(tg.code + ': targets 未通过校验（missing=' + (tg.missing ?? []).join(', ') + '; unchanged=' + (tg.unchanged ?? []).join(', ') + '）');
      }
      if (tg.declared) {
        batch.events.push(newEvent(EVT.EVT_GATE_TARGET_PASSED, { lane, mode: tg.mode ?? 'mtime', targets: tg.targets ?? [] }));
      }
      // 命令 gate（V1，设计 §组件 4）：exec 层产物声明行 `gate: <命令>` → merged 前置确定性执行（checkExitGate 之后、needHuman 之前）
      // 成功/未声明 → gate.exit 事件（declared 时）后继续；失败+needHuman 声明 → 转人工闸（escalation，merged 须 note 含 human: 证据）；
      // 失败+未声明 → gate.exit_blocked 事件 + 抛 GATE_EXIT_*（拒 merged，lane 留 review）
      const cg = gates.checkCommandGate(sessionId, batchId, batch, lane);
      if (!cg.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_EXIT_BLOCKED, { lane, code: cg.code, command: cg.command ?? null, exitCode: cg.exitCode ?? null, detail: cg.detail ?? null, escalation: cg.needHumanEscalation === true }));
        if (cg.needHumanEscalation) {
          // 转人工闸：复用 needHuman 证据契约（note 含 `human:<裁决人>:<时间>:<结论>`）；无证据 → GATE_NEEDHUMAN_PENDING 挂起
          const evidence = typeof note === 'string' ? (note.match(/^human:.+/m) ?? [null])[0] : null;
          if (!evidence) {
            batch.updatedAt = new Date().toISOString();
            atomicWrite(batchFile(sessionId, batchId), batch);
            throw new Error('GATE_NEEDHUMAN_PENDING: 命令 gate 失败（' + cg.code + '）且产物声明 needHuman，merged 须 note 含 human: 证据');
          }
          batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note })); // 人工裁决留痕（note 可回溯）
        } else {
          batch.updatedAt = new Date().toISOString();
          atomicWrite(batchFile(sessionId, batchId), batch);
          throw new Error(cg.code + ': ' + (cg.detail ?? 'command gate failed'));
        }
      } else if (cg.declared) {
        batch.events.push(newEvent(EVT.EVT_GATE_EXIT, { lane, commands: cg.commands ?? [], results: cg.results ?? [], outputTruncated: cg.outputTruncated === true }));
      }
      // needHuman 人工闸（merged 前置，与 checkExitGate 并列）——声明 lane 缺 human: 证据 → 拒 GATE_NEEDHUMAN_PENDING
      const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, note);
      if (!nh.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_NEEDHUMAN_BLOCKED, { lane, code: nh.code, path: nh.path }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(nh.code + ': ' + nh.message);
      }
      if (nh.declared) batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note })); // 人工裁决留痕（note 可回溯）
    }
    // P1-02：lane 结算终态（merged/failed/skipped/conflict，member_settle 语义）清退 laneProgress
    // 断点指针（不残留脏指针；批次 complete 后整块随批次归档由 archive 覆盖）
    if (schema.isMemberTerminal(to)) batch = laneProgressClear(batch, lane);
    batch.lanes[lane] = to;
    batch.events.push(newEvent(EVT.EVT_MEMBER_SETTLED, { lane, from, to, note: note ?? null }));
    // C 子项：连续失败升级（spec C）——failed 结算后计数：同批次最近连续 failed ≥3 且批次 running → 触发 paused。
    // 单次原子写：paused 迁移 + batch.phase 事件 + batch.failed-escalate 事件与本次结算同批落盘（不调 setPhase 二次写盘，避免竞态）。
    // 棘轮校验 fail-closed：running→paused 迁移被部署收紧删除时 bv.ok=false，不触发、不绕过棘轮；
    // phase 闸（T-2）：paused 后 phase 非 running 自然不重复；人工 resume 后计数从当前事件流重新评估；
    // 不自动重试：failed 仍为终态（schema failed: [] 不变），重做=重开新批次。
    let escalated = false;
    if (to === 'failed' && batch.phase === 'running') {
      const streak = countConsecutiveFailedSettles(batch.events);
      if (streak >= 3) {
        const bv = machine.applyBatchTransition('running', 'paused', { rules: ratchet });
        if (bv.ok) {
          batch.phase = 'paused';
          batch.events.push(newEvent(EVT.EVT_BATCH_PHASE, { from: 'running', to: 'paused', reason: 'failed-escalate' }));
          batch.events.push(newEvent(EVT.EVT_BATCH_FAILED_ESCALATE, { lane, count: streak }));
          escalated = true;
        }
      }
    }
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    // R2 调用点埋点：member.settled（结算终态/返工入 review 等全部迁移）+ 伴随的 batch.phase（failed-escalate）
    emitStateChange({ type: 'member.settled', sessionId, batchId, lane, from, to, note: note ?? null });
    if (escalated) {
      emitStateChange({ type: 'batch.phase', sessionId, batchId, from: 'running', to: 'paused', reason: 'failed-escalate' });
    }
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
        batch.events.push(newEvent(EVT.EVT_GATE_COMPLETE_BLOCKED, { code: g.code, pending: g.pending }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + (g.pending ? ': ' + g.pending.join(', ') : ''));
      }
    }
    batch.phase = to;
    batch.events.push(newEvent(EVT.EVT_BATCH_PHASE, { from, to }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    // R2 调用点埋点：batch.phase 迁移事件发布（规划→运行→暂停→终态等全部阶段迁移）
    emitStateChange({ type: 'batch.phase', sessionId, batchId, from, to });
    // complete 钩子——门禁通过 + phase 写入后自动归档（单向、幂等）；
    // 失败仅记录 archive.failed（archiveBatch 内部处理），不阻断 complete；try/catch 兜底意外异常（如批次文件不可读）
    if (to === 'complete') {
      try {
        archive.archiveBatch(sessionId, batchId);
      } catch (err) {
        try {
          const b = readBatch(sessionId, batchId);
          if (b) {
            b.events.push(newEvent(EVT.EVT_ARCHIVE_FAILED, { reason: String((err && err.message) || err) }));
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

  // ---- P1-02 断点指针持久化（laneProgress）----
  // updateLaneProgress：lane_checkpoint 携带 progress 时经 laneProgressWrite 纯函数合并后原子写
  // （不突变入参；worktree.checkpoint 事件留痕由调用方 lane-tools 承担，本接口只写指针）。
  // 清退走 setMember 终态分支（laneProgressClear），本接口只增不删。
  function updateLaneProgress(sessionId, batchId, lane, progress) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = laneProgressWrite(batch, lane, progress);
    next.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), next);
    return next;
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
    batch.events.push(newEvent(EVT.EVT_ASSET_CLAIMED, { lane: null, source, target }));
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
    const corrupt = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) {
        const batch = readBatch(sessionId, batchId);
        if (!batch) {
          // 损坏批次隔离（②，P0）：登记已由 readBatch 幂等完成（first 才 warn）；汇总 corrupt 后跳过，不击穿循环（INV-1）
          if (isCorrupt(sessionId, batchId)) corrupt.push(sessionId + '/' + batchId);
          continue;
        }
        if (schema.isBatchTerminal(batch.phase)) continue;
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
          batch.events.push(newEvent(EVT.EVT_SYSTEM_RECOVERED, { batchId, sessionId, recoveredLanes, detail }));
          batch.updatedAt = new Date().toISOString();
          atomicWrite(batchFile(sessionId, batchId), batch);
          recovered.push(sessionId + '/' + batchId);
        }
      }
    }
    // 向后兼容：返回数组形态（.length/.join 兼容 index.js:86-87 既有消费与 resume.js:60 原样透传）；
    // corrupt 汇总以非破坏性属性暴露（设计「{ recovered, corrupt }」语义经 recovered.corrupt 获得）
    recovered.corrupt = corrupt;
    if (corrupt.length) {
      log.warn?.('[dsh-punky-swarm] recovery skipped ' + corrupt.length + ' corrupt batch(es): ' + corrupt.join(', '));
    }
    return recovered;
  }

  // 孤儿 worker 显式回收（③，P1，设计 D-002/D-003）：lane.stalled 处置扩展——只标记 → 可显式回收。
  // 语义：管理命令（显式触发，仿 recoverBatches 直写先例，不经棘轮表/不放宽 MEMBER_TRANSITIONS，C-5）；
  //       默认不自动处置（人审保留，D-003）；lane.stalled 仍非成员状态（不新增成员态，W7 语义保持）。
  // 前置校验：批次不存在/损坏 → throw；lane 非 running → throw（防双回收/误回收，INV-4：终态 lane 永不回收）。
  // 事件：lane.recycled { lane, from:'running', reason:'stalled', note } 留痕；回收后走既有 member_status idle→running 重派（①）。
  function recycleStalledLane(sessionId, batchId, lane) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    if (batch.lanes[lane] !== 'running') throw new Error('lane not running: ' + lane + ' (state=' + batch.lanes[lane] + ')');
    // 校验该 lane 存在 lane.stalled 事件（batch.events 反查；stalled 只标记，回收须有停滞证据）
    const hasStalled = (batch.events ?? []).some((e) => e.type === 'lane.stalled' && e.lane === lane);
    if (!hasStalled) throw new Error('no lane.stalled event for lane: ' + lane + ' (recycle requires stalled evidence)');
    batch.lanes[lane] = 'idle';
    batch.events.push(newEvent(EVT.EVT_LANE_RECYCLED, { lane, from: 'running', reason: 'stalled', note: null }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return { ok: true, lane, from: 'running', to: 'idle' };
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
    createBatch, readBatch, readBatchResult, isCorrupt, listBatches, listSessions, listAllBatches,
    setMember, setPhase, appendEvent, claimAsset,
    readChains, updateChains, updateLaneProgress, // P1-02：laneProgress 断点指针持久化
    batchSettled, batchAutoReleaseable,
    recoverBatches, recycleStalledLane, migrateLegacy, batchFile, sessionsDir, artifactsDirOf, gateStatus: gates.gateStatus,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    // 损坏旁路清单（②）：幂等登记 / 只读清单 / 人工修复后清除标记（透传 corrupt-registry）
    corruptRegistry: { markBatchCorrupt: corruptRegistry.markBatchCorrupt, listCorruptBatches: corruptRegistry.listCorruptBatches, clearCorruptMark: corruptRegistry.clearCorruptMark, corruptFileOf: corruptRegistry.corruptFileOf },
    // 归档只读/幂等面（batch_status 面板与审计查询用）
    archive: { archiveBatch: archive.archiveBatch, readManifest: archive.readManifest, listArchived: archive.listArchived },
  };
}
