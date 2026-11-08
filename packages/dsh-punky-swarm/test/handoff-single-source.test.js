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

// 交接面「单真源」判据（先红后绿）：
//   SS-1 视图与门禁同源：门禁判 `contract.consumedFrom` 指错，视图必须同步 BLOCKED（此前视图只看边集合 ⇒ 假绿）
//   SS-2 记录形态单点：建批写点与收件写点产出同一套键（收件多 source/acceptedBy 两个显式可选键）
//   SS-3 缺口事件载荷键集白名单：任何发射点的键集都不得越出白名单
//   SS-4 边序：视图边序 ≡ 声明序（deps 顺序，收件追加在末尾）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PSWARM_HANDOFF_GATE = '1';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam, threeTierSyntheticTeam } from './helpers/team-fixture.mjs';
import { clearRoleCache } from '../lib/assembly/flows.js';
import * as EVT from '../lib/state/event-types.js';

const SESSION = 'sess-single-source';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'single-source-team';

function tasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'build-it' },
    { id: 'e2', layer: 'exec', role: 'coder', consume: ['exec/e1.md'], outputs: ['exec/e2.md'], deps: ['e1'], cmd: 'build-more' },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/e1.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e1', 'e2'], cmd: 'verify-it' },
  ];
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ss-'));
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ss-teams-'));
  writeSyntheticTeam(teamsRoot, TEAM, threeTierSyntheticTeam(TEAM));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root, config: {} });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：交接面单真源判据前置评估（三层 DAG 多依赖 ⇒ C 档）' });
  clearRoleCache();
  return { root, teamsRoot, store, byName };
}

async function mkBatch(h, batchId) {
  await h.byName.wave_plan.execute({
    batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: tasks(),
    assembly: { auditLane: 'a1' },
  }, SESS);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
}

function seedArtifact(h, batchId, rel) {
  const abs = path.join(h.root, 'sessions', SESSION, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'out', 'utf8');
}

const eventsOf = (h, batchId) => (h.store.readBatch(SESSION, batchId)?.events ?? []);
const cleanup = (h) => {
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.rmSync(h.teamsRoot, { recursive: true, force: true });
};

test('SS-1 视图与门禁同源：`contract.consumedFrom` 指错边 ⇒ 门禁拒 且 view 必须 BLOCKED', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'ss1');
    seedArtifact(h, 'ss1', 'exec/e1.md');
    const sub = await h.byName.handoff_submit.execute(
      { batchId: 'ss1', from: 'p1', to: 'e1', artifacts: ['exec/e1.md'], assertions: ['e1 已按 spec 实现'] }, SESS,
    );
    assert.equal(sub.ok, true, '前提：正常提交成功 ' + JSON.stringify(sub));

    // 篡改 consumedFrom 指到不存在的上游（写守卫只比 to/from/status 签名 ⇒ 线下改不留痕，也不被守卫拦）
    const batchFile = path.join(h.root, 'sessions', SESSION, 'batches', 'ss1.json');
    const onDisk = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
    onDisk.handoffs.e1[0].contract.consumedFrom = 'not-p1';
    fs.writeFileSync(batchFile, JSON.stringify(onDisk), 'utf8');

    const gateErr = await h.byName.member_set_status.execute({ batchId: 'ss1', lane: 'e1', status: 'running' }, SESS)
      .then(() => null).catch((e) => e);
    assert.ok(gateErr, '门禁须拒（consumedFrom 指错 ⇒ 契约不成立）');
    assert.match(String(gateErr.message), /^GATE_HANDOFF_MISSING/, '门禁拒码：' + gateErr.message);
    assert.match(String(gateErr.message), /consumedFrom/, '门禁须点名 consumedFrom：' + gateErr.message);

    const v = await h.byName.handoff_view.execute({ batchId: 'ss1', lane: 'e1' }, SESS);
    assert.equal(v.ready, false, '同源判据：门禁拒则视图必须 BLOCKED（实际 blocking=' + JSON.stringify(v.blocking) + '）');
    assert.ok(
      (v.blocking ?? []).some((x) => String(x).includes('consumedFrom')),
      '视图须回显同一缺口（不只是回显字段值）：' + JSON.stringify(v.blocking),
    );
  } finally { cleanup(h); }
});

