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

// R-1 第一步（数据面 + 写入面）：**引擎自建在册表** `batch.managerSeat`。
//
// 裁决前提（2026-10-31 用户裁决 · AQ-1 = 乙）：roster（无论哪个宿主、以何形态取到）**只用于对账**，
//   **在册真源 = 引擎自建表** ⇒ 表由 `batch_phase({manager})` **显式**写入
//   （NQ-1 = 丙：显式登记为主；`spawn_teammate` 反向只留痕、不写表，本批不动 `dispatch-register.js`）。
//
// 范围边界（本批 = R1-1 数据面 + R1-2 写入面）：**判定面**（`inRoster` 改读表 = R1-3）、
//   **事件分级**（`seat-not-registered` 观察级 = R1-4）、**回显面**（`source`/`mismatch` = R1-5）
//   **不在**本批 ⇒ 本文件不为其写期望值（避免把「本批未做」写成「已做」的假绿）。
//
// 覆盖：
//   M-1 入表：五键齐 + 值正确；兼容写 legacy `manager`（键名/形态**逐字不变**）；工具回显不变
//   M-2 幂等：同 seatId 重复登记 ⇒ 两字段逐字不变、不重复落事件
//   M-3 换席：表行改指新席 + 恰一条新事件 + legacy 改指最新（终态批亦可登记事实）
//   M-4 空/空白 agentId：不成行、不覆盖既有、不落事件；未登记批**零键**（不做 null 占位）
//   M-5 存量 legacy 批回填：只回填表，legacy `raisedAt` **逐字不变**（防漂移）
//   M-6 判别子恒定：`source` 恒 `'engine-registry'`（≠ `'roster'`，两者是不同语义位）
//   M-7 静态面：`lib/**` **代码区**内对 `managerSeat` 的赋值**只**发生在 `store/batch.js`（唯一写点）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { codeOnly, findRepoRoot } from '../scripts/baseline-snapshot-core.mjs';
import { tempRoot } from './helpers/gate-fixture.mjs';

const ROOT = tempRoot('punky-manager-seat-');
const store = createStore(ROOT);
const { tools } = createTools({ tools: { register: () => {} }, logger: console }, { store, root: ROOT });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const SID = 'sess-seat';
const SESS = { agent: { session: { id: SID } } };
const EVT_RAISED = 'batch.manager.raised';

/** 建一个最小可登记批（`batch_phase` 只要求批次存在；相位面与本批无关）。 */
function newBatch(batchId) {
  store.createBatch(SID, {
    batchId,
    wavePlan: { schema: 1, team: 'probe-team', concurrency: 1, wavePlan: [{ wave: 1, tasks: [{ id: 'p1' }] }] },
  });
  return batchId;
}

const raisedCount = (batch) => batch.events.filter((e) => e.type === EVT_RAISED).length;

test('M-1 入表：batch_phase({manager}) 写自建表 managerSeat（五键）+ 兼容写 legacy manager', async () => {
  const id = newBatch('b-seat-1');
  const r = await byName.batch_phase.execute({ batchId: id, manager: { agentId: 'mgr-1' } }, SESS);
  const b = store.readBatch(SID, id);

  assert.ok(b.managerSeat, '显式登记一次 ⇒ 入表（表 = 在册真源，不再依赖宿主 roster）');
  assert.deepEqual(Object.keys(b.managerSeat).sort(), ['registeredAt', 'registeredBy', 'role', 'seatId', 'source'],
    '表行键集冻结为五键（增删键 = 契约级变更，须单开批）');
  assert.equal(b.managerSeat.seatId, 'mgr-1', 'seatId = 登记入参 agentId');
  assert.equal(b.managerSeat.role, 'manager', '约定席名（与宿主 roster 的 role 枚举无关）');
  assert.equal(b.managerSeat.source, 'engine-registry', '真源出处判别子');
  assert.equal(b.managerSeat.registeredBy, 'batch_phase', '入表通道 = 唯一显式登记道（不是自然人）');
  assert.match(b.managerSeat.registeredAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'registeredAt 为 ISO 时间戳');

  // legacy 兼容面：**键名/形态逐字不变**（读端零破坏；R1-1 完成判据「旧字段值逐字不变」）
  assert.deepEqual(Object.keys(b.manager).sort(), ['agentId', 'raisedAt']);
  assert.equal(b.manager.agentId, 'mgr-1');
  assert.equal(b.managerSeat.registeredAt, b.manager.raisedAt, '表与 legacy 取同一时刻（表 ↔ 旧字段可对账）');

  // 工具回显面**本批不改**（回显 `source`/`mismatch` 归 R1-5）⇒ 仍回 legacy 形态
  assert.equal(r.manager.agentId, 'mgr-1', 'batch_phase 回显形态不变');
  assert.equal('managerSeat' in r, false, '回显不提前暴露表（避免与 R1-5 的口径分叉）');
  assert.equal(b.phase, 'planning', '登记不改批次阶段');
});

