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

// 批次 `core-techdebt-close-20260915` · lane e2：测试基线**生成器**。
//
// 用途：把 `test/**/*.test.js` 的源码词法计数（用例数 / 断言调用数 / test.todo 数 / 行数）
// 快照成 `baselines/test-baseline.json`，供 `test/test-baseline.test.js` 逐文件比对。
//
// 为什么需要它（本 lane 的问题陈述）：`test/gates.test.js` / `test/gate-flows.test.js` /
// `test/gate-techdebt-red.test.js` 三文件在 git 里 **untracked** ⇒ 没有历史 diff，
// 「删断言」这类退化只能在事后靠人工回忆间接举证（本仓已真实发生过一次举证困难）。
// 基线给出一条不依赖 git 追踪状态的确定性对照线。
//
// 用法（**参数面 fail-closed**，见 §参数校验）：
//   node scripts/baseline-snapshot.mjs                 # 生成/覆盖基线
//   node scripts/baseline-snapshot.mjs --check         # 只读对照：断言数下降 或 恒真形态命中数上升 ⇒ exit 1（不写盘）
//   node scripts/baseline-snapshot.mjs --reason "..."  # 覆盖时记录本次生成事由（留痕）
//   node scripts/baseline-snapshot.mjs --help | -h     # 打印用法（零副作用：不扫描、不写盘）
//
// 参数校验（**fail-closed**；本 lane 的问题陈述）：首版**无未知参数校验** ⇒ `--help` 被当成
// 无参处理，**静默进入重写分支**：既有基线被覆盖、`reason` 落成 `null`，事由留痕被无声洗掉。
// 现在——未知参数 / 非法组合（`--check` 配 `--reason`、`--reason` 缺值或空事由）⇒ 用法打 stderr、
// **exit 2、绝不进入重写分支**；未知 flag 一律「拒绝 + 用法提示」，**不得**静默降级为无参。
// 判定发生在**任何扫描/写盘之前**，故失败路径对仓库零副作用。
//
// 判红两条腿（批次 `engine-review-fix-a-20260915` · lane e6 补第二条）：
//   ① 断言调用数下降 ⇒ 兜「删断言」；
//   ② **恒真形态**命中数上升 ⇒ 兜「等价替换」（`assert.equal(x, 期望)` → `assert.ok(true)`，调用数不变）。
//
// 纪律：本脚本输出**UTF-8 无 BOM + LF**；键排序保证两次生成在同一源码下逐字节一致
// （唯一例外是 `generatedAt` 时间戳，故校验用例只比数值、不比时间戳）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_REL_PATH,
  compareBaseline,
  diffBaseline,
  findRepoRoot,
  readBaseline,
  scanTree,
  writeBaseline,
} from './baseline-snapshot-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE);

function buildDoc(scan, reason) {
  return {
    schema: 1,
    kind: 'test-baseline',
    generatedBy: 'scripts/baseline-snapshot.mjs',
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    reason: reason ?? null,
    // 口径自述：读基线的人无需翻生成器源码即可知道「这些数是什么、不是什么」
    metricSemantics: {
      tests: 'top-level `test(` call sites in code region (test.todo excluded)',
      todos: '`test.todo(` call sites in code region',
      asserts: '`assert.<method>(` call sites in code region (comments/strings excluded)',
      tautologies:
        'always-true assertion call sites in code region (assert.ok(<const truthy>) / assert.(strict|deep)?Equal(X, X)); heuristic, not AST',
      lines: 'physical lines split by LF',
      blankLines: 'blank lines (whitespace-only), informational only',
    },
    files: scan.files,
    totals: scan.totals,
  };
}

function formatDelta(n) {
  return (n > 0 ? '+' : '') + n;
}

/** 用法文本（`--help` 走 stdout 且 exit 0；参数错误走 stderr 且 exit 2）。 */
const USAGE = `用法：
  node scripts/baseline-snapshot.mjs                    生成/覆盖基线（记 \`reason: null\`）
  node scripts/baseline-snapshot.mjs --check            只读对照（不写盘；断言数下降 / 恒真形态上升 ⇒ exit 1）
  node scripts/baseline-snapshot.mjs --reason "<事由>"  覆盖时记录本次生成事由（留痕；事由不得为空）
  node scripts/baseline-snapshot.mjs --help | -h        打印本用法（零副作用）

参数纪律（fail-closed）：未知参数、\`--reason\` 缺值/空事由、\`--check\` 与 \`--reason\` 并用
一律拒绝——打印本用法到 stderr 并非零退出，**绝不重写基线**（静默降级为无参会洗掉事由留痕）。
`;

/**
 * 参数解析（**白名单 + fail-closed**）。
 * 只认 `--check` / `--reason <事由>` / `--help` / `-h`；其余一律判非法并**立即返回**，
 * 不进扫描、不进写盘。返回 `{ help, check, reason, error }`：`error` 非空 ⇒ 调用方打用法并 exit 2。
 * `--help` 只在整条参数向量**干净通过**时生效（未知参数优先判非法，判定序确定、不靠参数次序）。
 */
