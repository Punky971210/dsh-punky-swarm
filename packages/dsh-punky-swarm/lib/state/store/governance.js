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

// 会话级治理状态（governance.json v2）+ 违规计数记录/升级——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../../schema.js';
import * as machine from '../machine.js';
import * as EVT from '../event-types.js';
import { SESSION_RE } from '../constants.js';
// 违规计数纯函数（governance/escalation.js，零依赖纯模块——只 import state/event-types.js，
//   无循环依赖：store.js → escalation.js → event-types.js 单向链）。默认计入原语集（DENY/NARROW）亦复用
//   escalation.js 导出常量（单一事实源——config resolve 默认与纯函数签名缺省同源）。
import { countGovernanceRefusals, DEFAULT_ESCALATION_PRIMITIVES } from '../../governance/escalation.js';

// ── P2（2026-10-03）执行型计数**节流落盘**：模块级共享态 ─────────────────────────────
// 背景（实测）：`bumpExecCount` 原为「每次执行型工具调用：读盘 → 合并 → **全量重写**」，
//   单次成本随会话 `governance.json` 线性增长（2.4 KB 新会话 1.51 ms → 218 KB 长会话 4.38 ms，p95 8.52），
//   而该字段**源码自带依据为纯观察量**（见下方 `bumpExecCount` 处的【2026-09-16 用户裁决】注释：
//   「不作为升档或评估过期依据，仅作观察」）⇒ 节流**不改任何门禁/判定语义**，仅降低写盘频率。
// 设计：内存累加（未落盘增量 `govPending`）+ 按阈值（每 N 次）/定时（每 T ms）落盘；
//   读取侧 `readGovernance` 返回「磁盘 + 未落盘增量」的合并值 ⇒ 对外读数**严格不减**（不跳号、不回退）。
// 三个关键时机冲刷：① 阈值/定时（本文件）② **进程退出钩子** `process.once('exit')`（重启不丢最终值）
//   ③ 显式入口 `flushDirtyGovernance()`（宿主插件卸载/热重载侧可调用，见本文件导出面）。
// 【已知边界 · 如实登记】节流必然存在「已计数、未落盘」窗口 ⇒ 进程**非正常终止**（SIGKILL / 崩溃 /
//   插件热重载且未调用 `flushDirtyGovernance()`）时最多丢失 `< N` 次未落盘计数。N 越小丢失上界越小；
//   本仓未在 `lib/index.js` 的 disposer 上挂钩（写域约束），故热重载路径的兜底为**登记项**而非既成事实。
const EXEC_FLUSH_EVERY = envPositiveInt('PUNKY_GOV_EXEC_FLUSH_EVERY', 10);
const EXEC_FLUSH_INTERVAL_MS = envPositiveInt('PUNKY_GOV_EXEC_FLUSH_INTERVAL_MS', 30 * 1000);

// 环境旋钮解析：非法/缺省 → 回落默认（绝不产生 0/NaN 阈值——0 会让「节流」退化为每调必写）
function envPositiveInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ── P3（2026-10-03）`history` **有界化**：只保留最近 N 条**完整**记录 ─────────────────────
// 背景（实测）：`governance.json` 的 `history` 数组**无界增长**——每条存**完整 rationale**
//   （172–636 字符），最重会话 history 195 条 / gov 218 KB / 768 次执行型调用 ⇒ guard 单次成本随文件线性上升。
// 用户裁决 T-1=乙（2026-10-03）：**只保留最近 N 条完整记录**——刻意**不**选「截断 rationale 字段」，
//   完整条目比截断字符串更有审计价值；N 默认 100，环境旋钮沿用 P2 `PUNKY_GOV_EXEC_FLUSH_*` 惯例。
// 裁剪时机 = **写入时**（两个写点 `writeGovernance` / `flushExecCount` 共用单点 `boundHistory`）；
//   读侧 `readGovernance` 亦套同一投影 ⇒ 存量超界文件不必等一次写入才收敛（读数与写盘契约同界）。
// 留痕：发生裁剪时落 `historyTruncated: { dropped, since }`——`dropped` = **累计**丢弃条数（跨次累加），
//   `since` = 最早保留条目的 `at`（可追溯「更早的记录去哪了」），**不得无声消失**。
// 语义边界（明示）：裁剪只改「**存多少**」，**不改「怎么判」**——`history` 不被任何门禁/判定读取
//   （guard 只读 lastAssign / pendingBatch，见 lib/tools/tier-gate.js）；唯一非展示读端 = assign_check 的
//   `turn` 编号（按 history 长度递增）⇒ 已改为「累计丢弃 + 现存条数 + 1」，保证编号裁剪后仍单调不重号。
const GOV_HISTORY_MAX = envPositiveInt('PUNKY_GOV_HISTORY_MAX', 100);

