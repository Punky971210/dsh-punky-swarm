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

// 成员 deny 列表**边界**回归（2026-09-16 用户裁决）：
//   「成员侧只禁主 Agent 的派发工具」≡「禁止成员嵌套派发」⇒ `subagent`/`subagent_fork` 必须入列；
//   且口径边界为「**MCP 等普通工具对成员全量开放**」⇒ 列表只收治理/派发套件，不得扩到普通工具。
//   背景（为何 deny 是唯一落实点）：宿主 `maxDepth` 判据是 `childDepth > maxDepth`
//   （`dsh-subagent/lib/index.js:432-436`），我们传的 `maxDepth:1` 只约束「创建该子会话」，
//   不约束子会话再派（它再派时用自己那层的 `tool-subagent` 配置，preset 未设 ⇒ 宿主默认 3）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SUITE_DENY_TOOLS, buildStartRequest } from '../lib/engine/dispatch.js';

const DISPATCH_TOOLS = ['subagent', 'subagent_fork'];

test('DB-1 成员 deny 列表必须含 subagent / subagent_fork（禁止成员嵌套派发）', () => {
  for (const t of DISPATCH_TOOLS) {
    assert.ok(SUITE_DENY_TOOLS.includes(t), '成员 deny 列表缺失：' + t);
  }
});

test('DB-2 上述 deny 必须真正落到 start request 的 toolFilter.deny（不是只写在常量里）', () => {
  const request = buildStartRequest({ batchId: 'b-db', lane: 'l1', parent: { id: 'a' }, prompt: 't' });
  const deny = request.toolFilter.deny;
  for (const t of DISPATCH_TOOLS) assert.ok(deny.includes(t), 'toolFilter.deny 缺失：' + t);
  assert.ok(deny.includes('wave_plan') && deny.includes('assign_check'), '原治理套件项不得丢失');
});

test('DB-3 边界：deny 列表只收治理/派发套件，**不得**收 MCP 等普通工具（用户口径）', () => {
  const ordinary = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'web_search', 'skill', 'todo_write'];
  const leaked = SUITE_DENY_TOOLS.filter((t) => t.startsWith('mcp__') || ordinary.includes(t));
  assert.deepEqual(leaked, [], '不得把 MCP / 普通工具列入成员 deny：' + JSON.stringify(leaked));
  assert.ok(SUITE_DENY_TOOLS.length >= 13, '补入两件派发工具后应 ≥13 项，实测 ' + SUITE_DENY_TOOLS.length);
});
