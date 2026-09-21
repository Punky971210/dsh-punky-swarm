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

// A-① 端到端接线用例（批 core-pending-a-20260915 · lane e1）
//
// 被检缺陷：`config.ratchet`（棘轮覆盖表）在**生产装配链路**不可达——装配点 `lib/index.js:108-112`
//   的 `createStore(root, { onStateChange })` 未透传 `rules`，读点 `lib/state/store.js:155`
//   的 `rules ?? loadRules()` 恒走无参分支 ⇒ `config.ratchet` 写了不生效（引擎级死配置）。
//
// 判别设计（**防「恒绿假过」**）：只断言「抛错」在未修复态也会抛（基线拒因 = entry 门 consume 缺件），
//   故本用例断言的是**码字可区分**——同一批、同一调用序列：
//     · 无 `ratchet` ⇒ 棘轮判定点放行（默认表允许 pending -> running）⇒ 拒因落到 entry 门 `GATE_ENTRY_MISSING`；
//     · `ratchet.memberRules.pending` 收紧到**删掉 `running` 出口** ⇒ 拒因前移到棘轮判定点
//       `invalid member transition: pending -> running`（`lib/state/store.js:462-463`，**先于** entry 门 `:485`）。
//   未修复态下（rules 未注入）注入面恒为默认表 ⇒ 两种装配都落 `GATE_ENTRY_MISSING` ⇒ E1-b 必红。
//   ⚠ 判据口径修正（与规格 core-spec §落点 的差异，以代码为准）：规格示例写 `pending: ['running']`，
//     但 `MEMBER_TRANSITIONS.pending = ['running','failed','skipped']`（`lib/schema.ts:39`）⇒ 该覆盖表
//     **仍允许** pending -> running（是「删掉 failed/skipped」，不是收紧 running）。故本用例取
//     `pending: ['failed']`（合法子集 + 真删掉 running 出口），判别性由此成立。
//
// 为什么必须走 `apply()` 装配点：函数级语义（`test/machine.test.js`）与 store 级注入（`test/lifecycle.test.js`
//   R2b `:184-193`）**早已绿**——但 R2b 的 `rules` 是测试自己传给 `createStore` 的，绕过了 `lib/index.js`
//   这条唯一的断链 ⇒ 强制不了本缺陷。装配级探针是唯一能红的形态。
//
// 隔离（硬要求）：`apply()` 以裸调触发 `syncAssets()`（`lib/assets.js`）写 `<home>/.agents/skills`、
//   `<home>/.dsh/.agent-presets`，且会挂 hotConfig watcher ⇒ 探针必须在**子进程 + 隔离
//   USERPROFILE/HOME/DSH_HOME** 下执行（先例：`test/auditlog-mount.test.js:320-350`）。**真实用户目录零写入**。
//
// G1 前置清障（纪律）：`member_status.execute` 内先走 `assertMemberActionTierC`（`lib/tools/core.js:599`）
//   ⇒ 调用方会话必须已评估为 C（否则 `GATE_MEMBER_REQUIRES_C` 会吞掉被检面）。探针用共享种子
//   `test/helpers/gate-fixture.mjs` 的 `assessC`（与 `assign_check({difficulty:'C'})` 同一落盘函数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRules, DEFAULT_MEMBER_RULES, DEFAULT_BATCH_RULES } from '../lib/state/machine-rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const INDEX_JS = path.join(PKG, 'lib', 'index.js');
const STORE_JS = path.join(PKG, 'lib', 'state', 'store.js');
const WAVEPLAN_JS = path.join(PKG, 'lib', 'wave-plan.js');
const FIXTURE_MJS = path.join(PKG, 'test', 'helpers', 'gate-fixture.mjs');

// ── 隔离根清理（进程退出即回收；只在 os.tmpdir() 下建目录）──
const pendingRoots = [];
process.on('exit', () => {
  for (const d of pendingRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ } }
});
function freshRootTracked(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-ratchet-wiring-' + tag + '-'));
  pendingRoots.push(d);
  return d;
}

