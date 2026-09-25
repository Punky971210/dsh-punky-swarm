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

// lib/sig-fingerprint.js —— sig 任务内容指纹（N3-②）
//
// 定位（规格来源 = `docs/sig-fingerprint-design-2026-09-22.md` §1/§2 + 用户 D-sig-1..4 四项裁定）：
//   · **形式**：`WaveTask.sig` = 单任务内容指纹，随 wavePlan 持久化、可选字段、**不参与任何门禁判定**
//     （风格同既有 `owner` 可选字段）；
//   · **哈希构成**（D-sig-1 裁定 = **不含 `assemblyRef`**，只含任务信息）：
//     `sha256(canonicalJSON({ id, layer, role, deps, produce, outputs, cmd }))` 截 **16 hex**（D-sig-3 裁定）。
//     规范形态复用包内既有惯例（先例 = `lib/verify/selector.js` 的 `canonicalizeArgs` + `createHash('sha256')`；
//     另见 `lib/assembly/snapshot.js` 的 sha256 惯例）：对象键递归排序、**数组保序**（`deps` 顺序 = 声明顺序，
//     是语义面而非噪声）、`undefined`/`null` 空值在规范形态里**一致落为 `null`**（不落 `undefined`：
//     后者会被键排序剔键 ⇒ 「未写 layer」与「显式 layer:null」曾产生两个不同哈希）。
//   · **计算点唯一纪律**（D-sig-4 裁定）：唯一计算入口 = `buildWavePlan`（建批全量算）；
//     `addPoolTasks` 追加任务经同一次 `buildWavePlan` 重归一化 ⇒ 新任务补算、既有任务输入不变 ⇒ sig 不变；
//     `addTaskEdges` 加边经同一次重归一化 ⇒ 受影响任务（deps 变化）重算、**无关任务 sig 不变**；
//     已派发（`owner` 非空）任务在 `buildWavePlan` 内**冻结**（读旧 sig 原样落盘，见 `lib/wave-plan.ts`）。
//   · **消费点**（D-sig-2 裁定 = **不加新拒码**，仅事件留痕）：同批次内存在 sig 相同且状态 ∈
//     {running, review, merged} 的**其他** lane ⇒ 只落事件 `sig.duplicate_detected`，**不阻断动作**、
//     **不新增治理状态**、**不进 `GateErrorCode` union**（拒码面恒 29 保持不变）。
//
// 零依赖纪律：本模块**只 import node:crypto**——
//   它被 `lib/wave-plan.ts`（TS 源码）与 `lib/state/store.js`（手写 JS）**共同** import，
//   故必须保持零本包运行期依赖（避免循环：store ← wave-plan 已在既有导入图内）。
// 事件常量不在此 import：事件**落盘点在消费点写路径**（`store.setMember`，与迁移同一 atomicWrite），
//   由 `lib/state/store.js` 直引 `EVT_SIG_DUPLICATE_DETECTED`（本模块只产载荷，见 `sigDuplicateVerdict`）。

import { createHash } from 'node:crypto';

/** 指纹精度：16 hex（D-sig-3 裁定；先例 `selector.js` 为 12 hex，此处留更长内部判等碰撞余量）。 */
export const SIG_HEX_LEN = 16;

/** sig 形态判据（16 位小写 hex）：消费点/测试共用同一份正则，禁第二套口径。 */
export const SIG_PATTERN = /^[0-9a-f]{16}$/;

