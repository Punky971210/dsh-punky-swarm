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

// P1 交接门工具面（自 `lib/tools/core.js` **原样搬移**）：handoff_submit / handoff_view。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import * as EVT from '../state/event-types.js';
import * as lock from '../lock.js';
import { lockPath } from './tier-gate.js';
import { handoffCallerIdentityOf } from './host-surface.js';

export function buildHandoffTools(cx) {
  const { ctx, store, root } = cx;
  return [
    defineTool({
          name: "handoff_submit",
      description: "P1 交接门：提交一条**上游→下游**交接（写黑板真源 `batch.handoffs` + 落审计事件 `lane.handoff`，同一次原子写）。语义 = 「上游把产物交给下游」，是 DAG 下游开工的**硬前提**（下游缺该入边交接 ⇒ entry 门拒 `GATE_HANDOFF_MISSING`）。入参 `from`（上游 lane）/`to`（下游 lane，须已由建批期 `deps` 声明）/`artifacts`（交付产物，相对批次产物根；**逐个必须在场**，缺则拒并回显缺口）/`assertions`（下游可核断言，非空）。写权转移：提交成功即尝试 `from` 释放 / `to` 获取（与既有 lane_claim 配对耦合；锁不可用只落 hint、**不阻塞交接**）。官方任务板双写（M-6）**未启用**（如实降级 2026-09-18）：本引擎**未接线**官方任务板——全仓无 `team_task_create` 调用点，宿主工具面**有**这些工具（`team_task_create`/`_get`/`_list`/`_update`，可实调），但引擎侧**无消费点、无校验、无判定** ⇒ 不构成治理真源；据此 `officialTaskId` 是**调用方自填**的原样回填位（不填恒 `null`），引擎**不写、不校验、不据以判定**；本工具的任何回显**不得**读作「已双写」。拒绝码：`GATE_HANDOFF_MISSING`（缺口同时落 `lane.handoff.gap` 事件）。",
      parameters: {"batchId":{"type":"string","required":true},"from":{"type":"string","required":true,"description":"上游 lane id（该批内）"},"to":{"type":"string","required":true,"description":"下游 lane id（须有建批期 deps 声明）"},"artifacts":{"type":"array","required":true,"items":{"type":"string"},"description":"交付产物路径（相对批次产物根；逐个须在场）"},"assertions":{"type":"array","required":true,"items":{"type":"string"},"description":"下游可核断言（非空）"},"overwrite":{"type":"boolean","description":"**R-2 覆盖保护（P4 授权修复批）**：该入边已 `submitted` 时重交必须显式声明 `true`，否则拒 `GATE_HANDOFF_OVERWRITE_UNDECLARED`（缺省 `false` ⇒ 旧调用零破坏；放行时事件带 `previousAssertions`/`overwrite`/`replaced`，记录侧 `history` 追加旧值快照）"},"officialTaskId":{"type":"string","description":"官方任务板 task id（**M-6 双写未启用**，如实降级 2026-09-18：仅调用方自填的原样回填位，引擎不写、不校验、不判定）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"code":{"type":"string"},"from":{"type":"string"},"to":{"type":"string"},"artifacts":{"type":"array","items":{"type":"string"}},"assertions":{"type":"array","items":{"type":"string"}},"overwrite":{"type":"boolean"},"previousAssertions":{"type":"array","items":{"type":"string"}},"missing":{"type":"array","items":{"type":"string"}},"problems":{"type":"array","items":{"type":"string"}},"lockTransfer":{"type":"object","additionalProperties":true}}},
        render: (_args, value) => value.ok
          ? TEXT_OUTPUT('handoff submitted: ' + value.from + ' -> ' + value.to + ' (' + (value.artifacts ?? []).length + ' artifacts, ' + (value.assertions ?? []).length + ' assertions)')
          : TEXT_OUTPUT('handoff rejected [' + value.code + ']: ' + (value.missing ?? []).join(', ')),
      },
      async execute(args, exec) {
        // 【task-22 裁决 ①】**不落模式门**：`handoff_submit` 归 `comms` 族（成员面）——交接是**生产者的动作**，
        //   引擎侧需要的是**第一手**交接声明（而非 Leader 转写），故与 `swarm_report`/`mailbox_send` 同形：
        //   非生效模式下亦可调用（只受模式门约束的治理写面不在此列）。判定点唯一：entry 门（`gates.ts`）。
        const sessionId = sessionOf(args, exec);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts.filter((p) => typeof p === 'string' && p.trim().length > 0) : [];
        const assertions = Array.isArray(args.assertions) ? args.assertions.filter((a) => typeof a === 'string' && a.trim().length > 0) : [];
        // 产物在场判定（判据同源：相对路径按批次产物根解析）——缺则拒 + 回显**缺哪件产物**（与 entry 门同判据）
        const dir = store.artifactsDirOf(sessionId, args.batchId);
        const missingArtifacts = artifacts.filter((p) => !existsSync(isAbsolute(p) ? p : join(dir, p)));
        // 官方任务板回填位（M-6）**未启用**（2026-09-18 如实降级）：此处只把**调用方自填**的值原样透传给 store
        //   （引擎不写、不校验、不据以判定）；保留透传 = 不破既有调用方与 `store.recordHandoff` 形参面。
        //   「已双写」的读端语义已同步降级（见本工具 `description` / `parameters.officialTaskId`）。
        // R-2 覆盖留痕的**回显面**（成功路径透出，供调用方与审计即时可见；缺省首交 = `false` / `[]`）
        let rOverwrite = false;
        let rPreviousAssertions = [];
        if (missingArtifacts.length === 0) {
          // R-1 调用方身份采集（§2.1 判据链的**输入面**；裁决在 store.recordHandoff = 唯一写路径）
          const callerIdentity = handoffCallerIdentityOf(ctx, exec, args);
          const r = store.recordHandoff(sessionId, args.batchId, {
            from: args.from, to: args.to, artifacts, assertions,
            overwrite: args.overwrite === true, // R-2：缺省 false（真·可选，旧调用零破坏）
            caller: { ...callerIdentity, from: args.from },
            ...(typeof args.officialTaskId === 'string' && args.officialTaskId ? { officialTaskId: args.officialTaskId } : {}),
          });
          if (!r.ok) throw new Error(r.code + ': ' + (r.problems ?? []).join('; ') + (r.missing?.length ? '（缺口：' + r.missing.join(', ') + '）' : ''));
          rOverwrite = r.overwrite === true;
          rPreviousAssertions = Array.isArray(r.previousAssertions) ? r.previousAssertions : [];
        } else {
          // 缺口与拒态**同事件面留痕**（`lane.handoff.gap`）：与 store.recordHandoff 的拒态共用同一码/同一事件，
          //   保证「谁在什么时候因缺哪件产物被拒」在事件流里可核（不静默）。
          store.appendEvent(sessionId, args.batchId, EVT.EVT_LANE_HANDOFF_GAP, {
            lane: args.to, code: 'GATE_HANDOFF_MISSING', missing: missingArtifacts,
            problems: missingArtifacts.map((p) => '交接产物不在场：' + p),
          });
          throw new Error('GATE_HANDOFF_MISSING: 交接产物不在场（' + missingArtifacts.join(', ')
            + '）——请先落盘产物（批次产物根：' + dir + '）再提交交接。');
        }
        // 写权转移（§7 判据③）：`from` 释放 / `to` 获取——与既有 `lane_claim`/`lane_release` **配对耦合**（勿另造锁）。
        //   失败只**降级为 hint**（不抛、不阻塞交接）：锁是运行期并发面、是否持有取决于当前派发方；
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
        // 【task-25 缺陷修复（2026-09-17）】**成功路径的 `code` 必须恒为字符串**——原实现写 `code: null`，
        //   违反本工具自身 `output.schema` 的 `"code":{"type":"string"}` ⇒ 宿主（dsh-tools）抛
        //   `tool "handoff_submit" returned invalid output: "value.code" must be a string`，
        //   而**写入已成功落盘**（随后 `handoff_view` 由 BLOCKED 翻 READY）⇒ **假失败**：调用方据错误
        //   误判失败而重试 ⇒ 重复交接 / 审计噪音（正是本引擎反复强调要避免的「已落盘却报失败」形态）。
        //   修法取「恒为字符串的稳定成功码」（**不放宽 schema**、不掩盖字段缺失）；回归锁 = `test/handoff-gate.test.js` 的 `P1-H8a`。
        return { ok: true, code: 'HANDOFF_OK', from: args.from, to: args.to, artifacts, assertions, overwrite: rOverwrite, previousAssertions: rPreviousAssertions, missing: [], problems: [], lockTransfer };
      },
    }),
    defineTool({
          name: "handoff_view",
      description: "P1 交接门（**只读**）：列出指定 lane 的**入边交接**（M-7 验收核心 = 下游要能稳定取件）——每条入边回显上游 lane、状态（submitted/pending）、交付产物**解析后的绝对路径 + 是否可读（存在性）**、以及上游给出的可核断言 assertions；并给出上游 **produce∪outputs 声明清单**（下游取件面）。`blocking`（阻塞该 lane 开工的缺口，与 entry 门 `GATE_HANDOFF_MISSING` 同判据）与 `pending`（建批期已声明但未提交的入边）分列。存量批（无 `batch.handoffs` 字段）回 `legacy:true`（门整体放行 + 留痕语义）。本工具零写入、不改任何状态。每边回显的 `officialTaskId` 同属**未启用**面（M-6 双写未接线 ⇒ 除非调用方在 `handoff_submit` 自填，恒 `null`），**不得**读作「已双写」。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"下游 lane id"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"legacy":{"type":"boolean"},"ready":{"type":"boolean","required":true},"deps":{"type":"array","items":{"type":"string"}},"edges":{"type":"array","items":{"type":"object","additionalProperties":true}},"pending":{"type":"array","items":{"type":"string"}},"blocking":{"type":"array","items":{"type":"string"}}}},
        // 【task-27 增量】渲染面必须让下游**能照单取件**（M-7 验收核心）：逐条入边显示 `from → status` +
        //   **artifacts 路径清单**（含可读性）+ **assertions**；`pending` 与 BLOCKED 三类缺口
        //   （`edge:…(无交接声明)` / `(未交接)` / `(artifacts 空)` / `contract.assertions@…`）**全部保留**。
        //   原实现只输出 `READY (edges=N)` ⇒ 下游拿不到产物路径（与门态不可见同类的「信息只活在 schema」缺陷）。
        render: (_args, value) => {
          const lines = ['handoff ' + value.lane + ': ' + (value.ready ? 'READY' : 'BLOCKED')
            + ' (edges=' + (value.edges ?? []).length + (value.legacy ? ', legacy-batch' : '') + ')'];
          for (const e of value.edges ?? []) {
            lines.push('  ' + e.from + ' → ' + e.status);
            const arts = e.artifacts ?? [];
            lines.push('    artifacts: ' + (arts.length
              ? arts.map((a) => String(a.path) + (a.readable ? ' (readable)' : ' (MISSING)')).join(', ')
              : '（空）'));
            const asrt = e.assertions ?? [];
            lines.push('    assertions: ' + (asrt.length ? asrt.join(' | ') : '（空）'));
          }
          if ((value.pending ?? []).length) lines.push('  pending: ' + value.pending.join(', '));
          if ((value.blocking ?? []).length) lines.push('  缺口: ' + value.blocking.join(', '));
          return TEXT_OUTPUT(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        const map = (b.handoffs && typeof b.handoffs === 'object' && !Array.isArray(b.handoffs)) ? b.handoffs : null;
        const legacy = map === null;
        const dir = store.artifactsDirOf(sessionId, args.batchId);
        const deps = (() => {
          for (const w of b.wavePlan ?? []) for (const t of w.tasks ?? []) if (t && t.id === args.lane) return Array.isArray(t.deps) ? t.deps : [];
          return [];
        })();
        const edges = deps.map((from) => {
          const t = (() => { for (const w of b.wavePlan ?? []) for (const x of w.tasks ?? []) if (x && x.id === from) return x; return null; })();
          const upstreamDeclared = t ? [...(Array.isArray(t.produce) ? t.produce : []), ...(Array.isArray(t.outputs) ? t.outputs : [])] : [];
          const rec = (map && Array.isArray(map[args.lane])) ? map[args.lane].find((r) => r && r.from === from) ?? null : null;
          // 产物在场判定与 entry 门**同判据**（同一解析规则 + 同一「文件且非空」语义）——下游据此判断**能不能稳定取件**
          const arts = (rec && Array.isArray(rec.artifacts)) ? rec.artifacts : [];
          const artifactViews = arts.map((p) => {
            const abs = isAbsolute(p) ? p : join(dir, p);
            let readable = false;
            try { const st = statSync(abs); readable = st.isFile() && st.size > 0; } catch { readable = false; }
            return { path: p, abs, readable };
          });
          const s = rec ? String(rec.status ?? 'pending') : 'undeclared';
          return {
            from, to: args.lane, status: s,
            artifacts: artifactViews,
            assertions: (rec && rec.contract && Array.isArray(rec.contract.assertions)) ? rec.contract.assertions : [],
            consumedFrom: (rec && rec.contract) ? (rec.contract.consumedFrom ?? null) : null,
            officialTaskId: rec ? (rec.officialTaskId ?? null) : null,
            upstreamDeclared,
            // 缺口明细（与 entry 门 `GATE_HANDOFF_MISSING` 的 missing 同形，便于下游直接照单补齐）
            gap: [
              ...(s === 'undeclared' ? ['edge:' + from + '->' + args.lane + ' (无交接声明)'] : []),
              ...(s === 'pending' ? ['edge:' + from + '->' + args.lane + ' (未交接)'] : []),
              // 三类缺口的第三类（`artifacts 空`）——与门禁侧 `handoffRecordVerdict` 的判据**同形**，
              //   否则取件面与门禁面的缺口清单会漂移（登记：理想是直接复用门函数判定，属后续收口项）
              ...(rec && arts.length === 0 ? ['edge:' + from + '->' + args.lane + ' (artifacts 空)'] : []),
              ...artifactViews.filter((a) => !a.readable).map((a) => a.path + ' (missing)'),
              ...(rec && (!rec.contract || !Array.isArray(rec.contract.assertions) || rec.contract.assertions.length === 0) ? ['contract.assertions@' + from + '->' + args.lane] : []),
            ],
          };
        });
        const blocking = edges.flatMap((e) => e.gap);
        const pending = edges.filter((e) => e.status !== 'submitted').map((e) => e.from + '->' + args.lane);
        // 存量批（无 handoffs 字段）⇒ 门整体放行 ⇒ ready:true + legacy 标记（不静默）
        const ready = legacy ? true : blocking.length === 0;
        return { batchId: args.batchId, lane: args.lane, legacy, ready, deps, edges, pending, blocking };
      },
    }),
  ];
}