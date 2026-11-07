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

// BatchStore：批次状态文件唯一事实源（原子写 + 事件日志 + 状态机迁移 + 恢复语义）
// v2：批次绑定 session——root/sessions/<sessionId>/batches/*.json；存量 root/batches 迁移到 legacy
// Tier3：层间门禁（entry/exit/Plan 契约/complete）由 state/gates.js 承担，createStore 经 createGates(root) 注入调用

import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto'; // L7：身份快照 sha256 + 原子写 tmp 唯一 token
// 【历史·已退役，保留可读】团队资产解析快照写单点（§8③：解析结果落会话级资产解析档 + 批次级指纹引用）——本文件只做**建批侧接线**：
//   解析 + 写档 + 字段/事件载荷的构建全在 lib/assembly/snapshot.js，store 不复制其语义
//   【2026-09-27 · 批 3】资产面全量退役 ⇒ 该接线（`import * as snapshot` + 建批侧写档）**已整条删除**。

// 事件 type 常量单点：newEvent 调用 type 一律引用本模块常量（禁止裸字面量）
import * as EVT from './event-types.js';
import { createGates } from './gates.js';
// P2-1（本批 `c6-gate-snapshot`）：lane 态读端**单点复用** —— 与 `batch_status.lanesState`
//   （`lib/tools/query-tools.js:76-77`）取的是同一个 `laneStateOf`，**禁**在本文件另写第二套口径
//   （种纪律同 `lib/state/dangling.js` / `lib/watch/lane-heartbeat.js` 的既有复用先例）。
import { laneStateOf } from './lane-state.js';
import { loadRules } from './machine-rules.js';
import { createArchive } from './archive.js'; // done→archive（complete 钩子）
import { createCorruptRegistry } from './corrupt-registry.js'; // 损坏批次旁路清单
// I-26（批 `punky-g4a-dataplane-2026-10-31` · lane `e3-deny`）：零副作用拒写的**两个判定单点**。
//   · `isBatchTerminal` —— 终态相位判定归 `schema.js`（禁在本文件重写一份 `phase` 枚举判定）；
//   · `isAtLeastAsTight` —— 策略单调判定归 `governance/policy.js`（I-23 / e2 建；该模块零 import ⇒ 无环）。
//   本文件**只调用**这两个判定，不在 store 内再实现一遍（同一判据两份实现 ⇒ 必漂）。
import { isBatchTerminal } from '../schema.js';
import { isAtLeastAsTight } from '../governance/policy.js';

// ── 波 3 拆分后的语义面 builder（子模块 ← 组合器，**单向依赖**；builder 不反向 import 本文件）──
import { buildPaths } from './store/paths.js';
import { buildEvents } from './store/events.js';
import { buildBatch } from './store/batch.js';
import { buildPlanMutate } from './store/plan-mutate.js';
import { buildHandoff } from './store/handoff.js';
// G-10（批 `g10-fix-20261012`）：受限反向声明写入口 —— 「下游经 `handoff_accept` 声明接受后置上游」。
//   与 `buildHandoff`（提交面）**分工不重叠**：本件只**补声明条目**（不提交、不改任何门判据）。
import { buildHandoffAccept } from './store/handoff-accept.js';
import { buildLifecycle } from './store/lifecycle.js';
import { buildMemberGates } from './store/member-gates.js';
import { buildMemberExempt } from './store/member-exempt.js';
import { buildMember } from './store/member.js';
import { buildGovernance } from './store/governance.js';
// 模块级事件载荷纯函数单点（仓内既有导入面：`import * as STORE from '../lib/state/store.js'`）
import { gateEscapeEvents, gateDegradeEvents, contractMissingEvents, countConsecutiveFailedSettles } from './store/events.js';
export { gateEscapeEvents, contractMissingEvents, countConsecutiveFailedSettles };

// D7（豁免继承/清退留痕）事件名 —— **单点已迁入 `lib/state/event-types.js`**（设计 §5.1「迁入」项；
//   原文案寄居本文件并自述「该文件在本批 writeForbidden 内」，该理由随 `event-types.js` 成为本批写域而失效）。
//   本文件**保留再导出**（R-32 断言再导出值逐字仍在）⇒ 既有导入面零破坏；
//   字面值逐字不变（`lib/watch/lane-heartbeat.js` 的 `exemptClearedAtOf` 按**同一字面量**反查，改值即静默断链）。
export const EVT_LANE_EXEMPT_INHERITED = EVT.EVT_LANE_EXEMPT_INHERITED;
export const EVT_LANE_EXEMPT_CLEARED = EVT.EVT_LANE_EXEMPT_CLEARED;

// ── V-4 写端（e2-gov-repair）：门禁逃生/降级载荷 → 批次事件 ─────────────────────────
// 契约（`plan/spec.md` §5.3 ＋ `plan/techdebt-design.md` §2.1）：
//   ① 门禁只**产载荷**（`{escape:{kind,…}}` / `{escapes:[…]}` / `{degrades:[…]}`）；落盘**唯一**在此写端，
//      且仅出现在**写路径**（`setMember` 的统一 atomicWrite 前）⇒ 只读视图（`gate_status`）绝不发射。
//   ② **fail-closed**：事件常量缺位时**抛明确错误**（`GATE_EVENT_CONST_MISSING`），
//      **绝不**写入 `type: undefined` / 空串（防「语义失名事件」污染审计面）。
//   ③ 载荷键 `escape.type` 属事件名，**不得**占用载荷 `type` 键 ⇒ 白名单式搬运（下方 *_OF 映射）。
const GATE_EVENT_CONST_MISSING = 'GATE_EVENT_CONST_MISSING';

// fail-closed 事件类型解析：常量必须是**非空字符串**才允许写盘（单一守卫，供 gate.escape / gate.degrade 共用）。
// 抛出即停手（调用点不落盘）——「缺常量 ⇒ 明确错误」优先于「写一条无名事件」。
function requireEventType(evt, name) {
  const t = evt ? evt[name] : undefined;
  if (typeof t !== 'string' || t.length === 0) {
    throw new Error(GATE_EVENT_CONST_MISSING + ': event type constant "' + name
      + '" is absent/empty in lib/state/event-types.js ⇒ 拒绝写入（fail-closed：不得写 type:undefined；'
      + '请先落常量再由写端发射）');
  }
  return t;
}

