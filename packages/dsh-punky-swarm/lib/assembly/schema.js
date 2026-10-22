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
import { AUDITLOG_DEFAULTS } from '../auditlog/config.js';

// ── 能力注册表（13 键：aip/identity/discovery/verify/watch/worktree/budget/injectBudget/trajectory/acps/auditlog/logs/topic）──
// path = config 取值路径；default = 缺省值（9 键默认开——aip/discovery/verify/watch/worktree/budget/injectBudget/trajectory/auditlog；
//   显式 enabled:false 可逐键关闭；4 键默认关——identity/acps/logs/topic，需显式开启）；
// consumers = 既有消费点（键路径一致性依据）
// identity 键：身份体系默认关——config.aip.identity.enabled === true 时
//   调用方才激活 lib/aip/identity.js 模块 API（AIC 身份码注册 + CAI 证书发行 + 签名 + 信任链验证）；
//   默认关 → 零开销零破坏；不注册新治理工具（**21 工具契约**：2026-09-15 增 `lane_dispatch`），身份能力经模块 API 暴露。
export const CAPABILITY_REGISTRY = [
  { key: 'aip', path: ['aip'], default: { enabled: true }, consumers: ['tools/register.js catalog + api.js /tools 端点'] },
  // acps 键：ACPs 通讯能力——对外 mTLS 服务端点 + 内部桥。
  // 默认关：acps.enabled 与 acps.endpoint.enabled 均 false 时零加载零监听（config 短路）；显式开启才
  //   index.js 实例化 createAcpsServer（lib/acps/server.js + certs.js，node:https/tls/crypto 原生，零新依赖）。
  { key: 'acps', path: ['acps'], default: ACPS_DEFAULTS, consumers: ['index.js acps endpoint 装配 + lib/acps/server.js'] },
  { key: 'identity', path: ['aip', 'identity'], default: { enabled: false }, consumers: ['lib/aip/identity.js 模块 API（AIC/CAI/sign/verifyTrustChain）'] },
  { key: 'discovery', path: ['capabilities', 'discovery'], default: DISCOVERY_DEFAULTS, consumers: ['index.js discovery 服务装配 + api.js /discover + /.well-known/aip 端点'] },
  { key: 'verify', path: ['capabilities', 'verify'], default: VERIFY_DEFAULTS, consumers: ['index.js mountVerify 捕获 hook（只做证据捕获）', 'verify/gate.js createCompletionGate（仅测试 DI；生产未接线 ⇒ mode=enforce 不拦截）'] },
  { key: 'watch', path: ['capabilities', 'watch'], default: WATCH_DEFAULTS, consumers: ['index.js watchdog + watch/lane-heartbeat.js'] },
  { key: 'worktree', path: ['capabilities', 'worktree'], default: { enabled: true, mergeAgent: { enabled: false, model: null, timeoutMs: 600000 } }, consumers: ['tools/lane-tools.js 三工具注册'] },
  { key: 'budget', path: ['capabilities', 'budget'], default: { enabled: true, maxChainHops: 4, maxChainRoundTrips: 2 }, consumers: ['comms/budget.js + mailbox-tools.js 发送检查'] },
  // injectBudget 键：注入面字节预算（四层：每源软上限 / 总量硬上限 / head-tail 截断 / 显式省略标记）。
  //   与上一行 budget 键**语义正交、互不复用**：budget = mailbox 链环防护（hop/round-trip），本键 = 注入文本字节上限。
  //   默认开 ⇒ 与「零回归靠未超限不动作、不靠默认关」的取值口径一致（无需进测试 OFF_KEYS）。
  //   阈值取值唯一源 = 本条目；实现侧禁止散落字面量。位宽对齐宿主日志行物理上限（auditlog 的 MAX_LINE_BYTES）。
  //   消费点：engine/dispatch.js 任务包、tools/handoff-tools.js 交接注入、tools/swarm-comms.js lane 回报。
  { key: 'injectBudget', path: ['capabilities', 'injectBudget'], default: { enabled: true, perItemBytes: 3072, perBlockBytes: 12288, totalBytes: 32768, headBytes: 2048, tailBytes: 1024 }, consumers: ['comms/inject-budget.js + engine/dispatch.js + tools/handoff-tools.js + tools/swarm-comms.js'] },
  { key: 'trajectory', path: ['capabilities', 'trajectory'], default: TRAJECTORY_DEFAULTS, consumers: ['index.js 桥接订阅'] },
  // logs 键：日志导出工具注册开关——默认关（与 cordis.patch.yml 显式 logs.enabled:true 相合）；
  //   消费点经 readCapability(config,'logs') 缺省读取，显式 enabled:false 可关。
  { key: 'logs', path: ['capabilities', 'logs'], default: { enabled: false }, consumers: ['tools/log-tools.js log_export 注册'] },
  // topic 键：comms/topic.js 预留模块开关——默认关；接线（trajectory 桥广播改经本模块等）预留。
  { key: 'topic', path: ['capabilities', 'topic'], default: { enabled: false }, consumers: ['comms/topic.js（预留）'] },
  // auditlog 键：审计日志 sink（默认开）；env PUNKY_AUDITLOG 逐键覆盖；消费 lib/index.js mountAuditLog + lib/auditlog/**
  { key: 'auditlog', path: ['capabilities', 'auditlog'], default: AUDITLOG_DEFAULTS, consumers: ['lib/index.js apply() mountAuditLog', 'lib/auditlog/sink.js', 'docs 根 README（落点/开关）'] },
];

