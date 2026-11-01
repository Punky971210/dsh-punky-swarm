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

// ── DSH provider 包入口（批 `punky-adapter-split-20261031` · lane `w2-provider-skeleton`）──
//
// 定位：本目录 = **DSH 这一家宿主的适配实现包**。三层职责（用户裁决 R-2）里，宿主差异
//   只允许出现在这里；引擎只向适配层要具名功能，适配层（`lib/ports.ts` 契约 + 分发）不含宿主名。
//
// 本文件当前是**骨架**：
//   · 能加载、能导出（`name` + `apply`），**零运行期行为**——不注册工具、不写状态、不挂钩子、
//     不读 config、不 provide 任何服务。
//   · 具体的宿主实现（工具面 / HTTP 面 / 成员执行面 / 名册 / 能力回显）已在 lane
//     `w2-move-host-ports` 从原 `lib/host-ports/**` **搬迁**进来（搬迁，不是重写）：
//     `tools-http.js`（原 `host-ports/index.js` → 工具面 + HTTP 面）与 `agent.js`（原 `agent.js` → 成员执行面，含 `formOf` 单点）。
//     ⚠ 文件名**刻意不叫 `ports.js`**：`lib/ports.js` 是契约层（`ports.ts`）的受控 build 回拷产物，
//       而 `test/roster-self-held.test.js` 的门（AC-8）禁止任何运行时模块**加载** `ports.js`
//       ⇒ 同名会让 provider 实现被该门误判（实测红，见 `exec/move-host-ports.md` §踩坑）。
//
// ⚠ **`inject` 声明的唯一落点 = 装配面**（`cordis.patch.yml` 的
//   `- id: dsh-punky-swarm-provider-dsh` 行上 `inject: [tools, webServer, subagents]`）。
//   **本模块刻意不导出 `inject`**：同一声明若在「模块导出」与「装配行」两处各写一份，
//   就出现两个真源（一处改了另一处不说话）——这正是本批要消灭的形态。
//   既有同形先例：`lib/service-probe.js` 亦为「无 inject 导出 + 装配行承载」。
//
// ⚠ **与引擎行的 inject 关系（W4 负责清空，本 lane 不动）**：
//   引擎插件 `lib/index.js:120` 仍 `export const inject = HOST_INJECTIONS`
//   （`['tools','webServer','subagents']`）。
//   **进度（W2-S1 已完成）**：宿主触达实现已全部搬进本目录，`lib/host-ports/**` **已不存在**。
//   但按 `exec/provider-skeleton.md` §5.2 的硬顺序，清空引擎侧 inject（**S-3**）仍须等
//   **S-2（引擎侧清除残余宿主触达：`lib/index.js:337`、`lib/mcp/data-plane-server.js:279`、
//   `lib/tools/write-provenance-guard.js:98` 等重复判据）** 完成 —— 引擎代码此刻仍在直读这三个宿主服务；
//   提前清空会让引擎取值直接撞 cordis 的 `cannot get property "x" without inject`
//   （活体教训见 `lib/engine/dispatch.js` 的 `subagentRuntimeProbeOf` 头注释与
//   `test/dispatch-inject-guard.test.js:19`）。

/** 插件名（与装配行 `id` 同值，便于从 pending 审计反查归属；`id` 本身不参与解析）。 */
export const name = 'dsh-punky-swarm-provider-dsh';

/**
 * 加载入口。
 *
 * **刻意空实现**：骨架阶段不持有任何宿主服务、不注册任何能力。搬迁 lane 到位后，
 * 这里的职责是「把 `lib/ports.ts` 的五个槽位用 DSH 的实现装配起来」，
 * 而不是在这里写宿主逻辑（具体实现落在同目录按能力拆分的模块里）。
 */
export function apply() {}
