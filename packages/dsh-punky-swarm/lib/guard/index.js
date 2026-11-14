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

// dsh-punky-guard —— 工具护栏 L1 子插件行（`cordis.patch.yml` 的 `name: 'dsh-punky-swarm/guard'`）。
//
// 本文件是**薄入口**（契约 §S-1.4：≤ 120 行）：判定链实现在 `./wiring.js`（订阅 + pre/post 决策）/
// `./kernel.js`（6 原语内核）/ `./tool-ban.js`（第三类判定面）/ `./allowlist.js` / `./state-store.js` /
// `./narrow.js` / `./classify.js` / `./denial.js` / `./types.js` —— 全部是本包内的**同一份**代码
// （`exports['./guard']` 子路径，不是复制品），因此与 core 共享同一份 `lib/core-ports.js` 模块实例
// ⇒ 端口是**同进程同一对象**，不是跨进程协议。
//
// 三件职责（契约 §S-2.4 / §S-4.4，顺序与时机是契约不是偏好）：
//   ① 登记第 9 个端口键 `guard`（**先摘后登**：同进程重建 / 多夹具第二次 apply 否则抛 `DUPLICATE_CORE_PORT`）；
//   ② `mount()` 内做**行级消费方登记**（`corePort('hooks').registerConsumer(ctx, {id:'governance'})`）——
//      本行 apply 时 `hooks` 端口**尚未登记**（引擎行在**本行之后** apply）⇒ 登记点只能是 `mount()`；
//      幂等（同 ctx 同 id 返回同一 disposer），热切 remount 反复调用不累积；
//   ③ 卸载：**只**在行 disposer 里 `releaseConsumer` + 摘自己那份端口。
//      ⚠ **绝不可**在 `mount()` 返回的句柄 `dispose()` 里 `releaseConsumer`：热切配置会 dispose + 原地重挂，
//      那会让 `owns(本行 ctx)` 变回 false ⇒ 护栏**静默回落** `ctx.on`（照跑、序表校验失效、无任何报错）。
//
// 层位与行序（契约 §S-2.3 / §S-2.4 / C-1）：**宿主层**行（与引擎行同一 `- insert:` 列表），且**必须排在
//   引擎行之前** —— core 在装配期（`installGovernanceSurface`）**同步**消费 `corePort('guard')`；
//   端口晚一步就位 core 只能走「端口缺席 ⇒ 零拦截」的降级路 = **漏拦**，而写反不报错、只多一条 warn。
//
// 配置（契约 §S-7 / C-4 / N-12）：本行**不写 `config:`**。生效配置唯一源 = 引擎行静态 config 快照，
//   经 `mount()` 入参（`config` / `resolvedCfg` / `root` / `allowlistScope` / `onRefusal`）交给本行。
//   写第二份 = 两个真源 ⇒ 热更只命中引擎行 ⇒ 运行期静默分叉（护栏侧表现为空表 ⇒ 恒 ALLOW）。
//
// inject 面（契约 §S-2.3）：**空**。宿主 cordis 4.0.5 的 `inject` 无 optional 位 ⇒ 硬注入会让本行 pending；
//   本行对宿主能力的全部需求经 `corePort` 端口层取得（与 engine / panel 两行同法）。

import { corePort, hasCorePort, registerCorePort, unregisterCorePort } from '../core-ports.js';
import { installGovernanceHook } from './wiring.js';

export const name = 'dsh-punky-guard';
/** 空声明：本行对宿主零硬依赖（依赖全部经端口层，见文件头）；引擎行的端口**晚于**本行登记也不违约（见 ②）。 */
export const inject = [];

/** hooks 端口里的消费方 id（契约 §S-4.2；`registered().consumer` 与 V-9 三元组读的是它）。 */
const CONSUMER_ID = 'governance';

export const apply = (ctx) => {
  const log = ctx?.logger ?? null;
  /** 本行在 hooks 端口上的登记 disposer（**行级**生命周期，不进 `mount()` 句柄）。 */
  let consumerRelease = null;
  /** 登记归属的端口实例（引擎行热重载会换实例 ⇒ 换实例须重新登记，不能复用旧 disposer）。 */
  let consumerPort = null;

  // ② 行级消费方登记（幂等）：让 `hooks.owns(本行 ctx) === true` ⇒ `registerHook` 走端口分支，
  //    P0·X-3 的冻结序表 / 重名检测 / `registered()` 机检面对护栏继续生效（否则回落 `ctx.on`，序靠运气）。
  const ensureConsumer = () => {
    if (!hasCorePort('hooks')) return;                        // 端口尚未由引擎行登记（首次 apply 即此态）
    const port = corePort('hooks');
    if (consumerPort === port && port.owns?.(ctx) === true) return;   // 已是本行登记（幂等快路）
    if (typeof port.registerConsumer !== 'function') return;  // 端口无多 ctx 面 ⇒ 保持旧回落语义（兼容）
    try {
      consumerRelease = port.registerConsumer(ctx, { id: CONSUMER_ID });
      consumerPort = port;
    } catch (e) {
      // 登记失败（同 id 被另一个 ctx 占用 = 双挂）不得静默：响亮 warn，并保持回落语义（行为不劣化）。
      log?.warn?.('[dsh-punky-swarm/guard] hooks 端口消费方登记失败（回落 ctx.on，序表机检面失效）: '
        + String(e?.message ?? e));
    }
  };

  const portImpl = {
    id: 'dsh-punky-swarm/guard',
    version: 1,
    /**
     * 装一次护栏（契约 §S-3.2）。**幂等**：可重复调用（每次返回新实例；上一实例由 core 先 dispose）。
     * **永不抛**：内部任何失败一律返回 inert 手柄（与 `installGovernanceHook` 的 inert 纪律一致）——
     * 护栏是安全面，装配期抛错会让整条插件链 pending，那时连「零拦截」都不会留痕。
     */
    mount(params = {}) {
      ensureConsumer();
      try {
        return installGovernanceHook(ctx, { ...params, logger: log });
      } catch (e) {
        const reason = 'mount-failed: ' + String(e?.message ?? e);
        log?.warn?.('[governance] inert(warn): ' + reason);
        return { installed: false, inert: true, reason, level: 'warn', refusals: { count: () => 0 }, dispose() {} };
      }
    },
  };
  // ① 先摘后登（同 `panelSurface` / `store` / `presets` 口径）
  unregisterCorePort('guard');
  registerCorePort('guard', portImpl);

  // ③ 卸载：先摘 hooks 消费方登记（只摘登记表），再摘**自己那份**端口（行重入时旧 disposer 不得摘接管者）。
  //    宿主总线上的 listener 归 core 侧句柄 `dispose()`（`rt.governanceHook?.dispose?.()`），两条路径互不代偿。
  return () => {
    try {
      if (typeof consumerRelease === 'function') consumerRelease();
    } catch { /* 幂等：重复释放不阻断卸载 */ }
    consumerRelease = null;
    consumerPort = null;
    if (hasCorePort('guard') && corePort('guard') === portImpl) unregisterCorePort('guard');
  };
};
