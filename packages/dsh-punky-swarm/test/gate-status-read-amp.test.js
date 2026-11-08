// G5-P1 · `gate_status` 读放大收敛（批级单点接线）回归锁
//
// ## 为什么有这个文件
// G5-P 实测：`gate_status` p50 **9.606 ms** vs `batch_status` **0.657 ms**（14.6×），且 81% 无法归因。
// 病根定位到 `lib/tools/query-tools.js` 的列举路径：
//     `ids.map((l) => store.gateStatus(sessionId, args.batchId, l))`
// 每个 lane 各读一次批文件 ⇒ 总读盘 = 1(工具自身) + N(lane 数)，O(N) 放大。
// 而**批级单点早已存在**：`store.gateStatusMapOfBatch`（一次读批 → `{lane: gateView}`），
// 与逐 lane 外壳 `gateStatus` 同源同实现（`lib/state/gates/status.js:95-104` 的 TD-21 收敛注释），
// 差别只在读盘次数；`lib/api.js` 的 `lanesGate` 已是它的读端。本文件即把工具侧接线锁住。
//
// ## 判据为什么用「读盘次数」而不是「ms」
// 计时断言会 flaky（GC / 冷启动 / 机器负载），本仓已有多次「恒真判据」教训。
// **读盘次数是确定性的**，且能**成对**：桩有效性（逐 lane 外壳读数 = lane 数）＋ 目标断言
// （批级列举读数不随 lane 数增长）。前者自证桩看得见读盘，否则后者恒绿也无意义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-gate-read-amp-'));
const store = createStore(root);
const S = 'sess-gate-read-amp';

/** 合规三层批（plan → N×exec → audit）。夹具走真实写入口（`buildWavePlan` + `store.createBatch`），
 *  禁手写裸 JSON 绕过校验（G4-C2b 曾因缺 `wavePlan` 形态在 `createBatch` 抛错）。 */
function makeBatch(batchId, laneIds) {
  const tasks = [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
    ...laneIds.map((id) => ({
      id, layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/' + id + '.md'], cmd: 'run', deps: ['p1'],
    })),
    {
      id: 'a1', layer: 'audit',
      consume: ['plan/spec.md', ...laneIds.map((i) => 'exec/' + i + '.md')],
      produce: ['audit/a1.md'], cmd: 'review', deps: laneIds,
    },
  ];
  const plan = buildWavePlan({ batchId, team: 'software-team', tasks });
  store.createBatch(S, { batchId, wavePlan: plan, assembly: { auditLane: 'a1' } });
  return store.readBatch(S, batchId);
}

const ONE = ['e1'];
const FIVE = ['e1', 'e2', 'e3', 'e4', 'e5'];
makeBatch('b-one', ONE);
makeBatch('b-five', FIVE);

const ctx = { tools: { register: () => {}, guard: () => () => {} }, logger: { warn: () => {}, info: () => {} } };
const { tools } = createTools(ctx, { store, root });
const gateStatusTool = tools.find((t) => t.name === 'gate_status');
assert.ok(gateStatusTool, '前置：gate_status 工具必须在册');

/** `fs.readFileSync` 计数桩：**只统计指定批次 JSON**（其余透传，判据不外溢）。
 *  有效前提：`lib/state/{gates,store}.js` 均 `import fs from 'node:fs'`（default 绑定，同一对象）⇒ 打桩可见。 */
function instrumentBatchReads(files) {
  const original = fs.readFileSync;
  const hits = new Map(files.map((f) => [path.resolve(f), 0]));
  fs.readFileSync = function countedReadFileSync(file, ...rest) {
    if (typeof file === 'string') {
      const key = path.resolve(file);
      if (hits.has(key)) hits.set(key, hits.get(key) + 1);
    }
    return original.apply(this, [file, ...rest]);
  };
  return {
    hits: (f) => hits.get(path.resolve(f)),
    reset: () => { for (const k of hits.keys()) hits.set(k, 0); },
    restore: () => { fs.readFileSync = original; },
  };
}

const fileOne = store.batchFile(S, 'b-one');
const fileFive = store.batchFile(S, 'b-five');

test('G5P1-1 桩有效性（阳性对照）：逐 lane 外壳 store.gateStatus 读数 = lane 数', () => {
  const spy = instrumentBatchReads([fileFive]);
  try {
    spy.reset();
    for (const lane of FIVE) store.gateStatus(S, 'b-five', lane);
    // 改前的实现形态就是「每个 lane 各调一次」⇒ 桩必须能看见 N 次，否则本文件的判据全部恒绿
    assert.equal(spy.hits(fileFive), FIVE.length, '桩须能观测到逐 lane 外壳的 N 次读盘（否则断言无杀伤力）');
  } finally { spy.restore(); }
});

