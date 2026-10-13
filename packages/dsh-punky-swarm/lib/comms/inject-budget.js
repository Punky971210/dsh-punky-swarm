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

// 文件 inject-budget：注入面字节预算（四层结构 + 显式省略标记）
// 作用面 = 注入给 worker / Leader 的**文本**（任务包骨架、交接断言块、lane 回报唤醒消息）。
//   刻意**不**作用于产物文件本体：截断结果只回传给调用方拼接注入文本，绝不回写任何文件（AC-10）。
//
// 纯函数模块（对齐同目录 budget.js 先例）：**零 config import** —— 阈值由调用方从单一取值源
//   capabilities.injectBudget 读出后传入；本模块内**不出现任何阈值字面量**（AC-8 / C-7）。
//
// 四层结构（层号只在本注释与返回值中体现，实现不重复编号）：
//   层① 每源软上限 —— 由调用方选择 limit 种类：单条目 或 单块（两种 kind 各是一层，各自一条记录）
//   层② 总量硬上限 —— 对拼接后的整面文本施加（kind='total'）
//   层③ head-tail 截断 —— 保结构头 + 结论尾（headBytes / tailBytes），中段挖除
//   层④ 显式省略标记 —— 被截断文本**自带** `…[omitted <N>B @ <surface>]`，消费方当场可辨
//                        「没有」vs「被省略」；`<N>` = 十进制省略字节数，与 omissions[].omittedBytes 相等
//
// 分层施加顺序**固定**：单条目 → 单块 → 总量。每层各自产**一条** omissions 记录（不合并），
//   使 audit 可分辨「哪个面省略了多少」。调用方按序调用本函数即得该顺序（本模块不自行编排多面）。
//
// ── 调用契约（**务必先读**：签名比「面名 + 阈值」多一个层选择位，按声明面臆测会静默降级）──────
//   `applyInjectionBudget(text, { surface, thresholds, kind })`
//     ① `kind` ∈ `'perItem' | 'perBlock' | 'total'`，**缺省 `'total'`**。
//        ⇒ 只施**该一层**，不施其它层；缺省时**只施总量层**、**不施单条目 / 单块层**。
//        ⇒ 想施加「单条目层」或「单块层」必须**显式**传对应 `kind`，否则该层**静默不生效**
//          （症状是「省略标记少了一层」这类**难定位**的偏差，不报错）。
//     ② **分层不合并 = 调用方编排责任**：本模块**一次调用只施一层**。要四层齐备，调用方须
//        **按固定顺序各呼一次**：`kind:'perItem'`（单条目）→ `kind:'perBlock'`（单块）→
//        `kind:'total'`（总量）；每次调用的返回值**串联**（把上一次的 `.text` 作为下一次的 `text`）。
//     ③ 每条路径**恰产生一条 omission**（同面跨层 = 多条，**不得**合并为一条）——这正是 ② 的读端期望。
//     ④ `thresholds` 必须由调用方**从单一取值源 `capabilities.injectBudget` 读出后传入**；
//        本模块不读配置、不内置默认阈值、不设兜底字面量。
//
// 触发口径：**严格大于**阈值才截断（恰等于阈值 ⇒ 不动作、零省略），并**返回入参原值本身**
//   （同一引用，不重新拼接）⇒ 未超限零回归（AC-13）。
//
// 字节安全：一切长度按 Buffer 字节计，切点按**字节**取（禁按 String.length / 码元切，防 UTF-8 破字）。
//   实现自带该原语、**不触** lib/auditlog/sink.js —— 后者的字节截断函数为模块私有（无 export），
//   强行导出会把改动面推出本批写域边界；且两者语义本就不同（该处 = 尾部收敛 + 单标记；
//   本件 = head+tail + 结构化带字节数与面名的标记）。后续波次可抽公共原语。

// 省略标记模板：`…[omitted <N>B @ <surface>]`（省略号 U+2026）
const OMISSION_MARKER_TEMPLATE = '…[omitted {N}B @ {surface}]';

// 标记文案（本模块唯一构造点；`<surface>` 为空时退化为 `unknown`，不产半截标记）
export function omissionMarkerOf(omittedBytes, surface) {
  return OMISSION_MARKER_TEMPLATE
    .replace('{N}', String(omittedBytes))
    .replace('{surface}', typeof surface === 'string' && surface.length > 0 ? surface : 'unknown');
}

// 字节视图：按 byteBudget 自 text[0] 起取「不破字前缀」的**码元下标**（可与 String.prototype.slice 直配）
//   倒退最多 3 个码元（UTF-8 续字节前缀 0b10）保证切在码点边界上
function utf8PrefixEndIndex(text, byteBudget) {
  if (!Number.isFinite(byteBudget) || byteBudget <= 0) return 0;
  if (byteBudget >= Buffer.byteLength(text, 'utf8')) return text.length;
  let n = 0;
  let used = 0;
  while (n < text.length) {
    const w = Buffer.byteLength(text[n], 'utf8');
    if (used + w > byteBudget) break;
    used += w;
    n += 1;
  }
  return n;
}

// 字节视图：按 byteBudget 自 text 末尾起取「不破字后缀」的**起始码元下标**
function utf8SuffixStartIndex(text, byteBudget) {
  if (!Number.isFinite(byteBudget) || byteBudget <= 0) return text.length;
  if (byteBudget >= Buffer.byteLength(text, 'utf8')) return 0;
  let start = text.length;
  let used = 0;
  while (start > 0) {
    const w = Buffer.byteLength(text[start - 1], 'utf8');
    if (used + w > byteBudget) break;
    used += w;
    start -= 1;
  }
  return start;
}

