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

// test/preflight-packet.test.js —— P0-1「开工前必做」四段内联（批 `punky-guidance-preflight-20261025` · lane `c1-preflight`）
// ─────────────────────────────────────────────────────────────────────────────────────────────
// 判据源：`plan/guidance-preflight-spec.md` §A（方案）/ §验收标准 P0-1（AC-P1..P9）· 横切（AC-X1/AC-X6）。
//
// 断言纪律（判据源「通则」逐条对码）：
//   ① 每条**能红**——都有「删掉实现即变红」的构造（不写「字段存在即通过」）；
//   ② **禁 L3↔L3 自证**——不拿本文件刚写的字符串去断言它自己存在：本文件的期望文案均取自**判据源 §A.4**，
//      且用「行为后果」形态断言（互斥、计数、相对位置、与另一条渲染通道共存）；
//   ③ 每条尽量给「反向归零」断言（旧形态回潮即红）。
//
// 说明：`test/inject-budget.test.js` 的 `GOLDEN_COMPOSE` 逐字节锁死 `composeWorkerPrompt` 输出，
//   本批**必然**改动任务包字节（未声明 lane 也多一行警示）⇒ 该件预期变红，**由 Leader 重冻**（本 lane 不改它）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  composeWorkerPrompt, renderPreflightBlock, renderPreflightLines, preflightOf,
} from '../lib/engine/dispatch.js';
import { normalizePreflight, validateWavePlan, buildWavePlan, assembleCmd } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { threeTierTasks, assessC } from './helpers/gate-fixture.mjs';

const SESSION = 'sess-preflight-packet';
const EXEC = { agent: { session: { id: SESSION } } };

/** 判据源 §A.4 分支① 的**逐字**四段头（照抄，非本实现的常量） */
const H1 = '1. 查知识库（`weknora_search`）——命中即按「正向做法」执行并登记来源；无命中写一行「无命中」照常推进：';
const H2 = '2. 调用技能（`skill`）——开工前先读该技能正文，按其契约做事：';
const H3 = '3. 使用 MCP——行尾写用途，否则不知道该拿它干什么：';
const H4 = '4. 本任务检查表——逐条照做，不用翻文档：';
const SEC = '## 开工前必做';
const ABSENT = '   - （本任务未声明此项）';

const FULL = Object.freeze({
  kb: ['写者静止采样', '判据可达'],
  skills: ['speclang'],
  mcp: [{ tool: 'codegraph_explore', why: '按符号取源码与调用链（替代 grep+read 循环）' }],
  checklist: ['写者未静止时不得采样'],
});

const baseArgs = (extra = {}) => ({
  batchId: 'b-pf', lane: 'e1', cmd: 'c', layer: 'exec', role: null, firstLine: 'HANDLE', ...extra,
});

/** 取任务包内「开工前必做」段（到 `## 纪律` 为止；去尾随空行 ⇒ 与**段文本本体**逐字可比）。 */
function preflightSectionOf(prompt) {
  const s = String(prompt);
  const at = s.indexOf(SEC);
  if (at < 0) return null;
  const rest = s.slice(at + SEC.length);
  const end = rest.indexOf('\n## ');
  return (SEC + (end < 0 ? rest : rest.slice(0, end))).replace(/\n+$/, '');
}

async function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-preflight-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: { warn: () => {}, info: () => {} } };
  const made = createTools(ctx, { store, root });
  // ⚠ **不用** `test/helpers/skill-paths.mjs#withDefaultTeam`：该 helper 会被
  //   `test/fixture-team-ledger.test.js` 的 F2-6 台账锁（「使用者 ≡ 允许名单」双向登记）拦住，
  //   而那张名单不在本 lane 写域。`team` 自 2026-09-27 起只是**可选标签**（不解析、不拒建批）
  //   ⇒ 显式传 `team:'software-team'` 与 helper 注入等价，无需台账登记。
  const byName = Object.fromEntries(made.tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'preflight 任务包用例：建批面动作（多线并行 ⇒ C 档）' });
  return { root, store, byName };
}

