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

// ─────────────────────────────────────────────────────────────────────────────
// R-5@techdebt2 · 宿主外部依赖的**条件回退**解析钩子（惰性兜底，非无条件改写）
//
// 存在理由：本包以裸 specifier import 宿主外部依赖（`lib/tools/*.js` → `@deepseek-ai/dsh-tools`、
//   `lib/auditlog/sink.js` → `@deepseek-ai/cordis`），而**裸检出**下
//   `packages/dsh-punky-swarm/node_modules` 为空（本机实测 0 条目）⇒ 任何加载 `lib/**` 的进程
//   都抛 `ERR_MODULE_NOT_FOUND`。主测试进程可由命令行 `--import` 兜住，**测试内 spawn 的子进程
//   不会继承**该 `--import` ⇒ 子进程侧解析失败（本批 R-5 要收口的就是这条链）。
//
// ⚠ 唯一红线（本文件的存在意义）：**只在本地解析失败时才介入**。
//   ① 先 `nextResolve(specifier, context)` 走**默认解析链**（本地 `node_modules` / 自引用 / 条件导出）；
//   ② **仅当**默认链抛「找不到」时，才回退到宿主检出；
//   ③ ⇒ 生产 / CI 有 `node_modules` 时本钩子**一次都不介入**，**生产语义零变更**。
//   **反面形态（本批明令禁止、验收不通过）**：映射命中即 `return { url, shortCircuit: true }`
//     （先于 `nextResolve`）—— 那是**无条件改写**，会在生产环境**绕过本地依赖**。
//     上批 `role-deliverable-inject-fix-20261008/…/_test-loader.mjs:31` 即该违规形态，本文件不得复现。
//
// 「找不到」有两个 code（本 lane 实测，原始回显见 proof/01-mechanism.md）：
//   · ESM 链（`import` / `import.meta.resolve`）   ⇒ `ERR_MODULE_NOT_FOUND`
//   · CJS 链（`createRequire(...).resolve(...)`）  ⇒ `MODULE_NOT_FOUND`
//   两者语义相同（皆 = 本地解析失败），且**共同**构成「需要回退」的判据 ⇒ 一并接受。
//   **其余任何错误**（语法错 / 权限错 / 条件导出不匹配）**原样抛出**，绝不吞掉。
//
// 注册顺序（既有实测踩坑记录，必须保留）：**先**把宿主映射表解析出来，**再** `registerHooks` ——
//   `require.resolve` 自身会经过本钩子 ⇒ 在钩子体内解析会自递归到 `RangeError: Maximum call stack size exceeded`。
//
// 用法（两个入口）：
//   ① 主测试进程：`node --import ./test/helpers/isolated-home.preload.mjs \
//                          --import file:///<本文件绝对路径> --test`
//   ② 测试内派生的子进程：用本模块导出的 `hostDepFallbackImportArgs()` 生成 argv
//      （**必须** `file:///` 形态；直接传 Windows 驱动器绝对路径会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，
//        那是调用姿势问题、不是项目缺陷）。
//
// 可移植性（AC-R5-4）：候选宿主根按下列顺序**发现**，**不含机器特定的绝对路径字面量** ——
//   ① 环境变量 `PSWARM_HOST_NODE_MODULES`（**覆盖**：一旦声明即**只**用这些根，不再推导；
//      可用 `path.delimiter`（`;`）分隔多个根）—— 便于钉住版本 / CI 可控 / 降级取证；
//   ② 未声明时，由本包位置**逐级向上**推导：`<祖先>/deepseek-harness/apps/cli/node_modules` 与 `<祖先>/node_modules`。
//   全部候选都不可用 ⇒ **优雅降级**：钩子照常注册但**永不回退**，原始错误原样抛出
//   （**不误报通过**）；降级原因经 `hostDepFallbackState()` 与
//   `PSWARM_HOST_DEP_FALLBACK_TRACE=1`（stderr）留读数。
//
// 边界（诚实声明）：
//   · 只覆盖**精确裸 specifier**（下表三项）；**子路径**（`@deepseek-ai/dsh-tools/lib/x.js`）不回退
//     —— 本仓 `lib/**` 与 `test/**` 实测只用精确形态（见 lane 产物 `exec/e02-env-hook.md` §证据）；
//     子路径若出现，原错误照抛（不误报）。
//   · 由 `node --test` 收集执行时（`test/**` 下所有模块都会被收集）本文件只注册钩子、零副作用、零断言。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 需要回退的裸 specifier 白名单（= `lib/**` 的实际外部 import 面）。 */
export const HOST_DEP_SPECIFIERS = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-app-boot',
];

