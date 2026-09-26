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

// 批次 `onto-p4-authz-r2-20260925` · lane `exec-tests`（角色 tester）——**测试锁**：
//   R-3 lane `roster` 承载字段（§2.3）+ R-5 批级通道归属声明（§2.4）。
// 判据源（逐条对照，勿另起口径）：`plan/fix-spec.md` §2.3 / §2.4 / §5 / §6.3 / §6.4 / §6.5 B-a；
//   实现自证 = `exec/contract-change.md`。
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ **可达面登记（读本文件前必读，见 `exec/test-locks.md` G-T2）**：
//   `lib/tools/core.js` 内 `normalizeChannelDecl` / `args.channel` / `batch.channel` **零命中**
//   （限定量词：该文件内）⇒ R-5 的建批工具面**未接线**，`wave_plan.execute` 与 `store.createBatch`
//   都没有 `channel` 入参。故 R5-b / R5-c 的**唯一可达构造** = 直调 `lib/wave-plan.js#normalizeChannelDecl`
//   （导出的纯函数，单点判定处）；R5-d 的存量批零破坏在 `store.createBatch` 路径可达（不传即不写键）。
//   R5-e 的「运行期单一判定点」在本文件内按**限定路径计数**判定（gates/store 两文件内该前缀引用 = 0）。
//   本 lane **不**把「工具面未接线」写成断言（那会把缺陷锁死、并在接线后产生假红）——只登记，交 audit 进 gap-list。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildWavePlan, normalizeRoster, normalizeChannelDecl, ROSTER_NAME_RE,
} from '../lib/wave-plan.js';
import { createStore } from '../lib/state/store.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SESSION = 'sess-channel';
const TEAM = 'channel-team';

const flatOf = (plan) => Object.fromEntries(plan.wavePlan.flatMap((w) => w.tasks).map((t) => [t.id, t]));

/**
 * 合成 tasks（plan → exec[…] → audit）。
 * 形态约束（`validateLayerContract`）：有 exec 层就必须有 audit 层 ⇒ 一律带 `a1`，
 *   否则先命中 `three-tier: exec layers require at least one audit lane`（那是另一条判据，会盖住被检面）。
 */
