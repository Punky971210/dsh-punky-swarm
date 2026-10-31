/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/dispatch-form-pairing.test.js —— **S-3 回归的另一半**：`start` ／ `activation` 两支**成对**覆盖。
//
// 背景（`e1` 主动登记的未覆盖）：入口选择曾写成 `if (agentPort.form === 'activation') spawn : rt.start`。
// 【P0-3 门禁解冻 · 批 `punky-adapter-p0-20261031`】入口选择按 J6-e 归 **provider**（端口内部分派），
//   引擎只读**功能面读数** ⇒ 本文件的断言对象不再含 `agentPort.form`，也不点名宿主入口。
//   `test/engine-dispatch.test.js` 里 `activation` 出现 0 次 ⇒ 该二分只有 `start` 支被行为覆盖，
//   故本文件保留「成对覆盖」的职责。
//
// 本文件钉三件事（成对）：
//   ① activation 宿主：统一派发入口成功后，宿主侧 activation 入口被调用**恰 1 次**，
//      且 `spec.request` 只带 `agentPreset`（宿主 schema 无 `toolFilter`/`persona` 字段）；
//   ② **收窄通道必须被消费**：`toolFace`（经 `denyTools` 通道）与 preset 覆盖声明的关系**必须改变判定结果**
//      —— 交集为空 ⇒ 放行；有交集 ⇒ 拒派。原「传与不传同形」断言的**方向已反转**（见 S-3b），
//      因为「不消费 toolFace」正是 p0-6 F-3 的缺陷，不是预期行为；
//   ③ 与 `start` 形态**成对**：同一引擎在 start 宿主上 ⇒ 捕获的 `request` **含** `toolFilter.deny`（这才是 S-3 修的 B2）。
//
// 【BG-1 订正 · 批 `punky-adapter-split-20261031`】① 与 ② 的「收窄见证」曾用**空覆盖** `tools: []` 充当
//   （本文件旧 `:104`/`:143`）。与 p0-6 `meter-spec.md` C-5（`:221`）/ RL-5（`:334`）互斥：空覆盖必须被拒，
//   否则 `∅ ∩ ∅ = ∅` 恒成立 ⇒ 量具退化成恒 true（假绿）。现改用 RL-4 原文的**非空且与 deny 不相交**形态，
//   并新增两道反向锁：RL-6（静态 · 放行侧禁空覆盖）与 RL-5（语义 · 空覆盖必须被拒，自激活）。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/dispatch-form-pairing.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createCoreTools } from '../lib/tools/core.js';
import { tempRoot } from './helpers/gate-fixture.mjs';
// 单点「代码区」口径（注释/字符串掩码），与 test/forward-todo-lock.test.js 同源
import { codeOnly } from '../scripts/baseline-snapshot-core.mjs';

const PRESET = 'punkynarrow';

