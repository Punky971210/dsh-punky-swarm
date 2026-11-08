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
import { managerRosterOf, managerSeatFaceOf } from './host-surface.js';
// 【批 `punky-engine-fix2-20261106` · lane `e2-f8` · F-8 返工】宿主 roster 成员名读取**单点**：
//   `buildWavePlan` 是**零 ctx 纯函数**（`lib/wave-plan.ts` 全篇纪律）⇒ 宿主读取**只能**在工具面做，
//   以**纯数据**（`string[]`）传入建批函数；本 import 即该读取的唯一来源（provider 侧 `RosterSource`
//   的 DSH 实现，归属声明见 `lib/provider-dsh/roster.js:18-37`）。
import { createRosterPort } from '../provider-dsh/roster.js';
// 【批 `preset-per-role-20261108`】建批期「role ↔ preset 覆盖面」预检所需三个**单点**：
//   · `presetIdForRoleOf` = preset id 解析（与派发路径**同一函数**，禁在本文件另写形态判定）；
//   · `deriveDenyTools` = 「该角色不该拿的工具」反推（与派发闸 `askToolFace.deny` **同一实现**）；
//   · `resolveRoleRef` / `roleCorpusRoot` = role 语料解析（同上，唯一解析单点）。
//   ⚠ 复用而非重写：本预检必须与真实派发闸**同判据**，否则会出现「建批说能派、派发被拒」的假绿
//     （或反之假红）。判据源 = `lib/engine/dispatch.js` 的 `presetFor`（`deny ∩ covers`）。
//   ⚠ 依赖方向：`lib/engine/**` 不在 `lib/provider-dsh/**` 棘轮面内（后者才是受限方向），
//     本 import 与上方 `provider-dsh/roster.js` 那条（棘轮白名单内）无关。
import { presetIdForRoleOf, deriveDenyTools, resolveRoleRef, roleCorpusRoot } from '../engine/dispatch.js';
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
// 【批 `punky-engine-fix2-20261106` · lane `e1-red` · D-2=乙】本表**只收**需要发射专用事件的码；
//   **不发射事件**的告警码见下方 `WARN_SILENT_CODES`。两集合**相斥**（交集必须 = ∅，判据 `E1-R8`）。
const WARN_EVENT_OF = {
  // 【2026-09-28 · 批 `cleanup-tail-20260927` E-5】原 `GATE_ROLE_MISSING` → 事件映射行**已删**：
  //   该码**零发射点**（`collectRoleCompletenessWarnings`，`lib/wave-plan.js:119-140`，现只 push
  //   `GATE_ROLE_MANAGER_AS_LANE`）⇒ 该键**恒不命中**；映射行与其事件常量（`lib/state/event-types.js`）
  //   同批删除，全仓 `lib/**` 零残留（含注释）。下方在役映射**逐字保留**。
  GATE_COMPLETE_OUTCOMES_EMPTY: EVT.EVT_GATE_COMPLETE_OUTCOMES_EMPTY,
  // 【批 `preset-per-role-20261108`】建批期「role ↔ preset 覆盖面」冲突（非拒观察面）
  //   ⚠ 码名用 `WARN_` 前缀而**非** `GATE_`：`GateErrorCode` union 是**冻结面**
  //     （`test/gate-lane-snapshot.test.js` 的 `P2-1` 用 `EXPECTED_GATE_CODES` 硬锁 62 个码，
  //     要求「集合身份不变」）⇒ 新增观察码一律不得进 union、不得进词表。
  //     既有同族先例 = `WARN_ROSTER_UNKNOWN`（`WARN_SILENT_CODES` 内，也是 `WARN_` 前缀）。
  //     本码与它的差别：本码**要发事件**（下一条映射），故落 `WARN_EVENT_OF` 而非 `WARN_SILENT_CODES`
  //     （两集合相斥，判据 `E1-R8`）。
  WARN_ROLE_PRESET_MISMATCH: EVT.EVT_GATE_ROLE_PRESET_MISMATCH,
};

