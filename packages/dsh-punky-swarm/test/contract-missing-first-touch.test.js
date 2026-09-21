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

// B2（蓝图 §8⑤ 运行期首触校验）· 批 `core-debt-parallel-20260915` · lane e1 **自建**用例
// （e1 写域只有本文件；`test/gate-techdebt-red.test.js` / `test/gate-flows.test.js` / `test/gates.test.js`
//   的唯一写者是 e2，本文件不改那三份）。
//
// 交付面：团队资产**未声明**某检查项 ⇒ 引擎缺省接管时**首次触发**落 `gate.contract_missing` + 一次告警。
// 硬口径（规格 §1.1 R-1..R-6，逐条对应用例）：
//   R-1 读法 A（未声明 ⇒ 引擎缺省接管，首触留痕）      → 用例「六判定位首触」
//   R-2 非拒态（不新增码 / 不改判定 / 不改 exit code）  → 用例「非拒态」
//   R-3 去重键 (batchId, gateKind, layer)、只报一次/批  → 用例「六判定位首触」
//   R-4 跨重启幂等（判据 = `batch.events`）             → 用例「跨重启幂等」
//   R-5 只由写路径发射（只读视图零事件）                → 用例「R-5 只读零发射」
//   R-6 不做读法 B 的迁移面子面                         → 本文件无任何迁移判定断言（负向：事件不含迁移面）
//
// cwd 无关：一切路径以**本文件位置**解析（本 lane 的 `gate:` 行由引擎在**产物根**执行，非仓库根）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createGates } from '../lib/state/gates.js';
import { createStore } from '../lib/state/store.js';
import * as STORE from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { clearFlowCache, resolveTeamFlows } from '../lib/assembly/flows.js';
import { SPEC_OK, assessC } from './helpers/gate-fixture.mjs';
import { seedHostSkills } from './helpers/host-skills.mjs';
import * as EVT from '../lib/state/event-types.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // cwd 无关
const SID = 's-b2-e1';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b2-contract-missing-'));
const store = createStore(ROOT);
const gates = createGates(ROOT);

// 常量未落地时以字面量兜底 ⇒ 「常量缺位」与「行为缺位」两半分别可判（不互相吞掉）
const E_CONTRACT_MISSING = EVT.EVT_GATE_CONTRACT_MISSING ?? 'gate.contract_missing';
const GATE_KINDS = ['entry_requires', 'contract', 'needhuman', 'gate_command', 'targets', 'complete'];
// 无资产团队名（拼错/不存在与「资产未声明」同走 tighten-only 缺省侧：flows=null）。
//   ⚠ P1 起该形态**只在直调 `store.createBatch` 面可用**（工具面「无资产 ⇒ 构造期拒」）——本文件的
//   直调用例继续用它；**工具面探针**（用例 8）改用临时团队资产，见 `mkMinTeamRoot`。
const NO_ASSET_TEAM = 'no-asset-team-b2';

// 【P1 同步】工具面探针的证人更换：P1 起「无资产团队」不可建批（构造期拒）⇒ 改为**临时团队资产**，
//   且刻意**不声明 `flows.exec.entry_requires`** —— 对读端而言「键未声明」与「flows=null」逐字等价，
//   故被检面（首触留痕 `entry_requires@exec`）不变。
const MIN_TEAM = 'b2-min-team';
const MIN_SKILL = 'B2-MIN-SKILL';
seedHostSkills([MIN_SKILL], undefined, { stub: true }); // 技能根须可解析（P1 §3），显式注入隔离 HOME
function mkMinTeamRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b2-minteams-'));
  const asset = {
    team: MIN_TEAM,
    layers: {
      plan: { roles: ['designer'], skills: { designer: [MIN_SKILL] } },
      exec: { roles: ['coder'], skills: { coder: [MIN_SKILL] } },
      audit: { roles: ['supervisor'], skills: { supervisor: [MIN_SKILL] } },
    },
    flows: {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs' }, // 刻意不声明 entry_requires（被检面）
      audit: { produce_field: 'produce', audit_contract: { criteria_from: 'plan/**', verdict: ['pass', 'fail', 'skip'] } },
    },
  };
  fs.mkdirSync(path.join(root, 'presets', MIN_TEAM), { recursive: true });
  fs.writeFileSync(path.join(root, 'presets', MIN_TEAM, 'team-asset.json'), JSON.stringify(asset), 'utf8');
  return root;
}

