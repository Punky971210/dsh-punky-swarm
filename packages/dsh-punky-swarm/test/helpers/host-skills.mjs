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

// 【P1 同步 · 宿主技能根夹具】`presets/<team>/team-asset.yml` 的每个 role 都必须声明**可解析**的技能名
//   （P1 语义：非空 **且可在宿主技能根 `~/.agents/skills` 解析**，不可解析 = `TEAM_ASSET_SKILLS_MISMATCH` 拒建批；
//   技能根不存在 / 不可读 ⇒ 同码拒，不静默跳过）。
//
// 为什么需要它：测试进程跑在 `isolated-home.preload.mjs` 重定向出的**空** HOME 下，该根下没有 `.agents/skills`，
//   于是「团队资产 → 建批」这条路径在 P1 后**一律拒**（fail-closed 的应有之义）。本模块把「隔离宿主的技能根」
//   按**显式 env**（`USERPROFILE || HOME` + `.agents/skills`，与引擎读端**同源**、零新变量）造齐——只在需要的
//   套件里显式调用，**不做全局注入**（避免把与本命题无关的 fixture 一并改语义）。
//
// 口径（与引擎建批期技能解析面同源）：
//   可解析名 = 技能**目录名** ∪ `SKILL.md` frontmatter 的 `name`；本模块两者同时落（目录名 = 名，frontmatter name 同名）。
//   同名技能若包内 `skills/<name>/SKILL.md` 存在 ⇒ 复制其真实正文；否则写最小 frontmatter 桩（宿主侧技能）。
//
// ⚠ **2026-09-21 F1：桩从「静默缺省」改为「显式声明」**（夹具审计见 `docs/fixture-audit-2026-09-21.md` §3.1）
//   原因：静默造桩会让门禁 `TEAM_ASSET_SKILLS_MISMATCH` 的**正向命题在测试里恒真** ——
//   夹具为**任意**名字都造出可解析技能 ⇒ 资产里技能名拼错 / 改名 / 真实技能被删，测试全绿
//   （实测：5 份真实资产共声明 30 个技能名，其中 **27 个**包内无副本 ⇒ 那 27 条正向命题从未被真正验证）。
//   新纪律（承 R4-1d「结构性保证取代断言」）：
//     · **读真实资产**的路径（`seedTeamAssetSkills`）维持缺省 ⇒ 名字必须命中「包内真实副本 ∪ HOST_ONLY_SKILLS」，
//       否则**抛错** ⇒ 资产新增/改名技能而名单没同步 ⇒ 测试立刻红，由人裁定「宿主侧合法 / 拼错」；
//     · **测试自造技能名**（临时团队资产）⇒ 调用方须**显式**传 `{ stub: true }`，把「我知道这个名不在包里」写进代码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 包内**无** `SKILL.md` 副本、但确属**宿主侧技能库**的技能名（= 真实团队资产声明的技能减去包内已有副本）。
 * ⚠ 本名单是「资产声明面」的显式快照：任一侧变化（资产改名/新增、包内增删副本）都会让
 *   `test/fixture-skill-ledger.test.js` 的三条双向断言变红 ⇒ **必须同步本名单或补副本**，不得默认放过。
 */
export const HOST_ONLY_SKILLS = Object.freeze([
  'ara-compiler', 'ara-research-manager', 'ara-rigor-reviewer', 'arxiv-translator',
  'baoyu-markdown-to-html', 'brainstorming', 'citation-evaluator', 'codebase-design',
  'comfyui-use', 'decision-mapping', 'dev-coder', 'doc-generator', 'efficient-edit',
  'humanizer', 'interaction-design-principles', 'lieflat-less-ai-tone',
  'receiving-code-review', 'requesting-code-review', 'revision-patterns', 'spec-writing',
  'systematic-debugging', 'tech-benchmark-planning', 'test-driven-development',
  'verification-before-completion', 'wechat-writing-style', 'writing-plans', 'writing-trio',
]);

/** 包根（`test/helpers/` → 包根）。 */
export function packageRootOf() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/** 隔离宿主技能根（与引擎读端同源：`USERPROFILE || HOME` + `.agents/skills`）。 */
export function hostSkillsRoot(home = process.env.USERPROFILE || process.env.HOME) {
  return path.join(home, '.agents', 'skills');
}

