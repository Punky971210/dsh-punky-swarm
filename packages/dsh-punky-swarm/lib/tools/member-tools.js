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

// 成员 / lane 工具面（自 `lib/tools/core.js` **原样搬移**）：lane_claim / lane_release / member_settle /
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertModeActive, assertMemberActionTierC, readLiveConfig, lockPath, ownerOfExec } from './tier-gate.js';
import { dispatchBindingDecision } from '../verify/binding.js';
import * as lock from '../lock.js';
import { TERMINAL_MEMBER_STATES, SETTABLE_MEMBER_STATES } from '../schema.js';
import {
  dispatchLaneCore,
} from '../engine/dispatch.js';

export function buildLaneTools(cx) {
  const { ctx, deps, store, root } = cx;
  const { resolveBatchSession } = deps ?? {};
  return [
    defineTool({
      name: "lane_claim",
      description: "以 O_EXCL 单写者锁认领 lane（同一批次同一 lane 同时只允许一个写者）。冲突先拒，可 wait 或 force 接管；锁按会话隔离。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"任务 ID"},"waitMs":{"type":"integer","description":"等待毫秒（默认 0 = 直接冲突返回）"},"force":{"type":"boolean","description":"force 接管（默认 false）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"token":{"type":"string"},"conflict":{"type":"boolean"},"reason":{"type":"string"},"lockPath":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane claimed') : TEXT_OUTPUT('lane conflict'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, 'lane 锁认领（lane_claim）'); // 模式门（E 阶段）：非生效模式不得落锁（零治理写入），先于取锁
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        //   （接管了他人的单写者锁），生产路径必须留一行日志，否则「接管可审计」只存在于返回载荷里。
        const warn = (m) => { try { ctx?.logger?.warn?.(m); } catch {  } };
        const r = await lock.acquire(lockPath(root, sessionId, args.batchId, args.lane), { waitMs: args.waitMs ?? 0, force: args.force === true, warn });
        if (!r.ok) {
          const reason = (typeof r.reason === 'string' && r.reason) ? r.reason : 'lane locked';
          return { ok: false, conflict: true, reason };
        }
        return { ok: true, token: r.token };
      },
    }),
    defineTool({
      name: "lane_release",
      description: "释放 lane 锁（须持 token，不匹配即拒）；锁按会话隔离。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"token":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"reason":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane released') : TEXT_OUTPUT('release failed: ' + (value.reason ?? '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, 'lane 锁释放（lane_release）');
        return lock.release(lockPath(root, sessionOf(args, exec, resolveBatchSession), args.batchId, args.lane), args.token);
      },
    }),
    defineTool({
      name: "member_settle",
      description: "成员结算：running->review->merged/failed/skipped/conflict，限该批 owner 或已登记 Manager。merged 前验 Tier3（plan 契约、exec outputs、audit produce、targets 落盘）；audit lane 产物含独立行 needHuman: true 时 merged 的 note 须带 human:<裁决人>:<时间>:<结论>，缺则拒 GATE_NEEDHUMAN_PENDING（conflict 驳回不强制）；exec 层可声明 gate: <命令>（exit 0 通过）。audit lane 不自动结算 ⇒ 先 member_set_status(review) 再调本工具；完成判定靠三查（batch_status、log_export、产物根 glob）。abort 批 danglingLanes 属预期残留。失败必带 GATE_* 码。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":TERMINAL_MEMBER_STATES},"note":{"type":"string","description":"简短备注（只留元数据，不复制正文）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' settled -> ' + value.status),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps);
        const bindingOfSettle = dispatchBindingDecision({
          batch: store.readBatch(sessionId, args.batchId),
          lane: args.lane,
          caller: exec?.agent?.session?.id ?? null,
          where: 'member_settle(lane=' + args.lane + ')',
        });
        if (!bindingOfSettle.ok) throw new Error(bindingOfSettle.reason);
        // 状态推进与「批是否收口」解耦：**结算旁挂失败不得阻塞状态推进**。
        const before = store.readBatch(sessionId, args.batchId);
        if (before && before.lanes && before.lanes[args.lane] === args.status) {
          // 幂等：同态重复结算 ⇒ 零写（不重复落事件、不抖动相位）
          return { batchId: args.batchId, lane: args.lane, status: args.status, settled: true };
        }
        const settledBatch = store.setMember(sessionId, args.batchId, args.lane, args.status, args.note ?? null);
        let settled = false;
        try { settled = store.batchSettled(settledBatch) !== false; } catch { settled = false; }
        return { batchId: args.batchId, lane: args.lane, status: settledBatch.lanes[args.lane], settled };
      },
    }),
  ];
}

