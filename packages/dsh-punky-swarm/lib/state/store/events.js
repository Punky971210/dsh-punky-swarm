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

// 事件基座与留痕面（newEvent / sig 判等消费点 / 状态事件发布钩子 / 首触留痕发射器 / 升级写内联）——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import * as EVT from '../event-types.js';
// sig 任务内容指纹（N3-②）· 消费点单点（幂等判等 + 留痕，**不加新拒码、不阻断**）：
//   判据/写路径全在 `lib/sig-fingerprint.js`（与 `lib/wave-plan.ts` 的计算入口**同模块**，禁第二套口径）；
//   本文件只做接线：`setMember` 的写路径在**迁移前态**上判等，命中即落 `sig.duplicate_detected`。
import { duplicateSigLanesOf, sigDuplicateVerdict } from '../../sig-fingerprint.js';


// ── 事件载荷纯函数（模块级，零副作用；【2026-10-02 · 波 3】自 `store.js` 机械搬移）──────────────

// escape 载荷可透传键（与 e1 逐字同一契约：`{kind,lane,reason?,gate?,path?,artifact?}`）；
//   `type` 显式排除（newEvent 的 `type` 是事件名槽位）。
const ESCAPE_PAYLOAD_KEYS = ['kind', 'lane', 'reason', 'gate', 'path', 'artifact'];
// degrade 载荷可透传键（`{kind,declaredField,effective,layers,lanes,…}`，同样排除 `type`）。
const DEGRADE_PAYLOAD_KEYS = ['kind', 'declaredField', 'effective', 'layers', 'lanes', 'reason'];