// ── 互斥表（预留空表：当前能力两两可叠加；未来互斥能力登记于此）──
// 项形如 { keys: ['x', 'y'], message: '...' }：两键同时 enabled=true → validateCapabilities 报 MUTEX error
export const EXCLUSIONS = [];

// ── 反向断言权威表（对齐 software-team skill 装配表 8 角色）──
// manager 显式豁免：Leader 直系拉起、不经 wavePlan lane 角色池，不登记于装配表 roles
export const REQUIRED_ROLES = ['coordinator', 'designer', 'coder', 'tester', 'reviewer', 'supervisor', 'doc-manager'];

// ── 盲审扩展 ──
// 三角色 + 六模板键名清单；模板内容由 lib/assembly/audit-blind-review.js 提供
export const BLIND_REVIEW_ROLES = ['audit-panelist', 'audit-aggregate', 'audit-critic'];
export const BLIND_REVIEW_TEMPLATE_KEYS = ['bundle', 'panelist', 'aggregate', 'critic', 'checklist', 'config'];

// ── 内部工具 ──
// 热更新（lib/hot/config-watch.js）导出复用本函数做 runtime 覆盖层 deepMerge——
// 禁止复制散落实现（复制即漂移源）；readCapability 缺省合并与本函数同源。
export function deepMerge(base, override) {
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

// ── C-5 · 坏配置加载期 fail-closed（消除静默降级）────────────────────────────
// 存在理由：`capabilities.injectBudget` 的五个阈值此前**无任何校验** ⇒ `runtime.json` 写
//   `{enabled:true,totalBytes:-1}` 会**通过白名单后静默降级**（`inject-budget.js` 的「无可用阈值 ⇒ 零动作」
//   是**契约**，故不会报错，只会静默地把整条预算关掉）⇒ 本组校验把该形态改为**可见的拒绝**。
// 语义边界（**不得混淆**）：本组只管「**坏配置**」；`inject-budget.js` 中「未超限 / 开关关 / 无可用阈值 ⇒
//   返回入参原值本身、零省略」是**文档化契约**（`:165` 逐字），**不是**本组要消除的对象 —— 该件一字不动。
//
// 五个阈值字段（**唯一字段清单**；禁第二套字面量表）。
export const INJECT_BUDGET_LIMIT_FIELDS = Object.freeze([
  'perItemBytes',
  'perBlockBytes',
  'totalBytes',
  'headBytes',
  'tailBytes',
]);

/**
 * **单一判定点**（`DEP-N` 值校验）：`injectBudget` 是否为**可用的有限正数阈值**。
 * 两个调用方共用本函数 ⇒ 启动期与热更通道**同判、文案同源、零漂移**：
 *   · `validateCapabilities`（本文件；经 `lib/index.js` 装配期 warn）
 *   · `validateOverlay`（`lib/hot/config-watch.js`；**热更通道**，拒则整份 overlay 不采用）
 *
 * 判定口径：
 *   · `enabled !== true` ⇒ **零校验**（与 DEP-1..DEP-5 同形：禁用能力零校验零开销）；
 *   · 五字段**逐个**：`!== undefined` 才查（缺省不误伤），须为**有限正数**
 *     （`0` / 负 / `NaN` / `Infinity` / 字符串 全拒）；文案含**字段名**与**实得值**。
 * @param {unknown} block `capabilities.injectBudget` 显式声明的值
 * @returns {string[]} 错误文案（空数组 = 合法）
 */
export function injectBudgetValueErrors(block) {
  const errors = [];
  if (block === undefined || block === null) return errors;
  if (typeof block !== 'object' || Array.isArray(block)) {
    // 非对象（`5` / `"on"` / `true`）：`?.enabled` 取不到 ⇒ 预算会被**静默禁用且无痕**（同族静默面）。
    errors.push('DEP-6: capabilities.injectBudget must be an object (got ' + JSON.stringify(block) + ')');
    return errors;
  }
  if (block.enabled !== true) return errors;
  for (const field of INJECT_BUDGET_LIMIT_FIELDS) {
    const v = block[field];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      errors.push('DEP-6: capabilities.injectBudget.' + field
        + ' must be a finite positive number (got ' + JSON.stringify(v) + ')');
    }
  }
  return errors;
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

  // DEP-6（包内写作 `DEP-N`）：injectBudget 五阈值在 `enabled === true` 时须为**有限正数**。
  //   落点理由：该键此前**零校验** ⇒ `totalBytes:-1` 一类坏值通过白名单后被**静默降级**（无任何报错）。
  //   与 DEP-1..DEP-5 **同形**：仅显式 `enabled === true` 时校验值、字段缺省不误伤、文案 `DEP-6: …(got …)`。
  //
  // ⚠ **调用门不得写成 `c.injectBudget?.enabled === true`**（本 lane 自测抓出的真实缺陷，见 progress 03）：
  //   非对象形态（`injectBudget: 5`）取 `?.enabled` 得 `undefined` ⇒ 门为假 ⇒ **判定点根本看不到它**
  //   ⇒ 「坏配置被静默吞掉」的原病照旧（`5` 经 `deepMerge` 后同样让预算静默失效）。
  //   ⇒ 门只按「**是否显式声明**」开：`!== undefined` 即交判定点；`enabled !== true` 的**零校验**语义
  //     由判定点自己实现（`injectBudgetValueErrors`），**既不误伤禁用态、也不漏放非对象**。
  //   `null` 不入判定点：`deepMerge(default, null)` 回落到注册表默认（预算照常生效）⇒ 无静默危害，不拒。
  if (c.injectBudget !== undefined) {
    errors.push(...injectBudgetValueErrors(c.injectBudget));
  }

  // MUTEX：互斥表（当前空表，无天然互斥；心跳/预算/worktree/verify/trajectory/aip 两两可叠加）
  for (const ex of EXCLUSIONS) {
    const on = ex.keys.filter((k) => readCapability(config, k)?.enabled === true);
    if (on.length === ex.keys.length) errors.push('MUTEX: ' + ex.message);
  }

  return { errors };
}

// ── 完整性断言（三视图，入测试门禁）──
// 【C1 判读（N2 第二批，docs/c1-wiring-audit-2026-09-22.md）】原 `validateAssembly`（纯形状校验）已删：
//   生产零调用 + 测试自产自销；形状判定真源 = 本函数视图 1（严格覆盖且更强：+技能可解析性 +REQUIRED_ROLES
//   反向对齐）。**校验器：当前唯一消费者 = `test/assembly-schema.test.js`（14 调用点）**；lib 生产路径零调用，`audit-blind-review.js:37` 仅注释提及）
// 视图 1 正向：装配表自洽（∀ (layer, role)：skills[role] 非空字符串数组且每个 skill 可解析）
// 视图 2 反向：software-team 装配表 7 角色（manager 显式豁免）全部出现且映射非空
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

  // 视图 2：反向对齐 software-team 手册表（manager 豁免）
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