function tasks({ rosterOf = {}, execIds = ['e1'] } = {}) {
  const withRoster = (id, t) => (rosterOf[id] === undefined ? t : { ...t, roster: rosterOf[id] });
  const execs = execIds.map((id) => withRoster(id, {
    id, layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/' + id + '.md'], deps: ['p1'], cmd: 'run',
  }));
  return [
    withRoster('p1', { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' }),
    ...execs,
    withRoster('a1', {
      id: 'a1', layer: 'audit', role: 'reviewer',
      consume: ['plan/spec.md', ...execIds.map((id) => 'exec/' + id + '.md')],
      produce: ['audit/a1.md'], deps: [...execIds], cmd: 'review-it',
    }),
  ];
}

// ── R-3 §2.3.2 归一化恒写 ────────────────────────────────────────────────────

test('C-1 R3-b roster 恒写：缺省/非字符串/空串/纯空白 ⇒ null；\'  coder-1  \' ⇒ trim 后保留', () => {
  const plan = buildWavePlan({
    batchId: 'c1',
    tasks: [
      { id: 'a', cmd: 'x' },
      { id: 'b', cmd: 'x', roster: '  coder-1  ' },
      { id: 'c', cmd: 'x', roster: '' },
      { id: 'd', cmd: 'x', roster: null },
      { id: 'e', cmd: 'x', roster: 7 },
      { id: 'f', cmd: 'x', roster: '   ' },
    ],
  });
  const flat = flatOf(plan);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.equal(Object.prototype.hasOwnProperty.call(flat[id], 'roster'), true,
      'roster 必须**恒写**（键在场；缺省落 null 而非 undefined，风格同 targetsMarker）：' + id);
  }
  assert.equal(flat.a.roster, null, '缺省 ⇒ null');
  assert.equal(flat.b.roster, 'coder-1', 'trim 后原样保留');
  assert.equal(flat.c.roster, null, '空串 ⇒ null');
  assert.equal(flat.d.roster, null, 'null ⇒ null');
  assert.equal(flat.e.roster, null, '非字符串 ⇒ null');
  assert.equal(flat.f.roster, null, '纯空白 ⇒ null');
  // 纯函数读端同口径（导出面单点，供读端与测试共用）
  assert.equal(normalizeRoster('  coder-1  '), 'coder-1');
  assert.equal(normalizeRoster(undefined), null);
  assert.equal(ROSTER_NAME_RE.test('coder-1'), true);
});

// ── R-3 §2.3.2 sig 面零漂移 ─────────────────────────────────────────────────

test('C-2 R3-c roster 不进 sig：同一任务 roster 有无 ⇒ sig 逐字相等', () => {
  const a = buildWavePlan({ batchId: 'c2a', tasks: [{ id: 'k', cmd: 'q' }] });
  const b = buildWavePlan({ batchId: 'c2b', tasks: [{ id: 'k', cmd: 'q', roster: 'coder-1' }] });
  const sigA = flatOf(a).k.sig;
  const sigB = flatOf(b).k.sig;
  assert.match(String(sigA), /^[0-9a-f]{16}$/, '前置：sig 形态 = 16 hex');
  assert.equal(sigB, sigA, 'computeTaskSig 输入面 {id,layer,role,deps,produce,outputs,cmd} 逐字未动 ⇒ sig 零漂移');
});

// ── R-3 §2.3.3 多形态合法（同类型多成员 / 一成员多 lane）─────────────────────

test('C-3 R3-d 多形态：同 roster 名书两条 lane + 不同名各书一条 ⇒ 均放行且**零 roster 告警**', () => {
  const sameName = buildWavePlan({
    batchId: 'c3a',
    tasks: tasks({ execIds: ['x1', 'x2'], rosterOf: { x1: 'coder-1', x2: 'coder-1' } }),
  });
  const multiMember = buildWavePlan({
    batchId: 'c3b',
    tasks: tasks({ execIds: ['y1', 'y2'], rosterOf: { y1: 'coder-1', y2: 'coder-2' } }),
  });
  const rosterWarn = (p) => p.warnings.filter((w) => /ROSTER/.test(String(w.code)));
  assert.deepEqual(rosterWarn(sameName), [],
    '一成员多 lane 合法（不去重、不查重、不产告警）：' + JSON.stringify(sameName.warnings));
  assert.deepEqual(rosterWarn(multiMember), [],
    '同类型多成员各书其名合法：' + JSON.stringify(multiMember.warnings));
  assert.deepEqual(flatOf(sameName).x1.roster, 'coder-1');
  assert.deepEqual(flatOf(sameName).x2.roster, 'coder-1');
  assert.equal(flatOf(multiMember).y2.roster, 'coder-2');
});

// ── R-3 §2.3.4 非法 roster fail-closed 拒 + 零批次落盘 ───────────────────────

test('C-4 R3-e 反例：非法 roster ⇒ GATE_ROSTER_INVALID（回显 task 与 value）且**零批次落盘**', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-roster-'));
  try {
    const store = createStore(root);
    const batchFile = path.join(root, 'sessions', SESSION, 'batches', 'c4.json');
    // 走与 `lib/tools/core.js` 建批路径**同一对单点**：`buildWavePlan` → `store.createBatch`
    //   （词法判据在 buildWavePlan 产物构造**之前**抛 ⇒ 不可能有半成品落盘）。
    for (const bad of ['Coder One', 'coder_1', 'coder-', '-coder', 'CODER']) {
      assert.throws(
        () => {
          const plan = buildWavePlan({ batchId: 'c4', tasks: tasks({ rosterOf: { e1: bad } }) });
          store.createBatch(SESSION, { batchId: 'c4', wavePlan: plan });
        },
        (e) => {
          assert.match(String(e.message), /^GATE_ROSTER_INVALID/, '反例须**命中该码**（非「未抛出」）：' + e.message);
          assert.match(String(e.message), /task e1/, '须回显 task：' + e.message);
          assert.match(String(e.message), /roster "/, '须回显 value：' + e.message);
          return true;
        },
        '非法 roster 形态：' + bad,
      );
      assert.equal(fs.existsSync(batchFile), false, '命中即**零批次 JSON 落盘**：' + bad);
    }
    // 正例对照（同形 tasks，仅 roster 合法）⇒ 建批成功（证拒的是词法，不是环境/参数）
    const okPlan = buildWavePlan({ batchId: 'c4-ok', tasks: tasks({ rosterOf: { e1: 'coder-1' } }) });
    store.createBatch(SESSION, { batchId: 'c4-ok', wavePlan: okPlan });
    assert.equal(fs.existsSync(path.join(root, 'sessions', SESSION, 'batches', 'c4-ok.json')), true, '合法 roster ⇒ 放行落盘');
    const read = store.readBatch(SESSION, 'c4-ok');
    assert.equal(read.wavePlan.flatMap((w) => w.tasks).find((t) => t.id === 'e1').roster, 'coder-1', '落盘的 roster 为归一化后值');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── R-3 §2.3.1 类型面落位（R3-a，限定路径计数）───────────────────────────────

test('C-5 R3-a 类型面：`contracts.ts` 与 `contracts.d.ts` 各有 2 处 roster **字段声明**（计数差 = 0 ≤ 1）', () => {
  const declOf = (rel) => fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8')
    .split('\n').filter((l) => /^\s*roster\??:\s/.test(l));
  const ts = declOf('lib/types/contracts.ts');
  const dts = declOf('lib/types/contracts.d.ts');
  assert.equal(ts.length >= 2, true, 'WavePlanTaskInput + WavePlanTask 各 ≥1 处字段声明；实测 ' + ts.length + ' 处：' + JSON.stringify(ts));
  assert.equal(dts.length >= 2, true, '同上（.d.ts）；实测 ' + dts.length + ' 处：' + JSON.stringify(dts));
  assert.equal(Math.abs(ts.length - dts.length) <= 1, true, '声明面一致（计数差 ≤1）：ts=' + ts.length + ' dts=' + dts.length);
  // 两处声明形态各一（可选入参 + 恒写持久形态）——**限定量词：上述两条正则命中行内**
  const joined = ts.join('\n');
  assert.match(joined, /roster\?:\s*string\s*\|\s*null/, '建批入参形态 roster?: string | null');
  assert.match(joined, /roster:\s*string\s*\|\s*null/, '持久形态 roster: string | null');
});

// ── R-5 §2.4.1 / R5-a 缺省向后兼容 ──────────────────────────────────────────

test('D-1 R5-a 缺省归一化：channel 未声明（undefined/null）⇒ 归一化读端有效值 = dispatch，且 declared=false', () => {
  for (const absent of [undefined, null]) {
    const out = normalizeChannelDecl(absent, [{ id: 'a' }, { id: 'b', roster: 'coder-1' }]);
    assert.equal(out.channel, 'dispatch', '「缺省 dispatch（存量语义零变化）」= 归一化读端有效值：' + String(absent));
    assert.equal(out.declared, false, 'declared=false = 调用方**不写 `batch.channel` 键**的信号（R5-d）；实测 ' + JSON.stringify(out));
  }
  // 显式声明 ⇒ declared=true 且原样回显枚举
  assert.deepEqual(normalizeChannelDecl('team', [{ id: 'a', roster: 'coder-1' }]), { channel: 'team', declared: true });
});

test('D-2 R5-d 存量批零破坏：未声明 channel 建批 ⇒ 批次 JSON **无 `channel` 键** + 读端零感知', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-channel-'));
  try {
    const store = createStore(root);
    const plan = buildWavePlan({ batchId: 'd2', tasks: tasks() });
    store.createBatch(SESSION, { batchId: 'd2', wavePlan: plan });
    const file = path.join(root, 'sessions', SESSION, 'batches', 'd2.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(raw, 'channel'), false,
      '未声明 ⇒ **不写键**（键不存在 = 零感知，同 `handoffs` 的存量口径）');
    const read = store.readBatch(SESSION, 'd2'); // 读端不抛错
    assert.equal(read.channel, undefined, '读端取值 = undefined（不抛错、不补默认字面量）');
    assert.equal(Object.prototype.hasOwnProperty.call(read, 'channel'), false, '读端亦不凭空造键');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── R-5 §2.4.3 一致性三条（各命中 GATE_CHANNEL_UNRESOLVED）──────────────────

test('D-3 R5-b 反例三条：team 缺 roster / dispatch 带 roster / mixed 零 roster ⇒ 各命中 GATE_CHANNEL_UNRESOLVED', () => {
  const cases = [
    ['team 缺 roster', 'team', [{ id: 'a', roster: 'coder-1' }, { id: 'b' }], /lanes missing roster: b/],
    ['dispatch 带 roster', 'dispatch', [{ id: 'a' }, { id: 'b', roster: 'coder-1' }], /lanes with roster: b/],
    ['mixed 零 roster', 'mixed', [{ id: 'a' }, { id: 'b' }], /at least one lane/],
  ];
  for (const [label, channel, laneList, msgRe] of cases) {
    assert.throws(
      () => normalizeChannelDecl(channel, laneList),
      (e) => {
        assert.match(String(e.message), /^GATE_CHANNEL_UNRESOLVED/, label + ' 须**命中该码**：' + e.message);
        assert.match(String(e.message), msgRe, label + ' 须回显矛盾 lane / 矛盾点：' + e.message);
        return true;
      },
      label,
    );
  }
});

// ── R-5 §2.4.2 非法枚举 ─────────────────────────────────────────────────────

test('D-4 R5-c 反例：非法枚举（字符串/非字符串）⇒ GATE_CHANNEL_INVALID 且回显原值', () => {
  for (const bad of ['hybrid', 'TEAM', '', 42, true]) {
    assert.throws(
      () => normalizeChannelDecl(bad, [{ id: 'a' }]),
      (e) => {
        assert.match(String(e.message), /^GATE_CHANNEL_INVALID/, '须**命中该码**：' + e.message);
        assert.match(String(e.message), /got: /, '须回显原值（可自救）：' + e.message);
        return true;
      },
      '非法枚举值：' + JSON.stringify(bad),
    );
  }
});

// ── R-5 正例（放行侧）──────────────────────────────────────────────────────

test('D-5 R5-b 正例三条：dispatch+零 roster / team+全 roster / mixed+至少一条 roster ⇒ 放行', () => {
  assert.deepEqual(normalizeChannelDecl('dispatch', [{ id: 'a' }, { id: 'b' }]), { channel: 'dispatch', declared: true });
  assert.deepEqual(normalizeChannelDecl('team', [{ id: 'a', roster: 'coder-1' }, { id: 'b', roster: 'coder-2' }]), { channel: 'team', declared: true });
  assert.deepEqual(normalizeChannelDecl('mixed', [{ id: 'a', roster: 'coder-1' }, { id: 'b' }]), { channel: 'mixed', declared: true });
  // team 的「每条 lane」判据按**归一化后**取值：空白 roster 视同缺（fail-closed）
  assert.throws(
    () => normalizeChannelDecl('team', [{ id: 'a', roster: '   ' }]),
    (e) => {
      assert.match(String(e.message), /^GATE_CHANNEL_UNRESOLVED/, '纯空白 roster 归一化为 null ⇒ team 下视同缺：' + e.message);
      return true;
    },
    '空白 roster 不得绕过 team 的「每条 lane 非空」判据',
  );
  // D2 实现决定（`exec/contract-change.md` §6）：**未声明**却写了 roster ⇒ 放行（否则追溯性砸存量批）
  assert.doesNotThrow(() => normalizeChannelDecl(undefined, [{ id: 'a', roster: 'coder-1' }]),
    '未声明 + 有 roster ⇒ 放行（存量零破坏；一致性三条只在显式声明时施加）');
});

// ── R5-e 运行期单一判定点（限定路径计数）────────────────────────────────────

test('D-6 R5-e 单点判定：`lib/state/gates.ts` 与 `lib/state/store.js` 内 `GATE_CHANNEL_` 引用计数 = 0', () => {
  const countIn = (rel) => fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8').split('GATE_CHANNEL_').length - 1;
  assert.equal(countIn('lib/state/gates.ts'), 0, '限定路径：lib/state/gates.ts 内该前缀引用 = 0（运行期不再二次判定）');
  assert.equal(countIn('lib/state/store.js'), 0, '限定路径：lib/state/store.js 内该前缀引用 = 0');
  assert.equal(countIn('lib/wave-plan.ts') > 0, true, '对照：定义侧（lib/wave-plan.ts）该前缀在场（证明计数面有效，非空转）');
  assert.equal(countIn('lib/wave-plan.js') > 0, true, '对照：运行期定义侧（lib/wave-plan.js）该前缀在场');
});

// ── B-a 六新码入两处 union（批次级收口判据的机检半边）────────────────────────

test('D-7 B-a 新码入 union：6 码在 `contracts.ts` 与 `contracts.d.ts` 各 ≥1（集合相等）', () => {
  const CODES = [
    'GATE_HANDOFF_UNAUTHORIZED', 'GATE_HANDOFF_IDENTITY_UNKNOWN', 'GATE_HANDOFF_OVERWRITE_UNDECLARED',
    'GATE_ROSTER_INVALID', 'GATE_CHANNEL_INVALID', 'GATE_CHANNEL_UNRESOLVED',
  ];
  const presentIn = (rel) => {
    const s = fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8');
    return CODES.filter((c) => s.includes(c));
  };
  const ts = presentIn('lib/types/contracts.ts');
  const dts = presentIn('lib/types/contracts.d.ts');
  assert.deepEqual(ts, CODES, 'contracts.ts 须 6/6 全在：' + JSON.stringify(ts));
  assert.deepEqual(dts, CODES, 'contracts.d.ts 须 6/6 全在：' + JSON.stringify(dts));
  assert.deepEqual(ts, dts, '两文件新码**集合相等**（逐字）');
});
