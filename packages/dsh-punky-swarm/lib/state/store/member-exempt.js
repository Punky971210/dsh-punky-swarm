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

// longrun 长程豁免面（撤销唯一入口 / 清退纯函数 / 派发面授予·继承·清退）——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import * as EVT from '../event-types.js';
// longrun 长程豁免授予面定义单点（档位表 + 载荷校验/归一 + 4 个 GATE 错误码 + 白名单）；
// 本文件只做接线：派发面写入 batch.laneExempt + 同次 atomicWrite 落 lane.exempt.* 事件
import { EXEMPT_GATE_CODES } from '../lane-exempt.js'; // 撤销唯一入口的拒码单点
// D7（豁免继承/清退留痕）事件名——单点 = `lib/state/event-types.js`；本文件沿用原 `store.js` 别名，保持搬移逐字。
const EVT_LANE_EXEMPT_CLEARED = EVT.EVT_LANE_EXEMPT_CLEARED;
const EVT_LANE_EXEMPT_INHERITED = EVT.EVT_LANE_EXEMPT_INHERITED;

export function buildMemberExempt(cx) {
  const { readBatch, newEvent, commitBatch } = cx;

  // longrun 长程豁免：撤销唯一入口（显式调用，不改成员状态）。
  // 与 setMember **互斥**（工具层已保证两者不得并用：revokeExempt 携带 status → GATE_EXEMPT_NOT_DISPATCH）；
  // 契约：`laneExempt` 无该 lane → 拒 GATE_EXEMPT_REVOKE_REQUIRED（撤销只能由显式调用产生，不可隐式产生）；
  // 成功 → 删条目（表空则整键删除，保持「无值不写键」）+ 同一次 atomicWrite 追加 lane.exempt.revoked。
  function revokeLaneExempt(sessionId, batchId, lane) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    const grant = batch.laneExempt?.[lane];
    if (!grant) {
      throw new Error(EXEMPT_GATE_CODES.REVOKE_REQUIRED
        + ': lane ' + lane + ' 无既有豁免（撤销须显式调用，且仅对已授予豁免的 lane 有效；无豁免可撤 → 不产生任何写入）');
    }
    const next = { ...batch.laneExempt };
    delete next[lane];
    // 表空 → 整键删除（不在批次 JSON 留下空对象噪音，旧批/非豁免批形态保持一致）
    if (Object.keys(next).length === 0) delete batch.laneExempt;
    else batch.laneExempt = next;
    const revokedAt = new Date().toISOString();
    batch.events.push(newEvent(EVT.EVT_LANE_EXEMPT_REVOKED, {
      lane,
      exemptType: grant.type,
      multiplier: grant.multiplier,
      at: revokedAt,
      grantedAt: grant.grantedAt,
    }));
    // D7 次选留痕（与 revoked **同一事实、同一时刻、同一次写盘**）：显式撤销 = 「清退」的动作面，
    //   revoked 记「谁做的动作」、cleared 记「清退这一状态变化」——读端 `exemptClearedAtOf`（e1 探针）
    //   据此把清退时间透出为 `exemptClearedAt`，使「撤销后重新计时」可见。
    //   两者**不合并**：revoked 是豁免撤销的专用事件（既有读端），cleared 是通用清退留痕（含 D7 次选语义）。
    batch.events.push(newEvent(EVT_LANE_EXEMPT_CLEARED, { lane, clearedAt: revokedAt, reason: 'explicit-revoke' }));
    batch.laneExemptCleared = { ...(batch.laneExemptCleared ?? {}), [lane]: revokedAt };
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    return batch;
  }

  // longrun 豁免清退（纯函数，返回新 batch）：豁免是「本次派发」的属性，不是 lane 的长期属性。
  // 调用点：① 结算终态（批次归档前清理）② 显式撤销后的兜底清退。**默认仍静默**
  //   （不产 lane.exempt.revoked——该事件专表「Leader 显式撤销」；读端以最近一次 lane.exempt.granted 为准判读）。
  // D7（2026-09-14）：`clearedAt` 给出时**改为留痕清退**——写 `batch.laneExemptCleared[lane]`（批量级时间戳）
  //   + 字面量事件 `lane.exempt.cleared`（payload `{lane, clearedAt, from}`），使「清退事实」在探针读端可见
  //   （`lib/watch/lane-heartbeat.js:325-337` `exemptClearedAtOf` 的两个通道），把旧口径下「静默清退 ⇒
  //   长任务恢复后重新变成长跑候选（误报）」变成**可见的重新计时**。
  //   事件名走**字面量**（`lib/state/event-types.js` 本批无写者，禁越域新增常量；e1 同款处置见其 §6）。
  //   清退**只改「清退事实」字段 + 事件**，不产 reason 码（G-5 裁定见 exec/manager-binding-impl.md §5：
  //   `reason` 恒由 state 判据给出，D2「reason 必须与 state 对齐」优先于 §6.2 次选的 `reason='exempt-cleared'`）。
  function laneExemptClear(batch, lane, clearedAt = null) {
    if (!batch?.laneExempt?.[lane]) return batch;
    const next = { ...batch.laneExempt };
    delete next[lane];
    if (Object.keys(next).length === 0) delete batch.laneExempt;
    else batch.laneExempt = next;
    if (clearedAt) {
      batch.laneExemptCleared = { ...(batch.laneExemptCleared ?? {}), [lane]: clearedAt };
      batch.events.push(newEvent(EVT_LANE_EXEMPT_CLEARED, { lane, clearedAt }));
    }
    return batch;
  }

  // 豁免授予落盘（与本次迁移同一 atomicWrite）：以最后一次派发面授予为准（覆盖旧记录，不设「已存在则拒」——
  // 避免阻塞 idle→running 重派；重派后阈值以新授予为准，探针侧 runningSince 亦从新 stint 起算）。
  // D7（2026-09-14，§6.2 **首选=继承**）：派发面无授予（exemptGrant 为 null）且 `to === 'running'` 时——
  //   ① 该 lane **仍有**旧豁免 ⇒ **继承**：保留 `batch.laneExempt[lane]`（阈值/倍率/stalled 语义原样延续，
  //      避免「长任务恢复重派 ⇒ 阈值被打回基准 ⇒ 重新变成长跑候选」的误报）+ 更新 `grantedAt` 为本次（新 stint 起算）
  //      + 写 `grantedFrom = from`（语义扩展为「显式授予 / 继承」两种来源）+ 字面量事件 `lane.exempt.inherited` 留痕。
  //   ② 该 lane **已无**旧豁免（此前终态清退 / 显式撤销）⇒ 走下方 `laneExemptClear` 兜底；**若确有清退发生**
  //      则以字面量事件 `lane.exempt.cleared` + `batch.laneExemptCleared[lane]` **留痕清退**
  //      （D7 次选的留痕面；e1 读端 `exemptClearedAtOf` 的两个通道都能读到）。
  //   **两条落法不并存于同一次迁移**：先看「有无可继承的旧豁免」——有则继承（不产 cleared），
  //   无则清退（不产 inherited）；即任一次重派**至多**产一条 `lane.exempt.*` 留痕事件（除本次显式授予）。
  //   显式撤销入口不变（`revokeLaneExempt`），继承**不妨碍**它：撤销仍整键删除并写 `lane.exempt.revoked`。
  // 【2026-10-02 · 波 3】本段自 `setMember` **整体搬移**（含上方历史登记逐字保留）；返回（可能被清退重建的）
  //   batch，调用点以 `batch = applyLaneExemptOnDispatch(...)` 承接 —— 语义与拆分前逐字一致（含 `laneExemptClear` 兜底）。
  function applyLaneExemptOnDispatch(batch, { lane, from, to, exemptGrant }) {
  let exemptInherited = null;
  if (!exemptGrant && to === 'running') {
    const prev = batch.laneExempt?.[lane];
    if (prev) {
      const inheritedAt = new Date().toISOString();
      exemptInherited = { ...prev, grantedAt: inheritedAt, grantedFrom: from, inheritedAt, inheritedFrom: prev.grantedAt ?? null };
      batch.laneExempt = { ...batch.laneExempt, [lane]: exemptInherited };
      batch.events.push(newEvent(EVT_LANE_EXEMPT_INHERITED, {
        lane, from, to: 'running',
        exemptType: exemptInherited.type,
        multiplier: exemptInherited.multiplier,
        tierMultiplier: exemptInherited.tierMultiplier,
        stalled: exemptInherited.stalled,
        grantedFrom: from,
        inheritedFrom: prev.grantedAt ?? null,
      }));
    } else {
      const at = new Date().toISOString();
      const cleared = laneExemptClear(batch, lane, at);
      // 仅当**确有一次清退发生**（laneExemptCleared 记到该 lane）才算「留痕清退」：避免对从未授予的 lane
      // 产出 cleared 事件噪音（与「零静默」互补的「零假留痕」）。
      if (cleared.laneExemptCleared?.[lane] === at) batch = cleared;
    }
  }
  if (exemptGrant) {
    const grantedAt = new Date().toISOString();
    batch.laneExempt = {
      ...(batch.laneExempt ?? {}),
      [lane]: { grantedAt, grantedFrom: from, ...exemptGrant },
    };
    // 载荷键纪律：newEvent(type, fields) 的 `type` 键承载**事件名**（引擎多处按 `e.type` 读取与过滤，
    // 如 log_export 的 `e.type.startsWith('gate.')`、面板 label、batch_status），载荷**不得**占用该键 →
    // 豁免类型一律写 `exemptType`（唯一无歧义的命名键；载荷表的 `type` 即事件名本身）。
    batch.events.push(newEvent(EVT.EVT_LANE_EXEMPT_GRANTED, {
      lane, from, to: 'running',
      exemptType: exemptGrant.type,
      multiplier: exemptGrant.multiplier,
      tierMultiplier: exemptGrant.tierMultiplier,
      stalled: exemptGrant.stalled,
      grantedFrom: from,
    }));
  }
    return batch;
  }

  return { revokeLaneExempt, laneExemptClear, applyLaneExemptOnDispatch };
}
