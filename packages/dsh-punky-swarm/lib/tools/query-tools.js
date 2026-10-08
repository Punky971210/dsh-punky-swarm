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
import { laneStateOf, isDanglingLane } from '../watch/lane-heartbeat.js';
import { managerViewOf, MERGE_STATE_SOURCE, MEMBER_STATES_LEGACY } from './host-surface.js';
import * as EVT from '../state/event-types.js';
// 【本批 `role-guide-extract-20261008` · D-1 / R-2】`role_guide` 取的正是**引擎侧同一份**渲染单点
//   （解析 `resolveRoleRef` ＋ 渲染 `renderRoleGuide`，二者均在 `lib/engine/dispatch.js`）——本文件
//   **不自带任何三段模板/标题字面量**（R-5 渲染色同源的**结构性**保证，见 L-AC-6 ②④）。
//   依赖方向单向：`lib/tools/*` → `lib/engine/*`；`dispatch.js` 只引 node 内置 + `../bridge` + `../state`
//   + `./suite.js` ⇒ **无环**。
import { renderRoleGuide, resolveRoleRef, ROLE_UNRESOLVED_CODE } from '../engine/dispatch.js';

export function buildBatchStatusTools(cx) {
  const { ctx, deps, store } = cx;
  return [
    defineTool({
      name: "batch_status",
      description: "查询批次状态（唯一事实源）：phase/lanes/wavePlan/事件摘要 + 状态面派生视图 lanesState（lane→成员态映射，原 lanes 保留）/ danglingLanes（**悬挂成员**：批次已终态而成员非终态的 lane 名单，恒显、不产候选、不受僵尸批过滤）。悬挂成员是「批次已了结、成员未了结」的信号，供 Manager/Leader 只读核查收口遗漏。不传 batchId 则列出当前会话全部批次。可用 session 指定会话。`chain` 回显 = 建批期声明投影 + 历史 `chain.step` 事件（**不是**运行期真源）；**`chain` = 建批期展开 + 静态校验；运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`**（逐边取件见 `handoff_view`）。",
      parameters: {"batchId":{"type":"string","description":"批次 ID；缺省时列出该会话全部"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"phase":{"type":"string"},"concurrency":{"type":"integer"},"lanes":{"type":"object","additionalProperties":true},"lanesState":{"type":"object","additionalProperties":true},"danglingLanes":{"type":"array","items":{"type":"string"}},"wavePlan":{"type":"array","items":{"type":"object","additionalProperties":true}},"manager":{"type":"object","additionalProperties":true},"managerRoster":{"type":"object","additionalProperties":true},"smoke":{"type":"boolean"},"eventCount":{"type":"integer"},"recentEvents":{"type":"array","items":{"type":"object","additionalProperties":true}},"settled":{"type":"boolean"},"sessionId":{"type":"string"},"batches":{"type":"array","items":{"type":"object","additionalProperties":true}},"stateSource":{"type":"string"},"memberStatesLegacy":{"type":"boolean"},"handoffGate":{"type":"object","additionalProperties":true}}},
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
        const sessionId = sessionOf(args, exec);
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
        // ── P2-B 回显标注（2026-09-17；**只标注不改行为**）─────────────────────────────────────
        // ① 成员态来源标注：`source: engine|roster` 的**二值可辨**——引擎八态为 legacy 投影（`stateSource:'engine'`
        //    + `memberStatesLegacy:true`），官方 roster 5 态为真源（`managerRoster.source:'roster'`）。
        //    消费者 = 本工具的**渲染面**（`state=engine(legacy)`），不再「写了不生效」。
        // ② P1/P2 交接门**策略态**（`task-27`）：经**唯一解析点** `handoffGateStateOf(readLiveConfig(deps))` 取值
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
        if (!args.batchId) {
          return { sessionId, batches: store.listBatches(sessionId).map((id) => { const b = store.readBatch(sessionId, id); return { batchId: id, sessionId, phase: b.phase, lanes: b.lanes, ...derivedOf(b), ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation }; }), ...stateAnnotation, handoffGate: handoffGateView };
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
        return { batchId: b.batchId, sessionId, phase: b.phase, concurrency: b.concurrency, lanes: b.lanes, ...derivedOf(b), wavePlan: b.wavePlan, ...(b.manager ? { manager: b.manager } : {}), managerRoster: { ...managerViewOf(ctx, exec, b), source: MERGE_STATE_SOURCE.roster }, ...(smokeOf(b) ? { smoke: true } : {}), ...stateAnnotation, handoffGate: handoffGateView, eventCount: b.events.length, recentEvents: b.events.slice(-20), settled: store.batchSettled(b) };
      },
    }),
  ];
}

