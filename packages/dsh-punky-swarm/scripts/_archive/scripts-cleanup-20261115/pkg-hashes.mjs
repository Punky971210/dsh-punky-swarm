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

// 【2026-09-30 · 批 `debt-cleanup-20260930` / lane `exec-td02`】**TD-02 关闭** —— 本文件**已改性质**：
//   **按需生成器（on-demand generator）；不是门禁（NOT a gate）；清单不随仓维护（no in-repo manifest）。**
//
// 背景（为何废除「随仓清单」）：
//   原 `pkg-hashes.txt` 覆盖**整个包目录**（`SCAN_DIRS` 七目录 + 包根文件）⇒ 任何一处正常改动都使其漂移；
//   而其**消费面为零**（无测试、无门禁、无脚本链读取它，漂移只能**人肉比对**）⇒ 每批都要重算，
//   **成本 > 收益**。本轮实测 `--check`：清单 440 → 实测 430（changed 107 / added 11 / removed 21）
//   ⇒ `removed` 全为历史批次已删文件，即「账目滞后」的典型形态。
//   ⇒ 裁决 = **乙：显式废除清单**。**不采甲（重生）**：重生若要成立，必须同时给该清单**接线消费面**
//     （= 给仓库再加一条常态门禁），与「清债」意图相反，且与既有常态化校验（测试套件 / 基线 / 退役码锁 /
//     归一化守卫）**功能重叠**。
//
// 本脚本现在的契约（**参数面 fail-closed**：未知参数 / 非法组合 ⇒ 用法打 stderr、exit 2，绝不进入写盘分支）：
//   node scripts/pkg-hashes.mjs                  # 生成当前包内容清单 ⇒ **写 stdout**（不落盘、不入仓）
//   node scripts/pkg-hashes.mjs --out <path>     # 生成并写入指定路径（**按需**；仓库内不维护该文件）
//   node scripts/pkg-hashes.mjs --check [--out <path>]   # **诊断子命令（非门禁）**：与清单做只读对照
//   node scripts/pkg-hashes.mjs --help           # 打印用法（零副作用：不扫描、不落盘）
//
//   ⚠ **退出码语义（显式改写，2026-09-30）**：`--check` **无论是否漂移、无论清单是否存在，一律 `exit 0`**
//     —— 它**只是诊断**，不是门禁；漂移只作为**读数**打印。**禁止**把本脚本的退出码接入任何测试/门禁
//     （那会复活 TD-02）。其余退出码：`0` = 正常完成；`2` = 参数错误（fail-closed）。
//
// 取代面（原用途「资产随包可审计」的去处）：需要审计**某次发布**的包内容时 ——
//   用 `--out <仓外路径>` 生成清单，与该次发布的记录**人工/外部比对**（清单**不入仓**、不随批维护）。
//   仓库的常态化校验由下列承担：`test/**`（全量套件）、`baselines/**`（Leader 单写者）、
//   退役码登记锁与归一化守卫（`test/retired-codes-lock.test.js` / `test/hygiene-comment-literals.test.js`）。
//
// 范围 / 排序 / 形态（与废除前逐字一致，仅**落点语义**改变）：
//   · 范围 = `SCAN_DIRS` 七目录（递归）+ 包根文件；**排除** 清单自身、`node_modules/`、其它点目录；
//   · 排序 = 相对路径默认字节序（同一源码下两次生成逐字节一致）；
//   · 形态 = `<相对路径>\t<sha256 小写>\n`，UTF-8 无 BOM、LF 行尾。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
/** 诊断模式缺省清单路径（**仓库内不再维护该文件**；仅当你用 `--out` 生成了它才有意义）。 */
const MANIFEST_REL = 'pkg-hashes.txt';
/** 清单覆盖的目录（递归）；此外只收**包根文件**。 */
const SCAN_DIRS = ['baselines', 'docs', 'lib', 'presets', 'scripts', 'skills', 'test'];

