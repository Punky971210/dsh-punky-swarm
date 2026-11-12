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

// test/wave-plan-subtasks.test.js —— 批 `punky-checkpoint-enforce-20261112` · lane `e1-schema`
//
// 判据源：`plan/checkpoint-enforce-spec.md`（exec 层唯一权威验收面），本文件覆盖 e1 的**数据面 / 方言面**：
//   · V-2 幂等（`subtasks-immutable`）
//   · V-3 坏项丢弃且零 throw（`subtasks-bad-item`）
//   · V-4 落盘形态（`subtasks-persist`）
//   · V-5 IMM-2 兼容：加边 / 追加均不抛，既有 `subtasks` 逐字不变（`subtasks-immutable-2`）
//   · V-6 sig 零漂移（`subtasks-sig`）
//   · V-7 `dialectOf` 判定 + 零副作用（`dialect`）
//   · V-10 建批告警不拒（`dialect-legacy-warn`）
//
// 断言口径（spec §X-10 / 仓内纪律）：**身份集合**判覆盖，不写「用例数 / 断言数 / total 固定值」型裸计数；
//   仅「声明序 id 列表」这类**功能绑定面**（声明序本身即被验收的语义）用 `deepEqual` 钉住。
//
// 每条测试「如何能红」（避免恒绿断言）：
//   · V-2 删掉 `normalizeCheckpoints` 的 `{items:[…]}` 原样返回分支 ⇒ 二次归一的 items 变 `[]` ⇒ 必红；
//   · V-4 删掉 `wave-plan.js` 白名单里的 `...(subtasksRef !== null ? { subtasks: … })` 一行 ⇒ 键缺席 ⇒ 必红；
//   · V-5 归一化不幂等（如把 `{items}` 归一成新对象且改值）⇒ IMM-2「字段被改写: subtasks」⇒ 必红；
//   · V-7 把判据从「键在场」改成「值非空」⇒ `{items:[]}` 批被判 legacy ⇒ 必红；
//   · V-10 删掉 `wave-plan-tools.js` 的建批后扫 ⇒ 事件 0 条 ⇒ 必红；误加到「两者都未声明」的批 ⇒ 噪声断言必红。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWavePlan, normalizeSubtasks } from '../lib/wave-plan.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { dialectOf } from '../lib/state/resume.js';
import { threeTierTasks, assessC } from './helpers/gate-fixture.mjs';

const SESS_ID = 'sess-ckpt-subtasks';
const SESS = { agent: { session: { id: SESS_ID } } };
const SILENT = { warn: () => {}, info: () => {}, error: () => {} };
const LEGACY_DIALECT_EVT = 'batch.checkpoint.dialect.legacy';

