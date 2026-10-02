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
// P3a 自动结算（规格 §2/§3）：**单点判定**（`lib/engine/auto-settle.js`）——本文件只用其兼底路入口
//   （`swarm_report(type='settle-request')` 显式交付意图）；主路 `subagent/end` 的装配期订阅在 `lib/index.js`，
//   两路共用同一判定函数（禁第二套口径）。
import { autoSettleLane, AUTO_SETTLE_TRIGGERS, AUTO_SETTLE_ON_FAIL } from '../engine/auto-settle.js';
import { readLiveConfig } from './tier-gate.js';
import { reportTargetOf, deliverSwarmMessage, appendSwarmEventOf, WAKE_TYPES, wakeLeaderForReport, UNBOUND_BATCH_KEY } from './swarm-comms.js';

export function buildSwarmTools(cx) {
  const { ctx, deps, store, root } = cx;
  return [
    defineTool({
      name: "swarm_report",
      description: '成员 → **Leader** 回报（成员侧套件通信入口；2026-09-16 裁决：集群内部同步事件走套件工具，不再散落用通用通信工具）。**身份 best-effort 解析**（`member.dispatch.workerSessionId` → `{batchId, lane}`）。【gate-lite Q-G2 · 2026-09-17 用户裁决「删除这一项」】**身份未绑定不再拒**（官方 Team 成员天然无 lane 绑定 = 常态）：消息照发、事件照留痕（解析到批次才落事件），回显 `unbound` / `eventWritten` / `notice`。参数最小化：类型 + 摘要 + 产物路径，**不复制正文**。留痕双写：批事件 `swarm.report` + Leader 通道（broadcast，与 0f 口径一致）。**`type=settle-request` 兼底触发自动结算**（P3a 规格 §2）：回报落盘后调引擎自动结算判定器（与主路 `subagent/end` **同一单点判定**，见 `lib/engine/auto-settle.js`）——全绿自动 `merged`，任一判据不满足按 `onFail` 缺省 `pause` 停轮；判定失败**不影响**本次回报的投递事实（返回 `settle` 明细供调用方核）。',
      parameters: {"type":{"type":"string","required":true,"enum":["progress","blocked","settle-request"]},"summary":{"type":"string","required":true,"description":"一句话摘要（元数据，勿贴正文）"},"artifactPath":{"type":"string","description":"产物相对路径（可选）"},"batchId":{"type":"string","description":"可选：目标批次（**仅在无 `member.dispatch` 绑定时**用于自报归属——官方 Team 成员场景；给得出批次则事件面也能落）"},"lane":{"type":"string","description":"可选：目标 lane（同上，仅在无绑定时使用；缺省占位 `(unbound)`）"}},
      output: {
        // `wake` 为新增键 ⇒ **必须**同步声明（`additionalProperties:false`！）否则宿主判 `invalid output` **假失败**，
        //   且被 `test/tool-schema-conformance.test.js` 的 TSC-1 判违规（同类真实先例：`handoff_submit` 的 `code:null`）。
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"type":{"type":"string","required":true},"delivered":{"type":"boolean","required":true},"unbound":{"type":"boolean"},"eventWritten":{"type":"boolean"},"notice":{"type":"string"},"wake":{"type":"object","additionalProperties":true},"settle":{"type":"object","additionalProperties":true}}},
        render: (_args, v) => TEXT_OUTPUT('swarm.report → Leader（' + v.batchId + '/' + v.lane + '，' + v.type + '）'
          + (v.unbound ? ' [unbound: best-effort]' : '')
          + (v.settle ? '\n自动结算：' + String(v.settle.action ?? '') + (v.settle.reason ? '（' + v.settle.reason + '）' : '') : '')),
      },
      async execute(args, exec) {
        const tgt = reportTargetOf(store, exec, args);
        const delivered = deliverSwarmMessage(root, tgt, REPORT_CHANNEL.leader, args, args.type);
        const eventWritten = appendSwarmEventOf(store, tgt, EVT.EVT_SWARM_REPORT, args.type);
        // P3a 兼底路（规格 §2）：`settle-request` = 显式交付意图 ⇒ 触发**同一**自动结算判定器。
        //   定位说明：主路 = 宿主 `subagent/end`（`lib/index.js` 装配期 `{global:true}` 订阅），
        //   本路不依赖宿主事件面（worker 自觉回报），是规格裁定的**第二路**（兼底）。
        //   失败隔离：`autoSettleLane` **不抛错**（异常隔离为 `{ok:false}`）⇒ 回报的投递事实不被拖累；
        //   停轮/门拒只落批次事件（`auto.settle.*` + `batch.phase`），工具返回值如实回显 `settle` 明细。
        //   Q-G2 连带：无批次可解析（未绑定且未自报 batchId）时**不结算**（无批可结算），仍不拒。
        const settle = (args.type === 'settle-request' && tgt.batchId)
          ? await autoSettleLane({ ctx, store, root, liveConfig: readLiveConfig(deps) }, {
            sessionId: tgt.sessionId, batchId: tgt.batchId, lane: tgt.lane,
            workerSessionId: tgt.caller, trigger: AUTO_SETTLE_TRIGGERS.settleRequest,
            // 【2026-09-26 用户裁决：门禁拒派要"打回成员"而非"停轮"】
            //   `report` ⇒ 判定失败时**不落 `auto.settle.paused`、不改 `batch.phase`**，
            //   把 gate 拒因原样回传 ⇒ 下方立即 `throw` ⇒ **本次工具调用失败** ⇒
            //   成员收到拒因全文，**自行修改产物后重试**（批保持 `running`，无需 Leader 介入）。
            //   缺省 `pause` 路径（宿主 `subagent/end` 主路）逐字不变。
            onFail: AUTO_SETTLE_ON_FAIL.report,
          })
          : null;
        // 打回（2026-09-26 用户裁决）：**gate 类形态错误**（`GATE_*`）⇒ 工具调用失败，让成员改。
        //   ▸ 投递与留痕**已先行完成**（`deliverSwarmMessage` + `appendSwarmEventOf` + `auto.settle.skipped`
        //     带 `gate-rejected-to-member:` 前缀）⇒ 「消息已投递 + 事件已落」这一既有事实**不被抹掉**，
        //     只有【gate 结论】从「返回值」升级为「工具调用失败」。
        //   ▸ 非 `GATE_*`（如 `error` / `no-lane-binding`）**不打回**，保持既有返回语义。
        if (settle && settle.ok === false && typeof settle.code === 'string' && settle.code.startsWith('GATE_')) {
          throw new Error(settle.code + ': ' + settle.reason
            + '【打回：批未停轮】被拒产物 = ' + (args.artifactPath ?? '(未声明 artifactPath)')
            + '；修正后请【重新】handoff_submit（如交接断言需同步）并再次 swarm_report(type=\'settle-request\')。'
            + '若确认产物无需修改，请携 reason 原文回报 Leader 裁决。');
        }
        // 唤醒 Leader（规格 §2.5）：位置在 `appendSwarmEventOf`（**留痕先于唤醒**）之后 ⇒
        //   唤醒失败/被节流都**不损**「消息已投递 + 事件已落」这一既有事实；返回值只并入 `wake` 键。
        //   Leader 会话来源**逐字复用** `tgt.sessionId`（有 dispatch 绑定 = 批 owner 会话；无绑定 =
        //   宿主父会话；两者缺一即退化为 caller 自身 ⇒ 被 `self` 闸拦下）——**禁另写一套映射**（规格 §2.3）。
        const wake = WAKE_TYPES.has(args.type)
          ? wakeLeaderForReport(ctx, {
            callerSessionId: tgt.caller, leaderSessionId: tgt.sessionId,
            batchId: tgt.batchId, lane: tgt.lane, type: args.type,
            summary: args.summary, artifactPath: args.artifactPath ?? null,
          })
          : { attempted: false, woke: false, reason: 'type-not-in-wake-set', merged: 0 };
        return {
          batchId: tgt.batchId ?? UNBOUND_BATCH_KEY, lane: tgt.lane, type: args.type, delivered,
          unbound: !tgt.bound, eventWritten,
          ...(!tgt.bound ? {
            notice: '本会话无 `member.dispatch` 绑定（官方 Team 成员为常态，Q-G2 已删身份门）⇒ best-effort：消息'
              + (delivered ? '已投递' : '未投递（无可用会话）') + '，批次事件' + (eventWritten ? '已落' : '未落（未给出可解析的 batchId；如需事件面请带 batchId 重发）'),
          } : {}),
          wake,
          ...(settle ? { settle: { action: settle.action, ok: settle.ok, reason: settle.reason, status: settle.status } } : {}),
        };
      },
    }),
    defineTool({
      name: "swarm_cc",
      description: '成员 → **Manager** 抄送（异常 / 待裁决 / 长跑候选；成员侧套件通信入口）。**身份 best-effort 解析**。【gate-lite Q-G2 · 2026-09-17 用户裁决「删除这一项」】**身份未绑定不再拒**：消息照发、事件照留痕（解析到批次才落事件），回显 `unbound` / `eventWritten` / `notice`。留痕双写：批事件 `swarm.cc` + Manager 通道（supervisor/inbox，与既有 Manager 通道口径一致）。参数最小化，不复制正文。',
      parameters: {"type":{"type":"string","required":true,"enum":["anomaly","decision-request","longrun-candidate"]},"summary":{"type":"string","required":true,"description":"一句话摘要（元数据，勿贴正文）"},"artifactPath":{"type":"string","description":"产物相对路径（可选）"},"batchId":{"type":"string","description":"可选：目标批次（**仅在无 `member.dispatch` 绑定时**用于自报归属——官方 Team 成员场景）"},"lane":{"type":"string","description":"可选：目标 lane（同上，仅在无绑定时使用；缺省占位 `(unbound)`）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"type":{"type":"string","required":true},"delivered":{"type":"boolean","required":true},"unbound":{"type":"boolean"},"eventWritten":{"type":"boolean"},"notice":{"type":"string"}}},
        render: (_args, v) => TEXT_OUTPUT('swarm.cc → Manager（' + v.batchId + '/' + v.lane + '，' + v.type + '）' + (v.unbound ? ' [unbound: best-effort]' : '')),
      },
      async execute(args, exec) {
        const tgt = reportTargetOf(store, exec, args);
        const delivered = deliverSwarmMessage(root, tgt, REPORT_CHANNEL.manager, args, args.type);
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