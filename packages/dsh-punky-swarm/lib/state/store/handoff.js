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

// P1 交接门：交接记录唯一写路径 + 交接写权判定——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import * as EVT from '../event-types.js';

export function buildHandoff(cx) {
  const { readBatch, newEvent, commitBatch } = cx;

  // ---- P1 交接门：交接记录写入（**唯一写路径内新增**，裁决 ③=A）----
  // 纪律（`p1-handoff-gate-changeplan-20260917`（原文档未随仓分发） §5「触碰唯一写路径」的缓解措施）：
  //   · **只新增函数**，既有写入语义（createBatch/appendEvent/setMember/atomicWrite）一字不改；
  //   · `batch.handoffs` 与 `lane.handoff` 审计事件**同一次 atomicWrite** ⇒ 「交了」与「记了」不可分叉；
  //   · 交接成立性判据（artifacts 在场 / contract 合规）**不在本函数重判**（单点判定在 entry 门，禁双重判定）：
  //     本函数只判**结构性前提**（批次存在 / 入边已在建批期种条 / artifacts 非空 / assertions 非空 / consumedFrom 指回入边），
  //     存在性事实由 `tools/core.js` 的交接工具面在**调用前**判定并回显缺口（与门禁判据同源：`presenceOfArtifact`）。
  const HANDOFF_MISSING = 'GATE_HANDOFF_MISSING';
  // ── R-1（P4 授权修复批 `onto-p4-authz-r2-20260925`，2026-09-25 · `plan/fix-spec.md` §2.1）：交接写权 ──
  // 需求真源 = `docs/b5-teammate-seat-design-v1-2026-09-25.md` §3 + 用户四项裁决；**实现落点 = 本函数**
  //   （唯一写路径 ⇒ 判据与写入同点，杜绝「先写后校验」）。
  const HANDOFF_UNAUTHORIZED = 'GATE_HANDOFF_UNAUTHORIZED';       // 身份可解析但不持该边写权
  const HANDOFF_IDENTITY_UNKNOWN = 'GATE_HANDOFF_IDENTITY_UNKNOWN'; // 身份不可解析（fail-closed）
  const HANDOFF_OVERWRITE_UNDECLARED = 'GATE_HANDOFF_OVERWRITE_UNDECLARED'; // R-2：已 submitted 且未显式声明覆盖
  // 判据链（**顺序即优先级**，`plan/fix-spec.md` §2.1 逐行）：
  //   ① 批 owner（`batch.sessionId`）⇒ 全批；② 已登记 Manager（`batch.manager.agentId`）⇒ 全批；
  //   ③ dispatch worker（本批 `member.dispatch.workerSessionId → lane`）⇒ 仅其自身 lane 的出边；
  //   ④ team 席位（`lane.roster` 命中调用方 roster 名）⇒ 其名下 lane 的出边；
  //   ⑤ 其余 ⇒ 拒（fail-closed）。
  // ⚠ **不新增第二套 dispatch 反查口径**：本函数只读**本批**事件流（`batch.events`），与 canonical 实现
  //   `lib/engine/dispatch.js#laneBindingOf`（跨批复查）**同一 `member.dispatch` 事实源**、同一字段名
  //   （`workerSessionId`/`lane`）；差异仅在查询范围（单批 vs 全批）——见实现说明的「登记」条。
  // ⚠ **拒态零写入**：本段只做**读判定**，不碰 `batch.handoffs`、不 push 事件、不落盘（写点全在下方成功分支）。
  //   三类拒态（UNAUTHORIZED / IDENTITY_UNKNOWN / OVERWRITE_UNDECLARED）一律 `write:false` ⇒ 批 JSON 与
  //   事件流**双零新增**（本 lane 任务包判据 2「拒时批 JSON 与事件流均无新增」）；拒因经工具面**显式抛错
  //   回显**（不静默）。其余结构性拒态（缺产物/缺断言/未声明入边）保持 R-1 之前**逐字行为**（照落 `lane.handoff.gap`）。
  function handoffAuthorityOf(batch, caller) {
    const raw = (caller && typeof caller === 'object') ? caller : {};
    const from = typeof raw.from === 'string' && raw.from ? raw.from : null; // 被交出的 lane（上游）
    const callerSessionId = (() => {
      const sid = raw.sessionId !== undefined && raw.sessionId !== null ? raw.sessionId : raw.callerSessionId;
      return typeof sid === 'string' && sid.length ? sid : null; // 空白/非字符串 ⇒ null（与未提供同态）
    })();
    const rosterNames = Array.isArray(raw.rosterNames)
      ? raw.rosterNames.filter((n) => typeof n === 'string' && n.trim().length).map((n) => n.trim())
      : [];
    // ①② 批 owner / 已登记 Manager ⇒ 全批（保留 Leader 代提交入边能力）
    if (callerSessionId && callerSessionId === batch.sessionId) return { ok: true, role: 'owner' };
    if (callerSessionId && batch.manager && batch.manager.agentId === callerSessionId) return { ok: true, role: 'manager' };
    // ③ dispatch worker：本批事件流反查（只认 workerSessionId 严格相等 + lane 非空）
    const dispatchLanes = [];
    for (const ev of batch.events ?? []) {
      if (ev && ev.type === 'member.dispatch' && ev.workerSessionId === callerSessionId && ev.lane) {
        if (!dispatchLanes.includes(ev.lane)) dispatchLanes.push(ev.lane);
      }
    }
    if (dispatchLanes.length) {
      if (!from) return { ok: false, role: 'dispatch', allowedFrom: dispatchLanes };
      return dispatchLanes.includes(from) ? { ok: true, role: 'dispatch' } : { ok: false, role: 'dispatch', allowedFrom: dispatchLanes };
    }
    // ④ team 席位：名 = `lane.roster`（R-3 承载字段，真源恒 `wavePlan.tasks[].roster`）
    const rosterLanes = [];
    for (const w of batch.wavePlan ?? []) {
      for (const t of w?.tasks ?? []) {
        if (t && typeof t.id === 'string' && typeof t.roster === 'string' && t.roster && rosterNames.includes(t.roster)) {
          if (!rosterLanes.includes(t.id)) rosterLanes.push(t.id);
        }
      }
    }
    if (rosterLanes.length) {
      if (!from) return { ok: false, role: 'roster', allowedFrom: rosterLanes };
      return rosterLanes.includes(from) ? { ok: true, role: 'roster' } : { ok: false, role: 'roster', allowedFrom: rosterLanes };
    }
    // ⑤ fail-closed：无法解析的陌生会话（含未提供身份）
    return { ok: false, role: 'unresolved', allowedFrom: [], resolution: 'no-owner/manager/dispatch/roster match' };
  }
  function recordHandoff(sessionId, batchId, { from, to, artifacts, assertions, officialTaskId = null, overwrite = false, caller = null } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    // 拒态留痕统一入口：`write !== false` ⇒ 落既有缺口事件 `lane.handoff.gap`（R1-c 要求：拒态非静默）；
    //   `write === false` ⇒ **零写入**（R-1④「拒时零写入」：批 JSON 与事件流均无新增）。
    const fail = (problems, missing, { code = HANDOFF_MISSING, callerRole = null, write = true } = {}) => {
      const r = { ok: false, code, problems, missing };
      if (write) {
        batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, {
          lane: to ?? null, code, ...(callerRole ? { callerRole } : {}), missing, problems,
        }));
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
      }
      return r;
    };
    // R-1 授权：**先于任何写入**。身份不可解析 ⇒ `GATE_HANDOFF_IDENTITY_UNKNOWN`（fail-closed）；
    //   可解析但 `from` 不属本人 lane ⇒ `GATE_HANDOFF_UNAUTHORIZED`（回显 `allowedFrom`）。
    const auth = handoffAuthorityOf(batch, caller ? { ...caller, from: from ?? caller.from ?? null } : null);
    if (!auth.ok) {
      if (auth.role === 'unresolved') {
        return fail(
          ['调用方身份不可解析（既非批 owner / 已登记 Manager，又无 member.dispatch 绑定、无 lane.roster 命中）⇒ fail-closed 拒（不猜、不静默）'],
          ['caller-identity'],
          { code: HANDOFF_IDENTITY_UNKNOWN, callerRole: 'unresolved', write: false },
        );
      }
      return fail(
        ['调用方（' + auth.role + '）对 lane "' + String(from ?? '') + '" 的出边无写权 ⇒ 越权写入被拒'],
        ['from:' + String(from ?? '')],
        { code: HANDOFF_UNAUTHORIZED, callerRole: auth.role, write: false },
      );
    }
    if (typeof from !== 'string' || !from.length) return fail(['handoff from 必填（上游 lane id）'], ['from']);
    if (typeof to !== 'string' || !to.length) return fail(['handoff to 必填（下游 lane id）'], ['to']);
    // 存量批（无 `handoffs` 字段）⇒ 不受新门约束 ⇒ 交接**不可登记**（否则会给存量批凭空开新门）：
    //   明确拒 + 回显（不静默），与裁决 ①=B「存量批放行 + 留痕」同向（放行的是**开工**，不是**新建交接载体**）。
    if (batch.handoffs == null || typeof batch.handoffs !== 'object' || Array.isArray(batch.handoffs)) {
      return fail(['本批无 `batch.handoffs`（存量批）⇒ 交接载体不存在，交接不予登记（新门只对新建批生效，裁决 ①=B）'], ['batch.handoffs']);
    }
    const list = Array.isArray(batch.handoffs[to]) ? batch.handoffs[to] : null;
    if (!list) return fail(['下游 lane ' + to + ' 无建批期交接声明（`deps` 入边未种条）⇒ 交接不成立'], ['edge:' + from + '->' + to]);
    const rec = list.find((r) => r && r.from === from) ?? null;
    if (!rec) return fail(['交接入边 ' + from + '->' + to + ' 不在建批期声明中（下游 deps 未含该上游）'], ['edge:' + from + '->' + to]);
    const arts = Array.isArray(artifacts) ? artifacts.filter((p) => typeof p === 'string' && p.trim().length > 0) : [];
    const asrt = Array.isArray(assertions) ? assertions.filter((a) => typeof a === 'string' && a.trim().length > 0) : [];
    const problems = [];
    const missing = [];
    if (arts.length === 0) { problems.push('artifacts 必填（至少一件上游交付产物）'); missing.push('artifacts'); }
    if (asrt.length === 0) { problems.push('contract.assertions 必填（至少一条下游可核断言）'); missing.push('contract.assertions'); }
    if (problems.length) return fail(problems, missing);
    // ── R-2（§2.2）：覆盖式改显式 —— 已 `submitted` 的边重交须**显式声明**，且旧值必留痕 ──
    //   · 未声明（`overwrite !== true`）⇒ 拒 `GATE_HANDOFF_OVERWRITE_UNDECLARED`（回显 `existingAssertions.length` / `existingTs`）；
    //   · 声明 ⇒ 放行覆盖：**追加式** push 旧值快照（`history`，禁替换/禁清空）+ 事件带 `previousAssertions`/`overwrite`；
    //   · **首次提交语义一字不改**（`status !== 'submitted'` ⇒ 下方赋值路径与 R-2 之前逐字相同）。
    const alreadySubmitted = rec.status === 'submitted';
    if (alreadySubmitted && overwrite !== true) {
      const existingAssertions = (rec.contract && Array.isArray(rec.contract.assertions)) ? rec.contract.assertions : [];
      const existingTs = rec.ts ?? null;
      const rejected = fail(
        ['入边 ' + from + '->' + to + ' 已 submitted ⇒ 重交须显式声明 overwrite:true（R-2 覆盖保护：禁静默覆盖）'],
        ['overwrite'],
        { code: HANDOFF_OVERWRITE_UNDECLARED, callerRole: auth.role, write: false },
      );
      // §2.2.2 要求回显（不落盘、不改批）：`existingAssertions.length` 与 `existingTs`
      return { ...rejected, existingAssertionsLength: existingAssertions.length, existingTs };
    }
    const prevArtifacts = Array.isArray(rec.artifacts) ? [...rec.artifacts] : [];
    const prevAssertions = (rec.contract && Array.isArray(rec.contract.assertions)) ? [...rec.contract.assertions] : [];
    if (alreadySubmitted) {
      const prev = {
        ts: rec.ts ?? null,
        artifacts: prevArtifacts,
        assertions: prevAssertions,
        officialTaskId: rec.officialTaskId ?? null,
      };
      rec.history = [...(Array.isArray(rec.history) ? rec.history : []), prev]; // 追加式：不替换、不清空历史
    }
    rec.artifacts = [...arts];
    rec.contract = { consumedFrom: from, assertions: [...asrt] };
    rec.status = 'submitted';
    rec.ts = new Date().toISOString();
    if (officialTaskId !== null && officialTaskId !== undefined) rec.officialTaskId = String(officialTaskId);
    batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF, {
      lane: to, from, to, artifacts: [...arts], assertions: [...asrt], handoffBatch: batchId,
      // R-2 事件侧留痕（§2.2.3 / R2-d）：`previousAssertions` 首交 = `[]`；`overwrite` 恒布尔。
      previousAssertions: [...prevAssertions],
      overwrite: alreadySubmitted,
      // 引擎/Leader 侧口径（本 lane 任务包点名）：`replaced` = 旧值快照（首交 = `null`）。
      replaced: alreadySubmitted ? { artifacts: [...prevArtifacts], assertions: [...prevAssertions] } : null,
    }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    return {
      ok: true, code: null, from, to, artifacts: [...arts], assertions: [...asrt],
      overwrite: alreadySubmitted, previousAssertions: [...prevAssertions], record: { ...rec },
    };
  }

  return { recordHandoff };
}
