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

// 产物声明路径**包容面**用例（DT-GAP-1 · T2）——batch `punky-debt-fix-20261020` · lane `e2-test`
//
// 判据源：`plan/scope.md` §2 T2 ①②③④ + §3（P6/P7 改法）+ AC-3/AC-4/AC-5/AC-6。
//
// 被检面 = 「产物声明路径」的**单一解析入口** `resolveArtifactIn(artifactsDir, rel)`（`lib/state/batch-paths.js`），
//   以及它的**全部消费点**：
//     · P1-P5（gates 域，本批未改，作为**回归锚**）：`detectGate` / `detectNeedHuman` / `detectGateOff` /
//       `detectScriptAnchors` / `checkNeedHumanGate` 经同一单点读产物；
//     · P6（本批 57a28d8 收口）：`lib/watch/heartbeat/context.js#resolveArtifact` —— 逃逸 ⇒ **throw**，
//       消费点 `artifactActivity`（activity.js:83）与 `resolvableArtifact`（evidence.js:30）的 try/catch ⇒ 不可判定；
//     · P7（本批 57a28d8 收口）：`handoff_submit` 在场判定 ⇒ 逃逸**判缺**；`handoff_view` 可读判定 ⇒ 逃逸
//       `abs:null` / `readable:false`。
//
// 断言纪律（AC-4，本文件的核心取舍）：
//   ① **每条「空 / 被拒 / 缺失 / 不可读」断言，其同测试内必须先有同输入形状的阳性断言**
//      （同一夹具、同一调用、只换被声明路径）——否则「返回空」在实现完全不做读时也成立（不可证伪）；
//   ② 根外夹具**非空且带 `SENTINEL-*` 哨兵**（证明「没读到」不是因为文件空/不存在）；
//   ③ 逃逸矩阵 7 形态：`..` / `../../` / 子目录回退 / `..\` / 根外绝对 / 盘符相对（跨盘）/ UNC。
//
// ⚠ 一条已实测的口径边界（非缺陷，见 `exec/tests-debt.md` 缺陷清单 N-1）：
//   Windows 上**同盘**的盘符相对路径（根在 `C:`、声明 `C:outside.md`）由 `path.resolve` 解析为
//   「该盘当前目录下的相对路径」= **根内** ⇒ 不构成逃逸；只有**跨盘**（`D:outside.md`）才逃逸。
//   故本文件的「盘符相对」样本取**跨盘**形态，并对同盘形态给出显式断言（钉住语义，不静默略过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveArtifactIn } from '../lib/state/batch-paths.js';
import { detectGate, detectNeedHuman, detectGateOff, detectScriptAnchors } from '../lib/state/gates/detect.js';
import { resolveArtifact } from '../lib/watch/heartbeat/context.js';
import { artifactActivity } from '../lib/watch/heartbeat/activity.js';
import { resolvableArtifact } from '../lib/watch/heartbeat/evidence.js';
import { buildHandoffTools } from '../lib/tools/handoff-tools.js';

const SID = 's-debt';
const BID = 'b-debt';
const SHA64 = 'a'.repeat(64);

