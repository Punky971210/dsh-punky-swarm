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

// 夹具审计 F1：**技能名台账**（双向断言）——`test/helpers/host-skills.mjs` 的 `HOST_ONLY_SKILLS`
// ─────────────────────────────────────────────────────────────────────────────
// 背景（`docs/fixture-audit-2026-09-21.md` §3.1）：原 `seedHostSkills` 对「包内无 `SKILL.md` 副本」的技能名
//   **静默写桩** ⇒ 门禁 `TEAM_ASSET_SKILLS_MISMATCH` 的**正向命题在测试里恒真**：
//   夹具为任意名字都造出可解析技能 ⇒ 真实资产里技能名拼错/改名/真实技能被删，测试全绿。
//   F1 把桩降为「显式声明」后，本文件负责**把名单与资产声明钉在一起**，让任一侧漂移立刻变红：
//     ① 名单 ⊆ 资产声明技能（无多余登记）
//     ② 名单 ∩ 包内真实副本 = ∅（不重复登记）
//     ③ 资产声明技能 = 包内真实副本 ∪ 名单（**无遗漏** ⇒ 资产新增/改名技能必红）
//     ④ 负向：未登记的名字走缺省路径 ⇒ **抛错**（证明保护真在跑，不是纸面纪律）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOST_ONLY_SKILLS, declaredSkillsOf, readTeamAssetSource, listTeamAssetNames,
  seedHostSkills, hostSkillsRoot, packageRootOf,
} from './helpers/host-skills.mjs';

/** 全部**真实**团队资产声明的技能名（去重）。 */
function allDeclaredSkills() {
  const out = new Set();
  for (const team of listTeamAssetNames()) {
    const src = readTeamAssetSource(team);
    assert.ok(src, team + ' 资产应可读');
    for (const s of declaredSkillsOf(src.asset)) out.add(s);
  }
  return out;
}

/** 包内**有**真实 `skills/<name>/SKILL.md` 副本的技能名（在真实资产声明集合内取交集）。 */
function inPackageSkills(declared) {
  return [...declared].filter((n) => fs.existsSync(path.join(packageRootOf(), 'skills', n, 'SKILL.md')));
}

test('F1-1 名单 ⊆ 资产声明技能（不得登记资产里没有的名字）', () => {
  const declared = allDeclaredSkills();
  const extra = HOST_ONLY_SKILLS.filter((n) => !declared.has(n));
  assert.deepEqual(extra, [],
    'HOST_ONLY_SKILLS 里出现了**任何真实资产都未声明**的技能名 ⇒ 名单已腐化（删掉它们，或确认资产是否漏声明）：'
    + JSON.stringify(extra));
});

test('F1-2 名单 ∩ 包内真实副本 = ∅（有副本的不该登记为宿主侧）', () => {
  const overlap = HOST_ONLY_SKILLS.filter((n) => fs.existsSync(path.join(packageRootOf(), 'skills', n, 'SKILL.md')));
  assert.deepEqual(overlap, [],
    '这些名字包内**已有真实 SKILL.md** ⇒ 不应出现在 HOST_ONLY_SKILLS（否则掩盖「副本已存在」的事实）：'
    + JSON.stringify(overlap));
});

test('F1-3 资产声明技能 = 包内真实副本 ∪ 名单（**无遗漏**——本条是 F1 的核心保护）', () => {
  const declared = allDeclaredSkills();
  const inPkg = inPackageSkills(declared);
  const covered = new Set([...inPkg, ...HOST_ONLY_SKILLS]);
  const uncovered = [...declared].filter((n) => !covered.has(n));
  assert.deepEqual(uncovered, [],
    '真实资产声明了这些技能名，但**包内无副本、名单也没登记** ⇒ 夹具将拒绝造桩。'
    + '请二选一：① 确属宿主侧技能 ⇒ 加入 `HOST_ONLY_SKILLS`；② 应随包分发 ⇒ 把真实 SKILL.md 收进 `skills/<name>/`。'
    + '（这条红的含义：**资产与技能可解析性之间的契约变了**，需要人裁定，不是随手补名单。）\n实际：' + JSON.stringify(uncovered));
});

test('F1-4 负向：未登记的名字走缺省路径 ⇒ 抛错（保护真在跑）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-skill-ledger-'));
  // ① 未登记 + 包内无副本 + 未声明 stub ⇒ 必须抛
  assert.throws(
    () => seedHostSkills(['definitely-not-a-real-skill-xyz'], home),
    (e) => /拒绝造桩/.test(e.message) && /definitely-not-a-real-skill-xyz/.test(e.message),
    '缺省路径必须拒绝未登记名字（否则门禁正向又会恒真）',
  );
  // ② 显式 stub ⇒ 放行（测试自造的合法通道）
  assert.doesNotThrow(() => seedHostSkills(['definitely-not-a-real-skill-xyz'], home, { stub: true }),
    '显式 { stub: true } = 测试自造声明 ⇒ 应放行');
  // ③ 名单内的宿主侧技能 ⇒ 放行且落桩
  const hostOnlySample = HOST_ONLY_SKILLS[0];
  assert.doesNotThrow(() => seedHostSkills([hostOnlySample], home), '名单内 ⇒ 放行');
  assert.ok(fs.existsSync(path.join(hostSkillsRoot(home), hostOnlySample, 'SKILL.md')), '应落 SKILL.md 桩');
  // ④ 包内有真实副本 ⇒ 复制真实正文（非桩）
  const inPkg = inPackageSkills(allDeclaredSkills());
  assert.ok(inPkg.length > 0, '前置：应存在包内真实副本的样本');
  seedHostSkills([inPkg[0]], home);
  const body = fs.readFileSync(path.join(hostSkillsRoot(home), inPkg[0], 'SKILL.md'), 'utf8');
  assert.ok(!/隔离宿主技能根夹具/.test(body), '包内已有真实副本 ⇒ 应复制真实正文，不得写桩');
});
