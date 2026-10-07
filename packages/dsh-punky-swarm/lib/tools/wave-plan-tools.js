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
//   注：`batch_phase` / `batch_control`（两处 `setPhase(` 写点）**留在 core.js** —— 源码锁 `test/phase-reason.test.js`
//   PR-8 硬编码文件面 `lib/tools/core.js` 且要求「须至少一处 setPhase 调用点」，测试不得修改 ⇒ 该两件不迁出。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildWavePlan, validateWavePlan, normalizeAssemblyDecl, assemblyGate, normalizeChannelDecl, handoffGateEnabledOf, consumeDepsAsymmetryOf } from '../wave-plan.js';
import { resolveAssembly } from '../assembly.js';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertMemberActionTierC, readLiveConfig, clearPendingBatch } from './tier-gate.js';
import { managerRosterOf } from './host-surface.js';
// 事件字面量改引 EVT 常量单点（gate.role_* 发端）
import * as EVT from '../state/event-types.js';

// 建批期告警码 → 事件 type 映射表（GAP-S9）：`wave_plan` 的告警事件化**按码映射**，不把**未命中映射**的
//   一切告警都事件化成 `gate.role_invalid`（后者会把 `GATE_COMPLETE_OUTCOMES_EMPTY`
//   误标成「role 非法」——载荷 `code` 正确、事件 type 误导读端）。
//   【2026-09-28 · 批 `cleanup-tail-20260927` E-5 订正】原措辞以「非 `<某已删码>`」描述本映射的动机 ——
//   该码的映射行已随其零发射点一并删除 ⇒ 措辞改为**按码映射的通用表述**（不再援引已删码名）。
// 未命中映射的码**保持现状 = `EVT_GATE_ROLE_INVALID`**（向后兼容：`GATE_AUDIT_CONTRACT_EXEMPT` /
//   既有码的事件 type 不迁移，避免既有断言与外部消费者漂移）。GAP-S9 残留：未来
//   把每个告警码都映射到专用类型（本任务不迁移）。
const WARN_EVENT_OF = {
  // 【2026-09-28 · 批 `cleanup-tail-20260927` E-5】原 `GATE_ROLE_MISSING` → 事件映射行**已删**：
  //   该码**零发射点**（`collectRoleCompletenessWarnings`，`lib/wave-plan.js:119-140`，现只 push
  //   `GATE_ROLE_MANAGER_AS_LANE`）⇒ 该键**恒不命中**；映射行与其事件常量（`lib/state/event-types.js`）
  //   同批删除，全仓 `lib/**` 零残留（含注释）。下方在役映射**逐字保留**。
  GATE_COMPLETE_OUTCOMES_EMPTY: EVT.EVT_GATE_COMPLETE_OUTCOMES_EMPTY,
};

