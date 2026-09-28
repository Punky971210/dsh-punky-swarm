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

// 批 onekey-install-20260927 · lane exec-smoke：`scripts/smoke-install.mjs` 的**结构契约**用例（I-7 静态面）。
//
// 为什么是静态面：I-7 的**动态**证明是一次完整宿主级冒烟（`pnpm pack` + 干净 profile 上装 npm 包 + 真实启动），
//   耗时数分钟且**依赖网络**（上游团队包）⇒ 不进常驻测试树（否则会污染全套的确定性与时长；
//   判据源 D-15 亦把「隔离测试体系」留待后续批次）。动态读数由 lane 产物 `exec/smoke.md` 承载并经 audit 独立复跑。
//   ⇒ 本文件只把 I-7 中**可静态机检**的四条钉死（b/c/D-6/e），使脚本的**结构不变量**在后续改动中不会静默回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = path.join(PKG, 'scripts', 'smoke-install.mjs');
const SELFCHECK = path.join(PKG, 'scripts', 'selfcheck-install.mjs');
const smokeSrc = () => fs.readFileSync(SMOKE, 'utf8');

test('I-7(a) 冒烟脚本存在且可被 node 解析（`--help` 语义不生副作用）', () => {
  assert.equal(fs.existsSync(SMOKE), true, 'scripts/smoke-install.mjs 必须存在');
  // 语法/可加载性：用 `node --check` 等价手段（不执行主体，避免真跑冒烟）
  const r = spawnSync(process.execPath, ['--check', SMOKE], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'smoke-install.mjs 须语法可解析：' + (r.stderr ?? '').slice(0, 400));
});

test('I-7(b) 双变量隔离：脚本对子进程同时设 DSH_HOME 与 USERPROFILE/HOME（grep 级断言）', () => {
  const src = smokeSrc();
  assert.ok(src.includes('DSH_HOME'), '须出现 DSH_HOME（宿主 home 变量，决定 profiles/node_modules 落点）');
  assert.ok(src.includes('USERPROFILE'), '须出现 USERPROFILE（Windows 上 os.homedir() 的首选来源）');
  assert.ok(/\bHOME\b/.test(src), '须出现 HOME（跨平台回退）');
  // 三变量必须指向**同一批临时目录**（结构性约束：同一 env 对象字面量内出现三者）
  const m = /const ISO_ENV = \{([^}]*)\}/.exec(src);
  assert.ok(m, '须存在集中构造的隔离 env 常量（ISO_ENV）');
  for (const k of ['DSH_HOME', 'USERPROFILE', 'HOME']) {
    assert.ok(m[1].includes(k), 'ISO_ENV 须同时设置 ' + k + '；实测=' + m[1].trim());
  }
  assert.ok(m[1].includes('tmpDshHome') && m[1].includes('tmpHome'),
    '三变量须指向临时根（tmpDshHome / tmpHome），不得回落真实目录；实测=' + m[1].trim());
});

test('I-7(c) 污染守卫在场：真实 home 真源 = os.userInfo().homedir + 前后 sha256 复算 + 不等即 FAIL', () => {
  const src = smokeSrc();
  assert.ok(src.includes('userInfo'), '须以 os.userInfo().homedir 取**真实** home 真源（不受 USERPROFILE/HOME 改写影响）');
  assert.ok(src.includes('createHash') && src.includes('sha256'), '须用 sha256 做守卫指纹');
  assert.ok(/before\.digest === after\.digest/.test(src), '须做**前后 digest 全等**判定');
  assert.ok(src.includes('I-7(c)'), '守卫判定须显式挂 I-7(c) 标签（可核）');
  // 失败即保留现场（不静默清理掉证据）
  assert.ok(/keepTmp/.test(src) && /guardOk/.test(src), '守卫失败须保留现场以便取证');
});

test('D-6 脚本禁 import 宿主内部包（app-boot）：只判 import/require 形态，不限制注释里的证据引用', () => {
  // 判据是「**不得** import 宿主内部包」（profile 层实装为旧版，语义可能不同）—— 与「注释里可否引其名字作证据」无关。
  //   ⇒ 只匹配 import / require / 动态 import 三种加载形态（注释中的纯叙述性提及不算违规，
  //     且根因取证正需要点名到该层，见脚本头注「面② 根因」段）。
  const IMPORT_RE = /(?:^|[^\w.])import\s[^;\n]*['"]@deepseek-ai\/dsh-app-boot['"]|require\(\s*['"]@deepseek-ai\/dsh-app-boot['"]\s*\)|import\(\s*['"]@deepseek-ai\/dsh-app-boot['"]\s*\)/;
  assert.equal(IMPORT_RE.test(smokeSrc()), false,
    '脚本不得 import/require 宿主内部包 @deepseek-ai/dsh-app-boot（D-6）');
  assert.equal(IMPORT_RE.test(fs.readFileSync(SELFCHECK, 'utf8')), false,
    'selfcheck 同样不得 import 宿主内部包（D-6）');
  // 反向自证（防「正则在任何输入下都 false」的空转）：同款正则须能命中一条构造样本
  assert.equal(IMPORT_RE.test("import { x } from '@deepseek-ai/dsh-app-boot';"), true,
    '正则须对构造样本命中（防空转校验，纪律 §15⑤）');
});

test('I-7(e) 端口隔离机制落地：`--port 0`（OS 分配）+ `--no-open`，且注释写明实测依据', () => {
  const src = smokeSrc();
  assert.ok(src.includes("'--port'") || src.includes('"--port"'), '启动参数须含 --port');
  assert.ok(src.includes("'0'"), '须显式传 0（OS 分配空闲端口，非猜测值）');
  assert.ok(src.includes("'--no-open'"), '须带 --no-open（不弹浏览器）');
  // 实测依据须可核（判据源 D-7 明令「禁猜」⇒ 注释必须指到实测坐标）
  assert.ok(src.includes('webStartup'), '注释须写明实测机制（webserver 行的 config.port 取自 webStartup 服务）');
  assert.ok(src.includes('startup.js'), '注释须给出旗标定义坐标（dsh-web-app/lib/startup.js）');
});

test('I-6 自检入口存在且与冒烟脚本同批在册（两入口互不替代）', () => {
  assert.equal(fs.existsSync(SELFCHECK), true, 'scripts/selfcheck-install.mjs 必须存在（I-6）');
  assert.equal(fs.existsSync(SMOKE), true, 'scripts/smoke-install.mjs 必须存在（I-7）');
});
