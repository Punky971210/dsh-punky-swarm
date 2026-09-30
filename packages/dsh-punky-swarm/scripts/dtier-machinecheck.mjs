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

// D 档前置机检（四层）· `scripts/dtier-machinecheck.mjs`
//   来源：批 `guidance-dtier-20261001` / lane `exec-dtier-machinecheck`（判据源 plan/dtier-spec.md §需求 §二）。
//
// 解决的问题（对「team 成为主流」的硬前置）：**安装层非确定性** ⇒ 承载团队工具面的
//   `@deepseek-ai/dsh-experimental-*` 子包**落错线/缺失** ⇒ 组合树里的那一行**静默停用**
//   ⇒ 团队面**无声消失**，而主 Agent 只会「没有队友工具可用」。四层机检把这种静默**转成可机检信号**。
//
// 四层（逐层给**固定字段**）：
//   ① 静态在场：`<profile>/package.json` 的 `@deepseek-ai/dsh-experimental-*` **声明集**
//      与 `<profile>/node_modules/@deepseek-ai/` 的**实装目录集**比对 ⇒ **差集非空即告警**。
//   ② 加载期响亮：启动日志 grep `pending (waiting for service: agentTeams)` 与
//      `patch: entry "<…agent-team…>" not found` ⇒ **任一命中即团队面缺失**。
//   ③ 会话期功能面：组合树 dump 中**逐包锚定**核对团队四包行是否在场（整行锚定，**禁子串**），
//      并列出该面应提供的工具名；工具名的**会话级**在场与否**不能静态判定** ⇒ 固定标注 `sessionProbe`。
//   ④ 引擎读端：日志中 `managerRoster` 的 `service-unavailable` 口径命中数。
//
// 口径（沿用本仓模板 `scripts/id-anchor-count.mjs` 的三条，取用不得改宽）：
//   ① **锚定匹配**：组合树行判定一律整行锚定（`^\s*- name: '<pkg>'\s*$`），**禁用子串匹配**；
//   ② **逐项计数入固定字段**（`rowCountsByPkg`）—— 不以文本长度/总条数推断；
//   ③ **写盘前建父目录**：`--out` 落盘前 `mkdirSync(<dir>, { recursive: true })`。
//
// 用法（**参数面 fail-closed**：未知参数/缺值 ⇒ 用法打 stderr、exit 2；**任何内部异常 ⇒ exit 2**）：
//   node scripts/dtier-machinecheck.mjs [--profile <dir>] [--log <file>] [--dump <file>]
//                                      [--out <path>] [--json] [--help]
//     --profile <dir>   profile 目录（缺省 = <USERPROFILE>/.dsh/profiles/web）
//     --log <file>      启动日志文本（缺省 = 跳过②④层，层内标注 skipped）
//     --dump <file>     组合树 dump 文本（缺省 = 跳过③层，层内标注 skipped）
//     --out <path>      结果 JSON 落盘（父目录自动创建）
//     --json            JSON 打到 stdout（缺省打人类可读摘要）
//
// 退出码（**fail-closed**）：0 = 四层全过；1 = 任一层命中异常（团队面缺失/漂移）；2 = 参数错误或内部异常。
//
// 输出字段（**固定**，取用方可直接消费）：
//   layer1 { profile, declared, installed, declaredNotInstalled, installedNotDeclared, verdict }
//   layer2 { log, pendingWaitingService, patchEntryNotFound, sampleLines, verdict }
//   layer3 { dump, rowCountsByPkg, rowsMissing, toolsExpected, sessionProbe, verdict }
//   layer4 { serviceUnavailable, verdict }
//   expected { packages, tools }
//   verdict  'pass' | 'fail'
//   exitCode 0 | 1
//
// 最小可跑示例（构造 + 正常两个读数并列，证明非空转）：
//   node scripts/dtier-machinecheck.mjs --profile <临时假 profile> --log <含命中串的日志> --dump <缺行的 dump>
//     ⇒ verdict=fail / exitCode=1（层①②③ 均有命中）
//   node scripts/dtier-machinecheck.mjs --profile <真实 profile> --log <干净日志> --dump <含四包行的 dump>
//     ⇒ verdict=pass / exitCode=0
import fs from 'node:fs';
import path from 'node:path';

/** 团队面四包（承载 `spawn_teammate` / `team_task_*` 等工具面的子包集合）。 */
const EXPECTED_PACKAGES = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-tool-agent-team',
  '@deepseek-ai/dsh-experimental-client-ui-agent-team',
];

/** 团队面应提供的工具名（会话级；本脚本只做**静态应然清单**，不声称已核）。 */
const EXPECTED_TOOLS = ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_list'];

