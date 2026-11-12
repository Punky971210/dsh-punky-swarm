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

// 建批工具面（自 `lib/tools/core.js` **原样搬移**）：wave_plan。
//   PR-8 硬编码文件面 `lib/tools/core.js` 且要求「须至少一处 setPhase 调用点」，测试不得修改 ⇒ 该两件不迁出。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildWavePlan, validateWavePlan, normalizeAssemblyDecl, assemblyGate, normalizeChannelDecl, handoffGateEnabledOf, handoffGateStateOf, consumeDepsAsymmetryOf } from '../wave-plan.js';
import { resolveAssembly } from '../assembly.js';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertMemberActionTierC, readLiveConfig, clearPendingBatch } from './tier-gate.js';
import { assertNotSentinelSessionArg } from '../state/session-authority.js';
import { createRosterPort } from '../provider-dsh/roster.js';
import * as EVT from '../state/event-types.js';

const WARN_EVENT_OF = {
  GATE_COMPLETE_OUTCOMES_EMPTY: EVT.EVT_GATE_COMPLETE_OUTCOMES_EMPTY,
};

//     ⚠ 若将来再改该码名，仍须「源码改名 + build + 同步本集合」三步同做，否则会重现「发射绕过静默集」。
const WARN_SILENT_CODES = new Set(['WARN_ROSTER_UNKNOWN']);

