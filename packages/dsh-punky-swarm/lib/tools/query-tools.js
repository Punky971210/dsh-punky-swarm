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
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { readLiveConfig } from './tier-gate.js';
import { handoffGateStateOf } from '../wave-plan.js';
// D6 批次级派生视图（只读投影）取**同源单点**：`laneStateOf`（lane 原始态）/ `isDanglingLane`（悬挂判定）
//   与 e1 探针（`lib/watch/lane-heartbeat.js`）**同一份实现、同一份语义**——不在本文件另写一套判定，
//   否则「同一 lane 的 state」会在工具面与探针面分裂（U-5 边界；依赖方向单向：core → watch，无环）。
// 【S-2 解环】真源直取 `state/lane-state.js`（**不再经 `watch/lane-heartbeat.js` 的转发**）：
//   原写法依赖心跳模块的再导出 —— 任何人把 lane-heartbeat 当「心跳专用」清掉那几行转发，
//   本文件两个名字就变 `undefined`（`checkJs:false` 下无编译期保护），运行时才炸。
import { laneStateOf, isDanglingLane } from '../state/lane-state.js';
import { managerViewOf, managerSeatFaceOf, MERGE_STATE_SOURCE, MEMBER_STATES_LEGACY } from './host-surface.js';
import * as EVT from '../state/event-types.js';
// 【本批 `role-guide-extract-20261008` · D-1 / R-2】`role_guide` 取的正是**引擎侧同一份**渲染单点
//   （解析 `resolveRoleRef` ＋ 渲染 `renderRoleGuide`，二者均在 `lib/engine/dispatch.js`）——本文件
//   **不自带任何三段模板/标题字面量**（R-5 渲染色同源的**结构性**保证，见 L-AC-6 ②④）。
//   依赖方向单向：`lib/tools/*` → `lib/engine/*`；`dispatch.js` 只引 node 内置 + `../bridge` + `../state`
//   + `./suite.js` ⇒ **无环**。
import { renderRoleGuide, resolveRoleRef, ROLE_UNRESOLVED_CODE, renderPreflightBlock, composeWorkerPrompt } from '../engine/dispatch.js';
// `renderArchContext` 的**真源**在 `lib/engine/arch-context.js`（`dispatch.js` 只是 import 它、
//   **不 re-export**）⇒ 必须从真源取，从 `dispatch.js` 取会得 `undefined`（调用期 TypeError）。
import { renderArchContext } from '../engine/arch-context.js';
// 【批 `punky-guidance-preflight-20261025` · lane `c1-preflight`】开工前必做段的**阈值同源**：
//   `role_guide` 与引擎自派路径必须过**同一份** `capabilities.injectBudget`（同一取值单点
//   `readCapability` + 同一热更快照读端 `readLiveConfig`）⇒ 两处输出**逐字一致**由结构保证，
//   不靠「块从来没超限所以看不出来」。依赖方向仍单向（`lib/tools/*` → `lib/assembly/*`，无环）。
import { readCapability } from '../assembly/schema.js';

