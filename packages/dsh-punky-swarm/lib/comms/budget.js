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

// 文件 budget：mailbox 循环防护（C4，dsh-team 循环防护三件套语义适配）
// 借鉴 dsh-team config.ts:41-42（maxChainHops/maxChainRoundTrips）、service.ts:514-571（chainFor/REPEATED_MESSAGE/记账+CHAIN_MEMORY 裁剪）、errors.ts（错误码闭环）。
// 纯函数模块：不 import store/mailbox（状态由调用方传入），接线在 tools/mailbox-tools.js。
// 链语义（决策包 §4.2）：蟛蜞 worker 读多封消息无「正在处理哪条」机械绑定 → 链由发送方在 meta.chain 显式声明 {id, hop}；
//   不声明 = 新链 hop=0（向后兼容，现有调用零感知）。
import { randomUUID } from 'node:crypto';

// 记账上限：chains 保留最近 64 条链（dsh-team CHAIN_MEMORY=64），batch JSON 不膨胀
export const CHAIN_MEMORY = 64;

// 有序对 key：from→to（与决策包状态 shape 同构）
export function chainKey(from, to) {
  return String(from ?? '?') + '→' + String(to ?? '?');
}

function validChainId(id) {
  return typeof id === 'string' && id.length > 0;
}

// chainFor：显式 meta.chain 继承 hop+1；无显式声明 → 开新链（hop=0）
// msg: { meta?: { chain?: {id, hop} } }；chainsState 当前未用于派生（链身份由发送方声明），保留入参以对齐契约签名
export function chainFor(_chainsState, msg) {
  const explicit = msg?.meta?.chain;
  if (explicit && validChainId(explicit.id)) {
    const hop = Number.isInteger(explicit.hop) && explicit.hop >= 0 ? explicit.hop + 1 : 1;
    return { id: explicit.id, hop };
  }
  return { id: randomUUID(), hop: 0 };
}

// checkBudget：环防护校验（纯函数，不 mutate 任何入参）
// meta: { chain?: {id, hop}, from?, to?, text? }（text 用于一字不差重发拒绝）
// chainsState: { chains: { [chainId]: { edges: { [from→to]: count }, said: { [from→to]: lastText } } }, order: [chainId] }
// 返回 { ok:true, chain } | { ok:false, code:'CHAIN_EXHAUSTED'|'PING_PONG'|'REPEATED_MESSAGE', chain, detail }
export function checkBudget(meta, chainsState, { maxChainHops = 4, maxChainRoundTrips = 2 } = {}) {
  const chain = meta?.chain;
  if (!chain || !validChainId(chain.id)) {
    // 无链声明 → 视为新链 hop=0（向后兼容，现有调用零感知）
    return { ok: true, chain: { id: randomUUID(), hop: 0 } };
  }
  const hop = Number.isInteger(chain.hop) && chain.hop >= 0 ? chain.hop : 0;
  // B1 环检测：链跳数超限
  if (hop > maxChainHops) {
    return {
      ok: false,
      code: 'CHAIN_EXHAUSTED',
      chain: { id: chain.id, hop },
      detail: 'chain ' + chain.id + ' hop=' + hop + ' exceeded maxChainHops=' + maxChainHops
        + '; settle it yourself and report to the leader',
    };
  }
  const rec = chainsState?.chains?.[chain.id];
  const from = meta?.from;
  const to = meta?.to;
  if (rec && from != null && to != null) {
    const key = chainKey(from, to);
    // B2 往返上限：同链同有序对往返 ≥ maxChainRoundTrips → PING_PONG
    const count = rec.edges?.[key] ?? 0;
    if (count >= maxChainRoundTrips) {
      return {
        ok: false,
        code: 'PING_PONG',
        chain: { id: chain.id, hop },
        detail: 'chain ' + chain.id + ' round-trips ' + key + '=' + count + ' reached maxChainRoundTrips=' + maxChainRoundTrips
          + '; settle it yourself and report to the leader',
      };
    }
    // B3 重发拒绝：同链同向同文本 → REPEATED_MESSAGE（跨链/新链同文本放行）
    if (typeof meta.text === 'string' && typeof rec.said?.[key] === 'string' && rec.said[key] === meta.text) {
      return {
        ok: false,
        code: 'REPEATED_MESSAGE',
        chain: { id: chain.id, hop },
        detail: 'chain ' + chain.id + ' repeated identical message on ' + key
          + '; start a new chain to resend',
      };
    }
  }
  return { ok: true, chain: { id: chain.id, hop } };
}

// recordChain：记账（edges 计数 + said 文本 + CHAIN_MEMORY=64 插入序裁剪）；纯函数返回新链状态，不 mutate
export function recordChain(chainsState, msg) {
  const base = chainsState ?? { chains: {}, order: [] };
  const chain = msg?.meta?.chain;
  if (!chain || !validChainId(chain.id)) return base;
  const chainId = chain.id;
  const from = msg?.meta?.from;
  const to = msg?.meta?.to;
  const prev = base.chains?.[chainId] ?? { edges: {}, said: {} };
  const edges = { ...(prev.edges ?? {}) };
  const said = { ...(prev.said ?? {}) };
  if (from != null && to != null) {
    const key = chainKey(from, to);
    edges[key] = (edges[key] ?? 0) + 1;
    if (typeof msg.meta.text === 'string') said[key] = msg.meta.text;
  }
  const chains = { ...(base.chains ?? {}), [chainId]: { edges, said } };
  // 插入序裁剪：order 记录链创建顺序，超 CHAIN_MEMORY 删除最旧链（batch JSON 不膨胀）
  const order = Array.isArray(base.order) ? [...base.order] : [];
  if (!order.includes(chainId)) order.push(chainId);
  while (order.length > CHAIN_MEMORY) {
    const drop = order.shift();
    delete chains[drop];
  }
  return { chains, order };
}
