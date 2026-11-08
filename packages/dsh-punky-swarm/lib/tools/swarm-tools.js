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

// 成员套件通信工具面（自 `lib/tools/core.js` **原样搬移**）：swarm_report / swarm_cc。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT } from './shared.js';
import * as EVT from '../state/event-types.js';
import { REPORT_CHANNEL } from '../engine/dispatch.js';
import { autoSettleLane, AUTO_SETTLE_TRIGGERS, AUTO_SETTLE_ON_FAIL, settleIdOf } from '../engine/auto-settle.js';
import { autoSettleEnabledOf, autoSettleSwitchOf } from '../schema.js';
import { readLiveConfig } from './tier-gate.js';
import { reportTargetOf, deliverSwarmMessage, appendSwarmEventOf, budgetSummaryForReport, WAKE_TYPES, wakeLeaderForReport, UNBOUND_BATCH_KEY } from './swarm-comms.js';

export function buildSwarmTools(cx) {
  const { ctx, deps, store, root } = cx;
  return [
    defineTool({
      name: "swarm_report",
      description: '成员 → Leader 回报（集群内部同步走本套件，不用通用通信）。身份 best-effort 解析，未绑定不拒：消息照发，解析到批次才落事件，回显 unbound/eventWritten/notice。参数最小化：类型 + 摘要 + 产物路径，不复制正文；留痕双写 swarm.report + Leader 通道。type=settle-request 兼触发自动结算（全绿 merged，否则 onFail 缺省 pause 停轮，不影响本次投递）；completed 只唤醒 Leader 不结算；progress 只留痕。',
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"type":{"type":"string","required":true,"enum":["progress","blocked","settle-request","completed"]},"summary":{"type":"string","required":true,"description":"一句话摘要（元数据，勿贴正文）"},"artifactPath":{"type":"string","description":"产物相对路径（可选）"},"batchId":{"type":"string","description":"可选：目标批次（仅在无 member.dispatch 绑定时自报归属；给得出则事件面也能落）"},"lane":{"type":"string","description":"可选：目标 lane（同上；缺省占位 (unbound)）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"type":{"type":"string","required":true},"delivered":{"type":"boolean","required":true},"unbound":{"type":"boolean"},"eventWritten":{"type":"boolean"},"notice":{"type":"string"},"wake":{"type":"object","additionalProperties":true},"settle":{"type":"object","additionalProperties":true},"omissions":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, v) => TEXT_OUTPUT('swarm.report → Leader（' + v.batchId + '/' + v.lane + '，' + v.type + '）'
          + (v.unbound ? ' [unbound: best-effort]' : '')
          + (v.wake ? '\n唤醒：woke=' + String(v.wake.woke === true) + '（reason=' + String(v.wake.reason ?? '') + '）' : '')
          + (v.settle ? '\n自动结算：' + String(v.settle.action ?? '') + (v.settle.reason ? '（' + v.settle.reason + '）' : '') : '')
          + ((v.omissions ?? []).length ? '\n省略：' + (v.omissions ?? []).map((o) => o.surface + ' ' + o.omittedBytes + 'B').join(', ') : '')),
      },
      async execute(args, exec) {
        const tgt = reportTargetOf(store, exec, args, ctx?.logger);
        const summaryBud = budgetSummaryForReport(readLiveConfig(deps), args.summary);
        const injectCfg = summaryBud.injectBudget;
        const budgetedArgs = summaryBud.summary === args.summary ? args : { ...args, summary: summaryBud.summary };
        const delivered = deliverSwarmMessage(root, tgt, REPORT_CHANNEL.leader, budgetedArgs, args.type);
        const eventWritten = appendSwarmEventOf(store, tgt, EVT.EVT_SWARM_REPORT, args.type);
        const settleRequested = args.type === 'settle-request' && !!tgt.batchId;
        const live = readLiveConfig(deps);
        const autoSettleEnabled = autoSettleEnabledOf(autoSettleSwitchOf(live));
        const settle = (settleRequested && autoSettleEnabled)
          ? await autoSettleLane({ ctx, store, root, liveConfig: live }, {
            sessionId: tgt.sessionId, batchId: tgt.batchId, lane: tgt.lane,
            workerSessionId: tgt.caller, trigger: AUTO_SETTLE_TRIGGERS.settleRequest,
            onFail: AUTO_SETTLE_ON_FAIL.report,
          })
          : null;
        if (settleRequested && !autoSettleEnabled) {
          try {
            store.appendEvent(tgt.sessionId, tgt.batchId, EVT.EVT_AUTO_SETTLE_SKIPPED, {
              lane: tgt.lane, reason: 'auto-settle-disabled',
              trigger: AUTO_SETTLE_TRIGGERS.settleRequest, settleId: settleIdOf(tgt.caller),
            });
          } catch {  }
        }
        if (settle && settle.ok === false && typeof settle.code === 'string' && settle.code.startsWith('GATE_')) {
          throw new Error(settle.code + ': ' + settle.reason
            + '【打回：批未停轮】被拒产物 = ' + (args.artifactPath ?? '(未声明 artifactPath)')
            + '；修正后请【重新】handoff_submit（如交接断言需同步）并再次 swarm_report(type=\'settle-request\')。'
            + '若确认产物无需修改，请携 reason 原文回报 Leader 裁决。');
        }
        const wake = WAKE_TYPES.has(args.type)
          ? wakeLeaderForReport(ctx, {
            callerSessionId: tgt.caller, leaderSessionId: tgt.wakeSessionId ?? tgt.sessionId,
            batchId: tgt.batchId, lane: tgt.lane, type: args.type,
            summary: budgetedArgs.summary, artifactPath: args.artifactPath ?? null,
            injectBudget: injectCfg,
          })
          : { attempted: false, woke: false, reason: 'type-not-in-wake-set', merged: 0 };
        const omissions = [...summaryBud.omissions, ...(Array.isArray(wake?.omissions) ? wake.omissions : [])];
        //   载荷 = `{surface, omittedBytes, keptBytes}`；**`type` 键承载事件名，载荷不得占用**。
        for (const o of (tgt.batchId && tgt.sessionId ? omissions : [])) {
          try {
            store.appendEvent(tgt.sessionId, tgt.batchId, EVT.EVT_INJECT_OMITTED, {
              surface: o.surface, omittedBytes: o.omittedBytes, keptBytes: o.keptBytes,
            });
          } catch {  }
        }
        return {
          batchId: tgt.batchId ?? UNBOUND_BATCH_KEY, lane: tgt.lane, type: args.type, delivered,
          unbound: !tgt.bound, eventWritten,
          ...(!tgt.bound ? {
            notice: '本会话无 `member.dispatch` 绑定（官方 Team 成员为常态，Q-G2 已删身份门）⇒ best-effort：消息'
              + (delivered ? '已投递' : '未投递（无可用会话）') + '，批次事件' + (eventWritten ? '已落' : '未落（未给出可解析的 batchId；如需事件面请带 batchId 重发）'),
          } : {}),
          wake,
          omissions,
          ...(settle ? { settle: { action: settle.action, ok: settle.ok, reason: settle.reason, status: settle.status } } : {}),
        };
      },
    }),
    defineTool({
      name: "swarm_cc",
      description: '成员 → 批 owner 抄送（异常 / 待裁决 / 长跑候选）。身份 best-effort 解析，未绑定不拒：消息照发，解析到批次才落事件，回显 unbound/eventWritten/notice。参数最小化，不复制正文；留痕双写 swarm.cc + owner 收件箱。',
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"type":{"type":"string","required":true,"enum":["anomaly","decision-request","longrun-candidate"]},"summary":{"type":"string","required":true,"description":"一句话摘要（元数据，勿贴正文）"},"artifactPath":{"type":"string","description":"产物相对路径（可选）"},"batchId":{"type":"string","description":"可选：目标批次（仅在无 member.dispatch 绑定时自报归属）"},"lane":{"type":"string","description":"可选：目标 lane（同上；缺省占位 (unbound)）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"type":{"type":"string","required":true},"delivered":{"type":"boolean","required":true},"unbound":{"type":"boolean"},"eventWritten":{"type":"boolean"},"notice":{"type":"string"}}},
        render: (_args, v) => TEXT_OUTPUT('swarm.cc → owner（' + v.batchId + '/' + v.lane + '，' + v.type + '）' + (v.unbound ? ' [unbound: best-effort]' : '')),
      },
      async execute(args, exec) {
        const tgt = reportTargetOf(store, exec, args, ctx?.logger);
        const delivered = deliverSwarmMessage(root, tgt, REPORT_CHANNEL.owner, args, args.type);
        const eventWritten = appendSwarmEventOf(store, tgt, EVT.EVT_SWARM_CC, args.type);
        return {
          batchId: tgt.batchId ?? UNBOUND_BATCH_KEY, lane: tgt.lane, type: args.type, delivered,
          unbound: !tgt.bound, eventWritten,
          ...(!tgt.bound ? {
            notice: '本会话无 `member.dispatch` 绑定（官方 Team 成员为常态，Q-G2 已删身份门）⇒ best-effort：消息'
              + (delivered ? '已投递' : '未投递（无可用会话）') + '，批次事件' + (eventWritten ? '已落' : '未落（未给出可解析的 batchId；如需事件面请带 batchId 重发）'),
          } : {}),
        };
      },
    }),
  ];
}