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

// 产物声明/命令检测族 + 任务定位单点（纯函数，无闭包状态）——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。

import { isAbsPath } from '../constants.js';
// findTask 单点：收敛至 task-utils.js（原本地定义删除，调用点不变）
import { findTask } from '../task-utils.js';
import * as EVT from '../event-types.js';
import type { Batch, WavePlanTask } from '../../types/contracts.js';
import fs from 'node:fs';
import path from 'node:path';

// 局部类型化包装：findTask（task-utils.js，保持 JS）返回 object|null → 属性访问全报"属性不存在"。
// taskOf 为唯一断言点：findTask 遍历 batch.wavePlan[].tasks 按 t.id === lane 返回 buildWavePlan 持久形态任务
// → WavePlanTask 类型成立（运行期零变化，断言纯类型层）。
export function taskOf(batch: Batch | null, lane: string): WavePlanTask | null {
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
export type TaskArrayField = 'consume' | 'produce' | 'outputs';

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
export function contractMissingPayload(
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

export function detectGateOff(artifactsDir: string, paths: string[]) {
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

// ── L8 判据脚本信任锚：声明行族 + 命令行 token 切分（**纯函数/解析面**，零副作用）───────────────
// 声明面 = 产物内**独立行** `gate-script-sha256: <相对路径>=<64 hex>`（可多行，每脚本一行）——
//   与 `GATE_LINE_RE` / `GATE_EMPTY_LINE_RE` / `GATE_OFF_LINE_RE` **同族**（行首锚定 + 独立行；
//   内嵌/注释/非行首不误判）。
// 语义（判定侧在 `command.ts`，执行命令**之前**）：把「本产物引用的脚本内容」钉成 sha256 ⇒ 内容变更即**可判**。
//   **锚定值不是信任根**：它与脚本本体由同一写者可写 ⇒ 只证「自声明时刻起内容未变」，**不证声明者可信**
//   （一个先改脚本、再写自洽锚定值的写者本机制不拒）。⇒ 完整信任模型需**独立锚定值来源**（交接面契约，
//   不在本批）。本机制堵的是 `RED-4`：**声明之后**的任何内容变更 ⇒ 不一致 ⇒ 拒。
export const GATE_SCRIPT_SHA_RE = /^gate-script-sha256:[ \t]*(\S+?)[ \t]*=[ \t]*([0-9a-f]{64})[ \t]*$/gm;

/** 锚定键归一（**单点**）：反斜杠→`/`、剥前导 `./`、去尾 `/`。
 *  与 `command.ts` 侧「候选脚本键」**必须同一口径**（否则同一文件两处键不等 ⇒ 锚定永不命中）。 */
export function normalizeScriptKey(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// 锚定声明解析（同 detectNeedHuman 模式：缺失/空/目录跳过、零感知）：
// 遍历 produce/outputs 并集 → 收集 `路径=sha256` → `{anchors, path}`（path = 首个含锚定行的产物，供返工定位）。
// **同键取首**（后出现的同键行**不改判定**）⇒ 追加行无法覆盖既有锚定（防「后补一行翻案」）。
// 非法/非 64 hex/空键的行**不构成锚定**（`\S+?` + `[0-9a-f]{64}` 双约束）；重复声明不报错（幂等首取）。
export function detectScriptAnchors(artifactsDir: string, paths: string[]) {
  const anchors: Record<string, string> = {};
  let anchorPath: string | null = null;
  if (!Array.isArray(paths) || paths.length === 0) return { anchors, path: anchorPath };
  for (const p of paths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    GATE_SCRIPT_SHA_RE.lastIndex = 0; // /g 正则复用防 lastIndex 泄漏（与 GATE_LINE_RE 同法）
    let m;
    while ((m = GATE_SCRIPT_SHA_RE.exec(content)) !== null) {
      const key = normalizeScriptKey(m[1]);
      if (key.length === 0) continue;
      if (anchors[key] === undefined) anchors[key] = m[2].toLowerCase();
      if (!anchorPath) anchorPath = p;
    }
  }
  return { anchors, path: anchorPath };
}

// 命令行 token 切分（**纯字符串函数，零 IO**）：空白切分 + 去**成对**引号 + 跳过空 token 与选项 token（`-x`/`--x`）。
// 职责边界：本函数只做**候选抽取**；「是否真的是解析根下的普通文件」由调用方（`command.ts`）用 fs 判定
//   （解析根 = `commandCwd` 单点 ⇒ 本函数不持 root、不碰 fs）。⇒ `node -e '…'` 这类无文件形态的命令
//   恒零候选，命令门对它们**零感知**（连锚定文件都不读）。
export function scriptTokensOf(command: string): string[] {
  const out: string[] = [];
  if (typeof command !== 'string' || command.length === 0) return out;
  for (const raw of command.split(/\s+/)) {
    if (raw.length === 0) continue;
    let t = raw;
    const quoted = (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'));
    if (quoted && t.length >= 2) t = t.slice(1, -1);
    if (t.length === 0 || t.startsWith('-')) continue; // 选项不是文件候选
    out.push(t);
  }
  return out;
}

