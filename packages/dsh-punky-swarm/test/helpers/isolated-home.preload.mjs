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

// 测试隔离 preload（`node --import ./test/helpers/isolated-home.preload.mjs --test`）。
//
// 存在理由：被测代码存在**真实的用户主目录派生写点**，且它们在测试里不可回避——
//   `lib/index.js` 的 `apply()` 以裸调 `syncAssets()`（无 home 实参）触发资产同步，落 `~/.agents/skills`
//   与 `~/.dsh/.agent-presets`；同处 `~/.dsh/jiufeng` 由 `homedir()` 拼出引擎根；审计 sink 落
//   `<DSH_HOME>/logs/punky-swarm`（DSH_HOME 缺省兜底 `homedir()/.dsh`）。任何直接 import `apply()` 的
//   测试文件（本包现有 9 个）在进程内首调即触达这些写点。
//
// 机制位置：`--import` 的求值顺序早于测试文件与被测模块的 eval，故这里改写环境变量即可让
//   `os.homedir()` 与 `DSH_HOME` 在**取值时机之前**就已重定向——不需要被测代码提供注入点，
//   也不需要每个测试文件「记得」做什么（这正是它与「各文件自觉隔离」纪律写法的分别）。
//
// 安全契约（本模块的硬要求，宁失败不静默）：
//   ① 目标根不可解析 / 不可写 / 与真实 home 同一 → 打错误到 stderr 并 **非零退出**，绝不回落真实 home；
//   ② 落点只在系统临时目录（或调用方显式给的 PUNKY_TEST_ISOLATED_HOME）之下；
//   ③ 由本进程创建的目标根在进程退出时清理（PUNKY_TEST_KEEP_ISOLATED_HOME=1 可保留以供取证）。
//
// 环境变量契约：
//   PUNKY_TEST_ISOLATED_HOME      隔离 home 根（已有则复用，父进程传入时子进程共享同一根）
//   PUNKY_TEST_ISOLATED_DSH_HOME  由本模块派生并导出 = <隔离根>/.dsh（与生产 <home>/.dsh 同形）
//   PUNKY_TEST_KEEP_ISOLATED_HOME 置 1/true 时保留隔离根（默认退出即清理）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_HOME = 'PUNKY_TEST_ISOLATED_HOME';
const ENV_DSH_HOME = 'PUNKY_TEST_ISOLATED_DSH_HOME';
const ENV_KEEP = 'PUNKY_TEST_KEEP_ISOLATED_HOME';
const MARKER = '.punky-isolation-marker';

function fail(reason) {
  process.stderr.write('[isolated-home.preload] 隔离前置失败：' + reason + '\n');
  process.stderr.write('[isolated-home.preload] 测试进程终止（拒绝以未隔离状态继续，以免写入真实用户目录）\n');
  process.exit(1);
}

// 真实 home 真源：os.userInfo() 走系统账户 API，不受 USERPROFILE / HOME 影响，
// 因此可在 env 已被别的 preload 改写后仍取到真实值（本模块用它做「不许撞真实 home」的自检）。
let realHome = '';
try { realHome = os.userInfo().homedir; } catch { realHome = ''; }

const declared = (process.env[ENV_HOME] ?? '').trim();
const createdHere = declared === '';
const root = createdHere
  ? path.join(os.tmpdir(), 'punky-isolated-home-' + process.pid)
  : path.resolve(declared);

if (!root || !path.isAbsolute(root)) fail('隔离根不可解析：' + JSON.stringify(declared));
if (realHome && path.resolve(root).toLowerCase() === path.resolve(realHome).toLowerCase()) {
  fail('隔离根等于真实 home（' + root + '）——拒绝继续');
}

try {
  fs.mkdirSync(root, { recursive: true });
  const probe = path.join(root, MARKER);
  const payload = 'isolated-home:' + process.pid + ':' + Date.now();
  fs.writeFileSync(probe, payload, 'utf8');
  if (fs.readFileSync(probe, 'utf8') !== payload) fail('隔离根写入回读不一致：' + probe);
} catch (error) {
  fail('隔离根不可写：' + root + ' —— ' + String(error && error.message));
}

// 三处真实 home 派生面一并重定向（USERPROFILE 是 Windows 上 uv_os_homedir 的首选来源，
// HOME 供跨平台/子进程，DSH_HOME 供审计 sink 与内核 resolveDshHome 同形解析）。
process.env.USERPROFILE = root;
process.env.HOME = root;
process.env.DSH_HOME = path.join(root, '.dsh');
process.env[ENV_HOME] = root;
process.env[ENV_DSH_HOME] = process.env.DSH_HOME;

const keep = /^(1|true|on|yes)$/i.test((process.env[ENV_KEEP] ?? '').trim());
if (createdHere && !keep) {
  process.on('exit', () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响退出码 */ }
  });
}
