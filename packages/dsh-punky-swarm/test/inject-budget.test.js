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

// L2 注入面「四层字节预算」独立测试套件（tester lane `t2-budget-tests`）。
//
// 性质 = **同源不同向**：本套件与 coder lane 读**同一个任务包**（`plan/taskpack-e2.md`），
//   但把该包的 `## 验收标准` 翻译成**可执行测试**；**不验收 coder 的产物**（独立验收归 audit 层）。
// 判据源：`plan/impl-spec.md`「冻结 2」（四层阈值 / 省略标记 / 面名集合）
//   ＋ `plan/taskpack-e2.md` 的 `AC-8..AC-17` 与 `RED-3..RED-6`。
//
// ⚠ **接口对账（实测，已按交付契约适配；登记于 exec/t2-budget-tests.md）**：交付签名比包内声明多一个
//   **层选择位 `kind`**：`applyInjectionBudget(text, { surface, thresholds, kind })`，
//   `kind ∈ {'perItem','perBlock','total'}`、**缺省 `'total'`**；且**一次调用只施一层**、
//   恰产**一条** omission —— 「分层不合并」由**调用方按序各呼一次**实现（模块不自编排多面）。
//   ⇒ 本套件显式传 `kind`（缺省位会把单条目/单块用例静默降级到总量层 ⇒ 假绿）。
//
// ⚠ **环境前提（实测）**：本 checkout 的 `node_modules` **为空** ⇒ `lib/auditlog/sink.js`
//   （`import { Logger } from '@deepseek-ai/cordis'`）不可加载。若静态 import 它，**整个套件文件**
//   会加载失败、31 条用例一条都跑不到 ⇒ 改为守卫式动态 import：失败只是让依赖它的那条判据
//   以**显式「环境未就绪」理由** RED（**不静默跳过**）。
//
// 口径纪律：阈值**唯一取值源** = `capabilities.injectBudget`；本文件为可读性把冻结值写成字面量，
//   但**同批以 `[AC-8] 冻结值 × 注册表逐值相等` 用例锁死等式**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readCapability } from '../lib/assembly/schema.js';
import { composeWorkerPrompt } from '../lib/engine/dispatch.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. 冻结值（唯一真源 = `plan/impl-spec.md` 冻结 2；本节仅镜像，等式由 [AC-8] 用例锁死）
// ─────────────────────────────────────────────────────────────────────────────

const FROZEN_THRESHOLDS = Object.freeze({
  enabled: true,
  perItemBytes: 3072,
  perBlockBytes: 12288,
  totalBytes: 32768,
  headBytes: 2048,
  tailBytes: 1024,
});

/** 面名集合（冻结；禁自造面名）。 */
const SURFACE = Object.freeze({
  cmd: 'taskpack.cmd',
  leaderPrompt: 'taskpack.leaderPrompt',
  taskpackTotal: 'taskpack.total',
  assertion: 'handoff.assertion',
  assertions: 'handoff.assertions',
  wakeSummary: 'wake.summary',
  wakeTotal: 'wake.total',
});

/** 交付的层选择位（`kind`）；层 → 阈值字段一一对应。 */
const KIND = Object.freeze({ perItem: 'perItem', perBlock: 'perBlock', total: 'total' });

/** 省略标记：`…[omitted <N>B @ <surface>]`（`<N>` = 十进整数字节数）。 */
const OMIT_MARK_RE = /…\[omitted (\d+)B @ ([^\]\s]+)\]/g;

const DECLARED_APPLY_NAME = 'applyInjectionBudget';

// ─────────────────────────────────────────────────────────────────────────────
// 1. 被测模块与同源锁常量（守卫式加载：实现/环境未就绪 ⇒ 显式理由 RED，而非整体加载崩溃）
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const IMPL_REL = 'lib/comms/inject-budget.js';
const SINK_REL = 'lib/auditlog/sink.js';
const RERUN_CMD = 'node --import ./test/helpers/isolated-home.preload.mjs --test test/inject-budget.test.js';

let implModule = null;
let implLoadError = null;
try {
  implModule = await import('../lib/comms/inject-budget.js');
} catch (error) {
  implLoadError = error;
}

let MAX_LINE_BYTES = null;
let sinkLoadError = null;
try {
  ({ MAX_LINE_BYTES } = await import('../lib/auditlog/sink.js'));
} catch (error) {
  sinkLoadError = error;
}

const IMPL_NOT_READY = '实现未就绪：`' + IMPL_REL + '` 不可加载'
  + '（' + String(implLoadError && implLoadError.code) + ': '
  + String(implLoadError && implLoadError.message).split('\n')[0] + '）'
  + ' ⇒ 本条判据需该模块落盘后方可跑通；复现命令：' + RERUN_CMD;

const SINK_NOT_READY = '环境未就绪：`' + SINK_REL + '` 不可加载'
  + '（' + String(sinkLoadError && sinkLoadError.code) + ': '
  + String(sinkLoadError && sinkLoadError.message).split('\n')[0] + '）'
  + ' ⇒ 本 checkout 依赖未安装（`node_modules` 为空）；本条判据**须经该模块 import** 方可成立；'
  + '复现命令：' + RERUN_CMD;

/** 解析被测入口（包内只冻结语义；命名差异 ⇒ 退化取首个含 budget 的导出函数，判据不跳过）。 */
function resolveApplyEntry() {
  if (!implModule) throw new Error(IMPL_NOT_READY);
  const names = Object.keys(implModule);
  const ordered = [
    ...names.filter((k) => k === DECLARED_APPLY_NAME),
    ...names.filter((k) => typeof implModule[k] === 'function' && k.toLowerCase().includes('budget')),
    ...names.filter((k) => typeof implModule[k] === 'function'),
  ];
  for (const name of ordered) {
    if (typeof implModule[name] === 'function') return { name, fn: implModule[name] };
  }
  throw new Error('实现未就绪：`' + IMPL_REL + '` 已加载但**无任何导出函数**'
    + '（导出面 = ' + JSON.stringify(names) + '）');
}

