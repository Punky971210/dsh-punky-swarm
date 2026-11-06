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

// test/warn-silent-codes.test.js —— D-2=乙 落地锁：`WARN_SILENT_CODES` 里的告警码
// **只留 `warnings[]`、不落任何事件**（批 `punky-engine-fix2-20261106` · lane `e1-red`）。
//
// 本文件锁三件事（对应 `plan/fix2-spec.md` 的 `E1-R6` / `E1-R7` / `E1-R8`，及 `S2-2` 的机制）：
//   ① **事件面零发射**：`gate.roster_unknown` 零命中，**且**「载荷 `code` ∈ 静默集」的事件零命中
//      —— 后者是 `S2-2` 的判别点：只删 `WARN_EVENT_OF` 映射时，发射循环的兜底
//      `?? EVT.EVT_GATE_ROLE_INVALID` 会把它**误标成 `gate.role_invalid` 继续发射**（换个 type 而已）。
//   ② **告警面保留**：建批返回值 `warnings[]` 里该码仍在，且 `code` / `task` / `roster` / `basis` 四键俱在
//      —— 返回面是 Leader 能看到该告警的**唯一路径**，事件舍掉后它绝不能再被连带舍掉。
//   ③ **两集合相斥**：`WARN_EVENT_OF` 键集 ∩ `WARN_SILENT_CODES` 项集 = ∅（同一码不得既静默又映射）。
//
// 断言口径（纪律 15 / C-10）：**身份集合**判覆盖，不写 `length === 1` / `=== 1` 型裸计数；
//   失败消息点名「哪个码 / 哪个席位名 / 哪个 lane」，不报「期望 N 实得 M」。
//
// ⚠ **过渡期双名（本 lane 登记，非笔误）**：本批禁在 `e1-red` 跑 `npm run build`（`e3-contracts` 并行，
//   build 会回拷覆盖手改）⇒ 运行时 `wave_plan` 读的是**生成物** `lib/wave-plan.js`，其码字面量此刻仍是旧名
//   `GATE_ROSTER_UNKNOWN`，而源码单点 `lib/wave-plan.ts:1195` 已改名 `WARN_ROSTER_UNKNOWN`
//   （`e2-f8` 的 build 生效后运行时才切到新名）。故本文件用**双名候选集**判身份，
//   使结论在 build 前 / build 后**同真**，不靠「哪一天跑的」定绿红。
//
// 夹具：`smoke: true`（产物契约类门豁免）+ 最小 2-lane 批 —— 本文件被检面是**建批期告警与事件**，
//   与 produce/consume/plan 契约门无关；smoke 豁免**不涉**行为安全门（派发准入/单写者锁/终态冻结/
//   needHuman/命令门/验收判据门一字不减），故不影响本文件判别力。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILTIN_ROLES } from '../lib/roster.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { assessC } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 该告警码的**双名候选集**（源码单点=新名；生成物在 `e2-f8` build 前=旧名）。 */
const ROSTER_UNKNOWN_NAMES = ['WARN_ROSTER_UNKNOWN', 'GATE_ROSTER_UNKNOWN'];
/** 旧事件类型（本批裁决后**必须零命中**；保留字面量正是为了能断言「它不再出现」）。 */
const LEGACY_ROSTER_UNKNOWN_EVT = 'gate.roster_unknown';

const SESS_ID = 'sess-warn-silent-codes';
const SESS = { agent: { session: { id: SESS_ID } } };

const rosterUnknownWarningsOf = (out) => (out.warnings ?? []).filter((w) => ROSTER_UNKNOWN_NAMES.includes(w.code));

function makeHarness(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-warn-silent-' + tag + '-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // G1 前置：`wave_plan` 属 C 档动作 ⇒ 先落「已评估为 C」
  assessC(store, SESS_ID, { rationale: 'D-2 静默集锁：wave_plan 属 C 档动作（建批期告警与事件面）' });
  return { root, store, byName };
}

const eventsOf = (store, batchId) => store.readBatch(SESS_ID, batchId)?.events ?? [];
/** 事件类型 → 集合（便于失败消息点名，不报计数）。 */
const eventTypesOf = (store, batchId) => [...new Set(eventsOf(store, batchId).map((e) => e.type))].sort();

