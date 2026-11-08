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

//     ① `kind` ∈ `'perItem' | 'perBlock' | 'total'`，**缺省 `'total'`**。
//        ⇒ 只施**该一层**，不施其它层；缺省时**只施总量层**、**不施单条目 / 单块层**。
// 字节安全：一切长度按 Buffer 字节计，切点按**字节**取（禁按 String.length / 码元切，防 UTF-8 破字）。

const OMISSION_MARKER_TEMPLATE = '…[omitted {N}B @ {surface}]';

export function omissionMarkerOf(omittedBytes, surface) {
  return OMISSION_MARKER_TEMPLATE
    .replace('{N}', String(omittedBytes))
    .replace('{surface}', typeof surface === 'string' && surface.length > 0 ? surface : 'unknown');
}

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

function headTailCut(text, limitBytes, headBytes, tailBytes, surface) {
  const total = Buffer.byteLength(text, 'utf8');
  const markerBytes = Buffer.byteLength(omissionMarkerOf(total, surface), 'utf8');
  const available = limitBytes - markerBytes;
  if (available <= 0) return null;

  const tryAssemble = (headBudget) => {
    const headEnd = utf8PrefixEndIndex(text, headBudget);
    const headBytesTaken = Buffer.byteLength(text.slice(0, headEnd), 'utf8');
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

  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return untouched;

  const headBytes = Number.isFinite(thresholds.headBytes) ? thresholds.headBytes : 0;
  const tailBytes = Number.isFinite(thresholds.tailBytes) ? thresholds.tailBytes : 0;

  const cut = headTailCut(text, limitBytes, headBytes, tailBytes, surface);
  if (cut === null) return untouched; // 标记都放不下 ⇒ 宁可不截断，也不产「无信息的空壳」

  return {
    text: cut.text,
    omissions: [{ surface, omittedBytes: cut.omittedBytes, keptBytes: cut.keptBytes }],
  };
}
