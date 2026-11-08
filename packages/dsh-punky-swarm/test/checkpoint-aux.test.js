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

// test/checkpoint-aux.test.js —— `tasks[].checkpoints[]` 四段辅助信息
// （批 `punky-engine-fix2-20261106` · lane `e4-ckpt-aux`；判据源 `plan/fix2-spec.md` §5 + E4-K1..K10）
//
// 本套件的**纪律边界**（写死，防退化）：
//   ① 断言主体是 **`composeWorkerPrompt(...)` 返回的字符串**，不是 `normalizeCheckpoints` 的返回值。
//      上一批 `role_guide` 的 preflight 在 H 面被 render 折叠成一行 ⇒「字段层有、member 读不到」，
//      所以「归一绿了」不算证据（E4-K4 判红面）。
//   ② 不用「计数等值」型断言（把某个行数断言成具体数字）：判定「恰一行警示」用**子行身份集合**
//      （`deepEqual([WARN])`），既锁形态又锁行数，且不依赖 pass 数变化（全局判据句式 4）。
//   ③ 三态必须分清：① 未声明 ⇒ 不出段；② 声明了但四段全空 ⇒ 出段 + 恰一行警示；
//      ③ 任一段非空 ⇒ 出段 + 只出对应子行、无警示。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeWorkerPrompt } from '../lib/engine/dispatch.js';
import { normalizeCheckpoints, normalizePreflight } from '../lib/wave-plan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

const SEC = '## checkpoint 计划';
/** 四段全空时的**恰一行**建议性警示（含列表缩进；判据源 S5-3 逐字） */
const AUX_ABSENT = '  - ⚠ 本 checkpoint 未声明 skills / kb / mcp / checklist 四段（建议性：开工前自行判断；不阻断）';

/** `composeWorkerPrompt` 的最小入参（role 传 `null` ⇒ 零语料 I/O ⇒ 输出确定性）。 */
const baseArgs = (extra = {}) => ({
  batchId: 'b-cpaux', lane: 'e4', cmd: '夹具目标行', layer: 'exec', role: null, firstLine: 'HANDLE', ...extra,
});

/** 取任务包内「## checkpoint 计划」段（到下一个 `\n## ` 为止；去尾随空行）。 */
function cpSectionOf(prompt) {
  const s = String(prompt);
  const at = s.indexOf(SEC);
  if (at < 0) return null;
  const rest = s.slice(at + SEC.length);
  const end = rest.indexOf('\n## ');
  return (SEC + (end < 0 ? rest : rest.slice(0, end))).replace(/\n+$/, '');
}

/** 取某 item 正文行之后的**缩进子行**（到下一个 `- \`id\`` 或段尾）。缺该 item ⇒ `null`。 */
function subLinesOfItem(section, itemId) {
  const lines = section.split('\n');
  const head = lines.findIndex((l) => l.startsWith('- `' + itemId + '`'));
  if (head < 0) return null;
  const out = [];
  for (let i = head + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('  - ')) break; // 子行区结束（下一条 item 是 `- \``，不以两个空格开头）
    out.push(l);
  }
  return out;
}

/** 四段的全量声明夹具（词序 = skills → kb → mcp → checklist）。 */
const FULL = Object.freeze({
  skills: ['software-team', 'codebase-design'],
  kb: ['punky-swarm roster', 'checkpoint 四段'],
  mcp: [{ tool: 'codegraph_explore', why: '摸调用面' }, { tool: 'gate_status' }], // 第 2 项缺 why
  checklist: ['先核 file:line 再改', '改完跑相关测试'],
});

// ═════════════════════════════════════════════════════════════════════════════
// 归一面（E4-K1 / K2 / K3 / K7）
// ═════════════════════════════════════════════════════════════════════════════