// ── 基础工具（自建根纪律：一切落点在 os.tmpdir() 下的本次夹具根内）──
function batchFileOf(bid) { return path.join(ROOT, 'sessions', SID, 'batches', bid + '.json'); }
function artifactsDirOf(bid) { return path.join(ROOT, 'sessions', SID, 'artifacts', bid); }
function writeArt(bid, rel, content) {
  const abs = path.join(artifactsDirOf(bid), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}
function mkBatch(bid, tasks, { team = NO_ASSET_TEAM } = {}) {
  const plan = buildWavePlan({ batchId: bid, tasks, team });
  store.createBatch(SID, { batchId: bid, wavePlan: plan, concurrency: plan.concurrency });
  const b = store.readBatch(SID, bid);
  Object.assign(b.lanes, Object.fromEntries(tasks.map((t) => [t.id, 'pending'])));
  b.team = team;
  b.phase = 'running';
  fs.writeFileSync(batchFileOf(bid), JSON.stringify(b, null, 2), 'utf8');
  return bid;
}
function evsOf(bid) { return store.readBatch(SID, bid).events ?? []; }
function cmEvents(bid) { return evsOf(bid).filter((e) => e && e.type === E_CONTRACT_MISSING); }
function cmKey(e) { return String(e.gateKind ?? '') + '@' + String(e.layer ?? '-'); }
// 失败也不吞：settle 抛错即用例失败（拒态不在本批语义内）
function settle(bid, lane, to, note = null) { return store.setMember(SID, bid, lane, to, note); }

// 三层合规批（plan 产物被 exec 与 audit 双重 consume ⇒ 无 A1 悬空；exec 声明 targets 以触达 P-5）
function fullTasks(targetAbs) {
  return [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
    {
      id: 'e1', layer: 'exec', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run',
      targets: [targetAbs], targetsMarker: 'claimed',
    },
    { id: 'a1', layer: 'audit', deps: ['e1'], consume: ['plan/spec.md'], produce: ['audit/a1.md'], cmd: 'review' },
  ];
}
function mkFullBatch(bid) {
  const targetAbs = path.join(ROOT, 'targets', bid + '-target.txt');
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, 'targets-claimed: true\n', 'utf8');
  mkBatch(bid, fullTasks(targetAbs));
  writeArt(bid, 'plan/spec.md', SPEC_OK);
  writeArt(bid, 'exec/e1.md', 'out'); // 不含 `gate:` 行 ⇒ 命令门走「产物未声明」放行侧（不执行任何命令）
  writeArt(bid, 'audit/a1.md', 'review');
  return bid;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 1：常量单点登记 + 调用点无裸字面量（B2-A1）
// ═══════════════════════════════════════════════════════════════════════════════
test('B2-A1：事件常量单点登记于 event-types.js，调用点（gates.ts/store.js）无裸字面量', () => {
  assert.equal(EVT.EVT_GATE_CONTRACT_MISSING, 'gate.contract_missing',
    'event-types.js 须登记 EVT_GATE_CONTRACT_MISSING = "gate.contract_missing"（单点登记纪律）');
  const evtSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'state', 'event-types.js'), 'utf8');
  assert.ok(evtSrc.includes("export const EVT_GATE_CONTRACT_MISSING = 'gate.contract_missing';"),
    '常量声明行须逐字在场（先登记常量、后于调用点引用）');
  for (const rel of ['lib/state/gates.ts', 'lib/state/store.js']) {
    const src = fs.readFileSync(path.join(PKG_ROOT, ...rel.split('/')), 'utf8');
    assert.ok(!/['"]gate\.contract_missing['"]/.test(src),
      rel + ' 内不得出现裸字面量（须引用 EVT 常量单点）');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 2：六个判定位首触各落一条（B2-A2 / B2-A7；R-1 / R-3）
// ═══════════════════════════════════════════════════════════════════════════════
test('B2-A2/A7：六个 gateKind 首触各落一条，且同键不会再发（只报一次/批）', () => {
  const bid = mkFullBatch('b2-full');
  assert.equal(cmEvents(bid).length, 0, '前置：夹具建成时零 contract_missing 事件');

  // P-2 plan 契约（layer=plan 的 merged 前置）
  settle(bid, 'p1', 'running');
  settle(bid, 'p1', 'review');
  settle(bid, 'p1', 'merged');
  // P-1 entry_requires（exec 层派发前）
  settle(bid, 'e1', 'running');
  // P-5 targets + P-4 gate_command（exec 层 merged 前置）
  settle(bid, 'e1', 'review');
  settle(bid, 'e1', 'merged');
  // P-1 entry_requires（audit 层）+ P-3 needhuman（audit 层 review / merged 两次触达）
  settle(bid, 'a1', 'running');
  settle(bid, 'a1', 'review');
  settle(bid, 'a1', 'merged');
  // P-6 complete（批次收口门）
  store.setPhase(SID, bid, 'complete');

  const evs = cmEvents(bid);
  const keys = evs.map(cmKey);
  assert.equal(new Set(keys).size, keys.length, '去重键 (gateKind, layer) 不得重复：' + JSON.stringify(keys));
  for (const k of keys) {
    assert.equal(keys.filter((x) => x === k).length, 1, '同键只报一次：' + k);
  }
  for (const k of GATE_KINDS) {
    assert.ok(evs.some((e) => e.gateKind === k), 'P-' + k + ' 须至少一条首触事件；实测=' + JSON.stringify(keys));
  }
  // 判定位→层归属（规格 §1.2 逐点）：P-1 `entry_requires` 的判定位覆盖 **exec ∪ audit**（层是去重键的一员）
  //   ⇒ 两层各一条；其余五点在各自层各一条：实测 7 条（规格风险表「上限 6 条/批」按 `gateKind ≤6 × 有效层 ≤2` 的口径，
  //   本夹具实测 7 —— 差异已在产物「未决项/差异」登记）。
  assert.deepEqual(keys.slice().sort(), [
    'complete@audit', 'contract@plan', 'entry_requires@audit', 'entry_requires@exec',
    'gate_command@exec', 'needhuman@audit', 'targets@exec',
  ].sort(), '实测键集合');
  assert.equal(evs.length, 7, '本夹具实测条数（去重键 × 有效层）');
  // 载荷契约（E-2）：cause / declared / source / degrade 齐备；且 lane 可归因（complete 面为 null）
  for (const e of evs) {
    assert.equal(e.cause, 'undeclared', '成因默认 undeclared（本批不产 declared-off）');
    assert.equal(e.declared, false, '缺声明 ⇒ declared:false');
    assert.equal(typeof e.source, 'string', 'source 可读（引擎缺省来源）');
    assert.equal(typeof e.degrade?.kind, 'string', 'degrade.kind 在场');
    assert.equal(typeof e.degrade?.note, 'string', 'degrade.note 在场');
    assert.ok(Array.isArray(e.problems), 'problems 为数组');
    assert.ok(Object.prototype.hasOwnProperty.call(e, 'lane'), 'lane 键恒在场（可为 null）');
    assert.equal(Boolean(e.code), false, '事件不得携带 GATE 码（非拒态）');
  }
  // 上限（规格 §1.6 风险表）：gateKind ≤6 × 有效层 ≤2 ⇒ 本夹具 7 条
  assert.ok(evs.length <= 12, '事件量不得膨胀；实测=' + evs.length);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 3：跨重启幂等（B2-A3；R-4）
// ═══════════════════════════════════════════════════════════════════════════════
test('B2-A3：跨重启幂等——重建 store 后同键再触达不产生第二条事件（判据 = batch.events）', () => {
  const targetAbs = path.join(ROOT, 'targets', 'b2-idem-target.txt');
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, 'targets-claimed: true\n', 'utf8');
  const bid = 'b2-idem';
  mkBatch(bid, [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
    { id: 'e2', layer: 'exec', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e2.md'], cmd: 'run' },
    { id: 'a1', layer: 'audit', deps: ['e1', 'e2'], consume: ['plan/spec.md'], produce: ['audit/a1.md'], cmd: 'review' },
  ]);
  writeArt(bid, 'plan/spec.md', SPEC_OK);
  writeArt(bid, 'exec/e1.md', 'out');
  writeArt(bid, 'exec/e2.md', 'out');
  writeArt(bid, 'audit/a1.md', 'review');

  // 进程 A：首次触达（exec 层 entry_requires）
  settle(bid, 'e1', 'running');
  const afterFirst = cmEvents(bid);
  assert.equal(afterFirst.length, 1, '首触须落一条');
  assert.equal(cmKey(afterFirst[0]), 'entry_requires@exec');

  // 「重启」：进程 B —— 全新 store 实例，只从**磁盘批次 JSON** 取事实源
  const store2 = createStore(ROOT);
  store2.setMember(SID, bid, 'e2', 'running'); // 同 (gateKind, layer) 键的第二次触达
  const afterRestart = store2.readBatch(SID, bid).events.filter((e) => e && e.type === E_CONTRACT_MISSING);
  assert.equal(afterRestart.length, 1, '跨重启幂等：同键不产生第二条;实测=' + JSON.stringify(afterRestart.map(cmKey)));
  assert.equal(afterRestart[0].lane, 'e1', '既有事件不被改写（首触 lane 保持）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 4：R-5 硬边界——只读视图零发射
// ═══════════════════════════════════════════════════════════════════════════════
test('B2-A4：只读视图（gateStatus / 真实 gate_status 工具面）绝不发射事件', () => {
  const targetAbs = path.join(ROOT, 'targets', 'b2-readonly-target.txt');
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, 'targets-claimed: true\n', 'utf8');
  const bid = 'b2-readonly';
  mkBatch(bid, fullTasks(targetAbs));
  writeArt(bid, 'plan/spec.md', SPEC_OK);
  writeArt(bid, 'exec/e1.md', 'out');
  writeArt(bid, 'audit/a1.md', 'review');

  const before = evsOf(bid).length;
  // gateStatus 会调 checkPlanContract（gates.ts:1040）——「只产载荷、零落盘」的硬边界在此被行使
  for (let i = 0; i < 3; i += 1) {
    const gs = gates.gateStatus(SID, bid, 'p1');
    assert.equal(gs.gates, 'in-plan', 'gateStatus 正常返回');
    gates.gateStatus(SID, bid, 'e1');
    gates.gateStatus(SID, bid, 'a1');
  }
  assert.equal(evsOf(bid).length, before, '只读视图零事件（三次读数不变）');
  assert.equal(cmEvents(bid).length, 0, '只读视图不得产 gate.contract_missing（R-5）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 5：告警与事件同源（一次触达 = 一条事件 + 一条 warn）
// ═══════════════════════════════════════════════════════════════════════════════
test('B2：告警与事件同源——logger.warn 计数 = 事件条数（不得有事件无告警/反之）', async () => {
  const warns = [];
  const root5 = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b2-warn-'));
  const logger = { warn: (...a) => warns.push(a.map(String).join(' ')), info: () => {}, error: () => {} };
  const store5 = createStore(root5, { logger });
  const plan = buildWavePlan({
    batchId: 'b2-warn',
    team: NO_ASSET_TEAM,
    tasks: [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
      { id: 'a1', layer: 'audit', deps: ['e1'], consume: ['plan/spec.md'], produce: ['audit/a1.md'], cmd: 'review' },
    ],
  });
  store5.createBatch(SID, { batchId: 'b2-warn', wavePlan: plan, concurrency: plan.concurrency });
  const b = store5.readBatch(SID, 'b2-warn');
  b.team = NO_ASSET_TEAM;
  b.phase = 'running';
  fs.writeFileSync(path.join(root5, 'sessions', SID, 'batches', 'b2-warn.json'), JSON.stringify(b, null, 2), 'utf8');
  for (const rel of ['plan/spec.md', 'exec/e1.md', 'audit/a1.md']) {
    const abs = path.join(root5, 'sessions', SID, 'artifacts', 'b2-warn', ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, rel === 'plan/spec.md' ? SPEC_OK : 'out', 'utf8');
  }

  store5.setMember(SID, 'b2-warn', 'e1', 'running');
  const evs = store5.readBatch(SID, 'b2-warn').events.filter((e) => e && e.type === E_CONTRACT_MISSING);
  const warnLines = warns.filter((w) => w.includes('contract_missing'));
  assert.equal(evs.length, 1, '一次触达 ⇒ 一条事件');
  assert.equal(warnLines.length, 1, '一次触达 ⇒ 一条告警（同源一次）;实测=' + JSON.stringify(warns));
  assert.ok(warnLines[0].includes('entry_requires'), '告警须携带 gateKind（可定位）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 6：纯函数契约（去重键计算；W-4）
// ═══════════════════════════════════════════════════════════════════════════════
test('B2-W4：contractMissingEvents 纯函数——同键去重（含同调用内两次触达）+ 无载荷零产出', () => {
  assert.equal(typeof STORE.contractMissingEvents, 'function',
    'store.js 须导出 contractMissingEvents（纯函数，可单测；W-4）');
  const res = { ok: true, contractMissing: { cause: 'undeclared', gateKind: 'targets', layer: 'exec', declared: false, source: 'engine:enabledByFlag(targets,true)', degrade: { kind: 'targets-engine-default-enabled', note: 'n' }, problems: [] } };
  assert.equal(STORE.contractMissingEvents({ events: [] }, res, 'e1').length, 1, '首次 ⇒ 1 条');
  assert.equal(STORE.contractMissingEvents({ events: [{ type: E_CONTRACT_MISSING, gateKind: 'targets', layer: 'exec' }] }, res, 'e1').length, 0,
    '同键已在 batch.events ⇒ 不再发（跨重启幂等判据）');
  assert.equal(STORE.contractMissingEvents({ events: [{ type: E_CONTRACT_MISSING, gateKind: 'targets', layer: 'audit' }] }, res, 'e1').length, 1,
    '层不同 ⇒ 键不同 ⇒ 照发');
  assert.equal(STORE.contractMissingEvents({ events: [] }, { ok: true }, 'e1').length, 0, '无载荷 ⇒ 零产出');
  assert.equal(STORE.contractMissingEvents(undefined, undefined, 'e1').length, 0, '空入参 ⇒ 零产出（不抛）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 7：非拒态（B2-A5 / B2-A6；R-2）
// ═══════════════════════════════════════════════════════════════════════════════
test('B2-A5/A6：非拒态——判定随附事件不放宽/不放宽、且不新增 GateErrorCode', () => {
  // ① 判定：无团队声明 + 空 consume 仍**拒**（entry 零依赖拒派不被事件面削弱）
  const targetAbs = path.join(ROOT, 'targets', 'b2-nonreject-target.txt');
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, 'targets-claimed: true\n', 'utf8');
  const bid = 'b2-nonreject';
  mkBatch(bid, [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', deps: ['p1'], consume: [], outputs: ['exec/e1.md'], cmd: 'run' },
    { id: 'a1', layer: 'audit', deps: ['e1'], consume: ['plan/spec.md'], produce: ['audit/a1.md'], cmd: 'review' },
  ]);
  writeArt(bid, 'plan/spec.md', SPEC_OK);
  writeArt(bid, 'exec/e1.md', 'out');
  writeArt(bid, 'audit/a1.md', 'review');
  const g = gates.checkEntryGate(SID, bid, store.readBatch(SID, bid), 'e1');
  assert.equal(g.ok, false, '零依赖拒派判定不变');
  assert.equal(g.code, 'GATE_ENTRY_MISSING', '拒因码不变（未新增/未替换）');
  assert.equal(Boolean(g.contractMissing), false, '拒侧不产契约缺声明载荷（W-2：拒侧不采）');
  assert.throws(() => settle(bid, 'e1', 'running'), /GATE_ENTRY_MISSING/, '写入路径同判（拒派仍拒）');

  // ② 码面：GateErrorCode 枚举区不得出现 contract_missing 相关新码
  const contractsSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'types', 'contracts.ts'), 'utf8');
  const enumStart = contractsSrc.indexOf('export type GateErrorCode');
  const enumBody = contractsSrc.slice(enumStart, contractsSrc.indexOf('/** 门禁通过', enumStart));
  assert.ok(enumBody.length > 0, 'GateErrorCode 枚举区可定位');
  assert.ok(!/CONTRACT_MISSING/i.test(enumBody), 'GateErrorCode 零改动（事件码不是 GATE 码）');

  // ③ 事件面不承载迁移语义（R-6：不做读法 B 的迁移面子面）
  const bid2 = mkFullBatch('b2-no-migration');
  settle(bid2, 'e1', 'running');
  for (const e of cmEvents(bid2)) {
    assert.equal('override' in e, false, '事件不得带 state_machine.overrides 迁移面载荷');
    assert.equal('transition' in e, false, '事件不得带迁移判定载荷');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 9：负控——团队资产**声明齐备** ⇒ 零首触事件（无误报；判定逐点不变）
// ═══════════════════════════════════════════════════════════════════════════════
test('B2 负控：团队资产声明齐备 ⇒ 零首触事件（判定逐字不变，事件是附加观察面）', () => {
  const root9 = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b2-declared-'));
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b2-teams-'));
  const team = 'b2-declared-team';
  const dir = path.join(teamsRoot, 'presets', team);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team-asset.yml'), JSON.stringify({
    team,
    manifest: { version: 3, requires_engine: '>=0.4.4', hash: 'unhashed', source: 'B2 lane e1 负控夹具（声明齐备）' },
    layers: {
      plan: { roles: ['designer'], skills: { designer: ['spec-writing'] } },
      exec: { roles: ['coder'], skills: { coder: ['test-driven-development'] } },
      audit: { roles: ['supervisor'], skills: { supervisor: ['acceptance-gate'] } },
    },
    flows: {
      plan: {
        produce_field: 'produce',
        entry_requires: [],
        contract: { artifact_globs: ['plan/*spec.md'], required_sections: ['## 验收标准', '## 约束'] },
      },
      exec: {
        produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'],
        targets: true, gate_command: true,
      },
      audit: {
        produce_field: 'produce', consume_field: 'consume', entry_requires: ['consume'], needhuman: true,
        audit_contract: { criteria_from: 'plan/**', consumes_required: ['plan/'], verdict: ['pass', 'skip'] },
      },
    },
    // 【2026-09-18 清债】本负控夹具**不含**顶层 `state_machine`——该键已退役（零运行期消费者 ⇒ 声明即拒
    //   `TEAM_ASSET_FIELD_NOT_ALLOWED`）；负控以「声明齐备」为前提，含退役键会先吃 blocking、干扰判据。
  }, null, 2), 'utf8');
  clearFlowCache();
  // 前置：临时团队资产必须**可解析**（不可解析 ⇒ flows=null ⇒ 退化为「未声明」侧，本负控即失效）
  const resolved = resolveTeamFlows(team, { root: teamsRoot });
  assert.equal(resolved.ok, true, '前置：临时团队资产须可解析；problems='
    + JSON.stringify(resolved.problems ?? null) + '；severity=' + String(resolved.severity));
  const store9 = createStore(root9);
  const gates9 = createGates(root9);
  const targetAbs = path.join(root9, 'targets', 'declared-target.txt');
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, 'targets-claimed: true\n', 'utf8');
  const bid = 'b2-declared';
  const tasks = fullTasks(targetAbs);
  const plan = buildWavePlan({ batchId: bid, tasks, team, teamsRoot });
  store9.createBatch(SID, { batchId: bid, wavePlan: plan, concurrency: plan.concurrency, teamsRoot });
  const b = store9.readBatch(SID, bid);
  Object.assign(b.lanes, { p1: 'pending', e1: 'pending', a1: 'pending' });
  b.team = team;
  b.teamsRoot = teamsRoot;
  b.phase = 'running';
  const batchPath = path.join(root9, 'sessions', SID, 'batches', bid + '.json');
  fs.writeFileSync(batchPath, JSON.stringify(b, null, 2), 'utf8');
  for (const rel of ['plan/spec.md', 'exec/e1.md', 'audit/a1.md']) {
    const abs = path.join(root9, 'sessions', SID, 'artifacts', bid, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, rel === 'plan/spec.md' ? SPEC_OK : 'out', 'utf8');
  }

  // 判定面：与「未声明」夹具（用例 2）逐点同判——声明齐备不改变任何 `ok`/`code`
  assert.equal(gates9.checkEntryGate(SID, bid, store9.readBatch(SID, bid), 'e1').ok, true, '声明齐备 ⇒ entry 放行');
  assert.equal(gates9.checkPlanContract(SID, bid, store9.readBatch(SID, bid), 'p1').ok, true, '声明齐备 ⇒ plan 契约放行');
  store9.setMember(SID, bid, 'p1', 'running');
  store9.setMember(SID, bid, 'p1', 'review');
  store9.setMember(SID, bid, 'p1', 'merged');
  store9.setMember(SID, bid, 'e1', 'running');
  store9.setMember(SID, bid, 'e1', 'review');
  store9.setMember(SID, bid, 'e1', 'merged');
  store9.setMember(SID, bid, 'a1', 'running');
  store9.setMember(SID, bid, 'a1', 'review');
  store9.setMember(SID, bid, 'a1', 'merged');
  store9.setPhase(SID, bid, 'complete');
  const evs9 = store9.readBatch(SID, bid).events.filter((e) => e && e.type === E_CONTRACT_MISSING);
  assert.equal(evs9.length, 0, '声明齐备 ⇒ 零首触事件（不得误报）；实测=' + JSON.stringify(evs9.map(cmKey)));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 用例 8：真调用探针——经**真实工具面**触发一次 + 只读工具面负控（宿主形态复验）
// ═══════════════════════════════════════════════════════════════════════════════
test('B2-DoD：真实工具面触发落盘 + 只读 gate_status 工具面负控（零发射）', async () => {
  const root8 = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b2-toolface-'));
  const store8 = createStore(root8);
  const ctx = { tools: { register: () => {} }, logger: { warn: () => {}, info: () => {}, error: () => {} } };
  const { tools } = createTools(ctx, { store: store8, root: root8 });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const SESS = { agent: { session: { id: SID } } };
  const eventsOf = () => (store8.readBatch(SID, 'b2-probe').events ?? []).filter((e) => e && e.type === E_CONTRACT_MISSING);

  assessC(store8, SID, { rationale: 'B2 真调用探针：工具面建批/派发属 C 档动作（单批三层治理面）' });
  const minTeamsRoot = mkMinTeamRoot(); // 【P1 同步】工具面必带**有资产**团队 ⇒ 用「声明缺 entry_requires」的临时资产
  await byName.wave_plan.execute({
    batchId: 'b2-probe',
    team: MIN_TEAM,
    teamsRoot: minTeamsRoot,
    tasks: [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
      { id: 'e1', layer: 'exec', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run' },
      { id: 'a1', layer: 'audit', deps: ['e1'], consume: ['plan/spec.md'], produce: ['audit/a1.md'], cmd: 'review' },
    ],
    // assembly 必填（含 audit 层的三层批经工具面建批须带批次级装配声明）；
    //   managerPlan 显式 leader-direct ⇒ 探针不依赖 Manager 登记即可派 exec（去噪：只测契约缺声明面）
    assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
  }, SESS);
  await byName.batch_phase.execute({ batchId: 'b2-probe', phase: 'running' }, SESS);
  for (const rel of ['plan/spec.md', 'exec/e1.md', 'audit/a1.md']) {
    const abs = path.join(root8, 'sessions', SID, 'artifacts', 'b2-probe', ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, rel === 'plan/spec.md' ? SPEC_OK : 'out', 'utf8');
  }

  // ① 真实工具面驱动触发路径（member_status 派发 → entry 门 → 写路径落盘）
  assert.equal(eventsOf().length, 0, '派发前零事件');
  await byName.member_status.execute({ batchId: 'b2-probe', lane: 'e1', status: 'running' }, SESS);
  const landed = eventsOf();
  assert.equal(landed.length, 1, '真实工具面一次触达 ⇒ 事件真落盘');
  assert.equal(cmKey(landed[0]), 'entry_requires@exec', '落盘事件可归因');

  // ② 负控（R-5）：只读工具面 two-shot 调用零发射
  await byName.gate_status.execute({ batchId: 'b2-probe', lane: 'p1' }, SESS);
  await byName.gate_status.execute({ batchId: 'b2-probe', lane: 'e1' }, SESS);
  await byName.gate_status.execute({ batchId: 'b2-probe' }, SESS);
  assert.equal(eventsOf().length, 1, '只读 gate_status 工具面绝不发射（R-5 硬边界）');

  // ③ 既有只读投影面可读（不加键、不改 schema；事件经 batch_status 既有 events 面可见）
  const s = await byName.batch_status.execute({ batchId: 'b2-probe' }, SESS);
  assert.ok(s.recentEvents.some((e) => e.type === E_CONTRACT_MISSING), '事件经 batch_status 既有 recentEvents 面可读');
});
