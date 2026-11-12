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

// test/checkpoint-render.test.js —— 批 `punky-checkpoint-enforce-20261112` · lane `e1-schema`
//
// 判据源：`plan/checkpoint-enforce-spec.md` §C 渲染（e1 面）：
//   · V-9  双声明优先（`dual-declare`）
//   · V-11 强制档措辞置换（`strict-wording`）
//   · V-12 建议档逐字不动（`suggest-wording-byte-equal`，sha256 字节级）
//   · V-13 两档任务包同源（`taskpack-parity`）
//
// 反例如何能红：
//   · V-11 把任一弱化措辞（建议 / 由你自己填 / 引擎不与）留在强制档 ⇒ 禁词断言必红；
//     把 `（强制）` 分支的判据写反（只看 dialect 不看 layer）⇒ plan 层也会走强制档 ⇒ V-12 必红；
//   · V-12 改动建议档任一字符（含把 aux-absent 行统一换成强制档文案）⇒ sha256 必不等于 HEAD 常量；
//   · V-13 只改 `dispatch-core.js` 或只改 `query-tools.js` 一处 ⇒ 两档段落必然不等 ⇒ 必红。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { composeWorkerPrompt } from '../lib/engine/dispatch.js';
import { renderCheckpointsBlock, subtasksOf } from '../lib/engine/dispatch-preflight.js';
import { makeDispatchHarness } from './helpers/dispatch-fixture.mjs';

const sha256 = (s) => createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest('hex');

const TITLE = '## checkpoint 计划';
const NOTICE = '> 本 lane 的 checkpoints 已被 subtasks 取代';

/** 取任务包内 checkpoint 段（含「双声明取代说明」行，若有）；到下一个 `\n## ` 为止、去尾随空行。 */
function cpBlockOf(prompt) {
  const s = String(prompt);
  const titleAt = s.indexOf(TITLE);
  if (titleAt < 0) return null;
  const noticeAt = s.indexOf(NOTICE);
  //   取代说明与标题之间只允许一个换行（`startsWith` 而非 `===`：说明行尾还带「（subtasks 优先）」）。
  const start = (noticeAt >= 0 && noticeAt < titleAt
    && s.slice(noticeAt, titleAt).trim().startsWith(NOTICE)) ? noticeAt : titleAt;
  const rest = s.slice(titleAt + TITLE.length);
  const end = rest.indexOf('\n## ');
  return (s.slice(start, titleAt) + TITLE + (end < 0 ? rest : rest.slice(0, end))).replace(/\n+$/, '');
}

/** `composeWorkerPrompt` 最小入参（`role: null` ⇒ 零语料 I/O ⇒ 输出确定性）。 */
const baseArgs = (extra = {}) => ({
  batchId: 'b-ckpt-render', lane: 'e1', cmd: '夹具目标行', layer: 'exec', role: null, firstLine: 'HANDLE', ...extra,
});

const SUBTASKS = { items: [
  { id: 's1', target: 'exec/s1.md', outputs: [], acceptance: '', rounds: 1, ctxBudget: null },
  { id: 's2', target: 'exec/s2.md', outputs: [], acceptance: '', rounds: 1, ctxBudget: null, kb: ['k1'] },
] };

// ══ V-11 强制档措辞置换（`strict-wording`）═════════════════════════════════════════════════
test('strict-wording [V-11] exec + subtasks ⇒ 强制档：三处弱化措辞逐字零命中，三处硬要求齐备', () => {
  const text = composeWorkerPrompt(baseArgs({ subtasks: SUBTASKS }));
  const block = cpBlockOf(text);
  assert.ok(block, '任务包必须含 `## checkpoint 计划` 段（否则本判据无对象）');
  assert.match(block.split('\n')[0], /（强制）$/,
    '`layer=exec` + 新方言 ⇒ 段标题须带「（强制）」；实测首行=' + JSON.stringify(block.split('\n')[0]));

  for (const weak of ['建议', '由你自己填', '引擎不与']) {
    assert.equal(block.includes(weak), false,
      '强制档不得残留自我弱化措辞「' + weak + '」（spec §P-2 三处）：\n' + block);
  }
  for (const hard of ['GATE_CHECKPOINTS_INCOMPLETE', 'subtaskId', 'total 必须等于']) {
    assert.ok(block.includes(hard), '强制档必须含硬要求「' + hard + '」：\n' + block);
  }
  // ①② 由引擎给定的 total 与「按序」义务
  assert.ok(block.includes('共 ' + SUBTASKS.items.length + ' 个 checkpoint'), '须点名 checkpoint 个数（= subtasks.length）');
  assert.match(block, /必须按\*\*声明序\*\*逐项/, '须要求**按声明序**逐项留痕');
  // ③ 不得自建进度规划（Leader 点名要求的越界禁令）
  assert.match(block, /不得自建进度规划/, '须明写「不得自建进度规划」');
  assert.match(block, /越界先回报/, '须明写「越界先回报」');
  // ④ 逐项 id 仍按声明序渲染（措辞置换不得吞掉逐项行）
  assert.ok(block.includes('- `s1` → exec/s1.md'), '逐项行（id → target）两档共用，不得被置换掉');
  assert.ok(block.indexOf('`s1`') < block.indexOf('`s2`'), '逐项行须保声明序');
});

