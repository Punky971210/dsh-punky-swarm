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
import { assertModeActive, ownerOfExec, readLiveConfig } from './tier-gate.js';
import { handoffGateEnabledOf } from '../wave-plan.js';
import { isMemberTerminal } from '../schema.js';

export function poolViewOf(batch) {
  const lanes = (batch && batch.lanes) || {};
  const tasks = ((batch && batch.wavePlan) || []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
  const pool = [];
  let dispatched = 0;
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string') continue;
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
  const { resolveBatchSession } = deps;
  return [
    defineTool({
      name: "task_pool",
      description: "查询公共池（只读视图）：列出批次内未派发任务（owner == null）+ 每条的可派发性（上游 deps 是否已结算、lane 是否已派发）。池是视图不是容器：不授权、不认领、不改任何状态；派发仍由 Leader 经 lane_dispatch 单点发起。已派发/已启动任务不在池内。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"sessionId":{"type":"string"},"pooled":{"type":"integer"},"dispatched":{"type":"integer"},"pool":{"type":"array","items":{"type":"object","additionalProperties":true}},"note":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('pool ' + value.batchId + ': pooled=' + value.pooled
          + ' dispatched=' + value.dispatched
          + ' 可派发=' + (value.pool ?? []).filter((t) => t.dispatchable).length),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
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
    defineTool({
      name: "batch_tasks_add",
      description: "向批次池内追加任务（图变更唯一写入口）：单次原子写完成归一化 + lanes/handoffs 播种 + plan.mutated 留痕，并重跑建批期分层与环检测（判据与 wave_plan 同源）。只增不改：既有任务一概不动；新任务 owner 缺省 null（在池内），须经 lane_dispatch 才出池。拆父任务语义不存在（plan 层摸底/拆分本身即独立任务）。非法输入抛普通错误（不带 GATE_ 前缀），批终态抛 GATE_BATCH_TERMINAL。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true,"description":"批次 ID"},"tasks":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true},"description":"追加的任务数组；每项须含唯一非空 id，可选 layer/role/cmd/deps/consume/produce/outputs；owner 缺省 null = 在池内"},"reason":{"type":"string","description":"追加理由（落 plan.mutated 留痕）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"added":{"type":"array","items":{"type":"string"}},"planRevision":{"type":"integer"},"lanesCount":{"type":"integer"},"note":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('tasks added to ' + value.batchId + ': ' + (value.added ?? []).join(', ')
          + ' (revision=' + value.planRevision + ', lanes=' + value.lanesCount + ')'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '池内追加任务（batch_tasks_add）');
        const sessionId = sessionOf(args, exec);
        const list = Array.isArray(args.tasks) ? args.tasks : [];
        const b = store.addPoolTasks(sessionId, args.batchId, list, {
          reason: args.reason ?? null,
          author: ownerOfExec(exec),
          handoffGate: handoffGateEnabledOf(readLiveConfig(deps), 'entry'),
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
    defineTool({
      name: "task_update",
      description: "给池内任务加边（新增依赖，只增不删）：仅限未派发任务（owner == null 且 lane 仍 pending）；已派发/已启动任务冻结（换人走作废 + 池内新增替代 + gap-list）。新依赖须已声明在先、同层或上游层、且上游未结算。单次原子写：wavePlan 重归一化 + handoffs 补 pending + plan.mutated 留痕 + planRevision+1。删边不提供（属重算）。非法输入抛普通错误（不带 GATE_ 前缀），批终态抛 GATE_BATCH_TERMINAL。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true,"description":"批次 ID"},"edges":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true},"description":"加边数组，每项 { id, add: [上游任务 id, ...] }：id = 池内目标任务（须未派发），add = 新增依赖（须已存在、已声明在先、同层或上游、未结算）"},"reason":{"type":"string","description":"加边理由（落 plan.mutated 留痕）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"edges":{"type":"array","items":{"type":"object","additionalProperties":true}},"planRevision":{"type":"integer"},"handoffsCount":{"type":"integer"},"note":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('edges added to ' + value.batchId + ': '
          + (value.edges ?? []).map((e) => e.id + '<-' + (e.add ?? []).join('+')).join('; ')
          + ' (revision=' + value.planRevision + ')'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '池内任务加边（task_update）');
        const sessionId = sessionOf(args, exec);
        const list = Array.isArray(args.edges) ? args.edges : [];
        const b = store.addTaskEdges(sessionId, args.batchId, list, {
          reason: args.reason ?? null,
          author: ownerOfExec(exec),
          handoffGate: handoffGateEnabledOf(readLiveConfig(deps), 'entry'),
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