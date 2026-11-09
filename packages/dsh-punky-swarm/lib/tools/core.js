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

// 蟛蜞模式治理核心工具（11 个），defineTool 规范含 output.schema + output.render
// 共享辅助（下沉至零依赖 shared.js）：TEXT_OUTPUT / sessionOf——本文件 re-export 保持对外导出兼容





import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertModeActive, clearPendingBatch } from './tier-gate.js';
import { assertNotSentinelSessionArg, authorizeBatchWrite } from '../state/session-authority.js';
import { warnAbortDangling, danglingLanesOf } from '../state/dangling.js';
import { previewBatchControl } from '../engine/tree-control.js';

import { buildWavePlanTools } from './wave-plan-tools.js';
import { buildBatchStatusTools, buildGateTools, buildRoleGuideTools, buildTaskpackTools } from './query-tools.js';
import { buildArtifactTools, buildAssetClaimTools } from './asset-tools.js';
import { buildAssignTools } from './assign-tools.js';
import { buildLaneTools, buildDispatchTools, buildMemberStatusTools } from './member-tools.js';
import { buildHandoffTools } from './handoff-tools.js';
import { buildSwarmTools } from './swarm-tools.js';
import { buildTaskTools } from './task-tools.js';

export { TEXT_OUTPUT, sessionOf } from './shared.js';
export { EXEC_TOOLS, assertMemberActionTierC, assertModeActive, lockPath, installDifficultyGuard } from './tier-gate.js';
export { WAKE_MIN_INTERVAL_MS, LEADER_WAKE_WINDOWS, wakeLeaderForReport } from './swarm-comms.js';

export { CARD_FIELDS, buildConfirmCard } from '../engine/confirm-card.js';

