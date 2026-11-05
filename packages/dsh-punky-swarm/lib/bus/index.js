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

// ═══════════════════════════════════════════════════════════════════════════════════════
// 【冻结 · 2026-10-31 · 批 `punky-adapter-split-20261031` lane `w1-c0b-assert`】
//
//   **本文件当前「生产零调用」** —— 实测，不是推断：
//     · `createBus` 在全仓 `lib/**`（**除 `lib/bus/` 自身**）**零调用点**；
//     · `lib/ports.js`（契约的运行期回拷产物）只有 `export {}` ⇒ 端口契约**无运行期消费方**；
//     · 真正在跑的适配实现是 `lib/host-ports/**`（由业务层直接 import）。
//   ⇒ 本文件是**已死但未清的适配层雏形**。**处置取丙：保留待用 + 冻结误导面（不删除）。**
//
//   **接线前必须依次过这三关**（任一未过就接线 = 把已知违例接进生产路径）：
//     · **e1-G01** 端口契约三面互不相符：`lib/ports.ts` 的接口成员 × 本文件的 null 适配器成员
//       × `lib/host-ports/**` 的实现成员，三者交集极小。
//       **进度（W2 批 · lane `w2-null-adapters`）**：本文件的 null 适配器**已按契约 v2 重写**，
//       `selftest.mjs` 的 **C0b 成员名**档实测 **5/5 全绿**（重写前为 5/5 不一致）。
//       ⇒ 三面中的**本文件这一面已对齐**；`lib/host-ports/**`（实现面）与契约的对齐仍归 W3，别把两件事混为一谈。
//     · **e1-G09** 门禁把 J6-d 违例**冻结成契约**：`test/g2-ports-contract.test.js` 的 B3 **要求**本文件
//       引用能力域模块的导出（当前满足 = `CAPABILITY_KEYS` / `capabilityReport`）。
//       **进度**：本文件已**不再引用 `HOST_INJECTIONS`**（W2 批，见下方 import 处注释）；
//       该门断言的是「引用能力域模块」而非「引用 `HOST_INJECTIONS` 这个名字」，故**未撞红**（实测 B3 绿）。
//       残留：B3 的正则仍把 `HOST_INJECTIONS` 列为可接受的替代 ∨ 项 —— 属门禁措辞面，整改归门禁批次。
//     · **e1-G10** 本文件内置两条越界语义：① 能力名域（`assertCapability()`）—— **进度：已改**
//       （功能面主域 + 宿主键由报告派生，见该函数注释）；② `route()` 以 roster 命中判席位
//       （`seatView.matched.includes(role)`，J3'-a「在册真源读 roster」）—— **未改**，
//       ⇒ ① 已解、② 仍在，接线前须与 J3'/AC-14 同批处置。
//       （上列各处**按代码锚点定位，不写行号** —— 行号会随本文件改动漂移。）
//
//   **禁**：在本文件新增任何运行期消费方；**禁**：把本文件当作「适配层已成立」的证据引用。
//   **禁**：为了让 C0b 转绿而放宽 `selftest.mjs` 的判据（那正是把 e3-G02 重新放回盲区）。
// ═══════════════════════════════════════════════════════════════════════════════════════

