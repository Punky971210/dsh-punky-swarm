#!/usr/bin/env node
// bus 自证入口（可执行）：`node lib/bus/selftest.mjs`
//
// 退出码：0 = 全部检查通过；1 = 有检查失败（**含 `--break` 模式下的「缺陷已复现」**）。
//
// 模式：
//   node lib/bus/selftest.mjs                → 正向：四条加固 + 拒态/闩 + 否定对照 + 四动作 + 最小批次，全绿才 0
//   node lib/bus/selftest.mjs --break=fN     → 只关掉 F-N 那条加固 ⇒ 该条**必须红**
//                                              （N=1..4；「隔离是否成立」看 `ISOLATION:` 行，**不看退出码**）
//
// 设计要点（T-1 / T-2 之后）：
//   1. 探针**不再接收 harden 参数**：开关只经环境闩（`PUNKY_TEST_HARDEN` ＋ `PUNKY_TEST_HARDEN_FLAGS`），
//      由 `withBreak()` 在**逐探针作用域**内设置/还原 ⇒ 一条被关不会连累其它探针（原缺陷：一个 harden
//      对象传给全部探针 ⇒ 交叉污染）。
//   2. 隔离的可判形态 = **失败集合相等**（`{F-N}`），不是退出码：`--break` 两分支都 exit 1，
//      用退出码判隔离等于用一个恒等值判差异。
//   3. 「反向开关」仍是**同一实现里的一个分支**（env → `flags.fN = false`），不是另写一份缺陷实现。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBus, createNullAdapters, runMinimalBatch } from './index.js';
import { BUILTIN_ROLES } from '../roster.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const ENV_LATCH = 'PUNKY_TEST_HARDEN';
const ENV_FLAGS = 'PUNKY_TEST_HARDEN_FLAGS';

const results = [];
const record = (id, ok, readout) => {
  results.push({ id, ok, readout });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + '  ' + readout);
};
/** 从结果 id 抽机器可判的标签（`F-1` / `C0` / `C9` …），用于算失败集合。 */
const tagOf = (id) => (String(id).match(/^(F-\d|C\d+)/) ?? [''])[0];

// ── env 作用域工具：设置 → 跑 → **还原**（逐探针隔离的物理基础）────────────────────
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ── C0 形状对账（三档）：C0a 槽位键 / C0b 成员名 / C0c 判别力 ──────────────────────
//
// 演进（e3-G02@punky-adapter-audit-20261031 · e1-G01）：原 C0 只对**槽位键**
//   ⇒ 槽位内「成员名错配」结构性不可见（当时实测 4/5 槽位不一致）。C0b 把这一层补上。
//
// ⚠ **C0b 当前必须红**：null 适配器仍是旧形状（`start`/`stop`、`emit`、`list`/`call`、`listen`/`close`），
//   而契约已升到 v2（`AgentRuntime` 8 成员 / `ToolSurface` 7 / `HttpSurface` 2 / `RosterSource` 2）
//   ⇒ 实测 5/5 不一致。**转绿条件 = W2-3 按契约重写 null 适配器**。
//   **禁**为让它变绿而放宽判据 —— 那正是把 e3-G02 重新放回盲区。
//
// 解析式契约（w1 `plan/contract-v2.md` §6.1 公示的陷阱，本行**逐字对齐**该公示）：
//   成员行**必须**容忍 `readonly` 修饰符。契约现有 10 个 readonly 成员；旧式
//   `/^\s{2}([A-Za-z_]\w*)\??:/` 会把它们**全部静默漏检** ⇒ 对它们恒判「不存在」，形成假绿/假红双窗口。
const MEMBER_LINE_RE = /^\s{2}(?:readonly\s+)?([A-Za-z_]\w*)\??\s*[(:<]/;

/** 剥 TS 注释。**顺序不可反**：先剥行注释，再剥块注释
 *  （反序会把行注释里的 `/*` 当成块注释开头，吞掉后续代码 ⇒ 判据静默）。 */
const stripTsComments = (src) => src
  .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** 取 `interface <name> { … }` 的**体内文本**（花括号配平；入参须已剥注释）。找不到 ⇒ null。 */
function interfaceBodyOf(src, name) {
  const head = new RegExp('interface\\s+' + name + '\\s*\\{').exec(src);
  if (!head) return null;
  const from = head.index + head[0].length - 1; // 指向 `{`
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(from + 1, i);
    }
  }
  return null;
}

