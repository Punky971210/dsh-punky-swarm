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

// 【recommend 语义探针（2026-09-25 用户裁决）】
//   命题：建批期「资产声明的技能名可否解析」= **recommend**（非阻断告警），**不是**装配式（构造期拒建批）。
//   依据：`plan/recommend-spec.md` §1.3 三态表 ①②③ 与 §2.4「C 组新增探针」；断言文本与 §2.3.1 模板逐字同源
//   （两组各自独立驱动 = 反向验证，防「一处改错、两处同绿」）。
//
//   三臂（一臂一用例）：
//     ①a 技能根**不存在** + 资产声明名解析不到 ⇒ 建批成功 + 批次落盘 + **不落** GATE_SKILL_MISSING（③ 态守卫）
//     ①b 技能根**存在**（**空目录**）+ 资产声明名解析不到 ⇒ 建批成功 + 批次落盘 + GATE_SKILL_MISSING 点名
//     ①c 结构段哨兵：同一临时资产某 role **缺 `skills` 字段** ⇒ **仍拒** TEAM_ASSET_SKILLS_MISMATCH
//         （证明本批只翻转「存在性」，未误伤「结构」校验）
//
//   红线（用户裁决「不造空桩」）：**不写 SKILL.md**、**不造技能名目录**、**不 mock `resolvableSkillNames`**；
//     唯一的宿主构造 = `mkdirSync(<隔离 home>/.agents/skills)` **空目录**（①b 为使 `res.ok === true` 所必需）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam, threeTierSyntheticTeam } from './helpers/team-fixture.mjs';

const SESSION = 'sess-skill-recommend';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'rec-probe-team';

/** 宿主技能根（与引擎读端同源：`USERPROFILE || HOME` + `.agents/skills`）。 */
const hostSkillsRootOf = () => path.join(process.env.USERPROFILE || process.env.HOME, '.agents', 'skills');

/** 建 harness：真走工具注册面（`createTools`）+ 真实 store 写入路径。 */
function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-rec-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：recommend 语义三臂探针的建批前置评估（三层 + plan/exec/audit 多依赖 ⇒ C 档）' });
  return { root, store, byName };
}

/** 建批文件路径（与 store 落盘同址）。 */
const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESSION, 'batches', batchId + '.json');

/** 三层任务（plan → exec → audit；audit 消费 plan/ + exec/ 以满 audit_contract）。
 *  ⚠ 名带 `ForRecommend` 后缀：`test/helpers/team-fixture.mjs` 也导出 `threeTierTasks`
 *    ⇒ 本地同名会触发 `F4-1`（本地 function 与共享 helper 导出名不得相交，防「一名两义」）。 */
function threeTierTasksForRecommend() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'build-it' },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'verify-it' },
  ];
}

/** 临时 teamsRoot + 合成三层资产（**声明三个确定不存在的技能名**）。 */
function mkTeamsRoot() {
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-rec-teams-'));
  const asset = threeTierSyntheticTeam(TEAM);
  asset.layers.plan.skills.designer = ['rec-noskill-designer-xyz'];
  asset.layers.exec.skills.coder = ['rec-noskill-coder-xyz'];
  asset.layers.audit.skills.reviewer = ['rec-noskill-reviewer-xyz'];
  writeSyntheticTeam(teamsRoot, TEAM, asset);
  return { teamsRoot, asset };
}

test('①a 技能根不存在 + 声明技能不可解析 ⇒ 建批成功 + 不落 GATE_SKILL_MISSING（三态表 ③）', async () => {
  const h = makeHarness();
  const { teamsRoot } = mkTeamsRoot();
  try {
    // 隔离 HOME 下**不造** `.agents/skills` ⇒ `resolvableSkillNames().ok === false` ⇒ 守 `if (res.ok)` 守卫、不告警
    assert.equal(fs.existsSync(hostSkillsRootOf()), false, '前置：技能根不存在（本臂的可达构造）');
    const out = await h.byName.wave_plan.execute({
      batchId: 'rec-arm-a', team: TEAM, teamsRoot, tasks: threeTierTasksForRecommend(),
      assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
    }, SESS);
    assert.equal(out.batchId, 'rec-arm-a', 'recommend 语义：skills 不可解析不得拒建批');
    assert.equal(fs.existsSync(batchFileOf(h.root, 'rec-arm-a')), true, '不得零批次落盘（原「拒后零落盘」已翻转）');
    assert.equal((out.warnings ?? []).some((x) => x.code === 'GATE_SKILL_MISSING'), false,
      '技能根不可用 ⇒ 该态不落告警（不误报全部缺失）：' + JSON.stringify(out.warnings));
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
  }
});

