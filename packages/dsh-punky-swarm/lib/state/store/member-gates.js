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

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as schema from '../../schema.js';
import * as machine from '../machine.js';
import * as EVT from '../event-types.js';
// 人工裁决证据解析单点（WD-1）：禁在本文件内复制证据正则
import { humanEvidenceOf } from '../constants.js';
// lane → task 定位单点（与 `gates/detect.ts` 同一函数，禁第二套遍历）
import { findTask } from '../task-utils.js';
// 「被检面 = produce ∪ outputs 去重保序」单点（`wave-plan.ts` 的 `declaredArtifactsOf`）；
//   同目录 `store/plan-mutate.js:24` 已 import 本模块 ⇒ 无环先例在册。
import { declaredArtifactsOf } from '../../wave-plan.js';
// 产物声明路径解析**唯一入口**（与 `gates/detect.ts` 同源，禁第二套路径合法性逻辑）
import { resolveArtifactIn } from '../batch-paths.js';

// ── L4 规则变更传播：**可选模块**（本批 e2-l4-propagate 新建；接线点归本 lane = e4-l9-memorysrc）──
//   纪律（C-7）：本 lane **只负责在正确位置调用**，**不复制**其判定逻辑；调用签名**逐字冻结**：
//     evaluateRulePropagation({ batch, rules }) =>
//       { affected: string[], changed: boolean, version: string|null, detail: string[] }
//   为什么是**惰性同步解析 + try/catch**（而非顶部静态 import）：
//     ① `setPhase` **必须保持同步** —— 既有调用方（`lib/tools/core.js:104` / `:170`、`lib/engine/auto-settle.js:233`）
//        都在**同一 tick 内**读它的返回值 `.phase`；改成 async 会把「同步迁移判定」变成微任务 ⇒ 破坏既有语义
//        （AC-22 的「既有相位语义不变」）。
//     ② 该模块由**同批并行 lane** 产出（`lib/state/rule-propagation.ts` → 编译回拷 `lib/state/rule-propagation.js`）
//        ⇒ 本 lane 落盘时它**可能尚不存在**；顶部静态 import 会让「缺席」变成**加载期炸**
//        （`ERR_MODULE_NOT_FOUND`），把并行 lane 的时序问题转成本 lane 的故障。
//     ③ 惰性解析**只做一次并缓存**（`rulePropagationLoadError` 亦缓存）⇒ 不是每个相位一次文件 I/O。
//     ④ **不臆造**：模块缺席时**不静默假装成功** —— 调用返回 `null`，由调用方如实回显（见 `evaluatePropagationOf`）。
const RULE_PROPAGATION_MODULE = '../rule-propagation.js';
// L9 待抑制清单文件名（落**批次产物根**；单点定义，禁散落字面量）
const MEMORY_STALE_MANIFEST_FILE = 'memory-stale-recommended.json';
const requireOfPackage = createRequire(import.meta.url); // 单点：按包解析（与 engine/dispatch.js 的 require 口径同源）
let rulePropagationModule = null;
let rulePropagationLoadError = null;

/** 惰性取 L4 判定器；缺席/异常 ⇒ `{ fn: null, error: <原因> }`（**不抛**，fail-safe）。 */
export function rulePropagationEvaluatorOf() {
  if (rulePropagationModule === null && rulePropagationLoadError === null) {
    try {
      rulePropagationModule = requireOfPackage(RULE_PROPAGATION_MODULE);
    } catch (err) {
      rulePropagationLoadError = String((err && err.message) || err);
    }
  }
  const fn = rulePropagationModule && typeof rulePropagationModule.evaluateRulePropagation === 'function'
    ? rulePropagationModule.evaluateRulePropagation
    : null;
  return { fn, error: rulePropagationLoadError };
}

