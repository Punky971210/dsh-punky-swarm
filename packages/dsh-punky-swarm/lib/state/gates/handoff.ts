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

// P1 交接门 · 出口侧（结算前：有无下游 / 有无已成立交接 / Leader 例外）——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。

import { findTask } from '../task-utils.js';
import { taskOf, smokeOf } from './detect.js';
// P1/P2 交接门开关：**唯一解析点**在 `lib/state/handoff-gate.js#handoffGateEnabledOf`（读 runtime.json
//   `gates.handoff.*`，env 仅兜底）；本文件只**调用**它，不自行读 env/config 判据（禁两套读取）。
//   【A1-P2-01 补丁③】改为直连零依赖叶子（原经 `../../wave-plan.js`，与 `state/gates.js` 构成 4 模块 SCC）；
//   `wave-plan.ts` 保留同名保形再导出，故该判据在包内的公开取用位置不变。
import { handoffGateEnabledOf } from '../handoff-gate.js';
import type { Batch } from '../../types/contracts.js';
// 人工裁决证据解析单点（WD-1）：禁在本文件内复制证据正则
import { humanEvidenceOf } from '../constants.js';

import type { GatesCx } from './cx.js';

export function buildHandoff(cx: GatesCx) {
  // 【G-10 修复】「已声明入边」单点判定（`lib/state/gates/helpers.ts#declaredInboundEdgesOf`）：
  //   本门「有无下游」集合的并集侧消费它 —— 与 entry 门/提交前置**同一份**口径（红线 C-4 单点判定）。
  const { handoffRecordVerdict, readCfg, declaredInboundEdgesOf } = cx;

  // ── P2-A：出口侧「有下游 ⇒ 须至少一条已成立交接」────────────────────────
  // 定位（`p2-settle-narrowing-changeplan-20260917`（原文档未随仓分发） §7）：**结算出口收紧**——`merged` 前判本 lane 的
  //   **交接是否已成立**。与既有门的分工（§2 校正 A，D2 由此成立）：
  //     · `checkExitGate` 看**本 lane 自己的** `produce ∪ outputs` 在场（防**空结算**）⇒ 原样保留；
  //     · 本门看**交给下游的那批产物**（`handoff.artifacts`）是否已交付 ⇒ 两者**对象不同、非重复判定**。
  // 判据（**只判这一件事**）：
  //   ① **有无下游**：他人 `deps` 引用本 lane，或本 lane 的 `next` 指向存在的步；**无下游 ⇒ 本门零感知**；
  //   ② **有无已成立交接**：`batch.handoffs[*]` 中 `from === lane` 且 `status:'submitted'` +
  //      `artifacts` 非空且**逐个在场** + `contract{consumedFrom, assertions}` 合规 —— **至少一条**即算成立。
  // 豁免/例外（三条，均**不改其它门**）：① `smoke` 批 ⇒ 豁免（与 P1 同键口径）；② 存量批（无 `batch.handoffs`
  //   字段）⇒ 放行 + `legacy` 标记（出口侧同一口径：不静默、不砸存量）；③ **Leader 例外**：
  //   `merged` 的 note 含 `human:<裁决人>:<时间>:<结论>` ⇒ 放行 + `humanException`（留痕由写端落，判据同源 =
  //   与 `checkNeedHumanGate` 同一正则形态）。
  // 开关（`task-27`）：经**唯一解析点** `handoffGateEnabledOf(readCfg(),'settle')` 取值
  //   （真源 = runtime.json `gates.handoff.settle`，env 兜底，缺省关）——「工具是机制、门是策略」：
  //   关闭时本门**不拦**（保证既有批零回归），开启后生效；写端（`store.js`）据此落缺口事件。
  function checkSettleHandoffGate(
    sessionId: string, batchId: string, batch: Batch, lane: string, note?: string | null,
  ): { ok: boolean; code: string | null; missing: string[]; problems: string[]; disabled?: boolean; smoke?: boolean; legacy?: boolean; humanException?: boolean; downstream?: string[] } {
    if (!handoffGateEnabledOf(readCfg(), 'settle')) return { ok: true, code: null, missing: [], problems: [], disabled: true };
    if (smokeOf(batch)) return { ok: true, code: null, missing: [], problems: [], smoke: true };
    // ① 有无下游（禁猜：按**声明**判定 —— 静态 `deps` 引用 **∪** 「已声明入边」）
    //   【G-10 修复 · 批 `g10-fix-20261012`】原实现**只**遍历 `wavePlan[].tasks[].deps` ⇒ 追加的后置 lane
    //   因「无出边」而**没有对象**、缺口**不转红**（静默本体）。修法 = **扩为并集**：凡本 lane 出现在任何
    //   下游的「已声明入边」集合中（含下游经 `handoff_accept` 声明接受的后置边）⇒ 本 lane **必须有**一条
    //   已成立交接，否则本门拒 `GATE_HANDOFF_MISSING` + 落 `lane.handoff.gap`。
    //   方向 = **净收紧**（只增义务、不减），且集合口径**单点**取自 `declaredInboundEdgesOf`（红线 C-4）。
    const t = taskOf(batch, lane);
    const downstream: string[] = [];
    for (const w of batch.wavePlan ?? []) {
      for (const x of w.tasks ?? []) {
        if (!x || typeof x.id !== 'string' || x.id.length === 0 || x.id === lane) continue;
        const deps = Array.isArray((x as unknown as { deps?: unknown }).deps) ? ((x as unknown as { deps?: unknown }).deps as unknown[]) : [];
        const declared = declaredInboundEdgesOf(batch, x.id, x).edges;
        if (deps.some((d) => d === lane) || declared.includes(lane)) downstream.push(x.id);
      }
    }
    const nextOf = (t as unknown as { next?: unknown } | null | undefined)?.next;
    if (typeof nextOf === 'string' && nextOf.length > 0 && findTask(batch, nextOf)) downstream.push(nextOf);
    if (downstream.length === 0) return { ok: true, code: null, missing: [], problems: [], downstream: [] };
    // ② 有无已成立交接：存量批（无 handoffs 字段）⇒ 放行 + legacy 留痕
    const map = (batch as unknown as { handoffs?: unknown }).handoffs;
    if (map === undefined || map === null) {
      return { ok: true, code: null, missing: [], problems: [], legacy: true, downstream };
    }
    const records: Array<Record<string, unknown>> = [];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const list of Object.values(map as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        for (const r of list) if (r && typeof r === 'object' && !Array.isArray(r)) records.push(r as Record<string, unknown>);
      }
    }
    const problems: string[] = [];
    const missing: string[] = [];
    let anySatisfied = false;
    // 判据**单点复用**（裁决 ②）：逐条 out 边记录调 `handoffRecordVerdict`（与 entry 门**同一实现**，
    //   禁第二套标准）。集合语义差异（entry = 每条入边都成立 / 出口 = 至少一条 out 边成立）留在本层。
    for (const rec of records) {
      if (rec.from !== lane) continue;
      const to = typeof rec.to === 'string' && rec.to.length > 0 ? rec.to : '?';
      const vr = handoffRecordVerdict(sessionId, batchId, t?.layer ?? null, rec, lane, to);
      if (vr.ok) { anySatisfied = true; break; }
      missing.push(...vr.missing);
      problems.push(...vr.problems);
    }
    if (anySatisfied) return { ok: true, code: null, missing: [], problems: [], downstream };
    // ③ Leader 例外（note 含 human: 证据）⇒ 放行 + 留痕标记
    const evidence = humanEvidenceOf(note);
    if (evidence) return { ok: true, code: null, missing: [], problems: [], downstream, humanException: true };
    missing.unshift('handoff:' + lane + '->(' + downstream.join('/') + ')');
    problems.unshift('lane ' + lane + ' 在 DAG 中有下游（' + downstream.join('/') + '）但**无一条已成立交接**'
      + '（`handoff_submit` 须 status=submitted + artifacts 逐个在场 + contract{consumedFrom,assertions} 合规）'
      + ' ——Leader 例外：merged 的 note 含 `human:<裁决人>:<时间>:<结论>` 可放行并留痕');
    return { ok: false, code: 'GATE_HANDOFF_MISSING', missing, problems, downstream };
  }

  return { checkSettleHandoffGate };
}
