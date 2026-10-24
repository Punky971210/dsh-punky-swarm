#!/usr/bin/env node
// SpecLang 机械校验器的 **node 薄壳**（批次 `speclang-vendor-20261024` · lane `e2-shell`）
//
// 定位：**薄壳不是第二校验器**。壳只做三件事——定位 rb 原件、找 ruby 解释器、透传参数与退出码。
//   校验语义的单一真源 = `references/vendor/speclang/.../validate_speclang_mechanical.rb`（rb 原件，
//   逐字复制、本壳**零改写**）；壳**不读**被校验文件内容（读了即越界成第二真源）。
//
// 用法：
//   node scripts/speclang-validate.mjs [--ruby=<解释器路径>] <透传给 rb 的参数…>
//
// 参数纪律：
//   `-h` / `--help`      本壳自留：打印用法，**exit 0**，不触碰 ruby / rb。
//   `--ruby=<path>`      本壳自留：指定解释器（缺省 `ruby`，走 PATH 查找）。**不透传**给 rb。
//   其余一切 argv        **原样透传**给 rb（不解析、不重排、不合并、不改引号）。
//                        壳**不做**参数校验——未知参数由 rb 自己判，否则会把 rb 的参数演进面锁死在壳里。
//
// 四态（**exit 码是契约**）：
//   ① ruby 可用            原样透传 rb 的退出码（0 / 1 / 其他均原样），rb 输出经 stdio inherit 不经壳改写
//   ② ruby 不可用（ENOENT）exit 2，stderr 带 `UNKNOWN`（本机现状：`ruby` 不在 PATH）
//   ③ rb 原件缺失           exit 2，stderr 带缺失的**绝对路径**（vendor 资产不完整），文案与态②可区分
//   ④ `-h` / `--help`      exit 0，打印用法
//
// 为什么「无法执行」必须是 2 而不是 0 / 1：0 = 校验判合格、1 = 校验判不合规 —— 二者都是**假结论**。
//   2 是本仓脚本既有的「无法判定」档（与 `check-guidance-sync.mjs` 的 2 同构），文案带 `UNKNOWN`
//   即与证据强度档的 `UNKNOWN`（未取证、不计入合格档）同词，便于下游归档而**不被读成任何一种结论**。
//
// 措辞纪律（AC-C2）：态②/③ 的 stderr **不出现结论性判定词**（rb 侧的合格 / 不合规两词一律用「合格 / 不合格」表述），
//   以免自动化 grep 把壳的「无法执行」误读成一种结论。
//
// 禁项（本批硬约束）：禁 `shell: true`（注入面）；禁对 rb 做任何改写；禁缓存结论；禁在态②/③ 伪造 `0`。
//   路径一律由 `import.meta.url` 推导（禁硬编盘符 / 家目录字面量），故换机、换检出位置均可运行。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── 路径推导：唯一来源 = 本文件位置（不出现任何盘符 / 家目录字面量） ──────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/scripts
const PKG = path.resolve(HERE, '..'); // <pkg>
const RB = path.join(
  PKG,
  'skills',
  'software-team',
  'references',
  'vendor',
  'speclang',
  'speclang-waterfall',
  'assets',
  'validate_speclang_mechanical.rb',
);
const RB_REL_HINT = 'skills/software-team/references/vendor/speclang/speclang-waterfall/assets/';

const USAGE = `SpecLang 机械校验器薄壳（node 侧，校验语义由 rb 原件承担）

用法：
  node scripts/speclang-validate.mjs [--ruby=<解释器路径>] <透传给 rb 的参数…>

参数：
  -h, --help        打印本用法，exit 0（不调用 ruby / rb）
  --ruby=<path>     指定 ruby 解释器（缺省用 PATH 中的 ruby）；本壳自留，不透传给 rb
  其余参数          原样透传给 rb 原件，壳不解析、不校验、不重排

四态与退出码：
  ① ruby 可用       退出码 = rb 的退出码（原样透传）
  ② ruby 不可用     exit 2，stderr 标 UNKNOWN（校验**未执行**，结论未取证）
  ③ rb 原件缺失     exit 2，stderr 给出缺失的绝对路径（vendor 资产不完整）
  ④ -h / --help     exit 0

说明：退出码 2 = 「无法判定」，与 0（rb 报合格）/ 1（rb 报不合规）严格区分 —— 不要把 2 读成任何一种结论。
`;

