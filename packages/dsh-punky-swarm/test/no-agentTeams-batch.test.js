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

// 批 `punky-g1-declare-2026-10-29` · lane `t1-verify`（tester）—— **能力面**测试。
//
// 判据源 = `plan/p2-pack-g1.md`：
//   · §2.1 能力面导出面（**钉死，禁扩面**）+ fail-closed 两态表（a 必需缺失 / b 可选缺失）
//   · §2.2 inert 可见性**定点三处**（P-1 `wiring.js` inert 定义点 / P-2 `index.js:690-691` 局部 inert /
//     P-3 装配汇总一行 `capability-missing` warn）
//   · §2.7 T-gate（只跑指定文件，禁 `npm test` / 禁 `npm run build` / 禁全量 glob）
//   · `## 验收标准`：AC-1（导出面）/ AC-2（两态）/ AC-6（inert 三定点）/ AC-10（不造第二真源）/ AC-12（无外部能力仍可派发）
//   · `## 约束`：C-10（禁外部框架名）/ C-14（禁数量断言 —— 判据主体一律为**集合关系 / 存在性 / 捕获到的消息内容**）
//
// 写域自证（C-13）：本文件是 t1 的**唯一**写码面之一；不 import 任何会被 coder 改写的内部私有符号，
//   只消费包内钉死的**公开导出面**（`capabilityReport` / `assertRequired` / `HOST_INJECTIONS` / `CAPABILITY_KEYS`）
//   与「读回原文」面（P-2 / AC-10 的源码型判据 —— 包内 AC-6 的复核读数即写明「读回原文 + warn 捕获原始输出」）。
//
// 为什么用**动态 import**而不是顶层静态 import：本 lane 与 `e1-capability` **并行**（包内明示「t1 不等 coder」），
//   被测文件在 coder 交付前**不存在**。静态 import 会让整文件在模块加载期 ERR_MODULE_NOT_FOUND，
//   把「能力面未交付」与「roster/护栏面未交付」混成同一条报错，丧失逐面可读的 RED 定位。
//   动态 import + 明确断言消息，使每个用例各自报出自己的缺口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createStore } from '../lib/state/store.js';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { apply } from '../lib/index.js';
import { assemblyCtx, tempRoot } from './helpers/gate-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const rel = (p) => path.join(PKG_ROOT, p);

const SILENT = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };

// ── 被断言面：公开导出（包 §2.1 钉死四项）──────────────────────────────────────
async function loadCapabilities() {
  const mod = await import('../lib/capabilities.js').catch((err) => {
    throw new Error('lib/capabilities.js 不可加载（e1-capability 未交付？原始错：' + String(err?.message ?? err) + '）');
  });
  for (const name of ['HOST_INJECTIONS', 'CAPABILITY_KEYS', 'capabilityReport', 'assertRequired']) {
    assert.ok(name in mod, '导出面缺 ' + name + '（包 §2.1 钉死四项，禁增删）');
  }
  return mod;
}

// 能力面读 `rt` 的**宿主注入位**：三键在 rt 上均在场 = 「已注入」。
//   （包 §2.1：`HOST_INJECTIONS` 三键本批**全部必需**，不降级任何宿主键 ⇒ 「可选能力」只能落在内部能力键上。）
const hostInstalledRuntime = (hostKeys) => Object.fromEntries(hostKeys.map((k) => [k, {}]));
const hostRuntimeMissing = (hostKeys, dropped) =>
  Object.fromEntries(hostKeys.filter((k) => k !== dropped).map((k) => [k, {}]));

/** 读回源码（P-2 / AC-10 的源码型判据面；包内 AC-6 复核读数即「读回原文」）。 */
function sourceOf(relPath) {
  const abs = rel(relPath);
  assert.ok(fs.existsSync(abs), relPath + ' 不存在（对应 coder lane 未交付？）');
  return fs.readFileSync(abs, 'utf8');
}

/**
 * 从 `fromIndex` 起截出**括号配平**的一段源码（处理「返回对象跨行 / 单行」两种形态）。
 * 判据面需要「这**一个** inert 定义体内包含什么」，不能用「往后 12 行里有没有」——那会把相邻语句算进来（假绿）。
 */
function balancedSlice(src, fromIndex) {
  const openers = '({[';
  const closers = ')}]';
  let started = false;
  let depth = 0;
  for (let i = fromIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (openers.includes(ch)) { started = true; depth += 1; continue; }
    if (closers.includes(ch)) {
      depth -= 1;
      if (started && depth === 0) return src.slice(fromIndex, i + 1);
    }
  }
  return src.slice(fromIndex);
}