/** 调用 L4 判定器（**唯一调用点**）；返回冻结签名四字段，或 `null`（模块缺席/调用抛错，均不静默）。 */
export function evaluatePropagationOf(batch, rules) {
  const { fn, error } = rulePropagationEvaluatorOf();
  if (!fn) {
    return error
      ? { affected: [], changed: false, version: null, detail: ['rule-propagation unavailable: ' + error] }
      : { affected: [], changed: false, version: null, detail: ['rule-propagation module absent (e2-l4-propagate 未产出/未回拷)'] };
  }
  try {
    return fn({ batch, rules });
  } catch (err) {
    return { affected: [], changed: false, version: null, detail: ['rule-propagation threw: ' + String((err && err.message) || err)] };
  }
}

// L9 · 终态枚举（**纯函数**，可单测、零 I/O）
//   口径（冻结）：只列**终态收口**的受影响 lane —— 终态判定**单点复用** `lib/schema.js` 的
//   `isMemberTerminal` / `isBatchTerminal`（**禁自建终态表**，避免第二套判据漂移）。
//   `action` 只作**建议**（`archive`/`forget` 均可逆）；`source` 是与 mneme 对齐的**约定式**写入规范。
export function isTerminalPhase(phase) {
  return schema.isBatchTerminal(phase) === true;
}

/** L9：清单落点 = **批次产物根**（`<sessionsDir>/<sessionId>/artifacts/<batchId>/`），**不落工作区根**。 */
export function memoryStaleManifestPathOf(sessionId, batchId, artifactsDirOfFn) {
  const dir = typeof artifactsDirOfFn === 'function'
    ? artifactsDirOfFn(sessionId, batchId)
    : path.join(String(sessionId), 'artifacts', String(batchId));
  return path.join(dir, MEMORY_STALE_MANIFEST_FILE);
}

export function memoryStaleItemsOf(batch) {
  const lanes = (batch && typeof batch.lanes === 'object' && batch.lanes !== null && !Array.isArray(batch.lanes))
    ? batch.lanes : {};
  const items = [];
  for (const [lane, state] of Object.entries(lanes)) {
    // 只列**终态** lane：非终态 lane 的记忆在本批收口后仍可能被后续批次作废 ⇒ 不属本次建议面。
    //   （细粒度「哪条记忆派生自本批」在本仓**无映射结构** ⇒ 不可判；此处按 lane 枚举**可判**的补集。）
    if (!schema.isMemberTerminal(state)) continue;
    items.push({
      batchId: batch.batchId ?? null,
      lane,
      state,
      source: 'batch:' + String(batch.batchId ?? '') + '/lane:' + lane,
      action: 'archive', // 建议：默认 archive（可逆）；forget 亦为可选项，执行权归 Leader/Manager
      reversible: true,
    });
  }
  items.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)); // 稳定序（清单可比对/可 diff）
  return items;
}

// ── P0-2 回报三字段 · **检测器**（纯函数 / 零抛错 / 零副作用；读法沿用 `detectNeedHuman`）──────────────
// 规格：`plan/guidance-preflight-spec.md` §B.2/§B.3 + REQ-8（批 `punky-guidance-preflight-20261025`）。
// 三字段排他单点：字段名/顺序在此定义一次，调用点与测试一律引用本常量（禁散落字面量）。
export const PREFLIGHT_REPORT_FIELDS = Object.freeze(['knowledge_hits', 'skills_used', 'mcp_used']);

// 行首锚定（**禁前导空白**，与 `needHuman:` / `gate:` 同族）：内嵌/注释/非行首不误判。
//   仅 `[ \t]`，**不得用 `\s`**（`\s` 含 `\n`，在 `m` 下会把下一行吞成本行空白）。
const PREFLIGHT_LINE_RES = Object.freeze({
  knowledge_hits: /^knowledge_hits:[ \t]*(.*)$/m,
  skills_used: /^skills_used:[ \t]*(.*)$/m,
  mcp_used: /^mcp_used:[ \t]*(.*)$/m,
});

