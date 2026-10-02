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
  // 执行型工具调用计数（**纯观察面**）：execToolCount 累计 + lastAssign.execCallsSince 递增。
  // 【2026-09-16 用户裁决】这两项**仅作提示/观察**，**不作为升档或评估过期依据**——
  //   难度档位依据已彻底改写为「每回合主动写入的 difficulty + 判据」（见 lib/tools/core.js 门禁 1）。
  function bumpExecCount(sessionId) {
    const g = readGovernance(sessionId);
    g.execToolCount = (g.execToolCount ?? 0) + 1;
    if (g.lastAssign) g.lastAssign.execCallsSince = (g.lastAssign.execCallsSince ?? 0) + 1;
    atomicWrite(governanceFile(sessionId), g);
    return g;
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