let applyEntryCache = null;
function applyEntry() {
  if (!applyEntryCache) applyEntryCache = resolveApplyEntry();
  return applyEntryCache;
}

/** 调用被测入口（统一形态：`{ text, omissions }`）；`kind` 必传 —— 缺省位是 `'total'`。 */
function applyBudget(text, { surface, kind, thresholds = FROZEN_THRESHOLDS } = {}) {
  const { fn } = applyEntry();
  const out = fn(text, { surface, thresholds, kind });
  assert.ok(out && typeof out === 'object', '返回值必须为对象，实得 ' + JSON.stringify(out));
  assert.equal(typeof out.text, 'string', '返回值必须含 `text: string`');
  assert.ok(Array.isArray(out.omissions), '返回值必须含 `omissions: []`');
  return out;
}

function surfaceOf(record) {
  return record && typeof record === 'object' ? String(record.surface) : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 夹具（含**真实数据**锚点与**显式登记的构造夹具**）
// ─────────────────────────────────────────────────────────────────────────────

// ── 真实数据锚点（RED-3 用；只读取样，非构造）─────────────────────────────────
// 取样对象：本机在册批次 `punky-video-copy-final-20261010`
//   （`<引擎根>/sessions/punky-video-prod-20261010/batches/punky-video-copy-final-20261010.json`，284771 B）。
// 取样命令（只读；`batch.handoffs[<下游 lane>][*].contract.assertions` 以 `' | '` 连接后求 UTF-8 字节）：
//   node -e "…读该批次；对每个 handoffs 下游 lane 汇总 contract.assertions 并 join(' | ') 求字节…"
// 原始输出（节选，逐字）：
//   TOP6: [{"lane":"a2-copy-audit","edges":14,"assertions":102,"blockBytes":27478,"maxEdgeBytes":6209}, …]
//   lanes=19 P50=906 P90=6192 P99=27478 max=27478
//   a2-copy-audit: {"lane":"a2-copy-audit","edges":14,"assertions":102,"blockBytes":27478,"maxEdgeBytes":6209}
//   single-assertion max=817 @ a2-copy-audit
//
// ⚠ 与上游 `plan/codebase-survey.md` §3.2 的 27260 B（most-heavy lane 记为 27214 B）**同量级但不逐字节相同**
//   —— 口径差异登记：本件按「一个下游 lane 的**全部**入边断言合并 join(' | ')」计数，上游口径未在本件复核；
//   **结论不受影响**（两种口径下该块均远超 perBlockBytes 12288 ⇒ RED-3 可达）。
const REAL_SAMPLE = Object.freeze({
  batch: 'punky-video-copy-final-20261010',
  lane: 'a2-copy-audit',
  edges: 14,
  assertions: 102,
  blockBytes: 27478,
  maxEdgeBytes: 6209,
  maxSingleAssertionBytes: 817,
});

const ASSERTION_SEP = ' | ';

/**
 * 构造「字节规模对齐真实重载样本」的断言块。
 * 语义：**块级**超标而**单条目**不超标（使 RED-3 只触发层①单块，判据可分辨）。
 * ⚠ 诚实性：断言**内容**为构造（真实批次正文不在仓内、不可依赖）；**字节规模**对齐实测样本。
 */
function buildHeavyAssertions({ count, blockBytes, sep = ASSERTION_SEP } = {}) {
  const n = count ?? REAL_SAMPLE.assertions;
  const target = blockBytes ?? REAL_SAMPLE.blockBytes;
  const sepTotal = Buffer.byteLength(sep, 'utf8') * (n - 1);
  const payload = target - sepTotal;
  assert.ok(payload > n, '夹具参数非法：目标字节不足以分配给 ' + n + ' 条断言');
  const prefixOf = (i) => '夹具断言 ' + String(i + 1).padStart(3, '0') + '：';
  const perItem = Math.floor(payload / n);
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const p = prefixOf(i);
    const fill = Math.max(0, perItem - Buffer.byteLength(p, 'utf8'));
    items.push(p + 'A'.repeat(fill));
  }
  let used = items.reduce((sum, s) => sum + Buffer.byteLength(s, 'utf8'), 0);
  items[n - 1] += 'B'.repeat(payload - used);
  used = items.reduce((sum, s) => sum + Buffer.byteLength(s, 'utf8'), 0);
  assert.equal(used, payload, '夹具自检失败：断言正文合计字节与目标不符');
  return items;
}

/** 构造**恰好 `n` 字节**的 ASCII 文本（字节等价于字符数，用于边界夹具）。 */
function asciiOfBytes(n) {
  return 'A'.repeat(n);
}

const FILES = Object.freeze({
  eventTypes: 'lib/state/event-types.js',
  schema: 'lib/assembly/schema.js',
  swarmTools: 'lib/tools/swarm-tools.js',
  handoffTools: 'lib/tools/handoff-tools.js',
  impl: IMPL_REL,
  sink: SINK_REL,
});

function readSource(rel) {
  const abs = path.join(PKG_ROOT, rel);
  assert.ok(fs.existsSync(abs), '源码缺件：' + rel + '（期望在 ' + abs + '）');
  return fs.readFileSync(abs, 'utf8');
}

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

