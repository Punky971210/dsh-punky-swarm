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

// punky-fix-p2-20261023 · A1-P2-01（ESM 环 / 首求值 TDZ）的**长期防线 guard**（tester 落）。
//
// ── RED 基线（补丁前 `8d7815b` 形态，必红）────────────────────────────────────────────
//   对 `8d7815b` 的 `lib/watch/heartbeat/primitives.js` 做**首求值**（独立进程 `import()`）会抛：
//     ReferenceError: Cannot access 'REASON_BLIND_RUN_UPSTREAM_NEVER_READY' before initialization
//   栈顶 = `lib/watch/heartbeat/notice.js`（该模块在**模块顶层**用 `primitives.js` 的 `const`
//   构造 `new Set([...])`）。同一矩阵在补丁前是 **13/14 OK**（仅 `primitives` 抛），补丁后 **14/14 OK**。
//   ⇒ 本文件的两组断言在补丁前必红，是标准 RED→GREEN 构造（不是「恒真套话」）。
//
// ── 为什么是**长期**防线（不是一次性验收）────────────────────────────────────────────
//   拆环后**仍有 1 个 SCC / 8 模块**（`watch/heartbeat/{activity,context,evidence,longrun,primitives,
//   stalled,state-surface}.js` + `watch/lane-heartbeat.js`）。它当前之所以不崩，**仅因**残余边全部指向
//   聚合器 `lane-heartbeat.js` 的**函数声明**（ESM 实例化期即初始化 ⇒ 首求值不读其值）。
//   任一条件被破坏即回到 TDZ 崩溃面：
//     ① 环内模块在**模块顶层**读另一环内模块的 `const` / `let`；
//     ② 环内导出改成 `const` 箭头函数（不再是函数声明）；
//     ③ 新增「叶子模块反向 import 聚合器」的边。
//   ⇒ **14 个模块的首求值清单不得缩减**（缩一个就少一个可触发入口的护栏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(PKG_ROOT, 'lib');

/** 首求值矩阵的**冻结清单**（14 个入口；不得缩减 —— 见文件头「长期防线」）。 */
const FIRST_EVAL_MODULES = Object.freeze([
  'lib/index.js',
  'lib/watch/lane-heartbeat.js',
  'lib/watch/heartbeat/primitives.js',
  'lib/watch/heartbeat/notice.js',
  'lib/watch/heartbeat/context.js',
  'lib/watch/heartbeat/activity.js',
  'lib/watch/heartbeat/evidence.js',
  'lib/watch/heartbeat/longrun.js',
  'lib/watch/heartbeat/stalled.js',
  'lib/watch/heartbeat/state-surface.js',
  'lib/watch/heartbeat/scan.js',
  'lib/watch/heartbeat/replay.js',
  'lib/state/gates.js',
  'lib/wave-plan.js',
]);

/** 残余环的冻结成员集（8 模块，排序后比较；与 `sccCount/memberCount` 断言互补）。 */
const RESIDUAL_SCC = Object.freeze([
  'watch/heartbeat/activity.js',
  'watch/heartbeat/context.js',
  'watch/heartbeat/evidence.js',
  'watch/heartbeat/longrun.js',
  'watch/heartbeat/primitives.js',
  'watch/heartbeat/stalled.js',
  'watch/heartbeat/state-surface.js',
  'watch/lane-heartbeat.js',
]);

/** 在**独立子进程**里首求值一个模块（同进程会命中 ESM 模块缓存 ⇒ 掩盖 TDZ）。 */
function firstEvalInChild(rel) {
  const url = pathToFileURL(path.join(PKG_ROOT, rel)).href;
  try {
    const out = execFileSync(process.execPath, [
      '--input-type=module', '-e',
      `import(${JSON.stringify(url)}).then(() => console.log('OK'))`,
    ], { cwd: PKG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: out.includes('OK'), stderr: '' };
  } catch (e) {
    const stderr = String(e?.stderr ?? e?.message ?? e);
    return { ok: false, stderr: stderr.split('\n').filter(Boolean).pop() ?? stderr };
  }
}

// ── 静态 ESM 图 + Tarjan SCC（边 = 静态 import/export-from 的相对说明符）──────────────
const EDGE_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function walkJs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function buildGraph() {
  const files = walkJs(LIB);
  const ids = new Map(files.map((f, i) => [f, i]));
  const names = files.map((f) => path.relative(LIB, f).split(path.sep).join('/'));
  const graph = files.map(() => new Set());
  for (const [i, f] of files.entries()) {
    const src = readFileSync(f, 'utf8');
    EDGE_RE.lastIndex = 0;
    let m;
    while ((m = EDGE_RE.exec(src)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      let abs = path.resolve(path.dirname(f), spec);
      if (!abs.endsWith('.js')) abs += '.js';
      const j = ids.get(abs);
      if (j !== undefined && j !== i) graph[i].add(j);
    }
  }
  return { files, names, graph };
}

function tarjanScc(graph) {
  const n = graph.length;
  const idx = new Array(n).fill(-1);
  const low = new Array(n).fill(0);
  const onStack = new Array(n).fill(false);
  const stack = [];
  const sccs = [];
  let counter = 0;
  const strongconnect = (v) => {
    idx[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = true;
    for (const w of graph[v]) {
      if (idx[w] === -1) {
        strongconnect(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], idx[w]);
      }
    }
    if (low[v] === idx[v]) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack[w] = false;
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp);
    }
  };
  for (let v = 0; v < n; v += 1) if (idx[v] === -1) strongconnect(v);
  return sccs;
}

