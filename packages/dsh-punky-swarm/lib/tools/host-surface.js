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

// 宿主面读端单点（自 `lib/tools/core.js` **原样搬移**，行为零变更）：宿主技能根 / 官方 roster（Manager 在册）/
//   交接调用方身份采集 / legacy 标注常量。宿主技能根函数零引用已删（W3a）；其余导出面由消费者直接 import。

// ── 【2026-09-27 · team-asset 全量退役】原「会话级临时团队资产根（teamsRoot）」整面**已删除** ──────────
//   删除清单（逐项对 A-5 / A-6 / A-11 判据归零）：
//     · `teamsRootLexicalProblem`（词法/防逃逸纯判定）＋ `TEAM_NAME_RE`；
//     · 「teamsRoot 不可用」非门禁留痕码 ＋ 「尽力」资产面解析函数（两者随本批删除）；
//     · 「team 标签 → 资产查找键」归一化函数——现按**纯归类标签**在调用点就地归一化，无资产语义；
//     · `RETIRED_TEAM_NAME`（旧缺省团队名 `generic` 的构造期拒）；
//     · `packagedTeamsWithAsset` / `teamRecoveryHint`（拒态自救文案的资产枚举）；
//     · `assertTeamNameRequired` / `assertTeamAssetReady` / `assertChainReady`（三个 P1/P2 构造期断言，
//       此前已退出工具面接线）。
//   现语义：`team` = **可选自由标签**（纯归类字段：不解析、不校验、不拒建批）；`teamsRoot` 参数与批次字段
//   **一并退役**（D-3 裁决）⇒ 引擎不再有任何「团队资产根」概念。**禁回加**任何资产查找/拒态面。


// 【2026-09-27 · team-asset 全量退役】原工具面「新语义」整段（三条纪律 + 留痕码 + 标签归一化 +
//   「尽力」资产面解析）**已删除**，取代之的统一语义见上一段：`team` = 纯归类标签，资产面不存在。


// ── P1（2026-09-16）团队资产**必填化** → 【2026-09-27 用户裁决】**整体退役** → 【2026-09-27 批 3】面已删净 ──
// 历史（保留可读性）：P1 把建批时的团队资产做成**构造期拒**（唯一落点 = `wave_plan.execute` 前置段）：
//   判定序 ① `team` 词法/必填 → ② 资产加载 + 加载期不变量 → ③ `skills` 名可解析性（recommend）→ ④ `chain` 静态校验。
// 现口径：**构造期拒建批门与资产读端全部删除** —— `team` 降为**可选自由标签**（纯归类字段），
//   资产 / `chain` / `teamsRoot` 三面在引擎内**不再存在**（本批的删除动作见上一段清单）。


// 【2026-09-27 · team-asset 全量退役】原 `packagedTeamsWithAsset`（包内资产枚举）与
//   `teamRecoveryHint`（拒态自救文案）**已删除**：无资产面 ⇒ 无候选可枚举、无自救指引可给。


// 【2026-09-27 · team-asset 全量退役】原三个构造期断言 **已删除**：`assertTeamNameRequired`
//   （P1 判定 ①：`team` 必填 / `generic` 已废除）/ `assertTeamAssetReady`（判定 ②③：资产加载 + 加载期不变量）
//   / `assertChainReady`（P2 判定 ④：`chain` 八条静态校验）。
//   删除依据：① 三者语义上全部依赖**资产面**（判据源 T-5 明列）；② 它们此前已退出工具面接线
//   （2026-09-27 用户裁决「team-asset 装配方案全面弃用」⇒ 调用点删除、函数体保留待清理）；
//   ③ 本批为「资产面全量退役」⇒ 保留 = 读已删除资产的死路径（判据源 A-13 禁「写了不生效」的静默面）。
//   **禁回加**：`team` 为纯归类标签，不存在「必填 / 有资产 / 有链声明」三种构造期拒态。


// （`assertChainReady` 已随上一段一并删除：资产面不存在 ⇒ 无 `chain` 声明可校验。）

// ── gate-lite 第二批 · A2：Manager「在册」判定的**官方 roster 承抽**读端 ──────────────────
// 设计四问的完整论证见产出文档 §A；此处是**唯一实现**（禁第二套判定）：
//   ① 映射口径：Manager = 官方 Team roster 中**具名成员**，约定名 `manager`（lower-kebab-case，
//      满足 `spawn_teammate` 的 name 约束）。官方 roster 行形状 `TeamMemberView`（`role:'lead'|'teammate'`）
//      **没有 manager role 枚举** ⇒ 只能**按约定名判**（显式取舍，写进文档）；Lead 伪行为 `name:'lead'`
//      （官方 `roster.list` 首行 ❰dsh-experimental-agent-team/lib/index.js:439-446❱）⇒ 不会与 Manager 撞名。
//   ② 判据 API：`agentTeams.listMembers(agent)`（宿主 service 名 `agentTeams`，官方注册 `lib/index.js:1680`
//      `super(ctx, "agentTeams")`、实现 `:1731`；typert 契约 `lib/typert.host.js:231`
//      `listMembers(agent: Agent): TeamMemberView[]`）。凭据 = **live Team member 的 agent**（传 `exec.agent`）。
//   ③ 取用口：cordis `ctx.get('agentTeams')` —— 官方语义「Read a service from the store **without the inject
//      requirement** … returns the service value, or **undefined** when not (yet) provided」
//      （`@deepseek-ai/cordis/lib/types/reflect.d.ts:6-16` / 实现 `lib/index.js:754-771`）⇒ **不在本插件
//      `inject` 里加硬依赖**（加硬 inject 会使本插件在**未挂官方 team 插件**的宿主上失去加载能力）。
//   ④ 降级（禁静默，四级可辨）：service 不可用 ⇒ `reason:'service-unavailable'`（非官方宿主**基线态**，
//      由回显承担可读性）；调用抛错（调用方非 Team 成员等）⇒ `reason:'not-a-team-member: …'`（异常态，
//      上抛 `logger.warn` + 回显）；roster 可读但无该成员 ⇒ `inRoster:false`（本批事实 ⇒ **落
//      `gate.manager_roster_gap` 事件**）；命中 ⇒ `inRoster:true` + `member` 行（id/name/role/status）。
//   **本判定不拒任何调用**（Manager 四码按用户裁决整体删除后无拒态；读端只回显事实）。
const MANAGER_ROSTER_NAME = 'manager';
export function managerRosterOf(ctx, exec) {
  let svc = null;
  try { svc = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : null; } catch { svc = null; }
  if (!svc || typeof svc.listMembers !== 'function') {
    return { ok: false, source: 'roster', inRoster: false, reason: 'service-unavailable', rosterName: MANAGER_ROSTER_NAME };
  }
  let rows = null;
  try { rows = svc.listMembers(exec?.agent); } catch (e) {
    return { ok: false, source: 'roster', inRoster: false, reason: 'not-a-team-member: ' + String(e?.message ?? e), rosterName: MANAGER_ROSTER_NAME };
  }
  const list = Array.isArray(rows) ? rows : [];
  const hit = list.find((m) => m && m.name === MANAGER_ROSTER_NAME) ?? null;
  return {
    ok: true, source: 'roster', inRoster: !!hit, rosterName: MANAGER_ROSTER_NAME, memberCount: list.length,
    member: hit ? { id: hit.id ?? null, name: hit.name, role: hit.role ?? null, status: hit.status ?? null } : null,
  };
}

