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

// test/command-script-anchor.test.js —— L8 判据脚本信任锚（**实现者自测面**；独立构造面归 tester）
// 批次 `punky-spec-adopt-p2-20261013` · lane `e3-l8-scriptrust`
// 覆盖：
//   A1 「RED-4 双次判定」：同一产物同一锚定，脚本**声明后被改** ⇒ 第一次（锚定相符）走正常退出码判定
//       `GATE_EXIT_NONZERO`，第二次（锚定不符）⇒ **执行前拒** `GATE_SCRIPT_CHANGED`。
//   A2 「旧行为（无锚定）放行」：同一被改脚本、产物**无**锚定行 ⇒ merged 放行（**命令门可被自我满足**的既成事实）
//       + 告警 `gate-script-unanchored`（S-3 口径：放行 + 可判告警）。
//   A3 S-2 锚定值伪造（脚本未改、锚定错）⇒ 拒（比对只认内容，不认写者）。
//   A4 S-4 位置告警（脚本落在 lane worktree 根内）⇒ **告警非拒**（`escape.kind` 原值）。
//   A5 S-5 非脚本命令（`node -e '…'`）⇒ **零感知**（无候选 ⇒ 无告警、不读锚定）。
//   A6 S-6 多脚本部分变更 ⇒ 恰被改的那一个被指认。
//   A0 解析面单测：`detectScriptAnchors` / `scriptTokensOf` / 行首锚定正则（内嵌/注释/畸形行不误判）。
//
// 说明：本套件用 `node scripts/*.js` 而非 `bash scripts/*.sh` —— 机制只认「解析根下存在的普通文件」
//   （与扩展名无关），用 node 可在无 bash 的宿主上稳定复跑（tester 侧若用 bash 形态属独立构造，同样有效）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createGates } from '../lib/state/gates.js';
// 直引 `gates/detect.js`（**单点**）：新增函数不经 `gates.js` 的 re-export 面转发 ——
//   `lib/state/gates.ts:68` 的转发清单**不在本 lane 写域**（写域 4 件不含 gates.ts）⇒ 不越界改它；
//   `command.ts` 亦直引 `./detect.js`（同一路径口径）。
import { detectScriptAnchors, scriptTokensOf, normalizeScriptKey, GATE_SCRIPT_SHA_RE } from '../lib/state/gates/detect.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-l8-script-'));
const store = createStore(root);
const SID = 's-l8';

