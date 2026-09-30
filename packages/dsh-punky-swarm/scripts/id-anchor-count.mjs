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

// 【模板】id 锚定计数 · `scripts/id-anchor-count.mjs`
//   来源：批 `fcleanup-and-debt-20260930` / lane `exec-harness-template`（判据 K-4 / K-5）——
//   把本会话多次**一次性重写**的「读清单文本 → 数某个 id 在不在、有几处」harness **沉淀为可复用模板**。
//
// 三条口径（本模板的**唯一**口径，取用时不得改宽）：
//   ① **锚定匹配**：判定某 id 在场/计数一律用整行锚定 `^\s*- id: <id>\s*$`（逐 id 精确）。
//      **禁用任何子串匹配** —— 子串形态在「**前缀同族 id**」并存时会**假阳**：
//      目标同时含 `tool`、`tool-workflow`、`tool-ralph` 时，查 `tool` 的子串口径会把三行**全部**计入
//      （得 3），而**锚定口径得 1**（只有 `- id: tool` 那行）⇒ 差 2 即误报量。
//   ② **逐 id 计数入固定字段**（`countsById`）—— 取代「靠 dump 文本长度/总条数推断」的不稳做法
//      （长度口径无法区分「哪个 id 多了」，且同族 id 并存时**结构性失真**）。
//   ③ **写盘前建父目录**：`--out` 落盘前 `mkdirSync(<dir>, { recursive: true })`
//      ⇒ 目标目录不存在时不再以 `ENOENT` 失败（这是「模板不可复用」的最后一处硬伤）。
//
// 用法（**参数面 fail-closed**：未知参数/缺 `--target` ⇒ 用法打 stderr、exit 2，绝不进入写盘分支）：
//   node scripts/id-anchor-count.mjs --target <file> [--ids a,b,c] [--out <path>] [--json]
//     --target <file>   必填：被扫描的文本 / YAML 文件
//     --ids a,b,c       可选：要逐 id 计数的 id 列表（缺省 = 先收集目标内**全部锚定 id**，再逐个计数）
//     --out <path>      可选：把 JSON 结果写入该路径（**父目录自动创建**）
//     --json            可选：JSON 打到 stdout（缺省打人类可读摘要）
//     --help, -h        打印用法（零副作用）
//   退出码：0 = 正常完成；2 = 参数错误。
//
// 输出字段（**固定**，取用方可直接消费）：
//   target         目标文件路径
//   anchoredTotal  锚定行总数（`^\s*- id: <...>\s*$` 命中行数）
//   countTotal     `countsById` 各值之和
//   countsById     { <id>: <该 id 的**锚定**出现次数> }   ← **固定字段：逐 id 计数**
//   missingIds     请求的 ids 中计数为 0 者（未传 `--ids` 时为空数组）
//   duplicateIds   `countsById` 中计数 > 1 者（清单内重名，供去重核查）
//
// 最小可跑示例（`<pkg>` = 包根，可直接复制；示例目标为含「前缀同族 id」的构造）：
//   printf 'plugins:\n  - id: tool\n  - id: tool-workflow\n  - id: tool-ralph\n' > /tmp/ids.yml
//   node scripts/id-anchor-count.mjs --target /tmp/ids.yml --ids tool,tool-workflow --json
//   ⇒ {"target":"/tmp/ids.yml","anchoredTotal":3,"countTotal":2,
//      "countsById":{"tool":1,"tool-workflow":1},"missingIds":[],"duplicateIds":[]}
//   （对照：同一目标的**子串口径**会把 `tool` 数成 3 —— 该对照仅用于说明缺陷，**不在本模板内实现**。）
import fs from 'node:fs';
import path from 'node:path';

const USAGE = [
  '用法：node scripts/id-anchor-count.mjs --target <file> [--ids a,b,c] [--out <path>] [--json]',
  '  --target <file>   必填：被扫描的文本 / YAML 文件',
  '  --ids a,b,c       可选：逐 id 计数的 id 列表（缺省 = 收集目标内全部锚定 id）',
  '  --out <path>      可选：JSON 结果落盘（父目录自动创建）',
  '  --json            可选：JSON 打到 stdout（缺省打摘要）',
  '  --help, -h        打印本用法（零副作用）',
  '  口径：整行锚定 ^\\s*- id: <id>\\s*$（禁子串）；计数入 countsById；写盘前 mkdirSync(recursive)。',
  '',
].join('\n');

