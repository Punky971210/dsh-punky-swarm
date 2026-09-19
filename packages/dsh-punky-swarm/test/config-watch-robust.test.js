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

// R1-h 配置热更健壮性：两个**实测缺陷**的回归锚（2026-09-13）
//   缺陷 ① BOM 拒读：外部工具（PowerShell Set-Content -Encoding UTF8）写 runtime.json 会带 BOM，
//           `JSON.parse` 直接拒 → 覆盖层静默保持旧快照（实测日志 'Unexpected token'）。
//   缺陷 ② 一次性锁死：`watch()` 抛 EBUSY（Windows 文件被占）时原实现**永久降级**（不重试），
//           此后即便经官方 API 写入也不再热更（实测日志 'config hot reload disabled, restart to apply'）。
//   本文件断言：BOM 被容忍（覆盖层生效）；watch 失败退避重试并最终建立成功。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigWatcher } from '../lib/hot/config-watch.js';

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cw-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  return root;
}
function warnCollector() {
  const warns = [];
  return { warns, logger: { warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} } };
}

test('R1-h①：runtime.json 带 BOM → 覆盖层仍被读取（缺陷回归锚）', () => {
  const root = mkRoot();
  try {
    const overlay = { capabilities: { watch: { longrun: { maxDurationMs: 60000 } } } };
    writeFileSync(join(root, 'config', 'runtime.json'), '\uFEFF' + JSON.stringify(overlay), 'utf8');
    const { warns, logger } = warnCollector();
    const w = createConfigWatcher({ root, config: { capabilities: { watch: { enabled: true } } }, logger, useWatcher: false });
    w.start();
    const snap = w.readSnapshot();
    assert.equal(snap?.capabilities?.watch?.longrun?.maxDurationMs, 60000, 'BOM 不应导致覆盖层被弃用');
    assert.equal(warns.filter((m) => m.includes('initial read failed')).length, 0, '不应出现读取失败告警');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1-h②：watch 抛 EBUSY → 退避重试并最终建立（不再一次性锁死）（缺陷回归锚）', async () => {
  const root = mkRoot();
  try {
    writeFileSync(join(root, 'config', 'runtime.json'), JSON.stringify({ capabilities: { watch: { enabled: true } } }), 'utf8');
    const { warns, logger } = warnCollector();
    let calls = 0;
    const fakeWatcher = { close() {}, unref() {}, on() {} };
    const w = createConfigWatcher({
      root, config: {}, logger,
      watchFn: () => {
        calls += 1;
        if (calls <= 2) { const e = new Error('EBUSY: resource busy or locked'); throw e; }
        return fakeWatcher;
      },
    });
    w.start();
    assert.equal(calls, 1, '首拍尝试建立 watch');
    assert.ok(warns.some((m) => m.includes('retry 1/5')), '首拍失败 → 退避重试告警（含 retry 1/5）：' + warns.join(' | '));
    await new Promise((r) => setTimeout(r, 900)); // 覆盖两次退避（200ms + 400ms）
    assert.ok(calls >= 3, '退避后重试至成功（实际调用次数：' + calls + '）');
    assert.equal(warns.some((m) => m.includes('config hot reload disabled after')), false, '未到上限不应出现"永久禁用"告警');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1-h②：watch 持续失败 → 达上限才降级，且手动 reload 仍可用', async () => {
  const root = mkRoot();
  try {
    const overlay = { capabilities: { watch: { enabled: false } } };
    writeFileSync(join(root, 'config', 'runtime.json'), JSON.stringify(overlay), 'utf8');
    const { warns, logger } = warnCollector();
    const w = createConfigWatcher({
      root, config: { capabilities: { watch: { enabled: true } } }, logger,
      watchFn: () => { throw new Error('EBUSY: resource busy or locked'); },
    });
    w.start();
    assert.ok(warns.some((m) => m.includes('retry 1/5')));
    await w.reload(); // 手动 reload 不受 watch 状态影响（显式调用路径）
    assert.equal(w.readSnapshot()?.capabilities?.watch?.enabled, false, '手动 reload 仍能应用覆盖层');
    assert.equal(typeof w.reload, 'function');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
