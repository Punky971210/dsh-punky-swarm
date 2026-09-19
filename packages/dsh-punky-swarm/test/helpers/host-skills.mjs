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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * @returns {string} 技能根绝对路径
 */
export function seedHostSkills(names, home = process.env.USERPROFILE || process.env.HOME) {
  const root = hostSkillsRoot(home);
  fs.mkdirSync(root, { recursive: true });
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (name.length === 0) continue;
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const real = path.join(packageRootOf(), 'skills', name, 'SKILL.md');
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
