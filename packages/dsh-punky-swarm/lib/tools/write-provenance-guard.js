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

// ── 拒态形态（**本仓实测，禁用 throw**）────────────────────────────────────────────
//   `batchId`/`laneId` 在场也不能当溯源证据：它们是**执行位置**，不是**来源**。
import { SUITE_TOOLS } from '../engine/suite.js';
import { createToolsPort } from '../provider-dsh/tools-http.js';
import { recordGuardRefusal, GUARD_SOURCE } from '../governance/guard-receipt.js';

export const HOST_EXEMPT = Object.freeze([
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'send_message',
  'interrupt_agent',
]);

/**
 * 所以本常量不会随工具面增删而漂移（派生 ≠ 手抄）。
 */
export const WRITE_FAMILY = Object.freeze(
  SUITE_TOOLS.filter((tool) => tool.write === true && !HOST_EXEMPT.includes(tool.name)).map((tool) => tool.name),
);

const WRITE_FAMILY_SET = new Set(WRITE_FAMILY);

/** 拒态前缀（模型可见，宿主原样保留）。 */
export const SOURCE_RUN_ID_MISSING = 'source-run-id-missing:';

const installedOn = new WeakSet();

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * 判定单次调用。**纯函数**：`string` = 拒绝（宿主据此短路），`undefined` = 放行。
 * @param {object} execution 宿主传入门禁的调用面：`{ name, arguments?, agent? }`
 * @returns {string|undefined} 拒绝字符串（前缀 `source-run-id-missing:` + 工具名）或 `undefined`
 */
export function writeProvenanceDecision(execution) {
  const name = execution?.name;
  if (typeof name !== 'string' || !WRITE_FAMILY_SET.has(name)) return undefined;

  if (isNonEmptyString(execution?.arguments?.sourceRunId)) return undefined;

  if (isNonEmptyString(execution?.agent?.session?.id)) return undefined;

  return SOURCE_RUN_ID_MISSING + ' ' + name;
}

/**
 * 注册守卫。与 `installDifficultyGuard` **并列**（不改它、不并入它）。
 * @param {object} ctx 插件上下文（需 `工具面 guard（经 `lib/provider-dsh/` 端口安装）` 可调用；不可用时**静默不注册**并返回 false）
 * @param {object} [deps] 预留（本守卫不需要 store/config；保持与同族签名一致）
 * @returns {boolean} 本次是否真的注册了（幂等 ⇒ 重复调用返回 false）
 */
export function installWriteProvenanceGuard(ctx, deps = {}) {
  if (installedOn.has(ctx)) return false;
  const installed = createToolsPort(ctx).installGuard((execution) => {
    const decision = writeProvenanceDecision(execution);
    // 【⑥-1 · 2026-11-08 裁决乙1b】守卫拒绝留痕（收据 + 事件流；不接升级链、不改变裁决）。
    if (decision !== undefined) {
      recordGuardRefusal(deps?.root, execution, {
        reason: decision,
        source: GUARD_SOURCE.PROVENANCE,
        log: ctx?.logger,
      });
    }
    return decision;
  });
  if (!installed) return false; // 工具面不可用 / 宿主无 guard 面 ⇒ 静默不注册（原语义逐字保留）
  installedOn.add(ctx);
  return true;
}
