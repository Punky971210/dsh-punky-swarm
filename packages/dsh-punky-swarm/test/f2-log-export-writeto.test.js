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

// F2 写面接线测试（批次 `punky-fix-f2-20261022` · lane `e4-tester`）
//   判据源：`plan/fix-spec-f2.md` §2.3 + AC-4 / R-9（`log_export.writeTo` 经 `resolveWriteTargetIn` 单点）
//   回指缺陷：A1-P1-03 第三个逃逸面（唯一有写权限的面：逃逸 = 任意路径写文件）
//
// 覆盖三档（缺一不可）：
//   ① 根内 junction 指向根外 ⇒ **throw** 且**根外零落盘**（哨兵文件不存在作判据）；
//   ② 正常相对路径 ⇒ 正常落盘（阳性对照，`writtenTo` 与文件内容逐字一致）；
//   ③ **产物根尚不存在** ⇒ 仍能正常落盘（Leader 直做的误拒修正面；无此用例则该修无判据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

const EXEC_SESS = { agent: { session: { id: 'sess-f2-w' } } };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-f2-write-'));
  const store = createStore(root);
  const { tools } = createTools(
    { tools: { register: () => {} }, logger: console },
    { store, root, config: { capabilities: { logs: { enabled: true } } } },
  );
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, store, byName };
}

function makeBatch(store, bid) {
  store.createBatch('sess-f2-w', { batchId: bid, wavePlan: { wavePlan: [{ tasks: [{ id: 'l1' }] }] } });
  store.appendEvent('sess-f2-w', bid, 'member.settled', { lane: 'l1', from: 'pending', to: 'running' });
  store.appendEvent('sess-f2-w', bid, 'gate.entry.missing', { lane: 'l1', missing: ['exec/x.md'] });
}

const artifactsOf = (root, bid) => path.join(root, 'sessions', 'sess-f2-w', 'artifacts', bid);

// ── W1 · AC-4 阳性面 + Leader 误拒修正面：产物根不存在时仍正常落盘 ──────────────────────
test('W1 产物根尚不存在 ⇒ writeTo 仍正常落盘（writtenTo/内容逐字一致）', async () => {
  const { root, store, byName } = setup();
  makeBatch(store, 'b-w1');
  const artifactsDir = artifactsOf(root, 'b-w1');
  assert.equal(fs.existsSync(artifactsDir), false, '前置：批次建好后产物根**尚不存在**（由落盘方 mkdir）');

  const r = await byName.log_export.execute({ batchId: 'b-w1', format: 'markdown', writeTo: 'audit/event-log.md' }, EXEC_SESS);
  assert.equal(r.writtenTo, 'audit/event-log.md', 'writtenTo 逐字回显调用方入参');
  const file = path.join(artifactsDir, 'audit', 'event-log.md');
  assert.equal(fs.existsSync(file), true, '产物根不存在时也必须成功落盘（否则 = 正常写入被误判逃逸）');
  assert.equal(fs.readFileSync(file, 'utf8'), r.report, '落盘内容 = 返回 report（逐字）');
  assert.ok(r.report.includes('## 时间线'), '报告本体完好（非空壳）');
});

// ── W2 · AC-4 阴性面：根内 junction → 根外 ⇒ throw 且根外零落盘 ─────────────────────────
test('W2 根内 junction → 根外 ⇒ throw `writeTo escapes artifacts dir:` 且根外零落盘；同测试内正常路径阳性对照', async (t) => {
  const { root, store, byName } = setup();
  makeBatch(store, 'b-w2');
  const artifactsDir = artifactsOf(root, 'b-w2');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-f2-write-out-'));
  let linkErr = 'ok';
  try { fs.symlinkSync(OUT, path.join(artifactsDir, 'linkout'), 'junction'); } catch (e) { linkErr = String(e && e.code || e); }

  // 阳性对照先行（不依赖链接）：同一批、同一工具、只换 writeTo ⇒ 正常落盘
  const ok = await byName.log_export.execute({ batchId: 'b-w2', format: 'markdown', writeTo: 'audit/ok.md' }, EXEC_SESS);
  assert.equal(ok.writtenTo, 'audit/ok.md');
  assert.equal(fs.existsSync(path.join(artifactsDir, 'audit', 'ok.md')), true, '阳性对照：正常相对路径必须落盘');

  if (linkErr !== 'ok') {
    t.skip('junction unavailable: ' + linkErr + '（该环境写面 junction 用例 verified=false）');
    return;
  }
  assert.equal(fs.existsSync(path.join(artifactsDir, 'linkout')), true, '前置：junction 已建在根内');

  // 阴性：经 junction 写入根外 ⇒ 必拒，且错误文案逐字（既有文案族，零新码）
  await assert.rejects(
    () => byName.log_export.execute({ batchId: 'b-w2', format: 'markdown', writeTo: 'linkout/escape.md' }, EXEC_SESS),
    (e) => e instanceof Error && e.message.startsWith('writeTo escapes artifacts dir: '),
    '经根内 junction 的 writeTo 必须 throw 且文案为 `writeTo escapes artifacts dir: `',
  );
  assert.equal(fs.existsSync(path.join(OUT, 'escape.md')), false, '根外必须零落盘（哨兵文件不存在作判据）');
  assert.deepEqual(fs.readdirSync(OUT), [], '根外目录必须仍然为空');

  // 词法面既有文案不动（与写面单点文案族分离）：`./x.md` 仍走 `invalid writeTo path`
  await assert.rejects(
    () => byName.log_export.execute({ batchId: 'b-w2', format: 'markdown', writeTo: './x.md' }, EXEC_SESS),
    /invalid writeTo path/,
    '词法面文案 `invalid writeTo path` 逐字保留',
  );
});