test('A1-P2-01 / AC-8 · 首求值矩阵：14 个入口逐个独立进程 import 全 OK（RED 基线 = primitives 抛 TDZ）', () => {
  // 清单不得缩减：长度与非空断言先于遍历（缩清单会让本 guard 静默变弱）
  assert.equal(FIRST_EVAL_MODULES.length, 14, '首求值清单必须保持 14 个入口（不得缩减）');
  assert.ok(FIRST_EVAL_MODULES.includes('lib/watch/heartbeat/primitives.js'), 'TDZ 根因入口必须在清单内');
  assert.ok(FIRST_EVAL_MODULES.includes('lib/watch/lane-heartbeat.js'), '聚合器入口必须在清单内');

  const bad = [];
  for (const rel of FIRST_EVAL_MODULES) {
    const r = firstEvalInChild(rel);
    if (!r.ok) bad.push(rel + ' ⇒ ' + r.stderr);
  }
  assert.deepEqual(bad, [], '全部 14 个入口的首求值都必须不抛（任一抛 = 环内顶层读未初始化绑定）');
});

test('A1-P2-01 / AC-8 · 冷加载冒烟：包入口 import 成功且 inject 声明面不被环破坏', async () => {
  const m = await import('../lib/index.js');
  assert.equal(typeof m.apply, 'function', 'lib/index.js 必须导出 apply');
  assert.equal(m.name, 'dsh-punky-swarm', 'name 声明');
  assert.deepEqual(m.inject, ['tools', 'webServer', 'subagents'], 'inject 三键内容/顺序逐字不变');
});

test('A1-P2-01 / AC-8 · 静态 ESM 环：SCC 数 = 1、成员 = 8、成员集逐项冻结（BEFORE = 2 SCC / 13 模块）', () => {
  const { names, graph } = buildGraph();
  const sccs = tarjanScc(graph);
  assert.equal(sccs.length, 1, 'BEFORE 有 2 个 SCC（SCC2 已由 handoffGate* 下沉切断）；AFTER 必须恰 1 个');
  const members = sccs[0].map((i) => names[i]).sort();
  assert.equal(members.length, 8, '残余环成员数必须为 8（BEFORE = 13）');
  assert.deepEqual(members, [...RESIDUAL_SCC].sort(),
    '残余环成员集冻结：新增/消失任何成员都必须由本 guard 显式升级（触发条件见文件头三条）');
});

test('A1-P2-01 / REVERSE · SCC2 四模块两两不成环（证明 handoffGate* 下沉真的切断了环，而非巧合）', () => {
  const { names, graph } = buildGraph();
  const byName = new Map(names.map((nm, i) => [nm, i]));
  const scc2 = ['state/gates.js', 'state/gates/entry.js', 'state/gates/handoff.js', 'wave-plan.js'];
  const ids = scc2.map((nm) => {
    const i = byName.get(nm);
    assert.notEqual(i, undefined, '模块必须在场：' + nm);
    return i;
  });
  // 逐对：不存在「a 可达 b 且 b 可达 a」的两两互达（同属一个 SCC 的充要条件）
  const reach = (from, to) => {
    const seen = new Set();
    const q = [from];
    while (q.length) {
      const v = q.pop();
      if (v === to) return true;
      if (seen.has(v)) continue;
      seen.add(v);
      for (const w of graph[v]) q.push(w);
    }
    return false;
  };
  for (let a = 0; a < ids.length; a += 1) {
    for (let b = a + 1; b < ids.length; b += 1) {
      const ab = reach(ids[a], ids[b]);
      const ba = reach(ids[b], ids[a]);
      assert.equal(ab && ba, false, 'SCC2 成员不得两两互达：' + scc2[a] + ' / ' + scc2[b]);
    }
  }
});
