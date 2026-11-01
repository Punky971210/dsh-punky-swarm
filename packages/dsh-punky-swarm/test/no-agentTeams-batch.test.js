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

// ── 被断言面：公开导出（**W4 批 `w4-inject-teardown` 重划：4 → 6 项**）──────────────────────
//   旧四项 = `HOST_INJECTIONS` / `CAPABILITY_KEYS` / `capabilityReport` / `assertRequired`。
//   W4 把「宿主注入表」拆成「功能面键（宿主中立）」+「引擎空声明」+「内核端口键」三件 ⇒ 共六项。
async function loadCapabilities() {
  const mod = await import('../lib/capabilities.js').catch((err) => {
    throw new Error('lib/capabilities.js 不可加载（e1-capability 未交付？原始错：' + String(err?.message ?? err) + '）');
  });
  for (const name of ['HOST_FACE_KEYS', 'ENGINE_INJECTIONS', 'KERNEL_KEYS', 'CAPABILITY_KEYS', 'capabilityReport', 'assertRequired']) {
    assert.ok(name in mod, '导出面缺 ' + name + '（W4 钉死六项，禁增删）');
  }
  return mod;
}

// 能力面读 `rt` 的**端口位**（W4 起 `capabilityReport` 判**端口 `available`**，不再读宿主 ctx 属性）。
//   `ports: null` ⇒ **未探明**；`available:false` ⇒ 该宿主**拿不到该功能**（正常降级形态）。
const facePorts = (available = true, only = null) =>
  Object.fromEntries((only ?? ['toolSurface', 'httpSurface', 'agentRuntime']).map((k) => [k, { available }]));
/** 内核端口在位事实（W4 起 fail-closed 面 = 这里）。 */
const kernelFacts = (over = {}) => ({ runtime: true, audit: true, ...over });

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
  const { HOST_FACE_KEYS, ENGINE_INJECTIONS, capabilityReport, assertRequired } = await loadCapabilities();

  // 前置（**W4 新命题**）：引擎声明面**空**，且引擎侧词表是**功能面名**（不含任何宿主服务名）。
  //   旧命题是「`HOST_INJECTIONS` 必须逐字等于宿主三键」—— 那是本批要取消的硬依赖，已作废。
  assert.deepEqual([...ENGINE_INJECTIONS], [], '引擎插件行 inject 必须为空（J4\u0027-a）');
  assert.deepEqual(
    [...HOST_FACE_KEYS].sort(),
    ['agentRuntime', 'httpSurface', 'toolSurface'],
    '功能面键必须逐字为三面（宿主中立词表；AC-9b）',
  );
  for (const foreign of ['agentTeams', 'AgentScope', 'dsh-agent', 'tools', 'webServer', 'subagents']) {
    assert.equal(HOST_FACE_KEYS.includes(foreign), false, '功能面键不得含宿主服务名/外部框架位 ' + foreign);
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
  const installedAll = capabilityReport({ ports: facePorts(true), kernel: kernelFacts() });
  assert.ok(installedAll && typeof installedAll === 'object', 'capabilityReport 必须返回对象回显');
  for (const key of ['host', 'internal', 'missing']) {
    assert.ok(key in installedAll, '回显结构缺键 ' + key + '（W4 → {host, kernel, internal, missing, degraded}）');
  }
  assert.ok(Array.isArray(installedAll.missing), 'missing 必须是数组（缺失面可读）');
  assert.equal(assertRequired(installedAll), true, '内核端口齐备 ⇒ assertRequired 返回 true（不因宿主功能面差异而拒）');
});