export function buildDispatchTools(cx) {
  const { ctx, deps, store, root } = cx;
  const { resolveBatchSession } = deps ?? {};
  return [
    defineTool({
      name: "lane_dispatch",
      description: '集群派发：为 lane 发一次性句柄 + 置 running + 引擎自派 worker；门禁同 member_set_status(running)（限 owner/Manager，exec 需 consume 齐备）。自派按次收窄成员工具面并写 member.dispatch；能力位 fail-closed：provider 不支持 toolFilter/depthLimit 或为 startActivation 形态 ⇒ 拒派（mode=rejected、code=GATE_DISPATCH_CAPABILITY_UNAVAILABLE），打在状态变更之前。仅当 ctx.subagents 不可取、或服务在位但两入口皆不可调用 ⇒ 降级为「仅发句柄」（spawned:false + 成因）。句柄含 firstLine（供人工直派形态粘贴），TTL 30 分钟。',
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"},"prompt":{"type":"string","description":"Leader 补充的任务要点（可选）：接在引擎「角色/契约/纪律」骨架之后"},"exempt":{"type":"object","additionalProperties":false,"description":"longrun 豁免：type=ai-render|large-download|dep-install|none（档位 8/6/4/4）；multiplier [1,100]；stalled 缺省 true","properties":{"type":{"type":"string","required":true,"enum":["ai-render","large-download","dep-install","none"]},"multiplier":{"type":"number"},"stalled":{"type":"boolean"}}}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"token":{"type":"string"},"firstLine":{"type":"string"},"ttlMs":{"type":"number"},"spawned":{"type":"boolean","required":true},"workerSessionId":{"type":"string"},"spawnNote":{"type":"string"},"mode":{"type":"string","enum":["degraded","rejected"],"description":"结局面：degraded=派了但无法保证｜rejected=主动拒派（收窄不可核）；成功路径 spawned:true 不产本字段"},"code":{"type":"string","description":"拒码，仅 mode==='rejected' 时给（GATE_DISPATCH_CAPABILITY_UNAVAILABLE）"},"unconfirmed":{"type":"boolean","description":"派发已尝试但无法确认（不可确认 ≠ 失败）"},"reason":{"type":"string","description":"机器可判短码；spawnNote=长文供人读"}}},
        render: (_args, value) => TEXT_OUTPUT('lane ' + value.lane + ' dispatched'
          + (value.mode === 'rejected'
            ? '（拒派：' + String(value.spawnNote ?? '') + '）'
            : value.spawned
              ? '（引擎自派：worker=' + String(value.workerSessionId) + '）'
              : '（仅发句柄：' + String(value.spawnNote ?? '') + '）')
          + '\n' + value.firstLine),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps);
        return await dispatchLaneCore({
          ctx, store, root, liveConfig: readLiveConfig(deps), exec, sessionId,
          dispatchIndex: deps?.dispatchIndex,
          batchId: args.batchId, lane: args.lane,
          leaderPrompt: args.prompt ?? '', exempt: args.exempt,
        });
      },
    }),
  ];
}

export function buildMemberStatusTools(cx) {
  const { deps, store } = cx;
  const { resolveBatchSession } = deps ?? {};
  return [
    //   （不得反向修：把 `idle` 做成可设 = 动迁移表语义，属另一批）。
    defineTool({
      name: "member_set_status",
      description: '成员状态操作（非终态）：pending->running（派发）、running->review（提交评审）、idle->running（恢复重派）；闭集不含 idle（该态只能经恢复/回收单点进入）。限该批 owner 或已登记 Manager。running 可带 exempt。终态结算用 member_settle。',
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":SETTABLE_MEMBER_STATES,"description":"目标成员态（闭集不含 idle：该态只能经恢复/回收单点进入，设置必被状态机拒）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"},"exempt":{"type":"object","additionalProperties":false,"description":"longrun 豁免（仅 status=running 可带）：type=ai-render|large-download|dep-install|none（档位 8/6/4/4）；multiplier [1,100]；stalled 缺省 true","properties":{"type":{"type":"string","required":true,"enum":["ai-render","large-download","dep-install","none"]},"multiplier":{"type":"number"},"stalled":{"type":"boolean"}}}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' status -> ' + value.status),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps);
        //   **不再做容量准入**（高并发不得被限流），`running` 迁移一律照常放行；本文件对该符号**零引用**。
        const b = store.setMember(sessionId, args.batchId, args.lane, args.status, null, args.exempt, ownerOfExec(exec));
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
  ];
}