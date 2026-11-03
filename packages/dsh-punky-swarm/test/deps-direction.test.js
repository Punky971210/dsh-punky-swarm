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

// test/deps-direction.test.js —— **依赖方向棘轮**（批 `punky-deps-direction-20261102` · lane `impl` · 方案 α）
//
// 一句话判据（spec §D-1）：
//   `lib/**`（**排除** `lib/index.js` 与 `lib/provider-dsh/**`）内 `from '…provider-dsh/…'` 的
//   (file, symbol) 集合 **≡ 白名单集合**（**双向相等**）。
//
// 为什么需要它：本批方向是「**引擎不依赖 provider**」。但实测有 9 处 import / 17 行 `create*Port(...)` 调用
//   仍在引擎侧直构 provider 端口。经论证改造只能消 2/9（`data-plane-server` + `api`，剩 7 处**结构不可消**：
//   需 per-call `presetFor` / `exec.agent`，或属注册动作现场）＝收益有限；**真正的风险面是「将来新增第 10/11 处」**。
//   ⇒ 立棘轮：新增必须显式提交理由；且**白名单只许减不许增**（spec R-5）。
//
// ⚠⚠ **A4 警示（必读，勿把本判据读成「重复创建/调用都无害」）** ⚠⚠
//   「**重复创建端口无害**」**不得**延伸为「**重复调用无害**」。四个 `create*Port` 是纯工厂（无模块级状态），
//   但**端口方法**里有**累积副作用**的方法：
//     · `registerTool` —— 对同一工具名重复调用 ⇒ **重复注册**（后写覆盖或双份登记，取决于宿主）
//     · `installGuard`  —— **追加**式挂 guard ⇒ 对同一目标重复调用 ⇒ 同一拦截**跑 N 遍**
//     · `mountRoute`    —— 对同一 route 重复挂 ⇒ 重复路由 / 重复 dispose
//   **现状实测无此 bug**（各调用注册的是**不同**目标），但**机制上允许误写** ⇒
//   不要把本判据的「多处直构被白名单放过」误读为「多处调用安全」。要看调用语义，别看 import 数量。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const LIB = path.join(PKG_ROOT, 'lib');

/** 排除面（spec §D-1）：装配根允许依赖 provider；provider 自身当然读自己。 */
const isExempt = (relFromLib) => {
  const posix = relFromLib.split(path.sep).join('/');
  return posix === 'index.js' || posix.startsWith('provider-dsh/');
};

/**
 * 扫出源码里**注释**与**字符串字面量**的区间（返回 `{start,end}` 列表）。
 *
 * 用途：判据只认 `import` **语句**（R-7）。做法 = 在**原文**上跑 import 正则，然后**跳过起点落在
 * 注释/字符串区间内**的匹配 —— 而不是先把字符串内容抹掉再匹配（那样 import 的**路径**也会被抹掉 ⇒ 零命中，
 * 本文件第一版就是这样，被 D-1 的「实测面非空」前置当场抓到）。
 */
export function maskedSpans(src) {
  const s = String(src ?? '');
  const spans = [];
  let i = 0;
  let mode = 'code';
  let start = -1;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; start = i; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; start = i; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; start = i; i += 1; continue; }
      i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { spans.push({ start, end: i }); mode = 'code'; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { spans.push({ start, end: i + 2 }); mode = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    // 字符串 / 模板串
    if (c === '\\') { i += 2; continue; }
    if (c === mode) { spans.push({ start, end: i + 1 }); mode = 'code'; i += 1; continue; }
    i += 1; continue;
  }
  if (mode !== 'code' && start >= 0) spans.push({ start, end: s.length });
  return spans;
}

/** 文本版（保留给可读性/后续复用）：注释与字符串内容替换为空格，长度不变。 */
export function codeOnly(src) {
  const s = String(src ?? '');
  const chars = s.split('');
  for (const sp of maskedSpans(s)) {
    for (let k = sp.start; k < sp.end; k += 1) if (chars[k] !== '\n') chars[k] = ' ';
  }
  return chars.join('');
}

