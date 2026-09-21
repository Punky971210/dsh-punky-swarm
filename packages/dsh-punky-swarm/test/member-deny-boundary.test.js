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
// 【批 5 · G1（2026-09-22 用户裁定「同语义就删」）】原 DB-1（deny 含 subagent*/subagent_fork 成员性）与
//   DB-3（leaked 普通工具/MCP 零泄漏 + length>=13）已删——均被 suite-consistency SC-1 的**精确全集 deepEqual**
//   （FROZEN_DENY 20 项）蕴含 ⇒ 单一权威在 SC，本处只保留 SC 覆盖不到的唯一维度：DB-2 **deny → toolFilter
//   落地面**（deny 常量必须真正经 buildStartRequest 进 worker 请求载荷，不是只写在常量里）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStartRequest } from '../lib/engine/dispatch.js';

const DISPATCH_TOOLS = ['subagent', 'subagent_fork'];

test('DB-2 上述 deny 必须真正落到 start request 的 toolFilter.deny（不是只写在常量里）', () => {
  const request = buildStartRequest({ batchId: 'b-db', lane: 'l1', parent: { id: 'a' }, prompt: 't' });
  const deny = request.toolFilter.deny;
  for (const t of DISPATCH_TOOLS) assert.ok(deny.includes(t), 'toolFilter.deny 缺失：' + t);
  assert.ok(deny.includes('wave_plan') && deny.includes('assign_check'), '原治理套件项不得丢失');
});