// ── 探测体（写入临时文件，不落仓库；被测模块经绝对 file:// URL 导入）──
const PROBE_SOURCE = `import path from 'node:path';
import { pathToFileURL } from 'node:url';

const asUrl = (p) => pathToFileURL(p).href;
const out = { ok: false };
try {
  const { apply } = await import(asUrl(process.env.PUNKY_PROBE_INDEX));
  const { createStore } = await import(asUrl(process.env.PUNKY_PROBE_STORE));
  const { buildWavePlan } = await import(asUrl(process.env.PUNKY_PROBE_WAVEPLAN));
  const { assessC } = await import(asUrl(process.env.PUNKY_PROBE_FIXTURE));

  const ROOT = process.env.PUNKY_PROBE_ROOT;
  const SID = process.env.PUNKY_PROBE_SESSION;
  const BID = process.env.PUNKY_PROBE_BATCH;
  const RAW = process.env.PUNKY_PROBE_RATCHET;
  // leader-direct：退出 G2（raise 缺省）「未登记 Manager 不得派 exec」的前置门，使基线拒因**唯一**
  //   落在 entry 门的 consume 缺件上（可区分性不被另一道门噪化）
  const ASM = { managerPlan: 'leader-direct', auditLane: 'a1' };

  const captured = [];
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(t) { captured.push(t); } },
    emit() {},
    on() { return () => {}; },
    webServer: { register(r) { routes.push(r); return () => {}; } },
  };
  const config = { root: ROOT };
  if (RAW && RAW !== 'none') config.ratchet = JSON.parse(RAW);

  let dispose = null;
  out.applyThrew = false;
  try {
    dispose = apply(ctx, config);
  } catch (e) {
    out.applyThrew = true;
    out.applyMessage = String(e && e.message);
  }
  out.toolCount = captured.length;
  if (!out.applyThrew) {
    // 造数据 store（**不带 rules**：只用于播种批次/治理，与工具 store 经文件交换；不构成被检面）
    const aux = createStore(ROOT);
    assessC(aux, SID, { rationale: 'fixture：ratchet 接线装配级探针前置评估（成员面写动作 ⇒ C 档）' });
    const tasks = [
      { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
      // e1 的 consume **刻意不落盘** ⇒ 基线路径必然停在 entry 门缺件（判据来源）
      { id: 'e1', layer: 'exec', consume: ['exec/e1/absent.md'], outputs: ['exec/e1/out.md'], deps: ['p1'], cmd: 'run' },
      { id: 'a1', layer: 'audit', consume: ['plan/spec.md'], produce: ['audit/a1.md'], deps: ['e1'], cmd: 'review' },
    ];
    const plan = buildWavePlan({ batchId: BID, tasks: tasks, assembly: ASM });
    aux.createBatch(SID, { batchId: BID, wavePlan: plan, phase: 'running', assembly: ASM });

    const exec = { agent: { session: { id: SID } } };
    const toolOf = (n) => captured.find((t) => t && t.name === n);
    const ms = toolOf('member_status');
    const bp = toolOf('batch_phase');
    out.hasMemberTool = !!ms;
    out.hasBatchTool = !!bp;

    try {
      await ms.execute({ batchId: BID, lane: 'e1', status: 'running', session: SID }, exec);
      out.memberThrew = false;
      out.memberMessage = null;
    } catch (e) {
      out.memberThrew = true;
      out.memberMessage = String(e && e.message);
    }
    const afterMember = aux.readBatch(SID, BID);
    out.laneState = afterMember.lanes.e1;
    out.entryGateEvents = (afterMember.events || []).filter((e) => e.type === 'gate.entry.missing').length;

    try {
      await bp.execute({ batchId: BID, phase: 'complete', session: SID }, exec);
      out.batchThrew = false;
      out.batchMessage = null;
    } catch (e) {
      out.batchThrew = true;
      out.batchMessage = String(e && e.message);
    }
    out.phase = aux.readBatch(SID, BID).phase;
    try { dispose(); } catch (e) { out.disposeError = String(e && e.message); }
  }
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String((e && e.stack) || e);
}
process.stdout.write('\\n__PROBE_JSON__' + JSON.stringify(out) + '\\n');
process.exit(0);
`;