const inAnySpan = (spans, index) => spans.some((sp) => index >= sp.start && index < sp.end);

/**
 * 抽出一个文件里 **import 语句** 引用的 `provider-dsh/**` 符号。
 *
 * @returns {Array<{file:string, line:number, symbol:string, target:string}>} `file` = lib 相对 posix 路径
 */
export function importsOf(src, fileRelFromLib) {
  const original = String(src ?? '');
  const spans = maskedSpans(original);
  const lines = original.split('\n');
  const lineStart = (n) => { let off = 0; for (let k = 0; k < n; k += 1) off += lines[k].length + 1; return off; };
  const out = [];
  const file = fileRelFromLib.split(path.sep).join('/');

  for (let i = 0; i < lines.length; i += 1) {
    // 语句级起点：行首（可含缩进）就是 `import`
    if (!/^\s*import\b/.test(lines[i])) continue;
    if (inAnySpan(spans, lineStart(i))) continue;   // R-7：注释里的同形文本不算
    // **按语句**累积到 `from '…'` 为止（不跨到下一条语句 ⇒ 防「第一条 import 吞掉后面所有 from」）
    let text = '';
    let j = i;
    for (; j < lines.length && j < i + 60; j += 1) {
      text += lines[j] + '\n';
      if (/\bfrom\s*(['"])[^'"]*\1/.test(text)) break;
    }
    const m = text.match(/^\s*import\s+([\s\S]*?)\s+from\s*(['"])([^'"]*)\2/);
    if (!m) { i = j; continue; }
    const target = m[3];
    const line = i + 1;
    i = j;
    if (!target.includes('provider-dsh/')) continue;  // 非本判据对象
    const clause = m[1];
    // 具名导入 `{ a, b as c }` ⇒ 取导入名（`as` 左侧）
    const named = clause.match(/\{([\s\S]*?)\}/);
    const symbols = [];
    if (named) {
      for (const part of named[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const name = t.split(/\s+as\s+/)[0].trim();
        if (name) symbols.push(name);
      }
    } else {
      // 默认导入 / 命名空间导入（本仓目前未用，留可见处理，避免静默漏判）
      const def = clause.trim();
      if (def && !def.startsWith('*')) symbols.push(def);
    }
    for (const symbol of symbols) out.push({ file, line, symbol, target });
  }
  return out;
}

/** 递归扫一棵 `lib/` 树（**可指向临时目录** ⇒ 可达构造复用同一实现，不另建第二套判据）。 */
export function scanTree(libRoot) {
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|ts)$/.test(ent.name)) continue;
      const rel = path.relative(libRoot, abs);
      if (isExempt(rel)) continue;
      found.push(...importsOf(fs.readFileSync(abs, 'utf8'), rel));
    }
  };
  walk(libRoot);
  return found;
}

const keyOf = (e) => e.file + ':' + e.symbol;

/**
 * **双向相等**（spec §D-3）：
 *   · `added` = 实测有、白名单无 ⇒ **新增依赖**（判红）
 *   · `stale` = 白名单有、实测无 ⇒ **过期白名单**（也判红 —— 防「靠留白名单掩盖已消除的依赖」）
 */
export function diffAgainstWhitelist(found, whitelist) {
  const foundKeys = new Set(found.map(keyOf));
  const wlKeys = new Set(whitelist.map(keyOf));
  const added = [...foundKeys].filter((k) => !wlKeys.has(k)).sort();
  const stale = [...wlKeys].filter((k) => !foundKeys.has(k)).sort();
  return { added, stale, ok: added.length === 0 && stale.length === 0 };
}

/**
 * 白名单（**只许减不许增**，spec R-5）。每条 4 字段：`file` / `symbol` / `class` / `reason`。
 * `class`：**A1** = 可改（有注入面，本批保留，为 β 提供可检索靶面）｜**A3** = 显式例外（结构不可消）。
 */
export const WHITELIST = [
  // ── A1（可改，本批不改；β 落地后应删这几条）────────────────────────────
  { file: 'api.js', symbol: 'createHttpPort', class: 'A1', reason: '纯依赖 ctx 的工厂；本模块已有 deps 注入面（createApi(ctx, deps)）⇒ 可改「注入优先 + 回落直构」，本批不改' },
  { file: 'mcp/data-plane-server.js', symbol: 'createToolsPort', class: 'A1', reason: '纯依赖 ctx；模块已有 deps 参数（installMcpDataPlane(ctx, deps)）⇒ 可改注入优先，本批不改' },
  { file: 'mcp/data-plane-server.js', symbol: 'createHttpPort', class: 'A1', reason: '同上（同一模块的 HTTP 面直构点）' },
  // ── A3（显式例外：需 per-call 参数 或 属注册动作现场）────────────────────
  { file: 'engine/dispatch.js', symbol: 'createAgentPort', class: 'A3', reason: 'agentPort 需 per-call presetFor（热更配置）⇒ 结构不可预装配' },
  { file: 'tools/host-surface.js', symbol: 'createRosterPort', class: 'A3', reason: 'rosterPort 需 per-call agent 凭据（exec.agent）⇒ 不可预装配' },
  { file: 'bridge/dispatch-register.js', symbol: 'createRosterPort', class: 'A3', reason: '同上：对账期按 exec.agent 现取凭据' },
  { file: 'tools/register.js', symbol: 'createToolsPort', class: 'A3', reason: '属**注册动作现场**（registerTool）；预装配只是把 create 挪位置，不减少依赖' },
  { file: 'tools/tier-gate.js', symbol: 'createToolsPort', class: 'A3', reason: '同上：installGuard 属装配动作现场（且该方法是**追加**式，见文件头 A4 警示）' },
  { file: 'tools/write-provenance-guard.js', symbol: 'createToolsPort', class: 'A3', reason: '同上：installGuard 现场' },
  { file: 'tools/swarm-comms.js', symbol: 'createAgentPort', class: 'A3', reason: '需 per-call agent 会话（唤醒目标可每次不同）⇒ 不可预装配' },
];

// ── D-2：白名单结构可审计（4 字段 + class 值域 + reason 非空）────────────────────────────
test('D-2 白名单每条 4 字段、class ∈ {A1,A3}、reason 非空', () => {
  for (const e of WHITELIST) {
    assert.deepEqual(Object.keys(e).sort(), ['class', 'file', 'reason', 'symbol'],
      '条目字段须恰为 {file, symbol, class, reason}；实际=' + JSON.stringify(e));
    assert.ok(['A1', 'A3'].includes(e.class), 'class 只许 A1/A3；实际=' + e.class);
    assert.equal(typeof e.reason === 'string' && e.reason.length >= 8, true,
      'reason 须非空且可读（禁「不知道就加白名单」）；实际=' + JSON.stringify(e.reason));
    assert.equal(e.file.includes('\\'), false, 'file 须用 posix 分隔（可审计、跨平台一致）');
  }
  // 分类构成（spec §D-6：A1=3 / A3=7 的**符号级**构成；β 落地后 A1 应减到 0 ⇒ 本断言随之收紧）
  assert.deepEqual({
    A1: WHITELIST.filter((e) => e.class === 'A1').length,
    A3: WHITELIST.filter((e) => e.class === 'A3').length,
  }, { A1: 3, A3: 7 }, '分类构成须为 A1=3 / A3=7（β 后 A1 应归零）');
});

// ── D-1 / D-3：**双向相等**（本判据的主体）──────────────────────────────────────────────
test('D-1/D-3 实测集合 ≡ 白名单集合（双向相等）：既无新增依赖，也无过期白名单', () => {
  const found = scanTree(LIB);
  assert.ok(found.length > 0, '夹具前提：实测面非空（否则双向相等会因两侧皆空而假绿）');
  const { added, stale, ok } = diffAgainstWhitelist(found, WHITELIST);
  assert.deepEqual(added, [],
    '**新增依赖**：以下 (file:symbol) 在实测中 import 了 provider-dsh 但白名单没有 —— '
    + '本批方向是「引擎不依赖 provider」，新增须显式提交理由（白名单只许减不许增）：' + JSON.stringify(added));
  assert.deepEqual(stale, [],
    '**过期白名单**：以下条目已不在实测面里 —— 必须删除，不得靠留白名单掩盖已消除的依赖：' + JSON.stringify(stale));
  assert.equal(ok, true, '双向相等必须成立；added=' + JSON.stringify(added) + ' stale=' + JSON.stringify(stale));
});

// ── 可达构造 ①：白名单**外**的 import ⇒ 必红（真扫一棵临时 lib 树）────────────────────────────
test('D-4① 白名单外的 import ⇒ 判据必红（真实扫描：临时 lib 树）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-deps-dir-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tools', 'newcomer.js'),
      "import { createToolsPort } from '../provider-dsh/tools-http.js';\nexport const x = 1;\n", 'utf8');
    const found = scanTree(dir);
    assert.equal(found.length, 1, '夹具前提：临时树恰命中 1 条 import；实际=' + JSON.stringify(found));
    const { added, ok } = diffAgainstWhitelist(found, WHITELIST);
    assert.equal(ok, false, '白名单外 ⇒ **必须判红**');
    assert.deepEqual(added, ['tools/newcomer.js:createToolsPort'], '须点名 file:symbol；实际=' + JSON.stringify(added));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 可达构造 ②：**注释里**的 import 字样 ⇒ 不得误报（codeOnly 生效）──────────────────────────
test('D-4② 注释/字符串里的同形 import ⇒ 不得误报（只判 import 语句）', () => {
  const samples = [
    "// import { createToolsPort } from '../provider-dsh/tools-http.js';\nexport const a = 1;\n",
    "/* import { createAgentPort } from '../provider-dsh/agent.js'; */\nexport const b = 2;\n",
    "export const c = \"import { createRosterPort } from '../provider-dsh/roster.js'\";\n",
    "export const d = `x: import { createHttpPort } from '../provider-dsh/tools-http.js'`;\n",
  ];
  for (const [i, src] of samples.entries()) {
    const found = importsOf(src, 'tools/sample' + i + '.js');
    assert.deepEqual(found, [], '样本 ' + i + '：注释/字符串里的 import 字样**不得**被计入实测面；实际=' + JSON.stringify(found));
    assert.equal(diffAgainstWhitelist(found, []).ok, true, '样本 ' + i + '：空实测面对空白名单 ⇒ 无违规（证明「不误报」不是因为全局 stale 被掩盖）');
  }
  // 反向对照：**真** import 必须被计入（否则上面的「不误报」可以用「恒不识别」蒙过去）
  const real = importsOf("import { createToolsPort } from '../provider-dsh/tools-http.js';\n", 'tools/real.js');
  assert.deepEqual(real.map((r) => r.symbol), ['createToolsPort'], '真 import 必须被识别（反假绿）');
});

// ── 可达构造 ③：变异 —— 删掉「实测集合」比对改成恒 0 ⇒ ① 必红 ─────────────────────────────
test('D-5 变异：把比对逻辑改成恒 0 违规 ⇒ D-4① 的构造必须失去判别力（必红）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-deps-mut-'));
  try {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tools', 'newcomer.js'),
      "import { createToolsPort } from '../provider-dsh/tools-http.js';\n", 'utf8');
    const found = scanTree(dir);

    // 变异体：删掉比对，恒报「无违规」（= 判据被架空）
    const mutatedDiff = () => ({ added: [], stale: [], ok: true });
    assert.equal(mutatedDiff(found, WHITELIST).ok, true,
      '变异体在**同一输入**下报绿 ⇒ 说明 D-4① 的红完全依赖真实比对逻辑（不是环境噪声）');

    const real = diffAgainstWhitelist(found, WHITELIST);
    assert.equal(real.ok, false, '真实比对在同输入下报红 ⇒ 两结论**必须不同**（相同 ⇒ 判据无鉴别力）');
    assert.notDeepEqual({ ok: mutatedDiff(found, WHITELIST).ok }, { ok: real.ok },
      '变异体与真实判据结论必须不同（相同则说明比对逻辑可被删除而不被发现）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
