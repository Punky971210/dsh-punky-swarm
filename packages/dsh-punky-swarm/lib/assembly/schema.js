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

// 装配配置注册表统一
// 纯函数 + 数据，零运行时依赖（仅 import 本包 lib/schema.js 默认常量）。
// 能力键路径保持既有现状（aip.* / capabilities.* 两套不变）= 消费点零改动 = 向后兼容。
// 校验语义：validateCapabilities 仅对显式 enabled 的非法组合报错（fail-closed 在测试/装配验收层）；
//   引擎启动侧只 warn 不炸宿主（配置错误不破坏可用性，与「默认关零破坏」一致）。

import { WATCH_DEFAULTS, TRAJECTORY_DEFAULTS, VERIFY_DEFAULTS, DISCOVERY_DEFAULTS, ACPS_DEFAULTS } from '../schema.js';

// ── 能力注册表（9 键：aip/identity/discovery/verify/watch/worktree/budget/trajectory/acps）──
// path = config 取值路径；default = 缺省值（全能力默认开——AIP 为主线 + 治理能力全开，
//   显式 enabled:false 可逐键关闭）；consumers = 既有消费点（键路径一致性依据）
// identity 键：身份体系默认关——config.aip.identity.enabled === true 时
//   调用方才激活 lib/aip/identity.js 模块 API（AIC 身份码注册 + CAI 证书发行 + 签名 + 信任链验证）；
//   默认关 → 零开销零破坏；不注册新治理工具（20 工具契约不变），身份能力经模块 API 暴露。
export const CAPABILITY_REGISTRY = [
  { key: 'aip', path: ['aip'], default: { enabled: true }, consumers: ['tools/register.js catalog + api.js /tools 端点'] },
  // acps 键：ACPs 通讯能力——对外 mTLS 服务端点 + 内部桥。
  // 默认关：acps.enabled 与 acps.endpoint.enabled 均 false 时零加载零监听（config 短路）；显式开启才
  //   index.js 实例化 createAcpsServer（lib/acps/server.js + certs.js，node:https/tls/crypto 原生，零新依赖）。
  { key: 'acps', path: ['acps'], default: ACPS_DEFAULTS, consumers: ['index.js acps endpoint 装配 + lib/acps/server.js'] },
  { key: 'identity', path: ['aip', 'identity'], default: { enabled: false }, consumers: ['lib/aip/identity.js 模块 API（AIC/CAI/sign/verifyTrustChain）'] },
  { key: 'discovery', path: ['capabilities', 'discovery'], default: DISCOVERY_DEFAULTS, consumers: ['index.js discovery 服务装配 + api.js /discover + /.well-known/aip 端点'] },
  { key: 'verify', path: ['capabilities', 'verify'], default: VERIFY_DEFAULTS, consumers: ['index.js mountVerify 捕获 hook', 'verify/gate.js createCompletionGate(DI)'] },
  { key: 'watch', path: ['capabilities', 'watch'], default: WATCH_DEFAULTS, consumers: ['index.js watchdog + watch/lane-heartbeat.js'] },
  { key: 'worktree', path: ['capabilities', 'worktree'], default: { enabled: true, mergeAgent: { enabled: false, model: null, timeoutMs: 600000 } }, consumers: ['tools/lane-tools.js 三工具注册'] },
  { key: 'budget', path: ['capabilities', 'budget'], default: { enabled: true, maxChainHops: 4, maxChainRoundTrips: 2 }, consumers: ['comms/budget.js + mailbox-tools.js 发送检查'] },
  { key: 'trajectory', path: ['capabilities', 'trajectory'], default: TRAJECTORY_DEFAULTS, consumers: ['index.js 桥接订阅'] },
];

// ── 互斥表（预留空表：当前 7 能力两两可叠加；未来互斥能力登记于此）──
// 项形如 { keys: ['x', 'y'], message: '...' }：两键同时 enabled=true → validateCapabilities 报 MUTEX error
export const EXCLUSIONS = [];

// ── 反向断言权威表（对齐 jiufeng-team skill 装配表 8 角色）──
// manager 显式豁免：Leader 直系拉起、不经 wavePlan lane 角色池，不登记于装配表 roles
export const REQUIRED_ROLES = ['coordinator', 'designer', 'coder', 'tester', 'reviewer', 'supervisor', 'doc-manager'];

