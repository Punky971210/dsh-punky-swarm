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
//   2026-10-09 批 `auto-settle-disable-switch-20261009`：本路增 `settleIdOf`（**既有导出**，非新增）
//   仅为停用跳过留痕带回幂等键第三元（`(lane, settleId)` 可核；不引入新口径）。
import { autoSettleLane, AUTO_SETTLE_TRIGGERS, AUTO_SETTLE_ON_FAIL, settleIdOf } from '../engine/auto-settle.js';
// 开关**判定式单点**（A1-P2-07）：`lib/schema.js#autoSettleEnabledOf` —— 本文件不再内联 `!== false`，
//   只负责**读源**（`readLiveConfig(deps)` 热更快照）；判定语义（只有显式 `false` 才停用）只在单点内。
// 取面亦单点（A2-G12）：`enabled` 原始值经 `lib/schema.js#autoSettleSwitchOf` 投影，本文件不再内联取面表达式
import { autoSettleEnabledOf, autoSettleSwitchOf } from '../schema.js';
import { readLiveConfig } from './tier-gate.js';
import { reportTargetOf, deliverSwarmMessage, appendSwarmEventOf, budgetSummaryForReport, WAKE_TYPES, wakeLeaderForReport, UNBOUND_BATCH_KEY } from './swarm-comms.js';