function buildPhaseTools(cx) {
  const { deps, store } = cx;
  const { resolveBatchSession } = deps ?? {};
  return [
    defineTool({
      name: "batch_phase",
      description: "阶段迁移 planning->running->paused->aborted|complete（终态拒写）；complete 前置 audit 层验收齐备。批次按会话隔离；reason 缺省 manual:batch_phase:<phase>。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true,"enum":["running","paused","aborted","complete"]},"reason":{"type":"string","description":"相位迁移事由（写入 batch.phase 事件；缺省 manual:batch_phase:<phase>）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true},"danglingLanes":{"type":"array","items":{"type":"string"}}}},
        render: (_args, value) => TEXT_OUTPUT('batch ' + value.batchId + ' phase -> ' + value.phase
          + (value.danglingLanes?.length ? '; dangling lanes: ' + value.danglingLanes.length : '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '批次阶段迁移（batch_phase）');
        assertNotSentinelSessionArg(args, 'batch_phase');                       // D-03/RQ-5：显式 session 不得取哨兵
        const sessionId = sessionOf(args, exec, resolveBatchSession);           // D-02/RQ-2：绑齐派发绑定级
        authorizeBatchWrite({ store, sessionId, batchId: args.batchId, exec, where: 'batch_phase' }); // D-01/D-04 站点3
        const b = store.setPhase(sessionId, args.batchId, args.phase, { reason: args.reason ?? ('manual:batch_phase:' + args.phase) });
        if (b.phase === 'complete' || b.phase === 'aborted') clearPendingBatch(store, sessionId);
        const out = { batchId: args.batchId, phase: b.phase };
        //   不得因此新增事件）；无悬挂成员（全终态）的批 ⇒ **不落事件、不写 `danglingLanes` 键**（反例锁）。
        const dg = warnAbortDangling(store, sessionId, args.batchId, b);
        if (dg) out.danglingLanes = dg.danglingLanes;
        return out;
      },
    }),
    defineTool({
      name: "batch_control",
      description: "对批次的人工干预：pause（running→paused，停自动推进）/ resume（paused→running，停轮批的唯一恢复入口）/ abort（→aborted 收口，有悬挂成员时回 danglingLanes）。幂等：目标相位已达成 ⇒ no-op。绝不改任何成员状态。非法迁移走既有相位机报错码。批次按会话隔离，缺省取当前执行会话。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true,"description":"批次 ID"},"action":{"type":"string","required":true,"enum":["pause","resume","abort"],"description":"干预动作：pause=停轮 / resume=唯一恢复入口 / abort=收口（不可逆）"},"preview":{"type":"boolean","description":"预演（缺省 false）：true ⇒ 零写入，只返回 {affected,skipped,warnings,totals} 预测面；随后不带 preview 再真执行"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true},"action":{"type":"string","required":true},"noop":{"type":"boolean"},"danglingLanes":{"type":"array","items":{"type":"string"}},"preview":{"type":"object","additionalProperties":false,"description":"仅 preview:true 时出现（预演面：零写入）","properties":{"affected":{"type":"array","items":{"type":"string"}},"skipped":{"type":"array","items":{"type":"string"}},"warnings":{"type":"array","items":{"type":"string"}},"totals":{"type":"object","additionalProperties":false,"properties":{"affected":{"type":"integer"},"skipped":{"type":"integer"}}}}}}},
        render: (_args, value) => TEXT_OUTPUT(value.preview
          ? 'batch ' + value.batchId + ' control ' + value.action + ' PREVIEW -> ' + value.phase
            + ' (affected ' + value.preview.affected.length + ', skipped ' + value.preview.skipped.length + ')'
            + (value.preview.warnings.length ? '; warnings: ' + value.preview.warnings.join(' | ') : '')
          : 'batch ' + value.batchId + ' control ' + value.action + ' -> ' + value.phase
            + (value.noop ? ' (no-op: already ' + value.phase + ')' : '')
            + ((value.danglingLanes ?? []).length ? '; dangling lanes: ' + value.danglingLanes.length : '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '批次干预（batch_control）');
        assertNotSentinelSessionArg(args, 'batch_control');                     // D-03/RQ-5
        const sessionId = sessionOf(args, exec, resolveBatchSession);           // D-02/RQ-2
        const action = args.action;
        if (!['pause', 'resume', 'abort'].includes(action)) {
          throw new Error('GATE_BATCH_CONTROL_ACTION_INVALID: batch_control action 只允许 pause|resume|abort（收到 ' + JSON.stringify(action ?? null) + '）');
        }
        //   站点4（`action` 取值即改相位，含不可逆 abort）：值域判定之后、**任何写之前**过属主门。
        authorizeBatchWrite({ store, sessionId, batchId: args.batchId, exec, where: 'batch_control(' + action + ')' });
        const cur = store.readBatch(sessionId, args.batchId);
        if (!cur) throw new Error('batch not found: ' + args.batchId);
        if (args.preview === true) {
          return previewBatchControl({ store, sessionId, batchId: args.batchId, action, deps });
        }
        const idempotent = (phase) => {
          const out = { batchId: args.batchId, phase, action, noop: true };
          if (action === 'abort' && phase === 'aborted') {
            const lanes = danglingLanesOf(store.readBatch(sessionId, args.batchId));
            if (lanes.length > 0) out.danglingLanes = lanes;
          }
          return out;
        };
        if (action === 'pause' && cur.phase === 'paused') return idempotent('paused');
        if (action === 'resume' && cur.phase === 'running') return idempotent('running');
        if (action === 'abort' && cur.phase === 'aborted') return idempotent('aborted');
        const target = action === 'pause' ? 'paused' : (action === 'resume' ? 'running' : 'aborted');
        const b = store.setPhase(sessionId, args.batchId, target, { reason: 'manual:batch_control.' + action });
        if (b.phase === 'complete' || b.phase === 'aborted') clearPendingBatch(store, sessionId);
        const out = { batchId: args.batchId, phase: b.phase, action };
        const dg = action === 'abort' ? warnAbortDangling(store, sessionId, args.batchId, b) : null;
        if (dg) out.danglingLanes = dg.danglingLanes;
        return out;
      },
    }),
  ];
}

export function createCoreTools(ctx, deps) {
  const { store, root, config = {} } = deps;
  const cx = { ctx, deps, store, root, config };
  return [
    ...buildWavePlanTools(cx),
    ...buildPhaseTools(cx),
    ...buildBatchStatusTools(cx),
    ...buildArtifactTools(cx),
    ...buildAssignTools(cx),
    ...buildAssetClaimTools(cx),
    ...buildGateTools(cx),
    ...buildRoleGuideTools(cx),
    ...buildTaskpackTools(cx),
    ...buildLaneTools(cx),
    ...buildHandoffTools(cx),
    ...buildDispatchTools(cx),
    ...buildSwarmTools(cx),
    ...buildMemberStatusTools(cx),
    ...buildTaskTools(cx),
  ];
}