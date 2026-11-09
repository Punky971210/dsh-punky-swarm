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

// 只读查询投影工具面（自 `lib/tools/core.js` **原样搬移**）：batch_status / gate_status。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf, sessionOfResolved } from './shared.js';
import { readLiveConfig } from './tier-gate.js';
import { handoffGateStateOf } from '../wave-plan.js';
//   否则「同一 lane 的 state」会在工具面与探针面分裂（U-5 边界；依赖方向单向：core → watch，无环）。
import { laneStateOf, isDanglingLane } from '../state/lane-state.js';
import * as EVT from '../state/event-types.js';
import { renderRoleGuide, resolveRoleRef, ROLE_UNRESOLVED_CODE, renderPreflightBlock, composeWorkerPrompt } from '../engine/dispatch.js';
//   **不 re-export**）⇒ 必须从真源取，从 `dispatch.js` 取会得 `undefined`（调用期 TypeError）。
import { renderArchContext } from '../engine/arch-context.js';
//   `role_guide` 与引擎自派路径必须过**同一份** `capabilities.injectBudget`（同一取值单点
import { readCapability } from '../assembly/schema.js';

/** 多批读面缺省条数上限（语义见 `batch_status` 的 `limit` 参数说明）。传 0 才表示不限。 */
const BATCH_LIST_LIMIT_DEFAULT = 50;

