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

// test/roster-unknown.test.js —— 已裁 B-2（F-8）**返工后**的行为锁：
// 未知席位告警 = `WARN_ROSTER_UNKNOWN`，基准 = `BUILTIN_ROLES` **∪ 宿主 roster 成员名**
// （批 `punky-engine-fix2-20261106` · lane `e2-f8`；判据源 `plan/fix2-spec.md` §3 S3-5）
//
// 【本批两处断言相对上一批**反转**（`S3-5` 表格：RU-1 / RU-5），不是放宽】
//   · RU-1：旧断言「须落 `gate.roster_unknown` 事件」⇒ **反转**为「事件流**零**该事件、
//     `warnings[]` 携该码」（D-2=乙：不落事件、只留 warnings）。
//   · RU-5：旧断言「建批面零 `hostRoster`」⇒ **反转**为「`hostRoster` 出现在建批面、
//     但 `lib/wave-plan.ts` **代码面零 `ctx`**」（`buildWavePlan` 至今零 ctx 纯函数）。
//
// 两个面必须分清（混为一谈就是本文件的全部意义）：
//   · `GATE_ROSTER_INVALID` = roster **词法**非法（含空格/大写）⇒ 建批期 **throw**（`lib/wave-plan.ts:1152-1157`）
//     —— 本文件 RU-3 是它的**不得放宽**锁。
//   · `WARN_ROSTER_UNKNOWN` = 词法合法但**两侧都不含**（不在 `BUILTIN_ROLES`、也不在宿主 roster）
//     ⇒ **只落 `warnings[]`、零事件、建批成功**（RU-1 / RU-6 / RU-7）。
//
// 基准口径（用户裁决 2026-11-06，覆盖 Q-3=乙）：比对基准 = `lib/roster.js:44 BUILTIN_ROLES`
//   **∪ 宿主 roster 成员名**（`hostRoster`，**纯数据**传入）。为什么必须并集：`lanes[].roster` 的语义是
//   **roster 成员名**（正例 `coder-1`）而 `BUILTIN_ROLES` 是**职位名** ⇒ 只查内建表会让全量 1484 条
//   roster 声明里 1419 条（95.6%）告警（噪声）。
//
// 断言口径（纪律 15 / C-10）：**身份集合**判覆盖，不判裸计数（不写 `length === 1`）；
//   失败消息点名「哪个码 / 哪个席位名 / 哪个 lane」，不报「期望 N 实得 M」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWavePlan } from '../lib/wave-plan.js';
import { BUILTIN_ROLES } from '../lib/roster.js';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { assessC } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 告警码（**告警名不是拒码**：不进 `GateErrorCode` union —— RU-5 反锁）。 */
const ROSTER_UNKNOWN = 'WARN_ROSTER_UNKNOWN';
/** 事件类型：D-2=乙 裁决后本码**不落任何事件** ⇒ RU-1 直接核对事件流「零」。 */
const ROSTER_UNKNOWN_EVT = 'gate.roster_unknown';
/** 兜底类型（`WARN_EVENT_OF[w.code] ?? EVT_GATE_ROLE_INVALID`）：漏跳过时本码会以它误标落地。 */
const FALLBACK_EVT = 'gate.role_invalid';

const SESS_ID = 'sess-roster-unknown';
const SESS = { agent: { session: { id: SESS_ID } } };

/** roster 面告警（新旧两码名都算：旧名残留 = 未按 D-2=乙 改名的回归信号） */
const rosterWarningsOf = (plan) => (plan.warnings ?? []).filter((w) => /ROSTER/.test(String(w.code)));
const unknownSeatsOf = (plan) => rosterWarningsOf(plan).map((w) => w.roster);

/**
 * 夹具：`smoke: true`（产物契约类门豁免）+ 最小 2-lane 批 —— 本文件被检面是**建批期告警与事件**，
 * 与 produce/consume/plan 契约门无关；smoke 豁免**不涉**行为安全门（派发准入/单写者锁/终态冻结/
 * needHuman/命令门/验收判据门一字不减），故不影响本文件判别力。
 *
 * @param {string} tag                     临时根标签
 * @param {{rosterService?: object}} [opts] `rosterService` ⇒ 注入 `ctx.agentTeams`（RU-7 的读失败构造）
 */
