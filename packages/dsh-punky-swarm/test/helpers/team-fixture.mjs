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

// 【F2 同步 · 团队资产夹具单点】`presets/<team>/team-asset.{json,yml}` 的**唯一**写入面。
//
// 为什么收在单点（夹具审计 `docs/fixture-audit-2026-09-21.md` §3.2，2026-09-21）：
//   全仓曾有 **29 个测试文件**各自 `mkdirSync + writeFileSync('team-asset.…')`，形态分两类 ——
//     ① 以**真实资产**为骨架、在自建根里改一处（`writeTempTeam` 6 份完全相同 + 2 份 `mkTeam*` 变体）；
//     ② **合成资产**（调用方自写 `{team, layers, roles, flows, chain}`）。
//   两类都不是「错」，但漂移风险不同：
//     · ① 的风险 = 「骨架被悄悄改小/改歪 ⇒ 测的不再是真实资产」（本模块 `writeRealTeamPkg` 让骨架**逐字节可核**）；
//     · ② 的风险 = 「自造声明的层/流程语义与真实资产脱节」（无法机器消除，只能**显式标注为合成**并登记）。
//   ⚠ 判读更正（相对台账首版）：`writeTempTeam` **本来就用真实资产骨架**，不属「自建资产」范畴；
//     台账首版把「装配（assembly）夹具」（`validateAssembly` / `DEFAULT_ASSEMBLY`）也算入团队资产 ⇒ 计数虚高。
//
// 两条纪律（承 R4-1d「结构性保证取代断言」与 F1「桩须显式声明」）：
//   · **不许在各测试文件里直接写 `team-asset.*`** —— 新增写入点必须走本模块（`test/fixture-team-ledger.test.js`
//     扫描全 `test/**`，白名单外的直接写入 ⇒ 红）；
//   · **合成资产必须走 `writeSyntheticTeam`**（名字自带「这是自造的」语义，人工一眼可辨，禁与真实资产混淆）。
import fs from 'node:fs';
import path from 'node:path';

// 【2026-09-27 批 3 · T-15/D-6 归因：**真实骨架三 API 已整体删除**】
//   删除项：`SKELETON_TEAM` / `REAL_FILENAME` / `readRealTeamAsset()` / `writeTempTeam()` / `writeRealTeam()`。
//   理由 = 其**唯一数据源**（`presets/<team>/team-asset.{json,yml}`，5 件）已随 **T-4/A-9** 整体删除（不留空壳 D-2），
//   且 `lib/assembly/team-asset.js` 装载器本体亦删除（**T-1**）⇒ 保留它们只会成为「读已删路径即抛」的调用地雷，
//   属**本批改动产生的孤儿面**（纪律：删除因本次改动而失效的代码）。
//   **存活面**（合成夹具，零真实资产依赖）：`writeSyntheticTeam()` / `SYNTHETIC_FILENAME` / `threeTierSyntheticTeam()`
//   —— 这三者不读包内资产，是本批后仍成立的夹具契约（`test/fixture-team-ledger.test.js` F2-5 / F2-6 在册）。

/** 团队资产文件名（合成夹具用；`team-asset.json` 与已删读端同名，保持形态可读）。 */
const SYNTHETIC_FILENAME = 'team-asset.json';

/**
 * **② 合成资产夹具**：把调用方**自写**的资产对象写到 `root/presets/<team>/team-asset.json`。
 * ⚠ 名字里的 `Synthetic` 是契约：调用方承认「这份声明的层/流程/链是**为本次命题构造**的，
 *   不保证与真实资产同形」⇒ 只应用于「测某个具体装配语义变体 / 建批只是手段」的用例。
 *   若命题是「真实资产能否正确加载/校验」，**必须**改用 `writeRealTeam`（骨架即真实资产）。
 *
 * 前置校验（fail-fast，防手滑造出读端根本载不动的资产）：
 *   `team` 非空、`layers` 为非空对象、每个 layer 有非空 `roles` 数组与 `skills` 对象。
 *   —— 只做「形状下限」检查，**不复制读端的完整校验**（读端校验是本仓被测对象，
 *   夹具若把它抄一遍就成了第二份判据；此处只挡「明显打错」）。
 *
 * @param {string} root 自建根（`presets/` 的父目录）
 * @param {string} team 团队名
 * @param {object} asset 合成资产
 * @param {{ filename?: string }} [opts]
 * @returns {object} 写入后的资产对象
 */
export function writeSyntheticTeam(root, team, asset, { filename = SYNTHETIC_FILENAME } = {}) {
  if (typeof team !== 'string' || team.trim().length === 0) {
    throw new Error('fixture: writeSyntheticTeam 需要非空团队名');
  }
  if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new Error('fixture: writeSyntheticTeam 的 asset 必须是对象（团队 ' + team + '）');
  }
  if (asset.layers === null || typeof asset.layers !== 'object' || Object.keys(asset.layers).length === 0) {
    throw new Error('fixture: writeSyntheticTeam 的 asset.layers 必须是非空对象（团队 ' + team + '）'
      + ' ⇒ 若这份资产其实来自真实骨架，请改用 writeRealTeam');
  }
  for (const [layer, def] of Object.entries(asset.layers)) {
    if (!Array.isArray(def?.roles) || def.roles.length === 0) {
      throw new Error('fixture: writeSyntheticTeam 的 layers.' + layer + '.roles 必须是非空数组（团队 ' + team + '）');
    }
    if (def.skills === null || typeof def.skills !== 'object') {
      throw new Error('fixture: writeSyntheticTeam 的 layers.' + layer + '.skills 必须是对象（团队 ' + team + '）');
    }
  }
  const dir = path.join(root, 'presets', team);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(asset, null, 2), 'utf8');
  return asset;
}

/**
 * **最小三层合成资产**（plan/exec/audit 各一角色）——供「建批只是手段」的套件共用。
 *
 * 来源：F2 收敛前，`handoff-gate` / `handoff-gate-hotconfig` / `p2-settle-handoff` 三处
 *   **逐字相同**的本地 `teamAsset()` 各写一份（18 行 ×3）⇒ 收进本模块单点。
 * ⚠ 它是**合成**资产（层/流程为最小可载形态），**不是** `presets/software-team` 的副本：
 *   命题若涉及真实装配语义，请改用 `writeRealTeam`。
 *
 * @param {string} team 团队名（写入 `asset.team`）
 * @returns {object} 资产对象
 */
export function threeTierSyntheticTeam(team) {
  return {
    team,
    layers: {
      plan: { roles: ['designer'], skills: { designer: ['dev-designer'] } },
      exec: { roles: ['coder'], skills: { coder: ['dev-coder'] } },
      audit: { roles: ['reviewer'], skills: { reviewer: ['report-blind-audit'] } },
    },
    flows: {
      plan: { produce_field: 'produce', entry_requires: [] },
      exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'] },
      audit: { produce_field: 'produce', entry_requires: ['consume'], audit_contract: { criteria_from: 'plan/**', verdict: ['pass', 'fail', 'skip'] } },
    },
  };
}