// ═══════════════════════════════════════════════════════════════════════════════
// WS-1 · 事件面零发射（E1-R6 + S2-2 机制：既无专用 type，也无兜底误标）
// ═══════════════════════════════════════════════════════════════════════════════
test('WS-1 未知席位告警 ⇒ 事件流零 `gate.roster_unknown`，且零「载荷 code ∈ 静默集」的事件（兜底误标形态一并排除）', async () => {
  const { store, byName } = makeHarness('events');
  const tasks = [
    { id: 'a', cmd: 'x', roster: 'ghost-seat' },
    { id: 'b', cmd: 'x', roster: 'coder' },
  ];
  // 前提（不是被检面）：ghost-seat 词法合法却查无此席
  assert.equal(BUILTIN_ROLES.includes('ghost-seat'), false, '前提：ghost-seat 不在 BUILTIN_ROLES 内（基准取自 lib/roster.js）');

  await byName.wave_plan.execute({ batchId: 'b-warn-silent', tasks, smoke: true }, SESS);

  // ① 非空性对照（防「零命中」是因为事件流根本没落）：建批本应有事件
  assert.equal(eventTypesOf(store, 'b-warn-silent').length > 0, true,
    '前提：建批本应落事件（否则下面的「零命中」是空集假绿）；实测类型集合=' + JSON.stringify(eventTypesOf(store, 'b-warn-silent')));

  // ② 专用事件类型零命中
  const legacyTyped = eventsOf(store, 'b-warn-silent').filter((e) => e && e.type === LEGACY_ROSTER_UNKNOWN_EVT);
  assert.deepEqual(legacyTyped, [], LEGACY_ROSTER_UNKNOWN_EVT + ' 不得再落事件（D-2=乙）；实测=' + JSON.stringify(legacyTyped));

  // ③ 兜底误标零命中：任何事件的载荷 `code` 都不得是静默集里的码
  //    （只删映射不补跳过时，这里会抓到 `gate.role_invalid` + `code=GATE_ROSTER_UNKNOWN`）
  const codedEvents = eventsOf(store, 'b-warn-silent').filter((e) => e && ROSTER_UNKNOWN_NAMES.includes(e.code));
  assert.deepEqual(codedEvents, [], '静默集的码不得以任何 type 落事件（含兜底 gate.role_invalid 误标形态）；实测='
    + JSON.stringify(codedEvents.map((e) => ({ type: e.type, code: e.code }))));
});