export function buildBatchStatusTools(cx) {
  const { ctx, deps, store } = cx;
  const { resolveBatchSession } = deps;
  return [
    defineTool({
      name: "batch_status",
      description: "查询批次状态（唯一事实源）：phase/lanes/wavePlan/事件摘要 + 派生视图 lanesState（lane→成员态）/danglingLanes（批次已终态而成员非终态的 lane，恒显）。不传 batchId 则列当前会话全部批次，可用 session 指定会话。**未解析到调用方会话（如 MCP 直连）⇒ 列全部会话，每批带 sessionId（顶层 sessionScope:'all'）；显式 session 仍优先（sessionScope:'session'）。**运行期 DAG 真源 = 批次 lanes[].deps + handoffs（逐边取件见 handoff_view），chain 回显只是建批期投影，不是运行期真源。读面裁剪参数 view ∈ summary|active|full，**缺省 full**（不裁剪，返回体与不传该参数时逐字一致）：active 只裁 wavePlan（只保留 status 不属于 merged/failed/skipped 的 lane 对应任务；过滤后为空的波条目丢弃、wave 序号不重编号），lanes/lanesState/danglingLanes/eventCount/settled/handoffGate/recentEvents 一律不动；summary 本批等价 full（不引入第三语义）；非法值（空串 / 大小写不符 / 非字符串等）回落 full 且不抛错。生效视图经返回体 viewApplied（'full'|'active'）回显 —— 回显生效值而非请求值，裁剪视图不冒充全量事实源；view 仅作用于单批投影（多批列表读面不含 wavePlan）。**多批读面按「最近活跃」降序（批文件 mtime）且受 limit 约束**：缺省 50（MCP 直连不会主动传 limit，而 511 批全量投影既慢又撑爆消费方上下文），传 0 = 不限；`ids` / `batchId` 显式点名不受限。total 恒回显裁剪前总数、limitApplied 回显生效上限（0 = 未裁剪）——裁剪不冒充全量。",
      parameters: {"batchId":{"type":"string","description":"批次 ID；缺省时列出该会话全部"},"ids":{"type":"array","items":{"type":"string"},"description":"批量读面：给批次 ID 清单时只读这些批（≥2 件不扫目录），恰 1 件透传；与 batchId 同给时 batchId 优先"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"},"limit":{"type":"integer","description":"多批读面条数上限（只作用于「列全部」的两条分支：全会话并集 / 单会话列表）：缺省 50，按批文件 mtime 降序取最近活跃的前 N 件；传 0 = 不限（全量，成本随批数线性增长，511 批实测约 770ms）；`ids` / `batchId` 显式点名不受限（点名即全给）。负数回落缺省 50；小数 / 字符串 / null 等非整数由宿主参数校验直接拒绝（`INVALID_ARGS`）—— 两者都不静默当作「不限」，也不静默截断成 0 件。生效上限经返回体 limitApplied 回显（0 = 未裁剪），裁剪前总数经 total 回显 —— 裁剪不冒充全量。"},"view":{"type":"json","description":"读面裁剪视图，三枚举 summary|active|full，**缺省 full**（不裁剪：返回体与不传该参数时逐字一致，零回归）。active 只裁 wavePlan —— 只保留 status 不属于 merged/failed/skipped 的 lane 对应任务（任务 id 不在 lanes 表内视为非终态、保留），过滤后为空的波条目丢弃、wave 序号不重编号；lanes/lanesState/danglingLanes/eventCount/settled/handoffGate/recentEvents 一律不动。summary 本批等价 full（不引入第三语义）。**非法值回落 full 且不抛错**（空串 / 大小写不符 / null / 数字 / 对象等），生效视图经返回体 viewApplied（'full'|'active'）回显 —— 回显生效值而非请求值，裁剪视图不冒充全量事实源。view 仅作用于单批投影（多批列表读面不含 wavePlan，故其返回体不回显 viewApplied）。"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"phase":{"type":"string"},"concurrency":{"type":"integer"},"lanes":{"type":"object","additionalProperties":true},"lanesState":{"type":"object","additionalProperties":true},"danglingLanes":{"type":"array","items":{"type":"string"}},"wavePlan":{"type":"array","items":{"type":"object","additionalProperties":true}},"smoke":{"type":"boolean"},"eventCount":{"type":"integer"},"recentEvents":{"type":"array","items":{"type":"object","additionalProperties":true}},"settled":{"type":"boolean"},"sessionId":{"type":"string"},"sessionScope":{"type":"string"},"total":{"type":"integer"},"limitApplied":{"type":"integer"},"batches":{"type":"array","items":{"type":"object","additionalProperties":true}},"stateSource":{"type":"string"},"memberStatesLegacy":{"type":"boolean"},"handoffGate":{"type":"object","additionalProperties":true},"viewApplied":{"type":"string"}}},
        render: (_args, value) => {
          const hg = value.handoffGate ?? null;
          const hgTxt = hg ? ' handoffGate=entry:' + (hg.entry === 'enforced' ? 'on' : 'off') + '/settle:' + (hg.settle === 'enforced' ? 'on' : 'off') + '(src:' + String(hg.source ?? 'default') + ')' : '';
          const stateTxt = value.stateSource ? ' state=' + String(value.stateSource) + (value.memberStatesLegacy ? '(legacy)' : '') : '';
          if (value.batchId) {
            return TEXT_OUTPUT('batch ' + value.batchId + ' phase=' + value.phase + ' settled=' + value.settled + (value.smoke ? ' SMOKE(产物契约类门豁免)' : '') + stateTxt + hgTxt + ((value.danglingLanes ?? []).length ? ' ⚠ dangling=' + value.danglingLanes.length : ''));
          }
          // 裁剪必须可见：`50/511 (最近活跃, limit=50)` 读作「盘上共 511 件，这里是最近活跃前 50」，
          //   不与「真的只有 50 件」混淆（与单批视图 `viewApplied` 同一纪律：裁剪不冒充全量）。
          const shown = (value.batches ?? []).length;
          const clipped = typeof value.total === 'number' && value.total > shown;
          const totalTxt = clipped ? '/' + value.total + ' (最近活跃, limit=' + value.limitApplied + ')' : '';
          return TEXT_OUTPUT('batches: ' + shown + totalTxt + stateTxt + hgTxt);
        },
      },
      async execute(args, exec) {
        // 【B-1/B-2 · 会话可见性】回落来源单点化：`source === 'fallback'` 才把「列表读面」升级为全会话。
        //   显式 `args.session`（`source==='arg'`）仍是**首行短路**的最高优先级（C-9，AC-12 反向锁）；
        //   `bound`（派发绑定）/`agent`（宿主内调用）两态行为与改前逐字相同。
        const resolved = sessionOfResolved(args, exec, resolveBatchSession);
        const sessionId = resolved.sessionId;
        const derivedOf = (b) => {
          const laneIds = Object.keys(b.lanes ?? {});
          const lanesState = {};
          for (const l of laneIds) lanesState[l] = laneStateOf(b, l);
          return { lanesState, danglingLanes: laneIds.filter((l) => isDanglingLane(b, l)) };
        };
        const smokeOf = (b) => (b?.events ?? []).some((e) => e && e.type === EVT.EVT_BATCH_SMOKE);
        //    （改了会把「服务不可用」与「非成员」压成同一形态，降级不可辨）。
        //    （`runtime|env|default`）；渲染面同样显示（缺省关是策略、**不得隐形**）。
        // 输出面的「这个字段是哪来的」自述：engine = 引擎状态机为真源；memberStatesLegacy = 成员态仍是引擎内置闭集
  //   （曾以 `MERGE_STATE_SOURCE` / `MEMBER_STATES_LEGACY` 两个常量导出承载，实为恒等映射与恒真布尔 ⇒ 内联）
  const stateAnnotation = { stateSource: 'engine', memberStatesLegacy: true };
        // 【B-2 · 唯一一份列表投影】单会话列表与「全会话并集」共用本函数 ⇒ 两处元素形状**逐字段相等**
        //   （AC-10 判据「同一投影，不造第二套」由此结构性成立，不靠两个分支各写一遍）。
        //   `sessionIdOfBatch`：单会话路径 = 本次解析出的会话（与改前逐字相同）；并集路径 = 该批**自身**所属会话。
        const listProjection = (b, sessionIdOfBatch, batchIdOfBatch) => ({
          batchId: batchIdOfBatch, sessionId: sessionIdOfBatch, phase: b.phase, lanes: b.lanes,
          ...derivedOf(b), ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation,
        });
        const hgState = handoffGateStateOf(readLiveConfig(deps));
        const handoffGateView = {
          enabled: hgState.entry || hgState.settle,
          entry: hgState.entry ? 'enforced' : 'observation',
          settle: hgState.settle ? 'enforced' : 'observation',
          source: hgState.source,
        };
        // 【B-2 列表分支边界（AC-11）】`source==='fallback'` **且**无 `batchId` ⇒ 全会话并集：
        //   · `ids` 语义 = 「在全部会话里找这些 id」，`ids: []` 仍等同缺省（列全部，同 Q2A-4 口径）；
        //   · 顶层 `sessionScope:'all'` 是**唯一判别位**（此时 `sessionId` 仍回显哨兵 `'cli'`，不代表读面范围）；
        //   · `batchId` 分支**不进这里**（见下方单批路径）——避免把一次 typing 错误放大成跨会话存在性探测。
        //   · `view` 不参与：多批列表读面本就不含 `wavePlan`（与既有口径一致）。
        // 【A 项 · 多批读面预算】`limit` 只作用于「列全部」的两条分支（全会话并集 / 单会话列表）：
        //   `ids` 与 `batchId` 是**显式点名** ⇒ 不受限（裁剪会把「我要的这几件」静默变成「其中一部分」）。
        //   缺省 50：MCP 直连（Claude Desktop 等）不会主动传 limit，而 511 批全量投影既慢又撑爆消费方上下文。
        //   负数（合法整数但语义非法）回落缺省、不抛错；小数 / 字符串 / null 到不了这里 ——
        //   宿主 `dsh-tools` 的参数校验先以 `INVALID_ARGS` 拒掉（实测，见 L-5 测试）。
        //   ⇒ 两个「非法」入口都必须收口到「可见的默认预算」，不得静默变成「不限」或「0 件」。
        const limitOf = (raw) => (Number.isInteger(raw) && raw >= 0 ? raw : BATCH_LIST_LIMIT_DEFAULT);
        if (resolved.source === 'fallback' && !args.batchId) {
          const wantIds = Array.isArray(args.ids) && args.ids.length > 0 ? new Set(args.ids) : null;
          if (wantIds) {
            // 显式 id 清单：在**全部会话**里找这些 id（不排序、不裁剪 —— 点名即全给；Q2A-2/AC-10 口径不变）
            const batches = [];
            for (const own of store.listAllBatches()) {
              if (!wantIds.has(own.batchId)) continue;
              const b = store.readBatch(own.sessionId, own.batchId);
              if (b) batches.push(listProjection(b, own.sessionId, own.batchId));
            }
            return { sessionId, batches, total: batches.length, limitApplied: 0, ...stateAnnotation, handoffGate: handoffGateView, sessionScope: 'all' };
          }
          const limit = limitOf(args.limit);
          const { total, items } = store.recentBatches({ limit });
          const batches = [];
          for (const own of items) {
            const b = store.readBatch(own.sessionId, own.batchId);
            if (b) batches.push(listProjection(b, own.sessionId, own.batchId));
          }
          return { sessionId, batches, total, limitApplied: limit, ...stateAnnotation, handoffGate: handoffGateView, sessionScope: 'all' };
        }
        if (!args.batchId && Array.isArray(args.ids) && args.ids.length > 0) {
          const map = store.readBatchMap(sessionId, args.ids);
          return { sessionId, batches: [...map].map(([id, b]) => listProjection(b, sessionId, id)), total: map.size, limitApplied: 0, ...stateAnnotation, handoffGate: handoffGateView, sessionScope: 'session' };
        }
        if (!args.batchId) {
          const limit = limitOf(args.limit);
          const { total, items } = store.recentBatches({ sessionId, limit });
          const batches = [];
          for (const own of items) {
            const b = store.readBatch(sessionId, own.batchId);
            if (b) batches.push(listProjection(b, sessionId, own.batchId));
          }
          return { sessionId, batches, total, limitApplied: limit, ...stateAnnotation, handoffGate: handoffGateView, sessionScope: 'session' };
        }
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
        const VIEW_TERMINAL = new Set(['merged', 'failed', 'skipped']);
        const viewAppliedOf = (requested) => (requested === 'active' ? 'active' : 'full');
        const wavePlanOf = (batch, applied) => {
          if (applied !== 'active') return batch.wavePlan;
          const keepTask = (t) => !VIEW_TERMINAL.has(batch?.lanes?.[t?.id]);
          return (Array.isArray(batch.wavePlan) ? batch.wavePlan : [])
            .map((w) => ({ ...w, tasks: (Array.isArray(w?.tasks) ? w.tasks : []).filter(keepTask) }))
            .filter((w) => w.tasks.length > 0);
        };
        const viewApplied = viewAppliedOf(args.view);
        return { batchId: b.batchId, sessionId, phase: b.phase, concurrency: b.concurrency, lanes: b.lanes, ...derivedOf(b), wavePlan: wavePlanOf(b, viewApplied), ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation, handoffGate: handoffGateView, eventCount: b.events.length, recentEvents: b.events.slice(-20), settled: store.batchSettled(b), viewApplied, sessionScope: 'session' };
      },
    }),
  ];
}

export function buildGateTools(cx) {
  const { store, deps } = cx;
  const { resolveBatchSession } = deps;
  return [
    defineTool({
      name: "gate_status",
      description: "查询批次/lane 的门禁状态：layer、consume/produce/outputs 缺失清单、plan 契约问题，以及批次级装配声明。不传 lane 时按全部 lane 逐个投影；对不在 wavePlan.tasks 内的 lane id 返回 gates:'orphan'（layer:null），该读数是损坏/悬空 lane 的显式标记。本工具不定义批级聚合（批级汇总读 batch_status）。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","description":"lane ID；缺省列出全部"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"lanes":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"assembly":{"type":"object","additionalProperties":true}}},
        render: (_args, value) => TEXT_OUTPUT('gate status: ' + value.lanes.length + ' lane(s)' + (value.assembly ? ' · assembly' : '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        const batch = store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const extras = {
          ...(batch.assembly ? { assembly: batch.assembly } : {}),
        };
        if (args.lane) {
          return { batchId: args.batchId, sessionId, lanes: [store.gateStatus(sessionId, args.batchId, args.lane)], ...extras };
        }
        const viewOfLane = store.gateStatusMapOfBatch(sessionId, args.batchId);
        return { batchId: args.batchId, sessionId, lanes: Object.keys(batch.lanes).map((l) => viewOfLane[l]), ...extras };
      },
    }),
  ];
}

