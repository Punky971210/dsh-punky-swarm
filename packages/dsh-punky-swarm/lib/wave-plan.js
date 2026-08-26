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
// cmd 由引擎注入 role/skill 前缀（装配可插拔，不绑定 jiufeng，见设计 §12.1/§14.2/§15.3）。
// resume 契约：task 可声明 checkpoint:{steps}（总步数）与 resume:boolean
// （崩溃后新 worker 允许参考 checkpoint 跳过已完成步骤）——校验放行 + 字段透传（与 condition 同模式，
// 默认关场景仅存元数据，消费方按 capabilities.worktree.enabled 开关生效）；resumeClauseFor(task) 供
// 派发侧注入固定任务包条款（RESUME_CLAUSE）。

import { BLIND_REVIEW_ROLES } from './assembly/schema.js';

const SCHEMA_VERSION = 1;

export const LAYERS = ['plan', 'exec', 'audit'];

// 合法角色集合（jiufeng-team 8 角色，任务权威；大小写兼容，内部归一化小写）
export const VALID_ROLES = ['coordinator', 'manager', 'designer', 'coder', 'tester', 'reviewer', 'supervisor', 'doc-manager'];
// 装配扩展角色（盲审三角色，与 assembly/schema.js BLIND_REVIEW_ROLES 同源；装配可插拔扩展点）
export const ROLE_EXTENSIONS = BLIND_REVIEW_ROLES;
// 校验白名单 = 8 角色 ∪ 装配扩展（既有合法装配角色不误报）
export const ROLE_WHITELIST = new Set([...VALID_ROLES, ...ROLE_EXTENSIONS]);

// role 归一化：合法角色（大小写不敏感）→ 小写规范名；非法/未声明 → null
export function normalizeRole(role) {
  if (role == null) return null;
  if (typeof role !== 'string') return null;
  const norm = role.trim().toLowerCase();
  return ROLE_WHITELIST.has(norm) ? norm : null;
}

// layer → 缺省 role（task 未显式声明 role 时）：plan→designer / audit→supervisor / exec→coder；
// 未声明 layer（generic 任务）→ null（保持现状：不注入 role 前缀，不改变既有 generic 语义）
export function defaultRoleForLayer(layer) {
  if (layer === 'plan') return 'designer';
  if (layer === 'audit') return 'supervisor';
  if (layer === 'exec') return 'coder';
  return null;
}

// C 类批次角色齐备门禁（GATE_ROLE_MISSING，warning 语义：事件留痕、不阻断建批，与 GATE_ROLE_INVALID 一致；后续可配 enforce）——
// 背景：实跑证实 C 类批次（多 wave/多 lane/跨层）常缺 plan 层 designer 与 audit 层 supervisor（被 planner/auditor 或 Leader 代劳）。
// C 类形态判定（复用 wavePlan 拓扑信息）：wave 数 >1 或 lane 数 >1 或存在跨 layer 依赖；单 lane 批次（非 C 类形态）不触发本门禁。
export const PLAN_LEAD_ROLES = new Set(['designer', 'coordinator', 'manager']); // plan 层牵头角色（manager 为 continuable subagent 常驻牵头）
export const AUDIT_LEAD_ROLES = new Set(['supervisor', 'doc-manager']); // audit 层牵头角色

