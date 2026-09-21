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

// 【F3 同步 · watch 域夹具】`lib/watch/**` 相关套件的共享构造器。
//
// 为什么单独一个模块（而不是并入 `gate-fixture.mjs`）：本模块**需要 lib 依赖**
//   （`lib/watch/lane-heartbeat.js` + `lib/comms/mailbox.js`），而 `gate-fixture.mjs` 被 **39 个套件**
//   导入 ⇒ 给它加 lib 依赖会无谓扩大所有套件的加载面。域内 helper 承担域内依赖。
//
// 收敛依据（夹具审计 `docs/fixture-audit-2026-09-21.md` §3.3「必合档」，2026-09-21）：
//   `hb` 在 4 个 watch 套件里各写一份，函数体**逐字相同**（**6/6 对 100%** 相似，`dup-similarity.mjs`）。
//   ⚠ 原名 `hb` 过于简略 ⇒ 单点用全称 `laneHeartbeat`；4 个调用方的调用点已同步改名（禁止别名遮蔽）。
import * as mailbox from '../../lib/comms/mailbox.js';
import { createLaneHeartbeat } from '../../lib/watch/lane-heartbeat.js';

/**
 * 组装 lane 心跳引擎（`createLaneHeartbeat` 的测试装配）。
 * `mailbox` 由本模块统一提供 ⇒ 调用方不必各自 `import * as mailbox`。
 * @param {object} store 引擎 store
 * @param {string} root 本次用例自建根
 * @param {object} [config] 心跳配置
 * @param {object} [opts] 其余透传字段（覆盖 `config` / `mailbox` 等同名键）
 */
export function laneHeartbeat(store, root, config = {}, opts = {}) {
  return createLaneHeartbeat({ store, mailbox, config, root, ...opts });
}