test('SS-2 交接记录形态单点：建批写点与收件写点同构（收件只多 source/acceptedBy）', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'ss2');
    const base = h.store.readBatch(SESSION, 'ss2').handoffs.e1[0];
    assert.deepEqual(Object.keys(base).sort(), [
      'artifacts', 'batch', 'contract', 'from', 'officialTaskId', 'status', 'step', 'to', 'ts',
    ], '建批期记录键集（单点形态）');
    assert.deepEqual(base.contract, { consumedFrom: 'p1', assertions: [] }, '基础契约形态');
    assert.equal(base.status, 'pending');

    const added = await h.byName.batch_tasks_add.execute({
      batchId: 'ss2', tasks: [{ id: 'a2', layer: 'audit', role: 'reviewer', produce: ['audit/a2.md'], cmd: 'post-hoc' }],
      reason: '后置 audit lane（收件通道的唯一适用面）',
    }, SESS);
    assert.deepEqual(added.added, ['a2'], '前提：后置 lane 追加成功');
    const acc = h.store.recordHandoffAccept(SESSION, 'ss2', { from: 'a2', to: 'a1', reason: 'audit 补边' });
    assert.equal(acc.ok, true, '收件写入成功');
    const rec = (h.store.readBatch(SESSION, 'ss2').handoffs.a1 ?? []).find((r) => r.from === 'a2');
    assert.ok(rec, '收件记录须落盘');
    assert.deepEqual(Object.keys(rec).sort(), [
      'acceptedBy', 'artifacts', 'batch', 'contract', 'from', 'officialTaskId', 'source', 'status', 'step', 'to', 'ts',
    ], '收件记录 = 基础形态 + source/acceptedBy 两个显式键（不得另起一套字段名）');
    assert.equal(rec.source, 'accept');
    assert.deepEqual(rec.acceptedBy, { lane: 'a1', ts: rec.ts }, 'acceptedBy 与 ts 同源');
    assert.deepEqual(rec.contract, { consumedFrom: 'a2', assertions: [] });
  } finally { cleanup(h); }
});

test('SS-3 缺口事件载荷键集白名单：任何发射点都不得越出 {lane,code,missing,problems,callerRole,legacy}', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'ss3');
    // 发射点 A：交接提交缺产物（handoff-tools）
    await assert.rejects(() => h.byName.handoff_submit.execute(
      { batchId: 'ss3', from: 'p1', to: 'e1', artifacts: ['exec/absent.md'], assertions: ['x'] }, SESS,
    ));
    // 发射点 B：入边门拒（store/member）
    await assert.rejects(() => h.byName.member_set_status.execute({ batchId: 'ss3', lane: 'e2', status: 'running' }, SESS));

    const gaps = eventsOf(h, 'ss3').filter((e) => e.type === EVT.EVT_LANE_HANDOFF_GAP);
    assert.ok(gaps.length >= 2, '两个发射点各落一条 gap 事件（实测 ' + gaps.length + '）');
    const WHITELIST = new Set(['lane', 'code', 'missing', 'problems', 'callerRole', 'legacy']);
    for (const g of gaps) {
      const extra = Object.keys(g).filter((k) => !WHITELIST.has(k) && k !== 'type' && k !== 'ts' && k !== 'at');
      assert.deepEqual(extra, [], 'gap 事件载荷越出白名单：' + JSON.stringify({ code: g.code, keys: Object.keys(g) }));
      assert.equal(typeof g.lane, 'string', 'lane 必带');
      assert.ok(Array.isArray(g.missing), 'missing 必带（可为空数组）');
      assert.ok(Array.isArray(g.problems), 'problems 必带');
    }
  } finally { cleanup(h); }
});

test('SS-4 视图边序 ≡ 声明序：deps 顺序保持，收件追加在末尾', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'ss4');
    await h.byName.batch_tasks_add.execute({
      batchId: 'ss4', tasks: [{ id: 'a2', layer: 'audit', role: 'reviewer', produce: ['audit/a2.md'], cmd: 'post-hoc' }],
      reason: '后置 lane',
    }, SESS);
    h.store.recordHandoffAccept(SESSION, 'ss4', { from: 'a2', to: 'a1', reason: '补后置边' });
    const v = await h.byName.handoff_view.execute({ batchId: 'ss4', lane: 'a1' }, SESS);
    assert.deepEqual(v.edges.map((e) => e.from), ['e1', 'e2', 'a2'], '边序 = deps 声明序 + 收件追加在后（不得排序/去重打乱）');
    assert.deepEqual(v.deps, ['e1', 'e2'], 'deps 原样回显');
  } finally { cleanup(h); }
});
