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

// `task-27` 设计修正 —— 交接门开关从 **OS 环境变量** 改到 **插件热配置**（`<root>/config/runtime.json`）。
// ─────────────────────────────────────────────────────────────────────────────
// 背景（用户裁决）：「门禁应该**只与插件有关**，和父进程无关，也和 dsh 底座无关」——原实现读
//   `process.env.PSWARM_HANDOFF_GATE` ⇒ 被启动父进程的环境块绑架（Desktop 派生的 web 宿主环境块早于
//   变量设置 ⇒ 门永远开不了）。本套件验的就是：**改 runtime.json 即热生效、无需重启**。
// 覆盖：
//   HC-1 **entry 段热生效**（RED：关态派发放行 → 写 runtime.json `gates.handoff.entry=true` → reload →
//        同型派发被拒 `GATE_HANDOFF_MISSING`，**全程无重启**）
//   HC-2 **settle 段热生效**（同上口径：关态 merged 放行 → 开态 merged 被拒）
//   HC-3 **缺省仍关**（无 `gates` 键 ⇒ `source:'default'`、两段 false、行为零变化）
//   HC-4 **env 兜底 + runtime 优先**（纯函数面：env 可开；runtime 显式为 false 时压过 env）
//   HC-5 **渲染面可见门态**（`batch_status` 渲染含 `handoffGate=entry:on/settle:on(src:runtime)`）
//   HC-6 **渲染面可见 state 来源 + 取件信息**（`state=engine(legacy)`；`handoff_view` READY 显示 artifacts 路径
//        与 assertions，BLOCKED 显示三类缺口）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { createConfigWatcher } from '../lib/hot/config-watch.js';
import { handoffGateEnabledOf, handoffGateStateOf, HANDOFF_GATE_ENV } from '../lib/wave-plan.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeSyntheticTeam, threeTierSyntheticTeam } from './helpers/team-fixture.mjs';
import { clearRoleCache } from '../lib/assembly/flows.js';

const SESSION = 'sess-hotcfg';
const SESS = { agent: { session: { id: SESSION } } };
const TEAM = 'hotcfg-team';


/** DAG：p1 → e1 → e2 → a1（e1/e2 均有下游 ⇒ 出口门对二者均可判）。 */
function tasksChain() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], deps: ['p1'], cmd: 'build-it' },
    { id: 'e2', layer: 'exec', role: 'coder', consume: ['exec/e1.md'], outputs: ['exec/e2.md'], deps: ['e1'], cmd: 'build-more' },
    { id: 'a1', layer: 'audit', role: 'reviewer', consume: ['plan/spec.md', 'exec/e1.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify-it' },
  ];
}

/** 夹具：`runtime.json` watcher + 工具面（`readConfig` 与生产同源 = 热更快照）+ store（门禁经模块级快照读）。 */
function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-hotcfg-'));
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-hotcfg-teams-'));
  // F2：合成资产（最小三层）⇒ 走单点写入（'helpers/team-fixture.mjs'）。
  writeSyntheticTeam(teamsRoot, TEAM, threeTierSyntheticTeam(TEAM));
  clearRoleCache();
  // 环境隔离：本套件验的是 **runtime.json 热配置**路径 ⇒ 必须先中和**环境变量兜底**，
  //   否则 ambient env（实测本机就有 `PSWARM_HANDOFF_GATE=1`）会把「缺省关/只开一段」的用例污染成「两段全开」。
  //   这正是用户裁决要根治的形态（插件行为不该由父进程环境块决定）：测试里**显式**控制该兜底并还原。
  const savedEnv = process.env.PSWARM_HANDOFF_GATE;
  delete process.env.PSWARM_HANDOFF_GATE;
  const store = createStore(root);
  // 热更真源：与 `lib/index.js` 同构（fs.watch → 防抖 → 快照）；本套件用 useWatcher:false + `reload()` 取确定性
  const watcher = createConfigWatcher({ root, config: {}, useWatcher: false, logger: { info() {}, warn() {}, error() {} } });
  const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools } = createTools(ctx, { store, root, config: {}, readConfig: () => watcher.readSnapshot() });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, SESSION, { rationale: 'fixture：交接门热配置用例的建批前置评估（三层 DAG 多依赖 ⇒ C 档）' });
  return { root, store, byName, teamsRoot, watcher, savedEnv };
}

