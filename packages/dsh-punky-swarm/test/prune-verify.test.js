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

// 批 3 · 未接线导出删除辅助（N2/C1 激进档，docs/c1-wiring-audit-2026-09-22.md）：
//   枚举 lib 内指定符号的**残留引用**（供删除后核对清零；机器底稿，非行为测试）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRUNED = [
  ['lib/engine/dispatch.js', 'parseLabel'],
  ['lib/bridge/lane-handle.js', 'sweepExpiredHandles'],
  ['lib/governance/state-store.js', 'clearSessionState'],
  // 【判读更正（2026-09-22）】DEFAULT_ESCALATION_WINDOW_MS（escalation.js 同文件默认参数消费，生产在役）
  //   与 auditlogStats/sinkFilePath（sink 测试观测钩，probe 依赖）已从删除清单移出并恢复。
  ['lib/acps/registry-client.js', 'decryptEabCredential'],
  ['lib/acps/registry-client.js', 'API_BASE_PATH'],
  ['lib/acps/registry-client.js', 'ATR_BASE_PATH'],
  ['lib/acps/discovery-client.js', 'flattenAgentSkills'],
  ['lib/aip/agent-descriptor.js', 'ACS_REQUIRED_FIELDS'],
  ['lib/aip/agent-descriptor.js', 'ACS_SKILL_REQUIRED_FIELDS'],
  ['lib/aip/identity.js', 'isEntityAic'],
  ['lib/assembly/audit-blind-review.js', 'BLIND_REVIEW_ORDER'],
  ['lib/state/lane-exempt.js', 'DEFAULT_THRESHOLD_MULTIPLIER'],
  ['lib/state/machine.js', 'RATCHET_RULES'],
  ['lib/wave-plan.js', 'MANAGER_PLANS'],
  ['lib/schema.js', 'assertMemberTransition'],
  ['lib/schema.js', 'assertBatchTransition'],
  ['lib/artifact-types.js', 'artifactTypeOf'],
  ['lib/artifact-types.js', 'typesOfLayer'],
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

test('批 3 删除核对：被删符号在 lib/** 零引用（导出与残留一并清除）', () => {
  const sources = libSources(join(process.cwd(), 'lib'));
  const residue = [];
  for (const [file, sym] of PRUNED) {
    for (const f of sources) {
      const t = readFileSync(f, 'utf8');
      if (t.split(sym).length - 1 > (f.replace(/\\/g, '/').endsWith(file) ? 1 : 0)) {
        residue.push(sym + ' @ ' + f.replace(/\\/g, '/'));
      }
    }
  }
  assert.deepEqual(residue, [], '被删符号仍有 lib 引用：\n' + residue.join('\n'));
});
