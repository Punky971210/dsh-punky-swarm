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

// F2 模型可见面 / 描述面 / 直做项验证（批次 `punky-fix-f2-20261022` · lane `e4-tester`）
//   判据源：`plan/fix-spec-f2.md` §1.6 / §4 / §5 + AC-8（工具面）/ AC-9 / AC-10
//   回指缺陷：F-1（`lane_dispatch` 旧归因）、A1-P2-04（注释/文档锚点漂移）、A1-P2-06（AC-8 工具面留痕）
//
// 纪律：
//   · **运行期证据优先**（不是 grep 源码）：`lane_dispatch` 的描述/参数/schema 取自
//     `buildDispatchTools(cx)` 实例化后的工具对象；源码面 grep 只用于注释/文档锚点（文字面无可运行对象）；
//   · `parameters` / `output.schema` 的「与改前一致」用**双路对拍**：① 与 `git show HEAD:` 版本逐字
//     （同一抽象面 = 源码里的 JSON 字面量）；② 与运行期归一化对象（`defineTool` 后的 schema）逐键比对；
//   · 每条「旧句式已消失」断言都配**同文件仍含新句式**的阳性断言（防「整段被删」也算绿）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildDispatchTools } from '../lib/tools/member-tools.js';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(PKG_DIR, rel), 'utf8');
const countHits = (text, re) => (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;

// ── 源码 JSON 字面量抽取（`parameters: {..}` / `schema: {..}`）：取 `name: "lane_dispatch"` 之后的首个块 ──
function jsonBlockAfter(text, anchor, marker) {
  const at = text.indexOf(anchor);
  assert.ok(at >= 0, '源码中须存在锚点: ' + anchor);
  const start = text.indexOf(marker, at);
  assert.ok(start >= 0, '锚点之后须存在 `' + marker + '`');
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { // 跳过字符串（这两个块内无转义引号的嵌套字符串，保守处理反斜杠）
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === '"') break;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(open, i + 1)); }
  }
  throw new Error('unterminated JSON block after ' + marker);
}

const CURRENT_SRC = read('lib/tools/member-tools.js');
const CUR_PARAMS = jsonBlockAfter(CURRENT_SRC, 'name: "lane_dispatch"', 'parameters: ');
const CUR_SCHEMA = jsonBlockAfter(CURRENT_SRC, 'name: "lane_dispatch"', 'schema: ');

// `defineTool` 的归一化：把属性上的 `required:true` 收到同层 `required:[]`（递归，含 `exempt.properties.type`）。
function normalizedSchema(node) {
  if (Array.isArray(node)) return node.map(normalizedSchema);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  const required = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === 'required' && Array.isArray(v)) { out.required = v.slice(); continue; }
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (pv && typeof pv === 'object' && pv.required === true) {
          required.push(pk);
          const { required: _flag, ...rest } = pv;
          void _flag;
          out.properties[pk] = normalizedSchema(rest);
        } else {
          out.properties[pk] = normalizedSchema(pv);
        }
      }
      continue;
    }
    out[k] = normalizedSchema(v);
  }
  if (required.length > 0) out.required = required;
  return out;
}

// ── D1 · AC-9：运行期取 `lane_dispatch` 描述，断言新归因在、旧句式亡 ─────────────────────
test('D1 lane_dispatch 运行期描述：含 startActivation / GATE_DISPATCH_CAPABILITY_MISSING / 拒派 / 仅当+不可取；不含旧降级句', () => {
  const tools = buildDispatchTools({ ctx: {}, deps: {}, store: {}, root: '' });
  const t = tools.find((x) => x.name === 'lane_dispatch');
  assert.ok(t, '必须能实例化到 lane_dispatch');
  const d = t.description;

  // 阳性面（新归因逐条在场）
  assert.ok(d.includes('startActivation'), '描述须提宿主 startActivation 形态');
  assert.ok(d.includes('GATE_DISPATCH_CAPABILITY_MISSING'), '描述须提拒派抛出的现有拒码');
  assert.ok(d.includes('拒派'), '描述须含「拒派」语义');
  assert.ok(/打在状态变更之前/.test(d), '描述须写明拒派早于状态变更（F1 实装口径）');
  assert.ok(/仅当[^。]*?(不可取|皆不可调用)/.test(d), '「仅当」句须含降级条件（不可取 / 两入口皆不可调用）');

  // 阴性面（旧句式零命中）——用正则覆盖两种引号/空格变体
  assert.equal(/若宿主未提供\s*`?ctx\.subagents`?\s*⇒/.test(d), false, '旧句式「若宿主未提供 ctx.subagents ⇒ 降级」不得残留');
  assert.equal(/降级为「仅发句柄」/.test(d), true, '新旧描述都保留「仅发句柄」措辞（证阴性断言不是整段被删）');

  // 同文件其他工具描述未顺手动（S-6）——抽 lane_claim 描述与源码另一处逐字比对
  assert.ok(CURRENT_SRC.includes('以 O_EXCL 单写者锁认领 lane（同一批次同一 lane 同时只允许一个写者）'),
    'lane_claim 描述（S-6 冻结面）须逐字保留');
});

