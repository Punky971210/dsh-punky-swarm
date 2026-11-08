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


export interface NarrowBounds {
  path: string;
  max?: number; min?: number;
  enum?: unknown[];
  pattern?: string;
}

export interface NarrowResult {
  narrowed: unknown;
  clamped: Array<{ path: string; from: unknown; to: unknown }>;
  changed: boolean;
}

function parseJsonPointer(pointer: string): string[] | null {
  if (typeof pointer !== 'string' || pointer.length === 0) return null;
  if (pointer === '/') return [];
  if (!pointer.startsWith('/')) return null;
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function locate(
  obj: unknown,
  tokens: string[],
): { parent: Record<string | number, unknown>; key: string | number; value: unknown } | null {
  let cur: unknown = obj;
  for (let i = 0; i < tokens.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    const container = cur as Record<string | number, unknown>;
    const key: string | number = Array.isArray(container) && /^\d+$/.test(tokens[i])
      ? Number(tokens[i])
      : tokens[i];
    if (!Object.prototype.hasOwnProperty.call(container, key)) return null;
    if (i === tokens.length - 1) return { parent: container, key, value: container[key] };
    cur = container[key];
  }
  return null;
}

function deepClone<T>(v: T): T {
  return structuredClone(v);
}

export function computeNarrowedParams(params: unknown, bounds: NarrowBounds[]): NarrowResult {
  const narrowed: unknown = deepClone(params);
  const clamped: Array<{ path: string; from: unknown; to: unknown }> = [];
  let changed = false;

  // 安全默认：bounds 空数组 → 零钳制（narrowed 仍深拷贝，保证返回不共享输入引用）
  if (!Array.isArray(bounds) || bounds.length === 0) {
    return { narrowed, clamped, changed };
  }

  for (const b of bounds) {
    if (!b || typeof b.path !== 'string') continue;
    const tokens = parseJsonPointer(b.path);
    if (tokens === null || tokens.length === 0) continue;
    const hit = locate(narrowed, tokens);
    if (hit === null) continue;

    const raw = hit.value;
    let to: unknown = raw;
    let clampedByPattern = false;

    if (typeof raw === 'number') {
      if (typeof b.max === 'number' && (raw as number) > b.max) to = b.max;
      else if (typeof b.min === 'number' && (raw as number) < b.min) to = b.min;
    }
    if (Array.isArray(b.enum) && b.enum.length > 0 && !b.enum.includes(raw)) {
      to = b.enum[0];
    }
    if (typeof b.pattern === 'string' && b.pattern.length > 0) {
      let re: RegExp | null = null;
      try { re = new RegExp(b.pattern); } catch { re = null; }
      if (re !== null) {
        const s = typeof raw === 'string' ? raw : String(raw);
        if (!re.test(s)) {
          to = raw;
          clampedByPattern = true;
        }
      }
    }

    if (to !== raw) {
      hit.parent[hit.key] = to;
      clamped.push({ path: b.path, from: raw, to });
      changed = true;
    } else if (clampedByPattern) {
      clamped.push({ path: b.path, from: raw, to: raw });
    }
  }

  return { narrowed, clamped, changed };
}