// ═══════════════════════════════════════════════════════════════════════════════
// WS-2 · 告警面保留（E1-R7）：事件舍掉，`warnings[]` 绝不能被连带舍掉
// ═══════════════════════════════════════════════════════════════════════════════
test('WS-2 同一批的 `warnings[]` 仍含该码，且 code / task / roster / basis 四键俱在（返回面 = 唯一可见路径）', async () => {
  const { byName } = makeHarness('warnings');
  const tasks = [
    { id: 'a', cmd: 'x', roster: 'ghost-seat' },
    { id: 'b', cmd: 'x', roster: 'coder' },
  ];
  const out = await byName.wave_plan.execute({ batchId: 'b-warn-keep', tasks, smoke: true }, SESS);

  const warns = rosterUnknownWarningsOf(out);
  assert.equal(warns.length > 0, true, '事件静默不得连带告警静默：`warnings[]` 须仍含该码；实测 codes='
    + JSON.stringify((out.warnings ?? []).map((w) => w.code)));

  // 四键俱在（载荷契约，不得因本批改动被削）
  for (const w of warns) {
    assert.deepEqual(['code', 'task', 'roster', 'basis'].filter((k) => !(k in w)), [],
      '告警载荷须含 code/task/roster/basis 四键；实测键集=' + JSON.stringify(Object.keys(w)));
  }
  // 身份集合：席位名与归属 lane 点名正确（不判裸计数）
  assert.deepEqual(warns.map((w) => w.roster), ['ghost-seat'], '告警须点名未知席位名；实测=' + JSON.stringify(warns.map((w) => w.roster)));
  assert.deepEqual(warns.map((w) => w.task), ['a'], '告警须归属 lane a（表内 coder 的 lane b 不得连带告警）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// WS-3 · 两集合相斥（E1-R8）：同一码不得既静默又映射到事件
// ═══════════════════════════════════════════════════════════════════════════════
test('WS-3 `WARN_EVENT_OF` 键集 ∩ `WARN_SILENT_CODES` 项集 = ∅（源码面解析，防「既静默又映射」的自相矛盾）', () => {
  const src = fs.readFileSync(path.join(PKG_ROOT, 'lib/tools/wave-plan-tools.js'), 'utf8');

  // 映射表键集：取 `const WARN_EVENT_OF = {` 到其后第一个 `};` 之间的 `^\s*CODE:` 形态
  const mapStart = src.indexOf('const WARN_EVENT_OF = {');
  assert.notEqual(mapStart, -1, '`WARN_EVENT_OF` 映射表须仍在 lib/tools/wave-plan-tools.js');
  const mapBlock = src.slice(mapStart, src.indexOf('\n};', mapStart));
  const mappedKeys = [...mapBlock.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\s*:/gm)].map((m) => m[1]);

  // 静默集项集：取 `const WARN_SILENT_CODES = new Set([` 到 `])` 之间的字符串字面量
  const silentStart = src.indexOf('const WARN_SILENT_CODES = new Set([');
  assert.notEqual(silentStart, -1, '`WARN_SILENT_CODES` 须仍在 lib/tools/wave-plan-tools.js（S2-2 的机制载体）');
  const silentBlock = src.slice(silentStart, src.indexOf('])', silentStart));
  const silentCodes = [...silentBlock.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);

  assert.equal(silentCodes.length > 0, true, '静默集不得为空（否则 WS-1 的「零发射」与它无关）');
  const overlap = mappedKeys.filter((k) => silentCodes.includes(k));
  assert.deepEqual(overlap, [], '同一码不得既在 WARN_EVENT_OF（发射）又在 WARN_SILENT_CODES（静默）；实测交集=' + JSON.stringify(overlap));

  // 旧专用映射行必须已删（只删映射、另由静默集兜住的完整形态）
  assert.deepEqual(mappedKeys.filter((k) => ROSTER_UNKNOWN_NAMES.includes(k)), [],
    '该码不得再出现在 WARN_EVENT_OF（映射行已删）；实测映射键集=' + JSON.stringify(mappedKeys));

  // 发射循环里的跳过必须在场（否则静默集是死数据）
  assert.equal(/WARN_SILENT_CODES\.has\(w\.code\)\s*\)\s*continue/.test(src), true,
    '发射循环须有 `if (WARN_SILENT_CODES.has(w.code)) continue;`（只登记不跳过 = 死数据）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// WS-4 · 码名不入 `GATE_` 家族（E1-R5 的源码面锁：不登记词表 + 过 AC-pack2-2）
// ═══════════════════════════════════════════════════════════════════════════════
test('WS-4 源码面：`lib/wave-plan.ts` 内 `code: \'GATE_ROSTER_UNKNOWN\'` 零命中；词表与 GateErrorCode union 均不含该码', () => {
  const planSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/wave-plan.ts'), 'utf8');
  // `check-vocab-counts.mjs` 的发射码扫描面只认 `code: 'GATE_…'` ⇒ 该形态零命中是 AC-pack2-2 绿的机制
  const gateFormLeaks = [...planSrc.matchAll(/code\s*:\s*'(GATE_ROSTER_UNKNOWN)'/g)].map((m) => m[1]);
  assert.deepEqual(gateFormLeaks, [], '告警码不得以 `code: \'GATE_…\'` 形态出现在 lib/wave-plan.ts'
    + '（check-vocab-counts 的发射码扫描面只认该形态 ⇒ 会报缺口 AC-pack2-2 红）；实测=' + JSON.stringify(gateFormLeaks));
  assert.equal(planSrc.includes('WARN_ROSTER_UNKNOWN'), true, '源码单点须改用 `WARN_ROSTER_UNKNOWN`（D-2=乙 落地形态）');

  // 词表零登记（用户已裁：不登记词表）
  const vocabSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/state/vocabulary.json'), 'utf8');
  const vocabLeaks = ROSTER_UNKNOWN_NAMES.filter((n) => vocabSrc.includes(n));
  assert.deepEqual(vocabLeaks, [], '该告警码不得登记进 lib/state/vocabulary.json；实测=' + JSON.stringify(vocabLeaks));

  // 不进 GateErrorCode union（与 RU-5 同址锁，但用源码面判据而非依赖那一用例在场）
  const contractsSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/types/contracts.ts'), 'utf8');
  const unionStart = contractsSrc.indexOf('export type GateErrorCode');
  assert.notEqual(unionStart, -1, 'GateErrorCode union 须仍在 lib/types/contracts.ts');
  const unionBlock = contractsSrc.slice(unionStart, contractsSrc.indexOf(';', unionStart));
  const unionLeaks = ROSTER_UNKNOWN_NAMES.filter((n) => unionBlock.includes(n));
  assert.deepEqual(unionLeaks, [], '该告警码不是拒码，不得进 GateErrorCode union；实测=' + JSON.stringify(unionLeaks));
});
