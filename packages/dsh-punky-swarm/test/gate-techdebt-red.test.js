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

// ─────────────────────────────────────────────────────────────────────────────
// RED 反例网 · 批次 `gate-techdebt` ｜ lane `e3-red-tests`
//
// 正源：`plan/techdebt-design.md` §5（R-01…R-36）＋ §2 逐条设计（反例验收判据）＋
//       `plan/spec.md`《验收标准》A–K（含 Leader 附则 Q3-A）。
//
// 纪律（本文件是 RED 证据的**唯一**来源，故自身必须可核）：
//   ① **直连运行期真实函数**：import `lib/state/gates.js`（宿主执行的 .js）/
//      `lib/state/store.js` / `lib/wave-plan.js`；不以 `.ts` 源码阅读替代真跑。
//   ② **零落盘污染**：批次根 = 自建 `%TEMP%` 目录；绝不触达 `~/.dsh/punky-preset/sessions/**`
//      （真实批次状态根全程只读）。
//   ③ 断言的是**目标语义（GREEN 期望）**：未实现前必须失败（RED），实现后通过（GREEN）。
//      「当前就通过」的条目一律**显式标注【回归保护 / GREEN-as-is】**，绝不伪装成红。
//   ④ 夹具形态受 `wave-plan.js` 的层契约约束（exec ⇔ audit 成对）——本文件用**最小合规批**
//      （plan + exec + 空 consume 的 audit），使被检面（entry/exit/command/targets）单一可读。
//   ⑤ 产物正文含独立行 `gate: <命令>` 者只作为**被检夹具**写入自建根；本文件自身产物不得含该形态。
//   ⑥ 时间无关：无 sleep、无时钟依赖；治理窗口用默认 10 分钟（同一次同步调用内完成）。
//   ⑦ 「先观测全部子例、再断言」：多子例先跑完并 diagnostic，避免首例失败吞掉其余子例证据。
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGates, detectGate } from '../lib/state/gates.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan, assemblyGate } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { SPEC_OK, assessC } from './helpers/gate-fixture.mjs';
import { writeTempTeam } from './helpers/team-fixture.mjs';
import { seedTeamAssetSkills } from './helpers/host-skills.mjs';

// 【P1 同步】`team` 现为必填且必须解析到资产 ⇒ 工具面建批用例须给**有资产**的团队；
//   其 skills 须可解析 ⇒ 隔离 HOME 下先注入宿主技能根（R-12 的正向对照随之补 team，被检面仍是装配门）。
seedTeamAssetSkills('software-team');
import { DEFAULT_ESCALATION_PRIMITIVES } from '../lib/governance/escalation.js';
import { MEMBER_STATES } from '../lib/schema.js';
import * as EVT from '../lib/state/event-types.js';
import * as STORE_EVT from '../lib/state/store.js';

// ═══ 会话级夹具（自建根；store 与 gates 共享同一根 ⇒ 磁盘批文件即唯一事实源）═══

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-techdebt-red-'));

// 套件对齐归档（批次 gate-techdebt · lane e2-gov-repair · 用户裁决 Q1=C）：
//   失效红条的**原用例体逐字**保存在本对象中（活字符串数据，零执行）；
//   对应的 test.todo 仅登记待办，正确断言留待独立小批复活（复用时取出文本重组即可）。
const ARCHIVED_CASES = {};

const SID = 's-techdebt-red';
const store = createStore(ROOT);
const gates = createGates(ROOT);

