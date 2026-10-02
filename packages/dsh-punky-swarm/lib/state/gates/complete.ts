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

// Complete 门（audit 验收前置）+ 未接线台账读端 + 资产视图只读壳——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。

import * as schema from '../../schema.js';
import { taskOf, smokeOf, contractMissingPayload } from './detect.js';
import type { Batch } from '../../types/contracts.js';

import type { GatesCx } from './cx.js';

export function buildComplete(cx: GatesCx) {
  const { completeOutcomesOf, declaredArtifactsOf, layersOf, orphanProductsOf } = cx;

  // Complete Gate：audit 层必须存在且全部 settled 且**通过验收**（Q-7）；exec 层全部 settled
  //   · B3：批次既无 exec 也无 audit（或 wavePlan 全无 layer）⇒ 拒 `GATE_COMPLETE_NO_TIER`（Q-6① 定稿）；
  //   · Q-7：有效白名单 = 声明 ∩ {pass, skip} ⇒ `fail` / `conflict` 恒拒，且拒绝载荷带 `escapeRoute{phase:'aborted'}`
  //     （D-8 终态可退出：不得出现「既不能 complete 也无法收口」的僵局——本载荷不改变「不得 complete」这一判定）；
  //   · A1（二级防线）：plan 层悬空产物 ⇒ 拒 `GATE_ORPHAN_PRODUCT`；exec / audit 悬空 ⇒ 强告警 + `gateStrength` 可见。
  function checkCompleteGate(batch: Batch) {
    const layers = layersOf(batch);
    // gate-lite Q-G1：冒烟/探针批判定（本函数内两处消费：plan 悬空产物门跳过 + 放行载荷回显）。
    //   验收判据门（NO_AUDIT / PENDING_AUDIT / AUDIT_FAILED / EXEC_PENDING）**不在豁免面内**（Q-G5 另裁）。
    const smoke = smokeOf(batch);
    // B3（Q-6① 定稿）：零执行零验收的批次不得收口（generic 豁免已成因消失的兼容条款）
    if (layers.exec.length === 0 && layers.audit.length === 0) {
      return {
        ok: false, code: 'GATE_COMPLETE_NO_TIER', pending: [],
        problems: ['batch has neither exec nor audit lane ⇒ 零执行零验收不得 complete（Q-6①，generic 豁免已废除）'],
      };
    }
    const laneState = (id: string) => batch.lanes[id];
    const allTerminal = (ids: string[]) => ids.every((id: string) => schema.isMemberTerminal(laneState(id)));
    if (layers.audit.length === 0) return { ok: false, code: 'GATE_COMPLETE_NO_AUDIT' };
    if (!allTerminal(layers.audit)) return { ok: false, code: 'GATE_EXIT_PENDING_AUDIT', pending: layers.audit.filter((id: string) => !schema.isMemberTerminal(laneState(id))) };
    // 完成判据（Q-7 重写 + E-4 清退）：声明真源 = `flows.audit.audit_contract.verdict`（**唯一**，只两态：
    //   verdict / 引擎基线）；缺声明 ⇒ 引擎基线 ['pass','skip']（`flows.complete.require_audit_outcomes` 已于
    //   legacy-retire-20260915 清退，不再读取）；白名单仍只能收窄到 {pass, skip} 子集；
    //   `fail` / `conflict` 与一切白名单外终态一律拒。
    const outcomes = completeOutcomesOf(batch);
    // B2（§8⑤ **P-6** complete）：验收白名单**未声明**（`flows.audit.audit_contract.verdict` 缺失 ⇒ 回落
    //   引擎 Q-7 基线 `{pass,skip}`）⇒ 产首触载荷。判定逐字不变（fail/conflict 恒拒、白名单只能收窄）。
    const cmComplete = outcomes.source.startsWith('engine:Q-7-baseline')
      ? contractMissingPayload(
        'complete', 'audit', outcomes.source, 'complete-outcomes-Q-7-baseline',
        '团队资产未声明 flows.audit.audit_contract.verdict ⇒ 引擎 Q-7 基线 {pass,skip} 接管；本事件为首触留痕，不改判定',
      )
      : null;
    const outcomeOf = (s: string) => (s === 'merged' ? 'pass' : s === 'skipped' ? 'skip' : s === 'failed' ? 'fail' : s === 'conflict' ? 'conflict' : null);
    const offenders = layers.audit.filter((id: string) => !outcomes.values.includes(String(outcomeOf(laneState(id)))));
    if (offenders.length) {
      // GAP-S2（2026-09-16）**收窄的补充诊断码**（不是放宽）：`verdict` 已声明、但与 `{pass,skip}` **交集为空**
      //   （`outcomes.values.length === 0`）与「审计真没通过」是两种不同故障，原先同码 `GATE_COMPLETE_AUDIT_FAILED`
      //   ⇒「资产把 verdict 写成产物层词（如 approve/reject）」被静默读成「验收未过」，真因只藏在
      //   `completeOutcomes.narrowed` 里、不读本文件无法定位。空白名单时换专用码并回显 `declared` / `narrowed`
      //   / `values`，使「词表写错 vs 终态不达标」一眼可判。
      //   判定逐字不变（零放宽）：`ok:false` 不变；offenders / requiredOutcomes / narrowedOutcomes / rejectedBy /
      //   escapeRoute / completeOutcomes 逐字保留 ⇒ `fail` / `conflict` 恒拒不变；`values` 非空（缺声明回落
      //   引擎基线 `['pass','skip']`，或声明含 pass/skip）⇒ **走原分支**，载荷与码逐字不变。
      const emptyOutcomes = outcomes.values.length === 0;
      return {
        ok: false, code: emptyOutcomes ? 'GATE_COMPLETE_OUTCOMES_EMPTY' : 'GATE_COMPLETE_AUDIT_FAILED',
        ...(emptyOutcomes ? { declared: outcomes.declared, narrowed: outcomes.narrowed, values: outcomes.values } : {}),
        offenders: offenders.map((id: string) => ({ lane: id, state: laneState(id) })),
        requiredOutcomes: outcomes.values,
        narrowedOutcomes: outcomes.narrowed,
        rejectedBy: outcomes.rejectedBy,
        escapeRoute: outcomes.escapeRoute,
        completeOutcomes: outcomes,
      };
    }
    if (layers.exec.length && !allTerminal(layers.exec)) return { ok: false, code: 'GATE_COMPLETE_EXEC_PENDING', pending: layers.exec.filter((id: string) => !schema.isMemberTerminal(laneState(id))) };
    // A1 二级防线（防「建批后被改状态 / 注入 lane」的漂移）：纯读 wavePlan，不读文件正文
    // gate-lite Q-G1：冒烟/探针批判**不拒**（plan 悬空产物 = 无产物契约的必然后果，非漂移信号）——
    //   改由下方 `pass.smokeSkipped` 回显（零静默：跳了什么在载荷里写出来）。
    const orphans = orphanProductsOf(batch);
    if (!smoke && orphans.plan.length > 0) {
      return {
        ok: false, code: 'GATE_ORPHAN_PRODUCT', orphans: orphans.plan, orphanProducts: orphans,
        problems: ['plan 层产物无任何 lane consume（悬空产物）：' + orphans.plan.join(', ')],
        escapeRoute: { phase: 'aborted' as const, reason: '悬空产物使「plan 产物指导下游执行」不成立 ⇒ 修正 wavePlan 后重开新批，或经 batch_phase({phase:"aborted"}) 收口' },
      };
    }
    const pass: Record<string, unknown> = { ok: true, ...(smoke ? { smoke: true, smokeSkipped: 'complete-orphan-product' } : {}), ...(cmComplete ?? {}) };
    const degrades: Array<Record<string, unknown>> = [];
    // 不对称口径（有意）：exec / audit 层悬空 ⇒ 强告警 + 可见，不拒（exec 产物可能本就是终端交付物）
    if (orphans.exec.length > 0 || orphans.audit.length > 0) {
      pass.orphanProducts = orphans;
      degrades.push({ kind: 'orphan-product-nonblocking', layers: { exec: orphans.exec, audit: orphans.audit } });
    }
    // Q3-A②（本批）：exec 层存在**非 merged 终态**（`failed` / `skipped`）且该 lane **曾声明非空产物**
    //   ⇒ 该 lane 的产物义务从未落地。口径 = **非阻断降级留痕**（可辨认），**不得**变成拒码
    //   （`fail` / `skip` 是 Q-7 的合法终局 ⇒ 拒码会与「D-8 终态可退出」冲突）；`ok` 判定逐字不变。
    const execTerminalWithoutPresence = layers.exec.filter((id: string) => {
      const st = laneState(id);
      if (st !== 'failed' && st !== 'skipped') return false;
      const t = taskOf(batch, id);
      return t ? declaredArtifactsOf(t).length > 0 : false; // 曾声明非空产物（被检面 = produce ∪ outputs，与 exit 门同源）
    });
    if (execTerminalWithoutPresence.length > 0) {
      degrades.push({
        kind: 'exec-terminal-without-presence',
        lanes: execTerminalWithoutPresence,
        reason: 'exec lane 已终态（failed / skipped）且曾声明非空产物 ⇒ 产物义务未落地；非阻断降级留痕（不改变 complete 判定）',
      });
    }
    if (degrades.length > 0) pass.degrades = degrades;
    return pass;
  }
  // 未接线声明台账读端（S19② / S20）——**只读视图**：不参与任何门禁判定。
  //   【2026-09-27 · team-asset 全量退役】声明台账本体（团队资产侧常量）与 `flows` 层内声明读法
  //   随资产面**整体删除**：无声明面 ⇒ 无「未接线声明」条目可列。
  //   保留项 = **引擎级配置键 `config.ratchet`**：它是**引擎配置键**（注入端 `lib/index.js:108-112` ⇒
  //   `rules: loadRules(config)` ⇒ 读点 `lib/state/store.js:155`；**已接线**：A-① 落地），
  //   **不是团队声明键** ⇒ 台账结构上不承载；按 S20 以引擎级条目显式标注（条目口径见下方）。
  function unwiredEntriesOf(_batch: Batch): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    out.push({
      name: 'config.ratchet', at: 'config.ratchet', status: 'wired',
      readEnd: 'lib/index.js:108-112（装配点 createStore 注入 `rules: loadRules(config)`，**整份 config** ⇒ 内部取 config.ratchet）⇒ lib/state/store.js:155（`rules ?? loadRules()`）⇒ 消费点 :331 / :462 / :690',
      consumer: '装配点 lib/index.js:108-112（rules: loadRules(config)）／读点 lib/state/store.js:155（原注 :79 为过期行号）／消费点 lib/state/store.js:331（批次迁移）· :462（成员迁移）· :690（批次阶段迁移）',
      note: '引擎级配置键（**非团队声明键**）：**已接线**（A-① 落地——注入端 lib/index.js:108-112 ⇒ 读点 store.js:155）。缺省（无 config.ratchet 键）⇒ 返回默认表且与 schema 常量**同引用**（machine-rules.js:82-84，行为零差异）；非法棘轮配置在**装配期 throw**（fail-closed，不静默回落默认规则）。本条目保留「引擎级配置键可读性」既有能力（R-14 依赖其在列）',
    });
    return out;
  }
  // §8③ 团队资产解析快照的**读端**（批次 `a3-snapshot-b1-20260915`）。
  //   【2026-09-27 · team-asset 全量退役】快照写盘面与档读端**整体删除**（判据源 T-7：删资产指纹面）：
  //   无资产 ⇒ 无档可写、无可读 ⇒ 恒 `{teamAsset:null, declaration:null, declarationMissing:true}`，
  //   零 I/O、零副作用、**不回落现算**。**保形保留导出**：`lib/state/store.js` 与工具面按既有符号名消费
  //   （该文件不在本 lane 写域 ⇒ 删导出会造成 ESM 缺符号断链）。
  function teamAssetViewOf(_batch: Batch | null | undefined): { teamAsset: unknown; declaration: unknown; declarationMissing: boolean } {
    return { teamAsset: null, declaration: null, declarationMissing: true };
  }

  return { checkCompleteGate, teamAssetViewOf, unwiredEntriesOf };
}