/** 接口**顶层成员名**（2 空格缩进锚定 ⇒ 天然排除嵌套块内更深缩进的行）。 */
const topLevelMembersOf = (body) => [...body.matchAll(new RegExp(MEMBER_LINE_RE.source, 'gm'))].map((m) => m[1]);

/** 成员集合差（C0b 与 C0c **共用同一比较器** ⇒ 判别力自检覆盖的正是生产判据本体）。 */
const memberDiffOf = (contractMembers, adapterMembers) => {
  const c = new Set(contractMembers);
  const a = new Set(adapterMembers);
  return {
    onlyContract: [...c].filter((m) => !a.has(m)),
    onlyAdapter: [...a].filter((m) => !c.has(m)),
  };
};
const diffIsEmpty = (d) => d.onlyContract.length === 0 && d.onlyAdapter.length === 0;

/** `KernelPorts` 块 → `{ 槽位: 接口名 }`（**解析得出，不硬编码**）。找不到块 ⇒ null。 */
function slotInterfaceMapOf(src) {
  const kp = interfaceBodyOf(src, 'KernelPorts');
  if (kp === null) return null;
  const map = {};
  for (const m of kp.matchAll(/^\s{2}([A-Za-z_]\w*)\??\s*:\s*([A-Za-z_]\w*)/gm)) map[m[1]] = m[2];
  return map;
}

// ── C0c 判别力自检：先证「探针有牙」，再报盘点结果 ────────────────────────────────
// 判据两条，缺一即红（防 C0b 因探针退化而变成**恒绿**）：
//   ① 比较器：不等对必判不等、相等对必判相等；
//   ② 解析器：四种成员形态（`readonly x:` / `f(` / `f<T>(` / `readonly x?:`）全部解析得出。
function checkCODiscrimination() {
  const comparatorOk = !diffIsEmpty(memberDiffOf(['execute', 'cancel'], ['start', 'stop']))
    && diffIsEmpty(memberDiffOf(['read', 'sessionOf'], ['read', 'sessionOf']));
  const sample = [
    '  readonly available: boolean;',      // readonly + 字段
    '  canNarrow(ask: NarrowAsk): boolean;', // 方法
    '  registerTool<T>(definition: T): boolean;', // 泛型方法（`<` 结尾形态）
    '  readonly id?: string;',              // readonly + `??` 可选标记
  ].join('\n');
  const parsed = topLevelMembersOf(sample);
  const parserOk = ['available', 'canNarrow', 'registerTool', 'id'].every((m) => parsed.includes(m))
    && parsed.length === 4;
  const ok = comparatorOk && parserOk;
  return record('C0c 判别力', ok,
    '比较器(不等对判不等/相等对判相等)=' + comparatorOk + '｜解析器=' + JSON.stringify(parsed)
    + (ok ? '  (有判别力)' : '  ⇒ **判据失效：C0a/C0b 读数不可信**'));
}

// ── C0a 槽位键对账 ─────────────────────────────────────────────────────────────
function checkSlotKeys(slotMap, nulls) {
  if (slotMap === null) {
    return record('C0a 槽位键', false, 'lib/ports.ts 内未找到 interface KernelPorts');
  }
  const fromPorts = Object.keys(slotMap);
  const fromBus = Object.keys(nulls);
  const onlyPorts = fromPorts.filter((k) => !fromBus.includes(k));
  const onlyBus = fromBus.filter((k) => !fromPorts.includes(k));
  const ok = onlyPorts.length === 0 && onlyBus.length === 0;
  return record('C0a 槽位键', ok, 'ports.ts=' + JSON.stringify(fromPorts) + ' bus=' + JSON.stringify(fromBus)
    + ' 槽位↔接口=' + JSON.stringify(slotMap)
    + (ok ? '  (集合相等)' : '  多出=' + JSON.stringify(onlyBus) + ' 缺失=' + JSON.stringify(onlyPorts)));
}

