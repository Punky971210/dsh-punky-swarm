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

export type PresenceMode = 'declare' | 'runtime';

/** 空内容原因行留痕（`gate.escape{kind:'empty-artifact-noted'}` 的载荷）。 */
export interface PresenceNote { artifact: string; reason: string }

export interface PresenceVerdict {
  ok: boolean;
  mode: PresenceMode;
  layer: string | null;
  declaredKind: string | null;
  path: string | null;
  kind: 'file' | 'dir';
  code: string | null;
  problems: string[];
  notes: PresenceNote[];
}

/** `presenceJudge` 的入参形态（原闭包内联形参类型**逐字搬移**为新具名类型；建批期 / 运行期两 mode 共用）。 */
export interface PresenceInput {
  mode?: PresenceMode;
  layer?: string | null;
  declared?: unknown;
  declaredKind?: string | null;
  abs?: string | null;
  content?: string | null;
  artifactsRoot?: string | null;
}

export function declaredKindOf(declared: string): 'file' | 'dir' {
  return typeof declared === 'string' && declared.endsWith('/') ? 'dir' : 'file';
}

export function emptyReasonOf(content: string): string | null {
  if (typeof content !== 'string') return null;
  const m = content.match(EMPTY_REASON_RE);
  if (!m) return null;
  const reason = String(m[1]).trim();
  return reason.length > 0 ? reason : null;
}

export function substantiveContentOf(content: string): string {
  return String(content ?? '').replace(/^empty-reason:.*$/gm, '');
}

export function sectionLineHit(content: string, section: string): boolean {
  if (typeof content !== 'string' || typeof section !== 'string' || section.length === 0) return false;
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped + '[ \\t]*$', 'm').test(content);
}

/**
 *  与既有行族同构（`reason:` / `gate:` / `targets-claimed:` / `empty-reason:`）；不用 `content.includes(id)`
 *  是因为元素 id（如 `goal`）通常极短，`includes` 会把任意词命中 ⇒ 判据不可靠（假绿风险）。
 */
export function elementLineHit(content: string, id: string): boolean {
  if (typeof content !== 'string' || typeof id !== 'string' || id.length === 0) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^element:[ \\t]*' + escaped + '[ \\t]*$', 'm').test(content);
}

export function isInsideRoot(absPath: string, rootDir: string): boolean {
  const rel = path.relative(path.resolve(rootDir), path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}


/** 解权档选项。 */
export interface InsideRootResolvedOptions {
  /**
   * `true` = 目标**允许尚不存在**（写面：目标由本次调用创建）⇒ 解权「最近既有祖先」+ 剩余段。
   * `false`（缺省）= 目标本身须可解权；解不了（不存在/断链/权限）⇒ `false`。
   */
  allowMissing?: boolean;
}

/** 最近既有祖先（`allowMissing` 档的解析基）：祖先绝对路径 + 尚未落盘的剩余段；无（含盘根不存在）⇒ `null`。 */
function nearestExistingAncestorOf(absPath: string): { anc: string; rest: string[] } | null {
  let cur = absPath;
  const rest: string[] = [];
  for (;;) {
    if (fs.existsSync(cur)) return { anc: cur, rest };
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

export function isInsideRootResolved(absPath: string, rootDir: string, opts: InsideRootResolvedOptions = {}): boolean {
  if (!isInsideRoot(absPath, rootDir)) return false;
  let rootReal: string;
  if (opts.allowMissing === true) {
    const nearRoot = nearestExistingAncestorOf(path.resolve(rootDir));
    if (nearRoot === null) return false;
    let ancRootReal: string;
    try { ancRootReal = fs.realpathSync(nearRoot.anc); } catch { return false; }
    rootReal = path.join(ancRootReal, ...nearRoot.rest);
  } else {
    try { rootReal = fs.realpathSync(path.resolve(rootDir)); } catch { return false; }
  }
  let absReal: string;
  if (opts.allowMissing === true) {
    const near = nearestExistingAncestorOf(path.resolve(absPath));
    if (near === null) return false;
    let ancReal: string;
    try { ancReal = fs.realpathSync(near.anc); } catch { return false; }
    absReal = path.join(ancReal, ...near.rest);
  } else {
    try { absReal = fs.realpathSync(path.resolve(absPath)); } catch { return false; }
  }
  return isInsideRoot(absReal, rootReal);
}
