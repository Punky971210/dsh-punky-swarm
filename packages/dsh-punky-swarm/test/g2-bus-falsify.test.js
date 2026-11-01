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

// 批 `punky-g2-adapter-2026-10-30` · lane `t1-verify`（tester）—— **bus 可证伪面**：
//   ② null 适配器最小批次（含否定对照）＋ F-1…F-4 每条 ≥1 用例 ＋ 四动作探针。
//
// 判据源 = `plan/p2-pack-g2.md` §2.5（块三四动作/null 适配器）／§2.6（可证伪四条）＋ `## 验收标准`：
//   · AC-12 四动作各 ≥1 探针 · AC-14 selftest exit 0 + 否定对照 · AC-15 F-1…F-4 每条 ≥1 用例
//
// 【独立构造声明（E-2 明确提醒，Leader 背书）】
//   本文件的夹具**独立构造**，不复用 `lib/bus/selftest.mjs` 的夹具；`selftest` 只作**被测对象**（我跑它、读它的
//   exit code），**不作判据来源**（它的断言怎么写，本文件不照抄）。与 selftest 的差异点逐条见各用例注释里的
//   「Δ vs selftest」。
//
// 写法纪律（C-14）：**禁数量断言** —— 判据主体 = 集合相等 / 集合为空 / 匹配存在性 / 捕获到的抛错形态。
//   反向开关 `harden.<fN> = false` 是**被测对象自带的测试缝**（生产不传 ⇒ 零行为），本文件用它取得
//   反向开关**迁移后**已不在对外签名里（批 `punky-g2-tail-2026-10-30` T-1 收口）：改由**环境闩**
//   `PUNKY_TEST_HARDEN='1' + PUNKY_TEST_HARDEN_FLAGS='fN'` 驱动（见 `createBusWithHardenOff`）。
//   本文件用它取得
//   「判红读数」，证明「使它不再发生的那一行」真的在起作用（包 §2.6 三条共同要求）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBus, createNullAdapters, runMinimalBatch } from '../lib/bus/index.js';
import { BUILTIN_ROLES, reconcileRoster } from '../lib/roster.js';
import { HOST_FACE_KEYS, capabilityReport } from '../lib/capabilities.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

/**
 * **自建**功能面端口夹具（W4 起 `capabilityReport` 读**端口 `available`**，不再读宿主 ctx 属性）。
 * 三面各给一个可判读的探针；`available:false` 即「该宿主拿不到此功能」。
 */
const facePortsFixture = (available = true) =>
  Object.fromEntries(HOST_FACE_KEYS.map((k) => [k, { available }]));

/**
 * 【W4 批 `w4-inject-teardown`】能力名域**单点**。
 *
 * W4 前：`HOST_INJECTIONS[0]`（= `tools`，**宿主服务名**）。
 * W4 后宿主三键已从引擎侧退场（`HOST_FACE_KEYS` 只含功能面名），故「某个已知能力名」改用
 *   **内部能力键里**「缺省即启用」的首个 —— 与 `capabilityReport({})` **同源派生**，不写死名字。
 * 本组用例的真命题不变：「**某个 bus 认识的能力名** + 必需端口齐/缺 ⇒ fail-closed 行为」。
 * 若表与 bus 词表脱钩 ⇒ `assertCapability` 走 `unknown capability:` 分支 ⇒ 用例失败并点名。
 */
const CAPABILITY_NAME = capabilityReport({}).internal.filter((c) => c.enabled)[0].key;

/**
 * **自建**必需端口夹具：只给 runtime + audit（两必需），其余走内建/null 适配器。
 *
 * 【P0-3 解冻】原夹具写死 `runtime:{start,stop}` / `audit:{emit}` —— 那是**端口方法名**冻结。
 *   契约唯一化后 runtime 的动词变 `execute`、audit 的 `emit` 可能变 `append`（contract-shape §8.1），
 *   写死单向名字会先红。本夹具的语义只是「两必需端口**在场且可调用**」，不负责钉动词名
 *   （动词名由 `lib/ports.ts` 契约面判）⇒ 给**两代动词名的并集**，标注为过渡期兼容。
 *   注：`M4` 的「null 适配器 5 键集合相等」**故意不动** —— 那是键集不是动词（contract-shape §8.2 正向约束）。
 */
