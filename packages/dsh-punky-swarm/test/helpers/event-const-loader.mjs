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
// R3-4 · `GATE_EVENT_CONST_MISSING` 真 E2E 的**源码面破坏器**（module loader hook）
//
// 存在理由（为什么必须走到"改源"这一步）：
//   `lib/state/store.js` 的 fail-closed 守卫 `requireEventType(evt, name)` 判据是
//   「`evt[name]` 是非空字符串」；其默认实参 `evt = EVT`（ESM 命名空间 import `* as EVT`）。
//   Node 的 ESM 命名空间对象实测 **不可改**（`Object.isExtensible === false`；
//   `delete ns.X` ⇒ `TypeError: Cannot delete property 'X' of [object Module]`）
//   ⇒ 进程内无法制造「常量缺位」；而守卫的注入缝 `resolveGateEventTypes(evt = EVT)`
//   是模块私有（导出它 = 解冻 C1 未接线项）。**唯一不触碰生产代码的制造法** = 在**加载期**
//   改写 `lib/state/event-types.js` 的源码文本 ⇒ 本 hook。
//
// 威胁模型对齐：该守卫的真实触发场景本就是「有人改动 `event-types.js` 把常量删掉 / 改名」
//   —— 那是**源码面事件**。故本 hook 不是"人造场景"，而是对该源码面事件的**忠实模拟**：
//   只做一件事，把 `export const <NAME> = <字面量>;` 的右值改写为 `undefined;`（= 常量缺位）。
//
// 纪律：
//   ① **只改被点名的常量**（`initialize(data).names`），其余源码逐字不变；
//   ② **只改本包 `lib/state/event-types.js`**（URL 后缀匹配），其它模块一律放行；
//   ③ 不做任何静默兜底：钩子未生效时由**子进程自证**（见 `event-const-missing-child.mjs`
//      的 `sabotageApplied`）暴露，父测试据此直接判红——绝不让「钩子失效」被读成「守卫失效」。
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_SUFFIX = '/lib/state/event-types.js';
// 守卫本体模块（**仅负向对照档**使用：把 fail-closed 判据置 `false`，用以证明本套件有判别力）
const GUARD_SUFFIX = '/lib/state/store.js';
const GUARD_SNIPPET = "if (typeof t !== 'string' || t.length === 0) {";

/** 被点名的常量名（由 `event-const-sabotage.preload.mjs` 经 `register(..., {data})` 传入）。 */
let NAMES = [];
/** 负向对照档开关：削弱 `requireEventType` 的判据（**只为证明断言有判别力**，不是被测行为）。 */
let WEAKEN_GUARD = false;

/** Node ≥20.6 hooks 的 `initialize`（在 hooks 线程内被调用一次）。 */
export function initialize(data) {
  NAMES = Array.isArray(data?.names) ? data.names.filter((n) => typeof n === 'string' && n.length > 0) : [];
  WEAKEN_GUARD = data?.weakenGuard === true;
}

/** 统一解码 source（Node 文档口径：`string | ArrayBufferView | ArrayBuffer`）。
 *  实测（Node 22.22.2，本机对该文件的 loader 观测）：默认 ESM 加载器返回的是 **`Buffer`**
 *  （`ctor:"Buffer"` · `instanceof Uint8Array` 真 · `typeof === "object"` · `byteLength 25929`），
 *  **不是 string**。证据与观测方法见 `docs/gate-assertion-blueprint-2026-09-21.md` §9.4。
 *  ⚠️ 若按 `typeof === 'string'` 判定后放行 ⇒ 钩子**静默失效**（破坏没改到源、测试照旧通过）。
 *  故此处一行覆盖三种合法形态；未知形态由 `TextDecoder` 直接抛（天然 fail-loud，不写形态分支）。 */
function decodeSource(raw) {
  return typeof raw === 'string' ? raw : new TextDecoder('utf8').decode(raw);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const bare = url.split('?')[0];
  // ── 负向对照档：削弱守卫（**只在显式开关下生效**；命中失败即抛，不许静默）──────────────
  if (WEAKEN_GUARD && bare.endsWith(GUARD_SUFFIX)) {
    const src = decodeSource(result?.source);
    if (!src.includes(GUARD_SNIPPET)) {
      throw new Error('[event-const-loader] 削弱守卫失败：判据行未命中（store.js 源码形态已变）');
    }
    return { ...result, source: src.replace(GUARD_SNIPPET, 'if (false) {') };
  }
  // 非目标模块 / 无点名常量 ⇒ 逐字透传（零副作用）
  if (NAMES.length === 0) return result;
  if (!bare.endsWith(TARGET_SUFFIX)) return result;

  const raw = result?.source;
  if (raw === undefined || raw === null) {
    // 目标模块无 source（如被 CJS loader 接管）⇒ 破坏**不可能**生效 ⇒ 抛（不许静默放行）
    throw new Error('[event-const-loader] 目标模块无 source（format=' + String(result?.format)
      + '）⇒ 破坏无法生效，拒绝静默放行');
  }
  let source = decodeSource(raw);

  const applied = [];
  for (const name of NAMES) {
    // 逐字匹配 `export const <NAME> = <非分号串>;`（本文件常量全为该形态、单行）
    const re = new RegExp('(export const ' + name + ' = )[^;]+;', 'g');
    if (!re.test(source)) continue;
    re.lastIndex = 0;
    source = source.replace(re, '$1undefined;');
    applied.push(name);
  }
  // 点名了但一处未命中 ⇒ 抛（不静默：钩子与源码形态失配必须立刻可见）
  if (applied.length !== NAMES.length) {
    throw new Error('[event-const-loader] 破坏未完全生效：requested=' + JSON.stringify(NAMES)
      + ' applied=' + JSON.stringify(applied) + ' @ ' + url);
  }
  return { ...result, source };
}