// 端口总线（bus）：**端口槽位域的唯一归属点**，与「装配开关」「职位表」两域**只引用不复制**。
//
// 三域边界（写死，禁混）：
//   · 端口槽位 → **本文件**（`KernelPorts` 5 键，形状由 `lib/ports.ts` 的 `interface KernelPorts` 定义；
//     本文件只声明槽位名，由 `selftest.mjs` 与 `ports.ts` 文本对账，防两处漂移）；
//   · 装配开关 → 引用 `lib/capabilities.js`（`CAPABILITY_KEYS` / `capabilityReport`），
//     本文件**不自建能力表**；（**W2 批起不再引用 `HOST_INJECTIONS`**，理由见下方 import 处）
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
// ⚠ 本文件**不再引用** `HOST_INJECTIONS`（W2 批 · `punky-adapter-split-20261031` lane `w2-null-adapters`）：
//   理由 = W4 落地后插件 `inject` 里不再有宿主服务名 ⇒ 以它为「能力名域」的合法性消失（e1-G04 / e3-G04）。
//   替代：① 功能面名域（`FUNCTION_FACES`，判端口自身 `available`）
//         ② 宿主键由 `capabilityReport(rt).host` **派生**（不 import 常量，随 capabilities.js 单点变化）
import { CAPABILITY_KEYS, capabilityReport } from '../capabilities.js';
// ── 【跨层依赖已解除 · W2 批 · lane `w2-null-adapters`】─────────────────────────────────
//   重写前：本文件 `import { HOST_PORT_INVALID } from '../host-ports/index.js'` —— 只为让 null 适配器的
//     `invokeTool` 抛出与实现面同名的前缀（`contract-shape.md` §S-4 ② 的旧要求）。
//   **问题（方向是反的）**：适配层（bus）→ provider 实现（host-ports）。而 `w2-move-host-ports`
//     正在把 `lib/host-ports/**` 整体迁入 `lib/provider-dsh/` ⇒ 那行 import 会在迁移收口时**直接断**
//     （`ERR_MODULE_NOT_FOUND`）。这不是「以后再说」的事。
//   **处置（两条候选路都不可用的实证）**：
//     · 上提到契约层 `lib/ports.ts` —— 撞 W1-1 **冻结写域**红线 ❌；
//     · 改指向 `lib/provider-dsh/` —— 该目录当前只有 **骨架**（`index.js` 仅 `name` + 空 `apply`），
//       **未导出** `HOST_PORT_INVALID`，且搬迁 lane 的文件拆分（`tools.js`？`index.js`？）**尚未定案**
//       ⇒ 现在照抄一个路径就是对在途工作的**猜测性耦合**，比原依赖更脆 ❌；
//     · 在本文件另写一份字面量 —— 成**第二处定义点**，与 AC-12「前缀定义点各恰 1 个」的**意图**冲突
//       （藏在非 export 常量里能骗过 grep，但那是假绿）❌。
//   **实际处置：本文件**不依赖该前缀**。null 适配器的 `invokeTool` 改用**本层自己的**拒态词汇
//     `capability-missing:`（与 `assertCapability` 同源，见该函数注释）——契约 `ToolSurface.invokeTool`
//     只要求「工具面不可用时抛」，**未规定前缀**（契约 v2 为准，`contract-shape` 为旧版）。
//   **代价实测为 0**：全仓**无任何调用方按 `host-port-invalid:` 分支**（唯一提及处是
//     `test/host-ports.test.js` H1，测的是**真实现** `createToolsPort`，不涉 null 适配器）。
//   **前向兼容**：将来若把该前缀上提到契约层（解冻后），本文件可**零改**地继续工作（本就不引用它）。

/** 端口槽位（本文件唯一声明点）。形状与 `lib/ports.ts#KernelPorts` 由 `selftest.mjs` 逐键对账。 */
const PORT_SLOTS = ['runtime', 'audit', 'roster', 'tools', 'http'];

/** 必需槽位：缺失即 fail-closed（不静默替代）。其余槽位缺失 = 内核自建语义 ⇒ 由 null 适配器补齐并记降级。 */
const REQUIRED_SLOTS = ['runtime', 'audit'];

/** 可选槽位：缺失时注入 null 实现，且**必须**留下降级记录（F-2）。 */
const OPTIONAL_SLOTS = PORT_SLOTS.filter((slot) => !REQUIRED_SLOTS.includes(slot));

/**
 * **功能面名 → 端口槽位**（`assertCapability` 的**主域名**）。
 *
 * 依据 J6-d「适配层只认**功能面词表**，不认宿主专有名」（e1-G04 / e3-G04）：
 *   ⇒ 判据 = 「**该端口拿到没有**」（`port.available`），**不是**「宿主有没有那个服务」。
 * 名字取本层语义（与 `lib/ports.ts` 的接口名同形），**不含任何宿主服务名**。
 */
const FUNCTION_FACES = {
  toolSurface: 'tools',
  httpSurface: 'http',
  agentRuntime: 'runtime',
  rosterSource: 'roster',
  auditSink: 'audit',
};

const HARDEN_ALL = { f1: true, f2: true, f3: true, f4: true };

/** 无操作的 dispose（`http.mountRoute` 降级返回值用；与实现面同形）。 */
const NOOP = () => {};

/**
 * null 适配器：`KernelPorts` 5 键各一份「什么都不做但**形状符合契约**」的实现。
 *
 * 用途 = 让「端口缺失」走**内建/空实现路径**而不是空指针（F-1 的正向面）。
 *
 * **形状基准 = `lib/ports.ts`（契约 v2），成员名逐字对齐**：
 *   由 `selftest.mjs` 的 `C0b 成员名` 档做**集合相等**机检（双向空差集）。
 *   ⇒ 改这里任何一个成员名都会让 C0b 转红 —— **这是设计**（e3-G02 的盲区就是 C0 只对槽位键）。
 *
 * 三条语义纪律（与实现面同口径，不因「空实现」而放宽）：
 *   ① `available:false` = 「本宿主拿不到该功能」⇒ 调用方须走**可判定降级**，**不得**静默当成可用；
 *   ② **查询类不抛**（返回 `absent` / `null` / `false` / `[]`），**执行类在不可用时抛**
 *      （让「拿不到」以本层可识别的形态暴露，而非下沉成宿主原生错或被当成成功）；
 *   ③ 拒态用**本层**词汇，禁写宿主服务名/入口名。
 */
