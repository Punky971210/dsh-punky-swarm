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

// G-2（2026-09-18 清理波 · TD-21 / N-13 回归锁）：`/batch` 响应键面 + `lanesGate` 批级读收敛。
//   · P-1 面板读端**七新键在场**（`danglingLanes` / `handoffs` / `assembly` / `teamAsset` / `chain` /
//     `lanesGate` / `aipSession`；证据面 `lib/api.js:129-140`）。**条件键** `manager`（`api.js:131`）/
//     `smoke`（`api.js:135`）按条件缺省属**正确**（无值不写键），本用例按负向断言锁死「不写空占位键」。
//   · P-2 批级视图（`store.gateStatusMapOfBatch`）逐 lane 与**逐 lane 兼容外壳**（`store.gateStatus`）
//     `deepStrictEqual` **全等**（TD-21 保留面：外壳签名/形状/语义逐字不变）。
//   · P-3 **读计数**（AC-07 双口径）：`lanesGate` 投影段对批次 JSON 的 `fs.readFileSync` 次数 = **1**，
//     且**不随 lane 数增长**；`lib/api.js:96` 的 handler 自身 `store.readBatch` 那 1 次**不可消除**，
//     故按「整请求读数 − handler 基线读数」计（字面「=1」只对**投影段**成立，不得按整请求字面值判）。
// 纪律：夹具一律走真实写入口（`buildWavePlan` + `store.createBatch`），禁手写裸 JSON 绕过校验；
//   本文件零写项目盘（夹具落在 `os.tmpdir()`，退出时清理）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../lib/api.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import * as aipFormat from '../lib/comms/acps-bridge.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-api-batch-keys-'));
const store = createStore(root);
const S = 'sess-batch-keys';

/** 合规三层批（plan → N×exec → audit）。`team` 显式声明 `software-team`（其资产含顶层 `chain`
 *  ⇒ `/batch` 的 `chain` 回显键在场），并显式声明 `assembly`（⇒ `assembly` 键在场）。 */
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
  store.createBatch(S, { batchId, wavePlan: plan, assembly: { auditLane: 'a1', managerPlan: 'leader-direct' } });
  return store.readBatch(S, batchId);
}

const FIVE = ['e1', 'e2', 'e3', 'e4', 'e5'];
const batchFive = makeBatch('b-five', FIVE);
const batchOne = makeBatch('b-one', ['e1']);

const routes = [];
const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
const api = createApi(ctx, { store, root, aipFormat });
const batchRoute = routes.find((x) => x.path === '/api/dsh-punky-swarm/batch');

