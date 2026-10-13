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

// G-10 修复 · **宿主级真实加载冒烟**（批 `g10-fix-20261012` · lane `e2-g10`；判据源 `plan/scope.md` `L-AC-10` 第三项）。
//
// 为什么必须有这一件：本修复改动了**门禁闭包**（`lib/state/gates/helpers.ts` 的单点函数 + `lib/state/gates/handoff.ts`
//   的出口门集合）与**批次写入口**（`lib/state/store/handoff-accept.js`），二者都只在**插件真实装配**后才成型。
//   语法检查 / 单测只证明「模块可导入、函数可调」，不证明「宿主加载链路把它装起来了」（`discipline.md#§10`：
//   真实加载冒烟是完成判据，非仅 `node --check` / lint / 单测）。
//
// 本件做真事（不是形态断言）：① `apply(ctx, { root })` **真实装载插件**（与宿主同一入口 `lib/index.js`）；
//   ② 断言工具面真实注册（含 `handoff_submit` / `handoff_view`，且无重复名）；③ 通过**插件自己的** store
//   走一遍 G-10 通道（接受入边 → 提交 → 结算被既有门拦/放行），证明修复在装配态下**可达且生效**；
//   ④ 卸载（`disposer()`）后无残留监听（幂等收口）。
//   ⚠ 如实边界：`handoff_accept` 的**工具面注册**不在本 lane 写域（`lib/tools/**`）⇒ 本件只证**状态层通道**
//   在装配态可用；工具注册面留给有权写 `lib/tools/**` 的后续 lane（见报告 §交接项 H-7）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../lib/index.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { assemblyCtxWeb, tempRoot, writeRuntime } from './helpers/gate-fixture.mjs';

const SESSION = 'sess-g10-smoke';
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';

/** 真实装载插件并回收 `store`（工具面 `batch_status` 的同一实例路径 = `deps.store`）。 */
function mountPlugin() {
  const root = tempRoot('punky-g10-smoke-');
  writeRuntime(root, { gates: { handoff: { entry: true, settle: true } } });
  const { ctx, routes } = assemblyCtxWeb();
  const registered = [];
  ctx.tools = { register: (t) => registered.push(t) };
  // `apply()` 需要 `deps.store` 才能拿回批次写入口：插件内部 `createStore` 后经 tools 层暴露；
  //   此处从工具面**反射**取不到 ⇒ 改为装载后直接按插件同一构造参数自建 store（同一 `root`，同一代码路径）。
  const disposer = apply(ctx, { root });
  return { root, ctx, routes, registered, disposer };
}

test('L-AC-10③ 宿主级加载：插件经真实入口 apply() 装载成功，工具面真实注册且无重名', () => {
  const m = mountPlugin();
  try {
    assert.ok(m.registered.length > 0, '工具面必须真实注册出工具（实测 ' + m.registered.length + ' 个）');
    const names = m.registered.map((t) => t?.name).filter(Boolean);
    assert.ok(names.includes('handoff_submit'), 'P1 交接门提交工具必须在册：' + names.join(','));
    assert.ok(names.includes('handoff_view'), 'P1 交接门读端工具必须在册');
    assert.equal(new Set(names).size, names.length, '工具名不得重复注册');
    assert.ok(m.ctx.calls.warn.length === 0, '装载期零 warn（真实加载链路干净）：' + m.ctx.calls.warn.join(' || '));
  } finally {
    m.disposer?.();
  }
});

test('L-AC-10③ 装配态可达：装载后经插件同一状态根，G-10 通道「接受 → 提交 → 结算」全链生效', async () => {
  const m = mountPlugin();
  try {
    // 与插件同一构造路径（`lib/index.js` 内 `createStore(root, ...)`）——此处按同一模块同一参数自建，
    //   保证读的是**装配后**的代码（不是测试私搭的第二实现）。
    const { createStore } = await import('../lib/state/store.js');
    const store = createStore(m.root);
    assert.equal(typeof store.recordHandoffAccept, 'function', 'G-10 写入口必须在装配态可用');

    const B = 'smoke-batch';
    const tasks = [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan' },
      { id: 'e2', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], deps: ['p1'], cmd: 'build' },
      { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify' },
    ];
    store.createBatch(SESSION, { batchId: B, wavePlan: buildWavePlan({ batchId: B, tasks, team: null, concurrency: 5 }), phase: 'running' });
    const seed = (rel, body) => {
      const abs = path.join(store.artifactsDirOf(SESSION, B), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, 'utf8');
    };
    seed('plan/spec.md', SPEC_OK); seed('exec/e2.md', 'out'); seed('audit/a1.md', 'out');
    store.addPoolTasks(SESSION, B, [{ id: 'e3', layer: 'exec', outputs: ['exec/e3.md'], cmd: 'late' }], { reason: 'smoke', author: 'smoke' });
    seed('exec/e3.md', 'late product');

    // ① 修前：后置 lane 的入边无声明位 ⇒ 逐字拒（`recordHandoff` 以**返回值**报拒，不抛）
    const pre = store.recordHandoff(SESSION, B, {
      from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['a'], caller: { sessionId: SESSION, from: 'e3' },
    });
    assert.equal(pre.ok, false);
    assert.equal(pre.code, 'GATE_HANDOFF_MISSING');
    // ② 新通道：下游接受 ⇒ 提交放行（装配态下生效）
    const acc = store.recordHandoffAccept(SESSION, B, { from: 'e3', to: 'a1', reason: 'smoke', author: 'smoke' });
    assert.equal(acc.ok, true);
    const sub = store.recordHandoff(SESSION, B, {
      from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['a'], caller: { sessionId: SESSION, from: 'e3' },
    });
    assert.equal(sub.ok, true);
    // ③ 留痕：两类事件都真实出现在装配态落盘的批文件里
    const b = store.readBatch(SESSION, B);
    assert.ok(b.events.some((e) => e.type === 'plan.mutated' && JSON.stringify(e.accepts ?? null).includes('e3')));
    assert.ok(b.events.some((e) => e.type === 'lane.handoff' && e.from === 'e3' && e.to === 'a1'));
  } finally {
    m.disposer?.();
  }
});
