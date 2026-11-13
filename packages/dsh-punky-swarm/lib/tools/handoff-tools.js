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

import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import * as EVT from '../state/event-types.js';
import { presenceJudge, declaredKindOf } from '../state/gates.js';
import { resolveArtifactIn } from '../state/batch-paths.js';
import { normalizeCheckpoints } from '../wave-plan.js';
import * as lock from '../lock.js';
import { lockPath, readLiveConfig } from './tier-gate.js';
import { handoffCallerIdentityOf } from './host-surface.js';
import { dispatchBindingDecision } from '../verify/binding.js';
import { readCapability } from '../assembly/schema.js';
import { applyInjectionBudget } from '../comms/inject-budget.js';
import { laneHandoffGapPayload } from '../state/store/events.js';

function budgetAssertionsOf(assertions, thresholds) {
  const omissions = [];
  if (!Array.isArray(assertions) || assertions.length === 0) return { assertions, omissions };
  const perItem = assertions.map((a) => {
    const r = applyInjectionBudget(a, { surface: 'handoff.assertion', thresholds, kind: 'perItem' });
    omissions.push(...r.omissions);
    return r.text;
  });
  const joined = perItem.join(' | ');
  const block = applyInjectionBudget(joined, { surface: 'handoff.assertions', thresholds, kind: 'perBlock' });
  omissions.push(...block.omissions);
  if (block.omissions.length === 0) return { assertions: perItem, omissions };
  const piece = block.text.split(' | ');
  return { assertions: piece.length > 0 ? piece : perItem, omissions };
}

/**
 * subtask 产物展示读数（G4=C ＋ H2=A：**只展示、不校验**）。
 *
 * 取源与判据（三处单一事实源，均不自写第二份）：
 *   · 声明面：`normalizeCheckpoints`（= `subtasks` 的**唯一归一实现**，与 `resume.js#declaredSubtasksOf`
 *     同一单点）⇒ `id` / `outputs` 的归一语义与建批、渲染、门禁三面**同源**；本函数不做任何二次归一。
 *   · 方言面：判据是「**该 lane 的 `subtasks` 键在场**」（与 `dialectOfLane` 的 lane 分支同一判据）。
 *     ⚠ 此处**不调** `dialectOfLane`：它的回落分支判的是**批级**方言（批内任一 lane 有键即为新方言），
 *     而本字段的需求是「**本 lane** 是否声明了 subtasks」—— 混合方言批里未声明的 lane 必须**缺席该键**
 *     （任务契约③：禁返回 `[]` 冒充「已声明 0 项」）。
 *   · 在场面：逐件复用 `resolveArtifactIn` + `presenceJudge`（与 `handoff_view` 的 artifactViews 同一对
 *     判据函数）⇒ `presenceJudge` 内部**逐件 `fs.statSync`** ＋ 批次产物根包含性判定，
 *     故 `present` 反映磁盘事实，**不由 `outputs.length` 反推**。
 *
 * ⚠ 只读契约：不写 store、不落事件、不进任何门禁判据；**更不接入 `handoff_submit` 的 artifacts 校验**
 *   （H2=A：交接提交的在场判据与错误码 `GATE_HANDOFF_ARTIFACT_MISSING` 逐字不变）。
 * @param {object|null} laneTask 已从同一份 `taskById` 索引取出的 lane 任务对象
 * @param {string} dir 批次产物根
 * @returns {Array<{id: string, outputs: string[], present: boolean[]}>|null} 未声明 ⇒ `null`（调用方据此**不写键**）
 */
function subtaskOutputViewsOf(laneTask, dir) {
  if (!laneTask || !('subtasks' in laneTask)) return null;
  const items = normalizeCheckpoints(laneTask.subtasks)?.items ?? [];
  return items.map((it) => {
    const outputs = Array.isArray(it.outputs) ? it.outputs : [];
    const present = outputs.map((p) => {
      let abs = null;
      try { abs = resolveArtifactIn(dir, p); } catch { abs = null; }
      const v = presenceJudge({
        mode: 'runtime',
        declared: [p],
        declaredKind: declaredKindOf(p),
        abs,
        artifactsRoot: dir,
      });
      return v.ok === true;
    });
    return { id: it.id, outputs, present };
  });
}

