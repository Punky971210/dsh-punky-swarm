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

// 【2026-09-27 用户裁决 · 新增套件】`team` 降为**可选标签**（team-asset 装配方案全面弃用）的回归锁。
// 三条命题（逐条对应改动目标，判据可机检）：
//   ① 不传 `team` ⇒ **建批成功** + 批次 JSON 落盘 + `batch.team === null`（跳过整个团队资产面，且不代造默认值）；
//   ② 传**未注册** team 名 ⇒ **建批成功** + 批次 JSON 落盘 + 原 `TEAM_ASSET_NOT_FOUND` 码进 `warnings` 留痕；
//   ③ 给了 `teamsRoot` 却没给 `team` ⇒ **不得静默吞掉**：`TEAMS_ROOT_IGNORED` 既进返回值 `warnings`、也落批次事件，
//      且**不写批次键**（防「声明了却不生效」）。
// 夹具纪律：本套件**不需要任何团队资产**（这正是被检面）⇒ 不写 `presets/**`、不碰仓库内真实资产，
//   故无需 `helpers/team-fixture.mjs` 的写入单点，也不进 F2 白名单。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';

const SESS = { agent: { session: { id: 'sess-team-label' } } };

// 合规三层任务（含 audit 层 ⇒ 必须随批带装配声明；`GATE_ASSEMBLY_*` 不在本批写域、逐字未改）
function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'code' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a.md'], deps: ['e1'], cmd: 'accept' },
  ];
}
const ASSEMBLY = { auditLane: 'a1' };

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tlabel-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // G1 前置（既有门禁）：`wave_plan` 属 C 档动作 ⇒ 建批前先评估为 C（同 assign_check 落盘函数）
  assessC(store, SESS.agent.session.id, { rationale: 'fixture：team 可选标签套件建批前置评估（多 lane 跨层依赖 ⇒ C 档）' });
  return { root, byName };
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESS.agent.session.id, 'batches', batchId + '.json');
const readBatchRaw = (root, batchId) => JSON.parse(fs.readFileSync(batchFileOf(root, batchId), 'utf8'));

test('T1 `team` 可选：不传 team ⇒ 建批成功 + 批次落盘 + batch.team === null（跳过资产面，不代造默认值）', async () => {
  const { root, byName } = makeHarness();
  try {
    const out = await byName.wave_plan.execute({ batchId: 'tl-none', tasks: tasks3(), assembly: ASSEMBLY }, SESS);
    assert.equal(out.batchId, 'tl-none', '缺 team 不得再拒建批（原 TEAM_ASSET_MISSING_FIELD 已退出工具面）');
    assert.deepEqual(out.warnings, [], '无标签 ⇒ 零留痕（资产面整体跳过，不是「查了没查到」）');
    assert.ok(!out.wavePlan.flatMap((w) => w.tasks).some((t) => /\[skills=/.test(String(t.cmd ?? ''))),
      '无资产面 ⇒ 不注入 skills 前缀（装配前缀面本批零输入）；实测：' + JSON.stringify(out.wavePlan[0].tasks.map((t) => t.cmd)));
    const raw = readBatchRaw(root, 'tl-none');
    assert.equal(raw.team, null, '批次 team 落 null（= 「无团队」事实；不回落 `generic` 等第二默认值真源）');
    assert.equal('teamsRoot' in raw, false, '未给 teamsRoot ⇒ 不写批次键');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T2 `team` 可选（2026-09-27 批 3 反转）：传未注册 team 名 ⇒ 建批成功 + 批次落盘 + 标签原样落批次 + 零资产留痕', async () => {
  const { root, byName } = makeHarness();
  try {
    const out = await byName.wave_plan.execute({ batchId: 'tl-unknown', team: 'no-such-team-zzz', tasks: tasks3(), assembly: ASSEMBLY }, SESS);
    assert.equal(out.batchId, 'tl-unknown', '未注册团队名不得再拒建批（标签 = 自由归类，不要求已注册）');
    // 【T-15/D-6 等值反转（面仍在：建批返回值 `warnings` 面）】原断言 `warnings.some(w => w.code === 'TEAM_ASSET_NOT_FOUND')`；
    //   团队资产查找面已随 T-1（装载器删除）/ T-6（读端删除）整体退役 ⇒ 该码已入退役锁（A-10）
    //   ⇒ 真值反转为「零资产留痕」。断言强度不减：由「包含某码」→「**精确空集**」（更严）。
    assert.deepEqual(out.warnings, [], '团队资产面已整体退役 ⇒ 零资产留痕；实测=' + JSON.stringify(out.warnings));
    const raw = readBatchRaw(root, 'tl-unknown');
    assert.equal(raw.team, 'no-such-team-zzz', '标签照原样落批次（归类面可用）');
    // 【同上反转】原断言 `raw.teamAsset.ok === false`（资产观察档）；观察档写端已随 T-7 整条删除
    //   ⇒ 真值反转为「批次不得写该键」（严格缺席，非放宽为 `== null`）。
    assert.equal('teamAsset' in raw, false, '资产观察档写端已删净（T-7）⇒ 批次不得写 teamAsset 键');
    assert.equal(fs.existsSync(batchFileOf(root, 'tl-unknown')), true, '批次 JSON 落盘');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T3 `teamsRoot`（2026-09-27 批 3 反转）：参数已删除 ⇒ 传入被忽略且**零留痕 / 零批次键**（不静默、不报错）', async () => {
  const { root, byName } = makeHarness();
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tlabel-root-'));
  try {
    const out = await byName.wave_plan.execute({ batchId: 'tl-rootnoteam', tasks: tasks3(), assembly: ASSEMBLY, teamsRoot }, SESS);
    assert.equal(out.batchId, 'tl-rootnoteam', '«给了根却不给标签» 不得拒建批（拒态家族已删除）');
    // 【T-15/D-6 等值反转】原断言 `warnings` 含 `TEAMS_ROOT_IGNORED` + `reason === 'no-team'` + 批次事件携该码；
    //   `teamsRoot` 参数与其留痕码已随 **D-3** 一并退役（`wave_plan.parameters` 删除；码入退役锁）
    //   ⇒ 真值反转为：参数被**结构性忽略**（不再有任何留痕/事件/批次键）。
    //   断言强度不减：原 4 条（warnings 在场 / reason 可辨 / 不写批次键 / 落批次事件）→ 现 4 条
    //   （warnings 精确空集 / 零批次事件携该码 / 不写批次键 / 批内 `teamsRoot` 键仍缺席）。
    assert.deepEqual(out.warnings, [], 'teamsRoot 参数已删 ⇒ 不再产生 TEAMS_ROOT_IGNORED 留痕；实测=' + JSON.stringify(out.warnings));
    const raw = readBatchRaw(root, 'tl-rootnoteam');
    assert.equal('teamsRoot' in raw, false, '被删除的参数不得写批次键（防「声明了却不生效」）');
    assert.equal(raw.events.some((e) => e.code === 'TEAMS_ROOT_IGNORED'), false, '不得落该码的批次事件（写点已删）');
    assert.equal(Array.isArray(raw.events), true, '阴性对照：批次事件面本体仍在（非整段失效）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
  }
});
