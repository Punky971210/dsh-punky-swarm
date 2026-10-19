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

// Plan 契约门（声明存在 → 形态/在场 → 内容判据）——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。

import { flowOf, contractOf, sectionProblemsOf, ENGINE_BASELINE_PLAN_SECTIONS } from '../../assembly/flows.js';
import { taskOf, smokeOf, contractMissingPayload, detectPendingMarker } from './detect.js';
import { sectionLineHit, elementLineHit } from './presence.js';
import type { PresenceNote } from './presence.js';
import type { Batch } from '../../types/contracts.js';
import fs from 'node:fs';

import type { GatesCx } from './cx.js';

export function buildPlanContract(cx: GatesCx) {
  const { artifactsDirOf, declaredArtifactsOf, flowsOf, presenceJudge, resolveArtifact } = cx;

  // Plan 契约门（(c) 收敛，拒绝免检）：声明必须存在 → 形态/在场 → 内容判据
  //   · 无产物声明 ⇒ 拒 `GATE_PLAN_NO_DECLARATION`（免检分支消失）；
  //   · 被检面 = produce ∪ outputs（T07：仅声明在 outputs 的产物同样受检）；
  //   · 空内容唯一通道 = 独立行 `empty-reason: <非空文本>`（有 ⇒ 放行 + `gate.escape` 留痕）；
  //   · 内容判据：≥1 份在场产物携带声明判据章节（缺声明 ⇒ 引擎基线）+ `.json` 必须可解析。
  function checkPlanContract(sessionId: string, batchId: string, batch: Batch, lane: string) {
    const t = taskOf(batch, lane);
    if (!t) return { ok: false, code: 'GATE_LANE_NOT_IN_PLAN', lane, problems: [lane + ' not in wavePlan.tasks'], missing: [] };
    if (t.layer !== 'plan') return { ok: true, lane };
    // gate-lite Q-G1：冒烟/探针批 ⇒ 跳过 plan 契约门（`produce`/`outputs` 在场 + 判据章节 + `.json` 解析）。
    if (smokeOf(batch)) return { ok: true, lane, smoke: true, smokeSkipped: 'plan-contract' };
    const declared = declaredArtifactsOf(t);
    if (declared.length === 0) {
      return { ok: false, code: 'GATE_PLAN_NO_DECLARATION', lane, problems: [lane + ': no produce/outputs declared'], missing: [] };
    }
    const contract = contractOf(flowOf(flowsOf(batch).flows, 'plan'));
    // B2（§8⑤ **P-2** contract）：plan 内容契约**未声明**（`contractOf === null` ⇒ 回落引擎基线章节集
    //   `ENGINE_BASELINE_PLAN_SECTIONS`）⇒ 产首触载荷。判定逐字不变（基线章节判据照旧执行为硬约束）。
    const cmContract = contract === null
      ? contractMissingPayload(
        'contract', 'plan', 'engine:ENGINE_BASELINE_PLAN_SECTIONS', 'plan-contract-engine-baseline',
        '团队资产未声明 flows.plan.contract ⇒ 引擎基线判据（' + ENGINE_BASELINE_PLAN_SECTIONS.join(' / ') + '）接管；本事件为首触留痕，不改判定',
      )
      : null;
    // 判据章节集（声明优先；缺声明 ⇒ 引擎基线命名常量 ENGINE_BASELINE_PLAN_SECTIONS，E-2 唯一真源）：
    //   lane 级最低判据 = ≥1 份在场产物携带其中任一章节（readonly：下游仅 some/join 只读消费）
    const requiredSections: readonly string[] = contract && Array.isArray(contract.required_sections) && contract.required_sections.length > 0
      ? (contract.required_sections as string[]) : ENGINE_BASELINE_PLAN_SECTIONS;
    // ── P3 元素/小节 判据面（R1 §2.4 #3）——**声明了才启用**（缺省 ⇒ 零感知，引擎基线行为逐字不变）──────
    // 元素：`contract.elements`（词表 `kind:'element'` 的 id 清单）⇒ 被检产物须含**行首锚定独立行**
    //   `element: <id>`（与 `reason:` / `gate:` / `targets-claimed:` 行族同构，判据 = `elementLineHit`）。
    //   不用 `content.includes(id)`：元素 id 通常极短（`goal` / `constraints`），子串匹配会把任意词命中 ⇒ 假绿。
    // 小节：`contract.subsections` 对象形 `{ "<标题>": <level> }` 归一取键、数组形等价 level 2 ⇒ 逐条走
    //   **既有** `sectionLineHit`（裸标题行，与 `required_sections` 同判据、同函数 ⇒ 判据同源，不造第二套）。
    // 被检面 = 本 lane 的 `produce ∪ outputs`（与 required_sections 同一 `declared` 循环），逐件核；缺 ⇒ 追加
    //   `problems`（沿用既有汇总通道，**复用** `GATE_PLAN_CONTRACT`，**不新增拒码**）。
    const declaredElements: string[] = contract && Array.isArray(contract.elements)
      ? (contract.elements as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const declaredSubsections: string[] = (() => {
      const s = contract ? (contract as { subsections?: unknown }).subsections : null;
      if (Array.isArray(s)) return (s as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (s !== null && typeof s === 'object') return Object.keys(s as Record<string, unknown>).filter((k) => k.trim().length > 0);
      return [];
    })();
    const problems: string[] = [];
    const notes: PresenceNote[] = [];
    let present = 0;
    let criteriaHit = false;
    for (const p of declared) {
      const abs = resolveArtifact(sessionId, batchId, p);
      const v = presenceJudge({
        mode: 'runtime', layer: 'plan', declared: [p], declaredKind: 'array',
        abs, artifactsRoot: artifactsDirOf(sessionId, batchId),
      });
      if (!v.ok) { for (const prob of v.problems) problems.push(prob); continue; }
      present += 1;
      for (const n of v.notes) notes.push(n);
      if (v.notes.length > 0) { criteriaHit = true; continue; } // 载原因 ⇒ 空内容通道：跳过内容判据且视作判据承载
      let content = '';
      try { content = fs.readFileSync(abs, 'utf8'); } catch { problems.push(p + ' unreadable'); continue; }
      if (requiredSections.some((s) => sectionLineHit(content, s))) criteriaHit = true;
      if (contract) {
        // 单点断言：sectionProblemsOf（flows.js，保持 JS）返回 any → 断言为 string[]（运行期零变化，断言纯类型层）
        for (const prob of sectionProblemsOf(p, content, contract) as string[]) problems.push(prob);
        // P3（R1 §2.4 #3）：元素/小节逐条核（声明为空数组 ⇒ 本循环零迭代 ⇒ 零感知）
        for (const el of declaredElements) {
          if (!elementLineHit(content, el)) problems.push(p + ' lacks element "' + el + '"');
        }
        for (const ss of declaredSubsections) {
          if (!sectionLineHit(content, ss)) problems.push(p + ' lacks subsection "' + ss + '"');
        }
      } else if (p.endsWith('spec.md')) {
        // 引擎基线 spec.md 判据（E-2 正名，legacy-retire-20260915）：无 contract 声明时，对以 spec.md 结尾的
        //   产物做基线标题（`ENGINE_BASELINE_PLAN_SECTIONS`）的逐字 includes 校验——**行为与清退前逐字一致**，
        //   仅语义正名（原注释误称「legacySuffixMatch 旧口径」；实为引擎基线缺声明承接分支，S10 裸标题
        //   最低判据 sectionLineHit 在 :580 独立生效，编号变体仍拒）。
        //   **配置化**（2026-09-21）：章节名一律从 `ENGINE_BASELINE_PLAN_SECTIONS` 取（单一真源，全中文），
        //   本分支**不再写字面量**；团队要用非默认章节名 ⇒ 声明 `flows.plan.contract.required_sections`。
        for (const s of ENGINE_BASELINE_PLAN_SECTIONS) {
          if (!content.includes(s)) problems.push(p + ' lacks "' + s + '"');
        }
      }
      if (p.endsWith('.json')) {
        try { JSON.parse(content); } catch { problems.push(p + ' invalid JSON'); }
      }
    }
    // 最低内容判据（S10）：在场产物至少一份携带判据章节（全部缺失在场性时由在场性问题单独定罪，不叠加噪音）
    if (present > 0 && !criteriaHit) problems.push(lane + ': no plan artifact carries a criteria section (' + requiredSections.join(' / ') + ')');
    // ── 【2026-09-27 用户裁决 · 运行时回调指引】拒的同时给出「怎么做」──────────────────────────────
    //   设计意图（用户原话）：「**通过工具调用回调说明和门禁码锁住 worker 行为并给出对应指引**」
    //   —— 用**机制**锁行为，不用**文档**教行为：文档会漂移、worker 未必读；回调**每次必达**。
    //   实证（批 onto-engine-slim-20260926）：plan 产物缺 `## 约束` ⇒ `GATE_PLAN_CONTRACT`
    //   ⇒ `auto.settle.paused` **停轮** ⇒ 由 Leader **批外补正**才恢复。若此处直接告诉 worker
    //   「该写哪六个标题」，它**当场就能自救**，不必停轮。
    //   ⚠ **只追加文案**：`code` / `problems` 的**判定集合**逐字不变（新增项仅为指引，不作判据输入）。
    if (problems.length) {
      problems.push(
        '【怎么做】plan 产物正文须含六个【裸标题】（行首恰为该串，非 `###`、无缩进/前缀）：'
        + '`## 概述` / `## 问题` / `## 方案` / `## 需求` / `## 验收标准` / `## 约束`'
        + ' —— **内容允许为空，标题一个都不能缺**（本门只校标题在场，不校内容）。'
        + ' 改完产物后重跑即可；若是交接后才补，重新 `handoff_submit` 该边。',
      );
      return { ok: false, code: 'GATE_PLAN_CONTRACT', lane, problems, missing: [] };
    }
    // ── P4 待确认（R1 §2.4 #4；U-1 锁定面 = **仅 plan 层**）──────────────────────────────────────────
    // 声明位：`flows.plan.contract.pending_marker:{literal:"<非空字符串>"}`（R1 冻结唯一合法字面量 = `[待确认]`）。
    //   **未声明 ⇒ 立即零感知返回**（`markerLiteral === null` 短路在 `t.layer` 判定**之前** ⇒ 不读产物、不加 IO）。
    // 判定：产物正文**逐字**含该字面量（`detectPendingMarker` 纯函数）且 `t.layer === 'plan'` ⇒ 拒。
    //   **复用既有码** `GATE_NEEDHUMAN_PENDING`（**不造新码**）：语义与 audit 侧人工闸同属「挂起等人工裁决」，
    //   载荷补 `pendingMarker:{path, index}` 供定位（两套字面量各有归属，审计可辨）。
    // U-1（用户裁决 C）：判定面**仅 plan**——audit 层**不**走本判定，其人工闸仍是既有 `checkNeedHumanGate`
    //   的独立行 `needHuman: true`（本批一字不动）；故本处显式 `t.layer === 'plan'` 守卫（非依赖调用链隐含）。
    // 拒因优先级：**契约缺陷先行**（上方 `problems` 拒态已 return）⇒ 契约修好后再做人工裁决，拒因不互相掩盖。
    const markerLiteral = (() => {
      const pm = contract ? (contract as { pending_marker?: unknown }).pending_marker : null;
      if (pm === null || typeof pm !== 'object') return null;
      const lit = (pm as { literal?: unknown }).literal;
      return typeof lit === 'string' && lit.length > 0 ? lit : null;
    })();
    if (markerLiteral !== null && t.layer === 'plan') {
      for (const p of declared) {
        const abs = resolveArtifact(sessionId, batchId, p);
        let content = '';
        try {
          const st = fs.statSync(abs);
          if (st.isDirectory() || st.size === 0) continue;
          content = fs.readFileSync(abs, 'utf8');
        } catch { continue; }
        const pm = detectPendingMarker(content, markerLiteral);
        if (pm.declared) {
          return {
            ok: false, code: 'GATE_NEEDHUMAN_PENDING', lane, missing: [],
            problems: [p + ' contains pending marker ' + JSON.stringify(markerLiteral)],
            pendingMarker: { path: p, index: pm.index },
            message: 'plan lane 产物含人工待确认字面量 ' + JSON.stringify(markerLiteral)
              + '（团队资产 `flows.plan.contract.pending_marker` 声明位生效）⇒ 须人工裁决后再 merged'
              + '（复用既有 GATE_NEEDHUMAN_PENDING，不造新码）',
          };
        }
      }
    }
    const pass: Record<string, unknown> = { ok: true, lane, ...(cmContract ?? {}) };
    if (notes.length) {
      pass.escapes = notes.map((n) => ({ kind: 'empty-artifact-noted', artifact: n.artifact, reason: n.reason }));
      pass.escape = (pass.escapes as unknown[])[0];
      pass.emptyNoted = notes;
    }
    return pass;
  }

  return { checkPlanContract };
}
