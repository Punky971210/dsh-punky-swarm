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

// test/dgate-reachable.test.js —— **D 档可达性**的可达用例（批 `punky-dgate-reachable-20261102` · lane `impl`）
//
// 背景：`dispatch.js` 的续用绑定曾写成 `laneBindingOf(...) instanceof Map` ⇒ **恒 null** ⇒ `pickChannelOf`
//   规则①「`bound && dUsable ⇒ agentTeam`」永不命中 ⇒ `pushViaAgentTeam` 在该路径**结构不可达**、
//   `PUSH_UNCONFIRMED` 短路是死码。
//   修法（spec §A）：改用按 lane 查的单点 `expectedWorkerSessionOf(store.readBatch(...), lane)`。
//
// 场景 β（**唯一能到 D 档**的场景 = 重派）：本 lane **已有**一条 `member.dispatch` ⇒ `bound` 非空
//   ⇒ 规则① 命中 ⇒ 走 `pushViaAgentTeam`。
//
// ⚠ 本文件为**新增**文件；**未修改** `test/ac16-push-unconfirmed.test.js`（红线 R-4）——
//   其 provider 侧断言与本文件的 dispatch 侧构造互不替代（后者要 store/batch/事件前置）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const tempRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

/** 批次前置（形态取自 `test/dispatch-form-pairing.test.js#seed`；**复制**而非引用，避免跨文件耦合）。 */
function seed(tag = 'punky-dgate-') {
  const root = tempRoot(tag);
  const store = createStore(root, { logger: SILENT });
  const sess = 'sess-dg';
  const batchId = 'b-dg';
  store.createBatch(sess, {
    batchId,
    wavePlan: buildWavePlan({
      batchId,
      tasks: [
        { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: 'l1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], produce: ['exec/x.md'], outputs: ['exec/x.md'], deps: ['p1'] },
        { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/x.md'], produce: ['audit/a1.md'], outputs: ['audit/a1.md'], deps: ['l1'] },
      ],
    }),
    assembly: { auditLane: 'a1' },
  });
  // 成员写面档位判据落在**调用方会话** ⇒ 必须先写 C 档治理记录
  store.writeGovernance(sess, {
    lastAssign: { form: 'C', difficulty: 'C', rationale: 'D 档可达性夹具（C 档派发前置）', at: new Date().toISOString() },
  });
  const dir = path.join(root, 'sessions', sess, 'artifacts', batchId);
  fs.mkdirSync(path.join(dir, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan', 'spec.md'), '# 规格夹具\n', 'utf8');
  return { root, store, sess, batchId, lane: 'l1', dir };
}

/** 预置一条 `member.dispatch` ⇒ 该 lane 的 `boundSessionId` 非空（场景 β 的前提）。 */
const seedDispatchEvent = (store, sess, batchId, lane, workerSessionId) =>
  store.appendEvent(sess, batchId, 'member.dispatch', { lane, workerSessionId });

const dispatchCountOf = (store, sess, batchId, lane) =>
  (store.readBatch(sess, batchId)?.events ?? [])
    .filter((e) => e && e.type === 'member.dispatch' && e.lane === lane).length;

/**
 * 双通道宿主 ctx：
 *   · `subagents.start`  ⇒ C 档可用（环 2 不早退）
 *   · `tools.execute`    ⇒ D 档可调（`spawn_teammate`），并**记录调用**作「确实走到 D 档」的证据
 *   · `agents.get`       ⇒ D 档 `dUsable`（`pickChannelOf` 规则① 需要）
 *   · `agentTeams.listMembers` ⇒ 名册反查面（返回空 ⇒ 「名不在名册」⇒ `PUSH_UNCONFIRMED`）
 */
function hostCtxOf({ rosterRows = () => [] } = {}) {
  const toolCalls = [];
  const ctx = {
    on: () => () => {},
    logger: SILENT,
    tools: {
      register() {},
      execute: async (req) => {
        toolCalls.push({ name: req?.name, args: req?.arguments });
        return { isError: false, content: [{ type: 'text', text: 'spawned' }] };
      },
    },
    subagents: { start: async () => ({ id: 'ws-c', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
    agents: { get: () => ({ followup() {} }) },
    agentTeams: { listMembers: () => rosterRows() },
  };
  return { ctx, toolCalls };
}

async function dispatchOnce({ root, store, sess, batchId, lane, rosterRows }) {
  const { ctx, toolCalls } = hostCtxOf({ rosterRows });
  const tools = createCoreTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process' } } });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  assert.ok(ld, '夹具前提：lane_dispatch 工具必须在位');
  let result = null;
  let error = null;
  try {
    result = await ld.execute({ batchId, lane, prompt: '要点：先读规格' }, { agent: { session: { id: sess } } });
  } catch (e) { error = e; }
  return { result, error, toolCalls, store, sess, batchId, lane };
}

// ── B-1 / B-2（②-2′ / ②-3′）：`PUSH_UNCONFIRMED` 时**不新增**绑定，lane 保持 running ──────────────
test('B-1/B-2 名册未命中 ⇒ PUSH_UNCONFIRMED：member.dispatch **不新增**、lane 保持 running', async () => {
  const s = seed();
  try {
    seedDispatchEvent(s.store, s.sess, s.batchId, s.lane, 'ws-prev'); // bound = 'ws-prev'
    const before = dispatchCountOf(s.store, s.sess, s.batchId, s.lane);
    assert.equal(before, 1, '前提：预置恰 1 条 member.dispatch');

    const r = await dispatchOnce({ ...s, rosterRows: () => [] }); // 名册反查未命中
    assert.equal(r.error, null, 'PUSH_UNCONFIRMED 是**结果态**，不得抛错；实际=' + String(r.error?.message ?? ''));

    // B-4：确实走到 D 档 —— 证据 = `spawn_teammate` 被调用（不是空断言）
    assert.ok(r.toolCalls.some((c) => c.name === 'spawn_teammate'),
      '证据：必须真的经工具面发起 spawn_teammate（否则没走到 D 档）；实际=' + JSON.stringify(r.toolCalls));

    const after = dispatchCountOf(s.store, s.sess, s.batchId, s.lane);
    assert.equal(after, before, 'B-1（②-2′）：不可确认 ⇒ **不新增** member.dispatch；实际 ' + before + '→' + after);
    assert.equal(s.store.readBatch(s.sess, s.batchId)?.lanes?.[s.lane], 'running',
      'B-2（②-3′）：lane 必须保持 running（不可确认 ≠ 失败）');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

// ── B-3（②-4′）：名册**命中** ⇒ 写绑定，新增**恰 1 条** ─────────────────────────────────────
//   说明（**偏离及理由，如实登记**）：spec 的 ②-4′ 原写「同一 lane 首次未命中、二次命中」，但同一 lane
//   在第一次派发后已被置 `running`，第二次 `lane_dispatch` 会撞状态机 `invalid member transition:
//   running -> running` ⇒ **同一夹具内做不到**（实测）。
//   ⇒ 拆成两条**等价判据**：
//     · 「未命中那次不变」= B-1/B-2 用例（`→ 不新增`，实跑已绿）；
//     · 「命中那次 +1」= 本用例（全新夹具 + 预置绑定 + 名册命中）。
//   ②-4′ 的两半各自都有可达构造，合起来等价于原命题。
test('B-3 名册命中 ⇒ member.dispatch **新增恰 1 条**（预置那条仍在，总量 2）', async () => {
  const s = seed('punky-dgate-hit-');
  try {
    seedDispatchEvent(s.store, s.sess, s.batchId, s.lane, 'ws-prev');
    const before = dispatchCountOf(s.store, s.sess, s.batchId, s.lane);
    assert.equal(before, 1, '前提：预置恰 1 条 member.dispatch（bound 非空 ⇒ 规则① 命中）');

    // 名册**命中** ⇒ `pushViaAgentTeam` 返回 sessionId ⇒ 引擎写绑定（+1）
    const r = await dispatchOnce({ ...s, rosterRows: () => [{ name: s.lane, id: 'ws-new' }] });
    assert.equal(r.error, null, '命中时不得抛错；实际=' + String(r.error?.message ?? ''));
    assert.ok(r.toolCalls.some((c) => c.name === 'spawn_teammate'), '必须仍走 D 档（证据：spawn_teammate 被调用）');

    const after = dispatchCountOf(s.store, s.sess, s.batchId, s.lane);
    assert.equal(after, before + 1, 'B-3（②-4′）：命中后**新增恰 1 条**；实际 ' + before + '→' + after);
    assert.equal(after, 2, '总量 = 预置 1 + 新增 1 = 2（②-4′ 的「恰 1 条」指新增）');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

// ── C-3（N-4）：「C 档不回退」—— 无历史绑定 ⇒ 仍走 subagent ─────────────────────────────────
test('C-3 无历史绑定（首次派发）⇒ 仍走 C 档 subagent，不经工具面', async () => {
  const s = seed('punky-dgate-first-');
  try {
    const before = dispatchCountOf(s.store, s.sess, s.batchId, s.lane);
    assert.equal(before, 0, '前提：首次派发达前零 member.dispatch');
    const r = await dispatchOnce({ ...s, rosterRows: () => [] });
    assert.equal(r.error, null, '首次派发不得抛错；实际=' + String(r.error?.message ?? ''));
    assert.equal(r.toolCalls.some((c) => c.name === 'spawn_teammate'), false,
      '首次派发（无 bound）⇒ 规则② 走 subagent，**不得**经工具面（C 不回退）；实际=' + JSON.stringify(r.toolCalls));
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});