const TASKS = [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/report.md'], cmd: 'code', deps: ['p1'] },
  { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md'], produce: ['audit/accept.md'], cmd: 'review', deps: ['e1'] },
];
const SPEC_OK = '# Spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- done\n## 约束\n- none\n';

function makePlan(batchId) {
  const plan = buildWavePlan({ batchId, tasks: TASKS, team: 'punky-preset' });
  store.createBatch(SID, { batchId, wavePlan: plan, concurrency: plan.concurrency });
  return plan;
}
function art(batchId, rel, content) {
  const abs = path.join(root, 'sessions', SID, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
// lane worktree 根（= `commandCwd` 第一优先；存在即为解析根）——「lane 在其 cwd 放脚本」的可达构造
function laneRoot(batchId) { return path.join(root, 'sessions', SID, 'worktrees', batchId, 'e1'); }
function putScript(batchId, rel, body) {
  const abs = path.join(laneRoot(batchId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}
const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function set(session, batchId, lane, to, note) {
  try { return store.setMember(session, batchId, lane, to, note); }
  catch (e) { return e; }
}
function execToReview(batchId) {
  const r1 = set(SID, batchId, 'e1', 'running');
  if (r1 instanceof Error) return r1;
  return set(SID, batchId, 'e1', 'review');
}
// 到达命令门：running → review → merged（命令门在 merged 前置判定）
function mergeLane(batchId) {
  const r = execToReview(batchId);
  if (r instanceof Error) return r;
  return set(SID, batchId, 'e1', 'merged');
}
function blockedEvent(batchId, code) {
  return store.readBatch(SID, batchId).events.find((e) => e.type === 'gate.exit_blocked' && e.code === code);
}
/** 命令门成功返回侧的告警载荷：单条走 `escape`，多条走 `escapes[]`（两通道互斥，见 command.ts） */
function warningsOf(res) {
  if (!res || typeof res !== 'object') return [];
  const out = [];
  if (res.escape && typeof res.escape === 'object') out.push(res.escape);
  if (Array.isArray(res.escapes)) out.push(...res.escapes);
  return out;
}

// ── A0 解析面（纯函数）────────────────────────────────────────────────────────────────────────
test('A0 解析面：锚定行族（行首独立行）∥ 命令 token 切分 ∥ 键归一', () => {
  const dir = art('b-l8-parse', 'exec/parse.md', [
    '# 报告',
    '# gate-script-sha256: scripts/x.js=' + 'a'.repeat(64),        // 注释行不命中
    'inline gate-script-sha256: scripts/y.js=' + 'b'.repeat(64),   // 非行首不命中
    'gate-script-sha256: scripts/a.js=' + 'A'.repeat(64),          // 大写 hex 不命中（形态冻结为小写 64 hex）
    'gate-script-sha256: scripts/short.js=' + 'c'.repeat(63),      // 长度不符不命中
    'gate-script-sha256: scripts/ok.js=' + 'd'.repeat(64),         // 命中
    'gate-script-sha256: .\\win\\path.js=' + 'e'.repeat(64),        // 命中（反斜杠归一）
    'gate-script-sha256: scripts/ok.js=' + 'f'.repeat(64),         // 同键第二次：**首取**（后行不改判定）
    '',
  ].join('\n'));
  const r = detectScriptAnchors(path.dirname(path.dirname(dir)), ['exec/parse.md']);
  assert.deepEqual(Object.keys(r.anchors).sort(), ['scripts/ok.js', 'win/path.js'], JSON.stringify(r.anchors));
  assert.equal(r.anchors['scripts/ok.js'], 'd'.repeat(64), '同键取首（追加行不得覆盖既有锚定）');
  assert.equal(r.path, 'exec/parse.md');
  assert.equal(detectScriptAnchors(path.dirname(path.dirname(dir)), []).path, null, '空 paths 零感知');
  // 正则单独复核（独立行 + 行首锚定）
  GATE_SCRIPT_SHA_RE.lastIndex = 0;
  assert.equal(('gate-script-sha256: a.js=' + '1'.repeat(64)).match(GATE_SCRIPT_SHA_RE)?.length, 1);
  GATE_SCRIPT_SHA_RE.lastIndex = 0;
  assert.equal(('x gate-script-sha256: a.js=' + '1'.repeat(64)).match(GATE_SCRIPT_SHA_RE), null);
  // token 切分：去引号 / 跳选项 / 空 token 跳过
  assert.deepEqual(scriptTokensOf('node scripts/check.js'), ['node', 'scripts/check.js']);
  assert.deepEqual(scriptTokensOf('node -e "process.exit(0)"'), ['node', 'process.exit(0)']);
  assert.deepEqual(scriptTokensOf('bash ./scripts/x.sh --flag'), ['bash', './scripts/x.sh']);
  assert.deepEqual(scriptTokensOf(''), []);
  // 键归一
  assert.equal(normalizeScriptKey('.\\a\\b.js'), 'a/b.js');
  assert.equal(normalizeScriptKey('./a/b.js/'), 'a/b.js');
});

// ── A1 RED-4 双次判定（本 lane 的核心反例）──────────────────────────────────────────────────────
test('A1 RED-4：同产物同锚定，脚本声明后被改 ⇒ 改前走退出码判定、改后**执行前拒** GATE_SCRIPT_CHANGED', () => {
  const B = 'b-l8-red4';
  makePlan(B);
  art(B, 'plan/spec.md', SPEC_OK);
  const script = putScript(B, 'scripts/check.js', 'process.exit(1);\n'); // v1：会失败
  const anchor = sha256Of(script);
  art(B, 'exec/report.md', '# 报告\ngate: node scripts/check.js\ngate-script-sha256: scripts/check.js=' + anchor + '\n');

  // 第一次：脚本 = v1，锚定相符 ⇒ **照常执行** ⇒ 退出码判定（1 ⇒ 拒 GATE_EXIT_NONZERO）——证锚定层不改退出码语义
  const r1 = mergeLane(B);
  assert.ok(r1 instanceof Error && /GATE_EXIT_NONZERO/.test(r1.message), '锚定相符 ⇒ 走既有退出码判定：' + String(r1 && r1.message));
  assert.ok(blockedEvent(B, 'GATE_EXIT_NONZERO'), 'exit_blocked 记 GATE_EXIT_NONZERO');
  assert.equal(store.readBatch(SID, B).lanes.e1, 'review', '失败 lane 留 review');

  // 改脚本使其**恒 exit 0**（不改锚定行）——这正是「命令门被自我满足」的构造
  putScript(B, 'scripts/check.js', 'process.exit(0);\n');
  const r2 = set(SID, B, 'e1', 'merged');
  assert.ok(r2 instanceof Error && /GATE_SCRIPT_CHANGED/.test(r2.message), '锚定不符 ⇒ 拒：' + String(r2 && r2.message));
  const ev = blockedEvent(B, 'GATE_SCRIPT_CHANGED');
  assert.ok(ev, 'exit_blocked 记 GATE_SCRIPT_CHANGED');
  assert.ok(String(ev.detail || '').includes('scripts/check.js'), '指认被改脚本：' + String(ev.detail));
  assert.equal(ev.exitCode, null, '执行前拒 ⇒ 无退出码');
  assert.equal(store.readBatch(SID, B).lanes.e1, 'review', '拒后 lane 不落终态');
});

// ── A2 旧行为（无锚定）⇒ 放行（零回归）+ 可判告警 ──────────────────────────────────────────────
test('A2 无锚定 ⇒ 放行（零回归）+ 告警 gate-script-unanchored（S-3：命令门可被自我满足的既成事实）', () => {
  const B = 'b-l8-noanchor';
  makePlan(B);
  art(B, 'plan/spec.md', SPEC_OK);
  putScript(B, 'scripts/always-ok.js', 'process.exit(0);\n'); // 恒真脚本
  art(B, 'exec/report.md', '# 报告\ngate: node scripts/always-ok.js\n');
  const r = mergeLane(B);
  assert.ok(!(r instanceof Error), '无锚定 ⇒ 放行（不新增拒态）：' + String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  const ev = r.events.find((e) => e.type === 'gate.exit');
  assert.ok(ev && ev.results[0].exitCode === 0, '命令真执行且 exit 0：' + JSON.stringify(ev && ev.results));
  // 告警可判（事件侧）：本产物落在 lane worktree 根内 + 无锚定 ⇒ 两条告警 ⇒ escapes[] 多值通道
  const esc = r.events.filter((e) => e.type === 'gate.escape');
  const kinds = esc.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['gate-script-lane-local', 'gate-script-unanchored'], '告警留痕：' + JSON.stringify(esc));
});

// ── A3 锚定值伪造（脚本未改、锚定错）⇒ 拒 ──────────────────────────────────────────────────────
test('A3 S-2 锚定值伪造：脚本未改但锚定错 ⇒ 拒（比对只认内容，不认写者）', () => {
  const B = 'b-l8-forge';
  makePlan(B);
  art(B, 'plan/spec.md', SPEC_OK);
  putScript(B, 'scripts/check.js', 'process.exit(0);\n');
  art(B, 'exec/report.md', '# 报告\ngate: node scripts/check.js\ngate-script-sha256: scripts/check.js=' + 'a'.repeat(64) + '\n');
  const r = mergeLane(B);
  assert.ok(r instanceof Error && /GATE_SCRIPT_CHANGED/.test(r.message), String(r && r.message));
  const ev = blockedEvent(B, 'GATE_SCRIPT_CHANGED');
  assert.equal(ev.exitCode, null, '执行前拒 ⇒ 无退出码');
  // 事件载荷面：`gate.exit_blocked` 只透传 {code,command,exitCode,detail,escalation}（写端 member-gates.js:159）
  //   ⇒ 诊断字段（script/expected/actual）经 `detail` **文本**承载；**结构字段**读数见 A8（直调原始返回）。
  assert.ok(String(ev.detail).includes('a'.repeat(12)), 'detail 回显声明值前缀：' + String(ev.detail));
  assert.ok(String(ev.detail).includes('实得'), 'detail 回显实得值：' + String(ev.detail));
});

// ── A4 位置告警（非拒）────────────────────────────────────────────────────────────────────────
test('A4 S-4 位置缺口：脚本落在 lane worktree 根内 ⇒ 告警（escape.kind）非拒，锚定相符照常执行', () => {
  const B = 'b-l8-local';
  makePlan(B);
  art(B, 'plan/spec.md', SPEC_OK);
  const script = putScript(B, 'scripts/check.js', 'process.exit(0);\n');
  art(B, 'exec/report.md', '# 报告\ngate: node scripts/check.js\ngate-script-sha256: scripts/check.js=' + sha256Of(script) + '\n');
  const r = mergeLane(B);
  assert.ok(!(r instanceof Error), '位置缺口**不拒**：' + String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  const esc = r.events.filter((e) => e.type === 'gate.escape');
  assert.equal(esc.length, 1, '恰一条告警（锚定相符 ⇒ 无 unanchored）：' + JSON.stringify(esc));
  assert.equal(esc[0].kind, 'gate-script-lane-local', 'escape.kind 原值');
  assert.ok(String(esc[0].reason || '').includes('位置缺口'), String(esc[0].reason));
});

// ── A5 非脚本命令 ⇒ 零感知 ────────────────────────────────────────────────────────────────────
test('A5 S-5 非脚本命令（node -e）⇒ 零感知：无候选 ⇒ 不读锚定、不产任何 gate-script-* 告警', () => {
  const B = 'b-l8-nofile';
  makePlan(B);
  art(B, 'plan/spec.md', SPEC_OK);
  putScript(B, 'scripts/unused.js', 'process.exit(0);\n');
  // 即便声明了一个**不被引用**的锚定行，也不应触发任何告警（无候选 ⇒ 锚定面不参与）
  art(B, 'exec/report.md', '# 报告\ngate: node -e "process.exit(0)"\ngate-script-sha256: scripts/unused.js=' + 'a'.repeat(64) + '\n');
  const r = mergeLane(B);
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  const esc = r.events.filter((e) => e.type === 'gate.escape');
  assert.deepEqual(esc, [], '零感知（无 gate-script-* 告警）：' + JSON.stringify(esc));
});

// ── A6 多脚本部分变更 ⇒ 恰该脚本被指认 ────────────────────────────────────────────────────────
test('A6 S-6 多脚本：两条锚定各一行、只改其一 ⇒ 恰被改脚本被拒（另一不受影响）', () => {
  const B = 'b-l8-multi';
  makePlan(B);
  art(B, 'plan/spec.md', SPEC_OK);
  const a = putScript(B, 'scripts/a.js', 'process.exit(0);\n');
  const b = putScript(B, 'scripts/b.js', 'process.exit(0);\n');
  art(B, 'exec/report.md', '# 报告\ngate: node scripts/a.js && node scripts/b.js\n'
    + 'gate-script-sha256: scripts/a.js=' + sha256Of(a) + '\n'
    + 'gate-script-sha256: scripts/b.js=' + sha256Of(b) + '\n');
  // 只改 b.js（a.js 与锚定仍相符）
  putScript(B, 'scripts/b.js', 'process.exit(0); // changed\n');
  const r = mergeLane(B);
  assert.ok(r instanceof Error && /GATE_SCRIPT_CHANGED/.test(r.message), String(r && r.message));
  const ev = blockedEvent(B, 'GATE_SCRIPT_CHANGED');
  assert.equal(ev.exitCode, null, '执行前拒 ⇒ 无退出码');
  assert.ok(String(ev.detail).includes('scripts/b.js'), '恰指认被改脚本：' + String(ev.detail));
  assert.ok(!String(ev.detail).includes('scripts/a.js'), '未改脚本不被指认：' + String(ev.detail));
  // 把 b.js 改回锚定内容 ⇒ 放行（**非终态**：可返工修复）
  putScript(B, 'scripts/b.js', 'process.exit(0);\n');
  const r2 = set(SID, B, 'e1', 'merged');
  assert.ok(!(r2 instanceof Error), '修回与锚定一致 ⇒ 放行：' + String(r2 && r2.message));
  assert.equal(r2.lanes.e1, 'merged');
});

// ── A8 直接判定面（**原始返回**读数 + 「执行前拒 ⇒ 零命令被执行」证明）──────────────────────────
// 与 A1-A7（经 `setMember` 状态机驱动）互补：本用例直调 `checkCommandGate` 取**返回值原值**
//   （包 AC-11/AC-14 的读数形态 = 「判定路径原值」/「escape.kind 原值」；A3/A6 已说明事件侧只透传 detail）。
test('A8 直调原始返回：锚定相符 ⇒ 执行+mock 计数 1；改脚本 ⇒ GATE_SCRIPT_CHANGED 且 **mock 计数 0**', () => {
  const B = 'b-l8-direct';
  makePlan(B);
  art(B, 'plan/spec.md', SPEC_OK);
  const script = putScript(B, 'scripts/check.js', 'process.exit(1);\n');
  const anchor = sha256Of(script);
  art(B, 'exec/report.md', '# 报告\ngate: node scripts/check.js\ngate-script-sha256: scripts/check.js=' + anchor + '\n');
  const gates = createGates(root);
  const calls = [];
  const mockRun = (req) => { calls.push(req); return { ok: true, exitCode: 0, durationMs: 1, truncated: false }; };

  // ① 锚定相符 ⇒ 照常执行（mock 恰 1 次）；位置告警**单条** ⇒ 走单值 `escape`（多值通道**不占**）
  const ok1 = gates.checkCommandGate(SID, B, store.readBatch(SID, B), 'e1', { runCommand: mockRun });
  assert.equal(ok1.ok, true, JSON.stringify(ok1));
  assert.deepEqual(ok1.commands, ['node scripts/check.js']);
  assert.equal(calls.length, 1, '锚定相符 ⇒ 命令真被执行');
  assert.equal(ok1.escape.kind, 'gate-script-lane-local', '判定路径原值（单值通道）：' + JSON.stringify(ok1.escape));
  assert.equal(ok1.escapes, undefined, '单条告警**不**并用多值通道（防双事件）');

  // ② 改脚本使其恒 exit 0（不改锚定）⇒ 拒：码名/字段原值 + **mock 零调用**（执行前拒）
  calls.length = 0;
  putScript(B, 'scripts/check.js', 'process.exit(0);\n');
  const bad = gates.checkCommandGate(SID, B, store.readBatch(SID, B), 'e1', { runCommand: mockRun });
  assert.equal(bad.ok, false, JSON.stringify(bad));
  assert.equal(bad.code, 'GATE_SCRIPT_CHANGED', '码名原值');
  assert.equal(bad.exitCode, null);
  assert.equal(bad.script, 'scripts/check.js');
  assert.equal(bad.expected, anchor, '回显声明值');
  assert.notEqual(bad.actual, anchor, '回显实得值（内容比对）');
  assert.equal(bad.declared, true);
  assert.equal(calls.length, 0, '**执行前拒 ⇒ 零命令被执行**（预扫先于执行循环）');
  // ③ 修回锚定内容 ⇒ 同一 lane 可放行（**非终态**：拒不烧 lane）
  putScript(B, 'scripts/check.js', 'process.exit(1);\n');
  const ok2 = gates.checkCommandGate(SID, B, store.readBatch(SID, B), 'e1', { runCommand: mockRun });
  assert.equal(ok2.ok, true, JSON.stringify(ok2));
  assert.equal(calls.length, 1, '修回后照常执行');
});

// ── A7 告警通道互斥（单条 ⇒ escape；多条 ⇒ escapes[]）─────────────────────────────────────────
test('A7 告警通道互斥：单条走 escape、多条走 escapes[]（避免 gateEscapeEvents 合并 ⇒ 同事实双事件）', () => {
  const B = 'b-l8-chan';
  makePlan(B);
  art(B, 'plan/spec.md', SPEC_OK);
  // 解析根 = artifacts 根（本批不建 lane worktree 目录）⇒ 脚本落在产物根内（位置告警）且无锚定（unanchored）⇒ 2 条
  const abs = art(B, 'scripts/two.js', 'process.exit(0);\n');
  art(B, 'exec/report.md', '# 报告\ngate: node scripts/two.js\n');
  const r = mergeLane(B);
  assert.ok(!(r instanceof Error), String(r && r.message));
  assert.equal(r.lanes.e1, 'merged');
  const esc = r.events.filter((e) => e.type === 'gate.escape');
  assert.equal(esc.length, 2, '两条告警各一事件（**无重复**）：' + JSON.stringify(esc));
  assert.deepEqual(esc.map((e) => e.kind).sort(), ['gate-script-lane-local', 'gate-script-unanchored']);
  assert.equal(fs.existsSync(abs), true);
});