test('M-2 幂等：同 seatId 重复登记 ⇒ 两字段逐字不变、不重复落事件', async () => {
  const id = newBatch('b-seat-2');
  await byName.batch_phase.execute({ batchId: id, manager: { agentId: 'mgr-1' } }, SESS);
  const before = store.readBatch(SID, id);
  const snap = JSON.stringify({ seat: before.managerSeat, legacy: before.manager });

  // 重复登记（含 note 变化）：幂等键 = seatId，note 变化**不构成**新登记（既有语义，逐字保留）
  await byName.batch_phase.execute({ batchId: id, manager: { agentId: 'mgr-1', note: '重复登记' } }, SESS);
  const after = store.readBatch(SID, id);

  assert.equal(JSON.stringify({ seat: after.managerSeat, legacy: after.manager }), snap,
    '同 seatId ⇒ 表行与 legacy 均逐字不变（registeredAt/raisedAt 不漂移）');
  assert.equal(raisedCount(after), 1, '幂等 ⇒ 不重复写 batch.manager.raised 事件');
});

test('M-3 换席：表行改指新席 + 恰一条新事件 + legacy 改指最新（终态批亦可登记）', async () => {
  const id = newBatch('b-seat-3');
  await byName.batch_phase.execute({ batchId: id, manager: { agentId: 'mgr-1' } }, SESS);
  await byName.batch_phase.execute({ batchId: id, phase: 'aborted' }, SESS);
  await byName.batch_phase.execute({ batchId: id, manager: { agentId: 'mgr-2' } }, SESS);
  const b = store.readBatch(SID, id);

  assert.equal(b.managerSeat.seatId, 'mgr-2', '表行改指新席（换人 = 真实变更 ⇒ 必写）');
  assert.equal(b.manager.agentId, 'mgr-2', 'legacy 改指最新登记值（旧语义逐字保留）');
  assert.equal(raisedCount(b), 2, '换 seatId ⇒ 恰一条新事件');
  assert.equal(b.phase, 'aborted', '登记不改批次阶段（终态仍终态）');
});

test('M-4 空/空白 agentId：不成行、不覆盖既有、不落事件；未登记批零键（不做 null 占位）', async () => {
  const id = newBatch('b-seat-4');
  const b0 = store.readBatch(SID, id);
  assert.equal('managerSeat' in b0, false, '未登记批**无** managerSeat 键（不写 null 占位 ⇒ 存量批面零变化）');

  await assert.rejects(() => byName.batch_phase.execute({ batchId: id, manager: {} }, SESS),
    /requires "phase" or "manager"/, '空 agentId ⇒ 不写记录；单独调用如实报错（不静默 no-op）');
  await assert.rejects(() => byName.batch_phase.execute({ batchId: id, manager: { agentId: '   ' } }, SESS),
    /requires "phase" or "manager"/, '空白 agentId（trim 后为空）同判');

  const b1 = store.readBatch(SID, id);
  assert.equal('managerSeat' in b1, false, '空登记不写垃圾行（表不许有 seatId 为空的行）');
  assert.equal(raisedCount(b1), 0, '空登记不落事件');

  // 已有在册席时，空登记**不得**覆盖既有表行
  await byName.batch_phase.execute({ batchId: id, manager: { agentId: 'mgr-keep' } }, SESS);
  const keepSnap = JSON.stringify(store.readBatch(SID, id).managerSeat);
  await assert.rejects(() => byName.batch_phase.execute({ batchId: id, manager: { agentId: '' } }, SESS),
    /requires "phase" or "manager"/);
  assert.equal(JSON.stringify(store.readBatch(SID, id).managerSeat), keepSnap, '空登记不覆盖在册席');
});

