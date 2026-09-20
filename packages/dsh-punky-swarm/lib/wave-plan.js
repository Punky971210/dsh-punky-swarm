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
// wavePlan 固定语义：DAG 拓扑分层，启动时确定并持久化，绝不在中途重算
// Tier3（dsh-punky-swarm 三层门禁）：任务可声明 layer/consume/produce/outputs/role/skills，
// 建批时做三层契约静态校验（跨层引用 / 有 exec 必有 audit / 路径契约一致性 / skill 声明）；
// cmd 由引擎注入 role/skill 前缀（装配可插拔，不绑定 punky-preset）。
// resume 契约：task 可声明 checkpoint:{steps}（总步数）与 resume:boolean
// （崩溃后新 worker 允许参考 checkpoint 跳过已完成步骤）——校验放行 + 字段透传（与 condition 同模式，
// 默认关场景仅存元数据，消费方按 capabilities.worktree.enabled 开关生效）；resumeClauseFor(task) 供
// 派发侧注入固定任务包条款（RESUME_CLAUSE）。
// 类型化说明：输入面 WavePlanTaskInput（id 必填其余可选）/ 持久面 WavePlanTask（缺省落 null/[]/false），
//   buildWavePlan 是两形态间的唯一规范化桥；topoWaves 产物 id 必命中 tasks（find 单点断言）；
//   PLAN_LEAD_ROLES.has(effectiveRole(t)) 经显式空值守卫（Set.has(null) 运行期即 false，非行为缺陷）——
//   全部消解路径均为类型适配，运行期语义零变更。
//
// r2 扩域（e2，**仅追加式最小编辑**）：建批期 presence 硬约束 + A1 悬空产物**主防线**（O-1 双点强制）。
//   判据同源：本文件**引用** `lib/state/gates.ts` 的 `presenceJudge`（唯一实现，`mode:'declare'`），
//   不自带任何 presence 判定逻辑。他方在建批期的 `GATE_AUDIT_INPUT_MISSING` 块（本 lane 追加前处于
//   `:469-488`；追加后落 `:555-578`，`throw` 在 `:576`）**逻辑逐字保留**，本批新增校验一律**追加**在其后
//   （既有拒因优先级/消息不变）。
import { BLIND_REVIEW_ROLES } from './assembly/schema.js';
// 团队角色集（可拔插）——各层声明角色 ∪ 扩展角色 ∪ 额外牵头角色，缺声明回落引擎基础集
import { resolveTeamRoles, unionRoleVocabulary } from './assembly/flows.js';
// 判据同源（O-4.3 / I-1 / I-2）：建批期**导入**运行期唯一 presence 判据实现（含「声明形态」判据），
//   禁两套逻辑（T35 L3 要求 `lib/wave-plan.js` 内 `presenceJudge` **定义处 = 0** 且**引用**该标识符）。
//   无环证明：`lib/**` 内导入 `wave-plan.js` 的只有 `lib/tools/core.js`（不在 gates.ts 的导入图内）。
import { presenceJudge, declaredKindOf } from './state/gates.js';
import { isAbsPath } from './state/constants.js'; // 单点（自有实现收敛改 import）
const SCHEMA_VERSION = 1;
export const LAYERS = ['plan', 'exec', 'audit'];
// 合法角色集合（software-team 8 角色，任务权威；大小写兼容，内部归一化小写）
// 合法角色集合：`manager` 仅为**声明面**保留（`assembly.roles` 可声明它），
// **不得用作 lane.role**——Manager 是引擎层功能角色（不属任一层、不占 lane，见纪律 §0g）；
// 误用会产专属告警 `GATE_ROLE_MANAGER_AS_LANE`（见 collectRoleCompletenessWarnings）。
export const VALID_ROLES = ['coordinator', 'manager', 'designer', 'coder', 'tester', 'reviewer', 'supervisor', 'doc-manager'];
// 装配扩展角色（盲审三角色，与 assembly/schema.js BLIND_REVIEW_ROLES 同源；装配可插拔扩展点）
export const ROLE_EXTENSIONS = BLIND_REVIEW_ROLES;
// 校验白名单 = 8 角色 ∪ 装配扩展（既有合法装配角色不误报）
export const ROLE_WHITELIST = new Set([...VALID_ROLES, ...ROLE_EXTENSIONS]);
// role 归一化：合法角色（大小写不敏感）→ 小写规范名；非法/未声明 → null
// `extraRoles` = 团队声明扩展角色（引擎基础集之外）——**并集**进白名单（可拔插而不削地基）
export function normalizeRole(role, extraRoles = null) {
    if (role == null)
        return null;
    if (typeof role !== 'string')
        return null;
    const norm = role.trim().toLowerCase();
    if (ROLE_WHITELIST.has(norm))
        return norm;
    if (Array.isArray(extraRoles) && extraRoles.some((r) => typeof r === 'string' && r.trim().toLowerCase() === norm))
        return norm;
    return null;
}
// layer → 缺省 role（task 未显式声明 role 时）：plan→designer / audit→supervisor / exec→coder；
// 未声明 layer（generic 任务）→ null（保持现状：不注入 role 前缀，不改变既有 generic 语义）
// 参数含 undefined：调用点（effectiveRole/buildWavePlan）传 t.layer 可能为 undefined——宽松输入面，运行期语义零变更
export function defaultRoleForLayer(layer) {
    if (layer === 'plan')
        return 'designer';
    if (layer === 'audit')
        return 'supervisor';
    if (layer === 'exec')
        return 'coder';
    return null;
}
// C 类批次角色齐备门禁（GATE_ROLE_MISSING，warning 语义：事件留痕、不阻断建批，与 GATE_ROLE_INVALID 一致；后续可配 enforce）——
// 背景：实跑证实 C 类批次（多 wave/多 lane/跨层）常缺 plan 层 designer 与 audit 层 supervisor（被 planner/auditor 或 Leader 代劳）。
// C 类形态判定（复用 wavePlan 拓扑信息）：wave 数 >1 或 lane 数 >1 或存在跨 layer 依赖；单 lane 批次（非 C 类形态）不触发本门禁。
export const PLAN_LEAD_ROLES = new Set(['designer', 'coordinator']); // plan 层牵头角色（**不含 manager**：Manager 是引擎层常驻功能角色——continuable subagent，由 Leader 直系拉起，不属任何层、不占 lane，故不得充当 plan 层牵头）
export const AUDIT_LEAD_ROLES = new Set(['supervisor', 'doc-manager']); // audit 层牵头角色
// 跨 layer 依赖：任一任务的 deps 中存在 layer 与自身不同的依赖（DAG 跨层编排）
function hasCrossLayerDep(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return tasks.some((t) => {
        if (!t.layer)
            return false;
        return (t.deps ?? []).some((d) => {
            const dep = byId.get(d);
            return dep && dep.layer && dep.layer !== t.layer;
        });
    });
}
export function isCClassBatch(tasks, waves) {
    return waves.length > 1 || tasks.length > 1 || hasCrossLayerDep(tasks);
}
// 任务有效角色（归一化）：未声明 → 按 layer 缺省（plan→designer / audit→supervisor / exec→coder）；
// 显式声明非法角色 → null（归一化失败，不满足齐备；由 GATE_ROLE_INVALID 另行告警）
// `opts.extraRoles` = 团队声明的扩展角色集（引擎基础集之外），使非工程团队可用自有角色名。
function effectiveRole(t, opts = {}) {
    return normalizeRole(t.role ?? defaultRoleForLayer(t.layer), opts.extraRoles ?? null);
}
// C 类批次角色齐备检查：plan 层 lane 需至少一个 designer/coordinator；audit 层 lane 需至少一个 supervisor/doc-manager；
// 层不存在（无该层 lane）不检查（validateLayerContract 既有语义不变）；非 C 类形态（单 lane 批次）不触发
// `opts.planLeads` / `opts.auditLeads` = 团队声明的额外牵头角色（**并集**进基础集，不替换——保证引擎地基不被删减）
export function collectRoleCompletenessWarnings(tasks, waves, opts = {}) {
    if (!isCClassBatch(tasks, waves))
        return [];
    const extraRoles = Array.isArray(opts.extraRoles) ? opts.extraRoles : [];
    const planLeads = new Set([...PLAN_LEAD_ROLES, ...(Array.isArray(opts.planLeads) ? opts.planLeads : [])]);
    const auditLeads = new Set([...AUDIT_LEAD_ROLES, ...(Array.isArray(opts.auditLeads) ? opts.auditLeads : [])]);
    const roleOpts = { extraRoles };
    const warnings = [];
    const planLanes = tasks.filter((t) => t.layer === 'plan');
    if (planLanes.length > 0 && !planLanes.some((t) => {
        // 空值守卫：effectiveRole 返回 string|null；Set.has(null) 运行期恒 false，显式守卫类型适配、判定结果不变
        const r = effectiveRole(t, roleOpts);
        return r !== null && planLeads.has(r);
    })) {
        warnings.push({
            code: 'GATE_ROLE_MISSING',
            layer: 'plan',
            missing: [...new Set(['designer', 'coordinator', ...(Array.isArray(opts.planLeads) ? opts.planLeads : [])])].join('|'),
            message: 'C-class batch requires at least one plan lane with role ' + ['designer', 'coordinator', ...(Array.isArray(opts.planLeads) ? opts.planLeads : [])].join('/') + ' (effective: ' + planLanes.map((t) => effectiveRole(t, roleOpts) ?? t.role ?? '(default)').join('/') + ')',
        });
    }
    const auditLanes = tasks.filter((t) => t.layer === 'audit');
    if (auditLanes.length > 0 && !auditLanes.some((t) => {
        const r = effectiveRole(t, roleOpts);
        return r !== null && auditLeads.has(r);
    })) {
        warnings.push({
            code: 'GATE_ROLE_MISSING',
            layer: 'audit',
            missing: [...new Set(['supervisor', 'doc-manager', ...(Array.isArray(opts.auditLeads) ? opts.auditLeads : [])])].join('|'),
            message: 'C-class batch requires at least one audit lane with role ' + ['supervisor', 'doc-manager', ...(Array.isArray(opts.auditLeads) ? opts.auditLeads : [])].join('/') + ' (effective: ' + auditLanes.map((t) => effectiveRole(t, roleOpts) ?? t.role ?? '(default)').join('/') + ')',
        });
    }
    // manager 作为 lane 角色的**语义错位**提示（专属码，不混入 GATE_ROLE_MISSING 以免误读为「缺牵头角色」）：
    // Manager 是引擎层功能角色（不属 plan/exec/audit 任一层、不占 lane），它出现在 lane.role 上通常意味着
    // 「该域缺自己的计划/验收角色」。仅提示、不阻断（与既有告警通道一致）。
    for (const t of tasks) {
        if (effectiveRole(t, roleOpts) === 'manager') {
            warnings.push({
                code: 'GATE_ROLE_MANAGER_AS_LANE',
                task: t.id,
                ...(t.layer ? { layer: t.layer } : {}),
                role: 'manager',
                message: 'lane ' + t.id + ' uses role "manager": Manager is an engine-layer role (belongs to no layer, occupies no lane); use the domain\'s own planning/acceptance role instead (e.g. plan: designer/coordinator, audit: supervisor/doc-manager)',
            });
        }
    }
    return warnings;
}
// ── C+ 档装配门禁（建批时刻静态校验）──
// 背景：C 类三层批次（≥3 个 exec lane）实跑频繁缺「批次级编排装配声明」（谁牵头调度 Manager、验收归哪条 audit lane），
// 全靠 Leader 事后人工补救。本门禁把裁决前移到建批：凡 exec 层 lane ≥ 3（C+）的批次必须携带装配声明 assembly。
// 档位语义（与既有 GATE_ROLE_MISSING 同族命名、语义分离、并存不合并）：
//   - 缺 assembly（C+）→ 拒建批：GATE_ROLE_ASSEMBLY_MISSING（新码，编排装配声明缺失 = C+ 硬前置，不复用告警通道）；
//   - 结构/引用非法 → 拒建批：GATE_ASSEMBLY_INVALID（fail-closed，对齐 deps 未知 id / targets 相对路径既有 throw 家族）；
//   - roles 词法非法 → 告警：GATE_ROLE_INVALID（复用既有软告警通道，批次照建）。
// 码经 throw 消息前缀暴露（建批拦截是 throw 非 gates.ts 返回码族，不进 GateErrorCode）。
export const MANAGER_PLANS = ['raise', 'leader-direct']; // assembly.managerPlan 合法枚举（运行时事实源，与 contracts.ManagerPlan 字面量等价）
// 统计口径：仅按 task 的 layer 字段计（layer==='exec' 的 lane 数）
export function countExecLanes(tasks) {
    return tasks.filter((t) => t.layer === 'exec').length;
}
// C+ 判定：任一 task 声明 layer ∈ {plan, exec, audit}（三层批形态）
// 且 layer==='exec' 的 lane 数 ≥ 3 → C+（建批必须携带装配声明）；exec<3 或 generic 批 → 不强制（零感知）
export function isCPlusBatch(tasks) {
    const threeTier = tasks.some((t) => t.layer != null && LAYERS.includes(t.layer));
    return threeTier && countExecLanes(tasks) >= 3;
}
// 装配声明必备判定（2026-09-14 用户裁决：Manager 见批即默认 raise，且该默认必须**可核**）：
//   三层批形态（任一 task 声明 layer）**且含 audit 层 lane** → 建批必须携带批次级装配声明。
//   为什么是这两个条件：① 声明里的 `auditLane` 必须指向 audit 层 lane ⇒ 「含 audit lane」是该声明可成立的前提；
//   ② 只有声明落盘后，`managerPlan`（**缺省 raise**）才成为引擎侧可核事实——收口告警按**声明**触发（见 state/store.js），
//      读端因此能区分「默认 raise 未登记 Manager」与「显式 leader-direct」，消除原先的可核性空洞。
//   不强制的形态：generic 批（无 layer 声明）与无 audit 层的批（零感知，与既有行为兼容）。
//   注：`isCPlusBatch`（exec≥3）保留为**集群规模**口径（既有读端/测试仍用），不再是装配强制的唯一触发条件。
export function requiresAssemblyDecl(tasks) {
    const threeTier = tasks.some((t) => t.layer != null && LAYERS.includes(t.layer));
    const hasAudit = tasks.some((t) => t.layer === 'audit');
    return threeTier && hasAudit;
}
// assembly 归一化/校验（纯函数，导出供工具与测试共用）：input 缺省/undefined → { decl: null, warnings: [] }
// （非 C+ 批零感知）；结构非法 → throw 'GATE_ASSEMBLY_INVALID: assembly.<field> ...'（fail-closed 拒建批）——
//   非对象 / managerPlan 非枚举 / auditLane、coordinatorLane 非非空字符串；
// roles 词法非法（词条非字符串、或不在合法角色集合 VALID_ROLES∪扩展）→ warnings（GATE_ROLE_INVALID，
//   软告警不阻断建批；事件经既有 gate.role_invalid 通道留痕）。归一化 decl 供 createBatch 持久化（batch JSON 顶层可选字段）。
// 复核补齐：assembly.roles 的词法判定**也**接受团队声明的角色
//  （若只认引擎基础集 ∪ 盲审三角色 ⇒ 非工程团队在装配声明里写自有角色会被误判 GATE_ROLE_INVALID）
// 读端同源（2026-09-14）：调用方传入的 extraRoles 应为 `unionRoleVocabulary(resolveTeamRoles(...))`
//  （= 资产各层声明角色 ∪ roles.extra），与 task.role 判定同一读端，消除「两处白名单不一致」。
export function normalizeAssemblyDecl(input, extraRoles = null) {
    if (input == null)
        return { decl: null, warnings: [] };
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('GATE_ASSEMBLY_INVALID: assembly must be an object { managerPlan, auditLane, coordinatorLane?, roles? } (got: ' + (Array.isArray(input) ? 'array' : typeof input) + ')');
    }
    const raw = input;
    const warnings = [];
    const mpRaw = raw.managerPlan ?? 'raise'; // 缺省 = raise（2026-09-14 用户裁决「Manager 见批即默认」；leader-direct 须显式写出）
    if (mpRaw !== 'raise' && mpRaw !== 'leader-direct') {
        throw new Error('GATE_ASSEMBLY_INVALID: assembly.managerPlan must be one of raise|leader-direct (got: ' + String(mpRaw) + ')');
    }
    const managerPlan = mpRaw; // 单点断言：上方双字面量守卫后仅剩合法枚举（断言纯类型层）
    const auditLane = raw.auditLane;
    if (typeof auditLane !== 'string' || !auditLane.trim()) {
        throw new Error('GATE_ASSEMBLY_INVALID: assembly.auditLane must be a non-empty string (audit lane id, got: ' + String(auditLane) + ')');
    }
    const decl = { managerPlan, auditLane: auditLane.trim() };
    const coordinatorLane = raw.coordinatorLane;
    if (coordinatorLane != null) {
        if (typeof coordinatorLane !== 'string' || !coordinatorLane.trim()) {
            throw new Error('GATE_ASSEMBLY_INVALID: assembly.coordinatorLane must be a non-empty string when present');
        }
        decl.coordinatorLane = coordinatorLane.trim();
    }
    const roles = raw.roles;
    if (roles != null) {
        if (!Array.isArray(roles)) {
            warnings.push({ code: 'GATE_ROLE_INVALID', message: 'assembly.roles must be an array of role strings (got: ' + typeof roles + ')' });
        }
        else {
            const kept = [];
            for (const r of roles) {
                const s = typeof r === 'string' ? r : null;
                if (s === null || !s.trim() || normalizeRole(s, extraRoles) === null) {
                    warnings.push({
                        code: 'GATE_ROLE_INVALID',
                        role: s ?? String(r),
                        message: 'assembly.roles entry "' + (s ?? String(r)) + '" is not a valid role (' + [...VALID_ROLES, ...ROLE_EXTENSIONS].join('/') + ', or any role declared by the team asset)',
                    });
                }
                else {
                    kept.push(s);
                }
            }
            if (kept.length)
                decl.roles = kept; // 合法词条保留（信息性声明；大小写原样透传，词法判定大小写不敏感）
        }
    }
    return { decl, warnings };
}
// C+ 装配门禁裁决（纯函数，导出供工具与测试共用）：工具 execute 在 validateWavePlan 与 createBatch 之间调用——
//   - decl 悬空 lane id（auditLane/coordinatorLane 不在 tasks）→ throw GATE_ASSEMBLY_INVALID（引用悬空 = 声明无意义，fail-closed）；
//   - 层归属（结构前置）：三层批形态（任一 task 声明 layer）时 auditLane 须指向 audit 层 lane、
//     coordinatorLane 须指向 plan 层 lane；层错配 → throw GATE_ASSEMBLY_INVALID（含层错配明细）。generic 批（无 layer 声明）
//     跳过层归属（无层可归属；带 assembly 仅信息性持久化）；
//   - 非必备形态（generic 无 layer 声明，或无 audit 层的批）→ 'ok'（零感知，行为与现状一致）；
//   - 必备形态且缺 decl → { code: 'GATE_ROLE_ASSEMBLY_MISSING', message }（拒建批，消息自解释补法）；
//   - 必备形态且 decl 齐备 → 'ok'。
//   必备形态 = requiresAssemblyDecl(tasks)（三层批且含 audit 层，2026-09-14 起；此前仅 exec≥3 触发）。
export function assemblyGate(tasks, decl) {
    if (decl != null) {
        const byId = new Map(tasks.map((t) => [t.id, t]));
        // 层归属仅在批内存在声明 layer 的任务（三层批形态）时强制：generic 批无 audit/plan 层概念，跳过（声明无害仅持久化）
        const threeTier = tasks.some((t) => t.layer != null && LAYERS.includes(t.layer));
        const audit = byId.get(decl.auditLane);
        if (!audit) {
            throw new Error('GATE_ASSEMBLY_INVALID: assembly.auditLane "' + decl.auditLane + '" does not match any task id in this batch');
        }
        if (threeTier && audit.layer !== 'audit') {
            throw new Error('GATE_ASSEMBLY_INVALID: assembly.auditLane "' + decl.auditLane + '" must reference an audit-layer lane (found layer: ' + (audit.layer ?? 'none') + ')');
        }
        if (decl.coordinatorLane != null) {
            const coord = byId.get(decl.coordinatorLane);
            if (!coord) {
                throw new Error('GATE_ASSEMBLY_INVALID: assembly.coordinatorLane "' + decl.coordinatorLane + '" does not match any task id in this batch');
            }
            if (threeTier && coord.layer !== 'plan') {
                throw new Error('GATE_ASSEMBLY_INVALID: assembly.coordinatorLane "' + decl.coordinatorLane + '" must reference a plan-layer lane (found layer: ' + (coord.layer ?? 'none') + ')');
            }
        }
    }
    if (!requiresAssemblyDecl(tasks))
        return 'ok';
    if (decl == null) {
        return {
            code: 'GATE_ROLE_ASSEMBLY_MISSING',
            message: "three-tier batch with an audit lane requires an assembly declaration — pass assembly: { managerPlan?: 'raise'|'leader-direct' (default raise), auditLane: '<audit lane id>' }",
        };
    }
    return 'ok';
}
export function topoWaves(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error('tasks must be a non-empty array');
    }
    const ids = new Set();
    for (const t of tasks) {
        if (!t || typeof t.id !== 'string' || !t.id)
            throw new Error('task id required');
        if (ids.has(t.id))
            throw new Error('duplicate task id: ' + t.id);
        ids.add(t.id);
    }
    const deps = new Map();
    for (const t of tasks) {
        const d = Array.isArray(t.deps) ? t.deps : [];
        for (const dep of d) {
            if (!ids.has(dep))
                throw new Error('task ' + t.id + ' depends on unknown id: ' + dep);
        }
        deps.set(t.id, new Set(d));
    }
    const indegree = new Map();
    for (const id of ids) {
        const d = deps.get(id); // 单点断言：ids 内每 id 均经上方 deps.set(t.id, ...) 建项，get 必命中（断言纯类型层）
        indegree.set(id, d.size);
    }
    const waves = [];
    let remaining = new Set(ids);
    const order = [];
    let guard = ids.size * ids.size + 1;
    while (remaining.size > 0) {
        if (--guard < 0)
            throw new Error('cycle detected in task deps');
        const ready = [...remaining].filter((id) => {
            const d = deps.get(id); // 单点断言：remaining ⊆ ids，get 必命中（断言纯类型层）
            for (const dep of d)
                if (remaining.has(dep))
                    return false;
            return true;
        });
        if (ready.length === 0)
            throw new Error('cycle detected in task deps');
        waves.push(ready);
        order.push(...ready);
        for (const id of ready)
            remaining.delete(id);
    }
    return { waves, order };
}
// condition 规范化（建批静态声明，两种等价形态 → 统一对象数组）：
//   condition: [{ path, exists: true }]（推荐主形态）/ condition: ['plan/spec.md']（字符串简写 = 存在即满足）
// 非法（非数组 / 元素非法 / path 非空字符串 / exists 非 true）→ throw（fail-closed 拒建批）
// 谓词唯一：exists（MVP 只做存在性判定）；exists: false 反向断言超出 MVP，拒建批。
export function normalizeCondition(cond) {
    if (cond == null)
        return null;
    if (!Array.isArray(cond))
        throw new Error('condition must be an array (of {path, exists} objects or path strings)');
    const out = [];
    // 单点断言：Array.isArray 后 cond 为 ConditionClause[] | string[] 之一（元素并集形态），运行期遍历不变
    for (const c of cond) {
        if (typeof c === 'string') {
            if (!c.trim())
                throw new Error('condition path must be a non-empty string');
            out.push({ path: c, exists: true });
        }
        else if (c && typeof c === 'object' && !Array.isArray(c)) {
            if (typeof c.path !== 'string' || !c.path.trim())
                throw new Error('condition path must be a non-empty string');
            if (c.exists !== true)
                throw new Error('condition exists must be true (MVP supports existence predicate only)');
            out.push({ path: c.path, exists: true });
        }
        else {
            throw new Error('condition entries must be {path, exists} objects or path strings');
        }
    }
    return out.length ? out : null; // 空数组 = 无条件（恒满足）
}
// condition 路径契约（与 consume 同源）：相对路径必须在当前批次产物根内（plan/|exec/|audit/ 前缀）；artifacts/ 跨批次先禁；绝对路径放行
// 对所有声明 condition 的任务生效（含 generic 批次），建批入口统一校验（fail-closed 拒建批）
function checkConditionPaths(t, cond) {
    for (const c of cond ?? []) {
        const p = c.path;
        if (isAbsPath(p))
            continue;
        if (p.startsWith('artifacts/'))
            throw new Error('task ' + t.id + ' condition cross-batch reference is disabled in MVP : ' + p);
        if (!/^(plan|exec|audit)\//.test(p))
            throw new Error('task ' + t.id + ' condition must be under plan/|exec/|audit/ or absolute: ' + p);
    }
}
// resume 契约字段规范化（建批静态声明，与 condition 同模式）：
//   checkpoint: { steps: number }（声明本 lane 总步数，供 progress 校验与任务包注入；缺省 null）
//   resume: boolean（声明"崩溃后新 worker 允许参考 checkpoint 跳过已完成步骤"；缺省 false = 现状，行为不变）
// 非法（steps 非正整数 / resume 非 boolean）→ throw（fail-closed 拒建批）
export function normalizeResumeContract(t) {
    let checkpoint = null;
    if (t.checkpoint != null) {
        if (typeof t.checkpoint !== 'object' || Array.isArray(t.checkpoint)) {
            throw new Error('task ' + t.id + ' checkpoint must be an object { steps: number }');
        }
        const steps = t.checkpoint.steps;
        if (!Number.isInteger(steps) || steps < 1) {
            throw new Error('task ' + t.id + ' checkpoint.steps must be a positive integer');
        }
        checkpoint = { steps };
    }
    const resume = t.resume;
    if (resume != null && typeof resume !== 'boolean') {
        throw new Error('task ' + t.id + ' resume must be a boolean');
    }
    return { checkpoint, resume: resume === true };
}
// targets/targetsMarker 契约规范化（targets 声明契约，与 condition/resume 同模式）：
//   targets: string[]——批次产物根外目标文件（exec worker 承诺「修改/生成」的既有文件）的绝对路径数组；
//             相对路径建批拒绝（fail-closed，防把产物相对路径误当 targets）；
//   targetsMarker: string|null——可选内容声明标记（缺省 null = 纯 mtime 校验；非空时目标文件含独立行
//             `targets-claimed: true` 即视为已变更，见 gates.ts checkTargetsGate marker 逃生路径）。
//   targetsNoChange: boolean——零改动声明（缺省 false = 现状：走变更性判定；true 时只核存在性）。
// 非法（targets 非 string 数组 / 空 / 含非绝对路径 / targetsMarker 非 string|null / targetsNoChange 非 boolean）→ throw（fail-closed 拒建批）。
export function normalizeTargetsContract(t) {
    let targets = null;
    if (t.targets != null) {
        if (!Array.isArray(t.targets) || t.targets.length === 0) {
            throw new Error('task ' + t.id + ' targets must be a non-empty string array');
        }
        for (const p of t.targets) {
            if (typeof p !== 'string' || !p.trim()) {
                throw new Error('task ' + t.id + ' targets must be non-empty strings');
            }
            if (!isAbsPath(p)) {
                throw new Error('task ' + t.id + ' targets must be absolute paths (fail-closed, got: ' + p + ')');
            }
        }
        targets = [...t.targets];
    }
    let targetsMarker = null;
    if (t.targetsMarker != null) {
        if (typeof t.targetsMarker !== 'string') {
            throw new Error('task ' + t.id + ' targetsMarker must be a string or null');
        }
        targetsMarker = t.targetsMarker;
    }
    // 缺口修复：零改动声明位——lane 承诺「本 lane 不改动 targets，只核存在性」时置 true。
    //   语义等价于 marker 逃生（显式声明跳过"变更性"判定），但**无需改文件内容**（marker 需要往目标文件写行）；
    //   留痕：gate.target.passed 事件带 mode='no-change' + skippedChange=true（可审计「谁声明了零改动」）。
    let targetsNoChange = false;
    if (t.targetsNoChange != null) {
        if (typeof t.targetsNoChange !== 'boolean') {
            throw new Error('task ' + t.id + ' targetsNoChange must be a boolean');
        }
        targetsNoChange = t.targetsNoChange;
    }
    return { targets, targetsMarker, targetsNoChange };
}
// 任务包 resume 契约固定条款：resume: true 时注入 worker 派发提示词——
//   新 worker 先查 checkpoint 历史（lane_checkpoint_status），从最后已 checkpoint 步骤之后继续，禁止重做；
//   每完成一个子步骤立即 lane_checkpoint（携带 progress），禁止攒批。
export const RESUME_CLAUSE = '若本 lane 存在 checkpoint（lane_checkpoint_status 可查），须先查询 checkpoint 历史，从最后已 checkpoint 的步骤之后继续，禁止重做已完成步骤；每完成一个子步骤立即 lane_checkpoint（携带 progress），禁止攒批。';
// 任务包 resume 条款注入：task.resume === true → 返回固定条款文本（注入派发提示词）；否则 null（不注入，现状）
export function resumeClauseFor(task) {
    return task?.resume === true ? RESUME_CLAUSE : null;
}
// ── 建批期 presence / A1 主防线（r2 新增；O-1 双点强制的主防线）───────────────────────────────
// 依据：`convergence-design.md` §5.1（P1 声明在场 / P2 路径契约 / P5 A1 悬空）· §5.2（建批期落点与两码）
//   · §11.A（A1 双点：主防线 = 建批期，二级防线 = 运行期 `checkCompleteGate`）；
//   `plan/spec.md` §3（`GATE_PLAN_PRESENCE_MISSING` / `GATE_ORPHAN_PRODUCT`）· §验收标准 17 / 21b / 21c。
// 判据同源（O-4.3 / I-2）：逐件调用 `presenceJudge({mode:'declare'})` —— **唯一实现**在
//   `lib/state/gates.ts`（运行期以同一函数的 `mode:'runtime'` 调用）；本文件**不自带**presence 判定
//   （T35 L3 口径：`wave-plan.js` 内该函数的**定义处计数必须 = 0**，只允许**引用**该标识符——故本文件的
//   注释文字也不得出现「定义处」形态的该标识符字面量，避免被正则计数误命中）。
// 可达性（Leader 裁定 R-3）：本组校验由 `validateLayerContract` 调用，而后者在 `buildWavePlan`
//   （`lib/tools/core.js:192`）与 `validateWavePlan`（`:193`）两处被调用 ⇒ 抛出点在 `wave_plan.execute`
//   内**真跑可达**（不是 schema/语法层校验，也不是只在 `validateWavePlan` 的旁路里）。
// 形态保真（Leader 裁定 R-1）：声明字符串**原样**读取；`declaredKindOf` 按**声明原文**判 `/` 结尾，
//   本文件**不做**任何尾斜杠规范化 / strip（`buildWavePlan` 亦以 `[...t.produce]` 原样复制）——
//   这是 e1 目录语义二分（`/` 结尾 = 目录语义）可用的前提。
/** 任务声明面并集（`produce ∪ outputs`，**保留声明原文**，去重保序）。 */
export function declaredArtifactsOf(t) {
    const out = [];
    for (const field of ['produce', 'outputs']) {
        for (const p of (t[field] ?? [])) {
            if (typeof p === 'string' && p.trim().length > 0 && !out.includes(p))
                out.push(p);
        }
    }
    return out;
}
/**
 * A1 悬空产物（plan 层）：被声明的 plan 产物**无任何 lane 的 `consume` 引用**（纯读声明面，不读文件正文）。
 * 有意不对称（`design §11.A`）：exec / audit 层产物悬空**不在此列**（exec 产物可能本就是终端交付物）；
 * 它们由运行期 `gateStrength.orphanProducts` 强告警可见（不拒）。
 */
function orphanPlanProductsOf(tasks) {
    const consumed = new Set();
    for (const t of tasks) {
        for (const c of (t.consume ?? []))
            if (typeof c === 'string')
                consumed.add(c);
    }
    const orphans = [];
    for (const t of tasks) {
        if (t.layer !== 'plan')
            continue;
        for (const p of declaredArtifactsOf(t))
            if (!consumed.has(p))
                orphans.push(p);
    }
    return orphans;
}
/**
 * 建批期 presence 硬约束 + A1 主防线（fail-closed 拒建批）。两码分工（spec §3 / design §5.2）：
 *   · `GATE_PLAN_PRESENCE_MISSING`：plan lane **未声明**产物 / 声明违反 presence 契约（P1 / P2）；
 *   · `GATE_ORPHAN_PRODUCT`：声明了但**无人 consume**（P5 / A1）⇒ 主防线拒建批。
 * 仅 plan 层（`design §11.A`/A2：exec/audit 的「无产物声明」归运行期 `GATE_EXIT_NO_DECLARATION`，
 * 建批期不扩张该面）；非三层批（无 plan lane）零感知。
 */
function checkPlanPresenceContract(tasks) {
    const planLanes = tasks.filter((t) => t.layer === 'plan');
    if (planLanes.length === 0)
        return;
    for (const t of planLanes) {
        const declared = declaredArtifactsOf(t);
        if (declared.length === 0) {
            throw new Error('GATE_PLAN_PRESENCE_MISSING: plan lane ' + t.id
                + ' declares no produce/outputs — plan 产物必须指导下游执行（拒绝免检：缺声明即拒，无 legacy 回落）');
        }
        for (const p of declared) {
            // 逐件走唯一实现（`declaredKind: 'array'` = 声明以数组形态给出；形态按声明原文判 `/` 结尾）
            const v = presenceJudge({
                mode: 'declare', layer: 'plan', declared: [p], declaredKind: 'array', abs: null, content: null,
            });
            if (!v.ok) {
                throw new Error('GATE_PLAN_PRESENCE_MISSING: plan lane ' + t.id + ' declaration ' + JSON.stringify(p)
                    + ' violates the presence contract (mode=declare, declaredKind=' + declaredKindOf(p) + '): '
                    + (v.problems ?? []).join('; '));
            }
        }
    }
    const orphans = orphanPlanProductsOf(tasks);
    if (orphans.length > 0) {
        throw new Error('GATE_ORPHAN_PRODUCT: plan product(s) declared but consumed by no lane: ' + JSON.stringify(orphans)
            + ' — A1 主防线（O-1）：plan 产物必须被至少一条 lane 的 consume 引用；exec/audit 层悬空仅告警不拒（有意不对称）');
    }
}
// 三层契约静态校验（仅当任一 lane 声明 layer 时启用；generic 批次跳过）
function validateLayerContract(tasks, opts = {}) {
    const plan = tasks.filter((t) => t.layer === 'plan');
    const exec = tasks.filter((t) => t.layer === 'exec');
    const audit = tasks.filter((t) => t.layer === 'audit');
    const used = tasks.some((t) => t.layer != null && LAYERS.includes(t.layer));
    if (!used)
        return;
    if (exec.length === 0 && audit.length === 0 && plan.length === 0) {
        throw new Error('three-tier: layer must be one of plan/exec/audit');
    }
    // 有 exec 必有 audit
    if (exec.length > 0 && audit.length === 0) {
        throw new Error('three-tier: exec layers require at least one audit lane');
    }
    // P1（2026-09-14 用户裁决，**全局严格**）：**audit 的判据来源是设计不变量**——三层批中，
    //   只要有 audit lane 声明了 `consume`，就必须**至少一条** audit lane 消费到 **plan 层产物**（验收标准载体）；
    //   否则拒建批 `GATE_AUDIT_INPUT_MISSING`。
    //   语义依据（2026-09-14 用户澄清）：audit 层对的是**总体任务验收**，判据来自 plan 的验收标准；
    //   exec 层的 `reviewer` 只是「初步 audit」（消费 tester 结果），**不外延到总体验收** ⇒ 不能替代本锚定。
    //   判据口径：① 路径在 `plan/` 前缀内，或 ② 由某条 plan lane 显式声明产出（覆盖绝对路径/自定义布局）；
    //   落**批级**而非逐 lane——多 audit lane 设计（panel/aggregate/critic）不必每条都直接消费 spec。
    //   边界：未声明 `consume` 的 audit lane 不在本检查内（由团队 `entry_requires: ['consume']` 在派发面拦）。
    //   内容面（产物正文须含裸标题 `## 验收标准`）在建批时产物尚未生成 ⇒ 落在 entry 期（state/gates.ts）。
    if (audit.length > 0 && plan.length > 0) {
        const planProducts = new Set();
        for (const p0 of plan) {
            for (const f of ['produce', 'outputs']) {
                for (const p of p0[f] ?? [])
                    planProducts.add(p);
            }
        }
        const isPlanProduct = (p) => (typeof p === 'string' && p.startsWith('plan/')) || planProducts.has(p);
        const consuming = audit.filter((a) => Array.isArray(a.consume) && a.consume.length > 0);
        const anchored = consuming.some((a) => (a.consume ?? []).some((p) => isPlanProduct(p)));
        if (consuming.length > 0 && !anchored) {
            const detail = consuming.map((a) => a.id + ':' + JSON.stringify(a.consume ?? [])).join('; ');
            throw new Error('GATE_AUDIT_INPUT_MISSING: no audit lane consumes a plan-layer product (criteria source) — audit lanes: ' + detail);
        }
    }
    // 路径契约一致性：相对路径必须在当前批次产物根内（plan/exec/audit 前缀）；跨批次 artifacts/ 先禁；绝对路径放行（由运行时 gate 校验存在性）
    const checkPaths = (t, field) => {
        for (const p of t[field] ?? []) {
            if (typeof p !== 'string' || !p.trim())
                throw new Error('task ' + t.id + ' ' + field + ' must be non-empty strings');
            if (isAbsPath(p))
                continue;
            if (p.startsWith('artifacts/'))
                throw new Error('task ' + t.id + ' ' + field + ' cross-batch reference is disabled in MVP : ' + p);
            if (!/^(plan|exec|audit)\//.test(p))
                throw new Error('task ' + t.id + ' ' + field + ' must be under plan/|exec/|audit/ or absolute: ' + p);
        }
    };
    for (const t of tasks) {
        if (t.layer != null && LAYERS.includes(t.layer)) {
            checkPaths(t, 'consume');
            checkPaths(t, 'produce');
            checkPaths(t, 'outputs');
            // condition 结构/路径校验在建批入口对所有任务统一做（见 buildWavePlan），此处不重复
        }
    }
    // 跨层引用：exec.consume 的相对 plan/ 路径必须由 plan 层 produce 提供（建批静态校验）
    const planProduces = new Set(plan.flatMap((t) => t.produce ?? []));
    for (const t of exec) {
        for (const p of t.consume ?? []) {
            if (p.startsWith('plan/') && !planProduces.has(p)) {
                throw new Error('task ' + t.id + ' consumes "' + p + '" which is not produced by any plan lane');
            }
        }
    }
    // skill 声明校验：非空字符串；真实存在性由装配/技能库在注册侧保证
    for (const t of tasks) {
        if (t.skills != null) {
            if (!Array.isArray(t.skills) || t.skills.length === 0 || t.skills.some((s) => typeof s !== 'string' || !s.trim())) {
                throw new Error('task ' + t.id + ' skills must be a non-empty string array');
            }
        }
        if (t.role != null && (typeof t.role !== 'string' || !t.role.trim())) {
            throw new Error('task ' + t.id + ' role must be a non-empty string');
        }
    }
    // r2 建批期 presence 硬约束 + A1 主防线（**追加在全部既有 throw 之后**）——
    //   位置刻意置于函数末尾：既有拒因（跨层引用 / 路径契约 / 有 exec 必有 audit / audit 判据锚定 /
    //   skills 声明）的触发优先级与消息逐字不变（`contract.test.js` 的 `/not produced by any plan lane/`
    //   等既有断言不受影响），新增两道码只在既有检查全通过后才可能触发。
    // gate-lite Q-G1（2026-09-17 用户裁决「开显式豁免键」）——**冒烟/探针批**（`smoke: true`）跳过本段：
    //   `GATE_PLAN_PRESENCE_MISSING` / `GATE_ORPHAN_PRODUCT` 均属**产物契约类**门，而冒烟批的全部意义就是
    //   「无产物契约地跑通一条通路」（单 lane、不声明产物）⇒ 硬拦即自相矛盾（本轮 Leader 实测两次被此两码拒）。
    //   边界（明示，防扩权）：只跳本段——本函数内其余拒因（有 exec 必有 audit / audit 判据锚定 / 路径契约 /
    //   skills 声明）与**行为安全门**（派发准入 lane 存在性、单写者锁、终态冻结 `GATE_BATCH_TERMINAL`）一字不动。
    if (opts.smoke !== true)
        checkPlanPresenceContract(tasks);
}
// 引擎注入 cmd 前缀：按 role 契约 + 装配的 skill 能力，Leader 只写任务内容
export function assembleCmd(role, skills, cmd) {
    const parts = [];
    if (role)
        parts.push('[role=' + role + ']');
    if (Array.isArray(skills) && skills.length)
        parts.push('[skills=' + skills.join(',') + ']');
    return parts.length ? parts.join(' ') + ' ' + (cmd ?? '') : (cmd ?? '');
}
// P1（2026-09-16）：`team` 改为**必填**（原 `team = 'generic'` 缺省已删）——`generic` 已废除，
//   **不再有任何第二默认值真源**（读端 `?? 'generic'` 同批清退：store/snapshot/agent-descriptor）。
//   运行期缺 `team` ⇒ 本函数**不代造默认值**（落 `team: team`），构造期拒由工具面负责
//   （`lib/tools/core.js` `assertTeamNameRequired` / `assertTeamAssetReady`，在 `createBatch` 之前 throw）：
//   **直调本函数不走同一门 = 已登记差异 W-2**（P1 不消，超范围——不在此处新增硬拦）。
// ── P1/P2 交接门开关（`task-27` 2026-09-17 设计修正）：**唯一解析点** ────────────────────────────
// 背景（用户裁决）：「门禁应该**只与插件有关**，和父进程无关，也和 dsh 底座无关」——原实现读
//   `process.env.PSWARM_HANDOFF_GATE` ⇒ 插件行为被**启动父进程的环境块**绑架（本机 web 宿主由常驻
//   Desktop 应用派生，其环境块早于变量设置 ⇒ 重启多少次都带不进来）。现改为**插件自己的热配置**：
//     真源 = `<root>/config/runtime.json` 顶层 `gates.handoff.{entry,settle}`
//       （`lib/hot/config-watch.js`：fs.watch + 防抖 → 快照 → `config.changed`；`gates` 已入允许键白名单）；
//     **env 降为兜底**（`PSWARM_HANDOFF_GATE`，兼容既有行为与夹具），**缺省仍关**。
// 单一解析点纪律（硬）：三处消费点（① 建批期 `checkHandoffDeclarations` ② entry 门 ③ 出口门）**全部**经本组
//   函数取值；`process.env.PSWARM_HANDOFF_GATE` **只允许出现在本文件内**（grep 判据）。**禁两套读取**。
export const HANDOFF_GATE_ENV = 'PSWARM_HANDOFF_GATE';
const asBool = (v) => (typeof v === 'boolean' ? v : null);
/** 解析门态（**唯一真源**）。优先级（**逐段独立**）：段级 runtime 键 > 段内 `enabled` > env 兜底 > 缺省关。
 *  「逐段独立」的理由：`{ handoff: { settle: true } }` 这类**只写一段**的配置若整体回落 env，会出现
 *  「写了 settle 却把 entry 交给环境变量」的静默半开面（实测踩点：ambient env 可让本意只开一段的配置
 *  连带开另一段）⇒ 未显式声明的段一律走 `enabled`/env/缺省，不连坐。 */
export function handoffGateStateOf(liveConfig, env = process.env) {
    const raw = String(env?.[HANDOFF_GATE_ENV] ?? '').toLowerCase();
    const envOn = raw === '1' || raw === 'true' || raw === 'on';
    const gates = (liveConfig && typeof liveConfig === 'object' && !Array.isArray(liveConfig))
        ? liveConfig.gates : null;
    const handoff = (gates && typeof gates === 'object' && !Array.isArray(gates))
        ? gates.handoff : null;
    if (handoff && typeof handoff === 'object' && !Array.isArray(handoff)) {
        const h = handoff;
        const enabled = asBool(h.enabled);
        const eRaw = asBool(h.entry);
        const sRaw = asBool(h.settle);
        const entry = eRaw ?? enabled ?? envOn;
        const settle = sRaw ?? enabled ?? envOn;
        // 只要该段有**本段/段级**显式布尔来源，就记 source='runtime'（env 仅作未声明段的缺省）
        const explicit = eRaw !== null || sRaw !== null || enabled !== null;
        if (explicit)
            return { entry, settle, source: 'runtime' };
    }
    if (envOn)
        return { entry: true, settle: true, source: 'env' };
    return { entry: false, settle: false, source: 'default' };
}
/** 单段判定（薄封装；三处消费点用这个）。 */
export function handoffGateEnabledOf(liveConfig, stage = 'entry', env = process.env) {
    return handoffGateStateOf(liveConfig, env)[stage];
}
// ── P1 交接门：建批期校验（裁决 ②=A，2026-09-17）─────────────────────────────────────────────
// 判据（**只判一件事**，避免把「DAG 有依赖」误判成「缺交接」）：
//   下游 lane 的某条 `deps` 入边，其**上游 lane 未声明任何交付产物**（`produce ∪ outputs` 皆空）
//   ⇒ 该入边**不可能**产出交接（`handoff_submit` 的 artifacts 必填 ⇒ 无件可交）⇒ 下游永远拿不到依赖 ⇒ **建批期即拒**。
//   反例说明（为什么不否掉「有 deps 但未交接」本身）：**建批期种子**（`store.createBatch` 按每条 deps 入边种
//   `status:'pending'` 的交接条）正是「交接声明来源」——把常态判成缺口会误拒**所有** DAG 批（实测：一次性
//   159 例回归）。「未交接」的拒态属**运行期** entry 门（`GATE_HANDOFF_MISSING`），不属建批期。
// 注：`deps` 指向**不存在的 id** 由 `topoWaves` 报（`depends on unknown id`），本函数不抢答其语义。
// `smoke:true`（冒烟/探针批，gate-lite Q-G1）⇒ 与产物契约类门同键豁免。
function checkHandoffDeclarations(tasks, opts = {}) {
    if (opts.smoke === true)
        return;
    // 策略值由**调用方**解析后传入（工具面持 liveConfig ⇒ 传 `handoffGateEnabledOf(readLiveConfig(deps),'entry')`）；
    //   缺省（直调 `buildWavePlan` / 单测）走**缺省配置**的兜底解析（env → 缺省关）—— 单一解析点不变。
    const gateOn = opts.handoffGate ?? handoffGateEnabledOf({}, 'entry');
    if (!gateOn)
        return; // 门关 ⇒ 建批期零行为变化
    const byId = new Map();
    for (const t of tasks)
        if (t && typeof t.id === 'string' && t.id.length > 0)
            byId.set(t.id, t);
    const delivers = (t) => {
        const up = t;
        const ok = (v) => Array.isArray(v) && v.some((p) => typeof p === 'string' && p.length > 0);
        return !!up && (ok(up.produce) || ok(up.outputs));
    };
    const gaps = [];
    for (const t of tasks) {
        if (!t || typeof t.id !== 'string')
            continue;
        const deps = Array.isArray(t.deps) ? t.deps : [];
        for (const d of deps) {
            if (typeof d !== 'string' || d.length === 0)
                continue;
            if (d === t.id)
                continue; // 自指由 topoWaves 报（同一家族）
            if (!byId.has(d))
                continue; // 悬空 id 由 topoWaves 报（不抢答）
            if (!delivers(byId.get(d)))
                gaps.push('edge:' + d + '->' + t.id + ' (上游 lane ' + d + ' 未声明任何交付产物 `produce`/`outputs` ⇒ 无件可交)');
        }
    }
    if (gaps.length > 0) {
        throw new Error('GATE_HANDOFF_MISSING: 下游 lane 的 deps 入边**无交接声明来源**（上游未声明交付产物 ⇒ 交接不可能成立）'
            + ' ⇒ 拒建批（零批次落盘）；缺口：' + gaps.join(', ')
            + ' ——请为上游 lane 声明 `produce`/`outputs`（交接件来源），或经 `smoke: true` 显式声明冒烟/探针批豁免。');
    }
}
// ── §5.1 配对基数软校验（`pair_with` 退役后的替代面；**只告警不拒**） ─────────────────────────
/**
 * 判据（规格 `plan/debt-spec.md` §2.1 方案 R，**只读、零副作用**）：对每条 `layer === 'audit'` 的 task，
 * 取其 `deps` 中每条 `layer === 'exec'` 的入边 `E`（= 本 audit lane **认领**了一条 exec lane），
 * 若本 lane 的 `consume` **未覆盖 `E` 的任何交付产物**（`E.produce ∪ E.outputs`；两者皆空 ⇒ 视为覆盖缺失）
 * ⇒ 产一条**告警**（「疑似配对基数漂移：认领即须声明消费该 exec 的产物」+ 建议）。
 *
 * 【2026-09-18 · 替换判据（G-08）】**旧判据已退役**：它比较的是「上游 exec lane 的 `deps` 是否覆盖本 audit
 * lane 的 `deps` 且严格更大」——该判据在**任何合法拓扑下不可满足**（本 audit lane 的 `deps` 含该 exec lane
 * 自身，而任何 lane 的 `deps` 都不含自身；要满足覆盖即须自指环，而该构造在建批期先被 `topoWaves` 以
 * `cycle detected in task deps` 拒绝）⇒ 旧判据恒 `false`，是**零可达性的空转校验**（退役表达式原文与原始读数见
 * `exec/pairing-panel.md` §U-7 与探针 `exec-pairing-panel/probe/u7-reachability.json`，本 docstring 不复制该表达式）。
 * 替换判据与旧判据**注释自述的语义**同旨（「一条 exec lane 被 ≥2 条 audit lane 认领且认领集不同」）：
 * 认领集 = `deps ∩ exec`，覆盖面 = 本 lane 的 `consume`。可达性实证见 `test/wave-plan-pairing.test.js`
 * （六格构造：不可达 3 + 可达 3，逐格断言 + 原始读数）。
 *
 * **不得升级为拒建批**（与容忍口径同纪律）：现网 `leader-direct` 批的 audit lane 常为**单条聚合**
 * （`docs/engine-design-adjudication-20260918.md:46` 实证：声明 3 exec 分支 + `pair_with:"exec"`，实批 1 条聚合
 * audit lane）⇒ 硬拒会**立刻**打断既有建批。`pair_with` 退役后 1:1 配对改由 audit lane 显式 `deps` 表达
 * （`deps` **恰为** `[<对应 exec lane>]`）**并显式消费其交付产物**；跨层聚合由该 audit lane 显式声明全部目标 lane
 * 且逐条消费其产物（认领即须消费）。
 */
export function collectAuditPairingWarnings(tasks) {
    const out = [];
    const byId = new Map();
    for (const t of tasks)
        if (t && typeof t.id === 'string' && t.id.length > 0)
            byId.set(t.id, t);
    const strsOf = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : [];
    // 字段访问走单点断言（`WaveTask` = 输入/持久两形态并集，与同文件既有写法同款）
    const depsOf = (t) => strsOf(t?.deps);
    const consumeOf = (t) => strsOf(t?.consume);
    /** 交付产物 = `produce ∪ outputs`（去重；两侧皆空 ⇒ 空集 = 无件可被消费）。 */
    const deliveredOf = (t) => [...new Set([
            ...strsOf(t?.produce),
            ...strsOf(t?.outputs),
        ])];
    for (const t of tasks) {
        if (!t || t.layer !== 'audit')
            continue;
        const own = depsOf(t);
        if (own.length === 0)
            continue;
        const consumed = new Set(consumeOf(t));
        for (const d of own) {
            const up = byId.get(d);
            if (!up || up.layer !== 'exec')
                continue; // 只认领 exec lane（plan/audit 入边不属本判据）
            const delivered = deliveredOf(up);
            // 覆盖判据：该 exec lane 的交付产物**至少一件**被本 audit lane 显式 consume；交付面为空 ⇒ 视为未覆盖
            if (delivered.length > 0 && delivered.some((p) => consumed.has(p)))
                continue;
            out.push({
                code: 'GATE_PAIRING_CARDINALITY_DRIFT',
                task: t.id,
                message: 'audit lane ' + t.id + ' 的 deps 认领了 exec lane ' + d + '（认领即须声明消费该 exec 的产物），'
                    + '但本 lane 的 consume(' + [...consumed].join(',') + ') 未覆盖 ' + d + ' 的任何交付产物'
                    + (delivered.length > 0
                        ? '（' + d + ' 交付：' + delivered.join(',') + '）'
                        : '（' + d + ' **未声明任何交付产物** `produce`/`outputs` ⇒ 视为覆盖缺失）')
                    + ' ⇒ 疑似配对基数漂移：`pair_with` 已退役（Q-A=C），认领集 `deps ∩ exec` 与消费面 `consume` 须逐条对齐'
                    + '（跨层聚合的 audit lane 请把每条目标 exec lane 的交付产物显式写进 `consume`）。'
                    + '**本告警不拒建批**（软校验：只告警，交 Leader/审计裁量）。',
            });
        }
    }
    return out;
}
// ── 建批主函数 ──────────────────────────────────────────────────────────────
export function buildWavePlan({ batchId, tasks, concurrency = 5, team, assembly, teamsRoot = undefined, smoke = false, handoffGate = undefined }) {
    if (!batchId || typeof batchId !== 'string')
        throw new Error('batchId required');
    // P1 交接门建批期判据（裁决 ②=A）**先于** `topoWaves`：deps 悬空在本门是 `GATE_HANDOFF_MISSING`
    //   （给出「缺哪条边 / 缺哪件来源」），若后置会被 `topoWaves` 的 `depends on unknown id` 抢答 ⇒
    //   调用方拿不到新码语义（码面契约见 §7 判据 1/2）。非 deps 的其它拓扑违规仍由 `topoWaves` 原样报。
    checkHandoffDeclarations(tasks, { smoke: smoke === true, ...(handoffGate === undefined ? {} : { handoffGate }) });
    const { waves } = topoWaves(tasks);
    validateLayerContract(tasks, { smoke: smoke === true });
    // 团队角色集（可拔插）——角色词法集 = 资产**各层声明角色** ∪ `roles.extra`（`unionRoleVocabulary`）；
    //   `plan_leads` / `audit_leads`（额外牵头角色）另计、与引擎基础牵头集并集。
    //   缺声明/加载失败 → 空集 = 与重构前逐字一致。
    //   缺口修复（2026-09-14）：extraRoles 曾只取 `roles.extra` ⇒ 「角色已写进资产 layers 但没抄进 roles.extra」
    //   的团队，每个自定义角色被判 GATE_ROLE_INVALID（指引说放开角色组装、白名单却只认 roles.extra）——现同源。
    const teamRoles = resolveTeamRoles(team, teamsRoot ? { root: teamsRoot } : {});
    const extraRoles = teamRoles.ok ? unionRoleVocabulary(teamRoles) : [];
    const roleOpts = {
        extraRoles,
        planLeads: teamRoles.ok ? teamRoles.planLeads : [],
        auditLeads: teamRoles.ok ? teamRoles.auditLeads : [],
    };
    // role 集合校验（GATE_ROLE_INVALID，warning 语义：事件留痕、不阻断建批、保持兼容）——
    // 仅「显式声明且非空、但不在合法集合」的 role 触发告警；未声明（走默认值）与归一化后合法的角色不告警
    const warnings = [];
    for (const t of tasks) {
        if (typeof t.role === 'string' && t.role.trim() && normalizeRole(t.role, extraRoles) === null) {
            warnings.push({
                code: 'GATE_ROLE_INVALID',
                task: t.id,
                role: t.role,
                message: 'task ' + t.id + ' role "' + t.role + '" is not a valid role (' + [...VALID_ROLES, ...ROLE_EXTENSIONS].join('/') + ', or any role declared by the team asset); kept as-is for compatibility, layer default applies only when role is omitted',
            });
        }
    }
    // C 类批次角色齐备门禁（GATE_ROLE_MISSING，warning 语义）——并入同一收集循环/同一返回结构；
    // 仅 C 类形态（多 wave/多 lane/跨层依赖）且对应层存在时检查；单 lane 批次不触发
    warnings.push(...collectRoleCompletenessWarnings(tasks, waves, roleOpts));
    // §5.1 配对基数软校验（`pair_with`/`perLane` 退役后的替代面）——**只告警不拒**（与容忍口径同纪律）。
    warnings.push(...collectAuditPairingWarnings(tasks));
    const wavePlan = waves.map((ids, idx) => ({
        wave: idx + 1,
        tasks: ids.map((id) => {
            // 单点断言：ids 来自 topoWaves(tasks)（同一 tasks 的拓扑序），find 必命中（断言纯类型层）
            const t = tasks.find((x) => x.id === id);
            const layer = t.layer ?? undefined;
            // 默认值修正：task 未显式声明 role → 按 layer 取缺省（plan→designer / audit→supervisor / exec→coder；generic 无 layer → null 现状）
            const rawRole = t.role ?? defaultRoleForLayer(layer);
            // 大小写归一化：合法角色（Designer→designer）存小写规范名；非法角色保留原值（兼容，GATE_ROLE_INVALID 告警暴露）
            const role = normalizeRole(rawRole, extraRoles) ?? rawRole;
            let skills = t.skills;
            // 装配补全（可插拔）：未显式声明 skills 时，按 team 装配表的 role → skills 补全（assembly 可选）
            // layer 为 Layer|undefined：undefined 时索引装配表 miss（JS 属性键字符串化语义一致），断言仅类型层
            if (assembly && role && skills === undefined) {
                const entry = assembly?.layers?.[layer]?.skills?.[role];
                if (entry)
                    skills = entry;
            }
            // condition 结构 + 路径校验（对所有任务，含 generic），fail-closed 拒建批
            const condition = normalizeCondition(t.condition);
            checkConditionPaths(t, condition);
            // resume 契约字段校验 + 透传（checkpoint{steps}/resume 布尔；默认关场景仅存元数据，消费方按开关生效）
            const resumeContract = normalizeResumeContract(t);
            // targets/targetsMarker 契约校验 + 透传（绝对路径 fail-closed 拒建批；未声明 = null = 零感知，
            // 仿 condition 可选字段模式，不升 batch schema 版本）
            const targetsContract = normalizeTargetsContract(t);
            // standalone 契约——lane 声明「无上游消费」（`entry_requires: ['consume']` 强制时的**显式逃生**）。
            //   语义：该 lane 不消费任何上游产物（如批次首 lane、纯取证 lane）；缺省 false = 走 consume 校验。
            //   留痕：entry gate 放行时返回值带 `standalone: true`（store 侧事件可审计「谁声明了无上游」）。
            if (t.standalone != null && typeof t.standalone !== 'boolean') {
                throw new Error('task ' + t.id + ' standalone must be a boolean');
            }
            // B4 逃生阀**可达化**（R-01b，本批 e1 扩面唯一用途）：`standaloneReason` 必须随归一化**落盘**——
            //   entry 门的 standalone 事实核验读该字段（`gates.ts` `standaloneVerdict`）⇒ 归一化丢弃它
            //   会让**任何真实批次**的 standalone 逃生阀恒判 `GATE_STANDALONE_UNJUSTIFIED`（逃生阀不可达）。
            //   类型面说明：`lib/types/contracts.ts` **不在本 lane 白名单写域**（仅 gates.ts / event-types.js /
            //   wave-plan.ts / flows.js）⇒ 以**单点断言**读取该字段（断言纯类型层、运行期零额外语义），
            //   与 `gates.ts` `standaloneVerdict` 的同款断言一致。
            //   取值：非字符串（含缺省）⇒ `null`（与 `targetsMarker` 同风格：缺省落 null 不落 undefined）；
            //   「非空」义务不在建批期判（建批期只判布尔类型；非空 + 无可用上游的语义判据在 entry 门）。
            const standaloneReason = typeof t.standaloneReason === 'string'
                ? t.standaloneReason
                : null;
            return {
                id: t.id,
                cmd: assembleCmd(role, skills, t.cmd ?? ''),
                deps: Array.isArray(t.deps) ? [...t.deps] : [],
                model: t.model ?? null,
                tools: Array.isArray(t.tools) ? [...t.tools] : null,
                layer: t.layer ?? null,
                role: role ?? null,
                skills: skills ? [...skills] : null,
                consume: Array.isArray(t.consume) ? [...t.consume] : null,
                standalone: t.standalone === true, // true = 声明无上游消费（entry 强制的显式逃生）
                standaloneReason, // B4/R-01b：归一化**保留**理由字段（逃生阀可达化；缺省 null）
                produce: Array.isArray(t.produce) ? [...t.produce] : null,
                outputs: Array.isArray(t.outputs) ? [...t.outputs] : null,
                condition, // lane 条件（统一对象数组形态；缺省 null = 恒满足）
                checkpoint: resumeContract.checkpoint, // { steps } | null（总步数声明，供 progress 校验与任务包注入）
                resume: resumeContract.resume, // boolean（缺省 false = 现状，行为不变）
                targets: targetsContract.targets, // string[] | null（绝对路径目标文件声明；未声明 null = 零感知）
                targetsMarker: targetsContract.targetsMarker, // string | null（内容声明标记；缺省 null = 纯 mtime 校验）
                targetsNoChange: targetsContract.targetsNoChange, // true = 零改动声明（跳过变更性判定，仅核存在性）
            }; // 单点断言：`standaloneReason`（B4/R-01b）不在 `WavePlanTask` 类型面
            //   （lib/types/contracts.ts 非本 lane 写域）⇒ 仅类型层断言，运行期对象形态即上述字面量本身。
        }),
    }));
    // 【2026-09-18 · Q-B 取消并发闸】`concurrency` **保留为纯声明 + 回显、零判定**（上游裁决
    //   `docs/engine-design-adjudication-20260918.md:182`）：本行**归一**与下方**回显**逐字不变（改回显/删参数会破
    //   `wave-plan.test.js:44,49,73-75` 与 `gates.test.js:40` 的既有断言），但引擎内**不再有任何分支读它做准入**
    //   （原唯一执行点 = `lib/engine/dispatch.js` 的并发闸，已随 Q-B 整体删除）。
    const concurrencyN = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 5;
    return {
        schema: SCHEMA_VERSION,
        batchId,
        team: team, // P1：删除 `|| 'generic'` 兜底（第二默认值真源清退）；缺 team 的批在工具面已被构造期拒
        wavePlan,
        concurrency: concurrencyN,
        warnings, // role 校验告警（GATE_ROLE_INVALID，warning 语义：不阻断建批；事件留痕由调用方落批次）
    };
}
export function validateWavePlan(plan, opts = {}) {
    if (!plan || typeof plan !== 'object')
        throw new Error('wavePlan must be an object');
    if (plan.schema !== SCHEMA_VERSION)
        throw new Error('unsupported wavePlan schema: ' + String(plan.schema));
    if (!plan.batchId || typeof plan.batchId !== 'string')
        throw new Error('wavePlan.batchId required');
    if (!Array.isArray(plan.wavePlan) || plan.wavePlan.length === 0)
        throw new Error('wavePlan.wavePlan required');
    const seen = new Set();
    for (const w of plan.wavePlan) {
        if (!Number.isInteger(w.wave) || w.wave < 1)
            throw new Error('wave number invalid');
        if (!Array.isArray(w.tasks))
            throw new Error('wave tasks must be an array');
        for (const t of w.tasks) {
            if (!t || typeof t.id !== 'string' || seen.has(t.id))
                throw new Error('task id invalid/duplicate');
            seen.add(t.id);
            if (t.model !== null && typeof t.model !== 'string')
                throw new Error('task model must be string or null');
            if (t.cmd !== undefined && typeof t.cmd !== 'string')
                throw new Error('task cmd must be string');
            if (t.tools !== undefined && t.tools !== null && (!Array.isArray(t.tools) || t.tools.some((x) => typeof x !== 'string')))
                throw new Error('task tools must be string array or null');
            if (t.layer != null && !LAYERS.includes(t.layer))
                throw new Error('task layer invalid: ' + t.layer);
            for (const f of ['consume', 'produce', 'outputs', 'skills']) {
                if (t[f] != null && (!Array.isArray(t[f]) || t[f].some((x) => typeof x !== 'string')))
                    throw new Error('task ' + f + ' must be string array');
            }
            // condition 规范化形态校验（建批后 wavePlan JSON 应为对象数组或 null）
            if (t.condition != null) {
                if (!Array.isArray(t.condition) || t.condition.some((c) => !c || typeof c !== 'object' || Array.isArray(c) || typeof c.path !== 'string' || c.exists !== true)) {
                    throw new Error('task condition must be [{path, exists: true}, ...] array or null');
                }
                checkConditionPaths(t, t.condition);
            }
            // checkpoint/resume 形态校验（建批后 wavePlan JSON 应为 {steps} | null / boolean）
            if (t.checkpoint != null && (typeof t.checkpoint !== 'object' || Array.isArray(t.checkpoint) || !Number.isInteger(t.checkpoint.steps) || t.checkpoint.steps < 1)) {
                throw new Error('task checkpoint must be { steps: positive int } or null');
            }
            if (t.resume != null && typeof t.resume !== 'boolean') {
                throw new Error('task resume must be boolean');
            }
            // targets/targetsMarker 形态校验（与建批规范化同语义，防伪造/篡改）：
            // targets 为绝对路径 string 数组（相对路径 fail-closed 拒）；targetsMarker 为 string|null
            if (t.targets != null && (!Array.isArray(t.targets) || t.targets.length === 0 || t.targets.some((x) => typeof x !== 'string' || !x.trim() || !isAbsPath(x)))) {
                throw new Error('task targets must be a non-empty string array of absolute paths');
            }
            if (t.targetsMarker != null && typeof t.targetsMarker !== 'string') {
                throw new Error('task targetsMarker must be string or null');
            }
        }
    }
    const flat = plan.wavePlan.flatMap((w) => w.tasks);
    topoWaves(flat);
    validateLayerContract(flat, { smoke: opts.smoke === true });
    return true;
}