/**
 * 递归规范化：对象键递归排序（`{a:1,b:2}` 与 `{b:2,a:1}` 同哈希）；数组**保序**；`undefined` 剔除；
 * 标量原样（字符串/数字/布尔/null）。与 `lib/verify/selector.js#canonicalizeArgs` **同款语义**
 * （此为 sig 侧唯一实现，不改动 selector 侧冻结实现）。
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalizeForSig(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForSig);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = canonicalizeForSig(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

/**
 * 单任务 sig 的**规范形态**（哈希输入面；也是「字段敏感性」的可读举证面）。
 * 三态归一（消除「缺省」与「显式空」造成的伪差异）：
 *   · `layer` / `role`：非字符串（含缺省 / null）⇒ `null`；
 *   · `deps` / `produce` / `outputs`：非数组（含缺省 / null）⇒ `[]`（`deps` 顺序=声明顺序，保序不排序）；
 *   · `cmd`：非字符串 ⇒ `''`。
 * **不含 `assemblyRef`**；`role`/`skills` 经 `cmd` 进入（`cmd` 是持久面字段）。
 * `updatedAt` / `planRevision` / `owner` 等易变/派生元数据同样不入（D-sig-1 裁定：哈希只含任务信息）。
 * @param {Record<string, unknown>} task 任务对象（`WavePlanTaskInput` 或持久形态 `WavePlanTask` 均可）
 * @returns {{id: string, layer: string|null, role: string|null, deps: string[], produce: string[], outputs: string[], cmd: string}}
 */
export function canonicalTaskForSig(task) {
  const t = task ?? {};
  const strArr = (v) => (Array.isArray(v) ? [...v] : []);
  return {
    id: typeof t.id === 'string' ? t.id : '',
    layer: typeof t.layer === 'string' ? t.layer : null,
    role: typeof t.role === 'string' ? t.role : null,
    deps: strArr(t.deps),
    produce: strArr(t.produce),
    outputs: strArr(t.outputs),
    cmd: typeof t.cmd === 'string' ? t.cmd : '',
  };
}

/**
 * 计算任务内容指纹：`sha256(canonicalJSON(canonicalTaskForSig(task)))` 前 16 hex。
 * **纯函数**（零 IO、零副作用）：同输入恒同值、键序无关、数组保序。
 * @param {Record<string, unknown>} task
 * @returns {string} 16 位小写 hex
 */
export function computeTaskSig(task) {
  const canonical = canonicalTaskForSig(task);
  return createHash('sha256').update(JSON.stringify(canonicalizeForSig(canonical))).digest('hex').slice(0, SIG_HEX_LEN);
}

/** 落盘 sig 取值（唯一读取口径）：非 16 hex 形态（缺省 / 旧批无该字段 / 形态漂移）⇒ `null`。
 *  读取方**不得**自行判断 `typeof === 'string'`（那一口径会把任意脏串当真值）。 */
export function sigOf(task) {
  const raw = task?.sig;
  return typeof raw === 'string' && SIG_PATTERN.test(raw) ? raw : null;
}

/** 消费点接受的**其他** lane 状态集（D-sig-2 裁定原文）：{running, review, merged}。 */
export const SIG_DUPLICATE_STATES = ['running', 'review', 'merged'];

/**
 * 幂等判等（**只读**：零写入、零阻断）：同批次内找 sig 与本 lane 相同、且状态 ∈
 * `SIG_DUPLICATE_STATES` 的**其他** lane。
 * 口径（逐条，防误报）：
 *   · 候选 sig 取**落盘值** `sigOf`（非 16 hex ⇒ 视为无指纹，不参与判等）；
 *   · 本 lane **不计入**自身；状态取 `lanes[]` 的**迁移前**态（调用方须在写 `lanes[lane]=to` **之前**调用）；
 *   · 跨层同 sig **不做** `blocking`（层不同 ⇒ 任务语义不同域；仅作 `notice` 记账），
 *     使「同批 plan/exec 同名任务」不产假阳性。
 * @param {unknown} batch 批次对象（形状同 `store.readBatch` 返回值）
 * @param {string} lane 本 lane id
 * @returns {{sig: string|null, blocking: Array<{lane:string,state:string}>, notice: Array<{lane:string,state:string,layer:string|null}>}}
 */
