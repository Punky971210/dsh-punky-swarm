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

// Gates：Tier3 层间门禁——entry（consume 前置）/ exit（outputs/produce 前置 + Plan 契约 checkPlanContract）/ complete（audit 验收前置）
// ⚠ 本文件（`gates.ts`）是**唯一手写源**；同目录 `gates.js` / `gates.d.ts` 由 `tsc -p tsconfig.build.json`
//   + `scripts/copy-ts-built.mjs` 生成 ⇒ **只改 gates.ts**（手改 `.js` / `.d.ts` 会被下一次构建静默回退）。
// 纯函数闭包工厂：createGates(root) 注入 root；门禁函数签名 (sessionId, batchId, batch, lane)——batch 对象显式传入，不持有状态
// 类型化说明：wavePlan 任务属性访问经 taskOf 单点断言（findTask 保持 JS，返回 object|null → WavePlanTask，
//   断言依据：findTask 语义即"按 id 定位 buildWavePlan 持久形态任务"）；Batch/批事件判别联合收窄（零断言消解 TS2339）；
//   gate 函数返回类型沿用结构推断（消费方 store.js 等为 JS，无类型约束）——运行期语义零变更（断言纯类型层）。
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../schema.js';
import { runCommand } from './command-exec.js';
// 单点收敛：SESSION_RE/isAbsPath 定义迁至 constants.js；isAbsPath 保持导出
// （既有消费方 import { isAbsPath } from './gates.js' 不受影响）。
import { SESSION_RE, isAbsPath } from './constants.js';
// findTask 单点：收敛至 task-utils.js（原本地定义删除，调用点不变）
import { findTask } from './task-utils.js';
// 声明驱动：层语义（产物字段 / 入口要求 / 内容契约）改从团队声明读取——缺声明走**引擎基线**常量/缺省
//   （tighten-only；legacy-retire-20260915 清退后无 LEGACY_* 回落层）
// gate-techdebt 新增读端（G-2 / G-3 / S19①）：`entryRequiresOf`（入口要求的**真实来源**）/
//   `consumeFieldOf`（consume 字段名读端）/ `declarationSummaryOf`（声明面可读汇总，含**未接线台账**）——
//   三者均**只读复用** flows.js，不改该文件；`requiredBy` 标注取 `entryRequiresOf(flow).source`（G-3 修正）。
import { flowsForBatch, flowOf, produceFieldOf, produceFieldsOf, entryRequiresOf, consumeFieldOf, contractOf, sectionProblemsOf, enabledByFlag, flagOf, globMatchesPath, ENGINE_BASELINE_PLAN_SECTIONS, ENGINE_BASELINE_CRITERIA_SECTION } from '../assembly/flows.js';
// 【2026-09-27 · team-asset 全量退役】原资产读端 import（装载器 + 未接线声明台账常量）**整体删除**：
//   flows / roles 面只走**引擎基线** ⇒ 本文件不再读任何团队资产（A-5 判据：import 面归零）。
// R1「契约三小件」·词表读端（exec-1 lane 交付 `lib/state/vocabulary.json` / `vocabulary.js`）。
//   本文件**只读**词表，不写、不改词表真源；判定**单点**复用 `reasonTokenKnown`（其内部 `knownOf` 是
//   gate/reason 两 kind 的唯一实现）⇒ entry 门（E1）与命令门（C3）共用同一 tokenOf，禁两套口径。
//   依赖方向：gates.ts → vocabulary.js（单向；vocabulary.js **不** import gates.ts —— 防环，其文件头明示）。
import { VOCABULARY_REL, loadVocabulary, reasonTokenKnown } from './vocabulary.js';
// 读端收敛：e.type 比较改引 EVT 常量单点（member.settled 读端）
import * as EVT from './event-types.js';
// P1/P2 交接门开关：**唯一解析点**在 `lib/wave-plan.ts#handoffGateEnabledOf`（读 runtime.json `gates.handoff.*`，
//   env 仅兜底）；本文件只**调用**它，不自行读 env/config 判据（禁两套读取）。
import { handoffGateEnabledOf } from '../wave-plan.js';
// 热配置**模块级生效快照**（未注入 readConfig 时的读端；与 `lib/hot/config-watch.js` 的 watcher 同一次写入）
import { readRuntimeSnapshot } from '../hot/config-watch.js';
import type { Batch, Layer, WavePlanTask } from '../types/contracts.js';
export { isAbsPath };

// 局部类型化包装：findTask（task-utils.js，保持 JS）返回 object|null → 属性访问全报"属性不存在"。
// taskOf 为唯一断言点：findTask 遍历 batch.wavePlan[].tasks 按 t.id === lane 返回 buildWavePlan 持久形态任务
// → WavePlanTask 类型成立（运行期零变化，断言纯类型层）。
function taskOf(batch: Batch | null, lane: string): WavePlanTask | null {
  return findTask(batch, lane) as WavePlanTask | null;
}

// ── 冒烟/探针批判定**单点**（显式豁免键） ──────────────────
// 语义：批在 `wave_plan({ smoke: true })` 建批时落一条 `batch.smoke` 事件（`event-types.js` 登记常量）
//   ⇒ 本批为冒烟/探针批 ⇒ **跳过产物契约类门**（entry `consume` / exit `produce`∪`outputs` /
//   `targets` / complete 的 plan 悬空产物判定；建批期的 `GATE_PLAN_PRESENCE_MISSING` /
//   `GATE_ORPHAN_PRODUCT` 由 `lib/wave-plan.ts#validateLayerContract` 同键跳过）。
// **行为安全门一字不减**：派发准入（lane 存在性 `GATE_LANE_NOT_IN_PLAN`；Manager 在册判定已改由官方
//   roster 承抽，见 `lib/tools/core.js#managerRosterOf`）、lane 单写者锁（`lib/lock.js`，非本文件）、终态冻结
//   （`GATE_BATCH_TERMINAL`，`lib/state/store.js`）、`needHuman`、命令门、验收判据门。
// 判据来源 = **批次事件流**（与 `laneStartedAt` / `gateStrengthOf` 同法扫事件，零新增字段）：
//   批次 JSON 由 `store.createBatch` 写出，`smoke` 无对应持久字段（store 不在本批写域）⇒ 事件流即
//   唯一事实源；只读、零副作用（本函数绝不写事件——R-5「只读视图零事件」硬边界照旧）。
export function smokeOf(batch: Batch | null | undefined): boolean {
  const evs = ((batch as unknown as { events?: unknown[] } | null | undefined)?.events ?? []) as Array<{ type?: unknown }>;
  return evs.some((e) => e && e.type === EVT.EVT_BATCH_SMOKE);
}

// 任务数组字段（gates 只读 consume/produce/outputs 三类，t[field] 索引合法化）
type TaskArrayField = 'consume' | 'produce' | 'outputs';

// ── B2（蓝图 §8⑤ 运行期**首触校验**）：契约缺声明的**载荷**（纯构造，零副作用） ──────────────────────
// 语义：团队资产**未声明**某检查项（`cause:'undeclared'`）⇒ 引擎缺省接管 ⇒ 产本载荷。
// 纪律（规格 §1.1 / §1.4）：
//   · **只产载荷、零落盘**：门禁函数绝不 push 事件（本函数无副作用、无 I/O）；落盘唯一在
//     `lib/state/store.js` 写路径（`setMember` / `setPhase`）——这是 R-5「只读视图零事件」的**结构性**保证
//     （`gateStatus` 内部会调 `checkPlanContract`，靠调用点自觉必然漏）；
//   · **非拒态**：不改任何判定、不改任何 exit code、不新增 `GateErrorCode`（本载荷是**观察面**，不是码）；
//   · 去重键 `(batchId, gateKind, layer)` 由写端按 `batch.events` 判定（本函数不参与去重，保持纯函数）。
export type ContractMissingPayload = {
  contractMissing: {
    cause: 'undeclared';
    gateKind: string;
    layer: string;
    declared: false;
    source: string;
    degrade: { kind: string; note: string };
    problems: string[];
  };
};
/** 六判定位共用的载荷构造（gateKind 见 6 个调用点；source/degrade 逐点给出**引擎缺省来源**，可审计）。 */
function contractMissingPayload(
  gateKind: string, layer: string, source: string, degradeKind: string, degradeNote: string,
): ContractMissingPayload {
  return {
    contractMissing: {
      cause: 'undeclared', gateKind, layer, declared: false, source,
      degrade: { kind: degradeKind, note: degradeNote }, problems: [],
    },
  };
}

// targets 门禁（O2）marker 逃生声明标记：目标文件含独立行 `targets-claimed: true` 即视为已变更（跳过 mtime 比对）。
// 行首锚定独立行正则（仿 needHuman 独立行模式）——内嵌/注释/非行首不误判（NFR3）。
export const TARGETS_CLAIMED_RE = /^targets-claimed:\s*true$/m;

// needHuman：audit 产物人工裁决声明检测（纯函数，与 checkExitGate 同源文件解析）——
// 产物含独立行 `needHuman: true`（正则 /^needHuman:\s*true$/m）即声明人工裁决需求；
// 缺失/空文件/目录跳过（零感知：缺产物由 exit gate 既有语义拒，本函数不补刀）
export function detectNeedHuman(artifactsDir: string, producePaths: string[]) {
  if (!Array.isArray(producePaths) || producePaths.length === 0) return { declared: false, path: null };
  for (const p of producePaths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (/^needHuman:\s*true$/m.test(content)) return { declared: true, path: p };
  }
  return { declared: false, path: null };
}

// ── R1 §2.4 #4 · 人工待确认字面量检测（**纯函数**，与 `detectNeedHuman` 同区：声明解析函数族）──────
// 语义：团队成员可经 `flows.plan.contract.pending_marker:{literal:"<非空字符串>"}` 声明「本团队的 plan
//   产物用什么字面量表达『口径待人工裁决』」；产物正文**逐字**含该字面量 ⇒ 命中（拒 `GATE_NEEDHUMAN_PENDING`）。
// 判据三条（冻结）：
//   · **逐字 `includes`，非正则**（字面量可能含 `[` `]` 等正则元字符，正则化会把 `a.b` 误判成通配）；
//   · `literal` 非空才参与（空串恒命中 ⇒ 直接判未声明，防「空声明 = 全命中」的假挂起）；
//   · **零 IO、零副作用**：内容由调用方读好传入（本函数不碰 fs）。
// 边界（与 U-1 一致）：本函数**不判层**；「仅 plan 层生效」由调用点 `checkPlanContract`（本就只服务 plan 层）
//   的显式 `t.layer === 'plan'` 守卫承担 ⇒ 判定面单点、不在此处再嵌层语义（防两处判层漂移）。
export function detectPendingMarker(content: string, literal: string) {
  if (typeof content !== 'string' || content.length === 0
    || typeof literal !== 'string' || literal.length === 0) {
    return { declared: false, index: -1 };
  }
  const index = content.indexOf(literal);
  return index < 0 ? { declared: false, index: -1 } : { declared: true, index };
}

// 命令 gate（V1）：产物独立行声明 `gate: <命令>`（行首锚定正则，与 needHuman 独立行模式同源）
// 内嵌/注释/非行首不误判；`gate: false` 视为显式禁用声明不计入；空命令（gate: 后无内容）**不计入 `commands`**，
//   但**计入 `emptyCommand` 位**（声明面分离，S-F7）——空声明不再与「完全未声明」同路。
export const GATE_LINE_RE = /^gate:\s*(.+)$/gm;

// S-F7：**空声明行**（`gate:` 后仅空白 / 空）——与 GATE_LINE_RE 互补：后者要求命令段非空（`(.+)`），
//   故空声明行**永不**被其命中；本正则专门锚定该形态，使「声明了但没给命令」可判、可拒（GATE_EXIT_NO_COMMAND）。
//   行首锚定 + 整行匹配 + 仅 `[ \t]`：**不得用 `\s`**（`\s` 含 `\n`，在 `m` 下会把 `gate:\n<下一行>` 误吞成同一行空白）。
export const GATE_EMPTY_LINE_RE = /^gate:[ \t]*$/m;

