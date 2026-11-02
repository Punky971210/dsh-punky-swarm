// test/helpers/lane-logic-lines.mjs
//
// 【批 `punky-align-residual-20261102` · lane `t26-baseline`】T2.6 护栏的**计数单点**。
//
// 为什么抽出来：护栏的两条「可达构造」（`build(462)` 绿 / `build(463)` 红）必须**用同一个计数函数**，
//   否则它们证明的是「另一个函数的边界」而不是「护栏的边界」⇒ 构造不可信。
//   ⇒ 计数口径在**本文件唯一实现**，`test/merge-agent.test.js` 的 T2.6 与两个构造都引用它。
//
// 口径（与历史 split 口径**逐字一致**，不许"顺手改好"）：
//   · 先去掉文件开头的 `/* … */` 块注释（AGPL 头 = 发布合规强制，+17 行，不属逻辑膨胀）；
//   · `\r?\n` 兼容 CRLF checkout（autocrlf 工作树里 AGPL 头以 `\r\n` 结尾，旧正则 `/…\*\/\n/` 会失配误报）；
//   · 结果 = `split('\n').length`（**含尾部空串** —— 与基线同口径，改成非空行计数会让所有历史数字失效）。

/** 逻辑行数（T2.6 唯一口径）。 */
export function logicLinesOf(src) {
  const stripped = String(src ?? '').replace(/^\/\*[\s\S]*?\*\/\r?\n/, '');
  return stripped.split('\n').length;
}

/**
 * 造一个**逻辑行数恰为 n** 的合成源（供两个可达构造用）。
 *
 * 形态：开头一段块注释（**故意**走一遍剥除路径）＋ `n-1` 个 `x\n`
 *   ⇒ 剥除后 `'x\n'.repeat(n-1)` ⇒ `split('\n').length === n`。
 * @param {number} n 目标逻辑行数（正整数）
 */
export function build(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error('build(n): n 须为正整数，收到 ' + String(n));
  return '/* synthetic header (stripped by logicLinesOf) */\n' + 'x\n'.repeat(n - 1);
}
