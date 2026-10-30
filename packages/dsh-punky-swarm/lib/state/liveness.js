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

/**
 * `lib/state/liveness.js` —— I-10 **续跑上界**判定（采纳蓝图 B4）。
 *
 * ## 管什么（只有一件事）
 * 「这次活动性判定之后，**允不允许再续跑一次**」—— 一个**纯判定**：
 * 输入 `{ stopReason, continuationCount }`，输出 `{ continueAllowed, reason? }`。
 *
 * 两条门**串联**，顺序即语义（**先看原因、再看次数**）：
 * 1. **原因门**：只有 `CONTINUABLE_REASONS` 内的原因可续跑 —— 目前**只有 `empty_response`**
 *    （空证据 + 空写入 = 空转，值得再试一次）。其余原因（`completed` / `partial` / 未知）**一律拒**，
 *    **即使次数还没到上界** —— 这条专治「只看次数不看原因」。
 *    ⚠ `empty_response` 的**分类单点不在本文件**：`lib/bus/index.js:208`
 *    （`if (n.evidence.length === 0 && n.writes.length === 0) return 'empty_response';`）。
 *    本文件只**消费该字符串字面**，不复制分类逻辑、不改分类口径（本批对 `bus/index.js` **零改动**）。
 * 2. **次数门**：已续跑次数 **超过** 上界 ⇒ 拒。上界只由本文件的**唯一策略常量**承载（见下方导出）。
 *    `continuationCount` 的语义 = **此前已经发生的续跑次数**（首次调用传 0）：
 *    已续 1 次 ⇒ 允许（第 2 次 run）／已续 2 次 ⇒ 允许（用满上界）／已续 3 次 ⇒ **拒**。
 *    ⇒ 效果即 B4 的「**空转不产第 3 次 run**」。
 *
 * ## 不管什么（边界，防越权）
 * - **不接管恢复流程**：`lib/state/resume.js`（177 行，`resolveResumeConfig`/`recoverBatches`）
 *   负责断点续跑骨架，本文件**不 import 它**、不改它、不替它做任何决定；
 * - **不判活性分类**：`advanced` / `empty_response` / `partial` 的分类归 `lib/bus/index.js`；
 * - **不落盘、不落事件、不读时钟、不读环境**：零 import、零副作用 ⇒ 可直接单测。
 *
 * ## 为什么上界必须是常量（而不是函数里写死一个字面量）
 * 「上界」是**策略**，会在后续批次被调（也可能被配置化）。写死字面量会让「改策略」= 改判定逻辑，
 * 且无法被 grep 或单点校验发现。故：**上界只在这里定义一次**，判定处一律引用该常量
 * （验收里有一条正是「比较必须走常量」：源码中比较运算符后**不得**直接跟字面量上界）。
 *
 * ## 缺省与非法输入（本文件是判据，不是形态校验器）
 * - `input` 缺省 / 非对象 ⇒ 视为 `{}` ⇒ 原因门会拒（`stopReason` 不在白名单）——**fail-closed**；
 * - `continuationCount` 缺省 / 非有限数 / 负数 ⇒ 按 **0** 处理（= 尚未续跑过）：这是首次请求的常态；
 *   若调用方传垃圾值，属其调用缺陷（本文件不抛错，避免判定函数成为新的崩溃面）。
 */

/** 续跑上界：**唯一真源**（策略常量；判定处一律引用它，禁在比较里写死字面量）。 */
export const MAX_LIVENESS_CONTINUATION = 2;

/** 可续跑的停止原因白名单：**只有空转（`empty_response`）值得再试一次**。冻结防运行期增删。 */
export const CONTINUABLE_REASONS = Object.freeze(['empty_response']);

/** 原因门拒态前缀（非 `GATE_`、无 `err.code`：本函数返回对象而非抛错）。 */
const NOT_CONTINUABLE = 'liveness-not-continuable:';
/** 次数门拒态前缀（口径源 §2.3 指定）。 */
const LIMIT = 'liveness-limit:';

/**
 * 已续跑次数归一：缺省 / 非有限数 / 负数 ⇒ 0（= 尚未续跑过）。
 * 取整而非四舍五入：次数是离散计数，带小数的输入按「已发生的完整次数」算，**不向上放宽**。
 */
function continuationCountOf(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  const whole = Math.trunc(raw);
  return whole > 0 ? whole : 0;
}

/**
 * 续跑判定（**纯函数**：无 I/O、无时钟、无随机、不改入参）。
 *
 * @param {{stopReason?: string, continuationCount?: number}} [input]
 * @returns {{continueAllowed: boolean, reason?: string}}
 *   `continueAllowed: true` ⇒ 允许再续跑一次（不返回 `reason`）；
 *   `false` ⇒ 拒，`reason` 以 `liveness-not-continuable:`（原因门）或 `liveness-limit:`（次数门）开头。
 */
export function continuationDecision(input = {}) {
  const facts = (input && typeof input === 'object') ? input : {};
  const stopReason = facts.stopReason;

  // 门 1（先行）：原因必须可续跑 —— 否证态（如 `completed`）即使次数未到上界也拒。
  if (!CONTINUABLE_REASONS.includes(stopReason)) {
    return {
      continueAllowed: false,
      reason: NOT_CONTINUABLE + ' stopReason=' + String(stopReason)
        + '（只有 ' + CONTINUABLE_REASONS.join('/') + ' 可续跑；空转可由证据面复核：lib/bus/index.js:208）',
    };
  }

  // 门 2：已续跑次数超过上界 ⇒ 拒（比较走常量，**不写死字面量**）。
  const used = continuationCountOf(facts.continuationCount);
  const limit = MAX_LIVENESS_CONTINUATION; // 唯一真源 → 局部别名（比较与文案都引用它，不再另写字面量）
  if (used > limit) {
    return {
      continueAllowed: false,
      reason: LIMIT + ' continuationCount=' + used + ' 已超过上界 ' + limit
        + '（B4：空转不产第 3 次 run）',
    };
  }

  return { continueAllowed: true };
}
