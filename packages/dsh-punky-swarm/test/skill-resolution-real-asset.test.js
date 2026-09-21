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

// 【F5】门禁 `TEAM_ASSET_SKILLS_MISMATCH` 的**正向**补测 —— 以**真实资产名**驱动引擎的技能解析面
//   （夹具审计 `docs/fixture-audit-2026-09-21.md` §4 F5；F1 已把「造桩」从缺省改为显式，本文件补正面的**可失败证据**）。
//
// 为什么需要它（F1 记录的要害）：`assertTeamAssetReady` 的正向命题是「资产声明的技能名可在宿主技能根解析」。
//   在夹具为**任意**名字造桩的年代，这条恒真 ⇒ 资产里技能名拼错 / 改名 / 真实技能被删，测试全绿。
//   既有覆盖只到负向两侧：
//     · `team-asset-mandatory.test.js#P1-3`  → 某 role 的 skills **不可解析** ⇒ 拒（**正向对照用测试自造名
//       `SEEDED` + `{stub:true}`** ⇒ 那条「通过」仍由夹具造桩保证，仍是空壳恒真）；
//     · `team-asset-mandatory.test.js#P1-3b` → 技能根**不存在** ⇒ 同码拒（fail-closed）。
//   本文件补的是缺口：**用真实资产**驱动，且断言「通过」的成因**可被失败** ——
//     ① 正向通过时注入**不得**使用 `stub`（每条声明名都须真有来源：包内副本 或 `HOST_ONLY_SKILLS`）；
//     ② 解析到的**内容**必须是包内真实 `SKILL.md`（逐字），而非桩 ⇒ 直接反证「空壳恒真」；
//     ③ 引擎只读**宿主技能根**（不回落包内 `skills/`）⇒ 删一份宿主副本即拒，且 missing **逐名指名**；
//     ④ `HOST_ONLY_SKILLS` 是**引擎所需的最小补充集**（双向：只注入包内副本 ⇒ missing ≡ 名单）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertTeamAssetReady } from '../lib/tools/core.js';
import {
  HOST_ONLY_SKILLS, declaredSkillsOf, hostSkillsRoot, listTeamAssetNames,
  packageRootOf, readTeamAssetSource, seedHostSkills, seedTeamAssetSkills,
} from './helpers/host-skills.mjs';

const PKG = packageRootOf();
/** 桩文件的可辨认标记（与 `host-skills.mjs#seedHostSkills` 的桩正文一致）。 */
const STUB_MARK = '（隔离宿主技能根夹具）';
const SAMPLE_TEAM = 'software-team';

