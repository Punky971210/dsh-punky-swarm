#!/usr/bin/env node
// 规格记账门（S-10 装牙）：核「plan 派下的规格类检查」在验收里**要么有读数、要么显式记未执行+原因**。
//
// 背景（为什么需要它）：源侧机械面只核「每个契约至少有去处」，**不核**「需求点是否被契约承接」，
//   也**不核**「plan 要求的 CC-* / hoare-check 到底跑没跑」。实测事故：批次 edu-backend-m0-r6 的
//   `plan/r6-scope.md` 把 `CC-*` 与 `hoare-check` 派给 audit 并写明「若不可用须显式记未执行+原因」，
//   而 `audit/r6-acceptance.md` 与 `gap-list.json` 对二者的命中**均为 0**，批次照样 complete。
//   ⇒ 计划里的要求可以静默蒸发。本脚本把这条要求变成**可执行的门**（退出码语义，可直接写进产物 `gate:` 行）。
//
// 用法（作为 audit 产物的 gate 行）：
//   node scripts/check-spec-accounting.mjs --plan <plan.md> --acceptance <audit.md>
//   可用 `--plan`/`--acceptance` 传目录（目录内须恰有 1 个 *.md，否则 fail-closed）
//   可选 `--json` 输出机读明细；`-h/--help` 打印用法。
//
// 判定（三态，退出码 0/1/2）：
//   · 要求集 = plan 内 `spec-accounting:` 声明块（`- <id>` 逐条）；**无声明块时**退化为「plan 里出现的
//     `CC-*` / `hoare-check` 字面量去重」——因为实测事故正是「只在正文提过、没进块」这一形态。
//   · 每条要求，验收里须命中**下列之一**：
//       ① 读数：该行含 <id> 且含 `读数|PASS|FAIL|exit|SUMMARY:|通过|未通过` 或数字；
//       ② 显式未执行：该行含 <id> 且含 `未执行`，且同行给出原因（`原因`/`：`/`—`/`--` 之后 ≥8 字符）。
//         —— 「只写未执行、不写原因」判**不合格**（否则该豁免就变成万能通行证）。
//   · 0 = 全部满足；1 = 有缺失（打印逐条缺口）；2 = 用法错误 / 文件不可读（fail-closed）。
//
// 机读行（与适配层 S-8 同族）：
//   SUMMARY: spec-accounting <declared> declared, <covered> covered, <missing> missing. [PROCEED|BLOCK]
//
// 纪律：本脚本只判「有没有交代」，不判「读数是否正确」——读数真假属评审面，不属机械面。
import fs from 'node:fs';
import path from 'node:path';

const READ_PAT = /读数|PASS|FAIL|exit|SUMMARY:|通过|未通过/;
const NOT_RUN_PAT = /未执行/;
const REASON_PAT = /(?:原因|：|:|—|--)\s*(.{8,})/;
const ID_LIST_PAT = /^\s*[-*]\s*([A-Za-z][\w.-]*)\s*$/;
const INLINE_ID_PAT = /(CC-[A-Za-z0-9_.-]+|hoare-check)/g;

const USAGE = [
  '用法: node scripts/check-spec-accounting.mjs --plan <plan.md|dir> --acceptance <audit.md|dir> [--json]',
  '  --plan        计划产物（声明 spec-accounting 块，或在正文提及 CC-* / hoare-check）',
  '  --acceptance  验收产物（逐条给读数，或显式记「未执行 + 原因」）',
  '  --json        额外输出机读明细到 stdout',
  '  -h, --help    打印本用法',
  '退出码: 0 全部有交代 / 1 有要求未被交代 / 2 用法或文件错误（fail-closed）',
].join('\n');

function fail(msg) {
  process.stderr.write('[check-spec-accounting] ' + msg + '\n');
  process.stdout.write('SUMMARY: spec-accounting 0 declared, 0 covered, 0 missing. [BLOCK] usage-error\n');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { plan: null, acceptance: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--plan' || a === '--acceptance') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.startsWith('--')) fail(a + ' 缺值');
      out[a.slice(2)] = v;
      i += 1;
      continue;
    }
    fail('未知参数: ' + a);
  }
  return out;
}

