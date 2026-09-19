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

// TD-02（2026-09-18 清债轮）：包内容哈希清单 `pkg-hashes.txt` 的**生成器 + 漂移检查**。
//
// 为什么需要它：该清单此前**无生成器**（一次性命令/手工产出）⇒ 每次重算都是**不可复现**的批外写面，
//   漂移只能人肉比对（技术债 TD-02 / F-3「`pkg-hashes.txt` 落后且非批前快照」的根因）。
//   本脚本把「范围 + 排序 + 形态」三件事单点固化，使重算**可复跑**、漂移**可机检**：
//   · 范围 = `SCAN_DIRS` 七个目录（递归）+ 包根文件；**排除** 清单自身、`node_modules/`、其它点目录
//     （`.git/`、`.wip-backup/` 等）——点目录一律不入清单（施工备份/版本元数据不属交付面）
//   · 排序 = 相对路径默认字节序（两次生成在同一源码下逐字节一致）
//   · 形态 = `<相对路径>\t<sha256 小写>\n`，UTF-8 无 BOM、LF 行尾（与既有清单逐字同形）
//
// 用法（**参数面 fail-closed**：未知参数/非法组合 ⇒ 用法打 stderr、exit 2，**绝不进入写盘分支**）：
//   node scripts/pkg-hashes.mjs            # 生成/覆盖 pkg-hashes.txt
//   node scripts/pkg-hashes.mjs --check    # 只读对照：与盘上清单逐条比对 ⇒ 有漂移 exit 1（不写盘）
//   node scripts/pkg-hashes.mjs --help     # 打印用法（零副作用：不扫描、不写盘）
//
// 纪律：跑生成后须复跑 `--check` 得 0 漂移；重算事由归台账（`docs/engine-status-and-debt-*.md`）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MANIFEST_REL = 'pkg-hashes.txt';
/** 清单覆盖的目录（递归）；此外只收**包根文件**。 */
const SCAN_DIRS = ['baselines', 'docs', 'lib', 'presets', 'scripts', 'skills', 'test'];

const USAGE = [
  '用法：node scripts/pkg-hashes.mjs [--check | --help]',
  '  缺省        生成/覆盖 ' + MANIFEST_REL + '（范围：' + SCAN_DIRS.join('/ ') + ' + 包根文件）',
  '  --check     只读对照：与盘上清单比对，有漂移 exit 1（不写盘）',
  '  --help, -h  打印本用法（零副作用）',
  '',
].join('\n');

function parseArgs(argv) {
  const args = { check: false, help: false, error: null };
  for (const a of argv) {
    if (a === '--check') args.check = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else { args.error = '未知参数：' + a; return args; }
  }
  if (args.check && args.help) { args.error = '--check 与 --help 不得并用'; return args; }
  return args;
}

/** 相对路径（**统一正斜杠**，跨平台同形）。 */
const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function walkDir(absDir, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // 点目录/点文件不入清单（.git / .wip-backup / 编辑器残留）
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
  const abs = path.join(ROOT, MANIFEST_REL);

  if (!args.check) {
    fs.writeFileSync(abs, render(now), 'utf8');
    process.stdout.write('[pkg-hashes] 已写入 ' + MANIFEST_REL + '：' + now.size + ' 件\n');
    process.exit(0);
  }

  if (!fs.existsSync(abs)) {
    process.stderr.write('[pkg-hashes] --check 需要既有清单：' + MANIFEST_REL + ' 不存在\n');
    process.exit(1);
  }
  const was = parseManifest(fs.readFileSync(abs, 'utf8'));
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
  process.stdout.write('[pkg-hashes] check: 清单 ' + was.size + ' → 实测 ' + now.size
    + '；changed ' + changed.length + ' / added ' + added.length + ' / removed ' + removed.length + '\n');
  process.stdout.write('[pkg-hashes] ' + (drift === 0
    ? 'GREEN 清单与包内容逐件一致'
    : 'RED ' + drift + ' 项漂移（跑 `node scripts/pkg-hashes.mjs` 重算）') + '\n');
  process.exit(drift === 0 ? 0 : 1);
}

main();
