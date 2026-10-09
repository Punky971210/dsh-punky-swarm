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
// 在跑批不降档守卫（批 `assign-tier-downgrade-guard-20261009` / lane `e01-impl` · T4 回归用例）
//
// 被检实现：`lib/tools/assign-tools.js`
//   · 模块级单点 `tierRank`（原为 `execute` 内局部常量）；
//   · 自身写入路径新增保护分支：`downgradeBlocked = hasActive && tierRank(本次) < tierRank(既有)`。
// 判据源：`plan/scope.md` §验收标准 —— L-AC-1（降档不覆盖）/ L-AC-2（判定式不引 pendingBatch）/
//   L-AC-3（history 留痕）/ L-AC-4（活跃批声明 C/D ⇒ pendingBatch=false 且 guard 放行 · 阴性）/
//   L-AC-5（无活跃批行为逐字不变 · 阴性）/ L-AC-6（成员面能力保留）/ L-AC-8（rank 单点）。
//
// 纪律：本套件**只用 `assign_check` + store + guard**（不建批、不派发）⇒ **不引入 `withDefaultTeam`**
//   （该注入面由 `test/fixture-team-ledger.test.js` 的允许名单双侧锁定，不得擅自扩面）。
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assertMemberActionTierC } from '../lib/tools/tier-gate.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSIGN_SRC = path.join(PKG_ROOT, 'lib', 'tools', 'assign-tools.js');

const RATIONALE_C = '测试：命中多线并行判据（≥2 条可并行推进的任务线），需 wave_plan 建批';
const RATIONALE_B = '测试：需独立上下文，评 B 派单个 subagent（单步调研）';
const RATIONALE_A = '测试：单线程直做（无并行任务线、无依赖链）';
const RATIONALE_D = '测试：引用 parallel 特征面；但需 durable 席位与事件队列交接，属例外；偏离方向为升档至 D，上限即 team 通道';