export function duplicateSigLanesOf(batch, lane) {
  /** @type {{sig: string|null, blocking: Array<{lane:string,state:string}>, notice: Array<{lane:string,state:string,layer:string|null}>}} */
  const out = { sig: null, blocking: [], notice: [] };
  if (!batch || typeof batch !== 'object' || typeof lane !== 'string' || !lane) return out;
  const flat = [];
  for (const w of Array.isArray(batch.wavePlan) ? batch.wavePlan : []) {
    for (const t of Array.isArray(w?.tasks) ? w.tasks : []) if (t && typeof t.id === 'string') flat.push(t);
  }
  const self = flat.find((t) => t.id === lane) ?? null;
  const selfSig = sigOf(self);
  out.sig = selfSig;
  if (selfSig === null) return out;
  const lanes = batch.lanes ?? {};
  for (const t of flat) {
    if (t.id === lane) continue;
    if (sigOf(t) !== selfSig) continue;
    const state = lanes[t.id] ?? null;
    if (typeof state !== 'string' || !SIG_DUPLICATE_STATES.includes(state)) continue; // pending/idle/终态不入判等
    if (t.layer === self?.layer) out.blocking.push({ lane: t.id, state });
    else out.notice.push({ lane: t.id, state, layer: typeof t.layer === 'string' ? t.layer : null });
  }
  return out;
}

/** 取某条 detection 的**去重键**（`<lane>|<对端:态, …>`；无命中 ⇒ `null`）。对端按 lane 名排序（稳定）。
 *  键**带本 lane**：否则两条不同 lane 命中同一对端时会被误判成同一条已记账（漏留痕）。
 *  调用方据此把「本次已留痕」记进 `batch.sigDuplicateLogged`（与事件同一原子写）。 */
export function sigDuplicateKeyOf(lane, det) {
  if (!det || typeof det.sig !== 'string' || !SIG_PATTERN.test(det.sig)) return null;
  const matches = Array.isArray(det.blocking) ? det.blocking : [];
  if (matches.length === 0) return null;
  return String(lane) + '|' + matches.map((m) => m.lane + ':' + m.state).sort().join(',');
}

/** 事件载荷单点构造（`newEvent(type, fields)` 的 fields 面；`type` 键承载事件名，故不出现）。
 *  纪律：**只产载荷、不落盘**——唯一写盘点是调用点（`store.setMember`）与其迁移**同一次 atomicWrite**
 *  （否则「先 appendEvent 再以陈旧快照 atomicWrite」会**静默丢掉**本条事件；本批实测踩过）。 */
export function sigDuplicateEventFields(lane, det) {
  return {
    lane,
    sig: det?.sig ?? null,
    matches: (Array.isArray(det?.blocking) ? det.blocking : []).map((m) => ({ lane: m.lane, state: m.state })),
    notice: Array.isArray(det?.notice) ? det.notice : [],
  };
}

/**
 * 判定某 lane 在当前批次态下是否需要落 `sig.duplicate_detected`，并给出**一次性**（去重后）的载荷。
 * 语义与纪律（D-sig-2 裁定：**不加新拒码、不阻断动作、不新增治理状态**）：
 *   · sig 平凡（非 16 hex）或零同层命中 ⇒ `{ log:false, reason:'no-sig' | 'no-duplicate' }`（零写入）；
 *   · 同 `(lane, 对端集合)` 已记进 `batch.sigDuplicateLogged` ⇒ `{ log:false, reason:'already-logged' }`
 *     （防 `running→review→merged` 三次迁移各落一条同义事件，不防「事实」）；
 *   · 命中且未记过 ⇒ `{ log:true, key, fields, matches }`，调用方须**同时**落事件与记账键。
 * @param {unknown} batch 批次对象（迁移前快照）
 * @param {string} lane
 * @param {{sig: string|null, blocking: Array<{lane:string,state:string}>, notice?: unknown[]}} det `duplicateSigLanesOf` 产物
 * @returns {{log: boolean, reason?: string, key?: string|null, fields?: Record<string, unknown>, matches?: Array<{lane:string,state:string}>}}
 */
export function sigDuplicateVerdict(batch, lane, det) {
  const key = sigDuplicateKeyOf(lane, det);
  if (key === null) return { log: false, reason: (det && SIG_PATTERN.test(String(det.sig))) ? 'no-duplicate' : 'no-sig' };
  if (batch && typeof batch === 'object' && batch.sigDuplicateLogged?.[key]) return { log: false, reason: 'already-logged', key };
  return { log: true, key, fields: sigDuplicateEventFields(lane, det), matches: det.blocking };
}