test('①b 技能根存在（空目录）+ 声明技能不可解析 ⇒ 建批成功 + GATE_SKILL_MISSING 点名', async () => {
  const h = makeHarness();
  const { teamsRoot } = mkTeamsRoot();
  try {
    // **空技能根**：只建目录，零 SKILL.md、零技能名目录 ⇒ `res.ok === true` 且 `known` 为空集
    fs.mkdirSync(hostSkillsRootOf(), { recursive: true });
    const out = await h.byName.wave_plan.execute({
      batchId: 'rec-arm-b', team: TEAM, teamsRoot, tasks: threeTierTasksForRecommend(),
      assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
    }, SESS);
    assert.equal(out.batchId, 'rec-arm-b', 'recommend 语义：skills 不可解析不得拒建批');
    assert.equal(fs.existsSync(batchFileOf(h.root, 'rec-arm-b')), true, '不得零批次落盘（原「拒后零落盘」已翻转）');
    const w = (out.warnings ?? []).find((x) => x.code === 'GATE_SKILL_MISSING');
    assert.ok(w, '解析不到的技能名须落 GATE_SKILL_MISSING 告警（recommend 留痕，非阻断）：' + JSON.stringify(out.warnings));
    assert.match(String(w.missing ?? ''), /rec-noskill-coder-xyz/, '告警须点名缺失技能名：' + JSON.stringify(w));
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
  }
});

test('①c 结构段哨兵：某 role 缺 skills 条目 ⇒ 仍拒 TEAM_ASSET_SKILLS_MISMATCH（未误伤结构校验）', async () => {
  const h = makeHarness();
  const { teamsRoot, asset } = mkTeamsRoot();
  try {
    // 唯一改动点：`layers.exec` 的 `roles` 多一个**没有对应 skills 条目**的角色
    //   ⇒ 结构段 `layers.exec.skills.<role>` 缺非空字符串数组（`lib/assembly/team-asset.js:237-239`）
    //   ⇒ 拒 `TEAM_ASSET_SKILLS_MISMATCH`。与「名不可解析」（存在性）分属两段，正是本臂要证的**未误伤**。
    writeSyntheticTeam(teamsRoot, TEAM, {
      ...asset,
      layers: { ...asset.layers, exec: { roles: ['coder', 'rec-structural-sentinel'], skills: { coder: ['rec-noskill-coder-xyz'] } } },
    });
    // 断言形态：`try/catch` 捕获 + 锚定正则逐字核对（`/^TEAM_ASSET_SKILLS_MISMATCH/`）——
    //   Node 本机实测 `assert.rejects(fn, /^RE/, 'msg')` 的三参形态在该版本下不校验正则，故不采用；
    //   断言强度不降：仍要求**抛**且**首段码逐字**为 `TEAM_ASSET_SKILLS_MISMATCH`。
    let sentinelMsg = null;
    try {
      await h.byName.wave_plan.execute({
        batchId: 'rec-arm-c', team: TEAM, teamsRoot, tasks: threeTierTasksForRecommend(),
        assembly: { managerPlan: 'leader-direct', auditLane: 'a1' },
      }, SESS);
    } catch (e) { sentinelMsg = String(e?.message ?? e); }
    assert.match(String(sentinelMsg), /^TEAM_ASSET_SKILLS_MISMATCH/,
      '结构段（每 role 必须有非空 skills 数组）**未被本批误伤**，仍拒建批：' + String(sentinelMsg));
    assert.equal(fs.existsSync(batchFileOf(h.root, 'rec-arm-c')), false, '结构非法 ⇒ 零批次 JSON 落盘');
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
  }
});