// 内部：构造「head + 标记 + tail」并求不超过 limitBytes 的最大可用切法
//   取法：**在不超过 limitBytes 的前提下最大化保留量** ——
//     ① head 取「结构头目标」headBytes（硬上限，不越界）；
//     ② tail 按目标占比 headBytes:tailBytes 放大，吃满本层剩余限额（tailBytes 同时是**下限**，
//        预算紧时仍保结论尾）；
//     ③ 结构头本身放不下时，对 head 预算做**二分边界搜索**取最大可行值（0 = 纯 tail）。
//   返回 null：连标记都放不下（预算过小）⇒ 调用方保持原值，不产「无信息的空壳」。
function headTailCut(text, limitBytes, headBytes, tailBytes, surface) {
  const total = Buffer.byteLength(text, 'utf8');
  // 标记占字节数按**上界省略值**自举（标记宽度随 N 的十进制位数量级变化）
  const markerBytes = Buffer.byteLength(omissionMarkerOf(total, surface), 'utf8');
  // available = 可供 head+tail 使用的字节（扣除标记）
  const available = limitBytes - markerBytes;
  if (available <= 0) return null;

  // tryAssemble(headBudget)：按给定 head 字节预算组装；返回 null 表示这一档放不下
  const tryAssemble = (headBudget) => {
    const headEnd = utf8PrefixEndIndex(text, headBudget);
    const headBytesTaken = Buffer.byteLength(text.slice(0, headEnd), 'utf8');
    // 余量给 tail：headBytes = head 硬上限；tailBytes = tail **下限**（预算紧时仍保结论）。
    //   本层上限宽裕时 tail 吃满剩余（available - headTaken），避免「上限 12288 却只留 3112」的浪费；
    //   剩余不足时退到 tailBytes 下限；head 只在自身预算内截。
    const available = limitBytes - markerBytes;
    const remaining = Math.max(0, available - headBytesTaken);
    const tailBudget = Math.max(Math.min(tailBytes, available - headBytesTaken), remaining);
    const tailStart = utf8SuffixStartIndex(text, tailBudget);
    const usableTailStart = tailStart > headEnd ? tailStart : text.length;
    const tailBytesTaken = usableTailStart < text.length ? Buffer.byteLength(text.slice(usableTailStart), 'utf8') : 0;
    const kept = headBytesTaken + tailBytesTaken;
    if (kept <= 0 || kept >= total) return null;
    const omittedBytes = total - kept;
    const rendered = text.slice(0, headEnd) + omissionMarkerOf(omittedBytes, surface) + text.slice(usableTailStart);
    const renderedBytes = Buffer.byteLength(rendered, 'utf8');
    if (renderedBytes > limitBytes) return null;
    return { text: rendered, omittedBytes, keptBytes: renderedBytes };
  };

  const headCap = Math.min(headBytes, total);
  const widest = tryAssemble(headCap);
  if (widest) return widest;

  // 结构头放不下 ⇒ 二分找**最大可行的 head 预算**（0 表示纯 tail）
  let lo = 0;
  let hi = headCap;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = tryAssemble(mid);
    if (candidate) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// applyInjectionBudget：对**一个注入面**施加**一层**字节上限
//   text：注入面文本（非字符串 ⇒ 原值返回、零动作，不抛）
//   { surface, thresholds, kind } ——
//     surface：面名（取自冻结面名集合；本模块**不**自造面名，亦不校验集合，校验归调用方/测试）
//     thresholds：由调用方从 capabilities.injectBudget 读出（{enabled, perItemBytes, perBlockBytes,
//                 totalBytes, headBytes, tailBytes}）；本模块**不**读配置、**不**内置默认阈值
//     kind：层选择位 ∈ 'perItem' | 'perBlock' | 'total'，**缺省 'total'**
//           ⇒ **缺省只施总量层**，不施单条目/单块层；要那两层必须**显式**传（详见文件头「调用契约」）。
//           ⇒ 一次调用只施一层；四层齐备由**调用方按序各呼一次**（perItem → perBlock → total）实现。
//   返回 { text, omissions }：omissions = [{ surface, omittedBytes, keptBytes }]
//     · 未超限 / 开关关 / 无可用阈值 ⇒ text **原值本身**（同一引用）、omissions = []（零回归）
//     · 超限 ⇒ head + 标记 + tail，**恰一条** omission（同面跨层 = 多条，不合并）
export function applyInjectionBudget(text, { surface, thresholds, kind = 'total' } = {}) {
  const untouched = { text, omissions: [] };
  if (typeof text !== 'string' || text.length === 0) return untouched;
  if (thresholds?.enabled !== true) return untouched;

  const limitOf = {
    perItem: thresholds.perItemBytes,
    perBlock: thresholds.perBlockBytes,
    total: thresholds.totalBytes,
  };
  const limitBytes = limitOf[kind] ?? thresholds.totalBytes;
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return untouched;

  // 层①/② 触发判定：**严格大于**才截断；恰等于阈值 ⇒ 零动作（边界口径，防空实现）
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return untouched;

  const headBytes = Number.isFinite(thresholds.headBytes) ? thresholds.headBytes : 0;
  const tailBytes = Number.isFinite(thresholds.tailBytes) ? thresholds.tailBytes : 0;

  // 层③ head-tail 截断 + 层④ 显式省略标记
  const cut = headTailCut(text, limitBytes, headBytes, tailBytes, surface);
  if (cut === null) return untouched; // 标记都放不下 ⇒ 宁可不截断，也不产「无信息的空壳」

  return {
    text: cut.text,
    omissions: [{ surface, omittedBytes: cut.omittedBytes, keptBytes: cut.keptBytes }],
  };
}