// ── 夹具：根内正例 + 根外哨兵（每个逃逸形态的**真实落点**都放一个非空带哨兵的文件）────────────
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-artifact-containment-'));
  const dir = path.join(root, 'sessions', SID, 'artifacts', BID);
  fs.mkdirSync(path.join(dir, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });

  // 根内正例（各消费点各取所需）
  fs.writeFileSync(path.join(dir, 'ok.md'), 'SENTINEL-IN\n根内普通产物\n');
  fs.writeFileSync(path.join(dir, 'plan', 'ok.md'),
    'SENTINEL-IN-PLAN\ngate-script-sha256: plan/ok.md = ' + SHA64 + '\n');
  // `gate:` 行在**产物正文**里是合法声明面（本测试文件自身不含行首 gate 冒号形态，见产物纪律）
  fs.writeFileSync(path.join(dir, 'plan', 'commands.md'), 'SENTINEL-CMD\ngate: echo from-plan\ngate: echo second\n');
  fs.writeFileSync(path.join(dir, 'audit', 'nh.md'), 'SENTINEL-NH\nneedHuman: true\n');
  fs.writeFileSync(path.join(dir, 'audit', 'off.md'), 'SENTINEL-OFF\ngate: false\n');

  // 根外哨兵：`../outside.md`（= <…>/artifacts/outside.md）与 `../../outside2.md`（= <…>/s-*/outside2.md）
  //   注意：哨兵里**故意也带** needHuman / gate / 锚定三类声明 —— 若逃逸被读，断言必然翻真（可证伪）。
  const artifactsParent = path.join(root, 'sessions', SID, 'artifacts');
  fs.writeFileSync(path.join(artifactsParent, 'outside.md'),
    'SENTINEL-OUTSIDE\ngate: echo evil-1\ngate: echo evil-2\nneedHuman: true\ngate-script-sha256: evil/x.md = ' + SHA64 + '\n');
  fs.writeFileSync(path.join(root, 'sessions', SID, 'outside2.md'),
    'SENTINEL-OUTSIDE2\ngate: echo evil-3\nneedHuman: true\n');
  // 根外绝对落点
  fs.writeFileSync(path.join(root, 'evil-abs.md'), 'SENTINEL-ABS\ngate: echo abs-evil\nneedHuman: true\n');

  return { root, dir, artifactsParent };
}
const FIX = makeFixture();
const { root, dir } = FIX;

// 逃逸矩阵：7 形态。前 5 条的真实落点都**有非空哨兵文件**（证明「读不到」不是因为没有文件）。
const ESCAPES = [
  ['单层 `..`', '../outside.md'],
  ['多层 `../../`', '../../outside2.md'],
  ['子目录回退', 'plan/../../outside.md'],
  ['反斜杠 `..\\`', '..\\outside.md'],
  ['根外绝对', path.join(root, 'evil-abs.md')],
  ['盘符相对（跨盘）', 'D:outside.md'],
  ['UNC', '\\\\server\\share\\x.md'],
];
const POSITIVES = [
  ['根内相对', 'ok.md'],
  ['根内子目录', 'plan/ok.md'],
  ['根内绝对', path.join(dir, 'plan', 'ok.md')],
];

test('T2-0 前置：根外哨兵文件存在、非空且带 SENTINEL（防「没读到 = 文件空」的伪证）', () => {
  const sentinels = [
    path.join(FIX.artifactsParent, 'outside.md'),
    path.join(root, 'sessions', SID, 'outside2.md'),
    path.join(root, 'evil-abs.md'),
  ];
  for (const p of sentinels) {
    assert.equal(fs.existsSync(p), true, '哨兵文件须存在: ' + p);
    const st = fs.statSync(p);
    assert.ok(st.size > 0, '哨兵文件须非空: ' + p);
    assert.match(fs.readFileSync(p, 'utf8'), /SENTINEL-/, '哨兵文件须带 SENTINEL 标记: ' + p);
  }
});

test('T2-1 单点 `resolveArtifactIn`：3 阳性可解析 ⟶ 之后 7 逃逸全部 throw（含 `escapes batch root`）', () => {
  // ① 阳性先行（同测试内）：根内相对 / 子目录 / 根内绝对都必须解析到根内绝对路径
  for (const [name, rel] of POSITIVES) {
    const abs = resolveArtifactIn(dir, rel);
    assert.equal(path.isAbsolute(abs), true, '[' + name + '] 应返回绝对路径');
    assert.equal(abs.startsWith(dir), true, '[' + name + '] 应解析到批次产物根内: ' + abs);
    assert.equal(fs.existsSync(abs), true, '[' + name + '] 根内正例须真实可读: ' + abs);
  }
  // ② 逃逸：逐个 throw，且**消息含** `escapes batch root`（可判据，不是泛化异常）
  for (const [name, rel] of ESCAPES) {
    assert.throws(() => resolveArtifactIn(dir, rel),
      (e) => e instanceof Error && /escapes batch root/.test(e.message),
      '[' + name + '] 逃逸须 throw 且消息含 escapes batch root: ' + JSON.stringify(rel));
  }
  // ③ 口径边界钉住：**同盘**盘符相对不逃逸（Windows `path.resolve` 语义），解析结果落在根内
  const sameDrive = resolveArtifactIn(dir, 'C:outside.md');
  assert.equal(sameDrive.startsWith(dir), true, '同盘盘符相对解析进根内（不是逃逸）: ' + sameDrive);
});

