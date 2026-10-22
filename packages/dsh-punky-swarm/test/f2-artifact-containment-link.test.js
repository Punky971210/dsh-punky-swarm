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

// F2 containment 判据测试（批次 `punky-fix-f2-20261022` · lane `e4-tester`）
//   判据源：`plan/fix-spec-f2.md` §2（containment 契约）+ AC-3 + 不变量 3（fail-closed）/ 7（可证伪）
//   回指缺陷：A1-P1-03（纯词法归属判据 ⇒ 根内 junction/软链指向根外仍判「根内」）
//
// 本文件把 e2-containment 探针（`progress/probe-e2-containment.mjs` 第 2/3/6 组）的运行期结论**固化**为测试：
//   ① 根内 junction → 根外：`resolveArtifactIn` throw / `presenceJudge` ok:false + OUTSIDE_ROOT /
//      `detectGate` commands=[]（根外哨兵里**确实写着** `gate:` 行 ⇒ 读到就会翻真，可证伪）；
//   ② 根内 junction → 根内：**不误拒**（阳性对照：若判据改成「一律拒链接」，本条必红）；
//   ③ 词法逃逸（`..` / 根外绝对）在解权档下**未被放宽**（词法档逐条仍拒）；
//   ④ `allowMissing` 两侧对称（写面：产物根尚不存在时目标仍须判「根内」，根外目标仍拒）。
// 链接不可用（EPERM/ENOSYS）⇒ 该用例 `t.skip` 并打印原因，**不伪造通过**；不依赖链接的断言保留在本文件的其余用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { presenceJudge } from '../lib/state/gates.js';
import { detectGate } from '../lib/state/gates/detect.js';
import { isInsideRoot, isInsideRootResolved } from '../lib/state/gates/presence.js';
import { resolveArtifactIn, resolveWriteTargetIn, isArtifactInRoot } from '../lib/state/batch-paths.js';

const SID = 's-f2';
const BID = 'b-f2-link';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-f2-contain-'));
const R = path.join(BASE, 'sessions', SID, 'artifacts', BID);
fs.mkdirSync(path.join(R, 'plan'), { recursive: true });
fs.mkdirSync(path.join(R, 'audit'), { recursive: true });
fs.mkdirSync(path.join(R, 'inner'), { recursive: true });

// 根内正例（各消费点各取所需；非空 + 哨兵）
fs.writeFileSync(path.join(R, 'plan', 'ok.md'), 'SENTINEL-IN\ngate: echo from-inner\n');
fs.writeFileSync(path.join(R, 'inner', 'target.md'), 'SENTINEL-INNER-TARGET\ngate: echo from-inner-link\n');

// 根外哨兵：**故意带 `gate:` 行**——若逃逸被读到，`detectGate.commands` 必然非空（可证伪，防「空文件读不到」伪证）
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-f2-out-'));
fs.writeFileSync(path.join(OUT, 'SENTINEL.md'), 'SENTINEL-OUTSIDE\ngate: echo evil-outside\ngate: echo evil-second\n');

// 链接构造（Windows 下 junction 无需管理员）；失败不 fail，记录成因供 skip 与报告
const LINK = { esc: 'ok', inner: 'ok' };
try { fs.symlinkSync(OUT, path.join(R, 'link'), 'junction'); } catch (e) { LINK.esc = String(e && e.code || e); }
try { fs.symlinkSync(path.join(R, 'inner'), path.join(R, 'innerlink'), 'junction'); } catch (e) { LINK.inner = String(e && e.code || e); }

const ESC_LINK_ABS = path.join(R, 'link', 'SENTINEL.md');
const INNER_LINK_ABS = path.join(R, 'innerlink', 'target.md');

// ── C0 前置：夹具真实性 + 链接可用性读数（不因链接不可用而 fail）────────────────────
test('C0 前置：根内正例非空、根外哨兵带 gate: 行、链接构造读数', (t) => {
  for (const p of [path.join(R, 'plan', 'ok.md'), path.join(R, 'inner', 'target.md'), path.join(OUT, 'SENTINEL.md')]) {
    assert.equal(fs.existsSync(p), true, '夹具文件须存在: ' + p);
    assert.ok(fs.statSync(p).size > 0, '夹具文件须非空: ' + p);
  }
  assert.match(fs.readFileSync(path.join(OUT, 'SENTINEL.md'), 'utf8'), /gate: echo evil-outside/, '根外哨兵须含 gate: 行（可证伪前提）');
  t.diagnostic('junction 构造读数：' + JSON.stringify(LINK));
});

