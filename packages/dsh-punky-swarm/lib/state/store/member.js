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

// 成员状态机：setMember（唯一迁移写路径）——
//   【2026-10-02 · 内务批 波 3】随 `createStore` 巨型函数拆分下沉；
//   依赖方向单向：`store.js`（组合器）→ 本文件，本文件不反向 import 组合器。

import * as schema from '../../schema.js';
import * as machine from '../machine.js';
import * as EVT from '../event-types.js';
// 断点指针：结算终态清退（纯函数，落盘在调用点）
import { laneProgressClear } from '../resume.js';
// longrun 长程豁免授予面：载荷归一 + 4 个 GATE 错误码（档位表/写单点在 lane-exempt.js）
import { EXEMPT_GATE_CODES, normalizeExemptPayload } from '../lane-exempt.js';
// C 子项：连续失败升级（spec C）——计数纯函数（事件面单点，供单测）
import { countConsecutiveFailedSettles } from './events.js';
// D7（豁免继承/清退留痕）事件名——单点 = `lib/state/event-types.js`；本文件沿用原 `store.js` 别名，保持搬移逐字。
const EVT_LANE_EXEMPT_INHERITED = EVT.EVT_LANE_EXEMPT_INHERITED;

export function buildMember(cx) {
  const { gates, readBatch, newEvent, commitBatch, appendGatePayloadEvents, runMergedGateChain, laneExemptClear, applyLaneExemptOnDispatch, sigDupVerdictOf, makeContractMissingSink, conditionFileExists, emitStateChange, escalatePausedWrite, ratchet } = cx;

  function setMember(sessionId, batchId, lane, to, note = null, exempt = undefined, owner = undefined) {
    let batch = readBatch(sessionId, batchId); // 终态清退经 laneProgressClear 返回新 batch（不突变入参）
    let sigDup = null; // sig 幂等留痕判定（见下方消费点；事件与去重键随本次迁移**同一次 atomicWrite** 落盘）
    if (!batch) throw new Error('batch not found: ' + batchId);
    // 终态批次冻结：complete / aborted 之后不再接受任何成员迁移（防「已收口批次仍被改写成 running」的治理自相矛盾）
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); member transition rejected');
    }
    schema.assertMemberState(to);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    // 豁免参数面强校验（R-5）：exempt 只能在「派发面」（to==='running'）出现——
    // 出现（含 null）且 to!=='running' → 拒 GATE_EXEMPT_NOT_DISPATCH（状态与批次 JSON 均不变，无写入）。
    // 置位在既有迁移校验之前：豁免是**参数面非法**（与 invalid member transition 同族、直接 throw、无门禁载荷可留），
    // 优先判定可让「非法迁移 + 非法豁免参数」的调用得到语义明确的豁免错误码。
    if (exempt !== undefined && to !== 'running') {
      throw new Error(EXEMPT_GATE_CODES.NOT_DISPATCH
        + ': exempt 仅允许出现在派发面（to=running），当前 to=' + to + '（豁免只能在派发时附带授予）');
    }
    const from = batch.lanes[lane];
    // Q3-A①（Leader 附则，本批 e2 落地）：`review` 结算到 failed / skipped / conflict 三态**必须**带非空 note。
    //   语义：失败/跳过/冲突是「决策面」终态，缺理由 ⇒ 后来者无法复盘（零留痕的失败）。
    //   边界（逐字）：① **只**约束 `from === 'review'`（`pending`/`running`→failed 为既有语义，不动）；
    //   ② **只**约束 failed/skipped/conflict —— `merged` **不得**加同一要求（其已有 Exit/Targets/Command/needHuman 四门）；
    //   ③ 拒 = **零写入**（在既有豁免参数面检查之后、迁移校验之前抛出：不落盘、不改 batch、不产事件）。
    //   拒码：`GATE_SETTLE_NOTE_MISSING`（新引入，本批唯一新增拒绝码）。
    const SETTLE_NOTE_REQUIRED = ['failed', 'skipped', 'conflict'];
    if (from === 'review' && SETTLE_NOTE_REQUIRED.includes(to)) {
      const reason = typeof note === 'string' ? note.trim() : '';
      if (reason.length === 0) {
        throw new Error('GATE_SETTLE_NOTE_MISSING: review -> ' + to + ' 必须携带非空 note（失败/跳过/冲突的理由，供审计复盘）；'
          + '实测 note=' + JSON.stringify(note ?? null) + ' ⇒ 拒结算（零写入）。'
          + '注：`merged` 不受本要求约束（其已由 Exit/Targets/Command/needHuman 四门把关）。');
      }
    }
    // 豁免授予载荷（归一后；null = 本次调用无授予意图）。声明在函数作用域：entry 门禁分支内赋值、
    // 统一写盘点消费（entry 门禁失败会提前 throw/return，不会带着未授予的载荷走到写盘）。
    let exemptGrant = null;
    // V-4 写端收集器（本批 e2）：门禁**放行/降级**路径的 escape/degrade 载荷在此汇聚，
    //   统一在下方「统一写盘点」（member.settled 之前、同一次 atomicWrite）落盘 ⇒ 单次原子写、零重复。
    //   收集项形如 {type:'escape'|'degrade', res}——真正的常量解析延后到落盘前（fail-closed 语义最紧）。
    const gatePayloads = [];
    const collect = (kind, res) => { if (res) gatePayloads.push({ kind, res }); };
    // B2（§8⑤）首触留痕发射器（**即时 push**，与上方延迟收集器并存：两者互不影响既有事件面）
    const emitContractMissing = makeContractMissingSink(() => batch, () => lane);
    // 迁移判定走 machine（rules 可注入；默认规则与 schema 常量同引用，行为不变）
    const mv = machine.applyMemberTransition(from, to, { rules: ratchet });
    // D-4（2026-09-16 清债）：状态机保持严格（非法迁移仍拒），但**报错必须自带下一步**——
    //   活体实测高频踩点：`running -> merged/skipped` 被拒（结算前须先经 review）。
    //   把可用路径与下一步调用样例写在同一条错误里，省掉 Leader「猜一步再试」的往返。
    //   （合法迁移表 = MEMBER_TRANSITIONS；此处提示的是最常见的 review 中转，不改变判定。）
    const d4Hint = (from === 'running' && (to === 'merged' || to === 'skipped'))
      ? ' ⇒ 下一步：先 `member_status({ batchId, lane, status: "review" })` 置 review，再 `member_settle({ batchId, lane, status: "' + to + '" })`'
        + '（`running -> ' + to + '` 不在迁移表内；review 为合并/跳过的唯一中转）'
      : '';
    if (!mv.ok) throw new Error('invalid member transition: ' + from + ' -> ' + to + d4Hint);
    // ── sig 任务内容指纹（N3-②）· 消费点（D-sig-2 裁定：**只留痕不阻断**）────────────────────────
    // 语义：本 lane 的 `sig` 与同批次内**其他** lane 相同、且该 lane 状态 ∈ {running, review, merged}
    //   ⇒ 判定为「同内容任务被重复派发/重复结算」，落事件 `sig.duplicate_detected` **留痕**。
    //   硬边界（逐条，防扩权）：**不阻断本次迁移**（不 throw、不加拒码、不动 `GateErrorCode` union、
    //   不新增治理状态、不生 v2 字段）；判等用**迁移前**的 lanes 快照（此刻本 lane 尚未置 to）；
    //   同层重复计 `blocking` 记账项、跨层只作 `notice`（层不同 ⇒ 任务语义不同域，避免假阳性）。
    //   去重：同一 (lane, 对端集合) 只落一条（`sigDuplicateLogged`）；sig 平凡/零命中 ⇒ 零写入。
    //   位置：置于入口门之前——留痕与门禁**互不影响**（门拒时本条已如实记账，不静默丢事实）。
    sigDup = sigDupVerdictOf(batch, lane);
    // Tier3 门禁：派发（condition + entry）与结算（exit/Plan 契约）+ needHuman（review 挂起检测 / merged 人工裁决闸）
    if (to === 'running') {
      // 派发前条件校验（lane.condition 静态声明，DI fileExists）——不满足 → 不派发、自动落 skipped（既有终态迁移）+ lane.skipped 事件；wavePlan 不动不重算
      const cond = machine.checkDispatchCondition(sessionId, batchId, batch, lane, { fileExists: conditionFileExists(sessionId, batchId) });
      if (!cond.ok) {
        // 落 skipped 同样过棘轮表（fail-closed 优先：收紧配置删掉 from→skipped 时拒绝自动跳过，不绕过规则表）
        const skip = machine.applyMemberTransition(from, 'skipped', { rules: ratchet });
        if (!skip.ok) {
          throw new Error('invalid member transition: ' + from + ' -> skipped (condition unmet: ' + cond.missing.join(', ') + '; ratchet forbids auto-skip)');
        }
        // condition 自动 skipped 亦为结算终态——清退 laneProgress 断点指针（不残留脏指针）
        batch = laneProgressClear(batch, lane);
        batch.lanes[lane] = 'skipped'; // pending→skipped 既有合法迁移
        batch.events.push(newEvent(EVT.EVT_LANE_SKIPPED, { lane, from, note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.events.push(newEvent(EVT.EVT_MEMBER_SETTLED, { lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
        // R2 调用点埋点：condition 自动 skipped 亦为结算终态（member.settled 事件发布）
        emitStateChange({ type: 'member.settled', sessionId, batchId, lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') });
        return batch;
      }
      const g = gates.checkEntryGate(sessionId, batchId, batch, lane);
      // V-4 写端（e2）：entry 门的**放行侧**逃生载荷（standalone / idle-recovery-passthrough）落盘。
      //   拒侧（g.ok===false）无 escape 载荷（其留痕走下方既有 GATE_ENTRY_MISSING 事件）⇒ 天然不重复。
      if (g.ok) collect('escape', g);
      emitContractMissing(g); // B2（§8⑤ P-1 entry_requires）：放行/降级侧采集体 = 门禁返回值（拒侧不采）
      if (!g.ok) {
        // 载荷兼容：GATE_ENTRY_MISSING 用 `missing`；GATE_AUDIT_CRITERIA_MISSING（P1）等用 `problems`。
        //   **取非空者**：旧写法 `g.missing ?? g.problems` 在「missing 存在但为空数组 + problems 有内容」时会吞掉 problems
        //   ⇒ 抛错文案只剩码字、丢掉可执行提示（历史实机复验：留痕事件里 problems 是全的，但工具抛错无细节）。
        //   改后取非空者，两类门禁的抛错都带回提示。注：本条注释原引用的 「未拉起 Manager」码(已删) 已随
        //   gate-lite 第二批 A 项删除（该门整体移除），提示取非空者这一**机制**保留不变。
        const detail = (g.missing && g.missing.length) ? g.missing : (g.problems ?? []);
        // P1 交接门拒态：码 = `GATE_HANDOFF_MISSING`（独立码）⇒ 落**专用**缺口事件
        //   `lane.handoff.gap`（含**缺哪条边 / 缺哪件产物**，即 `missing[]`），**不再**复用 `gate.entry.missing`
        //   （语义独立、审计可辨：交接 ≠ consume 在场）。其余 entry 拒码（GATE_ENTRY_MISSING / STANDALONE_* /
        //   AUDIT_*）走原路径**逐字不变**。
        if (g.code === 'GATE_HANDOFF_MISSING') {
          batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, { lane, code: g.code, missing: g.missing ?? [], ...(g.problems ? { problems: g.problems } : {}) }));
        } else {
          batch.events.push(newEvent(EVT.EVT_GATE_ENTRY_MISSING, { lane, missing: g.missing ?? [], ...(g.problems ? { problems: g.problems } : {}) }));
        }
        batch.updatedAt = new Date().toISOString();
        commitBatch(sessionId, batchId, batch);
        throw new Error(g.code + (detail.length ? ': ' + detail.join(', ') : ''));
      }
      // P1 存量批放行留痕（**不静默、不砸存量**）：本批无 `batch.handoffs` 字段（旧批）但该 lane
      //   声明了 deps 入边 ⇒ 未交接门整体放行 ⇒ 落 `lane.handoff.gap{legacy:true}` 告警，使「本 lane 是在无
      //   交接约束下开工的」在事件流里**可核**（不阻断、不追溯拒批）。闸门判据来自 gates.ts 的放行标记
      //   `handoffLegacy`（门禁纯函数不写事件 ⇒ 落盘一律在本写路径，R-5 边界不变）。
      if (g.handoffLegacy === true) {
        batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, {
          lane, code: 'GATE_HANDOFF_LEGACY_PASSTHROUGH', legacy: true, missing: [],
          problems: ['本批无 `batch.handoffs` 字段（存量批）⇒ 未交接门整体放行；本 lane 开工**未**受交接约束（裁决 ①=B：不静默、不砸存量）'],
        }));
      }
      // longrun 长程豁免授予（派发面唯一写入点，R-2/R-6）：entry 门禁通过后校验并归一载荷——
      //   非法结构 → GATE_EXEMPT_INVALID；未知 type → GATE_EXEMPT_TYPE_UNKNOWN（均在既有 guard 分支**零写入**语义下，
      //   即校验失败时不落盘、不改 batch（与 GATE_ENTRY_MISSING 拒派同族；entry 分支已在上方提前返回）。
      // 授予记录与本次迁移**同一次 atomicWrite** 落盘（下方统一写盘点），并携带 grantedFrom = 派发面来源（结构性证据）。
      if (exempt != null) {
        exemptGrant = normalizeExemptPayload(exempt);
      }
    }
    if (to === 'review') {
      // audit 产物含 needHuman 声明 → 落 lane.needhuman 事件（人工裁决转达）
      const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, null);
      collect('escape', nh); // V-4 写端（e2）：review 态关闭档留痕（needhuman-off）
      emitContractMissing(nh); // B2（§8⑤ P-3 needhuman @audit）：首触留痕
      if (nh.declared) batch.events.push(newEvent(EVT.EVT_LANE_NEEDHUMAN, { lane, path: nh.path }));
    }

    if (to === 'merged') {
      //── merged 门链已按面下沉 ──────────────────────────────────────────────────────────
      //   波 3 拆分：原内联段（exit → targets → command → needHuman → 出口交接）整体搬移至
      //   `store/member-gates.js#runMergedGateChain`，**门顺序 / 事件载荷 / 拒态零写入语义逐字不变**；
      //   本处只做调用，保持 setMember「单次读改写、单次 commitBatch」路径不分散。
      runMergedGateChain(batch, { sessionId, batchId, lane, note, collect, emitContractMissing });
    }

    // lane 结算终态（merged/failed/skipped/conflict，member_settle 语义）清退 laneProgress
    // 断点指针（不残留脏指针；批次 complete 后整块随批次归档由 archive 覆盖）
    if (schema.isMemberTerminal(to)) {
      batch = laneProgressClear(batch, lane);
      batch = laneExemptClear(batch, lane); // 结算终态同步清退 longrun 豁免（免残留到后续批次读端）
    }
    batch.lanes[lane] = to;
    // N1-R4-1b（K1 公共池）：**派发 = 唯一出池动作** ⇒ 在同一 atomicWrite 内把 `owner` 写进任务声明面。
    //   · 只在派发面（`to === 'running'`）写；`owner` 非字符串（含缺省 undefined）⇒ **零写入**（既有行为不变）。
    //   · 写的是 `wavePlan[].tasks[].owner`（声明面），与 `lanes[lane]`（执行面）**同一次落盘** ⇒ 二者不会漂移。
    //   · **非改派**：已出池（owner 非空）⇒ **不覆盖**（K1：已派发即冻结；换人 = 作废 + 池内新增替代 + gap-list 留痕）。
    if (to === 'running' && typeof owner === 'string' && owner.length > 0) {
      const wp = Array.isArray(batch.wavePlan) ? batch.wavePlan : [];
      for (let wi = 0; wi < wp.length; wi++) {
        const tasks = wp[wi]?.tasks;
        if (!Array.isArray(tasks)) continue;
        const ti = tasks.findIndex((x) => x && x.id === lane);
        if (ti < 0) continue;
        if (typeof tasks[ti].owner === 'string' && tasks[ti].owner.length > 0) break; // 已出池 ⇒ 不覆盖
        batch.wavePlan = wp.map((w, i) => (i !== wi ? w : {
          ...w,
          tasks: w.tasks.map((t, j) => (j !== ti ? t : { ...t, owner })),
        }));
        batch.events.push(newEvent(EVT.EVT_TASK_OWNER_ASSIGNED, { lane, owner, from }));
        break;
      }
    }

    // 豁免授予落盘（与本次迁移同一 commitBatch）：授予 / 继承 / 清退三落法整体下沉
    //   `store/member-exempt.js#applyLaneExemptOnDispatch`（D7 §6.2）；本处只做调用（含 `batch` 承接），
    //   保持「单次读改写、单次落盘」路径不分散、语义逐字不变。
    batch = applyLaneExemptOnDispatch(batch, { lane, from, to, exemptGrant });

    // ── V-4 统一写盘点（e2-gov-repair）：逃生/降级载荷 → 批次事件 ──────────────────────────
    //   实现单点 = 组合器内 `appendGatePayloadEvents`（**先在组合器解析常量**（fail-closed），
    //   再做白名单搬运）；本处只做调用 —— 落盘仍在下方同一次 `commitBatch` 内 ⇒
    //   「门禁已判 + 留痕同批落盘」不可分割、绝不产生 `type:undefined` 事件。
    appendGatePayloadEvents(newEvent, batch, gatePayloads, lane);

    batch.events.push(newEvent(EVT.EVT_MEMBER_SETTLED, { lane, from, to, note: note ?? null }));
    // 连续失败升级——failed 结算后计数：同批次最近连续 failed ≥3 且批次 running → 触发 paused。
    // 单次原子写：paused 迁移 + batch.phase 事件 + batch.failed-escalate 事件与本次结算同批落盘（不调 setPhase 二次写盘，避免竞态）。
    // 棘轮校验 fail-closed：running→paused 迁移被部署收紧删除时 bv.ok=false，不触发、不绕过棘轮；
    // phase 闸（T-2）：paused 后 phase 非 running 自然不重复；人工 resume 后计数从当前事件流重新评估；
    // 不自动重试：failed 仍为终态（schema failed: [] 不变），重做=重开新批次。
    // 升级写走公共内联函数 escalatePausedWrite（failed-escalate 与 governance-escalate 双源复用，
    //   写路径同构杜绝第二套暂停语义）；本段行为零变化（reason='failed-escalate' + batch.failed-escalate 事件原样）。
    let escalated = false;
    if (to === 'failed' && batch.phase === 'running') {
      const streak = countConsecutiveFailedSettles(batch.events);
      if (streak >= 3) {
        const bv = machine.applyBatchTransition('running', 'paused', { rules: ratchet });
        if (bv.ok) {
          escalatePausedWrite(batch, {
            reason: 'failed-escalate',
            eventType: EVT.EVT_BATCH_FAILED_ESCALATE,
            fields: { lane, count: streak },
          });
          escalated = true;
        }
      }
    }
    // sig 幂等留痕（N3-②）：**事件 + 去重记账键**在同一次 atomicWrite 内落盘（与迁移不可分叉；
    //   分两次写会被本函数随后的整文件写覆盖 —— 见 `sigDupVerdictOf` 头注）。事件载荷由
    //   `lib/sig-fingerprint.js#sigDuplicateVerdict` 单点构造（`type` 键承载事件名，载荷不占用）。
    if (sigDup?.log) {
      batch.events.push(newEvent(EVT.EVT_SIG_DUPLICATE_DETECTED, sigDup.fields));
      batch.sigDuplicateLogged = { ...(batch.sigDuplicateLogged ?? {}), [sigDup.key]: true };
    }
    batch.updatedAt = new Date().toISOString();
    commitBatch(sessionId, batchId, batch);
    // 调用点埋点：member.settled（结算终态/返工入 review 等全部迁移）+ 伴随的 batch.phase（failed-escalate）
    emitStateChange({ type: 'member.settled', sessionId, batchId, lane, from, to, note: note ?? null });
    if (escalated) {
      emitStateChange({ type: 'batch.phase', sessionId, batchId, from: 'running', to: 'paused', reason: 'failed-escalate' });
    }
    return batch;
  }

  return { setMember };
}
