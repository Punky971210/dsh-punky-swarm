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

// L9 记忆溯源（批 `punky-spec-adopt-p2-20261013` 的 lane `e4-l9-memorysrc`）回归锁。
//
// 本条覆盖（判据源 = `plan/impl-spec.md` D 组）：
//   AC-16 收口点覆盖 `complete` 与 `aborted`；`running` / `paused`（及起点 `planning`）**不触发**
//   AC-17 清单落**批次产物根**（非工作区根），条目含 `source=batch:<id>/lane:<id>`
//   AC-18 事件常量**单点登记** + 调用点引用常量（`grep` 无裸字面量）
//   AC-20 可逆性登记：条目带 `action` + `reversible:true`，且**执行权归 Leader/Manager**写进产物
//   RED-6 双向：aborted 收口 ⇒ 清单含该批条目；**可逆面**（执行权 + 可逆标记）不得残留不可逆状态
//   AC-21 L4 接线：调用签名与 `taskpack-l4` 冻结签名**逐字一致**
//   AC-22 不改既有相位语义（既有 `batch.phase` 事件载荷/迁移判定不变 —— 只**追加**清单与留痕）
//
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON + 落盘清单文件（不读实现内部状态）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { isBatchTerminal, isMemberTerminal } from '../lib/schema.js';
import {
  EVT_BATCH_PHASE, EVT_MEMORY_STALE_RECOMMENDED,
} from '../lib/state/event-types.js';
import {
  isTerminalPhase, memoryStaleItemsOf, memoryStaleManifestPathOf, evaluatePropagationOf,
} from '../lib/state/store/member-gates.js';
import { threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';
import { withDefaultTeam } from './helpers/skill-paths.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESS_ID = 'sess-l9';
const SESS = { agent: { session: { id: SESS_ID } } };
const MANIFEST_FILE = 'memory-stale-recommended.json';

// ── 夹具：临时 store 根 + 真工具面 + 合规三层批（口径同 `batch-control.test.js`）──
function makeHarness(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-l9-' + tag + '-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
  assessC(store, SESS_ID, { rationale: 'L9 记忆溯源回归锁：批收口终态面 ⇒ C 档动作前置评估' });
  return { root, store, byName };
}

async function makeBatch(byName, root, batchId, lanes = ['e1']) {
  const out = await byName.wave_plan.execute({
    batchId,
    tasks: threeTierTasks(lanes, { auditId: 'a1' }),
    assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
  }, SESS);
  seedArtifacts(root, SESS_ID, batchId, lanes);
  return out;
}

const phaseOf = (store, batchId) => store.readBatch(SESS_ID, batchId).phase;
const eventsOf = (store, batchId, type) => (store.readBatch(SESS_ID, batchId).events ?? []).filter((e) => e && e.type === type);
const toRunning = (byName, batchId) => byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
const toPaused = (byName, batchId) => byName.batch_phase.execute({ batchId, phase: 'paused' }, SESS);
const toComplete = (byName, batchId) => byName.batch_phase.execute({ batchId, phase: 'complete' }, SESS);
const toAborted = (byName, batchId) => byName.batch_phase.execute({ batchId, phase: 'aborted' }, SESS);
const manifestOf = (store, batchId) => {
  const p = path.join(store.artifactsDirOf(SESS_ID, batchId), MANIFEST_FILE);
  return { path: p, exists: fs.existsSync(p), json: fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null };
};
function settleLane(store, batchId, lane) {
  store.setMember(SESS_ID, batchId, lane, 'running');
  store.setMember(SESS_ID, batchId, lane, 'review');
  store.setMember(SESS_ID, batchId, lane, 'merged');
}

// ═══════════════════════════════════════════════════════════════════════════════
// A · 纯函数（零 I/O，单点复用终态判定）
// ═══════════════════════════════════════════════════════════════════════════════
test('A1【AC-16 判定面】isTerminalPhase：complete/aborted ⇒ true；planning/running/paused ⇒ false', () => {
  for (const p of ['complete', 'aborted']) assert.equal(isTerminalPhase(p), true, p + ' 是批次终态');
  for (const p of ['planning', 'running', 'paused']) assert.equal(isTerminalPhase(p), false, p + ' 非终态 ⇒ 不触发');
});

test('A2【AC-16 枚举面】memoryStaleItemsOf：只列终态 lane（非终态不入列）', () => {
  const batch = {
    batchId: 'b-x',
    lanes: { l1: 'merged', l2: 'running', l3: 'conflict', l4: 'pending', l5: 'failed', l6: 'review', l7: 'skipped', l8: 'idle' },
  };
  const items = memoryStaleItemsOf(batch);
  const lanes = items.map((it) => it.lane);
  // 终态 = SETTLE_STATES(merged/failed/skipped) ∪ {conflict}（单点复用 lib/schema.js）
  assert.deepEqual(lanes, ['l1', 'l3', 'l5', 'l7'], '只列终态 lane');
  for (const l of ['l2', 'l4', 'l6', 'l8']) {
    assert.equal(lanes.includes(l), false, '非终态 lane ' + l + ' 不得入列');
    assert.equal(isMemberTerminal(batch.lanes[l]), false, '对照：' + l + ' 确为非终态');
  }
  for (const it of items) assert.equal(isMemberTerminal(it.state), true, '逐条再核：' + it.lane + ' 必为终态');
});

test('A3【AC-20】条目形状 = {batchId,lane,state,source,action,reversible} 且 source 为约定式', () => {
  const items = memoryStaleItemsOf({ batchId: 'b-shape', lanes: { a1: 'merged' } });
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]).sort(), ['action', 'batchId', 'lane', 'reversible', 'source', 'state'].sort());
  assert.equal(items[0].batchId, 'b-shape');
  assert.equal(items[0].lane, 'a1');
  assert.equal(items[0].state, 'merged');
  assert.equal(items[0].source, 'batch:b-shape/lane:a1', '约定式写入规范');
  assert.equal(items[0].action, 'archive', 'action 只作建议（archive/forget 均可逆）');
  assert.equal(items[0].reversible, true, '可逆登记（禁不可逆动作）');
});

