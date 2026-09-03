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

// GAP-05：命令 gate 对「不存在命令」的处置集成用例（SPAWN_FAIL / NONZERO 分支）
// 平台差异如实披露：Windows cmd shell 下 nonexistent 命令 → spawn 成功、shell 返回 exit 1
// （GATE_EXIT_NONZERO，cmd 自身报 '不是内部或外部命令'）；真正的 SPAWN_FAIL（spawn 级异常，
// 如 cwd 无效/shell 不可用）在 POSIX/Windows 的 spawn 层触发。两种分支都必须拒 merged（不假通过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createGates } from '../lib/state/gates.js';
import { runCommand } from '../lib/state/command-exec.js';

const SILENT = { warn() {}, info() {}, error() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-spawn-'));
  const store = createStore(root, { logger: SILENT });
  return { root, store, S: 'sess-spawn' };
}

// 三层任务：plan 产 spec → exec 产带 gate 声明的报告 → audit
const TASKS = [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/test-report.md'], cmd: 'code', deps: ['p1'] },
  { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/acceptance.md'], cmd: 'review', deps: ['e1'] },
];

function makeBatch(root, store, S, batchId, gateCmd) {
  const plan = buildWavePlan({ batchId, tasks: TASKS, team: 'generic' });
  store.createBatch(S, { batchId, wavePlan: plan });
  const artDir = path.join(root, 'sessions', S, 'artifacts', batchId);
  fs.mkdirSync(path.join(artDir, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(artDir, 'plan', 'spec.md'), '# Spec\n## 验收标准\n- x\n## 约束\n- y\n');
  fs.writeFileSync(path.join(artDir, 'exec', 'test-report.md'), '# 验证\n- ok\ngate: ' + gateCmd + '\n');
  return artDir;
}

function set(store, S, batchId, lane, to, note) {
  try { return store.setMember(S, batchId, lane, to, note); }
  catch (e) { return e; }
}

test('GAP-05a：`gate: nonexistent_cmd_xyz` 集成 → merged 被拒（不假通过）+ gate.exit_blocked 留痕', () => {
  const { root, store, S } = setup();
  const batchId = 'b-spawn-missing';
  makeBatch(root, store, S, batchId, 'nonexistent_cmd_xyz');
  // plan lane merged
  assert.ok(!(set(store, S, batchId, 'p1', 'running') instanceof Error));
  assert.ok(!(set(store, S, batchId, 'p1', 'review') instanceof Error));
  assert.ok(!(set(store, S, batchId, 'p1', 'merged') instanceof Error));
  // exec lane → merged 前置命令 gate
  assert.ok(!(set(store, S, batchId, 'e1', 'running') instanceof Error));
  assert.ok(!(set(store, S, batchId, 'e1', 'review') instanceof Error));
  const r = set(store, S, batchId, 'e1', 'merged');
  assert.ok(r instanceof Error, '不存在命令必须拒 merged：' + String(r && r.message));
  const code = /GATE_EXIT_(NONZERO|SPAWN_FAIL)/.exec(r.message);
  assert.ok(code, '拒绝码为 GATE_EXIT_NONZERO 或 GATE_EXIT_SPAWN_FAIL（平台相关）：' + r.message);
  const b = store.readBatch(S, batchId);
  assert.equal(b.lanes.e1, 'review', '失败 lane 留 review');
  const ev = b.events.find((e) => e.type === 'gate.exit_blocked');
  assert.ok(ev, 'gate.exit_blocked 事件存在');
  assert.equal(ev.lane, 'e1');
  assert.ok(ev.code === 'GATE_EXIT_NONZERO' || ev.code === 'GATE_EXIT_SPAWN_FAIL', '事件码平台相关：' + ev.code);
});

test('GAP-05b：runCommand 对 nonexistent 命令的平台分支（Windows: NONZERO；POSIX: NONZERO-127）——退出码非 0 即拒', () => {
  const r = runCommand({ command: 'definitely_not_a_real_command_xyz_987', timeoutMs: 5000 });
  assert.equal(r.ok, false, '不存在命令必失败');
  if (r.error && r.error.startsWith('GATE_EXIT_SPAWN_FAIL')) {
    // 某些环境（无 shell）spawn 级失败
    assert.ok(true);
  } else {
    assert.equal(r.error, null);
    assert.ok(r.exitCode !== 0, 'shell 返回非 0 退出码：' + r.exitCode);
  }
});

test('GAP-05c：SPAWN_FAIL 分支（cwd 无效）→ runCommand 返回 GATE_EXIT_SPAWN_FAIL，不 throw', () => {
  const badCwd = path.join(os.tmpdir(), 'definitely-missing-cwd-' + Date.now());
  const r = runCommand({ command: 'node -e ""', cwd: badCwd, timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.startsWith('GATE_EXIT_SPAWN_FAIL'), 'cwd 无效 → SPAWN_FAIL：' + r.error);
  assert.equal(r.timedOut, false);
});

test('GAP-05d：checkCommandGate DI 注入 SPAWN_FAIL 执行器 → 返回 { ok:false, code:GATE_EXIT_SPAWN_FAIL }（store 集成接线）', () => {
  const { root, store, S } = setup();
  const batchId = 'b-spawn-di';
  makeBatch(root, store, S, batchId, 'echo hi');
  const gates = createGates(root);
  const batch = store.readBatch(S, batchId);
  const fakeRun = () => ({
    ok: false, exitCode: null, output: '', durationMs: 1, timedOut: false, forbidden: false, truncated: false,
    error: 'GATE_EXIT_SPAWN_FAIL: ENOENT: simulated spawn failure',
  });
  const r = gates.checkCommandGate(S, batchId, batch, 'e1', { runCommand: fakeRun });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GATE_EXIT_SPAWN_FAIL');
  assert.equal(r.declared, true);
  assert.equal(r.needHumanEscalation, false);
  // store 集成：真实 merged 路径上 DI 不可用，故此处验证 gates 层判定（store 默认执行器路径由 GAP-05a 覆盖）
});

test('GAP-05e：命令 gate 失败 + needHuman 声明 → 转人工闸（escalation），需 human 证据（与 GAP-05 拒假通过互补）', () => {
  const { root, store, S } = setup();
  const batchId = 'b-spawn-nh';
  const plan = buildWavePlan({ batchId, tasks: TASKS, team: 'generic' });
  store.createBatch(S, { batchId, wavePlan: plan });
  const artDir = path.join(root, 'sessions', S, 'artifacts', batchId);
  fs.mkdirSync(path.join(artDir, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(artDir, 'plan', 'spec.md'), '# Spec\n## 验收标准\n- x\n## 约束\n- y\n');
  fs.writeFileSync(path.join(artDir, 'exec', 'test-report.md'), '# 验证\ngate: nonexistent_cmd_xyz\nneedHuman: true\n');
  assert.ok(!(set(store, S, batchId, 'p1', 'running') instanceof Error));
  assert.ok(!(set(store, S, batchId, 'p1', 'review') instanceof Error));
  assert.ok(!(set(store, S, batchId, 'p1', 'merged') instanceof Error));
  assert.ok(!(set(store, S, batchId, 'e1', 'running') instanceof Error));
  assert.ok(!(set(store, S, batchId, 'e1', 'review') instanceof Error));
  // 无 human 证据 → GATE_NEEDHUMAN_PENDING（转人工闸）
  const r1 = set(store, S, batchId, 'e1', 'merged');
  assert.ok(r1 instanceof Error && /GATE_NEEDHUMAN_PENDING/.test(r1.message), String(r1 && r1.message));
  const b = store.readBatch(S, batchId);
  assert.ok(b.events.some((e) => e.type === 'gate.exit_blocked' && e.escalation === true), 'escalation 事件');
  // 人工裁决证据 → merged
  const r2 = set(store, S, batchId, 'e1', 'merged', 'human:user@2026-08-25:accept');
  assert.ok(!(r2 instanceof Error), String(r2 && r2.message));
  assert.equal(r2.lanes.e1, 'merged');
});