// 跨 layer 依赖：任一任务的 deps 中存在 layer 与自身不同的依赖（DAG 跨层编排）
function hasCrossLayerDep(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.some((t) => {
    if (!t.layer) return false;
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
function effectiveRole(t) {
  return normalizeRole(t.role ?? defaultRoleForLayer(t.layer));
}

// C 类批次角色齐备检查：plan 层 lane 需至少一个 designer/coordinator；audit 层 lane 需至少一个 supervisor/doc-manager；
// 层不存在（无该层 lane）不检查（validateLayerContract 既有语义不变）；非 C 类形态（单 lane 批次）不触发
export function collectRoleCompletenessWarnings(tasks, waves) {
  if (!isCClassBatch(tasks, waves)) return [];
  const warnings = [];
  const planLanes = tasks.filter((t) => t.layer === 'plan');
  if (planLanes.length > 0 && !planLanes.some((t) => PLAN_LEAD_ROLES.has(effectiveRole(t)))) {
    warnings.push({
      code: 'GATE_ROLE_MISSING',
      layer: 'plan',
      missing: 'designer|coordinator|manager',
      message: 'C-class batch requires at least one plan lane with role designer, coordinator or manager (effective: ' + planLanes.map((t) => effectiveRole(t) ?? t.role ?? '(default)').join('/') + ')',
    });
  }
  const auditLanes = tasks.filter((t) => t.layer === 'audit');
  if (auditLanes.length > 0 && !auditLanes.some((t) => AUDIT_LEAD_ROLES.has(effectiveRole(t)))) {
    warnings.push({
      code: 'GATE_ROLE_MISSING',
      layer: 'audit',
      missing: 'supervisor|doc-manager',
      message: 'C-class batch requires at least one audit lane with role supervisor or doc-manager (effective: ' + auditLanes.map((t) => effectiveRole(t) ?? t.role ?? '(default)').join('/') + ')',
    });
  }
  return warnings;
}

export function topoWaves(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('tasks must be a non-empty array');
  }
  const ids = new Set();
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !t.id) throw new Error('task id required');
    if (ids.has(t.id)) throw new Error('duplicate task id: ' + t.id);
    ids.add(t.id);
  }
  const deps = new Map();
  for (const t of tasks) {
    const d = Array.isArray(t.deps) ? t.deps : [];
    for (const dep of d) {
      if (!ids.has(dep)) throw new Error('task ' + t.id + ' depends on unknown id: ' + dep);
    }
    deps.set(t.id, new Set(d));
  }
  const indegree = new Map();
  for (const id of ids) indegree.set(id, deps.get(id).size);
  const waves = [];
  let remaining = new Set(ids);
  const order = [];
  let guard = ids.size * ids.size + 1;
  while (remaining.size > 0) {
    if (--guard < 0) throw new Error('cycle detected in task deps');
    const ready = [...remaining].filter((id) => {
      for (const dep of deps.get(id)) if (remaining.has(dep)) return false;
      return true;
    });
    if (ready.length === 0) throw new Error('cycle detected in task deps');
    waves.push(ready);
    order.push(...ready);
    for (const id of ready) remaining.delete(id);
  }
  return { waves, order };
}

function isAbsPath(p) {
  return /^[A-Za-z]:[\\/]|^\\|^\//.test(p);
}

// condition 规范化（建批静态声明，两种等价形态 → 统一对象数组）：
//   condition: [{ path, exists: true }]（推荐主形态）/ condition: ['plan/spec.md']（字符串简写 = 存在即满足）
// 非法（非数组 / 元素非法 / path 非空字符串 / exists 非 true）→ throw（fail-closed 拒建批）
// 谓词唯一：exists（MVP 只做存在性判定）；exists: false 反向断言超出 MVP，拒建批。
export function normalizeCondition(cond) {
  if (cond == null) return null;
  if (!Array.isArray(cond)) throw new Error('condition must be an array (of {path, exists} objects or path strings)');
  const out = [];
  for (const c of cond) {
    if (typeof c === 'string') {
      if (!c.trim()) throw new Error('condition path must be a non-empty string');
      out.push({ path: c, exists: true });
    } else if (c && typeof c === 'object' && !Array.isArray(c)) {
      if (typeof c.path !== 'string' || !c.path.trim()) throw new Error('condition path must be a non-empty string');
      if (c.exists !== true) throw new Error('condition exists must be true (MVP supports existence predicate only)');
      out.push({ path: c.path, exists: true });
    } else {
      throw new Error('condition entries must be {path, exists} objects or path strings');
    }
  }
  return out.length ? out : null; // 空数组 = 无条件（恒满足）
}

