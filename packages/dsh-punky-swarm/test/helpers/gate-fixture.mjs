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

// 【r2 同步 · 共享 fixture】`gate-hardening-impl-r2` 批已裁决「**拒绝免检**」语义后，既有测试里
//   「lane 无 layer 的小批」fixture 与下列门禁直接冲突，须升级为**合规三层批**：
//     · B2：无 `layer` 的 lane 不得整 lane 免检 ⇒ exit 门拒 `GATE_LANE_LAYER_MISSING`（Q-6①）；
//     · B3：批次既无 exec 也无 audit ⇒ complete 拒 `GATE_COMPLETE_NO_TIER`（零执行零验收不得收口）；
//     · A1：plan 产物必须被至少一条 lane consume ⇒ 否则 `GATE_ORPHAN_PRODUCT`（建批期）/ `GATE_PLAN_PRESENCE_MISSING`；
//     · B1 + presence：exec/audit **派发前** `consume` 必须已声明且全部在场 ⇒ 否则 `GATE_ENTRY_MISSING`；
//     · exit 门：`produce ∪ outputs` 声明的产物必须在场（并集口径，`produce_field` 不再能缩窄被检面）；
//     · B5：audit 的 `consume` 必须锚到 plan 判据来源，且该产物正文含裸标题 `## 验收标准`。
//   本模块只提供**构造器**（无副作用、不读真实状态根），供多个既有套件复用同一合规形态。
import fs from 'node:fs';
import path from 'node:path';

/** 满足 plan 契约门（裸标题 `## 验收标准` + `## 约束`）的 spec 正文。 */
export const SPEC_OK = '# spec\n## 验收标准\n- x\n## 约束\n- y\n';

/**
 * 【Q-A4 opt-2 · 2026-09-18 用户裁决】夹具锚点**按团队资产声明自适应**。
 *   根因（GAP-A1）：夹具缺省 `spec = 'plan/spec.md'` 与「收窄式」`criteria_from`（具体路径，
 *   如 `plan/plan-designer-spec.md`）不兼容 ⇒ entry 门 `anchors = []` ⇒ `GATE_AUDIT_INPUT_MISSING`
 *   （上一批 6 条红的单一根因，`lib/state/gates.js:733-737`）。
 *   规则（三态，逐条可判定）：
 *     · 未声明 `flows.audit.audit_contract.criteria_from` ⇒ 维持既有缺省（**零行为变化**）；
 *     · 声明为 **glob**（含 `*` / `?` / `[`）⇒ 维持缺省（`plan/**` 与 `plan/*spec.md` 下缺省均命中）；
 *     · 声明为**具体路径** ⇒ 取该路径（声明即在场 ⇒ 夹具与资产口径自动对齐，不再静默失配）。
 * @param {{flows?: {audit?: {audit_contract?: {criteria_from?: unknown}}}}} [assetLike] 团队资产对象（或任意同形片段）
 * @param {string} [fallback] 无声明 / glob / 非法值时的缺省路径
 */
