// 门禁失败「打回成员」而非「停轮」（2026-09-26 用户裁决）——`onFail: 'report'` 态测试。
// 背景：兼底路 `swarm_report(settle-request)` 遇 gate 类失败时，应**不落 paused、不改相位**，
//   把拒因回传调用方 ⇒ 调用方（工具 execute）throw ⇒ **工具调用失败打回成员**，成员自行修改后重试。
// 对照：缺省 `onFail='pause'`（主路 `subagent/end`）逐字不变 —— 已由 test/auto-settle.test.js 的 E 段覆盖。
// 事实源纪律：断言一律读 `store.readBatch` 的批次 JSON（唯一事实源）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { threeTierTasks, seedArtifacts, assemblyCtxOpts, tempRoot } from './helpers/gate-fixture.mjs';
import { EVT_AUTO_SETTLE_PAUSED, EVT_AUTO_SETTLE_SKIPPED, EVT_BATCH_PHASE } from '../lib/state/event-types.js';
import {
  AUTO_SETTLE_ON_FAIL, AUTO_SETTLE_TRIGGERS, autoSettleLane,
} from '../lib/engine/auto-settle.js';

function seedBatch(root, sessionId, batchId, { lane = 'e1' } = {}) {
  const store = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: threeTierTasks([lane]) });
  store.createBatch(sessionId, { batchId, wavePlan: plan, phase: 'running' });
  seedArtifacts(root, sessionId, batchId, [lane]);
  store.setMember(sessionId, batchId, lane, 'running');
  return store;
}
const eventsOf = (store, S, B, type) => store.readBatch(S, B).events.filter((e) => e.type === type);

test('R2M-1: onFail=report + exec 产物缺失 ⇒ action=rejected / 批相位**不变**（不停轮）/ 无 auto.settle.paused', async () => {
  const root = tempRoot('punky-r2m-1-');
  const S = 'sess-r2m-1';
  const B = 'r2m1';
  const store = seedBatch(root, S, B, { lane: 'e1' });
  const ctx = assemblyCtxOpts();
  // 删掉 exec 声明产物 ⇒ 判定链在 review→merged 处拒（GATE_EXIT_MISSING_EXEC）
  fs.rmSync(path.join(root, 'sessions', S, 'artifacts', B, 'exec', 'e1.md'));

  const out = await autoSettleLane(
    { ctx, store, root },
    {
      sessionId: S, batchId: B, lane: 'e1', workerSessionId: 'ws-r2m-1',
      stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.settleRequest,
      onFail: AUTO_SETTLE_ON_FAIL.report,
    },
  );

  // ① 返回值：rejected（不是 paused）
  assert.equal(out.ok, false, '失败态 ok:false');
  assert.equal(out.action, 'rejected', 'onFail=report ⇒ action=rejected（打回），不是 paused');
  assert.ok(String(out.code).startsWith('GATE_'), 'code 为门禁码（调用方据此决定 throw）：' + out.code);
  assert.ok(String(out.reason).includes('GATE_EXIT_MISSING'), 'reason 含门禁码原文：' + out.reason);

  // ② 批相位**不变**（不停轮）
  const b = store.readBatch(S, B);
  assert.equal(b.phase, 'running', '★核心：report 态**不改相位**（批保持 running，不停轮）');
  assert.equal(b.lanes.e1, 'review', '成员停在 review（等成员自行修改后重试）');

  // ③ 无 auto.settle.paused（停轮事件不得出现）
  assert.equal(eventsOf(store, S, B, EVT_AUTO_SETTLE_PAUSED).length, 0, '★report 态不得落 auto.settle.paused');
  assert.equal(b.events.filter((e) => e.type === EVT_BATCH_PHASE).length, 0, '不得落相位迁移事件');

  // ④ 留痕：auto.settle.skipped 带 gate-rejected-to-member 前缀（可核、不静默）
  const sk = eventsOf(store, S, B, EVT_AUTO_SETTLE_SKIPPED);
  assert.ok(sk.length >= 1, '须落 auto.settle.skipped 留痕（不静默）');
  const rejected = sk.find((e) => String(e.reason).startsWith('gate-rejected-to-member:'));
  assert.ok(rejected, '留痕 reason 须带 gate-rejected-to-member: 前缀（与既有 skip 分支可区分）：' + JSON.stringify(sk.map((e) => e.reason)));
  assert.equal(rejected.callbackCode ?? rejected.code, out.code, '留痕 code 与返回值 code 同源');
});

test('R2M-2: 同一构造下 onFail 缺省（pause）⇒ 仍停轮（存量行为零变化，对照）', async () => {
  const root = tempRoot('punky-r2m-2-');
  const S = 'sess-r2m-2';
  const B = 'r2m2';
  const store = seedBatch(root, S, B, { lane: 'e1' });
  const ctx = assemblyCtxOpts();
  fs.rmSync(path.join(root, 'sessions', S, 'artifacts', B, 'exec', 'e1.md'));

  const out = await autoSettleLane(
    { ctx, store, root },
    {
      sessionId: S, batchId: B, lane: 'e1', workerSessionId: 'ws-r2m-2',
      stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.settleRequest,
      // 不传 onFail ⇒ 走缺省
    },
  );

  assert.equal(out.action, 'paused', '缺省 onFail ⇒ action=paused（存量语义）');
  const b = store.readBatch(S, B);
  assert.equal(b.phase, 'paused', '缺省路径仍停轮（本改动不触及主路）');
  assert.equal(eventsOf(store, S, B, EVT_AUTO_SETTLE_PAUSED).length, 1, '恰一条 auto.settle.paused');
});

test('R2M-3: onFail=report + 判据**全绿** ⇒ 正常 merged（report 态不干扰成功路径）', async () => {
  const root = tempRoot('punky-r2m-3-');
  const S = 'sess-r2m-3';
  const B = 'r2m3';
  const store = seedBatch(root, S, B, { lane: 'e1' });
  const ctx = assemblyCtxOpts();

  const out = await autoSettleLane(
    { ctx, store, root },
    {
      sessionId: S, batchId: B, lane: 'e1', workerSessionId: 'ws-r2m-3',
      stopReason: 'completed', trigger: AUTO_SETTLE_TRIGGERS.settleRequest,
      onFail: AUTO_SETTLE_ON_FAIL.report,
    },
  );

  assert.equal(out.action, 'merged', '全绿 ⇒ 正常 merged（report 只在失败分支生效）：' + JSON.stringify(out));
  assert.equal(store.readBatch(S, B).lanes.e1, 'merged', '成员态 merged');
  assert.equal(eventsOf(store, S, B, EVT_AUTO_SETTLE_PAUSED).length, 0, '成功路径零 paused');
});

test('R2M-4: 枚举面契约 —— AUTO_SETTLE_ON_FAIL 二态且 pause === DEFAULT_ON_FAIL（不另造第三套口径）', () => {
  assert.deepEqual(Object.keys(AUTO_SETTLE_ON_FAIL).sort(), ['pause', 'report'], '恰两态');
  assert.equal(AUTO_SETTLE_ON_FAIL.pause, 'pause');
  assert.equal(AUTO_SETTLE_ON_FAIL.report, 'report');
  assert.ok(Object.isFrozen(AUTO_SETTLE_ON_FAIL), '冻结（防热改）');
});
