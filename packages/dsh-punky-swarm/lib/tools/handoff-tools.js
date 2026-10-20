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
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import * as EVT from '../state/event-types.js';
// 产物声明路径解析单点（WD-3b P7）：逃逸声明按「缺件 / 不可读」处理，不再探到根外
import { resolveArtifactIn } from '../state/batch-paths.js';
import * as lock from '../lock.js';
import { lockPath } from './tier-gate.js';
import { handoffCallerIdentityOf } from './host-surface.js';
import { readCapability } from '../assembly/schema.js'; // 注入预算阈值唯一取值源（注册表 default 缺省合并）
import { applyInjectionBudget } from '../comms/inject-budget.js';

// 面 B · 交接注入：把「断言块」按四层预算收窄（单条目 → 单块），返回收窄后的断言清单与省略事实。
//   固定顺序（分层不合并）：先按 `handoff.assertion` 逐条施加单条目层，再按 `handoff.assertions`
//   对**拼接后的整块**施加单块层（块 = 本入边的断言清单，与渲染面 `asrt.join(' | ')` 同一拼接口径）。
//   未超限 ⇒ 逐条**原值返回**、omissions 为空 ⇒ 渲染面与改动前逐字节一致（零回归）。
//   **本工具不发射事件**（保其「零写入、不改任何状态」docstring）：省略事实只由返回值 omissions[] +
//   文本标记承载——这是刻意的非对称发射取舍（唯一发射点在 `swarm_report`，见 lib/tools/swarm-tools.js）。
function budgetAssertionsOf(assertions, thresholds) {
  const omissions = [];
  if (!Array.isArray(assertions) || assertions.length === 0) return { assertions, omissions };
  // 层①单条目
  const perItem = assertions.map((a) => {
    const r = applyInjectionBudget(a, { surface: 'handoff.assertion', thresholds, kind: 'perItem' });
    omissions.push(...r.omissions);
    return r.text;
  });
  // 层①单块：块 = 本入-edge 的断言拼接（与渲染面同一拼接符，判据同源）
  const joined = perItem.join(' | ');
  const block = applyInjectionBudget(joined, { surface: 'handoff.assertions', thresholds, kind: 'perBlock' });
  omissions.push(...block.omissions);
  if (block.omissions.length === 0) return { assertions: perItem, omissions };
  // 块级触发 ⇒ 块文本已含标记，按同一拼接符还原为清单（渲染面照旧 join，文本不再二次膨胀）
  const piece = block.text.split(' | ');
  return { assertions: piece.length > 0 ? piece : perItem, omissions };
}

