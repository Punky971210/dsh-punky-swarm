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
// presence 判据纯叶（形态二分 / 空内容通道 / 行首锚定 / 路径守边）——
//   `presenceJudge` 本体（唯一实现）仍在 `gates.ts`（源码文本面断言锚：`gates.js` 内 `function presenceJudge` 恰 1 处）。
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。
import path from 'node:path';
const EMPTY_REASON_RE = /^empty-reason:[ \t]*(\S[^\n]*)$/m;
/** 声明形态（R-1）：按**声明原文**判定（`/` 结尾 = 目录语义），不做尾斜杠规范化。 */
export function declaredKindOf(declared) {
    return typeof declared === 'string' && declared.endsWith('/') ? 'dir' : 'file';
}
/** 原因行判定：**行首锚定 + 非空文本**（R-2；行中出现 / 前导空白 / 空文本 ⇒ 不命中）。 */
export function emptyReasonOf(content) {
    if (typeof content !== 'string')
        return null;
    const m = content.match(EMPTY_REASON_RE);
    if (!m)
        return null;
    const reason = String(m[1]).trim();
    return reason.length > 0 ? reason : null;
}
/** 「可空」的定义（O-4.1）：扣除原因行后**无任何实质内容**。 */
export function substantiveContentOf(content) {
    return String(content ?? '').replace(/^empty-reason:.*$/gm, '');
}
/** 判据章节**裸标题行**判定（S10 最低内容判据）：行首锚定 + 整行仅标题（编号变体/正文提及均不命中）。 */
export function sectionLineHit(content, section) {
    if (typeof content !== 'string' || typeof section !== 'string' || section.length === 0)
        return false;
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped + '[ \\t]*$', 'm').test(content);
}
/**
 * 元素声明行判定（R1 §2.4 #3）：行首锚定 + 独立整行 `element: <id>`。
 *  与既有行族同构（`reason:` / `gate:` / `targets-claimed:` / `empty-reason:`）；不用 `content.includes(id)`
 *  是因为元素 id（如 `goal`）通常极短，`includes` 会把任意词命中 ⇒ 判据不可靠（假绿风险）。
 *  `id` 按**字面量**转义后匹配（与 `sectionLineHit` 同法，防正则元字符）。
 */
export function elementLineHit(content, id) {
    if (typeof content !== 'string' || typeof id !== 'string' || id.length === 0)
        return false;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^element:[ \\t]*' + escaped + '[ \\t]*$', 'm').test(content);
}
/** 路径归属判定（P8）：绝对路径产物必须在批次产物根内。 */
export function isInsideRoot(absPath, rootDir) {
    const rel = path.relative(path.resolve(rootDir), path.resolve(absPath));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