// ── ① AC-12：**无 `agentTeams` 等外部能力** 仍可建批 + 派发，且能力面回显/报错面**在场**（不是静默通过）──
test('C1 无 agentTeams 能力仍可建批派发：建批 + 派发成功，且能力缺失面在回显/报错通道可见', async () => {
  const { HOST_INJECTIONS, capabilityReport, assertRequired } = await loadCapabilities();

  // 前置：本仓能力声明面**不含**任何外部框架键（用户口径：排除外部适配）
  assert.deepEqual(
    [...HOST_INJECTIONS].sort(),
    ['subagents', 'tools', 'webServer'],
    'HOST_INJECTIONS 必须逐字等于宿主三键（包 §2.1 硬纪律 2：本批不降级任何宿主键）',
  );
  for (const foreign of ['agentTeams', 'AgentScope', 'dsh-agent']) {
    assert.equal(HOST_INJECTIONS.includes(foreign), false, '宿主必需键不得含外部框架位 ' + foreign);
  }

  // 真·无 agentTeams 运行：无该 capability 的 runtime 下，建批 + 派发照常（引擎不依赖外部能力）
  const root = tempRoot('punky-t1-noagentteams-');
  const store = createStore(root, { logger: SILENT });
  const S = 'sess-t1-noagentteams';
  const BID = 'b-t1-noagentteams';
  const plan = buildWavePlan({ batchId: BID, tasks: [{ id: 't1-a', cmd: 'A' }, { id: 't1-b', cmd: 'B', deps: ['t1-a'] }] });
  store.createBatch(S, { batchId: BID, wavePlan: plan, phase: 'running' });
  store.setMember(S, BID, 't1-a', 'running', null, undefined, 'agent-t1');

  const after = store.readBatch(S, BID);
  assert.ok(after, '建批须成功（无 agentTeams 不是建批前提）');
  assert.equal(after.lanes['t1-a'], 'running', '派发须成功：执行面 lanes 迁移');
  const flat = (after.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
  assert.equal(flat.find((t) => t.id === 't1-a')?.owner, 'agent-t1', '派发须成功：声明面 owner 写入');
  assert.ok(after.events.some((e) => e && e.type === 'task.owner.assigned'), '派发须留痕 task.owner.assigned');

  // 「不是静默通过」：能力面必须**能表达缺失**
  const installedAll = capabilityReport(hostInstalledRuntime(HOST_INJECTIONS));
  assert.ok(installedAll && typeof installedAll === 'object', 'capabilityReport 必须返回对象回显');
  for (const key of ['host', 'internal', 'missing']) {
    assert.ok(key in installedAll, '回显结构缺键 ' + key + '（包 §2.1 → {host, internal, missing}）');
  }
  assert.ok(Array.isArray(installedAll.missing), 'missing 必须是数组（缺失面可读）');
  assert.equal(assertRequired(installedAll), true, '三键齐备 ⇒ assertRequired 返回 true（不因外部能力缺席而拒）');
});

// ── ② AC-2(a)：必需能力缺失 ⇒ fail-closed（普通 Error / `capability-missing:` / 含缺失键名 / 无 GATE_ 前缀）──
test('C2 必需能力缺失 ⇒ assertRequired 抛普通 Error：含 `capability-missing:` 与缺失键名，不以 GATE_ 开头', async () => {
  const { HOST_INJECTIONS, capabilityReport, assertRequired } = await loadCapabilities();
  const dropped = 'webServer';
  assert.ok(HOST_INJECTIONS.includes(dropped), '夹具前提：webServer 在必需键集合内');

  let err = null;
  try {
    assertRequired(capabilityReport(hostRuntimeMissing(HOST_INJECTIONS, dropped)));
  } catch (e) { err = e; }

  assert.ok(err, '必需键缺失必须 fail-closed 抛错（不得静默降级）');
  assert.ok(err instanceof Error, '必须是 Error 实例');
  assert.equal(err.code, undefined, '不得设置 err.code（禁进拒码集合的特殊读法）');
  const msg = String(err.message ?? '');
  assert.equal(msg.startsWith('GATE_'), false, '禁 GATE_ 前缀（包 §2.1 → 普通 Error + 固定前缀）');
  assert.ok(msg.includes('capability-missing:'), '消息须含固定前缀 `capability-missing:`；实际=' + msg);
  assert.ok(msg.includes(dropped), '消息须含**缺失键名**（可定位）；实际=' + msg);
  assert.equal(/GATE_/.test(msg), false, '消息任意位置不得出现 GATE_（拒码集合零新增）');
});

// ── ③ AC-2(b)：可选能力缺失 ⇒ **不抛**，且 `missing` 集合含该键（两态都要测，禁只验 happy path）──
test('C3 可选能力缺失 ⇒ 不抛，且 missing 集合含该键（可选 ≠ 必需，不得升级为 fail-closed）', async () => {
  const { HOST_INJECTIONS, capabilityReport, assertRequired } = await loadCapabilities();
  const { CAPABILITY_REGISTRY } = await import('../lib/assembly/schema.js');

  // 夹具从**单一真源**派生（不硬编码键名）：注册表里「非宿主键 且 缺省未启用」的那些 = 可选且缺省即缺失的能力
  const defaultOff = CAPABILITY_REGISTRY
    .filter((r) => !HOST_INJECTIONS.includes(r.key) && r?.default?.enabled !== true)
    .map((r) => r.key);
  assert.ok(defaultOff.length >= 1, '夹具前提：注册表内须存在「缺省未启用」的可选能力（否则本用例无可受试对象）');

  const report = capabilityReport(hostInstalledRuntime(HOST_INJECTIONS));
  assert.doesNotThrow(() => assertRequired(report), '可选能力缺失**不得**抛（fail-closed 只针对必需键）');
  assert.equal(assertRequired(report), true, '可选缺失 ⇒ assertRequired 返回 true');

  // AC-2(b) 的集合式判据：至少一个「可选且缺省关」的键出现在 missing 内（存在性，不计数）
  assert.ok(
    defaultOff.some((k) => report.missing.includes(k)),
    '可选能力缺失须在 `missing` 集合内可见（包 AC-2(b)）；候选=' + JSON.stringify(defaultOff)
      + '，实际 missing=' + JSON.stringify(report.missing),
  );
  for (const hostKey of HOST_INJECTIONS) {
    assert.equal(report.missing.includes(hostKey), false, '宿主键已注入 ⇒ 不得出现在 missing：' + hostKey);
  }
});

// ── ④ AC-6 P-1：`wiring.js` inert 定义点 —— warn 可捕获（非空 / 含 inert）+ 返回对象含回显键 `inert: true` ──
test('C4 P-1 inert 可见：wiring.js 两条 inert 路径均产出含 inert 的 warn，且回显键 inert:true 在场', () => {
  const mkLogger = () => { const warns = []; const logger = { warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} }; return { warns, logger }; };

  // 路径一：配置显式关闭（`cfg.enabled !== true` ⇒ inert('disabled')）
  const a = mkLogger();
  const disabled = installGovernanceHook({}, { logger: a.logger, config: { governance: { hook: { enabled: false } } } });
  // 路径二：ctx.on 不可用（`!root || typeof ctx?.on !== 'function'` ⇒ inert('ctx.on unavailable')）
  const b = mkLogger();
  const unavailable = installGovernanceHook({}, { logger: b.logger, config: { governance: { hook: { enabled: true } } } });

  for (const [label, hook, logger] of [['disabled', disabled, a], ['ctx.on-unavailable', unavailable, b]]) {
    // ① warn 通道非空且含关键字（不是静默返回空实现）
    assert.ok(logger.warns.length >= 1, label + '：inert 必须产出 warn（改前是静默返回，无法区分「装了但零拒绝」与「没装」）');
    assert.ok(
      logger.warns.some((w) => w.includes('inert')),
      label + '：warn 须含关键字 `inert`；实际=' + JSON.stringify(logger.warns),
    );
    // ② 回显键在场，且既有字段一个不丢（不破坏既有调用方）
    assert.equal(hook.inert, true, label + '：返回对象须含稳定回显键 inert:true');
    assert.equal(hook.installed, false, label + '：installed:false 语义保留');
    assert.equal(typeof hook.reason, 'string', label + '：reason 保留（且为字符串）');
    assert.equal(typeof hook.refusals?.count, 'function', label + '：refusals.count() 保留');
    assert.equal(typeof hook.dispose, 'function', label + '：dispose() 保留');
  }
});