let govStoreSeq = 0; // store 实例序号（键前缀：同 root 多 store 实例不互相覆盖）
const govPending = new Map(); // key -> { count, callsSince, since }：未落盘增量
const govSnapshot = new Map(); // key -> 最近一次读/写到的磁盘全量（供 bump 免读盘构造对外读数）
const govFlushers = new Map(); // key -> () => void：脏会话冲刷器（退出钩子/定时器遍历面）
let govFlushTimer = null;
let govExitBound = false;

// 一致性冲刷入口（同步）：退出钩子 / 定时器 / 宿主侧显式 flush 共用**单点**。
// 单会话失败不阻断其余会话（退出路径尤其不得抛）。
export function flushDirtyGovernance() {
  for (const flush of [...govFlushers.values()]) {
    try { flush(); } catch { /* 隔离：单会话冲刷失败不阻断其余会话 */ }
  }
}

// 钩子首次挂载（惰性：只在出现脏会话时挂，零脏会话零钩子零定时器）
function bindExecFlushHooks() {
  if (!govExitBound) {
    govExitBound = true;
    // 进程退出钩子（关键时机 flush）：atomicWrite 为同步写，可在 exit 处理器内安全执行。
    process.once('exit', () => { flushDirtyGovernance(); });
  }
  if (govFlushTimer) return;
  govFlushTimer = setInterval(() => {
    try { flushDirtyGovernance(); } catch { /* 定时冲刷失败不抛（下一拍重试） */ }
  }, EXEC_FLUSH_INTERVAL_MS);
  govFlushTimer.unref?.(); // 不因本定时器拖延进程退出（进程存活期间照常按拍触发）
}