test('G5P1-2 列举路径：gate_status 读盘次数**不随 lane 数增长**（核心判据）', async () => {
  const spy = instrumentBatchReads([fileOne, fileFive]);
  try {
    spy.reset();
    await gateStatusTool.execute({ batchId: 'b-one', session: S }, {});
    const oneLaneReads = spy.hits(fileOne);

    spy.reset();
    await gateStatusTool.execute({ batchId: 'b-five', session: S }, {});
    const fiveLaneReads = spy.hits(fileFive);

    // 成对断言：两次读数必须相等 —— 相等即「与 lane 数解耦」；不相等说明仍在 O(N) 放大
    assert.equal(fiveLaneReads, oneLaneReads,
      '1 lane 与 5 lane 的批文件读盘次数必须相等（解耦）；差异 = 仍在逐 lane 读批');
    // 绝对上界：不得随 lane 数线性增长（工具自身 1 次 readBatch + 批级单点 1 次 = 2）
    assert.ok(fiveLaneReads <= 2, '列举路径读盘应 ≤2 次（工具 readBatch + 批级单点），实测 ' + fiveLaneReads);
  } finally { spy.restore(); }
});

test('G5P1-3 语义等价：批级视图逐 lane 与逐 lane 外壳 deepEqual（防「更快但错了」）', async () => {
  const out = await gateStatusTool.execute({ batchId: 'b-five', session: S }, {});
  const batch = store.readBatch(S, 'b-five');
  // ⚠ `batch.lanes` 含 p1(plan) + 5×exec + a1(audit) = 7 条；`FIVE` 只是 exec 段，
  //   故此处必须对 `Object.keys(batch.lanes)` 取数，不能对 `FIVE.length` —— 否则判据锚错对象。
  const laneIds = Object.keys(batch.lanes);
  assert.equal(out.lanes.length, laneIds.length, 'lane 数应与批内 lane 数（含 plan/audit）一致');
  // 键序取 batch.lanes（改前口径），不是批级 map 自身键序
  assert.deepEqual(out.lanes.map((v) => v.lane), laneIds, 'lane 输出顺序须与 batch.lanes 键序一致');
  // 逐 lane 深比较：批级入口与兼容外壳必须给出同一份视图（同源同实现的回归锁）
  for (const lane of laneIds) {
    const fromBatch = out.lanes.find((v) => v.lane === lane);
    const fromShell = store.gateStatus(S, 'b-five', lane);
    assert.deepEqual(fromBatch, fromShell, 'lane ' + lane + ' 的批级视图与逐 lane 外壳必须 deepEqual');
  }
});

test('G5P1-4 单 lane 路径语义不变（含不在 batch.lanes 的任意 id）', async () => {
  // ① 正常单 lane：只返回该 lane
  const one = await gateStatusTool.execute({ batchId: 'b-five', lane: 'e3', session: S }, {});
  assert.equal(one.lanes.length, 1, '给定 lane 时必须只返回 1 条');
  assert.equal(one.lanes[0].lane, 'e3');
  assert.deepEqual(one.lanes[0], store.gateStatus(S, 'b-five', 'e3'), '单 lane 视图须与外壳逐字一致');

  // ② 任意 id（不在 batch.lanes）：改前 `gateStatus` 返回 orphan 风格视图而非 undefined；
  //    批级 map 无该键 ⇒ 若走批级路径会得到 undefined（静默降级）⇒ 本断言锁住「单 lane 走原实现」
  const ghost = await gateStatusTool.execute({ batchId: 'b-five', lane: 'no-such-lane', session: S }, {});
  assert.equal(ghost.lanes.length, 1);
  assert.notEqual(ghost.lanes[0], undefined, '未知 lane 不得退化为 undefined（禁静默降级）');
  assert.equal(ghost.lanes[0].lane, 'no-such-lane');
  assert.equal(ghost.lanes[0].gates, 'orphan', '未知 lane 须保留 orphan 标记（B2 语义）');
});

test('G5P1-5 manager / assembly 回显未受影响', async () => {
  const out = await gateStatusTool.execute({ batchId: 'b-five', session: S }, {});
  assert.deepEqual(out.assembly, { auditLane: 'a1' }, 'assembly 回显须保持');
  assert.ok(!('manager' in out), '本批未登记 manager ⇒ 不得出现 manager 键（条件键语义）');
});