test('T2-2 P1 `detectGate`：阳性产物有 2 条命令 ⟶ 7 逃逸一律 `commands: []`', () => {
  // 阳性先行：根内产物含两条 `gate:` 行 ⇒ commands 非空（证明读面真的在工作）
  const ok = detectGate(dir, ['plan/commands.md']);
  assert.deepEqual(ok.commands, ['echo from-plan', 'echo second'], '阳性对照：根内产物命令须被读出');
  assert.equal(ok.declared, true, '阳性对照：declared 须为 true');
  // 逃逸：一律空数组（且**不是**因为「产物不存在」——哨兵文件已在 T2-0 证明非空存在）
  for (const [name, rel] of ESCAPES) {
    const g = detectGate(dir, [rel]);
    assert.deepEqual(g.commands, [], '[' + name + '] 逃逸产物不得产出命令: ' + JSON.stringify(rel));
    assert.equal(g.declared, false, '[' + name + '] 逃逸不得判声明');
  }
});

test('T2-3 P2-P4 `detectNeedHuman` / `detectGateOff` / `detectScriptAnchors`：各阳性 ⟶ 各逃逸为零感知', () => {
  // 阳性（三个检测器各自的最小正例）
  assert.equal(detectNeedHuman(dir, ['audit/nh.md']).declared, true, '阳性：needHuman 声明须被读出');
  assert.equal(detectGateOff(dir, ['audit/off.md']).declared, true, '阳性：gate: false 须被读出');
  const anchors = detectScriptAnchors(dir, ['plan/ok.md']);
  assert.equal(Object.keys(anchors.anchors ?? {}).length > 0, true, '阳性：脚本锚定须被读出');
  assert.equal(anchors.path, 'plan/ok.md', '阳性：锚定来源路径须回显');

  // 逃逸：三个检测器一律零感知（needHuman 的逃逸目标里**确实写着** needHuman: true —— 存在于根外）
  for (const [name, rel] of ESCAPES) {
    assert.equal(detectNeedHuman(dir, [rel]).declared, false, '[' + name + '] 逃逸不得判 needHuman 声明');
    assert.equal(detectGateOff(dir, [rel]).declared, false, '[' + name + '] 逃逸不得判 gate 关闭声明');
    assert.deepEqual(detectScriptAnchors(dir, [rel]).anchors, {}, '[' + name + '] 逃逸不得产出脚本锚定');
  }
});

test('T2-4 P6 `resolveArtifact`：阳性返回根内可读路径 ⟶ 7 逃逸 throw（不 stat 根外）', () => {
  const cx = { store: { artifactsDirOf: () => dir } };
  // 阳性先行：根内路径返回后可 statSync 读到非空内容
  const abs = resolveArtifact(cx, SID, BID, 'ok.md');
  assert.equal(abs.startsWith(dir), true, '阳性：P6 解析结果须在根内');
  assert.ok(fs.statSync(abs).size > 0, '阳性：P6 解析结果须可读且非空');
  // 逃逸：P6 已收口为 throw（改前是「返回根外实体路径 ⇒ statSync 可读」）
  for (const [name, rel] of ESCAPES) {
    assert.throws(() => resolveArtifact(cx, SID, BID, rel),
      (e) => e instanceof Error && /escapes batch root/.test(e.message),
      '[' + name + '] P6 逃逸须 throw: ' + JSON.stringify(rel));
  }
  // R-4 分治：**合法但未落盘** ⇒ 原样返回路径、不抛（运行期缺失语义不变）
  const absent = resolveArtifact(cx, SID, BID, 'absent-but-legal.md');
  assert.equal(absent.startsWith(dir), true, 'R-4：合法未落盘路径须原样返回（不抛）');
  assert.equal(fs.existsSync(absent), false, 'R-4：该路径确实未落盘');
});