const USAGE = [
  '用法：node scripts/dtier-machinecheck.mjs [--profile <dir>] [--log <file>] [--dump <file>] [--out <path>] [--json] [--help]',
  '  --profile <dir>   profile 目录（缺省 = <USERPROFILE>/.dsh/profiles/web）',
  '  --log <file>      启动日志文本（缺省 ⇒ 跳过第②④层）',
  '  --dump <file>     组合树 dump 文本（缺省 ⇒ 跳过第③层）',
  '  --out <path>      结果 JSON 落盘（父目录自动创建）',
  '  --json            JSON 打到 stdout（缺省打摘要）',
  '  口径：组合树行判定整行锚定（禁子串）；逐项计数入 rowCountsByPkg；写盘前 mkdirSync(recursive)。',
  '  退出码：0 = 全过；1 = 任一层命中异常；2 = 参数错误或内部异常（fail-closed）。',
  '',
].join('\n');

function parseArgs(argv) {
  const args = { profile: null, log: null, dump: null, out: null, json: false, help: false, error: null };
  let skipValue = false;
  for (const [i, a] of argv.entries()) {
    if (skipValue) { skipValue = false; continue; }
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--profile' || a === '--log' || a === '--dump' || a === '--out') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.trim() === '') { args.error = a + ' 需要一个非空值'; return args; }
      if (a === '--profile') args.profile = v;
      else if (a === '--log') args.log = v;
      else if (a === '--dump') args.dump = v;
      else args.out = v;
      skipValue = true;
    } else { args.error = '未知参数：' + a; return args; }
  }
  return args;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 组合树内的包行锚定判据：`^\s*- name: '<pkg>'\s*$`（模板口径①：禁子串）。 */
const rowAnchorReOf = (pkg) => new RegExp("^\\s*- name: '" + escapeRe(pkg) + "'\\s*$");

function defaultProfileDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.dsh', 'profiles', 'web');
}

/** ① 声明集 ↔ 实装集比对（差集非空即告警）。 */
function layer1(profileDir) {
  const pkgJsonPath = path.join(profileDir, 'package.json');
  const nmDir = path.join(profileDir, 'node_modules');
  const declared = [];
  if (fs.existsSync(pkgJsonPath)) {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')); } catch { parsed = null; }
    if (parsed !== null && typeof parsed === 'object') {
      for (const field of ['dependencies', 'devDependencies']) {
        const bag = parsed[field];
        if (bag !== null && typeof bag === 'object') {
          for (const name of Object.keys(bag)) if (name.startsWith('@deepseek-ai/')) declared.push(name);
        }
      }
    }
  }
  const installed = [];
  if (fs.existsSync(nmDir)) {
    for (const dir of fs.readdirSync(nmDir)) {
      if (dir.startsWith('@')) {
        const scoped = path.join(nmDir, dir);
        if (fs.existsSync(scoped) && fs.statSync(scoped).isDirectory()) {
          for (const sub of fs.readdirSync(scoped)) {
            if (fs.existsSync(path.join(scoped, sub)) && fs.statSync(path.join(scoped, sub)).isDirectory()) {
              installed.push(dir + '/' + sub);
            }
          }
        }
      }
    }
  }
  const declaredSet = [...new Set(declared)].sort();
  const installedSet = [...new Set(installed)].sort();
  const declaredNotInstalled = declaredSet.filter((n) => !installedSet.includes(n));
  const installedNotDeclared = EXPECTED_PACKAGES.filter((n) => installedSet.includes(n) && !declaredSet.includes(n));
  const expectedMissingInstalled = EXPECTED_PACKAGES.filter((n) => !installedSet.includes(n));
  const verdict = (declaredNotInstalled.length === 0 && expectedMissingInstalled.length === 0) ? 'pass' : 'fail';
  return {
    profile: profileDir,
    packageJson: fs.existsSync(pkgJsonPath),
    declared: declaredSet,
    installed: installedSet,
    declaredNotInstalled,
    installedNotDeclared,
    expectedMissingInstalled,
    verdict,
  };
}

/** ② 加载期响亮 + ④ 引擎读端（同一日志文本，两个固定字段组）。 */
function layer2and4(logPath) {
  if (logPath === null) {
    return {
      layer2: { log: null, pendingWaitingService: 0, patchEntryNotFound: 0, sampleLines: [], verdict: 'skipped' },
      layer4: { serviceUnavailable: 0, verdict: 'skipped' },
    };
  }
  const abs = path.resolve(logPath);
  if (!fs.existsSync(abs)) {
    return {
      layer2: { log: abs, pendingWaitingService: 0, patchEntryNotFound: 0, sampleLines: [], verdict: 'error' },
      layer4: { serviceUnavailable: 0, verdict: 'error' },
    };
  }
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const rePending = /pending \(waiting for service: agentTeams\)/;
  const rePatch = /patch: entry "[^"]*agent-team[^"]*" not found/;
  const reUnavailable = /service-unavailable/;
  let pendingWaitingService = 0;
  let patchEntryNotFound = 0;
  let serviceUnavailable = 0;
  const sampleLines = [];
  for (const line of lines) {
    if (rePending.test(line)) { pendingWaitingService += 1; if (sampleLines.length < 5) sampleLines.push(line.trim()); }
    if (rePatch.test(line)) { patchEntryNotFound += 1; if (sampleLines.length < 5) sampleLines.push(line.trim()); }
    if (reUnavailable.test(line)) serviceUnavailable += 1;
  }
  const l2verdict = (pendingWaitingService === 0 && patchEntryNotFound === 0) ? 'pass' : 'fail';
  const l4verdict = serviceUnavailable === 0 ? 'pass' : 'fail';
  return {
    layer2: { log: abs, pendingWaitingService, patchEntryNotFound, sampleLines, verdict: l2verdict },
    layer4: { serviceUnavailable, verdict: l4verdict },
  };
}

