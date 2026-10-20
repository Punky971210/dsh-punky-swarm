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

// 心跳引擎**共享上下文 `cx`** 与路径/产物解析单点
//   （【2026-10-02 · 内务批 波 2】随 `createLaneHeartbeat` 巨型函数拆分下沉）：
//   原 `createLaneHeartbeat` 闭包内共享变量集中此处，各探针档（stalled / longrun / replay / 状态面）
//   从**同一 `cx`** 取值。`cx` **每引擎实例一份**（`createHeartbeatContext` 内建），**不得提升为模块级单例**
//   （纪律：不新增真源）。初始化顺序与拆分前逐字一致：cfg → lrCfg → schedule → hardStop → clock →
//   engineRoot → ctxOf → state；`disposed` / `replayInFlight` 为可变位（原闭包 `let`，同一实例内唯一）。
import { join, dirname } from 'node:path';
import { resolveArtifactIn } from '../../state/batch-paths.js'; // 产物声明路径解析单点（WD-3b P6；逃逸 ⇒ throw）
import { resolveWatchConfig } from '../../schema.js';
import { lastProgressTsOf, resolveLongrunConfig, buildSchedule } from '../lane-heartbeat.js';

export function createHeartbeatContext({ store, mailbox, config, root, now, liveConfig, logger }) {
  const cfg = resolveWatchConfig(config);
  const lrCfg = resolveLongrunConfig(config); // longrun 档配置（出厂默认开；关态 tick 不跑判定）
  const schedule = buildSchedule(cfg.intervalsMinutes);
  const hardStop = cfg.maxMissed; // 硬停拍数：连续 N 拍无活动 → stalled
  const clock = typeof now === 'function' ? now : () => Date.now();
  const engineRoot = root ?? (store?.sessionsDir ? dirname(store.sessionsDir) : null);
  // 重放档的 ctx：`logger` 透传给 `replayBatch`（其失败隔离路径用它 warn；缺省 = 静默降级，不 throw）。
  const ctxOf = () => ({ logger });
  // 状态表 Map<laneKey, { lastActivityAt, lastSeenTs, lastProbeAt, missedCount, stalled, pendingProbeId }>
  // laneKey = `${sessionId}/${batchId}/${lane}`
  const state = new Map();
  return {
    store, mailbox, config, root, liveConfig, logger,
    cfg, lrCfg, schedule, hardStop, clock, engineRoot, ctxOf, state,
    disposed: false,
    // W1-① 重放的 in-flight 句柄（`tick()` 同步返回，重放是异步只读+补决策）：测试/调用方可据此
    //   等待本拍补决策落盘（生产路径不等待——与装配期扫描的「异步化、不阻塞启动」纪律同构）。
    replayInFlight: null,
  };
}

export function mailboxRootOf(cx, sessionId, batchId) {
  if (!cx.engineRoot) throw new Error('lane-heartbeat: no root (pass deps.root or store.sessionsDir)');
  return join(cx.engineRoot, 'sessions', sessionId, 'mailbox', batchId);
}
export const laneKeyOf = (sessionId, batchId, lane) => `${sessionId}/${batchId}/${lane}`;

// 产物解析（WD-3b P6）：改调 fail-closed 单点 `resolveArtifactIn` ——
//   声明面非法（根外绝对 / `..` 逃逸）⇒ **throw**（R-4 声明期口径），由三个消费点的既有 try/catch
//   落为「不可判定」（activity:83/129、evidence:30），不再 stat 到根外；运行期缺失仍原样返回路径。
export function resolveArtifact(cx, sessionId, batchId, rel) {
  const base = cx.store.artifactsDirOf(sessionId, batchId);
  return resolveArtifactIn(base, rel);
}
// 该 lane 在引擎产物根下的目录 = <artifacts>/<batchId>/<lane>（progress 快照与 lane 产物同源落盘约定；
//   实测即 <artifacts>/<batchId>/<lane>/progress/NN-*.md）。
//   用原始 laneId 拼接：sanitize 只做 mailbox 路径安全，产物路径须与 worker 实际落盘逐字一致。
export function laneProgressDirOf(cx, sessionId, batchId, lane) {
  return join(cx.store.artifactsDirOf(sessionId, batchId), lane);
}
// 进度快照信号的**扫描面收窄**（两条，二者互补，只增不减信号面）：
//   ① <lane>/progress/ 子树 —— 快照落盘约定路径（实测口径）；
//   ② <lane>/*.md 顶层 —— 非约定式落盘的兜底（部分 worker 直写 lane 根）。
//   为什么要收窄：lane 根下还挂着**声明产物**（outputs/produce 的绝对路径，如 exec/exempt/x.md）——
//   那是「开工前不存在、收尾才写」的交付物，若把整棵子树当快照扫，一次收尾写盘会连带把
//   lastSeenTs 推进到交付时刻，掩盖此后真实停滞（假绿：把「已交完货」读成「还在跑」）。
//   故快照信号只看 progress/ 子树 + lane 根 .md 文件；不做全树无差别扫描。
export function progressSnapshotTsOf(cx, sessionId, batchId, lane) {
  const laneRoot = laneProgressDirOf(cx, sessionId, batchId, lane);
  const a = lastProgressTsOf(join(laneRoot, 'progress'));
  const b = lastProgressTsOf(laneRoot, { maxDepth: 0, onlyMarkdown: true });
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

// 长程豁免读取（唯一读端，可选链 + 无值即 null）：豁免落**批次级字段** batch.laneExempt[lane]
//   （**不是** batch.lanes[lane]——后者保持纯字符串，10+ 处字符串消费面零破坏）。
//   旧批次/未授予 lane → undefined → 归一为 null，倍率按 1×（行为与今日完全一致，零迁移）。
export function laneExemptOf(batch, lane) {
  return batch?.laneExempt?.[lane] ?? null;
}
