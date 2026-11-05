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

// lane-heartbeat 单测（watch 域）——覆盖验收标准 W1-W7
// 零侵入（W7）：不新增成员状态、不碰核心语义；本文件只增不减既有测试基线
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import { buildSchedule } from '../lib/watch/lane-heartbeat.js'; // B1：createHeartbeatTools 已随工具删除
import { buildWavePlan } from '../lib/wave-plan.js';
import * as schema from '../lib/schema.js';
import { laneHeartbeat } from './helpers/watch-fixture.mjs';

// 测试夹具：一个 running 批次 + running lane（generic 任务带声明产物，三层契约校验不介入）
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-hb-'));
  const store = createStore(root);
  const S = 'sess-hb';
  const plan = buildWavePlan({
    batchId: 'b-hb',
    tasks: [{ id: 'l1', outputs: ['exec/l1/out.txt'], cmd: 'work' }],
  });
  store.createBatch(S, { batchId: 'b-hb', wavePlan: plan, phase: 'running' });
  store.setMember(S, 'b-hb', 'l1', 'running');
  return { root, store, S, batchId: 'b-hb', lane: 'l1' };
}

// 0ms 档位（每拍即追问）+ 硬停 3 拍：让 W1/W2 流程确定可测
const FAST = { capabilities: { watch: { enabled: true, intervalsMinutes: [0, 0, 0], maxMissed: 3 } } };
const LANE_KEY = 'sess-hb/b-hb/l1';
const inboxItems = (root, S, batchId) => mailbox.readUnacked(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'inbox' });
const outboxRoot = (root, S, batchId, lane) => path.join(root, 'sessions', S, 'mailbox', batchId, lane, 'outbox');

// ---- W4（部分）：退避档位纯函数 ----
test('buildSchedule：分钟 → ms，档位单调化钳制，缺省 [10,20,30]', () => {
  assert.deepEqual(buildSchedule(), [600_000, 1_200_000, 1_800_000]);
  assert.deepEqual(buildSchedule([10, 20, 30]), [600_000, 1_200_000, 1_800_000]);
  assert.deepEqual(buildSchedule([5, 15]), [300_000, 900_000]); // 配置可覆写（W4）
  assert.deepEqual(buildSchedule([30, 10, 20]), [1_800_000, 1_800_000, 1_800_000]); // 单调化钳制
  assert.deepEqual(buildSchedule([0, 0, 0]), [0, 0, 0]);
});

// ---- W1/W2：running lane 无产出 → 追问 → N 拍 stalled，此后停止追问，同 lane 至多 1 条 pending ----
test('W1/W2：无活动 → 轻量追问（≤5 句含 lane）→ 3 拍 → lane.stalled，停止追问且不叠加', () => {
  const { root, store, S, batchId, lane } = setup();
  const engine = laneHeartbeat(store, root, FAST);

  // 第 1 拍：发追问（W1）
  engine.tick();
  let st = engine.status(LANE_KEY);
  assert.equal(st.missed, 1);
  assert.equal(st.stalled, false);
  let items = inboxItems(root, S, batchId);
  // G1 身份集合（期望值来自输入侧：setup() 只播种 lane 'l1'）+「同 lane 至多 1 条」双条件
  assert.deepEqual(items.map((i) => i.message.lane), [lane],
    'W1: inbox 追问的 lane 身份集合（实测 ' + JSON.stringify(items.map((i) => i.message.lane)) + '）');
  assert.ok(items.filter((i) => i.message.lane === lane).length <= 1,
    'W1: 同 lane 至多 1 条 pending（实测 ' + items.length + '）');
  assert.equal(items[0].message.kind, 'probe');
  assert.equal(items[0].message.lane, lane, '追问含 lane 标识');
  assert.ok(items[0].message.text.includes(lane), '追问模板含 lane');
  assert.ok(items[0].message.text.includes(batchId), '追问模板含 batchId');
  assert.ok(items[0].message.text.split('\n').length <= 5, '追问模板 ≤5 句');

  // 第 2 拍：pending 追问存在 → 不叠加（W1），拍数推进
  engine.tick();
  st = engine.status(LANE_KEY);
  assert.equal(st.missed, 2);
  {
    const inbox2 = inboxItems(root, S, batchId);
    assert.deepEqual(inbox2.map((i) => i.message.lane), [lane],
      'W1: pending 追问 lane 身份集合（实测 ' + JSON.stringify(inbox2.map((i) => i.message.lane)) + '）');
    assert.ok(inbox2.filter((i) => i.message.lane === lane).length <= 1,
      'W1: 重复 tick 不叠加（同 lane ≤1 条；实测 ' + inbox2.length + '）');
  }

  // 第 3 拍：硬停 → lane.stalled（W2）
  engine.tick();
  st = engine.status(LANE_KEY);
  assert.equal(st.missed, 3);
  assert.equal(st.stalled, true);
  const b = store.readBatch(S, batchId);
  const stalledEv = b.events.find((e) => e.type === 'lane.stalled');
  assert.ok(stalledEv, 'W2: batch.events 出现 lane.stalled');
  assert.equal(stalledEv.lane, lane);
  assert.equal(stalledEv.missed, 3);

  // 此后停止追问（W2）：已 stalled 不追加、不再发新消息
  engine.tick();
  engine.tick();
  {
    const inboxAfter = inboxItems(root, S, batchId);
    assert.deepEqual(inboxAfter.map((i) => i.message.lane), [lane],
      'W2: 停止追问后 inbox lane 身份集合不变（实测 ' + JSON.stringify(inboxAfter.map((i) => i.message.lane)) + '）');
    assert.ok(inboxAfter.filter((i) => i.message.lane === lane).length <= 1,
      'W2: 不叠加（同 lane ≤1 条；实测 ' + inboxAfter.length + '）');
  }
  // 【U-7】拆「存在性 + 上界」两条
  assert.ok(store.readBatch(S, batchId).events.filter((e) => e.type === 'lane.stalled').length >= 1,
    'lane.stalled 至少 1 条（存在性）');
  assert.ok(store.readBatch(S, batchId).events.filter((e) => e.type === 'lane.stalled').length <= 1,
    'lane.stalled 不得重复（上界 1）');
});

