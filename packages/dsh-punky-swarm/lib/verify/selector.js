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

// 服务端权威语义：裁决侧按 identity+tool+argsHash 全等绑定，模型提交值一律忽略（不参与匹配）。
import { createHash } from 'node:crypto';

export function canonicalizeArgs(value) {
  if (Array.isArray(value)) return value.map(canonicalizeArgs);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = canonicalizeArgs(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalizeArgs(value))).digest('hex').slice(0, 12);
}

export function freezeSelector({ acId, tool, args = {} }) {
  if (typeof acId !== 'string' || !acId.length) throw new Error('freezeSelector: acId required');
  if (typeof tool !== 'string' || !tool.length) throw new Error('freezeSelector: tool required');
  const canonical = canonicalizeArgs(args);
  const argsHash = stableHash({ tool, args: canonical });
  const selectorRef = acId + ':' + argsHash;
  return { acId, tool, args: canonical, argsHash, selectorRef };
}

export function createSelectorRegistry() {
  const byAc = new Map();   // acId -> frozen selector
  const byKey = new Map();  // argsHash -> acId（exact-only 全等身份，无模糊匹配）

  return {
    bindSelector(acId, selector) {
      if (byAc.has(acId)) throw new Error('duplicate AC binding: ' + acId);
      if (!selector || typeof selector.tool !== 'string') throw new Error('bindSelector: tool required for ' + acId);
      const frozen = freezeSelector({ acId, tool: selector.tool, args: selector.args ?? {} });
      if (byKey.has(frozen.argsHash)) {
        throw new Error('duplicate selector: ' + frozen.argsHash + ' already bound to AC ' + byKey.get(frozen.argsHash));
      }
      byKey.set(frozen.argsHash, acId);
      byAc.set(acId, frozen);
      return frozen;
    },

    bindAll(acList = []) {
      if (!Array.isArray(acList)) throw new Error('bindAll: acList must be an array');
      return acList.map((ac) => this.bindSelector(ac.id, { tool: ac.tool, args: ac.args }));
    },

    has(acId) { return byAc.has(acId); },
    get(acId) { return byAc.get(acId) ?? null; },
    size() { return byAc.size; },
    list() { return [...byAc.values()]; },
    clear() { byAc.clear(); byKey.clear(); },

    match(tool, args) {
      const key = stableHash({ tool, args: canonicalizeArgs(args) });
      return byKey.get(key) ?? null;
    },
    matchByKey(argsHash) {
      return typeof argsHash === 'string' ? (byKey.get(argsHash) ?? null) : null;
    },
  };
}