test('CA-1 [E4-K1] 声明四段 ⇒ 归一产物含四键且内容正确；不声明 ⇒ 四键**不在**（不是空数组）', () => {
  const r = normalizeCheckpoints([{ id: 'cp1', target: 'exec/x.md', ...FULL }]);
  const it = r.items[0];
  assert.deepEqual(it.skills, FULL.skills, 'skills 须逐字保留');
  assert.deepEqual(it.kb, FULL.kb, 'kb 须逐字保留');
  assert.deepEqual(it.mcp, [
    { tool: 'codegraph_explore', why: '摸调用面' },
    { tool: 'gate_status', why: '' }, // 缺 why ⇒ 归一为 ''（渲染占位，不静默丢项）
  ], 'mcp 须保留两项，缺 why 归为空串');
  assert.deepEqual(it.checklist, FULL.checklist, 'checklist 须逐字保留');
  // 反向：不声明的项，四键**键不在**（渲染层据此区分「未声明」与「声明了但空」）
  const bare = normalizeCheckpoints([{ id: 'cp2', target: 'exec/y.md' }]).items[0];
  assert.deepEqual(['skills', 'kb', 'mcp', 'checklist'].filter((k) => k in bare), [],
    '未声明四段的项不得写四键（`in` 判定）');
});

test('CA-2 [E4-K2] 同一非法夹具分别喂两处 ⇒ 四段归一结果**逐字相等**（= 单点复用，未写第二套）', () => {
  const LEGAL = { tool: 'codegraph_explore', why: '用途' };
  const fixtures = [
    { kb: 'notarray', skills: [1, '  ', null], mcp: [{ why: 'x' }, LEGAL], checklist: 42 },
    { kb: ['k1', 7, ' '], skills: ['  s1  '], mcp: 'notarray', checklist: ['c1'] },
    { kb: [], skills: [], mcp: [], checklist: [] },
  ];
  for (const fx of fixtures) {
    const viaPreflight = normalizePreflight(fx);
    const it = normalizeCheckpoints([{ id: 'cp', ...fx }]).items[0];
    const viaCheckpoint = { kb: it.kb, skills: it.skills, mcp: it.mcp, checklist: it.checklist };
    const shape = JSON.stringify(fx);
    // 全空夹具：checkpoint 侧不写键 ⇒ 与 normalizePreflight 的「四段恒在但全空」形态不同
    //   —— 这是唯一**刻意**差异（E4-K5：逐项不敢铺 4 行占位），故只在有内容时比逐字相等。
    const anyContent = (viaPreflight.kb.length || viaPreflight.skills.length
      || viaPreflight.mcp.length || viaPreflight.checklist.length);
    if (!anyContent) {
      assert.deepEqual(['skills', 'kb', 'mcp', 'checklist'].filter((k) => k in it), [],
        '全空夹具：checkpoint 侧不写四键（' + shape + '）');
      continue;
    }
    assert.deepEqual(viaCheckpoint, viaPreflight, '两处归一结果须逐字相等：' + shape);
  }
});

test('CA-3 [E4-K3] 建议性：四段极端非法 ⇒ 零 throw、零门禁码、仍返回对象（不拒建批）', () => {
  const evil = [
    { id: 'a', skills: { not: 'array' }, kb: 42, mcp: [null, 7, [], { tool: '' }, { tool: '  ' }], checklist: true },
    { id: 'b', skills: () => {}, kb: Symbol('x'), mcp: undefined, checklist: new Set(['x']) },
  ];
  let r;
  assert.doesNotThrow(() => { r = normalizeCheckpoints(evil); }, '四段非法不得抛（建议性面）');
  assert.deepEqual(r.items.map((i) => i.id), ['a', 'b'], '坏四段不得连带丢 item（id 合法即保留）');
  for (const it of r.items) {
    assert.deepEqual(['skills', 'kb', 'mcp', 'checklist'].filter((k) => k in it), [],
      it.id + '：四段归一后全空 ⇒ 不写四键');
  }
  // 进 prompt 亦不得抛，且只出「恰一行」警示（不是 4 行占位）
  let prompt;
  assert.doesNotThrow(() => { prompt = composeWorkerPrompt(baseArgs({ checkpoints: r })); }, '渲染不得抛');
  assert.deepEqual(subLinesOfItem(cpSectionOf(prompt), 'a'), [AUX_ABSENT], '全空 ⇒ 恰一行警示');
});