// 事件类型解析（**注入式**，默认取单点常量表 `lib/state/event-types.js`）：
//   写端在**每次落盘前**解析常量 ⇒ 缺位即抛（fail-closed）。`evt` 参数为生产零改动前提下的
//   可注入缝（缺省 = EVT namespace import，逐字同源）、供探针以「人为缺常量」实测守卫行为。
function resolveGateEventTypes(evt = EVT) {
  return {
    escape: requireEventType(evt, 'EVT_GATE_ESCAPE'),
    degrade: requireEventType(evt, 'EVT_GATE_DEGRADE'),
    // B2（§8⑤）：契约缺声明首触留痕——与 escape/degrade 同一 fail-closed 守卫（缺位即抛，绝不写失名事件）。
    contractMissing: requireEventType(evt, 'EVT_GATE_CONTRACT_MISSING'),
  };
}
// ── L7 写路径原子性（批次 `punky-spec-adopt-p2-20261013` / lane `e1-l7-atomic`）────────────
// 三处改动，**全部落在既有单点内、不新增文件、不接锁**：
//   ① tmp 名每次调用唯一：原名仅含 `process.pid` ⇒ **同进程并发两次写到同一目标 = 同一 tmp 路径**（互踩：
//      内容可交错、两次 rename 竞争）。现名追加**每次调用唯一成分**（单调计数 + 随机后缀）。
//   ② 有界重试 + 显式耗尽：`renameSync` 对**可重试类**错误（EPERM/EBUSY/EACCES）做**有限次退避重试**；
//      耗尽后**显式抛**（带重试次数与最后错误）。**注意**：`renameSync` 是**同步** API ⇒ 退避必须是
//      **同步等待**（不能 `await sleep`，那会把落盘点改成异步、破坏既有同步写路径语义）。
//   ③ 文件身份快照 + 比对纯函数（**只读新增 API**，不触碰既有读路径）。
// **不变量**：① 原子性不变（目标文件永不为半成品）；② 单写成功路径**逐字不变**（仅在原先「必抛」处
//   改为「重试后可能成功」⇒ **不引入新失败**）；③ 重试有界且耗尽即抛（禁无限重试、禁静默吞错）。
//
// ⚠ **两条必须留在源码里的事实**（防后人误改；本 lane 直读实测）：
//   (a) 下方 `commitBatch` 的历史注释曾称「与 `lane_claim` 的单写者锁构成双层保证」——**该说法不成立**：
//       `lib/lock.js`（**F2 后 272 行；建此注释时 65 行**，规模随接管/fencing 改造演进，勿写死为判据）是**纯锁文件助手**，其 import 点**只有工具面**三处
//       （`lib/tools/handoff-tools.js:24` / `lib/tools/lane-tools.js:48` / `lib/tools/member-tools.js:23`），
//       本文件 `atomicWrite` 体内**零 `lock` 调用**。⇒ `lane_claim` 是**逻辑/协议层**锁，`commitBatch` 是
//       **无锁物理直写**；任何**绕过工具面**直接调 store 写函数的调用方（`member_settle`/`appendEvent`/
//       `handoff_submit`/`setPhase`/`setMember` 内部路径）**都不被锁挡**。本 lane **不**把锁接进写路径
//       （那会扩张并发语义）⇒ 该缺口的**可判能力**由 ③ 的读端身份快照承载。
//   (b) `EPERM` 的两条确切路径（**两种原先都无重试**）：**跨进程** —— 双方 tmp 名不同（含各自 pid）⇒ 不互踩
//       tmp，但后到的 `renameSync` 可能因目标被另一进程持有句柄而抛；**同进程并发** —— tmp 名**相同** ⇒
//       **互踩** ⇒ 内容可交错 + 两次 rename 竞争。② 的统一重试覆盖两者。

/** 可重试类错误码（**只覆盖资源竞争类**；其余错误码一律立即上抛，不掩盖真实故障）。 */
const ATOMIC_WRITE_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** 重试上限（**有界**：总尝试次数 = 该值；耗尽即抛）。 */
const ATOMIC_WRITE_MAX_ATTEMPTS = 5;
/** 退避基数（毫秒）：第 n 次重试等待 `BASE * n`（线性退避，上限 `MAX`）。 */
const ATOMIC_WRITE_BACKOFF_MS = 2;
/** 退避单次等待上限（毫秒）。 */
const ATOMIC_WRITE_BACKOFF_CAP_MS = 40;

/** 每次调用唯一成分（单调计数 + 随机后缀）：同进程并发时两次调用的 tmp 名**必不相同**。 */
let atomicWriteSeq = 0;
function nextAtomicWriteToken() {
  atomicWriteSeq += 1;
  return process.pid + '.' + atomicWriteSeq + '.' + randomUUID().slice(0, 8);
}

/**
 * **同步**退避等待。`renameSync` 是同步 API ⇒ 不能 `await`（会把落盘点变异步）。
 * 优先 `Atomics.wait`（真阻塞、不烧 CPU）；不可用时回落 `Date.now()` 忙等（有界：单次 ≤ `BACKOFF_CAP`）。
 */
function sleepSyncSync(ms) {
  const budget = Math.max(0, Math.floor(ms));
  if (budget === 0) return;
  try {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(cell, 0, 0, budget);
    return;
  } catch {
    const until = Date.now() + budget;
    while (Date.now() < until) { /* 有界忙等：budget ≤ ATOMIC_WRITE_BACKOFF_CAP_MS */ }
  }
}

/**
 * 原子落盘：写 `<目标名>.<每次唯一 token>.tmp` → `renameSync` 覆盖目标（原子替换，目标永不为半成品）。
 * 对可重试类错误**有限次退避重试**；耗尽后抛错**带重试次数与最后错误**，并清理本次 tmp。
 * @param {string} file 目标文件绝对路径
 * @param {unknown} data 待序列化并落盘的数据
 * @param {{renameFn?: (from: string, to: string) => void}} [opts] 可注入缝：
 *   `renameFn` 缺省 = `fs.renameSync`（**生产路径逐字不变**）；仅供单测注入故障以实测重试语义。
 */
export function atomicWrite(file, data, { renameFn } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // tmp 名**一次生成、重试期间复用**（不在重试中换名 ⇒ 失败路径不遗留多份 tmp）
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + nextAtomicWriteToken() + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  const rename = typeof renameFn === 'function' ? renameFn : fs.renameSync;

  let lastErr = null;
  for (let attempt = 1; attempt <= ATOMIC_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      rename(tmp, file); // Windows: MoveFileEx REPLACE_EXISTING
      return;             // 成功路径：与改动前**逐字同效**（仅 tmp 名不同）
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      if (!ATOMIC_WRITE_RETRYABLE.has(code) || attempt >= ATOMIC_WRITE_MAX_ATTEMPTS) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort：目标文件不受影响 */ }
        // 不可重试类 ⇒ 立即上抛原错误（**不掩盖**）；耗尽 ⇒ 显式带次数与最后错误
        if (!ATOMIC_WRITE_RETRYABLE.has(code)) throw e;
        const err = new Error('atomicWrite 重试耗尽（尝试 ' + attempt + '/' + ATOMIC_WRITE_MAX_ATTEMPTS
          + '）：最后错误 ' + code + ' ' + String((lastErr && lastErr.message) || lastErr));
        err.code = code;
        err.attempts = attempt;
        err.retryExhausted = true;
        err.lastError = lastErr;
        err.target = file;
        throw err;
      }
      sleepSyncSync(Math.min(ATOMIC_WRITE_BACKOFF_MS * attempt, ATOMIC_WRITE_BACKOFF_CAP_MS));
    }
  }
}

/**
 * **文件身份快照**（只读）：`{size, mtimeMs, sha256, path}` —— 供读端判「读到的文件是否已被换过」。
 * 与 `atomicWrite` 的原子替换配合：读者读前取一份、读后取一份，`fileIdentityChanged` 为 true ⇒
 * 「本次读取期间文件被换过，读到的可能是旧/新混合视图」，调用方可据此重读（**可判**，非强制）。
 * @param {string} file 文件绝对路径
 */
export function fileIdentityOf(file) {
  const st = fs.statSync(file);
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { path: file, size: st.size, mtimeMs: st.mtimeMs, sha256 };
}

/**
 * 身份比对**纯函数**：判「文件是否已被换过」。
 * 口径（**显式**）：内容身份 = `size` **且** `sha256`；`mtimeMs` 仅作辅助信号、**不单独判不等**
 * （同内容重写会变 mtime）。⇒ 返回 true 的条件 = 一方缺位 ∨ size 不等 ∨ sha256 不等。
 * @param {{size?: number, sha256?: string}|null|undefined} before
 * @param {{size?: number, sha256?: string}|null|undefined} after
 */
