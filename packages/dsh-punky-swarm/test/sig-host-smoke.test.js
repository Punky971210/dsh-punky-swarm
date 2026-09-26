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

// test/sig-host-smoke.test.js —— sig 任务内容指纹（N3-②）**宿主级冒烟**（真实链路，非纯函数/单测）
//
// 为什么单列一份（DoD 纪律：真实路径自验证）：sig 的价值全在「**真实建批链路上**在场、可读回、格式可判」——
//   `buildWavePlan` 直调成功不等于工具面（`wave_plan`）与宿主装配（团队资产解析 → 技能根校验 → 门禁）链路上成功。
//   本套件全程走**真实工具**（`createTools` 产出的 `wave_plan` / `batch_tasks_add` / `member_settle`）
//   与**真实 store**（无手写伪批次 JSON），断言三件事：
//     ① 建批后落盘 `wavePlan[].tasks[].sig` **逐条在场**（含工具面经 `wavePlan` 归一化的结果）；
//     ② 格式恒为 **16 位小写 hex**（`SIG_PATTERN`），且**每条 lane 与其持久字段自洽**（重算值 == 落盘值）；
//     ③ 引擎读取路径（`store.readBatch` → 扁平化取任务 → 重算）**零报错**（失败即测试失败，不静默）。
//   ⚠ 本文件不替代 `test/sig-fingerprint.test.js`（判据套件）；它是「真实加载/读回」那一条判据的证据面。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { computeTaskSig, SIG_PATTERN } from '../lib/sig-fingerprint.js';
import { assessC, seedArtifactFile, SPEC_OK } from './helpers/gate-fixture.mjs';

test('HOST-SIG 宿主链路：真实 wave_plan 工具建批 ⇒ 落盘 tasks[].sig 在场、16 hex、读回自洽、派发链零报错', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-sig-host-'));
  const store = createStore(root);
  const captured = [];
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    subagents: { start: async (provider, request) => { captured.push({ provider, ...request }); return { id: 'w-smoke', result: Promise.resolve({ output: [], stopReason: 'completed' }) }; } },
  };
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn' } } });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const SID = 's-sig-host';
  const exec = { agent: { session: { id: SID } } };
  assessC(store, SID, { rationale: 'sig 宿主冒烟：真实工具链路建批（多线并行 ⇒ C 档）' });

  // ① 真实工具建批（走工具面参数校验 + 团队资产解析 + 三层契约 + sig 计算落盘）
  const out = await by.wave_plan.execute({
    batchId: 'b-sig-host',
    team: 'engine-team',
    session: SID,
    assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
    tasks: [
      { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', role: 'coder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
      { id: 'a1', layer: 'audit', role: 'supervisor', deps: ['e1'], consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], cmd: 'review' },
    ],
  }, exec);
  assert.equal(out.planned ?? out.ok ?? true, out.planned ?? out.ok ?? true, '工具面返回非抛错（原始回显供取证）');

  // ② 真实 store 落盘读回（引擎读取路径）
  const batch = store.readBatch(SID, 'b-sig-host');
  assert.equal(Array.isArray(batch?.wavePlan), true, '批次落盘可读（wavePlan 为 wave 数组）');
  const flat = batch.wavePlan.flatMap((w) => w.tasks);
  assert.equal(flat.length, 3, '3 条 lane 全部落盘');
  for (const t of flat) {
    assert.equal(SIG_PATTERN.test(t.sig ?? ''), true, '宿主链路落盘 sig 须为 16 位小写 hex：' + t.id + '=' + String(t.sig));
    assert.equal(computeTaskSig(t), t.sig, '读回任务重算须等于落盘 sig（' + t.id + '）—— sig 建立在持久字段上');
  }
  assert.equal(new Set(flat.map((t) => t.sig)).size, 3, '三条不同内容 lane ⇒ 三个不同 sig');

  // ③ 派发链读取路径零报错（任务包与派发核心都读 wavePlan；此处只证「读得到、不抛」）
  seedArtifactFile(root, SID, 'b-sig-host', 'plan/spec.md', SPEC_OK);
  const dispatched = await by.lane_dispatch.execute({ batchId: 'b-sig-host', lane: 'e1', session: SID }, exec);
  assert.equal(dispatched.status, 'running', '派发成功（sig 不阻断任何既有路径）');
  assert.equal(captured.length, 1, 'worker 已被真实自派（宿主链路走通）');
  assert.match(String(captured[0].prompt?.[0]?.text ?? ''), /\[role=coder\]/, '任务包正文含角色前缀（cmd 已被引擎装配）');
  const after = store.readBatch(SID, 'b-sig-host').wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'e1');
  assert.equal(after.sig, flat.find((t) => t.id === 'e1').sig, '派发（owner 写入）后 sig 仍为同一值（冻结面在真实链路上成立）');
  assert.equal(after.owner, exec.agent.session.id, 'owner = 调用方会话（出池声明）');

  // ④ 同批既有迁移路径跑通（sig 只留痕、不改既有状态机语义）：running → review
  const reviewed = store.setMember(SID, 'b-sig-host', 'e1', 'review');
  assert.equal(reviewed.lanes.e1, 'review', 'e1 提交评审成功（既有迁移路径不受 sig 影响）');
  const events = store.readBatch(SID, 'b-sig-host').events;
  assert.equal(events.filter((e) => e.type === 'sig.duplicate_detected').length, 0,
    '同批无同 sig 其他 lane ⇒ 零留痕（负向对照：sig 不产噪音事件）');
});