export function buildBatchStatusTools(cx) {
  const { ctx, deps, store } = cx;
  // 【批 `d-override-fix-20261011` · lane `e6-index-wiring`】批归属会话 resolver（**注入单点**；
  //   缺省 `undefined` ⇒ `sessionOf` 逐字回落原三级路径、**零行为变化**）。与 e4 已接线的 20 处**同形**，
  //   不自造第二套回落顺序、不自持索引（resolver 本体 = `lib/engine/dispatch.js#batchSessionIdOfWorker`）。
  const { resolveBatchSession } = deps;
  return [
    defineTool({
      name: "batch_status",
      description: "查询批次状态（唯一事实源）：phase/lanes/wavePlan/事件摘要 + 派生视图 lanesState（lane→成员态）/danglingLanes（批次已终态而成员非终态的 lane，恒显）。不传 batchId 则列当前会话全部批次，可用 session 指定会话。运行期 DAG 真源 = 批次 lanes[].deps + handoffs（逐边取件见 handoff_view），chain 回显只是建批期投影，不是运行期真源。读面裁剪参数 view ∈ summary|active|full，**缺省 full**（不裁剪，返回体与不传该参数时逐字一致）：active 只裁 wavePlan（只保留 status 不属于 merged/failed/skipped 的 lane 对应任务；过滤后为空的波条目丢弃、wave 序号不重编号），lanes/lanesState/danglingLanes/eventCount/settled/handoffGate/managerRoster/recentEvents 一律不动；summary 本批等价 full（不引入第三语义）；非法值（空串 / 大小写不符 / 非字符串等）回落 full 且不抛错。生效视图经返回体 viewApplied（'full'|'active'）回显 —— 回显生效值而非请求值，裁剪视图不冒充全量事实源；view 仅作用于单批投影（多批列表读面不含 wavePlan）。",
      parameters: {"batchId":{"type":"string","description":"批次 ID；缺省时列出该会话全部"},"ids":{"type":"array","items":{"type":"string"},"description":"批量读面：给批次 ID 清单时只读这些批（≥2 件不扫目录），恰 1 件透传；与 batchId 同给时 batchId 优先"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"},"view":{"type":"json","description":"读面裁剪视图，三枚举 summary|active|full，**缺省 full**（不裁剪：返回体与不传该参数时逐字一致，零回归）。active 只裁 wavePlan —— 只保留 status 不属于 merged/failed/skipped 的 lane 对应任务（任务 id 不在 lanes 表内视为非终态、保留），过滤后为空的波条目丢弃、wave 序号不重编号；lanes/lanesState/danglingLanes/eventCount/settled/handoffGate/managerRoster/recentEvents 一律不动。summary 本批等价 full（不引入第三语义）。**非法值回落 full 且不抛错**（空串 / 大小写不符 / null / 数字 / 对象等），生效视图经返回体 viewApplied（'full'|'active'）回显 —— 回显生效值而非请求值，裁剪视图不冒充全量事实源。view 仅作用于单批投影（多批列表读面不含 wavePlan，故其返回体不回显 viewApplied）。"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"phase":{"type":"string"},"concurrency":{"type":"integer"},"lanes":{"type":"object","additionalProperties":true},"lanesState":{"type":"object","additionalProperties":true},"danglingLanes":{"type":"array","items":{"type":"string"}},"wavePlan":{"type":"array","items":{"type":"object","additionalProperties":true}},"manager":{"type":"object","additionalProperties":true},"managerRoster":{"type":"object","additionalProperties":true},"smoke":{"type":"boolean"},"eventCount":{"type":"integer"},"recentEvents":{"type":"array","items":{"type":"object","additionalProperties":true}},"settled":{"type":"boolean"},"sessionId":{"type":"string"},"batches":{"type":"array","items":{"type":"object","additionalProperties":true}},"stateSource":{"type":"string"},"memberStatesLegacy":{"type":"boolean"},"handoffGate":{"type":"object","additionalProperties":true},"viewApplied":{"type":"string"}}},
        // 【task-27】渲染面**必须**显示门态与成员态来源（缺省关是策略、不得隐形；P2-B 两字段由此获得消费者）：
        //   `state=engine(legacy)`（引擎八态为 legacy 投影，真源 = 官方 roster 5 态）
        //   `handoffGate=entry:on/settle:on(src:runtime|env|default)`
        render: (_args, value) => {
          const hg = value.handoffGate ?? null;
          const hgTxt = hg ? ' handoffGate=entry:' + (hg.entry === 'enforced' ? 'on' : 'off') + '/settle:' + (hg.settle === 'enforced' ? 'on' : 'off') + '(src:' + String(hg.source ?? 'default') + ')' : '';
          const stateTxt = value.stateSource ? ' state=' + String(value.stateSource) + (value.memberStatesLegacy ? '(legacy)' : '') : '';
          return value.batchId
            ? TEXT_OUTPUT('batch ' + value.batchId + ' phase=' + value.phase + ' settled=' + value.settled + (value.manager ? ' manager=' + value.manager.agentId : '') + (value.smoke ? ' SMOKE(产物契约类门豁免)' : '') + stateTxt + hgTxt + ((value.danglingLanes ?? []).length ? ' ⚠ dangling=' + value.danglingLanes.length : ''))
            : TEXT_OUTPUT('batches: ' + (value.batches ?? []).length + stateTxt + hgTxt);
        },
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        // D6 批次级派生视图（零写入面纯投影）：取值与探针面**同源**（`laneStateOf` / `isDanglingLane` 两个
        //   单点，均来自 lib/watch/lane-heartbeat.js），本文件不另写任何状态判定。
        //   · lanesState = lane→**成员原态**映射（不取批次档覆盖值）：与 batch.lanes 同为原始态读端，
        //     故对同一 lane 恒有 lanesState[lane] === lanes[lane]；它存在的意义是给读端一个**显式命名**的
        //     状态面键，使悬挂/待恢复等语义不必靠 lanes 的隐式约定解读。
        //   · danglingLanes = 批次终态 ∧ 成员非终态的 lane（悬挂成员），恒显（无阈值、不受 staleBatchMs 过滤）。
        const derivedOf = (b) => {
          const laneIds = Object.keys(b.lanes ?? {});
          const lanesState = {};
          for (const l of laneIds) lanesState[l] = laneStateOf(b, l);
          return { lanesState, danglingLanes: laneIds.filter((l) => isDanglingLane(b, l)) };
        };
        // gate-lite Q-G1 读端：`smoke` 判定与门禁读端（`lib/state/gates.ts#smokeOf`）**同源** —— 同一事件、
        //   同一判据（`batch.smoke`）；此处只读投影，零写入（与 derivedOf 同为批次级派生视图）。
        const smokeOf = (b) => (b?.events ?? []).some((e) => e && e.type === EVT.EVT_BATCH_SMOKE);
        // ── 回显标注（P2-B 2026-09-17 引入 · R-1 2026-10-31 改义；**只标注不改行为**）──────────────
        // ① 成员态来源标注（NQ-2 甲：成员状态真源**不动**）：`stateSource:'engine'`（引擎八态 = legacy 投影）
        //    + `memberStatesLegacy:true`（官方 roster 5 态仍为成员态真源）。消费者 = 渲染面 `stateTxt`。
        //    ⚠ 该标注**不再**由 `managerRoster.source` 承载（见 ②）：R-1 前它被借用，键义已改，别按旧义读。
        // ② **在册**真源标注（R-1 / AQ-1 乙）：`managerRoster.source`（**顶层**）恒 `'engine-registry'`
        //    —— 在册真源 = 引擎自建表 `batch.managerSeat`（五键，`lib/state/store/batch.js`），宿主 roster 只对账。
        //    ⚠ 与**嵌套**的 `managerRoster.roster.source` 是**两个不同的键**（C-5）：后者 = roster **读取面**标签，
        //    恒 `'roster'`，与 `service-unavailable` / `not-a-team-member:` 两档降级配对 ⇒ **禁改**
        //    （改了会把「服务不可用」与「非成员」压成同一形态，降级不可辨）。
        // ③ P1/P2 交接门**策略态**（`task-27`）：经**唯一解析点** `handoffGateStateOf(readLiveConfig(deps))` 取值
        //    ⇒ 真源 = runtime.json `gates.handoff.{entry,settle}`（env 兜底、缺省关）；`source` 如实回显
        //    （`runtime|env|default`）；渲染面同样显示（缺省关是策略、**不得隐形**）。
        const stateAnnotation = { stateSource: MERGE_STATE_SOURCE.engine, memberStatesLegacy: MEMBER_STATES_LEGACY };
        const hgState = handoffGateStateOf(readLiveConfig(deps));
        const handoffGateView = {
          enabled: hgState.entry || hgState.settle,
          entry: hgState.entry ? 'enforced' : 'observation',
          settle: hgState.settle ? 'enforced' : 'observation',
          source: hgState.source,
        };
        // 【QT-2a】批量读面（多批分支）：`ids` ≥2 时**不扫目录**（`store.readBatchMap` 内部按 id 读）；
        //   输出键集/字段与下面的列表分支**逐字同形**（只改读取方式，不改投影形状）。
        if (!args.batchId && Array.isArray(args.ids) && args.ids.length > 0) {
          const map = store.readBatchMap(sessionId, args.ids);
          return { sessionId, batches: [...map].map(([id, b]) => ({ batchId: id, sessionId, phase: b.phase, lanes: b.lanes, ...derivedOf(b), ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation })), ...stateAnnotation, handoffGate: handoffGateView };
        }
        if (!args.batchId) {
          const map = store.readBatchMap(sessionId);
          return { sessionId, batches: [...map].map(([id, b]) => ({ batchId: id, sessionId, phase: b.phase, lanes: b.lanes, ...derivedOf(b), ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation })), ...stateAnnotation, handoffGate: handoffGateView };
        }
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
        // 【2026-09-27 批 3 · D-4 删净】原「P2（RK1）推进链回显面」（`{version, steps[], lastStep, edges[]}`，
        //   取值 = 链本体的两个回显投影函数）**已删除**：链声明面与回显面全批删净，
        //   **不做冻结兼容读**（原 2026-09-18「冻结 · 兼容读 · 勿删」登记随之作废）。
        //   运行期 DAG 真源 = 批次 `wavePlan[].tasks[].deps` + `batch.handoffs`（逐边取件见 `handoff_view`）。
        // 【2026-09-27 批 3 · T-7】原 `batch.teamAsset` 回显（§8③ 解析结果快照指针）**一并删除**：
        //   资产面退役 ⇒ 无指纹可回显（`store.createBatch` 亦同批停止写 `teamAsset` / `teamsRoot` 两键）。
        //   ✅ **同源约束提示已闭合**（wave 4 `exec-delete-assets`）：`lib/api.js` 的 panel 读端同批删净，
        //   两读端口径一致；原缺口登记见 `exec/consumers.md` §6.1 R-2。
        // R-1 观察面（`seatReason` / `mismatch`）：计算**单点** = `host-surface.js#managerSeatFaceOf`
        //   （差集需要「表」+「roster」两侧读数；在两读端各算一遍 = 第二套判定，禁）。
        //   两键为**观察级**：不参与任何门禁判定、不落事件（事件分级按 E-1 裁决留在原判据，见 wave-plan-tools 同注）。
        const managerView = managerViewOf(ctx, exec, b);
        const managerSeatFace = managerSeatFaceOf(b, managerView.roster);
        // ── 读面裁剪（`view`）：**唯一**裁剪分支，且只裁 `wavePlan`（J-AC-2/3/4/5）
        //   ⚠ 参数面**故意**声明为 `type:'json'`（编译后 = 纯注解 schema，无 type / enum 约束）：若声明
        //     `string` + `enum`，框架 `defineTool` 的 `validateArgs`（`@deepseek-ai/dsh-tools`）会在进入本函数
        //     **之前**对非法值抛 `ToolArgsError(INVALID_ARGS)`（实测 `'actve'`/`''`/`'FULL'`/`null`/`42` 全部如此）
        //     ⇒ 与「非法值回落 full、不抛错」的裁决直接冲突。故值域裁决权留在本函数，`viewApplied` 只回显**生效值**。
        const VIEW_TERMINAL = new Set(['merged', 'failed', 'skipped']);
        // 生效值域只有两档：`summary` 本批无第三语义 ⇒ 等价 full（不新增语义面）；其余任何非法值同样回落 full。
        const viewAppliedOf = (requested) => (requested === 'active' ? 'active' : 'full');
        // `wavePlan` 是**波数组** `[{wave,tasks:[…]}]`（不是平铺 task 数组 —— 误读 `wavePlan.tasks` 会恒空）：
        //   · 终态判定只认「lane 表里的原态」；任务 id 不在 lanes 表内 ⇒ 视为非终态（fail-open，保留信息）
        //   · 过滤后 `tasks` 为空的波条目**丢弃**（不留 `{wave,tasks:[]}` 空壳）；`wave` 序号**不重编号**
        //   · 保留任务是原序列的**子序列**（顺序不变、字段值不被裁剪侧改写）
        const wavePlanOf = (batch, applied) => {
          if (applied !== 'active') return batch.wavePlan;   // full：原样返回（与改动前逐字相等，零回归）
          const keepTask = (t) => !VIEW_TERMINAL.has(batch?.lanes?.[t?.id]);
          return (Array.isArray(batch.wavePlan) ? batch.wavePlan : [])
            .map((w) => ({ ...w, tasks: (Array.isArray(w?.tasks) ? w.tasks : []).filter(keepTask) }))
            .filter((w) => w.tasks.length > 0);
        };
        const viewApplied = viewAppliedOf(args.view);
        return { batchId: b.batchId, sessionId, phase: b.phase, concurrency: b.concurrency, lanes: b.lanes, ...derivedOf(b), wavePlan: wavePlanOf(b, viewApplied), ...(b.manager ? { manager: b.manager } : {}), managerRoster: { ...managerView, source: 'engine-registry', ...managerSeatFace }, ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation, handoffGate: handoffGateView, eventCount: b.events.length, recentEvents: b.events.slice(-20), settled: store.batchSettled(b), viewApplied };
      },
    }),
  ];
}

export function buildGateTools(cx) {
  const { store, deps } = cx;
  // 【批 `d-override-fix-20261011` · lane `e6-index-wiring`】批归属会话 resolver（与 e4 同形；
  //   缺省 `undefined` ⇒ `sessionOf` 逐字回落原三级路径、零行为变化）——`gate_status` 是**成员可达**工具，
  //   `member_settle` 拒态文案明确指示 worker 调它做人工核查 ⇒ 未接线时 worker 侧恒拒 `batch not found`。
  const { resolveBatchSession } = deps;
  return [
    defineTool({
      name: "gate_status",
      description: "查询批次/lane 的门禁状态：layer、consume/produce/outputs 缺失清单、plan 契约问题，以及批次级装配声明与 Manager 拉起登记。不传 lane 时按全部 lane 逐个投影；对不在 wavePlan.tasks 内的 lane id 返回 gates:'orphan'（layer:null），该读数是损坏/悬空 lane 的显式标记。本工具不定义批级聚合（批级汇总读 batch_status）。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","description":"lane ID；缺省列出全部"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"lanes":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"manager":{"type":"object","additionalProperties":true},"assembly":{"type":"object","additionalProperties":true}}},
        render: (_args, value) => TEXT_OUTPUT('gate status: ' + value.lanes.length + ' lane(s)' + (value.assembly ? ' · assembly' : '') + (value.manager ? ' · manager=' + value.manager.agentId : '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        const batch = store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        // 批次级可核字段：C+ 装配声明（建批入参留下的声明）+ Manager 拉起登记（batch_phase(manager=…) 写入）
        // 【2026-09-27 批 3 · T-7】原 §8③ 团队资产快照回显（`teamAsset` 指纹引用 + `declaration` 正档正文 +
        //   `declarationMissing`）**已删除**：资产面退役 ⇒ 无档可写、无可读（`teamAssetViewOf` 恒回空）。
        const extras = {
          ...(batch.manager ? { manager: batch.manager } : {}),
          ...(batch.assembly ? { assembly: batch.assembly } : {}),
        };
        // 【G5-P1 · 读放大收敛】改前：`ids.map((l) => store.gateStatus(...))` —— 每个 lane 各读一次批文件
        //   ⇒ 总读盘 = 1(本处) + N(lane 数)，N 大时 O(N) 放大（实测 p50 9.606 ms vs `batch_status` 0.657 ms）。
        //   改后：列举路径走**已存在的批级单点** `gateStatusMapOfBatch`（一次读批 → `{lane: gateView}`）——
        //   它与 `gateStatus` 同源同实现（`lib/state/gates/status.js:95-104` 的 TD-21 读放大收敛注释），
        //   差别只在读盘次数；`lib/api.js` 的 `lanesGate` 已是它的读端，且已有回归锁
        //   `test/api-batch-keys.test.js` 的 P-2（逐 lane 深比较全等）/ P-3（一次读、不随 lane 数增长）。
        //   单 lane 路径**保持原实现不变**：调用方可传一个不在 `batch.lanes` 里的任意 id，而 `gateStatus`
        //   对这种 id 返回 orphan 风格视图（非 undefined），批级 map 没有该键 ⇒ 只在 `args.lane` 缺省时走批级。
        if (args.lane) {
          return { batchId: args.batchId, sessionId, lanes: [store.gateStatus(sessionId, args.batchId, args.lane)], ...extras };
        }
        const viewOfLane = store.gateStatusMapOfBatch(sessionId, args.batchId);
        // 键序取 `batch.lanes`（与改前 `Object.keys(batch.lanes)` 逐字一致；不改用 map 自身键序）
        return { batchId: args.batchId, sessionId, lanes: Object.keys(batch.lanes).map((l) => viewOfLane[l]), ...extras };
      },
    }),
  ];
}

