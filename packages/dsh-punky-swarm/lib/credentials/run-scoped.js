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

// run-scoped 凭据（I-18）：**按执行身份**发放、随该身份结束而过期的一次性凭据。
//
// 身份键 = `sourceRunId`（= `execution.agent.session.id` = `subagent/end` 的 `info.id`），与写族溯源（S3）**同一身份源**。
//   ⚠ 刻意**不**采用宿主观察 id：`lib/engine/dispatch.js` 明文记载它是 `observeRun` 侧的随机 UUID，
//     登记面只用会话 id；若这里再接第二身份源，同一件事就有两个键，越早对齐越省事。
//
// 本模块的边界（红线）：**零依赖、纯内存、不写盘、不落事件、不承载任何门禁策略**。
//   「该不该放行 / 该不该结算」是门禁层的事（`lib/state/gates/**` 与 `ctx.tools.guard` 链）；
//   此处若复制一份判定，两份必然漂移。
import { randomUUID } from 'node:crypto';

/** 过期判别前缀（供调用方判别取值结果；本模块**不抛**，只返回 `null`）。 */
export const CREDENTIAL_EXPIRED = 'credential-expired:';

/**
 * 缺省存活期：**45 分钟**。
 *
 * 取值理由（不是随手数）：
 *   · 下界 —— 必须覆盖一次 exec 席位的典型跑动。本仓观察到的最长单 lane 跑动以「分钟」计，
 *     而 `subagent/end` 实测**晚到 60–63 s**（`lib/engine/auto-settle.js:227/:323`），
 *     故 TTL 要显著大于「迟到窗口 + 跑动时长」，否则凭据会在 run 还在干活时就先过期；
 *   · 上界 —— 凭据是**能力载体**，越长寿越危险；45 min 只比「一小时」短一档，便于人肉核对日志时段；
 *   · 与 TTL 无关的那一路（钩子吊销）才是「随 run 结束」的主判据，TTL 只是兜底，
 *     因此宁可给宽一点，避免把正常任务误杀 —— 兜底过严会变成事实上的硬超时。
 */
export const DEFAULT_TTL_MS = 45 * 60 * 1000;

/**
 * 创建 run-scoped 凭据存储（纯内存）。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 时钟（可注入 ⇒ 过期行为可机核）
 * @param {number} [options.ttlMs] 存活期（可注入 ⇒ 过期行为可机核）
 */
export function createRunScopedCredentials({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  /** @type {Map<string, {sourceRunId: string, issuedAt: number, expiresAt: number, revoked: boolean, values: object}>} */
  const issued = new Map();

  const positiveTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;

  /** 键规范化：非空字符串才算有效身份（其余一律视为「无凭据」）。 */
  const keyOf = (sourceRunId) => (typeof sourceRunId === 'string' && sourceRunId.length > 0 ? sourceRunId : null);

  /** 对外视图（浅拷贝：调用方改不到内部登记项）。 */
  const viewOf = (entry) => ({
    sourceRunId: entry.sourceRunId,
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt,
    ...entry.values,
  });

  return {
    /**
     * 发放：同 `sourceRunId` 再次发放 ⇒ **覆盖**前一版（一次执行只有一个当前凭据，不做版本栈）。
     * @returns 凭据视图（含 `sourceRunId` / `issuedAt` / `expiresAt` / 调用方 values）
     */
    issue(sourceRunId, values = {}) {
      const key = keyOf(sourceRunId);
      if (key === null) throw new TypeError('issue requires a non-empty sourceRunId');
      const issuedAt = now();
      const entry = {
        sourceRunId: key,
        issuedAt,
        expiresAt: issuedAt + positiveTtl,
        revoked: false,
        values: values && typeof values === 'object' ? { ...values } : {},
      };
      issued.set(key, entry);
      return viewOf(entry);
    },

    /**
     * 取用：**未过期且未吊销**才返回凭据视图；其余（过期 / 已吊销 / 未知键 / 非法键）一律 **`null`**。
     * ⚠ 刻意不抛错：没有凭据是**正常状态**（调用方按「缺凭据」处理），不是异常路径。
     */
    resolve(sourceRunId) {
      const key = keyOf(sourceRunId);
      if (key === null) return null;
      const entry = issued.get(key);
      if (entry === undefined) return null;
      // 兜底路（惰性）：即便吊销钩子还没到（实测晚到 60–63 s），这里也能立刻判出过期/已吊销。
      if (entry.revoked) return null;
      if (now() >= entry.expiresAt) return null;
      return viewOf(entry);
    },

    /**
     * 吊销：确有该键 ⇒ `true` 并使其失效；未知键 ⇒ `false`（**幂等、不抛**）。
     */
    revoke(sourceRunId) {
      const key = keyOf(sourceRunId);
      if (key === null) return false;
      const entry = issued.get(key);
      if (entry === undefined) return false;
      const wasActive = !entry.revoked;
      entry.revoked = true;
      return wasActive;
    },

    /** 登记项数量（**展示位，不作判据**：判据一律走 `resolve` 的取值）。 */
    size() {
      return issued.size;
    },

    /** 清理已过期 / 已吊销项（**展示位**；返回清理条数）。 */
    sweep() {
      const at = now();
      let removed = 0;
      for (const [key, entry] of issued) {
        if (entry.revoked || at >= entry.expiresAt) {
          issued.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    /** 仅供测试观察的元信息（不含任何凭据内容；不参与判定）。 */
    ttl() {
      return positiveTtl;
    },
  };
}

/**
 * 主路（主动吊销）：订阅 `subagent/end`，按 `info.id`（= `sourceRunId`）精确吊销该次执行的凭据。
 *
 * 形态照 `lib/engine/auto-settle.js` 的同名订阅：
 *   · 事件名 `'subagent/end'`；`{ global: true }` 是**硬性要求**（否则拿不到进程级子会话结束事件）；
 *   · `info.id` 是 durable 会话 id —— 与凭据键**同源**，无需再查映射。
 *
 * ⚠ 这一路**只吊销、不判定**：不结算、不过期策略、不写事件。
 * ⚠ 也**不能只靠**这一路：该事件实测晚到 60–63 s，迟到窗口内凭据仍可能被取用 ⇒ 必须配 `resolve` 的惰性过期。
 *
 * @param {object} ctx 宿主上下文（需 `ctx.on`；不可用 ⇒ `installed:false`，**不抛**）
 * @param {object} store `createRunScopedCredentials(...)` 的返回
 * @param {object} [deps] 可选 `{ logger }`
 * @returns {{installed: boolean, reason?: string, dispose?: () => void}}
 */
export function installRunScopedCredentialRevoker(ctx, store, deps = {}) {
  if (typeof ctx?.on !== 'function') return { installed: false, reason: 'no-ctx.on' };
  const logger = deps.logger ?? ctx?.logger ?? null;
  const dispose = ctx.on('subagent/end', (info) => {
    // 无 id ⇒ 静默丢弃（不猜身份：拿不到就不吊销，交给惰性过期兜底）
    const id = info && typeof info === 'object' ? info.id : null;
    if (typeof id !== 'string' || id.length === 0) return;
    const revoked = store.revoke(id);
    if (revoked) logger?.debug?.('[credentials] revoked on run end: ' + id);
  }, { global: true });
  return { installed: true, dispose };
}

/** 生成一个不透明凭据 token（**仅当调用方需要 bearer 形态时用**；不参与键判定）。 */
export function newCredentialToken() {
  return randomUUID();
}