test('T2-5 P6 消费点等价：`artifactActivity` / `resolvableArtifact` 阳性为真 ⟶ 逃逸为假（不可判定）', () => {
  const cx = { store: { artifactsDirOf: () => dir } };
  // 阳性先行：同一 batch/lane 声明**根内**产物时，两个消费点都必须为 true
  const batchIn = { wavePlan: [{ tasks: [{ id: 'e1', outputs: ['ok.md'] }] }] };
  assert.equal(artifactActivity(cx, SID, BID, batchIn, 'e1', 0), true,
    '阳性对照：根内产物 mtime > sinceTs(0) ⇒ artifactActivity 须为 true');
  assert.equal(resolvableArtifact(cx, SID, BID, 'ok.md'), true,
    '阳性对照：根内非空产物 ⇒ resolvableArtifact 须为 true');
  // 阴性对照：根内**空文件**不算可解析（口径 = 存在且非空）
  fs.writeFileSync(path.join(dir, 'empty.md'), '');
  assert.equal(resolvableArtifact(cx, SID, BID, 'empty.md'), false, '阴性对照：空文件不算可解析');

  // 逃逸：同一输入形状、只把声明换为逃逸路径 ⇒ 两个消费点降为「不可判定」= false，
  //   **不是**「新鲜 / 可解析」（改前二者都是 true —— 那正是本批 P6 修的缺陷）
  for (const [name, rel] of ESCAPES) {
    const batchEsc = { wavePlan: [{ tasks: [{ id: 'e1', outputs: [rel] }] }] };
    assert.equal(artifactActivity(cx, SID, BID, batchEsc, 'e1', 0), false,
      '[' + name + '] 逃逸不得判「有活动」: ' + JSON.stringify(rel));
    assert.equal(resolvableArtifact(cx, SID, BID, rel), false,
      '[' + name + '] 逃逸不得判「可解析」: ' + JSON.stringify(rel));
  }
});

// ── P7：工具面（`buildHandoffTools` + 最小 stub store，不依赖完整批次脚手架）──────────────
function makeHandoffHarness({ batch }) {
  const events = [];
  const recorded = [];
  const store = {
    readBatch: () => batch,
    artifactsDirOf: () => dir,
    appendEvent: (sid, bid, type, payload) => events.push({ type, payload }),
    recordHandoff: (sid, bid, rec) => { recorded.push(rec); return { ok: true, overwrite: false, previousAssertions: [] }; },
    declaredInboundEdgesOf: () => ({ edges: ['p1'], sources: [{ from: 'p1', source: 'deps' }] }),
  };
  const tools = buildHandoffTools({ ctx: {}, store, root, config: {}, deps: {} });
  const byName = (n) => tools.find((t) => t.name === n);
  return { events, recorded, submit: byName('handoff_submit'), view: byName('handoff_view') };
}
const EXEC = { agent: { session: { id: SID } } };
const WAVE = [{ tasks: [{ id: 'p1', produce: ['ok.md'] }, { id: 'e1', deps: ['p1'] }] }];

