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

// 治理内核组合根（G6）：规则匹配 → 违规收集 → classifyViolation → KernelDecision（同步、确定性、零 IO）。
// 蓝图：m2-detailed.md §2.2。空 rules → { primitive:'ALLOW', priority:-1, reason:'', ruleRefs:[] }。
// 零依赖纪律：本文件不 import 任何外部包/宿主模块——仅本目录相对导入；
//   randomUUID 用全局 crypto（node≥19 WebCrypto，标准库内建，非外部包）；
//   deepEqual 自实现递归（避免 node:util import 触发零依赖 grep 审计）。
// P0 硬化（harden-plan §5.1 A）：NARROW 运行期接线——decide 组合序在规则命中收集 violations 时同步收集
//   命中规则的 narrow bounds（Rule.narrow，A2 方案）；classify 产出后按契约计算 narrowedParams（见 decide）。

import type { GovernanceConfig, KernelDecision, RefusalReceipt, Rule, Violation } from './types.js';
import { classifyViolation } from './classify.js';
import { computeNarrowedParams, type NarrowBounds } from './narrow.js';

// ── Rule.match 匹配语义（蓝图 §2.2）──

// 递归深度相等（纯 JSON 数据；处理对象/数组/原始值，键序不敏感）
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    return aa.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

// JSON Pointer 取值（匹配语义）：pointer 缺省（undefined/''）= 匹配整个 arguments；
// 解析失败/目标不存在 → { found:false }（规则不命中，不抛错）。
function resolveParam(obj: unknown, pointer: string | undefined): { found: boolean; value: unknown } {
  if (pointer === undefined || pointer === '') return { found: true, value: obj };
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { found: false, value: undefined };
  const tokens = pointer.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = obj;
  for (const tok of tokens) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false, value: undefined };
    const container = cur as Record<string | number, unknown>;
    const key: string | number = Array.isArray(container) && /^\d+$/.test(tok) ? Number(tok) : tok;
    if (!Object.prototype.hasOwnProperty.call(container, key)) return { found: false, value: undefined };
    cur = container[key];
  }
  return { found: true, value: cur };
}

// 单规则命中判定：tools 白名单（缺省=全工具）+ match（path/op/pattern/value）
function ruleMatches(rule: Rule, exec: { name: string; arguments: unknown }): boolean {
  if (Array.isArray(rule.tools) && rule.tools.length > 0 && !rule.tools.includes(exec.name)) {
    return false;
  }
  const m = rule.match ?? {};
  const { found, value: target } = resolveParam(exec.arguments, m.path);
  if (!found) return false; // path 不存在 → 不命中
  const op = m.op ?? 'eq';  // op 缺省 = 'eq'
  switch (op) {
    case 'eq':
      return deepEqual(target, m.value);
    case 'gt':
      return typeof target === 'number' && typeof m.value === 'number' && target > m.value;
    case 'gte':
      return typeof target === 'number' && typeof m.value === 'number' && target >= m.value;
    case 'lt':
      return typeof target === 'number' && typeof m.value === 'number' && target < m.value;
    case 'lte':
      return typeof target === 'number' && typeof m.value === 'number' && target <= m.value;
    case 'in':
      return Array.isArray(m.value) && m.value.includes(target);
    case 'regex': {
      // regex 对 path 值（pattern 优先；value 为字符串时作兜底 pattern）
      const pat = typeof m.pattern === 'string' && m.pattern.length > 0
        ? m.pattern
        : (typeof m.value === 'string' ? m.value : null);
      if (pat === null) return false;
      try {
        return new RegExp(pat).test(typeof target === 'string' ? target : String(target));
      } catch {
        return false; // 非法正则 → 不命中
      }
    }
    default:
      return false;
  }
}

// 保序去重（U4-5：多规则命中 ruleRefs 收集，去重保序以实现为准）
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// 深拷贝（防宿主冻结对象污染——HTYPES ToolExecutionInput.arguments 为 frozen readonly）
function deepClone<T>(v: T): T {
  return structuredClone(v);
}

