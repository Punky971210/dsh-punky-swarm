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

// 派发套件回归：`lane_dispatch` 合成的**任务包必须携带 lane 的 cmd / 角色 / 契约**
//   （2026-09-16 批次 suite-live-20260916 活体抓出：worker 回执报「目标：（未声明 cmd）」）
//   根因：派发处读 `batch.wavePlan.tasks`，而 `batch.wavePlan` 是 **wave 数组**
//   （`[{wave, tasks:[…]}]`）⇒ `.tasks` 恒 undefined ⇒ `laneTask` 恒 null ⇒ 任务包退化为空骨架。
//   本套件用桩 `ctx.subagents` 捕获真实 start spec，断言任务包文本含 cmd 且不含占位符。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { threeTierTasks, seedArtifacts, assessC, registerManager } from './helpers/gate-fixture.mjs';
import { withDefaultTeam } from './helpers/skill-paths.mjs';

// G7 下沉（2026-09-22）：harness 体迁入 helpers/dispatch-fixture.mjs；本文件一行适配（markCmd 断言标记）。
import { makeDispatchHarness } from './helpers/dispatch-fixture.mjs';
const harness = () => makeDispatchHarness({ SID: 'sess-dp', batchId: 'b-dp', markCmd: true });

// 【P1 同步】`team` 现为必填且必须解析到资产 ⇒ 本套件建批统一补 software-team。

const SID = 'sess-dp';


test('DP-1 任务包携带 lane 的 cmd（wavePlan 为 wave 数组时不得退化为「未声明 cmd」）', async () => {
  const { by, exec, captured } = await harness();
  const r = await by.lane_dispatch.execute({ batchId: 'b-dp', lane: 'e1' }, exec);
  assert.equal(r.spawned, true, '引擎自派应成功（桩 subagents）');
  assert.equal(captured.length, 1, 'start（one-shot）应被调用一次');
  const text = captured[0].prompt[0].text;
  assert.ok(text.includes('CMD-MARK-e1'), '任务包「目标」位必须含该 lane 的 cmd：\n' + text);
  assert.ok(!text.includes('（未声明 cmd）'), '不得退化占位符：\n' + text);
});

test('DP-2 任务包同时携带 layer / role / 契约（consume·outputs）与句柄首行', async () => {
  const { by, exec, captured } = await harness();
  await by.lane_dispatch.execute({ batchId: 'b-dp', lane: 'e1' }, exec);
  const text = captured[0].prompt[0].text;
  assert.ok(/层|layer/.test(text), '应含层信息');
  assert.ok(text.includes('coder') || text.includes('role'), '应含角色信息');
  assert.ok(text.includes('plan/spec.md'), '应含 consume 契约（plan/spec.md）');
  assert.ok(/swarm-lane:b-dp\/e1#/.test(text), '应含一次性句柄首行');
});
