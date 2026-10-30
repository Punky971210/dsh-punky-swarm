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
 * `lib/engine/confirm-card.js` —— I-29 **变更卡统一裁决载形**（采纳蓝图 A4/B6）。
 *
 * ## 管什么
 * 把「需要人裁决的变更」渲染成**同一形状**的卡片：**字段集合固定**（= `CARD_FIELDS`），
 * **不随调用点/变更种类变化**。调用方（工具面、引擎面）只需填值，卡形由本文件保证。
 *
 * ## 为什么「载形」要统一
 * 若每种变更各写一套卡（`{phase, from, to}` / `{lane, owner}` / `{edge, artifacts}`…），
 * 裁决方每遇到一种新变更就得重新学一遍「该看哪几个字段」；更糟的是**缺字段**的卡会静默通过
 * （少一个 `authority` 就没人签、少一个 `options` 就无法裁决）。
 * ⇒ 本文件用**恒定键集 + 确定性缺省**把「空壳卡」变成结构性不可能：**7 个键永远都在**。
 *
 * ## 关键区分：「同一形状」≠「同一内容」
 * 不同种类的卡，**键集与字段类型相同**，但**值当然不同**（`kind`/`title`/`summary`/`options` 各异）。
 * 判据用 `Object.keys(card).sort()` 的 `deepEqual`；**不是**要求两场景返回同一张卡。
 *
 * ## 纯函数（可测、可复算）
 * - **不读时钟**：`createdAt` 由调用方传入（本文件缺省 `null`）—— 内部读系统时钟会让同一输入产出不同卡；
 * - **不取随机**：`cardId` 缺省由输入**确定性派生**（同样为了可复算）；
 * - 无 I/O、无全局状态、不改入参（`options` 复制一份再返回）。
 *
 * ## 缺省值（确定性，且**保持字段非空**）
 * | 字段 | 缺省 | 说明 |
 * |---|---|---|
 * | `kind` | `'unknown'` | 未分类变更（不许省略键） |
 * | `title` | `'变更确认：<kind>'` | **非空**：空标题的卡无从裁决 |
 * | `summary` | `'待裁决的 <kind> 变更（调用方未提供摘要）'` | **非空**，且如实说明是缺省 |
 * | `options` | `[]` | 数组恒在（空数组 = 暂时无可选项，仍可表达"是否放行"） |
 * | `authority` | `'unspecified'` | **非空但不伪造裁决权**：本文件不假装知道该谁签 |
 * | `createdAt` | `null` | 不读时钟；真实卡须由调用方传时间戳 |
 * | `cardId` | `'card:<kind>:<createdAt\|no-time>'` | 确定性派生；需全局唯一时由调用方传入 |
 */

/** 卡片的**恒定键集**（所有 `kind` 相同；顺序即返回对象的键序，便于逐字节比对）。 */
export const CARD_FIELDS = Object.freeze(['cardId', 'kind', 'title', 'summary', 'options', 'authority', 'createdAt']);

/** 「非空字符串」归一：非字符串或全空白 ⇒ `''`（交由调用处走确定性缺省）。 */
function textOf(value) {
  return (typeof value === 'string' && value.trim().length > 0) ? value : '';
}

/**
 * 造一张变更卡（**纯函数**：同一入参 ⇒ 同一张卡，可复算）。
 *
 * @param {{cardId?: string, kind?: string, title?: string, summary?: string,
 *          options?: unknown[], authority?: string, createdAt?: string|number|null}} [input]
 * @returns {{cardId: string, kind: string, title: string, summary: string,
 *           options: unknown[], authority: string, createdAt: string|number|null}}
 *   键集**恒等于** `CARD_FIELDS`（7 键，顺序同 `CARD_FIELDS`）；`title`/`summary`/`authority` 恒非空。
 */
export function buildConfirmCard(input = {}) {
  const given = (input && typeof input === 'object') ? input : {};

  const kind = textOf(given.kind) || 'unknown';
  // 时间戳：调用方给什么就是什么（含 null）；**本文件绝不读时钟**
  const createdAt = (given.createdAt === undefined) ? null : given.createdAt;
  const options = Array.isArray(given.options) ? [...given.options] : [];

  // 以下三者**恒非空**：空壳卡（有键无值）无法裁决，属本文件要结构性排除的形态
  const title = textOf(given.title) || ('变更确认：' + kind);
  const summary = textOf(given.summary) || ('待裁决的 ' + kind + ' 变更（调用方未提供摘要）');
  const authority = textOf(given.authority) || 'unspecified';

  // cardId 缺省 = 由 (kind, createdAt) 确定性派生（非随机、非时钟）⇒ 同输入同 id
  const cardId = textOf(given.cardId)
    || ('card:' + kind + ':' + (createdAt === null ? 'no-time' : String(createdAt)));

  return { cardId, kind, title, summary, options, authority, createdAt };
}