test('T2-6 P7 `handoff_submit`：根内产物提交成功 ⟶ 7 逃逸一律判缺 GATE_HANDOFF_MISSING（且不落 recordHandoff）', async () => {
  const h = makeHandoffHarness({ batch: { batchId: BID, wavePlan: WAVE, handoffs: {} } });
  // 阳性先行：根内产物 ⇒ 提交成功 + 唯一写路径真被调用一次
  const okRes = await h.submit.execute({ session: SID, batchId: BID, from: 'p1', to: 'e1', artifacts: ['ok.md'], assertions: ['a1'] }, EXEC);
  assert.equal(okRes.ok, true, '阳性对照：根内产物须提交成功');
  assert.equal(okRes.code, 'HANDOFF_OK', '阳性对照：成功码');
  assert.equal(h.recorded.length, 1, '阳性对照：写路径 recordHandoff 须被调用（证明成功路径真的走到写）');

  // 逃逸：判缺并拒；**不落 recordHandoff**（写路径零调用是「拒」的物理证据）
  for (const [name, rel] of ESCAPES) {
    const before = h.recorded.length;
    await assert.rejects(
      () => h.submit.execute({ session: SID, batchId: BID, from: 'p1', to: 'e1', artifacts: [rel], assertions: ['a1'] }, EXEC),
      (e) => e instanceof Error && /GATE_HANDOFF_MISSING/.test(e.message),
      '[' + name + '] 逃逸产物须判缺拒交: ' + JSON.stringify(rel),
    );
    assert.equal(h.recorded.length, before, '[' + name + '] 判缺时**不得**调用 recordHandoff');
  }
  // 缺口留痕：逃逸被拒时逐条落 lane.handoff.gap 事件（零静默）
  const gapEvents = h.events.filter((e) => String(e.type).includes('handoff.gap'));
  assert.equal(gapEvents.length >= ESCAPES.length, true,
    '逃逸被拒须逐条落缺口事件（实测 ' + gapEvents.length + ' ≥ ' + ESCAPES.length + '）');
});

test('T2-7 P7 `handoff_view`：根内产物 readable:true ⟶ 7 逃逸 `abs:null` / `readable:false`', async () => {
  // 同一次 view 里**同时**放根内 + 一个逃逸产物 ⇒ 直接对照（更强于两个独立调用）
  const batch = {
    batchId: BID, wavePlan: WAVE,
    handoffs: { e1: [{ from: 'p1', status: 'submitted', artifacts: ['ok.md', '../outside.md'], contract: { assertions: ['x'] } }] },
  };
  const h = makeHandoffHarness({ batch });
  const r = await h.view.execute({ session: SID, batchId: BID, lane: 'e1' }, EXEC);
  const arts = r.edges[0].artifacts;
  const inRoot = arts.find((a) => a.path === 'ok.md');
  const escaped = arts.find((a) => a.path === '../outside.md');
  // 阳性先行：同一响应里根内项必须 readable:true 且 abs 指向根内（证明视图真的能取件）
  assert.equal(inRoot.readable, true, '阳性对照：同响应内根内产物 readable 须为 true');
  assert.equal(inRoot.abs.startsWith(dir), true, '阳性对照：根内产物 abs 须指向批次产物根内');
  // 逃逸项：abs 置 null + readable:false（**不探根外**）
  assert.equal(escaped.readable, false, '逃逸项 readable 须为 false');
  assert.equal(escaped.abs, null, '逃逸项 abs 须为 null（R-4 声明期口径）');
  // 缺口清单同面透出（**按边**回显：`edges[].gap`，与 entry 门 missing 同形）
  assert.equal((r.edges[0].gap ?? []).some((g) => g.includes('../outside.md')), true, '逃逸项须进该边的 gap 清单');

  // 逐形态复核（每次一个新 view）：全部逃逸形态一律 abs:null / readable:false
  for (const [name, rel] of ESCAPES) {
    const b2 = { batchId: BID, wavePlan: WAVE, handoffs: { e1: [{ from: 'p1', status: 'submitted', artifacts: [rel], contract: { assertions: ['x'] } }] } };
    const h2 = makeHandoffHarness({ batch: b2 });
    const r2 = await h2.view.execute({ session: SID, batchId: BID, lane: 'e1' }, EXEC);
    const a = r2.edges[0].artifacts[0];
    assert.equal(a.readable, false, '[' + name + '] 逃逸 readable 须为 false');
    assert.equal(a.abs, null, '[' + name + '] 逃逸 abs 须为 null');
  }
});
