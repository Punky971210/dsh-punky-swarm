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

// ── A2-G14 强化用的冻结面（批 punky-fix-house-20261023 / h5-tester）──────────────────
// 三张冻结表共同构成**结构断言**（与「首求值 = 行为冒烟」互补，不可互替）：
//   `RESIDUAL_SCC_EDGES`   = 环成员**诱导子图**的边（成员之间的依赖形状）
//   `RESIDUAL_SCC_INBOUND` = 环的**外部入边**（谁是「叶子反向 import 聚合器」的那条边）
//   `KNOWN_DYNAMIC_EDGES`  = 全 lib 中**动态 import** 形态的已知边（证动态分支不是死码）
// 冻结值来源：本文件落地时对 `9aba643`+本批工作树的实测（边集 24 / 入边 3 / 动态边 1）。
// 改这些常量 = 显式声明「环的形状变了」，必须在 commit message 写明理由（见规格 R-H）。
const RESIDUAL_SCC_EDGES = Object.freeze([
  'watch/heartbeat/activity.js -> watch/heartbeat/context.js',
  'watch/heartbeat/context.js -> watch/lane-heartbeat.js',
  'watch/heartbeat/evidence.js -> watch/heartbeat/context.js',
  'watch/heartbeat/evidence.js -> watch/heartbeat/primitives.js',
  'watch/heartbeat/longrun.js -> watch/heartbeat/activity.js',
  'watch/heartbeat/longrun.js -> watch/heartbeat/context.js',
  'watch/heartbeat/longrun.js -> watch/heartbeat/evidence.js',
  'watch/heartbeat/longrun.js -> watch/heartbeat/primitives.js',
  'watch/heartbeat/longrun.js -> watch/lane-heartbeat.js',
  'watch/heartbeat/primitives.js -> watch/lane-heartbeat.js',
  'watch/heartbeat/stalled.js -> watch/heartbeat/activity.js',
  'watch/heartbeat/stalled.js -> watch/heartbeat/context.js',
  'watch/heartbeat/stalled.js -> watch/heartbeat/evidence.js',
  'watch/heartbeat/stalled.js -> watch/heartbeat/longrun.js',
  'watch/heartbeat/stalled.js -> watch/lane-heartbeat.js',
  'watch/heartbeat/state-surface.js -> watch/heartbeat/activity.js',
  'watch/heartbeat/state-surface.js -> watch/heartbeat/context.js',
  'watch/heartbeat/state-surface.js -> watch/heartbeat/primitives.js',
  'watch/heartbeat/state-surface.js -> watch/lane-heartbeat.js',
  'watch/lane-heartbeat.js -> watch/heartbeat/context.js',
  'watch/lane-heartbeat.js -> watch/heartbeat/longrun.js',
  'watch/lane-heartbeat.js -> watch/heartbeat/primitives.js',
  'watch/lane-heartbeat.js -> watch/heartbeat/stalled.js',
  'watch/lane-heartbeat.js -> watch/heartbeat/state-surface.js',
]);

/** 环的冻结外部入边（非成员 → 成员；「叶子反向 import 聚合器」即在此面红）。 */
const RESIDUAL_SCC_INBOUND = Object.freeze([
  'index.js -> watch/lane-heartbeat.js',
  'tools/lane-tools.js -> watch/lane-heartbeat.js',
  'tools/query-tools.js -> watch/lane-heartbeat.js',
]);

/** 已知动态 import 边（全 lib 唯一一处：`lib/tools/lane-tools.js` 的 `await import('../watch/lane-heartbeat.js')`）。 */
const KNOWN_DYNAMIC_EDGES = Object.freeze(['tools/lane-tools.js -> watch/lane-heartbeat.js']);

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

