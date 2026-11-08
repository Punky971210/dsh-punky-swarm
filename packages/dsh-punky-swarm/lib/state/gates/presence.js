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
import fs from 'node:fs';
import path from 'node:path';
const EMPTY_REASON_RE = /^empty-reason:[ \t]*(\S[^\n]*)$/m;
export function declaredKindOf(declared) {
    return typeof declared === 'string' && declared.endsWith('/') ? 'dir' : 'file';
}
export function emptyReasonOf(content) {
    if (typeof content !== 'string')
        return null;
    const m = content.match(EMPTY_REASON_RE);
    if (!m)
        return null;
    const reason = String(m[1]).trim();
    return reason.length > 0 ? reason : null;
}
export function substantiveContentOf(content) {
    return String(content ?? '').replace(/^empty-reason:.*$/gm, '');
}
export function sectionLineHit(content, section) {
    if (typeof content !== 'string' || typeof section !== 'string' || section.length === 0)
        return false;
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped + '[ \\t]*$', 'm').test(content);
}
/**
 *  与既有行族同构（`reason:` / `gate:` / `targets-claimed:` / `empty-reason:`）；不用 `content.includes(id)`
 *  是因为元素 id（如 `goal`）通常极短，`includes` 会把任意词命中 ⇒ 判据不可靠（假绿风险）。
 */
export function elementLineHit(content, id) {
    if (typeof content !== 'string' || typeof id !== 'string' || id.length === 0)
        return false;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^element:[ \\t]*' + escaped + '[ \\t]*$', 'm').test(content);
}
export function isInsideRoot(absPath, rootDir) {
    const rel = path.relative(path.resolve(rootDir), path.resolve(absPath));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
/** 最近既有祖先（`allowMissing` 档的解析基）：祖先绝对路径 + 尚未落盘的剩余段；无（含盘根不存在）⇒ `null`。 */
function nearestExistingAncestorOf(absPath) {
    let cur = absPath;
    const rest = [];
    for (;;) {
        if (fs.existsSync(cur))
            return { anc: cur, rest };
        const parent = path.dirname(cur);
        if (parent === cur)
            return null;
        rest.unshift(path.basename(cur));
        cur = parent;
    }
}
export function isInsideRootResolved(absPath, rootDir, opts = {}) {
    if (!isInsideRoot(absPath, rootDir))
        return false;
    let rootReal;
    if (opts.allowMissing === true) {
        const nearRoot = nearestExistingAncestorOf(path.resolve(rootDir));
        if (nearRoot === null)
            return false;
        let ancRootReal;
        try {
            ancRootReal = fs.realpathSync(nearRoot.anc);
        }
        catch {
            return false;
        }
        rootReal = path.join(ancRootReal, ...nearRoot.rest);
    }
    else {
        try {
            rootReal = fs.realpathSync(path.resolve(rootDir));
        }
        catch {
            return false;
        }
    }
    let absReal;
    if (opts.allowMissing === true) {
        const near = nearestExistingAncestorOf(path.resolve(absPath));
        if (near === null)
            return false;
        let ancReal;
        try {
            ancReal = fs.realpathSync(near.anc);
        }
        catch {
            return false;
        }
        absReal = path.join(ancReal, ...near.rest);
    }
    else {
        try {
            absReal = fs.realpathSync(path.resolve(absPath));
        }
        catch {
            return false;
        }
    }
    return isInsideRoot(absReal, rootReal);
}
