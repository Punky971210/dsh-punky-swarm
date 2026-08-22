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

const SCHEMA_VERSION = 1;

export const LAYERS = ['plan', 'exec', 'audit'];

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

// P1-4 condition 规范化（建批静态声明，两种等价形态 → 统一对象数组）：
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
  const wavePlan = waves.map((ids, idx) => ({
    wave: idx + 1,
    tasks: ids.map((id) => {
      const t = tasks.find((x) => x.id === id);
      const layer = t.layer ?? undefined;
      const role = t.role ?? undefined;
      let skills = t.skills;
      // 装配补全（可插拔）：未显式声明 skills 时，按 team 装配表的 role → skills 补全（assembly 可选）
      if (assembly && role && skills === undefined) {
        const entry = assembly?.layers?.[layer]?.skills?.[role];
        if (entry) skills = entry;
      }
      // P1-4：condition 结构 + 路径校验（对所有任务，含 generic），fail-closed 拒建批
      const condition = normalizeCondition(t.condition);
      checkConditionPaths(t, condition);
      // B2：resume 契约字段校验 + 透传（checkpoint{steps}/resume 布尔；默认关场景仅存元数据，消费方按开关生效）
      const resumeContract = normalizeResumeContract(t);
      return {
        id: t.id,
        cmd: assembleCmd(role, skills, t.cmd ?? ''),
        deps: Array.isArray(t.deps) ? [...t.deps] : [],
        model: t.model ?? null,
        tools: Array.isArray(t.tools) ? [...t.tools] : null,
        layer: t.layer ?? null,
        role: t.role ?? null,
        skills: skills ? [...skills] : null,
        consume: Array.isArray(t.consume) ? [...t.consume] : null,
        produce: Array.isArray(t.produce) ? [...t.produce] : null,
        outputs: Array.isArray(t.outputs) ? [...t.outputs] : null,
        condition, // P1-4：lane 条件（统一对象数组形态；缺省 null = 恒满足）
        checkpoint: resumeContract.checkpoint, // B2：{ steps } | null（总步数声明，供 progress 校验与任务包注入）
        resume: resumeContract.resume, // B2：boolean（缺省 false = 现状，行为不变）
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
      // P1-4：condition 规范化形态校验（建批后 wavePlan JSON 应为对象数组或 null）
      if (t.condition != null) {
        if (!Array.isArray(t.condition) || t.condition.some((c) => !c || typeof c !== 'object' || Array.isArray(c) || typeof c.path !== 'string' || c.exists !== true)) {
          throw new Error('task condition must be [{path, exists: true}, ...] array or null');
        }
        checkConditionPaths(t, t.condition);
      }
      // B2：checkpoint/resume 形态校验（建批后 wavePlan JSON 应为 {steps} | null / boolean）
      if (t.checkpoint != null && (typeof t.checkpoint !== 'object' || Array.isArray(t.checkpoint) || !Number.isInteger(t.checkpoint.steps) || t.checkpoint.steps < 1)) {
        throw new Error('task checkpoint must be { steps: positive int } or null');
      }
      if (t.resume != null && typeof t.resume !== 'boolean') {
        throw new Error('task resume must be boolean');
      }
    }
  }
  const flat = plan.wavePlan.flatMap((w) => w.tasks);
  topoWaves(flat);
  validateLayerContract(flat);
  return true;
}