// ── D2 · AC-9：parameters / output.schema 与改前一致（HEAD 对拍 + 运行期归一化对拍）────────
test('D2 lane_dispatch 参数与输出 schema 未变（HEAD 版本逐字对拍 + 运行期归一化形态一致）', (t) => {
  let headSrc = null;
  try {
    const toplevel = execFileSync('git', ['-C', PKG_DIR, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const rel = path.relative(toplevel, path.join(PKG_DIR, 'lib', 'tools', 'member-tools.js')).split(path.sep).join('/');
    headSrc = execFileSync('git', ['-C', toplevel, 'show', 'HEAD:' + rel], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    headSrc = null;
  }
  if (headSrc === null) {
    t.diagnostic('git HEAD 版本不可取 ⇒ 仅做运行期归一化对拍（HEAD 对拍项 verified=false）');
  } else {
    assert.deepEqual(CUR_PARAMS, jsonBlockAfter(headSrc, 'name: "lane_dispatch"', 'parameters: '),
      'parameters 与 HEAD 版本逐字一致（改前改后未动参数面）');
    assert.deepEqual(CUR_SCHEMA, jsonBlockAfter(headSrc, 'name: "lane_dispatch"', 'schema: '),
      'output.schema 与 HEAD 版本逐字一致');
  }

  // 运行期归一化对拍：`defineTool` 会把属性上的 `required:true` 收到顶层 required 数组
  const tools = buildDispatchTools({ ctx: {}, deps: {}, store: {}, root: '' });
  const t2 = tools.find((x) => x.name === 'lane_dispatch');
  const expectParams = { type: 'object', ...normalizedSchema({ properties: CUR_PARAMS }) };
  assert.deepEqual(t2.parameters, expectParams, '运行期 parameters 必须等于源码面参数（结构未变）');
  assert.deepEqual(t2.output.schema, normalizedSchema(CUR_SCHEMA), '运行期 output.schema 必须等于源码面 schema（结构未变）');

  // 外部判据（防「源码与自身对拍」的自洽恒真）：改前契约的**冻结面**（HEAD 版本人工核对）
  //   ⇒ 任何新增/删除/改名参数都会红，即使有人把源码面一起改坏也逃不掉。
  assert.deepEqual(Object.keys(t2.parameters.properties), ['batchId', 'lane', 'session', 'prompt', 'exempt'],
    '参数名集 = 改前冻结面（batchId/lane/session/prompt/exempt）');
  assert.deepEqual(t2.parameters.required, ['batchId', 'lane'], '必填参数集 = 改前冻结面');
  assert.deepEqual(Object.keys(t2.parameters.properties.exempt.properties), ['type', 'multiplier', 'stalled'],
    'exempt 子参数集 = 改前冻结面');
  assert.deepEqual(t2.parameters.properties.exempt.required, ['type'], 'exempt 必填子参数 = 改前冻结面');
  assert.equal(t2.parameters.properties.exempt.additionalProperties, false, 'exempt 仍是封闭对象');
  assert.deepEqual(Object.keys(t2.output.schema.properties),
    ['batchId', 'lane', 'status', 'token', 'firstLine', 'ttlMs', 'spawned', 'workerSessionId', 'spawnNote'],
    '输出属性名集 = 改前冻结面（9 键，未增未减）');
  assert.equal(t2.output.schema.additionalProperties, false, '返回形状仍是封闭对象');
});

// ── D3 · AC-8 工具面：lane_claim 透传 warn（force 接管恰 1 行；无 logger 不抛）─────────────
function laneHarness({ withLogger }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-f2-warn-'));
  const store = createStore(root);
  const warns = [];
  // 【2026-10-22 真机验证 #2 后修订】原夹具把 logger 挂在 `deps.ctx` 上——那是**错误接线**：
  //   装配面 `createTools(ctx, deps)` → `cx = { ctx, deps, … }`，`ctx` 在**顶层**，`deps` 里没有 `ctx`
  //   ⇒ 该形态单元必绿、真机零留痕（正是本轮失败项）。现按**真实 cx 形状**造，logger 挂 `ctx` 顶层。
  const logger = withLogger ? { warn: (m) => warns.push(String(m)), info: () => {} } : undefined;
  const ctx = { tools: { register: () => {} }, ...(logger ? { logger } : {}) };
  const { tools } = createTools(ctx, { store, root, config: {} });
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  return { root, store, warns, claim: byName.lane_claim };
}

const SESS = { agent: { session: { id: 'sess-f2-warn' } } };

test('D3 lane_claim 接线 warn：force 接管成功 ⇒ 宿主日志恰 1 行（含 fence 1→2）；无 logger ⇒ 不抛且仍成功', async () => {
  const h = laneHarness({ withLogger: true });
  const first = await h.claim.execute({ batchId: 'b-warn', lane: 'e1' }, SESS);
  assert.equal(first.ok, true, '阳性前置：首建锁成功');
  assert.equal(h.warns.length, 0, '首建（非接管）不得留痕');

  const forced = await h.claim.execute({ batchId: 'b-warn', lane: 'e1', force: true }, SESS);
  assert.equal(forced.ok, true, 'force 接管成功（工具面仍 ok:true，返回形状未变）');
  assert.equal(h.warns.length, 1, 'force 接管成功必须在宿主日志留**恰 1 行**（AC-8 工具面达标）');
  assert.match(h.warns[0], /lane lock 接管/, '留痕须含接管标记');
  assert.match(h.warns[0], /fence 1→2/, '留痕须含代数跃迁（可核）');

  // 无 logger ⇒ 静默降级，不抛、不阻断取锁（缺 logger 的部署面）
  const h2 = laneHarness({ withLogger: false });
  assert.equal((await h2.claim.execute({ batchId: 'b-warn2', lane: 'e1' }, SESS)).ok, true);
  const forced2 = await h2.claim.execute({ batchId: 'b-warn2', lane: 'e1', force: true }, SESS);
  assert.equal(forced2.ok, true, '无 logger 时 force 接管仍成功（warn 缺省 null ⇒ 零副作用）');
});

// ── D4 · AC-10 注释/文档锚点四处 + 第三处同类断言（tier-gate）────────────────────────────
test('D4 注释/文档锚点：dispatch.js/dispatch-register.js/docs 四处校正落盘且旧锚点 0 命中', (t) => {
  const dispatch = read('lib/engine/dispatch.js');
  const register = read('lib/bridge/dispatch-register.js');
  // 【2026-10-25 CI 修复】`docs/**` 按 `.gitignore` **不入库**（仅 `docs/integrations/` 下两件集成声明文档为例外）；
  //   干净检出 / CI runner 上本文件不在场，原 `read()` 直接抛错 ⇒ CI 必红（Linux CI 实测红）。
  //   处置：文档类断言在文档不在场时**留痕为环境不可核**（不计通过、也不判红），lib 侧断言照常执行。
  const DOC_REL = 'docs/engine-load-smoke-recipe.md';
  const docOnDisk = fs.existsSync(path.join(PKG_DIR, DOC_REL));
  if (!docOnDisk) {
    t.diagnostic(DOC_REL + ' 不在场（docs 按 .gitignore 不入库）⇒ 「文档锚点」两条断言本环境不可核；lib 侧断言仍执行。');
  }
  const docs = docOnDisk ? read(DOC_REL) : '';

  // C10：旧锚点 `lib/tools/core.js` + `:1369` 0 命中；真实调用点 ≥1（阳性对照：不是整段被删）
  assert.equal(countHits(dispatch, /core\.js:1369/), 0, 'dispatch.js 不得再出现陈旧锚点（core.js + :1369 形态）');
  assert.ok(countHits(dispatch, /member-tools\.js:110/) >= 1, 'dispatch.js 须指向真实调用点 member-tools.js:110');

  // C11：单边断言「官方 profile 已 disable 宿主 subagent/subagent_fork」0 命中（措辞级）
  assert.equal(countHits(dispatch, /已 disable 宿主/), 0, 'dispatch.js 不得再以单边断言写「已 disable 宿主」');
  assert.ok(dispatch.includes('双层真相') || dispatch.includes('只在顶层成立'), 'dispatch.js 须写双层真相口径（阳性对照）');

  // C12：引用必须是 preset 两层 + 显式注明顶层实写 disabled: true
  // 【2026-10-22 · AN-1 口径更新（Leader 直做）】原断言要求「回指宿主顶层区段行号 293-304」，但它与 AC-9(1)
  //   「lib/ 内该串 0 命中」**互斥**；且该文件由 loader 在 boot 期重写、行号不稳定 ⇒ 钉行号本身就是病。
  //   现改为：要求**显式声明行号不稳定、不引行号**（保住信息量），并**反向禁止**再出现该行号串。
  assert.ok(/行号不稳定|不引行号/.test(register), 'dispatch-register.js 须显式声明宿主锚点行号不稳定、不引行号');
  assert.equal(register.includes('293-304'), false, 'dispatch-register.js 不得再回指宿主顶层区段行号（AN-1）');
  assert.ok(/disabled:\s*true/.test(register), 'dispatch-register.js 须显式注明该区段实写 disabled: true');
  assert.ok(register.includes('770-780') && register.includes('220-232'), 'dispatch-register.js 须引 preset 两层（770-780 / 220-232）');
  assert.ok(/顶层成立、preset 层不成立/.test(register) || /不得据此假设派发工具缺席/.test(register),
    'dispatch-register.js 的强度须精确为「顶层成立、preset 层不成立」');

  // C13：文档旧锚点 L93 → 0；新锚点在场
  //   （文档不在场时这两条跳过并已在用例开头留痕：docs 按 .gitignore 不入库）
  if (docOnDisk) {
    assert.equal(countHits(docs, /\bL93\b/), 0, 'docs 不得再留 L93 旧锚点');
    assert.ok(docs.includes('lib/index.js:1040-1041'), 'docs 须改用 lib/index.js:1040-1041 锚点');
  }

  // 全仓（lib/docs/test/scripts 面）陈旧锚点（core.js + :1369 形态）0 命中
  const scan = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.tsbuild' || ent.name === '.git') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|ts|md|json)$/.test(ent.name)) scan.push(p);
    }
  };
  for (const sub of ['lib', 'docs', 'test', 'scripts']) {
    const d = path.join(PKG_DIR, sub);
    if (fs.existsSync(d)) walk(d);
  }
  for (const f of ['README.md', 'README.en.md', 'CHANGELOG.md']) {
    const p = path.join(PKG_DIR, f);
    if (fs.existsSync(p)) scan.push(p);
  }
  const offenders = scan.filter((p) => /core\.js:1369/.test(fs.readFileSync(p, 'utf8')));
  assert.deepEqual(offenders.map((p) => path.relative(PKG_DIR, p)), [], '全仓不得残留陈旧锚点（core.js + :1369 形态）');
});

test('D4b tier-gate.js 第三处同类断言：已改为双层真相（保留的历史引语必带限定词，非活跃断言）', () => {
  const tg = read('lib/tools/tier-gate.js');
  // 阳性面：双层真相在场
  assert.ok(tg.includes('770-780') && tg.includes('220-232'), 'tier-gate.js 须写 preset 两层引用');
  assert.ok(/不得\*\*据此假设|不得据此假设/.test(tg), 'tier-gate.js 须写明「不得据此假设派发工具缺席」');
  // 阴性面：该措辞若仍出现，必须处在**历史引语**语境（窗口内含「原「」/「单边断言」/「已删」限定）
  const PHRASE = '官方 agent-team profile 已 disable';
  const idxs = [];
  let from = 0;
  for (;;) {
    const at = tg.indexOf(PHRASE, from);
    if (at < 0) break;
    idxs.push(at);
    from = at + PHRASE.length;
  }
  for (const at of idxs) {
    const win = tg.slice(Math.max(0, at - 160), Math.min(tg.length, at + 160));
    assert.ok(/原「|已删|单边断言|已修订|2026-10-22/.test(win),
      '该措辞只允许作为历史引语出现（须带「原「/已删/单边断言」限定词）；实际窗口：' + win.replace(/\s+/g, ' '));
  }
});

// ── D5 · T-5#4：store.js 的「lock.js（65 行）」死行数表述已改为不写死 ──────────────────────
test('D5 store.js 注释：不再写死 lock.js 行数（65 行），改为规模可演进表述', () => {
  const s = read('lib/state/store.js');
  assert.equal(countHits(s, /lock\.js`?（65 行）/), 0, '不得再写死「lock.js（65 行）」（行数随接管/fencing 改造演进）');
  assert.ok(s.includes('勿写死为判据'), '改后须显式写明「勿写死为判据」（阳性对照：不是整段被删）');
  assert.ok(/F2 后 \d+ 行/.test(s), '改后须给出「F2 后 N 行」的当前读数');
});
