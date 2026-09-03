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

// client.js 拼装同步校验（既有 TBD-3 机制，契约 §6）：lib/panel/*.js 的 [panel-segment] 段
// 必须与 lib/client.js 内对应段逐字节一致。R3 触及 main.js/locales.js 两段；本测试覆盖全部六段。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const client = fs.readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8');

const PANEL_FILES = ['locales', 'theme', 'widgets', 'batch-list', 'batch-detail', 'main'];

function extractClientSegment(clientText, marker) {
  const start = clientText.indexOf(marker);
  assert.ok(start >= 0, 'client.js 缺失段标记: ' + marker);
  // 段文本含标记行（与 panel 源文件 marker→EOF 对齐）
  const rel = clientText.slice(start + marker.length);
  const nextMarker = rel.indexOf('// ===== [panel-segment]');
  if (nextMarker >= 0) return clientText.slice(start, start + marker.length + nextMarker);
  // 末段（main.js）：段尾 = `    return module.exports;` 行尾（含换行）
  const idx = rel.indexOf('    return module.exports;');
  assert.ok(idx >= 0, 'client.js 末段缺 module.exports 尾');
  const lineEnd = rel.indexOf('\n', idx);
  assert.ok(lineEnd >= 0, 'client.js 末段缺换行');
  return clientText.slice(start, start + marker.length + lineEnd + 1);
}

for (const name of PANEL_FILES) {
  test('[panel-segment] ' + name + '.js 与 lib/client.js 逐字节一致', () => {
    const src = fs.readFileSync(path.join(repo, 'lib', 'panel', name + '.js'), 'utf8');
    const marker = '// ===== [panel-segment] ' + name + '.js =====';
    const segStart = src.indexOf(marker);
    assert.ok(segStart >= 0, 'panel 源文件缺失段标记: ' + marker);
    const segText = src.slice(segStart); // 标记行起至 EOF（逐字节）
    const cseg = extractClientSegment(client, marker);
    assert.equal(cseg, segText, name + '.js 段与 client.js 不一致（字节级）');
    assert.equal(Buffer.byteLength(cseg, 'utf8'), Buffer.byteLength(segText, 'utf8'), name + '.js 段字节数不一致');
  });
}

test('client.js 与 panel 源文件均为 LF 行尾（逐字节同步的前提）', () => {
  for (const name of PANEL_FILES) {
    const src = fs.readFileSync(path.join(repo, 'lib', 'panel', name + '.js'), 'utf8');
    assert.ok(!src.includes('\r'), name + '.js 含 CR 行尾，破坏逐字节契约');
  }
  assert.ok(!client.includes('\r'), 'client.js 含 CR 行尾，破坏逐字节契约');
});