// ── C0b 成员名对账（本档的真增量）─────────────────────────────────────────────────
function checkMemberNames(src, nulls, slotMap) {
  // 防假绿：槽位映射为空时**不得**判绿（空集与空集恒等 ⇒ 无判别力）
  if (!slotMap || Object.keys(slotMap).length === 0) {
    return record('C0b 成员名', false, '槽位映射为空 ⇒ 无从对成员名（不判绿）');
  }
  const slots = Object.keys(slotMap);
  const lines = [];
  let mismatched = 0;
  for (const slot of slots) {
    const iface = slotMap[slot];
    const body = interfaceBodyOf(src, iface);
    if (body === null) {
      mismatched += 1;
      lines.push(slot + '［' + iface + '］契约接口未找到');
      continue;
    }
    const contractMembers = topLevelMembersOf(body);
    const adapterMembers = nulls[slot] ? Object.keys(nulls[slot]) : [];
    const d = memberDiffOf(contractMembers, adapterMembers);
    if (!diffIsEmpty(d)) {
      mismatched += 1;
      lines.push(slot + '［' + iface + '］契约=' + contractMembers.length + ' 适配器=' + adapterMembers.length
        + ' 缺失=' + JSON.stringify(d.onlyContract) + ' 多出=' + JSON.stringify(d.onlyAdapter));
    }
  }
  const ok = mismatched === 0;
  return record('C0b 成员名', ok,
    (ok ? '全 ' + slots.length + ' 槽位成员名集合相等'
      : '不一致 ' + mismatched + '/' + slots.length + ' 槽位（转绿条件 = W2-3 按契约重写 null 适配器）｜')
    + lines.join('｜'));
}

/** C0 驱动：C0c（先自证有牙）→ C0a → C0b。三档各自 `record()` ⇒ 失败档可分辨。 */
function checkShapeReconciliation() {
  const nulls = createNullAdapters();
  checkCODiscrimination();
  let src;
  try {
    src = stripTsComments(fs.readFileSync(path.join(ROOT, 'lib', 'ports.ts'), 'utf8'));
  } catch (err) {
    return record('C0a 槽位键', false, '读 lib/ports.ts 失败：' + String(err?.message ?? err));
  }
  const slotMap = slotInterfaceMapOf(src);
  checkSlotKeys(slotMap, nulls);
  return checkMemberNames(src, nulls, slotMap);
}

// ── F-1 可选端口被当必需直用（**零参数**：开关由调用它的 withBreak 作用域提供）──────────
async function checkF1() {
  // 构造：只给必需两项（runtime/audit）；roster 显式为 null ⇒ 可选缺失
  const ports = { runtime: createNullAdapters().runtime, audit: createNullAdapters().audit, roster: null };
  const bus = createBus({ ports });
  try {
    const routed = await bus.route('coder');
    const degrades = bus.report().degrades.map((d) => d.slot);
    const ok = degrades.includes('roster');
    return record('F-1 可选端口', ok,
      'route() 未抛；degrades=' + JSON.stringify(degrades) + '；seat=' + String(routed?.seat));
  } catch (err) {
    // 反向开关下这里必须命中：TypeError: Cannot read properties of null (reading 'read')
    return record('F-1 可选端口', false, 'THREW ' + String(err?.constructor?.name) + ': ' + String(err?.message));
  }
}

// ── F-2 降级不可见（三个可选同时缺、必需齐）────────────────────────────────────────
function checkF2() {
  const nulls = createNullAdapters();
  const bus = createBus({ ports: { runtime: nulls.runtime, audit: nulls.audit } });
  const rep = bus.report();
  const capabilityRecords = rep.capabilityRecords ?? [];
  const optionalAllMissing = ['roster', 'tools', 'http'].every((slot) => rep.missing.includes(slot));
  const ok = optionalAllMissing && capabilityRecords.length >= 1;
  return record('F-2 降级可见', ok,
    'missing=' + JSON.stringify(rep.missing) + '；capability-*记录=' + JSON.stringify(capabilityRecords));
}

// ── F-3 出口形状退化 ────────────────────────────────────────────────────────────
// 判据 = **出口是否为归一对象**（非 Array 且 `view.matched/builtinOnly/hostOnly` 三键在场）。
// 不再比「两路径键名是否相同」——关加固时两条路径**都**退化为裸 Row[]，键名自然仍相等 ⇒ 那是假绿。
const isNormalizedView = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
  && Boolean(x.view) && typeof x.view === 'object' && !Array.isArray(x.view)
  && Array.isArray(x.view.matched) && Array.isArray(x.view.builtinOnly) && Array.isArray(x.view.hostOnly);

