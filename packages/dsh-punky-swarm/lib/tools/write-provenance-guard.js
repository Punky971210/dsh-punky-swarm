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

// 写族溯源守卫（S3 执行层，**单点**）：19 件写族工具在**缺溯源证据**时拒绝执行。
//
// ── 拒态形态（**本仓实测，禁用 throw**）────────────────────────────────────────────
//   `@deepseek-ai/dsh-tools/lib/index.js:2916-2927` doc 原文：
//     「`@param guard` - synchronous check; **a returned string denies the execution**」
//   消费路径 `:3241-3254`：首个 non-undefined 字符串 ⇒ 转 `kind:'post-result'` 的
//   `{ content:[{type:'text', text:'Error: ' + reason}], isError:true, error:{ message: reason } }`。
//   ⇒ **`execute` 根本不执行**（在 dispatch 之前返回）、**宿主不注入 `err.code`**、前缀原样保留给模型看。
//   ⚠ **禁 `throw`**：守卫在 `guardReason` 的 `try` 内被调用，`throw` 会被外层 `catch`（`:3265-3272`）
//     转成 `final-result` + `toolErrorResult(error)` —— **另一条路径**，丢失 `post-result` 的确定性语义。
//     ⇒ 唯一正确写法是 **`return '<拒绝字符串>'`**。
//
// ── 来源优先级（**无 L3**）───────────────────────────────────────────────────────
//   L1 `execution.arguments?.sourceRunId`（非空字符串） ＞ L2 `execution.agent?.session?.id`（非空字符串）
//   **禁**从 `batchId` / `laneId` / 任何其它字段推导 —— **未知就是未知，不猜**。
//   `batchId`/`laneId` 在场也不能当溯源证据：它们是**执行位置**，不是**来源**。
//
// ── 与难度门禁的关系：**并列、不合并**───────────────────────────────────────────
//   本守卫只回答「这次写有没有来源证据」；难度/权限/模式门归 `tier-gate.js` 的 `installDifficultyGuard`。
//   两者在 `register.js` **并列注册**；本文件**不碰** `tier-gate.js`（合并会让两个判据互相掩盖）。
import { SUITE_TOOLS } from '../engine/suite.js';

/** 宿主面 5 件：**不在** 19 写族内 ⇒ 自然豁免（本仓无其 schema，无法要求溯源）。 */
export const HOST_EXEMPT = Object.freeze([
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'send_message',
  'interrupt_agent',
]);

/**
 * 19 件写族。**由 `suite.js` 派生**（`write === true` 共 24 件）**再减宿主 5 件** = 19，
 * 所以本常量不会随工具面增删而漂移（派生 ≠ 手抄）。
 */
export const WRITE_FAMILY = Object.freeze(
  SUITE_TOOLS.filter((tool) => tool.write === true && !HOST_EXEMPT.includes(tool.name)).map((tool) => tool.name),
);

const WRITE_FAMILY_SET = new Set(WRITE_FAMILY);

/** 拒态前缀（模型可见，宿主原样保留）。 */
export const SOURCE_RUN_ID_MISSING = 'source-run-id-missing:';

/** 已安装上下文（幂等；用 WeakSet 而非改 `ctx`，不污染调用方对象）。 */
const installedOn = new WeakSet();

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * 判定单次调用。**纯函数**：`string` = 拒绝（宿主据此短路），`undefined` = 放行。
 *
 * @param {object} execution 宿主传入门禁的调用面：`{ name, arguments?, agent? }`
 * @returns {string|undefined} 拒绝字符串（前缀 `source-run-id-missing:` + 工具名）或 `undefined`
 */
export function writeProvenanceDecision(execution) {
  const name = execution?.name;
  // ① 非写族（含宿主 5 件、读工具、治理工具）⇒ 不在本守卫判据域内，放行
  if (typeof name !== 'string' || !WRITE_FAMILY_SET.has(name)) return undefined;

  // ② L1：显式入参来源（最强证据）
  if (isNonEmptyString(execution?.arguments?.sourceRunId)) return undefined;

  // ③ L2：发起会话 id（兜底证据）
  if (isNonEmptyString(execution?.agent?.session?.id)) return undefined;

  // ④ 无 L3：**不**从 batchId / laneId / 其它字段推导 ⇒ 证据缺失即拒
  return SOURCE_RUN_ID_MISSING + ' ' + name;
}

/**
 * 注册守卫。与 `installDifficultyGuard` **并列**（不改它、不并入它）。
 *
 * @param {object} ctx 插件上下文（需 `ctx.tools.guard` 可调用；不可用时**静默不注册**并返回 false）
 * @param {object} [deps] 预留（本守卫不需要 store/config；保持与同族签名一致）
 * @returns {boolean} 本次是否真的注册了（幂等 ⇒ 重复调用返回 false）
 */
export function installWriteProvenanceGuard(ctx, deps = {}) {
  void deps; // 与同族签名对齐；本守卫不依赖 store / config
  if (typeof ctx?.tools?.guard !== 'function') return false;
  if (installedOn.has(ctx)) return false; // 幂等：同一 ctx 只注册一次
  ctx.tools.guard((execution) => writeProvenanceDecision(execution));
  installedOn.add(ctx);
  return true;
}