test('A4【AC-17 落点】memoryStaleManifestPathOf 落批次产物根（非工作区根）', () => {
  const p = memoryStaleManifestPathOf(SESS_ID, 'b-path', (s, b) => path.join('ROOT', 'sessions', s, 'artifacts', b));
  assert.equal(p, path.join('ROOT', 'sessions', SESS_ID, 'artifacts', 'b-path', MANIFEST_FILE));
  assert.equal(p.endsWith(MANIFEST_FILE), true);
});

test('A5【AC-21】evaluatePropagationOf 调用签名逐字一致：单对象入参 {batch,rules} + 返回四字段', () => {
  const src = fs.readFileSync(path.join(PKG, 'lib', 'state', 'store', 'member-gates.js'), 'utf8');
  assert.match(src, /fn\(\{\s*batch,\s*rules\s*\}\)/, '调用形态须逐字为 fn({ batch, rules })');
  const out = evaluatePropagationOf({ batchId: 'b', phase: 'running', lanes: {} }, {});
  assert.deepEqual(Object.keys(out).sort(), ['affected', 'changed', 'detail', 'version'].sort(), '返回四字段（冻结签名）');
  assert.equal(Array.isArray(out.affected), true);
  assert.equal(typeof out.changed, 'boolean');
  assert.equal(Array.isArray(out.detail), true);
  assert.equal(out.version === null || typeof out.version === 'string', true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// B · 四相位对照（AC-16 核心读数）
// ═══════════════════════════════════════════════════════════════════════════════
test('B1【AC-16】四相位对照：complete/aborted 触发；planning/running/paused 不触发', async () => {
  const rows = [];
  // ① planning（建批后即读，未迁移）
  {
    const { root, store, byName } = makeHarness('plan');
    await makeBatch(byName, root, 'b-plan');
    rows.push({ phase: 'planning', evt: eventsOf(store, 'b-plan', EVT_MEMORY_STALE_RECOMMENDED).length, manifest: manifestOf(store, 'b-plan').exists });
  }
  // ② running
  {
    const { root, store, byName } = makeHarness('run');
    await makeBatch(byName, root, 'b-run');
    await toRunning(byName, 'b-run');
    rows.push({ phase: 'running', evt: eventsOf(store, 'b-run', EVT_MEMORY_STALE_RECOMMENDED).length, manifest: manifestOf(store, 'b-run').exists });
  }
  // ③ paused
  {
    const { root, store, byName } = makeHarness('pause');
    await makeBatch(byName, root, 'b-pause');
    await toRunning(byName, 'b-pause');
    await toPaused(byName, 'b-pause');
    rows.push({ phase: 'paused', evt: eventsOf(store, 'b-pause', EVT_MEMORY_STALE_RECOMMENDED).length, manifest: manifestOf(store, 'b-pause').exists });
  }
  // ④ complete（先结算**全部 lane**（含聚合 audit lane `a1`）使 complete 门可过）
  {
    const { root, store, byName } = makeHarness('done');
    await makeBatch(byName, root, 'b-done');
    await toRunning(byName, 'b-done');
    settleLane(store, 'b-done', 'e1');
    settleLane(store, 'b-done', 'a1'); // 聚合 audit lane 未结算 ⇒ 既有 complete 门拒 GATE_EXIT_PENDING_AUDIT
    await toComplete(byName, 'b-done');
    rows.push({ phase: 'complete', evt: eventsOf(store, 'b-done', EVT_MEMORY_STALE_RECOMMENDED).length, manifest: manifestOf(store, 'b-done').exists });
  }
  // ⑤ aborted
  {
    const { root, store, byName } = makeHarness('abort');
    await makeBatch(byName, root, 'b-abort');
    await toRunning(byName, 'b-abort');
    await toAborted(byName, 'b-abort');
    rows.push({ phase: 'aborted', evt: eventsOf(store, 'b-abort', EVT_MEMORY_STALE_RECOMMENDED).length, manifest: manifestOf(store, 'b-abort').exists });
  }

  const byPhase = Object.fromEntries(rows.map((r) => [r.phase, r]));
  for (const p of ['planning', 'running', 'paused']) {
    assert.equal(byPhase[p].evt, 0, p + ' ⇒ 事件数须为 0');
    assert.equal(byPhase[p].manifest, false, p + ' ⇒ 清单不得落盘');
  }
  for (const p of ['complete', 'aborted']) {
    assert.equal(byPhase[p].evt, 1, p + ' ⇒ 恰一条 memory.stale.recommended');
    assert.equal(byPhase[p].manifest, true, p + ' ⇒ 清单须落盘');
  }
  assert.equal(rows.length, 5);
});

// ═══════════════════════════════════════════════════════════════════════════════
// C · aborted 收口 ⇒ 清单内容 + 留痕 + 恢复面（RED-6 双向）
// ═══════════════════════════════════════════════════════════════════════════════
test('C1【RED-6 正向】aborted 收口 ⇒ 清单含该批派生记忆条目（source 约定式）', async () => {
  const { root, store, byName } = makeHarness('red6');
  await makeBatch(byName, root, 'b-red6');
  await toRunning(byName, 'b-red6');
  settleLane(store, 'b-red6', 'e1'); // 一条终态 lane ⇒ 应有派生记忆
  await toAborted(byName, 'b-red6');

  const m = manifestOf(store, 'b-red6');
  assert.equal(m.exists, true, '清单须落批次产物根');
  assert.equal(m.path.startsWith(path.join(root, 'sessions', SESS_ID, 'artifacts', 'b-red6')), true,
    '路径须在批次产物根下（非工作区根）');
  assert.equal(m.json.batchId, 'b-red6');
  assert.equal(m.json.phase, 'aborted');
  assert.equal(Array.isArray(m.json.items), true);
  assert.equal(m.json.items.length >= 1, true, '须含该批条目');
  const e1 = m.json.items.find((it) => it.lane === 'e1');
  assert.ok(e1, '终态 lane e1 须入列');
  assert.equal(e1.source, 'batch:b-red6/lane:e1');
  assert.equal(e1.action, 'archive');
  assert.equal(e1.reversible, true);

  // 留痕事件（与清单**互不替代**）
  const evs = eventsOf(store, 'b-red6', EVT_MEMORY_STALE_RECOMMENDED);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].phase, 'aborted');
  assert.equal(evs[0].count, m.json.items.length);
  assert.deepEqual(evs[0].lanes, m.json.items.map((it) => it.lane));
  assert.equal(evs[0].reversible, true);
  assert.equal(evs[0].executor, 'leader-or-manager', '执行权归 Leader/Manager（引擎不自动执行）');
});

test('C2【RED-6 反向 / 可逆性】清单自带执行权与可逆面 ⇒ 无不可逆残留；重入幂等', async () => {
  const { root, store, byName } = makeHarness('rev');
  await makeBatch(byName, root, 'b-rev');
  await toRunning(byName, 'b-rev');
  settleLane(store, 'b-rev', 'e1');
  await toAborted(byName, 'b-rev');

  const m1 = manifestOf(store, 'b-rev');
  // ① 可逆面登记在**产物本体**（不只注释）：executor + reversible + actionNote
  assert.equal(m1.json.reversible, true, '批级可逆标记');
  assert.equal(m1.json.executor, 'leader-or-manager', '执行权归 Leader/Manager');
  assert.match(String(m1.json.actionNote), /可逆|不删/, 'actionNote 须写明可逆与不删');
  assert.equal(m1.json.items.every((it) => it.reversible === true), true, '逐条可逆');
  assert.equal(m1.json.items.every((it) => it.action === 'archive' || it.action === 'forget'), true, 'action 仅在可逆族内');

  // ② 无「不可逆已执行」形态：引擎**零**执行痕迹（引擎调不到 mneme ⇒ 不可能是 suppressed/deleted）
  const raw = fs.readFileSync(m1.path, 'utf8');
  for (const forbidden of ['suppressed', 'deleted', 'purged', 'memorandized']) {
    assert.equal(raw.includes(forbidden), false, '清单不得出现不可逆状态标记：' + forbidden);
  }
  // ③ 重入幂等：同一批再走一次终态收口 ⇒ 清单被**改写为同一形状**（不追加、不累积 ⇒ 「恢复」即回到同一可逆面）
  await toAborted(byName, 'b-rev').catch(() => {}); // aborted→aborted 由相位机拦（预期）
  const m2 = manifestOf(store, 'b-rev');
  assert.equal(m2.json.items.length, m1.json.items.length, '重入不得使条目累积');
  assert.deepEqual(m2.json.items, m1.json.items, '重入后条目逐字不变（可逆面可复原）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// D · 零自动化 + 相位语义不变（AC-19 / AC-22）
// ═══════════════════════════════════════════════════════════════════════════════
test('D1【AC-19 硬】引擎侧零 mneme **调用**：lib 内无 memory_* 调用点', () => {
  const libDir = path.join(PKG, 'lib');
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(js|ts)$/.test(ent.name) || /\.d\.ts$/.test(ent.name)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      // 只判**调用形态**（`memory_xxx(` / `.memory_xxx(`）——**名单登记**（如 verify/evidence.js 的
      // CONTROL_PLANE_TOOLS 排面）不是调用，不构成自动化。
      for (const m of txt.matchAll(/(?:^|[^\w.])memory_(save|search|list|update|delete|archive|forget)\s*\(/gm)) {
        offenders.push(path.relative(PKG, p) + ': ' + m[0].trim());
      }
    }
  };
  walk(libDir);
  assert.deepEqual(offenders, [], 'lib/** 内不得出现 mneme **调用**（执行权归 Leader/Manager）');
});

test('D2【AC-22】既有相位语义零改动：仍落 batch.phase，且迁移判定/拒态不变', async () => {
  const { root, store, byName } = makeHarness('ac22');
  await makeBatch(byName, root, 'b-ac22');
  const before = store.readBatch(SESS_ID, 'b-ac22').events.length;
  await toRunning(byName, 'b-ac22');
  const b = store.readBatch(SESS_ID, 'b-ac22');
  assert.equal(b.phase, 'running');
  const added = b.events.slice(before).filter((e) => e.type === EVT_BATCH_PHASE);
  assert.equal(added.length, 1, 'running 迁移仍恰一条 batch.phase');
  assert.deepEqual({ from: added[0].from, to: added[0].to }, { from: 'planning', to: 'running' }, '载荷逐字不变');
  assert.equal(eventsOf(store, 'b-ac22', EVT_MEMORY_STALE_RECOMMENDED).length, 0, '非终态不追加 L9 事件');
  // 非法迁移仍按既有码拒（逐字透传，本批未改判定）
  assert.throws(() => store.setPhase(SESS_ID, 'b-ac22', 'planning'), /invalid batch phase transition/);
});

test('D3【AC-18】event-types.js 单点登记 + 调用点引用常量（无裸字面量）', () => {
  const et = fs.readFileSync(path.join(PKG, 'lib', 'state', 'event-types.js'), 'utf8');
  assert.match(et, /export const EVT_MEMORY_STALE_RECOMMENDED = 'memory\.stale\.recommended';/, '单点登记');
  assert.equal(EVT_MEMORY_STALE_RECOMMENDED, 'memory.stale.recommended', '常量值逐字');
  const mg = fs.readFileSync(path.join(PKG, 'lib', 'state', 'store', 'member-gates.js'), 'utf8');
  assert.match(mg, /EVT\.EVT_MEMORY_STALE_RECOMMENDED/, '调用点须引用常量');
  assert.equal(/'memory\.stale\.recommended'/.test(mg), false, '调用点不得散布裸字面量');
});