async function checkF3() {
  const base = { runtime: createNullAdapters().runtime, audit: createNullAdapters().audit };
  const viaNull = createBus({ ports: { ...base, roster: null } });
  const viaReal = createBus({ ports: { ...base, roster: { read: () => [{ name: 'coder' }, { name: 'lead' }] } } });
  const a = await viaNull.route('coder'); // 内建路径
  const b = await viaReal.route('coder'); // 端口路径（返回等价 Row）
  const ok = isNormalizedView(a) && isNormalizedView(b);
  return record('F-3 出口形状', ok,
    'null路径归一=' + isNormalizedView(a) + '（' + (Array.isArray(a) ? '裸数组' : typeof a) + '）'
    + ' 真实端口路径归一=' + isNormalizedView(b) + '（' + (Array.isArray(b) ? '裸数组' : typeof b) + '）');
}

// ── F-4 空证据被判 advanced ──────────────────────────────────────────────────────
function checkF4() {
  const bus = createBus({ ports: { runtime: createNullAdapters().runtime, audit: createNullAdapters().audit } });
  const classification = bus.classifyProgress({ writes: [], evidence: [] });
  const ok = classification !== 'advanced';
  return record('F-4 空证据不谎报', ok, 'classification=' + classification + '（期望 ≠ advanced）');
}

// ── C5 否定对照：故意缺必需端口 ⇒ 必须抛，不得静默通过 ────────────────────────────
function checkNegativeControl() {
  const bus = createBus({}); // 不给 runtime / audit
  try {
    bus.assertCapability('tools');
    return record('C5 否定对照', false, '静默通过 ⇒ 不合格（缺必需端口却无异常）');
  } catch (err) {
    const msg = String(err?.message ?? '');
    const ok = err instanceof Error
      && err.code === undefined
      && !/^GATE_/.test(msg)
      && msg.includes('capability-missing:')
      && msg.includes('runtime');
    return record('C5 否定对照', ok,
      'THREW ' + String(err?.constructor?.name) + ' code=' + String(err?.code) + ' msg=' + JSON.stringify(msg));
  }
}

// ── C6 四动作各一条探针 ─────────────────────────────────────────────────────────
async function checkFourActions() {
  const nulls = createNullAdapters();
  const bus = createBus({ ports: { runtime: nulls.runtime, audit: nulls.audit } });
  const out = [];
  out.push('register→' + bus.register('tools', { list: () => [], call: () => ({ ok: true }) }));
  out.push('assertCapability→' + String(bus.assertCapability('tools', { ctx: { tools: {} } })));
  out.push('route→' + String((await bus.route('coder')).seat));
  out.push('normalize→' + JSON.stringify(Object.keys(bus.normalize({ writes: [], evidence: ['e'] })).sort()));
  const ok = out.every((line) => !line.includes('undefined'));
  return record('C6 四动作', ok, out.join(' ｜ '));
}

// ── C7 最小批次跑完（runMinimalBatch）──────────────────────────────────────────
async function checkMinimalBatch() {
  const nulls = createNullAdapters();
  const bus = createBus({ ports: { runtime: nulls.runtime, audit: nulls.audit } });
  const summary = await runMinimalBatch(bus, {
    capability: 'tools',
    rt: { ctx: { tools: {} } }, // 最小宿主面：只声明本次断言用到的那一项（其余不放宽）
    task: { id: 'selftest-task', role: BUILTIN_ROLES[0] },
  });
  const ok = summary.steps.length >= 5 && summary.classification === 'empty_response';
  return record('C7 最小批次', ok,
    'steps=' + JSON.stringify(summary.steps) + ' classification=' + summary.classification);
}

// ── C8 T-1 态②：对外传 `harden` ⇒ **抛普通 Error**（不是忽略）────────────────────
function checkHardenRejected() {
  try {
    createBus({ harden: {} });
    return record('C8 拒 harden', false, '静默通过 ⇒ 不合格（harden 被忽略 = 换位置重开的静默降级）');
  } catch (err) {
    const msg = String(err?.message ?? '');
    const ok = err instanceof Error
      && err.code === undefined
      && !/^GATE_/.test(msg)
      && msg.includes('harden')
      && msg.includes(ENV_LATCH);
    return record('C8 拒 harden', ok,
      'THREW ' + String(err?.constructor?.name) + ' code=' + String(err?.code) + ' msg=' + JSON.stringify(msg));
  }
}