/** 在**独立宿主 HOME** 下执行 `fn`（只注入 `names`；用例间互不污染，env 必恢复）。 */
function withSkillsHome(names, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-skillres-'));
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  try {
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    seedHostSkills(names, home); // 缺省 `{stub:false}` ⇒ 名字必须有来源，否则抛错（这正是本文件要的严格性）
    return fn(home);
  } finally {
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
}

const declaredOf = (team) => declaredSkillsOf(readTeamAssetSource(team).asset);
const copyOf = (name) => path.join(PKG, 'skills', name, 'SKILL.md');
/** 包内**有真实副本**的技能名（可读端判据：`skills/<name>/SKILL.md` 存在）。 */
const packageCopyNames = () => declaredOf(SAMPLE_TEAM).filter((n) => fs.existsSync(copyOf(n))).sort();

test('F5-1 正向：每份**真实**团队资产按「包内副本 ∪ HOST_ONLY_SKILLS」注入 ⇒ 引擎放行（注入禁 stub）', () => {
  const teams = listTeamAssetNames();
  assert.ok(teams.length > 0, '前提：包内须存在至少一份真实团队资产');
  let checked = 0;
  for (const team of teams) {
    const declared = declaredOf(team);
    assert.ok(declared.length > 0, team + ' 的前提：声明技能集非空（否则本用例空转）');
    seedTeamAssetSkills(team);            // 缺省路径：无副本且未登记 ⇒ 抛错（F1 的保护，本用例依赖它）
    const asset = assertTeamAssetReady(team); // 正向：不得抛
    assert.ok(asset && asset.layers, team + ' 应加载出资产对象');
    checked += declared.length;
  }
  assert.ok(checked >= 30, '覆盖的声明技能总数应 ≥30（实测 30），实际 ' + checked);
});

test('F5-2 ★ 正向的成因可失败：解析到的是**包内真实正文**（逐字），桩另带可辨认标记', () => {
  seedTeamAssetSkills(SAMPLE_TEAM);
  const copies = packageCopyNames();
  assert.ok(copies.length > 0, '前提：该团队至少声明 1 个包内真实副本');
  for (const name of copies) {
    const seeded = fs.readFileSync(path.join(hostSkillsRoot(), name, 'SKILL.md'), 'utf8');
    assert.equal(seeded, fs.readFileSync(copyOf(name), 'utf8'),
      name + ' 在宿主根必须与包内 skills/ 原件**逐字相同**（⇒ 正向解析到的是真技能，不是桩）');
    assert.ok(!seeded.includes(STUB_MARK), name + ' 是真实副本，不得带桩标记');
  }
  // 名单内的名字走桩分支，且桩**可辨认**（避免「真副本 / 桩」外观无差别）
  const hostOnly = declaredOf(SAMPLE_TEAM).filter((n) => HOST_ONLY_SKILLS.includes(n));
  assert.ok(hostOnly.length > 0, '前提：该团队须声明至少 1 个宿主侧技能（否则本条空转）');
  for (const name of hostOnly) {
    const body = fs.readFileSync(path.join(hostSkillsRoot(), name, 'SKILL.md'), 'utf8');
    assert.ok(body.includes(STUB_MARK), name + ' 属宿主侧 ⇒ 应为可辨认的桩');
  }
});

test('F5-3 引擎只读宿主技能根（不回落包内副本）⇒ 删一份即有拒，且 missing **逐名指名**、不多报', () => {
  const copies = packageCopyNames();
  const declared = declaredOf(SAMPLE_TEAM);
  const victim = copies[copies.length - 1];             // 取一个真实副本名
  const others = declared.filter((n) => n !== victim);
  withSkillsHome(declared, () => {
    // 先锁口径：可解析名 = **目录名** ∪ `SKILL.md` frontmatter `name` ⇒ 只删 `SKILL.md` 留空目录**仍可解析**
    fs.rmSync(path.join(hostSkillsRoot(), victim, 'SKILL.md'));
    assertTeamAssetReady(SAMPLE_TEAM);                   // 不得抛（目录名仍在可解析集内）—— 这是口径，不是缺陷
    // 真删该技能（整目录）⇒ 宿主根不再可解析 ⇒ 拒；⚠ 此处**不动包内 `skills/` 原件**（证明不回落）
    fs.rmSync(path.join(hostSkillsRoot(), victim), { recursive: true });
    assert.ok(fs.existsSync(copyOf(victim)), '前提：包内原件必须仍在（否则本用例退化为「资产被删」）');
    let msg = null;
    try { assertTeamAssetReady(SAMPLE_TEAM); } catch (e) { msg = String(e?.message ?? e); }
    assert.ok(msg, '宿主根缺 ' + victim + ' ⇒ 必须拒（若通过 ⇒ 说明回落到了包内 skills/，门禁虚设）');
    assert.match(msg, /TEAM_ASSET_SKILLS_MISMATCH/, '同码拒（不新造码）');
    assert.ok(msg.includes(victim), '缺失名须**指名**报出（否则「任一不匹配就一律拒」也会绿）');
    for (const n of others) {
      assert.ok(!msg.includes(n), '已可解析的名字不得出现在缺失清单里：' + n);
    }
  });
});

test('F5-4 ★ 名单即引擎所需的最小补充集（双向）：只注入包内副本 ⇒ missing ≡ declared ∩ HOST_ONLY_SKILLS', () => {
  const declared = declaredOf(SAMPLE_TEAM);
  const copies = packageCopyNames();
  const expectMissing = declared.filter((n) => HOST_ONLY_SKILLS.includes(n)).sort();
  assert.ok(expectMissing.length > 0, '前提：该团队须有宿主侧技能，否则本条空转');
  withSkillsHome(copies, () => {
    let msg = null;
    try { assertTeamAssetReady(SAMPLE_TEAM); } catch (e) { msg = String(e?.message ?? e); }
    assert.ok(msg, '只注入包内副本 ⇒ 声明里的宿主侧技能不可解析 ⇒ 必须拒');
    assert.match(msg, /TEAM_ASSET_SKILLS_MISMATCH/);
    for (const n of expectMissing) assert.ok(msg.includes(n), 'missing 须含 ' + n);
    for (const n of copies) assert.ok(!msg.includes(n), '包内副本已注入，不得算作 missing：' + n);
  });
  // 反向对照：把名单里的名字补齐 ⇒ 同资产转绿（证明拒因恰是这些名字，而非「一律拒」）
  withSkillsHome(declared, () => {
    const asset = assertTeamAssetReady(SAMPLE_TEAM);
    assert.ok(asset && asset.layers, '补齐补充集 ⇒ 放行');
  });
});

test('F5-5 名单自身须真被需要：HOST_ONLY_SKILLS ⊆ 全部真实资产的声明技能（无空登记）', () => {
  const union = new Set();
  for (const team of listTeamAssetNames()) for (const n of declaredOf(team)) union.add(n);
  const unused = HOST_ONLY_SKILLS.filter((n) => !union.has(n));
  assert.deepEqual(unused, [],
    '名单里每个名字都必须被某份真实资产声明（空登记会让「名单 ⊆ 资产」失去意义，并掩盖资产侧的删除）：'
    + JSON.stringify(unused));
});
