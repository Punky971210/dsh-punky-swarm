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

// 图变更写入口（池内追加任务 / 池内加边）——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import * as schema from '../../schema.js';
import * as EVT from '../event-types.js';
import { buildWavePlan, LAYERS } from '../../wave-plan.js'; // N1-R4-1c：池内追加任务的归一化（判据与建批期同源）

export function buildPlanMutate(cx) {
  const { batchFile, readBatch, newEvent, atomicWrite } = cx;

  // ── N1-R4-1c：池内追加任务（**图变更的唯一写入口**）─────────────────────────────
  // 纪律（K1 + 2026-09-21 13:3x 用户裁定）：
  //   ① 只**增**不改：既有任务（含未派发的）一概不动——「已派发即冻结」，且本接口不提供改任务语义。
  //   ② **不新建拒码**（迁移门禁再议）⇒ 非法输入抛**普通 Error**（不带 `GATE_` 前缀，不进 66 码集合）；
  //      唯一例外 = 批终态，复用既有 `GATE_BATCH_TERMINAL`。
  //   ③ 单次 `atomicWrite`：wavePlan 重归一化 + lanes 播种 + handoffs 播种 + `plan.mutated` 留痕同一次落盘。
  //      **【G-10/Q-H2 修复 · lane `e3-toolface`】本次播种的入边**逐条写进该事件的 `declared:[{from,to}]`** ——
  //      修前载荷只有 `added:[laneId]`，外部读端**无法从数据面区分**「合法补边（追加即声明）」与「手改批 JSON」
  //      （本批 `p1-spec -> e2-g10` 即因此被终验误判为手改注入；实为本次播种，见 `exec/g10-toolface/progress/01`）。
  //      `planRevision` 递增与拒态语义**一字未动**（只增一个只读载荷键）。
  //   ④ 判据与建批期**同源**：归一化走 `buildWavePlan`、分层/环检测走 `topoWaves`（不另写一份判据）。
  function addPoolTasks(sessionId, batchId, incoming, { reason = null, author = null } = {}) {
    const file = batchFile(sessionId, batchId);
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId + ' @' + sessionId);
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); task append rejected');
    }
    const list = Array.isArray(incoming) ? incoming : [];
    if (list.length === 0) throw new Error('task append rejected: tasks 为空（须至少给出一条）');
    const existing = new Set(Object.keys(batch.lanes ?? {}));
    const ids = [];
    for (const t of list) {
      const id = t && typeof t.id === 'string' ? t.id.trim() : '';
      if (!id) throw new Error('task append rejected: 任务 id 须为非空字符串（实际=' + JSON.stringify(t?.id ?? null) + '）');
      if (existing.has(id)) throw new Error('task append rejected: 任务 id 已存在 ⇒ ' + id + '（本接口只增不改）');
      if (ids.includes(id)) throw new Error('task append rejected: 本次追加内 id 重复 ⇒ ' + id);
      ids.push(id);
    }
    // ★ 结构性保证（2026-09-21 18:5x 用户裁定 + 19:5x 全局化）：**引擎不提供成环回路** ⇒ 不做「成环断言」。
    //   做法（与建批期**同一套**约束，见 `wave-plan.ts#validateDepsStructure`）：
    //     ① `deps` 只许指向批次内**既有**任务（不得指向本次新增、不得自指）⇒ 已声明在先
    //     ② 只许指向**同层或上游层**（generic 不参与层序判定）
    //   ⇒ 新增任务之间无边、只依赖既有且层序不降 ⇒ **成环在结构上不可能**。
    const layerIdx = (v) => (v == null ? null : LAYERS.indexOf(String(v)));
    for (const t of list) {
      const id = String(t.id).trim();
      const deps = t && Array.isArray(t.deps) ? t.deps : [];
      const cur = layerIdx(t.layer ?? null);
      for (const d of deps) {
        if (typeof d !== 'string' || d.trim().length === 0) {
          throw new Error('task append rejected: deps 元素须为非空字符串（任务 ' + id + '）');
        }
        if (!existing.has(d)) {
          throw new Error('task append rejected: deps 只能指向批次内**既有**任务 ⇒ ' + d
            + '（不得指向本次新增的任务，亦不得自指；这是「不成环」的**结构性保证**，非断言检查）');
        }
        const up = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []))
          .find((x) => x && x.id === d);
        const upl = layerIdx(up?.layer ?? null);
        if (cur != null && upl != null && upl > cur) {
          throw new Error('task append rejected: deps 只许指向**同层或上游层** ⇒ 任务 ' + id
            + '（层 ' + String(t.layer) + '）不得依赖下游层 ' + d + '（层 ' + String(up?.layer) + '）');
        }
      }
    }
    const baseTasks = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    const merged = [...baseTasks, ...list.map((t) => ({ ...t, id: String(t.id).trim() }))];
    const plan = buildWavePlan({
      batchId, tasks: merged, team: batch.team, concurrency: batch.concurrency ?? 5,
    });
    const lanes = { ...batch.lanes };
    const handoffs = { ...(batch.handoffs ?? {}) };
    const ts = new Date().toISOString();
    // 【G-10/Q-H2 · lane `e3-toolface`】声明留痕：把本次按 `deps` 播种的**入边声明**逐条记下（行形态与
    //   `handoff-accept.js` 的 `accepts:[{from,to}]` **同形** ⇒ 两条「补边」路径在读端可同构解析）。
    const declared = [];
    for (const t of list) {
      const id = String(t.id).trim();
      lanes[id] = 'pending';
      const deps = Array.isArray(t.deps) ? t.deps.filter((d) => typeof d === 'string' && d.length > 0) : [];
      if (deps.length === 0) continue;
      handoffs[id] = deps.map((from) => ({
        from, to: id, batch: batchId, step: null,
        artifacts: [], contract: { consumedFrom: from, assertions: [] },
        status: 'pending', ts, officialTaskId: null,
      }));
      for (const from of deps) declared.push({ from, to: id });
    }
    const revision = (batch.planRevision ?? 0) + 1;
    const next = {
      ...batch,
      wavePlan: plan.wavePlan,
      lanes,
      handoffs,
      planRevision: revision,
      updatedAt: ts,
      events: [...(batch.events ?? []), newEvent(EVT.EVT_PLAN_MUTATED, {
        added: ids, declared, reason: reason ?? null, author: author ?? null, revision,
      })],
    };
    atomicWrite(file, next);
    return next;
  }

  // ── N1-R4-2（K1 公共池）：`task_update` 的落盘面 —— 给**池内**任务**加边**（只增不删）──────────────
  // 定位（蓝图 §7.4 触点 #3 / #5 / #6）：
  //   · K1 裁定「**未派发**任务在池内可自由调整依赖」⇒ 加边是**池内**动作，不在红线保护对象内；
  //   · ⚠ **已派发/已启动**（`owner` 非空 或 lane 已离开 `pending`）⇒ **冻结**，不得加边
  //     （K1：层内不重算 · 非改派；要变 ⇒ 作废 + 池内新增替代任务 + gap-list 留痕）。
  // 结构性保证（与 `wave-plan.ts#validateDepsStructure` 同口径；用户裁定**不做成环断言**）：
  //   ① `deps` 只许指向**已存在且声明序在前**的任务 ⇒ 依赖序严格前进；
  //   ② 只许指向**同层或上游层**（`generic`/无 layer 不参与层序判定，否则破存量）；
  //   ⇒ 依赖图是**严格偏序** ⇒ **成环在结构上不可能**（无需运行期检测）。
  // 单次 `atomicWrite`：wavePlan 重归一化（**重跑** `checkHandoffDeclarations` / `topoWaves` /
  //   `validateLayerContract`，判据与建批期同源）+ handoffs 按新 `deps` 补 `pending` 交条件
  //   （**保留既有条目状态**——禁重建丢档）+ `plan.mutated` 留痕（带 `edges`）+ `planRevision+1`。
  // 只增不删：**不提供删边**——删边会毁掉既有交接声明与下游已消费的事实，属「重算」，撞 K1 红线。
  function addTaskEdges(sessionId, batchId, edges, { reason = null, author = null } = {}) {
    const file = batchFile(sessionId, batchId);
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId + ' @' + sessionId);
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); task edge rejected');
    }
    const list = Array.isArray(edges) ? edges : [];
    if (list.length === 0) throw new Error('task edge rejected: edges 为空（须至少给出一条）');
    // 存量批（无 `handoffs` 字段）⇒ 加边会把它从 legacy 形态静默转成受门形态 ⇒ 拒（不静默改门语义）。
    if (batch.handoffs === undefined || batch.handoffs === null) {
      throw new Error('task edge rejected: 该批为**存量形态**（无 `handoffs` 字段）⇒ 加边会改变交接门语义（legacy 放行 → 受门约束）'
        + ' ⇒ 拒；请在新建批（带交接面）上操作');
    }
    const baseTasks = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    // 声明序真源 = **落盘 wavePlan 的 flat 顺序**（= `topoWaves` 分层结果 ⇒ 祖先恒在前）。
    const orderOf = new Map();
    const byId = new Map();
    baseTasks.forEach((t, i) => {
      if (t && typeof t.id === 'string' && t.id) { orderOf.set(t.id, i); byId.set(t.id, t); }
    });
    const lanes = batch.lanes ?? {};
    const layerIdx = (v) => (v == null ? null : LAYERS.indexOf(String(v)));
    // 全量校验先走完（**零写入**：任一违反即整批拒，不做部分落盘）。
    const planEntries = [];
    for (const e of list) {
      const id = e && typeof e.id === 'string' ? e.id.trim() : '';
      if (!id) throw new Error('task edge rejected: 任务 id 须为非空字符串');
      const target = byId.get(id);
      if (!target) throw new Error('task edge rejected: 任务不存在 ⇒ ' + id + '（本接口只给**既有**任务加边）');
      // K1：已派发即冻结（声明面 `owner` 为唯一真源；lane 状态是兜底，二者不许混用）。
      const owner = typeof target.owner === 'string' && target.owner ? target.owner : null;
      const laneState = lanes[id] ?? null;
      if (owner !== null || (laneState !== null && laneState !== 'pending')) {
        throw new Error('task edge rejected: 任务 ' + id + ' 已出池（owner=' + String(owner)
          + ' lane=' + String(laneState) + '）⇒ **已派发即冻结**（K1：层内不重算 · 非改派）；'
          + '如需变更，走「作废 + 池内新增替代任务 + gap-list 留痕」');
      }
      const addRaw = Array.isArray(e.add) ? e.add : [];
      const existingDeps = Array.isArray(target.deps) ? target.deps.filter((d) => typeof d === 'string' && d) : [];
      const fresh = [];
      for (const d0 of addRaw) {
        if (typeof d0 !== 'string' || d0.trim().length === 0) {
          throw new Error('task edge rejected: add 元素须为非空字符串（任务 ' + id + '）');
        }
        const d = d0.trim();
        if (existingDeps.includes(d) || fresh.includes(d)) continue; // 已有该边 ⇒ 幂等跳过（非错误）
        if (d === id) throw new Error('task edge rejected: 任务 ' + id + ' 不得自指（deps 不得指向自身）');
        const up = byId.get(d);
        if (!up) throw new Error('task edge rejected: 上游任务不存在 ⇒ ' + d + '（加边只许指向批次内既有任务）');
        // 结构保证 ①：声明序（严格偏序 ⇒ 成环结构上不可能）
        if (!(orderOf.get(d) < orderOf.get(id))) {
          throw new Error('task edge rejected: deps 只许指向**已声明在先**的任务 ⇒ ' + id + ' ← ' + d
            + '（这是「不成环」的**结构性保证**：依赖序严格前进，非成环断言）');
        }
        // 结构保证 ②：同层或上游层（`generic`/无 layer 不参与）
        const cur = layerIdx(target.layer ?? null);
        const upl = layerIdx(up.layer ?? null);
        if (cur != null && upl != null && upl > cur) {
          throw new Error('task edge rejected: deps 只许指向**同层或上游层** ⇒ 任务 ' + id + '（层 ' + String(target.layer)
            + '）不得依赖下游层 ' + d + '（层 ' + String(up.layer) + '）');
        }
        // 上游已终态 ⇒ 该边**结构性无法满足**：终态 lane 无法再 `handoff_submit` ⇒ 新边恒 `pending`
        //   ⇒ 下游 entry 门（开启时）永拒 ⇒ 死锁。⇒ 加边期即拒（不给「永远开不了工」的任务加边）。
        if (schema.isMemberTerminal(lanes[d])) {
          throw new Error('task edge rejected: 上游 ' + d + ' 已结算（lane=' + String(lanes[d])
            + '）⇒ 该边**无交接可等**（终态 lane 无法再提交交接）⇒ 结构性无法满足。'
            + '若你只是需要其产物在场，请用 `consume` 声明；若确需等待交接，须在**建批期**声明该 deps');
        }
        fresh.push(d);
      }
      planEntries.push({ id, fresh });
    }
    if (planEntries.every((p) => p.fresh.length === 0)) {
      throw new Error('task edge rejected: 本次**零新增边**（全部已存在）⇒ 不落盘');
    }
    const merged = baseTasks.map((t) => {
      const hit = planEntries.find((p) => p.id === t.id);
      if (!hit || hit.fresh.length === 0) return t;
      const old = Array.isArray(t.deps) ? t.deps : [];
      return { ...t, deps: [...old, ...hit.fresh] }; // 只增不删：旧边保持在先
    });
    // 重归一化 + 重跑建批期校验（判据同源；`checkHandoffDeclarations` 在 `buildWavePlan` 内部先于 `topoWaves`）。
    const plan = buildWavePlan({
      batchId, tasks: merged, team: batch.team, concurrency: batch.concurrency ?? 5,
    });
    const handoffs = { ...batch.handoffs };
    const ts = new Date().toISOString();
    const edgesLog = [];
    for (const p of planEntries) {
      if (p.fresh.length === 0) continue;
      const after = merged.find((t) => t.id === p.id);
      const deps = (Array.isArray(after?.deps) ? after.deps : []).filter((d) => typeof d === 'string' && d);
      const prev = Array.isArray(handoffs[p.id]) ? handoffs[p.id] : [];
      const byFrom = new Map();
      for (const r of prev) if (r && typeof r.from === 'string') byFrom.set(r.from, r);
      // 保留既有条目（**不重建丢状态**）；新入边补 `pending` 条（与建批期种子同形态）。
      handoffs[p.id] = deps.map((from) => byFrom.get(from) ?? {
        from, to: p.id, batch: batchId, step: null,
        artifacts: [], contract: { consumedFrom: from, assertions: [] },
        status: 'pending', ts, officialTaskId: null,
      });
      edgesLog.push({ id: p.id, add: p.fresh });
    }
    const revision = (batch.planRevision ?? 0) + 1;
    const next = {
      ...batch,
      wavePlan: plan.wavePlan,
      handoffs,
      planRevision: revision,
      updatedAt: ts,
      events: [...(batch.events ?? []), newEvent(EVT.EVT_PLAN_MUTATED, {
        edges: edgesLog, reason: reason ?? null, author: author ?? null, revision,
      })],
    };
    atomicWrite(file, next);
    return next;
  }

  return { addPoolTasks, addTaskEdges };
}