/** 建一个三层批；`execExtra` 合并进 exec lane 的任务声明（用于塞 `preflight`）。 */
// ═════════════════════════════════════════════════════════════════════════════
// A. 渲染面（AC-P1 / P2 / P3 / P4）
// ═════════════════════════════════════════════════════════════════════════════

test('AC-P1 声明 preflight ⇒ 四段**逐字**出现在任务包，段头为**裸** `## 开工前必做`', () => {
  const p = composeWorkerPrompt(baseArgs({ preflight: FULL }));
  const lines = p.split('\n');
  assert.ok(lines.includes(SEC), '须有裸段头行 ' + SEC + '（`###`/缩进/前缀都不算）');
  const body = preflightSectionOf(p);
  assert.ok(body, '段须在场');
  for (const h of [H1, H2, H3, H4]) assert.ok(body.includes(h), '四段头须逐字出现：' + h);
  // 子项逐字（判据源 §A.4 分支① 样例形态）
  assert.ok(body.includes('   - `weknora_search("写者静止采样")`'), 'kb 第 1 项须逐字渲染');
  assert.ok(body.includes('   - `weknora_search("判据可达")`'), 'kb 第 2 项须逐字渲染');
  assert.ok(body.includes('   - `skill("speclang")`'), 'skills 项须逐字渲染');
  assert.ok(body.includes('   - `codegraph_explore` —— 按符号取源码与调用链（替代 grep+read 循环）'),
    'mcp 项须渲染为「`tool` —— why」');
  assert.ok(body.includes('   - 写者未静止时不得采样'), 'checklist 项须逐字渲染');
  // 反向：声明了 ⇒ **不得**出现「未声明」警示（形态互斥）
  assert.equal(body.includes('本任务未声明开工前必做项'), false, '已声明时不得再渲染未声明警示');
  // 能红：删掉 composeWorkerPrompt 内的渲染调用 ⇒ 段头整段缺席 ⇒ 上两行必红
});

test('AC-P2 未声明 ⇒ 段头 1 行 + 警示 1 行；位置在 `## 纪律` 之前；与四段**互斥**', () => {
  const p = composeWorkerPrompt(baseArgs());
  const body = preflightSectionOf(p);
  assert.ok(body, '未声明也须有段（不静默）');
  const lines = body.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2, '未声明 ⇒ 恰 2 行（段头 + 警示），实得：' + JSON.stringify(lines));
  assert.equal(lines[0], SEC);
  assert.ok(lines[1].startsWith('> ⚠ 本任务未声明开工前必做项'), '第二行须是警示行');
  // 警示行须点名回报三字段（否则成员不知道该写什么）
  for (const f of ['knowledge_hits', 'skills_used', 'mcp_used', 'preflight']) {
    assert.ok(lines[1].includes(f), '警示行须点名 ' + f);
  }
  // 位置契约：段在 `## 纪律` 之前
  assert.ok(p.indexOf(SEC) >= 0 && p.indexOf(SEC) < p.indexOf('## 纪律'), '段须落在 `## 纪律` 之前');
  // 互斥（反向归零）：未声明时**不得**出现四段头任何一条
  for (const h of [H1, H2, H3, H4]) {
    assert.equal(p.includes(h), false, '未声明时不得渲染四段（否则「既警示又渲染空四段」）：' + h);
  }
});

test('AC-P3 三通道并存：role.skills / preflight.skills / task.skills 各自在场、**不合并、不去重**', () => {
  const cmd = assembleCmd('coder', ['speclang'], '实现 X');
  assert.equal(cmd.includes('[skills=speclang]'), true, '前置：通道 A 的装配前缀由 assembleCmd 产出');
  const p = composeWorkerPrompt(baseArgs({
    cmd,
    role: { id: 'coder', skills: ['speclang'] }, // 通道 B
    preflight: { skills: ['speclang'] },          // 通道 C（与 A/B 同值 ⇒ 重合是允许的）
  }));
  const count = (needle) => p.split(needle).length - 1;
  // 三条独立读数（任一被折叠/去重即红）
  assert.equal(count('[skills=speclang]'), 1, '通道 A（装配前缀）须恰 1 次');
  assert.equal(p.split('- 规格：见技能').length - 1, 1, '通道 B（role 规格指向）须恰 1 次');
  assert.equal(count('   - `skill("speclang")`'), 1, '通道 C（开工前必做）须恰 1 次');
  // 反向归零：preflight 不得回写装配通道（合流会出现 `[skills=speclang,speclang]`）
  assert.equal(p.includes('[skills=speclang,speclang]'), false, 'preflight.skills 不得回写 task.skills');
});