// 本批新增事件常量（§5.1 五常量）：未落地时为 undefined ⇒ `?? 字面值` 保证
// 「常量缺位」与「行为缺位」两半分别可判（不互相吞掉）。
const E_ESCAPE = EVT.EVT_GATE_ESCAPE ?? 'gate.escape';
const E_DEGRADE = EVT.EVT_GATE_DEGRADE ?? 'gate.degrade';
const E_LANE_DEGRADE = EVT.EVT_LANE_GOVERNANCE_DEGRADE ?? 'lane.governance-degrade';
// 设计 §5.1 的常量名（e1 落点）：缺失即 R-32 红；**若 e1 改名，R-32 必然转红**（强制同步登记）
// 【套件对齐（批次 gate-techdebt · lane e2-gov-repair · 用户裁决 Q1=C）】常量数 **3 → 2**：
//   用户裁决 G-a 不实施 ⇒ `EVT_LANE_GOVERNANCE_DEGRADE` **不新增**（无消费者，不预留）⇒ 本清单同步收敛为 2 项。
//   用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；
//     本条因「常量数 3 → 2（`EVT_LANE_GOVERNANCE_DEGRADE` 不新增）」转 todo。
const CONST_NAMES = ['EVT_GATE_ESCAPE', 'EVT_GATE_DEGRADE'];
// 原三常量断言（逐字保留，供独立小批复活）：
//   const CONST_NAMES = ['EVT_GATE_ESCAPE', 'EVT_GATE_DEGRADE', 'EVT_LANE_GOVERNANCE_DEGRADE'];
const HISTORIC_EVENT_NAMES = [
  'lane.exempt.cleared', 'lane.exempt.inherited', 'gate.entry.missing',
  'gate.exit', 'gate.exit_blocked', 'gate.target.passed',
];
// 包根（**cwd 无关**）：本 lane 的 `gate:` 命令由引擎在**产物根**执行（非仓库根），
//   任何 `process.cwd()` 相关的夹具路径都会在产物根下 ENOENT ⇒ 一律以本文件位置解析。
//   （驱动：A-② lane e2 的 gate 命令 GATE_EXIT_NONZERO 返工；仓库根运行行为逐字不变。）
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 基础工具 ──
const fixturesWritten = new Set(); // 已成功落盘的夹具批（供前置自检）
function batchFileOf(bid) { return path.join(ROOT, 'sessions', SID, 'batches', bid + '.json'); }
function artifactsDirOf(bid) { return path.join(ROOT, 'sessions', SID, 'artifacts', bid); }
function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function writeArt(bid, rel, content) {
  const abs = path.join(artifactsDirOf(bid), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}
function setLaneState(bid, lane, state) {
  const b = store.readBatch(SID, bid);
  b.lanes[lane] = state;
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  return b;
}
function trySet(bid, lane, to, note) {
  try { return store.setMember(SID, bid, lane, to, note); } catch (e) { return e; }
}
function evsOf(bid) { return store.readBatch(SID, bid).events; }
function withType(bid, type) { return evsOf(bid).filter((e) => e && e.type === type); }
// 安全观测器：node:test 的 diagnostic 并非在所有运行器/子测试上都可用 ⇒ 退化到 stdout（证据不丢）
function obs(t, label, v) {
  const line = '[RED-OBS] ' + label + ' → ' + (typeof v === 'string' ? v : JSON.stringify(v));
  if (t && typeof t.diagnostic === 'function') t.diagnostic(line); else console.log(line);
}
function expectAccepted(label, r) {
  if (r instanceof Error) assert.fail(`${label}: 期望放行，实测错误 → ` + r.message);
}
function expectRejected(label, r, code) {
  if (!(r instanceof Error)) assert.fail(`${label}: 期望拒 ${code}，实测放行 → ` + JSON.stringify(r));
  assert.ok(r.message.includes(code), `${label}: 拒因须含 ${code}；实测=${r.message}`);
}

// ── 批次夹具（直写合规批；镜像 fixture helper 的形态，可按被检面裁剪）──
function auditTask(id, { consume = [], produce = [], outputs = undefined } = {}) {
  return { id, layer: 'audit', role: 'supervisor', cmd: 'accept', deps: ['e1'], consume, produce, ...(outputs ? { outputs } : {}) };
}
function planTask(id = 'p1', spec = 'plan/spec.md') { return { id, layer: 'plan', role: 'designer', produce: [spec], cmd: 'spec' }; }
function execTask(id = 'e1', over = {}) {
  return { id, layer: 'exec', role: 'coder', cmd: 'run', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/' + id + '.md'], ...over };
}
/* 批次夹具（直写合规批；镜像 fixture helper 的形态，可按被检面裁剪）*/
function mkFixtures(bid, { tasks, lanes, laneState, team, teamsRoot, phase = 'running' } = {}) {
  const plan = buildWavePlan({ batchId: bid, tasks, team });
  store.createBatch(SID, { batchId: bid, wavePlan: plan, concurrency: plan.concurrency });
  const b = store.readBatch(SID, bid);
  Object.assign(b.lanes, lanes ?? Object.fromEntries(tasks.map((t) => [t.id, laneState ?? 'pending'])));
  if (team) b.team = team;
  if (teamsRoot) b.teamsRoot = teamsRoot;
  b.phase = phase;
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  fixturesWritten.add(bid);
  return bid;
}
/* 最小合规批：plan + exec + audit 成对 —— 层契约与 A1（plan 产物须被 consume）由 wave-plan 校验器把关 */
function mkBase(bid, execOver = {}, auditOver = {}, opts = {}) {
  const base = {
    tasks: [
      planTask(),
      execTask('e1', { consume: ['plan/spec.md'], outputs: ['exec/e1.md'], ...execOver }),
      auditTask('a1', { consume: ['plan/spec.md'], ...auditOver }),
    ],
    team: opts.team ?? 'software-team', teamsRoot: opts.teamsRoot, laneState: opts.laneState,
  };
  const id = mkFixtures(bid, base);
  writeArt(id, 'plan/spec.md', SPEC_OK);
  return id;
}
function mkPlanExec(bid, execOver = {}, opts = {}) {
  return mkBase(bid, execOver, {}, opts);
}
/* entry 面判据只读「lane 声明」⇒ 声明可由夹具直置（层契约仍由合规基线保证）*/
function declareLaneField(bid, lane, patch) {
  const b = store.readBatch(SID, bid);
  const t = b.wavePlan.flatMap((w) => w.tasks).find((x) => x.id === lane);
  Object.assign(t, patch);
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  return b;
}
function mkSettled(bid) {
  const id = mkPlanExec(bid, {}, {});
  writeArt(id, 'exec/e1.md', 'out');
  return id;
}
/* 「批次内确实无可用上游」的合规批（standalone 唯一可放行形态）：
   exec lane 只声明产物、**无 plan 层** ⇒ availableUpstream=false（与 T23(d) 同法）。
   ⚠ 实测发现（e3 lane，R-01 排障所得）：`buildWavePlan` 的归一化**不保留 `standaloneReason`**
   （`lib/wave-plan.js:691-707` 只写 `standalone` 布尔）⇒ 批次里该字段恒缺 ⇒ entry 门判
   `GATE_STANDALONE_UNJUSTIFIED`。本 helper 先把 batch 落盘，再补写该字段，使**下游写路径**
   （事件落盘）可被独立检验；该归一化缺口另由 R-01b 单独断言。*/
function mkNoUpstream(bid, execOver = {}) {
  const id = mkFixtures(bid, {
    tasks: [
      execTask('spec1', { deps: [], consume: null, outputs: ['exec/spec.md'] }),
      execTask('e1', { deps: [], consume: null, ...execOver }),
      auditTask('a1', { consume: [] }),
    ],
  });
  if (typeof execOver.standaloneReason === 'string' && execOver.standaloneReason.length > 0) {
    declareLaneField(id, 'e1', { standaloneReason: execOver.standaloneReason });
  }
  return id;
}
function mkRunning(bid, laneIds) {
  // 治理面夹具：lanes 由 fixture 提供（buildWavePlan 直调产出合法 plan）
  const plan = buildWavePlan({ batchId: bid, tasks: laneIds.map((id) => ({ id })) });
  store.createBatch(SID, { batchId: bid, wavePlan: plan, phase: 'running' });
  fixturesWritten.add(bid);
  return bid;
}
/* 临时团队资产（自建根；以包内 software-team 为骨架改一处）*/
function mkTeamRoot(team, mutate) {
  // F2：单点委托——真实骨架 + `asset.team` 同步（见 helpers/team-fixture.mjs#writeTempTeam）。
  return writeTempTeam('punky-techdebt-team-', team, (a) => { a.team = team; mutate(a); }, { setTeam: true });
}

// ── 治理面夹具 ──
const ESC_ON = { enabled: true, threshold: 3, windowMs: 600000, primitives: DEFAULT_ESCALATION_PRIMITIVES };
function record(bid, i, over = {}) {
  return store.recordGovernanceRefusal(SID, bid, {
    lane: 'l1', receiptId: 'r' + i, primitive: 'DENY', ruleRefs: ['L3-W01'], tool: 'pwsh', escalation: ESC_ON, ...over,
  });
}
function toolHarness() {
  const { tools } = createTools({ tools: { register() {} }, logger: console }, { store, root: ROOT });
  // G1 前置（新门禁）：`wave_plan` 属 C 档动作 ⇒ 工具面用例先把本会话评估为 C（同 assign_check 落盘函数）
  assessC(store, SID, { rationale: 'fixture：gate-techdebt 工具面建批前置评估（多线门禁治理 ⇒ C 档）' });
  return { tools, byName: Object.fromEntries(tools.map((t) => [t.name, t])) };
}
const EXEC_SESS = { agent: { session: { id: SID } } };

// ═══════════════════════════════════════════════════════════════════════════
// 组 A · 夹具自检（前置：后续全部断言的前提）
// ═══════════════════════════════════════════════════════════════════════════

test('R-A0 夹具自检：最小合规批可建、lane 表与 wavePlan 一致、批文件在场', () => {
  const bid = mkPlanExec('r-a0');
  const b = store.readBatch(SID, bid);
  const ids = b.wavePlan.flatMap((w) => w.tasks.map((t) => t.id));
  obs(null, 'wavePlan task ids / lanes keys', { ids, lanes: Object.keys(b.lanes) });
  assert.deepEqual([...ids].sort(), Object.keys(b.lanes).sort(), 'per-lane 契约：任务与 lane 表须一致');
  assert.ok(fs.existsSync(batchFileOf(bid)), '夹具批文件须在场');
  assert.equal(fixturesWritten.has(bid), true, '夹具登记须成功');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 B · V-4 零静默事件面接线（R-01…R-04 / R-32 / R-33）
//   现状：`event-types.js` 无 gate.escape / gate.degrade / lane.governance-degrade 常量，
//   全 `lib/**` 无写端，而读端（gates.js:903-904 字节字面量）已存在 ⇒ 返回面有、事件面空。
// ═══════════════════════════════════════════════════════════════════════════

test('R-01b 【e3 实测发现】建批期归一化必须保留 standaloneReason（否则 standalone 逃生阀全批次不可达）', () => {
  let built = null; let err = null;
  try {
    built = buildWavePlan({
      batchId: 'r01b',
      tasks: [execTask('spec1', { deps: [], consume: null, outputs: ['exec/spec.md'] }),
        execTask('e1', { deps: [], consume: null, standalone: true, standaloneReason: '本批确实无 plan 上游' }),
        auditTask('a1', { consume: [] })],
      team: 'software-team',
    });
  } catch (e) { err = e; }
  const t = built && built.wavePlan.flatMap((w) => w.tasks).find((x) => x.id === 'e1');
  obs(null, '归一化后的 e1 任务对象', t ? { standalone: t.standalone, standaloneReason: t.standaloneReason } : String(err && err.message));
  assert.equal(err, null, '夹具须可建批：' + String(err && err.message));
  assert.equal(t.standalone, true, '前置：standalone 布尔须保留（实测已保留）');
  assert.equal(t.standaloneReason, '本批确实无 plan 上游',
    'entry 门的 standalone 事实核验读 `t.standaloneReason`（gates.js:394-407）⇒ 建批归一化必须保留该字段，'
    + '否则**任何真实批次**的 standalone 逃生阀都恒判 GATE_STANDALONE_UNJUSTIFIED（当前实测='
    + JSON.stringify(t.standaloneReason) + '，逃生阀不可达）');
});

test('R-01 standalone 逃生放行 ⇒ batch.events 含 gate.escape{kind:"standalone"}（V-4 接线）', () => {
  const bid = mkNoUpstream('r01', { standalone: true, standaloneReason: '本批确实无 plan 上游' });
  writeArt(bid, 'exec/e1.md', 'out');
  const r = trySet(bid, 'e1', 'running');
  obs(null, 'setMember(e1, running)', r instanceof Error ? r.message : { lane: r.lanes.e1 });
  obs(null, 'events[type=gate.escape]', withType(bid, E_ESCAPE));
  expectAccepted('standalone（真无上游 + 非空 reason）', r);
  const esc = withType(bid, E_ESCAPE);
  assert.equal(esc.length, 1, 'V-4：逃生路径必须在**写路径**落 batch.events（当前恒 0 条）——实测=' + JSON.stringify(esc));
  assert.equal(esc[0].kind, 'standalone', 'escape 载荷须含 kind:"standalone"：' + JSON.stringify(esc[0]));
  assert.equal(esc[0].lane, 'e1', 'escape 载荷须含 lane：' + JSON.stringify(esc[0]));
  assert.ok(typeof esc[0].reason === 'string' && esc[0].reason.length > 0, 'escape 须携带 reason 供审计：' + JSON.stringify(esc[0]));
});

test('R-02 idle 恢复降级放行 ⇒ batch.events 含 gate.escape{kind:"idle-recovery-passthrough"}', () => {
  const bid = mkPlanExec('r02', { consume: ['plan/spec.md', 'exec/not-yet/'] });
  writeArt(bid, 'exec/e1.md', 'out');
  setLaneState(bid, 'e1', 'idle'); // idle 是恢复档；由夹具直置（pending→idle 非法迁移，见 R-21）
  const r = trySet(bid, 'e1', 'running');
  obs(null, 'idle→running 结果', r instanceof Error ? r.message : { lane: r.lanes.e1 });
  obs(null, 'events[type=gate.escape]', withType(bid, E_ESCAPE));
  expectAccepted('idle 恢复（G-1 唯一出边）不得硬拒', r);
  const esc = withType(bid, E_ESCAPE);
  assert.equal(esc.length, 1, 'V-4：恢复降级路径必须在写路径落 batch.events（当前恒 0）——实测=' + JSON.stringify(esc));
  assert.equal(esc[0].kind, 'idle-recovery-passthrough', 'escape 载荷 kind=' + JSON.stringify(esc[0]));
});

// 用户 2026-09-14 裁决（grilling Q11=A）：失效红条转 test.todo ＋ 逐字引注（模板同 Q1=C）。
// **实现已完成**（V-4 写端已在 `store.js` 落盘，probe 实证：`gate.degrade{kind:'produce-field-widened'}` /
//   `gate.escape{kind:'needhuman-off'|'env-gate-disabled'|'targets-off'}` 均真写入 `batch.events`）；
//   **仅测试调用层错位** —— 本用例**直调门禁函数**（`gates.checkExitGate` / `checkNeedHumanGate` /
//   `checkCommandGate` / `checkTargetsGate`）后读事件，而 `plan/spec.md` §5.3 规定写端只在 `store.js` 写路径，
//   且「只读视图（gate_status）绝不得发射事件」（B-4）。⇒ **正确形态 = 经 `setMember`/`runLane` 端到端驱动**
//   （同 R-01/R-02/R-27a 的已绿形态）。本条**不得**被读成「未实现」。
// 原用例体逐字保留于下方 `ARCHIVED_CASES`（活字符串数据、不执行），正确断言留待独立小批复活。
test('R-03【复活·T-1】produce_field 错位触发并集降级 ⇒ batch.events 含 gate.degrade{kind:"produce-field-widened"}（端到端驱动）', () => {
  // 【复活要点·2026-09-15 批次 core-debt-parallel-20260915 / lane e2】原形态为何失效：归档体**直调**
  //   `gates.checkExitGate` 后读事件 ⇒ 与「写端唯一在 store.js 写路径 / 只读视图零事件」纪律错位（只读面必然 0 条）。
  //   本次改动：① 保留返回值 `degrades` 断言（可读面，GREEN-as-is）＋ 增补「只读直调零事件」硬边界断言；
  //   ② 事件面改由 `store.setMember`（review→merged）**端到端驱动**（写端 store.js:550 / :674-682）。
  const tp = mkTeamRoot('r03-team', (a) => { a.flows.exec.produce_field = 'produce'; });
  const bid = mkBase('r03', { consume: null, outputs: ['exec/e1.md'] }, {}, { team: 'r03-team', teamsRoot: tp });
  writeArt(bid, 'exec/e1.md', 'out');
  setLaneState(bid, 'e1', 'review');
  const deg = gates.checkExitGate(SID, bid, store.readBatch(SID, bid), 'e1');
  obs(null, 'checkExitGate(produce_field=produce, 仅 outputs)', deg);
  assert.equal(deg.ok, true, '前置：降级路径本身仍放行（降级非拒码）；实测=' + JSON.stringify(deg));
  assert.ok(Array.isArray(deg.degrades) && deg.degrades.some((d) => d.kind === 'produce-field-widened'),
    'S8/原则②：字段错位触发并集降级 ⇒ 返回值须带 degrade（可读面，当前已通过 = GREEN-as-is）；实测=' + JSON.stringify(deg.degrades));
  assert.equal(withType(bid, E_DEGRADE).length, 0,
    'B-4：只读视图/直调门禁函数**零事件**（写端唯一在 store.js 写路径）；实测=' + JSON.stringify(withType(bid, E_DEGRADE)));
  const r = trySet(bid, 'e1', 'merged');
  obs(null, 'setMember(e1, merged)', r instanceof Error ? r.message : { lane: r.lanes.e1 });
  obs(null, 'events[type=gate.degrade]', withType(bid, E_DEGRADE));
  expectAccepted('S8：字段错位降级不得演变成拒（降级非拒码）', r);
  const evs = withType(bid, E_DEGRADE);
  assert.ok(evs.some((e) => e.kind === 'produce-field-widened'),
    'V-4：降级路径必须在**写路径**上真落 batch.events（原直调形态恒 0 条）；实测=' + JSON.stringify(evs));
});
ARCHIVED_CASES['R-03 produce_field 错位触发并集降级 ⇒ batch.events 含 gate.degrade{kind:"produce-field-widened"}'] = [
  '【已复活 ⇒ 见用例「R-03【复活·T-1】…（端到端驱动）」（批次 core-debt-parallel-20260915 · lane e2）】',
  '  const tp = mkTeamRoot(\'r03-team\', (a) => { a.flows.exec.produce_field = \'produce\'; });',
  '  const bid = mkBase(\'r03\', { consume: null, outputs: [\'exec/e1.md\'] }, {}, { team: \'r03-team\', teamsRoot: tp });',
  '  writeArt(bid, \'exec/e1.md\', \'out\');',
  '  setLaneState(bid, \'e1\', \'review\');',
  '  const deg = gates.checkExitGate(SID, bid, store.readBatch(SID, bid), \'e1\');',
  '  obs(null, \'checkExitGate(produce_field=produce, 仅 outputs)\', deg);',
  '  assert.equal(deg.ok, true, \'前置：降级路径本身仍放行（降级非拒码）；实测=\' + JSON.stringify(deg));',
  '  assert.ok(Array.isArray(deg.degrades) && deg.degrades.some((d) => d.kind === \'produce-field-widened\'),',
  '    \'S8/原则②：字段错位触发并集降级 ⇒ 返回值须带 degrade（可读面，当前已通过 = GREEN-as-is）；实测=\' + JSON.stringify(deg.degrades));',
  '  const evs = withType(bid, E_DEGRADE);',
  '  obs(null, \'events[type=gate.degrade]\', evs);',
  '  assert.ok(evs.some((e) => e.kind === \'produce-field-widened\'),',
  '    \'V-4：降级路径必须在**写路径**上真落 batch.events（当前全 lib 无写端 ⇒ 恒 0 条）；实测=\' + JSON.stringify(evs));',
];

test('R-04 只读不发射：连续两次 gate_status 后 batch.events 长度不变（B-4 / J-5）', async () => {
  const bid = mkSettled('r04');
  const { byName } = toolHarness();
  const n0 = evsOf(bid).length;
  await byName.gate_status.execute({ batchId: bid }, EXEC_SESS);
  const n1 = evsOf(bid).length;
  await byName.gate_status.execute({ batchId: bid }, EXEC_SESS);
  const n2 = evsOf(bid).length;
  obs(null, 'events.length 三次读数（前/两次只读后）', [n0, n1, n2]);
  assert.equal(n1, n0, 'R-04：只读门禁视图不得发射事件（第 1 次）');
  assert.equal(n2, n0, 'R-04：只读门禁视图不得发射事件（第 2 次）');
});

// 原 R-32 / R-33 的**常量在场断言**（逐字保留，供独立小批复活）：
//   const missing = CONST_NAMES.filter((n) => typeof EVT[n] !== 'string' || EVT[n].length === 0);
//   assert.deepEqual(missing, [], 'V-4/§5.1：五常量必须单点入 lib/state/event-types.js；缺位=' + JSON.stringify(missing));
//   const absent = CONST_NAMES.filter((n) => typeof EVT[n] !== 'string');
//   assert.deepEqual(absent, [], 'fail-closed 前置：常量必须在场（缺位时写端须抛明确错误，而非写 type:undefined）；缺位=' + JSON.stringify(absent));
// 用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；
//   本条因「常量数 3 → 2（`EVT_LANE_GOVERNANCE_DEGRADE` 不新增）」转 todo。
// 说明：本批常量面收敛为**两个**（`EVT_GATE_ESCAPE` / `EVT_GATE_DEGRADE`，见上方 `CONST_NAMES`）；
//   原断言要求三常量在场 ⇒ 与用户裁决 G-a 不实施正面冲突 ⇒ **只**把「常量在场」这一段转 todo，
//   同一用例内的历史事件名逐字不变断言（B-5）**照常执行**（回归保护不得因此失效）。
function assertConstantsPresent(label) {
  const missing = CONST_NAMES.filter((n) => typeof EVT[n] !== 'string' || EVT[n].length === 0);
  assert.deepEqual(missing, [], label + '：常量必须在场；缺位=' + JSON.stringify(missing));
}
test('R-32b【复活·T-2/T-3】原「常量在场 / fail-closed 前置」断言逐字解壳（CONST_NAMES 现为 2 项）', () => {
  // 【复活要点·2026-09-15 批次 core-debt-parallel-20260915 / lane e2】原 todo 形态为何失效：两条 todo 只有**断言**
  //   而没有变量定义（`missing` / `absent` 无定义 ⇒ 逐字解壳即 ReferenceError）。本次在用例体内按归档文本定义两变量
  //   并**逐字**执行两条断言。判据与 R-32/R-33 的 `assertConstantsPresent` 同源（规格 §2.1 T-2/T-3 允许并入既有
  //   断言点；此处以独立用例承载以保「原断言文本逐字可核」，重复面 = 同源判据、非新语义）。
  const missing = CONST_NAMES.filter((n) => typeof EVT[n] !== 'string' || EVT[n].length === 0);
  assert.deepEqual(missing, [], 'V-4/§5.1：五常量必须单点入 lib/state/event-types.js；缺位=' + JSON.stringify(missing));
  const absent = CONST_NAMES.filter((n) => typeof EVT[n] !== 'string');
  assert.deepEqual(absent, [], 'fail-closed 前置：常量必须在场（缺位时写端须抛明确错误，而非写 type:undefined）；缺位=' + JSON.stringify(absent));
});

test('R-32 新增事件常量在场 ＋ 历史事件名逐字不变（B-1 / B-5 回归保护）', () => {
  // 【套件对齐 Q1=C】原「三常量在场」断言已转 test.todo（见上方）；此处执行**收敛为 2 项**的同一判据。
  assertConstantsPresent('V-4/§5.1');
  const histPresence = HISTORIC_EVENT_NAMES.map((v) => ({ name: v, inEventTypes: Object.values(EVT).includes(v) }));
  obs(null, '历史名逐字在场', histPresence);
  assert.equal(STORE_EVT.EVT_LANE_EXEMPT_INHERITED, 'lane.exempt.inherited', '历史事件名 lane.exempt.inherited 必须逐字仍在（store.js 再导出面）');
  assert.equal(STORE_EVT.EVT_LANE_EXEMPT_CLEARED, 'lane.exempt.cleared', '历史事件名 lane.exempt.cleared 必须逐字仍在（store.js 再导出面）');
  const notInEventTypes = histPresence.filter((h) => !h.inEventTypes).map((h) => h.name);
  assert.deepEqual(notInEventTypes, [], 'B-5：6 个历史事件名须在同一处单点可查；缺失=' + JSON.stringify(notInEventTypes));
});

test('R-33 fail-closed：新事件常量必须单点在场（写端不得写 type:undefined）', () => {
  // 【套件对齐 Q1=C】原「三常量在场」前置已转 test.todo（见上方）；此处执行收敛为 2 项的同源判据。
  assertConstantsPresent('fail-closed 前置');
  const bid = mkSettled('r33');
  const bad = evsOf(bid).filter((e) => !e || typeof e.type !== 'string' || e.type === 'undefined');
  obs(null, '异常事件类型条目数', bad.length);
  assert.equal(bad.length, 0, '写端须 fail-closed：不得把常量缺位写成语义失名的事件');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 C · ① requiredBy 真来源（R-05 / R-06）＋ ② 团队级逃生阀删除（R-07…R-09）
// ═══════════════════════════════════════════════════════════════════════════

test('R-05 generic（无资产）＋ exec 空 consume ⇒ 拒 且 requiredBy !== "team-asset:entry_requires"', () => {
  const bid = mkPlanExec('r05', {}, { team: 'generic' });
  declareLaneField(bid, 'e1', { consume: [] });
  const r = gates.checkEntryGate(SID, bid, store.readBatch(SID, bid), 'e1');
  obs(null, 'checkEntryGate(generic, consume=[])', r);
  assert.equal(r.ok, false, '空 consume 必须拒（不得因「团队未声明」而成免检面）');
  assert.equal(r.code, 'GATE_ENTRY_MISSING', '拒码=' + r.code);
  assert.notEqual(r.requiredBy, 'team-asset:entry_requires',
    'G-3：无资产团队**未声明** entry_requires ⇒ requiredBy 须为真实来源 tighten-only-default，不得失真为团队来源；实测=' + JSON.stringify(r.requiredBy));
});

test('R-06 正向对照：software-team（entry_requires:["consume"]）＋ 空 consume ⇒ requiredBy === "team-asset:entry_requires"【回归保护】', () => {
  const bid = mkPlanExec('r06');
  declareLaneField(bid, 'e1', { consume: [] });
  const r = gates.checkEntryGate(SID, bid, store.readBatch(SID, bid), 'e1');
  obs(null, 'checkEntryGate(software-team, consume=[])', r);
  assert.equal(r.ok, false, '显式声明强制项须生效（当前已通过）');
  assert.equal(r.code, 'GATE_ENTRY_MISSING', '拒码=' + r.code);
  assert.equal(r.requiredBy, 'team-asset:entry_requires',
    '正向对照【GREEN-as-is】：已声明团队仍报团队来源 ⇒ 证明修正不是「无差别抹掉」');
});

test('R-07 团队级 entry_requires:[] ＋ exec 空 consume ⇒ 仍拒 GATE_ENTRY_MISSING【回归保护】', () => {
  const tp = mkTeamRoot('r07-team', (a) => { a.flows.exec.entry_requires = []; });
  const bid = mkBase('r07', {}, {}, { team: 'r07-team', teamsRoot: tp });
  declareLaneField(bid, 'e1', { consume: [] });
  const r = gates.checkEntryGate(SID, bid, store.readBatch(SID, bid), 'e1');
  obs(null, 'checkEntryGate(团队 entry_requires:[], consume=[])', r);
  assert.equal(r.ok, false, 'D-1：团队级 [] **不得**成为放行入口（回归保护，恒成立）');
  assert.equal(r.code, 'GATE_ENTRY_MISSING', '拒码=' + r.code);
});

test('R-08 任务级 standalone（布尔 true + 非空 reason）⇒ 放行 ＋ 事件落 gate.escape{kind:"standalone"}', () => {
  const bid = mkNoUpstream('r08', { standalone: true, standaloneReason: '本批确实无 plan 上游' });
  writeArt(bid, 'exec/e1.md', 'out');
  const r = trySet(bid, 'e1', 'running');
  obs(null, 'setMember(e1, running)', r instanceof Error ? r.message : { lane: r.lanes.e1 });
  expectAccepted('合法 standalone（当前已通过）', r);
  const esc = withType(bid, E_ESCAPE);
  assert.equal(esc.length, 1, 'B-2/R-ER-2：放行必须落事件留痕（当前 0 条）——实测=' + JSON.stringify(esc));
  assert.equal(esc[0].kind, 'standalone', 'escape kind=' + JSON.stringify(esc[0]));
});

test('R-09 standalone 负例：字符串 "true" 被建批期校验拒 / 空 reason 拒 / 有可用上游须拒（三判据）', () => {
  // (a) 字符串 "true"：建批期即 fail-closed（reason 为可读文本）
  let aErr = null;
  try {
    mkFixtures('r09a', {
      tasks: [execTask('spec1', { deps: [], consume: null, outputs: ['exec/spec.md'] }), execTask('e1', { deps: [], consume: null, standalone: 'true' }), auditTask('a1', { consume: [] })],
    });
  } catch (e) { aErr = e; }
  // (b) 有可用上游（plan 层声明产物在场）却声明 standalone ⇒ 事实核验须拒
  const bidB = mkPlanExec('r09b');
  declareLaneField(bidB, 'e1', { consume: null, standalone: true, standaloneReason: '我认为没有上游' });
  const rB = gates.checkEntryGate(SID, bidB, store.readBatch(SID, bidB), 'e1');
  // (c) 布尔 true 但 standaloneReason 为空 ⇒ 拒
  const bidC = mkNoUpstream('r09c', { standalone: true, standaloneReason: '' });
  const rC = gates.checkEntryGate(SID, bidC, store.readBatch(SID, bidC), 'e1');
  obs(null, '(a) standalone 字符串 "true" 的建批期校验', aErr ? aErr.message : 'NO-THROW（放行 = 缺陷）');
  obs(null, '(b) 有可用 plan 上游却声明无上游', rB);
  obs(null, '(c) 布尔 true 但 standaloneReason 为空', rC);
  assert.ok(aErr instanceof Error, 'D-2：standalone 须为**布尔** true —— 字符串形态不得进入批（fail-closed）');
  assert.ok(/standalone must be a boolean/.test(aErr.message), '拒因须可读；实测=' + aErr.message);
  assert.equal(rB.ok, false, 'B4 事实核验：批次内确有可用上游 ⇒ 拒；实测=' + JSON.stringify(rB));
  assert.equal(rB.code, 'GATE_STANDALONE_UNJUSTIFIED', '拒码=' + rB.code);
  assert.equal(rC.ok, false, 'D-2：非空 standaloneReason 必填；实测=' + JSON.stringify(rC));
  assert.equal(rC.code, 'GATE_STANDALONE_UNJUSTIFIED', '拒码=' + rC.code);
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 D · ③ 建批期双入口（R-10 / R-11 / R-12）＋ 工具描述登记（R-DE-4）
// ═══════════════════════════════════════════════════════════════════════════

test('R-10 直调 buildWavePlan（无 assembly）⇒ 不抛【回归保护 · 差异面固化】', () => {
  const tasks = [planTask(), execTask('e1'), auditTask('a1', { consume: ['plan/spec.md'], produce: ['audit/a1.md'] })];
  let out = null; let err = null;
  try { out = buildWavePlan({ batchId: 'r10', tasks, team: 'software-team' }); } catch (e) { err = e; }
  obs(null, 'buildWavePlan 直调结果', err ? 'THREW: ' + err.message : { waves: out.wavePlan.length });
  assert.equal(err, null, 'R-DE-1：直调入口**不**走 assembly 门（有意差异，已登记）；实测抛=' + (err && err.message));
  assert.ok(out && Array.isArray(out.wavePlan), '直调须返回合法 plan');
});

test('R-11 assemblyGate(同 tasks, null) ⇒ 返 GATE_ROLE_ASSEMBLY_MISSING【差异可机器检出】', () => {
  const tasks = [planTask(), execTask('e1'), auditTask('a1', { consume: ['plan/spec.md'], produce: ['audit/a1.md'] })];
  const r = assemblyGate(tasks, null);
  obs(null, 'assemblyGate(tasks, null) 形态与值', { typeof: typeof r, value: r });
  const text = typeof r === 'string' ? r : JSON.stringify(r);
  assert.ok(text.includes('GATE_ROLE_ASSEMBLY_MISSING'),
    'R-DE-2：同 tasks 在 assemblyGate 下必须返 GATE_ROLE_ASSEMBLY_MISSING（与 R-10 的 NO-THROW 构成差异双面）；实测=' + text);
});

test('R-12 正向对照：工具面 wave_plan 对同 tasks 仍拒建批、零批次 JSON 落盘', async () => {
  const { byName } = toolHarness();
  const tasks = [planTask(), execTask('e1'), auditTask('a1', { consume: ['plan/spec.md'], produce: ['audit/a1.md'] })];
  let err = null;
  // 【P1 同步】补 `team:'software-team'`（team 现必填；无资产 ⇒ 构造期先拒，会遮住本用例的被检面=装配门）。
  try { await byName.wave_plan.execute({ batchId: 'r12', team: 'software-team', tasks, concurrency: 3 }, EXEC_SESS); } catch (e) { err = e; }
  obs(null, '工具面 wave_plan 结果', err ? 'THREW: ' + err.message : 'NO-THROW');
  assert.ok(err instanceof Error, 'R-DE-3：工具面必须仍拒（防无差别放宽）');
  assert.ok(err.message.includes('GATE_ROLE_ASSEMBLY_MISSING'), '拒码须为 GATE_ROLE_ASSEMBLY_MISSING；实测=' + err.message);
  assert.equal(fs.existsSync(batchFileOf('r12')), false, '拒建批 ⇒ 零批次 JSON 落盘');
});

test('R-DE-4 工具描述（machine-readable 面）登记「直调不走本门」的有意差异', () => {
  const { byName } = toolHarness();
  const desc = JSON.stringify(byName.wave_plan);
  obs(null, '描述命中面', {
    directCall: /直调|buildWavePlan/i.test(desc),
    registeredDiff: /有意差异|登记/.test(desc),
    docRef: /techdebt-design/.test(desc),
  });
  assert.ok(/直调|buildWavePlan/i.test(desc), 'E-3：描述须写清「本门只在工具面生效；直调 buildWavePlan 不走本门」');
  assert.ok(/techdebt-design/.test(desc), 'E-3：描述须指向登记位置 plan/techdebt-design.md §3');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 E · G-2 / G-3 gateStrength 接线（R-13 / R-14 / R-29）
// ═══════════════════════════════════════════════════════════════════════════

test('R-13 gateStrength.entryRequires[<layer>] 必须为对象且含 source 字段（F-1）', () => {
  const bid = mkSettled('r13');
  const gs = gates.gateStatus(SID, bid).gateStrength;
  obs(null, 'gateStrength.entryRequires', gs.entryRequires);
  const er = gs.entryRequires;
  assert.ok(er && typeof er === 'object', 'G-2：gateStrength 须暴露 entryRequires：' + JSON.stringify(er));
  for (const l of ['plan', 'exec', 'audit']) {
    const v = er[l];
    assert.ok(v && typeof v === 'object' && !Array.isArray(v),
      `R-GS-1：entryRequires.${l} 必须为**对象**（含 source）；当前形态=` + JSON.stringify(v));
  }
  assert.ok(['team-asset:entry_requires', 'tighten-only-default'].includes(er?.exec?.source),
    'R-GS-1：对象须含真实来源 source；实测=' + JSON.stringify(er?.exec));
});

test('R-14 gateStrength.unwired 须由台账真值驱动（单源；区分性构造含 rework）', () => {
  const tp = mkTeamRoot('r14-team', (a) => { a.flows.exec.rework = 'unwired-decl'; });
  const bid = mkBase('r14', {}, {}, { team: 'r14-team', teamsRoot: tp });
  const gs = gates.gateStatus(SID, bid).gateStrength;
  const list = (Array.isArray(gs.unwired) ? gs.unwired : []).map((x) => (typeof x === 'string' ? x : x && x.name));
  obs(null, 'gateStrength.unwired（临时团队声明 rework）', gs.unwired);
  const hardcoded = ['progress_contract', 'state_machine', 'config.ratchet', 'consume_field'];
  obs(null, '硬编码 4 项对照（不含 rework）', hardcoded);
  assert.ok(list.length > 0, 'S19②：unwired 不得为空（台账有未接线项）；实测=' + JSON.stringify(gs.unwired));
  assert.ok(list.includes('config.ratchet'), 'R-14/S20：unwired 必须含 config.ratchet（引擎级、已接线键与该面区分）；实测=' + JSON.stringify(list));
  // 【2026-09-18 清债翻牌】原断言为「声明 rework 即出现在 unwired（台账驱动 ⇒ 与硬编码 4 项可区分）」；
  //   清债后顶层 `rework` **已退役**（零运行期消费者 ⇒ **声明即拒** `FIELD_NOT_ALLOWED`）⇒ 它**不再**进
  //   unwired 面。区分性判据随之改为**反向**锚：退役键**不得**出现在 unwired（否则说明台账仍在登记退役键）。
  assert.equal(list.includes('rework'), false,
    '2026-09-18 清债：rework 已退役 ⇒ 不得再出现在 unwired 面（改由 FIELD_NOT_ALLOWED 声明即拒）；实测=' + JSON.stringify(list));
});

test('R-29 unwired 项须标注 status:"unwired" 与 consumer 说明（S20b 无静默欺骗面）', () => {
  const bid = mkSettled('r29');
  const gs = gates.gateStatus(SID, bid).gateStrength;
  const list = Array.isArray(gs.unwired) ? gs.unwired : [];
  const annotated = list.filter((x) => x && typeof x === 'object' && x.status === 'unwired');
  obs(null, 'unwired 条目形态', gs.unwired);
  obs(null, '带 status:"unwired" 的条目数', annotated.length);
  // 【2026-09-18 清债翻牌】原断言为「带 status:"unwired" 的条目数 > 0」；清债后**台账为空**
  //   （三条历史条目移除，且退役键改为「声明即拒」而非「标注未接线」）⇒ 该数应为 **0**。
  //   断言强度不减：由「至少一条」改为「**零条**」+ 保留逐条形态断言（空集下恒真，仍防将来回填成无注解条目）。
  assert.equal(annotated.length, 0,
    '2026-09-18 清债：台账为空 ⇒ unwired 不得有 status:"unwired" 条目（退役键走 FIELD_NOT_ALLOWED）；实测=' + JSON.stringify(gs.unwired));
  assert.ok(list.every((x) => !(x && typeof x === 'object' && x.status === 'unwired') || (typeof x.consumer === 'string' && x.consumer.length > 0)),
    'R-S20b：若将来回填未接线条目，每条仍须带 consumer 说明；实测=' + JSON.stringify(list));
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 F · G-a governance-escalate 粒度（R-16…R-19）—— 本批最高价值项
// ═══════════════════════════════════════════════════════════════════════════

// 【已裁不实施（G-a governance-escalate 粒度，用户裁决维持现状）】批次 core-debt-parallel-20260915 · lane e2 标注（T-4）。
//   原因：用户已裁 G-a **不实施、维持现状** ⇒ `lane.governance-degrade` / `batch.governanceDegrade` / 批次级阈值
//     `max(t+1,2t)` / `governanceEscalatedAt` 去重键**全部无写者**（依据：本文件 :544-548、`event-types.js:132-133`）。
//   复活前置条件：若将来实施 G-a ⇒ 先登记常量 `EVT_LANE_GOVERNANCE_DEGRADE`，再接线写端，再复活本用例。
test.todo('R-16 单 lane ×3 可计入拒绝 ⇒ 批次**仍 running** ＋ lane.governance-degrade ＋ governanceDegrade[lane].count===3');
ARCHIVED_CASES['R-16 单 lane ×3 可计入拒绝 ⇒ 批次**仍 running** ＋ lane.governance-degrade ＋ governanceDegrade[lane].count===3'] = [
  '用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；',
  '  本条因「G-a 撤销（用户裁决维持现状）」转 todo。',
  '说明：G-a（`governance-escalate` 粒度）**不实施** ⇒ `lane.governance-degrade` / `batch.governanceDegrade` /',
  '  批次级阈值 `max(t+1,2t)` / `governanceEscalatedAt` 去重键**全部无写者**；本批不引入上述任何新面。',
  '  原断言文本逐字保留于测试体内（`test.todo` 不执行回调）。',
  '  const bid = mkRunning(\'r16\', [\'l1\']);',
  '  record(bid, 1); record(bid, 2); record(bid, 3);',
  '  const b = store.readBatch(SID, bid);',
  '  obs(null, \'phase\', b.phase);',
  '  obs(null, \'events[lane.governance-degrade]\', withType(bid, E_LANE_DEGRADE));',
  '  obs(null, \'governanceDegrade\', b.governanceDegrade);',
  '  assert.equal(b.phase, \'running\',',
  '    \'G-a/R-GA-1：单 lane 达 threshold(3) 只做 lane 级留痕，**不得**暂停整批（当前 paused = 实测误伤）；实测=\' + b.phase);',
  '  const degs = withType(bid, E_LANE_DEGRADE);',
  '  assert.equal(degs.length, 1, \'须恰 1 条 lane.governance-degrade——实测=\' + JSON.stringify(degs));',
  '  assert.equal(degs[0].lane, \'l1\', \'载荷须含 lane：\' + JSON.stringify(degs[0]));',
  '  assert.equal(degs[0].count, 3, \'载荷须含 count=3：\' + JSON.stringify(degs[0]));',
  '  assert.equal(degs[0].windowMs, , \'载荷须含 windowMs：\' + JSON.stringify(degs[0]));',
  '  assert.ok(Array.isArray(degs[0].receiptIds) && degs[0].receiptIds.length === 3, \'载荷须含 receiptIds（可回查）：\' + JSON.stringify(degs[0]));',
  '  assert.ok(b.governanceDegrade && b.governanceDegrade.l1, \'批次 JSON 须含 governanceDegrade[lane]：\' + JSON.stringify(b.governanceDegrade));',
  '  assert.equal(b.governanceDegrade.l1.count, 3, \'governanceDegrade[l1].count===3；实测=\' + JSON.stringify(b.governanceDegrade.l1));',
];

// 【已裁不实施（G-a governance-escalate 粒度，用户裁决维持现状）】批次 core-debt-parallel-20260915 · lane e2 标注（T-5）。
//   原因：G-a 不实施 ⇒ 批次级升级阈值 `max(t+1,2t)` 与 `batch.governance-escalate` 升级写端均不存在（无写者）。
//   复活前置条件：若将来实施 G-a ⇒ 先登记常量 `EVT_LANE_GOVERNANCE_DEGRADE`，再接线写端，再复活本用例。
test.todo('R-17 两 lane 各 ×3 ⇒ 合计 6 ≥ batchThreshold ⇒ 升级 paused（载荷含 count/windowMs/lane/receiptIds）');
ARCHIVED_CASES['R-17 两 lane 各 ×3 ⇒ 合计 6 ≥ batchThreshold ⇒ 升级 paused（载荷含 count/windowMs/lane/receiptIds）'] = [
  '用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；',
  '  本条因「G-a 撤销（用户裁决维持现状）」转 todo。',
  '  const bid = mkRunning(\'r17\', [\'l1\', \'l2\']);',
  '  record(bid, 1); record(bid, 2); record(bid, 3);                                              // l1 三条',
  '  const b = store.readBatch(SID, bid);',
  '  const esc = withType(bid, \'batch.governance-escalate\');',
  '  obs(null, \'phase\', b.phase);',
  '  obs(null, \'batch.governance-escalate\', esc);',
  '  assert.equal(b.phase, \'paused\', \'G-a/R-GA-3：不同 lane 累计达 batchThreshold=6 ⇒ 升级 paused；实测=\' + b.phase);',
  '  assert.equal(esc.length, 1, \'升级事件恰 1 条；实测=\' + JSON.stringify(esc));',
  '  for (const k of [\'count\', \'windowMs\', \'lane\', \'receiptIds\']) {',
  '    assert.ok(esc[0] && k in esc[0], \'升级载荷须含 \' + k + \'：\' + JSON.stringify(esc[0]));',
  '  assert.equal(esc[0].count, 6, \'升级载荷 count===6；实测=\' + JSON.stringify(esc[0]));',
];

// 【已裁不实施（G-a governance-escalate 粒度，用户裁决维持现状）】批次 core-debt-parallel-20260915 · lane e2 标注（T-6）。
//   原因：G-a 不实施 ⇒ `governanceEscalatedAt` 去重键与 paused 恢复面（R-GA-4）无写者，本用例的「不僵局」前提不成立。
//   复活前置条件：若将来实施 G-a ⇒ 先登记常量 `EVT_LANE_GOVERNANCE_DEGRADE`，再接线写端，再复活本用例。
test.todo('R-18 已 paused ⇒ batch_phase({phase:"running"}) 成功；同窗口不二次打回（G-3 恢复不僵局）');
ARCHIVED_CASES['R-18 已 paused ⇒ batch_phase({phase:"running"}) 成功；同窗口不二次打回（G-3 恢复不僵局）'] = [
  '用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；',
  '  本条因「G-a 撤销（用户裁决维持现状）」转 todo。',
  '  const bid = mkRunning(\'r18\', [\'l1\', \'l2\']);',
  '  const mid = store.readBatch(SID, bid).phase;',
  '  const resumed = store.setPhase(SID, bid, \'running\');',
  '  for (let i = 7; i <= 8; i += 1) record(bid, i, { lane: \'l1\' });',
  '  const after = store.readBatch(SID, bid);',
  '  obs(null, \'升级前 / 恢复后 phase\', [mid, after.phase]);',
  '  obs(null, \'升级事件总数\', withType(bid, \'batch.governance-escalate\').length);',
  '  assert.equal(mid, \'paused\', \'前置：须先发生一次升级（当前已通过）\');',
  '  assert.equal(resumed.phase, \'running\', \'R-GA-4：paused 必须有恢复出路（不引入僵局）\');',
  '  assert.equal(after.phase, \'running\', \'R-GA-4：同一窗口内恢复后不得被二次打回；实测=\' + after.phase);',
  '  assert.equal(withType(bid, \'batch.governance-escalate\').length, 1, \'升级事件不得重复（governanceEscalatedAt 去重键）\');',
];

// 【已裁不实施（G-a governance-escalate 粒度，用户裁决维持现状）】批次 core-debt-parallel-20260915 · lane e2 标注（T-7）。
//   原因：G-a 不实施 ⇒ `lane.governance-degrade` 无写者，事件洪水这一被检语义**无观测面**（当前恒 0 条 ≠ 幂等成立）。
//   复活前置条件：若将来实施 G-a ⇒ 先登记常量 `EVT_LANE_GOVERNANCE_DEGRADE`，再接线写端，再复活本用例。
test.todo('R-19 幂等：同窗口同 lane 重复违规 ⇒ lane.governance-degrade 不产生事件洪水');
ARCHIVED_CASES['R-19 幂等：同窗口同 lane 重复违规 ⇒ lane.governance-degrade 不产生事件洪水'] = [
  '用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；',
  '  本条因「G-a 撤销（用户裁决维持现状）」转 todo。',
  '  const bid = mkRunning(\'r19\', [\'l1\']);',
  '  for (let i = 1; i <= 3; i += 1) record(bid, i);',
  '  const n1 = withType(bid, E_LANE_DEGRADE).length;',
  '  record(bid, 1); // 同 receiptId 重复（lastReceiptId 去重键面）',
  '  const n2 = withType(bid, E_LANE_DEGRADE).length;',
  '  obs(null, \'重复前后 degrade 事件数\', [n1, n2]);',
  '  assert.equal(n1, 1, \'前置：首次达阈值须恰好 1 条；实测=\' + n1);',
  '  assert.equal(n2, 1, \'R-GA-5：同窗口同 lane 重复违规不得产生事件洪水；实测=\' + n2);',
  '═══════════════════════════════════════════════════════════════════════════',
  '组 G · #4 派发面 CAS 守卫（R-20 / R-21）',
  '═══════════════════════════════════════════════════════════════════════════',
];

test('R-20 lane 已 running 再次派发 ⇒ 抛 invalid member transition 且 batch.json 逐字不变【回归保护】', () => {
  const bid = mkSettled('r20');
  trySet(bid, 'e1', 'running');
  const h1 = sha256File(batchFileOf(bid));
  const n1 = evsOf(bid).length;
  const r = trySet(bid, 'e1', 'running');
  const h2 = sha256File(batchFileOf(bid));
  const n2 = evsOf(bid).length;
  obs(null, '批次文件哈希前后（短）', [h1.slice(0, 12), h2.slice(0, 12)]);
  obs(null, '事件条数前后', [n1, n2]);
  assert.ok(r instanceof Error, 'H-2：running→running 非法（schema running 无自环）须抛；实测=' + JSON.stringify(r));
  assert.ok(/invalid member transition/.test(r.message), '抛错须含 "invalid member transition"；实测=' + r.message);
  assert.equal(h2, h1, 'R-CAS-1：拒派必须**零写入**（batch.json 逐字不变）');
  assert.equal(n2, n1, 'R-CAS-1：拒派不得追加事件');
});

// 【2026-09-21 K3 去返工边】R-CAS-4 改判：原断言「review→running 返工既有语义不得被本批收紧」
//   已随返工边（`schema.MEMBER_TRANSITIONS.review` 去掉 `running`）**反转**——失败即终态，
//   返工 = gap-list + 新任务批次。⇒ 本用例从「三路径全通」改为「两通一拒」，**保留 (a)(b) 的回归保护**。
test('R-21 正向对照：pending→running / idle→running 成功；review→running 已去边须拒【回归保护】', () => {
  const bid = mkSettled('r21');
  const a = trySet(bid, 'e1', 'running');
  setLaneState(bid, 'e1', 'idle');
  const c = trySet(bid, 'e1', 'running');
  trySet(bid, 'e1', 'review');
  const d = trySet(bid, 'e1', 'running');
  obs(null, '(a) pending→running', a instanceof Error ? a.message : a.lanes.e1);
  obs(null, '(b) idle→running（恢复重派）', c instanceof Error ? c.message : c.lanes.e1);
  obs(null, '(c) review→running（返工）', d instanceof Error ? d.message : d.lanes.e1);
  assert.ok(!(a instanceof Error), 'R-CAS-2：pending→running 必须成功（不得无差别拒）：' + String(a && a.message));
  assert.ok(!(c instanceof Error), 'R-CAS-3：idle→running 恢复路径不得被堵（G-1）：' + String(c && c.message));
  assert.ok(d instanceof Error, 'R-CAS-4（改判 K3）：review→running 返工边已去除 ⇒ 必须被拒；实测=' + String(d && d.message));
  assert.ok(/invalid member transition/.test(d.message), 'R-CAS-4（改判 K3）：拒须为状态机拒（"invalid member transition"）；实测=' + String(d && d.message));
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 H · S13–S20 逐条可判定（R-22…R-28）
// ═══════════════════════════════════════════════════════════════════════════

test('R-22 audit 层产物含命令声明行（exit 7）⇒ 必须真执行并拒 GATE_EXIT_NONZERO（S16 扩张项）', () => {
  const bid = mkBase('r22', {}, { produce: ['audit/accept.md'] }, { laneState: 'pending' });
  const b = store.readBatch(SID, bid);
  b.lanes.p1 = 'merged'; b.lanes.e1 = 'merged'; b.lanes.a1 = 'review';
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  writeArt(bid, 'audit/accept.md', 'review\ngate: node -e "process.exit(7)"\n');
  const det = detectGate(artifactsDirOf(bid), [path.join(artifactsDirOf(bid), 'audit/accept.md')]);
  const r = trySet(bid, 'a1', 'merged');
  obs(null, 'detectGate（audit 层产物）', det);
  obs(null, 'setMember(a1, merged) 结果', r instanceof Error ? r.message : { lane: r.lanes && r.lanes.a1 });
  assert.equal(det.declared, true, '前置：命令声明行须被检出；实测=' + JSON.stringify(det));
  assert.ok(r instanceof Error, 'S16/R-S16：audit 层命令声明必须真执行并拦下（当前 declared:false 静默放行）；实测=' + JSON.stringify(r));
  assert.ok(r.message.includes('GATE_EXIT_NONZERO'), '拒码须为 GATE_EXIT_NONZERO；实测=' + r.message);
});

test('R-23 命令黑名单形态 ⇒ 不执行 ＋ 拒 GATE_EXIT_FORBIDDEN（K3 缓解 ①）【回归保护】', () => {
  const bid = mkPlanExec('r23');
  writeArt(bid, 'exec/e1.md', 'out\ngate: rm -rf /tmp/whatever\n');
  trySet(bid, 'e1', 'running'); trySet(bid, 'e1', 'review');
  const r = trySet(bid, 'e1', 'merged');
  obs(null, 'setMember(e1, merged) 结果', r instanceof Error ? r.message : { lane: r.lanes.e1 });
  assert.ok(r instanceof Error, '黑名单命令不得执行（只读守卫）');
  assert.ok(r.message.includes('GATE_EXIT_FORBIDDEN'), '拒码须为 GATE_EXIT_FORBIDDEN；实测=' + r.message);
});

test('R-24 needHuman 声明行只写在 audit 的 outputs 所指产物 ⇒ 必须拒 GATE_NEEDHUMAN_PENDING（S14）', () => {
  const bid = mkBase('r24', {}, { produce: ['audit/r24a.md'], outputs: ['audit/r24b.md'] });
  const b = store.readBatch(SID, bid);
  b.lanes.p1 = 'merged'; b.lanes.e1 = 'merged'; b.lanes.a1 = 'review';
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  writeArt(bid, 'audit/r24a.md', 'review without declaration');
  writeArt(bid, 'audit/r24b.md', 'review\nneedHuman: true\n');
  const r = gates.checkNeedHumanGate(SID, bid, store.readBatch(SID, bid), 'a1', null);
  obs(null, 'checkNeedHumanGate(声明只在 outputs)', r);
  assert.equal(r.declared, true,
    'S14/R-S14：扫描面须为 produce ∪ outputs（当前只扫 produce ⇒ declared:false 零感知）；实测=' + JSON.stringify(r));
  assert.equal(r.ok, false, 'S14：声明人工闸而缺 human: 证据 ⇒ 必须拒');
  assert.equal(r.code, 'GATE_NEEDHUMAN_PENDING', '拒码=' + r.code);
});

// 用户 2026-09-14 裁决（grilling Q11=A）：失效红条转 test.todo ＋ 逐字引注（模板同 Q1=C）。
// **实现已完成**（V-4 写端已在 `store.js` 落盘，probe 实证：`gate.degrade{kind:'produce-field-widened'}` /
//   `gate.escape{kind:'needhuman-off'|'env-gate-disabled'|'targets-off'}` 均真写入 `batch.events`）；
//   **仅测试调用层错位** —— 本用例**直调门禁函数**（`gates.checkExitGate` / `checkNeedHumanGate` /
//   `checkCommandGate` / `checkTargetsGate`）后读事件，而 `plan/spec.md` §5.3 规定写端只在 `store.js` 写路径，
//   且「只读视图（gate_status）绝不得发射事件」（B-4）。⇒ **正确形态 = 经 `setMember`/`runLane` 端到端驱动**
//   （同 R-01/R-02/R-27a 的已绿形态）。本条**不得**被读成「未实现」。
// 原用例体逐字保留于下方 `ARCHIVED_CASES`（活字符串数据、不执行），正确断言留待独立小批复活。
test('R-25【复活·T-8】团队 needhuman:false ⇒ disabledBy ＋ 写路径落 gate.escape{kind:"needhuman-off"}（端到端驱动）', () => {
  // 【复活要点·2026-09-15 批次 core-debt-parallel-20260915 / lane e2】原形态为何失效：归档体**直调**
  //   `gates.checkNeedHumanGate` 后读事件 ⇒ 只读面恒 0 条（写端唯一在 store.js）。本次改动：返回值 `disabledBy`
  //   断言保留（GREEN-as-is）＋ 增补「直调零事件」硬边界；事件面改由 `store.setMember`（a1 review→merged）端到端驱动
  //   （写端 store.js:599 的 merged 前置收集）。
  const tp = mkTeamRoot('r25-team', (a) => { a.flows.audit.needhuman = false; });
  const bid = mkBase('r25', {}, { produce: ['audit/a25.md'] }, { team: 'r25-team', teamsRoot: tp });
  const b = store.readBatch(SID, bid);
  b.lanes.p1 = 'merged'; b.lanes.e1 = 'merged'; b.lanes.a1 = 'review';
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  writeArt(bid, 'audit/a25.md', 'review\nneedHuman: true\n');
  const nh = gates.checkNeedHumanGate(SID, bid, store.readBatch(SID, bid), 'a1', null);
  obs(null, 'checkNeedHumanGate（团队 needhuman:false）', nh);
  assert.equal(nh.ok, true, 'S13：关闭档判定结果**不变**（仍放行）；实测=' + JSON.stringify(nh));
  assert.equal(nh.disabledBy, 'team-asset:needhuman', 'S13：须返回 disabledBy 标注（可区分「关闭」与「未声明」）；实测=' + JSON.stringify(nh));
  assert.equal(withType(bid, E_ESCAPE).length, 0,
    'B-4：直调门禁函数零事件（写端唯一在 store.js 写路径）；实测=' + JSON.stringify(withType(bid, E_ESCAPE)));
  const r = trySet(bid, 'a1', 'merged');
  obs(null, 'setMember(a1, merged)', r instanceof Error ? r.message : { lane: r.lanes.a1 });
  expectAccepted('S13：needhuman 关闭档 ⇒ merged 放行（关闭能力保留）', r);
  const esc = withType(bid, E_ESCAPE).filter((e) => e.kind === 'needhuman-off');
  assert.equal(esc.length, 1,
    'S13/R-S13：关闭能力保留但**必须留痕** escape{kind:"needhuman-off"}；实测=' + JSON.stringify(withType(bid, E_ESCAPE)));
});
ARCHIVED_CASES['R-25 团队 needhuman:false ⇒ checkNeedHumanGate 返 disabledBy ＋ 事件落 gate.escape{kind:"needhuman-off"}（S13）'] = [
  '【已复活 ⇒ 见用例「R-25【复活·T-8】…（端到端驱动）」（批次 core-debt-parallel-20260915 · lane e2）】',
  '  const tp = mkTeamRoot(\'r25-team\', (a) => { a.flows.audit.needhuman = false; });',
  '  const bid = mkBase(\'r25\', {}, { produce: [\'audit/a25.md\'] }, { team: \'r25-team\', teamsRoot: tp });',
  '  const b = store.readBatch(SID, bid);',
  '  b.lanes.p1 = \'merged\'; b.lanes.e1 = \'merged\'; b.lanes.a1 = \'review\';',
  '  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), \'utf8\');',
  '  writeArt(bid, \'audit/a25.md\', \'review\\nneedHuman: true\\n\');',
  '  const r = gates.checkNeedHumanGate(SID, bid, store.readBatch(SID, bid), \'a1\', null);',
  '  obs(null, \'checkNeedHumanGate（团队 needhuman:false）\', r);',
  '  assert.equal(r.ok, true, \'S13：关闭档判定结果**不变**（仍放行）；实测=\' + JSON.stringify(r));',
  '  assert.equal(r.disabledBy, \'team-asset:needhuman\', \'S13：须返回 disabledBy 标注（可区分「关闭」与「未声明」）；实测=\' + JSON.stringify(r));',
  '  const esc = withType(bid, E_ESCAPE).filter((e) => e.kind === \'needhuman-off\');',
  '  assert.equal(esc.length, 1,',
  '    \'S13/R-S13：关闭能力保留但**必须留痕** escape{kind:"needhuman-off"}（当前零事件）；实测=\' + JSON.stringify(withType(bid, E_ESCAPE)));',
];


// 用户 2026-09-14 裁决（grilling Q11=A）：失效红条转 test.todo ＋ 逐字引注（模板同 Q1=C）。
// **实现已完成**（V-4 写端已在 `store.js` 落盘，probe 实证：`gate.degrade{kind:'produce-field-widened'}` /
//   `gate.escape{kind:'needhuman-off'|'env-gate-disabled'|'targets-off'}` 均真写入 `batch.events`）；
//   **仅测试调用层错位** —— 本用例**直调门禁函数**（`gates.checkExitGate` / `checkNeedHumanGate` /
//   `checkCommandGate` / `checkTargetsGate`）后读事件，而 `plan/spec.md` §5.3 规定写端只在 `store.js` 写路径，
//   且「只读视图（gate_status）绝不得发射事件」（B-4）。⇒ **正确形态 = 经 `setMember`/`runLane` 端到端驱动**
//   （同 R-01/R-02/R-27a 的已绿形态）。本条**不得**被读成「未实现」。
// 原用例体逐字保留于下方 `ARCHIVED_CASES`（活字符串数据、不执行），正确断言留待独立小批复活。
test('R-26【复活·T-9】GATE_ENABLED=false ⇒ 命令门/目标门均放行 ＋ 两门各落一条 escape{kind:"env-gate-disabled"}（端到端驱动）', () => {
  // 【复活要点·2026-09-15 批次 core-debt-parallel-20260915 / lane e2】原形态为何失效：归档体**直调**两门后读事件
  //   ⇒ 只读面恒 0 条。本次改动：两门返回值 `ok` 断言保留（GREEN-as-is）＋ 增补「直调零事件」；事件面改由
  //   `store.setMember`（e1 running→review→merged）端到端驱动（写端 store.js:563 targets / :577 command）。
  const prev = process.env.GATE_ENABLED;
  process.env.GATE_ENABLED = 'false';
  try {
    const bid = mkPlanExec('r26', { targets: [path.join(ROOT, 'absent-target.txt')] });
    writeArt(bid, 'exec/e1.md', 'out\ngate: node -e "process.exit(7)"\n');
    const g = createGates(ROOT);
    const cg = g.checkCommandGate(SID, bid, store.readBatch(SID, bid), 'e1');
    const tg = g.checkTargetsGate(SID, bid, store.readBatch(SID, bid), 'e1');
    obs(null, 'checkCommandGate(GATE_ENABLED=false)', cg);
    obs(null, 'checkTargetsGate(GATE_ENABLED=false)', tg);
    assert.equal(cg.ok, true, 'S15：env 阀保留（应急必需）⇒ 命令门放行；实测=' + JSON.stringify(cg));
    assert.equal(tg.ok, true, 'S15：目标门放行；实测=' + JSON.stringify(tg));
    assert.equal(withType(bid, E_ESCAPE).length, 0,
      'B-4：直调门禁函数零事件；实测=' + JSON.stringify(withType(bid, E_ESCAPE)));
    trySet(bid, 'e1', 'running'); trySet(bid, 'e1', 'review');
    const r = trySet(bid, 'e1', 'merged');
    obs(null, 'setMember(e1, merged)（env 阀关闭）', r instanceof Error ? r.message : { lane: r.lanes.e1 });
    expectAccepted('S15：env 阀关闭 ⇒ 命令门/目标门均放行、merged 成立', r);
    const esc = withType(bid, E_ESCAPE).filter((e) => e.kind === 'env-gate-disabled');
    assert.equal(esc.length, 2,
      'S15/R-S15：两门命中须各落一条 escape{kind:"env-gate-disabled"}；实测=' + JSON.stringify(withType(bid, E_ESCAPE)));
  } finally {
    if (prev === undefined) delete process.env.GATE_ENABLED; else process.env.GATE_ENABLED = prev;
  }
});
ARCHIVED_CASES['R-26 GATE_ENABLED=false ⇒ 命令门/目标门均放行 ＋ 两门各落一条 gate.escape{kind:"env-gate-disabled"}（S15）'] = [
  '【已复活 ⇒ 见用例「R-26【复活·T-9】…（端到端驱动）」（批次 core-debt-parallel-20260915 · lane e2）】',
  '  const prev = process.env.GATE_ENABLED;',
  '  process.env.GATE_ENABLED = \'false\';',
  '  try {',
  '    const bid = mkPlanExec(\'r26\', { targets: [path.join(ROOT, \'absent-target.txt\')] });',
  '    writeArt(bid, \'exec/e1.md\', \'out\\ngate: node -e "process.exit(7)"\\n\');',
  '    const g = createGates(ROOT);',
  '    const cg = g.checkCommandGate(SID, bid, store.readBatch(SID, bid), \'e1\');',
  '    const tg = g.checkTargetsGate(SID, bid, store.readBatch(SID, bid), \'e1\');',
  '    obs(null, \'checkCommandGate(GATE_ENABLED=false)\', cg);',
  '    obs(null, \'checkTargetsGate(GATE_ENABLED=false)\', tg);',
  '    assert.equal(cg.ok, true, \'S15：env 阀保留（应急必需）⇒ 命令门放行；实测=\' + JSON.stringify(cg));',
  '    assert.equal(tg.ok, true, \'S15：目标门放行；实测=\' + JSON.stringify(tg));',
  '    const esc = withType(bid, E_ESCAPE).filter((e) => e.kind === \'env-gate-disabled\');',
  '    assert.equal(esc.length, 2,',
  '      \'S15/R-S15：两门命中须各落一条 escape{kind:"env-gate-disabled"}（当前零留痕）；实测=\' + JSON.stringify(withType(bid, E_ESCAPE)));',
  '  } finally {',
  '    if (prev === undefined) delete process.env.GATE_ENABLED; else process.env.GATE_ENABLED = prev;',
];


// 用户 2026-09-14 裁决（grilling Q11=A）：失效红条转 test.todo ＋ 逐字引注（模板同 Q1=C）。
// **实现已完成**（V-4 写端已在 `store.js` 落盘，probe 实证：`gate.degrade{kind:'produce-field-widened'}` /
//   `gate.escape{kind:'needhuman-off'|'env-gate-disabled'|'targets-off'}` 均真写入 `batch.events`）；
//   **仅测试调用层错位** —— 本用例**直调门禁函数**（`gates.checkExitGate` / `checkNeedHumanGate` /
//   `checkCommandGate` / `checkTargetsGate`）后读事件，而 `plan/spec.md` §5.3 规定写端只在 `store.js` 写路径，
//   且「只读视图（gate_status）绝不得发射事件」（B-4）。⇒ **正确形态 = 经 `setMember`/`runLane` 端到端驱动**
//   （同 R-01/R-02/R-27a 的已绿形态）。本条**不得**被读成「未实现」。
// 原用例体逐字保留于下方 `ARCHIVED_CASES`（活字符串数据、不执行），正确断言留待独立小批复活。
test('R-27【复活·T-10】(a) 显式禁用命令行 ⇒ 放行 ＋ escape{kind:"command-declared-off"}；(b) 空命令段 ⇒ 拒 GATE_EXIT_NO_COMMAND（F-7 落地，X-1 关账）', () => {
  // 【复活要点·2026-09-15 批次 core-debt-parallel-20260915 / lane e2】归档体已是 `trySet`（= `store.setMember`）
  //   端到端形态 ⇒ 断言逐字保留；**最小改造一处**：(b) 空命令子例原体缺 `running→review` 前置（pending→merged
  //   非法迁移 ⇒ 报 `invalid member transition` 而非 `GATE_EXIT_NO_COMMAND`），本次补上该前置，使被检面仍为命令门。
  const bidA = mkPlanExec('r27a', { consume: ['plan/spec.md'] });
  writeArt(bidA, 'exec/e1.md', 'out\ngate: false\n');
  trySet(bidA, 'e1', 'running'); trySet(bidA, 'e1', 'review');
  const rA = trySet(bidA, 'e1', 'merged');
  const escA = withType(bidA, E_ESCAPE).filter((e) => e.kind === 'command-declared-off');
  const bidB = mkPlanExec('r27b', { consume: ['plan/spec.md'] });
  writeArt(bidB, 'exec/e1.md', 'out\ngate:\n');
  trySet(bidB, 'e1', 'running'); trySet(bidB, 'e1', 'review');
  const rB = trySet(bidB, 'e1', 'merged');
  obs(null, '(a) 显式禁用行 ⇒ 放行 + 留痕', { result: rA instanceof Error ? rA.message : rA.lanes.e1, escape: escA });
  obs(null, '(b) 空命令 ⇒ 拒 GATE_EXIT_NO_COMMAND（F-7）', rB instanceof Error ? rB.message : rB.lanes.e1);
  expectAccepted('S17：显式禁用须放行', rA);
  assert.equal(escA.length, 1,
    'S17/R-S17：显式禁用必须留痕 escape{kind:"command-declared-off"}；实测=' + JSON.stringify(withType(bidA, E_ESCAPE)));
  // 【X-1 已关账 · F-7 批次 `f7-empty-gate-20260915`，用户裁决「严控勿松」】
  //   不可达根因（复活时实测）：`GATE_LINE_RE = /^gate:\s*(.+)$/gm` 的 `(.+)` 要求命令段**非空** ⇒ 空声明行
  //   零命中；`detectGate` 内 `cmd.length === 0 ⇒ continue` 二次剔除 ⇒ `declared ≡ commands.length > 0` 恒 false
  //   ⇒ `checkCommandGate` 的 `if (!det.declared)` 早退**先于** `GATE_EXIT_NO_COMMAND` 分支 ⇒ 该分支为**死码**，
  //   当时实测语义 = 「空 `gate:` 行 = 未声明 ⇒ 零感知放行」（归档期望「仍拒」因此被证伪）。
  //   修法：新增 `GATE_EMPTY_LINE_RE = /^gate:[ \t]*$/m` ＋ `detectGate` 新增 `emptyCommand` 位（声明面与
  //   `declared` 分离）＋ `checkCommandGate` 在早退**之前**首判短路为拒；`declared` 语义**一字未改**。
  //   归档期望（`ARCHIVED_CASES` 内 `rB instanceof Error && …GATE_EXIT_NO_COMMAND`）**已按原期望恢复为活断言**
  //   （即下述四条正向索取），故 X-1 关账、ARCHIVED_CASES 不再登记「处置待裁决」。
  assert.ok(rB instanceof Error && /GATE_EXIT_NO_COMMAND/.test(rB.message),
    'S17/F-7：空命令段必须拒 GATE_EXIT_NO_COMMAND（防一码遮百丑）；实测=' + String(rB && rB.message));
  assert.equal(store.readBatch(SID, bidB).lanes.e1, 'review', 'F-7：空命令拒 merged，lane 留 review（失败 lane 非终态）');
  const blkB = withType(bidB, 'gate.exit_blocked');
  assert.equal(blkB.length, 1, 'F-7：空命令须落**恰 1 条** gate.exit_blocked；实测=' + JSON.stringify(blkB));
  assert.equal(blkB[0].code, 'GATE_EXIT_NO_COMMAND', 'F-7：拒码须为 GATE_EXIT_NO_COMMAND；实测=' + JSON.stringify(blkB[0]));
});
ARCHIVED_CASES['R-27 显式禁用命令行 ⇒ 放行 ＋ escape{kind:"command-declared-off"}；空命令 ⇒ 仍拒 GATE_EXIT_NO_COMMAND（S17）'] = [
  '【已复活 ⇒ 见用例「R-27【复活·T-10】…（端到端）」；复活时补 (b) 子例的 running→review 前置（批次 core-debt-parallel-20260915 · lane e2）】',
  '【X-1 已关账（F-7 批次 `f7-empty-gate-20260915`，用户裁决「严控勿松」）：不可达根因 = `GATE_LINE_RE` 的 `(.+)` 不进空声明 ＋ `detectGate` 内 `cmd.length===0 ⇒ continue` ⇒ `declared=false` 早退遮蔽死码分支；修法 = 新增 `GATE_EMPTY_LINE_RE` ＋ `detectGate.emptyCommand` 位 ＋ `checkCommandGate` 首判短路；本归档期望已按原期望恢复为活断言（见用例「R-27【复活·T-10】…」内 (b) 四条正向断言）】',
  '  const bidA = mkPlanExec(\'r27a\', { consume: [\'plan/spec.md\'] });',
  '  writeArt(bidA, \'exec/e1.md\', \'out\\ngate: false\\n\');',
  '  trySet(bidA, \'e1\', \'running\'); trySet(bidA, \'e1\', \'review\');',
  '  const rA = trySet(bidA, \'e1\', \'merged\');',
  '  const escA = withType(bidA, E_ESCAPE).filter((e) => e.kind === \'command-declared-off\');',
  '  const bidB = mkPlanExec(\'r27b\', { consume: [\'plan/spec.md\'] });',
  '  writeArt(bidB, \'exec/e1.md\', \'out\\ngate:\\n\');',
  '  const rB = trySet(bidB, \'e1\', \'merged\');',
  '  obs(null, \'(a) 显式禁用行 ⇒ 放行 + 留痕\', { result: rA instanceof Error ? rA.message : rA.lanes.e1, escape: escA });',
  '  obs(null, \'(b) 空命令 ⇒ 仍拒\', rB instanceof Error ? rB.message : rB.lanes.e1);',
  '  expectAccepted(\'S17：显式禁用须放行\', rA);',
  '  assert.equal(escA.length, 1,',
  '    \'S17/R-S17：显式禁用必须留痕 escape{kind:"command-declared-off"}（当前无留痕）；实测=\' + JSON.stringify(withType(bidA, E_ESCAPE)));',
  '  assert.ok(rB instanceof Error && rB.message.includes(\'GATE_EXIT_NO_COMMAND\'),',
  '    \'S17：空命令维持拒（防一码遮百丑）；实测=\' + String(rB && rB.message));',
];


// 用户 2026-09-14 裁决（grilling Q11=A）：失效红条转 test.todo ＋ 逐字引注（模板同 Q1=C）。
// **实现已完成**（V-4 写端已在 `store.js` 落盘，probe 实证：`gate.degrade{kind:'produce-field-widened'}` /
//   `gate.escape{kind:'needhuman-off'|'env-gate-disabled'|'targets-off'}` 均真写入 `batch.events`）；
//   **仅测试调用层错位** —— 本用例**直调门禁函数**（`gates.checkExitGate` / `checkNeedHumanGate` /
//   `checkCommandGate` / `checkTargetsGate`）后读事件，而 `plan/spec.md` §5.3 规定写端只在 `store.js` 写路径，
//   且「只读视图（gate_status）绝不得发射事件」（B-4）。⇒ **正确形态 = 经 `setMember`/`runLane` 端到端驱动**
//   （同 R-01/R-02/R-27a 的已绿形态）。本条**不得**被读成「未实现」。
// 原用例体逐字保留于下方 `ARCHIVED_CASES`（活字符串数据、不执行），正确断言留待独立小批复活。
test('R-28【复活·T-11】团队 targets:false ⇒ disabledBy ＋ 写路径落 escape{kind:"targets-off"}（端到端驱动）', () => {
  // 【复活要点·2026-09-15 批次 core-debt-parallel-20260915 / lane e2】原形态为何失效：归档体**直调**
  //   `gates.checkTargetsGate` 后读事件 ⇒ 只读面恒 0 条。本次改动：返回值 `ok`/`disabledBy` 断言保留
  //   （GREEN-as-is）＋ 增补「直调零事件」；事件面改由 `store.setMember`（e1 running→review→merged）端到端驱动
  //   （写端 store.js:563）。
  const tp = mkTeamRoot('r28-team', (a) => { a.flows.exec.targets = false; });
  const bid = mkBase('r28', { targets: [path.join(ROOT, 'absent-r28.txt')] }, {}, { team: 'r28-team', teamsRoot: tp });
  writeArt(bid, 'exec/e1.md', 'out');
  const tg = gates.checkTargetsGate(SID, bid, store.readBatch(SID, bid), 'e1');
  obs(null, 'checkTargetsGate（团队 targets:false）', tg);
  assert.equal(tg.ok, true, 'S18：判定结果不变（仍放行，不得因留痕而改判）；实测=' + JSON.stringify(tg));
  assert.equal(tg.disabledBy, 'team-asset:targets', 'S18：团队级关闭须给 disabledBy（可区分「关闭」与「未声明」）；实测=' + JSON.stringify(tg));
  assert.equal(withType(bid, E_ESCAPE).length, 0,
    'B-4：直调门禁函数零事件；实测=' + JSON.stringify(withType(bid, E_ESCAPE)));
  trySet(bid, 'e1', 'running'); trySet(bid, 'e1', 'review');
  const r = trySet(bid, 'e1', 'merged');
  obs(null, 'setMember(e1, merged)', r instanceof Error ? r.message : { lane: r.lanes.e1 });
  expectAccepted('S18：团队 targets:false ⇒ merged 放行（判定不变）', r);
  const esc = withType(bid, E_ESCAPE).filter((e) => e.kind === 'targets-off');
  assert.equal(esc.length, 1,
    'S18/R-S18：团队 targets:false 须补留痕 escape{kind:"targets-off"}；实测=' + JSON.stringify(withType(bid, E_ESCAPE)));
});
ARCHIVED_CASES['R-28 团队 targets:false ⇒ checkTargetsGate 返 disabledBy ＋ 目标面留痕（S18）'] = [
  '【已复活 ⇒ 见用例「R-28【复活·T-11】…（端到端驱动）」（批次 core-debt-parallel-20260915 · lane e2）】',
  '  const tp = mkTeamRoot(\'r28-team\', (a) => { a.flows.exec.targets = false; });',
  '  const bid = mkBase(\'r28\', { targets: [path.join(ROOT, \'absent-r28.txt\')] }, {}, { team: \'r28-team\', teamsRoot: tp });',
  '  const tg = gates.checkTargetsGate(SID, bid, store.readBatch(SID, bid), \'e1\');',
  '  obs(null, \'checkTargetsGate（团队 targets:false）\', tg);',
  '  assert.equal(tg.ok, true, \'S18：判定结果不变（仍放行，不得因留痕而改判）；实测=\' + JSON.stringify(tg));',
  '  assert.equal(tg.disabledBy, \'team-asset:targets\', \'S18：团队级关闭须给 disabledBy（可区分「关闭」与「未声明」）；实测=\' + JSON.stringify(tg));',
  '  const esc = withType(bid, E_ESCAPE).filter((e) => e.kind === \'targets-off\');',
  '  assert.equal(esc.length, 1,',
  '    \'S18/R-S18：团队 targets:false 须补留痕 escape{kind:"targets-off"}（当前零事件）；实测=\' + JSON.stringify(withType(bid, E_ESCAPE)));',
];


// 复活记录（批次 core-pending-a-20260915 · lane e2 · Leader 裁决：走 **P-1** 合规最小可判别形态）：
//   ① 原构造为何**不可达**（本 lane 逐条复核）：`flows.exec.consume_field='inputs'` 会被资产校验白名单拒 ——
//      `CONSUME_FIELDS` 是**双源真源**（`lib/assembly/flows.js:255` ＋ `lib/assembly/team-asset.js:51`，值均为 `['consume']`）
//      ⇒ 命中 `TEAM_ASSET_CONSUME_FIELD_NOT_ALLOWED`（`team-asset.js:281-283`）⇒ `resolveTeamFlows().ok=false`
//      ⇒ `flows=null` ⇒ `consumeFieldOf` 只能回落 `'consume'`（`flows.js:263-267`）⇒ 门禁按 `consume` 检
//      （该 lane 无 `consume`）⇒ 原用例第 2/3 条断言在合规资产下**恒不成立**（不是「未实现」，是「构造非法」）。
//   ② 未采纳的 P-2（把 `'inputs'` 纳入白名单）＝ 放宽「声明面只能收紧」的引擎级语义，属产品决策（须用户裁决）⇒ 本批**不扩白名单**。
//   ③ ⇒ 被检语义改述为**最小可判别形态**：合规声明值（`'consume'`）下，仍可机器判定「声明值 ⇒ 检面字段名
//      ＋ `GATE_ENTRY_MISSING` 的 `missing` 来自该字段」；并补一条本批修复的判据「`consume_field` 已接线 ⇒
//      不得再以未接线语义出现在 `gateStrength.unwired`」（该条在台账修复前 RED、修复后 GREEN）。
//   ④ 原断言文本逐字保留于下方 `ARCHIVED_CASES`（活字符串数据、不执行）供追溯（P-1 要求）。
test('R-15【P-1 复活】团队 consume_field:"consume"（合规声明）+ lane consume 缺件 ⇒ entry 门按声明字段名检，且该键已不在未接线台账', () => {
  const tp = mkTeamRoot('r15-team', (a) => { a.flows.exec.consume_field = 'consume'; });
  const bid = mkBase('r15', {}, {}, { team: 'r15-team', teamsRoot: tp });
  declareLaneField(bid, 'e1', { consume: ['exec/absent.md'] });
  const gs = gates.gateStatus(SID, bid).gateStrength;
  const r = gates.checkEntryGate(SID, bid, store.readBatch(SID, bid), 'e1');
  obs(null, 'gateStrength.consumeField（资产显式声明 consume_field="consume"）', gs.consumeField);
  obs(null, 'checkEntryGate(consume_field="consume", consume 缺件)', r);
  obs(null, 'gateStrength.unwired（该键已接线 ⇒ 不得在列）', gs.unwired);
  assert.equal(gs.consumeField && gs.consumeField.exec, 'consume',
    'S19① 判据同源：被检字段名 = 该层 `consume_field` 声明值（白名单内）；实测=' + JSON.stringify(gs.consumeField));
  assert.equal(r.ok, false, 'consume 缺件须拒（不得因声明面写同一值而成免检面）；实测=' + JSON.stringify(r));
  assert.equal(r.code, 'GATE_ENTRY_MISSING', '拒码=' + r.code);
  assert.ok(Array.isArray(r.missing) && r.missing.includes('exec/absent.md'),
    'R-S19a：缺件清单须来自**声明字段**（`consume`）的实际取值；实测=' + JSON.stringify(r.missing));
  const unwiredNames = (Array.isArray(gs.unwired) ? gs.unwired : []).map((x) => (typeof x === 'string' ? x : x && x.name));
  assert.ok(!unwiredNames.includes('consume_field'),
    'A-②（本批修复判据）：`consume_field` 已于 S19① 接线（`gates.ts` `consumeFieldNameOf` ⇒ `flows.js` `consumeFieldOf`，'
    + '消费点 :384/:483/:966）⇒ 不得再以「未接线」语义出现在 unwired；实测=' + JSON.stringify(gs.unwired));
  // 两态同源核对（spec §A-② 设计 L127）：同一 lane 在「资产显式声明 consume_field」与「无该声明（缺省回落）」两态下，
  //   检面字段名与 `missing[]` 须同值 —— 证明读端走的是**同一单点**（`consumeFieldNameOf`），而非两条逻辑。
  //   ⚠ 诚实标注：因白名单只允许 `'consume'`，本核对**不是区分性构造**（两态必然同值）；真正的区分性构造
  //   （声明 `'inputs'` ⇒ 检面按 `inputs`）在合规资产下不可达，原因见上方 ①。
  const tp2 = mkTeamRoot('r15-nodecl', (a) => { delete a.flows.exec.consume_field; delete a.flows.audit.consume_field; });
  const bid2 = mkBase('r15-nodecl', {}, {}, { team: 'r15-nodecl', teamsRoot: tp2 });
  declareLaneField(bid2, 'e1', { consume: ['exec/absent.md'] });
  const gs2 = gates.gateStatus(SID, bid2).gateStrength;
  const r2 = gates.checkEntryGate(SID, bid2, store.readBatch(SID, bid2), 'e1');
  obs(null, '无声明（缺省回落）态：consumeField / missing', { consumeField: gs2.consumeField, missing: r2.missing });
  assert.equal((gs2.consumeField || {}).exec, (gs.consumeField || {}).exec,
    '两态检面字段名须同值（同一单点）；实测=' + JSON.stringify([gs.consumeField, gs2.consumeField]));
  assert.deepEqual(r2.missing, r.missing,
    '两态 missing[] 须同值（同一单点）；实测=' + JSON.stringify([r.missing, r2.missing]));
});

// 原用例体逐字保留（`test.todo` 形态已由上方真实用例取代；本对象仅作活字符串数据存证）。
ARCHIVED_CASES['R-15 团队 consume_field:"inputs" + lane 写 inputs ⇒ 门禁按 inputs 检（S19① 判据同源）'] = [
  '用户 2026-09-14 裁决（grilling Q1=C）：失效红条不落成新契约，正确断言留待独立小批；',
  '  本条因「构造非法 ⇒ 不可达」转 todo。',
  '说明（Leader 裁决 2，以 `plan/spec.md` **F-3** 为准，该文与 I-7 冲突）：`flows.exec.consume_field=\'inputs\'`',
  '  会被资产校验拒（`TEAM_ASSET_CONSUME_FIELD_NOT_ALLOWED`）⇒ `resolveTeamFlows().ok=false`、`flows=null`',
  '  ⇒ `consumeFieldOf` 只能回落 `\'consume\'` ⇒ 本用例的构造**在合规资产下不可达**（逃逸阀不成立），',
  '  断言文本逐字保留于测试体内（`test.todo` 不执行回调），正确断言留待独立小批。',
  '  const bid = mkBase(\'r15\', { inputs: [\'exec/absent-input.md\'] }, {}, { team: \'r15-team\', teamsRoot: tp });',
  '  declareLaneField(bid, \'e1\', { inputs: [\'exec/absent-input.md\'] });',
  '  const gs = gates.gateStatus(SID, bid).gateStrength;',
  '  const r = gates.checkEntryGate(SID, bid, store.readBatch(SID, bid), \'e1\');',
  '  obs(null, \'gateStrength.consumeField\', gs.consumeField);',
  '  obs(null, \'checkEntryGate(consume_field=inputs, consume 缺件)\', r);',
  '  assert.equal(r.ok, false,',
  '    \'S19①：声明字段名后门禁须**按 inputs 检**（当前恒读 t.consume ⇒ 零检放行）；实测=\' + JSON.stringify(r));',
  '  assert.equal(r.code, \'GATE_ENTRY_MISSING\', \'拒码=\' + r.code);',
  '  assert.ok(Array.isArray(r.missing) && r.missing.includes(\'exec/absent-input.md\'),',
  '    \'R-S19a：缺件清单须来自 inputs 字段；实测=\' + JSON.stringify(r.missing));',
  '  assert.equal(gs.consumeField && gs.consumeField.exec, \'inputs\',',
  '    \'G-4/S19① 判据同源：gateStrength.consumeField 与 entry 检面须同字段；实测=\' + JSON.stringify(gs.consumeField));',
];

test('R-15b 越界声明 consume_field:"outputs"（白名单外）⇒ 回落 consume 且问题可读', () => {
  const tp = mkTeamRoot('r15b-team', (a) => { a.flows.exec.consume_field = 'outputs'; });
  const bid = mkBase('r15b', {}, {}, { team: 'r15b-team', teamsRoot: tp });
  declareLaneField(bid, 'e1', { consume: [] });
  const gs = gates.gateStatus(SID, bid).gateStrength;
  const r = gates.checkEntryGate(SID, bid, store.readBatch(SID, bid), 'e1');
  obs(null, 'gateStrength.consumeField（越界声明）', gs.consumeField);
  obs(null, 'checkEntryGate（越界声明 + 空 consume）', r);
  assert.equal(gs.consumeField && gs.consumeField.exec, 'consume',
    'R-S19b：白名单外的 consume_field 必须回落 consume；实测=' + JSON.stringify(gs.consumeField));
  assert.equal(r.ok, false, '回落 consume 后空 consume 仍须拒；实测=' + JSON.stringify(r));
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 I · 结算面与保全（R-30 / R-31 / R-34 / R-35 / R-36 / Q3-A）
// ═══════════════════════════════════════════════════════════════════════════

test('R-30 review→failed 结算仍放行（D12 固化已知行为，**不得**判为回归）', () => {
  const bid = mkSettled('r30');
  trySet(bid, 'e1', 'running'); trySet(bid, 'e1', 'review');
  const r = trySet(bid, 'e1', 'failed', '外部依赖不可用');
  obs(null, 'review→failed（带非空 note）结果', r instanceof Error ? r.message : r.lanes.e1);
  expectAccepted('D12：review→failed 既有放行语义（本批不改）', r);
  assert.equal(store.readBatch(SID, bid).lanes.e1, 'failed', '结算终态须落盘');
});

test('R-31 targets 绝对路径 + 根外 ⇒ 不受 artifactExists 约束（K6 边界断言）', () => {
  const bid = mkPlanExec('r31', { consume: ['plan/spec.md'] });
  const outside = path.join(ROOT, 'outside-k6.txt');
  fs.writeFileSync(outside, 'x', 'utf8');
  const b = store.readBatch(SID, bid);
  b.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'e1').targets = [outside];
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  const tg = gates.checkTargetsGate(SID, bid, store.readBatch(SID, bid), 'e1');
  obs(null, 'checkTargetsGate(根外绝对路径 target)', tg);
  assert.equal(tg.declared, true, 'targets 声明须被承认：' + JSON.stringify(tg));
  assert.notEqual(tg.code, 'GATE_ARTIFACT_OUTSIDE_ROOT',
    'K6/R-31：targets 是「批次产物根外」的合法目标面 ⇒ 不得套用产物归属门；实测=' + JSON.stringify(tg));
});

test('R-34 字段空/未声明全排列扫描 ⇒ 不得新增免检面（J-5 回归保护）', () => {
  const fields = ['consume', 'outputs', 'produce'];
  const empty = [undefined, [], null];
  const rows = [];
  for (const f of fields) {
    for (const e of empty) {
      const suffix = e === undefined ? 'undef' : (e === null ? 'null' : 'empty');
      const bid = mkPlanExec('r34-' + f + '-' + suffix);
      declareLaneField(bid, 'e1', { [f]: e });
      const b = store.readBatch(SID, bid);
      const g = gates.checkEntryGate(SID, bid, b, 'e1');
      const x = gates.checkExitGate(SID, bid, b, 'e1');
      rows.push({ field: f, value: suffix, entryOk: g.ok === true, exitOk: x.ok === true });
    }
  }
  const okCount = rows.filter((r) => r.entryOk && r.exitOk).length;
  obs(null, '全排列扫描结果（9 组合）', rows);
  assert.equal(rows.length, 9, '扫描面须覆盖 3 字段 × 3 空值 = 9 组合');
  assert.equal(okCount, 0,
    'J-5/R-34：不得出现「字段空 / 未声明 ⇒ 两门皆 ok:true」的免检面；命中=' + JSON.stringify(rows.filter((r) => r.entryOk && r.exitOk)));
});

test('R-35 包根探针残留 `.e2-manager-binding-probe.mjs` 不存在（K-1 只读核对）', () => {
  const p = path.join(PKG_ROOT, '.e2-manager-binding-probe.mjs');
  const exists = fs.existsSync(p);
  obs(null, '探针残留存在性', { path: p, exists });
  assert.equal(exists, false, 'K-1/R-PR-1：包根探针残留必须已清（Leader 已删；本 lane 只读核对，不创建/不写该路径）');
});

test('R-36 MEMBER_STATES 逐字不变（8 态；J-4 不引入成员生命周期态）', () => {
  obs(null, 'MEMBER_STATES', MEMBER_STATES);
  assert.deepEqual(MEMBER_STATES, ['pending', 'running', 'review', 'merged', 'failed', 'skipped', 'conflict', 'idle'],
    'J-4/R-36：不得引入新成员态（用户定位裁定 O-3：永不纳入）');
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 J · Leader 附则 Q3-A（结算面 note 义务 ＋ Complete 门非阻断降级）
// ═══════════════════════════════════════════════════════════════════════════

test('R-Q3A-1 review → failed|skipped|conflict 缺非空 note ⇒ 拒 GATE_SETTLE_NOTE_MISSING；merged 不得加同一要求', () => {
  const rFail = (() => { const b = mkSettled('q3a-fail'); trySet(b, 'e1', 'running'); trySet(b, 'e1', 'review'); return trySet(b, 'e1', 'failed', null); })();
  const rSkip = (() => { const b = mkSettled('q3a-skip'); trySet(b, 'e1', 'running'); trySet(b, 'e1', 'review'); return trySet(b, 'e1', 'skipped', ''); })();
  const rConf = (() => { const b = mkSettled('q3a-conf'); trySet(b, 'e1', 'running'); trySet(b, 'e1', 'review'); return trySet(b, 'e1', 'conflict', '   '); })();
  const rOk = (() => { const b = mkSettled('q3a-ok'); trySet(b, 'e1', 'running'); trySet(b, 'e1', 'review'); return trySet(b, 'e1', 'failed', '外部依赖不可用，已复现三次'); })();
  const rMerged = (() => { const b = mkSettled('q3a-merged'); trySet(b, 'e1', 'running'); trySet(b, 'e1', 'review'); return trySet(b, 'e1', 'merged'); })();
  obs(null, '(a) review→failed 无 note', rFail instanceof Error ? rFail.message : { lane: rFail.lanes.e1 });
  obs(null, '(b) review→skipped 空 note', rSkip instanceof Error ? rSkip.message : { lane: rSkip.lanes.e1 });
  obs(null, '(c) review→conflict 空白 note', rConf instanceof Error ? rConf.message : { lane: rConf.lanes.e1 });
  obs(null, '(d) review→failed 带非空 note（正例对照）', rOk instanceof Error ? rOk.message : rOk.lanes.e1);
  obs(null, '(e) review→merged（不得被加 note 义务）', rMerged instanceof Error ? rMerged.message : rMerged.lanes.e1);
  for (const [label, r] of [['failed', rFail], ['skipped', rSkip], ['conflict', rConf]]) {
    assert.ok(r instanceof Error, `Q3A-①：review→${label} 缺非空 note 必须被拒（当前静默放行）；实测=` + JSON.stringify(r));
    assert.ok(r.message.includes('GATE_SETTLE_NOTE_MISSING'),
      `Q3A-①：拒码须为 GATE_SETTLE_NOTE_MISSING（${label}）；实测=` + r.message);
  }
  assert.ok(!(rOk instanceof Error), 'Q3A-①：非空 note 须放行（不得无差别拒）：' + String(rOk && rOk.message));
  expectAccepted('Q3A-①：merged 不得被加同一要求', rMerged);
});

test('R-Q3A-2 exec 层存在 failed 终态且曾声明非空 outputs ⇒ Complete 门仍 ok，载荷带 degrades[{kind:"exec-terminal-without-presence"}]（非阻断）', () => {
  const bid = mkSettled('q3a2');
  trySet(bid, 'e1', 'running'); trySet(bid, 'e1', 'review'); trySet(bid, 'e1', 'failed', '外部依赖不可用');
  // p1 / a1 由夹具直置为 merged（状态转换的合法性已在 R-21/R-30 单独覆盖）
  const b = store.readBatch(SID, bid);
  b.lanes.p1 = 'merged'; b.lanes.a1 = 'merged';
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  const g = gates.checkCompleteGate(store.readBatch(SID, bid));
  obs(null, 'lanes 终态', store.readBatch(SID, bid).lanes);
  obs(null, 'checkCompleteGate(exec failed 终态 + 曾声明 outputs)', g);
  assert.equal(g.ok, true, 'Q3A-②：失败 lane 已终态 ⇒ Complete 门**仍 ok**（非阻断，不得变拒码）；实测=' + JSON.stringify(g));
  const kinds = Array.isArray(g.degrades) ? g.degrades.map((d) => d.kind) : [];
  obs(null, 'Complete 载荷 degrades kinds', kinds);
  assert.ok(kinds.includes('exec-terminal-without-presence'),
    'Q3A-②：载荷须带 degrades[{kind:"exec-terminal-without-presence"}]（可辨认的降级留痕，非阻断）；实测=' + JSON.stringify(g.degrades));
});