// 建批期**只留 `warnings[]`、不落任何事件**的告警码（批 `punky-engine-fix2-20261106` · D-2=乙 裁决）：
//   · 与 `WARN_EVENT_OF` **相斥**（两集合交集必须 = ∅，判据 `E1-R8`）；
//   · 这些码**不进** `GateErrorCode` union、**不进** `lib/state/vocabulary.json`（用户已裁：不登记词表）；
//   · 建批返回值的 `warnings[]` 是 Leader 能看到该告警的**唯一可见面**（`E1-R7` 要求它必须仍在）；
//   · 为什么必须显式跳过而不能只删映射：下方发射循环有兜底 `?? EVT.EVT_GATE_ROLE_INVALID`
//     ⇒ 只删映射会把该告警**换个 type 继续发射**（`gate.role_invalid` + 载荷 `code` = 告警码 = 误标 2.0），
//     与裁决「不发射事件」正好相反。
//   · **过渡期双名已收口（2026-11-06）**：`e1-red` 当时因本批禁在该 lane 跑 `npm run build`
//     （`e3-contracts` 并行，build 会回拷覆盖手改）而把两名字面量**同时登记** —— 那时生成物
//     `lib/wave-plan.js` 仍是旧字面量 `GATE_ROSTER_UNKNOWN`，只登记新名会让「事件面零发射」不成立。
//     现 `e2-f8` 的 `npm run build` 已生效 ⇒ 运行时码名恒为 `WARN_ROSTER_UNKNOWN`，**旧名成死项、已删**。
//     ⚠ 若将来再改该码名，仍须「源码改名 + build + 同步本集合」三步同做，否则会重现「发射绕过静默集」。
const WARN_SILENT_CODES = new Set(['WARN_ROSTER_UNKNOWN']);