export function anchorSpecOf(assetLike, fallback = 'plan/spec.md') {
  const declared = assetLike?.flows?.audit?.audit_contract?.criteria_from;
  if (typeof declared !== 'string') return fallback;
  const cf = declared.trim();
  if (cf === '' || /[*?[]/.test(cf)) return fallback;
  return cf;
}

/** 合规三层 tasks：`laneIds` 归 exec 层；plan 产物被 exec 与 audit **双重消费**（A1），audit 锚到 plan（B5）。
 *  【P1 同步 · 形态收紧】audit lane 现**同时 consume 各 exec 产物**（`exec/<lane>.md`）：
 *   P1 起建批必带团队资产，而**每个内置团队与 engine-team 的 `flows.audit.audit_contract.consumes_required`
 *   均为 `['plan/','exec/']`**（引擎既有 `GATE_AUDIT_INPUT_MISSING` 通用纪律，不因 P1 放宽）⇒ 合规三层批的
 *   audit 必须消费两个前缀。**断言强度未变**（未删任何判据；只是把夹具补成"团队契约下的合规形态"）。 */
export function threeTierTasks(laneIds, opts = {}) {
  const planId = opts.planId ?? 'p1';
  const auditId = opts.auditId ?? 'a1';
  const spec = opts.spec ?? anchorSpecOf(opts.asset);
  return [
    { id: planId, layer: 'plan', produce: [spec], cmd: 'spec' },
    ...laneIds.map((id) => ({
      id, layer: 'exec', consume: [spec], outputs: ['exec/' + id + '.md'], cmd: 'run', deps: [planId],
    })),
    {
      id: auditId, layer: 'audit', consume: [spec, ...laneIds.map((id) => 'exec/' + id + '.md')],
      produce: ['audit/' + auditId + '.md'], cmd: 'review', deps: laneIds,
    },
  ];
}

/** 落盘 `threeTierTasks` 声明的全部产物（满足 presence 硬约束）；返回所用相对路径。 */
export function seedArtifacts(root, session, batchId, laneIds, opts = {}) {
  const planId = opts.planId ?? 'p1';
  const auditId = opts.auditId ?? 'a1';
  const spec = opts.spec ?? anchorSpecOf(opts.asset);
  const write = (rel, content) => {
    const abs = path.join(root, 'sessions', session, 'artifacts', batchId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  write(spec, opts.specContent ?? SPEC_OK);
  const execRels = laneIds.map((id) => {
    const rel = 'exec/' + id + '.md';
    write(rel, 'out');
    return rel;
  });
  const auditRel = 'audit/' + auditId + '.md';
  write(auditRel, 'review');
  return { spec, planId, auditId, execRels, auditRel };
}

/** 走完一条 lane 的合法结算链（running → review → merged）。 */
export function runLane(store, session, batchId, lane) {
  store.setMember(session, batchId, lane, 'running');
  store.setMember(session, batchId, lane, 'review');
  store.setMember(session, batchId, lane, 'merged');
}

// ── G1 / G2 门禁种子（2026-09-14 新增）────────────────────────────────────────
// 背景：引擎新增两道门禁后，既有 fixture 的会话**缺「已评估为 C 档」的治理状态**、批次**缺 Manager 登记**，
//   于是既有用例在真正的被判面（role/assembly/presence/entry…）之前就被新门拦下。本模块把两个前置
//   抽成同一套种子函数，供各套件复用：
//     · G1（`lib/tools/core.js` 的 `assertMemberActionTierC`）：`wave_plan` / `member_status` / `member_settle`
//       只允许出现在 **C 档**会话 ⇒ 未评估一律拒 `GATE_BATCH_REQUIRES_C` / `GATE_MEMBER_REQUIRES_C`；
//     · G2（`lib/state/gates.ts` entry 门）：声明 `assembly.managerPlan === 'raise'`（**引擎缺省**）的批，
//       首个 **exec** 层派发前必须已登记 Manager ⇒ 否则拒 `GATE_MANAGER_NOT_RAISED`（lane 处于 `idle`
//       的恢复路径由 `reject()` 降级为告警放行）。
// 纪律（本组 helper 的硬要求）：**走与真实工具相同的写入路径/同一函数**，不手写裸 JSON 绕过校验——
//   · `assessC` 用 `store.writeGovernance`（`assign_check` 的同一写入函数，同一 `lastAssign` 形状）；
//   · `registerManager` 直接委托 `store.markManagerRaised`（`batch_phase({manager})` 的唯一入口）。

/** G1 种子：把会话治理状态写成「已评估为 C 档」（等价 `assign_check({difficulty:'C', ...})` 的落盘形态）。 */
export function assessC(store, session, { rationale = 'fixture：建批/成员面用例的前置评估（多线并行 ⇒ C 档）', at = new Date().toISOString() } = {}) {
  const prev = store.readGovernance(session);
  const entry = {
    turn: (prev.history?.length ?? 0) + 1,
    difficulty: 'C', form: 'C', derived: 'C', override: false, at,
    reasons: ['fixture：多线并行/多依赖（建批面用例前置）'], rationale,
  };
  const next = store.writeGovernance(session, {
    lastAssign: { difficulty: 'C', form: 'C', scope: 'full', rationale, derived: 'C', override: false, at, reasons: entry.reasons, execCallsSince: 0 },
    history: [...(prev.history ?? []), entry],
  });
  return next.lastAssign;
}

/** G2 种子：登记该批的 Manager（委托 `store.markManagerRaised`，与 `batch_phase({manager})` 同一入口）。 */
export function registerManager(store, session, batchId, agentId = 'mgr-1', note = undefined) {
  return store.markManagerRaised(session, batchId, note ? { agentId, note } : { agentId });
}