test('CA-7 [E4-K7] 幂等：二次归一逐字不变且四段不丢（B-6 不复发）', () => {
  const once = normalizeCheckpoints([{ id: 'cp1', target: 'exec/x.md', ...FULL }]);
  // 形态①：`{ items }` 回灌（`store.addPoolTasks` / `addTaskEdges` 的真实路径）
  assert.deepEqual(normalizeCheckpoints(once), once, '`{ items }` 回灌须原样返回（B-6 幂等早退分支）');
  // 形态②：归一后的 items 数组回灌（更严：逐项四段二次归一后不得被重置）
  const twice = normalizeCheckpoints(once.items);
  assert.deepEqual(twice, once, 'items 数组回灌须逐字相等');
  assert.deepEqual(twice.items[0].skills, FULL.skills, '四段二次归一后不得丢失');
  assert.deepEqual(twice.items[0].mcp, once.items[0].mcp, 'mcp 二次归一后不得变形');
});

// ═════════════════════════════════════════════════════════════════════════════
// **prompt 文本面**（E4-K4 / K5 / K6 / K8 / K9）—— 本套件的成败点
// ═════════════════════════════════════════════════════════════════════════════

test('CA-4 [E4-K4] 四段**进 composeWorkerPrompt 的返回字符串**（不是只在归一层）', () => {
  const checkpoints = normalizeCheckpoints([
    { id: 'cp1-recon', target: 'exec/progress/01-recon.md', acceptance: '定位单点', ctxBudget: 5000, ...FULL },
  ]);
  const prompt = composeWorkerPrompt(baseArgs({ checkpoints }));
  const section = cpSectionOf(prompt);
  assert.ok(section, '声明四段后须出「## checkpoint 计划」段');
  // 断言主体 = prompt 文本里的**子行身份集合**（逐字 + 词序）
  assert.deepEqual(subLinesOfItem(section, 'cp1-recon'), [
    '  - skills：`skill("software-team")` / `skill("codebase-design")`',
    '  - kb：`weknora_search("punky-swarm roster")` / `weknora_search("checkpoint 四段")`',
    '  - mcp：`codegraph_explore` —— 摸调用面；`gate_status` —— （用途未声明）',
    '  - checklist：先核 file:line 再改 / 改完跑相关测试',
  ], '四段须作为**缩进子行**逐字进 prompt（词序 skills→kb→mcp→checklist）');
  // 独立读数：内容在整段 prompt 字符串里可读（防「只是子行数组对、拼装丢失」）
  assert.ok(prompt.includes('`skill("software-team")`'), 'prompt 全文须含技能名');
  assert.ok(prompt.includes('`weknora_search("punky-swarm roster")`'), 'prompt 全文须含知识库关键词');
  assert.ok(prompt.includes('`codegraph_explore` —— 摸调用面'), 'prompt 全文须含 MCP 工具 + 用途');
  assert.ok(prompt.includes('先核 file:line 再改'), 'prompt 全文须含检查表条目');
  // 反向：有内容 ⇒ **不得**出「四段全空」警示（形态互斥）
  assert.equal(section.includes('本 checkpoint 未声明 skills'), false, '已声明时不得出全空警示');
  // 位置契约：仍在 `## 开工前必做` 之前（既有段序不变）
  assert.ok(prompt.indexOf(SEC) < prompt.indexOf('## 开工前必做'), 'checkpoint 段须在开工前必做段之前');
});

test('CA-5 [E4-K5] 四段全空的 item ⇒ prompt 里**恰一行**建议性警示（不是每段一行占位）', () => {
  const checkpoints = normalizeCheckpoints([{ id: 'cp1', target: 'exec/x.md' }]);
  const prompt = composeWorkerPrompt(baseArgs({ checkpoints }));
  const section = cpSectionOf(prompt);
  assert.deepEqual(subLinesOfItem(section, 'cp1'), [AUX_ABSENT], '全空 ⇒ 子行身份集合恰为**一行**警示');
  // 反向归零：不得出现四段头/占位行（多行噪声 = 判红）
  for (const noise of ['  - skills：', '  - kb：', '  - mcp：', '  - checklist：', '（本任务未声明此项）']) {
    assert.equal(section.includes(noise), false, '四段全空时不得出现占位行噪声：' + noise);
  }
});