function makeHarness(tag, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-roster-unknown-' + tag + '-'));
  const store = createStore(root);
  const warns = [];
  const logger = {
    info: () => {}, debug: () => {}, error: () => {},
    warn: (...parts) => { warns.push(parts.map((p) => String(p)).join(' ')); },
  };
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger };
  if (opts.rosterService !== undefined) ctx.agentTeams = opts.rosterService;
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // G1 前置：`wave_plan` 属 C 档动作 ⇒ 先落「已评估为 C」
  assessC(store, SESS_ID, { rationale: 'F-8 返工回归锁：wave_plan 属 C 档动作（建批期告警面）' });
  return { root, store, byName, warns };
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESS_ID, 'batches', batchId + '.json');
const eventsOf = (store, batchId) => store.readBatch(SESS_ID, batchId)?.events ?? [];

// ═══════════════════════════════════════════════════════════════════════════════
// RU-1（**反转**）· 两侧都不含的席位名 ⇒ `warnings` 携 WARN_ROSTER_UNKNOWN；事件流**零**；建批成功
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-1 两侧都不含的席位名 ⇒ warnings 携 WARN_ROSTER_UNKNOWN + 事件流零（反转：原要求落 gate.roster_unknown）+ 批次 JSON 照常落盘', async () => {
  // 宿主 roster 提供两个成员名：`ghost-seat` 两侧都不含（真未知席位），`coder-1` 仅宿主有（并集生效）
  const { root, store, byName } = makeHarness('unknown', {
    rosterService: { listMembers: () => [{ name: 'coder-1' }, { name: 'coder-2' }] },
  });
  const tasks = [
    { id: 'a', cmd: 'x', roster: 'ghost-seat' },
    { id: 'b', cmd: 'x', roster: 'coder' },     // 内建职位名 ⇒ 零告警
    { id: 'c', cmd: 'x', roster: 'coder-1' },   // 宿主成员名 ⇒ 零告警（并集基准的判别点）
  ];
  // 前提（不是断言被检面）：ghost-seat 两侧都不含；coder 在内建表；coder-1 仅在宿主侧
  assert.equal(BUILTIN_ROLES.includes('coder'), true, '前提：coder 须在 BUILTIN_ROLES 内（基准取自 lib/roster.js:44）');
  assert.equal(BUILTIN_ROLES.includes('ghost-seat'), false, '前提：ghost-seat 不在 BUILTIN_ROLES 内');
  assert.equal(BUILTIN_ROLES.includes('coder-1'), false, '前提：coder-1 是**成员名**、不在内建职位表内（须靠宿主 roster 覆盖）');

  const out = await byName.wave_plan.execute({ batchId: 'b-unknown', tasks, smoke: true }, SESS);

  // ① 返回面：身份集合恰 = [ghost-seat]，归属 lane a（coder / coder-1 两条不得告警）
  assert.deepEqual(unknownSeatsOf(out), ['ghost-seat'],
    '未知席位身份集合须恰为 [ghost-seat]（内建表内的 coder、宿主 roster 内的 coder-1 均不得告警）；实测='
    + JSON.stringify(rosterWarningsOf(out)));
  assert.deepEqual(rosterWarningsOf(out).map((w) => w.task), ['a'], '告警须归属 lane a（不得连带 lane b / c）');

  // ② 载荷：基准可核（`E2-F5`）
  const w0 = rosterWarningsOf(out).find((w) => w.roster === 'ghost-seat');
  assert.equal(w0.code, ROSTER_UNKNOWN, '告警码须为 ' + ROSTER_UNKNOWN + '（D-2=乙 改名；旧名 GATE_ 前缀 = 未改名回归）');
  assert.equal(w0.basis, 'BUILTIN_ROLES+hostRoster', '载荷 basis 须为并集声明（不再是只 BUILTIN_ROLES）');
  assert.equal(w0.hostRosterCount, 2, '载荷 hostRosterCount 须能分辨「宿主名单为空」与「宿主名单有内容」');

  // ③ 建批必须成功（告警不得变成拒建批）
  assert.equal(fs.existsSync(batchFileOf(root, 'b-unknown')), true, '未知席位名**不得**阻断建批：批次 JSON 须在场');
  assert.deepEqual(Object.keys(out.lanes).sort(), ['a', 'b', 'c'], '三条 lane 均正常入册；实测='
    + JSON.stringify(Object.keys(out.lanes)));

  // ④ 事件面（**本用例的反转点**）：专用事件零命中，且不得被兜底误标成 gate.role_invalid
  const evs = eventsOf(store, 'b-unknown');
  assert.deepEqual(evs.filter((e) => e && e.type === ROSTER_UNKNOWN_EVT), [],
    'D-2=乙 裁决：该告警**不落任何事件** ⇒ ' + ROSTER_UNKNOWN_EVT + ' 必须零命中');
  assert.deepEqual(evs.filter((e) => e && e.type === FALLBACK_EVT && /ROSTER/.test(String(e.code))), [],
    '漏跳过时会以 ' + FALLBACK_EVT + ' 误标落地（载荷 code 仍是本告警码）⇒ 必须零命中；实测='
    + JSON.stringify(evs.filter((e) => e && String(e.code).includes('ROSTER'))));
  // 非空性对照（防「事件流本身为空 ⇒ 上面两条恒真空过」的假绿）
  assert.equal(evs.length > 0, true, '对照：事件流须非空（否则「零命中」不具判别力）；实测类型集合='
    + JSON.stringify([...new Set(evs.map((e) => e.type))]));
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-2 · 内建职位表内的席位名 ⇒ 零告警、零事件（阳性对照）
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-2 BUILTIN_ROLES 内的席位名 ⇒ 零 roster 告警且零 ' + ROSTER_UNKNOWN_EVT + ' 事件', async () => {
  const { store, byName } = makeHarness('known');
  const tasks = [
    { id: 'a', cmd: 'x', roster: 'coder' },
    { id: 'b', cmd: 'x', roster: 'supervisor' },
    { id: 'c', cmd: 'x', roster: '  doc-manager  ' }, // trim 后合法且在内建表内
  ];
  const out = await byName.wave_plan.execute({ batchId: 'b-known', tasks, smoke: true }, SESS);
  assert.deepEqual(unknownSeatsOf(out), [],
    '表内席位名不得告警；实测=' + JSON.stringify(rosterWarningsOf(out)));
  assert.deepEqual(eventsOf(store, 'b-known').filter((e) => e && e.type === ROSTER_UNKNOWN_EVT), [],
    '表内席位名不得落 ' + ROSTER_UNKNOWN_EVT + ' 事件');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-3 · 词法非法 ⇒ 仍被 GATE_ROSTER_INVALID **拒**（本改动不得放宽 fail-closed 面）
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-3 反例：词法非法（含空格 / 大写）⇒ 仍抛 GATE_ROSTER_INVALID，且零批次落盘', async () => {
  const { root, byName } = makeHarness('invalid');
  assert.throws(() => buildWavePlan({ batchId: 'b-invalid-1', tasks: [{ id: 'a', cmd: 'x', roster: 'Coder One' }] }),
    /GATE_ROSTER_INVALID/, '含空格/大写 ⇒ 词法拒（不得退化为 WARN_ROSTER_UNKNOWN 告警）');
  assert.throws(() => buildWavePlan({ batchId: 'b-invalid-2', tasks: [{ id: 'a', cmd: 'x', roster: 'Coder' }] }),
    /GATE_ROSTER_INVALID/, '大写 ⇒ 词法拒（GATE_ROSTER_INVALID 是 fail-closed 面，不得放宽）');
  // 宿主 roster 里有同名也不得改变词法面（词法先于基准判定）
  assert.throws(() => buildWavePlan({ batchId: 'b-invalid-2b', tasks: [{ id: 'a', cmd: 'x', roster: 'Coder' }], hostRoster: ['Coder'] }),
    /GATE_ROSTER_INVALID/, '宿主 roster 含该名也不得放宽词法面（两条判据互不替代）');

  // 工具面同址：拒在建批之前 ⇒ 批次 JSON 零落盘
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'b-invalid-3', tasks: [{ id: 'a', cmd: 'x', roster: 'coder one' }], smoke: true }, SESS),
    /GATE_ROSTER_INVALID/,
    '工具面同样以 GATE_ROSTER_INVALID 拒（词法面先于未知席位面）',
  );
  assert.equal(fs.existsSync(batchFileOf(root, 'b-invalid-3')), false, '词法拒时批次 JSON 必须零落盘');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-4 · dispatch 批（roster 恒 null）⇒ 零告警、零事件
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-4 dispatch 批（零条 lane 写 roster）⇒ 零 roster 告警且零 ' + ROSTER_UNKNOWN_EVT + ' 事件', async () => {
  const { store, byName } = makeHarness('dispatch');
  const tasks = [
    { id: 'a', cmd: 'x' },
    { id: 'b', cmd: 'x', roster: null },
    { id: 'c', cmd: 'x', roster: '   ' },
    { id: 'd', cmd: 'x', roster: 7 },
  ];
  const out = await byName.wave_plan.execute({ batchId: 'b-dispatch', tasks, smoke: true }, SESS);
  assert.deepEqual(unknownSeatsOf(out), [],
    'dispatch 批（roster 归一为 null）不得告警；实测=' + JSON.stringify(rosterWarningsOf(out)));
  assert.deepEqual(eventsOf(store, 'b-dispatch').filter((e) => e && e.type === ROSTER_UNKNOWN_EVT), [],
    'dispatch 批不得落 ' + ROSTER_UNKNOWN_EVT + ' 事件');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-5（**反转**）· `hostRoster` 出现在建批面 + `lib/wave-plan.ts` **代码面零 ctx** + basis 并集声明
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-5 WARN_ROSTER_UNKNOWN 不进 GateErrorCode union；hostRoster 出现在建批面，且 lib/wave-plan.ts 代码面零 ctx', () => {
  const contractsSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/types/contracts.ts'), 'utf8');
  const unionStart = contractsSrc.indexOf('export type GateErrorCode');
  assert.notEqual(unionStart, -1, 'GateErrorCode union 须仍在 lib/types/contracts.ts');
  const unionBlock = contractsSrc.slice(unionStart, contractsSrc.indexOf(';', unionStart));
  assert.equal(unionBlock.includes(ROSTER_UNKNOWN), false,
    ROSTER_UNKNOWN + ' 是**告警名**不是拒码 —— 一旦进 GateErrorCode union，test/gate-lane-snapshot.test.js 的精确集合断言必红，'
    + '且语义从「只告警」漂移成「可拒」');

  const planSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/wave-plan.ts'), 'utf8');
  const toolSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib/tools/wave-plan-tools.js'), 'utf8');

  // ① 反转点之一：`hostRoster` **必须**出现在建批面（旧断言要求「零出现」已被推翻）
  assert.equal(planSrc.includes('hostRoster'), true,
    '建批函数须接收 hostRoster 纯数据形参（基准 = BUILTIN_ROLES ∪ 宿主 roster 的入口）');
  assert.equal(toolSrc.includes('hostRoster'), true,
    'lib/tools/wave-plan-tools.js 的 planArgs 须把 hostRoster 透传给 buildWavePlan（唯一接线点）');
  // ② 接线用的是 provider 名册单点，不是自建宿主读取
  assert.equal(toolSrc.includes('createRosterPort'), true,
    '宿主 roster 读取须走 provider 名册单点 createRosterPort（lib/provider-dsh/roster.js）');
  // ③ 基准文案可核（`E2-F5`）
  assert.equal(planSrc.includes("'BUILTIN_ROLES+hostRoster'"), true,
    "载荷 basis 须为 'BUILTIN_ROLES+hostRoster'（不再是只 BUILTIN_ROLES）");
  assert.equal(planSrc.includes('BUILTIN_ROLES'), true,
    'lib/wave-plan.ts 须直接引用 BUILTIN_ROLES（并集的左半，单一来源 = lib/roster.js:44）');
  // ④ 不得借用 reconcileRoster 当判据（它是对账语义，`S3-2` 明令）。
  //    口径：判**代码行**（注释里可以出现该名字作为「为什么不借用」的说明 —— 上一版裸 `includes`
  //    会把我方注释算成违规，是自造假红）。
  // ⑤ **代码面零 `ctx`**（`E2-F10`：buildWavePlan 至今零 ctx 纯函数）。
  //    口径说明：本文件既有注释里本来就有「零 ctx 纯函数」这类**说明性文字** ⇒ 判据取「非注释行零命中」，
  //    不是裸 grep 计数（裸计数会把既有注释算成违规）。`exec` 不作判据：它是 `layer` 字面量
  //    （`LAYERS = ['plan','exec','audit']`），裸 `exec` 命中无判别力。
  const nonCommentLines = planSrc.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .map((line) => line.replace(/\/\/.*$/, '')); // 去掉行尾注释后再判
  assert.deepEqual(nonCommentLines.filter((line) => line.includes('reconcileRoster')), [],
    '并集须用 Set 单点构造；**代码行**借用 reconcileRoster（对账三集合）等于让读端二次解释 ⇒ 判红');
  assert.deepEqual(nonCommentLines.filter((line) => /\bctx\b/.test(line)), [],
    'lib/wave-plan.ts 的**代码行**不得出现 ctx（零 ctx 纯函数；出现即证明有人把 ctx 传进了建批函数）');
  assert.deepEqual(planSrc.match(/\bagent\b/g) ?? [], [],
    'lib/wave-plan.ts 不得出现 agent（宿主凭据属调用方，不得下渗到纯函数）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-6（**新增**）· 正例：宿主 roster 提供成员名 ⇒ 这些成员名零告警
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-6 正例：hostRoster 含成员名 ⇒ 这些成员名零 roster 告警（并集生效）', () => {
  const plan = buildWavePlan({
    batchId: 'ru6',
    tasks: [
      { id: 'a', cmd: 'x', roster: 'coder-1' },
      { id: 'b', cmd: 'x', roster: 'coder-2' },
      { id: 'c', cmd: 'x', roster: 'coder' }, // 内建职位名（并集左半）
    ],
    hostRoster: ['coder-1', 'coder-2'],
  });
  assert.deepEqual(unknownSeatsOf(plan), [],
    '宿主 roster 内的成员名 + 内建职位名均不得告警；实测=' + JSON.stringify(rosterWarningsOf(plan)));
  // 反例对照（同一次调用结构、仅换席位名）：两侧都无 ⇒ 必须**有**告警且点名席位名 + lane
  const ghost = buildWavePlan({
    batchId: 'ru6b',
    tasks: [
      { id: 'a', cmd: 'x', roster: 'coder-1' },
      { id: 'g', cmd: 'x', roster: 'ghost-seat' },
    ],
    hostRoster: ['coder-1', 'coder-2'],
  });
  assert.deepEqual(unknownSeatsOf(ghost), ['ghost-seat'],
    '两侧都不含的席位名必须仍告警（并集不是「成员名形态一律合法」的降级）；实测='
    + JSON.stringify(rosterWarningsOf(ghost)));
  assert.deepEqual(rosterWarningsOf(ghost).map((w) => w.task), ['g'], '告警须点名归属 lane g');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RU-7（**新增 · 越权锁**）· 宿主 roster 读取抛错 ⇒ 基准退化 + **告警照旧** + 一行 logger.warn
//   判断：读失败后**零告警** = 有人加了「不可用 ⇒ 不告警」的降级分支（用户裁决 D-3 明令禁止）
// ═══════════════════════════════════════════════════════════════════════════════
test('RU-7 越权锁：宿主 roster 读取抛错 ⇒ 基准退化但 roster 告警照旧 + 一行 logger.warn', async () => {
  const { root, store, byName, warns } = makeHarness('throw', {
    // 服务在场（available=true）但查询本身失败 ⇒ `read()` 抛（`lib/provider-dsh/roster.js:109-114`）
    rosterService: { listMembers: () => { throw new Error('roster-service-boom'); } },
  });
  const out = await byName.wave_plan.execute({
    batchId: 'b-throw',
    tasks: [{ id: 'a', cmd: 'x', roster: 'coder-1' }, { id: 'b', cmd: 'x', roster: 'coder' }],
    smoke: true,
  }, SESS);

  // ① **越权锁**：读失败后仍须有告警（零告警 ⇒ 判红）
  assert.deepEqual(unknownSeatsOf(out), ['coder-1'],
    '读失败时基准退化为 BUILTIN_ROLES ⇒ 成员名 coder-1 仍须告警（**零告警 = 加了降级分支 = 越权**）；实测='
    + JSON.stringify(rosterWarningsOf(out)));
  const w0 = rosterWarningsOf(out).find((w) => w.roster === 'coder-1');
  assert.equal(w0.hostRosterCount, 0,
    '读失败 ⇒ hostRosterCount 须为 0（读端据此可辨「基准实际只用了内建表」）');
  assert.equal(w0.code, ROSTER_UNKNOWN, '读失败不得改变告警码（仍是 ' + ROSTER_UNKNOWN + '）');

  // ② 一行 logger.warn（可核的运行期留痕；不是静默降级）
  assert.equal(warns.length > 0, true, '读失败须落至少一行 logger.warn（禁静默降级）；实测 warns=' + JSON.stringify(warns));
  assert.equal(warns.some((line) => line.includes('roster') && line.includes('告警照常发射')), true,
    'warn 文案须说明「基准退化、告警照常发射」（可核的意图声明）；实测=' + JSON.stringify(warns));

  // ③ 建批照常成功（读失败不得变成拒建批）
  assert.equal(fs.existsSync(batchFileOf(root, 'b-throw')), true, '读失败不得阻断建批：批次 JSON 须在场');
  assert.deepEqual(Object.keys(out.lanes).sort(), ['a', 'b'], '读失败不得影响入册；实测='
    + JSON.stringify(Object.keys(out.lanes)));
  // ④ 事件面仍须零（读失败不改变「不落事件」口径）
  assert.deepEqual(eventsOf(store, 'b-throw').filter((e) => e && e.type === ROSTER_UNKNOWN_EVT), [],
    '读失败不得让该告警改走事件面（' + ROSTER_UNKNOWN_EVT + ' 仍须零命中）');
});
