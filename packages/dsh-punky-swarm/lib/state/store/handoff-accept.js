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

// G-10（批 `g10-fix-20261012`）：**受限反向声明**写入口 —— 「下游声明接受此上游」。
//
// 定位（判据源：`plan/design.md` §A.2 推荐候选 ② / §A.6 推荐方案 / `plan/scope.md` R-1、R-5）：
//   G-10 = 批运行中**追加的 lane（后置 lane）没有交付声明通道** —— `handoff_submit` 要求「该边已在
//   `batch.handoffs[to]` 里有声明条目」，而建批期种子只按 `task.deps` 逐边种条；后置 lane 恒落声明序
//   末尾 ⇒ 它**结构性不可能**成为既有下游的 `deps`（见 `lib/state/store/plan-mutate.js#addTaskEdges`
//   的「已声明在先」约束）⇒ 该边既交不上（拒 `GATE_HANDOFF_MISSING`），又**不转红**（出口门的「有无
//   下游」集合原本只读 `deps` ⇒ 无对象）—— 即「静默型」缺口。
//   **本函数的修法（与「放宽校验」相反的方向）**：不改 `handoff_submit` 的任何判据，而是在**被允许的
//   地方**（下游 lane 自己的入边表 `batch.handoffs[to]`）为这条边**补一个声明条目**，与建批期种子
//   **同形态**（`status:'pending'`）。声明一旦存在：① 上游 `from` 交付时可正常 `handoff_submit`（既有
//   前置自然读得到它）；② 下游 `to` 的 entry 门把它计入「声明过的入边」（**净收紧**：多等一条上游）；
//   ③ 出口门的「有无下游」集合（`lib/state/gates/handoff.ts#checkSettleHandoffGate`，集合口径单点 =
//   `lib/state/gates/helpers.ts#declaredInboundEdgesOf`）**立刻**把 `from` 认成「有下游的 lane」⇒
//   `from` 缺交即**转红**（拒 `GATE_HANDOFF_MISSING` + 既有 `lane.handoff.gap` 事件），不再静默。
//
// 写方纪律（本函数存在的理由）：**写方 = 下游**（消费方）。「我要不要等这条上游」这一判断天然属于
//   消费方；且**不跨 lane 改他人声明面**（不写 `to.consume`、不改他人任务字段）。
//
// 红线自查（`plan/scope.md` §C-1..C-6，逐条）：
//   C-1 不放宽 `handoff_submit`：本文件不触及 `lib/state/store/handoff.js` 的任何判据；
//   C-2 不静默放行：本函数是**净收紧**（补一条声明义务），且**必落事件**（`plan.mutated`）；
//   C-3 不弱化四门：不改 entry/settle 门的拒态语义，不改单写者锁（`handoff_submit` 的写权转移一字
//       不动），不改终态冻结（本函数对批终态与成员终态**双向拒**，见下 S-d/S-e）；
//   C-4 单点判定：「已声明入边」的唯一合成口径 = `declaredInboundEdgesOf`（本文件只**写入**该集合的
//       一个来源面，不另建一套判定）；
//   C-5 不写 `deps`：本文件**不触碰** `batch.wavePlan` / `orderOf` / `waves` / `validateDepsStructure`；
//   C-6 不新造 `GATE_*` 码：参数/前置类拒绝用**不带前缀的普通 `Error`**（与 `plan-mutate.js` 同纪律），
//       门禁侧缺交复用既有 `GATE_HANDOFF_MISSING`（**不由本文件抛**）。
//
// 受限开面（首版，逐条硬；判据源 §A.2「S-a/S-b/S-c 三条各自独立成立」+ 本 lane 任务包「反例」要求）：
//   S-a（写方 / 下游层）：`to` 必须是**已声明**的 lane，且 `to.layer === 'audit'`（首版只开 audit 面）；
//   S-b（产出方 / 后置 lane）：`from` 必须是**批运行中追加的**后置 lane —— 真源 = 批事件流
//       `plan.mutated.added[]` 之并集（**不新增字段**、不读 `owner`、不猜 lane 状态）；
//   S-c（声明序 / 承载位）：`orderOf(from) < orderOf(to)` —— `from` 必须**已声明在先**。同一条约束
//       同时保证：后置 lane 只能在**更早声明**的下游面前被接受，而**不能**反过来给更晚/不存在的下游
//       留条（这是既有「不成环」结构性保证在声明面上的同向延续，不新增拓扑保证）；
//   S-d（存量批）：`batch.handoffs` 缺失（legacy 形态）⇒ **拒**（禁把存量批静默转成受门形态）；
//   S-e（终态冻结）：批终态 ⇒ 拒；`from` / `to` 任一成员已终态 ⇒ 拒（终态 lane 无法再提交交接 ⇒
//       补出来的边结构性无法满足 ⇒ 死锁，与 `addTaskEdges` 的「上游已终态」判据同向）。
//
// 幂等（R-5）：同一 `(to, from)` 重复声明 ⇒ 返回既有条目、**不重复落事件、不递增 `planRevision`**。
//
// 审计留痕（硬约束「新通道必须有审计留痕」）：成功路径**必落**一条
//   `plan.mutated{ accepts:[{from,to}], reason, author, revision }`（`EVT.EVT_PLAN_MUTATED`，既有事件类，
//   **不新造事件类**）；随后上游提交交接落既有 `lane.handoff`、缺交落既有 `lane.handoff.gap`。