// 去 `//` 行注释与块注释（保留行结构）—— 与 AC-8「须为 0 或仅出现在注释」同口径。
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 黄金基线（**改动前**直采；见文件末采集说明）。
 * 2026-10-23 重采：`dispatch.js` 的 GR-12 规则由「以判据源 §6 为准 / 形如 L-AC-1..N」改为
 * **形态无关**表述（「承载 exec 验收项的那一章，章号与编号形态随判据源自定」）⇒ 任务包文本 +96B。
 * 原断言编码的是 c3 前的 §6 写死文案，已由 Q-22（指引 6 处文案）覆盖；
 * 本值由 `composeWorkerPrompt` 实跑两次逐字相同（HAS_OMIT_MARK=false）。
 */
const GOLDEN_COMPOSE = Object.freeze({
  bytes: 2152,
  sha256: '0f22d976530cc0b738faf01a9bcddb8bb3a87e77aa51db421b148e5adfe9e96d',
  lines: 37,
});

function goldenComposeArgs() {
  return {
    batchId: 'b-budget-golden',
    lane: 'lane-golden',
    cmd: '夹具目标行',
    layer: 'exec',
    // role **对象**直用 ⇒ `resolveRoleRef` 零文件 I/O ⇒ 输出完全确定（无路径/无时间依赖）
    role: {
      id: 'coder',
      title: '编码工程师',
      mission: '夹具使命',
      responsibilities: ['夹具职责一', '夹具职责二'],
      authorities: ['夹具授权'],
      deliverables: [{ form: '夹具交付件', must_contain: ['## 结果'] }],
    },
    consume: ['plan/spec.md'],
    produce: ['exec/out.md'],
    outputs: ['exec/out.md'],
    firstLine: 'swarm-lane:b-budget-golden/lane-golden#0',
    leaderPrompt: '夹具 Leader 要点',
    artifactsRoot: 'X:/artifacts/b-budget-golden',
  };
}

