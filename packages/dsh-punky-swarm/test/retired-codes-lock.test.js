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

// 退役码登记锁（N2 收口 · G3 合并，2026-09-22；2026-09-27 补登 GATE_SKILL_MISSING + teamsRoot 两码；
//   2026-09-27 批 3 补登 team-asset 全族 19 项 ⇒ 11 + 19 = **30**）：
//   数据源 = docs/gate-code-classification-2026-09-22.md C 类（码已退役、无任何拒态来源）。
//   单表遍历断言 lib/** 零字面量命中 —— 取代此前散布在 gate-lite-batch2 / concurrency-gate /
//   governance / writing-team-asset 四处的手写「已删零命中」变体（激进删除批 2，用户裁定）。
//   ⚠ 新增退役码时：在 contracts/事件表删除成员后，把码加入本清单即可获得全仓防回生覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RETIRED_CODES = [
  'GATE_SWARM_UNBOUND_REPORT', // gate-lite 第一批 · E②（Q-G2：身份门整条移除，成员回报 best-effort）
  'GATE_SUBAGENT_OUTSIDE_LANES', // gate-lite 第二批 · B（官方 profile disable 宿主派发工具）
  'GATE_CONCURRENCY_EXCEEDED', // Q-B 取消并发闸（高并发不得限流）
  'GATE_MANAGER_TERMINAL', // gate-lite 第二批 · A（Manager 在册判定改官方 roster 承抽）
  'GATE_MANAGER_PHASE_INVALID', // 同上
  'GATE_MANAGER_AGENT_ID_REQUIRED', // 同上（空 agentId ⇒ 不写记录、不抛错）
  'GATE_TEAM_ASSET_MISSING', // team-asset 解析前置化（装配前缀来源切换）
  'GATE_MANAGER_MISSING', // 收口告警删（2026-09-22 用户裁定：roster_gap 已承担在册缺口留痕；legacy 字段面退役）
  'GATE_SKILL_MISSING', // 【2026-09-27 补登】用户裁「技能 recommend 不再设门禁」⇒ 码已从引擎彻底移除（提交 b8380a8）
  // 【2026-09-27 补登 · 本批】依据用户裁决「team 降为可选标签（内容宽松）⇒ 相关门禁做退役处理」
  //   （覆盖性快照 reports/decision-team-optional-and-gate-retire-20260927.md §三 A 级「立即可退役」）：
  'GATE_TEAMS_ROOT_INVALID', // teamsRoot 词法/防逃逸拒态退役——原 `assert` 出口改「纯判定返回值」（`teamsRootLexicalProblem`），判据逐字保留、不再抛
  'GATE_TEAMS_ROOT_ASSET_NOT_FOUND', // teamsRoot 资产查找拒态退役——未接线函数 `assertTeamsRootAsset` 与本码同批删除（无 import/调用/测试引用）
  // ── 【2026-09-27 补登 · 批 3 `retire-team-chain-20260927` / lane `exec-delete-assets`】team-asset **全族退役** ──
  //   事由：用户 2026-09-27 裁决「team 类引擎内资产全部退役」；本批 D-5 = 「码面随本体删除 ⇒ **全部入退役锁**；
  //   锁前置 = `lib/**` **零字面量（含注释）**」。前置**已实测达成**（`lib/**` 110 件，排除 `*.d.ts`，逐码 0 命中；
  //   自扫原始输出见 `exec/delete-assets.md` §三）。本体删除 = `lib/assembly/team-asset.js`（装载器 + 码族）。
  //   · 码 **13 个**（原 `TEAM_ASSET_CODES` 全表）——其中 6 个（MISSING_FIELD / FIELD_NOT_ALLOWED / BAD_TYPE /
  //     SKILLS_MISMATCH / LAYER_UNKNOWN / REWORK_INVALID）亦曾被 `lib/assembly/chain.js` 的链校验复用
  //     （判据源 B-2 实测 59 处）：**链校验码族与资产码族同值同族**（`CHAIN_CODES` 逐字等于同名码值）
  //     ⇒ 不另立前缀、不重复登记；
  'TEAM_ASSET_NOT_FOUND',
  'TEAM_ASSET_BAD_JSON',
  'TEAM_ASSET_BAD_TYPE',
  'TEAM_ASSET_MISSING_FIELD',
  'TEAM_ASSET_FIELD_NOT_ALLOWED',
  'TEAM_ASSET_ENTRY_REQUIRE_UNKNOWN',
  'TEAM_ASSET_CONSUME_FIELD_NOT_ALLOWED',
  'TEAM_ASSET_CONTRACT_EMPTY',
  'TEAM_ASSET_CONTRACT_LEGACY',
  'TEAM_ASSET_LAYER_UNKNOWN',
  'TEAM_ASSET_ROLE_LEXICAL',
  'TEAM_ASSET_SKILLS_MISMATCH',
  'TEAM_ASSET_REWORK_INVALID',
  //   · 码族**本体定义项 4 个**（非码的标识符：码表 / 严重级表 / 资产目录名 / 资产文件名白名单）——
  //     判据源 A-10「登记范围 = `TEAM_ASSET_*` **全族**」⇒ 随本体删除者同入锁，防「族回生」；
  'TEAM_ASSET_CODES',
  'TEAM_ASSET_SEVERITY',
  'TEAM_ASSET_DIR',
  'TEAM_ASSET_FILENAMES',
  //   · 已删子族的**前缀**（原「牵头角色悬空」`TEAM_ASSET_LEAD_*` 码族，2026-09-26 `onto-engine-slim` 批删除；
  //     本批补登：锁前缀 = 锁全族，且当前 `lib/**` 零命中）；
  'TEAM_ASSET_LEAD_',
  //   · `teamsRoot` **留痕码**（判决源 A-10 明列于登记范围）：用户裁决 D-3「`teamsRoot` 参数一并退役」
  //     ⇒ 该码在 wave 3 已无发射点、`lib/**` 归零（实测 hits=0）；
  'TEAMS_ROOT_IGNORED',
];

function libSources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.tsbuild') continue;
      libSources(p, out);
    } else if (/\.(js|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

test('退役码登记锁：C 类 ' + RETIRED_CODES.length + ' 码在 lib/** 零字面量命中（防回生；散布锁已合并至此）', () => {
  const sources = libSources(join(process.cwd(), 'lib'));
  assert.ok(sources.length > 100, 'lib 源文件扫描面异常（应 >100 件）：' + sources.length);
  for (const code of RETIRED_CODES) {
    for (const f of sources) {
      const t = readFileSync(f, 'utf8');
      assert.ok(!t.includes(code), code + ' 已退役，不得出现在 ' + f + '（含注释——防 grep 误判活码）');
    }
  }
});
