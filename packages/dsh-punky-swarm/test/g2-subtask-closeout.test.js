// test/g2-subtask-closeout.test.js
//
// 【批 `punky-g2-closeout-20261113` · lane `e4-test` · C6 测试守卫】G2 + 交接门收口的**四组行为**用例。
//
// ## 判据源
//   `plan/gate-closeout-spec.md` §测试策略（T-1~T-4）＋ §验收标准「交付验收项」AC-1~AC-6 / AC-8。
//   本文件是**纯新增**守卫：不改既有用例文件、不碰 `baselines/`、不改任何 `lib/` 判据实现。
//
// ## 四组用例（每组各带**独立对照组**；对照读数必须与正例有差异，否则该组无判别力）
//   T-1 序贯覆盖已废：声明 3 项 + 单次 `{step:3,total:3}` 且**不带** `subtaskId` ⇒ 拒（`missing` 按声明序全列）
//       对照组：逐项显式 `subtask` 留痕 ⇒ 放行、`missing` 为空
//   T-2 `total.mismatch` 取源方言感知：subtasks 声明 3 + `{total:1}` ⇒ 判出 mismatch，事件 `source:'subtasks.items'`
//       对照组：legacy `checkpoints` 同调用 ⇒ 三读数**逐字相同**、`source:'checkpoints.items'`（差异只在取源标签）
//   T-3 软提示事件 `lane.checkpoint.subtask-hint`：subtasks 批 checkpoint ⇒ 落事件且 `covered` 含**本次** id，
//       回执 `ok:true` 不变
//       对照组：legacy 批零落 / 终态 lane 零落；两组同一调用里 `worktree.checkpoint` **照落**
//               （证明「不落」是软提示判据生效，不是整体静默）
//   T-4 `handoff_view` 展示：subtasks lane 返回 `subtaskOutputs` 且 `present` 逐件反映磁盘事实
//       对照组：无 `subtasks` 声明的 lane 该键**缺席**（不是 `[]`）、render 无该行、既有键读数不变
//
// ## 断言口径（用户纪律：**禁数量断言**）
//   只断言「放行 / 拒绝 / 字段在场或缺席 / 读数取值」。
//   **不**断言「恰 N 条事件」「恰 N 个节点」「恰 N 个用例」—— 数量断言对实现内部追加事件极脆（假红），
//   也会把用例锚死在与判据无关的形状上（本批 T-3 新增一个事件类型，正是这种脆性的现实场景）。
//   故：「零落 / 缺席」一律写成**不在场**断言（`deepEqual(x, [])` / `hasOwnProperty === false`）；
//   「落了」写成**读数取值**断言（取到该事件并核其载荷），不写成计数相等；
//   「不重复落」写成**相邻读数不重复**的行为断言（去重语义本身），不写成条数差。
//
// ## RED 证据（顺序不可颠倒）
//   判据源 §验收标准 1 要求先建立 RED。本文件在 `c97bbd6`（本批改动前）实现上**逐组必红**：
//   T-1 旧实现有「序贯覆盖」放行通道 ⇒ 正例被放行；T-2 旧实现只读 `checkpoints` ⇒ subtasks 侧静默不判；
//   T-3 旧实现无该事件常量与发射位 ⇒ 结构上不可达；T-4 旧 `handoff_view` 无该键。
//   RED 读数（用例名 + 实际 vs 期望）与复跑方式见批次产物 `exec/e4-test.md`。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  coveredSubtasksOf,
  dialectOfLane,
  latestCheckpointOf,
  checkpointTotalMismatchOf,
  recordCheckpointTotalMismatch,
} from '../lib/state/resume.js';
import { CHECKPOINT_PRIMITIVES } from '../lib/state/store/member.js';
import { buildCheckpoints } from '../lib/state/gates/checkpoints.js';
import { createStore } from '../lib/state/store.js';
import { buildHandoffTools } from '../lib/tools/handoff-tools.js';
import { worktreeToolCheckpoint } from '../lib/tools/lane-worktree-tools.js';
import * as EVT from '../lib/state/event-types.js';

// ── 判据原料与门面（生产同一实例：`buildCheckpoints` 是 `state/gates.js` 用的同一工厂；
//    `CHECKPOINT_PRIMITIVES` 是 `store/member.js` 注入 G1/G2 的同一份 frozen 表）────────────────
const gates = buildCheckpoints({});
const SID = 'sess-g2-closeout-test';

