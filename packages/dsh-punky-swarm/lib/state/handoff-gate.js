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

// P1/P2 交接门开关的**唯一解析点**（A1-P2-01 补丁③：整块从 `lib/wave-plan.ts` 下沉到本叶子）。
//   **为什么下沉**：原实装住在 `wave-plan.js`，而 `state/gates/entry.js` / `state/gates/handoff.js`
//   只为取本组函数而 import `wave-plan.js`，`wave-plan.js` 又 import `state/gates.js`
//   ⇒ `state/gates.js → gates/entry.js → wave-plan.js → state/gates.js` 构成 **4 模块 SCC**
//   （`state/gates.js` / `entry.js` / `handoff.js` / `wave-plan.js`）。本文件**零 import**
//   （谁都能依赖它、它不依赖谁）⇒ 两个门改指本文件后该 SCC 消失。
//   `wave-plan.ts` 与 `entry.ts` / `handoff.ts` 的导出名、参数个数、语义**逐字不变**（保形再导出）。
//
// ── P1/P2 交接门开关（`task-27` 2026-09-17 设计修正）：**唯一解析点** ────────────────────────────
// 背景（用户裁决）：「门禁应该**只与插件有关**，和父进程无关，也和 dsh 底座无关」——原实现读
//   `process.env.PSWARM_HANDOFF_GATE` ⇒ 插件行为被**启动父进程的环境块**绑架（本机 web 宿主由常驻
//   Desktop 应用派生，其环境块早于变量设置 ⇒ 重启多少次都带不进来）。现改为**插件自己的热配置**：
//     真源 = `<root>/config/runtime.json` 顶层 `gates.handoff.{entry,settle}`
//       （`lib/hot/config-watch.js`：fs.watch + 防抖 → 快照 → `config.changed`；`gates` 已入允许键白名单）；
//     **env 降为兜底**（`PSWARM_HANDOFF_GATE`，兼容既有行为与夹具），**缺省仍关**。
// 单一解析点纪律（硬）：三处消费点（① 建批期 `checkHandoffDeclarations` ② entry 门 ③ 出口门）**全部**经本组
//   函数取值；`process.env.PSWARM_HANDOFF_GATE` **只允许出现在 `lib/state/handoff-gate.js` 内**（grep 判据）。
//   **禁两套读取**。（A1-P2-01 补丁③：该 grep 判据的口径文件随之从 `wave-plan.js` 改名为本文件。）
export const HANDOFF_GATE_ENV = 'PSWARM_HANDOFF_GATE';

const asBool = (v) => (typeof v === 'boolean' ? v : null);
/** 解析门态（**唯一真源**）。优先级（**逐段独立**）：段级 runtime 键 > 段内 `enabled` > env 兜底 > 缺省关。
 *  「逐段独立」的理由：`{ handoff: { settle: true } }` 这类**只写一段**的配置若整体回落 env，会出现
 *  「写了 settle 却把 entry 交给环境变量」的静默半开面（实测踩点：ambient env 可让本意只开一段的配置
 *  连带开另一段）⇒ 未显式声明的段一律走 `enabled`/env/缺省，不连坐。 */
export function handoffGateStateOf(liveConfig, env = process.env) {
  const raw = String(env?.[HANDOFF_GATE_ENV] ?? '').toLowerCase();
  const envOn = raw === '1' || raw === 'true' || raw === 'on';
  const gates = (liveConfig && typeof liveConfig === 'object' && !Array.isArray(liveConfig))
    ? liveConfig.gates : null;
  const handoff = (gates && typeof gates === 'object' && !Array.isArray(gates))
    ? gates.handoff : null;
  if (handoff && typeof handoff === 'object' && !Array.isArray(handoff)) {
    const h = handoff;
    const enabled = asBool(h.enabled);
    const eRaw = asBool(h.entry);
    const sRaw = asBool(h.settle);
    const entry = eRaw ?? enabled ?? envOn;
    const settle = sRaw ?? enabled ?? envOn;
    // 只要该段有**本段/段级**显式布尔来源，就记 source='runtime'（env 仅作未声明段的缺省）
    const explicit = eRaw !== null || sRaw !== null || enabled !== null;
    if (explicit) return { entry, settle, source: 'runtime' };
  }
  if (envOn) return { entry: true, settle: true, source: 'env' };
  return { entry: false, settle: false, source: 'default' };
}
/** 单段判定（薄封装；三处消费点用这个）。 */
export function handoffGateEnabledOf(liveConfig, stage = 'entry', env = process.env) {
  return handoffGateStateOf(liveConfig, env)[stage];
}
