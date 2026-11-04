/**
 * `x` 是否为 `string[]`（数组 **且** 每个元素都是字符串）。
 *
 * @param x 任意值（通常来自外部输入 / `unknown` 面）
 * @returns 窄化谓词：`true` ⇒ `x` 在类型层与运行期都确为 `string[]`
 */
export declare function isStringArray(x: unknown): x is string[];
