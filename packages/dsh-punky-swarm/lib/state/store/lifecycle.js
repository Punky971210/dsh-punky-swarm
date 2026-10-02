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

// 批次生命周期与恢复（列表 / 恢复审计辅助 / 孤儿回收）——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../../schema.js';
// findTask 单点：收敛至 task-utils.js（原本地定义删除）
import { findTask } from '../task-utils.js';
import { SESSION_RE, isAbsPath } from '../constants.js';
import * as EVT from '../event-types.js';

export function buildLifecycle(cx) {
  const { sessionsDir, batchesDirOf, readBatch, isCorrupt, newEvent, commitBatch, artifactsDirOf, log } = cx;

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
          // 损坏批次隔离：登记已由 readBatch 幂等完成（首次才 warn）；汇总 corrupt 后跳过，不击穿循环
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
            // 审计详情：from 原态 / lastActiveAt 反查 / produced 复用 gate 语义（置 idle 前采集，只读不改产物）；
            // outcome='crashed'：进程崩溃重启后 in-flight lane 被强制落 idle 的结局记账值
            // （只记不改：非成员态、不拦截、不新增迁移；随既有 system.recovered.detail 供重派前经事件流查询）
            detail.push({ lane, from: state, lastActiveAt: lastActiveAtOf(batch, lane), produced: producedOf(sessionId, batchId, batch, lane), outcome: 'crashed' });
          }
        }
        if (recoveredLanes.length > 0) {
          // 恢复期清退**本进程已不持有**的 lane 锁：崩溃前的持有者进程已不存在 → 该锁是死锁，
          // 不清退会让「核对后重派」在 lane_claim 处永久冲突（唯一出路是 force 接管，而 force 不校验持有者活性）。
          for (const lane of recoveredLanes) {
            try { fs.rmSync(path.join(sessionsDir, sessionId, '.locks', batchId + '.' + lane + '.lock'), { force: true }); } catch { /* 清锁失败不阻断恢复 */ }
          }
          // 保留 recoveredLanes（向后兼容，既有测试断言其存在），新增 detail 审计详情数组
          batch.events.push(newEvent(EVT.EVT_SYSTEM_RECOVERED, { batchId, sessionId, recoveredLanes, detail }));
          batch.updatedAt = new Date().toISOString();
          commitBatch(sessionId, batchId, batch);
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

  // 孤儿 worker 显式回收：lane.stalled 处置扩展——只标记 → 可显式回收。
  // 语义：管理命令（显式触发，仿 recoverBatches 直写先例，不经棘轮表/不放宽 MEMBER_TRANSITIONS）；
  //       默认不自动处置（人审保留）；lane.stalled 仍非成员状态（不新增成员态，语义保持）。
  // 前置校验：批次不存在/损坏 → throw；lane 非 running → throw（防双回收/误回收：终态 lane 永不回收）。
  // 事件：lane.recycled { lane, from:'running', reason:'stalled', outcome:'interrupted', note } 留痕；
  //   outcome='interrupted'：运行中被显式回收（停滞证据 → 脱离在飞态）的结局记账值
  //   （只记不改：非成员态、不拦截、不新增迁移；watch stalled/longrun 信号零变，仅处置落 idle 时记账）；
  //   回收后走既有 member_status idle→running 重派。
  function recycleStalledLane(sessionId, batchId, lane) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    if (batch.lanes[lane] !== 'running') throw new Error('lane not running: ' + lane + ' (state=' + batch.lanes[lane] + ')');
    // 校验该 lane 存在 lane.stalled 事件（batch.events 反查；stalled 只标记，回收须有停滞证据）
    const hasStalled = (batch.events ?? []).some((e) => e.type === EVT.EVT_LANE_STALLED && e.lane === lane);
    if (!hasStalled) throw new Error('no lane.stalled event for lane: ' + lane + ' (recycle requires stalled evidence)');
    batch.lanes[lane] = 'idle';
    batch.events.push(newEvent(EVT.EVT_LANE_RECYCLED, { lane, from: 'running', reason: 'stalled', outcome: 'interrupted', note: null }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    return { ok: true, lane, from: 'running', to: 'idle' };
  }

  function listAllBatches() {
    const all = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) all.push({ sessionId, batchId });
    }
    return all;
  }

  return { listBatches, listSessions, listAllBatches, lastActiveAtOf, producedOf, recoverBatches, recycleStalledLane };
}
