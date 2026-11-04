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
// lib/types/guards.ts —— 类型守卫（批 `punky-type-assert-purge-20261103` · lane `impl`）
//
// 存在理由：`wave-plan.ts` 里有 6 处 `as string[]` 断言，形态都是
//   `Array.isArray(x) ? (x as string[]) : []`。
//   **问题**：`Array.isArray` 只把 `x` 窄化为 `any[]`（元素仍是 `any`）⇒ 元素类型仍靠**断言**补
//   ⇒ 断言掩盖了「元素可能不是字符串」这一事实。
// **修法**：用**谓词**（`x is string[]`）一次性把「是数组 **且** 元素全是字符串」判掉，
//   断言随之消失，且**元素类型由运行时检查真实保证**（不是靠断言声明）。
//
// 口径（与仓内既有归一化纪律一致）：
//   · **只认同「数组 + 每个元素都是 string」**；`[]`（空数组）**算通过**（空集天然满足）；
//   · 非数组 / 含任一非字符串元素 ⇒ `false`（**不做 trim、不做部分接受**：调用方自行决定如何算非法）；
//   · **不抛**（纯判定，零副作用）。
/**
 * `x` 是否为 `string[]`（数组 **且** 每个元素都是字符串）。
 *
 * @param x 任意值（通常来自外部输入 / `unknown` 面）
 * @returns 窄化谓词：`true` ⇒ `x` 在类型层与运行期都确为 `string[]`
 */
export function isStringArray(x) {
    if (!Array.isArray(x))
        return false;
    for (const item of x) {
        if (typeof item !== 'string')
            return false;
    }
    return true;
}
