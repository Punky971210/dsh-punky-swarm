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

// checkpoint 强制化门族（批 `punky-checkpoint-enforce-20261112` · lane `e2-gate`；spec §R-5）
//   两道门**纯判定**：零写盘 / 零 git / 零事件 / 零归一化第二实现。
//   事件发射与 `commitBatch` 归调用方（`state/store/member.js` · `state/store/member-gates.js`），
//   与 entry / exit / targets / command 诸门**同款契约** ⇒ 「拒前零写入」（spec §X-7 / §约束 5）才可机械复验。
//
// ── 为什么判据原料是**参数注入**（`prims`）而不是 import `../resume.js` ─────────────────────────
//   本仓有一条机械不变量：`test/esm-first-eval.test.js` 断言**全仓静态 ESM SCC 数 === 0**
//   （`RESIDUAL_SCC_COUNT`），且动态 import 也须登记（`KNOWN_DYNAMIC_EDGES === []`）。
//   既有依赖方向是 `wave-plan.js → state/gates.js`（`wave-plan.js:45` import `presenceJudge`），
//   而 `state/resume.js → wave-plan.js`（`:26` import `normalizeCheckpoints`）
//   ⇒ 本文件若 `import '../resume.js'` 就形成
//   `gates.js → gates/checkpoints.js → resume.js → wave-plan.js → gates.js` 一环，esm-first-eval 必红。
//   故判据原料（方言 / 声明 / 覆盖 / 取源）由**调用方**注入，方向与既有分层一致（store → resume），
//   单点实现仍只有 `resume.js` 那一份 —— 本模块**不做任何事件遍历、不归一化任何输入**。
//
// 注入面（`prims`，五函数，缺一即 fail-open 并显式降级）：
//   `dialectOfLane(batch, lane)` · `declaredSubtasksOf(batch, lane)` · `coveredSubtasksOf(batch, lane)`
//   · `latestCheckpointOf(batch, lane)`（`dialectOf` 键仍在表上供既有读端，但**本门族不消费**）
import { taskOf, smokeOf } from './detect.js';

const SUBTASKS_DIALECT = 'subtasks';

/**
 * 注入面是否齐备（五函数全 function 才可用；缺一 ⇒ 本门族整体放行 + 显式 `skipped` 成因）。
 *   ⚠ **fail-closed 语义**：`dialectOfLane` 缺失**不得**回落批级判据 —— 老 `prims` 对象
 *     （只带 `dialectOf`）必须显式 `skipped:'no-checkpoint-primitives'`，绝不静默按批级继续判
 *     （spec §S-3；否则缺失判据会变成「静默按 G-04 分叉继续跑」）。
 */
function primsReadyOf(prims) {
  return prims !== null && typeof prims === 'object'
    && typeof prims.dialectOfLane === 'function'
    && typeof prims.declaredSubtasksOf === 'function'
    && typeof prims.coveredSubtasksOf === 'function'
    && typeof prims.latestCheckpointOf === 'function';
}