/** `taskpack_for`（G-2 · 批 `punky-engine-core-deepdive-20261107` 方案乙）：**D 档任务包取件口**。
 *
 * ## 为什么需要它
 * `spawn_teammate` 的参数面无 role 位（见本文件 `role_guide` 段注释）⇒ D 档（官方 Team 席位）
 * **结构上无法自动注入**，闭环只能是「引擎给件 → Leader 取件拼装」。而在此之前**没有「整份任务包」
 * 的取件口**：`role_guide` 只给三段，Leader 要自己拼「角色 + 目标 + 契约 + 产物 + 检查点 + 纪律」——
 * 这正是本会话里 Leader 反复手写、且可能与 role 语料漂移的部分。
 *
 * ## 与 C 档的关系（**关键：同源，不复制**）
 * 本工具**不自己拼任务包**，而是调 `composeWorkerPrompt`（引擎自派路径的**同一函数**）——
 * 两个通道因此**必然逐字一致**，不会出现「引擎派的与 Leader 写的不同」的第二套口径。
 *
 * ## 与 C 档的两处差异（D 档固有，不是缺陷）
 * · **`firstLine` 缺省**：引擎自派有 `lane_dispatch` 发的句柄首行；D 档靠 `spawn_teammate` 拉起，
 *   没有句柄 ⇒ 传 `undefined`（`composeWorkerPrompt` 对该入参缺省有既有处理）。
 * · **`leaderPrompt` 由调用方给**：C 档是 Leader 在建批/派发时写的任务要点；D 档取件时 Leader 手上
 *   可能还没写完，故本工具接受**可选** `leaderPrompt`，未给则渲染缺省。
 *
 * ## 只读、零副作用
 * 读批 JSON + 解析 role 语料 + 纯函数渲染；**不写盘、不改状态、不发射事件**。
 * `injectBudget` / `archContext` 与 C 档**同源取值**（同一 `readCapability` + 同一 `renderArchContext`）。
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
        //   （踩过：直接读 `wavePlan.tasks` 恒空，任务包「目标」位会退化成「（未声明 cmd）」）。
        const flat = (Array.isArray(b.wavePlan) ? b.wavePlan : [])
          .flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
        const laneTask = flat.find((t) => t && t.id === lane) ?? null;
        if (!laneTask) {
          throw new Error('taskpack_for: lane "' + lane + '" 不在批 ' + batchId
            + ' 的 wavePlan 内（现有：' + flat.map((t) => String(t?.id)).join(' / ') + '）');
        }
        // role 解析走**单点**（`resolveRoleRef`）：对象直用 / id 串查语料库 / 零命中抛 `GATE_ROLE_UNRESOLVED`。
        const roleData = resolveRoleRef(laneTask.role, { team: b.team ?? undefined });
        // 【核心】调引擎自派路径的**同一函数** ⇒ 两通道逐字同源（本工具零模板、零拼装）。
        const text = composeWorkerPrompt({
          batchId, lane, cmd: laneTask.cmd, layer: laneTask.layer, role: roleData,
          consume: laneTask.consume ?? [], produce: laneTask.produce ?? [], outputs: laneTask.outputs ?? [],
          firstLine: undefined, // D 档无句柄（见上方注释）
          leaderPrompt: typeof args?.leaderPrompt === 'string' ? args.leaderPrompt : '',
          artifactsRoot: store.artifactsDirOf(sessionId, batchId),
          batchSessionId: sessionId,
          singleArtifactWrite: laneTask.singleArtifactWrite === true,
          injectBudget: readCapability(readLiveConfig(deps), 'injectBudget'),
          archContext: renderArchContext({ targets: laneTask.targets ?? null }),
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
          // 结构化面供核对（**不是**第二套渲染源：全由 laneTask 原样透出）
          fields: {
            cmd: laneTask.cmd ?? null,
            consume: laneTask.consume ?? [],
            produce: laneTask.produce ?? [],
            outputs: laneTask.outputs ?? [],
            hasCheckpoints: laneTask.checkpoints != null,
            checkpoints: laneTask.checkpoints ?? null,
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

/** `role_guide`（D-1 / R-2）：**只读取件口**——Leader 自写任务包时（C-2 人工直派 / D-1 team 席位）
 *  从引擎取该 role 的**已渲染三段**，与 C-1（引擎自派）**同源**（R-5）。
 *
 *  **为什么是「取件口」而非「自动注入」**：`spawn_teammate` 参数面无 role 位 ⇒ 闭环只能是
 *  「引擎给件 → Leader 取件拼装」；本工具即那个可调用、可核、报错显式的取件口。
 *
 *  **薄壳（零模板）**：`guide` = `renderRoleGuide(resolveRoleRef(role, { team }))` 的**原样输出**
 *  —— 本函数**不**做任何拼装/改写/裁剪，故三段与任务包内出现的字节**逐字一致**。
 *
 *  **零静默（三条报错路径，均抛 `GATE_ROLE_UNRESOLVED`，禁返回空串/部分结果）**：
 *   ① `role` 缺失 / 非字符串 / 空串 / 纯空白 ⇒ **本层先判空后抛**。**禁**透传 `resolveRoleRef` 的
 *      `null` 语义——它对空串返回 `null`（不抛），透传会渲染出空 `guide`，即静默降级；
 *   ② `role` 非空但零命中 ⇒ 由 `resolveRoleRef` 抛同一码（**复用**，不新造码）；
 *   ③ 报错发生在**任何返回值构造之前** ⇒ 不存在 `{ guide: '' }` 这类部分结果。
 *
 *  **工具面定位**（R-3）：`lib/engine/suite.js` 登记为 `('read', false, false, false)`
 *  —— 只读语料查询（同族先例 `gate_status` / `artifact_types` / `task_pool`）、零写面、
 *  **成员可用**（只读查自己的角色指引，与 2026-09-27 用户裁决「三项全放」同构）。
 *
 *  **`output.schema` 的 `team` 用 `oneOf` 而非 `type:"string"`**（消费方契约实测，非偏好）：
 *  判据源 §4 规定 `team` 未传时为 **`null`**，而宿主 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 的
 *  `assertSupportedJsonSchema` **拒绝 type 数组**（`type arrays are not supported`）且对声明为
 *  `type:"string"` 的字段收到 `null` 会判 `must be a string` —— 正是本仓 task-25「已落盘却报
 *  假失败」的同一形态。`oneOf:[{type:"string"},{type:"null"}]` 经**真实宿主校验函数**实测为零违例
 *  （见 `exec/e01-impl/provenance/schema-check.mjs` 读数）。 */
