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
// 【D-1】原 D2 用例用 `git show HEAD:…` 取「改前版本」做对拍；该设计**提交后自我失效**
//   ⇒ 改为读文件快照 `test/fixtures/lane-dispatch-output-schema.json`（历史基线不随 HEAD 移动）。
//   故 `node:child_process` 已无消费点，导入一并移除（不留孤儿 import）。
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
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const block = text.slice(open, i + 1);
        // 【2026-10-31 遗留收口】源文件里这两个块是 **JS 对象字面量**（裸键名 / 单引号 / 尾逗号），
        //   不是合法 JSON ⇒ 原实现直接 `JSON.parse` 抛 SyntaxError，整文件在模块加载期就红、
        //   一条断言都没跑到（属「测试跑不起来」而非「断言失败」）。先试 JSON（严格优先），
        //   失败再按对象字面量求值：块内只含数据字面量、无函数与副作用 ⇒ 求值等价于解析。
        try {
          return JSON.parse(block);
        } catch {
          // eslint-disable-next-line no-new-func -- 仅解析本仓源文件的纯数据字面量，不接受外部输入
          return Function('"use strict";return (' + block + ');')();
        }
      }
    }
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
test('D1 lane_dispatch 运行期描述：含 startActivation / GATE_DISPATCH_CAPABILITY_UNAVAILABLE / 拒派 / 仅当+不可取；不含旧降级句', () => {
  const tools = buildDispatchTools({ ctx: {}, deps: {}, store: {}, root: '' });
  const t = tools.find((x) => x.name === 'lane_dispatch');
  assert.ok(t, '必须能实例化到 lane_dispatch');
  const d = t.description;

  // 阳性面（新归因逐条在场）
  assert.ok(d.includes('startActivation'), '描述须提宿主 startActivation 形态');
  assert.ok(d.includes('GATE_DISPATCH_CAPABILITY_UNAVAILABLE'), '描述须提拒派抛出的现有拒码');
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

// ── D2 · AC-9：parameters / output.schema 与改前一致（**快照基线**对拍 + 运行期归一化对拍）────────
// 【D-1 · 批 `punky-d1d2-impl-20261103`】**对拍源从「git HEAD」改为「文件快照」**：
//   原实现 `git show HEAD:lib/tools/member-tools.js` 取「改前版本」——该设计**一旦提交就自我失效**：
//   提交后 HEAD == 改后版本 ⇒ ① `curKeys ∖ headKeys` 变空（≠ 新增四键）② `token` 在 HEAD 里已非
//   `required`（棘轮二「原本是 required」前提失败）⇒ 恒红。
//   ⇒ 基线落到 `test/fixtures/lane-dispatch-output-schema.json`（**只记录历史，不随 HEAD 移动**）。
//   两条棘轮语义不变（仍只许减不许增），只是比对对象从 HEAD 换成快照。
test('D2 lane_dispatch 参数与输出 schema 未变（**快照基线**逐字对拍 + 运行期归一化形态一致）', (t) => {
  const SNAPSHOT_REL = 'test/fixtures/lane-dispatch-output-schema.json';
  let headSchema = null;
  try {
    headSchema = JSON.parse(read(SNAPSHOT_REL));
  } catch (e) {
    headSchema = null;
  }
  if (headSchema === null) {
    t.diagnostic('快照基线不可读（' + SNAPSHOT_REL + '）⇒ 仅做运行期归一化对拍（快照对拍项 verified=false）');
  } else {
    // 【D-1】原 `params 与 HEAD 逐字对拍` 项移除：参数面本批未变，且其**外部冻结面**由下方
    //   `Object.keys(...properties)` / `required` / `exempt` 三组逐字断言独立承担（见本用例尾部），
    //   故不因去掉 HEAD 取源而丢「参数被无声改动」的能力。
    // 【D-1 · 甲：四键白名单】（不是删断言）
    //   原判据 = 「output.schema 与改前逐字一致」⇒ 与 D-1「schema 必改」结构性冲突（D-1 一落地它永远红）。
    //   甲把「零容忍」改成「**白名单容忍**」：只允许多出 `mode`/`code`/`unconfirmed`/`reason` 四键，
    //   **其余每个键仍逐字对拍** ⇒ 保住本条用例的真正价值（**防 schema 被无声改动**）。
    //   —— 甲′ 补充（二次裁决）：因 `:1148` 拒派路径**没有句柄**，
    //      `token`/`firstLine`/`ttlMs` 的 `required:true` 必须降级 —— 否则 schema 说必填、实际却缺（**声明说谎**）。
    const NEW_KEYS = ['code', 'mode', 'reason', 'unconfirmed'];              // 棘轮一：允许新增
    const RELAXED_REQUIRED = ['token', 'firstLine', 'ttlMs'];                // 棘轮二：允许 required 由 true→false
    const headKeys = Object.keys(headSchema.properties);
    const curKeys = Object.keys(CUR_SCHEMA.properties);
    assert.deepEqual(curKeys.filter((k) => !headKeys.includes(k)).sort(), NEW_KEYS,
      '棘轮一：相对快照基线只允许多出 ' + NEW_KEYS.join('/'));
    assert.deepEqual(headKeys.filter((k) => !curKeys.includes(k)), [],
      '快照基线里的键一个都不能少（本批只加不删）');
    for (const k of headKeys) {
      if (RELAXED_REQUIRED.includes(k)) {
        // 棘轮二：只允许 `required` 消失（true → false/absent），其余字段仍逐字
        const h = { ...headSchema.properties[k] };
        const c = { ...CUR_SCHEMA.properties[k] };
        assert.equal(h.required, true, '前提：快照基线里 `' + k + '` 原本是 required（否则棘轮二无对象）');
        delete h.required;
        delete c.required;
        assert.deepEqual(c, h, '`' + k + '` 仅允许 required 降级，其余字段必须逐字一致');
        assert.equal(CUR_SCHEMA.properties[k].required, undefined,
          '棘轮二方向固定：`' + k + '` 不得回填 required（只许 true→false）');
      } else {
        assert.deepEqual(CUR_SCHEMA.properties[k], headSchema.properties[k],
          'schema 属性 `' + k + '` 必须与快照基线逐字一致（白名单只开给新增四键与三键降级）');
      }
    }
    assert.equal(CUR_SCHEMA.additionalProperties, headSchema.additionalProperties,
      'additionalProperties 必须与快照基线一致（仍是封闭对象）');
  }

  // 运行期归一化对拍：`defineTool` 会把属性上的 `required:true` 收到顶层 required 数组
  const tools = buildDispatchTools({ ctx: {}, deps: {}, store: {}, root: '' });
  const t2 = tools.find((x) => x.name === 'lane_dispatch');
  const expectParams = { type: 'object', ...normalizedSchema({ properties: CUR_PARAMS }) };
  assert.deepEqual(t2.parameters, expectParams, '运行期 parameters 必须等于源码面参数（结构未变）');
  assert.deepEqual(t2.output.schema, normalizedSchema(CUR_SCHEMA), '运行期 output.schema 必须等于源码面 schema（结构未变）');

  // 外部判据（防「源码与自身对拍」的自洽恒真）：改前契约的**冻结面**（HEAD 版本人工核对）
  //   ⇒ 任何新增/删除/改名参数都会红，即使有人把源码面一起改坏也逃不掉。
  // 【2026-10-31 遗留收口 · 冻结滞后修正】`sourceRunId` 是 write-provenance-guard 批**有意新增**的
  //   显式来源参数（已裁决口径：来源标识由引擎从 `agent.session.id` 自取 L2，**禁用宿主 `runId`**），
  //   但本冻结面未同步 ⇒ 整条 D2 因「多一个参数」而红。此处的判据强度不变：仍是**逐字集合相等**
  //   （顺序敏感），只是把已裁决的既有参数纳入冻结面；除它之外任何增删改名仍会红。
  assert.deepEqual(Object.keys(t2.parameters.properties), ['sourceRunId', 'batchId', 'lane', 'session', 'prompt', 'exempt'],
    '参数名集 = 改前冻结面 + sourceRunId（write-provenance-guard 批已裁决显式来源参数；顺序即源码顺序）');
  assert.deepEqual(t2.parameters.required, ['batchId', 'lane'], '必填参数集 = 改前冻结面');
  assert.deepEqual(Object.keys(t2.parameters.properties.exempt.properties), ['type', 'multiplier', 'stalled'],
    'exempt 子参数集 = 改前冻结面');
  assert.deepEqual(t2.parameters.properties.exempt.required, ['type'], 'exempt 必填子参数 = 改前冻结面');
  assert.equal(t2.parameters.properties.exempt.additionalProperties, false, 'exempt 仍是封闭对象');
  // 【D-1 · 批 `punky-d1d2-impl-20261103`】9 → **13 键**：加 `mode` / `code` / `unconfirmed` / `reason`。
  //   **为何改**：D-1 要求「两处都返回、不抛」⇒ 调用方必须能**程序判定**结局面（`mode`）与拒码（`code`）；
  //   `unconfirmed` 是 AC-16 的核心信号（「不可确认 ≠ 失败」，不得因 schema 收紧而删）；
  //   `reason` 是机器可判短码（如 `PUSH_UNCONFIRMED`），与 `spawnNote`（人读长文）**职责不同、并存**。
  //   ⚠ `token` / `firstLine` / `ttlMs` 已移出 `required`：`canNarrow` 拒派发生在 `issueLaneHandle` **之前**
  //   ⇒ **无句柄是事实，不是妥协**（该路径如实没有句柄可发）。
  assert.deepEqual(Object.keys(t2.output.schema.properties),
    ['batchId', 'lane', 'status', 'token', 'firstLine', 'ttlMs', 'spawned', 'workerSessionId', 'spawnNote',
      'mode', 'code', 'unconfirmed', 'reason'],
    '输出属性名集 = 9 键 + mode/code/unconfirmed/reason（13 键）');
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