// 声明解析纯函数（同 detectNeedHuman 模式：缺失/空/目录跳过、零感知）：
// 遍历 produce/outputs 并集 → 收集所有命中行命令（保序）→ { declared, commands, path, emptyCommand }
// `declared` 仍为 `commands.length > 0`（向后兼容锚点，一字未改）；**空声明不再走此路**——
//   由新增的 `emptyCommand` 位承接 ⇒ `checkCommandGate` 首判短路为「拒 `GATE_EXIT_NO_COMMAND`」。
export function detectGate(artifactsDir: string, paths: string[]) {
  if (!Array.isArray(paths) || paths.length === 0) return { declared: false, commands: [], path: null, emptyCommand: null };
  const commands = [];
  let declaredPath: string | null = null;
  let emptyCommandPath: string | null = null; // S-F7：首个含空 `gate:` 行的产物相对路径（声明面，与 declared 分离）
  for (const p of paths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    GATE_LINE_RE.lastIndex = 0; // /g 正则复用防 lastIndex 泄漏
    let m;
    while ((m = GATE_LINE_RE.exec(content)) !== null) {
      const cmd = m[1].trim();
      if (cmd.length === 0 || cmd === 'false') continue; // 空命令 / gate: false（禁用声明）不计入
      commands.push(cmd);
      if (!declaredPath) declaredPath = p;
    }
    // S-F7：空声明**独立成位**（`GATE_EMPTY_LINE_RE` 无 `g` 标志 ⇒ 无 lastIndex 维护）
    if (!emptyCommandPath && GATE_EMPTY_LINE_RE.test(content)) emptyCommandPath = p;
  }
  return { declared: commands.length > 0, commands, path: declaredPath, emptyCommand: emptyCommandPath };
}

// 显式禁用声明检测（S17）：独立行 `gate: false`（行首锚定，与 `GATE_LINE_RE` / `TARGETS_CLAIMED_RE` 同族）。
// 语义：`detectGate` 把 `gate: false` 视为「不计入」（零感知）⇒ 无法区分「未声明」与「显式关闭」；
//   本函数**只补这一位信息**，供 `checkCommandGate` 产 `escape{kind:'command-declared-off'}` 留痕
//   （**判定不变**：显式禁用仍放行）。
// F-7：**空声明已由 `GATE_EMPTY_LINE_RE` 位承接并在 `checkCommandGate` 首判短路为拒**
//   （原注释「命令解析为空仍拒」描述了当时**不可达**的死码分支，属「说已防护、实未防护」的注释漂移，已订正）。
const GATE_OFF_LINE_RE = /^gate:[ \t]*false[ \t]*$/m;