// ── ② AC-2(a)【W4 命题反动】功能面不可用 ⇒ **不抛**（降级可见）；内核端口缺 ⇒ **抛** ──────────────
//   旧命题：「必需宿主键缺失 ⇒ assertRequired 抛」。W4 把 fail-closed 面从**宿主能力**改到**内核端口**
//   ⇒ 旧命题与新架构互斥（宿主能力差异属正常形态，不是装配缺陷）。新命题保留**同强度**的两条判据：
//   ① 功能面缺 ⇒ 不抛 且降级**可见**（installed:false + probed:true + reason 非空 + 进 degraded）；
//   ② 内核端口缺 ⇒ 必抛，且消息形态逐字沿用（`capability-missing:` / 无 err.code / 禁 GATE_）。
test('C2 功能面不可用 ⇒ assertRequired 不抛（降级可见）；内核端口缺 ⇒ 抛 `capability-missing:`（无 GATE_ 前缀）', async () => {
  const { capabilityReport, assertRequired } = await loadCapabilities();

  // ① 功能面不可用（httpSurface）而内核齐备 ⇒ **不抛**
  const faceDown = capabilityReport({ ports: facePorts(false, ['httpSurface']), kernel: kernelFacts() });
  assert.equal(assertRequired(faceDown), true,
    '功能面不可用**不得**升级为 fail-closed（宿主差异不是装配缺陷 —— 这是 W4 的架构决定）');
  const http = faceDown.host.find((h) => h.key === 'httpSurface');
  assert.equal(http.installed, false, '缺服务的功能面必须报 installed:false（不得静默当可用）');
  assert.equal(http.probed, true, '已探测（probed:true ≠ 未探明）');
  assert.ok(typeof http.reason === 'string' && http.reason.length > 0, '必须给可读 reason（降级但不静默）；实际=' + http.reason);
  assert.ok(faceDown.degraded.includes('httpSurface'), '降级事实须进 degraded 集合（回显通道）');

  // ② 内核端口缺（audit）⇒ **必抛**，形态逐字沿用旧约定
  let err = null;
  try { assertRequired(capabilityReport({ ports: facePorts(true), kernel: kernelFacts({ audit: false }) })); } catch (e) { err = e; }
  assert.ok(err, '内核端口缺必须 fail-closed 抛错（不得静默降级）');
  assert.ok(err instanceof Error, '必须是 Error 实例');
  assert.equal(err.code, undefined, '不得设置 err.code（禁进拒码集合的特殊读法）');
  const msg = String(err.message ?? '');
  assert.equal(msg.startsWith('GATE_'), false, '禁 GATE_ 前缀（包 §2.1 → 普通 Error + 固定前缀）');
  assert.ok(msg.includes('capability-missing:'), '消息须含固定前缀 `capability-missing:`；实际=' + msg);
  assert.ok(msg.includes('audit'), '消息须含**缺失键名**（可定位）；实际=' + msg);
  assert.equal(/GATE_/.test(msg), false, '消息任意位置不得出现 GATE_（拒码集合零新增）');
});

// ── ③ AC-2(b)：可选能力缺失 ⇒ **不抛**，且 `missing` 集合含该键（两态都要测，禁只验 happy path）──
test('C3 可选能力缺失 ⇒ 不抛，且 missing 集合含该键（可选 ≠ 必需，不得升级为 fail-closed）', async () => {
  const { HOST_FACE_KEYS, capabilityReport, assertRequired } = await loadCapabilities();
  const { CAPABILITY_REGISTRY } = await import('../lib/assembly/schema.js');

  // 夹具从**单一真源**派生（不硬编码键名）：注册表里「缺省未启用」的那些 = 可选且缺省即缺失的能力
  const defaultOff = CAPABILITY_REGISTRY
    .filter((r) => !HOST_FACE_KEYS.includes(r.key) && r?.default?.enabled !== true)
    .map((r) => r.key);
  assert.ok(defaultOff.length >= 1, '夹具前提：注册表内须存在「缺省未启用」的可选能力（否则本用例无可受试对象）');

  const report = capabilityReport({ ports: facePorts(true), kernel: kernelFacts() });
  assert.doesNotThrow(() => assertRequired(report), '可选能力缺失**不得**抛（fail-closed 只针对内核端口）');
  assert.equal(assertRequired(report), true, '可选缺失 ⇒ assertRequired 返回 true');

  // 集合式判据：至少一个「可选且缺省关」的键出现在 missing 内（存在性，不计数）
  assert.ok(
    defaultOff.some((k) => report.missing.includes(k)),
    '可选能力缺失须在 `missing` 集合内可见（包 AC-2(b)）；候选=' + JSON.stringify(defaultOff)
      + '，实际 missing=' + JSON.stringify(report.missing),
  );
  for (const faceKey of HOST_FACE_KEYS) {
    assert.equal(report.missing.includes(faceKey), false, '功能面已可用 ⇒ 不得出现在 missing：' + faceKey);
  }
});

// ── ④-T-2 P-1 inert **分级**（批 `punky-g1-tail-2026-10-29`：原单条 C4 拆成 C4-a / C4-b，**未删未合并**）──
//
// 【为什么拆】T-1 把 `inert(reason, level)` 显式分级：`cfg.enabled !== true`（**策略停用、生产可达**）走 `info`；
//   `ctx.on unavailable`（**防御纵深、生产不可达**）仍走 `warn`。原单条 C4 用同一模板断言「两条路径都产 warn」，
//   在分级后**必红**（disabled 一路不再进 warn 通道）⇒ 按新语义拆成两条各自独立的集合形态断言（C-4/C-5）。
//
//    ⚠ **阳性对照（常驻，C-5 要求）：旧口径「两路都必须产 warn」在本批实现下必红。**
//      红点恰在旧 C4 的两条断言上：① `warns.length >= 1`（disabled 一路 warn 为空 ⇒ 破）
//      ② `warns.some(w => w.includes('inert'))`（同一空集 ⇒ 破）。二者由下面 `C4-control` 逐条固化。

