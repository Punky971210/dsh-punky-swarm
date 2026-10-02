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

// 成员迁移的 merged 门链 + 批次阶段迁移 + longrun 豁免清退/撤销——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import * as schema from '../../schema.js';
import * as machine from '../machine.js';
import * as EVT from '../event-types.js';

export function buildMemberGates(cx) {
  const { gates, readBatch, newEvent, emitStateChange, makeContractMissingSink, archive, ratchet, commitBatch } = cx;

  // ── `to === 'merged'` 门链（exit → targets → command → needHuman → 出口交接）───────────────────
  //   【2026-10-02 · 内务批 波 3】自 `setMember` **整体搬移**（门顺序 / 事件载荷 / 拒态零写入语义逐字不变）：
  //   原内联段与 setMember 共享 `batch`（就地突变）+ 两个收集器（`collect` / `emitContractMissing`），
  //   故以显式参数承接，保持「单次读改写、单次 commitBatch」不可分叉。
  function runMergedGateChain(batch, { sessionId, batchId, lane, note, collect, emitContractMissing }) {
  const g = gates.checkExitGate(sessionId, batchId, batch, lane);
  // V-4 写端（e2）：exit 门的降级载荷（produce-field-widened 等）——**放行侧**落盘；
  //   拒侧（!g.ok）不落 degrade（既有 gate.exit_missing 已留痕，避免同一次失败双事件）。
  if (g.ok) collect('degrade', g);
  emitContractMissing(g); // B2（§8⑤ P-2 contract @plan）：plan 契约门的放行侧采集体
  if (!g.ok) {
    batch.events.push(newEvent(EVT.EVT_GATE_EXIT_MISSING, { lane, code: g.code, detail: g.problems ?? g.missing }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    throw new Error(g.code + ': ' + (g.problems ?? g.missing).join(', '));
  }
  batch.events.push(newEvent(EVT.EVT_GATE_PASSED, { lane, gate: 'exit' }));
  // targets 门禁：exec 层声明 targets（批次产物根外目标文件）→ merged 前置校验——
  // exit gate 之后、command gate 之前（增量接线，不改既有门禁顺序与语义）。
  // 失败（missing/unchanged）→ gate.target_blocked 事件 + 抛错拒 merged（lane 留 review，成员态不变，与 exit gate 同语义）；
  // 通过且 declared → gate.target.passed 事件留痕；未声明/非 exec/逃生阀 → 零感知（无事件）。
  const tg = gates.checkTargetsGate(sessionId, batchId, batch, lane);
  collect('escape', tg); // V-4 写端（e2）：targets 面的 env 阀 / 团队关闭留痕（env-gate-disabled / targets-off）
  emitContractMissing(tg); // B2（§8⑤ P-5 targets @exec）：放行侧首触留痕
  if (!tg.ok) {
    batch.events.push(newEvent(EVT.EVT_GATE_TARGET_BLOCKED, { lane, code: tg.code, missing: tg.missing ?? [], unchanged: tg.unchanged ?? [] }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    throw new Error(tg.code + ': targets 未通过校验（missing=' + (tg.missing ?? []).join(', ') + '; unchanged=' + (tg.unchanged ?? []).join(', ') + '）');
  }
  if (tg.declared) {
    batch.events.push(newEvent(EVT.EVT_GATE_TARGET_PASSED, { lane, mode: tg.mode ?? 'mtime', targets: tg.targets ?? [] }));
  }
  // 命令 gate（V1）：exec 层产物声明行 `gate: <命令>` → merged 前置确定性执行（checkExitGate 之后、needHuman 之前）
  // 成功/未声明 → gate.exit 事件（declared 时）后继续；失败+needHuman 声明 → 转人工闸（escalation，merged 须 note 含 human: 证据）；
  // 失败+未声明 → gate.exit_blocked 事件 + 抛 GATE_EXIT_*（拒 merged，lane 留 review）
  const cg = gates.checkCommandGate(sessionId, batchId, batch, lane);
  collect('escape', cg); // V-4 写端（e2）：命令面留痕（env-gate-disabled / command-declared-off）
  emitContractMissing(cg); // B2（§8⑤ P-4 gate_command @exec）：放行侧首触留痕
  if (!cg.ok) {
    batch.events.push(newEvent(EVT.EVT_GATE_EXIT_BLOCKED, { lane, code: cg.code, command: cg.command ?? null, exitCode: cg.exitCode ?? null, detail: cg.detail ?? null, escalation: cg.needHumanEscalation === true }));
    if (cg.needHumanEscalation) {
      // 转人工闸：复用 needHuman 证据契约（note 含 `human:<裁决人>:<时间>:<结论>`）；无证据 → GATE_NEEDHUMAN_PENDING 挂起
      const evidence = typeof note === 'string' ? (note.match(/^human:.+/m) ?? [null])[0] : null;
      if (!evidence) {
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
        throw new Error('GATE_NEEDHUMAN_PENDING: 命令 gate 失败（' + cg.code + '）且产物声明 needHuman，merged 须 note 含 human: 证据');
      }
      batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note })); // 人工裁决留痕（note 可回溯）
    } else {
      batch.updatedAt = new Date().toISOString();
      commitBatch(sessionId, batchId, batch);
      throw new Error(cg.code + ': ' + (cg.detail ?? 'command gate failed'));
    }
  } else if (cg.declared) {
    batch.events.push(newEvent(EVT.EVT_GATE_EXIT, { lane, commands: cg.commands ?? [], results: cg.results ?? [], outputTruncated: cg.outputTruncated === true }));
  }
  // needHuman 人工闸（merged 前置，与 checkExitGate 并列）——声明 lane 缺 human: 证据 → 拒 GATE_NEEDHUMAN_PENDING
  const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, note);
  collect('escape', nh); // V-4 写端（e2）：merged 前置 needHuman 面关闭档留痕（needhuman-off）
  emitContractMissing(nh); // B2（§8⑤ P-3 needhuman @audit）：merged 前置面的首触（同键已被 review 态拦下）
  if (!nh.ok) {
    batch.events.push(newEvent(EVT.EVT_GATE_NEEDHUMAN_BLOCKED, { lane, code: nh.code, path: nh.path }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    throw new Error(nh.code + ': ' + nh.message);
  }
  if (nh.declared) batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note })); // 人工裁决留痕（note 可回溯）
  // ── P2-A：出口侧收紧「有下游 ⇒ 须至少一条已成立交接」───────────────
  // 位置纪律：**放在既有门链末尾**（exit → targets → command → needHuman 之后、写盘点之前）⇒
  //   **既有门顺序与语义一字不动**（本批只**新增**判定；D2「保留 exit 门」由此自然成立）。
  // 语义：本 lane 有下游却无一条已成立交接 ⇒ 拒 `GATE_HANDOFF_MISSING` + 落 `lane.handoff.gap` 缺口事件；
  //   Leader 例外（note 含 `human:<裁决人>:<时间>:<结论>`）⇒ 放行 + `human.decision` 留痕；
  //   存量批（无 `batch.handoffs`）⇒ 放行 + `lane.handoff.gap{legacy:true}` 留痕（不静默、不砸存量）。
  //   门开关经**唯一解析点**（`wave-plan.ts#handoffGateEnabledOf`，读 runtime.json `gates.handoff.settle`
  //   + env 兜底，缺省关）⇒ 关闭时本段零行为变化（既有批零回归）；`task-27` 后改 runtime.json 即热生效。
  const shg = gates.checkSettleHandoffGate(sessionId, batchId, batch, lane, note);
  if (shg.legacy === true) {
    batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, {
      lane, code: 'GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH', legacy: true, missing: [],
      problems: ['本批无 `batch.handoffs` 字段（存量批）⇒ 出口侧交接门放行；本 lane 结算**未**受交接约束（不静默、不砸存量）'],
    }));
  } else if (!shg.ok) {
    batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, {
      lane, code: shg.code, missing: shg.missing ?? [], ...(shg.problems ? { problems: shg.problems } : {}),
    }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    throw new Error(shg.code + ': ' + (shg.missing ?? []).join(', ') + (shg.problems?.length ? ' ——' + shg.problems[0] : ''));
  } else if (shg.humanException === true) {
    batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note: 'handoff-exception: ' + String(note ?? '') }));
  }
  }

  function setPhase(sessionId, batchId, to, { reason = null } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    // B2（§8⑤）首触留痕发射器：与 `setMember` **共用同一实现**；complete 面无 lane 归因 ⇒ lane 缺省 null
    const emitContractMissing = makeContractMissingSink(() => batch, () => null);
    schema.assertBatchPhase(to);
    const from = batch.phase;
    // ── 相位迁移**事由**（`reason`）随事件落盘 ──────────────────────
    //   动机：`batch.phase` 是「为何不推进」的唯一跨会话可核事实源（审计入口 = `log_export` markdown
    //   时间线）；只有 `{from,to}` 时，读端无法区分「链停轮」与「人工停轮」。
    //   归一化：仅**非空字符串**（trim 后）计事由，其余（缺省 / 空串 / 空白串 / 非字符串）一律 null
    //   ⇒ **非空才写键**，保持既有 `{from,to}` 形态零污染（历史读端与既有深比较不受影响）。
    //   词表（形如 `<source>` 或 `<source>:<detail>`）见 `lib/state/event-types.js` 的 EVT_BATCH_PHASE 登记。
    const reasonStr = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
    // 批次阶段迁移判定走 machine（rules 可注入；默认规则与 schema 常量同引用，行为不变）
    const bv = machine.applyBatchTransition(from, to, { rules: ratchet });
    if (!bv.ok) throw new Error('invalid batch phase transition: ' + from + ' -> ' + to);
    if (to === 'complete') {
      const g = gates.checkCompleteGate(batch);
      // B2（§8⑤ P-6 complete @audit）：`setPhase` 是**独立函数**（无 `setMember` 的收集器作用域）⇒
      //   本处自建同一发射器（共用 `makeContractMissingSink`，杜绝第二套语义）；落盘点 = 本函数尾部
      //   同一次 `atomicWrite`（与 batch.phase 事件同批落盘，不可分割）。
      emitContractMissing(g);
      if (!g.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_COMPLETE_BLOCKED, { code: g.code, pending: g.pending }));
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
        throw new Error(g.code + (g.pending ? ': ' + g.pending.join(', ') : ''));
      }
    }
    batch.phase = to;
    batch.events.push(newEvent(EVT.EVT_BATCH_PHASE, reasonStr ? { from, to, reason: reasonStr } : { from, to }));
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    // 调用点埋点：batch.phase 迁移事件发布（规划→运行→暂停→终态等全部阶段迁移）
    emitStateChange({ type: 'batch.phase', sessionId, batchId, from, to, ...(reasonStr ? { reason: reasonStr } : {}) });
    // complete 钩子——门禁通过 + phase 写入后自动归档（单向、幂等）；
    // 失败仅记录 archive.failed（archiveBatch 内部处理），不阻断 complete；try/catch 兜底意外异常（如批次文件不可读）
    if (to === 'complete') {
      try {
        archive.archiveBatch(sessionId, batchId);
      } catch (err) {
        try {
          const b = readBatch(sessionId, batchId);
          if (b) {
            b.events.push(newEvent(EVT.EVT_ARCHIVE_FAILED, { reason: String((err && err.message) || err) }));
            b.updatedAt = new Date().toISOString();
            commitBatch(sessionId, batchId, b);
          }
        } catch { /* 兜底也失败：静默（complete 已置位，审计可经 archive/ 目录状态判断） */ }
      }
    }
    return batch;
  }

  return { runMergedGateChain, setPhase };
}
