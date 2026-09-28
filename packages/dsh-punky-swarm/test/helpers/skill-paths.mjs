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

// 【技能路径 helper · 只读半边】本模块是拆模块（批 `onto-fixture-purge-20260925`）后的**只读**半边——
//   旧 helper 模块（技能夹具与纯函数混装，本批已拆；迁移记录见批次产物 `exec/helper-change.md`）中
//   包根解析（`packageRootOf`）/ 宿主技能根推导（`hostSkillsRoot`）/ 资产声明技能名读端
//   （`declaredSkillsOf`）/ 建批面默认团队包装
//   （`withDefaultTeam`）。
//   【2026-09-28 · 批 `cleanup-tail-20260927` E-1 订正】原名单中的另两名（两个读团队资产文件的只读导出）
//   **已删除**：二者读的是已随批 3（`retire-team-chain-20260927`）整体退役的团队资产文件面 ⇒ 恒返
//   `null` / `[]` 的**孤儿导出**（零调用点、零消费方；实测佐证见 `plan/cleanup-spec.md` E-1）。
//
// ⚠ 本模块的**分界线是「只读 + 纯计算」**：文件在、目录不在。
//   写盘播种的夹具（`seedHostSkills` / `seedTeamAssetSkills`）与宿主侧技能名单（`HOST_ONLY_SKILLS`）
//   已随 `onto-fixture-purge-20260925` 删除，**不得**以任何形式回流到本文件——
//   本文件内**零** `node:fs` 写盘调用（建目录 / 写文件 / 删改重命名 / 流式写入各类 API 一律不出现，判据 J-4）。
//   【2026-09-28 · cleanup-tail】E-1 删两导出后本文件对 `node:fs` **零引用** ⇒ `import fs` 同步删除
//   （留死 import 违「不留死码」；本模块自此**无任何 fs 依赖**，与上句口径同向收窄）。
//
// 为什么拒绝写穿真实 home（迁移前 F2 纪律，原样留存；根因见 `reports/onto-skills-root-rca.md`）：
//   原 `seedHostSkills` 缺省 `home = process.env.USERPROFILE || process.env.HOME`：在**未加载隔离 preload**
//   的进程里它就是真实 `C:\Users\<user>`，于是该夹具把 `<真实home>\.agents\skills\<name>\SKILL.md`
//   **覆写成桩**（2026-09-18 / 09-21 两波实测，两波共 21 件）。
//   真实 home 真源 = `os.userInfo().homedir`——系统账户 API，不受 `USERPROFILE` / `HOME` 改写影响
//   （与 `isolated-home.preload.mjs:57-58` 同源）；守卫判据落在**任何写动作之前**（mkdir / readFile /
//   writeFile 全在其后）⇒ 未隔离运行只会抛错，不会产生副作用。
//
// 迁移前 F1 说明（同样留存）：静默造桩会让门禁 `TEAM_ASSET_SKILLS_MISMATCH` 的**正向命题在测试里恒真**
//   ——夹具为**任意**名字都造出可解析技能 ⇒ 资产里技能名拼错 / 改名 / 真实技能被删，测试全绿。
//   ⇒ 新纪律：夹具内容必须**显式签入可审**，且「造桩」这件事不得再散落在测试进程的任意时点。

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

/** 资产声明里出现的全部技能名（读端形状：`layers[*].skills[role] = [skill,…]`）。 */
export function declaredSkillsOf(asset) {
  const out = new Set();
  for (const layer of Object.values(asset?.layers ?? {})) {
    for (const arr of Object.values(layer?.skills ?? {})) for (const s of arr ?? []) out.add(s);
  }
  return [...out];
}

/**
 * 【P1 期 · 建批面默认团队（**历史注记已订正 2026-09-27**）】P1（2026-09-16）曾把 `wave_plan` 的 `team` 设为**必填**
 * （缺 ⇒ 参数面即拒；名字无资产 ⇒ 构造期拒），此后各套件为「没写 team」的建批调用补一个**有资产**的团队名。
 * 2026-09-27 用户裁决后 `team` 降为**可选标签**（缺省不再拒），本包装仍保留：它现在承担的是**显式声明批次标签**
 * （`team: 'software-team'`）与「建批只是手段」套件的统一来源，**不再是绕开门禁的手段**。
 * @param {object} byName 工具名 → 工具对象（`createTools` 产物）
 * @param {string} team 默认团队名（缺省仍取包内 `software-team`：装配/skill 前缀面按真实资产注入）
 */
export function withDefaultTeam(byName, team = 'software-team') {
  const raw = byName?.wave_plan;
  if (!raw || typeof raw.execute !== 'function') throw new Error('withDefaultTeam: wave_plan tool not found');
  byName.wave_plan = { ...raw, execute: (args, exec) => raw.execute({ team, ...args }, exec) };
  return byName;
}