function parseArgs(argv) {
  const out = { help: false, check: false, reason: undefined, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--check') {
      if (out.check) {
        out.error = '--check 重复出现';
        return out;
      }
      out.check = true;
      continue;
    }
    if (a === '--reason') {
      if (out.reason !== undefined) {
        out.error = '--reason 重复出现';
        return out;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        out.error = '--reason 缺少事由（下一个参数是 flag 或不存在）';
        return out;
      }
      if (value.trim() === '') {
        out.error = '--reason 事由不得为空（空事由等于静默更新，禁止）';
        return out;
      }
      out.reason = value;
      i += 1;
      continue;
    }
    out.error = `未知参数：${a}`;
    return out;
  }
  if (out.check && out.reason !== undefined) {
    out.error = '--check 不写盘，与 --reason 并用非法（无覆盖动作可记事由）';
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error !== null) {
    process.stderr.write(`[baseline] 参数错误：${args.error}\n`);
    process.stderr.write(USAGE);
    return 2; // 非零退出；**已在此返回 ⇒ 绝不进入重写分支**
  }
  if (args.help) {
    // 零副作用：不扫描、不读写任何文件
    process.stdout.write(USAGE);
    return 0;
  }
  const { check, reason } = args;

  const scan = scanTree(ROOT);
  const abs = path.join(ROOT, BASELINE_REL_PATH);

  if (!check) {
    const prev = fs.existsSync(abs) ? readBaseline(ROOT) : null;
    const doc = buildDoc(scan, reason);
    writeBaseline(ROOT, doc);
    process.stdout.write(`[baseline] 已写入 ${BASELINE_REL_PATH}\n`);
    process.stdout.write(
      `[baseline] files=${scan.totals.files} tests=${scan.totals.tests} asserts=${scan.totals.asserts} ` +
        `tautologies=${scan.totals.tautologies} todos=${scan.totals.todos} lines=${scan.totals.lines}\n`,
    );
    if (prev) {
      const d = diffBaseline(prev, doc);
      process.stdout.write(`[baseline] 本次变化（相对上一版基线）：\n`);
      process.stdout.write(
        `[baseline]   totals: tests=${formatDelta(d.totals.tests)} asserts=${formatDelta(d.totals.asserts)} ` +
          `tautologies=${formatDelta(d.totals.tautologies)} todos=${formatDelta(d.totals.todos)} ` +
          `lines=${formatDelta(d.totals.lines)}\n`,
      );
      if (d.files.length === 0) process.stdout.write('[baseline]   （逐文件无变化）\n');
      for (const f of d.files) {
        const parts = Object.entries(f.delta).map(([k, v]) => `${k}=${formatDelta(v)}`);
        process.stdout.write(`[baseline]   ${f.kind} ${f.file}  ${parts.join(' ')}\n`);
      }
    } else {
      process.stdout.write('[baseline] 首次生成（无上一版可比）\n');
    }
    return 0;
  }

  if (!fs.existsSync(abs)) {
    process.stderr.write(`[baseline] --check 需要既有基线：${BASELINE_REL_PATH} 不存在\n`);
    return 2;
  }
  const cmp = compareBaseline(readBaseline(ROOT), scan);
  for (const w of cmp.warnings) process.stderr.write(`[baseline] WARN ${w}\n`);
  for (const f of cmp.filesChanged) {
    const parts = Object.entries(f.delta).map(([k, v]) => `${k}=${formatDelta(v)}`);
    process.stdout.write(`[baseline]   ${f.kind} ${f.file}  ${parts.join(' ')}\n`);
  }
  process.stdout.write(
    `[baseline] check: asserts ${cmp.asserts.baseline} -> ${cmp.asserts.current} (${formatDelta(cmp.asserts.delta)}); ` +
      `tautologies ${cmp.tautologies.baseline} -> ${cmp.tautologies.current} (${formatDelta(cmp.tautologies.delta)}); ` +
      `tests ${cmp.tests.baseline} -> ${cmp.tests.current} (${formatDelta(cmp.tests.delta)})\n`,
  );
  if (!cmp.ok) {
    if (cmp.asserts.delta < 0) {
      process.stderr.write('[baseline] RED：断言调用数低于基线（禁止静默删断言；确需变更请走显式更新通道）\n');
    }
    if (cmp.tautologies.delta > 0) {
      process.stderr.write(
        '[baseline] RED：恒真形态命中数高于基线（等价替换绕过：断言调用数不变，但断言被写成恒真——' +
          '`assert.ok(true)` / `assert.equal(a, a)` 之类）\n',
      );
      for (const f of cmp.filesChanged) {
        if ((f.delta?.tautologies ?? 0) <= 0) continue;
        process.stderr.write(`[baseline]   ${f.file} 恒真形态命中（含存量）：\n`);
        for (const h of scan.tautologyHits[f.file] ?? []) {
          process.stderr.write(`[baseline]     :${h.line} [${h.kind}] ${h.text}\n`);
        }
      }
      process.stderr.write('[baseline]   处置：还原为真断言，或在合法场景下走显式更新通道（附事由）\n');
    }
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