export function buildRoleGuideTools(cx) { // eslint-disable-line no-unused-vars -- 本批起 `cx.deps` 用于 injectBudget 阈值同源（见 execute）；其余字段仍由 register 侧统一注入
  const { deps } = cx ?? {};
  return [
    defineTool({
      name: "role_guide",
      description: "取某个 role 的已渲染三段（职责 / 授权 / 交付要求），供 Leader 自写任务包时取件拼装，不得手抄；渲染色与引擎自派任务包内同一 role 三段逐字一致。role 缺失/非字符串/空串/纯空白或零命中一律报错，不静默返回空串。传 preflight ⇒ 返回值多出 preflight 字段（开工前必做四段，可直接粘进任务包）；不传则返回键集不变。只读、零副作用。",
      parameters: {
        "role": {"type":"string","required":true,"description":"role id（如 coordinator / coder）；不得传对象"},
        "team": {"type":"string","description":"限定团队目录；缺省按既有团队序（software-team 优先，余按字典序）"},
        // 【批 `punky-guidance-preflight-20261025` · lane `c1-preflight`】P0-1 开工前必做四段声明**透传位**：
        //   传了就按引擎自派路径的**同一个**渲染单点产出 `preflight` 字段（逐字一致）；不传 ⇒ 返回键集逐字不变。
        //   形态与 `wave_plan` 的 task `preflight` 完全同构 ⇒ Leader 自写任务包时可直接把同一份声明粘过来。
        "preflight": {"type":"object","additionalProperties":false,"description":"开工前必做四段声明（可选）：传 ⇒ 返回值多 preflight 字段；四段 kb / skills / mcp / checklist","properties":{
          "kb":{"type":"array","items":{"type":"string"},"description":"知识库关键词（2-3 个，可直接粘进 weknora_search）"},
          "skills":{"type":"array","items":{"type":"string"},"description":"技能确切名（不是「相关技能」）"},
          "mcp":{"type":"array","description":"MCP 工具 + 用途","items":{"type":"object","additionalProperties":false,"properties":{"tool":{"type":"string","required":true},"why":{"type":"string","description":"拿它干什么（缺 ⇒ 渲染「（用途未声明）」）"}}}},
          "checklist":{"type":"array","items":{"type":"string"},"description":"本任务相关检查表条目（内联）"}
        }}
      },
      output: {
        // ⚠ 本字段是**宿主的 value schema DSL**（`@deepseek-ai/dsh-tools` 的 `valueSchemaSpecToJsonSchema`），
        //   **不是**裸 JSON Schema —— 两处实测口径（`exec/e01-impl/provenance/schema-check.mjs` 读数）：
        //   ① `required` **只能**写成**逐属性** `required: true`（根节点不允许 `required` 数组：
        //      写数组会被拒 `schema.required is not supported by the value schema DSL`）；
        //   ② `type` **不接受数组**（`type arrays are not supported`）⇒ 可空字段只能走 `oneOf`。
        //   `additionalProperties` 在 object 节点**必须显式给布尔**。
        schema: {"type":"object","additionalProperties":false,"properties":{
          "role":{"type":"string","required":true},
          "team":{"oneOf":[{"type":"string"},{"type":"null"}],"required":true},
          "source":{"type":"string","required":true},
          "guide":{"type":"string","required":true},
          // 【本批】**仅在入参带 `preflight` 时出现**（可选键）：守「不传 ⇒ 返回键集逐字不变」（既有读端零回归）。
          "preflight":{"type":"string"},
        }},
        render: (_args, value) => TEXT_OUTPUT('role_guide ' + value.role + ' <- ' + value.source),
      },
      async execute(args) {
        // ① 判空前置（**先于**解析）：缺失 / 非字符串 / 空串 / 纯空白 ⇒ 显式抛，禁透传 null 语义。
        const role = args?.role;
        if (typeof role !== 'string' || role.trim() === '') {
          throw new Error(ROLE_UNRESOLVED_CODE + ': role_guide 的 `role` 参数缺失/非字符串/空串/纯空白'
            + '（实得 ' + JSON.stringify(role) + '）⇒ 拒绝渲染（零静默：不得返回空 guide）');
        }
        const team = (typeof args?.team === 'string' && args.team.trim() !== '') ? args.team : undefined;
        // ② 非空零命中 ⇒ 由 `resolveRoleRef` 抛 `GATE_ROLE_UNRESOLVED`（复用既有码，本工具不新造码）。
        const roleData = resolveRoleRef(role, { team });
        // ③ 单点渲染（薄壳）：不做拼装/裁剪/改写 ⇒ 与 C-1 任务包内三段逐字一致。
        const guide = renderRoleGuide(roleData);
        const out = { role, team: args?.team ?? null, source: String(roleData?.source ?? ''), guide };
        // ④ 【批 `punky-guidance-preflight-20261025` · lane `c1-preflight`】开工前必做四段（P0-1）：
        //   **取件口不是自动注入口**——同 role 三段口径：引擎给件、Leader 取件拼装。
        //   渲染**单点** = `dispatch.js#renderPreflightBlock`（引擎自派路径的同一函数）⇒ `preflight` 字段与
        //   任务包内该段**逐字一致**（本文件零模板、零拼装）。阈值也取同源 `capabilities.injectBudget`。
        //   未传 `preflight` ⇒ **不产该键**（返回键集逐字不变，既有读端 RO-18 的精确集断言零回归）。
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