function sha256Of(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ═════════════════════════════════════════════════════════════════════════════
// A. 环境与夹具自证（不依赖实现 ⇒ 当下即可判读；并把「反例是否真的越界」钉死）
// ═════════════════════════════════════════════════════════════════════════════

test('[ENV] 环境就绪读数（诊断；不判红）：依赖面可加载性 + node_modules 在场性', (t) => {
  const nmDir = path.join(PKG_ROOT, 'node_modules');
  let nmEntries = null;
  try { nmEntries = fs.readdirSync(nmDir).length; } catch { nmEntries = '(不可列)'; }
  t.diagnostic('[ENV] node_modules 条目数 = ' + nmEntries);
  t.diagnostic('[ENV] lib/assembly/schema.js 可加载 = true（静态 import，readCapability 已就绪）');
  t.diagnostic('[ENV] lib/engine/dispatch.js 可加载 = true（静态 import 已成功，否则本文件不加载）');
  t.diagnostic('[ENV] ' + SINK_REL + ' 可加载 = ' + String(!sinkLoadError)
    + (sinkLoadError ? '｜原因 = ' + String(sinkLoadError.code) : ''));
  t.diagnostic('[ENV] ' + IMPL_REL + ' 可加载 = ' + String(!implLoadError)
    + (implLoadError ? '｜原因 = ' + String(implLoadError.code) : ''));
  // 【本批删除 `assert.ok(true)`（原 F-13，`ok-const-true` 恒真式，零保护力）】
  //   为什么**删除**而不是「替强断言」（规格 C-2② 的默认处置在此不适用，理由须留痕）：
  //     · 本块自陈面 = **纯诊断**（见上方 :312）：环境/实现异常由依赖它的具体判据 RED 承载，
  //       「一处问题不污染多条判据读数」是本件明文设计 ⇒ 在此加依赖守卫式 import 的断言会**违反**该设计；
  //     · 本件其余两条静态 import（`readCapability` / `composeWorkerPrompt`）在模块级绑死 ⇒
  //       对它们作断言在结构上不可能失败（不是判据）；
  //     · e3/AD-07 建议的 `assert.match(tail, /原因 = [A-Z_]+/)` 是**环境相关**形态：依赖在外位时诊断串
  //       不含「原因 = 」⇒ 健康环境即假红（本 lane 复核后不采）。
  //   删除性检验：删后本件仍 31/31 pass（e2 K6 已实测，本 lane 复跑见 progress/02）；`tautologies` 2→1（改善）。
});

test('[FIX-1] 真实重载样本夹具自证：102 条断言 / 27478 B 块 / 单条不超 perItemBytes', () => {
  const items = buildHeavyAssertions({ count: REAL_SAMPLE.assertions, blockBytes: REAL_SAMPLE.blockBytes });
  const joined = items.join(ASSERTION_SEP);
  assert.equal(items.length, REAL_SAMPLE.assertions, '断言条数须等于实测样本条数');
  assert.equal(Buffer.byteLength(joined, 'utf8'), REAL_SAMPLE.blockBytes,
    '夹具块字节须**精确等于**实测样本字节（否则反例规模失真）');
  assert.ok(Buffer.byteLength(joined, 'utf8') > FROZEN_THRESHOLDS.perBlockBytes,
    '块字节必须 > perBlockBytes 12288（否则 RED-3 不可达）');
  const maxItem = Math.max(...items.map((s) => Buffer.byteLength(s, 'utf8')));
  assert.ok(maxItem <= FROZEN_THRESHOLDS.perItemBytes,
    '单条最大 ' + maxItem + ' B 必须 ≤ perItemBytes 3072 ⇒ 使 RED-3 只触发块层（判据可分辨）');
  assert.ok(maxItem <= REAL_SAMPLE.maxSingleAssertionBytes * 2,
    '单条规模须与真实样本同量级（实测单条 max ' + REAL_SAMPLE.maxSingleAssertionBytes + ' B）');
});

test('[FIX-2] 边界夹具自证：恰等于阈值 与 阈值+1 的字节差恒为 1', () => {
  const itemAt = asciiOfBytes(FROZEN_THRESHOLDS.perItemBytes);
  const itemOver = asciiOfBytes(FROZEN_THRESHOLDS.perItemBytes + 1);
  assert.equal(Buffer.byteLength(itemAt, 'utf8'), FROZEN_THRESHOLDS.perItemBytes);
  assert.equal(Buffer.byteLength(itemOver, 'utf8'), FROZEN_THRESHOLDS.perItemBytes + 1);
  assert.equal(Buffer.byteLength(itemOver, 'utf8') - Buffer.byteLength(itemAt, 'utf8'), 1,
    '两边界夹具必须**逐字节只差 1**（否则 RED-6 锁不住 > vs >=）');
  const totalAt = asciiOfBytes(FROZEN_THRESHOLDS.totalBytes);
  const totalOver = asciiOfBytes(FROZEN_THRESHOLDS.totalBytes + 1);
  assert.equal(Buffer.byteLength(totalOver, 'utf8') - Buffer.byteLength(totalAt, 'utf8'), 1);
});

test('[FIX-3] 同源锁**静态**前提：sink.js 源码导出常量 32768 且冻结 totalBytes 与之同值', () => {
  const sinkSrc = readSource(FILES.sink);
  assert.ok(/export const MAX_LINE_BYTES = 32768;/.test(sinkSrc),
    '`' + SINK_REL + '` 须**导出**常量 `MAX_LINE_BYTES = 32768`（位宽同源的可核前提）');
  assert.equal(FROZEN_THRESHOLDS.totalBytes, 32768, '冻结 totalBytes 须为 32768');
  // 附：truncateUtf8 私有的自证（包内「不可复用」结论的依据，AC-24 类锚点）
  const truncDecl = sinkSrc.match(/^function truncateUtf8\(/m);
  assert.ok(truncDecl, '`truncateUtf8` 须为模块私有（`function truncateUtf8(` 行首声明）');
  assert.ok(!/^export function truncateUtf8\(/m.test(sinkSrc),
    '`truncateUtf8` **不得**被导出（导出即越界 + 使 e2 写域变 9 件）');
});

test('[FIX-4] 黄金基线确定性自证：同夹具连算两次 sha256 相等且无省略标记', () => {
  const a = composeWorkerPrompt(goldenComposeArgs());
  const b = composeWorkerPrompt(goldenComposeArgs());
  assert.equal(sha256Of(a), sha256Of(b), '同夹具两次调用须逐字节相同（否则黄金基线不可用）');
  assert.ok(!a.includes('omitted'), '未超限入参不得出现省略标记');
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 冻结值与注册表（AC-8 / AC-16 / 位宽同源锁 AC-5）
// ═════════════════════════════════════════════════════════════════════════════

test('[AC-8] 冻结值 × readCapability 逐值相等 + 默认开（AC-16）', () => {
  const fromRegistry = readCapability({}, 'injectBudget');
  assert.ok(fromRegistry && typeof fromRegistry === 'object',
    'readCapability({}, \'injectBudget\') 须返回对象原值（实得 ' + JSON.stringify(fromRegistry) + '）');
  assert.deepEqual(fromRegistry, FROZEN_THRESHOLDS, '注册表默认值须与本件冻结值逐值相等（单一取值源）');
  assert.equal(fromRegistry.enabled, true, '默认须开（AC-16：免改 OFF_KEYS）');
});

test('[AC-5] 位宽同源锁：readCapability({},\'injectBudget\').totalBytes === MAX_LINE_BYTES（import 自 sink.js）', () => {
  if (sinkLoadError) throw new Error(SINK_NOT_READY);
  assert.equal(MAX_LINE_BYTES, 32768, 'sink.js 的导出常量 MAX_LINE_BYTES 须为 32768');
  assert.equal(readCapability({}, 'injectBudget').totalBytes, MAX_LINE_BYTES,
    '位宽同源锁：注册表 totalBytes 必须 === MAX_LINE_BYTES（防位宽漂移）');
});

test('[AC-8] 实现内无散落阈值字面量（读数形态 = grep 须为 0 或仅出现在注释）', () => {
  const src = readSource(FILES.impl);
  const code = stripComments(src);
  const hits = code.match(/\b(3072|12288|32768|2048|1024)\b/g) ?? [];
  assert.deepEqual(hits, [],
    '实现内出现散落阈值字面量（须由调用方经 capabilities.injectBudget 传入）：' + JSON.stringify(hits));
  for (const name of ['perItemBytes', 'perBlockBytes', 'totalBytes', 'headBytes', 'tailBytes']) {
    assert.ok(src.includes(name), '实现应引用阈值字段名 `' + name + '`（而非内联其数值）');
  }
});

test('[API] 接口对账：导出符号名 + 层选择位 kind + 返回形状（命名差异不跳过判据）', (t) => {
  const { name } = applyEntry();
  assert.ok(implModule, IMPL_NOT_READY);
  t.diagnostic('[API] 实测导出符号名 = ' + name + '（包内声明 = ' + DECLARED_APPLY_NAME + '）');
  const out = applyBudget('短文本', { surface: SURFACE.cmd, kind: KIND.total });
  assert.equal(typeof out.text, 'string');
  assert.ok(Array.isArray(out.omissions));
  // 层选择位行为自证：同一超限文本按三种 kind 各自的限值判定（kind 必须真的切换阈值字段）
  const probe = asciiOfBytes(FROZEN_THRESHOLDS.perBlockBytes + 64); // > perBlock，但 < total
  const asItem = applyBudget(probe, { surface: SURFACE.assertions, kind: KIND.perItem });
  const asBlock = applyBudget(probe, { surface: SURFACE.assertions, kind: KIND.perBlock });
  const asTotal = applyBudget(probe, { surface: SURFACE.assertions, kind: KIND.total });
  assert.ok(asItem.text !== probe, 'kind=perItem 时该文本（>' + FROZEN_THRESHOLDS.perItemBytes + 'B）须被截断');
  assert.ok(asBlock.text !== probe, 'kind=perBlock 时该文本（>' + FROZEN_THRESHOLDS.perBlockBytes + 'B）须被截断');
  assert.strictEqual(asTotal.text, probe, 'kind=total 时该文本（<' + FROZEN_THRESHOLDS.totalBytes + 'B）须原值返回');
});

// ═════════════════════════════════════════════════════════════════════════════
// C. 零回归（AC-13 双证 / AC-14 消费点黄金基线 / enabled:false 零动作）
// ═════════════════════════════════════════════════════════════════════════════

test('[AC-13] 零回归双证：未超限 ⇒ 返回入参**原值本身**（引用相等）且 byteLength 相等', () => {
  const text = '未超限的注入面文本（含中文夹具）';
  const result = applyBudget(text, { surface: SURFACE.cmd, kind: KIND.perItem });
  // 证①：引用相等（锁死「不重新拼接」）
  assert.strictEqual(result.text, text, '未超限时 result.text 必须与入参**同一引用**（strictEqual）');
  // 证②：字节相等（可核读数）
  assert.equal(Buffer.byteLength(result.text, 'utf8'), Buffer.byteLength(text, 'utf8'));
  assert.deepEqual(result.omissions, [], '未超限 ⇒ 零省略记录');
});

test('[AC-13] 零回归双证：恰在**各层阈值以内**的多样本均原值返回', () => {
  const cases = [
    { surface: SURFACE.cmd, kind: KIND.perItem, text: 'x'.repeat(FROZEN_THRESHOLDS.perItemBytes - 8) },
    { surface: SURFACE.leaderPrompt, kind: KIND.perItem, text: 'y'.repeat(FROZEN_THRESHOLDS.perItemBytes - 1) },
    { surface: SURFACE.wakeSummary, kind: KIND.perBlock, text: '摘要' + 'z'.repeat(FROZEN_THRESHOLDS.perItemBytes - 200) },
  ];
  for (const c of cases) {
    const r = applyBudget(c.text, { surface: c.surface, kind: c.kind });
    assert.strictEqual(r.text, c.text, '面 ' + c.surface + '（kind=' + c.kind + '）：未超限须引用相等');
    assert.equal(Buffer.byteLength(r.text, 'utf8'), Buffer.byteLength(c.text, 'utf8'),
      '面 ' + c.surface + '：未超限须字节相等');
    assert.deepEqual(r.omissions, [], '面 ' + c.surface + '：未超限须零省略');
  }
});

test('[AC-14] 消费点零回归：composeWorkerPrompt 未超限输出 === 改动前黄金基线（sha256 逐字节）', () => {
  const out = composeWorkerPrompt(goldenComposeArgs());
  const bytes = Buffer.byteLength(out, 'utf8');
  const sha = sha256Of(out);
  assert.equal(bytes, GOLDEN_COMPOSE.bytes,
    '未超限入参下 `composeWorkerPrompt` 输出字节数须与改动前逐字节相同（实测 ' + bytes + ' vs 基线 ' + GOLDEN_COMPOSE.bytes + '）');
  assert.equal(sha, GOLDEN_COMPOSE.sha256,
    'sha256 须等于**改动前**直采基线 ' + GOLDEN_COMPOSE.sha256 + '（实得 ' + sha + '）');
  assert.equal(out.split('\n').length, GOLDEN_COMPOSE.lines, '行数须与基线相同');
  assert.ok(!out.includes('omitted'), '未超限入参不得在任务包内出现省略标记');
});

test('[3.5] enabled:false ⇒ 恒零动作（引用相等 + 零 omissions）', () => {
  const text = asciiOfBytes(FROZEN_THRESHOLDS.totalBytes + 4096);
  const result = applyBudget(text, {
    surface: SURFACE.assertions,
    kind: KIND.perBlock,
    thresholds: { ...FROZEN_THRESHOLDS, enabled: false },
  });
  assert.strictEqual(result.text, text, '关闭态须返回入参原值本身（不截断、不改文本）');
  assert.deepEqual(result.omissions, [], '关闭态须零省略记录');
});

// ═════════════════════════════════════════════════════════════════════════════
// D. 四层结构齐备（AC-8）与可达反例（RED-3 / RED-4 / RED-5）
// ═════════════════════════════════════════════════════════════════════════════

test('[RED-4] 层①单条目：单条超 perItemBytes ⇒ 截断 + omissions 含 handoff.assertion（**构造用例**）', () => {
  // ⚠ 诚实性登记：**真实数据不可达** —— 实测单条 assertion max 817 B（样本 = punky-video-copy-final-20261010）
  //   与全局实测 max 1449 B 均 < perItemBytes 3072 ⇒ 本用例为**构造**，不得读作真实数据。
  const item = asciiOfBytes(FROZEN_THRESHOLDS.perItemBytes + 512);
  assert.ok(Buffer.byteLength(item, 'utf8') > FROZEN_THRESHOLDS.perItemBytes);
  const result = applyBudget(item, { surface: SURFACE.assertion, kind: KIND.perItem });
  assert.ok(result.text !== item, '超限必须发生截断');
  assert.ok(Buffer.byteLength(result.text, 'utf8') < Buffer.byteLength(item, 'utf8'), '截断后字节须变小');
  assert.ok(result.omissions.some((o) => surfaceOf(o) === SURFACE.assertion),
    'omissions 须含 `' + SURFACE.assertion + '`，实得 ' + JSON.stringify(result.omissions));
  assert.ok(result.omissions.some((o) => Number(o.omittedBytes) > 0), '省略字节须 > 0');
});

test('[RED-3] 层①单块：真实重载块 27478 B > perBlockBytes ⇒ 截断 + omissions 含 handoff.assertions', () => {
  // 反例取自**真实数据**：批次 punky-video-copy-final-20261010 的 lane `a2-copy-audit`
  //   = 14 条入边 / 102 条断言 / join(' | ') 后 27478 B（取样命令与原始输出见本文件 REAL_SAMPLE 注释）。
  const items = buildHeavyAssertions({ count: REAL_SAMPLE.assertions, blockBytes: REAL_SAMPLE.blockBytes });
  const block = items.join(ASSERTION_SEP);
  assert.equal(Buffer.byteLength(block, 'utf8'), REAL_SAMPLE.blockBytes);
  const result = applyBudget(block, { surface: SURFACE.assertions, kind: KIND.perBlock });
  assert.ok(result.text !== block, '真实重载块必须被截断（可达反例）');
  const hit = result.omissions.find((o) => surfaceOf(o) === SURFACE.assertions);
  assert.ok(hit, 'omissions 须含 `' + SURFACE.assertions + '`，实得 ' + JSON.stringify(result.omissions));
  assert.ok(Number(hit.omittedBytes) > 0, '`' + SURFACE.assertions + '` 的省略字节须 > 0');
  // 单条均未超 perItemBytes ⇒ 以 perItem 层单独施加时**不应**触发（判据可分辨，防「一刀切」假实现）
  const asItem = applyBudget(block, { surface: SURFACE.assertions, kind: KIND.perItem });
  assert.ok(asItem.text !== block, 'perItem 层对 27478 B 块必然触发（该层限值 3072 < 块字节）');
});

test('[RED-5] 层②总量：超 totalBytes 32768 ⇒ 总量层截断 + omissions 含 `.total` 面', () => {
  const text = asciiOfBytes(FROZEN_THRESHOLDS.totalBytes + 1);
  assert.ok(Buffer.byteLength(text, 'utf8') > FROZEN_THRESHOLDS.totalBytes);
  const result = applyBudget(text, { surface: SURFACE.taskpackTotal, kind: KIND.total });
  assert.ok(result.text !== text, '总量超限必须发生截断');
  assert.ok(result.omissions.length >= 1, '总量层须至少产一条省略记录');
  assert.ok(result.omissions.some((o) => surfaceOf(o).endsWith('.total')),
    'omissions 须含对应 `.total` 面，实得 ' + JSON.stringify(result.omissions));
});

test('[RED-5] 层②总量：wake.total 面同样可触发（面名集合内第二实例）', () => {
  const text = asciiOfBytes(FROZEN_THRESHOLDS.totalBytes + 2048);
  const result = applyBudget(text, { surface: SURFACE.wakeTotal, kind: KIND.total });
  assert.ok(result.text !== text, '唤醒消息总量超限必须发生截断');
  assert.ok(result.omissions.some((o) => surfaceOf(o).endsWith('.total')),
    'omissions 须含 `.total` 面，实得 ' + JSON.stringify(result.omissions));
});

test('[AC-8] 层③ head-tail：截断后保结构头（headBytes 段原样）与结论尾（tailBytes 段原样）', () => {
  const head = 'HEAD'.padEnd(FROZEN_THRESHOLDS.headBytes, 'h');
  const tail = 'TAIL'.padEnd(FROZEN_THRESHOLDS.tailBytes, 't');
  const middle = 'M'.repeat(FROZEN_THRESHOLDS.perBlockBytes * 2);
  const text = head + middle + tail;
  const result = applyBudget(text, { surface: SURFACE.assertions, kind: KIND.perBlock });
  assert.ok(result.text !== text, '超限必须截断');
  assert.ok(result.text.startsWith(head), '截断后须**原样保留**头 headBytes 段（保结构头）');
  assert.ok(result.text.endsWith(tail), '截断后须**原样保留**尾 tailBytes 段（保结论尾）');
});

test('[AC-8] 分层不合并：单条目层与单块层**各自**独立产一条记录（调用方按序各呼一次）', () => {
  // 交付契约：一次调用只施一层、恰一条记录 ⇒ 「分层不合并」= 两次调用共两条**面名可分辨**的记录。
  const itemOver = asciiOfBytes(FROZEN_THRESHOLDS.perItemBytes + 256);
  const r1 = applyBudget(itemOver, { surface: SURFACE.assertion, kind: KIND.perItem });
  assert.equal(r1.omissions.length, 1, '单条目层须**恰产一条**记录，实得 ' + JSON.stringify(r1.omissions));
  assert.equal(surfaceOf(r1.omissions[0]), SURFACE.assertion);

  const blockItems = buildHeavyAssertions({ count: 64, blockBytes: FROZEN_THRESHOLDS.perBlockBytes + 512 })
    .map((s) => s.slice(0, Math.min(s.length, 400)));
  const block = blockItems.join(ASSERTION_SEP);
  assert.ok(Buffer.byteLength(block, 'utf8') > FROZEN_THRESHOLDS.perBlockBytes, '夹具须确使块层超标');
  const r2 = applyBudget(block, { surface: SURFACE.assertions, kind: KIND.perBlock });
  assert.equal(r2.omissions.length, 1, '单块层须**恰产一条**记录，实得 ' + JSON.stringify(r2.omissions));
  assert.equal(surfaceOf(r2.omissions[0]), SURFACE.assertions);

  const merged = [...r1.omissions, ...r2.omissions];
  assert.equal(merged.length, 2, '两层各自一条 ⇒ 合计 2 条（**不合并**）');
  assert.ok(surfaceOf(merged[0]) !== surfaceOf(merged[1]),
    '两条记录的面名须可分辨（audit 据此判「哪个面省略了多少」）');
});

// ═════════════════════════════════════════════════════════════════════════════
// E. 层④ 显式省略标记（AC-9）
// ═════════════════════════════════════════════════════════════════════════════

test('[AC-9] 标记可见且含字节数：`…[omitted <N>B @ <surface>]` 的 <N> 与 omissions[].omittedBytes 相等', () => {
  const text = asciiOfBytes(FROZEN_THRESHOLDS.totalBytes + 1);
  const result = applyBudget(text, { surface: SURFACE.taskpackTotal, kind: KIND.total });
  const marks = [...result.text.matchAll(OMIT_MARK_RE)];
  assert.ok(marks.length >= 1, '超限文本须自带省略标记，实得文本尾部：' + JSON.stringify(result.text.slice(-120)));
  for (const m of marks) {
    const n = m[1];
    const surface = m[2];
    assert.match(n, /^\d+$/, '`<N>` 须为**十进整数**，实得 ' + JSON.stringify(n));
    const rec = result.omissions.find((o) => surfaceOf(o) === surface);
    assert.ok(rec, '标记内的面名 `' + surface + '` 须在 omissions 内出现，实得 '
      + JSON.stringify(result.omissions));
    assert.equal(Number(n), Number(rec.omittedBytes),
      '标记内字节数须与 omissions[].omittedBytes **相等**（标记 ' + n + ' vs 记录 ' + rec.omittedBytes + '）');
    assert.ok(Number(rec.omittedBytes) > 0
      && Number(rec.omittedBytes) <= Buffer.byteLength(text, 'utf8'),
      '省略字节须落在 (0, 原文字节] 内，实得 ' + rec.omittedBytes);
  }
});

test('[AC-9] 标记在场于块级反例：真实重载块的截断文本含标记且面名取自冻结集合', () => {
  const items = buildHeavyAssertions({ count: REAL_SAMPLE.assertions, blockBytes: REAL_SAMPLE.blockBytes });
  const result = applyBudget(items.join(ASSERTION_SEP), { surface: SURFACE.assertions, kind: KIND.perBlock });
  const marks = [...result.text.matchAll(OMIT_MARK_RE)];
  assert.ok(marks.length >= 1, '块级截断文本须含省略标记');
  const frozen = new Set(Object.values(SURFACE));
  for (const m of marks) {
    assert.ok(frozen.has(m[2]), '标记面名须取自冻结面名集合，实得 ' + JSON.stringify(m[2])
      + '（集合 = ' + JSON.stringify([...frozen]) + '）');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// F. 边界口径（RED-6：锁死 `>` 而非 `>=`）
// ═════════════════════════════════════════════════════════════════════════════

test('[RED-6a] 单条目**恰等于** perItemBytes ⇒ 不截断、零省略（严格大于才触发）', () => {
  const text = asciiOfBytes(FROZEN_THRESHOLDS.perItemBytes);
  assert.equal(Buffer.byteLength(text, 'utf8'), FROZEN_THRESHOLDS.perItemBytes);
  const result = applyBudget(text, { surface: SURFACE.assertion, kind: KIND.perItem });
  assert.strictEqual(result.text, text, '恰等于阈值 ⇒ 须返回入参原值本身');
  assert.deepEqual(result.omissions, [], '恰等于阈值 ⇒ 零省略');
});

test('[RED-6b] 单条目 = perItemBytes + 1 ⇒ 触发截断', () => {
  const text = asciiOfBytes(FROZEN_THRESHOLDS.perItemBytes + 1);
  const result = applyBudget(text, { surface: SURFACE.assertion, kind: KIND.perItem });
  assert.ok(result.text !== text, '阈值 +1 ⇒ 必须触发');
  assert.ok(result.omissions.length >= 1, '阈值 +1 ⇒ 须产省略记录');
});

test('[RED-6c] 总量**恰等于** totalBytes ⇒ 不截断、零省略', () => {
  const text = asciiOfBytes(FROZEN_THRESHOLDS.totalBytes);
  const result = applyBudget(text, { surface: SURFACE.taskpackTotal, kind: KIND.total });
  assert.strictEqual(result.text, text, '恰等于 totalBytes ⇒ 须返回入参原值本身');
  assert.deepEqual(result.omissions, [], '恰等于 totalBytes ⇒ 零省略');
});

test('[RED-6d] 总量 = totalBytes + 1 ⇒ 触发截断', () => {
  const text = asciiOfBytes(FROZEN_THRESHOLDS.totalBytes + 1);
  const result = applyBudget(text, { surface: SURFACE.taskpackTotal, kind: KIND.total });
  assert.ok(result.text !== text, 'totalBytes +1 ⇒ 必须触发');
  assert.ok(result.omissions.length >= 1, 'totalBytes +1 ⇒ 须产省略记录');
});

test('[RED-6e] 单块**恰等于** perBlockBytes ⇒ 不截断、零省略', () => {
  const items = buildHeavyAssertions({ count: 64, blockBytes: FROZEN_THRESHOLDS.perBlockBytes });
  const block = items.join(ASSERTION_SEP);
  assert.equal(Buffer.byteLength(block, 'utf8'), FROZEN_THRESHOLDS.perBlockBytes);
  const result = applyBudget(block, { surface: SURFACE.assertions, kind: KIND.perBlock });
  assert.strictEqual(result.text, block, '恰等于 perBlockBytes ⇒ 须返回入参原值本身');
  assert.deepEqual(result.omissions, [], '恰等于 perBlockBytes ⇒ 零省略');
});

// ═════════════════════════════════════════════════════════════════════════════
// G. UTF-8 破字防护（AC-10 关联；禁按 String.length 切）
// ═════════════════════════════════════════════════════════════════════════════

test('[UTF-8] 含多字节字符的超限入参 ⇒ 截断后不出现替换字符 \\uFFFD 且可无损往返', () => {
  const unit = '蟛蜞预算注入面';    // 每字 3 字节
  const emoji = '🚀';               // 4 字节（代理对）
  let text = '';
  while (Buffer.byteLength(text, 'utf8') < FROZEN_THRESHOLDS.perBlockBytes + 512) text += unit + emoji;
  assert.ok(Buffer.byteLength(text, 'utf8') > FROZEN_THRESHOLDS.perBlockBytes);
  const result = applyBudget(text, { surface: SURFACE.assertions, kind: KIND.perBlock });
  assert.ok(result.text !== text, '须发生截断（否则本用例不覆盖破字路径）');
  assert.ok(!result.text.includes('\uFFFD'),
    '截断后不得出现替换字符 \\uFFFD（按 String.length 切会在多字节字符中间破字）');
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text,
    '截断结果须可 UTF-8 无损往返（无孤立代理/截断码点）');
  assert.ok(result.omissions.some((o) => Number(o.omittedBytes) > 0), '省略字节须 > 0');
});

// ═════════════════════════════════════════════════════════════════════════════
// H. 结构面（AC-11 命名 / AC-12 唯一发射点 / AC-17 回显 schema 声明）
// ═════════════════════════════════════════════════════════════════════════════

test('[AC-11] 事件常量单点落表：event-types.js 含 EVT_INJECT_OMITTED = \'inject.omitted\'', () => {
  const src = readSource(FILES.eventTypes);
  assert.ok(/EVT_INJECT_OMITTED\s*=\s*['"]inject\.omitted['"]/.test(src),
    'lib/state/event-types.js 须**单点**落常量 `EVT_INJECT_OMITTED = \'inject.omitted\'`');
});

test('[AC-11] 命名冲突规避：`capabilities.budget` 零新增，三禁名零新增用法', () => {
  // 既有基线（改动前直读，2026-10-11）：schema.js 的 DEP-4 消息含 1 处 `capabilities.budget`（**既有**，非新增）。
  const PRE_EXISTING_SCHEMA_HITS = 1;
  const schemaHits = countMatches(readSource(FILES.schema), /capabilities\.budget/g);
  assert.ok(schemaHits <= PRE_EXISTING_SCHEMA_HITS,
    '`capabilities.budget` 命中数不得增加（基线 ' + PRE_EXISTING_SCHEMA_HITS + '，实得 ' + schemaHits + '）');
  const implSrc = readSource(FILES.impl);
  assert.equal(countMatches(implSrc, /capabilities\.budget/g), 0, '实现内不得出现 `capabilities.budget`');
  for (const banned of ['lane.over-budget', 'budget.rejected']) {
    assert.equal(countMatches(implSrc, new RegExp(banned.replace('.', '\\.'), 'g')), 0,
      '实现内不得出现禁名 `' + banned + '`');
  }
});

test('[AC-12] 非对称发射：swarm_report 为唯一发射点，handoff_view 零发射', () => {
  const swarmSrc = readSource(FILES.swarmTools);
  const handoffSrc = readSource(FILES.handoffTools);
  assert.ok(/EVT_INJECT_OMITTED|'inject\.omitted'/.test(swarmSrc),
    'swarm-tools.js 须为 `inject.omitted` 的发射点（引用常量或字面量）');
  assert.ok(!/EVT_INJECT_OMITTED|'inject\.omitted'/.test(handoffSrc),
    'handoff-tools.js **不得**发射 `inject.omitted`（保其「零写入、不改任何状态」契约）');
});

test('[AC-17] 回显加键已同步声明 output.schema：两工具均含 `omissions`', () => {
  for (const rel of [FILES.handoffTools, FILES.swarmTools]) {
    assert.ok(readSource(rel).includes('omissions'), rel + ' 的 output.schema.properties 须声明 `omissions`'
      + '（`additionalProperties:false` 下漏声明即宿主判 invalid output 假失败）');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 采集说明（黄金基线出处，供 audit 复核）
// ═════════════════════════════════════════════════════════════════════════════
//
// [AC-14] 的 GOLDEN_COMPOSE 于**改动前**直采（2026-10-11，包根 = packages/dsh-punky-swarm）：
//   前置核验：`lib/engine/dispatch.js` mtime = 2026-10-09T17:08:45Z（**未被本批改动**，
//     即与 `git HEAD 549f29a` 的工作树同源）⇒ 该输出确为「改动前」读数。
//   采集命令（只读，零写盘）：
//     node --import ./test/helpers/isolated-home.preload.mjs -e "<以 goldenComposeArgs 同参调用
//       composeWorkerPrompt，打印 Buffer.byteLength 与 sha256>"
//   原始输出（两次连跑逐字相同）：
//     2056 8baaaa4e9db9bb19878e25401ac13e54cef0f57f1965013ebed079da66d07a7c
//     2056 8baaaa4e9db9bb19878e25401ac13e54cef0f57f1965013ebed079da66d07a7c
//   佐证：LINES=37、HAS_OMIT_MARK=false。
