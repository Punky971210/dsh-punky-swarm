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

// 零依赖纪律：本文件不 import 任何外部包/宿主模块——仅本目录相对导入；
//   randomUUID 用全局 crypto（node≥19 WebCrypto，标准库内建，非外部包）；
//   deepEqual 自实现递归（避免 node:util import 触发零依赖 grep 审计）。

import type { GovernanceConfig, KernelDecision, RefusalReceipt, Rule, Violation } from './types.js';
import { classifyViolation } from './classify.js';
import { computeNarrowedParams, type NarrowBounds } from './narrow.js';
import { matchToolBan } from './tool-ban.js';


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

function ruleMatches(rule: Rule, exec: { name: string; arguments: unknown }): boolean {
  if (Array.isArray(rule.tools) && rule.tools.length > 0 && !rule.tools.includes(exec.name)) {
    return false;
  }
  const m = rule.match ?? {};
  const { found, value: target } = resolveParam(exec.arguments, m.path);
  if (!found) return false;
  const op = m.op ?? 'eq';
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
      const pat = typeof m.pattern === 'string' && m.pattern.length > 0
        ? m.pattern
        : (typeof m.value === 'string' ? m.value : null);
      if (pat === null) return false;
      try {
        return new RegExp(pat).test(typeof target === 'string' ? target : String(target));
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

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

function deepClone<T>(v: T): T {
  return structuredClone(v);
}


export interface GovernanceKernel {
  decide(exec: { name: string; arguments: unknown }): KernelDecision;
  getConfig(): GovernanceConfig;
}

export function createGovernanceKernel(config: GovernanceConfig): GovernanceKernel {
  return {
    decide(exec) {
      const banEntries = Array.isArray(config.toolBan) ? config.toolBan : [];
      if ((!Array.isArray(config.rules) || config.rules.length === 0) && banEntries.length === 0) {
        return { primitive: 'ALLOW', priority: -1, reason: '', ruleRefs: [] };
      }
      const violations: Violation[] = [];
      const hitIds: string[] = [];
      const narrowBounds: NarrowBounds[] = [];
      const ban = matchToolBan(banEntries, exec);
      for (const v of ban.violations) violations.push(v);
      for (const id of ban.ruleRefs) hitIds.push(id);
      for (const rule of config.rules ?? []) {
        if (ruleMatches(rule, exec)) {
          hitIds.push(rule.id);
          for (const v of rule.violations) violations.push(v);
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

export function createRefusalReceipt(input: {
  tool: string;
  callId: string;
  sessionId: string | null;
  decision: KernelDecision;
  attemptedParams: unknown;
}): RefusalReceipt {
  const { tool, callId, sessionId, decision, attemptedParams } = input;
  const receipt: RefusalReceipt = {
    receiptId: globalThis.crypto.randomUUID(),
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