export function buildSwarmTools(cx) {
  const { ctx, deps, store, root } = cx;
  return [
    defineTool({
      name: "swarm_report",
      description: '成员 → **Leader** 回报（成员侧套件通信入口；2026-09-16 裁决：集群内部同步事件走套件工具，不再散落用通用通信工具）。**身份 best-effort 解析**（`member.dispatch.workerSessionId` → `{batchId, lane}`）。【gate-lite Q-G2 · 2026-09-17 用户裁决「删除这一项」】**身份未绑定不再拒**（官方 Team 成员天然无 lane 绑定 = 常态）：消息照发、事件照留痕（解析到批次才落事件），回显 `unbound` / `eventWritten` / `notice`。参数最小化：类型 + 摘要 + 产物路径，**不复制正文**。留痕双写：批事件 `swarm.report` + Leader 通道（broadcast，与 0f 口径一致）。**`type=settle-request` 兼底触发自动结算**（P3a 规格 §2）：回报落盘后调引擎自动结算判定器（与主路 `subagent/end` **同一单点判定**，见 `lib/engine/auto-settle.js`）——全绿自动 `merged`，任一判据不满足按 `onFail` 缺省 `pause` 停轮；判定失败**不影响**本次回报的投递事实（返回 `settle` 明细供调用方核）。【D-5 甲 · 用户 2026-10-09 裁定】`type=completed` = **完成类**回报：**只唤醒 Leader、不触发结算**（与 `settle-request` 的结算语义解耦，不受 `autoSettle.enabled` 连带）；`progress` 保持「留痕不打扰」。',
      parameters: {"type":{"type":"string","required":true,"enum":["progress","blocked","settle-request","completed"]},"summary":{"type":"string","required":true,"description":"一句话摘要（元数据，勿贴正文）"},"artifactPath":{"type":"string","description":"产物相对路径（可选）"},"batchId":{"type":"string","description":"可选：目标批次（**仅在无 `member.dispatch` 绑定时**用于自报归属——官方 Team 成员场景；给得出批次则事件面也能落）"},"lane":{"type":"string","description":"可选：目标 lane（同上，仅在无绑定时使用；缺省占位 `(unbound)`）"}},
      output: {
        // `wake` 为新增键 ⇒ **必须**同步声明（`additionalProperties:false`！）否则宿主判 `invalid output` **假失败**，
        //   且被 `test/tool-schema-conformance.test.js` 的 TSC-1 判违规（同类真实先例：`handoff_submit` 的 `code:null`）。
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"type":{"type":"string","required":true},"delivered":{"type":"boolean","required":true},"unbound":{"type":"boolean"},"eventWritten":{"type":"boolean"},"notice":{"type":"string"},"wake":{"type":"object","additionalProperties":true},"settle":{"type":"object","additionalProperties":true},"omissions":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, v) => TEXT_OUTPUT('swarm.report → Leader（' + v.batchId + '/' + v.lane + '，' + v.type + '）'
          + (v.unbound ? ' [unbound: best-effort]' : '')
          // 【批 `lane-wake-addressing-fix-20261009`】**U-09 同批修（纯可见性）**：唤醒结果此前只进返回值、
          //   不进渲染面 ⇒ 模型可见面上 `woke` 出现 0 次，worker 无法判断 Leader 是否真被唤醒（静默）。
          //   本行**只读**既有返回键 `wake`（该键已在 `output.schema` 与返回对象内）⇒ 返回键集零变更
          //   （约束 C-4：`additionalProperties:false` 下不得新增键）。
          + (v.wake ? '\n唤醒：woke=' + String(v.wake.woke === true) + '（reason=' + String(v.wake.reason ?? '') + '）' : '')
          + (v.settle ? '\n自动结算：' + String(v.settle.action ?? '') + (v.settle.reason ? '（' + v.settle.reason + '）' : '') : '')
          // 注入面省略事实（本工具的 `omissions` 键已同步声明于 output.schema）——注入文本自带标记，
          //   此处再落一行汇总，使「哪个面省略了多少」不必反解标记即可读。
          + ((v.omissions ?? []).length ? '\n省略：' + (v.omissions ?? []).map((o) => o.surface + ' ' + o.omittedBytes + 'B').join(', ') : '')),
      },
      async execute(args, exec) {
        const tgt = reportTargetOf(store, exec, args);
        // 面 C · 层①单条目（`wake.summary`）：摘要**在投递前**按单条目层收窄，且收窄结果**同源**用于
        //   ① mailbox 消息体（下方 `deliverSwarmMessage`）② 唤醒消息体（`wakeLeaderForReport` 的 `summary`）
        //   ⇒ 两处共用同一份收窄文本，禁两套口径。未超限 ⇒ 摘要原值、omissions 空（零回归）。
        const summaryBud = budgetSummaryForReport(readLiveConfig(deps), args.summary);
        const injectCfg = summaryBud.injectBudget;
        const budgetedArgs = summaryBud.summary === args.summary ? args : { ...args, summary: summaryBud.summary };
        const delivered = deliverSwarmMessage(root, tgt, REPORT_CHANNEL.leader, budgetedArgs, args.type);
        const eventWritten = appendSwarmEventOf(store, tgt, EVT.EVT_SWARM_REPORT, args.type);
        // P3a 兼底路（规格 §2）：`settle-request` = 显式交付意图 ⇒ 触发**同一**自动结算判定器。
        //   定位说明：主路 = 宿主 `subagent/end`（`lib/index.js` 装配期 `{global:true}` 订阅），
        //   本路不依赖宿主事件面（worker 自觉回报），是规格裁定的**第二路**（兼底）。
        //   失败隔离：`autoSettleLane` **不抛错**（异常隔离为 `{ok:false}`）⇒ 回报的投递事实不被拖累；
        //   停轮/门拒只落批次事件（`auto.settle.*` + `batch.phase`），工具返回值如实回显 `settle` 明细。
        //   Q-G2 连带：无批次可解析（未绑定且未自报 batchId）时**不结算**（无批可结算），仍不拒。
        //
        // ── R-2 ②【2026-10-09 批 `auto-settle-disable-switch-20261009`】停用开关：**只回报、不结算** ──
        //   语义来源 = 用户裁决 E-1=甲「成员只能使用 `swarm_report` **回报**」⇒ **回报面全留、结算面全停**：
        //   上面的 `deliverSwarmMessage`（Leader broadcast）+ `appendSwarmEventOf`（批事件 `swarm.report`）
        //   **一字不少**（位置与顺序均不变），仅把本段 `autoSettleLane` 的调用短路掉。
        //   判定式**单点** = `lib/schema.js#autoSettleEnabledOf`（A1-P2-07；本文件原先的内联同形镜像已删）：
        //   只有**显式** `false` 才停用；缺省/非布尔 ⇒ 启用。判定式不再在本文件成第二套口径。
        //   读端 = `readLiveConfig(deps)`（热更快照；与 `lib/tools/wave-plan-tools.js:69` 的
        //   `handoffGateEnabledOf(readLiveConfig(deps), 'entry')` 同一读法）⇒ runtime.json 改写即生效。
        // 【D-5 甲 · 用户 2026-10-09 裁定】**唤醒与结算解耦**：本判定式**只认** `settle-request`——
        //   新增的完成类 `type='completed'` **不**进入本分支（只唤醒、不结算），故本行**逐字不变**即已满足裁定；
        //   连带效果：`autoSettle.enabled=false` 只停结算面，`completed` 的唤醒面不受牵连（`WAKE_TYPES` 与开关无关）。
        const settleRequested = args.type === 'settle-request' && !!tgt.batchId;
        const autoSettleEnabled = autoSettleEnabledOf(autoSettleSwitchOf(readLiveConfig(deps)));
        const settle = (settleRequested && autoSettleEnabled)
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
        // ── R-3 非静默（判据源 §3）：兼底路被开关跳过 ⇒ 落既有 `auto.settle.skipped` ──────────────
        //   复用既有事件常量（**不新增事件类型 / 不新增 `GATE_*` 码**）；`reason` 取自证值
        //   `auto-settle-disabled`（约束 8：禁写笼统 `skipped`）、`trigger` 自证为兼底路。
        //   该留痕**不进幂等链**——接收单点 = `lib/engine/auto-settle.js#isAutoSettleDisabledSkip`
        //   （已并入 `isTransientSkip`）⇒ 停用期每次触发各留一次痕；且开关重新启用后，同
        //   `(lane, settleId)` 的首个真实触发**不会**被这些留痕判成 `already-settled`（不被毒化）。
        //   留痕失败不抛：消息与 `swarm.report` 事件的投递事实已先行落定，不因留痕面拖累（观察者纪律）。
        if (settleRequested && !autoSettleEnabled) {
          try {
            store.appendEvent(tgt.sessionId, tgt.batchId, EVT.EVT_AUTO_SETTLE_SKIPPED, {
              lane: tgt.lane, reason: 'auto-settle-disabled',
              trigger: AUTO_SETTLE_TRIGGERS.settleRequest, settleId: settleIdOf(tgt.caller),
            });
          } catch { /* 留痕失败不拖累回报（消息 + swarm.report 事件已落） */ }
        }
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
        //   ── 【批 `lane-wake-addressing-fix-20261009` · U-08 修复】**唤醒寻址与治理落点分流** ──────────
        //   ▸ **标废（原口径，保留以存因果，勿据以拒改）**：「Leader 会话来源**逐字复用** `tgt.sessionId`」——
        //     其隐含前提「批 owner 会话 = 宿主 agent 会话」（`lib/index.js:605-606` 同款）在**命名黑板批**
        //     上不成立：那里 `tgt.sessionId` 是**黑板名**，取不到 live 句柄 ⇒ `leader-not-live` 静默。
        //   ▸ **现行口径**：唤醒目标取 `tgt.wakeSessionId`（= agent 亲缘，由 `reportTargetOf`
        //     **单点解析**）；治理落点三处（`:49` / `:50` / `:74`）**仍逐字** `tgt.sessionId`，一字未动。
        //   ▸ 回退安全：未绑定分支**不产生** `wakeSessionId` ⇒ `?? tgt.sessionId` 取回其既有值
        //     （父会话 / 退化为 caller 后由 `self` 闸拦下）⇒ 未绑定行为零变更。
        //   ▸ **禁另写一套映射**（规格 §2.3 / 约束 C-2）：本文件**不得**自行读 `exec.agent.session.header`。
        const wake = WAKE_TYPES.has(args.type)
          ? wakeLeaderForReport(ctx, {
            callerSessionId: tgt.caller, leaderSessionId: tgt.wakeSessionId ?? tgt.sessionId,
            batchId: tgt.batchId, lane: tgt.lane, type: args.type,
            summary: budgetedArgs.summary, artifactPath: args.artifactPath ?? null,
            // 面 C · 层②总量（`wake.total`）所需阈值：由本处单点从唯一取值源读出后传入
            //   （`leaderWakeMessageOf` 只消费、不读配置；两路唤醒共用同一判定，禁第二套口径）。
            injectBudget: injectCfg,
          })
          : { attempted: false, woke: false, reason: 'type-not-in-wake-set', merged: 0 };
        // 面 C 省略事实汇总：层①（摘要，本处）+ 层②（唤醒消息体，由唤醒单点回传）。
        const omissions = [...summaryBud.omissions, ...(Array.isArray(wake?.omissions) ? wake.omissions : [])];
        // ── 省略事实的**唯一事件发射点**（本批唯一）────────────────────────────────────────────
        //   位置：在「消息已投递 + `swarm.report` 已落 + 唤醒已尝试」之后 ⇒ 留痕失败**不拖累**
        //   回报的投递事实（同 `auto.settle.skipped` 的观察者纪律）；无批次可解析 ⇒ 无事件面，
        //   与 `appendSwarmEventOf` 同判据（不静默：`omissions` 仍在返回值与渲染面回显）。
        //   载荷 = `{surface, omittedBytes, keptBytes}`；**`type` 键承载事件名，载荷不得占用**。
        //   注：本事件与既有「步数预算」「链环防护」两个预算族**语义正交**（后二者的常量名在
        //   `lib/state/event-types.js` 内**逐字未改**，本批零触碰）；前缀刻意不用 `budget.`（面板
        //   `/^budget\./` 分类器会误标为「超预算」）。
        for (const o of (tgt.batchId && tgt.sessionId ? omissions : [])) {
          try {
            store.appendEvent(tgt.sessionId, tgt.batchId, EVT.EVT_INJECT_OMITTED, {
              surface: o.surface, omittedBytes: o.omittedBytes, keptBytes: o.keptBytes,
            });
          } catch { /* 留痕失败不拖累回报（消息 + swarm.report 事件已落） */ }
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