// ══ V-12 建议档逐字不动（`suggest-wording-byte-equal`）════════════════════════════════════
test('suggest-wording-byte-equal [V-12] 建议档产出与 HEAD fcf3a06 的 sha256 逐字节相等', () => {
  // 黄金常量来源（对照组，纪律 0v）：对 `git show fcf3a06:packages/dsh-punky-swarm/lib/engine/dispatch-preflight.js`
  //   的 `renderCheckpointsBlock` 源码求值后测得 —— 探针原件随本 lane 产物落盘：
  //   `e1-schema/probe/head-render-baseline.mjs`（输出 `EQUAL` × 6 + 下列 sha256 读数）。
  const GOLDEN = [
    {
      name: 'items-3',
      fixture: [{ id: 'c1', target: 'exec/a.md' }, { id: 'c2', target: 'exec/b.md', rounds: 2 }, { id: 'c3', target: '' }],
      sha: '39f3251b5df3e720d180a8cf91c08fe81b9d56837d7ad1b3460f60f6b1f7f232',
      bytes: 619,
    },
    {
      name: 'items-with-aux',
      fixture: [{ id: 'c1', target: 'exec/a.md', kb: ['k1'], skills: ['s1'], mcp: [{ tool: 't1' }], checklist: ['x'] }],
      sha: '0801dc4ff0bd1d5378be52b7c5ab58f99e96a6b294775d2b9656bed61f5c8cf5',
      bytes: 309,
    },
    {
      name: 'empty-array',
      fixture: [],
      sha: '7041f8f5a61cdaab65f5b9ebd64496e3e32545f73ca4816b89500a40e9b8e7c4',
      bytes: 289,
    },
  ];
  for (const g of GOLDEN) {
    // 四种「建议档」调用形态都必须落到同一份字节：单参 / 显式 legacy / legacy 批的 exec lane / layer≠exec 的新方言 lane
    const shapes = [
      renderCheckpointsBlock(g.fixture), // 既有单参调用（零破坏）
      renderCheckpointsBlock(g.fixture, { layer: 'exec', dialect: 'legacy' }),
      renderCheckpointsBlock(g.fixture, { layer: null, dialect: 'legacy' }),
      renderCheckpointsBlock(g.fixture, { layer: 'plan', dialect: 'subtasks' }), // 非 exec 层只许建议档
      renderCheckpointsBlock(g.fixture, { layer: 'audit', dialect: 'subtasks' }),
    ];
    for (const [i, out] of shapes.entries()) {
      assert.equal(sha256(out), g.sha,
        g.name + ' 形态#' + i + '：建议档须与 HEAD 逐字节相同（实测 ' + Buffer.byteLength(out, 'utf8')
        + 'B / ' + sha256(out) + '）');
      assert.equal(Buffer.byteLength(out, 'utf8'), g.bytes, g.name + ' 形态#' + i + '：字节数须与 HEAD 相同');
    }
  }
  // 建议档仍保留 HEAD 的三处原文（只证明「逐字沿用」不是靠删空实现取巧）
  const legacy = renderCheckpointsBlock([{ id: 'c1', target: 'exec/a.md' }]);
  assert.ok(legacy.includes('建议'), '建议档（legacy 批）须仍含 HEAD 的「建议」措辞 —— V-12 是逐字保留，不是统一改写');
  assert.ok(legacy.includes('由你自己填'), '建议档须仍含 HEAD 的「由你自己填」');
  assert.ok(legacy.includes('引擎不与'), '建议档须仍含 HEAD 的「引擎不与」');
});