// ── C9 T-1 态③/④：环境闩双条件 ＋ 未知 flag ⇒ 抛 ─────────────────────────────────
function checkEnvLatch() {
  const nulls = createNullAdapters();
  const make = () => createBus({ ports: { runtime: nulls.runtime, audit: nulls.audit } });
  // ① 闩**关**（或非 '1'）⇒ FLAGS 被**完全忽略**（半生效即违规）
  const latchOff = withEnv({ [ENV_LATCH]: undefined, [ENV_FLAGS]: 'f2' }, () => make().report().missing);
  // ② 闩**开** ⇒ 只关断 FLAGS 列出的那条（f2 关 ⇒ 降级不再记录 ⇒ missing 为空）
  const latchOn = withEnv({ [ENV_LATCH]: '1', [ENV_FLAGS]: 'f2' }, () => make().report().missing);
  // ③ 未知 flag ⇒ 抛（不得静默忽略）
  let unknown = null;
  try { withEnv({ [ENV_LATCH]: '1', [ENV_FLAGS]: 'f9' }, () => make()); } catch (err) { unknown = err; }
  const ok = latchOff.length > 0
    && latchOn.length === 0
    && unknown instanceof Error
    && String(unknown.message).includes('unknown flag');
  return record('C9 闩双条件', ok,
    '闩关⇒missing=' + JSON.stringify(latchOff) + '（须非空）／闩开+FLAGS=f2⇒missing=' + JSON.stringify(latchOn)
    + '（须为空）／未知 flag⇒' + (unknown ? 'THREW ' + String(unknown.message) : '未抛（不合格）'));
}

// ── main ──────────────────────────────────────────────────────────────────────
const breakArg = process.argv.slice(2).find((a) => a.startsWith('--break='));
const breakTarget = breakArg ? breakArg.slice('--break='.length) : null;
const expectedTag = breakTarget ? 'F-' + breakTarget.slice(1) : null;

console.log('== bus selftest ==' + (breakTarget ? '  [只关 F-' + breakTarget.slice(1) + ' 那条加固]' : ''));

/** 逐探针作用域：**只给自己那条**设 flags，其余探针拿到空 flags（= 全开）。 */
async function withBreak(id, fn) {
  // 注意 `id` 可能是 null（非 break 探针）⇒ 必须用 `id && …`，否则 `null === null` 会把 FLAGS 设成 "null"。
  const flags = id && breakTarget === id ? id : '';
  return withEnv({ [ENV_LATCH]: '1', [ENV_FLAGS]: flags }, () => fn());
}

/** 逐检查捕获：某条加固被关掉后若真抛出，也要记成**触发它的那条**的 FAIL，而不是让脚本崩掉。 */
async function runSafely(label, fn) {
  try {
    return await fn();
  } catch (err) {
    return record(label + ' 探针异常', false, 'THREW ' + String(err?.constructor?.name) + ': ' + String(err?.message));
  }
}

await runSafely('C0', () => withBreak(null, checkShapeReconciliation));
await runSafely('F-1', () => withBreak('f1', checkF1));
await runSafely('F-2', () => withBreak('f2', checkF2));
await runSafely('F-3', () => withBreak('f3', checkF3));
await runSafely('F-4', () => withBreak('f4', checkF4));
if (!breakTarget) {
  await runSafely('C5', checkNegativeControl);
  await runSafely('C6', () => withBreak(null, checkFourActions));
  await runSafely('C7', () => withBreak(null, checkMinimalBatch));
  await runSafely('C8', checkHardenRejected);
  await runSafely('C9', checkEnvLatch);
}

const failed = results.filter((r) => !r.ok);
const failSet = [...new Set(failed.map((r) => tagOf(r.id)).filter(Boolean))].sort();

if (breakTarget) {
  const actualF = failSet.filter((t) => t.startsWith('F-'));
  const isolated = actualF.length === 1 && actualF[0] === expectedTag;
  console.log('== BREAK ' + breakTarget + ' ⇒ 失败集合={' + failSet.join(',') + '} 期望={' + expectedTag + '} ==');
  // 退出码：保持既有「复现即 exit 1」语义 —— **不作为隔离判据**（两分支同为 1）
  console.log('ISOLATION: ' + (isolated ? 'ok' : 'VIOLATED（期望 {' + expectedTag + '}）'));
  process.exit(1);
}

console.log('== ' + (failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED 失败集合={' + failSet.join(',') + '}')
  + ' ⇒ exit ' + (failed.length === 0 ? 0 : 1) + ' ==');
process.exit(failed.length === 0 ? 0 : 1);
