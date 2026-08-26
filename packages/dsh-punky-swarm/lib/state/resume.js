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

// lib/state/resume.js — 断点续跑骨架（增强恢复落地后回填实现）
//
// 职责（断点续跑：执行模型改变——与增强恢复的"执行模型不变"互补）：
//   状态重建接口 —— 恢复 running/review（而非一律 idle）+ config.resume.enabled 开关（默认关）
//   断点指针语义 —— laneProgress 步骤进度（schema-v3.js 可选字段；本文件提供读写/清退接口骨架）
//   worker 任务包契约断点续跑 —— resume 章节占位（增强恢复落地后装配层实际注入）
//
// 纪律：
//   - 默认关：config.resume.enabled !== true → recoverBatches() 原样委托 store.recoverBatches()（零行为变化）
//   - 不新增成员态：恢复对象仅 running/review（crash 中断的 in-flight lane）；failed/conflict/skipped
//     不参与任何恢复，失败是裁决结果不是中断，不复活
//   - 恢复不走 setMember：直接保留状态 + 事件留痕，不重验 entry gate/condition（恢复不是新派发）
//   - 不提供批次内自动续跑：重做仍开新批次
//
// 边界：本文件只读 store 公共面（listSessions/listBatches/readBatch/appendEvent），
// 不触碰 store.js recoverBatches 主体（归 recover-audit lane）与 lane-tools.js（归 checkpoint-contract lane）。
import * as schema from '../schema.js';

// ── config.resume 开关（默认关，零运行时开销，行为不变）──
export const RESUME_DEFAULTS = Object.freeze({ enabled: false });

export function resolveResumeConfig(config) {
  const c = config?.resume ?? {};
  return { enabled: c.enabled === true };
}

// 待回填清单（增强恢复落地后逐项回填；workerResumeChapter() 亦引用）
export const RESUME_FILL_POINTS = [
  '恢复接口实现 + config.resume 接线（index.js 启动恢复改调 resume.recoverBatches(store, { restoreRunning: resumeCfg.enabled })）',
  'laneProgress 字段写/清/展（lane_checkpoint 携带 progress 时经 laneProgressWrite 写入；lane 结算终态经 laneProgressClear 清退；batch_status 面板 progress 视图）',
  '任务包 resume 章节从"文档占位"升为"装配层实际注入"（worker 角色手册加 resume 条款）',
  '崩溃恢复用例测试（模拟 running 中 crash → 重启 restore → 新 worker 从 N+1 续跑 → 产物合并验证）',
];

// ── 状态重建接口 ──
// 单一入口扩展：签名与 store.recoverBatches 同构，加可选 restoreRunning。
//   restoreRunning 缺省 false → 原样委托 store.recoverBatches()（默认路径零改动；detail 增强经 store 生效，不受本模块影响）
//   restoreRunning === true → restoreBatches()（running→running / review→review 原地保留）
// 幂等与安全：同一恢复调用内每 lane 二选一（restore 与 recover 互斥，由本布尔分支保证）。
// 接线点：index.js 启动恢复处 `resume.recoverBatches(store, { restoreRunning: resumeCfg.enabled })`，
//   返回数组形态与 store.recoverBatches 一致（.length 兼容既有 `if (r.length)` 日志）。
export function recoverBatches(store, { restoreRunning = false } = {}) {
  if (restoreRunning !== true) return store.recoverBatches();
  return restoreBatches(store);
}

// 独立恢复入口（语义更清晰）：只处理非终态批次的 running/review lane——
// 原地保留状态（不落 setMember，不重验 entry gate/condition）+ 事件留痕，返回 'sessionId/batchId' 数组。
// 骨架已实现：状态保留 + system.recovered{detail[].restored=true} / system.restored 事件留痕。
// （增强恢复落地后回填，均只读探测，不改产物）：produced 证据（gateStatus outputsMissing/produceMissing 反推）、
//   lastActiveAt（batch.events 该 lane 最近事件 ts，回退 updatedAt）、progress（laneProgress[lane] 合并）。
export function restoreBatches(store, { eventType = 'system.restored' } = {}) {
  const restored = [];
  for (const sessionId of store.listSessions()) {
    for (const batchId of store.listBatches(sessionId)) {
      const batch = store.readBatch(sessionId, batchId);
      if (!batch || schema.isBatchTerminal(batch.phase)) continue; // 终态批次跳过
      const detail = [];
      for (const [lane, state] of Object.entries(batch.lanes ?? {})) {
        if (state !== 'running' && state !== 'review') continue; // 仅 crash 中断的 in-flight lane
        detail.push({
          lane,
          from: state,
          to: state, // 原地保留（恢复 running/review 而非一律 idle）
          restored: true, // 恢复标记（与 gate_status 面板展示的衔接）
          // produced（已产出产物清单，复用 gate 语义只读探测）、
          // lastActiveAt（上次活动时间，batch.events 该 lane 最近事件 ts → 回退 batch.updatedAt）、
          // progress（laneProgress[lane] 断点指针）
        });
      }
      if (detail.length) {
        // 事件留痕：appendEvent 只追加事件 + updatedAt，不改 lanes——恢复路径不落 setMember（gate 交互设计）
        store.appendEvent(sessionId, batchId, 'system.recovered', {
          batchId, sessionId,
          recoveredLanes: detail.map((d) => d.lane), // 保留既有字段（batch-store.test.js 断言其存在，向后兼容）
          detail,
          restored: true,
        });
        store.appendEvent(sessionId, batchId, eventType, {
          batchId, sessionId,
          restoredLanes: detail.map((d) => d.lane),
          detail,
        });
        restored.push(sessionId + '/' + batchId);
      }
    }
  }
  return restored; // 与 recoverBatches 同形态（数组，.length 兼容 index.js 日志）
}

