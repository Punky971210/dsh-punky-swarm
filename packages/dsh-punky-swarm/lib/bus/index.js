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

// 端口总线（bus）：**端口槽位域的唯一归属点**，与「装配开关」「职位表」两域**只引用不复制**。
//
// 三域边界（写死，禁混）：
//   · 端口槽位 → **本文件**（`KernelPorts` 5 键，形状由 `lib/ports.ts:76` 定义；本文件只声明槽位名，
//     由 `selftest.mjs` 与 `ports.ts` 文本对账，防两处漂移）；
//   · 装配开关 → 引用 `lib/capabilities.js`（`CAPABILITY_KEYS` / `HOST_INJECTIONS` / `capabilityReport`），
//     本文件**不自建能力表**；
//   · 职位表 → 引用 `lib/roster.js`（`BUILTIN_ROLES` / `reconcileRoster`），本文件**不自造职位名单**。
//
// 手写 `.js` 的硬理由（不是「build 会扫掉」）：回拷清单是**显式枚举**（`scripts/copy-ts-built.mjs` 只对清单
//   逐项 `cpSync`，末尾只 `rmSync('.tsbuild')`）⇒ 本目录若写 `.ts`，emit 到 `.tsbuild/bus/*.js` 后**永不回拷**，
//   `.tsbuild` 一删就是运行期 `ERR_MODULE_NOT_FOUND`。手写 `.js` 本身**不会**被 build 触碰。
//
// 四条可证伪面（F-1…F-4）在本文件各有**单点**加固。反向校验开关**不在对外签名里**：生产不可关断，
//   测试缝只走环境闩 `PUNKY_TEST_HARDEN=1` ＋ `PUNKY_TEST_HARDEN_FLAGS`（**调用时读取**）。
//   开关的唯一用途 = 证明「使它不再发生的那一行」真的在起作用：
//     F-1 可选端口被当必需直用  → `of()` 单点取件（缺省已由 null 适配器补齐）
//     F-2 降级不可见            → `record()` 是 `degrades` 的唯一写入点，`report().missing` 由它投影
//     F-3 出口形状退化          → `toRosterView()` 是唯一出口形状（判红 = 出口退化为裸 Row[]；按「路径间差异」判会假绿——关加固时两条都退化为数组）
//     F-4 空证据被判 advanced   → `classifyProgress()` 要求 evidence 与 writes **都非空**
import { BUILTIN_ROLES, reconcileRoster } from '../roster.js';
import { CAPABILITY_KEYS, HOST_INJECTIONS, capabilityReport } from '../capabilities.js';

/** 端口槽位（本文件唯一声明点）。形状与 `lib/ports.ts#KernelPorts` 由 `selftest.mjs` 逐键对账。 */
const PORT_SLOTS = ['runtime', 'audit', 'roster', 'tools', 'http'];

/** 必需槽位：缺失即 fail-closed（不静默替代）。其余槽位缺失 = 内核自建语义 ⇒ 由 null 适配器补齐并记降级。 */
const REQUIRED_SLOTS = ['runtime', 'audit'];

/** 可选槽位：缺失时注入 null 实现，且**必须**留下降级记录（F-2）。 */
const OPTIONAL_SLOTS = PORT_SLOTS.filter((slot) => !REQUIRED_SLOTS.includes(slot));

const HARDEN_ALL = { f1: true, f2: true, f3: true, f4: true };

/**
 * null 适配器：`KernelPorts` 5 键各一份「什么都不做但**形状可调用**」的实现。
 * 用途 = 让「端口缺失」走**内建/空实现路径**而不是空指针（F-1 的正向面）。
 */
export function createNullAdapters() {
  return {
    runtime: {
      start: (spec) => ({ ok: true, writes: [], evidence: [], spec: spec ?? null }),
      stop: () => ({ ok: true }),
    },
    audit: { emit: () => null },
    roster: { read: () => [] },
    tools: { list: () => [], call: () => ({ ok: false, reason: 'no-tool-surface' }) },
    http: { listen: () => ({ url: null }), close: () => {} },
  };
}

// ── 环境闩（**唯一**测试缝）：生产零环境变量 ⇒ 零覆盖 ─────────────────────────────
const HARDEN_ENV_LATCH = 'PUNKY_TEST_HARDEN'; // 必须恰为 '1'
const HARDEN_ENV_FLAGS = 'PUNKY_TEST_HARDEN_FLAGS'; // 'f1' | 'f1,f2' | '' —— 要被关断的开关名

