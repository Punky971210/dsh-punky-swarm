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

/** 证据捕获挂载：`capabilities.verify.enabled`（缺省开）门控；`enabled=false` 不挂 hook、零运行时开销。
 *  宿主缺 `ctx.on` 或未给 `root` ⇒ 静默降级（可判定，不抛宿主原生错）。 */
export function mountVerify(ctx, { root, config, logger } = {}) {
  const cfg = resolveVerifyConfig(config);
  const log = logger ?? ctx?.logger ?? null;
  const inert = (reason) => ({ installed: false, inert: true, reason, count: () => 0, dispose() {} });
  if (cfg.enabled !== true) {
    log?.info?.('[dsh-punky-swarm] verify mount disabled (capabilities.verify.enabled === false)：'
      + 'post-execute 证据捕获未装配');
    return inert('disabled');
  }
  if (!root || typeof ctx?.on !== 'function') return inert('ctx.on unavailable');
  const cap = installEvidenceCapture(ctx, { root, enabled: true });
  if (cap.installed) {
    log?.info?.('[dsh-punky-swarm] verify capability enabled: post-execute evidence capture mounted');
  }
  return { installed: cap.installed, count: cap.count, dispose() { cap.dispose(); } };
}