/**
 * 取一个字段的**值原文**（首行值 + 缩进续行双读）。
 * @returns {string|null} `null` = 无匹配行（`missing`）；`''` = 行在但值为空（`empty`）
 */
function preflightValueOf(content, lineRe) {
  const m = lineRe.exec(content);
  if (!m) return null;
  const first = String(m[1] ?? '').trim();
  if (first) return first;
  // 首行值为空 ⇒ 再读紧随的**缩进续行**（真实回报常把列表写下一行）：
  //   续行判据 = 以「两个及以上空格 / \t / `- `」起首，且不匹配 `^[a-z][a-z0-9_]*:`；
  //   遇空行或顶层行（非缩进、非 `- `）即止。
  const lines = content.slice(m.index + m[0].length).split('\n');
  const parts = [];
  for (let i = 1; i < lines.length; i += 1) { // i=0 = 命中行残余（`$` 锚定 ⇒ 恒空）
    const raw = lines[i];
    if (raw.trim() === '') break;                                   // 空行 = 段结束
    if (/^[a-z][a-z0-9_]*:/.test(raw)) break;                       // 下一个顶层声明行（同族行）
    if (!/^(?: {2,}|\t|- )/.test(raw)) break;                       // 非缩进 / 非 `- ` ⇒ 顶层正文，停
    parts.push(raw.trim().replace(/^-\s*/, ''));
  }
  return parts.join(' ').trim();
}

/** 四态判定（**单点**）：`missing` / `empty` / `none-no-reason` / `ok`（仅 `ok` 计入通过）。 */
function preflightStateOf(value) {
  if (value === null) return 'missing';
  if (value === '') return 'empty';
  // `none` 后无理由 = 未作答；`none: <非空理由>` 才是「显式决定不做」⇒ ok（规格 §B.3 与库内正向做法一致）
  if (/^none\s*$/.test(value) || /^none:[ \t]*$/.test(value)) return 'none-no-reason';
  return 'ok';
}

/**
 * P0-2 检测器：扫描 `paths`（调用方传 **produce ∪ outputs 去重保序**）核三字段。
 * @param {string} artifactsDir 批次产物根（`artifactsDirOf(sessionId, batchId)`）
 * @param {string[]} paths 相对产物根的声明路径（保序）
 * @returns {{ok:boolean, reason:'fields-missing'|'no-declared-artifacts'|null,
 *   fields:Record<string,string>, missing:string[], artifacts:string[]}}
 *   · `reason === null` ⇒ 三字段全 `ok`（**零事件、零 warn**）；
 *   · `reason === 'no-declared-artifacts'` ⇒ 无声明产物，**不判 `missing`**（`missing` 为空数组）；
 *     `ok` 仍为 `true`（规格 §B.2「不判定」）—— 事件**不**由 `ok` 触发，而由 `reason !== null` 触发。
 *   · `reason === 'fields-missing'` ⇒ 至少一字段非 `ok`，`missing` 按字段序点名。
 * 读法逐条沿用 `detectNeedHuman`：`resolveArtifactIn` 解析 + `statSync` 跳**目录**与**0 字节** + 读失败即跳过（不抛）。
 */
