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
// 拆分自 lib/tools.js（core 域原样搬移，行为不变）
// 导出：createCoreTools(ctx, deps) => Array<defineTool>；installDifficultyGuard(ctx, deps)（难度门禁注册，原样搬移一字不改）
// 共享辅助（下沉至零依赖 shared.js）：TEXT_OUTPUT / sessionOf——本文件 re-export 保持对外导出兼容
//   （mailbox-tools/log-tools/lane-tools 已直引 shared.js；watch/lane-heartbeat 不再依赖 core.js）
// 【2026-10-02 · 内务批 波 1】`createCoreTools` 巨型函数（939 行 / 20 个 defineTool）已按功能面拆分：
//   工具实现落 `lib/tools/*.js`（各导出 `buildXxxTools(cx)`）；共享辅助抽为三个单点文件
//   （`tier-gate.js` / `host-surface.js` / `swarm-comms.js`）。本文件 = **组合器 + 对外导出面 + 相位两件**：
//   外部导出符号集合与拆分前**逐字相同**（下方 re-export），调用方/测试零感知。

// 【2026-09-27 · team-asset 全量退役】原读端 import 组**整体删除**（本文件对资产面 A-5/A-6 归零）：
//   ① `../assembly/flows.js`：`resolveTeamRoles` / `unionRoleVocabulary` / `resolveTeamFlows` / `flowOf` / `packageRoot`
//      —— flows / roles 面只走**引擎基线**，本文件不再解析任何团队声明；
//   ② `../assembly/team-asset.js`：装载器 + 码族 + 严重级 + 候选路径枚举；
//   ③ `../assembly/chain.js`：链静态校验探针 + 两个链回显投影函数
//      —— `chain` 声明面不存在 ⇒ 建批期无链可查、回显面按 D-4 删净（A-7 判据：本文件对 `chain.js` 的 import 归零）；
//      该文件本体亦已随批 3 步骤③删除（wave 4 `exec-delete-assets`）。

// 成员会话判定 + 只升不降档位（批次 `governance-member-isolation-20260915` · lane e2，规格 §2 规则 6/7）：
//   本文件的两处消费点（guard 的「成员只读继承」与 assign_check 的「跨会话写只升不降」）都调它，
//   禁在本文件另写一套判定（否则工具面与 guard 面的「谁是成员」会分裂——两套口径正是本批要修的缺陷）。

// 【2026-09-27 · team-asset 全量退役】原 P2 推进链读端 import（`chainProblemsOf` / 链本体两个回显投影函数）
//   **整体删除**：建批期链静态校验探针随资产面删除；工具面的链回显字段按 D-4 一并删净。

// 【已清退 · 勿回加】`advanceChainAfterSettle`（`lib/engine/chain-runner.js`）的调用随 **G-02 死调用清退**
//   （批次 `engine-debt-cleanup-2-20260918`）一并删除：链推进已全退役（2026-09-18 Q-A=C）⇒ 该调用**零行为**，
//   结算后不再触发推进；推进缺口与 `chain.step` 冻结语义见 `lib/engine/chain-runner.js` 头注释。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertModeActive, clearPendingBatch } from './tier-gate.js';
// 悬挂成员告警**单点**（GAP-S3b 抽取；P3a control lane）：`batch_phase(aborted)` 与 `batch_control(abort)`
//   共用同一份实现（`lib/state/dangling.js`），禁第二份——判据与 `batch_status.danglingLanes` 同源。
import { warnAbortDangling, danglingLanesOf } from '../state/dangling.js';

import { buildWavePlanTools } from './wave-plan-tools.js';
import { buildBatchStatusTools, buildGateTools, buildRoleGuideTools } from './query-tools.js';
import { buildArtifactTools, buildAssetClaimTools } from './asset-tools.js';
import { buildAssignTools } from './assign-tools.js';
import { buildLaneTools, buildDispatchTools, buildMemberStatusTools } from './member-tools.js';
import { buildHandoffTools } from './handoff-tools.js';
import { buildSwarmTools } from './swarm-tools.js';
import { buildTaskTools } from './task-tools.js';

// ── 对外导出面（**逐字保持**）：原 `lib/tools/core.js` 的具名导出经下方 re-export 原样透出 ──────────
export { TEXT_OUTPUT, sessionOf } from './shared.js'; // re-export：既有消费方（lib/tools/core.js 的 import 者）不受影响
export { EXEC_TOOLS, assertMemberActionTierC, assertModeActive, lockPath, installDifficultyGuard } from './tier-gate.js';
export { hostSkillsRoot } from './host-surface.js';
export { WAKE_MIN_INTERVAL_MS, LEADER_WAKE_WINDOWS, wakeLeaderForReport } from './swarm-comms.js';

