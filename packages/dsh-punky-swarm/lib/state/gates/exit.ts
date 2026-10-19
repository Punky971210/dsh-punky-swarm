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

// Exit 门（outputs/produce 前置）+ needHuman 门（review 态挂起）——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。

import { flowOf, produceFieldOf, enabledByFlag, flagOf } from '../../assembly/flows.js';
import { taskOf, smokeOf, contractMissingPayload, detectNeedHuman } from './detect.js';
import type { TaskArrayField } from './detect.js';
import type { Batch } from '../../types/contracts.js';

import type { GatesCx } from './cx.js';

export function buildExit(cx: GatesCx) {
  const { artifactsDirOf, checkPlanContract, declaredArtifactsOf, flowsOf, presenceOfArtifact, standaloneVerdict } = cx;

  // Exit Gate：(a) 收敛 —— 无 layer / 脱轨 lane 不再整 lane 免检；被检面 = produce ∪ outputs；空声明 ⇒ 拒
  function checkExitGate(sessionId: string, batchId: string, batch: Batch, lane: string) {
    const t = taskOf(batch, lane);
    // B2：lane 不在 wavePlan.tasks（状态损坏）⇒ 拒（不得退化为 generic 免检）
    if (!t) return { ok: false, code: 'GATE_LANE_NOT_IN_PLAN', lane, missing: [], problems: [lane + ' not in wavePlan.tasks'] };
    // B2：无 layer ⇒ 拒（Q-6① 废除 generic 豁免，已成因消失的兼容条款）
    if (!t.layer) return { ok: false, code: 'GATE_LANE_LAYER_MISSING', lane, missing: [], problems: [lane + ': no layer declared (generic exemption retired, Q-6①)'] };
    if (t.layer === 'plan') return checkPlanContract(sessionId, batchId, batch, lane);
    // gate-lite Q-G1：冒烟/探针批 ⇒ 跳过 **exit 产物契约**门（`produce`∪`outputs` 在场/形态/空内容）。
    //   位置：lane 存在性（`:659`）与无 layer 声明（`:662`）两门**之后**，故可核性/完整性判据仍生效。
    if (smokeOf(batch)) return { ok: true, lane, smoke: true, smokeSkipped: 'exit-produce' };
    const flow = flowOf(flowsOf(batch).flows, t.layer);
    // 单点断言：produceFieldOf（flows.js，保持 JS）返回 any → 断言为 TaskArrayField（运行期零变化，断言纯类型层）
    const declaredField = produceFieldOf(flow, t.layer) as TaskArrayField | null;
    const declared = declaredArtifactsOf(t);
    const degrades: Array<Record<string, unknown>> = [];
    // 零静默（原则②）：团队 `produce_field` 缩窄过被检面（字段错位）⇒ 补全为并集 + 降级留痕
    if (declaredField && declared.length > 0) {
      const narrowedField: string[] = Array.isArray(t[declaredField]) ? (t[declaredField] as string[]) : [];
      const otherField: TaskArrayField = declaredField === 'produce' ? 'outputs' : 'produce';
      const other: string[] = Array.isArray(t[otherField]) ? (t[otherField] as string[]) : [];
      if (narrowedField.length === 0 && other.length > 0) {
        degrades.push({ kind: 'produce-field-widened', declaredField, effective: ['produce', 'outputs'] });
      }
    }
    if (declared.length === 0) {
      // 唯一放行路径：standalone 显式声明（B4 四判据）
      const s = standaloneVerdict(batch, t);
      if (s.ok) return { ok: true, lane, standalone: true, escape: { kind: 'standalone', lane, reason: s.reason } };
      return {
        ok: false, code: 'GATE_EXIT_NO_DECLARATION', lane, missing: [], problems: [lane + ': no produce/outputs declared'],
        ...(degrades.length ? { degrades } : {}),
        ...(s.declared ? { standaloneProblem: s.code ?? 'GATE_STANDALONE_UNJUSTIFIED' } : {}),
      };
    }
    const failed: string[] = [];
    const codes: string[] = [];
    const problems: string[] = [];
    for (const p of declared) {
      const v = presenceOfArtifact(sessionId, batchId, t.layer, p);
      if (!v.ok) { failed.push(p); if (v.code) codes.push(v.code); for (const prob of v.problems) problems.push(prob); }
    }
    if (failed.length) {
      // 拒因优先级：根外 > 形态不符 > 空无原因 > 在场缺失（缺在场按层族回落 GATE_EXIT_MISSING_<LAYER>）
      const order = ['GATE_ARTIFACT_OUTSIDE_ROOT', 'GATE_ARTIFACT_NOT_A_FILE', 'GATE_ARTIFACT_EMPTY_NO_REASON', 'GATE_ARTIFACT_MISSING'];
      const picked = order.find((c) => codes.includes(c)) ?? 'GATE_ARTIFACT_MISSING';
      const code = picked === 'GATE_ARTIFACT_MISSING' ? 'GATE_EXIT_MISSING_' + t.layer.toUpperCase() : picked;
      return { ok: false, code, lane, missing: failed, problems, ...(degrades.length ? { degrades } : {}) };
    }
    return { ok: true, lane, ...(degrades.length ? { degrades } : {}) };
  }
  // needHuman Gate（复用 review 态挂起）：audit lane 产物声明 needHuman →
  // review→merged 前置人工裁决证据（note 契约 `human:<裁决人>:<时间>:<结论>`，如 human:user@2026-08-21:accept）
  // 缺证据 → GATE_NEEDHUMAN_PENDING；conflict 驳回不强制（评审驳回/人工否决语义）；
  // 未声明/非 audit lane → 零感知（{ ok: true, declared: false }）
  function checkNeedHumanGate(sessionId: string, batchId: string, batch: Batch, lane: string, note?: string | null) {
    const t = taskOf(batch, lane);
    if (!t || t.layer !== 'audit') return { ok: true, declared: false, path: null };
    // S14（本批）：扫描面改 **`produce ∪ outputs`（去重保序）**，与命令门同源先例——原仅扫 `produce`
    //   ⇒ `needHuman: true` 只写在 audit 的 `outputs` 所指产物时**零感知**（假完成通道）。
    const fields = [...new Set([
      ...(Array.isArray(t.produce) ? t.produce : []),
      ...(Array.isArray(t.outputs) ? t.outputs : []),
    ])];
    if (fields.length === 0) return { ok: true, declared: false, path: null };
    // 声明开关 flows.audit.needhuman——显式 false 则本团队不用人工闸；缺声明 ⇒ 引擎基线启用（enabledByFlag strictDefault=true，非回落旧口径）。
    // S13（本批）：**关闭能力保留**（放行判定不变），但命中时补 `escape{kind:'needhuman-off'}` 载荷留痕
    //   （零静默：关闭动作不再无痕；事件落盘在 store.js 写盘点 ⇒ e2）。
    const af = flowOf(flowsOf(batch).flows, 'audit');
    // B2（§8⑤ **P-3** needhuman）：本判定位**只对 `null` 侧**落首触载荷——`flagOf(...) === null` 即
    //   **未声明** ⇒ 引擎基线启用（缺声明不得放宽）；**显式 false** 是另一态（已有独立
    //   `escape{kind:'needhuman-off'}` 留痕，见下方分支）⇒ **不得**并入本事件（否则「关闭」与「未声明」混为一数）。
    const cmNeedhuman = flagOf(af, 'needhuman') === null
      ? contractMissingPayload(
        'needhuman', 'audit', 'engine:enabledByFlag(needhuman,true)', 'needhuman-engine-default-enabled',
        '团队资产未声明 flows.audit.needhuman ⇒ 引擎基线启用（缺声明不得放宽）；本事件为首触留痕，不改判定',
      )
      : null;
    if (!enabledByFlag(af, 'needhuman', true)) {
      return {
        ok: true, declared: false, path: null, disabledBy: 'team-asset:needhuman',
        escape: {
          kind: 'needhuman-off', lane,
          reason: '团队资产显式声明 flows.audit.needhuman=false ⇒ 人工闸停用（放行判定不变）＋留痕',
        },
      };
    }
    const det = detectNeedHuman(artifactsDirOf(sessionId, batchId), fields);
    if (!det.declared) return { ok: true, declared: false, path: null, ...(cmNeedhuman ?? {}) };
    const evidence = typeof note === 'string' ? (note.match(/^human:.+/m) ?? [null])[0] : null;
    if (evidence) return { ok: true, declared: true, path: det.path, evidence, ...(cmNeedhuman ?? {}) };
    return {
      ok: false, code: 'GATE_NEEDHUMAN_PENDING', declared: true, path: det.path,
      message: 'audit lane 声明 needHuman，须 Manager 转达人工裁决（merged 需 note 含 human: 证据 / conflict 驳回）',
    };
  }

  return { checkExitGate, checkNeedHumanGate };
}
