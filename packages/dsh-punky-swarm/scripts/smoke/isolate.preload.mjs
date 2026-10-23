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

// 宿主级生效冒烟 —— 隔离 preload（`node --import ./scripts/smoke/isolate.preload.mjs`）。
//
// 存在理由（与 `test/helpers/isolated-home.preload.mjs` **同契约的第二份实现**，非复制粘贴：
//   `package.json.files` 不含 `test/`，装了包的环境里 `scripts/smoke/` 仍在、`test/` 不在 ⇒
//   冒烟脚本**不得** import `test/**`，否则发布形态下运行时断链。差异由 audit 抽查）：
//   被测插件的装配路径存在**三处真实 home 派生写点**，且都由库内既有调用形态触发：
//     ① `lib/index.js:165` 以**无实参**调 `syncAssets()` ⇒ `lib/assets.js:211` 用裸 `os.homedir()`
//        ⇒ Windows 上取 `USERPROFILE`；写 `~/.agents/skills` 与 `~/.dsh/.agent-presets`；
//     ② 审计 sink 落 `<DSH_HOME>/logs/punky-swarm`（`DSH_HOME` 缺省 `homedir()/.dsh`）；
//     ③ 引擎状态根缺省 `~/.dsh/punky-preset`（本冒烟显式传 `root`，但 `homedir()` 仍在路径解析面）。
//   ⇒ **只隔离 DSH_HOME 不够**：`syncAssets()` 走裸 `os.homedir()`，会照样覆写真实
//   `~/.agents/skills` / `~/.dsh/.agent-presets`（本仓有 21 件夹具覆写真实 home 的前科）。
//   ⇒ **三变量必须齐**：`DSH_HOME` + `USERPROFILE` + `HOME`。
//
// 机制位置：`--import` 的求值顺序早于冒烟主模块与 `lib/**` 的 eval ⇒ 这里改写环境变量即发生在
//   `os.homedir()` 被取值的**时机之前**，不需要被测代码提供注入点，也不需要调用方「记得」隔离。
//
// 安全契约（宁失败不静默，绝不回落真实 home）：
//   ① 目标根不可解析 / 不可写 / 回读不一致 / 与真实 home 同一 ⇒ stderr 报错 + **退出码 2**
//      （`2` = 隔离前置失败，与 D-1.4 的 `2 = 用法错 / 隔离前置失败` 同档，**不新造语义**）；
//   ② 落点默认限制在系统临时目录之下；越界需显式 `PUNKY_SMOKE_ALLOW_ANY_ROOT=1`；
//   ③ 真实 home 真源取 `os.userInfo().homedir`（系统账户 API，不受 `USERPROFILE`/`HOME` 影响）
//      —— 这是「不许撞真实 home」自检的唯一可信来源；
//   ④ 由本进程创建的根在退出时清理（`PUNKY_SMOKE_KEEP_ISOLATED_HOME=1` 可保留取证）。
//
// 环境变量契约：
//   PUNKY_SMOKE_ISOLATED            标记（'1' = 已隔离；主脚本据此判断是否需自重启）
//   PUNKY_SMOKE_ISOLATED_HOME       隔离 home 根（由主脚本（父）创建并传入绝对路径）
//   PUNKY_SMOKE_ISOLATED_DSH_HOME   派生并导出 = <隔离根>/.dsh（与生产 <home>/.dsh 同形）
//   PUNKY_SMOKE_KEEP_ISOLATED_HOME  置 1/true 时保留隔离根
//   PUNKY_SMOKE_ALLOW_ANY_ROOT      置 1/true 时允许隔离根落在系统临时目录之外

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_MARK = 'PUNKY_SMOKE_ISOLATED';
const ENV_ROOT = 'PUNKY_SMOKE_ISOLATED_HOME';
const ENV_DSH_HOME = 'PUNKY_SMOKE_ISOLATED_DSH_HOME';
const ENV_KEEP = 'PUNKY_SMOKE_KEEP_ISOLATED_HOME';
const ENV_ANY_ROOT = 'PUNKY_SMOKE_ALLOW_ANY_ROOT';
const MARKER = '.punky-smoke-isolation-marker';

function fail(reason) {
  process.stderr.write('[host-smoke.preload] 隔离前置失败：' + reason + '\n');
  process.stderr.write('[host-smoke.preload] 进程终止（拒绝以未隔离状态继续，以免写入真实用户目录）\n');
  process.exit(2);
}

/** 真实 home 真源：系统账户 API，不受 USERPROFILE/HOME 改写影响。 */
let realHome = '';
try { realHome = os.userInfo().homedir; } catch { realHome = ''; }

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const declared = (process.env[ENV_ROOT] ?? '').trim();
if (!declared) fail('未提供 ' + ENV_ROOT + '（本 preload 只由 host-smoke.mjs 的自重启路径加载）');
const root = path.resolve(declared);
if (!path.isAbsolute(root)) fail('隔离根不是绝对路径：' + JSON.stringify(declared));
if (realHome && samePath(root, realHome)) fail('隔离根等于真实 home（' + root + '）——拒绝继续');
if (realHome && !path.relative(root, realHome).startsWith('..')) {
  fail('隔离根是真实 home 的祖先目录（' + root + ' ⊃ ' + realHome + '）——拒绝继续');
}
const allowAnyRoot = /^(1|true|on|yes)$/i.test((process.env[ENV_ANY_ROOT] ?? '').trim());
if (!allowAnyRoot) {
  const tmp = path.resolve(os.tmpdir());
  const rel = path.relative(tmp, root);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('隔离根不在系统临时目录之下（' + root + '，tmpdir=' + tmp + '）——如需放宽请显式置 ' + ENV_ANY_ROOT + '=1');
  }
}

try {
  fs.mkdirSync(root, { recursive: true });
  const probe = path.join(root, MARKER);
  const payload = 'host-smoke:' + process.pid + ':' + Date.now();
  fs.writeFileSync(probe, payload, 'utf8');
  if (fs.readFileSync(probe, 'utf8') !== payload) fail('隔离根写入回读不一致：' + probe);
  fs.unlinkSync(probe);
} catch (error) {
  fail('隔离根不可写：' + root + ' —— ' + String(error && error.message));
}

// 三处真实 home 派生面一并重定向（顺序无所谓：都在任何模块 eval 之前）。
process.env.USERPROFILE = root;
process.env.HOME = root;
process.env.DSH_HOME = path.join(root, '.dsh');
process.env[ENV_MARK] = '1';
process.env[ENV_ROOT] = root;
process.env[ENV_DSH_HOME] = process.env.DSH_HOME;

const keep = /^(1|true|on|yes)$/i.test((process.env[ENV_KEEP] ?? '').trim());
if (!keep) {
  process.on('exit', () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不改退出码：父进程会复核 */ }
  });
}
