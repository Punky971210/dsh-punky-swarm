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

// 公共池任务面工具（自 `lib/tools/core.js` **原样搬移**）：task_pool / batch_tasks_add / task_update。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertModeActive, ownerOfExec } from './tier-gate.js';
import { isMemberTerminal } from '../schema.js'; // N1-R4-1a：公共池「上游是否已结算」判据（终态单一真源，勿另写）

// ── 池判据单点（K1 公共池）：`task_pool` 工具面与只读 HTTP 投影（`/batch.pool`）**共用本函数** ──
// 为什么抽到这里：`lib/api.js` 的 `/batch` 帧亦需向面板下发池视图（B-2），而「池 = `owner == null`
//   的视图 + 上游未结算/lane 已离开 pending 两类 blocker」这套判定若在 api.js 再写一份，即**两个读端
//   各自解释池**（判据分裂）。故以本函数为唯一真源：api.js 只 `import` 调用，不重写等价逻辑。
// 返回形状与 `task_pool` 工具输出同源（pooled / dispatched / pool），工具面只做外加身份与 note。
export function poolViewOf(batch) {
  const lanes = (batch && batch.lanes) || {};
  const tasks = ((batch && batch.wavePlan) || []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
  const pool = [];
  let dispatched = 0;
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string') continue;
    // 出池判据 = **声明面** `owner` 非空（唯一真源；不靠 lane 状态反推——状态是执行面，二者不许混用）。
    const owner = typeof t.owner === 'string' ? t.owner : null;
    if (owner !== null) { dispatched += 1; continue; }
    const laneState = lanes[t.id] ?? null;
    const deps = Array.isArray(t.deps) ? t.deps : [];
    const blockers = [];
    for (const d of deps) {
      if (!isMemberTerminal(lanes[d])) {
        blockers.push('GATE_HANDOFF_MISSING: 上游 ' + d + ' 未结算（当前 ' + String(lanes[d] ?? 'unknown') + '）');
      }
    }
    // K1：已派发/已启动（lane 已离开 `pending`）⇒ 冻结，不得视为可重派对象。
    if (laneState !== null && laneState !== 'pending') {
      blockers.push('ALREADY_DISPATCHED: lane=' + t.id + ' 状态 ' + laneState + '（已派发即冻结，K1）');
    }
    pool.push({
      id: t.id, layer: t.layer ?? null, role: t.role ?? null, cmd: t.cmd ?? '',
      deps, owner: null, laneState,
      dispatchable: blockers.length === 0,
      blockers,
    });
  }
  return { pooled: pool.length, dispatched, pool };
}