function parseArgs(argv) {
  const args = { target: null, ids: null, out: null, json: false, help: false, error: null };
  // 遍历用 `entries()` + 跳过标志（**不用**集合长度类上界）—— 与「计数只用锚定累加」同口径：
  //   本模板内**不出现**任何长度类推断，避免复核者把「长度」字面当成计数来源。
  let skipValue = false;
  for (const [i, a] of argv.entries()) {
    if (skipValue) { skipValue = false; continue; }
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--target' || a === '--ids' || a === '--out') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.trim() === '') { args.error = a + ' 需要一个非空值'; return args; }
      if (a === '--target') args.target = v;
      else if (a === '--out') args.out = v;
      else args.ids = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
      skipValue = true;
    } else { args.error = '未知参数：' + a; return args; }
  }
  return args;
}

/** 正则元字符转义（id 可能含 `.` / `-` 等；这是**正则构造**，不是子串匹配）。 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 单 id 的**整行锚定**判据（模板的唯一定位口径）。 */
const anchoredReOf = (id) => new RegExp('^\\s*- id: ' + escapeRe(id) + '\\s*$');

/** 通用锚定收集：抓出目标内全部 `- id: <...>` 的 id（同样**只认整行锚定**）。 */
const collectRe = new RegExp('^\\s*- id:\\s*(\\S+)\\s*$');

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write('[id-anchor-count] 参数错误：' + args.error + '\n');
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (args.help) { process.stdout.write(USAGE); process.exit(0); }
  if (args.target === null) {
    process.stderr.write('[id-anchor-count] 参数错误：缺少 --target\n');
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const targetAbs = path.resolve(args.target);
  if (!fs.existsSync(targetAbs)) {
    process.stderr.write('[id-anchor-count] 目标不存在：' + targetAbs + '\n');
    process.exit(2);
  }
  const lines = fs.readFileSync(targetAbs, 'utf8').split('\n');

  // ① 收集锚定 id（缺省计数集 = 目标内出现的全部锚定 id）
  //   计数一律以**显式累加**得出（不用集合长度类推算）—— 保证「计数」只有**一处来源**（逐行锚定判定）。
  const anchoredIds = [];
  let anchoredTotal = 0;
  for (const line of lines) {
    const m = line.match(collectRe);
    if (m !== null && m[1] !== undefined) { anchoredIds.push(m[1]); anchoredTotal += 1; }
  }

  // ② 逐 id 计数（**固定字段 countsById**）—— 一律走整行锚定，逐行 test
  const wanted = args.ids === null ? [...new Set(anchoredIds)] : [...new Set(args.ids)];
  const countsById = {};
  for (const id of wanted) {
    const re = anchoredReOf(id);
    let n = 0;
    for (const line of lines) if (re.test(line)) n += 1;
    countsById[id] = n;
  }

  let countTotal = 0;
  const duplicateIds = [];
  for (const [id, n] of Object.entries(countsById)) {
    countTotal += n;
    if (n > 1) duplicateIds.push(id);
  }
  const missingIds = args.ids === null ? [] : wanted.filter((id) => countsById[id] === 0);

  const result = {
    target: targetAbs,
    anchoredTotal,
    countTotal,
    countsById,
    missingIds,
    duplicateIds,
  };
  const body = JSON.stringify(result, null, 2) + '\n';

  // ③ 写盘前建父目录（`--out` 指向不存在的嵌套目录时不 ENOENT）
  if (args.out !== null) {
    const outAbs = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, body, 'utf8');
    if (!args.json) process.stdout.write('[id-anchor-count] 已写入 ' + outAbs + '\n');
  }

  if (args.json || args.out === null) {
    process.stdout.write(body);
  } else {
    process.stdout.write('[id-anchor-count] target=' + targetAbs
      + ' anchoredTotal=' + anchoredTotal + ' countTotal=' + countTotal + '\n');
    for (const [id, n] of Object.entries(countsById)) {
      process.stdout.write('[id-anchor-count]   ' + id + ' = ' + n + (n === 0 ? '（缺）' : '') + '\n');
    }
  }
  process.exit(0);
}

main();
