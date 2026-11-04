#!/usr/bin/env node
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

// scripts/build-sync-guard.mjs —— **源 ↔ 构建产物同步守卫**（批 `punky-wp-ts-restore-20261103` · lane `impl`）
//
// 为什么需要它（真实事故，不是假想）：
//   提交 `0521292` 直接手改了构建产物 `lib/wave-plan.js`（`dispatch.js +67` / **`wave-plan.js +89`** / **无 `.ts`**），
//   而 `lib/wave-plan.ts` 里从没有对应实现 ⇒ 下一次 `npm run build` **静默擦除**手改部分，
//   且**没有任何测试覆盖该行为** ⇒ 擦掉后全量仍绿 ⇒ **功能丢失无人发现**。
//   ⇒ 本守卫做的事只有一件：**把「源缺 / 产物缺」这两种丢失，变成构建期必红的判据**。
//
// ⚠ 与 `scripts/docs-consistency.mjs` **分文件**（语义不同）：
//   · docs-consistency = **文档**一致性（旧词归零 / 计数一致）；
//   · 本守卫 = **源与产物**同步（`.ts` ↔ `.js`），且**可扩展到** `ports.js` / `contracts.js` / `schema.js` 等
//     `scripts/copy-ts-built.mjs` 回拷清单里的其他双源文件。
//   · 失败严重度也不同：产物丢失是**当前已丢**，必须当批阻断。
//
// **双向判据（两侧失败文案不同 —— 这是本脚本的核心设计）**：
//   · **`.ts` 缺符号** ⇒ `源缺，下次 build 会擦除`（危险但**还能救**：build 之前发现）
//   · **`.js` 缺符号** ⇒ `产物缺，当前已丢`（**已经丢了**：功能此刻不存在）
//
// 用法：
//   node scripts/build-sync-guard.mjs               # 退出码 0 同步 / 1 不同步
//   node scripts/build-sync-guard.mjs --json
//   node scripts/build-sync-guard.mjs --root <repo>
//   node scripts/build-sync-guard.mjs --pairs <ts>:<js>,<ts>:<js>   # 覆盖默认对（便于扩展/测试）
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const ROOT = path.resolve(opt('--root', process.cwd()));
const JSON_OUT = flag('--json');

/**
 * **必须存在于两侧的符号表**（新增回植项时在此登记）。
 * `why` 写清「丢了会怎样」，避免后人当噪音删掉。
 */
const REQUIRED_SYMBOLS = [
  {
    ts: 'lib/wave-plan.ts',
    js: 'lib/wave-plan.js',
    symbols: ['normalizeCheckpoints'],
    why: '提交 0521292 手改 .js 未写 .ts ⇒ build 静默擦除、功能丢失且无测试覆盖（本守卫的起因）',
  },
];

function pairsFromCli() {
  const raw = opt('--pairs', null);
  if (!raw) return null;
  return raw.split(',').map((s) => {
    const [ts, js] = s.split(':');
    return { ts, js, symbols: REQUIRED_SYMBOLS[0].symbols, why: 'CLI 覆盖' };
  });
}

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const checks = [];
const pairs = pairsFromCli() ?? REQUIRED_SYMBOLS;
for (const pair of pairs) {
  const tsAbs = path.join(ROOT, pair.ts);
  const jsAbs = path.join(ROOT, pair.js);
  const tsSrc = readIf(tsAbs);
  const jsSrc = readIf(jsAbs);
  for (const sym of pair.symbols) {
    const inTs = tsSrc !== null && tsSrc.includes(sym);
    const inJs = jsSrc !== null && jsSrc.includes(sym);
    // ① 源缺：build 之后会被擦掉（现在还能救）
    checks.push({
      id: 'SRC-MISSING',
      pair: `${pair.ts}::${pair.js}`,
      symbol: sym,
      ok: inTs,
      severity: 'block',
      message: inTs
        ? `${pair.ts} 含 ${sym} ✓`
        : `**源缺，下次 build 会擦除**：${pair.ts} 不含 \`${sym}\`（而 ${pair.js} ${inJs ? '含' : '也不含'}）`
          + ` —— 若只改 .js 不改 .ts，构建会静默丢功能。原因登记：${pair.why}`,
    });
    // ② 产物缺：**此刻功能已经不在了**
    checks.push({
      id: 'ARTIFACT-MISSING',
      pair: `${pair.ts}::${pair.js}`,
      symbol: sym,
      ok: inJs,
      severity: 'block',
      message: inJs
        ? `${pair.js} 含 ${sym} ✓`
        : `**产物缺，当前已丢**：${pair.js} 不含 \`${sym}\`（源 ${pair.ts} ${inTs ? '含' : '也不含'}）`
          + ` —— 功能此刻不存在，先跑 \`npm run build\`；若 build 后仍缺 ⇒ 源里没有（见上面 SRC-MISSING）。`,
    });
  }
}

const failed = checks.filter((c) => !c.ok);
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    guard: 'build-sync-guard', root: ROOT, total: checks.length, failed: failed.length, checks,
  }, null, 2) + '\n');
} else {
  for (const c of checks) {
    process.stdout.write(`[${c.ok ? 'PASS' : 'FAIL'}:${c.id}] ${c.pair} · \`${c.symbol}\` ⇒ ${c.message}\n`);
  }
  process.stdout.write(`\n[summary] ${checks.length - failed.length}/${checks.length} 通过`
    + (failed.length ? ' ⇒ **源与产物不同步，构建期阻断**' : ' ⇒ 源与产物同步') + '\n');
}
process.exit(failed.length === 0 ? 0 : 1);