export function buildTaskTools(cx) {
  const { deps, store } = cx;
  return [
    // ── N1-R4-1a（K1 公共池）：`task_pool` = 只读视图 ────────────────────────────────
    // 定位：池 = `owner == null` 的**筛选视图**（蓝图 §3.2 P-A），**不是容器**（P-B 撞 H3 不取）。
    //   ⇒ 本工具**只读**：不授权、不认领（不引入 claim）、不改任何状态；派发仍由 Leader 单点发起，派发即门禁。
    //   ⇒ 已出池（`owner` 非空）的任务**不在池内**——这是 K1「层内不重算 · 非改派」的读端表达。
    defineTool({
      name: "task_pool",
      description: "查询**公共池**（只读视图）：列出批次内**未派发**任务（`owner == null`）+ 每条的「可派发性」判定（上游 deps 是否已结算、lane 是否已被派发）。⚠ 池 = 视图不是容器：本工具**不授权、不认领、不改任何状态**；派发仍由 Leader 单点经 lane_dispatch 发起（K1：不引入 claim 自领），派发即门禁；已派发/已启动任务不在池内（层内不重算 · 非改派）。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"sessionId":{"type":"string"},"pooled":{"type":"integer"},"dispatched":{"type":"integer"},"pool":{"type":"array","items":{"type":"object","additionalProperties":true}},"note":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('pool ' + value.batchId + ': pooled=' + value.pooled
          + ' dispatched=' + value.dispatched
          + ' 可派发=' + (value.pool ?? []).filter((t) => t.dispatchable).length),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
        const view = poolViewOf(b);
        return {
          batchId: args.batchId, sessionId,
          pooled: view.pooled, dispatched: view.dispatched,
          pool: view.pool,
          note: '池 = `owner == null` 的**视图**（不是容器）：本工具只读、不认领；派发 = Leader 单点（`lane_dispatch`），派发即门禁。',
        };
      },
    }),
    // ── N1-R4-1c（K1 公共池）：`batch_tasks_add` = **图变更的唯一写入口** ─────────────
    // 用户裁定（2026-09-21 13:3x）：plan 层的**调查摸底/拆分本身就是独立任务**，其产物由下游 exec/audit
    //   层 `consume` ⇒ **不存在「拆父任务」语义** ⇒ 原 `task_split` 设计前提不成立（已舍弃，见蓝图 §7.4.2）。
    //   本工具只做一件事：**往池里加任务**（追加 lane），单次原子写完成归一化 + 播种 + 留痕 + 重跑分层校验。
    //   ⚠ 只增不改：既有任务（含未派发的）一概不动（已派发即冻结）。
    defineTool({
      name: "batch_tasks_add",
      description: "向批次**池内追加任务**（图变更的唯一写入口）：单次原子写完成「归一化 + lanes 播种 + handoffs 播种 + `plan.mutated` 留痕」，并重跑建批期分层/环检测（判据与 `wave_plan` 同源）。⚠ **只增不改**：既有任务（含未派发的）一概不动（K1：已派发即冻结）；新任务 `owner` 缺省 `null` = **在池内**，须经 Leader 派发（`lane_dispatch`）才出池。plan 层的调查摸底/拆分本身即独立任务——其产物由下游 exec/audit 层 consume，**不存在「拆父任务」语义**。非法输入（id 重复/为空、deps 成环或悬空、批不存在）抛**普通错误**（不带 `GATE_` 前缀）；批次已终态抛 `GATE_BATCH_TERMINAL`。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"tasks":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true},"description":"追加的任务数组；每项须含唯一非空 `id`，可选 `layer`/`role`/`cmd`/`deps`/`consume`/`produce`/`outputs`。`owner` 缺省 `null` = 在池内"},"reason":{"type":"string","description":"追加理由（落 `plan.mutated` 留痕，供审计复盘）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"added":{"type":"array","items":{"type":"string"}},"planRevision":{"type":"integer"},"lanesCount":{"type":"integer"},"note":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('tasks added to ' + value.batchId + ': ' + (value.added ?? []).join(', ')
          + ' (revision=' + value.planRevision + ', lanes=' + value.lanesCount + ')'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '池内追加任务（batch_tasks_add）'); // 模式门（E 阶段）：非生效模式零治理写入，先于参数/状态校验
        const sessionId = sessionOf(args, exec);
        const list = Array.isArray(args.tasks) ? args.tasks : [];
        const b = store.addPoolTasks(sessionId, args.batchId, list, {
          reason: args.reason ?? null,
          author: ownerOfExec(exec),
        });
        return {
          batchId: args.batchId,
          added: list.map((t) => String(t?.id ?? '')),
          planRevision: b.planRevision ?? 1,
          lanesCount: Object.keys(b.lanes ?? {}).length,
          note: '追加的任务已在池内（`owner=null`）⇒ 须经 Leader 派发才出池；本次变更已落 `plan.mutated`。',
        };
      },
    }),
    // ── N1-R4-2（K1 公共池）：`task_update` = 给**池内**任务**加边**的写入口 ────────────────────
    // 兑现蓝图 §7.4 触点 #3（重跑 `checkHandoffDeclarations`）/ #5（同事务补 `pending` 交条件）/ #6（出口门读当前声明）。
    //   · K1：「**未派发**任务在池内可自由调整依赖」⇒ 加边是**池内**动作，不在红线保护对象内；
    //   · ⚠ 已派发/已启动（`owner` 非空 或 lane 已离开 `pending`）⇒ **冻结**、不得加边（层内不重算 · 非改派）；
    //   · **只增不删**：不提供删边——删边会毁掉既有交接声明与下游已消费的事实 ⇒ 属「重算」，撞 K1 红线；
    //   · **不成环靠结构性保证**（用户裁定：不做成环断言）：新边只许指向**已声明在先** + **同层或上游层**的任务；
    //   · 单次 `atomicWrite`：wavePlan 重归一化（**重跑**建批期校验）+ handoffs 补 `pending` 交条件 + `plan.mutated` 留痕。
    //   ⇒ 触点 #6 **无需改码**：出口门 `checkSettleHandoffGate` 的「下游集合」本就**直接读落盘 `batch.wavePlan`**
    //     （= 当前 revision 的声明）⇒ 加边后自动感知；「换数据源」的真相 = 数据源本来就是它（本批补断言锁住）。
    defineTool({
      name: "task_update",
      description: "给**池内任务加边**（新增依赖，只增不删）：仅限**未派发**任务（`owner == null` 且 lane 仍 `pending`）；已派发/已启动任务**冻结**（K1：层内不重算 · 非改派；换人走「作废 + 池内新增替代任务 + gap-list」）。新依赖须**已声明在先**且**同层或上游层**（不成环的**结构性保证**，非成环断言），且上游**未结算**（终态 lane 无交接可等 ⇒ 该边结构性无法满足）。单次原子写：wavePlan 重归一化（重跑建批期校验）+ handoffs 补 `pending` 交条件 + `plan.mutated` 留痕 + `planRevision+1`。⚠ **删边不提供**（属重算）。非法输入抛**普通错误**（不带 `GATE_` 前缀）；批次已终态抛 `GATE_BATCH_TERMINAL`。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"edges":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true},"description":"加边数组；每项形如 `{ id, add: [上游任务 id, ...] }`——`id` = 池内目标任务（须未派发），`add` = 新增依赖（只增不删；须已存在、已声明在先、同层或上游、未结算）"},"reason":{"type":"string","description":"加边理由（落 `plan.mutated` 留痕，供审计复盘）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"edges":{"type":"array","items":{"type":"object","additionalProperties":true}},"planRevision":{"type":"integer"},"handoffsCount":{"type":"integer"},"note":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('edges added to ' + value.batchId + ': '
          + (value.edges ?? []).map((e) => e.id + '<-' + (e.add ?? []).join('+')).join('; ')
          + ' (revision=' + value.planRevision + ')'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '池内任务加边（task_update）'); // 模式门：非生效模式零治理写入，先于参数/状态校验
        const sessionId = sessionOf(args, exec);
        const list = Array.isArray(args.edges) ? args.edges : [];
        const b = store.addTaskEdges(sessionId, args.batchId, list, {
          reason: args.reason ?? null,
          author: ownerOfExec(exec),
        });
        return {
          batchId: args.batchId,
          edges: list.map((e) => ({
            id: String(e?.id ?? ''),
            add: Array.isArray(e?.add) ? e.add.map((x) => String(x)) : [],
          })),
          planRevision: b.planRevision ?? 1,
          handoffsCount: Object.values(b.handoffs ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
          note: '加边已落盘（单次原子写）：新入边已补 `pending` 交条件，`plan.mutated` 已留痕。'
            + '⚠ 只增不删——删边会毁掉既有交接声明与下游已消费事实（属「重算」，撞 K1 红线），故不提供。',
        };
      },
    }),
  ];
}