/**
 * 读环境闩。**必须在 `createBus` 调用时读取**（模块加载时读会让闩变成全局一次性，
 * 那样 `selftest.mjs` 的逐探针隔离就废了）。
 */
const hardenFlagsFromEnv = () => {
  if (process.env[HARDEN_ENV_LATCH] !== '1') return {}; // 生产：一切照旧（四条全开）
  const raw = String(process.env[HARDEN_ENV_FLAGS] ?? '');
  const out = {};
  for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(token in HARDEN_ALL)) throw new Error('harden env rejected: unknown flag: ' + token);
    out[token] = false;
  }
  return out;
};

/**
 * 建总线。
 *
 * @param {object} [opts]
 * @param {{report?: Function}|null} [opts.capabilities] 装配开关面（缺省用 `lib/capabilities.js` 的 `capabilityReport`）。
 * @param {object|null} [opts.roster] 职位面（缺省用 `lib/roster.js`）。
 * @param {Record<string, object>|null} [opts.ports] 外部端口注入（键须 ⊆ `PORT_SLOTS`）。
 *
 * ⚠ **不支持 `harden` 参数**：四条加固在生产**不可关断**。测试缝只走环境闩
 *   （`PUNKY_TEST_HARDEN=1` ＋ `PUNKY_TEST_HARDEN_FLAGS`）。
 *   若 `opts` 里出现 `harden` 键 ⇒ **抛普通 `Error`**（不是忽略、也不是静默生效）——
 *   忽略等于把「静默降级」换个位置重开，且这次连报错都没有。
 */