export function createNullAdapters() {
  return {
    runtime: {
      available: false,
      // 无「收窄见证」⇒ fail-closed（契约 canNarrow 纪律：不可核对的收窄不得宣称成立）
      canNarrow: () => false,
      narrowVia: 'none',
      personaVia: 'none',
      depthVia: 'none',
      // 空执行结果：字段集对齐 `ExecResult`；保留 `writes`/`evidence`（归一/分类面据它们判空转）
      // 【U-5 修复 · 2026-11-05 · 用户裁决甲】**null 适配器的 `push_execute` 不得冒充成功**。
    //   原实现 `exitCode: 0` ⇒ 拿到桩的消费方会把「**没派发**」读成 `exitCode: 0` = **成功**
    //   ⇒ 与全仓「不得冒充成功」纪律冲突（同族范例见下方 `cancel`：它报 `skipped` + 成因，不冒充「已停」）。
    //   现改为：① `dispatched: false` = 显式「未派发」标记 ② `exitCode: null` = 无结果（不是 0）
    //   ③ `reason` 与 `cancel` 同族成因（agent-runtime-unavailable）。
    //   ⚠ 消费方（`bus/index.js` 的 `normalize` / `classifyProgress`）不读 `exitCode` 做判定；
    //     读 `exitCode` 的是 `command.js` 的命令执行结果，与本桩无关（两套 ExitResult）。
    push_execute: async () => ({
      dispatched: false,
      reason: 'agent-runtime-unavailable',
      timedOut: false,
      exitCode: null,
      signal: null,
      writes: [],
      evidence: [],
    }),
      // 【T-B · 批 `punky-three-tasks-20261103`】null 适配器的 `cancel` **必须显式三态**、**不得返 `undefined`**：
      //   无真实运行时 ⇒ 没有可取消的对象，但**也不是**「已停」⇒ 报 `skipped` + 成因（by-value 面，不抛）。
      cancel: async () => ({ outcome: 'skipped', reason: 'agent-runtime-unavailable' }),
      // 失败以返回值表达、**不抛**（契约 NotifyLeaderResult 纪律）；成因用功能面词汇
      notifyLeader: async () => ({ delivered: false, reason: 'agent-runtime-unavailable' }),
    },
    // 审计出口：内核默认**唯一实现**，null 适配器只服务测试缝（契约 AuditSink 定性订正）
    audit: { append: () => undefined },
    roster: {
      read: async () => [],
      // 三档语义：名不在名册 ⇒ `null`（**正常态**，不抛）；本实现下「无名册」即恒 null
      sessionOf: async () => null,
    },
    tools: {
      available: false,
      hasTool: () => false,
      // 三态查询：不可用 ⇒ `absent`（**不是** `errored` —— 查询失败与「不存在」不得混同）
      probeTool: () => ({ state: 'absent', reason: 'port-unavailable' }),
      getTool: () => null,
      registerTool: () => false,
      installGuard: () => false,
      // 执行类：不可用时**抛**。拒态用**本层**词汇 `capability-missing:`（与 `assertCapability` 同源），
      //   **不**引用 `lib/host-ports/` 的 `host-port-invalid:` 前缀 —— 那会造成「适配层 → provider 实现」
      //   的反向依赖，且该前缀在契约层并无定义（详见本文件 import 处的「跨层依赖已解除」注）。
      invokeTool: async () => {
        throw new Error('capability-missing: toolSurface 不可用（null 适配器：无宿主工具面）');
      },
    },
    http: {
      available: false,
      // 可判定降级：不抛（契约 HttpSurface.mountRoute 纪律）
      mountRoute: () => ({ mounted: false, dispose: NOOP }),
    },
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

  /**
   * 能力断言（三域，判据来源各不相同）。
   *
   * **W2 批能力名域变更**（e1-G04 / e3-G04）：本函数**不再**以 `HOST_INJECTIONS` 作能力名域。
   *   理由：W4 落地后插件 `inject` 里不再有宿主服务名 ⇒ 拿 `inject` 的源常量当「能力名」的合法性消失。
   *   现三域：
   *     ① **功能面主域**（`FUNCTION_FACES`）⇒ 判**端口自身** `available`，完全不碰能力面；
   *     ② **内核策略键**（`CAPABILITY_KEYS`）⇒ 判 `report.missing`（引用不自建）；
   *     ③ **宿主键**（`report.host` **派生**，不再 import 常量）⇒ 判 `report.missing`。
   *   ⚠ ③ 是**过渡兼容域**：现有调用方（含 `test/g2-bus-falsify.test.js:61` 的
   *     `CAPABILITY_NAME`）仍传宿主键。**移除条件** = 调用方改传功能面名（W4 / 测试 lane）。
   *     它已不再由本文件持有宿主名清单 —— 名字集随 `capabilities.js` 单点变化。
   *
   * 判据顺序**不可换**：① 必需端口 → ② 域名判定 → ③ 缺失判定。
   *   「未知名」必须是 `unknown capability:`，「已知但缺失」才是 `capability-missing:`（两态可辨，禁混同）。
   */
  const assertCapability = (name, rt = {}) => {
    // ① 必需端口缺失 ⇒ fail-closed（AC-14 否定对照面）。普通 Error、不设 code、不以 GATE_ 开头。
    const missingRequired = REQUIRED_SLOTS.filter((slot) => resolved.get(slot) == null);
    if (missingRequired.length > 0) {
      throw new Error('capability-missing: ' + missingRequired.join(','));
    }
    // ② 功能面主域：判「端口拿到没有」。`of()` 走 F-1 单点（可选槽位恒非 null）。
    if (Object.prototype.hasOwnProperty.call(FUNCTION_FACES, name)) {
      const port = of(FUNCTION_FACES[name]);
      if (port == null || port.available !== true) {
        throw new Error('capability-missing: ' + name);
      }
      return true;
    }
    // ③ 策略键 / 宿主键域：**一次**取报告（引用不自建；宿主键名从报告派生）
    const report = typeof capabilities?.report === 'function' ? capabilities.report(rt) : capabilityReport(rt);
    const hostKeys = Array.isArray(report?.host) ? report.host.map((h) => h.key) : [];
    if (!CAPABILITY_KEYS.includes(name) && !hostKeys.includes(name)) {
      throw new Error('unknown capability: ' + name);
    }
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
 * 最小批次的**缺省能力名**：从报告**派生**首个宿主键（不写死宿主名）。
 *
 * 为什么还要「宿主键」作缺省：本函数的调用方（`selftest` C7 / `test/g2-bus-falsify.test.js` M4·M5）
 * 传的是宿主键语义的 `rt` 夹具；缺省保持该口径可**零破坏**。
 * 报告取不到宿主键时退化到功能面名（此时语义为「判端口 available」）。
 */
const defaultCapabilityOf = (rt) => {
  const rep = capabilityReport(rt ?? {});
  return Array.isArray(rep?.host) && rep.host.length > 0 ? rep.host[0].key : 'toolSurface';
};

/**
 * 最小批次用的**最小 `ExecSpec`**：只为「按契约动词 `push_execute(spec)` 调用」而造。
 * null 适配器不消费其内容；真适配器会消费 `member`/`session`/`taskPkg`/`contract`。
 */
const minimalExecSpecOf = (task) => ({
  runId: 'bus-minimal-' + String(task?.id ?? 'task'),
  targetId: String(task?.role ?? ''),
  member: { id: String(task?.id ?? 'bus-minimal-task') },
  session: { id: null, params: null },
  taskPkg: { id: String(task?.id ?? 'bus-minimal-task') },
  contract: { id: 'bus-minimal', sha256: '' },
});

/**
 * 最小批次：跑完一轮「取件 → 断言 → 解析 → 归一 → 分类」，产出可判读数。
 * 不做真实执行（runtime 由调用方提供；null 适配器下必然 `empty_response`）。
 */
export async function runMinimalBatch(bus, spec = {}) {
  const steps = [];
  // 能力断言由**调用方声明的最小宿主面**（`spec.rt`）驱动：bus 不替宿主「装作装上了」——
  //   缺省 `{}` ⇒ 宿主键全缺 ⇒ fail-closed 抛错（这正是要保住的行为）。
  bus.assertCapability(spec.capability ?? defaultCapabilityOf(spec.rt), spec.rt ?? {});
  steps.push('assertCapability');

  const task = spec.task ?? { id: 'bus-minimal-task', role: BUILTIN_ROLES[0] };
  const routed = await bus.route(task.role);
  steps.push('route');

  const raw = typeof spec.execResult === 'object' && spec.execResult !== null
    ? spec.execResult
    : await bus.of('runtime').push_execute(minimalExecSpecOf(task)); // 契约动词 = `push_execute(spec)`（原 `start(task)` 已废）
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