export function buildGovernance(cx) {
  const { readBatch, newEvent, commitBatch, escalatePausedWrite, emitStateChange, ratchet, sessionDir, atomicWrite, listBatches } = cx;

  // 违规计数记录 + 窗口评估 + 达阈值升级（批事件流单一事实源，原子写）。
  //   入参 escalation = 装配侧 resolve 产物（{enabled, threshold, windowMs, primitives}）；调用方（桥接/
  //   测试）负责归属后传入本方法。防御纵深（与计入过滤同标准，方法内重复守卫——桥接过滤
  //   遗漏不误计不误升级）：enabled!==true → 零记录零升级（关态零路径）；ruleRefs 空（状态门收据）
  //   → 零记录零升级（全排除）；primitive ∉ primitives → 零记录零升级（DEFER/PAUSE/类别外默认不计）。
  //   升级执行：escalation.enabled ∧ phase==='running' → countGovernanceRefusals 窗口计数 ≥
  //   threshold ∧ 棘轮 bv.ok → 公共函数 escalatePausedWrite（reason='governance-escalate' + 载荷事件）；
  //   单次原子写（记录与升级同批落盘，不调 setPhase 二次写）；paused 后 phase 闸自然挡重复；
  //   埋点：升级伴随 emitStateChange batch.phase（reason='governance-escalate'，与 failed-escalate 对称）。
  //   观察者纪律：失败（批次缺失等）上抛由调用方 catch warn 隔离；本方法为同步段无 await。
  //   返回 batch（含可能升级后的最新形态）；未升级 = 仅追加 governance.refusal 记录。
  function recordGovernanceRefusal(sessionId, batchId, { lane, receiptId, primitive, ruleRefs, tool, escalation = {} } = {}) {
    // 防御守卫：enabled 关态 / 状态门收据（ruleRefs=[]）/ primitive 不在计入集 → 零事件零升级
    if (escalation.enabled !== true) return null; // 不误调不误记（T20：enabled=false 批事件流零 governance.refusal）
    if (!Array.isArray(ruleRefs) || ruleRefs.length === 0) return null; // 状态门收据永不计数（T12）
    const primSet = new Set(escalation.primitives ?? DEFAULT_ESCALATION_PRIMITIVES);
    if (!primSet.has(primitive)) return null; // DEFER/PAUSE/REQUIRE_APPROVAL 等默认不计（T12）
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    // 可计入收据 → 批事件流追加 governance.refusal（ts 由 newEvent 基座携带）
    batch.events.push(newEvent(EVT.EVT_GOVERNANCE_REFUSAL, { lane, receiptId, primitive, ruleRefs, tool }));
    // 仅 phase==='running' 时评估；paused/planning 等 phase 只记录不升级
    let escalated = false;
    if (batch.phase === 'running') {
      const now = Date.now();
      const count = countGovernanceRefusals(batch.events, {
        windowMs: escalation.windowMs,
        primitives: escalation.primitives,
        now,
      });
      if (count >= (escalation.threshold ?? 3)) {
        const bv = machine.applyBatchTransition('running', 'paused', { rules: ratchet });
        if (bv.ok) {
          // 尾窗收据摘要（升级载荷 receiptIds 供审计回查）：窗口内可计入 refusal 的 receiptId 清单
          const receiptIds = [];
          for (const e of batch.events) {
            if (!e || e.type !== EVT.EVT_GOVERNANCE_REFUSAL) continue;
            if (e.receiptId === undefined || e.receiptId === null) continue; // 兼容缺 receiptId 记录（不摘要）
            const tsMs = typeof e.ts === 'number' ? e.ts : Date.parse(String(e.ts ?? ''));
            if (Number.isNaN(tsMs)) continue;
            if (now - tsMs > escalation.windowMs) continue; // 窗口外不计入摘要（与计数窗口同界）
            receiptIds.push(e.receiptId);
          }
          escalatePausedWrite(batch, {
            reason: 'governance-escalate',
            eventType: EVT.EVT_BATCH_GOVERNANCE_ESCALATE,
            fields: { count, windowMs: escalation.windowMs, lane, receiptIds },
          });
          escalated = true;
        }
      }
    }
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    if (escalated) {
      emitStateChange({ type: 'batch.phase', sessionId, batchId, from: 'running', to: 'paused', reason: 'governance-escalate' });
    }
    return batch;
  }

  // ---- 会话级治理状态（governance.json v2）----
  // 每回合任务难度评估（A/B/C）的事实源：lastAssign + history 审计 + 执行型工具计数 + pendingBatch
  const GOV_SCHEMA = 2;
  function govDefaults() {
    return { schema: GOV_SCHEMA, execToolCount: 0, pendingBatch: false, pendingSince: null, lastAssign: null, history: [] };
  }
  function governanceFile(sessionId) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionDir(sessionId), 'governance.json');
  }
  // 本 store 实例的键前缀：`governanceFile` 绝对路径已含会话隔离，再加实例序号
  //   ⇒ 同 root 多 store 实例各自持有独立增量/快照（互不吞并，也不跨实例误冲刷）。
  const govKeyPrefix = 'gov#' + (++govStoreSeq) + '|';
  const govKeyOf = (sessionId) => govKeyPrefix + governanceFile(sessionId);

  // 未落盘增量与磁盘态的合并（**纯函数式：不改 base**）：
  //   execToolCount 单调累加；lastAssign 缺位时增量无落点（与既有 bump 语义一致：只计 execToolCount）。
  function mergeExecPending(base, pend) {
    const next = { ...base };
    if (!pend) return next;
    next.execToolCount = (base.execToolCount ?? 0) + pend.count;
    if (next.lastAssign) {
      next.lastAssign = { ...next.lastAssign, execCallsSince: (next.lastAssign.execCallsSince ?? 0) + pend.callsSince };
    }
    return next;
  }
  // P3：`history` 有界化**单点**（**纯函数**：不并入参；未超界时原对象返回，零拷贝零副作用）。
  //   超界 ⇒ 保留**最近** N 条（`slice(-N)`：顺序与内容逐字不动，不截断任何字段）＋累计 `dropped`
  //   ＋`since` = 最早保留条目的 `at`；未超界 ⇒ 原样返回（既存 `historyTruncated` 标记随之保留，
  //   不因某次未裁剪而丢失）。裁剪只动 `history` / `historyTruncated` 两键，其余键逐字透传。
  function boundHistory(g) {
    const hist = Array.isArray(g?.history) ? g.history : [];
    const droppedNow = hist.length - GOV_HISTORY_MAX;
    if (droppedNow <= 0) return g;
    const kept = hist.slice(-GOV_HISTORY_MAX);
    const prev = g.historyTruncated ?? null;
    return {
      ...g,
      history: kept,
      historyTruncated: {
        dropped: (prev?.dropped ?? 0) + droppedNow,
        since: kept[0]?.at ?? prev?.since ?? null,
      },
    };
  }
  // P3：读侧同界投影（**不写盘**）——`readGovernance` / 快照播种 / 冲刷读盘三处共用，避免各写一份裁剪。
  function readGovernanceBounded(sessionId) { return boundHistory(readGovernanceDisk(sessionId)); }

  // 纯磁盘读（P2 拆分：原 `readGovernance` 逐字保留，仅更名）——不含未落盘增量
  function readGovernanceDisk(sessionId) {
    const file = governanceFile(sessionId);
    if (!fs.existsSync(file)) return govDefaults();
    try { return { ...govDefaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch { return govDefaults(); }
  }
  // 无文件/损坏 → 返回默认（调用方无需判空）；**读取侧 = 磁盘 + 未落盘增量**（对外读数严格不减）
  function readGovernance(sessionId) {
    const disk = readGovernanceBounded(sessionId); // P3：读侧同界投影（存量超界文件不必等一次写入才收敛）
    const key = govKeyOf(sessionId);
    // 顺带刷新快照：guard 每次执行型调用先读治理态 ⇒ `bumpExecCount` 免二次读盘。
    //   快照只经本函数的合并拷贝对外（`mergeExecPending` 必拷贝），不存在共享可变引用。
    govSnapshot.set(key, disk);
    return mergeExecPending(disk, govPending.get(key));
  }
  // 原子写：读当前（磁盘 + 未落盘增量）→ 合并 patch → 落盘。
  //   【P2】落盘即**冲刷**该会话未落盘增量（值已进磁盘 ⇒ 清增量），故任何治理写入都不丢计数。
  function writeGovernance(sessionId, patch) {
    const key = govKeyOf(sessionId);
    // P3：合并后**再裁剪一次**——`patch.history`（调用方按「已界内 history + 新条目」构造）在此收敛到 N 条，
    //   故「history 追加路径」（assign_check）无需改动即得界内落盘，裁剪留痕同时写入。
    const next = boundHistory({ ...readGovernance(sessionId), ...patch });
    atomicWrite(governanceFile(sessionId), next);
    govPending.delete(key);
    govFlushers.delete(key);
    govSnapshot.set(key, next);
    return next;
  }
  // 单会话冲刷：**真读盘**（读-改-写，保留他方写入）→ 原子写（`tmp + rename`，沿用既有 atomicWrite）→ 清增量。
  //   返回是否实际落盘（无增量 = no-op，零写盘）。
  function flushExecCount(sessionId) {
    const key = govKeyOf(sessionId);
    const pend = govPending.get(key);
    if (!pend) return false;
    const next = boundHistory(mergeExecPending(readGovernanceBounded(sessionId), pend));
    atomicWrite(governanceFile(sessionId), next);
    govPending.delete(key);
    govFlushers.delete(key);
    govSnapshot.set(key, next);
    return true;
  }
  // 快照播种（缺快照时的唯一一次读盘：每会话首触 +1 次读）
  function seedExecSnapshot(sessionId, key) {
    const boundedDisk = readGovernanceBounded(sessionId);
    govSnapshot.set(key, boundedDisk);
    return boundedDisk;
  }
  // 执行型工具调用计数（**纯观察面**）：execToolCount 累计 + lastAssign.execCallsSince 递增。
  // 【2026-09-16 用户裁决】这两项**仅作提示/观察**，**不作为升档或评估过期依据**——
  //   难度档位依据已彻底改写为「每回合主动写入的 difficulty + 判据」（见 lib/tools/core.js 门禁 1）。
  // 【P2（2026-10-03）节流】改为**内存累加 + 阈值/定时落盘**：
  //   每次调用零写盘（合并读亦可走快照 ⇒ 多数情形零读盘），每 N 次或距首次未落盘 ≥ T ms 才落盘一次；
  //   返回值 = 合并后真实值（快照 + 当前增量）⇒ 既有调用点与测试读到的数值语义**逐字不变**。
  function bumpExecCount(sessionId) {
    const key = govKeyOf(sessionId);
    let pend = govPending.get(key);
    if (!pend) { pend = { count: 0, callsSince: 0, since: Date.now() }; govPending.set(key, pend); }
    pend.count += 1;
    pend.callsSince += 1;
    if (!govFlushers.has(key)) govFlushers.set(key, () => { flushExecCount(sessionId); });
    bindExecFlushHooks();
    if (pend.count >= EXEC_FLUSH_EVERY || Date.now() - pend.since >= EXEC_FLUSH_INTERVAL_MS) {
      flushExecCount(sessionId); // 阈值/定时到达 → 落盘一次（此后快照即已落盘态）
    }
    const base = govSnapshot.get(key) ?? seedExecSnapshot(sessionId, key);
    return mergeExecPending(base, govPending.get(key));
  }
  // 评估过期判定：从未评估 / 距 lastAssign.at ≥ maxAgeMs(30min) / 时间戳非法。
  // 原 `execCallsSince ≥ maxCalls(20)` 判据**已移除**：难度档位依据已彻底改写，
  //   调用计数不再是档位/过期的依据（旧判据还会被只读侦察计数灌水误触发重评）。
  //   `maxCalls` 入参保留但**忽略**（向后兼容既有调用方与测试签名）。
  function stale(sessionId, { maxAgeMs = 30 * 60 * 1000 } = {}) {
    const g = readGovernance(sessionId);
    if (!g.lastAssign) return true;
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

  return { recordGovernanceRefusal, govDefaults, governanceFile, readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch };
}