const mkLog = () => {
  const warns = [];
  const infos = [];
  const logger = {
    warn: (m) => warns.push(String(m)),
    info: (m) => infos.push(String(m)),
    error: () => {},
  };
  return { warns, infos, logger };
};

// ── C4-a ｜ 策略停用（`cfg.enabled !== true`）⇒ **info** 通道；warn 不含 inert ─────────────
test('C4-a P-1 inert 分级：cfg.enabled !== true（策略停用）⇒ info 产出 inert(info): disabled，且 warn 集合不含 inert', () => {
  const a = mkLog();
  const hook = installGovernanceHook({}, { logger: a.logger, config: { governance: { hook: { enabled: false } } } });

  // ① info 通道存在一条匹配（分级后的主路；不计数，只判匹配存在性）
  assert.ok(
    a.infos.some((m) => /\[governance\] inert\(info\):.*disabled/.test(m)),
    '策略停用须走 info 且消息匹配 /[governance] inert(info): .*disabled/；实际 info=' + JSON.stringify(a.infos),
  );
  // ② warn 集合里**不含** inert（集合为空，写成 deepEqual；禁条数比较）
  assert.deepEqual(
    a.warns.filter((w) => w.includes('inert')), [],
    '策略停用**不得**再进 warn 通道（真缺失与策略停用必须分得开）；实际 warn=' + JSON.stringify(a.warns),
  );
  // ③ 回显：分级键在场 + 既有四字段一个不丢
  assert.equal(hook.inert, true, '返回对象须含稳定回显键 inert:true');
  assert.equal(hook.level, 'info', '策略停用一路的回显级别须为 info');
  assert.equal(hook.installed, false, 'installed:false 语义保留');
  assert.equal(typeof hook.reason, 'string', 'reason 保留（且为字符串）');
  assert.equal(typeof hook.refusals?.count, 'function', 'refusals.count() 保留');
  assert.equal(typeof hook.dispose, 'function', 'dispose() 保留');
});

// ── C4-b ｜ 防御纵深（`ctx.on` 缺失）⇒ **warn** 通道；info 不含 inert ──────────────────────
test('C4-b P-1 inert 分级：ctx.on 缺失（防御纵深）⇒ warn 产出 inert(warn): ctx.on unavailable，且 info 集合不含 inert', () => {
  const b = mkLog();
  const hook = installGovernanceHook({}, { logger: b.logger, config: { governance: { hook: { enabled: true } } } });

  // ① warn 通道存在一条匹配（真防御异常不得被降级静默）
  assert.ok(
    b.warns.some((m) => /\[governance\] inert\(warn\):.*ctx\.on unavailable/.test(m)),
    'ctx.on 缺失须走 warn 且消息匹配 /[governance] inert(warn): .*ctx.on unavailable/；实际 warn=' + JSON.stringify(b.warns),
  );
  // ② info 集合里**不含** inert（两路互斥：不得同一条路径两处都打）
  assert.deepEqual(
    b.infos.filter((m) => m.includes('inert')), [],
    '防御纵深一路**不得**同时进 info 通道；实际 info=' + JSON.stringify(b.infos),
  );
  assert.equal(hook.level, 'warn', '缺省调用走 warn ⇒ 返回对象的 level 回显须为 `warn`（包 §2.1 K-4：返回对象追加 level）');
  assert.equal(hook.installed, false, 'installed:false 语义保留');
  assert.equal(hook.inert, true, '返回对象须含稳定回显键 inert:true');
});