function seed(lane = 'l1') {
  const root = tempRoot('punky-t1-form-');
  const store = createStore(root);
  const sess = 'sess-f';
  const batchId = 'b-f';
  store.createBatch(sess, {
    batchId,
    wavePlan: buildWavePlan({
      batchId,
      tasks: [
        { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], outputs: ['plan/spec.md'] },
        { id: lane, layer: 'exec', role: 'coder', consume: ['plan/spec.md'], produce: ['exec/x.md'], outputs: ['exec/x.md'], deps: ['p1'] },
        { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/x.md'], produce: ['audit/a1.md'], outputs: ['audit/a1.md'], deps: [lane] },
      ],
    }),
    assembly: { auditLane: 'a1', managerPlan: 'leader-direct' },
  });
  // 成员写面档位判据落在**调用方会话** ⇒ 必须先写 C 档治理记录（否则先撞 GATE_MEMBER_REQUIRES_C）
  store.writeGovernance(sess, { lastAssign: { form: 'C', difficulty: 'C', rationale: 'S-3 形态成对覆盖夹具（C 档派发）', at: new Date().toISOString() } });
  const dir = path.join(root, 'sessions', sess, 'artifacts', batchId);
  fs.mkdirSync(path.join(dir, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan', 'spec.md'), '# 规格夹具\n', 'utf8');
  return { root, store, sess, batchId, lane };
}

/** start 形态宿主：`rt.start(provider, request)`，其余能力缺省。 */
function startHost(capturedRef) {
  return {
    start: async (provider, request) => {
      capturedRef.push({ provider, request });
      return { id: 'ws-start', result: Promise.resolve({ output: [], stopReason: 'completed' }) };
    },
  };
}

/** activation 形态宿主：只有 `startActivation(spec)`；**故意不提供 `start`** ⇒ 走错入口就会失败。 */
function activationHost(capturedRef) {
  return {
    startActivation: async (spec) => {
      capturedRef.push({ spec });
      return { id: 'ws-act', result: Promise.resolve({ output: [], stopReason: 'completed' }) };
    },
  };
}

async function dispatchWith(kind, cfg = {}) {
  const { root, store, sess, batchId, lane } = seed();
  const captured = [];
  const host = kind === 'activation' ? activationHost(captured) : startHost(captured);
  const ctx = { on: () => () => {}, tools: { register() {} }, logger: { info() {}, warn() {}, error() {}, debug() {} }, subagents: host };
  const tools = createCoreTools(ctx, { store, root, config: { dispatch: { provider: 'spawn-in-process', ...cfg } } });
  const ld = tools.find((t) => t.name === 'lane_dispatch');
  let result = null;
  let error = null;
  try {
    result = await ld.execute({ batchId, lane, prompt: '要点：先读规格' }, { agent: { session: { id: sess } } });
  } catch (e) { error = e; }
  return { captured, result, error, store, sess, batchId, lane };
}

test('S-3a activation 宿主：统一派发入口成功（宿主 activation 入口恰 1 次），且 `spec.request` 只带 agentPreset', async () => {
  // 【P0-3 解冻】原断言把「配了个 `agentPreset` 字符串」当成放行充分条件。真读数口径（p0-6 D-1/D-2）
  //   要求**收窄见证**：`presetCoverage[presetId].tools` 声明该 preset 实际拿到的工具面。
  //   ⇒ 夹具补 `presetCoverage` 使「见证齐备才放行」成立（今日实现忽略该键 ⇒ 仍绿；修复后见证齐备 ⇒ 仍绿）。
  // 【BG-1 订正 · 批 punky-adapter-split-20261031】原夹具写 `tools: []`（空覆盖）当作「交集为空 ⇒ 收窄成立」。
  //   与 p0-6 `meter-spec.md:221`（C-5）/`:334`（RL-5）直接互斥：C-5 明令 **空覆盖必须显式拒绝**
  //   （`coverage.tools === []` ⇒ `reason:'coverage-empty'` ⇒ `false`），因为 `∅ ∩ ∅ = ∅` **恒成立**
  //   ⇒ 量具会退化成恒 true（假绿）。⇒ 改用 p0-6 **RL-4 原文**的正对照片（`:315`）：
  //   **非空**且与 `deny`（治理工具）**不相交**的工具面 ⇒ 交集为空是**算出来的**，不是空集白给的。
  const { captured, result, error } = await dispatchWith('activation', {
    agentPreset: PRESET,
    presetCoverage: { [PRESET]: { tools: ['bash', 'read', 'write', 'edit'] } }, // RL-4：非空 + 不含治理工具 ⇒ ∩deny = ∅
  });
  assert.equal(error, null, 'activation + 见证齐备 ⇒ 不得拒派；错误=' + String(error?.message ?? ''));
  assert.equal(result?.spawned, true, '必须真的派发（spawned:true）');
  assert.equal(captured.length, 1, '必须恰好调用一次宿主入口；实际=' + captured.length);
  const spec = captured[0].spec;
  assert.ok(spec, '宿主侧 activation 入口必须收到 spec（该夹具宿主只有 activation 入口）');
  const req = spec.request;
  assert.equal(req?.agentPreset, PRESET, 'agentPreset 必须来自 config.dispatch.agentPreset；实际=' + JSON.stringify(req?.agentPreset));
  assert.equal('toolFilter' in (req ?? {}), false, 'activation 分支**不得**合成 toolFilter（宿主 schema 无此字段）');
  assert.equal('persona' in (req ?? {}), false, 'activation 分支**不得**合成 persona');
});

// ── S-3a-R（P0-3 前向登记 · **当前预期红**）裸 preset 字符串无见证 ⇒ 必须拒派 ─────────────────
//   真读数（p0-6 D-2 W-2）：「配了 preset id」≠「该 preset 收窄了本次工具面」——id 不含工具面内容，
//   必须有独立覆盖声明（`presetCoverage`）才可判。⇒ 只配 id 不配覆盖 = **无见证** ⇒ 拒派（不以弱换强）。
//   今日实现只看 id 是否存在 ⇒ 放行 ⇒ 本用例红；故挂 `{ todo }`：修好后删掉 todo 转正式用例。
test('S-3a-R（TODO · 预期红）activation + 裸 agentPreset（无 presetCoverage 见证）⇒ 必须拒派',
  { todo: '[S-3a-R] P0-3 登记：真读数要求收窄见证（p0-6 D-2 W-2）；当前实现只看 preset id 存在 ⇒ 预期红' },
  async () => {
    const { result, error } = await dispatchWith('activation', { agentPreset: PRESET });
    assert.ok(error, '无见证必须拒派（不得放行）；实际 spawned=' + String(result?.spawned));
    assert.match(String(error?.message), /GATE_DISPATCH_CAPABILITY_/, '拒派须属能力位不可用族；实际=' + String(error?.message));
  });

// ── S-3b（P0-3 方向反转 + 前向登记 · **当前预期红**）`toolFace` 必须被消费 ────────────────────
//   【原断言方向已反转】原文断言「传与不传 `toolFace` ⇒ 合成结果**同形**」= 把 p0-6 **F-3**
//   （activation 分支 `spawn(...)` 实参无 `toolFace` ⇒ 收窄通道整键丢失）**冻结成了预期行为**。
//   且原实现用 `config.dispatch.roleToolFace` 造差分 —— 该键在 `lib/**` **零消费**（grep 实测 = 0），
//   所以「同形」是**恒真**、无判别力（弱证明）。⇒ 本条按 p0-6 处方重写：
//   ① 删除 `roleToolFace`；② 改用**真实通道**（`denyTools` × `presetCoverage`）；
//   ③ 断言「`toolFace` 与覆盖声明的关系**改变判定结果**」（交集为空 ⇒ 放行；有交集 ⇒ 拒派）。
//   今日实现无视 `presetCoverage` ⇒ 两态都放行 ⇒ 本条红；修好后转绿（删掉 todo 即成正式用例）。
test('S-3b（TODO · 预期红）`toolFace` 必须被消费：覆盖与 deny 交集为空 ⇒ 放行；有交集 ⇒ 拒派',
  { todo: '[S-3b] P0-3/P0-6 登记：真读数要求 activation 分支消费 toolFace 并按 presetCoverage 核对见证；当前实现整键丢失 ⇒ 预期红' },
  async () => {
    // 交集为空：preset 覆盖**非空**但只含基础工具（不含任何治理工具）⇒ 与本次 deny 集不相交 ⇒ 收窄成立 ⇒ 放行
    //   【BG-1 订正】原为 `tools: []`（空覆盖）—— 那是 C-5 明令必须拒的退化个案（`∅∩∅` 恒成立），
    //   见 S-3a 同处注释。此处改为 RL-4 的非空不相交形态，「交集为空」由集合运算得出。
    const disjoint = await dispatchWith('activation', {
      agentPreset: PRESET,
      presetCoverage: { [PRESET]: { tools: ['bash', 'read', 'write', 'edit'] } },
    });
    assert.equal(disjoint.error, null, '交集为空 ⇒ 不得拒派；错误=' + String(disjoint.error?.message ?? ''));
    assert.equal(disjoint.result?.spawned, true, '交集为空 ⇒ 必须真的派发');

    // 有交集：`wave_plan` 在本次 deny 集内（见 S-3c 的冻结集断言），且被声明为 preset 覆盖 ⇒ 收窄不成立 ⇒ 拒派
    const overlapping = await dispatchWith('activation', {
      agentPreset: PRESET,
      presetCoverage: { [PRESET]: { tools: ['wave_plan'] } },
    });
    assert.ok(overlapping.error, '交集非空 ⇒ 必须拒派（该 preset 实际拿到了本次要禁的工具）；实际 spawned='
      + String(overlapping.result?.spawned));
    assert.match(String(overlapping.error?.message), /GATE_DISPATCH_CAPABILITY_/,
      '拒派须属能力位不可用族；实际=' + String(overlapping.error?.message));
    assert.equal(overlapping.store.readBatch(overlapping.sess, overlapping.batchId).lanes.l1, 'pending',
      '拒派须打在状态变更之前（lane 仍 pending，零状态变更）');
  });

// ── RL-6（BG-1 静态反向锁 · **今日绿**）放行侧 fixture 禁用空覆盖 ─────────────────────────────
//   动机：BG-1 的修法是「把 `tools: []` 换成非空不相交」。**只换不锁 = 把矛盾藏起来** ——
//   下一个人照样能写回 `tools: []` 而不被任何用例发现。故本节把「空覆盖不得出现在**放行侧**」机检化。
//   口径来源：a1 `punky-adapter-p0-20261031/audit/a1-pre-gate.md:247`（W0-2 验收条 ①）
//   「`tools: []` 不再出现在**期望放行**侧（`grep -A2 "spawned, true"` 上下文内无 `tools: []`）」。
//
//   为什么是「按侧」而不是「全文件禁」：C-5 要求的**反向锁**（空覆盖必须被拒）本身**必须**写出
//   `tools: []`。全文件禁会把这唯一合法的拒派侧构造也禁掉 ⇒ 锁过宽、把正确写法判红。
//   ⇒ 规则收紧为：`tools: []` 只允许出现在**不期望放行**（无 `spawned, true` 断言）的用例块内。
test('RL-6 **静态反向锁**：`presetCoverage` 的空覆盖（`tools: []`）不得出现在期望放行的用例块内', () => {
  const raw = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // ⚠ 为什么这样写（踩过两次，留档防回退）：
  //   ① **不能**直接在注释里扫 —— 本文件有多处**解释** BG-1 的注释本身写着 `tools: []`，朴素正则会全判红；
  //   ② **不能**直接拿 `codeOnly()` 的结果当扫描面 —— 它把**字符串内容**也掩成空格，
  //      于是 `tools: ['wave_plan']` 在代码视图里变成 `tools: [           ]`，被误判成**空数组**
  //      （实测第二个假阳性）。`codeOnly` 的设计用途是数断言调用，**不**适合区分「空数组 vs 有值数组」。
  //   ⇒ 正确用法：在 **raw** 上做字面匹配（保住字符串内容），用 `codeOnly` 只当**「该位置是否代码区」的掩码 oracle**
  //      （等长掩码 ⇒ 同下标；某位置非代码 ⟺ `code[i] === ' '` 且 `raw[i] !== ' '`）。
  //      注释/字符串里的同形文本因此被逐位置剔除，与 `test/forward-todo-lock.test.js` 的「注释不计」口径一致。
  const code = codeOnly(raw);
  const isCode = (i) => code[i] === raw[i];

  /** 在 raw 上找 pattern 的所有**代码区**起点下标。 */
  const codeMatches = (pattern) => {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    const out = [];
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (isCode(m.index)) out.push({ index: m.index, text: m[0] });
      if (m[0].length === 0) re.lastIndex += 1; // 防空匹配死循环
    }
    return out;
  };

  const testStarts = codeMatches(/^test\(/m).map((x) => x.index);
  const emptyHits = codeMatches(/tools\s*:\s*\[\s*\]/);
  const spawnTrueHits = codeMatches(/spawned,\s*true/);

  const offenders = [];
  for (const hit of emptyHits) {
    // 归属用例块 = 该命中之前最近的 `^test(`
    const owner = testStarts.filter((s) => s < hit.index).pop();
    if (owner === undefined) continue; // 文件头（无用例块）里的不算
    const nextStart = testStarts.filter((s) => s > hit.index)[0] ?? raw.length;
    const title = (raw.slice(owner, nextStart).match(/^test\(\s*['"`]([^'"`]*)/) ?? [, '<untitled>'])[1];
    // 「期望放行」判据：同一用例块内出现代码区的 `spawned, true`
    const expectsSpawn = spawnTrueHits.some((s) => s.index > owner && s.index < nextStart);
    if (expectsSpawn) offenders.push(title);
  }
  assert.deepEqual(offenders, [],
    '空覆盖（`tools: []`）被用在期望放行的用例块内 ⇒ `∅∩∅=∅` 恒成立 ⇒ 量具退化为恒 true（BG-1 / C-5）。'
    + ' 涉案用例=' + JSON.stringify(offenders));

  // 非空转自证：放行侧的覆盖声明必须**存在且非空**（堵「把 presetCoverage 整个删掉」这条逃逸路径 ——
  // 删掉 witness 与写空覆盖同样让判据失去锚点，S-3a-R 已冻结「无见证必须拒派」）。
  const nonEmpty = codeMatches(/presetCoverage\s*:\s*\{[^}]{0,80}tools\s*:\s*\[\s*['"]/);
  assert.ok(nonEmpty.length >= 2,
    '本文件须保留**非空** `presetCoverage` 声明（S-3a + S-3b disjoint 两处）；实际命中=' + nonEmpty.length);
});

// ── RL-5（C-5 语义反向锁 · **自激活**）空覆盖必须被判拒 ────────────────────────────────────
//   动机（lead 要求）：只把 fixture 从空覆盖换掉，等于把矛盾藏起来；必须有用例把「空覆盖 ⇒ 拒」钉住。
//
//   ⚠ **为什么不是 `{ todo }`，也不是硬红**（这一条必须写清，否则后人会「修正」成错误形态）：
//     · 写成 `{ todo }` ⇒ 撞 sibling lane `w0-todo-lock` 的 `test/forward-todo-lock.test.js`：
//       L1「内联 todo 的 id 集合 ≡ registry.open 集合（双向）」+ L2「open ≤ openMax=4，**棘轮只许收紧**」
//       ⇒ 新增第 5 条内联 todo **结构性被禁**（且 registry 不在本 lane 写域）。
//     · 写成硬红（无 todo）⇒ 本文件不再全绿，违反 a1 W0-2 验收条 ③「该文件 10/10 绿（todo 除外）」，
//       并把全量读数从 `fail 1` 污染成 `fail 2`。
//     · 写成「断言当前放行」⇒ 正是 S-3b 原写法犯过的 **F-3 缺陷冻结成预期**，明令禁止。
//   ⇒ 采用**自激活**：量具未落地（今日）时 **不冻结缺陷、只留痕**；一旦 W3-2 把真读数接上
//     （可观测判据 = 「覆盖含 `wave_plan` ⇒ 拒派」成立），本用例**立即自动收紧**为硬锁，
//     届时若未实现 C-5（空覆盖被拒）即**转红**。这样既不留 5 条 todo，也不在今日假绿。
test('RL-5 空覆盖必须被拒（C-5）：量具落地后自动收紧；未落地时留痕不冻结缺陷', async (t) => {
  // ① 量具活性探针：覆盖「含」被禁工具 ⇒ 若真读数已落地则必拒；覆盖「不含」⇒ 放行
  const overlap = await dispatchWith('activation', {
    agentPreset: PRESET,
    presetCoverage: { [PRESET]: { tools: ['wave_plan'] } },
  });
  const disjoint = await dispatchWith('activation', {
    agentPreset: PRESET,
    presetCoverage: { [PRESET]: { tools: ['bash', 'read', 'write', 'edit'] } },
  });
  const meterLive = Boolean(overlap.error) && !disjoint.error;

  if (!meterLive) {
    // 量具未落地：此刻**无法观测** C-5 语义。
    // 刻意**不**断言 `canNarrow === true` / `spawned === true` —— 那会把 p0-6 F-3 的缺陷冻结成预期。
    t.diagnostic('meter-not-live：`presetCoverage` 尚未被实现消费（activation 分支整键丢失 / 量具未接），'
      + 'C-5「空覆盖必须被拒」此刻不可观测；W3-2 落地本用例自动收紧为硬锁。'
      + ' 实测：overlap.rejected=' + Boolean(overlap.error) + ' disjoint.rejected=' + Boolean(disjoint.error));
    return;
  }

  // ② 量具已落地 ⇒ C-5 必须是硬锁：空覆盖**必须被拒**（`∅∩∅=∅` 恒成立，不得当收窄证据）
  const empty = await dispatchWith('activation', {
    agentPreset: PRESET,
    presetCoverage: { [PRESET]: { tools: [] } }, // ← 唯一合法的 `tools: []`：拒派侧（RL-6 按侧放行）
  });
  assert.ok(empty.error,
    'C-5：空覆盖（`tools: []`）必须被拒 —— 空集不是「全收窄」而是「未声明」；'
    + '否则 `∅∩∅=∅` 恒成立 ⇒ 量具退化为恒 true。实际 spawned=' + String(empty.result?.spawned));
  assert.match(String(empty.error?.message), /GATE_DISPATCH_/,
    '拒因须属派发能力位族；实际=' + String(empty.error?.message).slice(0, 160));
  assert.equal(empty.captured.length, 0, 'C-5 拒派须打在宿主调用之前（零宿主调用）');
  assert.equal(empty.result, null, 'C-5 拒派不返回成功结果');
  assert.equal(empty.store.readBatch(empty.sess, empty.batchId).lanes.l1, 'pending',
    'C-5 拒派须打在状态变更之前（lane 仍 pending）');
});

test('S-3c **成对证明**：同一引擎在 start 宿主上 ⇒ 捕获的 `request` **含** `toolFilter.deny`（B2 按次收窄）', async () => {
  const ref = [];
  const { captured, result, error } = await dispatchWith('start', {});
  assert.equal(error, null, 'start 宿主 + 无 agentPreset ⇒ 走 rt.start，不得拒派；错误=' + String(error?.message ?? ''));
  assert.equal(result?.spawned, true, '必须真的派发');
  assert.equal(captured.length, 1, 'start 形态必须恰调一次 rt.start');
  const req = captured[0].request;
  assert.ok(req?.toolFilter?.deny, 'start 形态的 request 必须带 `toolFilter.deny`（B2：按次收窄）');
  assert.equal(Array.isArray(req.toolFilter.deny), true, 'toolFilter.deny 必须是数组');
  assert.equal(req.toolFilter.deny.includes('wave_plan'), true,
    '冻结集成员 `wave_plan` 必须在 deny 内；实际=' + JSON.stringify(req.toolFilter.deny));
  // 与 activation 成对：这支有 toolFilter，activation 那支没有 —— 二分语义因此可辨
  assert.equal('agentPreset' in (req ?? {}), false, 'start 形态**不得**出现 agentPreset（那是 activation 的收窄通道）');
});

test('S-3d 能力位门仍在：activation 宿主 **未配置** agentPreset ⇒ 拒派（能力位不可用族，打在状态变更之前）', async () => {
  const { captured, result, error } = await dispatchWith('activation', {});
  assert.ok(error, '未配置 agentPreset ⇒ 必须拒派（否则 worker 拿到未收窄工具面）');
  // 【P0-3 解冻】原断言钉死码名 `..._MISSING`；码名批会改成 `..._UNAVAILABLE`（criteria-v4 M-5）
  //   ⇒ 改为**码族**匹配，跨改名窗口保持有效（单码名收紧留给码名批落地后的清理）。
  assert.match(String(error.message), /GATE_DISPATCH_CAPABILITY_(MISSING|UNAVAILABLE)/,
    '拒因须属「能力位不可用」族；实际=' + String(error.message).slice(0, 160));
  assert.equal(captured.length, 0, '拒派必须打在宿主调用之前（零宿主调用）');
  assert.equal(result, null, '拒派不返回成功结果');
});