export function buildCheckpoints(_cx) {
  /**
   * G1 · 派发门（码 `GATE_CHECKPOINTS_REQUIRED`，**拒**）——spec §R-5 表 G1。
   *  判据（**全部满足**才拒）：
   *    ① `layer === 'exec'`（plan / audit 不校验 —— 用户前提② / spec §X-5）
   *    ② `dialectOfLane(batch, lane) === 'subtasks'`（**lane 级**方言，与渲染入口同源 ——
   *       存量批 `legacy` ⇒ 全放行，存量零感知；G-04 的门/渲染判据面分叉正是在此收口）
   *    ③ `from === 'pending'`（`idle` 恢复重派 / `running` 重入**放行**，与 entry 门的 G-1 口径同向）
   *    ④ 非 smoke 批
   *    ⑤ `declaredSubtasksOf().length === 0`（键在场但归一后为空 = 正是要拒的形状）
   *  @param {string} sessionId
   *  @param {string} batchId
   *  @param {object} batch 已读批次对象（本函数**不改它**）
   *  @param {string} lane
   *  @param {{dialectOfLane:Function, declaredSubtasksOf:Function, coveredSubtasksOf:Function, latestCheckpointOf:Function}} prims
   *  @returns {{ok:boolean, lane:string, code?:string, dialect?:string, declared?:boolean, problems?:string[], skipped?:string}}
   */
  function checkCheckpointsDispatchGate(sessionId, batchId, batch, lane, prims = null) {
    if (!primsReadyOf(prims)) {
      return { ok: true, lane, skipped: 'no-checkpoint-primitives',
        problems: ['判据原料未注入（dialectOf / declaredSubtasksOf / coveredSubtasksOf / latestCheckpointOf）⇒ 本门放行'] };
    }
    const t = taskOf(batch, lane);
    if (!t) return { ok: true, lane, skipped: 'lane-not-in-plan' };
    if (t.layer !== 'exec') return { ok: true, lane, layer: t.layer ?? null, skipped: 'layer-not-exec' };
    const dialect = prims.dialectOfLane(batch, lane);
    if (dialect !== SUBTASKS_DIALECT) return { ok: true, lane, dialect, skipped: 'legacy-dialect' };
    const from = (batch?.lanes && typeof batch.lanes === 'object') ? (batch.lanes[lane] ?? null) : null;
    if (from !== 'pending') return { ok: true, lane, dialect, from, skipped: 'not-first-dispatch' };
    if (smokeOf(batch)) return { ok: true, lane, dialect, skipped: 'smoke' };
    const declared = prims.declaredSubtasksOf(batch, lane);
    if (declared.length > 0) return { ok: true, lane, dialect, declared };
    return {
      ok: false,
      lane,
      code: 'GATE_CHECKPOINTS_REQUIRED',
      dialect,
      declared: false,
      missing: [],
      problems: [
        'exec lane `' + lane + '` 在本批方言（subtasks）下未声明任何 subtask（归一后 items 为空）',
        'spec §R-5 G1：新方言批的 exec lane 必须声明 `subtasks[]`（≥1 项），否则拒派',
        '修法：在 `wave_plan` 的该 task 上补 `subtasks:[{id,target,...}]`（存量批不受影响：legacy 方言不校验）',
      ],
    };
  }

  /**
   * G2 · 结算门（码 `GATE_CHECKPOINTS_INCOMPLETE`，**拒**）——spec §R-5 表 G2。
   *  ⚠ 本门**只在 merged 链**（`runMergedGateChain`）被调用 ⇒ 判据①「`to === 'merged'`」由调用位置结构性保证。
   *  判据（全部满足才拒）：
   *    ① `layer === 'exec'`；② **lane 级**方言 `subtasks`（`dialectOfLane`，与渲染入口同源）；③ 非 smoke 批；
   *    ④ `declared.length > 0`（=0 直接放行：门序被绕过时不重复告警，与 G1 分工）；
   *    ⑤ 达标 = **显式覆盖**（`declared ⊆ coveredSubtasksOf().ids`）**∨** **序贯覆盖**（`covered.sequential`）
   *  @returns {{ok:boolean, lane:string, code?:string, declared:string[], missing?:string[], sequential:boolean, ...}}
   */
  function checkCheckpointsSettleGate(sessionId, batchId, batch, lane, prims = null) {
    if (!primsReadyOf(prims)) {
      return { ok: true, lane, skipped: 'no-checkpoint-primitives',
        problems: ['判据原料未注入 ⇒ 本门放行'] };
    }
    const t = taskOf(batch, lane);
    if (!t) return { ok: true, lane, skipped: 'lane-not-in-plan' };
    if (t.layer !== 'exec') return { ok: true, lane, layer: t.layer ?? null, skipped: 'layer-not-exec' };
    const dialect = prims.dialectOfLane(batch, lane);
    if (dialect !== SUBTASKS_DIALECT) return { ok: true, lane, dialect, skipped: 'legacy-dialect' };
    if (smokeOf(batch)) return { ok: true, lane, dialect, skipped: 'smoke' };
    const declared = prims.declaredSubtasksOf(batch, lane);
    if (declared.length === 0) return { ok: true, lane, dialect, declared, skipped: 'nothing-declared' };
    const covered = prims.coveredSubtasksOf(batch, lane);
    const coveredIds = [...covered.ids];
    // 判据⑥·显式覆盖：声明序里每一项都被事件面 `subtask` 字段点名过。
    const missing = declared.filter((id) => !covered.ids.has(id));
    if (missing.length === 0) {
      return { ok: true, lane, dialect, declared, missing: [], sequential: covered.sequential === true, covered: coveredIds };
    }
    // 判据⑥·序贯覆盖：成员没写 `subtaskId`，但最新进度走到末项（`total === 声明数 && step >= 声明数`）⇒ 照算覆盖。
    if (covered.sequential === true) {
      return { ok: true, lane, dialect, declared, missing: [], sequential: true, covered: coveredIds };
    }
    const latest = prims.latestCheckpointOf(batch, lane);
    return {
      ok: false,
      lane,
      code: 'GATE_CHECKPOINTS_INCOMPLETE',
      dialect,
      declared,
      missing,
      sequential: false,
      covered: coveredIds,
      latest: latest ? latest.latest : null,
      latestSource: latest ? latest.source : null,
      problems: [
        '本 lane 声明了 ' + declared.length + " 个 checkpoint（['" + declared.join("', '") + "']），未逐项留痕",
        '缺失（按**声明序**）：[' + missing.map((id) => "'" + id + "'").join(', ') + ']',
        '达标判据 = 显式覆盖（`lane_checkpoint({..., subtaskId})` 逐个点名）∨ 序贯覆盖（最新 `progress.total === ' + declared.length + '` 且 `step >= ' + declared.length + '`）',
      ],
    };
  }

  return { checkCheckpointsDispatchGate, checkCheckpointsSettleGate };
}