// ── C4-control ｜ 常驻阳性对照：旧口径（两路都必须产 warn）**必红** ────────────────────────
//   存在理由（C-5 要求阳性对照常驻）：若有人把实现改回「两路都 warn」或把断言放松成恒绿，本用例会红。
//   做法**不越权**：不临时改 `lib/`（那是 e1 写域），只把**旧口径的断言本体**放进 `assert.throws` 里 ——
//   它对当前读数**预期失败**，失败点即旧 C4 的两条断言（① warn 非空 ② warn 含 inert）。
test('C4-control 阳性对照：旧口径（两路都必须产 warn）在本批实现下必红（判据杀伤力实验）', () => {
  const a = mkLog();
  installGovernanceHook({}, { logger: a.logger, config: { governance: { hook: { enabled: false } } } });

  // 旧口径断言本体（= T-2 前那条用例对 disabled 路径施加的两条断言），此处**预期失败**
  assert.throws(
    () => {
      assert.ok(a.warns.length >= 1, '旧口径①：inert 必须产出 warn（策略停用一路已改走 info ⇒ 本条必破）');
      assert.ok(a.warns.some((w) => w.includes('inert')), '旧口径②：warn 须含关键字 inert（同上，集合为空 ⇒ 必破）');
    },
    (err) => err instanceof assert.AssertionError,
    '旧口径必须判红，否则说明 inert 分级未落地（或有人把两路都退化为 warn）；实际 warn='
      + JSON.stringify(a.warns),
  );
  // 阴性对照：同一份读数下新口径成立（红来自分级迁移，不是读数缺失）
  assert.deepEqual(a.warns.filter((w) => w.includes('inert')), [], '同一份读数下新口径须成立：warn 不含 inert');
  assert.ok(
    a.infos.some((m) => m.includes('inert(info)')), '同一份读数下 info 主路须在场（证明分级确实发生）',
  );
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

// ── ⑥ G02 分流后的装配期断言（批 `punky-g1-gapfix-2026-10-29`：C6 由「并集 warn」拆成**两条独立断言**）──
//
// 【为什么重写（不是让它变绿）】改前 C6 断言「默认关能力须出 `capability-missing` warn」—— 那是 **G02 之前的
//   并集口径**（`lib/capabilities.js` 的 `missing` = host 未装 ∪ internal 未启用，装配期用并集打一条 warn）。
//   G02 在打日志处分流后语义已变：**host 缺失 ⇒ `warn` + `capability-missing:`**；
//   **internal 未启用 ⇒ `info` + `capability-disabled:`**（`missing` 仍保持并集，供回显/巡检）。
//   ⇒ 旧断言在新语义下**应当红**（见下方 C6-control 阳性对照），新断言按语义分类各写一条。
//
// 【纪律】两条断言**独立成例、禁合并**；判据主体 = 消息内容 + 集合为空，**禁条数比较**（C-13）。

/** 装配夹具：伪 ctx（带 `calls.info/warn` 收集器）+ 三宿主注入键齐备；`without` 可剥掉指定键。 */
function applyAssembly({ root, without = [] } = {}) {
  const ctx = assemblyCtx();
  if (!without.includes('webServer')) ctx.webServer = { register: () => () => {} };
  if (!without.includes('subagents')) ctx.subagents = { start: async () => ({}) };
  if (!without.includes('on')) { /* 保留 ctx.on */ } else { delete ctx.on; }
  ctx.get = () => undefined;
  let disposer = null;
  let err = null;
  try { disposer = apply(ctx, { root }); } catch (e) { err = e; }
  return {
    ctx, err,
    warn: ctx.calls.warn,
    info: ctx.calls.info,
    dispose() { if (typeof disposer === 'function') { try { disposer(); } catch { /* 幂等清理 */ } } },
  };
}

// ── C6a · AC-8【W4 命题反动】：宿主功能面缺失 ⇒ apply() **不抛**，且降级**可见** ────────────────
//   旧命题：「缺宿主必需键（webServer）⇒ 装配期必须 fail-closed 抛」。
//   W4 的目标正是让引擎**不因宿主能力差异改变运行模式**（用户口述 / J6-e）⇒ 缺 webServer 只应**降级**，
//   且必须**响亮**（`capability-degraded: httpSurface` + report 的 `installed:false`/`reason`）。
//   ⇒ 若有人把硬依赖改回去（inject 三键 + 宿主缺即抛），本条 `assert.equal(run.err, null)` 必红。
test('C6a AC-8 宿主功能面缺失 ⇒ apply() 不抛，且 `capability-degraded:` 降级信号可见（不静默）', () => {
  const run = applyAssembly({ root: tempRoot('punky-t1-g02a-'), without: ['webServer'] });
  try {
    assert.equal(run.err, null,
      '宿主功能面缺失**不得**让 apply() 抛错（W4：引擎不因宿主能力差异拒绝加载）；实际=' + String(run.err?.message ?? ''));
    const degradedLines = run.warn.filter((l) => String(l).includes('capability-degraded:'));
    assert.ok(degradedLines.length >= 1,
      '降级必须**可见**：warn 须含 `capability-degraded:`；实际 warn=' + JSON.stringify(run.warn.map(String)));
    assert.ok(degradedLines.some((l) => String(l).includes('httpSurface')),
      '降级信号须点名缺的功能面 `httpSurface`；实际=' + JSON.stringify(degradedLines.map(String)));
  } finally { run.dispose(); }
});

// ── C6b · AC-9：**internal 未启用** ⇒ 走 info `capability-disabled:`，且 warn 无 `capability-missing` 噪音 ──
test('C6b AC-9 internal 未启用 ⇒ info 含 capability-disabled，且 warn 集合不含 capability-missing（空集，非计数）', () => {
  const run = applyAssembly({ root: tempRoot('punky-t1-g02b-') });
  try {
    assert.equal(run.err, null, '三宿主键齐备 ⇒ 装配不得抛（internal 未启用不是 fail-closed 面）');

    // ① internal 未启用 ⇒ info 通道可见（回显语义保留）
    assert.ok(
      run.info.some((w) => w.includes('capability-disabled:')),
      'internal 未启用须产出 info 含 `capability-disabled:`；实际 info=' + JSON.stringify(run.info.slice(-6)),
    );

    // ② 噪音消除：warn 里**不得**再有 capability-missing（写成集合为空，禁条数比较）
    const missingNoise = run.warn.filter((w) => w.includes('capability-missing'));
    assert.deepEqual(missingNoise, [],
      '装配期 warn 不得含 `capability-missing`（internal 未启用不属「真缺失」）；实际='
        + JSON.stringify(missingNoise));
  } finally { run.dispose(); }
});

// ── C6-control · 阳性对照：把**旧口径**作为断言 ⇒ 必红（证明新断言有杀伤力，不是恒绿）──────
test('C6-control 阳性对照：旧口径「warn 须含 capability-missing」在新语义下必红（判据杀伤力实验）', () => {
  const run = applyAssembly({ root: tempRoot('punky-t1-g02ctl-') });
  try {
    const legacyOk = run.warn.some((w) => w.includes('capability-missing'));
    assert.throws(
      () => assert.equal(legacyOk, true, '旧口径占位：默认关能力须出 capability-missing warn'),
      (err) => err instanceof assert.AssertionError,
      'G02 分流后旧口径必须判红（否则说明 warn 噪音仍在、或分流未落地）；实际 warn='
        + JSON.stringify(run.warn.slice(0, 6)),
    );
    // 阴性对照：新口径在同一份读数上必须成立（红来自语义迁移，不是读数缺失）
    assert.deepEqual(run.warn.filter((w) => w.includes('capability-missing')), [],
      '同一份读数下新口径须成立：warn 无 capability-missing');
  } finally { run.dispose(); }
});

// ── C6c · AC-5：**P-2 inert 可见性**（`index.js:704` 分支）—— 运行期 warn 捕获 ─────────────
//   构造：`assemblyCtx()` 去掉 `on`（⇒ `typeof ctx?.on !== 'function'` 成立）+ 三宿主键齐备 ⇒ 走公开 `apply()`。
//
//   ⚠ **边界（C-14，必须读）**：本用例证的只是「**该分支若发生，会有回显**」（warn 通道能捕获 `lane-wake inert:`），
//   **不证明**该分支在**生产**会发生 —— `lib/index.js:146` 的 `store` 恒非空、`ctx.on` 由宿主提供、
//   `root` 由 `apply(ctx, { root })` 给出 ⇒ `!store || typeof ctx?.on !== 'function'` **生产恒不成立**。
//   **禁止**据本用例推断「能力缺失可达」或修改任何可达性结论。
test('C6c AC-5 P-2 inert 可见（运行期）：去掉 ctx.on 后 apply() 的 warn 含 `lane-wake inert:`（仅证有回显，不推生产可达）', () => {
  const run = applyAssembly({ root: tempRoot('punky-t1-p2-'), without: ['on'] });
  try {
    assert.ok(
      run.warn.some((w) => w.includes('lane-wake inert:')),
      'P-2 定点（index.js 的局部 inert）须经 warn 通道回显 `lane-wake inert:`；实际 warn='
        + JSON.stringify(run.warn.slice(0, 8)),
    );
  } finally { run.dispose(); }
});

// ── ⑦ AC-1（导出面**恰好**四项，集合式）/ AC-10（不造第二真源：键集派生而非手抄）──
test('C7 AC-1 导出面恰好六项（集合相等）；AC-10 键集由 CAPABILITY_REGISTRY 派生、无手抄键名清单', async () => {
  const mod = await loadCapabilities();
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['CAPABILITY_KEYS', 'ENGINE_INJECTIONS', 'HOST_FACE_KEYS', 'KERNEL_KEYS', 'assertRequired', 'capabilityReport'],
    '导出面必须**恰好**为 W4 钉死的六项（禁增删；集合式比较，不是计数断言）',
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