export function buildHandoffTools(cx) {
  const { ctx, store, root, deps = {} } = cx;
  const { resolveBatchSession } = deps;
  return [
    defineTool({
          name: "handoff_submit",
      description: "交接门：提交上游→下游交接（原子写 batch.handoffs + 事件 lane.handoff），是 DAG 下游开工的硬前提。入参 from（上游 lane）/to（下游 lane，须有建批期 deps 声明）/artifacts（相对批次产物根，逐个须在场，缺则拒并回显缺口）/assertions（非空）。提交成功即写入交接真源；from 侧锁**保持 held-by-token**（本工具不代持、不释放 —— 须持 token 经 lane_release 释放）；to 侧仅在无锁时尝试获取（不可用只落 hint，不阻塞交接；返回值 lockTransfer 回显 fromRelease/toAcquire 两面）。officialTaskId 仅自填回填位，引擎不写不校验。失败必带 GATE_* 码（码表见 references/discipline.md），缺口同时落 lane.handoff.gap。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true,"description":"批次 ID"},"from":{"type":"string","required":true,"description":"上游 lane id（该批内）"},"to":{"type":"string","required":true,"description":"下游 lane id（须有建批期 deps 声明）"},"artifacts":{"type":"array","required":true,"items":{"type":"string"},"description":"交付产物路径（相对批次产物根；逐个须在场）"},"assertions":{"type":"array","required":true,"items":{"type":"string"},"description":"下游可核断言（非空）"},"overwrite":{"type":"boolean","description":"该入边已 submitted 时重交须显式 true，否则拒 GATE_HANDOFF_OVERWRITE_UNDECLARED（缺省 false 即旧调用零破坏）"},"officialTaskId":{"type":"string","description":"官方任务板 task id（未启用：仅自填回填位，引擎不写不校验）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"code":{"type":"string"},"from":{"type":"string"},"to":{"type":"string"},"artifacts":{"type":"array","items":{"type":"string"}},"assertions":{"type":"array","items":{"type":"string"}},"overwrite":{"type":"boolean"},"previousAssertions":{"type":"array","items":{"type":"string"}},"missing":{"type":"array","items":{"type":"string"}},"problems":{"type":"array","items":{"type":"string"}},"lockTransfer":{"type":"object","additionalProperties":true}}},
        render: (_args, value) => value.ok
          ? TEXT_OUTPUT('handoff submitted: ' + value.from + ' -> ' + value.to + ' (' + (value.artifacts ?? []).length + ' artifacts, ' + (value.assertions ?? []).length + ' assertions)')
          : TEXT_OUTPUT('handoff rejected [' + value.code + ']: ' + (value.missing ?? []).join(', ')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts.filter((p) => typeof p === 'string' && p.trim().length > 0) : [];
        const assertions = Array.isArray(args.assertions) ? args.assertions.filter((a) => typeof a === 'string' && a.trim().length > 0) : [];
        const dir = store.artifactsDirOf(sessionId, args.batchId);
        const missingArtifacts = artifacts.filter((p) => {
          let abs = null;
          try { abs = resolveArtifactIn(dir, p); } catch { return true; }
          const v = presenceJudge({
            mode: 'runtime',
            declared: [p],
            declaredKind: declaredKindOf(p),
            abs,
            artifactsRoot: dir,
          });
          return !v.ok;
        });
        let rOverwrite = false;
        let rPreviousAssertions = [];
        if (missingArtifacts.length === 0) {
          const callerIdentity = handoffCallerIdentityOf(ctx, exec, args);
          const binding = dispatchBindingDecision({
            batch: b,
            lane: args.from,
            caller: callerIdentity.sessionId,
            where: 'handoff_submit(from=' + args.from + ')',
          });
          if (!binding.ok) throw new Error(binding.reason);
          const r = store.recordHandoff(sessionId, args.batchId, {
            from: args.from, to: args.to, artifacts, assertions,
            overwrite: args.overwrite === true,
            caller: { ...callerIdentity, from: args.from },
            ...(typeof args.officialTaskId === 'string' && args.officialTaskId ? { officialTaskId: args.officialTaskId } : {}),
          });
          if (!r.ok) throw new Error(r.code + ': ' + (r.problems ?? []).join('; ') + (r.missing?.length ? '（缺口：' + r.missing.join(', ') + '）' : ''));
          rOverwrite = r.overwrite === true;
          rPreviousAssertions = Array.isArray(r.previousAssertions) ? r.previousAssertions : [];
        } else {
          store.appendEvent(sessionId, args.batchId, EVT.EVT_LANE_HANDOFF_GAP, laneHandoffGapPayload({
            lane: args.to, code: 'GATE_HANDOFF_ARTIFACT_MISSING', missing: missingArtifacts,
            problems: missingArtifacts.map((p) => '交接产物不在场：' + p),
          }));
          throw new Error('GATE_HANDOFF_ARTIFACT_MISSING: 交接产物不在场（' + missingArtifacts.join(', ')
            + '）——请先落盘产物（批次产物根：' + dir + '）再提交交接。'
            + '（口径：本码 = **缺产物**；`GATE_HANDOFF_MISSING` 现专指**缺边**——入边未声明/未提交。）');
        }
        //   交接（真源写入）已成功落盘，不应被锁状态反向报成失败（否则「已落盘、调用方以为失败 ⇒ 重试」）。
        const lockTransfer = {};
        try {
          if (lock.isLocked(lockPath(root, sessionId, args.batchId, args.from))) {
            lockTransfer.fromRelease = 'held-by-token（需持有 token 经 lane_release 释放：本工具不发凭据，避免代持）';
          } else lockTransfer.fromRelease = 'no-lock';
        } catch (e) { lockTransfer.fromRelease = 'probe-failed: ' + String(e?.message ?? e); }
        try {
          if (!lock.isLocked(lockPath(root, sessionId, args.batchId, args.to))) {
            const acq = await lock.acquire(lockPath(root, sessionId, args.batchId, args.to), { waitMs: 0 });
            lockTransfer.toAcquire = acq.ok ? 'acquired' : 'conflict';
          } else lockTransfer.toAcquire = 'already-held';
        } catch (e) { lockTransfer.toAcquire = 'failed: ' + String(e?.message ?? e); }
        return { ok: true, code: 'HANDOFF_OK', from: args.from, to: args.to, artifacts, assertions, overwrite: rOverwrite, previousAssertions: rPreviousAssertions, missing: [], problems: [], lockTransfer };
      },
    }),
    defineTool({
          name: "handoff_view",
      description: "交接门（只读）：列出该 lane 的已声明入边（deps ∪ 经 handoff_accept 接受的入边），与 entry/出口门同源。每条回显上游 lane、状态（submitted/pending）、来源 source（deps/accept）、交付产物绝对路径 + 是否可读、上游 assertions；另给上游 produce∪outputs 清单。blocking 与 pending 分列。存量批回 legacy:true（门放行）。零写入；officialTaskId 同属未启用面，不得读作已双写。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"lane":{"type":"string","required":true,"description":"下游 lane id"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"legacy":{"type":"boolean"},"ready":{"type":"boolean","required":true},"deps":{"type":"array","items":{"type":"string"}},"edges":{"type":"array","items":{"type":"object","additionalProperties":true}},"pending":{"type":"array","items":{"type":"string"}},"blocking":{"type":"array","items":{"type":"string"}},"omissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"subtaskOutputs":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"},"outputs":{"type":"array","items":{"type":"string"}},"present":{"type":"array","items":{"type":"boolean"}}}}}}},
        render: (_args, value) => {
          const lines = ['handoff ' + value.lane + ': ' + (value.ready ? 'READY' : 'BLOCKED')
            + ' (edges=' + (value.edges ?? []).length + (value.legacy ? ', legacy-batch' : '') + ')'];
          for (const e of value.edges ?? []) {
            lines.push('  ' + e.from + ' → ' + e.status + '  [source=' + (e.source ?? 'deps') + ']');
            const arts = e.artifacts ?? [];
            lines.push('    artifacts: ' + (arts.length
              ? arts.map((a) => String(a.path) + (a.readable ? ' (readable)' : ' (MISSING)')).join(', ')
              : '（空）'));
            const asrt = e.assertions ?? [];
            lines.push('    assertions: ' + (asrt.length ? asrt.join(' | ') : '（空）'));
          }
          // subtask 产物展示行（G4=C：让下游在交接视图里看得见本 lane 声明的产物面）。
          //   键缺席 ⇒ 整行不渲染（未声明 subtasks 的 lane 保持既有回执逐字不变）。
          if (Array.isArray(value.subtaskOutputs)) {
            const rows = value.subtaskOutputs.map((s) => {
              const outs = s.outputs ?? [];
              const flags = s.present ?? [];
              const body = outs.length
                ? outs.map((p, i) => String(p) + (flags[i] === true ? ' (ok)' : ' (MISSING)')).join(', ')
                : '（未声明 outputs）';
              return String(s.id) + ' → ' + body;
            });
            lines.push('  subtask 产物: ' + (rows.length ? rows.join(' | ') : '（已声明 0 项）'));
          }
          if ((value.pending ?? []).length) lines.push('  pending: ' + value.pending.join(', '));
          if ((value.blocking ?? []).length) lines.push('  缺口: ' + value.blocking.join(', '));
          for (const o of value.omissions ?? []) {
            lines.push('  omitted: ' + o.surface + ' ' + o.omittedBytes + 'B (kept ' + o.keptBytes + 'B)');
          }
          return TEXT_OUTPUT(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        const map = (b.handoffs && typeof b.handoffs === 'object' && !Array.isArray(b.handoffs)) ? b.handoffs : null;
        const legacy = map === null;
        const dir = store.artifactsDirOf(sessionId, args.batchId);
        // 一次建表：deps 读取与逐边上游查找共用同一份索引（原实现三处全扫 wavePlan ⇒ O(E·T)）
        const taskById = new Map();
        for (const w of b.wavePlan ?? []) for (const t of w.tasks ?? []) if (t && typeof t.id === 'string') taskById.set(t.id, t);
        const laneTask = taskById.get(args.lane) ?? null;
        // subtask 产物展示读数（G4=C ＋ H2=A：只展示、不校验）。未声明 ⇒ `null` ⇒ 返回体**不写该键**。
        const subtaskOutputs = subtaskOutputViewsOf(laneTask, dir);
        const deps = laneTask && Array.isArray(laneTask.deps) ? laneTask.deps : [];
        const declared = store.declaredInboundEdgesOf(b, args.lane, laneTask);
        const sourceOf = new Map((declared.sources ?? []).map((s) => [s.from, s.source]));
        const edges = declared.edges.map((from) => {
          const t = taskById.get(from) ?? null;
          const upstreamDeclared = t ? [...(Array.isArray(t.produce) ? t.produce : []), ...(Array.isArray(t.outputs) ? t.outputs : [])] : [];
          const rec = (map && Array.isArray(map[args.lane])) ? map[args.lane].find((r) => r && r.from === from) ?? null : null;
          // 缺口清单**只由门禁函数给出**（同一函数实例）：视图自拼会与门禁漂移 —— 曾漏 `contract.consumedFrom`
          const vr = store.handoffRecordVerdict(sessionId, args.batchId, laneTask?.layer ?? null, rec, from, args.lane);
          // 产物在场判定与 entry 门**同判据**（同一解析规则 + 同一「文件且非空」语义）——下游据此判断**能不能稳定取件**
          const arts = (rec && Array.isArray(rec.artifacts)) ? rec.artifacts : [];
          const artifactViews = arts.map((p) => {
            let abs = null;
            try { abs = resolveArtifactIn(dir, p); } catch { abs = null; }
            const v = presenceJudge({
              mode: 'runtime',
              declared: [p],
              declaredKind: declaredKindOf(p),
              abs,
              artifactsRoot: dir,
            });
            return { path: p, abs, readable: v.ok };
          });
          const s = rec ? String(rec.status ?? 'pending') : 'undeclared';
          return {
            from, to: args.lane, status: s,
            source: sourceOf.get(from) ?? null,
            artifacts: artifactViews,
            assertions: (rec && rec.contract && Array.isArray(rec.contract.assertions)) ? rec.contract.assertions : [],
            consumedFrom: (rec && rec.contract) ? (rec.contract.consumedFrom ?? null) : null,
            officialTaskId: rec ? (rec.officialTaskId ?? null) : null,
            upstreamDeclared,
            gap: vr.missing,
          };
        });
        const blocking = edges.flatMap((e) => e.gap);
        const pending = edges.filter((e) => e.status !== 'submitted').map((e) => e.from + '->' + args.lane);
        const ready = legacy ? true : blocking.length === 0;
        // 读热快照（与 dispatch/query 同源）：装配期 `cx.config` 是冻结值 ⇒ runtime.json 改预算后本工具不生效
        const injectCfg = readCapability(readLiveConfig(deps), 'injectBudget');
        if (injectCfg?.enabled === true) {
          const omissions = [];
          for (const e of edges) {
            const bud = budgetAssertionsOf(e.assertions, injectCfg);
            e.assertions = bud.assertions;
            omissions.push(...bud.omissions);
          }
          return { batchId: args.batchId, lane: args.lane, legacy, ready, deps, edges, pending, blocking, omissions, ...(subtaskOutputs === null ? {} : { subtaskOutputs }) };
        }
        return { batchId: args.batchId, lane: args.lane, legacy, ready, deps, edges, pending, blocking, omissions: [], ...(subtaskOutputs === null ? {} : { subtaskOutputs }) };
      },
    }),
    //   结构性拿不到声明位（它恒落声明序末尾，不可能成为既有下游的 `deps`）⇒ 其产物进不了既有 audit lane
    //   「放宽校验」相反：**净收紧**（补一条声明 ⇒ `from` 多一条**必须交**的义务，缺交即转红）。
    defineTool({
      name: "handoff_accept",
      description: "交接门（受限反向声明）：下游 lane 接受批运行中追加的后置 lane 作为入边（写方=消费方），在下游入边表 batch.handoffs[to] 补一条 pending 声明；声明存在则 from 必须交，缺交即拒并落 lane.handoff.gap。不写 deps、不改拓扑真源。入参 from（须为 plan.mutated.added[] 内的后置 lane）/to（须已声明且 layer=audit）/reason/author。拒绝均零写入：层/序号/存量批/终态不符或幂等。成功必落 plan.mutated 并 planRevision+1。失败必带 GATE_* 码。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true,"description":"批次 ID"},"from":{"type":"string","required":true,"description":"上游 lane id（必须是 plan.mutated.added[] 内的后置 lane）"},"to":{"type":"string","required":true,"description":"下游 lane id（须已声明且 layer=audit）"},"reason":{"type":"string","description":"声明理由（落 plan.mutated.reason）"},"author":{"type":"string","description":"声明作者（落 plan.mutated.author；缺省取调用方）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"code":{"type":"string","required":true},"idempotent":{"type":"boolean"},"from":{"type":"string"},"to":{"type":"string"},"revision":{"type":"number"},"record":{"type":"object","additionalProperties":true},"rejected":{"type":"string"}}},
        render: (_args, value) => value.ok
          ? TEXT_OUTPUT('handoff accepted [' + value.code + ']: ' + value.from + ' -> ' + value.to
            + ' (planRevision=' + (value.idempotent ? value.revision : (Number(value.revision) - 1) + '->' + value.revision)
            + (value.idempotent ? ', idempotent: 该边已声明 ⇒ 零写入' : '') + ')')
          : TEXT_OUTPUT('handoff accept rejected [' + value.code + ']: ' + (value.rejected ?? '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        const author = (typeof args.author === 'string' && args.author.trim().length)
          ? args.author.trim()
          : (handoffCallerIdentityOf(ctx, exec, args).sessionId ?? null);
        let r;
        try {
          r = store.recordHandoffAccept(sessionId, args.batchId, {
            from: args.from, to: args.to, reason: args.reason ?? null, author,
          });
        } catch (e) {
          const msg = String(e?.message ?? e);
          const gate = /^(GATE_[A-Z0-9_]+)/.exec(msg);
          throw Object.assign(new Error(msg), {
            ok: false, code: gate ? gate[1] : 'HANDOFF_ACCEPT_REJECTED', from: args.from, to: args.to, rejected: msg,
          });
        }
        return {
          ok: true,
          code: 'HANDOFF_ACCEPT_OK',
          idempotent: r.idempotent === true,
          from: r.from, to: r.to, revision: r.revision, record: r.record ?? null,
        };
      },
    }),
  ];
}