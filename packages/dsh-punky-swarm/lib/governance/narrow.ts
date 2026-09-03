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

// NARROW 参数钳制（G4）：JSON Pointer 只读钳制，返回深拷贝 + 变更明细。
// 蓝图：m2-detailed.md §5（移植 _compute_narrowed_params，hf.md:96）。
// 纯函数、零依赖、确定性；安全默认：未知 path 跳过不抛错、形状/类型不变、深拷贝不改输入。

export interface NarrowBounds {
  path: string;              // JSON Pointer（如 '/amount'、'/params/scope'）
  max?: number; min?: number; // 数值钳制
  enum?: unknown[];          // 枚举收敛
  pattern?: string;          // 字符串正则收敛
}

export interface NarrowResult {
  narrowed: unknown;         // 钳制后参数（深拷贝，形状不变——只改叶值）
  clamped: Array<{ path: string; from: unknown; to: unknown }>; // 变更明细（审计）
  changed: boolean;          // 是否有实际钳制（值发生变化）
}

// JSON Pointer 解析：'/a/b' → ['a','b']；'/' → []（根，不钳制）；支持 ~0(~) / ~1(/) 转义；
// 非法（非字符串/不以 '/' 开头/空串）→ null（跳过该 bounds，不抛错）。
function parseJsonPointer(pointer: string): string[] | null {
  if (typeof pointer !== 'string' || pointer.length === 0) return null;
  if (pointer === '/') return [];
  if (!pointer.startsWith('/')) return null;
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

// 沿 token 链寻址（在 deep clone 后的 narrowed 上操作）；目标不存在/父级非对象 → null（跳过）。
// 返回 { parent, key, value }：parent 为持有目标值的容器（写回点），key 为属性名（数组索引数字化为 number）。
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
  return null; // tokens 为空（根指针 '/'）→ 不钳制根
}

function deepClone<T>(v: T): T {
  // engines node>=22 → structuredClone 可用；参数为纯 JSON 数据（宿主 ToolExecutionInput.arguments）。
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
    if (hit === null) continue; // 未知 path → 跳过该 bounds，不抛错不修改

    const raw = hit.value;
    let to: unknown = raw;
    let clampedByPattern = false;

    // 数值钳制：超 max 钳到 max、低于 min 钳到 min（仅当值为 number 时）
    if (typeof raw === 'number') {
      if (typeof b.max === 'number' && (raw as number) > b.max) to = b.max;
      else if (typeof b.min === 'number' && (raw as number) < b.min) to = b.min;
    }
    // enum 收敛：enum 不含当前值 → 取 enum 首值（『待核实』取首 vs 拒绝，蓝图建议取首并记 clamped）
    if (Array.isArray(b.enum) && b.enum.length > 0 && !b.enum.includes(raw)) {
      to = b.enum[0];
    }
    // pattern：字符串正则收敛——不匹配 → 保留原值 + clamped 记录（不截断，避免语义破坏）
    if (typeof b.pattern === 'string' && b.pattern.length > 0) {
      let re: RegExp | null = null;
      try { re = new RegExp(b.pattern); } catch { re = null; } // 非法正则 → 跳过 pattern
      if (re !== null) {
        const s = typeof raw === 'string' ? raw : String(raw);
        if (!re.test(s)) {
          to = raw; // 保留原值（不截断）
          clampedByPattern = true;
        }
      }
    }

    if (to !== raw) {
      hit.parent[hit.key] = to; // 仅叶值替换，形状/类型不变
      clamped.push({ path: b.path, from: raw, to });
      changed = true;
    } else if (clampedByPattern) {
      clamped.push({ path: b.path, from: raw, to: raw }); // pattern 不匹配审计记录（from===to）
    }
  }

  return { narrowed, clamped, changed };
}
