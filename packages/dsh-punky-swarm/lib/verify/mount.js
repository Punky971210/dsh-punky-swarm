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

import { installEvidenceCapture } from './evidence.js';
import { VERIFY_DEFAULTS, resolveVerifyConfig } from '../schema.js';
export { VERIFY_DEFAULTS, resolveVerifyConfig };

export function mountVerify(ctx, { root, config, logger } = {}) {
  const cfg = resolveVerifyConfig(config);
  const log = logger ?? ctx?.logger ?? null;
  //   ⇒ 配 enforce 实际按 advisory 生效。本处**必须早于任何 inert 提前返回**，否则 `ctx.on` 缺失时
  //   该真相永不可见。语义边界：只多一条日志，**判定路径零改动**（接线/退役取向见 docs/governance-technical.md）。
  if (cfg.enabled === true && cfg.mode === 'enforce') {
    log?.warn?.('[dsh-punky-swarm] capabilities.verify.mode="enforce" is NOT wired（未接线）: '
      + 'createCompletionGate has no production consumer — only evidence capture is mounted, '
      + 'and it never reads `mode` ⇒ enforce is inert, the verdict runs as advisory. '
      + 'Set mode="advisory" to silence this warning; see docs/governance-technical.md '
      + '(wiring vs retirement is an open decision).');
  }
  const inert = (reason) => ({ installed: false, inert: true, reason, mode: cfg.mode, count: () => 0, dispose() {} });
  if (cfg.enabled !== true) {
    log?.info?.('[dsh-punky-swarm] verify mount disabled (capabilities.verify.enabled === false)：'
      + 'post-execute 证据捕获未装配；mode=' + cfg.mode);
    return inert('disabled');
  }
  if (!root || typeof ctx?.on !== 'function') return inert('ctx.on unavailable');
  const cap = installEvidenceCapture(ctx, { root, enabled: true });
  if (cap.installed) {
    log?.info?.('[dsh-punky-swarm] verify capability enabled: post-execute evidence capture mounted (mode=' + cfg.mode + ')');
  }
  return { installed: cap.installed, count: cap.count, mode: cfg.mode, dispose() { cap.dispose(); } };
}
