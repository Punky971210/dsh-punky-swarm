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
// 共享辅助（P2-01 下沉至零依赖 shared.js）：TEXT_OUTPUT / sessionOf——本文件 re-export 保持对外导出兼容
//   （mailbox-tools/log-tools/lane-tools 已直引 shared.js；watch/lane-heartbeat 不再依赖 core.js）
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildWavePlan, validateWavePlan } from '../wave-plan.js';
import { resolveAssembly } from '../assembly.js';
import { ARTIFACT_TYPES } from '../artifact-types.js';
import * as lock from '../lock.js';
import { join } from 'node:path';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
export { TEXT_OUTPUT, sessionOf }; // P2-01 re-export：既有消费方（lib/tools/core.js 的 import 者）不受影响

// 执行型工具名单（有副作用/写盘/派发执行）：guard 计数与拦截用；可被 config.escalation.execTools 覆盖
export const EXEC_TOOLS = [
  'pwsh', 'bash', 'write', 'edit', 'run_code', 'workflow', 'ralph',
  'ssh_exec', 'ssh_cluster', 'ssh_upload', 'ssh_download', 'subagent', 'subagent_fork',
];

// 清 pendingBatch（wave_plan 建批 / 批次 complete|aborted 后调用；无治理状态时不创建文件）
// session-compat：本会话曾把评估镜像到执行会话（mirroredTo）时，解锁同步传播到镜像会话，
// 避免 C@命名会话建批后，执行会话 guard 残留「先建批」幻觉锁
export function clearPendingBatch(store, sessionId) {
  const g = store.readGovernance(sessionId);
  const mirroredTo = g.mirroredTo ?? null;
  if (g.pendingBatch || g.pendingSince || g.lastAssign || mirroredTo) {
    store.writeGovernance(sessionId, { pendingBatch: false, pendingSince: null, mirroredTo: null });
  }
  if (mirroredTo && mirroredTo !== sessionId) {
    const gm = store.readGovernance(mirroredTo);
    if (gm.mirror?.from === sessionId) {
      store.writeGovernance(mirroredTo, { pendingBatch: false, pendingSince: null, mirror: null });
    }
  }
}

export function lockPath(root, sessionId, batchId, lane) { return join(root, 'sessions', sessionId, '.locks', batchId + '.' + lane + '.lock'); }

// 任务难度值门禁注册：guard 逻辑原样搬移自 lib/tools.js（一字不改），注册顺序保持现状（createTools 开头）
export function installDifficultyGuard(ctx, deps) {
  const { store, config = {} } = deps;
  // 任务难度值门禁（design task-difficulty-gate §3，引擎强制不依赖自觉）：执行型工具前置 guard
  // 同步签名 (execution) => string | undefined；execution 含 name / agent.session.id；返回 string 即拒绝
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard((execution) => {
      // ② subagent 降级豁免（guard 开头）：subagent/subagent_fork 派发的 worker 会话
      //   （delegationDepth>0 或带 parentSession）继承 Leader 侧已评估的任务形态，难度门禁不重复评估——
      //   会话隔离（worker 无 Leader 侧 lastAssign）+ 同块并行时序下重复评估必然误拦。豁免仅限难度门禁，
      //   其余 guard 语义（EXEC_TOOLS 名单、计数）不受影响；Leader 会话（无 header）仍走完整门禁。
      const header = execution?.agent?.session?.header;
      if (header && (header.delegationDepth > 0 || header.parentSession)) return undefined;
      // ③′ session 解析对称：与 sessionOf 同序——execution.arguments.session 优先，缺省回退 agent.session.id。
      // 修复显式传 session 时评估（args.session 落点）与拦截（只认 agent.session）不同步导致的误拦
      const sessionId = execution?.arguments?.session ?? execution?.agent?.session?.id;
      if (!sessionId) return undefined;
      const execTools = config?.escalation?.execTools ?? EXEC_TOOLS;
      // ① 非执行型：放行（治理/查询，防死锁）
      // ⚠ P2-05 豁免边界（明示）：
      //   - 豁免类别：治理/查询类工具（batch_status/gate_status/member_status/artifact_types/lane_checkpoint_status/
      //     lane_heartbeat 等不在 EXEC_TOOLS 名单者）+ 非执行型写（如 mailbox_read 读回执、assign_check 评估本身）。
      //   - 豁免理由：防死锁——难度门禁是「先评估后执行」的护栏，评估/查询动作若也被拦截将形成
      //     「评估→被拦→无法评估」死循环（worker 被派发后须先读状态再干活，读状态不能被门禁卡死）。
      //   - 豁免范围：仅限难度门禁（本 guard）；其余 guard 语义（EXEC_TOOLS 计数 bumpExecCount、
      //     执行型调用次数统计）不受影响——下方 store.bumpExecCount 仍对所有执行型调用计数。
      //   - 名单可覆盖：config.escalation.execTools 可增减执行型名单（名单外即豁免）。
      if (!execTools.includes(execution.name)) return undefined;
      const g = store.readGovernance(sessionId);
      let reason;
      // 门禁 1：从未评估 或 已过期（execCallsSince≥20 / 距 lastAssign.at≥30min）→ 要求先评估
      if (!g?.lastAssign?.form || store.stale(sessionId)) {
        reason = '[task-difficulty-gate] 本回合尚未进行任务难度评估（A/B/C）。请先调用 assign_check(scope=full) 给出难度与执行主体，再执行 ' + execution.name;
      } else if (g.lastAssign.form === 'C' && g.pendingBatch) {
        // 门禁 2：判 C 且未建批 → 拒绝执行型（必须先 wave_plan 建批）
        reason = '[task-difficulty-gate] 任务难度=C（集群方案），必须先 wave_plan 建批。已直做产物用 asset_claim 归位，然后建批派发。';
      } else if ((execution.name === 'subagent' || execution.name === 'subagent_fork') && g.lastAssign.form === 'A') {
        // 门禁 3（一致性）：A 类不派发 subagent（需要独立上下文请重评 B）
        reason = '[task-difficulty-gate] A 类任务不派发 subagent；如确实需要独立上下文请重评 B。';
      }
      store.bumpExecCount(sessionId); // 计数与拦截分离：无论是否拦截，执行型调用都计（机制 A 观察）
      return reason;
    });
  }
}