let probePath = null;
function probeFile() {
  if (!probePath) {
    probePath = path.join(freshRootTracked('probe'), 'probe.mjs');
    fs.writeFileSync(probePath, PROBE_SOURCE, 'utf8');
  }
  return probePath;
}

/** 装配级探针执行：隔离 HOME/DSH_HOME 子进程（真实用户目录零写入）。
 *  ratchet === undefined ⇒ 不传 `config.ratchet`（基线）；其余按 JSON 注入。 */
function runProbe(tag, ratchet) {
  const root = freshRootTracked(tag);
  const home = path.join(root, 'user');
  const dshHome = path.join(root, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  const childEnv = {
    ...process.env,
    USERPROFILE: home, // 隔离①②：apply()→syncAssets() 只写隔离 HOME
    HOME: home,
    DSH_HOME: dshHome, // 隔离③：审计 sink 等 DSH_HOME 派生面
    PUNKY_PROBE_INDEX: INDEX_JS,
    PUNKY_PROBE_STORE: STORE_JS,
    PUNKY_PROBE_WAVEPLAN: WAVEPLAN_JS,
    PUNKY_PROBE_FIXTURE: FIXTURE_MJS,
    PUNKY_PROBE_ROOT: path.join(root, 'engine'),
    PUNKY_PROBE_SESSION: 'sess-ratchet-wiring',
    PUNKY_PROBE_BATCH: 'rw-' + tag,
    PUNKY_PROBE_RATCHET: ratchet === undefined ? 'none' : JSON.stringify(ratchet),
  };
  const stdout = execFileSync(process.execPath, [probeFile()], { env: childEnv, encoding: 'utf8', timeout: 180000 });
  const marker = '__PROBE_JSON__';
  const idx = stdout.lastIndexOf(marker);
  assert.ok(idx >= 0, '探测体必须输出结果标记（实际 stdout 尾部: ' + stdout.slice(-500) + '）');
  const out = JSON.parse(stdout.slice(idx + marker.length).split('\n')[0]);
  out.__stdout = stdout;
  out.__root = root;
  return out;
}

// 收紧覆盖表：`pending` 默认出口 = ['running','failed','skipped'] ⇒ ['failed'] 是**合法子集**（棘轮只许删）
//   且真的删掉了 `running` 出口 ⇒ pending -> running 被棘轮判定点拒（而非被 entry 门拒）。
const SHRINK_MEMBER = { memberRules: { pending: ['failed'] } };
const SHRINK_BATCH = { batchRules: { running: ['paused'] } };

// ── E1-a 基线：无 ratchet ⇒ 拒因落在 entry 门（缺件），lane 零写入 ──
test('E1-a 基线（不传 config.ratchet）：装配可跑通，拒因 = entry 门 consume 缺件', () => {
  const out = runProbe('base', undefined);
  assert.equal(out.ok, true, '探针自身必须成功（实际: ' + JSON.stringify(out.error ?? null) + '）');
  assert.equal(out.applyThrew, false, '缺省 config 下 apply() 不得抛错');
  assert.ok(out.toolCount > 0, '装配点必须注册工具（实际 ' + out.toolCount + '）');
  assert.equal(out.hasMemberTool, true, 'member_status 必须经装配点注册');
  assert.equal(out.memberThrew, true, '基线路径必须被拒（该 lane 的 consume 刻意未落盘）');
  assert.match(out.memberMessage, /^GATE_ENTRY_MISSING: exec\/e1\/absent\.md$/, '基线拒因 = entry 门 consume 缺件（码字 + 缺件清单）');
  assert.equal(out.laneState, 'pending', '被拒 ⇒ lane 状态零变更');
  assert.ok(out.entryGateEvents >= 1, 'entry 门拒派须留痕 gate.entry.missing');
});

// ── E1-b 注入生效（本用例的最小可判别形态）：同输入、码字不同 ──
test('E1-b 注入生效：ratchet.memberRules 收紧 ⇒ 拒因前移到棘轮判定点（≠ 基线码字）', () => {
  const base = runProbe('b-base', undefined);
  const inj = runProbe('b-inject', SHRINK_MEMBER);
  assert.equal(inj.ok, true, '探针自身必须成功（实际: ' + JSON.stringify(inj.error ?? null) + '）');
  assert.equal(inj.applyThrew, false, '合法收紧配置不得在装配期抛错');

  // 判别性核心：同一次调用、同一构造，两种装配给出**不同码字**
  assert.match(inj.memberMessage, /^invalid member transition: pending -> running$/,
    '注入收紧后必须由棘轮判定点拒（store.js:462-463）：' + String(inj.memberMessage));
  assert.doesNotMatch(inj.memberMessage, /GATE_ENTRY_MISSING/,
    '注入生效时不得再落到 entry 门（否则与未修复态不可区分 = 恒绿）');
  assert.notEqual(inj.memberMessage, base.memberMessage,
    '注入前后的拒因码字必须不同（未修复态两者同为 GATE_ENTRY_MISSING ⇒ 本断言红）');

  // 零写入证据：棘轮拒在 entry 门之前 throw ⇒ 不落盘、不改 batch、不产 entry 缺件事件
  assert.equal(inj.laneState, 'pending', '棘轮拒派 ⇒ lane 仍 pending（零写入）');
  assert.equal(inj.entryGateEvents, 0, '棘轮判定点拒 ⇒ 不得产 gate.entry.missing（未走到 entry 门）');
});

// ── E1-c 第二消费点（批次面）+ 面间独立性 ──
test('E1-c 批次面注入：ratchet.batchRules 收紧 ⇒ 拒因落在 store.js:690（批次阶段迁移）', () => {
  const base = runProbe('c-base', undefined);
  const inj = runProbe('c-inject', SHRINK_BATCH);
  assert.equal(inj.ok, true, '探针自身必须成功（实际: ' + JSON.stringify(inj.error ?? null) + '）');
  assert.match(inj.batchMessage, /^invalid batch phase transition: running -> complete$/,
    '注入 batchRules 后必须由批次阶段棘轮判定点拒：' + String(inj.batchMessage));
  assert.equal(inj.phase, 'running', '批次阶段拒 ⇒ 状态零变更');

  // 面间独立：只收紧 batch 面 ⇒ member 面与基线逐字相同（证明注入按面生效，而非「全局乱拒」）
  assert.equal(inj.memberMessage, base.memberMessage, 'batch 面收紧不得影响 member 面拒因（面间独立）');
  // 反向对照：基线（默认批次表）不得出现批次棘轮拒因 ⇒ 差异只来自注入
  assert.doesNotMatch(String(base.batchMessage), /invalid batch phase transition: running -> complete/,
    '基线（未注入）不得出现批次棘轮拒因');
});

// ── E1-d 缺省零差异：无 ratchet 与 ratchet:{} 两次装配逐字相同 ──
test('E1-d 缺省零差异：不传 ratchet 与 ratchet:{} 的同一调用序列结果逐字相同', () => {
  const a = runProbe('d-none', undefined);
  const b = runProbe('d-empty', {});
  for (const k of ['ok', 'applyThrew', 'memberThrew', 'memberMessage', 'laneState', 'entryGateEvents', 'batchThrew', 'batchMessage', 'phase']) {
    assert.deepEqual(b[k], a[k], '缺省零差异被破坏（键 ' + k + '）：' + JSON.stringify({ none: a[k], empty: b[k] }));
  }
});

// ── E1-e fail-closed：非法棘轮配置在**装配期**抛错且不被吞噬（不得静默回落默认表）──
test('E1-e 非法棘轮配置：apply() 装配期抛错（fail-closed，不静默回落默认规则）', () => {
  const out = runProbe('invalid', { memberRules: { pending: ['bogus'] } });
  assert.equal(out.ok, true, '探针自身必须成功（实际: ' + JSON.stringify(out.error ?? null) + '）');
  assert.equal(out.applyThrew, true, '非法棘轮配置必须让装配期失败（fail-closed），而非被 try/catch 吞掉');
  assert.match(out.applyMessage, /^ratchet memberRules: relaxing transition "pending -> bogus"/,
    '错误串必须是 loadRules 的棘轮校验前缀：' + String(out.applyMessage));
});

// ── 零差异静态判据（反向守卫）：缺省分支返回 schema 常量**同引用** ──
test('零差异判据（引用相等）：无 ratchet / 空对象 / ratchet:{} 三者与 schema 常量同引用', () => {
  const cases = [
    ['undefined', loadRules(undefined)],
    ['null', loadRules(null)],
    ['{}', loadRules({})],
    ['{ratchet:{}}', loadRules({ ratchet: {} })],
    ['{ratchet:{allowRelax:true}}', loadRules({ ratchet: { allowRelax: true } })],
  ];
  for (const [label, r] of cases) {
    assert.equal(r.memberRules, DEFAULT_MEMBER_RULES, label + ' ⇒ memberRules 必须与 DEFAULT_MEMBER_RULES 同引用（非拷贝）');
    assert.equal(r.batchRules, DEFAULT_BATCH_RULES, label + ' ⇒ batchRules 必须与 DEFAULT_BATCH_RULES 同引用（非拷贝）');
    assert.equal(r.source, 'default', label + ' ⇒ source 必须为 default');
  }
  // 正向对照：真覆盖 ⇒ source=config，且只动被覆盖的那一面（另一面仍同引用）
  const over = loadRules({ ratchet: SHRINK_MEMBER });
  assert.equal(over.source, 'config', '覆盖生效 ⇒ source=config');
  assert.notEqual(over.memberRules, DEFAULT_MEMBER_RULES, '被覆盖面必须是新建表');
  assert.equal(over.batchRules, DEFAULT_BATCH_RULES, '未覆盖面必须零变化（同引用）');
});

// ── 接线形态静态守卫（与行为探针互补：行为绿而形态回退也能红）──
test('接线形态守卫：装配点传 rules（整份 config）+ 读点保持 rules ?? loadRules()', () => {
  const idx = fs.readFileSync(INDEX_JS, 'utf8');
  const store = fs.readFileSync(STORE_JS, 'utf8');
  // 注：断言用 .test(...) 而非 assert.match —— 失败时不得把整份被测文件当 actual 打出来（噪声 + 截断）
  assert.ok(/from '\.\/state\/machine-rules\.js'/.test(idx),
    'lib/index.js 必须 import loadRules（同源模块）');
  assert.ok(/const store = createStore\(root, \{[\s\S]{0,400}?rules: loadRules\(config\)/.test(idx),
    '装配点必须在 createStore 调用内传 `rules: loadRules(config)`（**整份 config**——传子对象会静默退化）');
  assert.ok(!/rules:\s*loadRules\(\s*config\.ratchet/.test(idx),
    '禁止传子对象 config.ratchet（loadRules 内部自取 config.ratchet）');
  assert.ok(/const ratchet = rules \?\? loadRules\(\);/.test(store),
    '读点（lib/state/store.js）必须保持 `rules ?? loadRules()` 形态不变');
});
