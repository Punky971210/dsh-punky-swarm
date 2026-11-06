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

// test/checkpoint-resume-wire.test.js —— A 通道接线（`resume` ⇒ `RESUME_CLAUSE` 进任务包）
//   （批 `punky-checkpoint-wire-20261106` · lane `e1-resume`；判据源 `plan/ckpt-spec.md`
//   「## 验收项（exec 判据源 · E-CK1…E-CK6）」章 ⇒ 本 lane 归属 **E-CK1 / E-CK2 / E-CK5 / E-CK6**）
//
// 本套件的**纪律边界**（写死，防退化）：
//   ① 断言主体 = `composeWorkerPrompt(...)` 返回的**字符串**（不是 `resumeClauseFor` 的返回值）——
//      「函数返回对了」不等于「member 真读到了」，本批修的正是**零调用点**这个断链。
//   ② 不用「计数等于 N」型断言：判定「条款**恰一行**」用**身份集合** `deepEqual(filtered, [CLAUSE])`，
//      既锁形态又锁行数（同 `checkpoint-aux.test.js` 纪律 ②）。
//   ③ 断言里**不重抄** `RESUME_CLAUSE` 文本（判据源 R-3 禁第二真源）⇒ 一律从 `lib/wave-plan.js` 取。
//   ④ E-CK6 用**冻结 sha256 常量**而非「改前 git 版本」：`git show HEAD:…` 落 `lib/` 会与
//      `npm test` 链里的 `git diff --exit-code -- lib/` 直接冲突（判据源 §方案 3.3 已否掉该备选）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { composeWorkerPrompt } from '../lib/engine/dispatch.js';
import { RESUME_CLAUSE, normalizeCheckpoints } from '../lib/wave-plan.js';
// ⚠ `dispatch-fixture.mjs` **惰性导入**（不在文件顶部静态 import）：它经 `createTools` 拉起工具层
//   （`lib/tools/register.js` → `lane-tools.js` → `state/resume.js`）。批内并发时兄弟 lane 可能把工具层
//   改成**半应用态**（真实发生：e2-status 已改 `lane-tools.js` 的 import、`resume.js` 的 export 尚未跟上）
//   ⇒ 静态 import 会让**加载期**整体抛 `SyntaxError`，把 E-CK1/2/5/6 四条纯 compose 级判据一并连坐判红。
//   惰性导入把该风险**收窄到 R-4 一例**：另四条永不因工具层中间态失败。

// ── E-CK6 冻结基线 ────────────────────────────────────────────────────────────────
// 取法：**改动前**于干净树（HEAD `bf061aa`，`git status --porcelain` 空）用下方 `NEUTRAL` fixture
//   实测 `composeWorkerPrompt` 返回值，`sha256(utf8)` = 下列常量（1905 B / 21 行）。
// 复算（审计可独立复跑）：同一 fixture 重算必须**逐字符相等**。
const BASELINE_HEAD = 'bf061aa';
const NEUTRAL_SHA256 = 'e4555c844a3f55363aa914edbc562360bbc2d0fc514ea166700d14d6080efd3c';

// E-CK6 的「未声明」形态：`role: null`（不触 role 语料库，跨机稳定）、`preflight` 缺省（走警示行）、
//   `checkpoints` / `resume` / `injectBudget` / `archContext` 皆缺省 ⇒ 正是判据要求的「未声明」。
const NEUTRAL = {
  batchId: 'b-ck6', lane: 'l1', cmd: 'CMD-CK6', layer: 'exec', role: null,
  consume: [], produce: [], outputs: [],
  firstLine: 'swarm-lane:b-ck6/l1#ck6', leaderPrompt: '', artifactsRoot: null,
};

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('E-CK1 A 通道阳性：`resume: true` ⇒ 任务包含 `RESUME_CLAUSE` 且为**独立整行**', () => {
  const text = composeWorkerPrompt({ ...NEUTRAL, resume: true });
  // 独立整行精确命中（非子串 `includes`）——防「被拼进别的段落」。
  assert.deepEqual(text.split('\n').filter((l) => l === RESUME_CLAUSE), [RESUME_CLAUSE],
    '`RESUME_CLAUSE` 必须以**恰一行、逐字相等**的形态出现：\n' + text);
  // 空行口径（判据源 C-8）：块前**恰一个**前导空行、块后**不给**（紧随 preflight 段自带前导空行）。
  const lines = text.split('\n');
  const at = lines.indexOf(RESUME_CLAUSE);
  assert.equal(lines[at - 1], '', '`RESUME_CLAUSE` 前必须是空行（前导空行恰一个）');
  assert.equal(lines[at + 1], '', '`RESUME_CLAUSE` 后必须紧接 preflight 段的前导空行（不得出连续空行）');
  assert.notEqual(lines[at + 2], '', '块后**不得**多给第二个空行（否则前后连空 ⇒ 形态漂移）');
});

