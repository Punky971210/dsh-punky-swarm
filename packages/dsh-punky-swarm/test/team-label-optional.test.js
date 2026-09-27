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

test('T2 `team` 可选：传未注册 team 名 ⇒ 建批成功 + 批次落盘 + TEAM_ASSET_NOT_FOUND 留痕（标签照原样落批次）', async () => {
  const { root, byName } = makeHarness();
  try {
    const out = await byName.wave_plan.execute({ batchId: 'tl-unknown', team: 'no-such-team-zzz', tasks: tasks3(), assembly: ASSEMBLY }, SESS);
    assert.equal(out.batchId, 'tl-unknown', '未注册团队名不得再拒建批（标签 = 自由归类，不要求已注册）');
    assert.ok(out.warnings.some((w) => w.code === 'TEAM_ASSET_NOT_FOUND'),
      '资产查不到须留痕原码（不静默）：' + JSON.stringify(out.warnings));
    const raw = readBatchRaw(root, 'tl-unknown');
    assert.equal(raw.team, 'no-such-team-zzz', '标签照原样落批次（归类面可用）');
    assert.equal(raw.teamAsset.ok, false, '资产观察档如实记 ok:false（不伪装成已解析）');
    assert.equal(fs.existsSync(batchFileOf(root, 'tl-unknown')), true, '批次 JSON 落盘');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T3 `teamsRoot` 无 `team` ⇒ 忽略但**不静默**：warnings + 批次事件携 TEAMS_ROOT_IGNORED，且不写批次键', async () => {
  const { root, byName } = makeHarness();
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-tlabel-root-'));
  try {
    const out = await byName.wave_plan.execute({ batchId: 'tl-rootnoteam', tasks: tasks3(), assembly: ASSEMBLY, teamsRoot }, SESS);
    assert.equal(out.batchId, 'tl-rootnoteam', '«给了根却不给标签» 不得拒建批（拒态家族已删除）');
    const w = out.warnings.find((x) => x.code === 'TEAMS_ROOT_IGNORED');
    assert.ok(w, '忽略必须可见（不静默吞掉 teamsRoot）：' + JSON.stringify(out.warnings));
    assert.equal(w.reason, 'no-team', '忽略理由可辨（no-team）');
    const raw = readBatchRaw(root, 'tl-rootnoteam');
    assert.equal('teamsRoot' in raw, false, '被忽略的根不得写批次键（防「声明了却不生效」）');
    assert.ok(raw.events.some((e) => e.code === 'TEAMS_ROOT_IGNORED'), '留痕须落批次事件（不只存在返回值里）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
  }
});
