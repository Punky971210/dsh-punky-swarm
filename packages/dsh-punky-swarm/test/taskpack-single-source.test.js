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

// test/taskpack-single-source.test.js —— 任务包入参单点（批 `punky-taskpack-cohesion-20261113`）
//
// 主张：`composeWorkerPrompt` 的 lane 黑板入参由 `taskpackInputOf` **唯一一份**组装，
//   两个生产入口（`lib/engine/dispatch-core.js` 自派档 / `lib/tools/query-tools.js` 的 `taskpack_for`）
//   只提供入口特有值（firstLine / leaderPrompt / artifactsRoot / injectBudget）与已解析 role。
//
// 反例如何能红：
//   · 任一入口回退成手抄入参（`checkpointDialect:` / `archContext:` 字面重新出现在入口文件里）⇒ 用例②必红；
//   · 单点里漏传 `subtasks`（历史事故）⇒ 用例①的 checkpoint 段不对称 / 用例③无强制档标题 ⇒ 必红；
//   · 单点里改用 `subtasks != null` 自判方言（绕过 `dialectOfLane`）⇒ 用例③的方言来源断言必红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeWorkerPrompt, taskpackInputOf } from '../lib/engine/dispatch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

const ROLE = Object.freeze({ id: 'coder', title: 'Coder', responsibilities: ['实现'], deliverables: ['报告'] });
const BATCH = Object.freeze({
  wavePlan: [{ wave: 1, tasks: [{ id: 'e1', layer: 'exec', subtasks: { items: [{ id: 's1', target: 'exec/a.md' }] } }] }],
});
const LANE_TASK = Object.freeze({
  id: 'e1',
  layer: 'exec',
  role: 'coder',
  cmd: '实现单点组装',
  consume: ['plan/spec.md'],
  produce: ['exec/a.md'],
  outputs: ['exec/a.md'],
  context: '项目上下文样例',
  subtasks: { items: [{ id: 's1', target: 'exec/a.md' }] },
  resume: false,
});

const render = (extra) => composeWorkerPrompt(taskpackInputOf({
  batchId: 'b-single', lane: 'e1', laneTask: LANE_TASK, batch: BATCH, sessionId: 'sess-single',
  roleData: ROLE, ...extra,
}));

/** 只保留「来自 lane 黑板」的行：目标 / 消费件 / 产出面 / 产物 四行。 */
const laneLines = (text) => text.split('\n').filter((l) => /^- \*\*(目标|消费件|产出面|产物)\*\*/.test(l));

/** 截取 checkpoint 段（含标题行，到下一条 `## ` 标题或结尾）。 */
function checkpointSection(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## .*checkpoint/i.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

// ══ ① 两入口特有值不同 ⇒ lane 黑板派生的行与 checkpoint 段必须逐字相同 ═════════════════════════
test('① 入口特有值（firstLine/leaderPrompt/artifactsRoot）不影响 lane 派生段', () => {
  const a = render({ firstLine: 'FIRST-LINE-A', leaderPrompt: '补充要点', artifactsRoot: '/root/a' });
  const b = render({ firstLine: undefined, leaderPrompt: '', artifactsRoot: '/root/b' });

  assert.deepEqual(laneLines(a), laneLines(b), 'lane 派生的四行必须两档逐字相同');
  assert.ok(laneLines(a).length >= 4, '前置：目标/消费件/产出面/产物四行都应在场，实测 ' + JSON.stringify(laneLines(a)));
  assert.deepEqual(checkpointSection(a), checkpointSection(b), 'checkpoint 段必须两档逐字相同（历史事故点）');
  assert.ok(checkpointSection(a).length > 0, '前置：exec + subtasks 必须渲染 checkpoint 段');
  assert.ok(!b.includes('补充要点'), '对照：空 leaderPrompt 不得出现任务要点正文');
  assert.ok(a.includes('补充要点'), '对照：给了 leaderPrompt 就必须出现（证明差异确实存在）');
});

// ══ ② 结构锁：两个生产入口都必须走单点，且不得再手抄方言/archContext ═══════════════════════════
test('② 两个生产入口都调 taskpackInputOf，且不再手写 checkpointDialect / archContext', () => {
  for (const rel of ['lib/engine/dispatch-core.js', 'lib/tools/query-tools.js']) {
    const src = fs.readFileSync(path.join(PKG, rel), 'utf8');
    assert.ok(src.includes('taskpackInputOf('), rel + ' 必须经 taskpackInputOf 组装任务包入参');
    for (const forbidden of ['checkpointDialect:', 'archContext:']) {
      assert.equal(src.includes(forbidden), false,
        rel + ' 不得再手写 `' + forbidden + '`（单点组装已接管；重抄即漂移面）');
    }
  }
});

// ══ ③ 方言来源：强制档由 batch 的 subtasks 方言决定（单点内 dialectOfLane），不靠 lane 级自判 ══
test('③ subtasks 方言 + exec ⇒ 强制档标题；legacy 批 ⇒ 建议档标题', () => {
  const strictText = render({ firstLine: 'X' });
  const legacyText = composeWorkerPrompt(taskpackInputOf({
    batchId: 'b-single', lane: 'e1',
    laneTask: { ...LANE_TASK, subtasks: null, checkpoints: [{ id: 'c1', target: 'exec/a.md' }] },
    batch: { wavePlan: [{ wave: 1, tasks: [{ id: 'e1', layer: 'exec' }] }] },
    sessionId: 'sess-single', roleData: ROLE, firstLine: 'X',
  }));
  const titleOf = (t) => (t.split('\n').find((l) => /^## .*checkpoint/i.test(l)) ?? '');
  assert.notEqual(titleOf(strictText), titleOf(legacyText),
    '两档标题必须不同（强制档 vs 建议档），实测：' + JSON.stringify([titleOf(strictText), titleOf(legacyText)]));
  assert.ok(/强制|逐项/.test(checkpointSection(strictText).join('\n')), '强制档须含逐项口径');
});
