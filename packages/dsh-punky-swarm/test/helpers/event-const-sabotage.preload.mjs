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

// R3-4：把 `event-const-loader.mjs` 注册为 module hook（`node --import ./test/helpers/event-const-sabotage.preload.mjs …`）。
//   点名常量经 **`register(..., { data })`** 传递（而非 env）：hooks 运行在专用线程，
//   `data` 是官方跨线程通道，避免依赖「env 在 hooks 线程可见」这一未承诺行为。
//   未设 `PSWARM_SABOTAGE_CONSTS` ⇒ `names: []` ⇒ loader 逐字透传（等价于不加载本 hook）。
//   `PSWARM_WEAKEN_GUARD=1` ⇒ **负向对照档**：把守卫判据置 `false`（只为证明套件有判别力）。
import { register } from 'node:module';

const names = (process.env.PSWARM_SABOTAGE_CONSTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const weakenGuard = process.env.PSWARM_WEAKEN_GUARD === '1';

// 【防线】本文件同样会被 `node --test` 收集执行（见 `test/helpers/*.mjs` 惯例）。若在**主测试进程**里
//   注册 hook，会给整个进程挂上 loader 线程（性能 + 无谓风险）。故只在被显式用作 `--import` 时注册。
if (process.env.PSWARM_EVENT_CONST_HOOK === '1') {
  register('./event-const-loader.mjs', import.meta.url, { data: { names, weakenGuard } });
}