// ── 断点指针语义（laneProgress，schema-v3.js 可选字段）──
// 纯函数：操作 batch 对象，不落盘（写入/清退由 B 的 lane_checkpoint / 结算路径调用本接口后交 store 原子写）

// 读：无进度记录 → null（缺省 undefined 语义，读兼容）
export function laneProgressRead(batch, lane) {
  return batch?.laneProgress?.[lane] ?? null;
}

// 值级校验：status ∈ running|review（与成员态对齐，不新增成员态 S2）；step/total 正整数且 step ≤ total
export function isValidLaneProgress(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (p.status !== 'running' && p.status !== 'review') return false;
  if (!Number.isInteger(p.step) || !Number.isInteger(p.total)) return false;
  if (p.step < 1 || p.total < 1 || p.step > p.total) return false;
  return true;
}

// 写：返回新 batch（不突变入参）。lane_checkpoint 携带 progress 时调用，
//   更新 laneProgress[lane]（断点指针：lane 执行到第 N 步，新 worker 从 N+1 继续），随后交 store 原子写。
export function laneProgressWrite(batch, lane, progress) {
  if (!isValidLaneProgress(progress)) {
    throw new Error('invalid laneProgress: ' + JSON.stringify(progress) + ' (expect { step, total, status: running|review, updatedAt? })');
  }
  return {
    ...batch,
    laneProgress: {
      ...(batch.laneProgress ?? {}),
      [lane]: { ...progress, updatedAt: progress.updatedAt ?? new Date().toISOString() },
    },
  };
}

// 清：lane 结算（merged/failed/skipped/conflict）时删除该 lane 指针，不残留脏指针；
//   批次 complete 后整块随批次归档（archive 已覆盖）。返回新 batch；无指针则原样返回。
export function laneProgressClear(batch, lane) {
  if (!batch?.laneProgress?.[lane]) return batch;
  const lp = { ...batch.laneProgress };
  delete lp[lane];
  return { ...batch, laneProgress: Object.keys(lp).length ? lp : undefined };
}

// ── 步数预算（超限判定，纯函数；接线在 lane-tools.js lane_checkpoint，B 子项）──
// 设计：任务建批时声明 checkpoint:{steps}（总步数预算，wave-plan.js normalizeResumeContract
//   校验正整数或 null 后透传进 wavePlan）；lane_checkpoint 携带 progress 时判定
//   progress.total > checkpoint.steps → 超限。判定只发信号不硬杀：接线层命中且事件流无该 lane
//   的 lane.over-budget → appendEvent（幂等），转 review/stalled 由 Manager/Leader 裁决。
// 返回 { over, budget }：budget = 任务声明的步数上限（未声明 = null）；over = total 是否超限。
//   B-不变量：未声明 checkpoint.steps（budget=null）零感知——任意 progress 返回 { over:false, budget:null }。
// 任务定位遍历语义与 store.findTask / machine.findTask 一致：wavePlan[].tasks 按 id 匹配。
export function overBudgetOf(batch, lane, progress) {
  let task = null;
  for (const w of batch?.wavePlan ?? []) {
    for (const t of w.tasks) if (t.id === lane) { task = t; break; }
    if (task) break;
  }
  const budget = task?.checkpoint?.steps ?? null;
  if (budget === null) return { over: false, budget: null }; // 未声明 → 零感知
  const total = progress?.total;
  if (Number.isInteger(total) && total > budget) return { over: true, budget };
  return { over: false, budget };
}

// B-幂等判据：事件流已存在该 lane 的 lane.over-budget → true（接线层据此避免重复 appendEvent；
//   同 lane 超限事件只发一次，重复 progress 调用不重复发）
export function hasOverBudgetEvent(batch, lane) {
  return (batch?.events ?? []).some((e) => e.type === 'lane.over-budget' && e.lane === lane);
}

// ── worker 任务包契约断点续跑（骨架，增强恢复落地后填充）──
// 返回任务包 resume 章节占位：B 完成后由装配层（worker 角色手册）按
//   config.resume.enabled && capabilities.worktree.enabled 置 enabled=true 并注入派发提示词。
// 四步契约语义：N = laneProgress.step（最近一次 checkpoint 的 progress.step），resumeFrom = N+1。
export function workerResumeChapter() {
  return {
    title: 'resume（断点续跑）',
    enabled: false, // 增强恢复落地后装配层按开关置 true 并实际注入
    steps: [
      '查询 laneProgress（laneProgressRead）/ lane_checkpoint_status → 得 { resumeFrom: N+1, total, produced }',
      '从第 N+1 步开始执行；已完成步骤（step ≤ N）的产物视为已交付，禁止重做',
      '每步完成即 lane_checkpoint(progress={ step, total })（经 laneProgressWrite 写 laneProgress）',
      '完成态（done）后正常 running→review→merged（exit gate 校验 outputs 齐备）',
    ],
    fillPoints: RESUME_FILL_POINTS,
  };
}
