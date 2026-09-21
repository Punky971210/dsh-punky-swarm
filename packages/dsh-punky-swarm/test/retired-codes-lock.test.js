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

// 退役码登记锁（N2 收口 · G3 合并，2026-09-22）：
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

test('退役码登记锁：C 类 7 码在 lib/** 零字面量命中（防回生；散布锁已合并至此）', () => {
  const sources = libSources(join(process.cwd(), 'lib'));
  assert.ok(sources.length > 100, 'lib 源文件扫描面异常（应 >100 件）：' + sources.length);
  for (const code of RETIRED_CODES) {
    for (const f of sources) {
      const t = readFileSync(f, 'utf8');
      assert.ok(!t.includes(code), code + ' 已退役，不得出现在 ' + f + '（含注释——防 grep 误判活码）');
    }
  }
});