const requiredPortsFixture = () => {
  const anyVerb = () => ({ ok: true, writes: [], evidence: [], timedOut: false, exitCode: 0, signal: null });
  return {
    runtime: { start: anyVerb, stop: anyVerb, execute: anyVerb, cancel: anyVerb },
    audit: { emit: () => null, append: () => null },
  };
};

/**
 * **反向开关迁移后的唯一入口**（批 `punky-g2-tail-2026-10-30` · T-1 收口后）：
 * 加固关断已**不在对外签名里**（`createBus({ harden })` 会被拒），改由**环境闩**驱动 ——
 *   ① `PUNKY_TEST_HARDEN` 必须恰为 `'1'` 才生效（否则 FLAGS 被完全忽略，不半生效）；
 *   ② `PUNKY_TEST_HARDEN_FLAGS` 列出要被关断的开关名（本文件固定单条 `'fN'`）；
 *   ③ 闩在 **`createBus` 调用时**读取（不是模块加载时）⇒ 本助手必须在**调用前后**设置/还原。
 *
 * 迁移纪律（包 §2.6）：**判红读数必须与迁移前等价** —— 关断后仍要拿到
 *   F-1 的 `TypeError` / F-2 的 `missing=[]` / F-3 的裸数组 / F-4 的 `advanced`。
 *   本助手只换「开关怎么开」，**不删任何判红断言**（删了就等于抽掉可证伪性本身）。
 */
function createBusWithHardenOff(flag, opts) {
  const prevLatch = process.env.PUNKY_TEST_HARDEN;
  const prevFlags = process.env.PUNKY_TEST_HARDEN_FLAGS;
  process.env.PUNKY_TEST_HARDEN = '1';
  process.env.PUNKY_TEST_HARDEN_FLAGS = flag;
  try {
    return createBus(opts);
  } finally {
    if (prevLatch === undefined) delete process.env.PUNKY_TEST_HARDEN; else process.env.PUNKY_TEST_HARDEN = prevLatch;
    if (prevFlags === undefined) delete process.env.PUNKY_TEST_HARDEN_FLAGS; else process.env.PUNKY_TEST_HARDEN_FLAGS = prevFlags;
  }
}

