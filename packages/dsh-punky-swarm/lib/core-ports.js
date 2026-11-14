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

// lib/core-ports.js — core 端口注册表（P0 端口化 X-1 … X-7 的**唯一**登记面）
//
// 为什么存在：七项「单点」若各自发明一套「谁读谁是唯一」的约定，就退化成七套互不相认的口头纪律。
//   本模块把「谁提供能力」变成一次显式登记：**只由 core 装配根写入，其余模块只读**——
//   同一 npm 包 ⇒ 同一模块实例 ⇒ 天然进程内单点（无需宿主服务、无需 inject 面变更）。
//
// 语义（逐条是硬约束，不是建议）：
//   ① **fail-closed**：未登记的键 `corePort(name)` **抛错**（`PORT_NOT_READY`），**禁止**返回
//      `undefined` —— 让调用方静默走空分支正是本批要消灭的缺陷形态（门禁静默 fail-open 的历史坑）。
//   ② **一次性**：同键重复登记抛 `DUPLICATE_CORE_PORT`（防热重载双挂 / 两个建点互相覆盖）。
//      确需换持有者 ⇒ 先 `unregisterCorePort(name)`（幂等）再登记，属**有意接管**，须在调用点写明理由。
//   ③ **原子**：`registerCorePorts(entries)` 任一键冲突 ⇒ 整批不生效（不留半登记态）。
//   ④ **零依赖**：本模块**不得** import 任何东西（含 node 内建）——它是全仓 import 图上的叶子，
//      否则 `hot/config-watch.js` 与 `lib/index.js` 同时 import 它就会引入首求值环（`esm-first-eval` 冻结 SCC = 0）。
//
// 七个键（本批全部登记，逐名冻结）：`config` / `store` / `hooks` / `presets` / `toolFace` / `httpSurface` / `batchFeed`。
//   本文件**不**定义任何端口实现：实现归各装配点（`hot/config-watch.js#start`、`lib/index.js#createEngineStore` …），
//   本模块只管「登记 / 读 / 在场判定 / 摘除」四件事。

/** 登记表：键 → 能力实现对象。进程内唯一（ESM 模块单例）。 */
const REGISTRY = new Map();

function portNameOf(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('core port name must be a non-empty string (got: ' + String(name) + ')');
  }
  return name;
}

function notReadyError(name) {
  const err = new Error(
    'core port not ready: ' + name
    + ' —— 该端口尚未由 core 装配根登记。禁止把未就绪当空实现（返回 undefined 会让调用方'
    + '静默走空分支，正是端口化要消灭的缺陷形态）。'
    + '修复：① 确认对应装配段已执行（config → hot/config-watch.js#start；store → lib/index.js#createEngineStore；'
    + '其余见 lib/core-ports.js 头注释的七个键）；② 若在装配前求值，改用 hasCorePort(name) 判在场；'
    + '③ 单测夹具可显式 registerCorePort(name, 假实现)。',
  );
  err.code = 'PORT_NOT_READY';
  err.port = name;
  err.registered = [...REGISTRY.keys()];
  return err;
}

function duplicateError(name) {
  const err = new Error(
    'duplicate core port: ' + name
    + ' —— 该键已登记（端口一旦登记即代表「唯一持有者」，重复登记意味着两个建点互相覆盖或热重载双挂）。'
    + '修复：确需换持有者时先 unregisterCorePort(' + JSON.stringify(name) + ') 再登记，并在调用点写明接管理由。',
  );
  err.code = 'DUPLICATE_CORE_PORT';
  err.port = name;
  return err;
}

/**
 * 登记单个端口。
 * @param {string} name 端口键（非空字符串）
 * @param {object} impl 能力实现（本模块不检查形状：键的语义由契约冻结，不由运行时猜）
 * @returns {object} 登记进去的同一引用
 */
export function registerCorePort(name, impl) {
  portNameOf(name);
  if (REGISTRY.has(name)) throw duplicateError(name);
  REGISTRY.set(name, impl);
  return impl;
}

/**
 * 批量登记（原子）：任一键已存在 ⇒ **整批不生效**（不留半登记态）。
 * @param {Record<string, object>} entries 键 → 实现
 * @returns {string[]} 本次实际登记的键（登记完成序）
 */
export function registerCorePorts(entries) {
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new TypeError('registerCorePorts expects a Record<name, impl> object (got: ' + String(entries) + ')');
  }
  const names = Object.keys(entries);
  for (const name of names) {
    portNameOf(name);
    if (REGISTRY.has(name)) throw duplicateError(name); // 先全量校验：冲突即整批不生效
  }
  for (const name of names) REGISTRY.set(name, entries[name]);
  return names;
}

/**
 * 读端口。未登记 ⇒ 抛 `PORT_NOT_READY`（**禁**返回 undefined）。
 * @param {string} name 端口键
 * @returns {object} 已登记的实现（同一引用，非拷贝）
 */
export function corePort(name) {
  portNameOf(name);
  if (!REGISTRY.has(name)) throw notReadyError(name);
  return REGISTRY.get(name);
}

/** 在场判定（装配前/夹具两态可分用；不抛）。 */
export function hasCorePort(name) {
  return typeof name === 'string' && name.trim() !== '' && REGISTRY.has(name);
}

/** 已登记键清单（自检/探针面；返回新数组，外部改动不影响登记表）。 */
export function corePortNames() {
  return [...REGISTRY.keys()];
}

/** 摘除（幂等：未登记返回 false，不抛）。仅用于「接管」与「卸载」两个有名称的场景。 */
export function unregisterCorePort(name) {
  portNameOf(name);
  return REGISTRY.delete(name);
}
