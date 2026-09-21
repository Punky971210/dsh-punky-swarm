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

// 派发失败路径回归（2026-09-16 清债）：
//   D-2 worker 会话 id **定点取值**（契约字段 `id`），兼容回落须**显式告警**、取不到**不静默**；
//   D-3 派发失败必须**回滚 lane**（K3 起目标为 `failed` 终态；此前为 `review`——返工边去除后该目标会把 lane
//       卡在非终态且重派必被拒），且在错误文案里给出**唯一**恢复步骤（旧行为：lane 停在 running 无 worker，
//       靠心跳 gap 事后补救）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { workerSessionIdOf } from '../lib/engine/dispatch.js';
import { threeTierTasks, seedArtifacts, assessC, registerManager } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills, withDefaultTeam } from './helpers/host-skills.mjs';
import * as schema from '../lib/schema.js';

// 【P1 同步】`team` 现为必填且必须解析到资产 ⇒ 本套件建批统一补 software-team；其 skills 须可解析 ⇒ 先注入技能根。
seedTeamAssetSkills('software-team');

const SID = 'sess-dr';

// ── D-2 纯函数面 ────────────────────────────────────────────────────────────
test('DR-1 workerSessionIdOf：实现面 id 优先、类型面 childId 同认，兼容回落须告警，取不到返回 null（不静默）', () => {
  const warns = [];
  assert.equal(workerSessionIdOf({ id: 'w-1' }, (m) => warns.push(m)), 'w-1');
  assert.equal(warns.length, 0, '实现面字段命中不得告警');
  assert.equal(workerSessionIdOf({ subagentId: 'w-2' }, (m) => warns.push(m)), 'w-2');
  assert.equal(warns.length, 1, '回落必须显式告警');
  assert.match(warns[0], /未返回实现面字段/, 'N4：告警须说明「实现面 id / 类型面 childId 并存」，不得错指宿主形态已变更');
  assert.equal(workerSessionIdOf({ childId: 'w-3' }, () => {}), 'w-3', '类型面 childId 直接命中（不告警路径见断言数）');
  assert.equal(workerSessionIdOf({}, () => {}), null);
  assert.equal(workerSessionIdOf(null, () => {}), null);
  assert.equal(workerSessionIdOf({ id: '' }, () => {}), null, '空串不算命中');
});

// ── D-3 工具面（真派发失败 ⇒ 回滚 + 恢复指引） ───────────────────────────────
async function harness(startContinuable) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-dr-'));
  const store = createStore(root);
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    subagents: { startContinuable },
  };
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn' } } });
  const by = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
  const exec = { agent: { session: { id: SID } } };
  assessC(store, SID, { rationale: 'fixture：三层批建批前置评估（多线并行 ⇒ C 档）' });
  await by.wave_plan.execute({ batchId: 'b-dr', tasks: threeTierTasks(['e1'], { auditId: 'a1' }), assembly: { auditLane: 'a1' } }, exec);
  await by.batch_phase.execute({ batchId: 'b-dr', phase: 'running' }, exec);
  registerManager(store, SID, 'b-dr', 'mgr-1');
  seedArtifacts(root, SID, 'b-dr', ['e1'], { planProduct: 'plan/spec.md' });
  return { by, exec, store };
}

// K3（2026-09-21）改判：返工边 `review→running` 已去除 ⇒ 派发失败的回滚目标由 `review` 改 `failed`。
//   旧口径「回滚到 review，修因后原地重派」在去边后会把 lane 卡在**非终态且重派必被拒**（invalid member transition）。
//   新语义：派发失败即终态 ⇒ 恢复按 K3 走「gap-list + 新任务批次」，**不可原地重派**。
test('DR-2 派发失败 ⇒ 报 GATE_* 码 + 置 lane failed（终态） + 给出唯一恢复步骤（gap-list + 新批次）', async () => {
  const { by, exec, store } = await harness(async () => { throw new Error('provider "spawn" cannot enforce toolFilter'); });
  await assert.rejects(
    () => by.lane_dispatch.execute({ batchId: 'b-dr', lane: 'e1' }, exec),
    (e) => {
      assert.match(e.message, /GATE_DISPATCH_CAPABILITY_MISSING/, '须归一为可读码面');
      assert.match(e.message, /已将 lane=e1 置 failed/, '须置终态并写明');
      assert.match(e.message, /不可原地重派/, '须明确「不可原地重派」（去边后重派会被拒）');
      assert.match(e.message, /gap-list/, '须指向 gap-list 恢复路径');
      return true;
    },
  );
  const b = store.readBatch(SID, 'b-dr');
  assert.equal(b.lanes.e1, 'failed', 'lane 必须落到终态（不得停在 running，亦不得停在非终态 review）');
  assert.equal(schema.isMemberTerminal(b.lanes.e1), true, 'K3：派发失败即终态 ⇒ 恢复只能走新任务批次');
});

test('DR-3 宿主返回载荷缺 id 且无兼容字段 ⇒ 显式报错（带原始载荷），不静默绑定', async () => {
  const { by, exec } = await harness(async () => ({ unexpected: true }));
  await assert.rejects(
    () => by.lane_dispatch.execute({ batchId: 'b-dr', lane: 'e1' }, exec),
    (e) => /GATE_DISPATCH_FAILED/.test(e.message)
      && /未返回 worker 会话 id/.test(e.message)
      && /载荷=/.test(e.message)
      && /"unexpected":true/.test(e.message.replace(/\s/g, '')),
  );
});

test('DR-4 兼容回落（只有 subagentId）⇒ 派发成功且不因此失败', async () => {
  const { by, exec, store } = await harness(async () => ({ subagentId: 'w-legacy' }));
  const r = await by.lane_dispatch.execute({ batchId: 'b-dr', lane: 'e1' }, exec);
  assert.equal(r.spawned, true);
  assert.equal(r.workerSessionId, 'w-legacy');
  const b = store.readBatch(SID, 'b-dr');
  assert.ok(b.events.some((ev) => ev.type === 'member.dispatch' && ev.workerSessionId === 'w-legacy'), '登记须落盘');
});