// condition 路径契约（与 consume 同源）：相对路径必须在本批次产物根内（plan/|exec/|audit/ 前缀）；artifacts/ 跨批次先禁；绝对路径放行
// 对所有声明 condition 的任务生效（含 generic 批次），建批入口统一校验（fail-closed 拒建批）
function checkConditionPaths(t, cond) {
  for (const c of cond ?? []) {
    const p = c.path;
    if (isAbsPath(p)) continue;
    if (p.startsWith('artifacts/')) throw new Error('task ' + t.id + ' condition cross-batch reference is disabled in MVP (N6): ' + p);
    if (!/^(plan|exec|audit)\//.test(p)) throw new Error('task ' + t.id + ' condition must be under plan/|exec/|audit/ or absolute: ' + p);
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

// targets/targetsMarker 契约规范化（O2 targets 声明契约，与 condition/resume 同模式）：
//   targets: string[]——批次产物根外目标文件（exec worker 承诺「修改/生成」的既有文件）的绝对路径数组；
//             相对路径建批拒绝（fail-closed，防把产物相对路径误当 targets）；
//   targetsMarker: string|null——可选内容声明标记（缺省 null = 纯 mtime 校验；非空时目标文件含独立行
//             `targets-claimed: true` 即视为已变更，见 gates.js checkTargetsGate marker 逃生路径）。
// 非法（targets 非 string 数组 / 空 / 含非绝对路径 / targetsMarker 非 string|null）→ throw（fail-closed 拒建批）。
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
  return { targets, targetsMarker };
}

// 任务包 resume 契约固定条款：resume: true 时注入 worker 派发提示词——
//   新 worker 先查 checkpoint 历史（lane_checkpoint_status），从最后已 checkpoint 步骤之后继续，禁止重做；
//   每完成一个子步骤立即 lane_checkpoint（携带 progress），禁止攒批。
export const RESUME_CLAUSE =
  '若本 lane 存在 checkpoint（lane_checkpoint_status 可查），须先查询 checkpoint 历史，从最后已 checkpoint 的步骤之后继续，禁止重做已完成步骤；每完成一个子步骤立即 lane_checkpoint（携带 progress），禁止攒批。';

// 任务包 resume 条款注入：task.resume === true → 返回固定条款文本（注入派发提示词）；否则 null（不注入，现状）
export function resumeClauseFor(task) {
  return task?.resume === true ? RESUME_CLAUSE : null;
}

// 三层契约静态校验（仅当任一 lane 声明 layer 时启用；generic 批次跳过）
function validateLayerContract(tasks) {
  const plan = tasks.filter((t) => t.layer === 'plan');
  const exec = tasks.filter((t) => t.layer === 'exec');
  const audit = tasks.filter((t) => t.layer === 'audit');
  const used = tasks.some((t) => LAYERS.includes(t.layer));
  if (!used) return;
  if (exec.length === 0 && audit.length === 0 && plan.length === 0) {
    throw new Error('three-tier: layer must be one of plan/exec/audit');
  }
  // 有 exec 必有 audit（设计 §3.3/§5.2）
  if (exec.length > 0 && audit.length === 0) {
    throw new Error('three-tier: exec layers require at least one audit lane');
  }
  // 路径契约一致性（N6/§15.3）：相对路径必须在本批次产物根内（plan/exec/audit 前缀）；跨批次 artifacts/ 先禁；绝对路径放行（N2 自由开放，由运行时 gate 校验存在性）
  const checkPaths = (t, field) => {
    for (const p of t[field] ?? []) {
      if (typeof p !== 'string' || !p.trim()) throw new Error('task ' + t.id + ' ' + field + ' must be non-empty strings');
      if (isAbsPath(p)) continue;
      if (p.startsWith('artifacts/')) throw new Error('task ' + t.id + ' ' + field + ' cross-batch reference is disabled in MVP (N6): ' + p);
      if (!/^(plan|exec|audit)\//.test(p)) throw new Error('task ' + t.id + ' ' + field + ' must be under plan/|exec/|audit/ or absolute: ' + p);
    }
  };
  for (const t of tasks) {
    if (LAYERS.includes(t.layer)) {
      checkPaths(t, 'consume');
      checkPaths(t, 'produce');
      checkPaths(t, 'outputs');
      // condition 结构/路径校验在建批入口对所有任务统一做（见 buildWavePlan），此处不重复
    }
  }
  // 跨层引用：exec.consume 的相对 plan/ 路径必须由 plan 层 produce 提供（设计 §3.3 建批静态校验）
  const planProduces = new Set(plan.flatMap((t) => t.produce ?? []));
  for (const t of exec) {
    for (const p of t.consume ?? []) {
      if (p.startsWith('plan/') && !planProduces.has(p)) {
        throw new Error('task ' + t.id + ' consumes "' + p + '" which is not produced by any plan lane');
      }
    }
  }
  // skill 声明校验（N4/§15.3）：非空字符串；真实存在性由装配/技能库在注册侧保证
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
}

// 引擎注入 cmd 前缀：按 role 契约 + 装配的 skill 能力（设计 §12.1/§14.2），Leader 只写任务内容
export function assembleCmd(role, skills, cmd) {
  const parts = [];
  if (role) parts.push('[role=' + role + ']');
  if (Array.isArray(skills) && skills.length) parts.push('[skills=' + skills.join(',') + ']');
  return parts.length ? parts.join(' ') + ' ' + (cmd ?? '') : (cmd ?? '');
}

export function buildWavePlan({ batchId, tasks, concurrency = 5, team = 'generic', assembly }) {
  if (!batchId || typeof batchId !== 'string') throw new Error('batchId required');
  const { waves } = topoWaves(tasks);
  validateLayerContract(tasks);
  // role 集合校验（GATE_ROLE_INVALID，warning 语义：事件留痕、不阻断建批、保持兼容）——
  // 仅「显式声明且非空、但不在合法集合」的 role 触发告警；未声明（走默认值）与归一化后合法的角色不告警
  const warnings = [];
  for (const t of tasks) {
    if (typeof t.role === 'string' && t.role.trim() && normalizeRole(t.role) === null) {
      warnings.push({
        code: 'GATE_ROLE_INVALID',
        task: t.id,
        role: t.role,
        message: 'task ' + t.id + ' role "' + t.role + '" is not a valid role (' + [...VALID_ROLES, ...ROLE_EXTENSIONS].join('/') + '); kept as-is for compatibility, layer default applies only when role is omitted',
      });
    }
  }
  // C 类批次角色齐备门禁（GATE_ROLE_MISSING，warning 语义）——并入同一收集循环/同一返回结构；
  // 仅 C 类形态（多 wave/多 lane/跨层依赖）且对应层存在时检查；单 lane 批次不触发
  warnings.push(...collectRoleCompletenessWarnings(tasks, waves));
  const wavePlan = waves.map((ids, idx) => ({
    wave: idx + 1,
    tasks: ids.map((id) => {
      const t = tasks.find((x) => x.id === id);
      const layer = t.layer ?? undefined;
      // 默认值修正：task 未显式声明 role → 按 layer 取缺省（plan→designer / audit→supervisor / exec→coder；generic 无 layer → null 现状）
      const rawRole = t.role ?? defaultRoleForLayer(layer);
      // 大小写归一化：合法角色（Designer→designer）存小写规范名；非法角色保留原值（兼容，GATE_ROLE_INVALID 告警暴露）
      const role = normalizeRole(rawRole) ?? rawRole;
      let skills = t.skills;
      // 装配补全（可插拔）：未显式声明 skills 时，按 team 装配表的 role → skills 补全（assembly 可选）
      if (assembly && role && skills === undefined) {
        const entry = assembly?.layers?.[layer]?.skills?.[role];
        if (entry) skills = entry;
      }
      // condition 结构 + 路径校验（对所有任务，含 generic），fail-closed 拒建批
      const condition = normalizeCondition(t.condition);
      checkConditionPaths(t, condition);
      // resume 契约字段校验 + 透传（checkpoint{steps}/resume 布尔；默认关场景仅存元数据，消费方按开关生效）
      const resumeContract = normalizeResumeContract(t);
      // targets/targetsMarker 契约校验 + 透传（O2：绝对路径 fail-closed 拒建批；未声明 = null = 零感知，
      // 仿 condition 可选字段模式，不升 batch schema 版本）
      const targetsContract = normalizeTargetsContract(t);
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
        produce: Array.isArray(t.produce) ? [...t.produce] : null,
        outputs: Array.isArray(t.outputs) ? [...t.outputs] : null,
        condition, // lane 条件（统一对象数组形态；缺省 null = 恒满足）
        checkpoint: resumeContract.checkpoint, // { steps } | null（总步数声明，供 progress 校验与任务包注入）
        resume: resumeContract.resume, // boolean（缺省 false = 现状，行为不变）
        targets: targetsContract.targets, // string[] | null（绝对路径目标文件声明；未声明 null = 零感知）
        targetsMarker: targetsContract.targetsMarker, // string | null（内容声明标记；缺省 null = 纯 mtime 校验）
      };
    }),
  }));
  const concurrencyN = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 5;
  return {
    schema: SCHEMA_VERSION,
    batchId,
    team: team || 'generic',
    wavePlan,
    concurrency: concurrencyN,
    warnings, // role 校验告警（GATE_ROLE_INVALID，warning 语义：不阻断建批；事件留痕由调用方落批次）
  };
}

export function validateWavePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('wavePlan must be an object');
  if (plan.schema !== SCHEMA_VERSION) throw new Error('unsupported wavePlan schema: ' + String(plan.schema));
  if (!plan.batchId || typeof plan.batchId !== 'string') throw new Error('wavePlan.batchId required');
  if (!Array.isArray(plan.wavePlan) || plan.wavePlan.length === 0) throw new Error('wavePlan.wavePlan required');
  const seen = new Set();
  for (const w of plan.wavePlan) {
    if (!Number.isInteger(w.wave) || w.wave < 1) throw new Error('wave number invalid');
    if (!Array.isArray(w.tasks)) throw new Error('wave tasks must be an array');
    for (const t of w.tasks) {
      if (!t || typeof t.id !== 'string' || seen.has(t.id)) throw new Error('task id invalid/duplicate');
      seen.add(t.id);
      if (t.model !== null && typeof t.model !== 'string') throw new Error('task model must be string or null');
      if (t.cmd !== undefined && typeof t.cmd !== 'string') throw new Error('task cmd must be string');
      if (t.tools !== undefined && t.tools !== null && (!Array.isArray(t.tools) || t.tools.some((x) => typeof x !== 'string'))) throw new Error('task tools must be string array or null');
      if (t.layer != null && !LAYERS.includes(t.layer)) throw new Error('task layer invalid: ' + t.layer);
      for (const f of ['consume', 'produce', 'outputs', 'skills']) {
        if (t[f] != null && (!Array.isArray(t[f]) || t[f].some((x) => typeof x !== 'string'))) throw new Error('task ' + f + ' must be string array');
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
      // targets/targetsMarker 形态校验（O2，与建批规范化同语义，防伪造/篡改）：
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
  validateLayerContract(flat);
  return true;
}