export function detectPreflightReport(artifactsDir, paths) {
  const fields = {};
  for (const f of PREFLIGHT_REPORT_FIELDS) fields[f] = 'missing';
  const declared = Array.isArray(paths) ? paths : [];
  const artifacts = [];
  const contents = [];
  for (const p of declared) {
    if (typeof p !== 'string' || p.length === 0) continue;
    let abs;
    try { abs = resolveArtifactIn(artifactsDir, p); } catch { continue; } // 声明面非法 ⇒ 跳过（fail-safe）
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue; // 目录 / 0 字节：不可能自带回报行
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    artifacts.push(p);
    contents.push(content);
  }
  if (declared.length === 0) {
    // 无声明产物（纯 `targets` lane：改代码不改产物）⇒ 判它缺字段是**误伤** ⇒ 不判 missing。
    return { ok: true, reason: 'no-declared-artifacts', fields, missing: [], artifacts };
  }
  const missing = [];
  for (const f of PREFLIGHT_REPORT_FIELDS) {
    let value = null;
    for (const content of contents) {
      value = preflightValueOf(content, PREFLIGHT_LINE_RES[f]);
      if (value !== null) break; // 声明序首件命中即取（produce 优先于 outputs，各自保序）
    }
    const state = preflightStateOf(value);
    fields[f] = state;
    if (state !== 'ok') missing.push(f);
  }
  return {
    ok: missing.length === 0,
    reason: missing.length === 0 ? null : 'fields-missing',
    fields, missing, artifacts,
  };
}