// ── ② AC-14（正向，被测对象）：`node lib/bus/selftest.mjs` 的真实 exit code ────────────────
//   ⚠ 这是**被测对象**而不是判据来源：本文件只读它的 exit code 与摘要行，不从它的断言反推我的断言。
test('M1 null 适配器最小批次：node lib/bus/selftest.mjs 真实退出码 = 0（被测对象，非判据来源）', () => {
  const r = spawnSync(process.execPath, ['lib/bus/selftest.mjs'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'selftest 必须 exit 0；实际 status=' + r.status + '\nstdout:\n' + (r.stdout ?? '') + '\nstderr:\n' + (r.stderr ?? ''));
  assert.ok(/ALL PASS/.test(r.stdout ?? ''), 'selftest 摘要须含 ALL PASS；实际 stdout 尾部=' + JSON.stringify((r.stdout ?? '').slice(-200)));
});

// ── ② AC-14（否定对照）：故意缺必需端口 ⇒ fail-closed，**不得静默通过** ─────────────────────
test('M2 否定对照①：两必需端口全缺 ⇒ assertCapability 抛普通 Error（非 GATE_ / 无 code / 消息含缺失端口名）', () => {
  const bus = createBus({}); // 不注册任何端口
  let err = null;
  try { bus.assertCapability(CAPABILITY_NAME, { config: {} }); } catch (e) { err = e; }

  assert.ok(err, '缺必需端口必须抛错（静默通过 = 不合格）');
  assert.ok(err instanceof Error, '必须是 Error 实例');
  assert.equal(err.code, undefined, '不得设置 err.code（禁新造拒码，C-9）');
  const msg = String(err.message ?? '');
  assert.equal(msg.startsWith('GATE_'), false, '禁 GATE_ 前缀');
  assert.equal(/GATE_/.test(msg), false, '消息任意位置不得出现 GATE_');
  assert.ok(msg.includes('capability-missing:'), '消息须含固定前缀 `capability-missing:`；实际=' + msg);
  assert.ok(msg.includes('runtime') && msg.includes('audit'), '消息须逐个列出缺失端口名；实际=' + msg);
});

test('M3 否定对照②（Δ vs selftest：selftest 只测「两个全缺」，本处测**部分缺失**）⇒ 只报缺的那一个', () => {
  const bus = createBus({ ports: requiredPortsFixture() }); // runtime+audit 齐 ⇒ 不应抛
  assert.equal(bus.assertCapability(CAPABILITY_NAME, { config: {} }), true, '两必需端口齐备 ⇒ 断言通过');

  // 只缺 audit：用新 bus 只给 runtime
  const bus2 = createBus({ ports: { runtime: requiredPortsFixture().runtime } });
  let err = null;
  try { bus2.assertCapability(CAPABILITY_NAME, { config: {} }); } catch (e) { err = e; }
  assert.ok(err, '缺 audit ⇒ 必须抛错');
  const msg = String(err.message ?? '');
  assert.ok(msg.includes('audit'), '消息须含缺失端口 `audit`；实际=' + msg);
  assert.equal(msg.includes('runtime'), false, 'runtime 已提供 ⇒ 不得被误报为缺失（逐端口判定，不是「整体不可用」）');
});

// ── AC-12 四动作各 ≥1 探针（register / assertCapability / route / normalize）───────────────
test('A1 四动作逐个可达：register 返回槽位名 · assertCapability 返回 true · route 给席位视图 · normalize 归形状', async () => {
  const bus = createBus({ ports: requiredPortsFixture() });

  // ① register：注册到端口名槽位
  assert.equal(bus.register('tools', { list: () => ['x'], call: () => ({ ok: true }) }), 'tools', 'register 应返回所注册的槽位名');

  // ② assertCapability：能力名域内 + 宿主键齐 ⇒ true
  assert.equal(bus.assertCapability(CAPABILITY_NAME, { config: {} }), true, 'assertCapability 应返回 true');

  // ③ route：给出席位视图（形状见 F-3）
  const routed = await bus.route(BUILTIN_ROLES[0]);
  assert.equal(routed.role, BUILTIN_ROLES[0], 'route 须回显受试席位');
  assert.ok(routed.view && typeof routed.view === 'object', 'route 须给出名册视图对象');

  // ④ normalize：只归形状，**不引入 stopReason**（C-10）
  const normalized = bus.normalize({ ok: true, writes: [{ id: 'w1' }], evidence: [{ kind: 'e' }] });
  assert.deepEqual(Object.keys(normalized).sort(), ['evidence', 'ok', 'shape', 'writes'], 'normalize 的键集合必须恰为形状四键（不得混入执行态字段）');
  assert.deepEqual(normalized.writes, [{ id: 'w1' }], 'normalize 须透传 writes');
  assert.equal(normalized.shape, 'exec-result', 'normalize 须声明 ExecResult 形状');
});

// ── F-1 可选端口被当必需直用（AC-15）────────────────────────────────────────────────────
//   Δ vs selftest：selftest 经 `route()` 间接触达；本处**直接调 `of(slot)`** 验「取件单点」本身，
//   并用反向开关取得判红读数（`TypeError: Cannot read properties of null`）。
test('F1 可选端口不得被当必需直用：缺可选端口时 of() 返回可调用对象；关加固 ⇒ 裸 null 解引用 TypeError', () => {
  const bus = createBus({ ports: requiredPortsFixture() }); // 只给两必需端口
  const tools = bus.of('tools'); // 直接取件（不经过 route）
  assert.ok(tools != null, 'F-1：可选端口缺失时 of() **不得**返回 null（否则后续裸解引用即 TypeError）');
  // 【W2 批 · `punky-adapter-split-20261031` lane `w2-null-adapters` 授权改动】
  //   原断言钉 `tools.list` —— 但 `list` 是**旧 null 适配器的成员**，契约 v2 的 `ToolSurface` 无此名
  //   （契约 7 成员：available/hasTool/probeTool/getTool/registerTool/installGuard/invokeTool）。
  //   本用例的判别对象是「取到的是**形状可调用**的 null 适配器、不是占位 undefined」，
  //   与具体动词名无关 ⇒ 换成契约成员 `probeTool`（查询类，语义最贴「空实现可调用」）。
  //   **判别力未降**：仍是「函数存在 + 调用返回可判读数」两段断言，只是钉的名字从非契约改契约。
  assert.equal(typeof tools.probeTool, 'function', 'F-1：取到的应是**形状可调用**的 null 适配器（契约成员 probeTool），不是占位 undefined');
  assert.deepEqual(tools.probeTool('x'), { state: 'absent', reason: 'port-unavailable' },
    'F-1：null 工具的查询返回「不存在」态（absent ≠ errored，内建路径语义）');

  // 反向开关（**迁移后形态**：环境闩，不再是对外 `harden` 参数）：关掉取件加固 ⇒ 裸解引用 ⇒ 判红读数
  //   为此显式把 `tools` 槽位声明为 `null`（缺省形态之一），使裸取件拿到的正是 `null`
  //   —— 判红读数与迁移前**等价**：`TypeError: Cannot read properties of null (reading 'probeTool')`。
  const broken = createBusWithHardenOff('f1', { ports: { ...requiredPortsFixture(), tools: null } });
  assert.equal(broken.of('tools'), null, '关加固后 of() 返回裸 null（这是 F-1 的缺陷形态）');
  assert.throws(
    () => broken.of('tools').probeTool('x'),
    (err) => err instanceof TypeError && /reading 'probeTool'/.test(String(err.message)),
    'F-1 判红读数 = TypeError: Cannot read properties of null (reading \'probeTool\')',
  );
});

// ── F-2 降级不可见（AC-15）──────────────────────────────────────────────────────────────
//   Δ vs selftest：selftest 只验「missing 与 capability-* 记录非空」；本处另验
//   ① 逐槽位与 report().slots 的 present 一致 ② `register` 会**撤销**该槽位的降级记录（撤销语义 selftest 未测）。
test('F2 降级必须可见：三个可选同时缺 ⇒ missing/capability-* 逐项在场；register 撤销该槽记录；关加固 ⇒ 静默降级', () => {
  const bus = createBus({ ports: requiredPortsFixture() });
  const rep = bus.report();
  const optionalMissing = rep.missing.filter((s) => ['roster', 'tools', 'http'].includes(s));
  assert.deepEqual([...optionalMissing].sort(), ['http', 'roster', 'tools'], 'F-2：三个可选端口同时缺时必须**逐个**可见（降级不得静默）');
  assert.ok(rep.capabilityRecords.length >= 1, 'F-2：须有 capability-* 记录（回显通道）');
  assert.ok(rep.capabilityRecords.every((line) => /^capability-(disabled|missing):/.test(line)), 'F-2：记录前缀须为 capability-disabled/missing');
  // 两维读法（写清以免误读）：`missing` = 「调用方未提供 / 降级发生」；`present` = 「该槽位**可取件**」
  //   （可选槽位缺失时由 null 适配器补齐 ⇒ present 仍为 true）。两者**不是同一维度**，
  //   降级可见性的判据是前者（`missing` + `capability-*` 记录），不是后者。
  for (const slot of ['roster', 'tools', 'http']) {
    assert.equal(rep.slots.find((s) => s.slot === slot).present, true,
      'F-2：可选槽位缺失但已由 null 适配器补齐 ⇒ present（可取件）为 true（降级事实由 missing 面表达）');
    assert.ok(rep.missing.includes(slot), 'F-2：该槽位同时必须出现在 missing 面（降级可见）——' + slot);
  }

  // 撤销语义（Δ vs selftest）：真正提供该槽位后，降级记录必须消失
  bus.register('http', { listen: () => ({ url: null }), close: () => {} });
  assert.equal(bus.report().missing.includes('http'), false, 'F-2：槽位被真正提供后，其降级记录必须撤销（不得留旧账）');

  // 反向开关（**迁移后形态**：环境闩）：关 f2 ⇒ record 不写 ⇒ 降级不可见（判红读数**等价**：missing=[]）
  const silent = createBusWithHardenOff('f2', { ports: requiredPortsFixture() });
  assert.deepEqual(silent.report().missing, [], 'F-2 缺陷形态：关加固后 missing 为空 ⇒ 三个可选端口缺失**静默不可见**');
  assert.deepEqual(silent.report().capabilityRecords, [], 'F-2 缺陷形态：关加固后无任何 capability-* 记录');
});

// ── F-3 出口形状退化（AC-15；判红面 = **出口退化为裸 `Row[]`**）────────────────────────────
//   【措辞订正（批 `punky-g2-tail-2026-10-30` · T-3 / AC-8）】原表述把判红面写成「**在两条路径之间比形状**」——
//   与事实不符：加固关断时 `route()` **两条路径都**退化为裸 `Row[]`（两者互相**一致**）⇒ 那种判据在恰好该红时是**绿**
//   （假绿、无判别力）。⇒ 真实判红面 = **出口形状是否退化**（`Array.isArray(out) === true` 即红）。
//   ⚠ 本用例 `:190` 的断言本体**本来就是正确形态**（数组判定），**保留未改**；本批只订正措辞。
//   Δ vs selftest：selftest 判「出口是否归一对象」；本处在**同一次调用**内比 `view`（端口路径）与
//   `builtinView`（内建路径）的**键集合**，并进一步断言**语义**（宿主名册缺一席 ⇒ builtinOnly 含该席）。
test('F-3 出口形状：正常态出口为归一对象（三键在场、非数组）；关加固 ⇒ 出口退化为裸数组（判红）', async () => {
  const seat = BUILTIN_ROLES[0];
  // 自建 roster 端口：名册**缺一席**（其余为名对象）⇒ 该席应落 builtinOnly
  const hostRoster = BUILTIN_ROLES.filter((r) => r !== seat).map((r) => ({ name: r }));
  const bus = createBus({ ports: { ...requiredPortsFixture(), roster: { read: () => hostRoster } } });

  const routed = await bus.route(seat);
  // 出口形状（正向）：整体是对象、`view` 是对象、三集合键逐项在场
  assert.equal(Array.isArray(routed), false, 'F-3：正常态 route() 出口须为归一对象，不得是裸数组');
  for (const key of ['matched', 'builtinOnly', 'hostOnly']) {
    assert.ok(Array.isArray(routed.view[key]), 'F-3：归一出口须含三集合键 ' + key + '（形状声明）');
  }
  const portKeys = Object.keys(routed.view).sort();
  const builtinKeys = Object.keys(routed.builtinView).sort();
  assert.deepEqual(portKeys, builtinKeys, 'F-3：端口路径与内建路径的视图**键集合必须相等**（同一出口形状）');
  assert.deepEqual(portKeys, ['builtinOnly', 'hostOnly', 'matched'], 'F-3：视图形状须恰为 reconcileRoster 的三集合');

  // 语义对账（不只是键名）：缺的那一席在 builtinOnly，matched 不含它
  assert.ok(routed.view.builtinOnly.includes(seat), 'F-3：宿主名册缺该席 ⇒ builtinOnly 须含该席；实际=' + JSON.stringify(routed.view.builtinOnly));
  assert.equal(routed.view.matched.includes(seat), false, 'F-3：缺位的席位不得落 matched');
  assert.deepEqual(routed.view.hostOnly, [], 'F-3：宿主名册是内建表子集 ⇒ hostOnly 为空集');
  // 与内建路径对同一入参的结果同源
  assert.deepEqual(routed.builtinView, reconcileRoster(BUILTIN_ROLES), 'F-3：内建路径视图须等于对 BUILTIN_ROLES 直接对账的结果');

  // 反向开关（**迁移后形态**：环境闩）：关 f3 ⇒ route 直返裸 Row[] ⇒ **出口形状退化**（判红读数**等价**：裸数组）
  const broken = createBusWithHardenOff('f3', { ports: { ...requiredPortsFixture(), roster: { read: () => hostRoster } } });
  const raw = await broken.route(seat);
  assert.equal(Array.isArray(raw), true, 'F-3 缺陷形态：关加固后端口路径返回裸数组（不是三集合视图）');
  assert.equal(raw.some((row) => row && typeof row === 'object' && 'matched' in row), false, 'F-3：裸数组行里不含视图三集合 ⇒ 出口形状已退化（这正是判红面）');
});

// ── F-4 空证据被判「有进展」（AC-15）──────────────────────────────────────────────────────
//   Δ vs selftest：selftest 只验「空/空 ⇒ 非 advanced」；本处另验**单边非空**的边界
//   （只有 evidence 或只有 writes ⇒ partial），并把关加固后的 `advanced` 谎报作为判红读数。
test('F-4 空证据不得被判有进展：空/空 ⇒ empty_response；单边非空 ⇒ partial；关加固 ⇒ 谎报 advanced', () => {
  const bus = createBus({ ports: requiredPortsFixture() });

  assert.equal(bus.classifyProgress({ writes: [], evidence: [] }), 'empty_response',
    'F-4：writes 与 evidence 都空 ⇒ 必须判 empty_response（不得判 advanced）');
  assert.equal(bus.classifyProgress({ writes: [], evidence: [{ kind: 'e' }] }), 'partial',
    'F-4（边界，Δ vs selftest）：只有证据没有写入 ⇒ partial（不得因「有证据」就判 advanced）');
  assert.equal(bus.classifyProgress({ writes: [{ id: 'w' }], evidence: [] }), 'partial',
    'F-4（边界）：只有写入没有证据 ⇒ partial');

  // 反向开关（**迁移后形态**：环境闩）：关 f4 ⇒ 空证据也判 advanced（谎报进展；判红读数**等价**）
  const broken = createBusWithHardenOff('f4', { ports: requiredPortsFixture() });
  assert.equal(broken.classifyProgress({ writes: [], evidence: [] }), 'advanced',
    'F-4 判红读数：关加固后空证据被判 advanced ＝ 谎报进展');
});

// ── ② AC-14 · null 适配器最小批次（独立构造 + fail-closed 面）───────────────────────────────
test('M4 最小批次（独立构造）：null 适配器 5 键齐 + 宿主最小面 ⇒ 跑完且分类 = empty_response', async () => {
  const nulls = createNullAdapters();
  assert.deepEqual(Object.keys(nulls).sort(), ['audit', 'http', 'roster', 'runtime', 'tools'],
    'null 适配器须恰为 KernelPorts 的 5 键（集合相等）');

  const bus = createBus({ ports: nulls });
  // 【W4 批 `w4-inject-teardown`】缺省能力名现在派生自 `report.host[0]` = **功能面名**（`toolSurface`），
  //   而 `nulls` 的 tools 槽位是 null 适配器（`available:false`）⇒ 若走缺省会**按设计**抛
  //   `capability-missing: toolSurface`（这正是 M5 验的 fail-closed 面）。
  //   本用例的真命题是「**跑完一轮最小批次**并分类」，与能力名无关 ⇒ 显式给一个缺省即启用的内部能力键。
  const out = await runMinimalBatch(bus, { capability: CAPABILITY_NAME, rt: { config: {} } });
  assert.ok(Array.isArray(out.steps) && out.steps.length > 0, '最小批次须记录执行步骤');
  for (const step of ['assertCapability', 'route', 'runtime', 'normalize', 'classify']) {
    assert.ok(out.steps.includes(step), '最小批次步骤缺 ' + step + '；实际=' + JSON.stringify(out.steps));
  }
  assert.equal(out.classification, 'empty_response', 'null 运行时无写入无证据 ⇒ 分类须为 empty_response');
  assert.equal(out.report.slots.every((s) => s.present === true), true, 'null 适配器全给 ⇒ 每个槽位 present=true');
});

test('M5 最小批次 fail-closed 面（Δ vs selftest）：宿主面缺失 ⇒ runMinimalBatch 抛错，不「装作装上了」', async () => {
  const bus = createBus({ ports: createNullAdapters() });
  let err = null;
  try { await runMinimalBatch(bus, {}); } catch (e) { err = e; }
  assert.ok(err, '宿主最小面为空 ⇒ 最小批次必须 fail-closed 抛错（bus 不得替宿主假装能力已装）');
  assert.ok(String(err.message).includes('capability-missing:'), '抛错消息须含 capability-missing:；实际=' + String(err.message));
});