// ── C1 词法面（不依赖链接）：既有逃逸拒绝面逐条仍在 + 解权档 fail-closed ────────────────
test('C1 词法逃逸未被放宽（`..` / 根外绝对）+ 解权档 fail-closed（不存在目标/根 ⇒ false）', () => {
  // 阳性先行：根内相对 / 根内绝对 ⇒ 均可解析且可读
  for (const rel of ['plan/ok.md', path.join(R, 'plan', 'ok.md')]) {
    const abs = resolveArtifactIn(R, rel);
    assert.equal(fs.existsSync(abs), true, '阳性：根内产物须可解析且存在: ' + rel);
  }
  assert.equal(isArtifactInRoot(R, path.join(R, 'plan', 'ok.md')), true, '阳性：根内已落盘产物 ⇒ true');
  assert.equal(isInsideRootResolved(path.join(R, 'plan', 'ok.md'), R), true, '阳性：解权档对根内普通文件 ⇒ true');

  // 阴性：词法逃逸逐条仍拒（文案逐字保留）
  for (const rel of ['../outside.md', '../../outside2.md', 'plan/../../outside.md', path.join(BASE, 'evil.md'), 'D:outside.md']) {
    assert.throws(() => resolveArtifactIn(R, rel),
      (e) => e instanceof Error && /artifact path escapes batch root: /.test(e.message),
      '词法逃逸须 throw 且文案逐字保留: ' + rel);
  }
  assert.equal(isInsideRoot(path.join(BASE, 'evil.md'), R), false, '词法档对根外绝对路径仍为 false');

  // 解权档 fail-closed：目标不存在 / 根不可解 ⇒ false（不得 fail-open）
  assert.equal(isInsideRootResolved(path.join(R, 'does-not-exist.md'), R), false, '目标不存在 ⇒ false（fail-closed）');
  assert.equal(isInsideRootResolved(path.join(BASE, 'ghost', 'artifacts', 'b', 'x.md'), path.join(BASE, 'ghost', 'artifacts', 'b')), false,
    '根不存在且未开 allowMissing ⇒ false（fail-closed）');
  assert.equal(isArtifactInRoot(R, path.join(R, 'absent-but-legal.md')), true,
    '未落盘路径沿用既有 missing 语义（存在驱动：不判 escape，码不变）');
});

// ── C2 根内 junction → 根外：读面三消费点一律拒（且词法档仍 true，证解权档真的在工作）──
test('C2 根内 junction → 根外：resolveArtifactIn/throw、presenceJudge ok:false+OUTSIDE_ROOT、detectGate commands=[]', (t) => {
  if (LINK.esc !== 'ok') {
    t.skip('junction unavailable: ' + LINK.esc + '（该环境 containment 修正 verified=false，不伪造通过）');
    return;
  }
  // 前置：链接目标确实在根外且带 gate: 行（若判据放行，下面 commands 必非空）
  assert.equal(fs.existsSync(ESC_LINK_ABS), true, '前置：junction 可解析到根外哨兵');
  assert.match(fs.readFileSync(ESC_LINK_ABS, 'utf8'), /SENTINEL-OUTSIDE/, '前置：确实读到的是根外哨兵内容');

  // 阳性对照（同测试内、同一根）：根内普通产物 commands 非空 ⇒ 证明读面在工作，不是「一律空」
  assert.deepEqual(detectGate(R, ['plan/ok.md']).commands, ['echo from-inner'], '阳性对照：根内产物的 gate 行须被读出');

  // 词法档对链接仍判 true（证明修复不是把词法档改宽/改严，而是**补**了一层解权档）
  assert.equal(isInsideRoot(ESC_LINK_ABS, R), true, '词法档仍判「根内」（原有语义一字未改）');
  assert.equal(isInsideRootResolved(ESC_LINK_ABS, R), false, '解权档判「出根」');

  // ① 声明解析单点
  assert.throws(() => resolveArtifactIn(R, 'link/SENTINEL.md'),
    (e) => e instanceof Error && /artifact path escapes batch root: link\/SENTINEL\.md/.test(e.message),
    'junction 逃逸须 throw（文案逐字保留）');
  assert.equal(isArtifactInRoot(R, ESC_LINK_ABS), false, '已落盘的逃逸链接 ⇒ false');

  // ② 运行期判据
  const pv = presenceJudge({ mode: 'runtime', declared: ['link/SENTINEL.md'], abs: ESC_LINK_ABS, artifactsRoot: R });
  assert.equal(pv.ok, false, '逃逸链接不得 ok');
  assert.equal(pv.code, 'GATE_ARTIFACT_OUTSIDE_ROOT', '复用既有码（零新码）');
  assert.ok(pv.problems.some((p) => p.includes('outside batch artifacts root')), '问题行须明示出根');

  // ③ 命令门：0 条命令（根外内容未被读出）
  const g = detectGate(R, ['link/SENTINEL.md']);
  assert.deepEqual(g.commands, [], 'junction 逃逸产物不得产出任何命令（根外 gate: 行未被读）');
});

