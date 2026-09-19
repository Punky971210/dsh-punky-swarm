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

// D-6（2026-09-16 清债）回归：只读判定入口的**取值加固**——
//   活体疑因 guard 时刻 `arguments` 形状与执行期不同源（JSON 字符串 / 命令键名不同）而 fail-closed，
//   故 `commandOf` 兼容三种承载形态；**加固不得放松 fail-closed**（写命令在任何形态下都必须判非只读）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandOf, isReadOnlyShellCall } from '../lib/tools/readonly.js';

const READONLY_CMD = "Get-ChildItem 'C:\\x' | Select-Object -ExpandProperty Name";
const WRITE_CMD = 'Set-Content -Path x -Value y';

test('RO-1 commandOf：对象 command / JSON 字符串 / 裸串 / 多键名 / 非法形态', () => {
  assert.equal(commandOf({ command: READONLY_CMD }), READONLY_CMD);
  assert.equal(commandOf(JSON.stringify({ command: READONLY_CMD })), READONLY_CMD, 'JSON 字符串形态须解出');
  assert.equal(commandOf(READONLY_CMD), READONLY_CMD, '裸命令文本原样返回');
  assert.equal(commandOf({ cmd: READONLY_CMD }), READONLY_CMD);
  assert.equal(commandOf({ script: READONLY_CMD }), READONLY_CMD);
  assert.equal(commandOf({ commandLine: READONLY_CMD }), READONLY_CMD);
  assert.equal(commandOf({ other: 1 }), undefined);
  assert.equal(commandOf(null), undefined);
  assert.equal(commandOf(42), undefined);
  assert.equal(commandOf('{"notCommand":1}'), '{"notCommand":1}', 'JSON 但无 command 键 ⇒ 当裸文本，交由判定器 fail-closed');
});

test('RO-2 isReadOnlyShellCall：三种承载形态都判只读；写命令一律不放行（加固不放松）', () => {
  assert.equal(isReadOnlyShellCall({ name: 'pwsh', arguments: { command: READONLY_CMD } }), true);
  assert.equal(isReadOnlyShellCall({ name: 'pwsh', arguments: JSON.stringify({ command: READONLY_CMD }) }), true);
  assert.equal(isReadOnlyShellCall({ name: 'pwsh', arguments: { cmd: READONLY_CMD } }), true);
  assert.equal(isReadOnlyShellCall({ name: 'pwsh', arguments: JSON.stringify({ command: WRITE_CMD }) }), false);
  assert.equal(isReadOnlyShellCall({ name: 'pwsh', arguments: { cmd: WRITE_CMD } }), false);
  assert.equal(isReadOnlyShellCall({ name: 'pwsh', arguments: { command: WRITE_CMD } }), false);
  assert.equal(isReadOnlyShellCall({ name: 'write', arguments: { command: READONLY_CMD } }), false, '非 shell 工具恒 false');
  assert.equal(isReadOnlyShellCall({ name: 'pwsh' }), false, '无参数 ⇒ fail-closed');
});
