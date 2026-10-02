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

const STORE_SCHEMA = BATCH_SCHEMA_V3;

// 批次 CRUD / 读取 / 列表 / 事件追加 / 登记（批次 JSON 的读写面）——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../../schema.js';
// 装配声明 / 交接面 / 环防护记账默认值（v3 字段单点）
import { BATCH_SCHEMA_V3, migrateV2toV3, chainsDefaults, conditionDefaults, handoffsDefaults } from '../schema-v3.js';
// laneProgress 断点指针：原子写合并（纯函数，本文件落盘）
import { laneProgressWrite } from '../resume.js';
// 单点（原本文件定义迁出）
import { isAbsPath } from '../constants.js';
import * as EVT from '../event-types.js';

export function buildBatch(cx) {
  const { batchFile, artifactsDirOf, corruptRegistry, log, atomicWrite, commitBatch, newEvent, emitStateChange } = cx;

  // 【2026-09-27 · 批 3】原「团队资产解析快照」建批侧接线（`teamAssetRefFor` + `lib/assembly/snapshot.js` 导入）
  //   **已整条删除**：资产面全量退役 ⇒ 无资产可解析、无指纹可写、无事件可落。本文件对该面**零 I/O、零引用**。
  //   历史批磁盘上仍可能带 `teamAsset` / `teamsRoot` 键（读取侧零迁移，不解析、不回显）。

  // C+ 档装配声明（assembly，batch JSON 顶层可选字段）：缺省 undefined → 不写键（仿 laneProgress 零噪音模式，
  // schema 不升、旧批无键读取兼容零迁移——C+ 门禁归一化产物随建批持久化，供运行期/审计按需消费）
  // 【2026-09-18 · Q-B 取消并发闸】形参 `concurrency`（缺省 5）与下方落盘位**逐字不变**（纯声明 + 回显）：
  //   引擎内**不再有任何分支读它做准入**（原唯一执行点 = `lib/engine/dispatch.js` 的并发闸，已随 Q-B 删除）；
  //   保留字段的判据 = 既有批次 JSON 读取 / 面板数字 / `batch_status` 回显 / 既有测试断言逐字不变。
  // 【G-1 接线 · 2026-09-26】形参 `channel`（R-5 批级通道归属声明，归一化后值 = `dispatch|team|mixed`）：
  //   与 `assembly` 同一「**未声明不写键**」模式落盘为批次顶层字段（`batch.channel` = 通道归属唯一事实源，
  //   禁从事件流事后重建）；缺省 `undefined` ⇒ 键不存在 ⇒ 旧批/未声明批读端零感知、schema 不升、零迁移。
  //   本函数**只落盘**归一化结果，不做任何判定（单点判定 = `lib/wave-plan.ts#normalizeChannelDecl`，
  //   由建批路径 `lib/tools/core.js` 在 `createBatch` 之前调用并 throw）。
  function createBatch(sessionId, { batchId, wavePlan, concurrency = 5, phase = 'planning', assembly, channel }) {
    schema.assertBatchPhase(phase);
    const file = batchFile(sessionId, batchId);
    if (fs.existsSync(file)) throw new Error('batch already exists: ' + batchId);
    const lanes = {};
    for (const w of wavePlan.wavePlan) {
      for (const t of w.tasks) lanes[t.id] = 'pending';
    }
    // D-3 口径不变：`?? 'generic'` 兜底已清退（防第二默认值真源；历史批自带 `team:'generic'` 字段，读取侧零迁移）。
    //   【2026-09-27】建批面 `team` 降为**可选标签** ⇒ 无标签批的 `wavePlan.team` = `null`，此处**不代造默认值**。
    const team = wavePlan.team;
    const batch = {
      schema: STORE_SCHEMA,
      sessionId,
      batchId,
      phase,
      concurrency,
      team,
      wavePlan: wavePlan.wavePlan,
      lanes,
      chains: chainsDefaults(), // 环防护记账状态（v3 字段，唯一事实源）
      // P1 交接门（handoff gate）：**新建批恒写** `handoffs`（空对象 = 该批无 deps ⇒ 未交接门恒放行）。
      //   字段**存在性**即「本批受新门约束」的判据（裁决 ①=B：存量批无本键 ⇒ 放行 + `lane.handoff.gap` 告警）。
      //   建批期意图声明（裁决 ②=A 的判据来源）= 下方按 `task.deps` 逐边种一条 `status:'pending'` 交接。
      handoffs: handoffsDefaults(),
      archived: false, // 单向归档标记（v3 可选字段，缺省 false；complete 归档后置 true）
      ...(assembly !== undefined ? { assembly } : {}), // 装配声明（C+ 归一化 decl）；未声明不写键（旧批/非 C+ 批零噪音）
      ...(channel !== undefined ? { channel } : {}), // R-5 通道归属（G-1）；未声明不写键（R5-d 存量批零破坏）
      // 【2026-09-27 · 批 3】原「会话级临时团队资产根」（`teamsRoot` 落键）与「资产解析冻结指纹引用」
      //   （`teamAsset` 落键）**两键同批删除**：资产面退役 ⇒ 临时资产根无对象、指纹无来源。
      //   历史批磁盘上仍可能带这两键（读取侧零迁移，不解析、不回显）。
      events: [
        newEvent(EVT.EVT_BATCH_CREATED, { batchId, sessionId }),
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // P1 交接门：按 `task.deps` 的**每条入边**种一条 `pending` 交接（建批期意图声明 = 本门判据来源）。
    //   语义：下游 lane 一旦声明 deps，就在黑板（本批 handoffs）留下「我期望上游 X 交接过来」的**机器可判事实**；
    //   上游未提交（status 仍 pending）/产物不在场/契约不合规 ⇒ entry 门拒 `GATE_HANDOFF_MISSING`（缺哪条边、缺哪件产物）。
    //   此为**纯数据种入**（不写事件、不派发、不改任何成员态）——事件面只在 `recordHandoff`（真实交接）与拒态留痕发生。
    for (const w of batch.wavePlan ?? []) {
      for (const t of w.tasks ?? []) {
        if (!t || typeof t.id !== 'string') continue;
        const deps = Array.isArray(t.deps) ? t.deps.filter((d) => typeof d === 'string' && d.length > 0) : [];
        if (deps.length === 0) continue;
        const list = [];
        for (const from of deps) {
          list.push({
            from, to: t.id, batch: batchId, step: null,
            artifacts: [], contract: { consumedFrom: from, assertions: [] },
            status: 'pending', ts: batch.createdAt, officialTaskId: null,
          });
        }
        batch.handoffs[t.id] = list;
      }
    }
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

  // Manager 拉起登记（唯一写入口）：写批次级 `manager` 字段 + `batch.manager.raised` 事件。
  // 【改造为官方 roster 承抽】**原 Manager 三码已删**
  //   （2026-09-21 可达性审计：**码名已字面删除**，避免 grep 误当活码；语义见本段，勿再引用码名）
  //   ⇒ 登记**不再按 phase 或 agentId 拒绝**：
  //     · 任意 phase（含终态）均可登记事实（幂等；不改批次阶段、不改成员状态）；
  //     · `agentId` 缺失/空白 ⇒ **不写垃圾记录**（返回 null，调用方按「既无 phase 又无 manager」如实报错），
  //       **不抛门禁错**（不静默：调用方拿到 null 后走既有显式报错分支）。
  //   在册判定的**新真源 = 官方 roster**（读端 `lib/tools/core.js#managerRosterOf`；建批期落
  //   `gate.manager_roster_gap`）。本函数降级为**legacy 登记面**（旧批/离线记录，读端并列回显）。
  function markManagerRaised(sessionId, batchId, payload = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const agentId = typeof payload.agentId === 'string' ? payload.agentId.trim() : '';
    if (!agentId) return null; // 空 agentId：不拒、不写垃圾（空值门禁已删，A 批口径）
    // 幂等：同一 agentId 重复登记 → 直接返回既有记录，**不重复写事件**（防审计噪音：例如
    //   「先登记、后迁移」的调用序下，同一次阶段迁移被重试时会二次登记）。
    if (batch.manager && batch.manager.agentId === agentId) return batch.manager;
    const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : undefined;
    const at = new Date().toISOString();
    batch.manager = note ? { agentId, raisedAt: at, note } : { agentId, raisedAt: at };
    batch.events.push(newEvent(EVT.EVT_BATCH_MANAGER_RAISED, note ? { agentId, note } : { agentId }));
    batch.updatedAt = at;
    commitBatch(sessionId, batchId, batch);
    emitStateChange({ type: EVT.EVT_BATCH_MANAGER_RAISED, sessionId, batchId, agentId });
    return batch.manager;
  }

  function appendEvent(sessionId, batchId, type, fields = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    batch.events.push(newEvent(type, fields));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    return batch;
  }

  // ---- 环防护 budget：chains 状态读写（批次 v3 字段，原子写复用 atomicWrite）----
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
    commitBatch(sessionId, batchId, next);
    return next.chains;
  }

  // ---- 断点指针持久化（laneProgress）----
  // updateLaneProgress：lane_checkpoint 携带 progress 时经 laneProgressWrite 纯函数合并后原子写
  // （不突变入参；worktree.checkpoint 事件留痕由调用方 lane-tools 承担，本接口只写指针）。
  // 清退走 setMember 终态分支（laneProgressClear），本接口只增不删。
  function updateLaneProgress(sessionId, batchId, lane, progress) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = laneProgressWrite(batch, lane, progress);
    next.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, next);
    return next;
  }

  // asset_claim 归位：Leader 已直做产物复制进批次 artifacts/<batchId>/（保留内容，不移动），事件留痕。
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
    commitBatch(sessionId, batchId, batch);
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

  return { createBatch, readBatchResult, readBatch, isCorrupt, markManagerRaised, appendEvent, readChains, updateChains, updateLaneProgress, claimAsset, batchSettled, batchAutoReleaseable };
}