export function buildWavePlanTools(cx) {
  const { ctx, deps, store, config } = cx;
  const { resolveBatchSession } = deps ?? {};
  return [
    defineTool({
      name: "wave_plan",      description: "把任务按 DAG 依赖分层为 waves 并持久化为批次（建批即固定，不重算）。任务可声明 layer(plan/exec/audit)/consume/produce/outputs/role/skills，建批时做三层契约静态校验。含 audit 层的三层批必填 assembly（字段表见该参数）。team 为纯归类标签（不解析、不校验、不拒建批）；skills 解析不到也不拒建批。批次绑定当前会话；产物根 = <~/.dsh/punky-preset>/sessions/<sessionId>/artifacts/<batchId>/，consume/produce/outputs 相对此根。运行期 DAG 真源 = lanes[].deps + handoffs。装配门只在工具面生效（直调 buildWavePlan 不走该门；该有意差异登记于 plan/techdebt-design.md §3）。失败必带 GATE_* 码。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true,"description":"批次 ID（kebab-case）"},"tasks":{"type":"array","required":true,"description":"任务列表 [{id, cmd, deps?, model?, tools?, layer?, role?, skills?, consume?, produce?, outputs?, context?, subtasks?}]。subtasks?（checkpoint 强制面）：与 checkpoints 同形（{id(必填唯一), target(必填非绝对路径), outputs?, acceptance?, rounds?, ctxBudget?, kb/skills/mcp/checklist?}），唯一区别是它的存在本身即开启该批的「新方言」——exec 层无 subtasks 的 lane 会被派发门拒派、未逐项留痕会被结算门拒 settle；只用于 exec 层。context（项目上下文，可选但强烈建议在大项目里填）= 该 lane 执行时必须知道的背景，会渲染进任务包 `## 项目上下文` 段供成员读：写「本域既有约定 / 已踩过的历史坑 / 当前进度与已完成面 / 边界禁令」四类事实，不要写任务目标（那是 cmd）、不要写开工动作清单（那是 preflight）。留空则该段不渲染（存量批零感知）。","items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","description":"并发声明（默认 5）：仅落盘 + 回显，不参与运行期准入"},"smoke":{"type":"boolean","description":"冒烟/探针批豁免（默认 false）：true ⇒ 跳过产物契约类门（建批 presence/orphan、运行期 consume·produce·targets·complete），行为安全门不减；落 batch.smoke 事件"},"team":{"type":"string","description":"可选自由标签（纯归类）：不解析、不校验、不拒建批；缺省 null"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"},"channel":{"type":"string","description":"通道归属（可选）：dispatch=引擎自派｜team=官方席位（每条 lane 须写 roster）｜mixed=并存（至少一条写 roster）。非法枚举 / 与 roster 矛盾拒 GATE_CHANNEL_INVALID / GATE_CHANNEL_UNRESOLVED"},"assembly":{"type":"object","additionalProperties":false,"description":"批次级装配声明：含 audit 层的三层批必填。{ auditLane: '<audit lane id>'（必填）；coordinatorLane?；roles? [string] }；缺失或 lane id 悬空拒 GATE_ROLE_ASSEMBLY_MISSING / GATE_ASSEMBLY_INVALID","properties":{"auditLane":{"type":"string","required":true,"description":"验收归属 lane id（须为 audit 层且存在于 tasks；层错配/悬空拒 GATE_ASSEMBLY_INVALID）"},"coordinatorLane":{"type":"string","description":"可选：协调/细拆 lane id（须为 plan 层且存在于 tasks）"},"roles":{"type":"array","items":{"type":"string"},"description":"可选：参与角色集（词法白名单；非法词条告警 GATE_ROLE_INVALID，批次照建）"}}}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"wavePlan":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","required":true},"lanes":{"type":"object","required":true,"additionalProperties":true},"warnings":{"type":"array","items":{"type":"object","additionalProperties":true}},"assembly":{"type":"object","additionalProperties":true},"smoke":{"type":"boolean"},"consumeDepsAsymmetry":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('wavePlan created: ' + value.batchId + ' @' + value.sessionId + ' (' + value.wavePlan.length + ' waves)' + (value.smoke ? '; SMOKE (产物契约类门已豁免)' : '') + (value.warnings?.length ? '; role warnings: ' + value.warnings.length : '')),
      },
      async execute(args, exec) {
        assertNotSentinelSessionArg(args, 'wave_plan');                          // D-03/RQ-5
        const sessionId = sessionOf(args, exec, resolveBatchSession);            // D-02/RQ-2
        //   注：wave_plan 做的是「在指定会话/命名黑板里**新建**批」，没有既有批可做属主比对
        //   （`governance.test.js:414` 锁定「Leader 向命名会话 deploy-x 建批」为合法正向路径），
        //   故本站点不落 `authorizeBatchWrite` —— 判据见台账 D-04 站点台账。
        assertMemberActionTierC(store, sessionId, exec, 'batch', {}, deps);
        const teamName = typeof args.team === 'string' && args.team.trim().length > 0 ? args.team.trim() : null;
        const assembly = resolveAssembly(teamName, config.assembly);
        const smoke = args.smoke === true;
        //     再不济有 Subagent ID 兜底 ⇒ 该场景现实中不存在）⇒ 读失败/不可用的正确行为 =
        let hostRosterNames = [];
        try {
          const rosterPort = createRosterPort(ctx, exec?.agent);
          if (rosterPort.available) {
            hostRosterNames = (rosterPort.read() ?? [])
              .map((m) => (m && typeof m.name === 'string' ? m.name.trim() : ''))
              .filter((name) => name.length > 0);
          }
        } catch (e) {
          ctx.logger?.warn?.('[dsh-punky-swarm] wave_plan: 宿主 roster 读取失败 ⇒ 未知席位告警基准退化为 BUILTIN_ROLES（**告警照常发射**）：' + String(e?.message ?? e));
        }
        const planArgs = { batchId: args.batchId, tasks: args.tasks, concurrency: args.concurrency ?? 5, team: teamName, assembly, smoke, handoffGate: handoffGateEnabledOf(readLiveConfig(deps), 'entry'), hostRoster: hostRosterNames };
        const plan = buildWavePlan(planArgs);
        validateWavePlan(plan, { smoke });
        //   否则「空白 roster」会绕过 `team` 的每条非空判据）。
        const channelDecl = normalizeChannelDecl(args.channel, plan.wavePlan.flatMap((w) => w.tasks));
        //   即与本会话声明的 D 不自洽，必须拒建批并给**两条正范式**，不得静默降级。
        //     （「单点判定」纪律：同一判据不得两处判）。
        const govD = store.readGovernance(sessionId)?.lastAssign ?? null;
        if (govD?.difficulty === 'D' && channelDecl.channel === 'dispatch') {
          throw new Error('GATE_DIFFICULTY_CHANNEL_UNRESOLVED: 本会话声明 difficulty=D（team 通道档），'
            + '而本批 channel=' + (channelDecl.declared ? "'dispatch'" : '未声明（归一为 dispatch）') + ' —— **D 与通道面不一致，拒建批**。'
            + '两条正范式：① 确需 durable 席位 ⇒ 保持 { difficulty:"D", durableSeats:true } 并以 channel:"team"|"mixed" 建批'
            + '（每条 lane 须写非空 roster，见 lib/wave-plan.js#normalizeChannelDecl）；'
            + '② 确属引擎自派 worker ⇒ 显式降级：重评 assign_check({ difficulty:"C", rationale:"<写明降级原因>", scope:"full" })'
            + ' 后以 channel:"dispatch" 建批（禁静默降级，同源 discipline.md §0b 十四⑤）。');
        }
        const asm = normalizeAssemblyDecl(args.assembly, []);
        const asmGate = assemblyGate(plan.wavePlan.flatMap((w) => w.tasks), asm.decl);
        if (asmGate !== 'ok') throw new Error(asmGate.code + ': ' + asmGate.message);

        plan.warnings.push(...asm.warnings);
        const batch = store.createBatch(sessionId, { batchId: plan.batchId, wavePlan: plan, concurrency: plan.concurrency, assembly: asm.decl ?? undefined, ...(channelDecl.declared ? { channel: channelDecl.channel } : {}), handoffGate: handoffGateStateOf(readLiveConfig(deps)) });
        if (smoke) store.appendEvent(sessionId, plan.batchId, EVT.EVT_BATCH_SMOKE, { batchId: plan.batchId });
        // 【批 `punky-checkpoint-enforce-20261112` · lane e1-schema】建批期**方言告警**：本批没有任何 task 声明
        //   `subtasks`（⇒ 方言 = legacy，两道 checkpoint 门全部放行）但确有 lane 声明了 `checkpoints`
        //   ⇒ 落一条批级告警事件，使「用旧方言绕过强制」在 `batch_status` 事件流里**可见**（spec §4.2 第 4 行 / §R-6）。
        //   ⚠ 只落事件、**不拒建批**；两者都未声明的批（含本批自身与全部存量批）**零事件** ⇒ 存量零感知。
        const flatPlanTasks = plan.wavePlan.flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
        const legacyCheckpointLanes = flatPlanTasks
          .filter((t) => t && !('subtasks' in t) && t.checkpoints != null)
          .map((t) => t.id);
        const declaresSubtasks = flatPlanTasks.some((t) => t && 'subtasks' in t);
        if (!declaresSubtasks && legacyCheckpointLanes.length > 0) {
          store.appendEvent(sessionId, plan.batchId, EVT.EVT_BATCH_CHECKPOINT_DIALECT_LEGACY, {
            lane: null, dialect: 'legacy', declared: legacyCheckpointLanes,
          });
        }
        const observedAsymmetry = smoke
          ? []
          : consumeDepsAsymmetryOf(plan.wavePlan.flatMap((w) => w.tasks)).filter((r) => r.domain === 'observed');
        for (const r of observedAsymmetry) {
          store.appendEvent(sessionId, plan.batchId, EVT.EVT_GATE_CONSUME_DEPS_ASYMMETRY, {
            lane: r.lane, from: r.from, artifact: r.artifact,
          });
        }
        //   （被枚举的两个码中，有一个已随零发射点删除 ⇒ 措辞不得再点名它）。
        for (const w of plan.warnings ?? []) {
          if (WARN_SILENT_CODES.has(w.code)) continue;
          store.appendEvent(sessionId, plan.batchId, WARN_EVENT_OF[w.code] ?? EVT.EVT_GATE_ROLE_INVALID, { code: w.code, task: w.task ?? null, role: w.role ?? null, layer: w.layer ?? null, missing: w.missing ?? null, roster: w.roster ?? null, basis: w.basis ?? null });
        }
        clearPendingBatch(store, sessionId);
        const out = { batchId: plan.batchId, sessionId, wavePlan: plan.wavePlan, concurrency: plan.concurrency, lanes: batch.lanes, warnings: plan.warnings ?? [], ...(smoke ? { smoke: true } : {}), ...(observedAsymmetry.length ? { consumeDepsAsymmetry: observedAsymmetry.map((r) => ({ lane: r.lane, from: r.from, artifact: r.artifact })) } : {}) };
        if (asm.decl) out.assembly = asm.decl;
        return out;
      },
    }),
  ];
}