export function fileIdentityChanged(before, after) {
  if (!before || !after) return true;
  return before.size !== after.size || before.sha256 !== after.sha256;
}


  // ── V-4 统一写盘点（e2-gov-repair）：逃生/降级载荷 → 批次事件 ──────────────────────────
  // 时序：在 member.settled 之前、统一 atomicWrite 之内 ⇒ 「门禁已判 + 留痕同批落盘」不可分割。
  // fail-closed：常量在此刻解析（`resolveGateEventTypes()`），缺位即抛 GATE_EVENT_CONST_MISSING
  //   ⇒ **不落盘**（原子写尚未执行）⇒ 绝不产生 `type:undefined` 事件。
  // 只写路径：本段仅存在于 `setMember`（写路径）；`gate_status` 等只读调用不经过本函数（R-04 可核）。
  // 【2026-10-02 · 波 3】本段降为**模块级单点**（无闭包状态，`newEvent` 由调用方注入）；上方契约逐字保留。
  function appendGatePayloadEvents(newEvent, batch, gatePayloads, lane) {
    if (gatePayloads.length > 0) {
      const evtTypes = resolveGateEventTypes();
      for (const item of gatePayloads) {
        const eventsOf = item.kind === 'degrade' ? gateDegradeEvents(item.res, lane) : gateEscapeEvents(item.res, lane);
        for (const ev of eventsOf) {
          batch.events.push(newEvent(item.kind === 'degrade' ? evtTypes.degrade : evtTypes.escape, ev.payload));
        }
      }
    }
  }

// ── F3 / K-1：批级 rev CAS（B1，用户已裁）────────────────────────────────────────────────
// 缺陷面（K-1）：批 JSON 的写函数是「整份读 → 内存突变 → 整份覆盖写」。写前执行的门禁链
//   （`command gate` 起子进程可达秒级、`claimAsset` 的文件复制）期间，任何其它写者提交的事件/状态
//   会被**静默抹掉**且无矛盾读数。`lane_claim` 的锁是 **lane 作用域**且不覆盖批级物理写（见上方 L7 段 (a)）
//   ⇒ 加锁解决不了它：锁只串行化「写」这一瞬间，管不了「读到的已经是旧快照」。
//   ⇒ 本批只做**可判**（CAS），**不**做互斥（用户 K-1 已否决把锁接进写路径）。
//
// 契约（rev 判据**唯一实现点** = 下方 `commitBatch`；`__rev` 键名唯一字面量 = 本常量）：
//   ① `__rev` = 批次 JSON 顶层**非负整数**。双下划线前缀 = **引擎内部字段**（非 schema-v3 契约字段）⇒
//      **工具面禁回显**（`batch_status` / 面板均不加 rev 位，防内部字段升格为公开契约）。
//      不得用既有字段替代：`updatedAt` 同毫秒多写同值 ⇒ 检测不出并发；`events.length` 在
//      `updateChains` / `updateLaneProgress` 零事件 push 也写盘 ⇒ 漏检这两类写。
//   ② 写前**同步重读盘上记录**取 `__rev`，与**调用方对象声明值**比对：相等 ⇒ 递增后写盘；
//      不等 ⇒ 抛**普通错误**（非 `GATE_` 前缀）且**零落盘**，由上层重读后重试。
//      比对**必须紧邻** `atomicWrite`（= 本函数内），不能上移到写函数入口：否则窗口含整段门禁执行
//      （含子进程），残余窗口从 μs 级膨胀到秒级。本仓调用形态天然满足（`commitBatch` 是每个写函数的最后一句）。
//   ③ 成功后**就地回写调用方对象** `batch.__rev = next` —— 这是**正确性条件**，不是优化：
//      不回写 ⇒ 同一对象连续两次 commit ⇒ 第二次 `expected=旧值 / actual=新值` ⇒ **自冲突**。
//      ⚠ **禁止**「由单点重新读取盘上值 +1」：那等于忽略调用方声明 ⇒ CAS 退化为**无条件覆盖** ⇒
//      K-1 要防的「读到旧快照再写」正好被放过（两个口径名相似、语义相反）。
//   ④ 兼容面冻结：旧文件无 `__rev` ⇒ 视 `0`；调用方对象也缺 ⇒ 视 `0` ⇒ `0 === 0` 通过 ⇒ 首次写升级为 `1`，
//      **不得拒写**、**不做批量回填迁移**（no backfill：不写的文件永远没有该键，也不影响它被读）。
//      非整数 / 负值 / 字符串数字一律归一为 `0`（不抛：旧数据或手工编辑的脏值不该砸掉写能力，
//      且首次写即被纠正为合法整数）。
//   ⑤ `ENOENT` ⇒ `0`（建批首写档——`createBatch` 刚判过 `!existsSync`）；**JSON 损坏 ⇒ 抛、绝不覆盖**
//      （`readBatch` 已把损坏批次登记 `corrupt-batches.json`；此处静默当 0 覆盖 = 数据丢失，属倒退）；
//      其余读失败（EACCES / EBUSY…）**原样上抛**，不降级为 0（不把真故障当兼容面）。
//
// ⚠ **残余窗口（如实登记；禁表述为「已根治」）**：`diskRevOf` 读完 → `atomicWrite` 的 `renameSync`
//   完成之间（两次文件系统调用，μs~ms 级）。两个写者若都在该窗口内「读→比对→写」，会以相同 `actual`
//   双双通过 ⇒ **后写覆盖先写（lost update）仍可能发生**。本批的收窄是**真实的**：窗口从「整段
//   read-modify-write（含门禁链、`command gate` 子进程、`claimAsset` 的文件复制）」压到「两次 fs 调用之间」，
//   且不再是**静默**覆盖（被覆盖方下一次同对象 commit 会因 `actual` 跳变立刻抛冲突 ⇒ 事实不消失）。
//   **彻底闭合所需条件（本批不做，登记）**：OS 级「写前有条件替换」原语（Linux `renameat2(RENAME_NOREPLACE)`
//   一次写；Windows 无等价语义）或文件锁（K-1 已明确否决）。威胁模型侧不构成提权：并发写者本就具备与
//   引擎相同的写盘权限，CAS 只影响「谁的事实留下」，不影响「能写到哪」。
//   ⇒ 允许措辞：`已可判` / `窗口收窄至两次 fs 调用` / `残余已登记`；**禁止**：`fixed` / `彻底解决` / `已根治`。
const BATCH_REV_KEY = '__rev';

/** 声明值归一：缺失 / 非整数 / 负数 ⇒ `0`（旧文件视 0；**不抛** —— 兼容面冻结，脏值首次写即被纠正）。 */
function revOf(obj) {
  const v = obj ? obj[BATCH_REV_KEY] : undefined;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/** 盘上值：文件不存在 ⇒ `0`；**JSON 损坏 ⇒ 抛**（绝不把 corrupt 当 0 覆盖）；其它读失败原样上抛。 */
function diskRevOf(file, batchId) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0; // 建批首写档（唯一允许的 `return 0`）
    throw err; // EACCES / EBUSY…：真故障不降级为 0
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 普通错误（**非 `GATE_` 前缀**，零新造拒码）。写面绝不覆盖损坏文件 ——
    //   读端口径是「登记 corrupt-batches.json 后返回 null」，静默当 0 覆盖 = 数据丢失。
    throw new Error('batch file is not valid JSON, refuse to overwrite: ' + batchId
      + ' (' + String((err && err.message) || err) + ')');
  }
  return revOf(parsed);
}

/**
 * rev 冲突错误（**普通错误**，**非 `GATE_` 前缀**；不参与任何门禁语义）。
 * 四段式文案：① 事实（expected/actual 两个数）② 判别（有并发写者在本轮读取之后提交过）
 * ③ **零副作用**声明 ④ **修复提示**（重读后重试 / 先 `batch_status` 确认盘上状态）。
 * 为何带修复提示：本仓纪律「报错必须自带下一步」（同 `store/member.js` 的 `d4Hint`）——
 *   冲突的下一步是**唯一确定的**（重读重试），不写在第 4 段，Leader 就得猜。
 * `err.code` 承载语义码是安全的：工具面只读**输出字段** `value.code`，不读 error 对象的 `code`；
 *   `atomicWrite` 内部只对它自己 catch 的 rename 错误判 `code` ⇒ 不与 Node syscall code 语义冲突。
 */
