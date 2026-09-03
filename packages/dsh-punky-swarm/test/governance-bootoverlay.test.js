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

// 残留 #11（m2-residual-20260831）：boot-overlay 启动对账装配级测试补 1 条。
//   断言对象 = lib/index.js:484 `remountGovernanceHook(hotConfig.readSnapshot(), 'boot-overlay')`：
//   启动时（apply 尾部 hotConfig.start() 后）runtime.json overlay 已含 governance 生效变化 →
//   按当前快照补一次对账 remount（logTag='boot-overlay'——热更路径无此 tag，可区分启动对账与热更）。
//   形态对齐 test/governance-hotconfig.test.js（T3 装配级：apply + assemblyCtx + writeRuntime + disposer）。
//   1 条 test（BO1）内两个装配场景：
//   正场景 A：静态 enabled:true + overlay enabled:false → 启动对账 remount 恰一次（unmounted 方向 +
//     '[boot-overlay]' 日志 + [was=true now=false]）+ 静态挂载被卸载（preCount 0）；
//   幂等对照 B：overlay 与静态快照一致（无 governance 覆盖）→ remountGovernanceHook 快照相等 no-op
//     （零 '[boot-overlay]' remount 日志 + hook 保持静态挂载 preCount 1 + 零 warn/error——重复触发不炸）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

// ── 装配级 fake ctx（与 governance-hotconfig.test.js 同款 helper：ctx.on 追加式注册 + logger 计数）──
function assemblyCtx() {
  const listeners = new Map(); // event -> Set<fn>
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  const ctx = {
    listeners,
    calls,
    logger,
    tools: { register() {} },
    emit() {},
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
  };
  ctx.preCount = () => listeners.get('tools/pre-execute')?.size ?? 0;
  return ctx;
}

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-bootgov-'));
}

function writeRuntime(root, overlay) {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(overlay, null, 2));
}

// 静态侧显式 enabled:true + rules:[]（与 overlay 不同即触发启动对账 remount；governance-hotconfig T3 同款静态侧）
const STATIC_GOV = { governance: { hook: { enabled: true, rules: [] } } };

test('BO1 boot-overlay 启动对账：overlay 生效覆盖 → apply 尾部一次 remount（unmounted + [boot-overlay]）；快照一致 → 幂等 no-op', async (t) => {
  // ── 正场景 A：启动前 runtime.json 已含 governance 生效覆盖（enabled:false ≠ 静态 enabled:true）──
  const rootA = freshRoot();
  writeRuntime(rootA, { governance: { hook: { enabled: false } } });
  const ctxA = assemblyCtx();
  const disposerA = apply(ctxA, { root: rootA, ...STATIC_GOV });
  try {
    // 启动对账 remount 恰一次（logTag='boot-overlay'；热更路径无此 tag）
    const bootLinesA = ctxA.calls.info.filter((l) => l.includes('hot config: governance hook') && l.includes('[boot-overlay]'));
    assert.equal(bootLinesA.length, 1, '启动对账 remount 日志恰 1 行（实际: ' + ctxA.calls.info.join(' || ') + '）');
    // unmounted 方向（enabled:false 覆盖 → 卸载；[was=true now=false] 佐证 remount 前静态已挂载）
    assert.ok(bootLinesA[0].includes('unmounted'), 'overlay enabled:false → unmounted 方向（实际: ' + bootLinesA[0] + '）');
    assert.ok(bootLinesA[0].includes('[was=true now=false]'), 'remount was=true → now=false（实际: ' + bootLinesA[0] + '）');
    // 装配结果：静态挂载的 hook 被对账卸载 → pre listener 0（无残留挂载）
    assert.equal(ctxA.preCount(), 0, 'boot-overlay 对账 remount 后 pre listener 0（静态挂载被卸载）');
  } finally {
    disposerA();
  }

  await t.test('BO1-B 幂等对照：overlay 与静态快照一致 → remount no-op（零 [boot-overlay] 日志、preCount 保持 1、零 warn/error）', () => {
    // ── 幂等对照 B：启动前 runtime.json 无 governance 生效变化（空 overlay → 快照 = 静态 config 原样）──
    const rootB = freshRoot();
    writeRuntime(rootB, {});
    const ctxB = assemblyCtx();
    const disposerB = apply(ctxB, { root: rootB, ...STATIC_GOV });
    try {
      // remountGovernanceHook 快照相等 → 返回 false no-op（不 dispose 不重挂不写 remount 日志）
      const bootLinesB = ctxB.calls.info.filter((l) => l.includes('hot config: governance hook') && l.includes('[boot-overlay]'));
      assert.equal(bootLinesB.length, 0, '快照一致 → 无 [boot-overlay] remount 日志（幂等 no-op；实际: ' + ctxB.calls.info.join(' || ') + '）');
      // 静态挂载保持（对账未误卸载）
      assert.equal(ctxB.preCount(), 1, 'overlay 与静态一致 → hook 保持静态挂载（pre listener 1）');
      // remount 幂等不炸：apply 正常返回 disposer、零 warn/error（对账路径无副作用残留）
      assert.equal(ctxB.calls.warn.length, 0, '启动对账路径零 warn（实际: ' + ctxB.calls.warn.join(' || ') + '）');
      assert.equal(ctxB.calls.error.length, 0, '启动对账路径零 error');
    } finally {
      disposerB();
    }
  });
});