export function buildHandoffTools(cx) {
  const { ctx, store, root, config = {}, deps = {} } = cx;
  // 【批 `d-override-fix-20261011` · lane `e4-session-bind`】批归属会话 resolver（注入单点；
  //   缺省 `undefined` ⇒ `sessionOf` 逐字回落原三级路径、零行为变化）。
  const { resolveBatchSession } = deps;
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
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts.filter((p) => typeof p === 'string' && p.trim().length > 0) : [];
        const assertions = Array.isArray(args.assertions) ? args.assertions.filter((a) => typeof a === 'string' && a.trim().length > 0) : [];
        // 产物在场判定（判据同源：相对路径按批次产物根解析）——缺则拒 + 回显**缺哪件产物**（与 entry 门同判据）
        const dir = store.artifactsDirOf(sessionId, args.batchId);
        // 逃逸声明 ⇒ 判缺（`resolveArtifactIn` throw），不再 existsSync 到根外
        const missingArtifacts = artifacts.filter((p) => {
          try { return !existsSync(resolveArtifactIn(dir, p)); } catch { return true; }
        });
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
      description: "P1 交接门（**只读**）：列出指定 lane 的**入边交接**（M-7 验收核心 = 下游要能稳定取件）——**边集合 = 该 lane 的「已声明入边」**（`deps` ∪ 运行期经 `handoff_accept` 声明接受的入边；单点 = 门禁侧同一实现 ⇒ 与 entry/出口门**同源**、读数一致），每条入边回显上游 lane、状态（submitted/pending）、**来源标注 `source`（`deps` = 建批期 `deps` 声明 / `accept` = 运行期下游接受，防审计误读）**、交付产物**解析后的绝对路径 + 是否可读（存在性）**、以及上游给出的可核断言 assertions；并给出上游 **produce∪outputs 声明清单**（下游取件面）。`blocking`（阻塞该 lane 开工的缺口，与 entry 门 `GATE_HANDOFF_MISSING` 同判据）与 `pending`（已声明但未提交的入边）分列。存量批（无 `batch.handoffs` 字段）回 `legacy:true`（门整体放行 + 留痕语义）。本工具零写入、不改任何状态。每边回显的 `officialTaskId` 同属**未启用**面（M-6 双写未接线 ⇒ 除非调用方在 `handoff_submit` 自填，恒 `null`），**不得**读作「已双写」。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"下游 lane id"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"legacy":{"type":"boolean"},"ready":{"type":"boolean","required":true},"deps":{"type":"array","items":{"type":"string"}},"edges":{"type":"array","items":{"type":"object","additionalProperties":true}},"pending":{"type":"array","items":{"type":"string"}},"blocking":{"type":"array","items":{"type":"string"}},"omissions":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        // 【task-27 增量】渲染面必须让下游**能照单取件**（M-7 验收核心）：逐条入边显示 `from → status` +
        //   **artifacts 路径清单**（含可读性）+ **assertions**；`pending` 与 BLOCKED 三类缺口
        //   （`edge:…(无交接声明)` / `(未交接)` / `(artifacts 空)` / `contract.assertions@…`）**全部保留**。
        //   原实现只输出 `READY (edges=N)` ⇒ 下游拿不到产物路径（与门态不可见同类的「信息只活在 schema」缺陷）。
        render: (_args, value) => {
          const lines = ['handoff ' + value.lane + ': ' + (value.ready ? 'READY' : 'BLOCKED')
            + ' (edges=' + (value.edges ?? []).length + (value.legacy ? ', legacy-batch' : '') + ')'];
          for (const e of value.edges ?? []) {
            // 【G-10 · e3-toolface】边来源**显式标注**：`deps` = 建批期声明；`accept` = 运行期下游经
            //   `handoff_accept` 声明接受的后置上游（修前这一类边在视图不可见，且无来源可辨 ⇒ 审计误读）。
            lines.push('  ' + e.from + ' → ' + e.status + '  [source=' + (e.source ?? 'deps') + ']');
            const arts = e.artifacts ?? [];
            lines.push('    artifacts: ' + (arts.length
              ? arts.map((a) => String(a.path) + (a.readable ? ' (readable)' : ' (MISSING)')).join(', ')
              : '（空）'));
            const asrt = e.assertions ?? [];
            lines.push('    assertions: ' + (asrt.length ? asrt.join(' | ') : '（空）'));
          }
          if ((value.pending ?? []).length) lines.push('  pending: ' + value.pending.join(', '));
          if ((value.blocking ?? []).length) lines.push('  缺口: ' + value.blocking.join(', '));
          // 省略事实（面 B）在渲染面**显式回显**：注入文本已自带标记，此处再落一行汇总，
          //   使「哪个面省略了多少」不必反解标记即可读（本工具零写入 ⇒ 事件面不承载，见文件头）。
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
        const deps = (() => {
          for (const w of b.wavePlan ?? []) for (const t of w.tasks ?? []) if (t && t.id === args.lane) return Array.isArray(t.deps) ? t.deps : [];
          return [];
        })();
        // 【G-10 修复 · lane `e3-toolface`】边集合**改取门禁侧同一单点**（红线 C-4 单点判定）：
        //   修前 `edges` **只由 `deps` 生成** ⇒ 运行期经 `handoff_accept` 声明的入边（`source:'accept'`）
        //   在视图**结构性不可见**（实测：门禁 2 边 vs 视图 1 边、`blocking:[]`、`ready:true` —— `L-AC-9` fail）。
        //   本处取 `store.declaredInboundEdgesOf` = `lib/state/gates/helpers.ts#declaredInboundEdgesOf` 的
        //   **同一函数实例**（经 `lib/state/gates.ts` 单点透出）⇒ 视图与门禁**同源**；**禁**在此另合成一套口径。
        //   零回归：`handoffs` 缺失 / 无 accept 边 ⇒ 集合与 `deps` 逐字相同（仅多一个 `source` 标注键）。
        const laneTask = (() => {
          for (const w of b.wavePlan ?? []) for (const t of w.tasks ?? []) if (t && t.id === args.lane) return t;
          return null;
        })();
        const declared = store.declaredInboundEdgesOf(b, args.lane, laneTask);
        const sourceOf = new Map((declared.sources ?? []).map((s) => [s.from, s.source]));
        const edges = declared.edges.map((from) => {
          const t = (() => { for (const w of b.wavePlan ?? []) for (const x of w.tasks ?? []) if (x && x.id === from) return x; return null; })();
          const upstreamDeclared = t ? [...(Array.isArray(t.produce) ? t.produce : []), ...(Array.isArray(t.outputs) ? t.outputs : [])] : [];
          const rec = (map && Array.isArray(map[args.lane])) ? map[args.lane].find((r) => r && r.from === from) ?? null : null;
          // 产物在场判定与 entry 门**同判据**（同一解析规则 + 同一「文件且非空」语义）——下游据此判断**能不能稳定取件**
          const arts = (rec && Array.isArray(rec.artifacts)) ? rec.artifacts : [];
          const artifactViews = arts.map((p) => {
            // 逃逸声明 ⇒ abs:null / readable:false（不探根外；R-4 声明期口径）
            let abs = null;
            let readable = false;
            try {
              abs = resolveArtifactIn(dir, p);
              const st = statSync(abs); readable = st.isFile() && st.size > 0;
            } catch { abs = null; readable = false; }
            return { path: p, abs, readable };
          });
          const s = rec ? String(rec.status ?? 'pending') : 'undeclared';
          return {
            from, to: args.lane, status: s,
            // 边来源**显式标注**（`L-AC-9`：declare/accept ≠ 建批期 `deps`，防审计误读）——
            //   与门禁同源产出（单点的 `sources`），非本处自判。
            source: sourceOf.get(from) ?? null,
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
        // 面 B · 交接注入预算（阈值唯一取值源 = capabilities.injectBudget；缺省合并注册表 default）。
        //   只作用于**注入面文本**（渲染面读到的 assertions）：不回写 batch.handoffs、不触任何产物文件。
        //   本工具**不发射事件**（保 zero-write docstring）⇒ 省略事实只走返回值 omissions[] + 文本标记。
        const injectCfg = readCapability(config, 'injectBudget');
        if (injectCfg?.enabled === true) {
          const omissions = [];
          for (const e of edges) {
            const bud = budgetAssertionsOf(e.assertions, injectCfg);
            e.assertions = bud.assertions;
            omissions.push(...bud.omissions);
          }
          return { batchId: args.batchId, lane: args.lane, legacy, ready, deps, edges, pending, blocking, omissions };
        }
        return { batchId: args.batchId, lane: args.lane, legacy, ready, deps, edges, pending, blocking, omissions: [] };
      },
    }),
    // ── 【G-10 · 批 `g10-fix-20261012` · lane `e4-toolface`】**受限反向声明**工具面 ──────────────────
    // 定位（判据源 `plan/scope.md` R-1/R-5 + `plan/design.md` §A.2 推荐候选 ②；用户裁决 Q-H1）：
    //   `handoff_submit` 的入边声明**唯一**来源原是建批期 `deps` 播种 ⇒ **批运行中追加的 lane（后置 lane）**
    //   结构性拿不到声明位（它恒落声明序末尾，不可能成为既有下游的 `deps`）⇒ 其产物进不了既有 audit lane
    //   的取件面，且缺口**不转红**（出口门无对象 = 静默本体）。本工具 = 该声明的**运行期补位**，方向与
    //   「放宽校验」相反：**净收紧**（补一条声明 ⇒ `from` 多一条**必须交**的义务，缺交即转红）。
    //
    // 三件事逐条对齐（**本工具不实现任何判据，只做透传**——判定单点 = `lib/state/store/handoff-accept.js`）：
    //   · 写方 = **下游**（消费方）：「我要不要等这条上游」天然属消费方；且**不跨 lane 改他人声明面**
    //     （不写 `to.consume`、不改任何任务字段、**不写 `deps`**）。
    //   · 单次原子写：`handoffs[to]` 追加一条与建批期**同形态**的 `pending` 条 + `plan.mutated{accepts}`
    //     留痕 + `planRevision+1`（既有事件类，**不新造**）。
    //   · 受限开面 S-a..S-e（`to.layer==='audit'` 且已声明 / `from` 必须是 `plan.mutated.added[]` 的后置 lane /
    //     声明序 `orderOf(from)<orderOf(to)` / 存量批拒 / 批或成员终态拒）+ **幂等**（已声明 ⇒ 零写入）。
    //
    // 形态对照（**与 `handoff_submit` 同族同形**，勿另立族）：
    //   `kind:'comms'` + `modeGate:false`（交接是生产/消费方成员的动作，非治理相位写面 ⇒ **不落**
    //   `assertModeActive`；且守不变量 `modeGate ⊆ memberDeny`）+ `memberDeny:false`（**成员可调用** ——
    //   下游 lane 的声明动作正是本通道存在的理由）+ `write:true`（写黑板真源 + 落事件）。
    //
    // 拒态口径（红线 C-6：**不新造 `GATE_*` 拒码**）：参数/前置/终态类拒绝由 store 抛**普通 `Error`**
    //   （与 `plan-mutate.js` 同纪律；唯一例外 = 批终态复用既有 `GATE_BATCH_TERMINAL`）。本工具**不改写**
    //   该文本、**不新增**码 —— 把它结构化回显为 `ok:false` + `code`（有前缀者取前缀，否则 `HANDOFF_ACCEPT_REJECTED`）
    //   + `rejected`（**逐字原文**，供调用方与审计直读根因），并同时 `throw`（与 `handoff_submit` 同契约：
    //   拒态**不得**被读成成功；`handoff_submit` 亦为 `throw`）。
    //
    // 零写入保证：全部拒绝路径都在 store 的任何写盘之前返回 ⇒ 拒后 `planRevision` 不变、`handoffs` 不留条
    //   （e2-g10 已实测，本 lane 复验）。
    defineTool({
      name: "handoff_accept",
      description: "P1 交接门（**受限反向声明** · G-10）：**下游 lane** 声明「接受」某条**批运行中追加的后置 lane**作为自己的入边（写方 = 消费方）。修前该边**无声明位**：建批期 `deps` 播种是入边声明的唯一来源，而后置 lane 恒落声明序末尾 ⇒ 它结构性不可能成为既有下游的 `deps` ⇒ 产物进不了下游取件面，且缺口**不转红**（出口门无对象 = 静默）。本工具在**被允许的地方**（下游自己的入边表 `batch.handoffs[to]`）补一条与建批期**同形态**的 `pending` 声明条 —— 方向与「放宽校验」相反，是**净收紧**：声明一旦存在，`from` 就**必须交**，缺交即拒 `GATE_HANDOFF_MISSING` + 落 `lane.handoff.gap`（不再静默）。**不写 `deps`**、不动 `wavePlan`/`waves`/`orderOf`（拓扑真源零变更）。入参 `from`（上游 ＝ 必须是批事件 `plan.mutated.added[]` 里的后置 lane）/`to`（下游 ＝ 必须是**已声明**且 `layer === 'audit'` 的 lane，首版只开 audit 面）/`reason`/`author`（留痕标签）。受限开面（逐条独立成立，全部拒绝均**零写入**）：`to` 非 audit 层 ⇒ 拒；`from` 非后置 lane ⇒ 拒（建批期已存在的 lane 请走建批期 `deps` 路径，勿当通用补边工具）；声明序 `orderOf(from) < orderOf(to)` 不成立 ⇒ 拒；存量批（无 `batch.handoffs`）⇒ 拒；批终态 / `from` 或 `to` 成员终态 ⇒ 拒。**幂等**：该边已被声明（无论来源面）⇒ 回既有条目、**零写入**（不重复落事件、不递增 `planRevision`）。审计留痕：成功路径**必落** `plan.mutated{accepts:[{from,to}],reason,author,revision}` + `planRevision+1`（既有事件类，**不新造**）。**不新造 `GATE_*` 拒码**（红线 C-6）：参数/前置/终态类拒绝为**无前缀普通 `Error`**（唯一例外 = 批终态复用既有 `GATE_BATCH_TERMINAL`）；门禁侧缺交复用既有 `GATE_HANDOFF_MISSING`（**不由本工具抛**）。",
      parameters: {"batchId":{"type":"string","required":true},"from":{"type":"string","required":true,"description":"上游 lane id（**必须是**批事件 `plan.mutated.added[]` 里出现过的批运行中追加的**后置 lane**；建批期即存在的 lane 会被拒）"},"to":{"type":"string","required":true,"description":"下游 lane id（**必须是**批次内已声明、且 `layer === 'audit'` 的 lane；首版只开 audit 面）"},"reason":{"type":"string","description":"声明理由（留痕标签，落 `plan.mutated.reason`）"},"author":{"type":"string","description":"声明作者（留痕标签，落 `plan.mutated.author`；缺省 = 调用方身份面解析）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"code":{"type":"string","required":true},"idempotent":{"type":"boolean"},"from":{"type":"string"},"to":{"type":"string"},"revision":{"type":"number"},"record":{"type":"object","additionalProperties":true},"rejected":{"type":"string"}}},
        // 渲染面（**拒态不静默、成功可归因**）：成功路径回 `HANDOFF_ACCEPT_OK` + `planRevision` 前后值 +
        //   是否幂等；拒态回**逐字根因**（`rejected`，非仅「失败」二字）⇒ 调用方据此区分「哪一条受限面被撞」。
        render: (_args, value) => value.ok
          ? TEXT_OUTPUT('handoff accepted [' + value.code + ']: ' + value.from + ' -> ' + value.to
            + ' (planRevision=' + (value.idempotent ? value.revision : (Number(value.revision) - 1) + '->' + value.revision)
            + (value.idempotent ? ', idempotent: 该边已声明 ⇒ 零写入' : '') + ')')
          : TEXT_OUTPUT('handoff accept rejected [' + value.code + ']: ' + (value.rejected ?? '')),
      },
      async execute(args, exec) {
        // **不落模式门**（`kind:'comms'`，同 `handoff_submit`）：声明动作是**消费方成员**的动作，
        //   引擎侧需要的是**第一手**声明（而非 Leader 转写）；判定点唯一 = store 的受限开面（S-a..S-e）。
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId);
        // 作者留痕：调用方自填优先（与 `handoff_submit` 的 `officialTaskId` 同形 = 自填位原样透传），
        //   缺省回落既有身份面单点（`handoffCallerIdentityOf`，**不另造**身份解析）。
        const author = (typeof args.author === 'string' && args.author.trim().length)
          ? args.author.trim()
          : (handoffCallerIdentityOf(ctx, exec, args).sessionId ?? null);
        let r;
        try {
          r = store.recordHandoffAccept(sessionId, args.batchId, {
            from: args.from, to: args.to, reason: args.reason ?? null, author,
          });
        } catch (e) {
          // 拒态：把 store 的**逐字根因**结构化回显（`code` 有 `GATE_` 前缀者取前缀，否则用本工具的
          //   非 `GATE_` 稳定码 —— 守 C-6「不新造 `GATE_*`」），同时 `throw`（与 `handoff_submit` 同契约）。
          const msg = String(e?.message ?? e);
          const gate = /^(GATE_[A-Z0-9_]+)/.exec(msg);
          throw Object.assign(new Error(msg), {
            ok: false, code: gate ? gate[1] : 'HANDOFF_ACCEPT_REJECTED', from: args.from, to: args.to, rejected: msg,
          });
        }
        return {
          ok: true,
          // 成功码恒为字符串（**同 `handoff_submit` 的 task-25 教训**：`code:null` 会被宿主 output.schema
          //   判为非法输出 ⇒「写入已落盘却报失败 ⇒ 调用方重试」的假失败形态）。
          code: 'HANDOFF_ACCEPT_OK',
          idempotent: r.idempotent === true,
          from: r.from, to: r.to, revision: r.revision, record: r.record ?? null,
        };
      },
    }),
  ];
}