// ══ V-9 双声明优先（`dual-declare`）═══════════════════════════════════════════════════════
test('dual-declare [V-9] 同 lane 双声明 ⇒ 只渲染 subtasks、首行注明取代', () => {
  const text = composeWorkerPrompt(baseArgs({
    subtasks: { items: [{ id: 's1', target: 'exec/s1.md' }] },
    checkpoints: [{ id: 'c1', target: 'exec/c1.md' }],
  }));
  const block = cpBlockOf(text);
  assert.ok(block, '任务包必须含 checkpoint 段');
  assert.ok(block.includes('`s1`'), '有效声明（subtasks）必须被渲染');
  assert.equal(block.includes('`c1`'), false, '被取代的 checkpoints 不得参与渲染（否则门/渲染两套真源）');
  assert.equal(block.split('\n')[0], NOTICE + '（subtasks 优先）',
    '取代说明须落在渲染块**首行**（spec §4.2 第 3 行逐字）：实测首行=' + JSON.stringify(block.split('\n')[0]));
});

// ══ V-13 两档任务包同源（`taskpack-parity`）═══════════════════════════════════════════════
test('taskpack-parity [V-13] lane_dispatch 自派与 taskpack_for 取件的 checkpoint 段逐字相等', async () => {
  const { by, exec, captured, batchId } = await makeDispatchHarness({
    SID: 'sess-ckpt-render', batchId: 'b-ckpt-parity',
    taskExtra: { subtasks: [{ id: 's1', target: 'exec/s1.md' }, { id: 's2', target: 'exec/s2.md' }] },
  });

  // ① 自派档：捕获真实 start spec 里的任务包文本
  const d = await by.lane_dispatch.execute({ batchId, lane: 'e1' }, exec);
  assert.equal(d.spawned, true, '引擎自派应成功（桩 subagents）');
  const dispatched = cpBlockOf(captured[0].prompt[0].text);
  assert.ok(dispatched, '自派档任务包必须含 checkpoint 段');

  // ② 取件档
  const t = await by.taskpack_for.execute({ batchId, lane: 'e1' }, exec);
  const fromTool = cpBlockOf(t.text);
  assert.ok(fromTool, '取件档任务包必须含 checkpoint 段');

  assert.equal(dispatched, fromTool,
    '同一 lane 走两条路径的 checkpoint 段必须**逐字相等**（漏透传 subtasks 任一处即红）');
  // ③ 顺带钉住「exec 层 + 新方言 ⇒ 强制档」在**两条路径上都成立**（防两档同时退化为建议档而仍然相等）
  assert.match(dispatched.split('\n')[0], /（强制）$/, 'exec 层新方言 lane 的两档任务包都须是强制档');
  assert.equal(dispatched.includes('建议'), false, '强制档两档都不得含弱化措辞');

  // ④ 读面透出（键只增不改）：`taskpack_for` fields 须能看到 subtasks 声明体与其在场判据
  assert.equal(t.fields.hasSubtasks, true, '`fields.hasSubtasks` 须为 true（读面可核）');
  assert.deepEqual(t.fields.subtasks?.items?.map((it) => it.id), ['s1', 's2'], '`fields.subtasks` 须透出声明体（保声明序）');
  assert.equal(t.fields.hasCheckpoints, false, '本 lane 未声明 checkpoints，既有键须仍为 false');
});

// ══ 读面同构（`subtasksOf` 与 `checkpointsOf` 同形，spec §W-1）════════════════════════════════
test('subtasksOf 与 checkpointsOf 同形：缺省 ⇒ null；归一形态 ⇒ `{items:[…]}`', () => {
  assert.equal(subtasksOf({}), null, '未声明 ⇒ null（不造空壳）');
  assert.equal(subtasksOf(null), null, 'task 缺省 ⇒ null');
  assert.deepEqual(subtasksOf({ subtasks: { items: [{ id: 's1' }] } }), { items: [{ id: 's1' }] }, '归一形态原样透出');
  assert.deepEqual(subtasksOf({ subtasks: [] }), { items: [] }, '数组形态 ⇒ items 为空数组（与 checkpointsOf 同款降级）');
  assert.equal(subtasksOf({ get subtasks() { throw new Error('boom'); } }), null, '读值抛错 ⇒ 降级 null（零 throw）');
});