function invokeBatch(batchId) {
  let status = 0;
  let body = null;
  const res = { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
  batchRoute.handler({ url: '/api/dsh-punky-swarm/batch?batchId=' + batchId + '&session=' + S }, res);
  return { status, body };
}

/** `fs.readFileSync` 计数桩：只统计**指定批次 JSON** 路径的调用（其余路径一律透传，判据不外溢）。
 *  有效前提：`lib/state/{gates,store}.js` 均以 `import fs from 'node:fs'`（default 绑定，同一对象）
 *  ⇒ 打桩可见；桩有效性由 P-3 的 ① 步（逐 lane 外壳读数 = lane 数）自证。 */
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

test.after(() => {
  api.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

// ── P-1：面板读端七新键在场（条件键按条件缺省）────────────────────────────────
test('P-1 七新键在场：danglingLanes / handoffs / assembly / teamAsset / chain / lanesGate / aipSession', () => {
  const r = invokeBatch('b-five');
  assert.equal(r.status, 200);
  for (const key of ['danglingLanes', 'handoffs', 'assembly', 'teamAsset', 'chain', 'lanesGate', 'aipSession']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.body, key), '缺键: ' + key);
  }
  // 条件键缺省（未登记 Manager、非冒烟批）⇒ **不写键**（不是 `null` 之类的空占位）
  assert.ok(!('manager' in r.body), 'manager 未登记时不得写键');
  assert.ok(!('smoke' in r.body), '非冒烟批不得写 smoke 键');
  // lanesGate 键面 = lanes 键面（逐 lane 视图齐备，键序与批次 lanes 同源）
  assert.deepEqual(Object.keys(r.body.lanesGate), Object.keys(r.body.lanes));
  assert.deepEqual(Object.keys(r.body.lanes), ['p1', ...FIVE, 'a1']);
  // 读端增量不得改动既有键语义（抽样：lanes / phase / eventCount 保持在场）
  assert.equal(r.body.phase, 'planning');
  assert.ok(Array.isArray(r.body.recentEvents) && r.body.recentEvents.length > 0);
});

// ── P-2：批级视图逐 lane 与兼容外壳深比较全等 ────────────────────────────────
test('P-2 gateStatusMapOfBatch 与逐 lane gateStatus 深比较全等（兼容外壳保留）', () => {
  // 兼容外壳仍在场（TD-21 保留面）：三个入口同面导出
  assert.equal(typeof store.gateStatus, 'function');
  assert.equal(typeof store.gateStatusOfBatch, 'function');
  assert.equal(typeof store.gateStatusMapOfBatch, 'function');

  const map = store.gateStatusMapOfBatch(S, 'b-five');
  const lanesOfBatch = Object.keys(batchFive.lanes);
  assert.deepEqual(Object.keys(map), lanesOfBatch);
  for (const lane of lanesOfBatch) {
    assert.deepEqual(map[lane], store.gateStatus(S, 'b-five', lane), 'lane 视图与逐 lane 外壳不等: ' + lane);
  }
  // 批级入口与对外稳定名同源（同一次读批、同形状）
  assert.deepEqual(store.gateStatusOfBatch(S, 'b-five'), map);
  // 视图取值抽样（层归属 / 缺失清单面仍在）
  assert.equal(map.e2.layer, 'exec');
  assert.deepEqual(map.e2.produceMissing, []);
  assert.deepEqual(map.p1.produceMissing, ['plan/spec.md']);
  assert.equal(map.p1.contractProblems.length, 1);
});

// ── P-3：读计数（AC-07 双口径）───────────────────────────────────────────────
test('P-3 lanesGate 投影段读批 = 1 次，且不随 lane 数增长', () => {
  const fileFive = store.batchFile(S, 'b-five');
  const fileOne = store.batchFile(S, 'b-one');
  const laneCountFive = Object.keys(batchFive.lanes).length;
  const stub = instrumentBatchReads([fileFive, fileOne]);
  try {
    // ① 桩有效性自证 + 逐 lane 外壳的读数形态（= 改前 `api.js:138` 的逐 lane 展开：N 次）
    stub.reset();
    for (const lane of Object.keys(batchFive.lanes)) store.gateStatus(S, 'b-five', lane);
    assert.equal(stub.hits(fileFive), laneCountFive, '逐 lane 外壳读数应 = lane 数（桩有效性自证）');

    // ② handler 自身读的可见基线（`lib/api.js:96` 的 `store.readBatch`，AC-07 明示不可消除）
    stub.reset();
    store.readBatch(S, 'b-five');
    const handlerBaseline = stub.hits(fileFive);
    assert.equal(handlerBaseline, 1);

    // ③ 整请求读数 ⇒ 投影段读数 = 总读数 − handler 基线（严格口径：= 1）
    stub.reset();
    const rFive = invokeBatch('b-five');
    assert.equal(rFive.status, 200);
    const totalFive = stub.hits(fileFive);
    assert.equal(totalFive - handlerBaseline, 1, 'lanesGate 投影段读批数应为 1（改前 = lane 数）');

    // ④ 整体口径（防误判）：N=1 批的总读数与 N=6 批相等 ⇒ 不随 lane 数增长
    stub.reset();
    store.readBatch(S, 'b-one');
    const baselineOne = stub.hits(fileOne);
    stub.reset();
    const rOne = invokeBatch('b-one');
    assert.equal(rOne.status, 200);
    const totalOne = stub.hits(fileOne);
    assert.equal(totalOne - baselineOne, 1, 'N=1 批的投影段读批数同样为 1');
    assert.equal(totalOne, totalFive, '总读数不得随 lane 数增长');
    assert.equal(Object.keys(batchOne.lanes).length, 3);
  } finally {
    stub.restore();
  }
});