import * as schema from '../../schema.js';
import * as EVT from '../event-types.js';

export function buildHandoffAccept(cx) {
  const { batchFile, readBatch, newEvent, atomicWrite } = cx;

  // 单条接受声明的记录形态（**与建批期种子同形态** + 两个可核标注键）：
  //   `source:'accept'` = 边来源标注（读端据此区分「建批期 `deps` 声明」与「运行期下游接受」，防审计误读）；
  //   `acceptedBy`      = 接受方（本通道的写方，恒 `= to`）+ 接受时刻，供审计直接归因。
  function acceptRecordOf(from, to, batchId, ts) {
    return {
      from, to, batch: batchId, step: null,
      artifacts: [], contract: { consumedFrom: from, assertions: [] },
      status: 'pending', ts, officialTaskId: null,
      source: 'accept', acceptedBy: { lane: to, ts },
    };
  }

  function recordHandoffAccept(sessionId, batchId, { from, to, reason = null, author = null } = {}) {
    const file = batchFile(sessionId, batchId);
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId + ' @' + sessionId);
    if (typeof from !== 'string' || !from.trim().length) throw new Error('handoff accept rejected: from 必填（上游 lane id）');
    if (typeof to !== 'string' || !to.trim().length) throw new Error('handoff accept rejected: to 必填（下游 lane id）');
    const fromId = from.trim();
    const toId = to.trim();
    // S-e 前置：批终态 ⇒ 拒（与 `addPoolTasks` / `addTaskEdges` 同码同纪律）
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); handoff accept rejected');
    }
    // S-d 前置：存量批（无 `handoffs` 字段）⇒ 拒（否则会把 legacy 放行形态静默改成受门形态）
    if (batch.handoffs === undefined || batch.handoffs === null
      || typeof batch.handoffs !== 'object' || Array.isArray(batch.handoffs)) {
      throw new Error('handoff accept rejected: 该批为**存量形态**（无 `batch.handoffs` 字段）⇒ 补声明会改变交接门语义'
        + '（legacy 放行 → 受门约束）⇒ 拒；请在新建批（带交接面）上操作');
    }
    // 现状读取：任务表（声明序真源 = 落盘 wavePlan 的 flat 顺序，与 `plan-mutate.js` 同源）
    const tasks = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    const orderOf = new Map();
    const byId = new Map();
    tasks.forEach((t, i) => {
      if (t && typeof t.id === 'string' && t.id) { orderOf.set(t.id, i); byId.set(t.id, t); }
    });
    const target = byId.get(toId);
    // S-a：`to` 必须是已声明的 lane 且层为 audit
    if (!target) throw new Error('handoff accept rejected: 下游 lane 不存在 ⇒ ' + toId + '（须为批次内**已声明**的 lane）');
    if (target.layer !== 'audit') {
      throw new Error('handoff accept rejected: 下游 lane ' + toId + ' 的 layer = ' + String(target.layer ?? null)
        + ' ≠ audit ⇒ 本通道首版**只开 audit 面**（声明方必须是消费方 / 验收方，不接受任意层间补边）');
    }
    // S-e：成员终态双向拒（终态 lane 无法再 `handoff_submit` ⇒ 补出的边结构性无法满足）
    const lanes = batch.lanes ?? {};
    if (schema.isMemberTerminal(lanes[fromId])) {
      throw new Error('handoff accept rejected: 上游 ' + fromId + ' 已结算（lane=' + String(lanes[fromId])
        + '）⇒ 该边**无交接可等**（终态 lane 无法再提交交接）⇒ 结构性无法满足，拒');
    }
    if (schema.isMemberTerminal(lanes[toId])) {
      throw new Error('handoff accept rejected: 下游 ' + toId + ' 已结算（lane=' + String(lanes[toId])
        + '）⇒ 声明一条无法再被消费的入边会改变其已成立的入场判定 ⇒ 拒');
    }
    // S-b：`from` 必须是**批运行中追加的**后置 lane（真源 = `plan.mutated.added[]` 之并集）
    const appended = new Set();
    for (const e of batch.events ?? []) {
      if (!e || e.type !== EVT.EVT_PLAN_MUTATED) continue;
      for (const id of Array.isArray(e.added) ? e.added : []) if (typeof id === 'string' && id) appended.add(id);
    }
    if (!appended.has(fromId)) {
      throw new Error('handoff accept rejected: 上游 ' + fromId + ' 不是**批运行中追加的**后置 lane'
        + '（真源 = 批事件 `plan.mutated.added[]` 之并集）⇒ 本通道只服务「追加 lane 无声明位」这一缺口，'
        + '建批期即存在的 lane 请走建批期 `deps` 声明路径（勿把本通道当通用补边工具）');
    }
    const fromTask = byId.get(fromId);
    if (!fromTask) throw new Error('handoff accept rejected: 上游 lane 不存在于当前 wavePlan ⇒ ' + fromId);
    // S-c：声明序 —— `from` 必须在 `to` **之前**已声明（同向延续「不成环」的结构性保证）
    if (!(orderOf.get(fromId) < orderOf.get(toId))) {
      throw new Error('handoff accept rejected: 声明序违约 ⇒ orderOf(' + fromId + ') 不小于 orderOf(' + toId + ')'
        + '（后置 lane 只能被**更早声明**的下游接受；本通道不新增任何拓扑保证，也不给更晚的下游留条）');
    }
    // 自指拒绝（跨 lane 语义；本通道最小面）
    if (fromId === toId) throw new Error('handoff accept rejected: from 与 to 不得相同 ⇒ ' + fromId);
    const list = Array.isArray(batch.handoffs[toId]) ? batch.handoffs[toId] : [];
    // 幂等：该边已被声明（无论来源面）⇒ 直接返回既有条目，**零写入**（不落事件、不递增 revision）
    const existing = list.find((r) => r && r.from === fromId) ?? null;
    if (existing) {
      return {
        ok: true, idempotent: true, from: fromId, to: toId, revision: batch.planRevision ?? 0,
        record: { ...existing },
      };
    }
    // 单次原子写：补声明条目 + `plan.mutated{accepts}` 留痕 + `planRevision+1`（与 `plan-mutate.js` 同纪律）
    const ts = new Date().toISOString();
    const rec = acceptRecordOf(fromId, toId, batchId, ts);
    const revision = (batch.planRevision ?? 0) + 1;
    const next = {
      ...batch,
      // ⚠ `wavePlan` / `lanes` **逐字不动**（C-5：本通道不写 `deps`、不改任何既有任务字段与成员态）
      handoffs: { ...batch.handoffs, [toId]: [...list, rec] },
      planRevision: revision,
      updatedAt: ts,
      events: [...(batch.events ?? []), newEvent(EVT.EVT_PLAN_MUTATED, {
        accepts: [{ from: fromId, to: toId }], reason: reason ?? null, author: author ?? null, revision,
      })],
    };
    atomicWrite(file, next);
    return { ok: true, idempotent: false, from: fromId, to: toId, revision, record: { ...rec } };
  }

  return { recordHandoffAccept };
}
