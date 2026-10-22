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

// verify/mount.js —— verify 引擎级接线（集成注意项 1 收口）
// index.js 的可测缝：capabilities.verify.enabled 门控挂 installEvidenceCapture（tools/post-execute 证据捕获），
//   返回 { installed, count, dispose }；enabled=false 零运行时开销；ctx.on 缺失静默降级（宿主能力缺失不炸）。
// 边界：createCompletionGate 与 audit lane 显式 DI 消费路径一字不动（gate.js 零改动）——本文件只做引擎级捕获装配，
//   裁决/拦截语义仍在 gate.js（advisory 只记录 / enforce 拦截），捕获侧只落 blob + ledger。
// 本文件与 lib/state/gates.js（批次内层间门禁）零耦合——不 import 亦不被其
//   import；verify/gate.js 的 createCompletionGate / evaluateAcEvidence 消费点 = audit lane 显式 DI 注入
//   （{acList, ledger, readBlob}）+ 装配层门控（index.js mountVerify 挂捕获 hook；assembly/schema.js verify
//   键注册表 consumers 标注），无共享调用路径，无需改动任何调用代码。
import { installEvidenceCapture } from './evidence.js';
// resolveVerifyConfig/VERIFY_DEFAULTS 统一归口 lib/schema.js（注册表 default：
//   同款实现已在装配 schema 侧落地，本文件不再自包含双实现——语义一致，消费路径单点，防未来字段漂移）
import { VERIFY_DEFAULTS, resolveVerifyConfig } from '../schema.js';
export { VERIFY_DEFAULTS, resolveVerifyConfig };

// 引擎级捕获挂载（index.js apply 内调用）：
//   enabled=true + ctx.on 可用 → installEvidenceCapture 订阅 tools/post-execute（pass-through 不断链）→ installed:true；
//   enabled=false（显式关闭——verify 出厂默认开，resolveVerifyConfig 缺省 enabled=true）→ installed:false / reason:'disabled'，不注册任何监听，零副作用；
//   ctx.on 缺失 → installed:false / reason:'ctx.on unavailable'，静默降级不 throw。
export function mountVerify(ctx, { root, config, logger } = {}) {
  const cfg = resolveVerifyConfig(config);
  const log = logger ?? ctx?.logger ?? null;
  // 诚实面（A1-P2-11）：`mode:'enforce'` **未接线** —— `verify/gate.js` 的 `createCompletionGate`
  //   无生产消费点（唯一 import 方是测试的显式 DI），装配侧只挂证据捕获 hook、**从不读 mode**
  //   ⇒ 配 enforce 实际按 advisory 生效。本处**必须早于任何 inert 提前返回**，否则 `ctx.on` 缺失时
  //   该真相永不可见。语义边界：只多一条日志，**判定路径零改动**（接线/退役取向见 docs/governance-technical.md）。
  if (cfg.enabled === true && cfg.mode === 'enforce') {
    log?.warn?.('[dsh-punky-swarm] capabilities.verify.mode="enforce" is NOT wired（未接线）: '
      + 'createCompletionGate has no production consumer — only evidence capture is mounted, '
      + 'and it never reads `mode` ⇒ enforce is inert, the verdict runs as advisory. '
      + 'Set mode="advisory" to silence this warning; see docs/governance-technical.md '
      + '(wiring vs retirement is an open decision).');
  }
  const inert = (reason) => ({ installed: false, reason, mode: cfg.mode, count: () => 0, dispose() {} });
  if (cfg.enabled !== true) return inert('disabled');
  if (!root || typeof ctx?.on !== 'function') return inert('ctx.on unavailable');
  const cap = installEvidenceCapture(ctx, { root, enabled: true });
  if (cap.installed) {
    log?.info?.('[dsh-punky-swarm] verify capability enabled: post-execute evidence capture mounted (mode=' + cfg.mode + ')');
  }
  return { installed: cap.installed, count: cap.count, mode: cfg.mode, dispose() { cap.dispose(); } };
}
