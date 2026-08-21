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

// verify/selector.js —— AC×selector 冻结（C3 成熟模式：dsh-verification selector 冻结，exact-only）
// 纯逻辑模块（无 IO、无工具面）：canonicalizeArgs（键递归排序）+ stableHash（sha256 前缀 12）。
// 服务端权威语义：裁决侧按 identity+tool+argsHash 全等绑定，模型提交值一律忽略（不参与匹配）。
// AC 声明来源（零核心侵入）：批次 plan 产物 spec.md「## 验收标准」章节 —— audit lane 任务包携带
// AC 清单 [{id, tool, args}]，不扩展 wave-plan task schema（wave-plan.js 零改动）。
import { createHash } from 'node:crypto';

// 递归规范化参数：对象键递归排序（{a:1,b:2} 与 {b:2,a:1} 同哈希）；数组保序；undefined 剔除；
// 标量原样（字符串/数字/布尔/null）。用于哈希与全等匹配的规范形态。
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

// 稳定哈希：sha256 → 12 位 hex 前缀（同输入恒等，键序无关）
export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalizeArgs(value))).digest('hex').slice(0, 12);
}

// AC×selector 冻结：同一 (acId, tool, args) 两次冻结 → selectorRef 稳定；参数键序无关；
// argsHash 只含 tool+args（跨 acId 可比较），selectorRef = acId:argsHash（可回溯到 AC）。
export function freezeSelector({ acId, tool, args = {} }) {
  if (typeof acId !== 'string' || !acId.length) throw new Error('freezeSelector: acId required');
  if (typeof tool !== 'string' || !tool.length) throw new Error('freezeSelector: tool required');
  const canonical = canonicalizeArgs(args);
  const argsHash = stableHash({ tool, args: canonical });
  const selectorRef = acId + ':' + argsHash;
  return { acId, tool, args: canonical, argsHash, selectorRef };
}

// AC→selector 绑定注册表（exact-only）：一 selector 只绑一个 AC，重复绑定拒绝。
// audit lane 在裁决前置入 AC 清单；捕获侧按 argsHash 全等反查命中的 AC。
export function createSelectorRegistry() {
  const byAc = new Map();   // acId -> frozen selector
  const byKey = new Map();  // argsHash -> acId（exact-only 全等身份，无模糊匹配）

  return {
    // 绑定单个 AC：{id, tool, args}（audit lane AC 清单逐项调用）；重复 AC / 重复 selector 拒绝
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

    // 批量绑定（AC 清单形态 [{id, tool, args}]），返回冻结后的 selector 列表
    bindAll(acList = []) {
      if (!Array.isArray(acList)) throw new Error('bindAll: acList must be an array');
      return acList.map((ac) => this.bindSelector(ac.id, { tool: ac.tool, args: ac.args }));
    },

    has(acId) { return byAc.has(acId); },
    get(acId) { return byAc.get(acId) ?? null; },
    size() { return byAc.size; },
    list() { return [...byAc.values()]; },
    clear() { byAc.clear(); byKey.clear(); },

    // exact-only 匹配（捕获侧/审计侧用）：tool+args 全等 → 命中的 acId；未命中 → null（无模糊）
    match(tool, args) {
      const key = stableHash({ tool, args: canonicalizeArgs(args) });
      return byKey.get(key) ?? null;
    },
    // 按已算好的 argsHash 反查（台账条目带 selectorKey 时免重算）
    matchByKey(argsHash) {
      return typeof argsHash === 'string' ? (byKey.get(argsHash) ?? null) : null;
    },
  };
}