export function buildGateTools(cx) {
  const { store } = cx;
  return [
    defineTool({
      name: "gate_status",
      description: "查询批次/ lane 的门禁状态：layer、consume/produce/outputs 缺失清单、plan 契约问题，以及批次级 C+ 装配声明与 Manager 拉起登记（可核性）。**V-6 口径：本工具须传 `lane`**——不传 `lane` 时按批次内全部 lane 逐个投影（缺省列举面）；对**不在 wavePlan.tasks 内**的 lane id（或已删任务）返回 `gates:'orphan'` 占位读数（`layer:null`），该读数是**损坏/悬空 lane 的显式标记**，不是批级聚合语义——**本工具不定义批级聚合**（需批级汇总请读 `batch_status`）。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","description":"lane ID；缺省列出全部"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"lanes":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"manager":{"type":"object","additionalProperties":true},"assembly":{"type":"object","additionalProperties":true}}},
        render: (_args, value) => TEXT_OUTPUT('gate status: ' + value.lanes.length + ' lane(s)' + (value.assembly ? ' · assembly' : '') + (value.manager ? ' · manager=' + value.manager.agentId : '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const batch = store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const ids = args.lane ? [args.lane] : Object.keys(batch.lanes);
        // 批次级可核字段：C+ 装配声明（建批入参留下的声明）+ Manager 拉起登记（batch_phase(manager=…) 写入）
        // 【2026-09-27 批 3 · T-7】原 §8③ 团队资产快照回显（`teamAsset` 指纹引用 + `declaration` 正档正文 +
        //   `declarationMissing`）**已删除**：资产面退役 ⇒ 无档可写、无可读（`teamAssetViewOf` 恒回空）。
        return {
          batchId: args.batchId, sessionId, lanes: ids.map((l) => store.gateStatus(sessionId, args.batchId, l)),
          ...(batch.manager ? { manager: batch.manager } : {}),
          ...(batch.assembly ? { assembly: batch.assembly } : {}),
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
export function buildRoleGuideTools(cx) { // eslint-disable-line no-unused-vars -- 签名与同文件其余 builder 齐一（cx 由 register 侧统一注入）
  return [
    defineTool({
      name: "role_guide",
      description: "取某个 role 的**已渲染三段**（职责 / 授权 / 交付要求；标题字面量只活在单点 `ROLE_SECTION_TITLES`，本描述刻意不复写标题原文），供 Leader 在**自写任务包**时取件拼装——C-2 人工直派（`lane_dispatch` 取 `firstLine` 后自写首行）与 D-1 team 席位（`spawn_teammate` 的 `prompt`）**都走本件**，不得手抄。**渲染色同源**：`guide` 与引擎自派（C-1）任务包内的同一 role 三段**逐字一致**（同一单点 `renderRoleGuide`，本工具是薄壳、不自带模板）。**未解析到 role 一律明确报错**（`GATE_ROLE_UNRESOLVED`，含 `role` 缺失/非字符串/空串/纯空白与零命中两路），**不静默返回空串**。只读、零副作用。",
      parameters: {
        "role": {"type":"string","required":true,"description":"role id（如 `coordinator` / `coder`）；**不得**传对象——本工具只走解析路径"},
        "team": {"type":"string","description":"限定团队目录；缺省 = 既有团队序（`software-team` 优先，余按字典序）"}
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
        return { role, team: args?.team ?? null, source: String(roleData?.source ?? ''), guide };
      },
    }),
  ];
}