/**
 * ## 为什么需要它
 */
export function buildTaskpackTools(cx) {
  const { ctx, deps, store } = cx;
  const { resolveBatchSession } = deps;
  return [
    defineTool({
      name: "taskpack_for",
      description: "取某 lane 的**完整任务包**（D 档派发专用取件口）。从批次黑板读该 lane 的 role/cmd/契约/产物/检查点，调引擎自派路径的**同一渲染函数** `composeWorkerPrompt` 生成 ⇒ 与 C 档任务包逐字同源。返回 text（可直接作 `spawn_teammate` 的 prompt）与 fields（结构化核对用）。只读、零副作用。⚠ 若该 lane 尚无 `owner`/未派发，仍可取件（用于预演）；lane 不存在则报错。",
      parameters: {
        "batchId": { "type": "string", "required": true, "description": "批次 ID" },
        "lane": { "type": "string", "required": true, "description": "lane id（须存在于该批 wavePlan）" },
        "leaderPrompt": { "type": "string", "description": "Leader 的任务要点（可选；D 档取件时若已想好可一并传入，未给则渲染缺省）" },
        "session": { "type": "string", "description": "批次归属会话（缺省=当前执行会话）" },
      },
      output: {
        schema: {
          "type": "object", "additionalProperties": false, "properties": {
            "batchId": { "type": "string", "required": true },
            "lane": { "type": "string", "required": true },
            "role": { "type": "string", "required": true },
            "layer": { "type": "string" },
            "text": { "type": "string", "required": true },
            "fields": { "type": "object", "additionalProperties": true, "required": true },
          },
        },
        render: (_args, value) => TEXT_OUTPUT('taskpack_for ' + value.batchId + '/' + value.lane
          + ' role=' + value.role + ' (' + String(value.text ?? '').split('\n').length + ' 行)'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        const batchId = args?.batchId;
        const lane = args?.lane;
        if (typeof batchId !== 'string' || batchId.trim() === '') throw new Error('taskpack_for: `batchId` 必填');
        if (typeof lane !== 'string' || lane.trim() === '') throw new Error('taskpack_for: `lane` 必填');
        const b = store.readBatch(sessionId, batchId);
        if (!b) throw new Error('taskpack_for: batch not found: ' + batchId);
        // lane 定位：`wavePlan` 存的是 **wave 数组**（`[{wave, tasks:[…]}]`）⇒ 必须 flatMap
        const flat = (Array.isArray(b.wavePlan) ? b.wavePlan : [])
          .flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
        const laneTask = flat.find((t) => t && t.id === lane) ?? null;
        if (!laneTask) {
          throw new Error('taskpack_for: lane "' + lane + '" 不在批 ' + batchId
            + ' 的 wavePlan 内（现有：' + flat.map((t) => String(t?.id)).join(' / ') + '）');
        }
        const roleData = resolveRoleRef(laneTask.role, { team: b.team ?? undefined });
        const text = composeWorkerPrompt({
          batchId, lane, cmd: laneTask.cmd, layer: laneTask.layer, role: roleData,
          consume: laneTask.consume ?? [], produce: laneTask.produce ?? [], outputs: laneTask.outputs ?? [],
          firstLine: undefined,
          leaderPrompt: typeof args?.leaderPrompt === 'string' ? args.leaderPrompt : '',
          artifactsRoot: store.artifactsDirOf(sessionId, batchId),
          batchSessionId: sessionId,
          singleArtifactWrite: laneTask.singleArtifactWrite === true,
          injectBudget: readCapability(readLiveConfig(deps), 'injectBudget'),
          archContext: renderArchContext({ targets: laneTask.targets ?? null }),
          //   `composeWorkerPrompt`）⇒ 本参数必须一并透传，否则同一 lane 在两档的任务包会不一致。
          context: laneTask.context ?? null,
          preflight: laneTask.preflight ?? null,
          checkpoints: laneTask.checkpoints ?? null,
          resume: laneTask.resume === true,
          logger: ctx?.logger ?? null,
        });
        return {
          batchId, lane,
          role: String(laneTask.role ?? ''),
          layer: laneTask.layer ?? null,
          text,
          fields: {
            cmd: laneTask.cmd ?? null,
            consume: laneTask.consume ?? [],
            produce: laneTask.produce ?? [],
            outputs: laneTask.outputs ?? [],
            hasCheckpoints: laneTask.checkpoints != null,
            checkpoints: laneTask.checkpoints ?? null,
            context: laneTask.context ?? null,
            preflight: laneTask.preflight ?? null,
            resume: laneTask.resume === true,
            targets: laneTask.targets ?? null,
            singleArtifactWrite: laneTask.singleArtifactWrite === true,
          },
        };
      },
    }),
  ];
}

export function buildRoleGuideTools(cx) { // eslint-disable-line no-unused-vars -- 本批起 `cx.deps` 用于 injectBudget 阈值同源（见 execute）；其余字段仍由 register 侧统一注入
  const { deps } = cx ?? {};
  return [
    defineTool({
      name: "role_guide",
      description: "取某个 role 的已渲染三段（职责 / 授权 / 交付要求），供 Leader 自写任务包时取件拼装，不得手抄；渲染色与引擎自派任务包内同一 role 三段逐字一致。role 缺失/非字符串/空串/纯空白或零命中一律报错，不静默返回空串。传 preflight ⇒ 返回值多出 preflight 字段（开工前必做四段，可直接粘进任务包）；不传则返回键集不变。只读、零副作用。",
      parameters: {
        "role": {"type":"string","required":true,"description":"role id（如 coordinator / coder）；不得传对象"},
        "team": {"type":"string","description":"限定团队目录；缺省按既有团队序（software-team 优先，余按字典序）"},
        "preflight": {"type":"object","additionalProperties":false,"description":"开工前必做四段声明（可选）：传 ⇒ 返回值多 preflight 字段；四段 kb / skills / mcp / checklist","properties":{
          "kb":{"type":"array","items":{"type":"string"},"description":"知识库关键词（2-3 个，可直接粘进 weknora_search）"},
          "skills":{"type":"array","items":{"type":"string"},"description":"技能确切名（不是「相关技能」）"},
          "mcp":{"type":"array","description":"MCP 工具 + 用途","items":{"type":"object","additionalProperties":false,"properties":{"tool":{"type":"string","required":true},"why":{"type":"string","description":"拿它干什么（缺 ⇒ 渲染「（用途未声明）」）"}}}},
          "checklist":{"type":"array","items":{"type":"string"},"description":"本任务相关检查表条目（内联）"}
        }}
      },
      output: {
        //   `additionalProperties` 在 object 节点**必须显式给布尔**。
        schema: {"type":"object","additionalProperties":false,"properties":{
          "role":{"type":"string","required":true},
          "team":{"oneOf":[{"type":"string"},{"type":"null"}],"required":true},
          "source":{"type":"string","required":true},
          "guide":{"type":"string","required":true},
          "preflight":{"type":"string"},
        }},
        render: (_args, value) => TEXT_OUTPUT('role_guide ' + value.role + ' <- ' + value.source),
      },
      async execute(args) {
        const role = args?.role;
        if (typeof role !== 'string' || role.trim() === '') {
          throw new Error(ROLE_UNRESOLVED_CODE + ': role_guide 的 `role` 参数缺失/非字符串/空串/纯空白'
            + '（实得 ' + JSON.stringify(role) + '）⇒ 拒绝渲染（零静默：不得返回空 guide）');
        }
        const team = (typeof args?.team === 'string' && args.team.trim() !== '') ? args.team : undefined;
        const roleData = resolveRoleRef(role, { team });
        const guide = renderRoleGuide(roleData);
        const out = { role, team: args?.team ?? null, source: String(roleData?.source ?? ''), guide };
        if (args?.preflight !== undefined && args?.preflight !== null) {
          out.preflight = renderPreflightBlock(args.preflight, {
            injectBudget: readCapability(readLiveConfig(deps), 'injectBudget'),
          });
        }
        return out;
      },
    }),
  ];
}