// ── 盲审扩展 ──
// 三角色 + 六模板键名清单；模板内容由 lib/assembly/audit-blind-review.js 提供
export const BLIND_REVIEW_ROLES = ['audit-panelist', 'audit-aggregate', 'audit-critic'];
export const BLIND_REVIEW_TEMPLATE_KEYS = ['bundle', 'panelist', 'aggregate', 'critic', 'checklist', 'config'];

// ── 内部工具 ──

function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (typeof base !== 'object' || base === null || typeof override !== 'object' || override === null) return override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    const b = out[k];
    const o = override[k];
    out[k] = (b !== null && typeof b === 'object' && !Array.isArray(b)
      && o !== null && typeof o === 'object' && !Array.isArray(o))
      ? deepMerge(b, o)
      : o;
  }
  return out;
}

// ── 统一读取：按注册表 path 取值 + 默认合并（消费点语义等价，供测试与工具面统一读取）──
export function readCapability(config, key) {
  const entry = CAPABILITY_REGISTRY.find((e) => e.key === key);
  if (!entry) return undefined;
  let val = config;
  for (const seg of entry.path) val = val?.[seg];
  return deepMerge(entry.default, val);
}

// ── 校验：仅对显式 enabled 的非法组合报错；禁用能力零校验零开销 ──
export function validateCapabilities(config = {}) {
  const errors = [];
  const c = config.capabilities ?? {};

  // DEP-1 verify：mode ∈ {advisory, enforce}（createCompletionGate 静默回退，统一校验兜底）
  if (c.verify?.enabled === true && c.verify.mode !== undefined && !['advisory', 'enforce'].includes(c.verify.mode)) {
    errors.push('DEP-1: capabilities.verify.mode must be advisory or enforce (got ' + JSON.stringify(c.verify.mode) + ')');
  }

  // DEP-2 trajectory：autoFail === true ⇒ enabled === true（autoFail 无 enabled 无意义）
  if (c.trajectory?.autoFail === true && c.trajectory.enabled !== true) {
    errors.push('DEP-2: capabilities.trajectory.autoFail=true requires enabled=true');
  }

  // DEP-3 trajectory：poll.enabled === true ⇒ poll.baseUrl 非空字符串（HTTP 轮询需目标地址）
  if (c.trajectory?.poll?.enabled === true) {
    const baseUrl = c.trajectory.poll.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      errors.push('DEP-3: capabilities.trajectory.poll.enabled=true requires non-empty poll.baseUrl');
    }
  }

  // DEP-4 budget：maxChainHops / maxChainRoundTrips 为正整数（显式声明时；环防护参数合法性）
  if (c.budget?.enabled === true) {
    for (const field of ['maxChainHops', 'maxChainRoundTrips']) {
      if (c.budget[field] !== undefined && (!Number.isInteger(c.budget[field]) || c.budget[field] < 1)) {
        errors.push('DEP-4: capabilities.budget.' + field + ' must be a positive integer (got ' + JSON.stringify(c.budget[field]) + ')');
      }
    }
  }

  // DEP-5 watch：maxMissed ≥ 1、scanIntervalMinutes ≥ 0.1（显式声明时；resolveWatchConfig 已钳制，校验兜底）
  if (c.watch?.enabled === true) {
    if (c.watch.maxMissed !== undefined && (!Number.isFinite(c.watch.maxMissed) || c.watch.maxMissed < 1)) {
      errors.push('DEP-5: capabilities.watch.maxMissed must be >= 1 (got ' + JSON.stringify(c.watch.maxMissed) + ')');
    }
    if (c.watch.scanIntervalMinutes !== undefined && (!Number.isFinite(c.watch.scanIntervalMinutes) || c.watch.scanIntervalMinutes < 0.1)) {
      errors.push('DEP-5: capabilities.watch.scanIntervalMinutes must be >= 0.1 (got ' + JSON.stringify(c.watch.scanIntervalMinutes) + ')');
    }
  }

  // MUTEX：互斥表（当前空表，无天然互斥；心跳/预算/worktree/verify/trajectory/aip 两两可叠加）
  for (const ex of EXCLUSIONS) {
    const on = ex.keys.filter((k) => readCapability(config, k)?.enabled === true);
    if (on.length === ex.keys.length) errors.push('MUTEX: ' + ex.message);
  }

  return { errors };
}