// ── 组合根 ──

export interface GovernanceKernel {
  decide(exec: { name: string; arguments: unknown }): KernelDecision;
  getConfig(): GovernanceConfig;
}

export function createGovernanceKernel(config: GovernanceConfig): GovernanceKernel {
  return {
    // 同步、确定性、零 IO：rules 匹配（Rule.match）→ 收集 violations + narrow bounds → classifyViolation → KernelDecision
    // P0 组合序：命中规则收集 violations 时同步收集 narrow bounds（A2 显式字段）；
    //   classify 后——primitive==='NARROW'（flag.narrow=true）必填 narrowedParams；
    //   primitive==='DENY' 且 violations 含 narrowable（P4 flag-off 回退，或多违规 hard 优先）亦填充
    //   （决策留痕：采纳 harden-plan §5.1 A.2 建议「填充」，deny+指引语义增强——收据携带钳制结果作模型修正依据）。
    decide(exec) {
      if (!Array.isArray(config.rules) || config.rules.length === 0) {
        return { primitive: 'ALLOW', priority: -1, reason: '', ruleRefs: [] };
      }
      const violations: Violation[] = [];
      const hitIds: string[] = [];
      const narrowBounds: NarrowBounds[] = [];
      for (const rule of config.rules) {
        if (ruleMatches(rule, exec)) {
          hitIds.push(rule.id);
          for (const v of rule.violations) violations.push(v);
          // P0：收集命中规则显式 narrow bounds（A2；旧规则无 narrow 字段 → 零 bounds 不钳制）
          if (Array.isArray(rule.narrow)) {
            for (const b of rule.narrow) {
              if (b && typeof b.path === 'string') narrowBounds.push(b);
            }
          }
        }
      }
      if (violations.length === 0) {
        return { primitive: 'ALLOW', priority: -1, reason: '', ruleRefs: [] };
      }
      const cls = classifyViolation({
        tool: exec.name,
        params: exec.arguments,
        violations,
        flags: config.flags,
        defaults: config.defaults,
      });
      const decision: KernelDecision = {
        primitive: cls.primitive,
        priority: cls.priority,
        reason: cls.reason,
        ruleRefs: dedupe(hitIds),
      };
      // P0 NARROW 运行期接线：窄域违规（narrowable）且收集到 bounds 时计算钳制结果——
      //   NARROW（P4 flag.on）必填；DENY 含 narrowable（flag-off 回退 / hard 多违规）亦填充（修正依据，建议采纳）。
      const hasNarrowable = violations.some((v) => v.category === 'narrowable');
      if (narrowBounds.length > 0 && (cls.primitive === 'NARROW' || (cls.primitive === 'DENY' && hasNarrowable))) {
        decision.narrowedParams = computeNarrowedParams(exec.arguments, narrowBounds);
      }
      return decision;
    },
    getConfig() {
      return config;
    },
  };
}

// ── 收据构造（纯函数实用：attemptedParams 深拷贝防冻结对象污染）──
// 非严格确定性实用函数：含 ts(new Date) + receiptId(crypto.randomUUID)，均为标准库，零 IO 零外部依赖。
export function createRefusalReceipt(input: {
  tool: string;
  callId: string;
  sessionId: string | null;
  decision: KernelDecision;
  attemptedParams: unknown;
}): RefusalReceipt {
  const { tool, callId, sessionId, decision, attemptedParams } = input;
  const receipt: RefusalReceipt = {
    receiptId: globalThis.crypto.randomUUID(), // node≥19 WebCrypto（标准库内建）
    ts: new Date().toISOString(),
    tool,
    callId,
    sessionId: sessionId ?? null,
    decision: {
      primitive: decision.primitive,
      priority: decision.priority,
      reason: decision.reason,
    },
    attemptedParams: deepClone(attemptedParams),
    ruleRefs: [...decision.ruleRefs],
  };
  if (decision.narrowedParams !== undefined) {
    receipt.narrowedParams = deepClone(decision.narrowedParams);
  }
  return receipt;
}