test('M-5 存量 legacy 批回填：只回填表，legacy raisedAt 逐字不变（防漂移）', async () => {
  const id = newBatch('b-seat-5');
  await byName.batch_phase.execute({ batchId: id, manager: { agentId: 'mgr-old' } }, SESS);
  // 伪造「R-1 之前」的存量批：磁盘上只有 legacy `manager`、无表（读端兼容面）
  const legacyOnly = store.readBatch(SID, id);
  delete legacyOnly.managerSeat;
  fs.writeFileSync(store.batchFile(SID, id), JSON.stringify(legacyOnly, null, 2), 'utf8');

  const pre = store.readBatch(SID, id);
  assert.equal('managerSeat' in pre, false, '前置：存量批无表键（模拟 R-1 之前的落盘形态）');
  const legacySnap = JSON.stringify(pre.manager);

  store.markManagerRaised(SID, id, { agentId: 'mgr-old' }); // 幂等键两字段同判 ⇒ 只回填表
  const post = store.readBatch(SID, id);
  assert.equal(post.managerSeat.seatId, 'mgr-old', '存量批被回填（否则 R-1 后该批永久显示未在册）');
  assert.equal(JSON.stringify(post.manager), legacySnap, 'legacy 值逐字不变（raisedAt 不被回填动作刷新）');
});

test('M-6 判别子恒定：source 恒 engine-registry（≠ roster）；legacy 带 note 时键集仍不变', async () => {
  const id = newBatch('b-seat-6');
  await byName.batch_phase.execute({ batchId: id, manager: { agentId: 'mgr-1', note: '带备注' } }, SESS);
  const b = store.readBatch(SID, id);

  assert.equal(b.managerSeat.source, 'engine-registry');
  // ⚠ 两个 `source` 是**不同语义位**：表行 source = 在册真源出处；MERGE_STATE_SOURCE.roster = 成员态真源。
  //   串用会让 batch_status 宣称「在册真源 = 宿主 roster」，与 R-1 直接相反。
  assert.notEqual(b.managerSeat.source, 'roster', '在册真源 ≠ 宿主 roster（两处 source 不得互相赋值）');
  assert.deepEqual(Object.keys(b.manager).sort(), ['agentId', 'note', 'raisedAt'], 'legacy 形态只多 note，键名逐字不变');
  assert.equal(b.manager.note, '带备注');
});

test('M-7 静态面：lib/** 代码区内对 managerSeat 的赋值只在 store/batch.js（唯一写点）', () => {
  const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const libRoot = path.join(repoRoot, 'lib');
  // 赋值形态（排除 `==`/`===` 比较）：只看**代码区**（注释/字符串已剥成空格）⇒ 注释里的措辞不会假红/假绿。
  const WRITE = /\bmanagerSeat\s*=(?!=)/g;
  const writers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|ts)$/.test(e.name) || e.name.endsWith('.d.ts')) continue; // .d.ts 是 tsc 产物（禁手改面）
      if (WRITE.test(codeOnly(fs.readFileSync(p, 'utf8')))) {
        writers.push(path.relative(repoRoot, p).split(path.sep).join('/'));
      }
      WRITE.lastIndex = 0; // 全局正则复位（`test()` 有 sticky lastIndex 语义）
    }
  };
  walk(libRoot);
  assert.deepEqual(writers, ['lib/state/store/batch.js'],
    '在册表的写入道**恰一处**；出现第二个写文件 = 新增入表通道（NQ-1 丙 只认显式 `batch_phase`，须显式裁决，禁静默扩道）');
});