test('E-CK2 A 通道阴性：`resume !== true`（false / undefined 两形态）⇒ 任务包**不含**条款', () => {
  // 判据源 E-CK2：两种形态各断言一次，缺一不可。
  for (const resume of [false, undefined]) {
    const args = resume === undefined ? { ...NEUTRAL } : { ...NEUTRAL, resume };
    const text = composeWorkerPrompt(args);
    const form = resume === undefined ? 'undefined（未传）' : 'false';
    assert.equal(text.includes(RESUME_CLAUSE), false, 'resume=' + form + ' 时不得含条款全文');
    // 子串级双保险：防「换行被拼掉但文本仍在」的假阴性。
    assert.equal(text.includes('从最后已 checkpoint 的步骤之后继续'), false,
      'resume=' + form + ' 时不得含条款片段');
    assert.equal(text.split('\n').some((l) => l.startsWith('若本 lane 存在 checkpoint')), false,
      'resume=' + form + ' 时不得有条款行');
    // 与「未声明」形态**逐字节相同**（不传 resume 与传 false 必须等价）。
    assert.equal(sha256(text), sha256(composeWorkerPrompt({ ...NEUTRAL })),
      'resume=' + form + ' 必须与未声明形态逐字节相同（缺省等价）');
  }
});

test('E-CK5 端到端：`checkpoints[]` + `resume: true` 并存 ⇒ 两段皆在且段序为「计划段 → 条款 → 开工前必做」', () => {
  // `checkpoints` 入参是**归一化后**的 `{ items }`（`wave-plan.ts:555` / `dispatch.js` 读 `laneTask?.checkpoints`）。
  const checkpoints = normalizeCheckpoints([{ id: 'cp1', target: 'plan/ckpt-spec.md' }]);
  const text = composeWorkerPrompt({ ...NEUTRAL, checkpoints, resume: true });
  assert.equal(text.includes('## checkpoint 计划'), true, 'B 通道段必须在：\n' + text);
  assert.deepEqual(text.split('\n').filter((l) => l === RESUME_CLAUSE), [RESUME_CLAUSE],
    'A 通道条款必须在（恰一行）：\n' + text);
  assert.equal(text.includes('## 开工前必做'), true, 'preflight 段必须在');
  const lines = text.split('\n');
  const atPlan = lines.indexOf('## checkpoint 计划');
  const atClause = lines.indexOf(RESUME_CLAUSE);
  const atPreflight = lines.indexOf('## 开工前必做');
  assert.equal(atPlan < atClause, true, '段序：`## checkpoint 计划` 必须在条款**之前**');
  assert.equal(atClause < atPreflight, true, '段序：条款必须在 `## 开工前必做` **之前**');
});

test('E-CK6 不回归：未声明 `checkpoints` 且 `resume !== true` ⇒ prompt 与改前**逐字节相同**', () => {
  const text = composeWorkerPrompt({ ...NEUTRAL });
  assert.equal(sha256(text), NEUTRAL_SHA256,
    '零回归基线（HEAD ' + BASELINE_HEAD + ' 改前实测）必须逐字符相等；'
    + '若不相等 ⇒ 条件段的空行/文本泄漏进了缺省路径');
  assert.equal(Buffer.byteLength(text, 'utf8'), 1905, '字节数须与改前一致（1905 B）');
});

test('R-4 派发路径：`WavePlanTask.resume === true` ⇒ 引擎自派的任务包真带条款（另一侧无）', async () => {
  // 惰性导入（理由见文件头 import 区注释：工具层可能处于兄弟 lane 的半应用态）。
  const { makeDispatchHarness } = await import('./helpers/dispatch-fixture.mjs');
  // 阳性：任务声明 `resume: true` ⇒ 派发出的 prompt 含条款行。
  const pos = await makeDispatchHarness({
    SID: 'sess-ckw1', batchId: 'b-ckw1', taskExtra: { resume: true },
  });
  const r = await pos.by.lane_dispatch.execute({ batchId: 'b-ckw1', lane: 'e1' }, pos.exec);
  assert.equal(r.spawned, true, '引擎自派应成功（桩 subagents）');
  const posText = pos.captured[0].prompt[0].text;
  assert.deepEqual(posText.split('\n').filter((l) => l === RESUME_CLAUSE), [RESUME_CLAUSE],
    '持久面 `resume: true` 必须经 `laneTask?.resume` 落进任务包：\n' + posText);

  // 阴性：同一 harness 不声明 ⇒ 任务包**不含**条款（证明单点取值、非无条件注入）。
  const neg = await makeDispatchHarness({ SID: 'sess-ckw2', batchId: 'b-ckw2' });
  await neg.by.lane_dispatch.execute({ batchId: 'b-ckw2', lane: 'e1' }, neg.exec);
  const negText = neg.captured[0].prompt[0].text;
  assert.equal(negText.includes(RESUME_CLAUSE), false,
    '未声明的 lane 不得含条款（防无条件注入）：\n' + negText);
});