function detectGateOff(artifactsDir: string, paths: string[]) {
  if (!Array.isArray(paths) || paths.length === 0) return { declared: false, path: null };
  for (const p of paths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (GATE_OFF_LINE_RE.test(content)) return { declared: true, path: p };
  }
  return { declared: false, path: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// R1 §2.4 #2/#5 ·「reason 词表」判据族 —— **单点实现**（entry 门 E1 与命令门 C3 共用，禁两套口径）
//   声明面（冻结，规格 §3 M-2）：产物内**行首锚定的独立行** `reason: <token>`。
//     与既有行族同构：`reason:` 类比 `gate:`（GATE_LINE_RE）/ `empty-reason:`（EMPTY_REASON_RE）/
//     `targets-claimed:`；`^reason:` **不匹配** `empty-reason:` ⇒ 既有载原因行族零误伤（逐字可机检）。
//   为什么是「独立行」而非 `t.reason`：`WavePlanTask`（`lib/types/contracts.ts`）**无 `reason` 字段**、
//     冻结面未授权新增任务字段 ⇒ 判定面落在**产物正文**（本规格 §3 M-2 冻结补全，唯一实现处 = 本处）。
//   读取纪律：与 `detectGate` / `detectNeedHuman` 同源——`produce ∪ outputs` 声明产物、缺失/空/目录跳过、
//     空 token 行不计入；**零写盘、零事件**（纯读）。
const REASON_DECL_RE = /^reason:[ \t]*(\S[^\n]*)$/gm;

export interface ReasonTokenDecl { token: string; path: string; index: number }

export interface ReasonVocabularyVerdict {
  ok: boolean;
  declarations: ReasonTokenDecl[];
  unknown: ReasonTokenDecl[];
  restated: Array<ReasonTokenDecl & { entryId: string | null }>;
  degrade: { kind: string; code: string; problems: string[] } | null;
}

/** 词表只读视图（§2.4 #6 的**纯展示位**形态：恰好三键，不参与任何判定）。 */
export interface VocabularyView { loaded: boolean; version: number | null; source: string | null }

/** 词表只读视图（`gateStatusOfLane` 展示位 + 判据面自证；**零拒码、零判定**）。 */
function vocabularyViewOf(opts: { root?: string | null } = {}): VocabularyView {
  const doc = loadVocabulary({ root: opts.root ?? null });
  if (doc.ok !== true) return { loaded: false, version: null, source: null };
  const meta = doc.meta as { version?: unknown } | undefined;
  return {
    loaded: true,
    version: meta && typeof meta.version === 'number' ? meta.version : null,
    source: VOCABULARY_REL,
  };
}

/** 解析产物内的 `reason: <token>` 声明行（保序；`token` 取 trim 后原文，空则不计入）。 */
function detectReasonTokens(artifactsDir: string, paths: string[]): ReasonTokenDecl[] {
  const out: ReasonTokenDecl[] = [];
  if (!Array.isArray(paths) || paths.length === 0) return out;
  for (const p of paths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    REASON_DECL_RE.lastIndex = 0; // /g 正则复用防 lastIndex 泄漏（同 detectGate 纪律）
    let m;
    while ((m = REASON_DECL_RE.exec(content)) !== null) {
      const token = String(m[1]).trim();
      if (token.length === 0) continue;
      out.push({ token, path: p, index: m.index });
    }
  }
  return out;
}

/**
 * 词表判定（**单点**：`checkEntryGate` E1 与 `checkCommandGate` C3 同调本函数）：
 *   · 未登记 token ⇒ `ok:false` + `unknown[]` ⇒ 调用方拒 `GATE_TOKEN_UNKNOWN`（Q-3=B 的收紧面）；
 *   · 词条存在但 `enabled:false` ⇒ `restated[]`（**放行 + 告警**，禁用≠删除：既有产物仍解析通过）；
 *   · 词表不可用（缺文件 / 坏 JSON / schema 不过）⇒ **fail-open**：`ok:true` + `degrade`
 *     （`GATE_VOCAB_INVALID` 是**告警级**码，不是拒码 —— 词表损坏不得砸生产，§2.1(f)）。
 * 严格生效（U-2）：本函数**无**任何按批龄分流 / env 关阀 / 缺声明放宽分支；「存量不追溯」由词表内容
 *   承载（R1 交付形态 `entries: []` ⇒ 零 token 命中 ⇒ 零校验面），**不**由批次年龄承载。
 */
export function reasonVocabularyVerdict(
  artifactsDir: string, paths: string[], opts: { root?: string | null } = {},
): ReasonVocabularyVerdict {
  const root = opts.root ?? null;
  const declarations = detectReasonTokens(artifactsDir, paths);
  const doc = loadVocabulary({ root });
  if (doc.ok !== true) {
    return {
      ok: true, declarations, unknown: [], restated: [],
      degrade: {
        kind: 'vocabulary-unavailable', code: 'GATE_VOCAB_INVALID',
        problems: Array.isArray(doc.problems) ? (doc.problems as string[]) : [],
      },
    };
  }
  const unknown: ReasonTokenDecl[] = [];
  const restated: Array<ReasonTokenDecl & { entryId: string | null }> = [];
  for (const d of declarations) {
    const r = reasonTokenKnown(d.token, { root });
    if (r.known !== true) { unknown.push(d); continue; }
    if (r.restated === true) {
      const entry = r.entry as { id?: unknown } | null;
      restated.push({ ...d, entryId: entry && typeof entry.id === 'string' ? entry.id : null });
    }
  }
  return { ok: unknown.length === 0, declarations, unknown, restated, degrade: null };
}

/**
 * 词表判定的**放行侧载荷**（单点构造；entry 门 E1 与命令门 C3 同形）：
 *   `{}` = 零感知（无声明 / 全部在册）；`escapes[]` = 留痕面（`vocabulary-restated` 告警 /
 *   `vocabulary-unavailable` 降级）。
 * 形态选择（**刻意的**）：只走 `escapes[]` **多值通道**，**不**占用 `escape` 单值键 —— 调用点可能已自带
 *   专属 `escape`（如 `command-declared-off` / `standalone`），两态可同时成立（例：显式禁用 `gate:` +
 *   产物声明停用词条）⇒ 多值通道使两条留痕**各自可归因**、互不覆盖（写端 `store.js#gateEscapeEvents`
 *   同时消费 `escape` 与 `escapes[]`）。
 * 纪律：本函数**只产载荷**，不落盘、不改判定（落盘唯一在 store 写路径 ⇒ R-5「只读视图零事件」）。
 */
function reasonVocabularyNote(v: ReasonVocabularyVerdict) {
  if (v.degrade !== null) {
    return {
      vocabCode: v.degrade.code,
      escapes: [{
        kind: v.degrade.kind,
        reason: '词表不可用（' + v.degrade.code + '）⇒ fail-open 降级放行 + 留痕（**不拒批**：词表损坏不得砸生产）'
          + (v.degrade.problems.length ? '：' + v.degrade.problems.join('; ') : ''),
      }],
    };
  }
  if (v.restated.length > 0) {
    return {
      escapes: [{
        kind: 'vocabulary-restated',
        reason: '产物声明的 reason token 命中**停用**词条（enabled:false）⇒ 放行 + 告警'
          + '（禁用≠删除：既有产物仍解析通过）：' + v.restated.map((r) => r.token + '@' + r.path).join(', '),
      }],
    };
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// 拒绝免检（presence 硬约束）判据族 —— **唯一实现 presenceJudge**（判据同源，O-4.3）
//   mode:'declare' = 建批期静态面（P1–P5；调用点 lib/wave-plan.ts，e2 导入）
//   mode:'runtime' = 运行期含文件面（P1–P9；调用点本文件的 entry / plan / exit 三门）
// 口径：声明的产物**必须在场**（不存在 / 0 字节 / 形态不符 ⇒ 拒）；
//   空内容唯一合法通道 = 独立行 `empty-reason: <非空文本>`（有 ⇒ 放行 + 留痕；无 ⇒ 拒）。
// 两条 Leader 裁定的实现口径：
//   · R-1（声明形态二分，**按声明原文判定，禁尾斜杠规范化**）：`/` 结尾 ⇒ 目录语义（须存在且非空）；
//     不以 `/` 结尾 ⇒ 文件语义（须为非空文件；给目录 ⇒ 拒）。
//   · R-2（行首锚定，不容前导空白，与 TARGETS_CLAIMED_RE 同族 `^...$`）。
//   · O-4.2：真实 0 字节文件一律判 missing（0 字节不可能自带原因行）。
// ─────────────────────────────────────────────────────────────────────────────
const EMPTY_REASON_RE = /^empty-reason:[ \t]*(\S[^\n]*)$/m;

export type PresenceMode = 'declare' | 'runtime';

/** 空内容原因行留痕（`gate.escape{kind:'empty-artifact-noted'}` 的载荷）。 */
export interface PresenceNote { artifact: string; reason: string }

export interface PresenceVerdict {
  ok: boolean;
  mode: PresenceMode;
  layer: string | null;
  declaredKind: string | null;
  path: string | null;
  kind: 'file' | 'dir';
  code: string | null;
  problems: string[];
  notes: PresenceNote[];
}

/** 声明形态（R-1）：按**声明原文**判定（`/` 结尾 = 目录语义），不做尾斜杠规范化。 */
export function declaredKindOf(declared: string): 'file' | 'dir' {
  return typeof declared === 'string' && declared.endsWith('/') ? 'dir' : 'file';
}

/** 原因行判定：**行首锚定 + 非空文本**（R-2；行中出现 / 前导空白 / 空文本 ⇒ 不命中）。 */
function emptyReasonOf(content: string): string | null {
  if (typeof content !== 'string') return null;
  const m = content.match(EMPTY_REASON_RE);
  if (!m) return null;
  const reason = String(m[1]).trim();
  return reason.length > 0 ? reason : null;
}

/** 「可空」的定义（O-4.1）：扣除原因行后**无任何实质内容**。 */
function substantiveContentOf(content: string): string {
  return String(content ?? '').replace(/^empty-reason:.*$/gm, '');
}

/** 判据章节**裸标题行**判定（S10 最低内容判据）：行首锚定 + 整行仅标题（编号变体/正文提及均不命中）。 */
function sectionLineHit(content: string, section: string): boolean {
  if (typeof content !== 'string' || typeof section !== 'string' || section.length === 0) return false;
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped + '[ \\t]*$', 'm').test(content);
}

/**
 * 元素声明行判定（R1 §2.4 #3）：行首锚定 + 独立整行 `element: <id>`。
 *  与既有行族同构（`reason:` / `gate:` / `targets-claimed:` / `empty-reason:`）；不用 `content.includes(id)`
 *  是因为元素 id（如 `goal`）通常极短，`includes` 会把任意词命中 ⇒ 判据不可靠（假绿风险）。
 *  `id` 按**字面量**转义后匹配（与 `sectionLineHit` 同法，防正则元字符）。
 */
function elementLineHit(content: string, id: string): boolean {
  if (typeof content !== 'string' || typeof id !== 'string' || id.length === 0) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^element:[ \\t]*' + escaped + '[ \\t]*$', 'm').test(content);
}

/** 路径归属判定（P8）：绝对路径产物必须在批次产物根内。 */
function isInsideRoot(absPath: string, rootDir: string): boolean {
  const rel = path.relative(path.resolve(rootDir), path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * presence 判据唯一实现（判据同源：建批期 `mode:'declare'` / 运行期 `mode:'runtime'`）。
 * `abs` / `content` 只对**单件声明**有效（多件声明由调用方逐件调用，或建批期只走静态面）。
 */
export function presenceJudge(input: {
  mode?: PresenceMode;
  layer?: string | null;
  declared?: unknown;
  declaredKind?: string | null;
  abs?: string | null;
  content?: string | null;
  artifactsRoot?: string | null;
} = {}): PresenceVerdict {
  const mode: PresenceMode = input.mode === 'declare' ? 'declare' : 'runtime';
  const layer = typeof input.layer === 'string' ? input.layer : null;
  const declaredKind = typeof input.declaredKind === 'string' ? input.declaredKind : null;
  const declaredList: string[] = Array.isArray(input.declared)
    ? (input.declared as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const problems: string[] = [];
  const notes: PresenceNote[] = [];
  const base = { mode, layer, declaredKind, problems, notes };
  if (declaredList.length === 0) {
    return { ...base, ok: false, path: null, kind: 'file', code: 'GATE_NO_DECLARATION', problems: ['no declared artifacts'] };
  }
  let code: string | null = null;
  let lastPath: string | null = null;
  let lastKind: 'file' | 'dir' = 'file';
  for (const decl of declaredList) {
    const kind = declaredKindOf(decl);
    lastPath = decl;
    lastKind = kind;
    if (mode === 'declare') {
      // P2 路径契约（静态面；相对路径必须落在 plan/|exec/|audit/ 命名空间内）
      if (!isAbsPath(decl) && !/^(plan|exec|audit)\//.test(decl)) {
        problems.push(decl + ' outside layer namespace (expect plan/|exec/|audit/)');
        code = code ?? 'GATE_ARTIFACT_OUTSIDE_ROOT';
      }
      continue; // 文件面（P6–P9）只在 runtime 判（静态面拿不到文件事实）
    }
    const abs = isAbsPath(decl) ? decl : (typeof input.abs === 'string' && input.abs.length > 0 ? input.abs : null);
    if (abs === null) {
      problems.push(decl + ' missing');
      code = code ?? (kind === 'dir' ? 'GATE_ARTIFACT_NOT_A_FILE' : 'GATE_ARTIFACT_MISSING');
      continue;
    }
    if (typeof input.artifactsRoot === 'string' && !isInsideRoot(abs, input.artifactsRoot)) {
      problems.push(decl + ' outside batch artifacts root');
      code = code ?? 'GATE_ARTIFACT_OUTSIDE_ROOT';
      continue;
    }
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch {
      if (kind === 'dir') { problems.push(decl + ' is not an existing directory'); code = code ?? 'GATE_ARTIFACT_NOT_A_FILE'; }
      else { problems.push(decl + ' missing'); code = code ?? 'GATE_ARTIFACT_MISSING'; }
      continue;
    }
    if (kind === 'dir') {
      // 目录语义（R-1）：声明以 `/` 结尾 ⇒ 须**存在且非空**
      if (!st.isDirectory()) { problems.push(decl + ' declared as directory but is not a directory'); code = code ?? 'GATE_ARTIFACT_NOT_A_FILE'; continue; }
      let entries: string[] = [];
      try { entries = fs.readdirSync(abs); } catch { entries = []; }
      if (entries.length === 0) { problems.push(decl + ' empty directory (no entries, no empty-reason)'); code = code ?? 'GATE_ARTIFACT_EMPTY_NO_REASON'; }
      continue;
    }
    // 文件语义（R-1）：须为**非空普通文件**；给目录 ⇒ 拒
    if (st.isDirectory()) { problems.push(decl + ' is a directory (declared as file)'); code = code ?? 'GATE_ARTIFACT_NOT_A_FILE'; continue; }
    if (st.size === 0) { problems.push(decl + ' missing'); code = code ?? 'GATE_ARTIFACT_MISSING'; continue; } // O-4.2：0 字节一律判 missing
    let text: string | null = typeof input.content === 'string' ? input.content : null;
    if (text === null) { try { text = fs.readFileSync(abs, 'utf8'); } catch { text = null; } }
    if (text === null) { problems.push(decl + ' unreadable'); code = code ?? 'GATE_ARTIFACT_MISSING'; continue; }
    if (substantiveContentOf(text).trim().length === 0) {
      const reason = emptyReasonOf(text);
      if (reason !== null) { notes.push({ artifact: decl, reason }); continue; } // 唯一空内容通道：放行 + 留痕
      problems.push(decl + ' empty and lacks an independent `empty-reason:` line with non-empty text');
      code = code ?? 'GATE_ARTIFACT_EMPTY_NO_REASON';
    }
  }
  return { ...base, ok: problems.length === 0, path: lastPath, kind: lastKind, code: problems.length ? code : null };
}

export function createGates(root: string, opts: { flowsRoot?: string; readConfig?: () => unknown; vocabularyRoot?: string } = {}) {
  const sessionsDir = path.join(root, 'sessions');
  // 【2026-09-27 · team-asset 全量退役】原「声明解析根」DI 缝（`opts.flowsRoot` → 临时包根）
  //   **已无对象**：团队资产不再被解析 ⇒ 无根可注入。签名里的 `flowsRoot` 字段**保形保留**
  //   （调用方与测试签名零变化），读端**不再消费**它，也不得据此恢复读盘。
  // R1 词表读取根（DI 缝，与 `flowsRoot` **同形**：测试可指向临时包根；生产缺省 = 包根 ⇒ 零行为变化）。
  //   存在理由：S-④ 要求「停用词条 ⇒ 既有产物解析通过 / 新写点被拒」的**两态可分**用例必须注入
  //   私有词表夹具；而交付物 `lib/state/vocabulary.json` 不得被测试污染（exec-1 同口径）。
  const vocabularyRoot = opts && typeof opts.vocabularyRoot === 'string' ? opts.vocabularyRoot : null;
  const vocabOpts: { root: string | null } = { root: vocabularyRoot };
  // 热配置读取器（`task-27`）：门开关策略**只在门禁侧解析一次**（单一解析点 `handoffGateEnabledOf`）。
  //   优先用装配点注入的 `readConfig`（工具面同源热更快照）；未注入（单测直建 store / 早期装配）⇒ 读
  //   `lib/hot/config-watch.js` 的**模块级生效快照**（与 watcher 同一次写入，非第二套读路径）；
  //   两者皆空 ⇒ 解析点顺次回落 env → 缺省关（既有行为零变化）。
  const readCfg: () => unknown = (opts && typeof opts.readConfig === 'function')
    ? opts.readConfig
    : () => readRuntimeSnapshot({});
  // 声明解析（【2026-09-27 · team-asset 全量退役】资产根面已不存在）：
  //   原优先级 ① 批次级 `teamsRoot`（临时团队资产）→ ② DI 缝 `flowsRoot` → ③ 包根 三态**全部作废**：
  //   团队资产不再被解析 ⇒ `flowsForBatch` 恒回「无声明」⇒ 读端一律走**引擎基线**（tighten-only 缺省）。
  //   形参 `flowsRoot` **保形保留**（DI 缝，测试签名零变化）；现已不被读，也不得据此恢复读盘。
  const flowsOf = (batch: Batch) => flowsForBatch(batch);

  function sessionDir(sessionId: string) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionsDir, sessionId);
  }
  function artifactsDirOf(sessionId: string, batchId: string) {
    return path.join(sessionDir(sessionId), 'artifacts', batchId);
  }
  function batchFile(sessionId: string, batchId: string) {
    if (!SESSION_RE.test(batchId)) throw new Error('invalid batchId');
    return path.join(sessionDir(sessionId), 'batches', batchId + '.json');
  }
  function readBatch(sessionId: string, batchId: string): Batch | null {
    const file = batchFile(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    try {
      // 单点断言：批次 JSON 由 store.createBatch 写入（Batch 契约同源形态），JSON.parse 产物断言为 Batch
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Batch;
    } catch {
      // 损坏批次隔离：读路径不 throw——损坏 → null（登记在 store 旁路清单，本文件不重复）
      return null;
    }
  }

  // ---- Tier3 门禁辅助 ----
  // lane 变更性基线（targets 门禁基准）：events 末尾向前反查最近一条 `member.settled` 且 lane 匹配且
  // to==='running' 且 **from!=='idle'** 的事件 ts（ISO）——
  // · 返工（review→running）会 push 新的 running 结算事件 → 基准重置（重新计时），语义不变（test/gates.test.js O2 T8 锚）；
  // · **排除 idle→running 恢复重派**（system.recovered 落 idle 后按 G-1 重派 ⇒ 基线不得后移——否则恢复后的 lane
  //   因 targets 门永远判「未变更」而无法收口，与 G-1「恢复路径永不可堵」/引擎 D-8「不得出现僵局」相悖；
  //   实证：gate-techdebt/e2-gov-repair 于 18:11:26.031Z idle→running 重派后基线后移，store.js mtime 17:41:06Z
  // · 无可用事件 → 回退 batch.createdAt（防御；正常 merged 必有 running 事件）。遍历模式仿 store.js lastActiveAtOf。
  // e.type === EVT 常量值（'member.settled'）在 BatchEvent 判别联合下收窄；兜底分支字段 unknown 与 === 比较不受影响
  function laneStartedAt(batch: Batch, lane: string): string {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e && e.type === EVT.EVT_MEMBER_SETTLED && e.lane === lane && e.to === 'running' && e.ts && e.from !== 'idle') return e.ts;
    }
    return batch.createdAt;
  }
  function resolveArtifact(sessionId: string, batchId: string, rel: string) {
    return isAbsPath(rel) ? rel : path.join(artifactsDirOf(sessionId, batchId), rel);
  }
  // 退休（r2 拒绝免检）：原 `fileExistsNonEmpty`（`isDirectory() || size>0`）已被 `presenceJudge`
  //   （声明形态二分 + 0 字节判 missing + 空内容须载原因）整体取代；保留同名判据即构成「两套逻辑」
  //   （O-4.3 判据同源禁止），故随本批删除——门禁与 `gateStatus` 面板一律走 `presenceJudge`。
  // ── 拒绝免检辅助（三层门禁共用单点）──
  // 被检面 = produce ∪ outputs（去重保序；`produce_field` 降为信息性字段，S8）
  function declaredArtifactsOf(t: WavePlanTask | null | undefined): string[] {
    const out: string[] = [];
    if (!t) return out;
    const lists: Array<string[] | null | undefined> = [t.produce, t.outputs];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const p of list) if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p);
    }
    return out;
  }
  // consume 检面（S19① **判据同源**）：字段名由 `consumeFieldOf(flow, layer)` 决定——缺声明回落 `'consume'`、
  //   白名单外（`team-asset.js` CONSUME_FIELDS）**回落 + 问题可读**；同一个字段名同时用于 **entry 检面**与
  //   `gateStrength.consumeField`（禁第二套逻辑）。缺 flow（无声明 / 层缺失）⇒ `'consume'`。
  function consumeFieldNameOf(flows: unknown, layer: string | null): string {
    return layer ? (consumeFieldOf(flowOf(flows, layer), layer) as string) : 'consume';
  }
  function consumeArtifactsOf(t: WavePlanTask | null | undefined, field: string = 'consume'): string[] {
    const out: string[] = [];
    if (!t) return out;
    const list = (t as unknown as Record<string, unknown>)[field];
    if (!Array.isArray(list)) return out;
    for (const p of list) if (typeof p === 'string' && p.length > 0) out.push(p);
    return out;
  }
  // 批次三层 lane 划分（B2 / B3 与 gateStrength 共用单点）
  function layersOf(batch: Batch): Record<Layer, string[]> {
    const layers: Record<Layer, string[]> = { plan: [], exec: [], audit: [] };
    for (const w of batch.wavePlan ?? []) for (const t of w.tasks ?? []) if (t && t.layer && layers[t.layer]) layers[t.layer].push(t.id);
    return layers;
  }
  // A1 悬空产物（纯读 wavePlan，不读正文）：plan 悬空 ⇒ 拒；exec / audit 悬空 ⇒ 强告警 + 可见（有意不对称）
  function orphanProductsOf(batch: Batch): { plan: string[]; exec: string[]; audit: string[] } {
    const declared: Record<Layer, string[]> = { plan: [], exec: [], audit: [] };
    const consumed = new Set<string>();
    const flows = flowsOf(batch).flows;
    for (const w of batch.wavePlan ?? []) for (const t of w.tasks ?? []) {
      if (!t) continue;
      if (t.layer && declared[t.layer]) {
        for (const p of declaredArtifactsOf(t)) if (!declared[t.layer].includes(p)) declared[t.layer].push(p);
      }
      // 判据同源（S19①）：被消费面同样按该层声明的 consume 字段名读（缺声明 ⇒ 'consume'）
      for (const c of consumeArtifactsOf(t, consumeFieldNameOf(flows, t.layer ?? null))) consumed.add(c);
    }
    const orphansOf = (layer: Layer) => declared[layer].filter((p) => !consumed.has(p));
    return { plan: orphansOf('plan'), exec: orphansOf('exec'), audit: orphansOf('audit') };
  }
  // complete = 执行完成**且通过验收** ⇒ 有效白名单 = 声明 ∩ {pass, skip}；fail / conflict 恒拒
  function completeOutcomesOf(batch: Batch) {
    const af = flowOf(flowsOf(batch).flows, 'audit');
    const verdict = af && af.audit_contract && Array.isArray(af.audit_contract.verdict) && af.audit_contract.verdict.length > 0
      ? (af.audit_contract.verdict as string[]) : null;
    // E-4（legacy-retire-20260915）：`flows.complete.require_audit_outcomes` 双键回落已清退——
    //   complete 白名单**唯一声明真源** = verdict；缺声明 ⇒ 引擎基线 ['pass','skip']（零差异：
    //   四内置资产均声明 verdict，清退前实测不回落）。声明废键不产生任何门禁效果（正向清退断言锚定）。
    const declaredSet: string[] | null = verdict;
    const values = declaredSet ? declaredSet.filter((v) => v === 'pass' || v === 'skip') : ['pass', 'skip'];
    const narrowed = declaredSet ? declaredSet.filter((v) => v !== 'pass' && v !== 'skip') : [];
    return {
      source: verdict ? 'flows.audit.audit_contract.verdict ∩ {pass,skip}' : 'engine:Q-7-baseline ∩ {pass,skip}',
      declared: declaredSet,
      values,
      narrowed,
      rejectedBy: ['fail', 'conflict'],
      escapeRoute: {
        phase: 'aborted' as const,
        reason: 'fail / conflict 为成员终态且均不得 complete ⇒ 批次经 batch_phase({phase:"aborted"}) 收口（可审计）或转人工闸；不得形成「既不能 complete 也无法推进」的僵局（D-8 终态可退出）',
      },
    };
  }
  // standalone 逃生阀（B4）：显式授权 + 事实核验 + 留痕；自声明不足以放行
  //   返回 declared=false 表示「根本未声明 standalone」⇒ 按缺声明拒（B1），不套用 standalone 码。
  function standaloneVerdict(batch: Batch, t: WavePlanTask): { ok: boolean; declared: boolean; code: string | null; reason: string } {
    const raw = (t as unknown as { standaloneReason?: unknown }).standaloneReason;
    const reason = typeof raw === 'string' ? raw.trim() : '';
    if (t.standalone === undefined || t.standalone === null || t.standalone === false) {
      return { ok: false, declared: false, code: null, reason };
    }
    if (t.standalone !== true) return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
    if (reason.length === 0) return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
    const availableUpstream = (batch.wavePlan ?? []).some((w) => (w.tasks ?? []).some((x) => x && x.layer === 'plan' && declaredArtifactsOf(x).length > 0));
    if (availableUpstream) return { ok: false, declared: true, code: 'GATE_STANDALONE_UNJUSTIFIED', reason };
    return { ok: true, declared: true, code: null, reason };
  }
  // 单件产物 presence 复核（运行期；判据同源 presenceJudge）
  function presenceOfArtifact(sessionId: string, batchId: string, layer: string | null, p: string) {
    return presenceJudge({
      mode: 'runtime', layer, declared: [p], declaredKind: 'array',
      abs: resolveArtifact(sessionId, batchId, p), artifactsRoot: artifactsDirOf(sessionId, batchId),
    });
  }

  // ── P1 交接门（handoff gate，2026-09-17）单点判定辅助 ───────────────────────────────────────
  // 判据（`p1-handoff-gate-changeplan-20260917`（原文档未随仓分发） §2/§3，**单点**：只在本函数判，禁第二处）：
  //   · 入边集合 = `task.deps`（DAG 入边，**每条入边 ⇔ 一条** `batch.handoffs[lane]` 记录）；
  //   · 每条记录须 `status:'submitted'` + `artifacts[]` 非空且**逐个存在** + `contract` 合规
  //     （`consumedFrom` 指回该入边 + `assertions[]` 非空字符串数组）；
  //   · **存量批**（`batch.handoffs === undefined`）⇒ 整门放行 + `legacy:true`（留痕由调用侧承担）；
  //   · **裁决 ②=A 的建批期判据**：`handoffs` 字段存在但**该入边的声明条目缺失**（= 建批期种条的来源没了）⇒ 拒。
  function depsOf(t: WavePlanTask | null | undefined): string[] {
    const out: string[] = [];
    const list = (t as unknown as { deps?: unknown } | null | undefined)?.deps;
    if (!Array.isArray(list)) return out;
    for (const d of list) if (typeof d === 'string' && d.length > 0 && !out.includes(d)) out.push(d);
    return out;
  }
  // ── 交接判据的**单点实现** ────────────────────────────────────────
  // 纪律（用户裁决）：「**复用**，禁在出口门里再写一遍判定逻辑」——故把「一条交接记录是否成立」抽成本函数，
  //   **entry 门（`handoffVerdictOf`）与出口门（`checkSettleHandoffGate`）两处都调它**。
  //   抽取面 = **单条记录的成立性**（status / artifacts 逐个在场 / contract{consumedFrom,assertions}）；
  //   两侧各自负责**集合语义**（entry = 每条 deps 入边都要成立；出口 = 至少一条 out 边成立）——
  //   集合语义不可共用（方向与量词都不同），但**判据标准单点**由此成立，不会漂移。
  //   `layer` 传入被检 lane 的 layer（产物在场判据按产品根解析，与 entry 门同源）。
  function handoffRecordVerdict(
    sessionId: string, batchId: string, layer: string | null | undefined,
    rec: Record<string, unknown> | null, from: string, to: string,
  ): { ok: boolean; missing: string[]; problems: string[]; pending: boolean } {
    const missing: string[] = [];
    const problems: string[] = [];
    if (!rec) {
      missing.push('edge:' + from + '->' + to + ' (无交接声明)');
      problems.push('deps 入边 ' + from + '->' + to + ' 在本批 `handoffs` 中无任何交接记录（建批期声明的交接来源缺失 ⇒ 判不可开工）');
      return { ok: false, missing, problems, pending: false };
    }
    let pending = false;
    if (rec.status !== 'submitted') {
      pending = true;
      missing.push('edge:' + from + '->' + to + ' (未交接)');
      problems.push('上游 ' + from + ' 尚未提交交接（status=' + String(rec.status ?? '（缺）') + '）');
    }
    const arts: string[] = Array.isArray(rec.artifacts) ? (rec.artifacts as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
    if (arts.length === 0) {
      missing.push('edge:' + from + '->' + to + ' (artifacts 空)');
      problems.push('交接 ' + from + '->' + to + ' 未声明交付产物（artifacts 为空）');
    }
    for (const p of arts) {
      const v = presenceOfArtifact(sessionId, batchId, layer ?? null, p);
      if (!v.ok) {
        missing.push(p + ' (missing)');
        problems.push('交接产物不在场：' + p + (v.problems && v.problems.length ? '（' + v.problems.join('; ') + '）' : ''));
      }
    }
    const c = rec.contract;
    const cObj = (c && typeof c === 'object' && !Array.isArray(c)) ? (c as Record<string, unknown>) : null;
    if (!cObj || cObj.consumedFrom !== from) {
      missing.push('contract.consumedFrom@' + from + '->' + to);
      problems.push('交接契约缺失或 `consumedFrom` 不指回该入边（期望 ' + from + '）');
    }
    const asrt = cObj && Array.isArray(cObj.assertions) ? (cObj.assertions as unknown[]).filter((x) => typeof x === 'string' && (x as string).trim().length > 0) : [];
    if (asrt.length === 0) {
      missing.push('contract.assertions@' + from + '->' + to);
      problems.push('交接契约 `assertions` 为空（下游无可核断言可依）');
    }
    return { ok: missing.length === 0, missing, problems, pending };
  }

  function handoffVerdictOf(sessionId: string, batchId: string, batch: Batch, lane: string, t: WavePlanTask | null | undefined) {
    const deps = depsOf(t);
    const map = (batch as unknown as { handoffs?: unknown }).handoffs;
    if (deps.length === 0) return { ok: true, legacy: false, missing: [], problems: [], pending: [] };
    // 存量批（无 `handoffs` 字段）⇒ 不受新门约束：放行 + 留痕（调用侧落 `lane.handoff.gap`）
    if (map === undefined || map === null) return { ok: true, legacy: true, missing: [], problems: [], pending: [] };
    const byTo: Record<string, unknown> = (map && typeof map === 'object' && !Array.isArray(map)) ? (map as Record<string, unknown>) : {};
    const list = Array.isArray(byTo[lane]) ? (byTo[lane] as unknown[]) : [];
    const records = list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
    const missing: string[] = [];
    const problems: string[] = [];
    const pending: string[] = [];
    for (const from of deps) {
      const vr = handoffRecordVerdict(sessionId, batchId, t?.layer ?? null, records.find((r) => r.from === from) ?? null, from, lane);
      missing.push(...vr.missing);
      problems.push(...vr.problems);
      if (vr.pending) pending.push(from + '->' + lane);
    }
    return { ok: missing.length === 0, legacy: false, missing, problems, pending };
  }

  // Entry Gate：exec / audit lane 派发前 consume 必须**已声明且全部在场**
  //   ① 零依赖拒派（B1）：consume 空 / 未声明 / 非数组 ⇒ 拒，**不依赖团队是否声明 entry_requires**；
  //   ② presence 硬约束：声明的上游产物必须在场（形态二分：`/` 结尾 ⇒ 目录语义，须存在且非空）；
  //   ③ audit 判据来源门（B-10）：**逐字保留**（criteria_from 锚点 + 裸标题内容面）；
  //   ④ G-1 空闲态不堵（2026-09-15 用户澄清）：lane 处于 `idle` = **字面意义的空闲态**（成员当前无在跑动作，
  //      **返工 / 续跑可调用**；进程重启也会把在途 lane 落回 idle）——此时严进不满足 ⇒ **降级为告警放行**
  //      并产 `gate.escape{kind:'idle-recovery-passthrough'}`；首次派发（pending）仍严格。
  function checkEntryGate(sessionId: string, batchId: string, batch: Batch, lane: string) {
    const t = taskOf(batch, lane);
    if (!t) return { ok: false, code: 'GATE_LANE_NOT_IN_PLAN', lane, missing: [], problems: [lane + ' not in wavePlan.tasks'] };
    // plan 层结构性无上游 ⇒ entry 豁免（B1 明示）；无 layer 的 lane 不在本门（B2 由 exit 门与 gateStatus 处置）
    if (t.layer !== 'exec' && t.layer !== 'audit') return { ok: true, lane };
    const flows = flowsOf(batch).flows;
    const flow = flowOf(flows, t.layer);
    // 团队声明只用于**留痕标注**，不作为「是否强制 consume」的开关（缺声明亦拒——B1 零依赖拒派）
    // G-3 修正：标注取**真实来源** `entryRequiresOf(flow).source`——显式声明过 ⇒ `team-asset:entry_requires`；
    //   缺声明/无资产 ⇒ `tighten-only-default`（引擎缺省）。该字段**只用于留痕**（不参与判定）
    //   ⇒ 值变化不改任何判定结果（正向对照见 R-06）。
    const teamNote: Record<string, unknown> = { requiredBy: entryRequiresOf(flow).source };
    // ── P1 交接门（**先**未交接门 **后**既有 consume 在场门；裁决 ②=A）───────────────────────────
    // 判定时机说明：本门在**本函数头部**求值一次（而非排在 smoke 分支之后），因为 `reject()` 闭包需要
    //   `handoffLegacy` 标记（存量批放行面）；smoke 豁免仍由**既有分支**在下方统一承担（`handoffLegacy`
    //   只在「无 handoffs 字段且确有 deps 入边」时为真，smoke 批在该分支直接返回 ⇒ 不进留痕面）。
    // 判据（§2/§3 单点）：入边集合 = `task.deps`；每条入边 ⇔ 一条 `batch.handoffs[lane]` 记录（submitted +
    //   artifacts 逐个在场 + contract{consumedFrom, assertions} 合规）；存量批（无该字段）⇒ 整门放行 + legacy 留痕。
    const hv = handoffGateEnabledOf(readCfg(), 'entry')
      ? handoffVerdictOf(sessionId, batchId, batch, lane, t)
      : { ok: true, legacy: false, missing: [], problems: [], pending: [] };
    const hvLegacy = hv.legacy === true;
    // B2（§8⑤ **P-1** entry_requires）：入口要求面**未声明**（`entryRequiresOf().source === 'tighten-only-default'`
    //   ⇒ 引擎缺省接管）⇒ 产首触载荷（只产不落盘）。**仅放行/降级侧**挂钩：拒侧（`!g.ok`）由写端不采
    //   （与既有「拒侧不落 escape/degrade、由其专用事件留痕」口径同构）。
    const cmEntry = entryRequiresOf(flow).source === 'tighten-only-default'
      ? contractMissingPayload(
        'entry_requires', t.layer, entryRequiresOf(flow).source, 'entry-requires-tighten-only-default',
        '团队资产未声明 flows.<layer>.entry_requires ⇒ 引擎 tighten-only 缺省接管（入口 consume 强制恒生效）；本事件为首触留痕，不改判定',
      )
      : null;
    const state = batch.lanes ? batch.lanes[lane] : null;
    const recovery = state === 'idle'; // G-1：唯一降级面（首次派发 pending 仍严格）
    const reject = (payload: { code: string; missing?: string[]; problems?: string[] } & Record<string, unknown>) => {
      if (recovery) {
        return {
          ok: true, lane, recovered: true, state,
          missing: payload.missing ?? [], problems: payload.problems ?? [],
          escape: {
            kind: 'idle-recovery-passthrough', lane,
            reason: 'G-1 空闲态不堵：lane 处于 idle（空闲态——返工/续跑可调用；进程重启亦会把在途 lane 落回 idle），严进条件不满足（' + payload.code + '）⇒ 降级为告警放行 + 留痕；首次派发（pending）仍严格',
          },
          ...(cmEntry ?? {}),
        };
      }
      return { ok: false, lane, ...payload, ...teamNote, handoffLegacy: hvLegacy, missing: payload.missing ?? [] };
    };
    // ── E1 词表早期拒（R1 §2.4 #5）────────────────────────────────────────────────────────────
    // 位置（冻结）：**晚于** lane 存在性（上方 `!t` 早退）与 plan 豁免（上方 `t.layer` 早退）、
    //   **早于** smoke 豁免（下方 `smokeOf(batch)`）⇒ 冒烟/探针批同样受「未登记 reason token」约束
    //   （词表面属**行为安全**面，不属产物契约豁免面）。判定与命令门 C3 **同调** `reasonVocabularyVerdict`
    //   （**同一 tokenOf 单点**，禁两套口径）。
    // 严格生效（U-2）：无按批龄分流 / 无 env 关阀；「存量不追溯」由词表内容承载（`entries: []` ⇒ 零命中）。
    const vocabE1 = reasonVocabularyVerdict(artifactsDirOf(sessionId, batchId), declaredArtifactsOf(t), vocabOpts);
    const vocabNote = reasonVocabularyNote(vocabE1);
    if (!vocabE1.ok) {
      const first = vocabE1.unknown[0];
      return reject({
        code: 'GATE_TOKEN_UNKNOWN', source: 'reason', token: first.token, path: first.path, missing: [],
        problems: vocabE1.unknown.map((u) => u.path + ' declares unregistered reason token "' + u.token
          + '"（词表未登记 ⇒ 拒：Q-3=B 只对**新增写点**强制注册）'),
      });
    }
    // G2：**建批即拉起**——声明 `managerPlan: 'raise'` 的批，**首个 exec 派发前**必须已
    //   登记 Manager（`batch_phase({ manager: { agentId } })` 写批字段 `batch.manager`）。动机（用户口径）：执行模式
    //   应为「建批 → **建批即拉起 Manager** → Manager 调度、成员大规模并行（coder 施工与 tester 备测同 wave）」，
    //   而原实现只有**批次收口时的告警**（仅 exec≥3 的批；**该收口告警已删**——2026-09-22 用户裁定）⇒ 「拉起」实为自觉。
    //   此处把时序前置到**派发面**。边界：只拦 **exec** lane（plan 层的设计/计划允许先于拉起）；走 `reject()`
    //   ⇒ 自动继承 G-1「空闲态不堵」（lane 为 idle 时降级为告警放行 + 留痕）。
    // 【改造为官方 roster 承抽】
    //   **原「未拉起 Manager」硬门已删**（2026-09-21 可达性审计：**码名已字面删除**，避免 grep 误当活码）：
    //   Manager 在册判定改由**官方 roster** 承抽
    //   （读端 `lib/tools/core.js#managerRosterOf` / `managerViewOf`：`ctx.get('agentTeams')` →
    //   `listMembers(agent)`；建批期落 `gate.manager_roster_gap` 事件、`wave_plan`/`batch_status` 回显）。
    //   派发面**不再因未登记 Manager 而拒**——本 engine 层不再持有第二套「拉起」口径。
    //   下列为史迹：原实现把「建批即拉起 Manager」前置到 exec 派发面（走 `reject()` ⇒ 继承 G-1 空闲态不堵）。
    const bAsm = batch as unknown as { assembly?: { managerPlan?: string } | null; manager?: unknown };
    void bAsm; // 保留锚点：`assembly.managerPlan` 的消费点已迁至 core.js 的 roster 承抽读端（本处不再判定）
    // gate-lite Q-G1：冒烟/探针批 ⇒ 跳过**产物契约类** entry 门（consume 在场 / audit 判据来源）。
    //   位置：Manager 拉起门**之后**（派发准入属行为安全门，一字不减）；lane 存在性门更在其前。
    if (smokeOf(batch)) {
      return { ok: true, lane, smoke: true, smokeSkipped: 'entry-consume', ...(cmEntry ?? {}), ...vocabNote };
    }
    // ── P1 交接门拒态判定（判据在函数头部求值，见 `hv`）─────────────────────────────────────────
    if (!hv.ok) {
      // 【2026-09-27 用户裁决 · 运行时回调指引】拒的同时给出「怎么做」（见 GATE_PLAN_CONTRACT 处同段说明）
      //   实证（批 onto-engine-slim-20260926）：**4 次停轮**源于「exec 线漏向聚合 audit lane 交接」
      //   ⇒ 若此处直接给出 `handoff_submit` 的正确调用形态与「含聚合 audit lane」的提醒，worker 当场可自救。
      return reject({
        code: 'GATE_HANDOFF_MISSING',
        missing: hv.missing,
        problems: [
          ...hv.problems,
          '【怎么做】用 `handoff_submit({ batchId, from: "<本 lane>", to: "<下游 lane>", '
          + 'artifacts: [<产物相对路径…>], assertions: [<下游可核断言…>] })` 向【本 lane 的全部出边】交接 —— '
          + '**含聚合 audit lane**（`a1-*` 这类多入边 lane，**每条上游线各自交一次**）。'
          + ' `artifacts` 里每个路径**必须已在场**（缺则仍拒）；`assertions` 不得为空。',
        ],
      });
    }
    if (hvLegacy) {
      // 放行侧标记：写端据此落 `lane.handoff.gap{legacy:true}` 告警（不静默、不砸存量）
      (teamNote as Record<string, unknown>).handoffLegacy = true;
    }
    // S19①（判据同源）：被检字段名由该层 `consume_field` 声明决定（缺声明/越界 ⇒ 回落 'consume'）
    const consume = consumeArtifactsOf(t, consumeFieldNameOf(flows, t.layer));
    if (consume.length === 0) {
      const s = standaloneVerdict(batch, t);
      if (s.ok) return { ok: true, lane, standalone: true, escape: { kind: 'standalone', lane, reason: s.reason }, ...teamNote, ...(cmEntry ?? {}), ...vocabNote };
      if (s.declared) {
        return reject({ code: 'GATE_STANDALONE_UNJUSTIFIED', missing: [], problems: [lane + ': standalone 声明不成立（须布尔 true + 非空 standaloneReason + 批次内确实无可用上游）'] });
      }
      return reject({ code: 'GATE_ENTRY_MISSING', missing: [], problems: [lane + ': no consume declared（B1 零依赖拒派）'] });
    }
    const failed: string[] = [];
    const shapeProblems: string[] = [];
    for (const p of consume) {
      const v = presenceOfArtifact(sessionId, batchId, t.layer, p);
      if (!v.ok) { failed.push(p); for (const pr of v.problems) shapeProblems.push(pr); }
    }
    if (failed.length) {
      // 【2026-09-27 用户裁决 · 运行时回调指引】拒的同时给出「怎么做」（同 GATE_PLAN_CONTRACT 段说明）
      return reject({
        code: 'GATE_ENTRY_MISSING',
        missing: failed,
        problems: [
          ...shapeProblems,
          '【怎么做】本 lane 的入口门要求**上游产物已在场**：'
          + '① 先用 `handoff_view({ batchId, lane })` 看入边是否 `submitted` —— 未交则等上游交；'
          + '② 若上游 lane 还没派 ⇒ 报 Leader 派（本 lane 不自行派发）；'
          + '③ 若 `consume` 的路径声明本身就写错 ⇒ 由 Leader 用 `task_update` 改声明。',
        ],
      });
    }
    // P1 内容面（**全局生效**）：**audit 的判据来源内容校验**——其 `consume` 中的
    //   plan 层产物至少有一份正文含裸标题行 `## 验收标准`（与 `GATE_PLAN_CONTRACT` 同判据）；否则拒派
    //   `GATE_AUDIT_CRITERIA_MISSING`。建批期已锚定「存在 plan 产物」；本层补「该产物真的带验收标准」——
    //   路径锚上而内容是空壳/跑题 ⇒ audit 仍无标准可依（长跑根因 R1 的另一半）。
    if (t.layer === 'audit') {
      const planProducts = new Set<string>();
      for (const w of batch.wavePlan ?? []) {
        for (const x of w.tasks ?? []) {
          if (x.layer !== 'plan') continue;
          for (const p of [...(x.produce ?? []), ...(x.outputs ?? [])]) planProducts.add(p);
        }
      }
      const isPlanProduct = (p: string) => (typeof p === 'string' && p.startsWith('plan/')) || planProducts.has(p);
      // A 方案（2026-09-14）：`criteria_from` **接消费**——声明存在时按其 glob **指名**锚点产物；
      //   缺省 → 回落既有口径（consume 中的 plan 层产物任一）。指名可消除「多份 plan 产物时判错对象」的隐患。
      const ac = flow?.audit_contract ?? null;
      const criteriaFrom = ac && typeof ac.criteria_from === 'string' && ac.criteria_from.trim() ? ac.criteria_from.trim() : null;
      const anchors = criteriaFrom
        ? consume.filter((p: string) => globMatchesPath(criteriaFrom, p))
        : consume.filter((p: string) => isPlanProduct(p));
      if (anchors.length === 0) {
        return reject({ code: 'GATE_AUDIT_INPUT_MISSING', problems: consume, ...(criteriaFrom ? { criteriaFrom } : {}) });
      }
      // ── 判据章节名（**配置化**，2026-09-21 用户裁定「判据改为全中文，且配置化」）──────────────
      //   取值优先序：① `flow.audit_contract.criteria_section`（声明面，本轮新增键）
      //             ② 回落引擎基线 `ENGINE_BASELINE_CRITERIA_SECTION`（全中文，单一真源）
      //   ⇒ 规格与判据解耦：团队若用英文章节名（如 `## Acceptance Criteria`），声明即可，代码零改动。
      const criteriaSection = ac && typeof ac.criteria_section === 'string' && ac.criteria_section.trim()
        ? ac.criteria_section.trim()
        : ENGINE_BASELINE_CRITERIA_SECTION;
      const problems: string[] = [];
      let okAnchor = false;
      for (const p of anchors) {
        try {
          if (fs.readFileSync(resolveArtifact(sessionId, batchId, p), 'utf8').includes(criteriaSection)) { okAnchor = true; break; }
          problems.push(p + ' lacks "' + criteriaSection + '"');
        } catch { problems.push(p + ' unreadable'); }
      }
      if (!okAnchor) {
        // 【2026-09-27 用户裁决 · 运行时回调指引】拒的同时给出「怎么做」（同 GATE_PLAN_CONTRACT 段说明）
        return reject({
          code: 'GATE_AUDIT_CRITERIA_MISSING',
          problems: [
            ...problems,
            '【怎么做】audit lane 的判据源只能是 **plan 层产物**（本 lane `consume` 里 `plan/` 前缀的件），'
            + '其正文须含裸标题行 `' + criteriaSection + '`（**行首恰为该串**，非 `###`、无编号前缀）。'
            + ' plan 产物缺它 ⇒ **回 plan 层补该标题**（内容可空），**不得在本 lane 自造判据**。',
          ],
        });
      }
    }
    // 放行侧回传（P1 交接门）：`handoffLegacy` = 存量批标记——写端（`store.setMember`）据此落
    //   `lane.handoff.gap{legacy:true}` 告警（不静默、不砸存量）。**仅新增本键**：其余放行载荷逐字不变。
    // R1 词表 E1 放行侧载荷（`vocabNote`）：`{}` = 零感知；有停用词条命中 ⇒ `escapes[{kind:'vocabulary-restated'}]`；
    //   词表不可用 ⇒ `escapes[{kind:'vocabulary-unavailable'}]` + `vocabCode:'GATE_VOCAB_INVALID'`（告警级，不拒批）。
    //   形态为 `escapes[]` **多值通道** ⇒ 与其它分支自带的单值 `escape`（`standalone` / `idle-recovery-passthrough`）
    //   互不覆盖：两态可同时成立且各自可归因（写端消费两者）。
    return { ok: true, lane, handoffLegacy: hvLegacy, ...(cmEntry ?? {}), ...vocabNote };
  }
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
  // 命令 gate（V1）：exec 层产物声明行 `gate: <命令>` → merged 前置确定性执行 → 退出码判定
  // 签名与既有门禁一致（batch 显式传入，不持有状态）；执行器经 deps.runCommand 注入（DI，默认真实执行器，测试可注入 mock）
  // cwd 契约：lane worktree 根（若已建）→ GATE_REPO_ROOT（批次 repo 根配置，V1 env 注入）→ artifacts 根兜底
  function commandCwd(sessionId: string, batchId: string, lane: string) {
    const wt = path.join(sessionDir(sessionId), 'worktrees', batchId, lane);
    try { if (fs.statSync(wt).isDirectory()) return wt; } catch { /* 未建 worktree，继续 */ }
    const repoRoot = process.env.GATE_REPO_ROOT;
    if (repoRoot) { try { if (fs.statSync(repoRoot).isDirectory()) return repoRoot; } catch { /* 无效则跳过 */ } }
    return artifactsDirOf(sessionId, batchId);
  }
  function checkCommandGate(
    sessionId: string, batchId: string, batch: Batch, lane: string,
    deps: { runCommand?: typeof runCommand } = {},
  ) {
    // 总开关（GATE_ENABLED=false → 全部零感知，应急逃生阀）
    // S15（本批）：env 阀**保留**（应急必需），但命中时补 `escape{kind:'env-gate-disabled', gate:'command'}`
    //   载荷留痕（原留痕只在 `lib/index.js:117-119` 启动级 warn，🔴 域外不可改）⇒ 从启动日志升级为批次事件。
    if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') {
      return {
        ok: true, declared: false,
        escape: {
          kind: 'env-gate-disabled', gate: 'command', lane,
          reason: 'GATE_ENABLED=false（应急逃生阀）⇒ 命令门零感知放行（判定不变）＋留痕',
        },
      };
    }
    const t = taskOf(batch, lane);
    // S16（本批，**唯一行为扩张项**）：作用层由 `exec` 放宽到 **`exec ∪ audit`**——「验收侧自证命令不可执行」
    //   = 自证无效 ⇒ 假完成通道。K3 缓解三条：① `runCommand` 只读黑名单先行（`command-exec.js`，不改文件/
    //   不重定向的命令才可执行）；② 新语义只对新批生效（旧批已终态，不重跑 merged）；③ 反例由 e3 覆盖
    //   （R-23：黑名单命令不执行且拒 `GATE_EXIT_FORBIDDEN`）。
    if (!t || (t.layer !== 'exec' && t.layer !== 'audit')) return { ok: true, declared: false };
    // 声明开关 `flows.exec.gate_command`——**团队级**开关（设计 §2.8 S16 原文：「显式 false 则**本团队**
    //   不执行命令 gate」）⇒ exec / audit 两层的命令门一并跳过；缺声明 ⇒ 引擎基线启用（enabledByFlag strictDefault=true，非回落旧口径）。
    const efCommand = flowOf(flowsOf(batch).flows, 'exec');
    // B2（§8⑤ **P-4** gate_command）：命令门开关**未声明**（`flagOf(execFlow,'gate_command') === null`）⇒
    //   引擎基线启用 ⇒ 产首触载荷；**显式 false** 已有独立 `escape{kind:'command-declared-off'}` 面（下方分支不挂钩）。
    const cmCommand = flagOf(efCommand, 'gate_command') === null
      ? contractMissingPayload(
        'gate_command', 'exec', 'engine:enabledByFlag(gate_command,true)', 'gate-command-engine-default-enabled',
        '团队资产未声明 flows.exec.gate_command ⇒ 引擎基线启用（缺声明不得放宽）；本事件为首触留痕，不改判定',
      )
      : null;
    if (!enabledByFlag(efCommand, 'gate_command', true)) return { ok: true, declared: false, disabledBy: 'team-asset:gate_command' };
    // produce ∪ outputs 并集（去重保序）
    const fields = [...new Set([...(t.produce ?? []), ...(t.outputs ?? [])])];
    const det = detectGate(artifactsDirOf(sessionId, batchId), fields);
    // ── C3 词表（R1 §2.4 #2）────────────────────────────────────────────────────────────────────
    // 位置（冻结）：`detectGate` 之后、`emptyCommand` 首判**之前** ⇒ 「`gate:` 未声明」与「`reason:` 未登记」
    //   两件事**各判各的**（后者不因前者早退而被遮蔽）。
    // 判据面 = 本 lane 的 `produce ∪ outputs`（`fields`，与 `gate:` 行族同扫描面）；判定调 E1 的**同一函数**
    //   `reasonVocabularyVerdict`（单点，禁两套口径）。未登记 ⇒ 拒 `GATE_TOKEN_UNKNOWN`；
    //   停用条目 ⇒ 放行 + `restated` 告警；词表不可用 ⇒ fail-open 降级留痕（`GATE_VOCAB_INVALID`，**不拒批**）。
    const vocabC3 = reasonVocabularyVerdict(artifactsDirOf(sessionId, batchId), fields, vocabOpts);
    const vocabNote = reasonVocabularyNote(vocabC3);
    if (!vocabC3.ok) {
      const first = vocabC3.unknown[0];
      // 载荷形状对齐既有失败分支（写端 `store.js` 读 `code` / `command` / `exitCode` / `detail` /
      //   `needHumanEscalation`）⇒ `detail` 必填，否则抛错文案退化为 'command gate failed'（不可读）。
      return {
        ok: false, code: 'GATE_TOKEN_UNKNOWN', lane, declared: false,
        command: null, exitCode: null, needHumanEscalation: false, path: first.path,
        token: first.token, source: 'reason',
        detail: first.path + ' 声明未登记的 reason token "' + first.token + '"（词表未登记 ⇒ 拒：Q-3=B 只对**新增写点**强制注册）',
        problems: vocabC3.unknown.map((u) => u.path + ' declares unregistered reason token "' + u.token + '"'),
      };
    }
    // S-F7（**首位判定**）：空 `gate:` 行 ⇒ 「已声明 + 命令解析为空」⇒ 拒 GATE_EXIT_NO_COMMAND。
    //   必须在 `!det.declared` 早退**之前**判定——否则空声明会与「完全未声明」同路零感知。
    //   `declared: true` 是刻意的：空声明**确实声明了**（`path` 带上便于返工定位；载荷与下文原分支逐字一致）。
    if (det.emptyCommand) {
      return {
        ok: false, code: 'GATE_EXIT_NO_COMMAND', command: null, exitCode: null,
        declared: true, needHumanEscalation: false, path: det.emptyCommand,
        detail: 'gate 行命中但命令解析为空（防空命令假通过）',
      };
    }
    if (!det.declared) {
      // S17（本批）：**显式禁用**（独立行 `gate: false`）与「未声明」两态可区分——前者补留痕，
      //   两者判定**相同**（皆放行）。
      // 【历史痕迹 · 审计追溯】本条注释原写「命令解析为空仍走下方 `GATE_EXIT_NO_COMMAND`（**不加宽**）」：
      //   该防护**曾长期不可达**（`GATE_LINE_RE` 的 `(.+)` 不命中空声明行 ⇒ `declared === false` 早退遮蔽了
      //   下方分支 ⇒ 死码从未执行），属「说已防护、实未防护」的注释漂移；**F-7 起该防护真正生效**——
      //   空声明已在上方 `emptyCommand` 首判短路为拒。本分支自此只承接「完全未声明」与「`gate: false` 显式
      //   禁用」两态，二者皆零感知放行（判定不变）。
      const off = detectGateOff(artifactsDirOf(sessionId, batchId), fields);
      if (off.declared) {
        return {
          ok: true, declared: false,
          escape: {
            kind: 'command-declared-off', lane, path: off.path,
            reason: '产物含独立行 `gate: false`（显式禁用声明）⇒ 命令门零感知放行（判定不变）＋留痕',
          },
          // R1 C3 放行侧载荷（`escapes[]` 多值通道，与上方单值 `escape` 互不覆盖）：两态可同时成立
          //   （既显式禁用 `gate:`、产物又声明停用词条 / 词表不可用）⇒ 两条留痕各自可归因。
          ...vocabNote,
          ...(cmCommand ?? {}),
        };
      }
      return { ok: true, declared: false, ...(cmCommand ?? {}), ...vocabNote }; // 未声明 gate → 零感知（判定不变）+ 首触留痕
    }
    // S-F7：本位置原为 `if (det.commands.length === 0) return { code:'GATE_EXIT_NO_COMMAND' }` 三行——
    //   该分支**恒不可达**（`declared === commands.length > 0` ⇒ 到达此处 `commands.length` 必 > 0，
    //   被上方 `!det.declared` 早退完全遮蔽）⇒ 死码即假防护（留着会被读成「已防护」），已删；
    //   空声明的拒载改由上方 `emptyCommand` 首判承担。
    const run = deps.runCommand ?? runCommand;
    const results: Array<{ command: string; exitCode: number | null; durationMs: number }> = [];
    let failed: { code: string; command: string; exitCode: number | null; detail: string } | null = null;
    let outputTruncated = false;
    for (const command of det.commands) {
      const r = run({ command, cwd: commandCwd(sessionId, batchId, lane) });
      if (r.truncated) outputTruncated = true;
      const res = { command, exitCode: r.exitCode ?? null, durationMs: r.durationMs ?? 0 };
      results.push(res);
      if (r.forbidden) { failed = { code: 'GATE_EXIT_FORBIDDEN', command, exitCode: null, detail: '黑名单命中（只读守卫，不执行）' }; break; }
      if (r.timedOut) { failed = { code: 'GATE_EXIT_TIMEOUT', command, exitCode: res.exitCode, detail: '命令超时（重试后仍超时）' }; break; }
      if (r.error && r.error.startsWith('GATE_EXIT_SPAWN_FAIL')) { failed = { code: 'GATE_EXIT_SPAWN_FAIL', command, exitCode: null, detail: r.error }; break; }
      if (r.error === 'GATE_EXIT_NO_COMMAND') { failed = { code: 'GATE_EXIT_NO_COMMAND', command, exitCode: null, detail: r.error }; break; }
      if (!r.ok) { failed = { code: 'GATE_EXIT_NONZERO', command, exitCode: res.exitCode, detail: '退出码 ' + res.exitCode + '（非 0，重试后仍失败）' }; break; }
    }
    if (failed) {
      // 失败且产物同时声明 needHuman → 转人工闸（不抛错，store 接线转 checkNeedHumanGate 语义）
      const nh = detectNeedHuman(artifactsDirOf(sessionId, batchId), fields);
      return { ok: false, ...failed, declared: true, needHumanEscalation: nh.declared, path: det.path };
    }
    return { ok: true, declared: true, commands: det.commands, results, outputTruncated, path: det.path, ...(cmCommand ?? {}), ...vocabNote };
  }
  // targets 门禁：exec 层 lane 声明 targets（批次产物根外目标文件绝对路径）→ merged 前置校验
  // 每个 target：①存在性（statSync 为文件；缺失/目录 → missing）；②变更性——mtime 晚于 lane 变更性基线（laneStartedAt：排除 idle 空闲态重派）
  // （默认 mtime 路径），或 marker 逃生（任务级 targetsMarker 非空 或 env GATE_TARGETS_MODE==='marker' →
  // 目标文件内容含独立行 `targets-claimed: true` 即视为已变更，跳过 mtime 比对，两模式不叠加）；
  // 未声明 targets / 非 exec 层 / GATE_ENABLED=false → 零感知（{ ok: true, declared: false }，与 checkCommandGate 对称）。
  // 判定：missing 非空 → { ok:false, code:'GATE_TARGET_MISSING', missing }；unchanged 非空 →
  // { ok:false, code:'GATE_TARGET_UNCHANGED', unchanged }；全过 → { ok:true, declared:true, mode:'mtime'|'marker' }。
  // 诚实披露：mtime/marker 均为低成本实证（非密码学证据），防「口头声称零成本通过」；恶意伪造归人工审计。
  function checkTargetsGate(sessionId: string, batchId: string, batch: Batch, lane: string) {
    // 总开关（GATE_ENABLED=false → 全批零感知，应急逃生阀，与 checkCommandGate 同源）
    // S15（本批）：env 阀保留，命中补 `escape{kind:'env-gate-disabled', gate:'targets'}` 留痕（判定不变）。
    if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') {
      return {
        ok: true, declared: false,
        escape: {
          kind: 'env-gate-disabled', gate: 'targets', lane,
          reason: 'GATE_ENABLED=false（应急逃生阀）⇒ targets 门零感知放行（判定不变）＋留痕',
        },
      };
    }
    const t = taskOf(batch, lane);
    if (!t || t.layer !== 'exec' || !Array.isArray(t.targets) || t.targets.length === 0) {
      return { ok: true, declared: false }; // 未声明 / 非 exec 层 → 零感知
    }
    // gate-lite Q-G1：冒烟/探针批 ⇒ 跳过 targets 门（存在性/变更性都属产物契约类）；
    //   留痕 `disabledBy` 使「为什么这个 smoke 批没跑 targets」在返回值里可读（与既有 disabledBy 同形）。
    if (smokeOf(batch)) return { ok: true, declared: false, disabledBy: 'batch:smoke' };
    // 声明开关 flows.exec.targets——显式 false 则跳过 targets 校验（存在性+变更性）；缺声明 ⇒ 引擎基线启用（enabledByFlag strictDefault=true，非回落旧口径）
    // S18（本批）：团队级关闭**保留**（判定不变），但补 `escape{kind:'targets-off'}` 载荷留痕（零静默）；
    //   `targetsNoChange` / marker 两个**任务级**显式声明保持不动（既有 `mode` 留痕留待 `gate.target.passed`）。
    const efTargets = flowOf(flowsOf(batch).flows, 'exec');
    // B2（§8⑤ **P-5** targets）：targets 开关**未声明**（`flagOf(execFlow,'targets') === null`）⇒ 引擎基线启用
    //   ⇒ 产首触载荷；**显式 false** 已有独立 `escape{kind:'targets-off'}` 面（下方分支不挂钩）。
    const cmTargets = flagOf(efTargets, 'targets') === null
      ? contractMissingPayload(
        'targets', 'exec', 'engine:enabledByFlag(targets,true)', 'targets-engine-default-enabled',
        '团队资产未声明 flows.exec.targets ⇒ 引擎基线启用（缺声明不得放宽）；本事件为首触留痕，不改判定',
      )
      : null;
    if (!enabledByFlag(efTargets, 'targets', true)) {
      return {
        ok: true, declared: false, disabledBy: 'team-asset:targets',
        escape: {
          kind: 'targets-off', lane,
          reason: '团队资产显式声明 flows.exec.targets=false ⇒ targets 门停用（放行判定不变）＋留痕',
        },
      };
    }
    const startAt = laneStartedAt(batch, lane);
    const startMs = Date.parse(startAt);
    const markerMode = (typeof t.targetsMarker === 'string' && t.targetsMarker.length > 0)
      || String(process.env.GATE_TARGETS_MODE).toLowerCase() === 'marker';
    // 缺口修复：零改动声明（task.targetsNoChange === true）→ 只核目标存在性，跳过"变更性"判定；
    //   留痕 mode='no-change' + skippedChange=true（gate.target.passed 事件随 mode 落盘，可审计谁声明了零改动）。
    const noChange = t.targetsNoChange === true;
    const modeOf = () => (noChange ? 'no-change' : (markerMode ? 'marker' : 'mtime'));
    const missing: string[] = [];
    const unchanged: string[] = [];
    for (const target of t.targets) {
      let st;
      try { st = fs.statSync(target); } catch { missing.push(target); continue; }
      if (!st.isFile()) { missing.push(target); continue; } // 目录/非文件视同缺失（与 detectNeedHuman 文件判定同源）
      if (markerMode) {
        let claimed = false;
        try {
          claimed = TARGETS_CLAIMED_RE.test(fs.readFileSync(target, 'utf8'));
        } catch { /* 读失败 → 视为未声明（fail-closed，落到 unchanged） */ }
        if (claimed) continue; // 标记命中 → 视为已变更（跳过 mtime 比对）
        unchanged.push(target);
        continue;
      }
      // mtime 主路径（默认）：目标文件 mtime 必须晚于 lane 变更性基线（laneStartedAt：最近一条**非 idle 空闲态重派**的
      // running 启动——review→running 返工重置基准；idle→running 恢复重派不后移基线，详见 laneStartedAt 注释）
      if (noChange) continue; // 零改动声明 → 只核存在性（上面 missing 分支已排除缺失）
      const mtimeMs = new Date(st.mtime).getTime();
      if (!(Number.isFinite(mtimeMs) && Number.isFinite(startMs) && mtimeMs > startMs)) unchanged.push(target);
    }
    if (missing.length > 0) {
      return { ok: false, declared: true, code: 'GATE_TARGET_MISSING', missing, unchanged: [], mode: modeOf(), targets: [...t.targets] };
    }
    if (unchanged.length > 0) {
      return { ok: false, declared: true, code: 'GATE_TARGET_UNCHANGED', missing: [], unchanged, mode: modeOf(), targets: [...t.targets] };
    }
    return { ok: true, declared: true, missing: [], unchanged: [], mode: modeOf(), skippedChange: noChange, targets: [...t.targets], ...(cmTargets ?? {}) };
  }
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
  // 门禁强度摘要（原则②的载体）：**只增不改** —— 纯只读视图，不参与任何门禁判定
  function gateStrengthOf(batch: Batch) {
    const layers = layersOf(batch);
    const flows = flowsOf(batch).flows;
    const layerFlow = (l: Layer) => flowOf(flows, l);
    const declaredProduce: Record<string, string | null> = {};
    // G-2（本批）：`entryRequires` 改读**单一读端** `entryRequiresOf(flow)` ⇒ 对象
    //   `{enforced, declared, values, source}`（**形态变化面**：原为 `string[]` 直读 `f.entry_requires`）。
    //   `lib/**` 内除本文件无消费点（grep 可核）；`test/**` 若断言该字段由 e3 同步。
    const entryRequires: Record<string, Record<string, unknown>> = {};
    for (const l of ['plan', 'exec', 'audit'] as Layer[]) {
      const f = layerFlow(l);
      declaredProduce[l] = f && typeof f.produce_field === 'string' ? f.produce_field : null;
      entryRequires[l] = entryRequiresOf(f) as Record<string, unknown>;
    }
    const af = layerFlow('audit');
    const ef = layerFlow('exec');
    // 【2026-09-28 · 批 `cleanup-tail-20260927` E-3】原 `ac`（`af.audit_contract` 提取）随下方恒不可达三元同批删除：
    //   资产面退役 ⇒ `flows` 恒 `null` ⇒ `af` 恒 `undefined` ⇒ `ac` 恒 `null` ⇒ 该变量**只服务恒 `null` 的三元**
    //   ⇒ 删三元后成死码，一并清除（`af` / `ef` 仍被下方 `disabled` 判据消费，保留）。
    const disabled: string[] = [];
    if (af && af.needhuman === false) disabled.push('needhuman@team-asset');
    if (ef && ef.gate_command === false) disabled.push('gate_command@team-asset');
    if (ef && ef.targets === false) disabled.push('targets@team-asset');
    if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') disabled.push('all-gates@env');
    const evs = (batch.events ?? []) as Array<{ type?: string; kind?: string }>;
    // V-4 读端单点化（本批）：事件名比较改引 `EVT` 常量（原为字节字面量 'gate.escape' / 'gate.degrade'）
    const escapes = evs.filter((e) => e && e.type === EVT.EVT_GATE_ESCAPE).map((e) => ({ kind: typeof e.kind === 'string' ? e.kind : null }));
    const degrades = evs.filter((e) => e && e.type === EVT.EVT_GATE_DEGRADE).map((e) => ({ kind: typeof e.kind === 'string' ? e.kind : null }));
    const outcomes = completeOutcomesOf(batch);
    return {
      level: layers.exec.length === 0 && layers.audit.length === 0 ? 'none' : 'strict',
      lanes: { plan: layers.plan.length, exec: layers.exec.length, audit: layers.audit.length },
      // G-2（本批）：被检面改读**单一读端** `produceFieldsOf(flow, layer)`（恒 `['produce','outputs']` 并集）——
      //   **形态变化面**：原为恒字面量串 `'produce∪outputs'`，现为数组（语义逐字相同：声明只能收窄不得放宽）。
      // S19①（判据同源）：`consumeField` 与 entry 检面同用 `consumeFieldOf`（缺声明回落 `'consume'`）。
      produceField: {
        plan: [...(produceFieldsOf(layerFlow('plan'), 'plan') as string[])],
        exec: [...(produceFieldsOf(layerFlow('exec'), 'exec') as string[])],
        audit: [...(produceFieldsOf(layerFlow('audit'), 'audit') as string[])],
      },
      produceFieldDeclared: declaredProduce,
      entryRequires,
      consumeField: {
        exec: consumeFieldNameOf(flows, 'exec'),
        audit: consumeFieldNameOf(flows, 'audit'),
      },
      escapes,
      degrades,
      disabled,
      // S19② / S20：未接线声明改读**台账**（原为硬编码 4 项 ⇒ 与台账双源；台账更新不会生效）
      unwired: unwiredEntriesOf(batch),
      evaluatedAt: ['running', 'merged'],
      orphanProducts: orphanProductsOf(batch),
      emptyNoted: [],
      // 【2026-09-28 · 批 `cleanup-tail-20260927` E-3】原三元（`ac ? { … } : null`，其 `source` 值指向
      //   **团队资产**来源）已删：资产面退役 ⇒ `flows` 恒 `null` ⇒ `af`/`ac` 恒 `undefined`/`null`
      //   ⇒ 该三元**恒走 `null` 支**（恒不可达分支），其「团队资产」来源标注**恒不产生**
      //   ⇒ 键保形保留、值恒 `null`。
      auditContract: null,
      completeOutcomes: outcomes,
      completeSemantics: 'Q-7：complete = 执行完成且通过验收 ⇒ 仅 pass / skip 可 complete；fail / conflict 恒拒且带 escapeRoute{phase:"aborted"}（D-8 终态可退出）',
    };
  }
  // 门禁状态查询（gate_status 工具用）：lane 的 layer/契约字段/缺失清单/plan 契约问题。
  // 【TD-21 / N-13（2026-09-18 清理波）】读放大收敛——三个入口共用**同一 lane 计算实现**（`gateStatusOfLane`，
  //   单点，禁第二份判定），差别**只在读盘次数**：
  //     · `gateStatus`            = **兼容外壳**（逐 lane 调用方）：1 次读批 → 单 lane 视图；签名/返回形状/
  //                                  语义/抛错面**逐字不变**（`gate_status` 工具与 lib/tools/core.js 零改动）；
  //     · `gateStatusOfBatch`     = **批级入口**（1 次读批）→ `{lane: gateView}`，键序同 `batch.lanes`；
  //     · `gateStatusMapOfBatch`  = 批级入口的**对外稳定名**（`store.js` 暴露 / `api.js` 消费），返回**普通
  //                                  对象而非 `Map`**——响应键须 `[lane]` 可索引且 JSON 序列化键序与改前
  //                                  （`Object.fromEntries(Object.keys(b.lanes).map(...))`）逐字一致。
  //   回归锁（`test/api-batch-keys.test.js`）：P-2 = 批级视图逐 lane 与 `gateStatus` **深比较全等**；
  //   P-3 = 批级一次读（`fs.readFileSync` 计数：投影段 1 次，且不随 lane 数增长）。
  function gateStatus(sessionId: string, batchId: string, lane: string) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) {
      // 损坏批次（文件存在但解析失败）→ 返回 corrupt 视图不 throw（读路径不 throw）；不存在 → throw
      if (fs.existsSync(batchFile(sessionId, batchId))) {
        return { lane, layer: null, state: null, team: null, corrupt: true, consume: [], produce: [], outputs: [], consumeMissing: [], outputsMissing: [], produceMissing: [], contractProblems: null, targets: [], targetsMissing: [], targetsUnchanged: [] };
      }
      throw new Error('batch not found: ' + batchId);
    }
    return gateStatusOfLane(sessionId, batchId, batch, lane);
  }

  // 单 lane 门禁视图（**已读批**：批对象由调用方传入 ⇒ 本函数零读盘）。三个入口的唯一计算实现。
  function gateStatusOfLane(sessionId: string, batchId: string, batch: Batch, lane: string) {
    const t = taskOf(batch, lane);
    // B2：lane 在 batch.lanes 但不在 wavePlan.tasks ⇒ 状态损坏，显式报 orphan（不再退化为 'generic'）
    if (!t) {
      return {
        lane, layer: null, state: batch.lanes[lane], gates: 'orphan', team: batch.team,
        consume: [], produce: [], outputs: [], consumeMissing: [], outputsMissing: [], produceMissing: [],
        contractProblems: null, targets: [], targetsMissing: [], targetsUnchanged: [],
        gateStrength: gateStrengthOf(batch),
        vocabulary: vocabularyViewOf(vocabOpts),
      };
    }
    // 面板与门禁同源（原则②）：缺失判定改走 presenceJudge（形态二分 + 0 字节 + 空内容通道），
    //   消除「面板说缺产物、门禁却放行」的不一致（gates.js 旧 fileExistsNonEmpty 的目录视同存在语义）。
    const missing = (field: TaskArrayField) => {
      const list: string[] = Array.isArray(t[field]) ? (t[field] as string[]) : [];
      return list.filter((p: string) => !presenceOfArtifact(sessionId, batchId, t.layer ?? null, p).ok);
    };
    const contract = t.layer === 'plan' ? checkPlanContract(sessionId, batchId, batch, lane) : null;
    // targets 探测：声明清单 + 缺失清单 + 未变更清单——仅 stat（存在性 + mtime 路径），
    // 不读文件正文（marker 命中判定留给门禁执行时，避免 gate_status 读文件成本，见 design Open Question 3）
    const targets: string[] = Array.isArray(t.targets) ? [...t.targets] : [];
    const startAt = laneStartedAt(batch, lane);
    const startMs = Date.parse(startAt);
    const statFile = (p: string): fs.Stats | null => { try { const st = fs.statSync(p); return st.isFile() ? st : null; } catch { return null; } };
    const targetsMissing = targets.filter((p: string) => statFile(p) === null);
    const targetsUnchanged = targets.filter((p: string) => {
      if (targetsMissing.includes(p)) return false;
      const st = statFile(p);
      if (!st) return true; // 探测竞态：stat 失败视同未变更（保守）
      const mtimeMs = new Date(st.mtime).getTime();
      return !(Number.isFinite(mtimeMs) && Number.isFinite(startMs) && mtimeMs > startMs);
    });
    return {
      lane, layer: t.layer ?? null, state: batch.lanes[lane], team: batch.team,
      gates: t.layer ? 'in-plan' : 'no-layer',
      consume: t.consume ?? [], produce: t.produce ?? [], outputs: t.outputs ?? [],
      consumeMissing: missing('consume'), outputsMissing: missing('outputs'), produceMissing: missing('produce'),
      contractProblems: contract && !contract.ok ? contract.problems : null,
      targets, targetsMissing, targetsUnchanged,
      gateStrength: gateStrengthOf(batch),
      // R1 §2.4 #6：词表**只读展示位**（恰好 `{loaded,version,source}` 三键）——**不参与任何判定**：
      //   面板据此显示「本批判定所依的词表是否加载成功 / 版本 / 来源」，不得据此放行或拒绝任何 lane。
      //   词表不可用（fail-open 侧）⇒ `loaded:false` + 两 null（与词表门 E1/C3 的降级口径同源）。
      vocabulary: vocabularyViewOf(vocabOpts),
    };
  }

  // 批级门禁视图（TD-21 / N-13）：**一次读批** → `{lane: gateView}`（键序 = `batch.lanes` 键序）。
  // 读路径语义与 `gateStatus` 同口径（`readBatch` 私有单点）：不存在 ⇒ throw；损坏批 ⇒ 空视图
  //   （批级无 lane 名可枚举；逐 lane 口径下的 corrupt 视图仍由 `gateStatus` 提供，二者不冲突）。
  function gateStatusOfBatch(sessionId: string, batchId: string) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) {
      if (fs.existsSync(batchFile(sessionId, batchId))) return {};
      throw new Error('batch not found: ' + batchId);
    }
    const view: Record<string, ReturnType<typeof gateStatusOfLane>> = {};
    for (const lane of Object.keys(batch.lanes ?? {})) view[lane] = gateStatusOfLane(sessionId, batchId, batch, lane);
    return view;
  }

  // 对外稳定名（`store.js` 暴露 / `api.js:138` 消费）：与 `gateStatusOfBatch` **同一实现、同一次读批**，
  //   不重复实现、不重复读盘（批级读放大收敛的对外契约名）。
  function gateStatusMapOfBatch(sessionId: string, batchId: string) {
    return gateStatusOfBatch(sessionId, batchId);
  }

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
    // ① 有无下游（禁猜：只按 wavePlan 的静态声明判定）
    const t = taskOf(batch, lane);
    const downstream: string[] = [];
    for (const w of batch.wavePlan ?? []) {
      for (const x of w.tasks ?? []) {
        if (!x || typeof x.id !== 'string' || x.id.length === 0 || x.id === lane) continue;
        const deps = Array.isArray((x as unknown as { deps?: unknown }).deps) ? ((x as unknown as { deps?: unknown }).deps as unknown[]) : [];
        if (deps.some((d) => d === lane)) downstream.push(x.id);
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
    const evidence = typeof note === 'string' ? (note.match(/^human:.+/m) ?? [null])[0] : null;
    if (evidence) return { ok: true, code: null, missing: [], problems: [], downstream, humanException: true };
    missing.unshift('handoff:' + lane + '->(' + downstream.join('/') + ')');
    problems.unshift('lane ' + lane + ' 在 DAG 中有下游（' + downstream.join('/') + '）但**无一条已成立交接**'
      + '（`handoff_submit` 须 status=submitted + artifacts 逐个在场 + contract{consumedFrom,assertions} 合规）'
      + ' ——Leader 例外：merged 的 note 含 `human:<裁决人>:<时间>:<结论>` 可放行并留痕');
    return { ok: false, code: 'GATE_HANDOFF_MISSING', missing, problems, downstream };
  }

  // TD-21 / N-13：`gateStatus`（兼容外壳）+ 两个批级入口（`gateStatusOfBatch` / `gateStatusMapOfBatch`）同面导出。
  return { checkEntryGate, checkPlanContract, checkExitGate, checkNeedHumanGate, checkCommandGate, checkTargetsGate, checkCompleteGate, checkSettleHandoffGate, gateStatus, gateStatusOfBatch, gateStatusMapOfBatch, teamAssetViewOf, presenceJudge };
}