/** 夹具：真 store + 真工具面（注册 guard 收集器）；全部写点落在隔离临时根。 */
function harness(prefix) {
  const root = tempRoot(prefix);
  const store = createStore(root);
  let guardFn = null;
  const ctx = { tools: { register: () => {}, guard: (fn) => { guardFn = fn; } }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const sess = (id) => ({ agent: { session: { id, header: {} } } });
  return {
    store, by, sess,
    /** 真 guard（`installDifficultyGuard` 注册的同一函数体）：返回 string = 拒因；undefined = 放行。 */
    guardWrite: (id) => guardFn({ name: 'write', arguments: {}, agent: { session: { id, header: {} } } }),
    mkBatch: (id, batchId, phase = 'running') => store.createBatch(id, {
      batchId, phase, wavePlan: { wavePlan: [{ wave: 1, tasks: [{ id: 'l1' }] }], team: null },
    }),
    tierCall: (id, action, batchId) => {
      try {
        assertMemberActionTierC(store, id, sess(id), action, { batchId }, null);
        return { action, verdict: 'allow', code: null };
      } catch (e) {
        return { action, verdict: 'deny', code: String(e?.message ?? e).split(':')[0] };
      }
    },
    declareC: (id, extra = {}) => by.assign_check.execute({ difficulty: 'C', rationale: RATIONALE_C, parallel: true, scope: 'full', ...extra }, sess(id)),
    declareB: (id, extra = {}) => by.assign_check.execute({ difficulty: 'B', rationale: RATIONALE_B, needIsolation: true, scope: 'full', ...extra }, sess(id)),
    declareA: (id, extra = {}) => by.assign_check.execute({ difficulty: 'A', rationale: RATIONALE_A, scope: 'full', ...extra }, sess(id)),
    declareD: (id, extra = {}) => by.assign_check.execute({ difficulty: 'D', rationale: RATIONALE_D, parallel: true, scope: 'full', ...extra }, sess(id)),
  };
}

test('L-AC-1/L-AC-3 活跃批期间同会话降档 ⇒ lastAssign.difficulty 保留 + history 恰 +1 且带「声明档 vs 生效档」留痕', async () => {
  const h = harness('punky-tierdg-a-');
  const S = 'sess-tierdg-a';
  h.mkBatch(S, 'b-a');
  await h.declareC(S);
  assert.equal(h.store.readGovernance(S).lastAssign.difficulty, 'C', '建批后声明 C 照旧写入（非降档）');
  const before = h.store.readGovernance(S).history.length;

  const outB = await h.declareB(S);
  const gB = h.store.readGovernance(S);
  assert.equal(gB.lastAssign.difficulty, 'C', 'L-AC-1：C→B 降档不得覆盖（既有档位保留）');
  assert.equal(gB.lastAssign.form, 'C', 'L-AC-1：legacy 字段 form 与档位面一并保留');
  assert.equal(gB.lastAssign.rationale, RATIONALE_C, 'L-AC-1：旧档判据面逐字保留');
  assert.equal(gB.history.length, before + 1, 'L-AC-3：被保护的调用仍恰记 1 条 history');
  const lastB = gB.history[gB.history.length - 1];
  assert.equal(lastB.turn, before + 1, 'L-AC-3：turn 严格单调 +1');
  assert.equal(lastB.declaredDifficulty, 'B', 'L-AC-3：留痕回显本次声明档位');
  assert.equal(lastB.effectiveDifficulty, 'C', 'L-AC-3：留痕回显实际生效档位');
  assert.equal(lastB.downgradeBlocked, 'GATE_DIFFICULTY_DOWNGRADE_BLOCKED', 'L-AC-3：留痕带可检索码');
  assert.match(String(outB.notice ?? ''), /GATE_DIFFICULTY_DOWNGRADE_BLOCKED/, '回显码');
  assert.match(String(outB.notice ?? ''), /本次声明 B/, '回显本次档位');
  assert.match(String(outB.notice ?? ''), /既有档位 C/, '回显既有档位');
  assert.equal(gB.pendingBatch, false, '收敛走既有 :103 原文（hasActive 真 ⇒ 清锁）');
  assert.equal(gB.pendingSince, null);

  // 二级降档（C→A）同样被保护，且 history 继续 +1
  await h.declareA(S);
  const gA = h.store.readGovernance(S);
  assert.equal(gA.lastAssign.difficulty, 'C', 'L-AC-1：C→A 同样不得覆盖');
  assert.equal(gA.history.length, before + 2, 'L-AC-3：每次调用各 +1 条');
  assert.equal(gA.history[gA.history.length - 1].effectiveDifficulty, 'C');
});

test('L-AC-4（阴性）活跃批期间声明 C/D ⇒ pendingBatch=false 且真 guard 对执行型 write 放行', async () => {
  const h = harness('punky-tierdg-b-');
  const S = 'sess-tierdg-b';
  h.mkBatch(S, 'b-b');

  await h.declareC(S);
  assert.equal(h.store.readGovernance(S).pendingBatch, false, 'L-AC-4：活跃批 + 声明 C ⇒ pendingBatch 恒 false');
  assert.equal(h.guardWrite(S), undefined, 'L-AC-4：门禁 2 不得拦（P-4 死锁面）');

  await h.declareD(S);
  const gD = h.store.readGovernance(S);
  assert.equal(gD.pendingBatch, false, 'L-AC-4：活跃批 + 声明 D ⇒ pendingBatch 恒 false');
  assert.equal(gD.pendingSince, null);
  assert.equal(h.guardWrite(S), undefined, 'L-AC-4：D 档同样放行');
  assert.equal(gD.lastAssign.difficulty, 'D', '升档照旧生效（保护只针对降档）');
});

test('L-AC-5（阴性）无活跃批降档逐字不变：放行 + 残留 pendingBatch/pendingSince 清锁', async () => {
  const h = harness('punky-tierdg-c-');
  const S = 'sess-tierdg-c';

  await h.declareC(S);
  const gLock = h.store.readGovernance(S);
  assert.equal(gLock.pendingBatch, true, '无活跃批 + C ⇒ 照旧挂锁');
  assert.ok(gLock.pendingSince, 'pendingSince 照旧落值');

  await h.declareB(S);
  const gFree = h.store.readGovernance(S);
  assert.equal(gFree.lastAssign.difficulty, 'B', 'L-AC-5：无活跃批降档**必须**放行（情形 C 不得保护）');
  assert.equal(gFree.pendingBatch, false, 'L-AC-5：残留锁照旧清');
  assert.equal(gFree.pendingSince, null);
  assert.equal(gFree.history[gFree.history.length - 1].downgradeBlocked, undefined, '非保护路径不得带留痕字段');

  // 无活跃批 + C 后重评 A：同样放行（首评无既有档位若为 A 亦然）
  await h.declareC(S);
  await h.declareA(S);
  const gA = h.store.readGovernance(S);
  assert.equal(gA.lastAssign.difficulty, 'A', 'L-AC-5：无活跃批 A/B 照旧覆盖');
  assert.equal(gA.pendingBatch, false);
});

test('L-AC-6 保护命中后成员面能力保留：batch/member 两 action 均放行（现状为双拒）', async () => {
  const h = harness('punky-tierdg-d-');
  const S = 'sess-tierdg-d';
  h.mkBatch(S, 'b-d');
  await h.declareC(S);
  assert.deepEqual(
    [h.tierCall(S, 'batch', 'b-d').verdict, h.tierCall(S, 'member', 'b-d').verdict],
    ['allow', 'allow'],
    '降档前：C 档成员面能力在位',
  );

  await h.declareB(S);
  assert.equal(h.store.readGovernance(S).lastAssign.difficulty, 'C', '降档仍被拒');
  assert.deepEqual(
    [h.tierCall(S, 'batch', 'b-d').verdict, h.tierCall(S, 'member', 'b-d').verdict],
    ['allow', 'allow'],
    'L-AC-6：保护生效后 batch/member 两 action 均放行（放行数 2/2）',
  );
});

test('L-AC-1 边界：活跃批 + 首评（无既有档位）不被保护；同档/升档照旧覆盖', async () => {
  const h1 = harness('punky-tierdg-e1-');
  const S1 = 'sess-tierdg-e1';
  h1.mkBatch(S1, 'b-e1');
  await h1.declareA(S1);
  assert.equal(h1.store.readGovernance(S1).lastAssign.difficulty, 'A', '既有档位缺失 ⇒ tierRank=0 ⇒ 首评永不被保护');
  assert.equal(h1.store.readGovernance(S1).history[0].downgradeBlocked, undefined);

  const h2 = harness('punky-tierdg-e2-');
  const S2 = 'sess-tierdg-e2';
  h2.mkBatch(S2, 'b-e2');
  await h2.declareB(S2);
  await h2.declareC(S2);
  assert.equal(h2.store.readGovernance(S2).lastAssign.difficulty, 'C', '升档（B→C）照旧覆盖');
  await h2.declareC(S2, { rationale: '测试：同档再评 C —— 同档非降档，照旧覆盖并刷新时间窗' });
  const g2 = h2.store.readGovernance(S2);
  assert.equal(g2.lastAssign.difficulty, 'C', '同档照旧覆盖');
  assert.equal(g2.lastAssign.rationale, '测试：同档再评 C —— 同档非降档，照旧覆盖并刷新时间窗', '同档路径的判据面照旧覆盖');
  assert.equal(g2.history.length, 3, '每次调用各 +1 条 history');
  assert.equal(g2.history[2].downgradeBlocked, undefined, '非保护路径不得带留痕字段');
  assert.equal(h2.guardWrite(S2), undefined, 'guard 放行');
});

test('L-AC-2（静态判据）+ L-AC-8：保护判定式不引用 pendingBatch/pendingSince；rank 映射全 lib 恰 1 处', () => {
  const src = fs.readFileSync(ASSIGN_SRC, 'utf8');
  const judge = src.split('\n').filter((l) => /const downgradeBlocked\s*=/.test(l));
  assert.equal(judge.length, 1, '保护判定式恰 1 处（单点，可静态核）');
  assert.doesNotMatch(judge[0], /pendingBatch|pendingSince/,
    'L-AC-2：判定式标识符集合 ∩ {pendingBatch, pendingSince} 必须为 ∅（P-4 死锁面）');
  assert.match(judge[0], /hasActive\b/, 'L-AC-2：保护条件第一项 = 既有单点 hasActive');
  assert.match(judge[0], /tierRank\(difficulty\)\s*<\s*tierRank\(/, 'L-AC-2/S-1：唯一合法形态 = 本次 rank < 既有 rank');

  // L-AC-8：rank 映射形态（`'D' ? 4 : …`）在 lib/** 内**恰好 1 处**（模块级单点导出）
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && /\.(js|ts)$/.test(e.name) ? [p] : [];
  });
  const hits = walk(path.join(PKG_ROOT, 'lib'))
    .filter((f) => /'D'\s*\?\s*4/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(PKG_ROOT, f).replace(/\\/g, '/'));
  assert.deepEqual(hits, ['lib/tools/assign-tools.js'], 'L-AC-8：rank 映射定义恰好 1 处（重复实现数 = 0）');
});