/** ③ 会话期功能面（静态可判部分）：组合树 dump 内逐包**锚定**核对 + 工具名应然清单。 */
function layer3(dumpPath) {
  if (dumpPath === null) {
    return { dump: null, rowCountsByPkg: {}, rowsMissing: [], toolsExpected: EXPECTED_TOOLS, sessionProbe: 'skipped', verdict: 'skipped' };
  }
  const abs = path.resolve(dumpPath);
  if (!fs.existsSync(abs)) {
    return { dump: abs, rowCountsByPkg: {}, rowsMissing: EXPECTED_PACKAGES, toolsExpected: EXPECTED_TOOLS, sessionProbe: 'error', verdict: 'error' };
  }
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const rowCountsByPkg = {};
  const rowsMissing = [];
  for (const pkg of EXPECTED_PACKAGES) {
    const re = rowAnchorReOf(pkg);
    let n = 0;
    for (const line of lines) if (re.test(line)) n += 1;
    rowCountsByPkg[pkg] = n;
    if (n === 0) rowsMissing.push(pkg);
  }
  return {
    dump: abs,
    rowCountsByPkg,
    rowsMissing,
    toolsExpected: EXPECTED_TOOLS,
    sessionProbe: 'not_applicable_static',
    verdict: rowsMissing.length === 0 ? 'pass' : 'fail',
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error !== null) {
    process.stderr.write('[dtier-machinecheck] 参数错误：' + args.error + '\n');
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (args.help) { process.stdout.write(USAGE); process.exit(0); }

  const profileDir = args.profile === null ? defaultProfileDir() : path.resolve(args.profile);
  if (!fs.existsSync(profileDir)) {
    process.stderr.write('[dtier-machinecheck] profile 目录不存在：' + profileDir + '\n');
    process.exit(2);
  }

  const l1 = layer1(profileDir);
  const l24 = layer2and4(args.log);
  const l3 = layer3(args.dump);

  const layerVerdicts = [l1.verdict, l24.layer2.verdict, l3.verdict, l24.layer4.verdict];
  const failed = layerVerdicts.some((v) => v === 'fail' || v === 'error');
  const result = {
    layer1: l1,
    layer2: l24.layer2,
    layer3: l3,
    layer4: l24.layer4,
    expected: { packages: EXPECTED_PACKAGES, tools: EXPECTED_TOOLS },
    verdict: failed ? 'fail' : 'pass',
    exitCode: failed ? 1 : 0,
  };
  const body = JSON.stringify(result, null, 2) + '\n';

  if (args.out !== null) {
    const outAbs = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, body, 'utf8');
    if (!args.json) process.stdout.write('[dtier-machinecheck] 已写入 ' + outAbs + '\n');
  }

  if (args.json || args.out === null) {
    process.stdout.write(body);
  } else {
    process.stdout.write('[dtier-machinecheck] verdict=' + result.verdict + ' exitCode=' + result.exitCode + '\n');
    process.stdout.write('[dtier-machinecheck] ① declaredNotInstalled=' + l1.declaredNotInstalled.length
      + ' expectedMissingInstalled=' + l1.expectedMissingInstalled.length + ' → ' + l1.verdict + '\n');
    process.stdout.write('[dtier-machinecheck] ② pendingWaitingService=' + l24.layer2.pendingWaitingService
      + ' patchEntryNotFound=' + l24.layer2.patchEntryNotFound + ' → ' + l24.layer2.verdict + '\n');
    process.stdout.write('[dtier-machinecheck] ③ rowsMissing=' + l3.rowsMissing.length + ' → ' + l3.verdict + '\n');
    process.stdout.write('[dtier-machinecheck] ④ serviceUnavailable=' + l24.layer4.serviceUnavailable + ' → ' + l24.layer4.verdict + '\n');
  }
  process.exit(result.exitCode);
}

try {
  main();
} catch (error) {
  // fail-closed：任何未预期异常一律非零（不允许「静默当通过」）
  process.stderr.write('[dtier-machinecheck] 内部异常（fail-closed）：'
    + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(2);
}