/** 读文件；给目录时要求目录内恰有 1 个 *.md（否则 fail-closed，不做「随便挑一个」的猜测）。 */
function readProduct(p, label) {
  if (!fs.existsSync(p)) fail(label + ' 不存在: ' + p);
  const st = fs.statSync(p);
  if (st.isFile()) return fs.readFileSync(p, 'utf8');
  const mds = fs.readdirSync(p).filter((f) => f.endsWith('.md'));
  if (mds.length !== 1) fail(label + ' 是目录但 *.md 不唯一（' + mds.length + ' 个）: ' + p);
  return fs.readFileSync(path.join(p, mds[0]), 'utf8');
}

/** 要求集：优先取 `spec-accounting:` 声明块；无块则按正文提及的 CC-* / hoare-check 去重。 */
function declaredChecks(planText) {
  const lines = planText.split(/\r?\n/);
  const block = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*spec-accounting\s*:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (/^\S/.test(line)) break; // 回到顶层键即结束
      const m = line.match(ID_LIST_PAT);
      if (m) block.push(m[1]);
    }
  }
  const ids = block.length > 0 ? block : [...new Set(planText.match(INLINE_ID_PAT) ?? [])];
  // 族形态 `CC-*`（实测 r6 plan 就这么写）：**不展开成具体 id**（展开要靠人工枚举，属语义面），
  //   但保留成一条「族要求」——验收里须至少有一行给 CC- 类的读数或豁免，否则同样是静默蒸发。
  if (/\bCC-\*/.test(planText)) ids.push('CC-*');
  return [...new Set(ids)].sort();
}

/** 某条要求在验收里的交代状态：'reading' | 'not-run' | 'missing'。 */
function accountingOf(id, acceptanceText) {
  // 族形态按前缀匹配（CC-* ⇒ 任意 CC-xxx）
  const re = id === 'CC-*' ? /CC-/ : new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const line of acceptanceText.split(/\r?\n/)) {
    if (!re.test(line)) continue;
    if (NOT_RUN_PAT.test(line)) {
      return REASON_PAT.test(line) ? { state: 'not-run', line } : { state: 'missing', line, why: '未执行但未给原因' };
    }
    if (READ_PAT.test(line) || /\d/.test(line)) return { state: 'reading', line };
  }
  return { state: 'missing', why: '验收内既无读数、也无「未执行 + 原因」' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
  if (!args.plan) fail('缺 --plan');
  if (!args.acceptance) fail('缺 --acceptance');

  const planText = readProduct(args.plan, '--plan');
  const accText = readProduct(args.acceptance, '--acceptance');
  const ids = declaredChecks(planText);
  const detail = ids.map((id) => ({ id, ...accountingOf(id, accText) }));
  const missing = detail.filter((d) => d.state === 'missing');
  const covered = detail.length - missing.length;

  if (args.json) process.stdout.write(JSON.stringify({ declared: ids, detail }, null, 2) + '\n');

  process.stdout.write('SUMMARY: spec-accounting ' + ids.length + ' declared, ' + covered
    + ' covered, ' + missing.length + ' missing. [' + (missing.length === 0 ? 'PROCEED' : 'BLOCK') + ']\n');

  if (ids.length === 0) {
    // 未声明且正文未提及 ⇒ 本批无规格类要求。如实打印，不装作「核过了」。
    process.stdout.write('[check-spec-accounting] 本批未声明也未提及 spec 类检查（CC-* / hoare-check）⇒ 无要求可核。\n');
    process.exit(0);
  }
  if (missing.length === 0) {
    for (const d of detail) process.stdout.write('  ok    ' + d.id + '  (' + d.state + ')\n');
    process.exit(0);
  }
  for (const d of missing) {
    process.stdout.write('  MISS  ' + d.id + '  —— ' + d.why + '\n');
  }
  process.stdout.write('[check-spec-accounting] 以下规格类要求在验收里没有交代（读数或「未执行 + 原因」）：'
    + missing.map((d) => d.id).join(', ') + '\n');
  process.exit(1);
}

main();