export function createBus(opts = {}) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'harden')) {
    throw new Error('createBus rejected: `harden` 不是对外参数（生产不可关断加固；测试缝走 '
      + HARDEN_ENV_LATCH + '=1 + ' + HARDEN_ENV_FLAGS + '）');
  }
  const { capabilities = null, roster = null, ports = null } = opts ?? {};
  const flags = { ...HARDEN_ALL, ...hardenFlagsFromEnv() };
  const nulls = createNullAdapters();
  const resolved = new Map();
  const degrades = [];

  // 降级记录的唯一写入点（F-2 单点）：关闭 f2 ⇒ 不记 ⇒ 降级不可见。
  const record = (slot, reason, source) => {
    if (!flags.f2) return;
    degrades.push({ slot, reason, source });
  };

  for (const slot of PORT_SLOTS) {
    const supplied = ports?.[slot];
    if (supplied != null) { resolved.set(slot, supplied); continue; }
    if (OPTIONAL_SLOTS.includes(slot)) {
      resolved.set(slot, nulls[slot]); // 缺失语义 = 内核自建 ⇒ 空实现
      record(slot, 'absent', 'null-adapter');
    } else {
      resolved.set(slot, null); // 必需缺失：留空，由 assertCapability fail-closed
      record(slot, 'required-absent', 'caller');
    }
  }

  // ── F-1 单点：取件的唯一入口（可选槽位永不返回 null）────────────────────────────
  const of = (slot) => {
    if (!PORT_SLOTS.includes(slot)) throw new Error('unknown port slot: ' + slot);
    if (flags.f1) return resolved.get(slot);
    return ports?.[slot]; // 反向开关：裸解引用 ⇒ 可选槽位缺失时 TypeError
  };

  // ── F-3 单点：名册视图的唯一出口形状 ────────────────────────────────────────────
  const toRosterView = (input) => {
    const names = (Array.isArray(input) ? input : [])
      .map((row) => (typeof row === 'string' ? row : row?.name))
      .filter((name) => typeof name === 'string' && name.length > 0);
    // 端口路径与内建路径都落到同一个函数 ⇒ 形状恒等（`{matched,builtinOnly,hostOnly}`）
    return reconcileRoster(names);
  };

  const register = (slot, impl) => {
    // 注册键 ⊆ KernelPorts 5 键；**不**接受能力键（禁把两域并表）
    if (!PORT_SLOTS.includes(slot)) throw new Error('register rejected: not a kernel port slot: ' + slot);
    if (impl == null) throw new Error('register rejected: implementation missing for slot: ' + slot);
    resolved.set(slot, impl);
    const at = degrades.findIndex((d) => d.slot === slot);
    if (at >= 0) degrades.splice(at, 1); // 该槽位已被真正提供 ⇒ 降级记录撤销
    return slot;
  };

  const assertCapability = (name, rt = {}) => {
    // ① 必需端口缺失 ⇒ fail-closed（AC-14 否定对照面）。普通 Error、不设 code、不以 GATE_ 开头。
    const missingRequired = REQUIRED_SLOTS.filter((slot) => resolved.get(slot) == null);
    if (missingRequired.length > 0) {
      throw new Error('capability-missing: ' + missingRequired.join(','));
    }
    // ② 能力名域校验：只认能力面（宿主注入键 ∪ 内部能力键），端口名不当能力名混用
    const known = new Set([...HOST_INJECTIONS, ...CAPABILITY_KEYS]);
    if (!known.has(name)) {
      throw new Error('unknown capability: ' + name);
    }
    // ③ 装配开关面（引用不自建）
    const report = typeof capabilities?.report === 'function' ? capabilities.report(rt) : capabilityReport(rt);
    if (Array.isArray(report?.missing) && report.missing.includes(name)) {
      throw new Error('capability-missing: ' + name);
    }
    return true;
  };

  const route = async (role) => {
    const source = of('roster');
    const rows = await source.read();
    if (!flags.f3) {
      return rows; // 反向开关：route 直返裸 Row[] ⇒ 出口形状退化（F-3 红）；注意两条路径此时**都**退化为数组，故判据必须落在「形状是否归一对象」上
    }
    const seatView = toRosterView(rows);
    const builtinView = toRosterView(roster?.builtinRoles ?? BUILTIN_ROLES);
    const known = BUILTIN_ROLES.includes(role);
    return {
      role,
      known,
      seat: known ? (seatView.matched.includes(role) ? 'matched' : 'builtin-only') : 'unknown',
      view: seatView,
      builtinView,
    };
  };

  const normalize = (result) => {
    const r = result ?? {};
    // 只归形状：**不引入内部执行态字段**（终止原因族一律不入本面）、不做 settleable 判定（该判定归 auto-settle）
    return {
      ok: r.ok !== false,
      writes: Array.isArray(r.writes) ? [...r.writes] : [],
      evidence: Array.isArray(r.evidence) ? [...r.evidence] : [],
      shape: 'exec-result',
    };
  };

  const classifyProgress = (result) => {
    const n = normalize(result);
    if (!flags.f4) return 'advanced'; // 反向开关：空证据也判 advanced（F-4 红）
    if (n.evidence.length > 0 && n.writes.length > 0) return 'advanced';
    if (n.evidence.length === 0 && n.writes.length === 0) return 'empty_response';
    return 'partial';
  };

  const report = () => ({
    slots: PORT_SLOTS.map((slot) => ({
      slot,
      required: REQUIRED_SLOTS.includes(slot),
      present: resolved.get(slot) != null,
    })),
    // 与 degrades **同源**（F-2）：不两处各算
    missing: degrades.map((d) => d.slot),
    degrades: degrades.map((d) => ({ ...d })),
    capabilityRecords: degrades.map((d) => 'capability-' + (d.reason === 'absent' ? 'disabled' : 'missing') + ': ' + d.slot),
  });

  return { register, assertCapability, route, normalize, classifyProgress, report, of };
}

/**
 * 最小批次：跑完一轮「取件 → 断言 → 解析 → 归一 → 分类」，产出可判读数。
 * 不做真实执行（runtime 由调用方提供；null 适配器下必然 `empty_response`）。
 */
export async function runMinimalBatch(bus, spec = {}) {
  const steps = [];
  // 能力断言由**调用方声明的最小宿主面**（`spec.rt`）驱动：bus 不替宿主「装作装上了」——
  //   缺省 `{}` ⇒ 宿主键全缺 ⇒ fail-closed 抛错（这正是要保住的行为）。
  bus.assertCapability(spec.capability ?? HOST_INJECTIONS[0], spec.rt ?? {});
  steps.push('assertCapability');

  const task = spec.task ?? { id: 'bus-minimal-task', role: BUILTIN_ROLES[0] };
  const routed = await bus.route(task.role);
  steps.push('route');

  const raw = typeof spec.execResult === 'object' && spec.execResult !== null
    ? spec.execResult
    : await bus.of('runtime').start(task);
  steps.push('runtime');

  const normalized = bus.normalize(raw);
  steps.push('normalize');
  const classification = bus.classifyProgress(raw);
  steps.push('classify');

  return {
    steps,
    task,
    routed,
    classification,
    writes: normalized.writes.length,
    evidence: normalized.evidence.length,
    report: bus.report(),
  };
}