test('AC-P4 声明了但某段空 ⇒ 该段占位「（本任务未声明此项）」，其余段照常', () => {
  const p = composeWorkerPrompt(baseArgs({
    preflight: { kb: ['k1', 'k2'], skills: [], mcp: [], checklist: ['c1'] },
  }));
  const body = preflightSectionOf(p);
  assert.equal(body.split(ABSENT).length - 1, 2, 'skills / mcp 两段须各 1 行占位（恰 2 次）');
  assert.ok(body.includes('   - `weknora_search("k1")`'), 'kb 段照常渲染');
  assert.ok(body.includes('   - c1'), 'checklist 段照常渲染');
  // 「声明了」与「未声明」形态可辨：不得整段降级为警示
  assert.equal(body.includes('本任务未声明开工前必做项'), false);
  // 反向：四段头仍恒出（声明了就是声明了）
  for (const h of [H1, H2, H3, H4]) assert.ok(body.includes(h), '空段也要出段头：' + h);
});

test('AC-P4b `kb` 恰 1 个 ⇒ 软提示行（**不占位**、不拒建批）；mcp 缺 why ⇒ 「（用途未声明）」', () => {
  const p = composeWorkerPrompt(baseArgs({
    preflight: { kb: ['only-one'], mcp: [{ tool: 'codegraph_explore' }] },
  }));
  const body = preflightSectionOf(p);
  assert.ok(body.includes('   - （提示：知识库关键词建议 2-3 个，当前仅 1 个）'), 'kb=1 须追加软提示行');
  assert.ok(body.includes('   - `weknora_search("only-one")`'), '唯一关键词仍须渲染');
  assert.equal(body.includes('   - `codegraph_explore` —— （用途未声明）'), true,
    'mcp 缺 why ⇒ 行尾显式占位（不静默丢项）');
  // 反向：kb 段有内容 ⇒ 该段不得同时出现占位行
  const kbBlock = body.slice(body.indexOf(H1), body.indexOf(H2));
  assert.equal(kbBlock.includes(ABSENT), false, 'kb 有内容时不得再占位');
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 归一化与建批面（AC-P5 / P6 / P7）
// ═════════════════════════════════════════════════════════════════════════════

test('AC-P5 `kb` 只 1 个 ⇒ **不阻断建批**、落盘长度 1、渲染含软提示、零 `GATE_` 抛出', async () => {
  const { store, byName } = await makeHarness();
  const tasks = threeTierTasks(['e1']).map((t) => (t.layer === 'exec'
    ? { ...t, preflight: { kb: ['only-one'] } }
    : t));
  const r = await byName.wave_plan.execute(
    { batchId: 'pf-kb1', tasks, assembly: { auditLane: 'a1' }, concurrency: 3 }, EXEC,
  );
  assert.equal(r.batchId, 'pf-kb1', '建批须成功（返回批次 JSON）');
  const b = store.readBatch(SESSION, 'pf-kb1');
  const t = b.wavePlan.flatMap((w) => w.tasks).find((x) => x.id === 'e1');
  // 【删计数】原 `kb.length === 1` 与下一行 `deepEqual(kb, ['only-one'])` 完全冗余（同数组必同长、且逐个值更强）
  assert.deepEqual(t.preflight.kb, ['only-one'], '落盘 kb 逐值相等（未拒绝、未截断、无多余项）');
  // 渲染含软提示
  const p = composeWorkerPrompt(baseArgs({ preflight: t.preflight }));
  assert.ok(p.includes('（提示：知识库关键词建议 2-3 个，当前仅 1 个）'), '渲染面须给软提示');
});

test('AC-P6 归一化**恒写**：未声明 ⇒ `"preflight" in t && t.preflight === null`；非法形态一律降级', async () => {
  const { store, byName } = await makeHarness();
  await byName.wave_plan.execute({
    batchId: 'pf-null', tasks: threeTierTasks(['e1']), assembly: { auditLane: 'a1' }, concurrency: 3,
  }, EXEC);
  const b = store.readBatch(SESSION, 'pf-null');
  const tasks = b.wavePlan.flatMap((w) => w.tasks);
  for (const t of tasks) {
    assert.equal('preflight' in t, true, t.id + '：键须在场（恒写，不是缺键）');
    assert.equal(t.preflight, null, t.id + '：未声明 ⇒ null（不是 undefined）');
  }
  // 未新增校验拒绝：持久形态仍可被 validateWavePlan 接受（同仓先例：`validateWavePlan(buildWavePlan(...))`）
  const doc = buildWavePlan({
    batchId: 'pf-validate',
    tasks: threeTierTasks(['e1']).map((t) => (t.layer === 'exec' ? { ...t, preflight: FULL } : t)),
    team: null,
    assembly: { auditLane: 'a1' },
  });
  assert.equal(validateWavePlan(doc), true, 'validateWavePlan 不得因 preflight 抛/拒（未新增校验分支）');

  // 归一化单点的六条口径（逐条可达）
  assert.equal(normalizePreflight(undefined), null);
  assert.equal(normalizePreflight(null), null);
  assert.equal(normalizePreflight('garbage'), null);
  assert.equal(normalizePreflight([]), null);
  assert.deepEqual(normalizePreflight({}),
    { kb: [], skills: [], mcp: [], checklist: [] },
    '声明了但四段全空 ⇒ 仍写对象（与「完全未声明」区分）');
  assert.deepEqual(normalizePreflight({ kb: [' a ', 42, '', '   ', 'b'] }), 
    { kb: ['a', 'b'], skills: [], mcp: [], checklist: [] },
    '非字符串/空串/纯空白丢弃，其余 trim 保留');
  assert.deepEqual(normalizePreflight({ mcp: ['x', { why: 'y' }, { tool: '  ' }, { tool: 'cg', why: 7 }] }),
    { kb: [], skills: [], mcp: [{ tool: 'cg', why: '' }], checklist: [] },
    'mcp：非对象/无 tool 丢弃；缺 why ⇒ why 归 `\'\'`（保留该项）');
  // 零 throw：读值异常也降级（建批期抛错会让整批不可建）
  const boom = {};
  Object.defineProperty(boom, 'kb', { get() { throw new Error('boom'); } });
  assert.equal(normalizePreflight(boom), null, 'getter 抛错 ⇒ null（零 throw）');
});

test('AC-P7 `preflight` **不进 `sig`**（同时守住既有 sig 基线零漂移）＋ 不进 cmd ＋ 不回写 skills', async () => {
  const { store, byName } = await makeHarness();
  const mk = async (batchId, extra) => {
    const tasks = threeTierTasks(['e1']).map((t) => (t.layer === 'exec' ? { ...t, ...extra } : t));
    await byName.wave_plan.execute({ batchId, tasks, assembly: { auditLane: 'a1' }, concurrency: 3 }, EXEC);
    const b = store.readBatch(SESSION, batchId);
    return b.wavePlan.flatMap((w) => w.tasks).find((x) => x.id === 'e1');
  };
  const plain = await mk('pf-sig-a', {});
  const withPf = await mk('pf-sig-b', { preflight: FULL });
  // 前置断言（为下一条「preflight 不得参与 sig」服务）：sig 须**真落盘且形态正确**。
  // 规格 §方案 4 ③：16 位 hex 是**格式契约**（computeTaskSig 固定宽度）⇒ 保留；
  // 但由 `length === 16` 升级为形态身份 `/^[0-9a-f]{16}$/` —— 旧写法对「16 个非 hex 字符」假绿。
  assert.match(String(plain.sig), /^[0-9a-f]{16}$/,
    '前置：sig 须落盘且为 16 位小写 hex（实测 ' + String(plain.sig) + '）');
  assert.equal(withPf.sig, plain.sig, 'preflight 不得参与 sig（喂进 computeTaskSig ⇒ 两值不等 ⇒ 红）');
  // 不进 cmd：两批 e1 的 cmd 逐字相同
  assert.equal(withPf.cmd, plain.cmd, 'preflight 不得进 cmd');
  // 不回写装配通道
  assert.equal(withPf.skills, null, 'preflight.skills 不得回写 task.skills（未声明任务级 skills ⇒ 仍 null）');
  // 但声明本身**确实落盘**（反向：否则「不进 sig」可由「整段被丢弃」伪造）
  assert.deepEqual(withPf.preflight.kb, FULL.kb, '声明须真落盘（防用「丢弃」伪造上三条）');
});

// ═════════════════════════════════════════════════════════════════════════════
// C. fail-safe（AC-P8）与单点同源（AC-P9）
// ═════════════════════════════════════════════════════════════════════════════

test('AC-P8 fail-safe：畸形声明**降级不阻断**（不抛 + 命中警示行）', () => {
  const cases = [
    ['非对象（字符串）', 'garbage'],
    ['数组', ['x']],
    ['数字', 42],
  ];
  for (const [label, preflight] of cases) {
    let p = null;
    assert.doesNotThrow(() => { p = composeWorkerPrompt(baseArgs({ preflight })); }, label + '：不得抛错');
    const body = preflightSectionOf(p);
    assert.ok(body && body.includes('本任务未声明开工前必做项'), label + '：须降级为警示行（不静默、不空段）');
  }
  // 更强：getter 抛错 ⇒ 同样降级（渲染期异常绝不能穿透到派发路径）
  const evil = { skills: ['x'] };
  Object.defineProperty(evil, 'kb', { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => composeWorkerPrompt(baseArgs({ preflight: evil })), 'getter 抛错不得外溢');
  const evilWarned = [];
  composeWorkerPrompt(baseArgs({ preflight: evil, logger: { warn: (m) => evilWarned.push(m) } }));
  assert.ok(evilWarned.length <= 1, '告警至多 1 条（不刷屏）');
  // 反向：正常声明时不得有任何一条告警（防「永远走降级支」伪通过）
  const okWarned = [];
  const okPrompt = composeWorkerPrompt(baseArgs({ preflight: FULL, logger: { warn: (m) => okWarned.push(m) } }));
  assert.equal(okWarned.length, 0, '正常声明不得产告警');
  assert.ok(okPrompt.includes(H1), '正常声明仍须渲染四段');
});

test('AC-P9 渲染色同源：`role_guide` 传 `preflight` ⇒ 与任务包内该段**逐字相等**；不传 ⇒ 返回键集不变', async () => {
  const { byName } = await makeHarness();
  const rg = byName.role_guide;
  // ① 不传 preflight ⇒ 键集逐字不变（既有读端零回归）
  const bare = await rg.execute({ role: 'coder' }, EXEC);
  assert.deepEqual(Object.keys(bare).sort(), ['guide', 'role', 'source', 'team'], '不传 ⇒ 无 preflight 键');
  // ② 传 ⇒ 与引擎任务包内该段逐字相等（同一渲染单点，零模板复制）
  const withPf = await rg.execute({ role: 'coder', preflight: FULL }, EXEC);
  assert.equal(typeof withPf.preflight, 'string', '传 ⇒ 产出 preflight 段文本');
  const prompt = composeWorkerPrompt(baseArgs({ preflight: FULL }));
  assert.equal(withPf.preflight, preflightSectionOf(prompt),
    'role_guide 的 preflight 字段须与任务包内该段**逐字一致**（两处共用同一单点）');
  // ③ 未声明的取件口：与引擎同一警示形态
  const bare2 = await rg.execute({ role: 'coder', preflight: {} }, EXEC);
  assert.equal(bare2.preflight, [SEC, ...renderPreflightLines({}).slice(1)].join('\n'),
    '空声明 ⇒ 四段 + 占位（与引擎同一单点）');
});

// ═════════════════════════════════════════════════════════════════════════════
// D. 横切（AC-X1 零新造门禁码 / AC-X6 文案不掺元信息 / 单点唯一性）
// ═════════════════════════════════════════════════════════════════════════════

test('AC-X6 渲染文案不掺元信息（批次号 / 版本号 / 来源追溯）', () => {
  const texts = [
    renderPreflightBlock(FULL),
    renderPreflightBlock(null),
    renderPreflightBlock({ kb: ['k1'], mcp: [{ tool: 'cg' }] }),
  ];
  for (const t of texts) {
    assert.equal(/[0-9]+(\.[0-9]+){1,}/.test(t), false, '不得出现版本号形态：' + t.slice(0, 40));
    assert.equal(/据\s*.{0,20}\s*批实测/.test(t), false, '不得出现来源追溯');
    assert.equal(/punky-[a-z]+-\d{8}/.test(t), false, '不得出现批次号');
  }
});

test('AC-X1 零新造门禁码：本段文案/常量不含 `GATE_` 子串（否则「零净增」扫码恒假）', () => {
  const texts = [renderPreflightBlock(FULL), renderPreflightBlock(null), renderPreflightBlock({})];
  for (const t of texts) {
    assert.equal(/GATE_[A-Z0-9_]+/.test(t), false, '渲染文案不得含 GATE_ 子串：' + t.slice(0, 60));
  }
  // 源码面：本 lane 新增区段里的常量名同样不得含该子串（否则「零净增」扫码恒假）
  const src = fs.readFileSync(new URL('../lib/engine/dispatch.js', import.meta.url), 'utf8');
  const start = src.indexOf('// ── 【批 `punky-guidance-preflight-20261025`');
  const stop = src.indexOf('/** 任务级三段渲染');
  assert.ok(start > 0 && stop > start, '前置：本批新增区段须可精确切出（start=' + start + ' stop=' + stop + '）');
  const span = src.slice(start, stop);
  assert.ok(span.length > 200, '前置：区段取到实内容（实得 ' + span.length + ' 字符）');
  const hits = span.match(/GATE_[A-Z0-9_]+/g) ?? [];
  assert.deepEqual([...new Set(hits)], [], '新增区段不得引入任何 GATE_ 形态标识符');
});

test('单点唯一性：`role_guide` 侧零模板（不复制段头/占位文案），只调 `renderPreflightBlock`', () => {
  const qt = fs.readFileSync(new URL('../lib/tools/query-tools.js', import.meta.url), 'utf8');
  assert.equal(qt.includes('renderPreflightBlock'), true, '工具面须调用引擎渲染单点');
  for (const literal of [H1, H2, H3, H4, '（本任务未声明此项）', '本任务未声明开工前必做项']) {
    assert.equal(qt.includes(literal), false, '工具面不得内联段文案（禁复制一份）：' + literal);
  }
});

test('`preflightOf` 判定表：仅 plain object 算已声明（null/undefined/数组/标量 ⇒ 未声明）', () => {
  assert.deepEqual(preflightOf({ preflight: FULL }), { declared: true, decl: FULL });
  for (const [label, task] of [
    ['缺键', {}], ['null', { preflight: null }], ['数组', { preflight: [] }],
    ['字符串', { preflight: 'x' }], ['undefined task', undefined],
  ]) {
    const r = preflightOf(task);
    assert.equal(r.declared, false, label + ' ⇒ 未声明');
    assert.equal(r.decl, null, label + ' ⇒ decl=null');
  }
  // 声明了但四段全空 ⇒ **仍算已声明**（渲染走四段+占位，与未声明的警示行区分）
  assert.equal(preflightOf({ preflight: {} }).declared, true, '空对象 = 声明了');
});