// ── 结构校验：team/layers/roles/skills 形状；role ∈ roles ⇒ skills[role] 非空字符串数组 ──
export function validateAssembly(assembly) {
  const errors = [];
  if (assembly === null || typeof assembly !== 'object') {
    return { errors: ['assembly must be an object'] };
  }
  if (typeof assembly.team !== 'string' || assembly.team.length === 0) {
    errors.push('assembly.team must be a non-empty string');
  }
  const layers = assembly.layers;
  if (layers === null || typeof layers !== 'object' || Array.isArray(layers)) {
    errors.push('assembly.layers must be an object');
    return { errors };
  }
  for (const [layerName, layer] of Object.entries(layers)) {
    if (layer === null || typeof layer !== 'object') {
      errors.push('layers.' + layerName + ' must be an object');
      continue;
    }
    const roles = layer.roles;
    if (!Array.isArray(roles) || roles.length === 0) {
      errors.push('layers.' + layerName + '.roles must be a non-empty array');
      continue;
    }
    const skills = layer.skills;
    if (skills === null || typeof skills !== 'object' || Array.isArray(skills)) {
      errors.push('layers.' + layerName + '.skills must be an object');
      continue;
    }
    for (const role of roles) {
      const list = skills[role];
      if (!Array.isArray(list) || list.length === 0) {
        errors.push('layers.' + layerName + '.skills.' + role + ' missing or empty');
      } else {
        for (const s of list) {
          if (typeof s !== 'string' || s.length === 0) {
            errors.push('layers.' + layerName + '.skills.' + role + ' contains non-string skill');
          }
        }
      }
    }
  }
  return { errors };
}

// ── 完整性断言（三视图，入测试门禁）──
// 视图 1 正向：装配表自洽（∀ (layer, role)：skills[role] 非空字符串数组且每个 skill 可解析）
// 视图 2 反向：jiufeng-team 装配表 7 角色（manager 显式豁免）全部出现且映射非空
// 视图 3 扩展：extensions.blindReview.enabled=true 时三角色映射非空 + 六模板键齐备
// skillCatalog：{ has(name) -> bool }；生产传 ~/.agents/skills/<name>/SKILL.md 存在性解析器，测试传 fixture
export function assertAssemblyCompleteness(assembly, skillCatalog) {
  if (typeof skillCatalog?.has !== 'function') {
    throw new TypeError('assertAssemblyCompleteness requires skillCatalog.has(name) — production: ~/.agents/skills/<name>/SKILL.md resolver; test: fixture');
  }
  const missing = [];
  const layers = assembly?.layers ?? {};

  // 收集全量角色 → skills（供视图 2/3 复用）
  const roleSkills = new Map();
  for (const layer of Object.values(layers)) {
    for (const role of layer?.roles ?? []) {
      roleSkills.set(role, layer?.skills?.[role]);
    }
  }

  // 视图 1：正向自洽
  for (const [layerName, layer] of Object.entries(layers)) {
    for (const role of layer?.roles ?? []) {
      const skills = layer?.skills?.[role];
      if (!Array.isArray(skills) || skills.length === 0) {
        missing.push('layers.' + layerName + '.skills.' + role + ' missing or empty');
        continue;
      }
      for (const s of skills) {
        if (!skillCatalog.has(s)) missing.push('layers.' + layerName + '.skills.' + role + ': skill "' + s + '" not resolvable');
      }
    }
  }

  // 视图 2：反向对齐 jiufeng-team 手册表（manager 豁免）
  for (const role of REQUIRED_ROLES) {
    if (!roleSkills.has(role)) {
      missing.push('required role "' + role + '" not present in assembly roles');
    } else if (!Array.isArray(roleSkills.get(role)) || roleSkills.get(role).length === 0) {
      missing.push('required role "' + role + '" has empty skills');
    }
  }

  // 视图 3：blindReview 扩展（默认不启用 → 零影响）
  const br = assembly?.extensions?.blindReview;
  if (br?.enabled === true) {
    for (const role of BLIND_REVIEW_ROLES) {
      if (!roleSkills.has(role)) {
        missing.push('blindReview: role "' + role + '" not present in assembly roles');
      } else if (!Array.isArray(roleSkills.get(role)) || roleSkills.get(role).length === 0) {
        missing.push('blindReview: role "' + role + '" has empty skills');
      }
    }
    const templates = br.templates;
    if (templates === null || typeof templates !== 'object') {
      missing.push('blindReview: templates object missing');
    } else {
      for (const k of BLIND_REVIEW_TEMPLATE_KEYS) {
        if (!(k in templates)) missing.push('blindReview: template "' + k + '" missing');
      }
    }
  }

  return { ok: missing.length === 0, missing };
}
