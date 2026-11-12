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

// 探针专用合成 ctx（`scripts/**` 侧的**同形自建**夹具）。
//
// 存在理由（批 `punky-cohesion-fix-20261111` · lane `e2-deadcode`；判据源 `plan/fix-spec.md` R-2 / V-15）：
//   `scripts/probe-sweep-defer.mjs` 原先以**动态 import** 从 `test/helpers/gate-fixture.mjs` 取
//   `assemblyCtxEffect()` —— 这条 **scripts → test 反向依赖**让「跑探针」隐式依赖测试树；而
//   `test/helpers/gate-fixture.mjs` 被 39 个套件 + fixture ledger 用例**冻结**（禁改、禁挪）。
//   ⇒ 按 R-2 首选路径：脚本侧自持最小夹具，形状与 `gate-fixture.mjs#assemblyCtxEffect` **同形**
//   （`on` 项存平坦 `fn`；`effect(factory,label)` 返回撤销函数；`tools/webServer.register` 收集实例与路由）。
//
// 仓内先例：`scripts/smoke/lib/support.mjs#makeAssemblyCtx`（对齐 `assemblyCtxWeb` 的同形自建）。
// 纪律：本模块**只依赖 node 内置**（无第三方、无 `lib/**` 依赖），且**不复制任何生产逻辑**。

/**
 * 装配 ctx **effect 变体**：基线 + `ctx.effect` 提供模式 + 注册/路由收集面。
 *
 * 提供面（**全部为探针可观测位，非产品 API**，与 `gate-fixture.mjs#assemblyCtxEffect` 同形）：
 *   · `listeners` / `calls` / `logger` —— 事件监听表与 logger 三档收集（`calls.info` 是本探针的唯一读数源）；
 *   · `tools` / `subagents`     —— 宿主必需注入键（`lib/index.js#apply` 末尾 `assertRequired` 的 fail-closed 面）；
 *   · `webServer.register`      —— 路由收集（`routes[]`）；
 *   · `registered[]`            —— `tools.register` 收到的工具实例；
 *   · `effect(fn,label)`        —— 记录注册（对齐宿主语义：`fn` 是**返回 cleanup 的工厂**）；
 *   · `effects[]`               —— `{ factory, label }` 清单（本探针按 `label` 出 `effectsRegistered` 读数）；
 *   · `runEffects()`            —— 逐个执行工厂并调用其 cleanup（模拟宿主卸载）；
 *   · `preCount()`              —— `tools/pre-execute` 已挂监听数。
 *
 * ⚠ **返回 `{ ctx, routes }`**（与 `assemblyCtxEffect` / `assemblyCtxWeb` 同形）。
 */
export function makeEffectCtx() {
  const listeners = new Map();
  const calls = { info: [], warn: [], error: [] };
  const routes = [];
  const registered = [];
  const effects = [];
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  const ctx = {
    listeners, calls, logger, routes, registered, effects,
    // 宿主必需注入键：三键缺一 `apply` 即抛 `capability-missing`（装配期 fail-closed 契约面）
    tools: { register: (t) => { registered.push(t); return () => {}; } },
    subagents: { start: async () => ({}), startActivation: async () => ({}), listMembers: async () => [] },
    webServer: { register: (r) => { routes.push(r); return () => {}; } },
    preCount: () => listeners.get('tools/pre-execute')?.size ?? 0,
    // 宿主语义同形：`ctx.effect(factory, label)`，`factory()` 返回 cleanup（可能为 undefined）
    effect: (factory, label) => {
      const rec = { factory, label };
      effects.push(rec);
      return () => { const i = effects.indexOf(rec); if (i >= 0) effects.splice(i, 1); };
    },
    runEffects: () => effects.map((rec) => {
      try {
        const cleanup = rec.factory();
        if (typeof cleanup === 'function') cleanup();
        return { label: rec.label, ok: true };
      } catch (e) {
        return { label: rec.label, ok: false, error: String(e?.message ?? e) };
      }
    }),
    emit() {},
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
  };
  return { ctx, routes };
}
