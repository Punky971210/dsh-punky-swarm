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
    }
  }
  const flat = plan.wavePlan.flatMap((w) => w.tasks);
  topoWaves(flat);
  validateLayerContract(flat);
  return true;
}