test('CA-6 [E4-K6] 未声明 `checkpoints` ⇒ 完全不出段、不出警示，且与「省略该参数」逐字节相同', () => {
  const withNull = composeWorkerPrompt(baseArgs({ checkpoints: null }));
  const omitted = composeWorkerPrompt(baseArgs());
  assert.equal(withNull, omitted, '`checkpoints: null` 与省略参数须逐字节相同（存量批零感知）');
  assert.equal(withNull.includes(SEC), false, '未声明 ⇒ 不得出现「## checkpoint 计划」段头');
  assert.equal(withNull.includes('本 checkpoint 未声明 skills'), false, '未声明 ⇒ 不得出现四段警示');
  assert.equal(withNull.split('\n').some((l) => l.startsWith('  - ')), false,
    '未声明 ⇒ 不得出现任何 2 空格缩进的 checkpoint 子行（防四段子行泄漏进存量批）');
});

test('CA-8 [E4-K8] mcp 缺 `why` ⇒ 逐字用 `（用途未声明）` 占位（与 preflight 同一常量）', () => {
  const checkpoints = normalizeCheckpoints([{ id: 'cp1', mcp: [{ tool: 'gate_status' }] }]);
  const prompt = composeWorkerPrompt(baseArgs({ checkpoints }));
  const sub = subLinesOfItem(cpSectionOf(prompt), 'cp1');
  assert.deepEqual(sub, ['  - mcp：`gate_status` —— （用途未声明）'],
    '缺 why 须渲染 `（用途未声明）` 占位，且**不得丢该项**');
  // 同一常量口径：与 `## 开工前必做` 段的占位逐字一致（禁另造措辞）
  const pf = composeWorkerPrompt(baseArgs({ preflight: { mcp: [{ tool: 'gate_status' }] } }));
  assert.ok(pf.includes('`gate_status` —— （用途未声明）'),
    'preflight 段与 checkpoint 段须共用同一占位文案（单点复用，禁另造一套）');
});

test('CA-9 [E4-K9] fail-safe：渲染抛错 ⇒ 跳过该段 + 一行 logger.warn，prompt 不向上抛', () => {
  const warned = [];
  const evil = {
    items: [{
      id: 'cp1',
      target: 'exec/x.md',
      get skills() { throw new Error('boom-skills'); }, // 读值即抛（模拟 getter 抛错）
    }],
  };
  let prompt;
  assert.doesNotThrow(() => {
    prompt = composeWorkerPrompt(baseArgs({ checkpoints: evil, logger: { warn: (m) => warned.push(String(m)) } }));
  }, '渲染抛错绝不得外溢到 composeWorkerPrompt（否则 lane 会 failed）');
  assert.equal(String(prompt).includes(SEC), false, '抛错 ⇒ 跳过该段（代价是缺段，不是 lane failed）');
  assert.ok(warned.some((m) => m.includes('checkpoint 计划段渲染失败')),
    '须落一条「段渲染失败」告警：' + JSON.stringify(warned));
  assert.ok(warned.every((m) => m.includes('不阻断派发')), '告警须明示「不阻断派发」语义：' + JSON.stringify(warned));
});

// ═════════════════════════════════════════════════════════════════════════════
// 预算面与源级守卫（E4-K10）
// ═════════════════════════════════════════════════════════════════════════════

test('CA-10 [E4-K10] 不加注入预算面：`taskpack.checkpoints` 在整个派发模块组里零出现', () => {
  // ⑤E：`dispatch.js` 已按职责拆为 7 模块（dispatch.js 门面 + 6 职责件）
  //   ⇒ 判据面从「单文件」改为「模块组」：语义不变（整个派发面都不许出现该预算面），且覆盖面更严。
  const dir = path.join(PKG_ROOT, 'lib', 'engine');
  const group = fs.readdirSync(dir).filter((f) => /^dispatch(-[\w-]+)?\.js$/.test(f)).sort();
  assert.ok(group.length >= 7, '夹具前提：派发模块组须至少 7 件（否则「全组扫描」会因空集假绿）；实际=' + group.length);
  const src = group.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.equal(/taskpack\.checkpoints/.test(src), false,
    '本批不给 checkpoint 段加注入预算面（新增面须另案裁决）');
  // 正向对照：既有四个面仍在（防「删错面」冒充通过）
  for (const surface of ['taskpack.preflight', 'taskpack.cmd', 'taskpack.leaderPrompt', 'taskpack.total']) {
    assert.ok(src.includes(surface), '既有预算面须仍在：' + surface);
  }
});