/** Manager 读端**统一形态**（roster 承抽）：官方 roster 优先，批次 legacy 字段（`batch.manager`）并列回显。 */
export function managerViewOf(ctx, exec, batch) {
  const roster = managerRosterOf(ctx, exec);
  const legacy = batch && batch.manager ? { agentId: batch.manager.agentId ?? null, raisedAt: batch.manager.raisedAt ?? null } : null;
  return { roster, legacy, managerPlan: batch?.assembly?.managerPlan ?? null };
}

// ── R-1（P4 授权修复批 `onto-p4-authz-r2-20260925`）：交接**调用方身份**采集端（只采集，不裁决） ──
// 分工（禁双套判据）：**裁决**在唯一写路径 `lib/state/store.js#recordHandoff`（与写入同点的 fail-closed）；
//   本函数只把可解析的身份面**如实采集**成描述子交下去——不猜、不静默、不自行放行。
// 身份面（逐条对应 `plan/fix-spec.md` §2.1 判据链，**全部取自既有读端**，不新增映射面）：
//   · `sessionId`：调用方会话（`exec.agent.session.id`；`sessionOf` 的 `'cli'` 兜底在此**不采用**——
//     兜底值会把「无身份」伪装成「会话 cli」，与 §2.1⑤ fail-closed 相悖；args.session 仅在 exec 无会话时作显式声明面）；
//   · `rosterNames`：官方 roster 内的**具名成员名**（`ctx.get('agentTeams').listMembers(agent)`）——
//     官方 Team 成员天然经此解析出 `name`（如 `coder-1`），与 R-3 的 `lanes[].roster` 同名空间可比；
//     服务不可用（非官方宿主基线态）/调用抛错 ⇒ **空数组**（= 该身份面无事实，交由 ③④⑤ 继续判定，不伪造）；
//   · `batch/manager` 判定所需的 `sessionId` 与批字段在 store 侧闭合（本函数不预判 owner/Manager）。
export function handoffCallerIdentityOf(ctx, exec, args) {
  const sessionId = exec?.agent?.session?.id
    ?? (typeof args?.session === 'string' && args.session.length ? args.session : null);
  const rosterNames = [];
  try {
    const svc = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : null;
    const rows = svc && typeof svc.listMembers === 'function' ? svc.listMembers(exec?.agent) : null;
    for (const m of Array.isArray(rows) ? rows : []) {
      if (m && typeof m.name === 'string' && m.name.trim()) rosterNames.push(m.name.trim());
    }
  } catch { /* 非 Team 成员 / 服务异常 ⇒ 该身份面无事实（**空数组**，不静默降级为「已授权」） */ }
  return { source: 'handoff-caller-identity', sessionId, rosterNames };
}

// ── P2-B（2026-09-17）：**legacy 标注**（用户裁决 Q2 暂缓 ⇒ **只标注不改行为**）────────────────────
// 事实（`member-governance-redesign-20260917`（原文档未随仓分发） §7.1 事实分工）：**成员身份/状态的真源 = 官方 roster（5 态）**；
//   引擎的 `member.*` **八态**（`pending/running/review/merged/failed/skipped/conflict/idle`）是**引擎侧投影**，
//   `member.settled` / `member_status` / `member_settle` 写的是这八态 ⇒ 一律**标 legacy**（不改判定、不删字段、
//   不新增事件；仅回显面标注，使读端能看出「这是引擎投影、非官方真源」）。
// 回显纪律（禁静默）：`batch_status` 单批与列表两形态**都带**标注键，且 `source` 二值可辨（`engine` = 引擎投影 /
//   `roster` = 官方真源）——`P2-B` 只做标注，真正的状态来源切换归后续批次（Q2 暂缓）。
export const MERGE_STATE_SOURCE = {
  engine: 'engine', // 引擎侧 `member.*` 八态投影（legacy 标注对象）
  roster: 'roster', // 官方 roster 5 态（成员身份/状态真源）
};
export const MEMBER_STATES_LEGACY = true; // 八态 = legacy 投影；真源 = 官方 roster 5 态