const USAGE = [
  '用法：node scripts/pkg-hashes.mjs [--out <path>] [--check | --help]',
  '  缺省                  生成当前包内容清单 ⇒ 写 **stdout**（不落盘、不入仓）',
  '  --out <path>          生成并写入指定路径（按需；仓库内不维护清单文件）',
  '  --check               诊断对照（**非门禁**）：与清单只读比对，**一律 exit 0**；漂移只作读数打印',
  '  --help, -h            打印本用法（零副作用）',
  '',
  '  ⚠ 本脚本为**按需生成器**，其退出码**不得**接入任何测试/门禁（TD-02 已关闭）。',
  '     范围：' + SCAN_DIRS.join('/ ') + ' + 包根文件（排除清单自身与点目录/node_modules）。',
  '',
].join('\n');

function parseArgs(argv) {
  const args = { check: false, help: false, out: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.trim() === '') { args.error = '--out 需要一个非空路径'; return args; }
      args.out = v; i += 1;
    } else { args.error = '未知参数：' + a; return args; }
  }
  if (args.check && args.help) { args.error = '--check 与 --help 不得并用'; return args; }
  return args;
}

/** 相对路径（**统一正斜杠**，跨平台同形）。 */
const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function walkDir(absDir, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // 点目录/点文件不入清单（.git / 施工备份 / 编辑器残留）
    if (entry.name === 'node_modules') continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) walkDir(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
}

/** 当前包内容 → `Map<相对路径, sha256 小写>`（清单自身不入表）。 */
function entriesOf() {
  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walkDir(abs, files);
  }
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== MANIFEST_REL) files.push(path.join(ROOT, entry.name));
  }
  const map = new Map();
  for (const abs of files) {
    const rel = relOf(abs);
    map.set(rel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
  }
  return map;
}

function render(map) {
  const keys = [...map.keys()].sort();
  return keys.map((k) => k + '\t' + map.get(k)).join('\n') + '\n';
}

function parseManifest(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const i = line.indexOf('\t');
    if (i <= 0) continue;
    map.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  return map;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write('[pkg-hashes] 参数错误：' + args.error + '\n');
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (args.help) { process.stdout.write(USAGE); process.exit(0); }

  const now = entriesOf();

  // 生成模式（按需）：`--out` 落指定路径；否则写 stdout（**不落仓**）
  if (!args.check) {
    const body = render(now);
    if (args.out) {
      fs.writeFileSync(path.resolve(args.out), body, 'utf8');
      process.stdout.write('[pkg-hashes] 已写入 ' + args.out + '：' + now.size + ' 件（按需生成，清单不随仓维护）\n');
    } else {
      process.stdout.write(body);
      process.stderr.write('[pkg-hashes] 已生成 ' + now.size + ' 件到 stdout（按需生成；如需落盘用 --out <path>）\n');
    }
    process.exit(0);
  }

  // 诊断模式（**非门禁**）：恒 exit 0；漂移只作读数
  const target = path.resolve(args.out ?? path.join(ROOT, MANIFEST_REL));
  process.stdout.write('[pkg-hashes] 诊断对照（**非门禁**；TD-02 已关闭：清单不随仓维护）\n');
  if (!fs.existsSync(target)) {
    process.stdout.write('[pkg-hashes] 无清单可对照：' + target + ' 不存在\n');
    process.stdout.write('[pkg-hashes] ⇒ 这是**预期**状态（清单已废除）；如需审计某次发布，用 '
      + '--out <仓外路径> 生成后人工比对。\n');
    process.exit(0);
  }
  const was = parseManifest(fs.readFileSync(target, 'utf8'));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [k, v] of now) {
    if (!was.has(k)) added.push(k);
    else if (was.get(k).toLowerCase() !== v) changed.push(k);
  }
  for (const k of was.keys()) if (!now.has(k)) removed.push(k);
  const drift = changed.length + added.length + removed.length;
  for (const k of changed.slice(0, 20)) process.stdout.write('[pkg-hashes]   CHANGED ' + k + '\n');
  for (const k of added.slice(0, 20)) process.stdout.write('[pkg-hashes]   ADDED   ' + k + '\n');
  for (const k of removed.slice(0, 20)) process.stdout.write('[pkg-hashes]   REMOVED ' + k + '\n');
  process.stdout.write('[pkg-hashes] 对照：清单 ' + was.size + ' → 实测 ' + now.size
    + '；changed ' + changed.length + ' / added ' + added.length + ' / removed ' + removed.length + '\n');
  process.stdout.write('[pkg-hashes] 漂移 ' + drift + ' 项（**仅读数，非失败**：本命令恒 exit 0；清单不随仓维护）\n');
  process.exit(0);
}

main();