const flatOf = (batch) => (batch?.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
const taskOf = (batch, id) => flatOf(batch).find((t) => t && t.id === id) ?? null;

function makeStore(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ckpt-subtasks-' + tag + '-'));
  return { root, store: createStore(root, { logger: SILENT }) };
}

/**
 * 三层批任务集（`exec` 层存在时有 audit 硬约束 ⇒ 必须走 `threeTierTasks` 形状）。
 * `patch` 是 `{ [laneId]: 附加字段 }`：只改我关心的 exec 任务，其余逐字不动。
 */
function tiered(execIds, patch = {}) {
  return threeTierTasks(execIds).map((t) => (patch[t.id] ? { ...t, ...patch[t.id] } : t));
}

/** 建一个已落盘批（直接走 `buildWavePlan` + `createBatch`，不涉工具面）。 */
function mkBatch(store, batchId, tasks) {
  return store.createBatch(SESS_ID, {
    batchId, wavePlan: buildWavePlan({ batchId, tasks }), phase: 'running',
  });
}

// ══ V-2 幂等（`subtasks-immutable`）══════════════════════════════════════════════════════
test('subtasks-immutable [V-2] 同一值连续归一两次逐字相等；`{items:[…]}` 回灌不回退为空 items', () => {
  const RAW = [
    { id: 'a', target: 'exec/a.md', outputs: ['exec/a.out'] },
    { id: 'b', target: 'exec/b.md', rounds: 2, ctxBudget: 4096, acceptance: '两条断言' },
  ];
  const snapshot = JSON.stringify(RAW);
  const once = normalizeSubtasks(RAW);
  const twice = normalizeSubtasks(once);
  assert.equal(JSON.stringify(twice), JSON.stringify(once),
    'IMM-2 硬前提：`normalize(normalize(x))` 必须逐字等于 `normalize(x)`'
    + '（否则声明该字段的批永久无法追加任务/加边）');

  // ② `{items:[…]}` 回灌必须原样返回 —— 不回退 `items:[]`（B-6 幂等修复的回接点）
  const refed = normalizeSubtasks({ items: once.items });
  assert.equal(JSON.stringify(refed.items), JSON.stringify(once.items),
    '`{items:[…]}` 回灌不得把 items 重置为空数组');
  // ③ 归一保声明序（后续断言依赖 id 序）
  assert.deepEqual(once.items.map((it) => it.id), ['a', 'b'], '归一须保声明序');
  // ④ 归一化是纯函数：不得回写入参
  assert.equal(JSON.stringify(RAW), snapshot, '归一化不得改动入参对象');
});

// ══ V-3 坏项丢弃 + 零 throw（`subtasks-bad-item`）═══════════════════════════════════════
test('subtasks-bad-item [V-3] 缺 id / id 重复 / target 绝对路径三类坏项各被丢弃；rounds 归 1；任一路径不抛', () => {
  const BAD = [
    { target: 'exec/no-id.md' }, // ① 缺 id
    { id: 'dup', target: 'exec/dup-first.md' }, // ② id 重复：先出现者保留
    { id: 'dup', target: 'exec/dup-second.md' },
    { id: 'abs', target: '/abs/exec/abs.md' }, // ③ target 绝对路径（POSIX 形态）
    { id: 'winabs', target: 'C:\\exec\\win.md' }, // ③' Windows 绝对路径同判
  ];
  const r = normalizeSubtasks(BAD);
  assert.deepEqual(r.items.map((it) => it.id), ['dup'],
    '坏项必须被丢弃、只留第一条合法项；实测 ids=' + JSON.stringify(r.items.map((it) => it.id)));
  assert.equal(r.items[0].target, 'exec/dup-first.md', '重复 id 保留**先出现**的那条（后者丢弃）');

  const clamped = normalizeSubtasks([{ id: 'a', target: 'x', rounds: 0, ctxBudget: 'nope' }]).items[0];
  assert.equal(clamped.rounds, 1, '`rounds: 0` 归一为默认值 1（非法值降级，不丢整项）');
  assert.equal(clamped.ctxBudget, null, '`ctxBudget` 非正数/非数字 ⇒ null（可空字段）');

  // ④ 零 throw（全软）：形态畸形的入口一律降级
  const WEIRD = [undefined, null, 0, 42, 'subtasks', true, {}, { items: 'nope' }, [null, 1, 'x', []],
    [{ id: {}, target: {} }], [{ id: 'a', target: 'x', outputs: 'not-array', mcp: 'not-array' }]];
  for (const w of WEIRD) {
    assert.doesNotThrow(() => normalizeSubtasks(w),
      '`subtasks` 归一化必须零 throw（与同伴 `checkpoints` 同口径，不拒建批）：入参=' + JSON.stringify(w));
  }
});

// ══ V-4 落盘形态（`subtasks-persist`）═══════════════════════════════════════════════════
test('subtasks-persist [V-4] 声明了 subtasks 的任务落盘为 `{items:[…]}`；未声明的任务键**不在**', () => {
  const { store } = makeStore('persist');
  const B = 'b-subtasks-persist';
  mkBatch(store, B, tiered(['e1', 'e2'], {
    e1: { subtasks: [{ id: 's1', target: 'exec/s1.md' }, { id: 's2', target: 'exec/s2.md' }] },
  }));
  const batch = store.readBatch(SESS_ID, B);
  const t1 = taskOf(batch, 'e1');
  const t2 = taskOf(batch, 'e2'); // 同一批的等价 exec 任务，**未声明**该键
  assert.ok(t1 && t1.subtasks, '声明了 subtasks 的任务必须**显式落盘**该字段（白名单漏行 ⇒ 此处必红）');
  assert.equal(Array.isArray(t1.subtasks.items), true, '落盘形态须为 `{items:[…]}`（与 `checkpoints` 同形）');
  assert.deepEqual(t1.subtasks.items.map((it) => it.id), ['s1', 's2'], '落盘须保声明序');
  assert.equal('subtasks' in t2, false, '未声明 ⇒ **不写键**（存量批零感知；判据就是「键在场」）');
  assert.equal(t2.subtasks, undefined, '未声明 ⇒ 也不得写 `undefined` 值');
});

// ══ V-5 IMM-2 兼容（`subtasks-immutable-2`）══════════════════════════════════════════════
test('subtasks-immutable-2 [V-5] 加边与追加任务均不抛 wave-plan-immutable，且既有 subtasks 逐字不变', () => {
  const { store } = makeStore('imm2');
  const B = 'b-subtasks-imm2';
  mkBatch(store, B, tiered(['e1', 'e3'], {
    e1: { subtasks: [{ id: 's1', target: 'exec/s1.md', rounds: 2 }] },
  }));
  const before = JSON.stringify(taskOf(store.readBatch(SESS_ID, B), 'e1').subtasks);
  assert.ok(before.includes('s1'), '前置：待守字段须真在盘上（否则下面两条断言恒绿）');

  // ① 加边路径（`task_update`）：e3 → e1（同层、上游未结算、e3 在池内）
  assert.doesNotThrow(
    () => store.addTaskEdges(SESS_ID, B, [{ id: 'e3', add: ['e1'] }], { reason: 'V-5 加边', author: 'e1-schema' }),
    '`task_update` 路径（addTaskEdges）重归一化后不得触发 IMM-2/IMM-3「字段被改写: subtasks」',
  );
  assert.equal(JSON.stringify(taskOf(store.readBatch(SESS_ID, B), 'e1').subtasks), before,
    '加边后既有任务的 subtasks 必须**逐字不变**');

  // ② 追加路径（`batch_tasks_add`）
  assert.doesNotThrow(
    () => store.addPoolTasks(SESS_ID, B, [{ id: 'e4', layer: 'exec', cmd: 'c4', deps: ['p1'], consume: ['plan/spec.md'] }],
      { reason: 'V-5 追加', author: 'e1-schema' }),
    '`batch_tasks_add` 路径（addPoolTasks）重归一化后不得触发 IMM-2/IMM-3',
  );
  const after = store.readBatch(SESS_ID, B);
  assert.equal(JSON.stringify(taskOf(after, 'e1').subtasks), before, '追加后既有任务的 subtasks 仍逐字不变');
  assert.ok(taskOf(after, 'e4'), '追加的任务须真落盘（否则上一条断言无判别力）');
});

// ══ V-6 sig 零漂移（`subtasks-sig`）══════════════════════════════════════════════════════
test('subtasks-sig [V-6] 含 subtasks 与不含 subtasks 的等价任务 sig 逐字相等', () => {
  const withSub = buildWavePlan({
    batchId: 'b-sig', tasks: tiered(['e1'], { e1: { subtasks: [{ id: 's1', target: 'exec/s1.md' }] } }),
  });
  const without = buildWavePlan({ batchId: 'b-sig', tasks: tiered(['e1']) });
  const sigWith = taskOf(withSub, 'e1').sig;
  const sigWithout = taskOf(without, 'e1').sig;
  assert.equal(typeof sigWith, 'string', '前置：任务须算出 sig（否则本判据无对象）');
  assert.equal(sigWith, sigWithout,
    '`subtasks` 不进 sig 哈希输入面（{id,layer,role,deps,produce,outputs,cmd}）⇒ 既有 sig 基线零漂移');
});

// ══ V-7 方言判定（`dialect`）═════════════════════════════════════════════════════════════
test('dialect [V-7] 无 subtasks 键 ⇒ legacy；任一 task 含该键 ⇒ subtasks；调用零副作用', () => {
  const legacyBatch = {
    wavePlan: [{ wave: 1, tasks: [{ id: 'e1', layer: 'exec', checkpoints: { items: [{ id: 'c1' }] } }] }],
  };
  assert.equal(dialectOf(legacyBatch), 'legacy', '只有 checkpoints 的批 = 旧方言（门全放行）');

  const emptyDeclBatch = { wavePlan: [{ wave: 1, tasks: [{ id: 'e1', subtasks: { items: [] } }] }] };
  assert.equal(dialectOf(emptyDeclBatch), 'subtasks',
    '判据是**键在场**而非「值非空」：`items:[]` 仍是新方言（那正是派发门要拒的形状）');

  const mixedBatch = {
    wavePlan: [
      { wave: 1, tasks: [{ id: 'p1', layer: 'plan' }] },
      { wave: 2, tasks: [{ id: 'e1', layer: 'exec', subtasks: [{ id: 's1', target: 'exec/s1.md' }] }] },
    ],
  };
  assert.equal(dialectOf(mixedBatch), 'subtasks', '批内**任一** task 含该键 ⇒ 整批方言升级');

  const before = JSON.stringify(mixedBatch);
  dialectOf(mixedBatch);
  assert.equal(JSON.stringify(mixedBatch), before, '`dialectOf` 必须纯读、零副作用（调用前后 JSON 逐字相等）');

  // 落盘批同判（读盘口径，不是只在手搓对象上成立）
  const { store } = makeStore('dialect');
  const B1 = 'b-dialect-legacy';
  mkBatch(store, B1, tiered(['e1']));
  assert.equal(dialectOf(store.readBatch(SESS_ID, B1)), 'legacy', '落盘批（无 subtasks）⇒ legacy');
  const B2 = 'b-dialect-new';
  mkBatch(store, B2, tiered(['e1'], { e1: { subtasks: [{ id: 's1', target: 'exec/s1.md' }] } }));
  assert.equal(dialectOf(store.readBatch(SESS_ID, B2)), 'subtasks', '落盘批（有 subtasks）⇒ subtasks');
});

// ══ V-10 建批告警不拒（`dialect-legacy-warn`）════════════════════════════════════════════
test('dialect-legacy-warn [V-10] 新批只声明 checkpoints ⇒ 建批成功 + 恰 1 条 batch.checkpoint.dialect.legacy', async () => {
  const { root, store } = makeStore('warn');
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: SILENT };
  const { tools } = createTools(ctx, { store, root });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESS_ID, { rationale: 'V-10 建批期方言告警：wave_plan 属 C 档动作' });

  const dialectLegacyEventsOf = (batchId) => (store.readBatch(SESS_ID, batchId)?.events ?? [])
    .filter((e) => e && e.type === LEGACY_DIALECT_EVT);

  // ① 只声明 checkpoints（旧方言，但确有声明面）⇒ 建批成功 + 1 条告警
  await assert.doesNotReject(
    () => by.wave_plan.execute({
      batchId: 'b-warn-legacy',
      tasks: tiered(['e1'], { e1: { checkpoints: [{ id: 'c1', target: 'exec/c1.md' }] } }),
      assembly: { auditLane: 'a1' },
    }, SESS),
    '建批期方言告警**只落事件、不得拒建批**',
  );
  const legacyEvts = dialectLegacyEventsOf('b-warn-legacy');
  assert.equal(legacyEvts.length, 1,
    '只声明 checkpoints 的新批须落**恰 1 条** `' + LEGACY_DIALECT_EVT + '`（重复发射即红）');
  assert.deepEqual(legacyEvts[0].declared, ['e1'], '载荷须点名声明了 checkpoints 的 lane（可审计「谁用了旧方言」）');
  assert.equal(legacyEvts[0].type, LEGACY_DIALECT_EVT,
    '载荷不得占用 `type` 键：事件名须仍由 `type` 承载（被载荷覆盖即失名）');

  // ② 声明了 subtasks ⇒ 新方言，**零**告警（不得误发）
  await by.wave_plan.execute({
    batchId: 'b-warn-new',
    tasks: tiered(['e1'], { e1: { subtasks: [{ id: 's1', target: 'exec/s1.md' }] } }),
    assembly: { auditLane: 'a1' },
  }, SESS);
  assert.equal(dialectLegacyEventsOf('b-warn-new').length, 0, '新方言批不得发同条告警');

  // ③ 两种声明面都未声明（= 本批自身与全部存量批的形状）⇒ **零**告警（存量零感知）
  await by.wave_plan.execute({
    batchId: 'b-warn-none',
    tasks: tiered(['e1']),
    assembly: { auditLane: 'a1' },
  }, SESS);
  assert.equal(dialectLegacyEventsOf('b-warn-none').length, 0,
    '未声明任何 checkpoint 面的批不得被打上旧方言告警（否则每批都是噪声，存量零感知红线）');
});