export function buildWavePlanTools(cx) {
  const { ctx, deps, store, config } = cx;
  return [
    defineTool({
      name: "wave_plan",      description: "把任务按 DAG 依赖分层为 waves 并持久化为批次（建批即固定，不重算）。任务可声明 layer(plan/exec/audit)/consume/produce/outputs/role/skills，建批时做三层契约静态校验。含 audit 层的三层批必填 assembly（字段表见该参数）。team 为纯归类标签（不解析、不校验、不拒建批）；skills 解析不到也不拒建批。批次绑定当前会话；产物根 = <~/.dsh/punky-preset>/sessions/<sessionId>/artifacts/<batchId>/，consume/produce/outputs 相对此根。运行期 DAG 真源 = lanes[].deps + handoffs。装配门只在工具面生效（直调 buildWavePlan 不走该门；该有意差异登记于 plan/techdebt-design.md §3）。失败必带 GATE_* 码。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true,"description":"批次 ID（kebab-case）"},"tasks":{"type":"array","required":true,"description":"任务列表 [{id, cmd, deps?, model?, tools?, layer?, role?, skills?, consume?, produce?, outputs?, context?}]。context（项目上下文，可选但强烈建议在大项目里填）= 该 lane 执行时必须知道的背景，会渲染进任务包 `## 项目上下文` 段供成员读：写「本域既有约定 / 已踩过的历史坑 / 当前进度与已完成面 / 边界禁令」四类事实，不要写任务目标（那是 cmd）、不要写开工动作清单（那是 preflight）。留空则该段不渲染（存量批零感知）。","items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","description":"并发声明（默认 5）：仅落盘 + 回显，不参与运行期准入"},"smoke":{"type":"boolean","description":"冒烟/探针批豁免（默认 false）：true ⇒ 跳过产物契约类门（建批 presence/orphan、运行期 consume·produce·targets·complete），行为安全门不减；落 batch.smoke 事件"},"team":{"type":"string","description":"可选自由标签（纯归类）：不解析、不校验、不拒建批；缺省 null"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"},"channel":{"type":"string","description":"通道归属（可选）：dispatch=引擎自派｜team=官方席位（每条 lane 须写 roster）｜mixed=并存（至少一条写 roster）。非法枚举 / 与 roster 矛盾拒 GATE_CHANNEL_INVALID / GATE_CHANNEL_UNRESOLVED"},"assembly":{"type":"object","additionalProperties":false,"description":"批次级装配声明：含 audit 层的三层批必填。{ managerPlan?: 'raise'|'leader-direct'（缺省 raise）；auditLane: '<audit lane id>'（必填）；coordinatorLane?；roles? [string] }；缺失或 lane id 悬空拒 GATE_ROLE_ASSEMBLY_MISSING / GATE_ASSEMBLY_INVALID","properties":{"managerPlan":{"type":"string","enum":["raise","leader-direct"],"description":"编排牵头形态（缺省 raise）：leader-direct=Leader 直管派发，须显式写出"},"auditLane":{"type":"string","required":true,"description":"验收归属 lane id（须为 audit 层且存在于 tasks；层错配/悬空拒 GATE_ASSEMBLY_INVALID）"},"coordinatorLane":{"type":"string","description":"可选：协调/细拆 lane id（须为 plan 层且存在于 tasks）"},"roles":{"type":"array","items":{"type":"string"},"description":"可选：参与角色集（词法白名单；非法词条告警 GATE_ROLE_INVALID，批次照建）"}}}},
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
        // 【批 `punky-engine-fix2-20261106` · lane `e2-f8` · F-8 返工】未知席位告警的比对基准 =
        //   `BUILTIN_ROLES` ∪ 宿主 roster **成员名**。宿主读取**只能**在此处做（`buildWavePlan` 零 ctx）。
        //   ⚠ **禁止**「宿主 roster 不可用 ⇒ 不告警」的降级分支（用户裁决 D-3：Harness 几乎不存在该场景，
        //     再不济有 Subagent ID 兜底 ⇒ 该场景现实中不存在）⇒ 读失败/不可用的正确行为 =
        //     **基准退化（传 `[]`）+ 告警照旧（`lib/wave-plan.ts` 的告警循环一字不减）+ 一行 `logger.warn`**。
        //   读端契约（`lib/provider-dsh/roster.js:87-89`）：`{available, read(), sessionOf()}`；`read()` **同步、
        //   可抛**、返回成员视图行数组（行名字段 `name`，`target` 双键容错见该文件 `nameOfRow`）。
        let hostRosterNames = [];
        try {
          const rosterPort = createRosterPort(ctx, exec?.agent);
          if (rosterPort.available) {
            hostRosterNames = (rosterPort.read() ?? [])
              .map((m) => (m && typeof m.name === 'string' ? m.name.trim() : ''))
              .filter((name) => name.length > 0);
          }
        } catch (e) {
          // 只降级「基准」，**不降级告警**：`hostRosterNames` 保持 `[]` ⇒ 并集退化为 `BUILTIN_ROLES`，
          //   两侧都不含的席位名仍照常告警（判据 `E2-F4`：读失败后零告警 = 有人加了降级分支 = 判红）。
          ctx.logger?.warn?.('[dsh-punky-swarm] wave_plan: 宿主 roster 读取失败 ⇒ 未知席位告警基准退化为 BUILTIN_ROLES（**告警照常发射**）：' + String(e?.message ?? e));
        }
        const planArgs = { batchId: args.batchId, tasks: args.tasks, concurrency: args.concurrency ?? 5, team: teamName, assembly, smoke, handoffGate: handoffGateEnabledOf(readLiveConfig(deps), 'entry'), hostRoster: hostRosterNames };
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
        // D 档 × channel 一致性**硬拒 + 显式降级出口**（**本批 Q-4 裁决，2026-10-11**）：原为「仅提示」
        //   （Q-3=P-3 / 2026-10-01 裁决曾 push 一个「D 档 × 通道未声明」告警码）—— **该码已停止发射**
        //   （判据源 AC-11：本文件内该码字面量零残留；历史登记面另在 `scripts/audit/**` 可留），
        //   若不同处改判将留下「提示」与「硬拒」**两条互斥口径**，故同处改判为硬拒。动机链保留：D ≡
        //   **建批档 + team 通道**（`discipline.md` §0p 十四）⇒ 通道面为 `dispatch`（含**未声明**归一为 dispatch）
        //   即与本会话声明的 D 不自洽，必须拒建批并给**两条正范式**，不得静默降级。
        //   ⚠ 与上方 `normalizeChannelDecl`（:82）**不重叠**：本判定读**档位声明**（`lastAssign.difficulty`），
        //     `normalizeChannelDecl` 读 **lane roster 分布** ⇒ 两条判据作用于**不同输入**，非双重判定
        //     （「单点判定」纪律：同一判据不得两处判）。
        //   ⚠ 位置：**必须**在 `normalizeChannelDecl`（:82）之后、`createBatch` 之前 ⇒ 拒时**零批次 JSON 落盘**、
        //     `pendingBatch` 锁保留（Leader 改声明/重评后可直接重试）。
        const govD = store.readGovernance(sessionId)?.lastAssign ?? null;
        if (govD?.difficulty === 'D' && channelDecl.channel === 'dispatch') {
          throw new Error('GATE_DIFFICULTY_CHANNEL_UNRESOLVED: 本会话声明 difficulty=D（team 通道档），'
            + '而本批 channel=' + (channelDecl.declared ? "'dispatch'" : '未声明（归一为 dispatch）') + ' —— **D 与通道面不一致，拒建批**。'
            + '两条正范式：① 确需 durable 席位 ⇒ 保持 { difficulty:"D", durableSeats:true } 并以 channel:"team"|"mixed" 建批'
            + '（每条 lane 须写非空 roster，见 lib/wave-plan.js#normalizeChannelDecl）；'
            + '② 确属引擎自派 worker ⇒ 显式降级：重评 assign_check({ difficulty:"C", rationale:"<写明降级原因>", scope:"full" })'
            + ' 后以 channel:"dispatch" 建批（禁静默降级，同源 discipline.md §0b 十四⑤）。');
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
        // ── 【批 `preset-per-role-20261108`】建批期「role ↔ preset 覆盖面」预检（**非拒观察面**）──────
        //   判据（与派发闸 `presetFor` **同一实现**，非另写一份）：把 `deriveDenyTools(role.tools.allow)`
        //   与 `presetCoverage[presetId].tools` 求交，相交非空 ⇒ 该 role 的 lane 在 `lane_dispatch` 时
        //   必被 `GATE_DISPATCH_CAPABILITY_UNAVAILABLE` 拒派（`activation` 形态无 `toolFilter` ⇒
        //   收窄只能靠 preset 的固定面）。
        //   **为什么在建批期报**：Leader 的决策点在「建批」而不是「派发」—— 等派发才撞，等于让 Leader
        //   先写完全部 lane 契约再发现一半派不出去（本会话实测踩过：designer 撞 `pwsh`）。
        //   **不拒建批**：preset 覆盖率是**宿主配置态**（`config.dispatch.presetCoverage` 可热更），
        //   环境一变就能派，与批次本身是否合法无关 ⇒ 走 `GATE_ROLE_INVALID` 同款 warning 语义。
        //   零 throw（全软）：本检失败只降级为空告警 + 一条 warn 留痕，绝不影响建批。
        const presetMismatchWarnings = (() => {
          try {
            const live = readLiveConfig(deps);
            const coverage = live?.dispatch?.presetCoverage;
            if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) return [];
            const seen = new Set();
            const out = [];
            for (const t of plan.wavePlan.flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []))) {
              const role = typeof t.role === 'string' ? t.role.trim() : '';
              if (!role) continue;
              const presetId = presetIdForRoleOf(live, role);
              if (!presetId) continue;
              const entry = coverage[presetId];
              const tools = entry !== null && typeof entry === 'object' && Array.isArray(entry.tools) ? entry.tools : null;
              // 无覆盖声明 ⇒ 派发闸走「只有 id 无见证」分支（那不是本预检的判据面）⇒ 跳过
              if (tools === null || tools.length === 0) continue;
              const roleData = resolveRoleRef(role, { root: roleCorpusRoot() });
              const deny = deriveDenyTools(roleData?.tools?.allow, { root: roleCorpusRoot() });
              const clash = deny.filter((x) => tools.includes(x));
              if (clash.length === 0) continue;
              // 同 (role, preset, 冲突集) 只报一条：20 条 coder lane 不该刷 20 条同样的话
              const key = role + '|' + presetId + '|' + clash.join(',');
              if (seen.has(key)) continue;
              seen.add(key);
              out.push({
                // ⚠ `WARN_` 前缀（非 `GATE_`）：union 是冻结面，观察码不得进（见 `WARN_EVENT_OF` 处注释）
                code: 'WARN_ROLE_PRESET_MISMATCH',
                task: t.id,
                role,
                layer: t.layer ?? null,
                // 复用 `missing` 槽承载冲突工具名：载荷形态零增删（`:208` 的 7 键不变），
                //   且语义同族（都是「该 role 面里缺/撞的东西」）。
                missing: clash.join(','),
                basis: 'preset=' + presetId,
              });
            }
            return out;
          } catch (e) {
            ctx.logger?.warn?.('[dsh-punky-swarm] wave_plan: role↔preset 覆盖面预检失败 ⇒ 跳过（不阻断建批）：'
              + String(e?.message ?? e));
            return [];
          }
        })();
        plan.warnings.push(...presetMismatchWarnings);
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
          // 【批 `punky-engine-fix2-20261106` · lane `e1-red` · D-2=乙】`WARN_SILENT_CODES` 里的码
          //   **只留 `warnings[]`、不落任何事件**（不加本行则下方兜底会把它误标成 `gate.role_invalid`）。
          if (WARN_SILENT_CODES.has(w.code)) continue;
          // 载荷 `roster` / `basis`（F-8）：现载荷原有 `{code,task,role,layer,missing}`，**没有**席位名字段
          //   ⇒ 不加的话事件里看不到「是哪个席位名未知」，也没法区分「真未知席位」与「成员名形态」。
          //   两键对既有告警码恒为 null（缺省 `?? null`，键恒在 ⇒ 读端形态稳定、存量语义零漂移）；
          //   `output.schema` 的 `warnings.items` 为 `additionalProperties:true`（`:53` 实测开放）
          //   ⇒ 无需扩 properties，回显不被剥离。
          store.appendEvent(sessionId, plan.batchId, WARN_EVENT_OF[w.code] ?? EVT.EVT_GATE_ROLE_INVALID, { code: w.code, task: w.task ?? null, role: w.role ?? null, layer: w.layer ?? null, missing: w.missing ?? null, roster: w.roster ?? null, basis: w.basis ?? null });
        }
        clearPendingBatch(store, sessionId); // 建批解锁：判 C 后 pendingBatch=false
        // gate-lite 第二批 · A2（Manager 承抽）：`assembly.managerPlan` 的**消费点改读官方 roster** ——
        //   声明 `raise` 的批若 roster 可读且确无约定名 `manager` 成员 ⇒ 落 `gate.manager_roster_gap`
        //   （可核事实；**非拒态**——Manager 四码已按用户裁决整体删除）。roster 服务不可用（非官方宿主
        //   基线态）或调用抛错（非 Team 成员）⇒ **只回显 + 异常态 warn**，不把环境事实写成本批事实。
        const managerRoster = managerRosterOf(ctx, exec);
        const managerPlan = asm.decl ? (asm.decl.managerPlan ?? null) : null;
        // R-1 观察面（E-1 裁决）：`seatReason` / `mismatch` **只进回显，不进下面这个发射点判据**。
        //   为什么（结构性，不是口味）：`store/batch.js:64` `if (fs.existsSync(file)) throw 'batch already exists'`
        //   ⇒ 同一 `batchId` 不可重建 ⇒ 本函数每次 execute 都是**全新落盘** ⇒ 此刻 `managerSeat` **必不存在**。
        //   ⇒ ①「表空」是建批期的**定义性状态**（实测 raise 批 14/14 表空），落成 `gate.*` 事件会让审计
        //      无法区分常态与异常（与 `service-unavailable` 同理：只回显、不落事件）；
        //     ② `mismatch` 要「表非空」才对得出差集 ⇒ 在此**结构性不可达**，接进判据即为死代码。
        //   ⚠ 因此下面 `if` 的判据**保持原样**（roster 口径），本 lane 不改事件面。
        const managerSeatFace = managerSeatFaceOf(batch, managerRoster);
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
        // R-1 回显（W-1 裁决）：`managerRoster` 在**本端**的 `source` **保持 `'roster'`**（= roster **读取面**标签，
        //   承载 `service-unavailable` / `not-a-team-member:` 两档降级可辨性；本端无嵌套副本可退，覆盖即抹掉降级标签）。
        //   两键 `seatReason` / `mismatch` 以**观察面**身份并入（`output.schema` 对 managerRoster 为 additionalProperties:true）。
        const out = { batchId: plan.batchId, sessionId, wavePlan: plan.wavePlan, concurrency: plan.concurrency, lanes: batch.lanes, warnings: plan.warnings ?? [], ...(smoke ? { smoke: true } : {}), ...(managerPlan ? { managerPlan, managerRoster: { ...managerRoster, ...managerSeatFace } } : {}), ...(observedAsymmetry.length ? { consumeDepsAsymmetry: observedAsymmetry.map((r) => ({ lane: r.lane, from: r.from, artifact: r.artifact })) } : {}) };
        if (asm.decl) out.assembly = asm.decl; // 归一化装配声明视图（closed output.schema 已扩 properties；未声明不写键）
        return out;
      },
    }),
  ];
}