// ── 相位两件（`batch_phase` / `batch_control`）：**留在 core.js**，不迁出 ────────────────────
//   判据（源码锁，非偏好）：`test/phase-reason.test.js#PR-8` 硬编码文件面 = `lib/engine/auto-settle.js` +
//   `lib/tools/core.js`，要求 core.js「须至少一处 `setPhase(` 调用点」且两文件合计恰 3 处写点
//   （auto-settle 1 + `batch_phase` 1 + `batch_control` 1）；测试不得修改（方案 §6 不做清单）
//   ⇒ 该两件与组合器同文件，`createCoreTools` 仍为 ≤40 行组合器，行为零变更。
function buildPhaseTools(cx) {
  const { deps, store } = cx;
  return [
    defineTool({
      name: "batch_phase",
      description: "批次阶段迁移：planning->running->paused->aborted|complete（终态后拒绝再写）。complete 前置：audit 层验收齐备（Tier3 门禁）。可选 manager={agentId,note?}：**legacy 登记面**（写批次字段 manager + batch.manager.raised 事件，只登记不改阶段，可单独调用）——【gate-lite 第二批 · A】Manager 在册判定的**新真源 = 官方 roster**（`ctx.get('agentTeams')` → `listMembers`；经 wave_plan/batch_status 的 `managerRoster` 回显，声明 raise 而无 Manager 落 `gate.manager_roster_gap`）；本登记**不再按 phase/agentId 拒绝**（空 agentId ⇒ 不写记录、不抛错）。批次按会话隔离，缺省取当前执行会话。迁移事由随事件落盘（`reason`），暂停类迁移缺省自动回填 `manual:batch_phase:<phase>`，不静默。",
      parameters: {"batchId":{"type":"string","required":true},"phase":{"type":"string","enum":["running","paused","aborted","complete"]},"reason":{"type":"string","description":"相位迁移事由（写入 batch.phase 事件；缺省 manual:batch_phase:<phase>）"},"manager":{"type":"object","description":"Manager **legacy 登记**载荷：{agentId: 非空字符串, note?: 说明}；任意 phase 均可登记（含终态；幂等）；空/缺 agentId ⇒ 不写记录（返回 null，调用方按「既无 phase 又无 manager」如实报错）。**不构成在册判据**——在册以官方 roster 为准（managerRoster 回显）","additionalProperties":false,"properties":{"agentId":{"type":"string"},"note":{"type":"string"}}},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true},"manager":{"type":"object","additionalProperties":true},"danglingLanes":{"type":"array","items":{"type":"string"}}}},
        render: (_args, value) => TEXT_OUTPUT((value.manager ? ('batch ' + value.batchId + ' manager.raised -> ' + value.manager.agentId) : ('batch ' + value.batchId + ' phase -> ' + value.phase))
          + (value.danglingLanes?.length ? '; dangling lanes: ' + value.danglingLanes.length : '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '批次阶段迁移（batch_phase）'); // 模式门（E 阶段）：非生效模式零治理写入，先于参数/状态校验
        const sessionId = sessionOf(args, exec);
        // Manager legacy 登记（留痕入口）：可与阶段迁移同一次调用。
        // 顺序：**先登记、后迁移**——这样「同一次调用里从 running 迁走」也能正常登记。
        // 原「准入 = 批次非终态 + agentId 必填」
        //   两处硬判**已删**（`「Manager 终态」码(已删)` / `_PHASE_INVALID` / `_AGENT_ID_REQUIRED` 三码不存在）：
        //   · 任意 phase 均可登记事实（幂等；不改阶段、不改成员状态）；
        //   · 空/缺 `agentId` ⇒ `markManagerRaised` 返回 null ⇒ 走下方「既无 phase 又无 manager」显式报错
        //     （不写垃圾记录、不静默）。
        //   **在册判据不在此处**：以官方 roster 为准（读端 `managerRosterOf` / `managerViewOf`，见 wave_plan、
        //   batch_status）；本登记降级为 legacy 观察字段。
        const manager = args.manager ? store.markManagerRaised(sessionId, args.batchId, args.manager) : undefined;
        if (!args.phase) {
          if (!manager) throw new Error('batch_phase requires "phase" or "manager"');
          const cur = store.readBatch(sessionId, args.batchId);
          return { batchId: args.batchId, phase: cur ? cur.phase : 'unknown', manager };
        }
        const b = store.setPhase(sessionId, args.batchId, args.phase, { reason: args.reason ?? ('manual:batch_phase:' + args.phase) });
        if (b.phase === 'complete' || b.phase === 'aborted') clearPendingBatch(store, sessionId); // 兜底清理旧锁
        const out = { batchId: args.batchId, phase: b.phase };
        if (manager) out.manager = manager;
        // `aborted` 收口时若本批仍存在**非终态成员**（折中方案）：
        //   **额外落一条告警事件 + 工具返回回显**（提醒「这批留了悬挂」）。
        // P3a control lane **抽取**：本判定的实现已移入单点 `lib/state/dangling.js` 的 `warnAbortDangling`
        //   ——`batch_phase`（本处）与新增 `batch_control(abort)` **共用同一份**，禁第二份实现。
        //   该单点内部判据零新口径：lane 级判定 = `isDanglingLane`（`lib/watch/lane-heartbeat.js`，与
        //   `batch_status.danglingLanes` 同源），lane 名单 = `Object.keys(b.lanes)`（与 `derivedOf` 同源）。
        // 纪律（逐字不变）：**绝对不改任何成员状态**（不做隐式批量 `skipped`）：`batch.lanes` 在 abort 前后
        //   **逐字不变**，只多落一条事件（那些成员在终态批上永久无法回收 —— `member_settle` 拒
        //   `GATE_BATCH_TERMINAL` —— 正是本告警要显式化的既有事实）。
        // 相位面：仅 `aborted` 判定 ⇒ `running` / `paused` / `complete` 三相位**逐字零差异**（尤其 complete
        //   不得因此新增事件）；无悬挂成员（全终态）的批 ⇒ **不落事件、不写 `danglingLanes` 键**（反例锁）。
        const dg = warnAbortDangling(store, sessionId, args.batchId, b);
        if (dg) out.danglingLanes = dg.danglingLanes;
        return out;
      },
    }),
    defineTool({
      // P3a 最小干预面（规格 §5）：停轮批的**唯一恢复入口**（`resume`）+ 人工介入（`pause`）+ 收口（`abort`）。
      // 与 `batch_phase` 的关系（规格 §5「与既有相位机/batch_phase 语义不冲突」）：
      //   · **同一个相位机**（`BATCH_TRANSITIONS` / `store.setPhase`），本工具不自造码、不绕门禁；
      //   · `batch_phase` 本阶段**照常在册、行为逐字不变**（收内是 P3b 的事，故二者并存而非替换）；
      //   · 差异只在**调用面**：`batch_phase` 是原始相位写入口（受 `args.phase` 白名单，
      //     `running|paused|aborted|complete`），`batch_control` 是**人工干预动作面**——把
      //     「停轮后从哪恢复」显式化为 `action:'resume'`（规格 §6：恢复的唯一入口）。
      // 边界（硬性）：
      //   · **不得改任何成员状态**（`batch.lanes` 前后逐字不变；停轮/收口只动相位与留痕）；
      //   · 幂等：目标相位已达成 ⇒ no-op（**不重复写相位事件**）；终态批上的 abort ⇒ no-op
      //     （既有的 `batch.abort_dangling` 告警也不重复落）；
      //   · 非法迁移逐字沿用既有报错码 `invalid batch phase transition: <from> -> <to>`（不自造码）。
      name: "batch_control",
      description: "最小干预面（P3a 规格 §5）：对批次的**人工干预动作**——`pause`（running→paused，人工介入即停止自动推进）/ `resume`（paused→running，**停轮批的唯一恢复入口**，规格 §6 防竞态）/ `abort`（→aborted，收口；有悬挂成员时复用既有 `batch.abort_dangling` 告警 + `danglingLanes` 回显）。幂等：目标相位已达成 ⇒ no-op（不重复写相位事件）。**绝不改任何成员状态**（停轮/收口只动相位与留痕）；非法迁移走既有相位机报错码，不新增/自造码。既有 `batch_phase` 本阶段照常在册、行为不变（收内属 P3b）。批次按会话隔离，缺省取当前执行会话。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"action":{"type":"string","required":true,"enum":["pause","resume","abort"],"description":"干预动作：pause=停轮（人工介入即停止自动推进）/ resume=paused→running（唯一恢复入口）/ abort=收口（不可逆）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true},"action":{"type":"string","required":true},"noop":{"type":"boolean"},"danglingLanes":{"type":"array","items":{"type":"string"}}}},
        render: (_args, value) => TEXT_OUTPUT('batch ' + value.batchId + ' control ' + value.action + ' -> ' + value.phase
          + (value.noop ? ' (no-op: already ' + value.phase + ')' : '')
          + ((value.danglingLanes ?? []).length ? '; dangling lanes: ' + value.danglingLanes.length : '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '批次干预（batch_control）'); // 模式门（E 阶段）：非生效模式零治理写入，先于参数/状态校验
        const sessionId = sessionOf(args, exec);
        const action = args.action;
        if (!['pause', 'resume', 'abort'].includes(action)) {
          throw new Error('GATE_BATCH_CONTROL_ACTION_INVALID: batch_control action 只允许 pause|resume|abort（收到 ' + JSON.stringify(action ?? null) + '）');
        }
        // 相位取值**直读批次 JSON**（判据唯一事实源；不由调用方传 phase ⇒ 无第二个相位入口）。
        const cur = store.readBatch(sessionId, args.batchId);
        if (!cur) throw new Error('batch not found: ' + args.batchId);
        const idempotent = (phase) => {
          const out = { batchId: args.batchId, phase, action, noop: true };
          if (action === 'abort' && phase === 'aborted') { // 已终态的 abort：回显既有悬挂事实，**不重复落告警**
            const lanes = danglingLanesOf(store.readBatch(sessionId, args.batchId));
            if (lanes.length > 0) out.danglingLanes = lanes;
          }
          return out;
        };
        if (action === 'pause' && cur.phase === 'paused') return idempotent('paused');
        if (action === 'resume' && cur.phase === 'running') return idempotent('running');
        if (action === 'abort' && cur.phase === 'aborted') return idempotent('aborted');
        const target = action === 'pause' ? 'paused' : (action === 'resume' ? 'running' : 'aborted');
        // 迁移判定/落盘**全部**走既有 `store.setPhase`（内含 `BATCH_TRANSITIONS` 校验 + `batch.phase` 事件
        //   + complete 门禁）——本工具不复制任何迁移逻辑；非法迁移按既有码抛（逐字透传，不改写）。
        const b = store.setPhase(sessionId, args.batchId, target, { reason: 'manual:batch_control.' + action });
        if (b.phase === 'complete' || b.phase === 'aborted') clearPendingBatch(store, sessionId); // 兜底清理旧锁（同 batch_phase 口径）
        const out = { batchId: args.batchId, phase: b.phase, action };
        // abort 收口告警：**复用** `batch_phase(aborted)` 的同一实现（单点 `lib/state/dangling.js`）——
        //   仅 `aborted` 相位且存在悬挂成员时落事件 + 回显；`pause`/`resume` 相位面零差异。
        const dg = action === 'abort' ? warnAbortDangling(store, sessionId, args.batchId, b) : null;
        if (dg) out.danglingLanes = dg.danglingLanes;
        return out;
      },
    }),
  ];
}

  // P1 交接门工具面（`handoff_submit` / `handoff_view`）：**恒注册（常驻）**——「**工具是机制、门是策略**」：
  //   机制不随策略开关出现/消失（`task-22` 裁决 ②）。收益：门关闭的休眠期也能积累
  //   真实交接数据（翻牌时以证据决策），且下游取件面（`handoff_view`）始终可用。
  //   开关经**唯一解析点** `lib/wave-plan.js#handoffGateEnabledOf`（真源 = `<root>/config/runtime.json` 的
  //   `gates.handoff.*`；env 仅兜底）只控制 entry 门**拦不拦**，不再控制工具**有没有**。
  //   族位：`handoff_submit` = `comms`（成员面，**不落模式门**——交接是生产者的动作，引擎要第一手声明；
  //   形态对齐 `swarm_report`）；`handoff_view` = `read`（成员可用）。见 `lib/engine/suite.js`。
export function createCoreTools(ctx, deps) {
  const { store, root, config = {} } = deps;
  // 闭包上下文 `cx`：承载原闭包内共享变量（ctx/deps/store/root/config），**不提升为模块级单例**
  //   （纪律：不新增真源）；各功能面 builder 从同一 `cx` 取值，组合顺序 = 原工具数组顺序（行为零变更）。
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
    ...buildLaneTools(cx),
    ...buildHandoffTools(cx),
    ...buildDispatchTools(cx),
    ...buildSwarmTools(cx),
    ...buildMemberStatusTools(cx),
    ...buildTaskTools(cx),
  ];
}