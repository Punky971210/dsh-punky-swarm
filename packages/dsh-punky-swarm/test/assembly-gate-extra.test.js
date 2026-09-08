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

// C+ 档装配门禁补测（e2-gate-tester，spec §7 矩阵）——roles 语义延伸（T8 语义补强）：
//   - e1 合并文件 assembly-gate.test.js（23 用例）已覆盖 T1-T10/T12（含层错配纯函数+execute）；
//   - 本文件只补 e1 未覆盖的 roles 语义面：合法角色全集（VALID_ROLES 8 + 盲审扩展 3）零误报、
//     全表大小写变体（词法判定大小写不敏感 + 原样透传）、execute 层扩展角色混合大小写持久化；
//   - T11 全量回归、T13 roles 文档核验（audit 侧记录）结论见 exec/test-report.md，非本文件断言。
// 消费构建产物：lib/wave-plan.js（.ts 源码改后须 npm run build 再生再测）+ createTools harness。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeAssemblyDecl, VALID_ROLES, ROLE_EXTENSIONS,
} from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

// ── fixtures（与 assembly-gate.test.js 同构：p1(plan/designer) + 3 exec/coder + a1(audit/supervisor) → C+）──
function cplusTasks(execN) {
  const tasks = [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/s.md'], cmd: 'spec' },
  ];
  for (let i = 1; i <= execN; i++) {
    tasks.push({ id: 'e' + i, layer: 'exec', role: 'coder', consume: ['plan/s.md'], outputs: ['exec/e' + i + '/o.md'], deps: ['p1'], cmd: 'impl' });
  }
  tasks.push({ id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/s.md'], produce: ['audit/r.md'], deps: ['e' + execN], cmd: 'verify' });
  return tasks;
}

// ── 工具 harness（每 suite 独立临时根；register.js 定义 wave_plan 时即编译参数 DSL）──
function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-cpa-e2-'));
  const store = createStore(root);
  const reg = [];
  const ctx = { tools: { register: (t) => reg.push(t) }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, store, byName };
}
const SESS = { agent: { session: { id: 'sess-cpa' } } };
function batchFileOf(root, sessionId, batchId) {
  return path.join(root, 'sessions', sessionId, 'batches', batchId + '.json');
}

// ── roles 语义补强（spec §7 roles 项 / T8 语义延伸）──

test('roles 语义：合法角色全集（VALID_ROLES 8 + 盲审扩展 3 = 白名单 11）→ 零告警且全保留', () => {
  const all = [...VALID_ROLES, ...ROLE_EXTENSIONS];
  assert.equal(all.length, 11, 'VALID_ROLES(8) + ROLE_EXTENSIONS(3, 盲审三角色) = 11');
  const { decl, warnings } = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', roles: all });
  assert.equal(warnings.length, 0, '合法全集零误报');
  assert.deepEqual(decl.roles, all, '合法词条原样透传保留');
});

test('roles 语义：全表大写变体 → 零告警（词法判定大小写不敏感）且大小写原样透传', () => {
  const upper = [...VALID_ROLES, ...ROLE_EXTENSIONS].map((r) => r.toUpperCase());
  const { decl, warnings } = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', roles: upper });
  assert.equal(warnings.length, 0, '全表大写变体零误报（词法判定大小写不敏感）');
  assert.deepEqual(decl.roles, upper, '词条大小写原样透传（归一化不改写）');
});

test('roles 语义（execute）：C+ 含扩展角色混合大小写 roles → 批次照建 + batch JSON 原样持久化（无告警）', async () => {
  const { root, byName } = makeHarness();
  const roles = ['coder', 'Audit-Panelist', 'SUPERVISOR']; // 扩展角色 + 大小写变体
  const out = await byName.wave_plan.execute({ batchId: 'cpa-roles', tasks: cplusTasks(3), assembly: { managerPlan: 'raise', auditLane: 'a1', roles } }, SESS);
  assert.ok(out.lanes.a1 === 'pending', '批次照建');
  assert.equal(out.warnings.length, 0, '合规 roles 无告警');
  const raw = JSON.parse(fs.readFileSync(batchFileOf(root, 'sess-cpa', 'cpa-roles'), 'utf8'));
  assert.deepEqual(raw.assembly.roles, roles, 'batch JSON 顶层 assembly.roles 原样持久化（含扩展角色与大小写变体）');
});