/**
 * 把给定技能名注入当前（或指定）宿主技能根。
 * @param names 技能名数组
 * @param home 宿主 home（缺省 = 隔离 HOME）
 * @param opts.stub `true` ⇒ **显式声明**「这些名字是测试自造的、包内可以没有真实副本」⇒ 允许写桩。
 *   缺省 `false` ⇒ 名必须命中「包内真实 `SKILL.md` ∪ `HOST_ONLY_SKILLS`」，否则**抛错**
 *   （防「静默造桩 ⇒ 门禁正向恒真」，见文件头 F1 说明）。
 * @returns {string} 技能根绝对路径
 */
export function seedHostSkills(names, home = process.env.USERPROFILE || process.env.HOME, { stub = false } = {}) {
  const root = hostSkillsRoot(home);
  fs.mkdirSync(root, { recursive: true });
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (name.length === 0) continue;
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const real = path.join(packageRootOf(), 'skills', name, 'SKILL.md');
    if (!fs.existsSync(real) && !stub && !HOST_ONLY_SKILLS.includes(name)) {
      throw new Error('fixture: 技能名 "' + name + '" 在包内无可解析副本，且未登记为宿主侧技能（HOST_ONLY_SKILLS）'
        + ' ⇒ 拒绝造桩。\n  若它来自**真实团队资产**：说明资产已改名/新增技能而名单未同步 ⇒ 请更新 '
        + 'HOST_ONLY_SKILLS（或把真实 SKILL.md 收进包内 skills/）。\n'
        + '  若它是**测试自造**的名字：请显式传 `{ stub: true }`（把「包内没有它」写进代码，不要依赖缺省）。');
    }
    const body = fs.existsSync(real)
      ? fs.readFileSync(real, 'utf8')
      : '---\nname: ' + name + '\n---\n# ' + name + '（隔离宿主技能根夹具）\n';
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  }
  return root;
}

/** 资产声明里出现的全部技能名（读端形状：`layers[*].skills[role] = [skill,…]`）。 */
export function declaredSkillsOf(asset) {
  const out = new Set();
  for (const layer of Object.values(asset?.layers ?? {})) {
    for (const arr of Object.values(layer?.skills ?? {})) for (const s of arr ?? []) out.add(s);
  }
  return [...out];
}

/** 读包内团队资产原文（`.json` → `.yml`，内容是 JSON 子集）；不存在 ⇒ null（不静默回退）。 */
export function readTeamAssetSource(team, root = packageRootOf()) {
  for (const f of ['team-asset.json', 'team-asset.yml']) {
    const p = path.join(root, 'presets', team, f);
    if (fs.existsSync(p)) return { path: p, asset: JSON.parse(fs.readFileSync(p, 'utf8')) };
  }
  return null;
}

/** 把某团队的**全部声明技能**注入宿主技能根（载荷来自包内资产原文）。 */
export function seedTeamAssetSkills(team, root = packageRootOf()) {
  const src = readTeamAssetSource(team, root);
  if (!src) throw new Error('team asset not found: ' + team + ' @ ' + root);
  seedHostSkills(declaredSkillsOf(src.asset));
  return src;
}

/** 动态扫描包内**有资产**的团队名（`presets/<team>/team-asset.{json,yml}`）——禁把「预设/模式名」当团队名。 */
export function listTeamAssetNames(root = packageRootOf()) {
  const dir = path.join(root, 'presets');
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (['team-asset.json', 'team-asset.yml'].some((f) => fs.existsSync(path.join(dir, e.name, f)))) out.push(e.name);
  }
  return out.sort();
}

/**
 * 【P1 同步 · 建批面默认团队】P1 起 `wave_plan` 的 `team` **必填**（缺 ⇒ 参数面即拒；名字无资产 ⇒ 构造期拒）
 * ⇒ 既有套件里「没写 team」的建批调用需要补一个**有资产**的团队名。本函数把该默认值**收在夹具一处**：
 * 包一层 `execute`，`{ team, ...args }` ⇒ **调用方显式传的 team 优先**（不覆盖、不改写既有断言面）。
 * 纪律：只在「建批只是手段、被检面是别的门禁」的套件里使用；断言 `team` 必填/无资产拒的用例（如
 * `team-asset-mandatory.test.js`）**不得**经过本包装。
 * @param {object} byName 工具名 → 工具对象（`createTools` 产物）
 * @param {string} team 默认团队名（须是包内**有资产**的团队）
 */
export function withDefaultTeam(byName, team = 'software-team') {
  const raw = byName?.wave_plan;
  if (!raw || typeof raw.execute !== 'function') throw new Error('withDefaultTeam: wave_plan tool not found');
  byName.wave_plan = { ...raw, execute: (args, exec) => raw.execute({ team, ...args }, exec) };
  return byName;
}