function batchVersionConflictOf(batchId, expected, actual) {
  const err = new Error(
    'batch version conflict: ' + batchId
    + ' —— 本次读取的 __rev=' + expected + '，盘上已是 __rev=' + actual
    + '；有并发写者在本轮读取之后提交过。本次写入未落盘（零副作用）。'
    + '修复：重新读取该批次后重试（store.readBatch → 同一写函数；或先 batch_status 确认盘上状态）。',
  );
  err.code = 'BATCH_VERSION_CONFLICT'; // 普通字符串码，**非 GATE_ 前缀**（仅供程序可判）
  err.batchId = batchId;
  err.expected = expected;
  err.actual = actual;
  return err;
}

// 组合器：仅做导出面装配（键序与原 `return` 逐字一致 ⇒ 消费方零感知）
//   【2026-10-02 · 波 3】`createStore` 降为 ≤40 行组合器，导出面装配移出为模块级函数；
//   原 `return {...}` 字面量（含其历史登记注释）逐字保留于下方。
function composeStore(cx) {
  const {
    createBatch, readBatch, readBatchResult, isCorrupt, listBatches, listSessions, listAllBatches,
    setMember, setPhase, appendEvent, claimAsset,
    commitBatchLocked, // I-26：锁内校验 + 锁内落盘的唯一入口（只调用 withBatchRowLock，不自建锁）
    addPoolTasks, addTaskEdges,
    recordHandoff, recordHandoffAccept, markManagerRaised, recordGovernanceRefusal,
    declaredInboundEdgesOf, // 【G-10 · e3-toolface】门禁侧「已声明入边」单点（只读透出，见下方导出注释）
    readChains, updateChains, updateLaneProgress,
    batchSettled, batchAutoReleaseable,
    recoverBatches, recycleStalledLane, migrateLegacy, batchFile, artifactsDirOf,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    sessionsDir, gates, corruptRegistry, archive,
  } = cx;

  // 【QT-2a】批级**批量读面**（纯读；一个入口三种调用形态，避免读端各自拼目录扫描）：
  //   · `ids` 缺省（含 `[]`）⇒ `listBatches` **恰 1 次** + 逐批 `readBatch`（= 现有列表语义，逐字等价）；
  //   · `ids.length === 1` ⇒ 直接透传单批 `readBatch`（**不**走批量）⇒ 单批路径零附加成本；
  //   · `ids.length >= 2` ⇒ **不调 `listBatches`**（那是目录扫描），只读给定 id。
  //   缺批 / 损坏批 ⇒ **不抛**，缺失 id 不入 Map（读端语义：查不到就是没有，与 `readBatch` 返回 null 同族）。
  //   ⚠ 计数以 **store 层调用**为准；OS 层 syscall 未直接观测（无 strace 面）。
  const readBatchMap = (sessionId, ids) => {
    const out = new Map();
    const wanted = Array.isArray(ids) && ids.length > 0 ? ids : null;
    if (wanted === null) {
      for (const id of listBatches(sessionId)) {
        const b = readBatch(sessionId, id);
        if (b) out.set(id, b);
      }
      return out;
    }
    if (wanted.length === 1) {
      const b = readBatch(sessionId, wanted[0]);
      if (b) out.set(wanted[0], b);
      return out;
    }
    for (const id of wanted) {
      const b = readBatch(sessionId, id);
      if (b) out.set(id, b);
    }
    return out;
  };

  return {
    withBatchRowLock, // I-23 行锁单点（进程内 per-batch 串行；跨进程由 rev CAS 兜底）。I-26 只调用它，禁另建
    readBatchMap, // QT-2a：批级批量读面（纯读；ids 缺省=list 1 次 / =1 透传 / ≥2 不扫目录）
    commitBatchLocked, // I-26：串行 + 写前拒绝的唯一异步入口（内部 = withBatchRowLock → commitBatch）
    createBatch, readBatch, readBatchResult, isCorrupt, listBatches, listSessions, listAllBatches,
    setMember, setPhase, appendEvent, claimAsset,
    addPoolTasks, // N1-R4-1c：池内追加任务（图变更唯一写入口；单次 atomicWrite，只增不改）
    addTaskEdges, // N1-R4-2：池内任务**加边**（只增不删；已派发即冻结 K1；单次 atomicWrite）
    recordHandoff, // P1 交接门：交接记录唯一写入入口（`batch.handoffs` + `lane.handoff` 事件同一次 atomicWrite）
    // G-10：受限反向声明唯一写入入口（**写方 = 下游**）—— 只补 `handoffs[to]` 声明条目 + `plan.mutated{accepts}`
    //   留痕 + `planRevision+1`；**不写 `deps`**、不提交任何交接、不改任何门判据（净收紧：补一条声明义务）。
    recordHandoffAccept,
    // 【G-10 修复 · lane `e3-toolface`】门禁侧「已声明入边」单点（`deps(lane) ∪ {handoffs[lane].from}`，逐边带来源）
    //   **只读透出**给读端：唯一读端 = `lib/tools/handoff-tools.js#handoff_view`（修前该视图只读 `deps` ⇒
    //   `handoff_accept` 声明的入边在视图**结构性不可见** ⇒ 视图与门禁口径分叉，`L-AC-9` fail）。
    //   本键即 `lib/state/gates.ts` 透出的**同一函数实例**（红线 C-4 单点判定：视图与门禁同源，禁第二套）。
    declaredInboundEdgesOf: gates.declaredInboundEdgesOf,
    markManagerRaised, // Manager 拉起登记唯一入口（批 event + 批字段，不改成员状态）
    // 【已删 · 2026-11-05】`revokeLaneExempt`（longrun 豁免撤销唯一入口）随撤销面整体移除（用户裁决「删掉 revokeExempt」）
    recordGovernanceRefusal, // 违规计数记录 + 窗口评估 + 升级（批事件流单一事实源）
    readChains, updateChains, updateLaneProgress, // laneProgress 断点指针持久化
    batchSettled, batchAutoReleaseable,
    recoverBatches, recycleStalledLane, migrateLegacy, batchFile, sessionsDir, artifactsDirOf, gateStatus: gates.gateStatus,
    // TD-21 / N-13（2026-09-18 清理波）：批级门禁视图单点暴露（一次读批 → `{lane: gateView}`）——
    //   `lib/api.js` 的 `lanesGate` 投影唯一读端；与逐 lane 兼容外壳 `gateStatus` 同源同实现（`gates.ts`
    //   的 `gateStatusOfLane` 单点），差别只在读盘次数（投影段由 N 次降为 1 次）。
    gateStatusOfBatch: gates.gateStatusOfBatch,
    gateStatusMapOfBatch: gates.gateStatusMapOfBatch,
    // §8③ 快照读端（只读视图：实现为 `lib/state/gates/complete.js:142-144` 的**常量返回**
    //   `{teamAsset:null, declaration:null, declarationMissing:true}`——零 I/O、不读档、不回落现算；
    //   **不参与任何门禁判定**、读路径不 throw）
    teamAssetViewOf: gates.teamAssetViewOf,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    // 损坏旁路清单：幂等登记 / 只读清单 / 人工修复后清除标记（透传 corrupt-registry）
    corruptRegistry: { markBatchCorrupt: corruptRegistry.markBatchCorrupt, listCorruptBatches: corruptRegistry.listCorruptBatches, clearCorruptMark: corruptRegistry.clearCorruptMark, corruptFileOf: corruptRegistry.corruptFileOf },
    // 归档只读/幂等面（batch_status 面板与审计查询用）
    archive: { archiveBatch: archive.archiveBatch, readManifest: archive.readManifest, listArchived: archive.listArchived },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P2-1（批 `punky-guidance-teams-20261025` · lane `c6-gate-snapshot`）：`gate.*` 事件载荷附 lane 态快照
//
// 要解决的问题：纪律「门读数有效 ⟺ 无 lane 处 `running` ∧ 已采样」此前**只存在于人脑**——事件落盘后
//   无法事后判别「该门读数是不是在写者未静止时采的」。修法 = 让**事件自带采样时刻的 lane 向量**。
//
// **落点选在 `commitBatch`（唯一写盘点）而非逐写点**，理由三条：
//   ① 逐写点散在 `store/member-gates.js`（9 处）＋ `store/member.js`（1 处）＋ 本文件（`appendGatePayloadEvents`）
//      ⇒ 改它们要动**两个不在本 lane 写域的文件**；而 `commitBatch` **定义就在本文件内**（写域内唯一落点）。
//   ② 覆盖性：凡经 `atomicWrite` 落盘的批次 JSON 一律经此函数 ⇒ 无「漏改某个写点」的可能（结构性完备）。
//   ③ **「同刻一致」由构造成立**（这是判据 AC-7 的要害）：此处 `batch` 即**本次要序列化的快照**，
//      而 `batch_status` 读的是同一份 JSON 的 `batch.lanes` ⇒ 快照与 `lanesState` **恒等**，不是抽样比对。
//
// 纯增量边界（红线）：只**追加** `lanes` 键（追加在事件对象键序末尾），**不改/不删任何既有键**；
//   不新增事件类型、不新增 `GATE_*` 码、不改任何门判据与拒态分支（`lib/state/event-types.js` 零改动）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 采样时刻的 lane 态快照。
 * 键集与取值**同源** `batch_status.lanesState`（`lib/tools/query-tools.js:76-77`：
 * `Object.keys(b.lanes ?? {})` → `laneStateOf(b, l)`）⇒ 两者形状逐字一致，本函数不引入第二套口径。
 */
function laneSnapshotOf(batch) {
  const lanes = {};
  for (const laneId of Object.keys(batch?.lanes ?? {})) lanes[laneId] = laneStateOf(batch, laneId);
  return lanes;
}

/**
 * 纯增量戳记：给**尚无** `lanes` 键的 `gate.*` 事件补上当前 lane 态快照。
 *
 * ⚠ **幂等守卫是正确性条件，不是优化**：`commitBatch` 会被**同一个 `batch` 对象反复调用**
 *   （每次 lane 迁移 / 相位迁移各一次，`batch.events` 是累积数组）。若无守卫，第 1 波落的
 *   `gate.passed` 会在第 5 次提交时被**改写成第 5 波的 lane 态** ⇒ 快照失真且不可复原。
 *   守卫语义 = 「**首次成为持久事实时**的 lane 态」，此后冻结（该事件对应的那次读数不再变）。
 *
 * 判据面（为什么是 `startsWith('gate.')`）：与 `log_export` 收录口径同源（按 `startsWith('gate.')`），
 *   覆盖 `gate.passed` / `gate.exit` / `gate.entry.missing` / `gate.escape` / `gate.degrade` /
 *   `gate.contract_missing` / `gate.target.*` / `gate.complete_blocked` / … 全族，无需枚举维护。
 */
function stampGateLaneSnapshot(batch) {
  if (!batch || !Array.isArray(batch.events)) return;
  let snapshot = null; // 惰性一次：同一批快照内 lane 向量相同，命中多条时只算一次
  for (const e of batch.events) {
    if (!e || typeof e.type !== 'string' || !e.type.startsWith('gate.')) continue;
    if (Object.prototype.hasOwnProperty.call(e, 'lanes')) continue; // 首落盘冻结（见上「幂等守卫」）
    if (snapshot === null) snapshot = laneSnapshotOf(batch);
    e.lanes = { ...snapshot };
  }
}

// ── I-23 · 行锁设施（**全仓唯一定义**，`:withBatchRowLock`）───────────────────────────
// 语义 = **进程内 per-batch 串行**：同 (sessionId, batchId) 的调用排队，先到先跑。
// ⚠ 它是**新增的外层串行**，不是给写路径加锁：`atomicWrite` 体内仍**零 lock 调用**、
//   `commitBatch` 仍**无锁物理直写**（见上方 :110-112 两条既有事实，逐字未改）。
//   跨**进程**并发不靠它 —— 由既有 rev CAS（`revOf`/`diskRevOf`/`batchVersionConflictOf`）兜底。
// ⇒ 归属单点：I-26 的「写前校验」**只调用本函数**，不得另建第二套锁（两套锁 = 两个真源）。
const batchRowChains = new Map();

/**
 * 同 (sessionId, batchId) 串行执行 `fn`。
 * @param {string} sessionId
 * @param {string} batchId
 * @param {() => any} fn 临界区（同步或异步均可）
 * @returns {Promise<any>} `fn()` 的结果；**`fn` 抛错则原样抛给调用方**（不被链吞掉）
 */
function withBatchRowLock(sessionId, batchId, fn) {
  const key = String(sessionId) + '::' + String(batchId);
  const prior = batchRowChains.get(key) ?? Promise.resolve();
  const result = prior.then(() => fn()); // 排队点：只在前一个 settle 之后进入临界区
  // 链上只留「已 settle」的尾巴 ⇒ 某一次失败不会毒化同 key 的后续调用（后续照常排队执行）
  const tail = result.then(() => {}, () => {});
  batchRowChains.set(key, tail);
  tail.then(() => { if (batchRowChains.get(key) === tail) batchRowChains.delete(key); }); // 队列排空即回收，防无界增长
  return result;
}

export function createStore(root, { rules, logger, onStateChange, readConfig, revRaceHook } = {}) {
  const sessionsDir = path.join(root, 'sessions');
  const legacyDir = path.join(root, 'batches');
  // 门禁侧的**热配置读取器**（`task-27`）：装配点可注入（与工具面 `deps.readConfig` 同源）；
  //   未注入 ⇒ 门禁闭包回落 `lib/hot/config-watch.js` 的模块级生效快照（`createGates` 内处理）。
  //   本文件**只传递**，不解析门开关、不读 env（门顺序与既有语义一字不动）。
  const gates = createGates(root, typeof readConfig === 'function' ? { readConfig } : {});
  // 损坏批次旁路清单：与 governance.json 同层；批次 JSON 结构零变更
  const corruptRegistry = createCorruptRegistry(root);
  // 留痕日志（可选注入；缺省 console——与 index.js ctx.logger 解耦，保持 createStore 既有调用点零改动）
  const log = logger ?? console;
  // 棘轮规则表（createStore(root, { rules }) 注入 loadRules 产物；未注入 = 默认规则 = schema 常量同引用，行为不变）
  // **接线已落地（A-①）**：装配点 `lib/index.js:108-112` 传 `rules: loadRules(config)`（**整份 config**
  //   ⇒ loadRules 内部自取 `config.ratchet`，machine-rules.js:78）⇒ 生产链路可达，`config.ratchet` 不再是死配置。
  //   本行形态**保持** `rules ?? loadRules()` 不变：无参兜底只服务「不传 rules 的调用方」（工具/测试直建 store），
  //   其返回与注入默认表**同引用**（machine-rules.js:82-84）⇒ 缺省零差异。
  const ratchet = rules ?? loadRules();
  // 归档器装配（createStore 签名不变；归档目标 = <root>/sessions/<sid>/archive/<bid>/）
  // 【2026-10-22 · 原 F3 D-2 残余收尾】把 `commitBatch` 注入归档器：归档写批次 JSON 时同样走 rev CAS
  //   （否则归档后 `__rev` 不推进 ⇒ 并发下可用旧 rev 覆盖 ⇒ rev 回退 + 后续虚假冲突）。
  //   传的是**函数引用**（`commitBatch` 为同作用域函数声明，具备提升）⇒ 无 TDZ、无循环 import。
  const archive = createArchive(root, { commitBatch });

  // ── 波 3：闭包上下文 `cx`（每 createStore 实例一份；禁提升为模块级单例）+ 写面单点 ──
  const cx = { root, sessionsDir, legacyDir, gates, corruptRegistry, log, ratchet, archive,
    onStateChange, atomicWrite, resolveGateEventTypes, appendGatePayloadEvents, commitBatch, commitBatchLocked,
    // F3 / K-1：rev CAS 的**确定性构造缝**（`fn({sessionId,batchId,file,expected})`）。
    //   **唯一扩面已登记**（规格 N-2）：生产调用点不传 ⇒ `undefined` ⇒ `commitBatch` 内 `typeof` 判否
    //   ⇒ **零行为**。唯一用途 = 单测确定性构造「对手在我读完之后、落盘之前提交了一次」。
    //   与 F2 的 `atomicWrite(file, data, { renameFn })` 注入缝**同族先例**（同为测试缝、同为缺省零行为）。
    revRaceHook };
  Object.assign(cx, buildPaths(cx));
  const { batchFile } = cx;
  // 构建顺序 = 依赖拓扑序（子模块 ← 组合器，单向依赖；各 builder 仅定义函数、无副作用）
  for (const build of [buildEvents, buildBatch, buildPlanMutate, buildHandoff, buildHandoffAccept, buildLifecycle,
    buildMemberExempt, buildMemberGates, buildMember, buildGovernance]) Object.assign(cx, build(cx));

  // ───────────────────────────────────────────────────────────────────────────
  // CAP-W2（批 `punky-mac-wave-immutability-2026-10-29` · lane `e1-coder`）：
  //   **波次固定语义的写前 guard**。
  //
  // 语义（Leader 裁定 D-1，**不是**「一律只读」）：**已派发** lane（`owner` 非空）的 `wavePlan` 条目与既有
  //   `deps` 只读；**未派发**任务的追加 / 加边**仍允许**，但图变更必须在**同一次落盘**内留 `plan.mutated`
  //   ⇒ 即只能经 `store/plan-mutate.js` 的 `addPoolTasks` / `addTaskEdges` 进出（「结构不可达」退化为
  //   「纪律约定」之后，这是唯一让该约定**可判**的点）。
  //
  // 位置纪律（三条缺一不可，见任务包 §3.2）：
  //   ① `diskRevOf` CAS 判定**之后** ⇒ 版本冲突时零副作用（拒态优先级不变：冲突先抛）；
  //   ② `stampGateLaneSnapshot` **之前** ⇒ 比对面不含它补写的事件快照（比的是调用方交来的那半段事实）；
  //   ③ `atomicWrite` **之前** ⇒ 满足「**写前**拒绝」而非事后回滚（IMM-5「拒则零落盘」由构造成立）。
  //
  // 拒绝形态（形态即契约，任务包 §4.2）：**普通 `Error`、不设 `err.code`、消息不以 `GATE_` 开头**。
  //   理由：否则会**二次扩大拒码集合**（复刻裁决 B1 向量）；同仓先例 = `store/plan-mutate.js:39-40`
  //   （「不新建拒码 ⇒ 抛普通 Error，不进 66 码集合」）。消息前缀 `[wave-plan-immutable]` 固定，
  //   并带 `batchId` 与出事的 lane / task id（可定位）。
  //
  // 判据来源 = IMM-1..IMM-5。两处**刻意不参与比较**的字段：
  //   · `wave`：合法加边会把任务及其下游推到更晚波次（`topoWaves` 按 `1+max(deps wave)` 分层）⇒
  //     把波序号当不变量会误杀合法加边；
  //   · `sig`：已派发任务的 `sig` 刻意沿用旧值（`lib/wave-plan.js:1139`）⇒ **发现不了 deps 被篡改**，
  //     判据必须落在字段本体（`deps`/`cmd`/`layer`/…）而不是摘要。
  // 建批豁免（IMM-0）：盘上无该批（`createBatch` 首写）⇒ 直接放行，否则建批即被自己拒。
  // ───────────────────────────────────────────────────────────────────────────
  function assertWavePlanImmutable(sessionId, batchId, batch) {
    const prev = cx.readBatch(sessionId, batchId); // 纯读：不写盘、不改调用方对象
    if (!prev || typeof prev !== 'object') return; // IMM-0 建批豁免 / 损坏批（读路径已登记旁路清单）
    const flatTasks = (b) => (Array.isArray(b?.wavePlan) ? b.wavePlan : [])
      .flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    const asArr = (v) => (Array.isArray(v) ? v : []);
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const reject = (invariant, taskId, detail) => {
      throw new Error('[wave-plan-immutable] batch=' + batchId + ' lane=' + String(taskId)
        + ' ' + invariant + ': ' + detail);
    };
    // 只按 id 建索引：`id` 非字符串的畸形条目不入判据面（形态校验归 `buildWavePlan`，本 guard 不越权）
    const byId = (b) => new Map(flatTasks(b).filter((t) => t && typeof t.id === 'string').map((t) => [t.id, t]));
    const prevTasks = byId(prev);
    const nextTasks = byId(batch);
    const SKIP_FIELDS = new Set(['deps', 'owner', 'wave', 'sig']); // 见上「刻意不参与比较的字段」
    // IMM-1：任务集合只增不删（删任务 = 已派发结构被抹掉，且会连带抹掉其交接声明）
    for (const id of prevTasks.keys()) {
      if (!nextTasks.has(id)) reject('IMM-1', id, '既有任务被删除（任务集合只增不删）');
    }
    for (const [id, p] of prevTasks) {
      const n = nextTasks.get(id);
      if (!n) continue; // 已由 IMM-1 拒，不重复报
      const dispatched = typeof p.owner === 'string' && p.owner.length > 0; // 声明面 `owner` 为唯一真源（K1 同源）
      for (const k of new Set([...Object.keys(p), ...Object.keys(n)])) {
        if (SKIP_FIELDS.has(k)) continue;
        if (!same(p[k], n[k])) reject(dispatched ? 'IMM-2' : 'IMM-3', id, '字段被改写: ' + k);
      }
      if (dispatched) {
        // IMM-2：已派发条目逐字冻结（含 `deps` 逐位相等、含 `owner` 相等 ⇒ 换人须走作废 + 池内新增替代）
        if (!same(asArr(p.deps), asArr(n.deps))) reject('IMM-2', id, '已派发任务 deps 被改写');
        if (!same(p.owner, n.owner)) reject('IMM-2', id, '已派发任务 owner 被改写');
      } else {
        // IMM-3：未派发条目仅允许「既有边前缀 + 新尾」（禁删 / 禁插 / 禁重排）与 `owner` 首次写入
        const pd = asArr(p.deps);
        const nd = asArr(n.deps);
        if (nd.length < pd.length || !pd.every((d, i) => nd[i] === d)) {
          reject('IMM-3', id, '未派发任务 deps 非「旧边前缀 + 新尾」');
        }
        if (p.owner != null && p.owner !== n.owner) reject('IMM-3', id, '未派发任务 owner 非空后被改写');
      }
    }
    // IMM-4：图变更（新增任务 / deps 变长）必须在**本次** commit 的**追加段**内留 `plan.mutated`
    //   用 `slice(prev.events.length)` 判「本次新增」而非「全量里有没有」——历史批遗留的 `plan.mutated`
    //   会让后者永远通过（假绿）；事件若被插在中间（而非追加），本判据会如实误判为缺失（已登记 W2-R-3）。
    const added = [...nextTasks.keys()].filter((id) => !prevTasks.has(id));
    const grownId = [...prevTasks.keys()].find((id) => {
      const n = nextTasks.get(id);
      return n !== undefined && asArr(prevTasks.get(id).deps).length !== asArr(n.deps).length;
    });
    if (added.length > 0 || grownId !== undefined) {
      const before = asArr(prev.events).length;
      const trailed = asArr(batch.events).slice(before);
      if (!trailed.some((e) => e && e.type === EVT.EVT_PLAN_MUTATED)) {
        reject('IMM-4', added[0] ?? grownId, '图变更无 plan.mutated 留痕（须经 plan-mutate 入口）');
      }
    }
  }

  /** 【U-3 修复 · 批 `punky-engine-core-deepdive-20261107`】`handoffs` 防篡改守卫（与 `assertWavePlanImmutable` 对等）。
   *
   * ## 为什么需要（缺口事实）
   * `wavePlan` 有 IMM-0..5 全套护栏，而 `batch.handoffs` **一条没有**（全仓 `handoffs.*immutab` 零命中）。
   * 手改批 JSON 把 `handoffs[to][i].status` 改成 `'submitted'`（并补 `artifacts` / `contract.assertions`）
   * 即可让**两道门同时放行**：
   *   · entry 门 —— 对入边并集逐条判（`gates/handoff.js` + `helpers.js`）；
   *   · settle 出口门 —— `gates/handoff.js:82-90` 遍历 `Object.values(map)` 的**全部**记录找 `rec.from === lane`，
   *     ⇒ **一条**伪造记录即同时满足「下游 ∀」与「上游 ∃」。两门共用判定单点 `handoffRecordVerdict`，
   *     盲区也单点共享。
   * 且 5 个旁路面都不会发现：`handoff_view` 走同一单点、`replay-verify` 只折 `member.settled`/`batch.phase`、
   * 事件流全仓仅 2 条注释写明「读端真源 = `batch.handoffs`，不做事件流重建」、IMM 不覆盖、手改不改 `__rev` 故 CAS 不冲突。
   *
   * ## 判据（与 IMM-4 同构，fail-closed）
   * `handoffs` 的 **status 或条目集合**发生变化 ⇒ **本次 commit 的追加段**必须出现
   * `lane.handoff` 或 `plan.mutated` 事件。
   * 正常写路径（`recordHandoff` / `recordHandoffAccept` / `plan-mutate`）**自身都落事件** ⇒ 天然满足，
   * 故**不需要白名单**（白名单会把「合法路径」与「手改」混为一谈）。
   *
   * ## 为什么用 `slice(prev.events.length)`
   * 判「**本次新增**」而非「全量里有没有」—— 历史批遗留的 `lane.handoff` 会让后者永远通过（假绿），
   * 与 IMM-4 在 `:601-615` 的处理完全一致。
   */
  function assertHandoffsIntegrity(sessionId, batchId, batch) {
    const prev = cx.readBatch(sessionId, batchId); // 纯读：不写盘、不改调用方对象
    if (!prev || typeof prev !== 'object') return; // 建批豁免（盘上无该批）/ 损坏批
    const sigOf = (b) => {
      const map = b?.handoffs;
      if (map === null || typeof map !== 'object') return null; // 存量批无 handoffs 字段 ⇒ 不判
      const rows = [];
      for (const to of Object.keys(map)) {
        const list = Array.isArray(map[to]) ? map[to] : [];
        for (const r of list) {
          if (!r || typeof r.from !== 'string') continue; // 畸形条目不进判据面（形态校验归各写入口）
          rows.push(to + '\u0000' + r.from + '\u0000' + String(r.status ?? ''));
        }
      }
      rows.sort();
      return rows.join('\u0001');
    };
    const prevSig = sigOf(prev);
    const nextSig = sigOf(batch);
    if (prevSig === nextSig) return; // 未变（含两侧同为 null 的存量批）
    const before = Array.isArray(prev.events) ? prev.events.length : 0;
    const trailed = (Array.isArray(batch.events) ? batch.events : []).slice(before);
    const hasTrace = trailed.some((e) => e
      && (e.type === EVT.EVT_LANE_HANDOFF || e.type === EVT.EVT_PLAN_MUTATED));
    if (!hasTrace) {
      throw new Error('[handoffs-integrity] batch=' + batchId
        + ' handoffs 的 status 或条目集合发生变化，但本次 commit 追加段**无** `lane.handoff` / `plan.mutated` 留痕'
        + ' ⇒ 疑似手改批 JSON 伪造交接状态（正常写路径自带事件；本守卫与 IMM 同属写前拒，拒则零落盘）');
    }
  }

  // 批次 JSON 的**统一落盘点**（单写者真源）：凡以 `batchFile(sessionId, batchId)` 定位的写路径
  //   一律经此函数落盘 ⇒ 写面单点不分散。
  //   ⚠ **订正（L7 / lane `e1-l7-atomic`，直读实测）**：本注释原称「与 `lane_claim` 的单写者锁构成
  //   **双层保证**」——**该说法不成立，已据实更正**：`lib/lock.js` 的 import 点**只有工具面三处**
  //   （`lib/tools/handoff-tools.js:24` / `lib/tools/lane-tools.js:48` / `lib/tools/member-tools.js:23`），
  //   `atomicWrite` 体内**零 `lock` 调用** ⇒ `lane_claim` 是**逻辑层**锁、本函数是**无锁物理直写**；
  //   **绕过工具面**直接调 store 写函数的路径**都不被锁挡**。详见上方 L7 段 `(a)`。
  //   F3 / K-1：本函数升级为 **rev CAS 写入**（契约见上方 `BATCH_REV_KEY` 段）——「可判」而非「互斥」。
  // ───────────────────────────────────────────────────────────────────────────
  // I-26（批 `punky-g4a-dataplane-2026-10-31` · lane `e3-deny`）：**零副作用拒写**的写前校验。
  //
  // 形态裁定（任务包 §2.3，**不是**「写完再回滚」）：校验在 `atomicWrite` **之前**抛出 ⇒ 拒则
  //   零落盘**由构造成立**（同仓先例 = 上方 `assertWavePlanImmutable` 的 IMM-5「位置纪律 ③」）。
  //   禁事后回滚：回滚会引入「半写 → 恢复」窗口与备份面。
  //
  // 位置纪律（三条，缺一不可；由**调用点行序**即成立 —— 本函数只判定、不写盘、不改入参）：
  //   ① `diskRevOf` CAS 判定**之后** ⇒ 版本冲突时零副作用（拒态优先级不变：冲突先抛）；
  //   ② `stampGateLaneSnapshot` **之前** ⇒ 比对面不含它补写的事件快照；
  //   ③ `atomicWrite` **之前** ⇒ 写前拒绝，非事后回滚。
  //
  // 串行纪律（I-23 的行锁，**只调用不自建**）：本函数自身不加锁；「锁内校验 + 锁内落盘」由
  //   `commitBatchLocked()` 提供 —— 它把 `commitBatch` 整段包进 `withBatchRowLock`，故校验与落盘
  //   **在同一临界区内**。⚠ 禁自建第二套锁（e2 原话逐字）：「两套锁**互不阻塞**，A 锁内的读能看见
  //   B 锁内未提交的中间态，而**两边都以为自己串行**」。
  //
  // 拒绝形态（形态即契约）：**普通 `Error`**，消息前缀 **`deny-zero-write:`** ＋ `batchId` ＋ 明细；
  //   **不设 `err.code`**、**不以 `GATE_` 开头**（禁二次扩大拒码集合；同 `store/plan-mutate.js:39-40` 先例）。
  //
  // 判据（两条，均可构造）：
  //   D-1 终态相位迁移：盘上批次已终态（`isBatchTerminal(prev.phase)`）而本次写入改 `phase` ⇒ 拒；
  //   D-2 策略非单调：本次带 `policy` 且盘上有 `policy`，而 `isAtLeastAsTight(prev, next) === false` ⇒ 拒。
  //     `policy` = **batch 级可选字段**（与 `batch.handoffs` 同风格），形状 `{allowed, denied, limits}`；
  //     语义与判定**全部委托** `lib/governance/policy.js`（本文件只调用，不重实现单调判定）。
  //
  // 建批/首写豁免：盘上无该批（`readBatch` ⇒ null）⇒ 直接放行（同 IMM-0，否则建批即被自己拒）；
  //   损坏批（读路径已登记旁路清单）同样放行 —— 本 guard 不越权做形态校验。
  // ───────────────────────────────────────────────────────────────────────────
  function assertBatchWriteAllowed(sessionId, batchId, batch, { action = 'commit' } = {}) {
    const prev = cx.readBatch(sessionId, batchId); // 纯读：不写盘、不改调用方对象
    if (!prev || typeof prev !== 'object') return; // 建批/首写豁免（IMM-0 同款）
    const deny = (detail) => {
      throw new Error('deny-zero-write: batch=' + String(batchId) + ' action=' + String(action) + ' ' + detail);
    };
    // D-1：终态是**单向门**（`schema.js#BATCH_TRANSITIONS` 的终态出边为空）⇒ 盘上已终态时任何相位改写一律拒
    if (isBatchTerminal(prev.phase) && batch.phase !== prev.phase) {
      deny('D-1 终态相位迁移被拒（盘上 phase=' + String(prev.phase) + '，本次 phase=' + String(batch.phase) + '）');
    }
    // D-2：策略只可收紧、永不放宽/擦除 —— 判定单点 = `policy.js#isAtLeastAsTight`（**不在此重写**）
    if (batch.policy !== undefined && prev.policy !== undefined) {
      if (!isAtLeastAsTight(prev.policy, batch.policy)) {
        deny('D-2 策略非单调（放宽/擦除）被拒：allowed 只减、denied 只增、limits 只降');
      }
    }
  }

  function commitBatch(sessionId, batchId, batch) {
    const file = batchFile(sessionId, batchId);
    const expected = revOf(batch); // 调用方声明值（旧文件/新对象缺 `__rev` ⇒ 0）
    if (typeof revRaceHook === 'function') {
      // 仅测试注入缝（生产不传 ⇒ 本分支不进）。**必须在 `diskRevOf` 之前**调用，
      //   否则观测不到「对手刚提交」这一时序（构造无效）。缝自身抛错**不阻断**写路径。
      try { revRaceHook({ sessionId, batchId, file, expected }); } catch { /* 缝失败不阻断 */ }
    }
    // 比对**紧邻** `atomicWrite`：中间只余一次赋值 ⇒ 残余窗口 = 两次文件系统调用之间（见上方契约段）。
    const actual = diskRevOf(file, batchId);
    // 失配 ⇒ 抛（本次**零落盘**：尚未写 tmp、尚未 rename）⇒ 由上层重读后重试。
    if (actual !== expected) throw batchVersionConflictOf(batchId, expected, actual);
    // CAP-W2（批 `punky-mac-wave-immutability-2026-10-29` · lane `e1-coder`）：波次固定语义**写前 guard**。
    //   三条位置纪律由本行位置即成立：CAS 之后（冲突零副作用）／`stampGateLaneSnapshot` 之前／
    //   `atomicWrite` 之前（写前拒绝 ⇒ IMM-5「拒则零落盘」）。判据与拒绝形态见本函数上方整段注释。
    assertWavePlanImmutable(sessionId, batchId, batch);
    // 【U-3 修复 · 批 `punky-engine-core-deepdive-20261107`】`handoffs` 防篡改守卫，与上方 IMM 对等。
    //   位置纪律同 IMM（三条缺一不可）：CAS 之后（冲突零副作用）／`stampGateLaneSnapshot` 之前／
    //   `atomicWrite` 之前（写前拒绝 ⇒ 拒则零落盘）。判据与拒绝形态见上方 `assertHandoffsIntegrity` 注释段。
    assertHandoffsIntegrity(sessionId, batchId, batch);
    // I-26（`e3-deny`）：**零副作用拒写**的写前校验 —— 位置即在 `atomicWrite` 之前（CAS 之后、快照之前）。
    //   抛出 ⇒ 本次零落盘（尚未写 tmp、尚未 rename）；判定与拒绝形态见本函数上方整段注释。
    assertBatchWriteAllowed(sessionId, batchId, batch, { action: 'commit' });
    // P2-1（lane `c6-gate-snapshot`）：落盘前给 `gate.*` 事件补 lane 态快照（纯增量，只补**尚无** `lanes` 的）。
    //   位置纪律：**在 CAS 判定之后**（冲突时零副作用，不改调用方事件对象）、**在 `atomicWrite` 之前**
    //   （快照与同一份落盘字节同批固化）。本行**不触碰**下方 `atomicWrite(batchFile(sessionId, batchId), batch)`
    //   字面量 —— `test/gate-assertion-r32.test.js:286` 的 R3-2④ 源码面锚点保持有效。
    stampGateLaneSnapshot(batch);
    // 回写**先于**落盘（契约 ③）：即便 `atomicWrite` 抛（重试耗尽 / 不可重试码），调用方对象已带新 rev
    //   ⇒ 调用方若错误地重试**同一对象**，会拿到**清晰的冲突**而不是二次覆盖（有意为之）。
    batch[BATCH_REV_KEY] = actual + 1;
    // ⚠ **保持该字面调用形态**（禁改写为 `atomicWrite(file, batch)`）：`test/gate-assertion-r32.test.js`
    //   R3-2④ 的源码面围栏以 `'atomicWrite(batchFile(sessionId, batchId), batch)'` 为锚点，断言
    //   「常量解析早于统一原子写」。改成 `file` 变量会让该围栏失锚（R3-2 结构性证据失效）。
    atomicWrite(batchFile(sessionId, batchId), batch);
  }
  // ───────────────────────────────────────────────────────────────────────────
  // I-26（`e3-deny`）：**锁内校验 + 锁内落盘**的唯一入口 —— 全仓 `withBatchRowLock` 的**唯一调用点**
  //   （其声明仍只有 1 处，就在本文件上方；禁另建第二把）。
  //
  // 语义链：`withBatchRowLock(sessionId,batchId, fn)` → `fn()` 内 `commitBatch(...)`
  //   → CAS → `assertBatchWriteAllowed(...)`（**写前拒绝**）→ 快照 → `atomicWrite(...)`。
  //   ⇒ 「串行」与「拒则零落盘」两条都被构造成立：临界区内一次只跑一个写者；判定在落盘之前。
  //   `fn` 抛错由 `withBatchRowLock` 原样抛给调用方（其 finally 语义保证链尾只挂已 settle 版本 ⇒
  //   一次失败不毒化同 key 后续），故**锁的释放不需要本函数操心**。
  //
  // ⚠ 与既有 `commitBatch` 的关系：本函数**不新增落盘路径**，只是给它套一层串行；
  //   既有无锁调用点（28 处）行为**逐字不变**（本条只影响新调用方是否走锁）。
  // ───────────────────────────────────────────────────────────────────────────
  async function commitBatchLocked(sessionId, batchId, batch) {
    return withBatchRowLock(sessionId, batchId, () => {
      commitBatch(sessionId, batchId, batch);
      return batch;
    });
  }
  return composeStore(cx);
}