// ---- W3：活动信号重置——产物 mtime / outbox / events 任一更新 → missed 归零、档位回 tier0 ----
test('W3：产物 mtime 更新 → missedCount 归零、档位回 tier0，活动拍不触发追问', async () => {
  const { root, store, S, batchId, lane } = setup();
  const engine = laneHeartbeat(store, root, FAST);
  engine.tick();
  assert.equal(engine.status(LANE_KEY).missed, 1);

  // 声明产物落盘（mtime > lastSeenTs）→ 活动信号 ③
  const out = path.join(store.artifactsDirOf(S, batchId), 'exec', 'l1', 'out.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'progress-v1');
  // 确定性修复：文件系统 mtime 记账与进程 Date.now() 不同源，可能 ≤ lastSeenTs（本地实证
  // 23% 轮次 mtime ≤ writeFileSync 时刻），引擎用严格大于判定导致活动漏判。显式 utimesSync
  // 推进 mtime 至确定未来值，消除同毫秒竞态（300 轮实验 0 失败，mtime 恒 > lastSeenTs）。
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(out, future, future);
  engine.tick(); // 活动拍：只重置，不追问
  let st = engine.status(LANE_KEY);
  assert.equal(st.missed, 0, 'W3: missedCount 归零');
  assert.equal(st.tier, 0, 'W3: 档位回 tier0');
  assert.equal(st.stalled, false);
  {
    const inboxW3 = inboxItems(root, S, batchId);
    assert.deepEqual(inboxW3.map((i) => i.message.lane), [lane],
      'W3: 活动拍后 inbox lane 身份集合（实测 ' + JSON.stringify(inboxW3.map((i) => i.message.lane)) + '）');
    assert.ok(inboxW3.filter((i) => i.message.lane === lane).length <= 1,
      'W3: 活动拍不追加（同 lane ≤1 条；实测 ' + inboxW3.length + '）');
  }
});

test('W3b：outbox 出现未 ack 消息 → 重置（活动信号 ②）', () => {
  const { root, store, S, batchId, lane } = setup();
  const engine = laneHeartbeat(store, root, FAST);
  engine.tick();
  assert.equal(engine.status(LANE_KEY).missed, 1);
  mailbox.send(path.join(root, 'sessions', S, 'mailbox', batchId), { type: 'outbox', lane }, { kind: 'report', text: 'progress' });
  engine.tick();
  assert.equal(engine.status(LANE_KEY).missed, 0);
  assert.equal(engine.status(LANE_KEY).stalled, false);
});

test('W3c：batch.events 本 lane 事件更新 → 重置（活动信号 ①）', async () => {
  const { root, store, S, batchId, lane } = setup();
  const engine = laneHeartbeat(store, root, FAST);
  engine.tick();
  assert.equal(engine.status(LANE_KEY).missed, 1);
  // 事件 ts 由 store 在 appendEvent 时生成（进程时钟），与 lastSeenTs 同源同精度；竞态点在
  // 「事件 ts 与 lastSeenTs 同毫秒」，须在事件产生前推进时钟（等待在 appendEvent 之后无效）。
  await new Promise((r) => setTimeout(r, 10));
  store.appendEvent(S, batchId, 'gate.passed', { lane });
  engine.tick();
  assert.equal(engine.status(LANE_KEY).missed, 0);
  // lane.stalled 为引擎自写事件，不视为活动（防自重置）
  const st = engine.status(LANE_KEY);
  assert.equal(st.missed, 0);
  assert.equal(store.readBatch(S, batchId).events.filter((e) => e.type === 'lane.stalled').length, 0);
});

// ---- W4：退避档位——冷场越久追问间隔递增（fake clock 精确验证 10→20→30） ----
test('W4：退避档位（fake clock）——追问节奏 10min → 30min → 60min，间隔 10/20/30 单调递增', () => {
  const { root, store, S, batchId, lane } = setup();
  let fake = 0;
  const engine = laneHeartbeat(store, root, { capabilities: { watch: { enabled: true, intervalsMinutes: [10, 20, 30], maxMissed: 3 } } }, { now: () => fake });
  const MIN = 60_000;

  engine.tick(); // t=0：新派发宽限，未到 base 档 → 不追问
  assert.equal(engine.status(LANE_KEY).missed, 0);

  fake = 10 * MIN; engine.tick(); // 第 1 拍（base=10min）
  assert.equal(engine.status(LANE_KEY).missed, 1);
  {
    const inboxW4 = inboxItems(root, S, batchId);
    assert.deepEqual(inboxW4.map((i) => i.message.lane), [lane],
      'W4: 多拍合并后 inbox lane 身份集合（实测 ' + JSON.stringify(inboxW4.map((i) => i.message.lane)) + '）');
    assert.ok(inboxW4.filter((i) => i.message.lane === lane).length <= 1,
      'W4: 同 lane ≤1 条（实测 ' + inboxW4.length + '）');
  }

  fake = 19 * MIN; engine.tick(); // 9min 后：未到第 2 档（20min）→ 不推进
  assert.equal(engine.status(LANE_KEY).missed, 1);

  fake = 30 * MIN; engine.tick(); // 第 2 拍（距第 1 拍 20min）→ pending 合并推进
  assert.equal(engine.status(LANE_KEY).missed, 2);

  fake = 49 * MIN; engine.tick(); // 未到第 3 档（30min）
  assert.equal(engine.status(LANE_KEY).missed, 2);

  fake = 60 * MIN; engine.tick(); // 第 3 拍（距第 2 拍 30min）→ 硬停
  let st = engine.status(LANE_KEY);
  assert.equal(st.missed, 3);
  assert.equal(st.stalled, true);
  assert.equal(store.readBatch(S, batchId).events.find((e) => e.type === 'lane.stalled').missed, 3);
  {
    const inboxMulti = inboxItems(root, S, batchId);
    assert.deepEqual(inboxMulti.map((i) => i.message.lane), [lane],
      'W4: 全程 inbox lane 身份集合（实测 ' + JSON.stringify(inboxMulti.map((i) => i.message.lane)) + '）');
    assert.ok(inboxMulti.filter((i) => i.message.lane === lane).length <= 1,
      'W4: 多拍合并为同 lane ≤1 条（实测 ' + inboxMulti.length + '）');
  }
  assert.equal(st.tier, 2, '档位随 missed 单调（min(missed, len-1)）');
});

// ---- W5：生命周期——running→idle 后不得静默丢态；重派 running 计时重置 ----
test('W5：recoverBatches → running→idle 后不得静默丢态；重派 running 计时重置', async () => {
  const { root, store, S, batchId, lane } = setup();
  const engine = laneHeartbeat(store, root, FAST);
  engine.tick();
  engine.tick(); // missed=2（pending 合并）
  assert.equal(engine.status(LANE_KEY).missed, 2);

  // 模拟进程重启恢复：running → idle + system.recovered
  store.recoverBatches();
  assert.equal(store.readBatch(S, batchId).lanes[lane], 'idle');
  engine.tick();
  // **本断言由本批新语义替代（旧口径：`engine.status(LANE_KEY).tracked === false`，即
  //   「idle lane 不被扫描 / 心跳条目被 state.delete 清除」）**。C-2 明文要求删除
  //   lib/watch/lane-heartbeat.js:675 的 `state.delete(laneKey)` 静默丢态路径（§1.2「必须删除的既有短路」
  //   + §W 第 6 行「C-2 删静默丢态（悬挂第二重成因）」）⇒「非 running lane 不可见」不再成立。
  //   改为核**设计已定的观测面**：缺省过滤按状态过滤（§6.1 A 栏②）⇒ 该 idle lane 必须仍能被读出（不得自我抹掉）。
  // 【2026-10-30 G3 B1】原「经 lane_heartbeat 工具只读查询」一段改走**引擎侧**同一观测面：
  //   工具已删，但 C-2 的语义要求（running→idle 后该 lane **不得静默丢态**）仍须有判据 ⇒
  //   改为断言 engine.status(laneKey) 对该 idle lane 仍返回可读状态（不是 self-delete）。
  const stIdle = engine.status(LANE_KEY);
  assert.ok(
    stIdle && stIdle.lane === lane && stIdle.tracked === true,
    'C-2/§6.1：running→idle 后该 lane 不得在探针视图消失（不得静默丢态）；实际 status=' + JSON.stringify(stIdle),
  );

  // 重派 running：计时重置（fresh entry，missed 从 0 起算）—— 既有生命周期意图，本批不变
  store.setMember(S, batchId, lane, 'running');
  engine.tick();
  const st = engine.status(LANE_KEY);
  assert.equal(st.tracked, true);
  assert.equal(st.missed, 1, 'W5: 重派 running 后计时重置（不接续 idle 前拍数）');
  assert.equal(st.stalled, false);
});

// 【2026-10-30 G3 B1】原 W6 / W6b / W6c 三条**工具面**用例已删（lane_heartbeat 工具随 B1 删除）；
//   引擎/探针面的覆盖由本文件其余用例（W1-W5、W7、reset/dispose、resolveWatchConfig）承担。

// ---- W7：零侵入——无新增成员状态、状态机常量不变 ----
test('W7：无新增成员状态（stalled 用事件表达，不碰 MEMBER_STATES/MEMBER_TRANSITIONS）', () => {
  assert.equal(schema.MEMBER_STATES.includes('stalled'), false);
  assert.equal(schema.MEMBER_TRANSITIONS.running.includes('stalled'), false);
  assert.equal(schema.MEMBER_TRANSITIONS.review.includes('stalled'), false);
  assert.deepEqual(schema.MEMBER_STATES, ['pending', 'running', 'review', 'merged', 'failed', 'skipped', 'conflict', 'idle']);
  assert.deepEqual(schema.BATCH_PHASES, ['planning', 'running', 'paused', 'aborted', 'complete']);
});

// ---- 生命周期 API：reset(laneKey) 外部活动入口；dispose 幂等且 tick 后置为空操作 ----
test('reset(laneKey) 外部活动入口；dispose 幂等', () => {
  const { root, store } = setup();
  const engine = laneHeartbeat(store, root, FAST);
  engine.tick();
  assert.equal(engine.status(LANE_KEY).missed, 1);
  engine.reset(LANE_KEY);
  assert.equal(engine.status(LANE_KEY).missed, 0);
  assert.equal(engine.status(LANE_KEY).tier, 0);

  engine.dispose();
  engine.dispose(); // 幂等
  assert.doesNotThrow(() => engine.tick()); // dispose 后 tick 为空操作
  assert.equal(engine.status(LANE_KEY).tracked, false);
});

// ---- resolveWatchConfig：配置键缺省默认 / 非法回退（schema.js 归主键） ----
test('resolveWatchConfig：缺省默认、显式覆写、非法值回退', () => {
  const d = schema.resolveWatchConfig({});
  assert.equal(d.enabled, true); // P1-01 行为变更：缺省 = WATCH_DEFAULTS.enabled(true)（等价 readCapability 合并；旧「缺省关」为旧行为断言）
  assert.deepEqual(d.intervalsMinutes, [10, 20, 30]);
  assert.equal(d.maxMissed, 3);
  assert.equal(d.scanIntervalMinutes, 1);
  assert.equal(d.probeTemplate, null);

  const c = schema.resolveWatchConfig({ capabilities: { watch: { enabled: true, intervalsMinutes: [1, 2], maxMissed: 5, scanIntervalMinutes: 0.5, probeTemplate: 'hi {lane}' } } });
  assert.equal(c.enabled, true);
  assert.deepEqual(c.intervalsMinutes, [1, 2]);
  assert.equal(c.maxMissed, 5);
  assert.equal(c.scanIntervalMinutes, 0.5);
  assert.equal(c.probeTemplate, 'hi {lane}');

  const bad = schema.resolveWatchConfig({ capabilities: { watch: { intervalsMinutes: ['x'], maxMissed: 0, scanIntervalMinutes: 0 } } });
  assert.deepEqual(bad.intervalsMinutes, [10, 20, 30]); // 非法档位回退缺省
  assert.equal(bad.maxMissed, 3);
  assert.equal(bad.scanIntervalMinutes, 1);
});