export function buildWavePlanTools(cx) {
  const { ctx, deps, store, config } = cx;
  return [
    defineTool({
      name: "wave_plan",      description: "把任务按 DAG 依赖分层为 waves 并持久化为批次（wavePlan 固定语义，绝不在中途重算）。Tier3：任务可声明 layer(plan/exec/audit)/consume/produce/outputs/role/skills，建批时做三层契约静态校验；team 装配按 role 注入 skill 前缀（可插拔，不绑定 punky-preset）。【2026-09-27 用户裁决 · `team` 降为**可选标签**；同批（批 3）**资产读端已全量退役**】`team` = **纯归类字段**：不解析、不校验、不拒建批；**不参与**装配 / skill 前缀 / flows / roles 任何解析（工具面**零团队资产查找**）。【2026-09-25 订正 · recommend 语义】资产 `skills` 的**可解析性已不再拒建批**（用户裁决：「技能、工具进任务包是 recommend 式，不是装配式」）：**技能可解析性已完全不参与建批判定**（用户裁决 2026-09-26：技能 recommend 不再设门禁）——技能名解析不到 ⇒ **建批照常落盘、无告警**。**含 audit 层的三层批**建批必须携带批次级装配声明 assembly：{ managerPlan?: 'raise'|'leader-direct'（**缺省 raise**）, auditLane: '<audit lane id>', coordinatorLane?, roles? }——缺失/结构非法/悬空 lane id 拒建批（GATE_ROLE_ASSEMBLY_MISSING / GATE_ASSEMBLY_INVALID），roles 词法非法告警（GATE_ROLE_INVALID）。**缺省即 raise**（建批即拉起 Manager 代管调度轮；收口按声明核验，未登记 Manager 的在册缺口由建批期 `gate.manager_roster_gap` 留痕（收口告警已删））；确需 Leader 直驱时显式写 leader-direct。批次绑定当前会话。产物落盘契约：引擎产物根 = <~/.dsh/punky-preset>/sessions/<sessionId>/artifacts/<batchId>/，consume/produce/outputs 相对路径均解析到该根下（worker 落盘按此根，勿落工作区根）。【装配门作用域｜当前态】assembly 门**只在工具面（本工具）生效**：**直调 `buildWavePlan` 不走本门**（不抛 GATE_ROLE_ASSEMBLY_MISSING）——这是**已登记的有意差异**，登记于 `plan/techdebt-design.md §3`（决策 D-③；反例判据 R-DE-1/R-DE-2/R-DE-3/R-DE-4）。【当前态｜W-2 批将移除本句：Q6=A 已裁「门下沉到 buildWavePlan 本体」，届时本句作废，直调亦受同一门约束】【2026-09-27 批 3】`chain` 声明面与回显面**全量退役**（D-4 删净：`batch_status.chain` 与建批期链静态校验探针同批删除）；运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`，本工具不重算拓扑。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID（kebab-case）"},"tasks":{"type":"array","required":true,"description":"任务列表 [{id, cmd, deps?, model?, tools?, layer?, role?, skills?, consume?, produce?, outputs?}]","items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","description":"并发**声明**（默认 5）；**已不参与运行期准入**（Q-B 取消并发闸，2026-09-18）：不再有超限拒绝与排队，字段仅落盘声明 + 回显（面板数字照显、`batch_status.concurrency` 照回）"},"smoke":{"type":"boolean","description":"**冒烟/探针批豁免键**（gate-lite Q-G1 · 2026-09-17 用户裁决「开显式豁免键」）：显式 `true` ⇒ 本批为 smoke ⇒ **跳过产物契约类门**（建批 GATE_PLAN_PRESENCE_MISSING / GATE_ORPHAN_PRODUCT；运行期 entry consume、exit produce∪outputs、targets、complete 的 plan 悬空产物判定），**行为安全门一字不减**（派发准入：lane 存在性 + Manager 拉起；单写者锁；终态冻结 GATE_BATCH_TERMINAL；needHuman；命令门；验收判据门）。建批成功即落 `batch.smoke` 事件（留痕）+ `batch_status.smoke` 回显（读端可见）。缺省（不传）⇒ 既有行为逐字不变。"},"team":{"type":"string","description":"**可选自由标签**（纯归类字段）：不传 / 空白 ⇒ 无标签（`null`），批次照常落盘。**不解析、不校验、不拒建批**：不参与装配 / skill 前缀 / flows / roles 任何解析（团队资产面已于 2026-09-27 批 3 全量退役）。"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"},"channel":{"type":"string","description":"批级通道归属声明（**可选**；R-5）。合法值 `dispatch`=引擎自派 worker（禁 lane 写 roster）｜`team`=官方 Team 席位（**每条** lane 必须写 roster）｜`mixed`=两者并存（**至少一条** lane 写 roster）。**本参数不写 `enum`**：合法值集合的**单点判定** = `lib/wave-plan.js#normalizeChannelDecl`（非法枚举拒 GATE_CHANNEL_INVALID、与 lane roster 分布矛盾拒 GATE_CHANNEL_UNRESOLVED），在 createBatch 之前 throw ⇒ 零批次 JSON 落盘；参数层再写 enum 会在工具面抢先拒、使 GATE_CHANNEL_INVALID 在工具面**不可达**（双重判定，与「单点判定」纪律相悖）。通过 ⇒ 落盘批次顶层 `channel`（通道归属唯一事实源）；缺省（不传）⇒ **不写键**，存量行为逐字不变。"},"assembly":{"type":"object","additionalProperties":false,"description":"批次级装配声明（可选顶层参数，与 batchId/tasks 平级）：**含 audit 层的三层批**必填（2026-09-14 扩面，原为「exec 层 lane≥3」）——managerPlan 编排牵头形态（**缺省 = raise**：建批即拉起 Manager 代管调度；leader-direct：Leader 直驱，须显式写出以退出默认）+ auditLane 验收归属 lane id；coordinatorLane/roles 可选；缺失/结构/引用非法拒建批（GATE_ROLE_ASSEMBLY_MISSING / GATE_ASSEMBLY_INVALID），roles 词法非法告警（GATE_ROLE_INVALID）","properties":{"managerPlan":{"type":"string","enum":["raise","leader-direct"],"description":"编排牵头形态（**缺省 = raise**）：raise=建批即拉起 Manager 代管调度（可省略）；leader-direct=Leader 直管派发（须显式写出）"},"auditLane":{"type":"string","required":true,"description":"验收归属 lane id：本批承担最终验收的 lane（须为 audit 层 lane 且存在于 tasks；层错配/悬空 → 拒建批 GATE_ASSEMBLY_INVALID）"},"coordinatorLane":{"type":"string","description":"可选：协调/细拆 lane id（须为 plan 层 lane 且存在于 tasks；声明后承担 CBM 代码摸底→细拆履职）；缺省无"},"roles":{"type":"array","items":{"type":"string"},"description":"可选：本批声明参与的角色集（词法白名单校验；非法词条 → GATE_ROLE_INVALID 告警，批次照建）"}}}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"wavePlan":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","required":true},"lanes":{"type":"object","required":true,"additionalProperties":true},"warnings":{"type":"array","items":{"type":"object","additionalProperties":true}},"assembly":{"type":"object","additionalProperties":true},"smoke":{"type":"boolean"},"managerPlan":{"type":"string"},"managerRoster":{"type":"object","additionalProperties":true},"consumeDepsAsymmetry":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('wavePlan created: ' + value.batchId + ' @' + value.sessionId + ' (' + value.wavePlan.length + ' waves)' + (value.smoke ? '; SMOKE (产物契约类门已豁免)' : '') + (value.warnings?.length ? '; role warnings: ' + value.warnings.length : '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        assertMemberActionTierC(store, sessionId, exec, 'batch', {}, deps); // G1（Q2=B 收窄）：建批只认**本会话自己的 C 档**（无父档继承）
        // 【2026-09-27 · team-asset 全量退役】原 P1/P2 构造期前置段（「尽力」资产面解析 + 链静态校验探针 +
        //   `teamsRoot` 透传）**整体删除**：`team` 为**纯归类标签**（不解析、不校验、不拒建批）；
        //   资产 / `chain` / `teamsRoot` 三面在引擎内已不存在 ⇒ 本段零资产查找、零 warnings 注入。
        const teamName = typeof args.team === 'string' && args.team.trim().length > 0 ? args.team.trim() : null;
        // 装配面**唯一真源 = `config.assembly`**（外部覆盖层；无覆盖层 ⇒ null，由 `buildWavePlan` / 调用方按缺省处置）。
        const assembly = resolveAssembly(teamName, config.assembly);
        const smoke = args.smoke === true; // gate-lite Q-G1：显式豁免键（非真值一律 false ⇒ 既有行为零变化）
        // P1 交接门策略（`task-27`）：由**工具面**用热更快照经**唯一解析点**解析后传入建批——单一真源 =
        //   `wave-plan.ts#handoffGateEnabledOf`（runtime.json `gates.handoff.entry` > env 兜底 > 缺省关）；
        //   `wave-plan` 自身不再读 env/config（禁两套读取）。
        const planArgs = { batchId: args.batchId, tasks: args.tasks, concurrency: args.concurrency ?? 5, team: teamName, assembly, smoke, handoffGate: handoffGateEnabledOf(readLiveConfig(deps), 'entry') };
        // 【2026-09-27 · team-asset 全量退役】原 `teamsRoot` 透传（`planArgs.teamsRoot = teamsRoot`）**已删除**：
        //   形参与批次字段一并退役（D-3 裁决）⇒ 建批面不再有任何「临时团队资产根」声明位。
        const plan = buildWavePlan(planArgs);
        validateWavePlan(plan, { smoke }); // gate-lite Q-G1：二级校验与建批同一豁免口径（否则 smoke 批仍被 GATE_PLAN_PRESENCE_MISSING 拒）
        // R-5 通道归属声明（**G-1 接线 · 2026-09-26**）：本行是 `normalizeChannelDecl` 的**唯一调用点**——
        //   工具入参 `channel` 在此归一化 + 一致性校验（`team`/`dispatch`/`mixed` vs **归一化后**的 lane roster 分布；
        //   判据取 `plan.wavePlan` 而非 `args.tasks`：`roster` 已在 buildWavePlan 内归一化（`'   '` ⇒ null），
        //   否则「空白 roster」会绕过 `team` 的每条非空判据）。
        //   非法枚举 → GATE_CHANNEL_INVALID；与 roster 分布矛盾 → GATE_CHANNEL_UNRESOLVED（均在本行 throw，
        //   位于 `createBatch` 之前 ⇒ 与上方 assembly 门同址同形：**零批次 JSON 落盘**、pendingBatch 锁保留）。
        //   未声明（undefined/null）⇒ declared:false ⇒ **不写批次键**（R5-d：存量批零破坏、读端零感知）。
        //   `GATE_CHANNEL_*` 的判据语义、合法值集合、门禁码集合**一字未改**（只做接线，不做语义变更）。
        const channelDecl = normalizeChannelDecl(args.channel, plan.wavePlan.flatMap((w) => w.tasks));
        // D 档 × channel 一致性**提示**（Q-3=P-3，2026-10-01 裁决）：D = team 方案 ⇒ 建批宜声明
        //   `channel: team|mixed`。**仅提示、不硬拒** —— 硬拒会与上方 `normalizeChannelDecl` 的通道一致性
        //   判定构成**双重判定**（违「单点判定」纪律）。载体沿用既有 `plan.warnings` 管道（下方按码映射留痕）；
        //   未命中 `WARN_EVENT_OF` 的码逐字保持现状（回落 `gate.role_invalid` 事件类型，载荷 `code` 字段可区分，
        //   与 GAP-S9 既有口径一致，**不新增事件类型**）。硬拦仍只归 `normalizeChannelDecl` 一处。
        if ((store.readGovernance(sessionId)?.lastAssign?.difficulty ?? null) === 'D'
          && channelDecl.channel === 'dispatch') {
          plan.warnings.push({ code: 'WARN_DTIER_CHANNEL_UNDECLARED' });
        }
        // 批次装配门禁（建批时刻，validateWavePlan 后、createBatch 前）：**含 audit 层的三层批**必须携带
        // 批次级装配声明 assembly（auditLane 必填；managerPlan **缺省 = raise**）。拒建批（throw：GATE_ROLE_ASSEMBLY_MISSING 缺声明 /
        // GATE_ASSEMBLY_INVALID 结构/引用非法）→ 无批次 JSON 落盘、pendingBatch 锁保留（Leader 补声明后重试）；
        // 通过 → 归一化 decl 随 createBatch 持久化（batch JSON 顶层可选字段，schema 不升）；roles 词法告警并入返回 warnings
        // 角色词法集（【2026-09-27 · team-asset 全量退役】）：原「团队各层声明角色 ∪ `roles.extra`」读端
        //   **已删除** ⇒ `extraRoles` 恒空（= **引擎基础集**）。`assembly.roles` 与 `task.role` 仍走**同一份**
        //   空集 ⇒ 两处白名单口径不分裂（`normalizeAssemblyDecl` 的软告警语义不变）。
        const asm = normalizeAssemblyDecl(args.assembly, []); // { decl, warnings }；结构非法 → GATE_ASSEMBLY_INVALID throw
        const asmGate = assemblyGate(plan.wavePlan.flatMap((w) => w.tasks), asm.decl); // C+ 缺声明 → 拒；悬空 lane id → throw
        if (asmGate !== 'ok') throw new Error(asmGate.code + ': ' + asmGate.message);
        // 【2026-09-27 · team-asset 全量退役】原两段「声明驱动建批门」**整体删除**（判据源 T-6：flows 只走引擎基线）：
        //   · P2 audit 职责声明化（`flows.audit.audit_contract` 缺 → `GATE_AUDIT_CONTRACT_MISSING`；
        //     空/exempt → `GATE_AUDIT_CONTRACT_EXEMPT`；`verdict` 与 complete 白名单交集为空 →
        //     `GATE_COMPLETE_OUTCOMES_EMPTY`；`consumes_required` → `GATE_AUDIT_INPUT_MISSING`）；
        //   · E-A / E-B exec 消费门（`flows.exec.consumes_required` / `consumes_required_per_lane`
        //     → `GATE_EXEC_INPUT_MISSING`）。
        //   删除依据：两段的判据**全部取自团队声明**（`resolveTeamFlows(...).flows`），而声明面已不存在
        //   ⇒ 分支恒为 `flows === null`（原实现下即已恒不触发，属**空转面**）。删除 = 消「写了不生效」的静默面
        //   （判据源 A-13），**零行为变更**（原本就不会 throw）。
        //   同族引擎默认面**保留**：`plan/` 前缀锚点（audit 判据源）与 entry consume 强制仍由
        //   `wave-plan` 的 P1-a 与 `lib/state/gates.ts#checkEntryGate` 兜底（本段删除不涉它们）。

        // 建批期**留痕告警**并入（返回值 `warnings` 可见 + 下方既有循环按 `WARN_EVENT_OF` 落事件）：
        //   来源 ① `asm.warnings` = roles 词法告警（原有）
        //   【2026-09-27 · team-asset 全量退役】原来源 ②（资产面「尽力」解析缺口）与 ③（`chain` 声明非法）
        //   随资产面/链面删除 ⇒ **已无发射点**；仅保留 ① 这一条通道。
        plan.warnings.push(...asm.warnings);
        const batch = store.createBatch(sessionId, { batchId: plan.batchId, wavePlan: plan, concurrency: plan.concurrency, assembly: asm.decl ?? undefined, ...(channelDecl.declared ? { channel: channelDecl.channel } : {}) });
        // **冒烟/探针批**留痕（显式豁免键）——建批成功当刻落一条
        //   `batch.smoke` 事件（常量登记于 `lib/state/event-types.js`）⇒ 门禁读端（`lib/state/gates.ts#smokeOf`）
        //   与读端回显（`batch_status.smoke`）取**同一事实源**；批次 JSON 不新增字段（`store.createBatch`
        //   不在本批写域，且事件流本就是批次级留痕的既有载体，与 `laneStartedAt`/`gateStrengthOf` 同法读取）。
        //   零静默：跳过什么、保留什么见 event-types.js 常量处的语义边界声明。
        if (smoke) store.appendEvent(sessionId, plan.batchId, EVT.EVT_BATCH_SMOKE, { batchId: plan.batchId });
        // `consume` × `deps` 不对称 · **非拒观察面**（2026-10-04 · 批 `consume-deps-guard-20261004`）：
        //   域 B = 来源 lane 为 `plan` 层 ∧ 消费方非 audit 层且缺边 ⇒ **不拒建批**，只落非拒事件 `gate.consume_deps_asymmetry`
        //   （逐三元组一条）+ 返回值回显 `consumeDepsAsymmetry`，把静默不对称变成可见。
        //   判定**不在本行**：`consumeDepsAsymmetryOf` 是 `lib/wave-plan.ts` 内**单点判定**的唯一实现，
        //   本处只取 `domain === 'observed'` 分支消费（强制域 `forced` 分支已在 `buildWavePlan` 内拒建批 ⇒ 到不了本行）。
        //   `smoke: true` 批**不落**：本门属产物契约类，与 `checkPlanPresenceContract` / `checkHandoffDeclarations` 同键豁免
        //   （行为安全门一字不减：派发准入 / 单写者锁 / 终态冻结 / needHuman / 命令门 / 验收判据门均不受本键影响）。
        const observedAsymmetry = smoke
          ? []
          : consumeDepsAsymmetryOf(plan.wavePlan.flatMap((w) => w.tasks)).filter((r) => r.domain === 'observed');
        for (const r of observedAsymmetry) {
          store.appendEvent(sessionId, plan.batchId, EVT.EVT_GATE_CONSUME_DEPS_ASYMMETRY, {
            lane: r.lane, from: r.from, artifact: r.artifact,
          });
        }
        // role 校验告警留痕（`GATE_ROLE_INVALID` / `assembly.roles` 词法告警等，**按码映射**见 `WARN_EVENT_OF`；
        //   warning 语义：事件留痕、不阻断建批；Leader 经返回值 warnings 可见）
        //   【2026-09-28 · 批 `cleanup-tail-20260927` E-5 订正】原按码枚举式措辞已改为**按码映射的通用表述**
        //   （被枚举的两个码中，有一个已随零发射点删除 ⇒ 措辞不得再点名它）。
        // GAP-S9：事件 type 改走 `WARN_EVENT_OF` 按码映射（`GATE_COMPLETE_OUTCOMES_EMPTY` 有自己的专用类型）；
        //   未命中映射的码**逐字保持现状** = `gate.role_invalid`；载荷字段形态**零增删**（`code` 仍在）。
        for (const w of plan.warnings ?? []) {
          store.appendEvent(sessionId, plan.batchId, WARN_EVENT_OF[w.code] ?? EVT.EVT_GATE_ROLE_INVALID, { code: w.code, task: w.task ?? null, role: w.role ?? null, layer: w.layer ?? null, missing: w.missing ?? null });
        }
        clearPendingBatch(store, sessionId); // 建批解锁：判 C 后 pendingBatch=false
        // gate-lite 第二批 · A2（Manager 承抽）：`assembly.managerPlan` 的**消费点改读官方 roster** ——
        //   声明 `raise` 的批若 roster 可读且确无约定名 `manager` 成员 ⇒ 落 `gate.manager_roster_gap`
        //   （可核事实；**非拒态**——Manager 四码已按用户裁决整体删除）。roster 服务不可用（非官方宿主
        //   基线态）或调用抛错（非 Team 成员）⇒ **只回显 + 异常态 warn**，不把环境事实写成本批事实。
        const managerRoster = managerRosterOf(ctx, exec);
        const managerPlan = asm.decl ? (asm.decl.managerPlan ?? null) : null;
        if (managerPlan === 'raise' && managerRoster.ok && !managerRoster.inRoster) {
          store.appendEvent(sessionId, plan.batchId, EVT.EVT_GATE_MANAGER_ROSTER_GAP, {
            managerPlan, rosterName: managerRoster.rosterName, memberCount: managerRoster.memberCount ?? 0,
          });
        } else if (managerPlan === 'raise' && !managerRoster.ok && managerRoster.reason === 'service-unavailable') {
          // A(d) 补 warn（2026-09-30 批 decl-face-and-logging-20260930）：`service-unavailable` 原被上一条
          //   `else if` 显式排除、而首条 `if` 又要求 `managerRoster.ok` ⇒ 两分支皆不命中 = **完全静默**。
          //   本分支**只补日志**：不 throw、不落批次事件、不改 `managerRoster` 回显与函数返回结构（降级行为逐字不变）。
          ctx.logger?.warn?.('[dsh-punky-swarm] managerPlan=raise 但宿主团队服务不可用（agentTeams 缺失）'
            + ' ⇒ 无法核验 Manager 在册；已回显 managerRoster，不落批次事件（服务面齐备后本警告不再出现）');
        }
        // 回显键 `consumeDepsAsymmetry`（**闭集 output.schema 已登记 properties**，未登记键会被剥掉）：
        //   逐条 `{ lane, from, artifact }`（R-4 契约形态，不带内部分域字段）；仅非空时写键
        //   （与 `smoke` / `assembly` 既有条件键同风格：未命中的批零键、读端零感知）。
        const out = { batchId: plan.batchId, sessionId, wavePlan: plan.wavePlan, concurrency: plan.concurrency, lanes: batch.lanes, warnings: plan.warnings ?? [], ...(smoke ? { smoke: true } : {}), ...(managerPlan ? { managerPlan, managerRoster } : {}), ...(observedAsymmetry.length ? { consumeDepsAsymmetry: observedAsymmetry.map((r) => ({ lane: r.lane, from: r.from, artifact: r.artifact })) } : {}) };
        if (asm.decl) out.assembly = asm.decl; // 归一化装配声明视图（closed output.schema 已扩 properties；未声明不写键）
        return out;
      },
    }),
  ];
}