/** `worktree.checkpoint` 事件夹具（`coveredSubtasksOf` 的唯一取源就是该类型的 `subtask` 字段）。 */
const cpEventOf = (lane, extra = {}) => ({ type: EVT.EVT_WORKTREE_CHECKPOINT, lane, ...extra });

/** 内存批夹具（`findTask` 的既有形状：`wavePlan[].tasks[]`）。 */
const batchOf = (task, events = []) => ({
  batchId: 'b-g2-fixture',
  wavePlan: [{ wave: 1, tasks: [task] }],
  lanes: { [task.id]: 'review' },
  events,
});

/** 声明面夹具：已归一形态 `{items:[…]}`（`normalizeCheckpoints` 的幂等分支原样返回）。 */
const declaredOf = (ids) => ({
  items: ids.map((id) => ({ id, target: 'exec/' + id + '.md', outputs: ['exec/' + id + '.md'] })),
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T-1 · 序贯覆盖已废（AC-1 / AC-2）
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('T-1 正例：声明 3 项 + 单次 {step:3,total:3} 无 subtaskId ⇒ 结算门拒，missing 按声明序全列', () => {
  // 声明序刻意取 `s2 → s1 → s3`（≠ 字典序）：若实现按排序输出，本组必红 ——
  //   否则「missing 按**声明序**全列」这条判据对排序实现没有判别力。
  const batch = batchOf(
    { id: 'e1', layer: 'exec', subtasks: declaredOf(['s2', 's1', 's3']) },
    [cpEventOf('e1', { step: 3, total: 3 })],
  );

  // 前置夹具自证（非被断言的正例本身）：这正是旧实现的**序贯覆盖放行形状** ——
  // 最新进度报到了末项、且 total 等于声明数。若夹具偏了，本组就退化成「本来就不会过」的假用例。
  assert.deepEqual(latestCheckpointOf(batch, 'e1')?.latest, { step: 3, total: 3 },
    '夹具前置：最新进度必须是 {step:3,total:3}（旧判据的放行形状）');
  assert.equal(dialectOfLane(batch, 'e1'), 'subtasks', '夹具前置：lane 方言必须是 subtasks');

  // 覆盖原料只剩显式 ids（序贯读数整体删除 ⇒ 键集恰为 ['ids']，`sequential` 缺席）
  const covered = coveredSubtasksOf(batch, 'e1');
  assert.deepEqual(Object.keys(covered), ['ids'], '覆盖原料键集必须恰为 [ids]；实测=' + JSON.stringify(Object.keys(covered)));
  assert.equal('sequential' in covered, false,
    '序贯读数必须整体删除（该键在场即说明后门还在）；实测=' + JSON.stringify(covered));
  assert.deepEqual([...covered.ids], [], '单次不带 subtaskId 的调用**不得**计入覆盖面');

  const g = gates.checkCheckpointsSettleGate(SID, 'b-g2-fixture', batch, 'e1', CHECKPOINT_PRIMITIVES);

  assert.equal(g.ok, false, '单次报到末项不再是覆盖 ⇒ 必须拒；实测=' + JSON.stringify(g));
  assert.equal(g.code, 'GATE_CHECKPOINTS_INCOMPLETE', '拒因码必须是结算门码；实测=' + JSON.stringify(g.code));
  assert.deepEqual(g.missing, ['s2', 's1', 's3'],
    'missing 必须按**声明序**全列三项（声明序 s2→s1→s3，非字典序）；实测=' + JSON.stringify(g.missing));
  assert.equal('sequential' in g, false,
    '门回执不得再带序贯读数；实测键集=' + JSON.stringify(Object.keys(g)));
});

test('T-1 对照组：逐项显式 subtask 留痕 ⇒ 结算门放行、missing 为空', () => {
  const batch = batchOf(
    { id: 'e1', layer: 'exec', subtasks: declaredOf(['s2', 's1', 's3']) },
    [cpEventOf('e1', { subtask: 's2' }), cpEventOf('e1', { subtask: 's1' }), cpEventOf('e1', { subtask: 's3' })],
  );

  // 对照组独立读数：显式覆盖集合（`ids` 是 Set ⇒ 排序后比对，不把事件书写顺序混进判据）
  assert.deepEqual([...coveredSubtasksOf(batch, 'e1').ids].sort(), ['s1', 's2', 's3'],
    '逐项留痕后事件面显式覆盖集合必须齐备');

  const g = gates.checkCheckpointsSettleGate(SID, 'b-g2-fixture', batch, 'e1', CHECKPOINT_PRIMITIVES);

  // 与正例形成对照的**独立断言**（不与正例共用读数）：放行 + 无 missing
  assert.equal(g.ok, true, '逐项留痕 ⇒ 放行；实测=' + JSON.stringify(g));
  assert.deepEqual(g.missing, [], '放行时 missing 必须为空；实测=' + JSON.stringify(g.missing));
  assert.equal(g.code, undefined, '放行回执不得带拒因码；实测=' + JSON.stringify(g.code));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T-2 · `total.mismatch` 取源方言感知（AC-4）
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('T-2 正例：subtasks 声明 3 + {total:1} ⇒ mismatch=true 且事件 source=subtasks.items', () => {
  const batch = batchOf({ id: 'e1', layer: 'exec', subtasks: declaredOf(['s1', 's2', 's3']) });

  const mm = checkpointTotalMismatchOf(batch, 'e1', { step: 1, total: 1 });
  assert.deepEqual(mm, { mismatch: true, declared: 3, actual: 1 },
    'subtasks 侧必须判出未对齐（旧实现只读 checkpoints ⇒ 这里静默 false）；实测=' + JSON.stringify(mm));

  const emitted = [];
  recordCheckpointTotalMismatch({ appendEvent: (...a) => emitted.push(a) }, SID, 'b-g2-fixture', batch, 'e1', { step: 1, total: 1 });
  const record = emitted[0]; // 桩只服务本次调用 ⇒ 取该次落的事件核载荷（不写「恰 N 条」）
  assert.ok(record, '未对齐必须落留痕事件（缺席即 C2 未生效）；实测=' + JSON.stringify(emitted));
  const [sid, bid, type, payload] = record;
  assert.equal(sid, SID);
  assert.equal(bid, 'b-g2-fixture');
  assert.equal(type, EVT.EVT_LANE_CHECKPOINT_TOTAL_MISMATCH, '事件类型必须是 total.mismatch；实测=' + type);
  assert.equal(payload.source, 'subtasks.items',
    '取源标签必须是 subtasks.items（方言感知的审计面）；实测=' + JSON.stringify(payload));
  assert.deepEqual([payload.declared, payload.actual], [3, 1], '载荷读数必须与判定读数一致；实测=' + JSON.stringify(payload));
});

test('T-2 对照组：legacy checkpoints 同调用 ⇒ 三读数逐字相同、source=checkpoints.items；对齐侧不得误报', () => {
  const legacy = batchOf({ id: 'e1', layer: 'exec', checkpoints: declaredOf(['c1', 'c2', 'c3']) });

  // 对照组读数：与正例同一支判据、同一支读数（逐字相等是本题的对照要求，不是巧合）
  const mm = checkpointTotalMismatchOf(legacy, 'e1', { step: 1, total: 1 });
  assert.deepEqual(mm, { mismatch: true, declared: 3, actual: 1 },
    'legacy 侧读数必须与改前逐字相等；实测=' + JSON.stringify(mm));

  const emitted = [];
  recordCheckpointTotalMismatch({ appendEvent: (...a) => emitted.push(a) }, SID, 'b-g2-fixture', legacy, 'e1', { step: 1, total: 1 });
  assert.ok(emitted[0], 'legacy 未对齐同样要留痕（取源回落不得变成不判）；实测=' + JSON.stringify(emitted));
  const legacySource = emitted[0][3].source;
  assert.equal(legacySource, 'checkpoints.items', '取源标签必须回落为 checkpoints.items；实测=' + legacySource);

  // 对照读数**有差异**：同一调用、同一读数，唯一差异就是取源标签 —— 这正是方言感知的判据面
  assert.notEqual(legacySource, 'subtasks.items', 'legacy 侧取源标签必须与 subtasks 侧不同（否则取源未被区分）');

  // legacy 对齐侧：不得因取源改造而误报（误报会训练成员忽略警示，比不报更有害）
  assert.deepEqual(checkpointTotalMismatchOf(legacy, 'e1', { step: 3, total: 3 }),
    { mismatch: false, declared: 3, actual: 3 },
    'legacy 对齐时不得误报');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T-3 · 软提示事件 `lane.checkpoint.subtask-hint`（AC-5）
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * 真桩：临时 root + 真 store（落盘链路与生产同源，`appendEvent` 的回写语义才是本组要验的东西）。
 * lane 无 worktree ⇒ `lane_checkpoint` 走 `no-worktree` 降级留痕路径（本仓绝大多数成员的真实路径）。
 */
function harnessOf(batchId, laneTasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-closeout-'));
  const store = createStore(root);
  store.createBatch(SID, {
    batchId,
    wavePlan: { wavePlan: [{ wave: 1, tasks: laneTasks }], team: 'software-team' },
    phase: 'running',
  });
  const warns = [];
  const ctx = { logger: { warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} } };
  const checkpoint = worktreeToolCheckpoint(ctx, { store, root, resolveBatchSession: () => SID });
  const exec = { agent: { session: { id: SID } } };
  const run = (args) => checkpoint.execute({ batchId, laneId: 'e1', session: SID, ...args }, exec);
  const eventsOf = () => (store.readBatch(SID, batchId)?.events ?? []);
  const ofType = (type) => eventsOf().filter((e) => e.type === type);
  const dispose = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, store, warns, run, eventsOf, ofType, dispose };
}

const HINT = EVT.EVT_LANE_CHECKPOINT_SUBTASK_HINT;

test('T-3 正例：subtasks 批 checkpoint ⇒ 落软提示、covered 含本次 subtaskId、回执 ok 不变', async () => {
  const h = harnessOf('p-g2-t3a', [{
    id: 'e1', layer: 'exec', cmd: 'run', outputs: ['exec/e1.md'],
    subtasks: [{ id: 's1', target: 'exec/s1.md' }, { id: 's2', target: 'exec/s2.md' }],
  }]);
  try {
    assert.equal(dialectOfLane(h.store.readBatch(SID, 'p-g2-t3a'), 'e1'), 'subtasks', '夹具前置：lane 方言必须是 subtasks');

    const r = await h.run({ message: 's1 完成', progress: { step: 1, total: 2 }, subtaskId: 's1' });

    // 软提示不得改回执（契约③：不 throw / 不改 ok / 不阻断）
    assert.equal(r.ok, true, 'checkpoint 回执必须仍是 ok:true；实测=' + JSON.stringify(r));

    const hint = h.ofType(HINT).at(-1);
    assert.ok(hint, 'subtasks 批的 checkpoint 必须落软提示事件（缺席即 C3 未生效）');

    // 读数取值断言（不写「恰 N 条」）：本次 subtask 必须被并入覆盖读数（D-4 并入口径）
    assert.equal(hint.subtask, 's1', '载荷 subtask 必须是本次调用的 id；实测=' + JSON.stringify(hint.subtask));
    assert.ok(hint.covered.includes('s1'),
      'covered 必须含**本次** subtaskId（快照滞后 + 并入口径）；实测=' + JSON.stringify(hint.covered));
    assert.deepEqual(hint.remaining, ['s2'],
      'remaining = 声明序减去覆盖；实测=' + JSON.stringify(hint.remaining));
    assert.deepEqual([hint.step, hint.total], [1, 2], 'step/total 必须随本次 progress；实测=' + JSON.stringify([hint.step, hint.total]));
  } finally {
    h.dispose();
  }
});

test('T-3 对照组：legacy 批零落软提示，但同一次调用 worktree.checkpoint 照落（不是整体静默）', async () => {
  const h = harnessOf('p-g2-t3b', [{ id: 'e1', layer: 'exec', cmd: 'run', outputs: ['exec/e1.md'] }]);
  try {
    assert.equal(dialectOfLane(h.store.readBatch(SID, 'p-g2-t3b'), 'e1'), 'legacy', '夹具前置：lane 方言必须是 legacy');

    const r = await h.run({ message: 'legacy 步骤', progress: { step: 1, total: 2 } });

    assert.equal(r.ok, true, 'legacy 批回执必须是 ok:true；实测=' + JSON.stringify(r));
    assert.deepEqual(h.ofType(HINT), [], 'legacy 批不得落软提示（方言判据把关）');
    // 对照组独立断言：同一调用的留痕事件仍在 —— 否则「零落」可能只是整个 checkpoint 静默了
    assert.equal(h.ofType(EVT.EVT_WORKTREE_CHECKPOINT).at(-1)?.mode, 'no-worktree',
      '同一次调用必须仍落 worktree.checkpoint（降级留痕路径）；实测=' + JSON.stringify(h.ofType(EVT.EVT_WORKTREE_CHECKPOINT)));
  } finally {
    h.dispose();
  }
});

test('T-3 对照组：终态 lane 零落软提示，但 worktree.checkpoint 仍照落（只掐软提示）', async () => {
  const h = harnessOf('p-g2-t3c', [{
    id: 'e1', layer: 'exec', cmd: 'run', outputs: ['exec/e1.md'],
    subtasks: [{ id: 's1', target: 'exec/s1.md' }, { id: 's2', target: 'exec/s2.md' }],
  }]);
  try {
    // 终态构造：直接写 `lanes.e1='skipped'`（夹具级注入，刻意绕过 entry/结算门 ——
    //   本组只判「终态守卫」这一条，选 skipped 而非 merged 是为了让「去重」无法解释本组的零落）
    {
      const b = h.store.readBatch(SID, 'p-g2-t3c');
      b.lanes.e1 = 'skipped';
      h.store.commitBatch(SID, 'p-g2-t3c', b);
    }
    assert.equal(h.store.readBatch(SID, 'p-g2-t3c').lanes.e1, 'skipped', '夹具前置：lane 必须已终态');

    await h.run({ message: '终态后再 checkpoint', progress: { step: 1, total: 2 }, subtaskId: 's1' });

    assert.deepEqual(h.ofType(HINT), [], '终态 lane 不得落软提示（TERMINAL 守卫）');
    assert.ok(h.ofType(EVT.EVT_WORKTREE_CHECKPOINT).at(-1),
      '终态 lane 的 worktree.checkpoint 仍必须照落（被掐的只有软提示）');
  } finally {
    h.dispose();
  }
});

test('T-3 对照行为：同 remaining 不重复落；覆盖推进后 remaining 收敛为空', async () => {
  const h = harnessOf('p-g2-t3d', [{
    id: 'e1', layer: 'exec', cmd: 'run', outputs: ['exec/e1.md'],
    subtasks: [{ id: 's1', target: 'exec/s1.md' }, { id: 's2', target: 'exec/s2.md' }],
  }]);
  try {
    await h.run({ message: 's1', progress: { step: 1, total: 2 }, subtaskId: 's1' });
    await h.run({ message: 's1 重报', progress: { step: 1, total: 2 }, subtaskId: 's1' });
    await h.run({ message: 's2', progress: { step: 2, total: 2 }, subtaskId: 's2' });

    const hints = h.ofType(HINT);
    const remainingSeen = hints.map((e) => JSON.stringify(e.remaining));
    assert.ok(hints[0], '夹具前置：必须观察到软提示读数；实测=' + JSON.stringify(remainingSeen));
    assert.deepEqual(hints[0].remaining, ['s2'], '首条读数：s1 已覆盖、s2 仍缺；实测=' + JSON.stringify(hints[0].remaining));

    // 去重语义本身（不写成条数差）：相邻两条软提示的 remaining 集合不得相同
    const adjacentDuplicate = remainingSeen.find((r, i) => i > 0 && r === remainingSeen[i - 1]);
    assert.equal(adjacentDuplicate, undefined,
      '同 remaining 不得重复落（去重按集合）；相邻重复读数=' + JSON.stringify(adjacentDuplicate) + ' 全序列=' + JSON.stringify(remainingSeen));

    assert.deepEqual(JSON.parse(remainingSeen.at(-1)), [],
      '全部 subtask 覆盖后 remaining 必须收敛为空（末条读数）；实测=' + JSON.stringify(remainingSeen.at(-1)));
  } finally {
    h.dispose();
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T-4 · `handoff_view` 的 subtask 产物展示（AC-6；G4=C + H2=A：只展示、不校验）
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('T-4 正例：subtasks lane 返回 subtaskOutputs，present 逐件反映磁盘事实', async () => {
  const batchId = 'p-g2-t4';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-closeout-view-'));
  const store = createStore(root);
  store.createBatch(SID, {
    batchId,
    wavePlan: { wavePlan: [{ wave: 1, tasks: [
      { id: 'e1', layer: 'exec', cmd: 'run', subtasks: [
        { id: 's1', target: 'exec/s1-a.md', outputs: ['exec/s1-a.md'] },
        { id: 's2', target: 'exec/s2-a.md', outputs: ['exec/s2-a.md', 'exec/s2-b.md'] },
      ] },
      { id: 'e2', layer: 'exec', cmd: 'run' }, // 无 `subtasks` 键 ⇒ 对照组
    ] }], team: 'software-team' },
    phase: 'running',
  });
  const dir = store.artifactsDirOf(SID, batchId);
  const put = (rel, body = 'fixture\n') => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  };
  const view = buildHandoffTools({ ctx: {}, store, root, config: {}, deps: {} })
    .find((t) => t.name === 'handoff_view');
  const exec = { agent: { session: { id: SID } } };
  const call = async (lane) => view.execute({ session: SID, batchId, lane }, exec);

  try {
    // ① 全在场
    put('exec/s1-a.md');
    put('exec/s2-a.md');
    put('exec/s2-b.md');
    const v1 = await call('e1');
    assert.deepEqual(v1.subtaskOutputs, [
      { id: 's1', outputs: ['exec/s1-a.md'], present: [true] },
      { id: 's2', outputs: ['exec/s2-a.md', 'exec/s2-b.md'], present: [true, true] },
    ], '全在场时 present 必须逐件 true；实测=' + JSON.stringify(v1.subtaskOutputs));

    // ② 缺 1 件：present 必须逐件反映磁盘事实（不由 outputs.length 反推）
    fs.rmSync(path.join(dir, 'exec/s2-b.md'));
    const v2 = await call('e1');
    assert.deepEqual(v2.subtaskOutputs, [
      { id: 's1', outputs: ['exec/s1-a.md'], present: [true] },
      { id: 's2', outputs: ['exec/s2-a.md', 'exec/s2-b.md'], present: [true, false] },
    ], '缺件位的 present 必须为 false（只展示、不伪造在场）；实测=' + JSON.stringify(v2.subtaskOutputs));
    for (const s of v2.subtaskOutputs) {
      assert.equal(s.present.length, s.outputs.length, 'present 必须与 outputs 等长同位；实测=' + JSON.stringify(s));
    }

    // render 必须把该读面上屏（缺件标 MISSING）
    const lines = view.output.render({ batchId, lane: 'e1' }, v2)[0].text.split('\n').filter((l) => l.includes('subtask 产物'));
    assert.deepEqual(lines, ['  subtask 产物: s1 → exec/s1-a.md (ok) | s2 → exec/s2-a.md (ok), exec/s2-b.md (MISSING)'],
      'render 的 subtask 展示行必须逐字反映 present 读数（缺件标 MISSING）；实测=' + JSON.stringify(lines));

    // ③ 对照组：无 subtasks 声明的 lane ⇒ 该键**缺席**（禁返回 [] 冒充「已声明 0 项」）
    const v3 = await call('e2');
    assert.equal(Object.prototype.hasOwnProperty.call(v3, 'subtaskOutputs'), false,
      '未声明 subtasks 的 lane 该键必须缺席；实测键集=' + JSON.stringify(Object.keys(v3)));

    // 对照读数（独立断言）：既有键与既有 render 面不得被新字段污染
    assert.equal(v3.ready, true, '既有键 ready 读数不变；实测=' + JSON.stringify(v3.ready));
    assert.equal(v3.legacy, false, '既有键 legacy 读数不变（本批 handoffs 为 {} ⇒ 非 legacy）；实测=' + JSON.stringify(v3.legacy));
    assert.deepEqual(v3.edges, [], '既有键 edges 读数不变（无 deps ⇒ 空）；实测=' + JSON.stringify(v3.edges));
    assert.deepEqual(v3.blocking, [], '既有键 blocking 读数不变；实测=' + JSON.stringify(v3.blocking));
    const legacyLines = view.output.render({ batchId, lane: 'e2' }, v3)[0].text.split('\n').filter((l) => l.includes('subtask 产物'));
    assert.deepEqual(legacyLines, [], '未声明 subtasks 的 lane 不得渲染 subtask 产物行；实测=' + JSON.stringify(legacyLines));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