const runtimeFile = (root) => path.join(root, 'config', 'runtime.json');
/** 写 runtime.json + 显式 reload（等价于「防抖后快照更新」；生产为 fs.watch 自动触发） */
async function applyRuntime(h, overlay) {
  fs.mkdirSync(path.dirname(runtimeFile(h.root)), { recursive: true });
  fs.writeFileSync(runtimeFile(h.root), JSON.stringify(overlay, null, 2), 'utf8');
  await h.watcher.reload();
}
/** 复位：门全关（避免模块级快照污染同文件后续用例） */
async function resetGate(h) {
  await applyRuntime(h, { gates: { handoff: { entry: false, settle: false } } });
}
function cleanup(h) {
  try { h.watcher.stop(); } catch { /* 忽略 */ }
  if (h.savedEnv === undefined) delete process.env.PSWARM_HANDOFF_GATE;
  else process.env.PSWARM_HANDOFF_GATE = h.savedEnv; // 还原 ambient 兜底（不影响同文件后续用例的语义）
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.rmSync(h.teamsRoot, { recursive: true, force: true });
}
const seedArtifact = (h, batchId, rel, body = 'out') => {
  const abs = path.join(h.root, 'sessions', SESSION, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
};
async function mkBatch(h, batchId) {
  const out = await h.byName.wave_plan.execute({ batchId, team: TEAM, teamsRoot: h.teamsRoot, tasks: tasksChain(), assembly: { managerPlan: 'leader-direct', auditLane: 'a1' } }, SESS);
  await h.byName.batch_phase.execute({ batchId, phase: 'running' }, SESS);
  return out;
}
const renderText = (tool, args, value) => (tool.output.render(args, value) ?? []).map((b) => b.text ?? '').join('\n');

// ── HC-1 entry 段热生效（RED → GREEN，无重启）────────────────────────────────
test('HC-1 热生效：写 runtime.json gates.handoff.entry=true ⇒ entry 门**无需重启**即拦（RED→GREEN）', async () => {
  const h = makeHarness();
  try {
    await resetGate(h); // 起点：门关
    await mkBatch(h, 'hc1');
    seedArtifact(h, 'hc1', 'plan/spec.md');
    seedArtifact(h, 'hc1', 'exec/e1.md'); // e2 的 consume（否则热关后会被既有 consume 门拦，掩盖本门语义）
    // RED：门关 ⇒ e1 缺 p1 交接，仍**放行**（既有行为零变化）
    const red = await h.byName.member_status.execute({ batchId: 'hc1', lane: 'e1', status: 'running' }, SESS);
    assert.equal(red.lanes?.e1 ?? h.store.readBatch(SESSION, 'hc1').lanes.e1, 'running', 'RED：门关 ⇒ 派发放行');
    // 热开 entry（**不重启、不重建 store/tools**）
    await applyRuntime(h, { gates: { handoff: { entry: true } } });
    assert.equal(handoffGateEnabledOf(h.watcher.readSnapshot(), 'entry'), true, '前置：快照已开 entry');
    // GREEN：同型派发（e2 缺 e1 交接）⇒ 被交接门拒
    await assert.rejects(
      () => h.byName.member_status.execute({ batchId: 'hc1', lane: 'e2', status: 'running' }, SESS),
      /GATE_HANDOFF_MISSING/,
      'GREEN：热开 entry 后同型派发须被拒（无重启）',
    );
    // 再热关 ⇒ 恢复放行（可逆性：同一进程内两向翻转）
    await resetGate(h);
    await h.byName.member_status.execute({ batchId: 'hc1', lane: 'e2', status: 'running' }, SESS);
    assert.equal(h.store.readBatch(SESSION, 'hc1').lanes.e2, 'running', '热关后恢复放行（双向可逆）');
  } finally { cleanup(h); }
});

// ── HC-2 settle 段热生效（RED → GREEN，无重启）──────────────────────────────
test('HC-2 热生效：写 runtime.json gates.handoff.settle=true ⇒ 出口门**无需重启**即拦（RED→GREEN）', async () => {
  const h = makeHarness();
  try {
    await resetGate(h);
    await mkBatch(h, 'hc2');
    seedArtifact(h, 'hc2', 'plan/spec.md');
    seedArtifact(h, 'hc2', 'exec/e1.md');
    seedArtifact(h, 'hc2', 'exec/e2.md');
    // RED：门关 ⇒ e1（有下游 e2）无交接也可 merged
    await h.byName.member_status.execute({ batchId: 'hc2', lane: 'e1', status: 'running' }, SESS);
    await h.byName.member_status.execute({ batchId: 'hc2', lane: 'e1', status: 'review' }, SESS);
    const red = await h.byName.member_settle.execute({ batchId: 'hc2', lane: 'e1', status: 'merged' }, SESS);
    assert.equal(red.status, 'merged', 'RED：门关 ⇒ 出口门观察态（放行）');
    // 热开 settle
    await applyRuntime(h, { gates: { handoff: { settle: true } } });
    assert.equal(handoffGateEnabledOf(h.watcher.readSnapshot(), 'settle'), true, '前置：快照已开 settle');
    // GREEN：e2（有下游 a1）无交接 ⇒ merged 被拒
    await h.byName.member_status.execute({ batchId: 'hc2', lane: 'e2', status: 'running' }, SESS);
    await h.byName.member_status.execute({ batchId: 'hc2', lane: 'e2', status: 'review' }, SESS);
    await assert.rejects(
      () => h.byName.member_settle.execute({ batchId: 'hc2', lane: 'e2', status: 'merged' }, SESS),
      /GATE_HANDOFF_MISSING/,
      'GREEN：热开 settle 后同型 merged 须被拒（无重启）',
    );
  } finally { cleanup(h); }
});

// ── HC-3 缺省仍关 ────────────────────────────────────────────────────────────
test('HC-3 缺省仍关：无 gates 键 ⇒ source=default、两段 false、行为零变化', async () => {
  const h = makeHarness();
  try {
    const st = handoffGateStateOf(h.watcher.readSnapshot(), {});
    assert.deepEqual(st, { entry: false, settle: false, source: 'default' }, '缺省 ⇒ 两段关、来源 default');
    await mkBatch(h, 'hc3');
    seedArtifact(h, 'hc3', 'plan/spec.md');
    await h.byName.member_status.execute({ batchId: 'hc3', lane: 'e1', status: 'running' }, SESS);
    assert.equal(h.store.readBatch(SESSION, 'hc3').lanes.e1, 'running', '缺省关 ⇒ 派发不受交接门约束（零行为变化）');
  } finally { cleanup(h); }
});

// ── HC-4 env 兜底 + runtime 优先（纯函数面）──────────────────────────────────
test('HC-4 env 兜底有效；runtime 显式值**优先于** env', () => {
  // env 兜底（保留既有行为：'1'/'true'/'on' ⇒ 两段同开）
  assert.deepEqual(handoffGateStateOf({}, { [HANDOFF_GATE_ENV]: '1' }), { entry: true, settle: true, source: 'env' });
  assert.equal(handoffGateEnabledOf({}, 'settle', { [HANDOFF_GATE_ENV]: 'true' }), true);
  // runtime 优先：显式 false 压过 env=true
  assert.equal(handoffGateEnabledOf({ gates: { handoff: { entry: false, settle: false } } }, 'entry', { [HANDOFF_GATE_ENV]: '1' }), false,
    'runtime 显式 false 必须优先于 env');
  // 段级 `enabled` 作两段共同缺省；段级键覆盖之
  assert.deepEqual(handoffGateStateOf({ gates: { handoff: { enabled: true } } }), { entry: true, settle: true, source: 'runtime' });
  assert.deepEqual(handoffGateStateOf({ gates: { handoff: { enabled: true, settle: false } } }), { entry: true, settle: false, source: 'runtime' });
  // 段级只写一半（entry）且无 enabled ⇒ 该段显式、另一段走 env/缺省（**逐段独立**，不连坐）
  assert.deepEqual(handoffGateStateOf({ gates: { handoff: { entry: true } } }, {}), { entry: true, settle: false, source: 'runtime' });
  assert.deepEqual(handoffGateStateOf({ gates: { handoff: { entry: true } } }, { [HANDOFF_GATE_ENV]: '1' }), { entry: true, settle: true, source: 'runtime' },
    '未声明段走 env 兜底（逐段独立），显式段压过 env');
  // 非法形态（数组/字符串）⇒ 视同缺省，不抛
  assert.equal(handoffGateStateOf({ gates: { handoff: 'on' } }, {}).source, 'default');
  assert.equal(handoffGateStateOf({ gates: [] }, {}).source, 'default');
});

// ── HC-5 渲染面：门态可见（不止活在 schema）─────────────────────────────────
test('HC-5 渲染面：batch_status 渲染文本含门态（entry/settle + 来源）', async () => {
  const h = makeHarness();
  try {
    await applyRuntime(h, { gates: { handoff: { entry: true, settle: true } } });
    await mkBatch(h, 'hc5');
    const val = await h.byName.batch_status.execute({ batchId: 'hc5' }, SESS);
    const text = renderText(h.byName.batch_status, { batchId: 'hc5' }, val);
    assert.match(text, /handoffGate=entry:on\/settle:on\(src:runtime\)/, '渲染文本须显示门态 + 来源：实际=' + text);
    // 关态也可见（缺省关是策略、不得隐形）
    await resetGate(h);
    const val2 = await h.byName.batch_status.execute({ batchId: 'hc5' }, SESS);
    const text2 = renderText(h.byName.batch_status, { batchId: 'hc5' }, val2);
    assert.match(text2, /handoffGate=entry:off\/settle:off\(src:runtime\)/, '关态须同样可见：实际=' + text2);
  } finally { cleanup(h); }
});

// ── HC-6 渲染面：state 来源标注 + 取件信息（artifacts/assertions + 三类缺口）────
test('HC-6 渲染面：state=engine(legacy) 可见；handoff_view READY 显示 artifacts/assertions，BLOCKED 保留三类缺口', async () => {
  const h = makeHarness();
  try {
    await mkBatch(h, 'hc6');
    // state 来源标注（P2-B 两字段的消费者 = 渲染面）
    const v = await h.byName.batch_status.execute({ batchId: 'hc6' }, SESS);
    const text = renderText(h.byName.batch_status, { batchId: 'hc6' }, v);
    assert.match(text, /state=engine\(legacy\)/, '渲染文本须显示成员态来源（真源 = 官方 roster）：实际=' + text);
    // BLOCKED 态渲染：三类缺口齐（未交接 / artifacts 空 / contract.assertions@）
    const blocked = await h.byName.handoff_view.execute({ batchId: 'hc6', lane: 'e2' }, SESS);
    const bTxt = renderText(h.byName.handoff_view, { batchId: 'hc6', lane: 'e2' }, blocked);
    assert.match(bTxt, /BLOCKED/, bTxt);
    assert.match(bTxt, /e1 → pending/, '须显示入边与状态：' + bTxt);
    assert.match(bTxt, /\(未交接\)/, '缺口①须保留：' + bTxt);
    assert.match(bTxt, /\(artifacts 空\)/, '缺口②须保留：' + bTxt);
    assert.match(bTxt, /contract\.assertions@e1->e2/, '缺口③须保留：' + bTxt);
    // READY 态渲染：**下游能看到 artifacts 路径与 assertions**（M-7 验收核心）
    seedArtifact(h, 'hc6', 'exec/e1.md');
    await h.byName.handoff_submit.execute({ batchId: 'hc6', from: 'e1', to: 'e2', artifacts: ['exec/e1.md'], assertions: ['e1 产物可被 e2 直接消费'] }, SESS);
    const ready = await h.byName.handoff_view.execute({ batchId: 'hc6', lane: 'e2' }, SESS);
    const rTxt = renderText(h.byName.handoff_view, { batchId: 'hc6', lane: 'e2' }, ready);
    assert.match(rTxt, /READY/, rTxt);
    assert.match(rTxt, /exec\/e1\.md \(readable\)/, 'READY 态须显示 artifacts 路径 + 可读性：' + rTxt);
    assert.match(rTxt, /e1 产物可被 e2 直接消费/, 'READY 态须显示 assertions：' + rTxt);
  } finally { cleanup(h); }
});
