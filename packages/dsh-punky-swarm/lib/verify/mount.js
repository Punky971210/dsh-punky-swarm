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

// verify/mount.js —— verify 引擎级接线（装配统一决策包 §4 Part2，批次 4 集成注意项 1 收口）
// index.js 的可测缝：capabilities.verify.enabled 门控挂 installEvidenceCapture（tools/post-execute 证据捕获），
//   返回 { installed, count, dispose }；enabled=false 零运行时开销；ctx.on 缺失静默降级（宿主能力缺失不炸）。
// 边界：createCompletionGate 与 audit lane 显式 DI 消费路径一字不动（gate.js 零改动）——本文件只做引擎级捕获装配，
//   裁决/拦截语义仍在 gate.js（advisory 只记录 / enforce 拦截），捕获侧只落 blob + ledger。
import { installEvidenceCapture } from './evidence.js';
// resolveVerifyConfig/VERIFY_DEFAULTS 统一归口 lib/schema.js（装配统一决策包 §3.1 注册表 default：
//   assembly-schema lane 落地同款实现，本文件不再自包含双实现——语义一致，消费路径单点，防未来字段漂移）
import { VERIFY_DEFAULTS, resolveVerifyConfig } from '../schema.js';
export { VERIFY_DEFAULTS, resolveVerifyConfig };

// 引擎级捕获挂载（index.js apply 内调用）：
//   enabled=true + ctx.on 可用 → installEvidenceCapture 订阅 tools/post-execute（pass-through 不断链）→ installed:true；
//   enabled=false（默认）→ installed:false / reason:'disabled'，不注册任何监听，零副作用；
//   ctx.on 缺失 → installed:false / reason:'ctx.on unavailable'，静默降级不 throw。
export function mountVerify(ctx, { root, config, logger } = {}) {
  const cfg = resolveVerifyConfig(config);
  const log = logger ?? ctx?.logger ?? null;
  const inert = (reason) => ({ installed: false, reason, mode: cfg.mode, count: () => 0, dispose() {} });
  if (cfg.enabled !== true) return inert('disabled');
  if (!root || typeof ctx?.on !== 'function') return inert('ctx.on unavailable');
  const cap = installEvidenceCapture(ctx, { root, enabled: true });
  if (cap.installed) {
    log?.info?.('[dsh-punky-swarm] verify capability enabled: post-execute evidence capture mounted (mode=' + cfg.mode + ')');
  }
  return { installed: cap.installed, count: cap.count, mode: cfg.mode, dispose() { cap.dispose(); } };
}
