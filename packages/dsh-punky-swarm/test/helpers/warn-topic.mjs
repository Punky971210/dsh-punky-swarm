/**
 * 主题面 warn 归因收窄（C1）。
 *
 * 存在理由：原断言写的是 `calls.warn.length === 0`（**全生命周期总量**），
 * 而注释承诺的是「**热更路径**零 warn」—— 装配期资产同步（`lib/assets.js:219` 的 rmSync+cpSync
 * `preserveTimestamps` → `utime` EPERM）会落进同一个数组 ⇒ 断言范围写宽了，不是取向问题。
 *
 * 语义（唯一）：
 *   · `topic` = 命中主题正则的 warn ⇒ **零容忍**（`ok = topic.length === 0`）；
 *   · `other` = 非主题 warn ⇒ **不判死，但必须可见**（调用方把它全文写进断言消息）。
 *
 * ⚠ 签名里**不含**任何时间/重试/阈值/容差参数 ⇒ "重试后放过""超阈值才报""非主题一律忽略"
 *   这几类吸收**结构上不可能**实现（审计可 grep 签名核验）。
 */
export function topicWarnVerdict(warns, topicPattern) {
  const all = Array.isArray(warns) ? warns.map((w) => String(w)) : [];
  const topic = all.filter((w) => topicPattern.test(w));
  const other = all.filter((w) => !topicPattern.test(w));
  return { ok: topic.length === 0, topic, other };
}