export function createCoreTools(ctx, deps) {
  const { store, root, config = {} } = deps;

  return [
    defineTool({
      name: "wave_plan",
      description: "把任务按 DAG 依赖分层为 waves 并持久化为批次（wavePlan 固定语义，绝不在中途重算）。Tier3：任务可声明 layer(plan/exec/audit)/consume/produce/outputs/role/skills，建批时做三层契约静态校验；team 装配按 role 注入 skill 前缀（可插拔，不绑定 jiufeng）。批次绑定当前会话。产物落盘契约：引擎产物根 = <~/.dsh/jiufeng>/sessions/<sessionId>/artifacts/<batchId>/，consume/produce/outputs 相对路径均解析到该根下（worker 落盘按此根，勿落工作区根）。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID（kebab-case）"},"tasks":{"type":"array","required":true,"description":"任务列表 [{id, cmd, deps?, model?, tools?, layer?, role?, skills?, consume?, produce?, outputs?}]","items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","description":"并发上限（默认 5）"},"team":{"type":"string","description":"装配团队（默认 generic；三层批推荐 jiufeng）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"wavePlan":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","required":true},"lanes":{"type":"object","required":true,"additionalProperties":true},"warnings":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('wavePlan created: ' + value.batchId + ' @' + value.sessionId + ' (' + value.wavePlan.length + ' waves)' + (value.warnings?.length ? '; role warnings: ' + value.warnings.length : '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const assembly = resolveAssembly(args.team, config.assembly);
        const plan = buildWavePlan({ batchId: args.batchId, tasks: args.tasks, concurrency: args.concurrency ?? 5, team: args.team, assembly });
        validateWavePlan(plan);
        const batch = store.createBatch(sessionId, { batchId: plan.batchId, wavePlan: plan, concurrency: plan.concurrency });
        // role 校验告警留痕（GATE_ROLE_INVALID / GATE_ROLE_MISSING，warning 语义：事件留痕、不阻断建批；Leader 经返回值 warnings 可见）
        for (const w of plan.warnings ?? []) {
          store.appendEvent(sessionId, plan.batchId, w.code === 'GATE_ROLE_MISSING' ? 'gate.role_missing' : 'gate.role_invalid', { code: w.code, task: w.task ?? null, role: w.role ?? null, layer: w.layer ?? null, missing: w.missing ?? null });
        }
        clearPendingBatch(store, sessionId); // 建批解锁：判 C 后 pendingBatch=false（design §4 写入点）
        return { batchId: plan.batchId, sessionId, wavePlan: plan.wavePlan, concurrency: plan.concurrency, lanes: batch.lanes, warnings: plan.warnings ?? [] };
      },
    }),
    defineTool({
      name: "batch_phase",
      description: "批次阶段迁移：planning->running->paused->aborted|complete（终态后拒绝再写）。complete 前置：audit 层验收齐备（Tier3 门禁）。批次按会话隔离，缺省取当前执行会话。",
      parameters: {"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true,"enum":["running","paused","aborted","complete"]},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('batch ' + value.batchId + ' phase -> ' + value.phase),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const b = store.setPhase(sessionId, args.batchId, args.phase);
        if (b.phase === 'complete' || b.phase === 'aborted') clearPendingBatch(store, sessionId); // 兜底清理旧锁
        return { batchId: args.batchId, phase: b.phase };
      },
    }),
    defineTool({
      name: "batch_status",
      description: "查询批次状态（唯一事实源）：phase/lanes/wavePlan/事件摘要；不传 batchId 则列出当前会话全部批次。可用 session 指定会话。",
      parameters: {"batchId":{"type":"string","description":"批次 ID；缺省时列出该会话全部"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"phase":{"type":"string"},"concurrency":{"type":"integer"},"lanes":{"type":"object","additionalProperties":true},"wavePlan":{"type":"array","items":{"type":"object","additionalProperties":true}},"eventCount":{"type":"integer"},"recentEvents":{"type":"array","items":{"type":"object","additionalProperties":true}},"settled":{"type":"boolean"},"sessionId":{"type":"string"},"batches":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => value.batchId ? TEXT_OUTPUT('batch ' + value.batchId + ' phase=' + value.phase + ' settled=' + value.settled) : TEXT_OUTPUT('batches: ' + (value.batches ?? []).length),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        if (!args.batchId) {
          return { sessionId, batches: store.listBatches(sessionId).map((id) => { const b = store.readBatch(sessionId, id); return { batchId: id, sessionId, phase: b.phase, lanes: b.lanes }; }) };
        }
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
        return { batchId: b.batchId, sessionId, phase: b.phase, concurrency: b.concurrency, lanes: b.lanes, wavePlan: b.wavePlan, eventCount: b.events.length, recentEvents: b.events.slice(-20), settled: store.batchSettled(b) };
      },
    }),
    defineTool({
      name: "artifact_types",
      description: "产物类型注册表（只读，Tier3 通用任务治理）：列出产物类型 → 层/目录前缀约定，供 wave_plan 声明产物与模板对齐。不绑定任何团队模板。",
      parameters: {},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"types":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('artifact types: ' + value.types.length),
      },
      async execute() {
        return { types: ARTIFACT_TYPES.map((t) => ({ type: t.type, dir: t.dir, layer: t.layer, desc: t.desc })) };
      },
    }),
    defineTool({
      name: "assign_check",
      description: "委派形态判定（设计 §10/§15.3 N3）：判断任务应由 Leader 直做（A）/ 轻量委派 subagent（B，需独立上下文/工具面时）/ 必须走流水线批次（C）。输入任务特征（并行?/多角色?/门禁?/可恢复?/需独立上下文?），返回判定与原因；C 类任务应走 wave_plan 建批。每次调用写入会话治理状态（governance.lastAssign+history），guard 依据其做执行型工具门禁。显式 session 时输出回显 sessionId 并镜像到执行会话（guard 兼容不误拦）；缺省=当前执行会话，cli 兜底并提示。",
      parameters: {"parallel":{"type":"boolean","description":"需要并行或任务间依赖（DAG）"},"multiRole":{"type":"boolean","description":"需要多角色协作（编码+测试+审查分离）"},"gate":{"type":"boolean","description":"需要门禁/审计（人审、验收、gap-list）"},"recoverable":{"type":"boolean","description":"需要跨轮治理/可恢复/可审计"},"needIsolation":{"type":"boolean","description":"需要独立上下文/工具面（查代码、跑测试等）"},"scope":{"type":"string","enum":["current","full"],"description":"评估对象：current=当前动作，full=完整目标任务（纪律强制 full，防把小动作当整体难度）"},"session":{"type":"string","description":"显式指定评估落点会话（当前会话 ID 或命名黑板）；缺省=当前执行会话，cli 兜底；与执行会话不同时自动镜像到执行会话（guard 兼容）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"form":{"type":"string","required":true},"allowed":{"type":"boolean","required":true},"reasons":{"type":"array","required":true,"items":{"type":"string"}},"next":{"type":"array","required":true,"items":{"type":"string"}},"execToolCount":{"type":"integer","required":true},"escalationHint":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"mirroredTo":{"type":"string"},"notice":{"type":"string"},"history":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => {
          let s = 'assign form: ' + value.form + (value.form === 'C' ? ' (must use batch) → next: wave_plan' : ' (allowed)') + (value.sessionId ? ' @' + value.sessionId : '');
          if (value.mirroredTo) s += ' [mirror→' + value.mirroredTo + ']';
          if (value.escalationHint) s += ' ⚠ ' + value.escalationHint;
          if (value.notice) s += ' ⚠ ' + value.notice;
          return TEXT_OUTPUT(s);
        },
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const reasons = [];
        if (args.parallel) reasons.push('需要并行或任务依赖（DAG）');
        if (args.multiRole) reasons.push('需要多角色协作（编码+测试+审查分离）');
        if (args.gate) reasons.push('需要门禁/审计（人审、验收、gap-list）');
        if (args.recoverable) reasons.push('需要跨轮治理/可恢复/可审计');
        const form = reasons.length ? 'C' : (args.needIsolation ? 'B' : 'A');
        // 写入治理状态：lastAssign + history 追加（审计：每回合评估留痕）；C 类且无活跃批次 → pendingBatch=true
        const now = new Date().toISOString();
        const scope = args.scope ?? 'full';
        const g0 = store.readGovernance(sessionId);
        const history = [...(g0.history ?? []), { turn: (g0.history?.length ?? 0) + 1, form, at: now, reasons }];
        const hasActive = store.hasActiveBatch(sessionId);
        const patch = { lastAssign: { form, scope, at: now, reasons, execCallsSince: 0 }, history };
        if (form === 'C' && !hasActive) { patch.pendingBatch = true; patch.pendingSince = now; }
        // 新评估总是把 pendingBatch 收敛到正确状态——已有活跃批次，或残留 pendingBatch（C 判定后重评为 A/B），一律清锁
        else if (hasActive || g0.pendingBatch) { patch.pendingBatch = false; patch.pendingSince = null; }
        // session-compat：显式 session 与执行会话不同 → 镜像到执行会话（guard 落点兼容）。
        // 镜像只写 lastAssign + pendingBatch + mirror 指针，不污染执行会话 history；解锁经 clearPendingBatch 传播
        const execSessionId = exec?.agent?.session?.id ?? null;
        const mirror = Boolean(args?.session && execSessionId && args.session !== execSessionId);
        if (mirror) patch.mirroredTo = execSessionId;
        const g = store.writeGovernance(sessionId, patch);
        let mirroredTo = null;
        if (mirror) {
          mirroredTo = execSessionId;
          store.writeGovernance(execSessionId, {
            lastAssign: { ...patch.lastAssign, mirroredFrom: sessionId },
            pendingBatch: patch.pendingBatch ?? g.pendingBatch ?? false,
            pendingSince: patch.pendingSince ?? g.pendingSince ?? null,
            mirror: { from: sessionId, at: now },
          });
        }
        const execToolCount = g.execToolCount ?? 0;
        // 升级信号（design escalation-hardgate §2.2 S4）：execToolCount≥5 且无活跃批次 → 软提示
        const escalationHint = (execToolCount >= 5 && !hasActive)
          ? 'execToolCount=' + execToolCount + ' ≥5 且无批次：任务已升级为复杂形态，必须 wave_plan 建批'
          : '';
        // session-compat：cli 兜底警示（共享黑板跨调用互相覆盖）
        const notice = sessionId === 'cli'
          ? 'session 未显式指定且无 agent.session：评估落点 cli 共享黑板，跨调用互相覆盖，建议显式传 session'
          : '';
        // 条件构造返回对象：不触发镜像时镜像字段完全缺席——undefined/null 值均会触发 harness lossless JSON 校验拒绝
        const out = { form, allowed: form !== 'C', reasons, next: form === 'C' ? ['wave_plan'] : [], execToolCount, escalationHint, notice, sessionId, history: g.history };
        if (mirroredTo) out.mirroredTo = mirroredTo;
        return out;
      },
    }),
    defineTool({
      name: "asset_claim",
      description: "归位（设计 6.3）：Leader 已直做产物（探索/探测/排障）注册为批次资产——复制 source 进 <artifacts>/<batchId>/<target>（保留内容，不移动），批次事件 asset.claimed 留痕，返回批次内路径供 wave_plan consume/produce 声明。路径防逃逸：target 必须是批次内相对路径，拒绝 .. 与绝对路径。引擎产物根 = <~/.dsh/jiufeng>/sessions/<sessionId>/artifacts/<batchId>/；worker 按工作区落盘的产物，结算前须经本工具归位到该根下。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"source":{"type":"string","required":true,"description":"源文件绝对路径（已直做产物）"},"target":{"type":"string","required":true,"description":"批次内目标路径（相对 artifacts/<batchId>/，不得含 .. 或绝对路径）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"claimedPath":{"type":"string"},"batchId":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('asset claimed: ' + value.claimedPath),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const r = store.claimAsset(sessionId, args.batchId, { source: args.source, target: args.target });
        return { ok: r.ok, claimedPath: r.claimedPath, batchId: r.batchId };
      },
    }),
    defineTool({
      name: "gate_status",
      description: "查询批次/ lane 的门禁状态（设计 §8 M1）：layer、consume/produce/outputs 缺失清单、plan 契约问题。不传 lane 列出全部 lane。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","description":"lane ID；缺省列出全部"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"lanes":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('gate status: ' + value.lanes.length + ' lane(s)'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const batch = store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const ids = args.lane ? [args.lane] : Object.keys(batch.lanes);
        return { batchId: args.batchId, sessionId, lanes: ids.map((l) => store.gateStatus(sessionId, args.batchId, l)) };
      },
    }),
    defineTool({
      name: "lane_claim",
      description: "以 O_EXCL 单写者锁认领 lane（同一批次同一 lane 同时只允许一个写者）。冲突先拒绝；可 wait 或 force 接管。锁按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"任务 ID"},"waitMs":{"type":"integer","description":"等待毫秒（默认 0 = 直接冲突返回）"},"force":{"type":"boolean","description":"force 接管（默认 false）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"token":{"type":"string"},"conflict":{"type":"boolean"},"reason":{"type":"string"},"lockPath":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane claimed') : TEXT_OUTPUT('lane conflict'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const r = await lock.acquire(lockPath(root, sessionId, args.batchId, args.lane), { waitMs: args.waitMs ?? 0, force: args.force === true });
        if (!r.ok) return { ok: false, conflict: true, reason: 'lane locked' };
        return { ok: true, token: r.token };
      },
    }),
    defineTool({
      name: "lane_release",
      description: "释放 lane 锁（需持有 token；token 不匹配拒绝释放）。锁按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"token":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"reason":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane released') : TEXT_OUTPUT('release failed: ' + (value.reason ?? '')),
      },
      async execute(args, exec) {
        return lock.release(lockPath(root, sessionOf(args, exec), args.batchId, args.lane), args.token);
      },
    }),
    defineTool({
      name: "member_settle",
      description: "成员结算：按状态机迁移（running->review->merged/failed/skipped/conflict），写入 member.settled 事件。Tier3 门禁：plan merged 前 Plan 契约校验（spec 必填章节 + task-tree JSON）、exec merged 前 outputs 校验、audit merged 前 produce 校验；lane 声明 targets 时，merged 前逐一核对 targets 落盘（存在性，不读正文），缺则拒 merged 抛 GATE_TARGET_MISSING、未变更抛 GATE_TARGET_UNCHANGED。needHuman：audit lane 产物含独立行 `needHuman: true` 声明时，merged 须 note 携带人工裁决证据（契约 `human:<裁决人>:<时间>:<结论>`，如 human:user@2026-08-21:accept），缺则拒 GATE_NEEDHUMAN_PENDING；conflict 驳回不强制（评审驳回语义）。命令 gate（V1）：exec 层产物可含独立行 `gate: <命令>`（行首锚定，可多行顺序执行），merged 前置确定性执行并以退出码判定（exit 0 通过，事件 gate.exit）；失败拒 merged 抛 GATE_EXIT_*（lane 留 review）；失败且产物声明 `needHuman: true` → 转人工闸（merged 须 note 含 human: 证据，缺则 GATE_NEEDHUMAN_PENDING）。批次按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":["merged","failed","skipped","conflict"]},"note":{"type":"string","description":"简短备注（只留元数据，不复制正文）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' settled -> ' + value.status),
      },
      async execute(args, exec) {
        const b = store.setMember(sessionOf(args, exec), args.batchId, args.lane, args.status, args.note ?? null);
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
    defineTool({
      name: "member_status",
      description: '成员状态操作（非终态）：pending->running（派发，Tier3 门禁：exec 需 consume 齐备）、running->review（提交评审）、idle->running（恢复重派）。终态结算请用 member_settle。批次按会话隔离。',
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":["pending","running","review","idle"]},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' status -> ' + value.status),
      },
      async execute(args, exec) {
        const b = store.setMember(sessionOf(args, exec), args.batchId, args.lane, args.status, null);
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
  ];
}
