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

// ── 【⑥-1 · 2026-11-08 裁决乙1b】守卫通道拒绝的留痕 ───────────────────────────────────
//   背景：工具调用有**三条**独立拦截通道 ——
//     A `ctx.on('tools/pre-execute')`（governance hook，kernel 规则/工具禁令/状态门）
//     B 工具面 guard 通道（`tools/tier-gate.js#installDifficultyGuard`：模式门/难度门/D 通道/
//       allowlist/只读 shell；注册经 `lib/provider-dsh/` 端口，本层不直触宿主服务名）
//     C 工具面 guard 通道（`tools/write-provenance-guard.js`：写族须带来源）
//   只有 A 写收据（`writeRefusal` 的调用点全在 `governance/wiring.js`）⇒ B/C 的拒绝在
//   `readRefusals` / 拒因事件流 / 面板事件面**完全不可见**。
//
//   本模块 = B/C 的**同一个**留痕入口（单点，两处各自手写会立刻漂移）：
//     ① 链式收据（`writeRefusal`，与 A 同一 schema ⇒ `verifyRefusals` 可校验、面板可读）；
//     ② 拒因事件流（`appendRefusalEvent`，JSONL 可见性）。
//
//   **刻意不做的**：不喂 `recordGovernanceRefusal`（升级链）。理由：那会让「同一 worker 连撞
//   3 次难度门 ⇒ 批被 pause」成为新的暂停路径，属**语义变更**而非留痕补齐；用户裁决 ⑥-1 只批
//   留痕（乙1b），不批升级（乙2）。
//
//   成本（⑥-3 落地后实测）：链式收据 ~1.5ms/次（链尾缓存已把 O(N) 降到 O(1)）+ 事件流 0.2ms。
import { createRefusalReceipt } from './kernel.js';
import { writeRefusal, appendRefusalEvent } from './receipt-store.js';

/** 守卫拒绝的来源标识（写进 `ruleRefs` 与 `receipt.source`，供审计定位是哪条通道）。 */
export const GUARD_SOURCE = Object.freeze({
  DIFFICULTY: 'guard-difficulty',
  MODE: 'guard-mode',
  CHANNEL: 'guard-difficulty-channel',
  ALLOWLIST: 'guard-allowlist',
  APPROVAL: 'guard-approval-ticket',
  READONLY_SHELL: 'guard-readonly-shell',
  PROVENANCE: 'guard-write-provenance',
});

/** 守卫拒态一律按 DENY 留痕（priority 取与 `classify.js` 的 DENY 档一致的值，不含收窄面）。 */
const GUARD_DENY_PRIORITY = 4;

const MODE_INACTIVE_PREFIX = 'mode-inactive:';
const READONLY_PREFIX = 'readonly-blocked:';
const ALLOWLIST_PREFIX = 'allowlist-denied:';

/** 从拒因串反查来源（B 的拒绝串由多个子门产出，前缀已足够定位；未知 ⇒ `guard-difficulty`）。 */
export function sourceOfGuardReason(reason) {
  const r = typeof reason === 'string' ? reason : '';
  if (r.startsWith(MODE_INACTIVE_PREFIX)) return GUARD_SOURCE.MODE;
  if (r.startsWith('GATE_DIFFICULTY_CHANNEL_UNRESOLVED')) return GUARD_SOURCE.CHANNEL;
  if (r.startsWith(ALLOWLIST_PREFIX) || r.includes('allowlist-not-permitted')) return GUARD_SOURCE.ALLOWLIST;
  if (r.includes('approval-needed') || r.includes('approval-args-mismatch')) return GUARD_SOURCE.APPROVAL;
  if (r.startsWith(READONLY_PREFIX) || r.includes('readonly-shell')) return GUARD_SOURCE.READONLY_SHELL;
  return GUARD_SOURCE.DIFFICULTY;
}

/**
 * 为一次守卫拒绝落痕（收据 + 事件流）。**永不抛**（观察者纪律：留痕失败不得改变裁决）。
 * @param {string|null|undefined} root 引擎状态根
 * @param {object} execution 宿主 guard 回调收到的调用面 `{ name, arguments?, agent?, callId? }`
 * @param {{reason: string, source?: string, log?: object}} opts
 * @returns {object|null} 落盘的收据对象（落失败 / 未装根 ⇒ null）
 */
export function recordGuardRefusal(root, execution, { reason, source, log } = {}) {
  if (!root || typeof reason !== 'string' || reason.length === 0) return null;
  const src = typeof source === 'string' && source.length > 0 ? source : sourceOfGuardReason(reason);
  try {
    const receipt = createRefusalReceipt({
      tool: execution?.name,
      callId: execution?.callId,
      sessionId: execution?.agent?.session?.id ?? 'cli',
      decision: {
        primitive: 'DENY',
        priority: GUARD_DENY_PRIORITY,
        reason,
        ruleRefs: [src],
      },
      attemptedParams: execution?.arguments,
    });
    receipt.source = src; // 与 A 的收据区分：本条来自 tools.guard 通道
    writeRefusal(root, receipt);
    appendRefusalEvent(root, receipt.sessionId ?? 'cli', receipt);
    return receipt;
  } catch (e) {
    log?.warn?.('[dsh-punky-swarm] guard refusal receipt failed (observer, decision unaffected): ' + String(e?.message ?? e));
    return null;
  }
}