// 白名单搬运：只透传上述键中**已存在**的项（缺省不写键，避免 `undefined` 噪音）。
export function pickPayload(keys, src) {
  const out = {};
  for (const k of keys) {
    if (src && src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out;
}
// 门禁结果 → 待落事件清单（纯函数，零副作用：不读盘、不写盘 ⇒ 可单测）。
//   来源面（e1 载荷形态）：`res.escape`（单条）/ `res.escapes[]`（多条）/ `res.degrades[]`（降级）。
//   `lane` 缺省由调用方补（门禁未带 lane 时以被结算 lane 为准，保证「每条事件可归因」）。
export function gateEscapeEvents(res, lane) {
  if (!res || typeof res !== 'object') return [];
  const raw = [
    ...(res.escape ? [res.escape] : []),
    ...(Array.isArray(res.escapes) ? res.escapes : []),
  ];
  return raw
    .filter((e) => e && typeof e === 'object' && typeof e.kind === 'string' && e.kind.length > 0)
    .map((e) => ({ payload: { ...pickPayload(ESCAPE_PAYLOAD_KEYS, e), lane: e.lane ?? lane } }));
}
export function gateDegradeEvents(res, lane) {
  if (!res || !Array.isArray(res.degrades)) return [];
  return res.degrades
    .filter((d) => d && typeof d === 'object' && typeof d.kind === 'string' && d.kind.length > 0)
    .map((d) => ({ payload: { ...pickPayload(DEGRADE_PAYLOAD_KEYS, d), lane: d.lane ?? lane } }));
}

// ── B2（蓝图 §8⑤ 运行期**首触校验**）：契约缺声明的**待落事件计算**（纯函数，零副作用） ──────────────
// 契约（规格 §1.4 W-4 ＋ §1.1 R-3/R-4/R-5）：
//   ① **非拒态**：只产观察事件——不改任何判定、不改任何 exit code、不新增 `GateErrorCode`
//      （与 gate.escape / gate.degrade 同族的留痕面）；
//   ② 去重键 = `(batchId, gateKind, layer)`——**不含 lane**；「**只报一次/批**」
//      （batchId 维度由「批次 JSON 即该批」天然蕴含：判据取自本批 `batch.events`）；
//   ③ **跨重启幂等**：判据 = `batch.events` 里已存在同键事件 ⇒ 不再发（批次 JSON 是持久事实源，
//      与 `EVT_LANE_LONGRUN_UNCONSUMED` 的 (lane, runningSince) 去重同法）；
//   ④ **只由写路径调用**：本函数只**计算**、不落盘 ⇒ 落盘唯一在 store 写端（`setMember` / `setPhase`），
//      **只读视图（`gate_status` 等）不经本路径**（R-5 硬边界；本函数被只读调用也不产生任何写效果）；
//   ⑤ 载荷键**白名单搬运**：`type` 是 `newEvent` 的事件名槽位，载荷**不得**占用（同 escape/degrade 纪律）。
const CONTRACT_MISSING_PAYLOAD_KEYS = ['cause', 'gateKind', 'layer', 'lane', 'declared', 'source', 'degrade', 'problems'];
export function contractMissingEvents(batch, res, lane) {
  const cm = res && typeof res === 'object' ? res.contractMissing : null;
  if (!cm || typeof cm !== 'object') return [];
  const gateKind = typeof cm.gateKind === 'string' ? cm.gateKind : '';
  if (gateKind.length === 0) return []; // 无 gateKind ⇒ 不可去重、不可归因 ⇒ 不落（fail-safe，不写失名事件）
  const layer = typeof cm.layer === 'string' ? cm.layer : null;
  const key = gateKind + '@' + (layer ?? '-');
  const events = batch && Array.isArray(batch.events) ? batch.events : [];
  for (const e of events) {
    if (!e || e.type !== EVT.EVT_GATE_CONTRACT_MISSING) continue;
    if (String(e.gateKind ?? '') + '@' + (e.layer ?? '-') === key) return []; // 同键已留痕 ⇒ 不再发（跨重启幂等）
  }
  return [{
    payload: {
      ...pickPayload(CONTRACT_MISSING_PAYLOAD_KEYS, cm),
      cause: typeof cm.cause === 'string' ? cm.cause : 'undeclared',
      gateKind,
      layer,
      lane: cm.lane ?? lane ?? null,
      declared: cm.declared === true,
      problems: Array.isArray(cm.problems) ? [...cm.problems] : [],
    },
  }];
}

// C 子项：连续失败升级（spec C）——计数纯函数（顶层导出，供单测）：
// 从事件流末尾向前扫描，统计连续 member.settled 且 to === 'failed' 的事件数（含本次刚 push 的结算）；
// 遇 member.settled 但 to !== 'failed'（merged/conflict/skipped/review/running 等）即停止（归零语义 C-计数）；
// 非 member.settled 事件（worktree.checkpoint / batch.phase / gate.* 等）不打断计数。
export function countConsecutiveFailedSettles(events) {
  const evs = events ?? [];
  let count = 0;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (!e || e.type !== EVT.EVT_MEMBER_SETTLED) continue;
    if (e.to === 'failed') count++;
    else break;
  }
  return count;
}

// 事件 type 常量单点：newEvent 调用 type 一律引用 `lib/state/event-types.js`（禁止裸字面量）
export function buildEvents(cx) {
  const { onStateChange, log, resolveGateEventTypes } = cx;

  function newEvent(type, fields = {}) {
    return { ts: new Date().toISOString(), type, ...fields };
  }

  // ── sig 任务内容指纹（N3-②）· 消费点判定（`setMember` 写路径唯一调用；**不落盘**）──────────────
  // 语义（用户 D-sig-2 裁定）：同批次内存在 `sig` 相同且状态 ∈ {running, review, merged} 的**其他** lane
  //   ⇒ 本次迁移落事件 `sig.duplicate_detected` **留痕**；**不阻断、不加拒码、不新增治理状态**。
  // 纪律要点：
  //   · 判等只看**落盘 sig**（非 16 hex ⇒ 视为无指纹，读端单点 `sigOf`）——本函数**不重算**任何 sig
  //     （计算点唯一 = `buildWavePlan`；此处重算即第二套计算入口）；
  //   · 本 lane 计入自身排除；状态取**迁移前**快照（调用点位于 `batch.lanes[lane] = to` 之前）；
  //   · **本函数零写入**：只回判定（`lib/sig-fingerprint.js#sigDuplicateVerdict`）——事件与去重记账键
  //     由调用点在**同一次 atomicWrite** 内落盘。理由（实测踩过）：`appendEvent` 是**独立整文件写**，
  //     若在此处即时写，随后调用点用它更早读到的 `batch` 快照再写一次 ⇒ **静默覆盖掉本条事件**
  //     （去重键仍在、事件消失）。故唯一写盘点必须与迁移写同批。
  // @returns {{log: boolean, reason?: string, key?: string|null, fields?: object, matches?: object[]}}
  function sigDupVerdictOf(batch, lane) {
    return sigDuplicateVerdict(batch, lane, duplicateSigLanesOf(batch, lane));
  }

  // 状态事件发布钩子（topic 接线）：setMember/setPhase 调用点埋点——
  // appendEvent 为闭包内部函数，外部 wrap 该导出属性无法拦截内部迁移（调用点埋点固化），
  // 故必须在调用点埋。onStateChange 缺省未装配（topic 默认关）→ 零行为变化；
  // 异常隔离（发布失败不阻断状态机）。载荷为纯数据摘要，topic 命名由装配侧（topic-runtime）负责。
  function emitStateChange(ev) {
    try { onStateChange?.(ev); } catch { /* 隔离：topic 发布失败不阻断状态机 */ }
  }

  // ── B2（§8⑤）写端发射器：契约缺声明**首触留痕**（`setMember` / `setPhase` 共用同一实现，杜绝第二套语义）──
  //   与 `gatePayloads`（escape/degrade 统一收集器）的**唯一差异 = 时序**：本类事件按 `(gateKind, layer)`
  //   去重，故**即时 push**——push 后再评估去重，同一次迁移内的第二次触达自然被拦（规格 §1.6 风险表第 2 行）。
  //   fail-closed：事件类型在**此刻**经 `resolveGateEventTypes()` 解析，常量缺位即抛（原子写尚未执行 ⇒ 不落盘）。
  //   告警与事件**同源一次**（U-3）：每条事件恰好一条 `logger.warn`，不得「有事件无告警」或反之。
  //   只写路径：本发射器只在 `setMember` / `setPhase` 内被构造使用；只读视图不持有它（R-5 可核）。
  function makeContractMissingSink(getBatch, getLane) {
    return (res) => {
      const batch = getBatch();
      const items = contractMissingEvents(batch, res, getLane());
      if (items.length === 0) return 0;
      const type = resolveGateEventTypes().contractMissing;
      for (const item of items) {
        batch.events.push(newEvent(type, item.payload));
        log.warn?.('[dsh-punky-swarm] gate.contract_missing: ' + item.payload.gateKind + '@' + (item.payload.layer ?? '-')
          + '(lane=' + String(item.payload.lane ?? '-') + ') —— 团队资产未声明该检查项 ⇒ 引擎缺省接管；'
          + '首触留痕，只报一次/批（degrade=' + String(item.payload.degrade?.kind ?? '-') + '）');
      }
      return items.length;
    };
  }

  // 升级写公共内联函数——failed-escalate 与 governance-escalate 双源复用（写路径同构，
  // 杜绝第二套暂停语义）。只做「paused 迁移 + 两事件同批追加」（不写盘），落盘由调用点统一 atomicWrite
  // （保持单次原子写：paused + batch.phase + 源事件同批落盘，不调 setPhase 二次写防竞态）；
  // 状态事件发布亦由调用点统一触发（事件载荷 reason 区分双源）。
  // 棘轮校验（machine.applyBatchTransition running→paused bv.ok）在调用点完成——本函数不重复校验。
  function escalatePausedWrite(batch, { reason, eventType, fields }) {
    batch.phase = 'paused';
    batch.events.push(newEvent(EVT.EVT_BATCH_PHASE, { from: 'running', to: 'paused', reason }));
    batch.events.push(newEvent(eventType, fields));
  }

  return { newEvent, sigDupVerdictOf, emitStateChange, makeContractMissingSink, escalatePausedWrite };
}