// ── A2-G14 ② · 动态 `import('…')` 边（本批新增面；上面的 `EDGE_RE`/`buildGraph` **零改动**）──
// `EDGE_RE` 只认**静态** import ⇒ `import('…')` 形态的边在图里「隐身」：把环内一条静态返边改写成
// `await import('./x.js')` 后，成员集不变、静态边集变小、而结构断言「看不见这条边消失了」。
// `buildGraphWithDynamic()` = 在 `buildGraph()`（既有实现，逐字复用）之上**补扫**动态形态，
// 返回 `{ names, graph, edges }`；`edges` 逐条带 `kind`（static / dynamic），供边集冻结与「动态独有边」断言使用。
/** 动态 `import('…')` / `await import("…")` 形态（前置非 `.`/标识符字符，避免误吃 `foo.import(`）。 */
const DYNAMIC_IMPORT_RE = /(?:^|[^.\w$])import\s*\(\s*['"]([^'"]+)['"]/g;

function buildGraphWithDynamic() {
  const base = buildGraph();
  const { files, names, graph } = base;
  const ids = new Map(files.map((f, i) => [f, i]));
  const edges = [];
  for (const [i, f] of files.entries()) {
    const src = readFileSync(f, 'utf8');
    for (const [re, kind] of [[EDGE_RE, 'static'], [DYNAMIC_IMPORT_RE, 'dynamic']]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        let abs = path.resolve(path.dirname(f), spec);
        if (!abs.endsWith('.js')) abs += '.js';
        const j = ids.get(abs);
        if (j === undefined || j === i) continue;
        if (kind === 'dynamic') graph[i].add(j); // 静态边已由 buildGraph 加入（幂等 add 亦可，此处只补动态）
        edges.push({ from: names[i], to: names[j], kind });
      }
    }
  }
  return { files, names, graph, edges };
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

// ── A2-G14 · 三处真缺口强化（批 punky-fix-house-20261023 / lane h5-tester）────────────
// 既有 4 例守的是「成员集 + 首求值」，本组补的是**结构侧的边集与覆盖面**。三例各自带
// **可达的失败构造**（$TEMP 整包副本内做，仓库零改动），逐条写在用例注释里 —— 禁止恒真断言。

test('A2-G14 ① · 环边集冻结：诱导子图 24 条 + 外部入边 3 条逐条比对（新增返边必红）', () => {
  // 反向构造（在 `$TEMP` 的**整包副本**内改，真仓零改动；跑法见本批 exec/test-report-house.md）：
  //   R1｜`lib/watch/heartbeat/activity.js` 追加 `import './evidence.js';`（成员间新边、成员集不变）
  //       ⇒ **本条红**；而「成员集断言」（成员仍 8）仍绿 ⇒ 证本条抓的是既有断言看不见的新维度。
  //   R2｜`lib/watch/heartbeat/scan.js` 追加 `import './lane-heartbeat.js';`（叶子反向 import 聚合器
  //       = 文件头触发条件 ③）⇒ 外部入边断言红（scan 成为第 4 条入边）。
  //   R3｜删掉环内任一条静态边（如 `stalled.js` 的 `import './longrun.js';`）⇒ 诱导边集断言红
  //       （证「没红」不是因为断言恒真）。
  const { names, graph, edges } = buildGraphWithDynamic();
  const sccs = tarjanScc(graph);
  assert.equal(sccs.length, 1, '前置：残余环必须恰 1 个 SCC（成员集另由 AC-8 例独立钉住）');
  const members = new Set(sccs[0].map((i) => names[i]));
  const pairs = (pred) => [...new Set(edges.filter(pred).map((e) => e.from + ' -> ' + e.to))].sort();

  assert.deepEqual(
    pairs((e) => members.has(e.from) && members.has(e.to)),
    [...RESIDUAL_SCC_EDGES].sort(),
    '环成员诱导子图的边集冻结：新增/消失任何一条环内边都必须由本 guard 显式升级（判据 = 边集，不是成员集）',
  );
  assert.deepEqual(
    pairs((e) => !members.has(e.from) && members.has(e.to)),
    [...RESIDUAL_SCC_INBOUND].sort(),
    '环的外部入边冻结：「叶子模块反向 import 聚合器」会在这一面红（文件头触发条件 ③）',
  );
});

test('A2-G14 ② · 动态 import 边纳入：静态扫不到的 `import(…)` 边必须在图上（防「改动态即隐身」）', () => {
  // 反向构造（`$TEMP` 整包副本内）：
  //   R4｜把环内一条静态边改写成动态形态（如 `activity.js` 的 `import ... from './context.js'` →
  //       `const m = await import('./context.js');`）⇒ 本组与 ① 均仍绿（边还在图上）
  //       ⇒ 证明「改动态」不再隐身；同时在副本内加一条**全新**动态边
  //       （`scan.js` 里 `await import('./lane-heartbeat.js')`）⇒ ① 的外部入边断言红。
  //   R5｜把 `buildGraphWithDynamic()` 里的 `[DYNAMIC_IMPORT_RE, 'dynamic']` 一项删掉
  //       （= 回退成本批前的缺口形态）⇒ 下方「动态独有边」断言必红（`[]` ≠ 1 条）。
  const dyn = buildGraphWithDynamic();
  const stat = buildGraph();
  const key = (e) => e.from + ' -> ' + e.to;
  const statSet = new Set(dyn.edges.filter((e) => e.kind === 'static').map(key));
  const dynSet = new Set(dyn.edges.map(key));
  const onlyDynamic = [...dynSet].filter((k) => !statSet.has(k)).sort();

  assert.deepEqual(
    onlyDynamic,
    [...KNOWN_DYNAMIC_EDGES].sort(),
    '动态分支必须补上静态正则漏掉的那些边（本仓唯一一处：tools/lane-tools.js 的 await import(../watch/lane-heartbeat.js)）',
  );
  // 动态边的落点是「环成员」⇒ 它确实落在本 guard 的判定面上（而不是无关模块之间的边）
  assert.ok(
    RESIDUAL_SCC.includes('watch/lane-heartbeat.js'),
    '动态边的目标必须是环内聚合器（否则该边不影响 TDZ 面，本条应改成不同的构造）',
  );
  // 含动态边后 SCC 结构不得变化（若变化说明动态分支把不存在的环算了进来 ⇒ 假红）
  assert.equal(tarjanScc(dyn.graph).length, tarjanScc(stat.graph).length, '含动态边的 SCC 数必须与静态口径一致');
});

test('A2-G14 ③ · 首求值清单覆盖环成员全集：清单 ⊇ SCC 成员（清单缩水 / 新成员漏登记必红）', () => {
  // 反向构造（`$TEMP` 整包副本内）：
  //   R6｜把 `FIRST_EVAL_MODULES` 里的 `'lib/watch/heartbeat/activity.js'` 换成
  //       `'lib/mailbox-paths.js'`（**长度仍 14** ⇒ AC-8 例的长度/必含项断言仍绿）
  //       ⇒ **本条红**（环成员 activity.js 不在清单内）⇒ 证本条独立于长度断言。
  //   R7｜在 `RESIDUAL_SCC` 追加 `'state/store/lifecycle.js'`（清单内无此入口）⇒ 本条亦红
  //       （新成员漏进首求值清单的形态）。
  const { names, graph } = buildGraph();
  const sccs = tarjanScc(graph);
  assert.equal(sccs.length, 1, '前置：残余环必须恰 1 个 SCC');
  const members = sccs[0].map((i) => names[i]);
  const missing = members.filter((m) => !FIRST_EVAL_MODULES.includes('lib/' + m));
  assert.deepEqual(missing, [], '环成员必须全部出现在首求值清单内（清单缩水 ⇒ 少一个可触发入口的护栏）');

  // 反向自证：清单里「指向环成员」的条目必须恰等于成员集（防用无关模块凑覆盖数）
  const covered = FIRST_EVAL_MODULES.filter((p) => p.startsWith('lib/') && RESIDUAL_SCC.includes(p.slice('lib/'.length)));
  assert.deepEqual(
    covered.slice().sort(),
    [...RESIDUAL_SCC].map((m) => 'lib/' + m).sort(),
    '清单对环成员的覆盖必须逐项相等（既不许缺，也不许用清单外成员冒充）',
  );
});