// ── C3 根内 junction → 根内：不误拒（阳性对照，防「一律拒链接」的假绿）──────────────────
test('C3 根内 junction → 根内目标：解权后仍在根内 ⇒ 不误拒（三消费点一致放行）', (t) => {
  if (LINK.inner !== 'ok') {
    t.skip('junction unavailable: ' + LINK.inner);
    return;
  }
  assert.equal(fs.existsSync(INNER_LINK_ABS), true, '前置：根内链接可解析');
  assert.equal(isInsideRootResolved(INNER_LINK_ABS, R), true, '根内→根内链接解权后仍在内 ⇒ true');
  assert.equal(isArtifactInRoot(R, INNER_LINK_ABS), true);

  const abs = resolveArtifactIn(R, 'innerlink/target.md');
  assert.match(fs.readFileSync(abs, 'utf8'), /SENTINEL-INNER-TARGET/, '根内链接可读且内容正确');

  const pv = presenceJudge({ mode: 'runtime', declared: ['innerlink/target.md'], abs: INNER_LINK_ABS, artifactsRoot: R });
  assert.equal(pv.ok, true, '根内链接不得被误判逃逸');
  assert.deepEqual(detectGate(R, ['innerlink/target.md']).commands, ['echo from-inner-link'], '根内链接的 gate 行须被读出');
});

// ── C4 写面单点 `resolveWriteTargetIn`：allowMissing 两侧对称 + 根外必拒 ─────────────────
test('C4 写面 allowMissing：产物根尚不存在仍判根内（不误拒）、根外目标必拒、根内 junction 目标必拒', (t) => {
  // ① 根**尚不存在**（Leader 直做修正面）：目标与根都不存在 ⇒ 仍须判根内并返回绝对路径
  const ghostRoot = path.join(BASE, 'ghost', 'sessions', SID, 'artifacts', 'b-ghost');
  assert.equal(fs.existsSync(ghostRoot), false, '前置：该产物根确实尚不存在');
  const target = path.join(ghostRoot, 'audit', 'event-log.md');
  assert.equal(resolveWriteTargetIn(ghostRoot, target), path.resolve(target), '根不存在时正常写入路径不得被判逃逸（误拒面已修）');
  // 对称性钉住：同一路径在**未开 allowMissing** 的解权档下必须是 false（证明差异只来自 allowMissing，而非放宽）
  assert.equal(isInsideRootResolved(target, ghostRoot), false, '未开 allowMissing ⇒ 目标不存在 ⇒ false（语义未放宽）');

  // ② 阳性对照：已存在的根内子目录（目标不存在）⇒ 放行
  const inRoot = path.join(R, 'audit', 'new-report.md');
  assert.equal(fs.existsSync(inRoot), false);
  assert.equal(resolveWriteTargetIn(R, inRoot), path.resolve(inRoot));

  // ③ 阴性：根外目标 ⇒ throw（文案逐字）
  const outside = path.join(BASE, 'evil-write.md');
  assert.throws(() => resolveWriteTargetIn(R, outside),
    (e) => e instanceof Error && e.message.startsWith('writeTo escapes artifacts dir: '),
    '根外目标须 throw 且文案逐字保留');

  // ④ 阴性：根内 junction 指向根外（写面）⇒ throw
  if (LINK.esc !== 'ok') {
    t.diagnostic('junction unavailable: ' + LINK.esc + ' ⇒ 写面链接用例未执行（verified=false）');
    return;
  }
  assert.throws(() => resolveWriteTargetIn(R, path.join(R, 'link', 'x.md')),
    (e) => e instanceof Error && e.message.startsWith('writeTo escapes artifacts dir: '),
    '经根内 junction 的写目标须被判逃逸');
  assert.equal(fs.existsSync(path.join(OUT, 'x.md')), false, '判据层不落盘（根外零文件）');
});