// ── ⑤ AC-6 P-2（读回原文）：`index.js` 内 `installLaneWake` 的局部 inert 同形补 warn + `inert: true` ──
test('C5 P-2 inert 可见（读回原文）：index.js installLaneWake 内局部 inert 同时具备 warn 与 inert:true 回显键', () => {
  const src = sourceOf('lib/index.js');
  const lines = src.split(/\r?\n/);

  // 定位 P-2：`installLaneWake` 函数体内 `const inert = (reason) => ...`（包 §2.2 定点，行号会随 e1 改动漂移 ⇒ 按符号定位）
  const fnAt = lines.findIndex((l) => /const\s+installLaneWake\s*=/.test(l));
  assert.ok(fnAt >= 0, 'index.js 内应存在 installLaneWake 定义（P-2 定点所在的函数体）');
  let inertAt = -1;
  for (let i = fnAt; i < Math.min(lines.length, fnAt + 40); i += 1) {
    if (/const\s+inert\s*=\s*\(reason\)\s*=>/.test(lines[i])) { inertAt = i; break; }
  }
  assert.ok(inertAt >= 0, 'installLaneWake 体内应存在局部 `const inert = (reason) => …`（P-2 定点）');

  // 该 inert 定义（可能跨行）须同时含：inert:true 回显键 + 一条 warn 调用
  // 截取从 `=>` 起**括号配平**的那一段（跳过形参 `(reason)` 自身的那对括号）
  const at = src.indexOf(lines[inertAt]);
  const arrowAt = src.indexOf('=>', at);
  assert.ok(arrowAt > at, 'P-2 inert 定义应为箭头函数形态 `const inert = (reason) => …`');
  const block = balancedSlice(src, arrowAt);
  assert.ok(/inert\s*:\s*true/.test(block), 'P-2 inert 返回对象须含 `inert: true`；实际块=' + JSON.stringify(block.slice(0, 300)));
  assert.ok(/warn\?\.\(|warn\(/.test(block), 'P-2 inert 定义须自带一条 warn 调用（warn 通道可捕获）；实际块=' + JSON.stringify(block.slice(0, 300)));
  assert.ok(/inert/.test(block), 'P-2 的 warn 文案须含关键字 `inert`');
  // 既有调用方字段不得被抹（不破坏 {installed, reason, count, dispose} 语义）；`reason` 允许简写属性
  const retained = [
    ['installed', /installed\s*:/],
    ['reason', /reason\s*[:,}]/],
    ['count', /count\s*[:(]/],
    ['dispose', /dispose\s*[:(]/],
  ];
  for (const [field, re] of retained) {
    assert.ok(re.test(block), 'P-2 inert 返回对象须保留既有字段 ' + field + '；实际块=' + JSON.stringify(block.slice(0, 300)));
  }
});

// ── ⑥ AC-6 P-3：装配汇总 `capability-missing` warn —— 用 `ctx.logger.warn` 收集器实跑捕获 ──
test('C6 P-3 装配汇总 warn：apply() 装配期经 ctx.logger.warn 产出含 `capability-missing:` 的汇总行', () => {
  const ctx = assemblyCtx(); // 已带 calls.warn 收集器 + on；无 webServer/subagents ⇒ 由本用例补齐
  ctx.webServer = { register: () => () => {} };
  ctx.subagents = { start: async () => ({}) };
  ctx.get = () => undefined;
  const root = tempRoot('punky-t1-capwarn-');

  let disposer = null;
  try {
    assert.doesNotThrow(() => { disposer = apply(ctx, { root }); },
      '三宿主键齐备时装配不得因能力面抛错（fail-closed 只针对必需缺失）');
  } finally {
    if (typeof disposer === 'function') { try { disposer(); } catch { /* 幂等清理 */ } }
  }

  const warns = ctx.calls.warn;
  assert.ok(
    warns.some((w) => w.includes('capability-missing')),
    'P-3 装配汇总须产出 ≥1 条含 `capability-missing` 的 warn（内部可选能力缺省关闭即缺失）；实际 warns='
      + JSON.stringify(warns.slice(0, 8)),
  );
});

// ── ⑦ AC-1（导出面**恰好**四项，集合式）/ AC-10（不造第二真源：键集派生而非手抄）──
test('C7 AC-1 导出面恰好四项（集合相等）；AC-10 键集由 CAPABILITY_REGISTRY 派生、无手抄键名清单', async () => {
  const mod = await loadCapabilities();
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['CAPABILITY_KEYS', 'HOST_INJECTIONS', 'assertRequired', 'capabilityReport'],
    '导出面必须**恰好**为包 §2.1 钉死的四项（禁增删；集合式比较，不是计数断言）',
  );

  const src = sourceOf('lib/capabilities.js');
  assert.ok(/CAPABILITY_REGISTRY/.test(src), 'AC-10：capabilities.js 必须引用 CAPABILITY_REGISTRY（禁造第二真源）');
  assert.ok(/from\s+['"][^'"]*assembly\/schema\.js['"]/.test(src) || /require\(['"][^'"]*assembly\/schema\.js['"]\)/.test(src),
    'AC-10：键集须从 lib/assembly/schema.js 派生（import/require 该单点）');

  // 包 AC-10 的判法：「首个键名同时出现在两处的行」⇒ 无 CAPABILITY_REGISTRY 的行里出现手抄键名即违规
  const { CAPABILITY_REGISTRY } = await import('../lib/assembly/schema.js');
  const firstKey = CAPABILITY_REGISTRY[0].key;
  const copied = src.split(/\r?\n/).filter((line) =>
    !/CAPABILITY_REGISTRY/.test(line) && new RegExp('[\'"]' + firstKey + '[\'"]').test(line));
  assert.deepEqual(copied, [], 'AC-10：不得出现手抄键名清单（首个键 ' + firstKey + ' 只应经由注册表派生出现）');
});
