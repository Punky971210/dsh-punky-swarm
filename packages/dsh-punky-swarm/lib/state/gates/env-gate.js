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

// lib/state/gates/env-gate.js —— 门禁**环境阀**的唯一读点（RQ-8 / N-06 收敛点，纯叶模块）
//
// 取值优先级（与插件自有配置的关系 —— 两项**各自独立、互不连坐**）：
//   ① `runtime.json` 的 `gates.*`（热更快照；门禁侧经 `createGates` 的 `readCfg` 解析）
//      —— 只决定 handoff 门的 entry / settle 两段，**不读**本函数；
//   ② 本函数的环境阀 —— 只决定 targets / status / command 三门的「应急逃生」，
//      且在**任务声明与 runtime 配置之前**被读取（历史行为：本批只收敛读点，**语义零变化**）；
//   ③ 两者皆缺 ⇒ 缺省：handoff 两段关、三个门按引擎基线启用。
//
// 为什么必须收敛到这一处：`lib/hot/config-watch.js` 的设计注释明确「门禁只与插件有关，
//   **不得**依赖启动父进程的环境块（Desktop 派生 web 宿主的场景下 env 永远带不进来）」。
//   散在三处读时该约束无法被审计：无面板开关、无事件留痕、也无法 grep 清点「到底有几处在看环境」。
//   收敛前实测 5 处（command.js 2 / status.js 1 / targets.js 2，横跨 3 个文件）。
//
// 读时机：**每次判定时调用**（不缓存）—— 保持「改环境变量即时生效」的既有行为零变化。
// 返回面刻意只给三个布尔/值投影：调用方拿到的是**判定结果**，不是 env 对象本身
//   （防消费方各自再读一遍环境，退回散点）。

/** 门禁环境阀投影。@param {Record<string, unknown>} [env] 缺省 `process.env`（测试可注入） */
export function gateEnvOf(env = process.env) {
    const enabled = String(env?.GATE_ENABLED ?? '').toLowerCase();
    const targetsMode = String(env?.GATE_TARGETS_MODE ?? '').toLowerCase();
    const repoRootRaw = env?.GATE_REPO_ROOT;
    return {
        /** 应急逃生阀：值为 `false` ⇒ targets / status / command 三门零感知放行（判定不变）＋留痕 */
        allGatesDisabled: enabled === 'false',
        /** targets 门的 marker 模式（改前由 targets.js 各自读）；`no-change` 仍优先于本项 */
        targetsMarkerMode: targetsMode === 'marker',
        /** 命令门 cwd 的兜底仓库根（lane worktree 不存在时才用）；空串/非串 ⇒ null */
        repoRoot: typeof repoRootRaw === 'string' && repoRootRaw.length > 0 ? repoRootRaw : null,
    };
}