export function buildMemberGates(cx) {
  const { gates, readBatch, newEvent, emitStateChange, makeContractMissingSink, archive, ratchet, commitBatch, artifactsDirOf, log } = cx;

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
      const evidence = humanEvidenceOf(note);
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
  // ── P0-2 回报三字段（**全软**）：接在既有门链**末尾**（exit → targets → command → needHuman → 出口交接）──
  // 位置纪律（与上方 P2-A 出口交接门同款先例）：只**追加**一段软检查 ⇒ 既有六类硬门的顺序与语义**一字不动**。
  // 为什么在本文件而非工具层（`member_settle`）：生产主路是 **auto-settle**（`lib/engine/auto-settle.js` 直调
  //   `store.setMember`，不经工具）⇒ 挂工具层会「测试全绿、生产永不触发」＝死码；本处是两路**共用**写路径。
  // D1/D2 全软：**绝不拒 merged** —— 非 `ok` 只落 1 条 `EVT_PREFLIGHT_REPORT_MISSING` + 1 条 `warn`；
  //   不抛错、不改成员态、不改迁移表、不新增/不改任何 `GATE_*` 码与拒态分支。
  // 事件触发条件 = `reason !== null`（三字段全 ok ⇒ `null` ⇒ 零事件零 warn，避免「做过的事还被打一次」的噪音）。
  const preflightTask = findTask(batch, lane);
  const preflight = detectPreflightReport(
    artifactsDirOf(sessionId, batchId),
    declaredArtifactsOf(preflightTask), // 被检面单点 = produce ∪ outputs（去重保序）
  );
  if (preflight.reason !== null) {
    batch.events.push(newEvent(EVT.EVT_PREFLIGHT_REPORT_MISSING, {
      lane,
      reason: preflight.reason,
      missing: preflight.missing,
      states: preflight.fields,
      artifacts: preflight.artifacts,
      soft: true,
    }));
    try {
      // warn 只留痕、不参与判定；logger 缺席（console 兜底）与 warn 自身抛错都不得拖累结算（R-2 fail-safe）
      const warnOf = (log && typeof log.warn === 'function') ? log.warn.bind(log) : console.warn;
      warnOf('[dsh-punky-swarm] lane ' + lane + ' merged 放行，但回报三字段不全：'
        + (preflight.missing.length
          ? preflight.missing.map((f) => f + ':' + preflight.fields[f]).join(' ')
          : '（无声明产物，无可核产物 ' + preflight.reason + '）')
        + '（软检查，不阻断；audit 验收会核）');
    } catch { /* warn 失败不拖累结算 */ }
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
    // ── L4 规则变更传播（接线点归本 lane；判定逻辑在 e2 的 `lib/state/rule-propagation.js`）──
    //   位置：相位**已变更、尚未提交**时求值 —— 此处 `batch` 已是「本相位之后」的视图
    //   （`batch.phase = to` 已赋值）⇒ `affected`（**仅含非终态 lane**）表达的是
    //   「在本批收口之后，仍可能被规则变更影响的在途 lane」，与冻结口径一致。
    //   签名逐字 = `evaluateRulePropagation({ batch, rules })`；
    //   `rules` 取既有装配入参 `ratchet`（与本函数上方 `applyBatchTransition` 用的**同一 rules 真源**，
    //   禁第二套取值口径）。返回值**只作留痕与回显**，**不参与**任何迁移判定（既有相位语义零改动）。
    const propagation = evaluatePropagationOf(batch, ratchet);
    // ── L9 记忆溯源（收口点 = 本终端分支；`complete` 与 `aborted` **同落此处**）──────────────
    //   产出两件**互不替代**的东西：① 留痕事件 `memory.stale.recommended`（进事件流 ⇒ 跨会话可核）；
    //   ② 待抑制清单落**批次产物根**（`memory-stale-recommended.json`）。
    //   ⚠ 二者都**只是建议**：引擎 `lib/**` **调不到 mneme**（宿主工具面）⇒ 写成直调即不可达强耦合；
    //     实际 archive/forget 的**执行权归 Leader / Manager**（两者均可逆、不删）。
    //   相位边界（冻结）：`to` ∈ {complete, aborted} 才产出；`running` / `paused` / `planning` **不产出**。
    //   `planning` 是 `BATCH_TRANSITIONS` 里的起点、也**不是**终态 ⇒ 一并排除（`isTerminalPhase` 单点判定）。
    let memoryStale = null;
    if (isTerminalPhase(to)) {
      const items = memoryStaleItemsOf(batch);
      const manifestPath = memoryStaleManifestPathOf(sessionId, batchId, artifactsDirOf);
      memoryStale = {
        trigger: to, // 'complete' | 'aborted'
        items,
        manifestPath,
        written: false,
        writeError: null,
        propagation,
      };
      // 多写者安全性：本进程内多个批次可能**并发**终态收口 ⇒ 每批次写**各自**的批次产物根路径
      //   （`artifactsDirOf(sessionId,batchId)` 按会话+批次隔离，天然不撞）；`mkdirSync({recursive:true})`
      //   幂等；`writeFileSync` 后写覆盖**同一批次的同一清单**（重入/重试 ⇒ 同内容重写，不追加、不累积）。
      try {
        if (typeof artifactsDirOf === 'function') {
          fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
          fs.writeFileSync(manifestPath, JSON.stringify({
            schema: 'punky-memory-stale-recommended@1',
            batchId,
            phase: to,
            generatedAt: new Date().toISOString(),
            manifestPath,
            // 执行权与可逆性**写进产物本体**（不只写在注释里），使清单自带「谁来执行、可否回退」
            executor: 'leader-or-manager',
            reversible: true,
            actionNote: 'action 仅为建议；实际 memory_archive / memory_forget 由 Leader/Manager 执行，两者均可逆（不删）',
            items,
            propagation,
          }, null, 2) + '\n', 'utf8');
          memoryStale.written = true;
        } else {
          memoryStale.writeError = 'artifactsDirOf-unavailable';
        }
      } catch (err) {
        // 清单落盘失败**不得**回滚相位迁移（相位是治理真源；清单是建议产物）——
        //   失败事实由下方事件的 `manifestWritten:false` + `manifestError` 如实承载（不静默）。
        memoryStale.writeError = String((err && err.message) || err);
      }
      try {
        batch.events.push(newEvent(EVT.EVT_MEMORY_STALE_RECOMMENDED, {
          phase: to,
          count: items.length,
          lanes: items.map((it) => it.lane),
          manifest: manifestPath,
          manifestWritten: memoryStale.written,
          ...(memoryStale.writeError ? { manifestError: memoryStale.writeError } : {}),
          executor: 'leader-or-manager',
          reversible: true,
          ...(propagation ? { propagationAffected: propagation.affected, propagationVersion: propagation.version } : {}),
        }));
      } catch { /* 事件构造失败不拖累相位迁移（相位已定；清单已尽力落盘） */ }
    }
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