/** 解析 argv：自留 `-h/--help` 与 `--ruby=`，其余原样进 `passthrough`（顺序不变）。 */
function parseArgs(argv) {
  const passthrough = [];
  let ruby = 'ruby';
  let rubyExplicit = false;
  let help = false;
  let error = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      help = true;
      continue;
    }
    if (a === '--ruby') {
      // 只支持 `--ruby=<path>`；空格分隔形态视为壳自身的用法错误（不猜、不漏传给 rb）。
      error = '`--ruby` 需写成 `--ruby=<解释器路径>`（等号形态）';
      break;
    }
    if (a.startsWith('--ruby=')) {
      const v = a.slice('--ruby='.length);
      if (!v) {
        error = '`--ruby=` 缺少解释器路径';
        break;
      }
      ruby = v;
      rubyExplicit = true;
      continue;
    }
    passthrough.push(a); // 原样透传：不解析、不重排
  }
  return { passthrough, ruby, rubyExplicit, help, error };
}

/** 态③：rb 原件缺失 ⇒ 文案给绝对路径 ＋ 与态② 可区分的状态标记。 */
function reportMissingRb() {
  process.stderr.write(
    '[speclang] 态③ rb 原件缺失（UNKNOWN）：校验**未执行**，结论未取证，不得据此下任何结论。\n'
    + `[speclang]   缺失路径：${RB}\n`
    + `[speclang]   期望位置（相对包根）：${RB_REL_HINT}\n`
    + '[speclang]   vendor 应有 27 件 skill 资产 ＋ LICENSE ＋ NOTICE.md（共 29 件）；'
    + '上游 dist/ 下的 speclang-convert-standalone.py 属构建产物，**已按裁决刻意排除**'
    + '（见同目录 NOTICE.md §三），不要为凑数把它加回来。\n',
  );
  process.exit(2);
}

/** 态②：解释器无法启动 ⇒ 文案标 UNKNOWN ＋ 给 `--ruby=` 补救提示 ＋ 与态③ 可区分的状态标记。 */
function reportRubyUnavailable(rubyBin, error) {
  const why = (error && (error.code || error.message)) || '未知原因';
  process.stderr.write(
    '[speclang] 态② ruby 不可用（UNKNOWN）：校验**未执行**，结论未取证，不得据此下任何结论（未取证 ≠ 已取证的结果）。\n'
    + `[speclang]   解释器：${rubyBin}（启动报错：${why}）\n`
    + '[speclang]   补救：用 `--ruby=<解释器路径>` 指定可用的 ruby；本机未安装 ruby 时该能力为 UNKNOWN，'
    + '不得折算为任何结论。\n',
  );
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    process.stderr.write(`[speclang] 参数错误：${args.error}\n\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }

  // ④ `-h` / `--help`：不触碰 ruby / rb
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // ③ rb 原件缺失（先于找解释器：此时「解释器有没有」已不是关键信息，补齐资产才是）
  if (!fs.existsSync(RB)) reportMissingRb();

  // ① / ② 调解释器：stdio inherit ⇒ rb 的输出原样直通，壳不改写、不截断
  const res = spawnSync(args.ruby, [RB, ...args.passthrough], { stdio: 'inherit' });

  if (res.error) {
    // ENOENT / EACCES / EINVAL 等：解释器没能起来 ⇒ 校验根本没跑
    reportRubyUnavailable(args.ruby, res.error);
  }
  if (typeof res.status === 'number') {
    process.exit(res.status); // ① 原样透传 rb 退出码（0 / 1 / 其他，壳不解释）
  }
  // 被信号终止（status = null）：同样没有可信结论
  process.stderr.write(
    `[speclang] 态② ruby 异常终止（UNKNOWN）：校验未产生结论，不得据此下任何结论（未取证 ≠ 已取证的结果）。信号：${res.signal ?? '(none)'}\n`,
  );
  process.exit(2);
}

main();
