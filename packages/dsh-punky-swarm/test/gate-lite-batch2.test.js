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

// gate-lite 第二批：仅剩 E③（`presets/punky-preset/references/discipline.md` 旧口径文本订正）。
//   【2026-11-08 裁撤】A2（Manager 承抽官方 roster 的读端）四条用例随「独立 Manager 成员」整层删除一并移除：
//   被测面 `wave_plan.managerPlan` / `wave_plan.managerRoster` / `batch_status.managerRoster` /
//   事件 `gate.manager_roster_gap` 均已不存在；随之失去用途的夹具（rosterService / threeTier / buildBatch /
//   makeHarness / mkCtx）同期清除，保留 `scan` 辅助函数与 T6。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 静态面（防回生 / 残留清理）────────────────────────────────────────────
function scan(dir, re, exts = ['.js', '.ts']) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...scan(p, re, exts)); continue; }
    if (!exts.includes(path.extname(e.name)) || e.name.endsWith('.d.ts')) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (re.test(src)) out.push(path.relative(PKG, p).replace(/\\/g, '/'));
  }
  return out;
}

// 【N2 收口 · G3 合并（2026-09-22）】原 T4「GATE_TEAM_ASSET_MISSING 防回生」与 T5 的枚举零命中断言
//   已合并至 test/retired-codes-lock.test.js（退役码单表锁）；T5 仅保留 d.ts 同步检查（生成物独有维度）。

test('T6 E③：discipline.md 旧口径文本已订正（不再出现「未绑定即拒」）', () => {
  const src = fs.readFileSync(path.join(PKG, 'presets/punky-preset/references/discipline.md'), 'utf8');
  assert.ok(!/未绑定即拒/.test(src), '旧口径文本须已订正');
  assert.ok(/未绑定不再拒/.test(src), '新口径文本在位');
});