const ENV_ROOTS = 'PSWARM_HOST_NODE_MODULES';
const ENV_TRACE = 'PSWARM_HOST_DEP_FALLBACK_TRACE';
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(SELF_DIR, '..', '..');
/** 向上推导的层数（`<pkg>` → `packages` → `<repo 父>` → …）。 */
const ASCENT_LEVELS = 4;

const trace = (line) => {
  if ((process.env[ENV_TRACE] ?? '').trim() !== '') process.stderr.write('[host-dep-fallback] ' + line + '\n');
};

/** 候选宿主 `node_modules` 根：env 显式覆盖则**只用**声明的根；否则由包位置向上推导。 */
function candidateRoots() {
  const roots = [];
  const declared = (process.env[ENV_ROOTS] ?? '').trim();
  if (declared.length > 0) {
    // 「覆盖」= 只此若干根（可钉住 / CI 可控；亦用于「宿主检出缺失」的降级取证 —— 见 lane 产物 proof/04）
    for (const raw of declared.split(path.delimiter)) {
      const p = raw.trim();
      if (p.length > 0) roots.push(path.resolve(p));
    }
    return [...new Set(roots)];
  }
  let dir = PKG_ROOT;
  for (let level = 0; level < ASCENT_LEVELS; level += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    roots.push(path.join(dir, 'deepseek-harness', 'apps', 'cli', 'node_modules'));
    roots.push(path.join(dir, 'node_modules'));
  }
  return [...new Set(roots)];
}

const candidates = candidateRoots();
/** specifier → 宿主检出内的绝对 file:// URL（**注册钩子之前**解析完毕，防自递归）。 */
const mapped = new Map();
/** 候选根不可用 / 解析失败的原因（降级留读数）。 */
const degraded = [];
let registerUnavailable = false;

for (const root of candidates) {
  let req = null;
  try {
    if (!fs.statSync(root).isDirectory()) { degraded.push({ root, reason: 'not-a-directory' }); continue; }
    req = createRequire(pathToFileURL(path.join(root, '__host_dep_anchor__.js')));
  } catch (error) {
    degraded.push({ root, reason: 'root-unusable:' + String(error?.code ?? error?.message ?? error) });
    continue;
  }
  for (const spec of HOST_DEP_SPECIFIERS) {
    if (mapped.has(spec)) continue;
    try {
      mapped.set(spec, pathToFileURL(req.resolve(spec)).href);
    } catch (error) {
      degraded.push({ root, spec, reason: String(error?.code ?? error?.message ?? error) });
    }
  }
}

trace('candidates=' + JSON.stringify(candidates));
trace('mapped=' + JSON.stringify([...mapped.entries()]));
if (degraded.length > 0) trace('degraded=' + JSON.stringify(degraded));

if (typeof registerHooks === 'function') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        // ① 先走**默认解析链**（本地 node_modules / 自引用 / 条件导出）
        return nextResolve(specifier, context);
      } catch (error) {
        // ② **仅**「本地找不到」才回退：ESM 链 ERR_MODULE_NOT_FOUND / CJS 链 MODULE_NOT_FOUND
        const code = error?.code;
        if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw error;
        const hit = mapped.get(specifier);
        // ③ 白名单外 / 宿主检出不可用 ⇒ 原样抛（**不误报通过**）
        if (hit === undefined) throw error;
        trace('fallback ' + specifier + ' => ' + hit);
        return { url: hit, shortCircuit: true };
      }
    },
  });
  trace('registered=true');
} else {
  // 老 Node（无 `registerHooks`）⇒ 不注册、不回退、原始错误照抛（不静默伪装成功）
  registerUnavailable = true;
  trace('registered=false (node:module#registerHooks 不可用)');
}

/** 本文件的 `file://` URL（供 `--import` 使用；直接拼 Windows 驱动器路径会被 Node 拒）。 */
export const HOST_DEP_FALLBACK_URL = import.meta.url;

/** 生成子进程 argv 的 `--import` 片段（`file:///` 形态，跨平台）。 */
export function hostDepFallbackImportArgs() {
  return ['--import', HOST_DEP_FALLBACK_URL];
}

/** 只读读数：候选根 / 映射表 / 降级原因 / 是否成功注册（供取证与 AC-R5-4「缺失时留读数」）。 */
export function hostDepFallbackState() {
  return {
    candidates,
    mapped: Object.fromEntries(mapped),
    degraded,
    registerUnavailable,
    registered: !registerUnavailable,
  };
}
