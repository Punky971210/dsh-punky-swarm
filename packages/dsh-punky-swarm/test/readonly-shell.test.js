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

// 只读 shell 判定（难度门禁只读侦察面）：白名单放行 / 写指示符与未知命令默认拒绝 / 分段与命令位口径
// 2026-09-15 补（对抗评审 B2）：find 写侧旗标族（`-fprint*`/`-fls`/`-exec*`/`-delete`，含**引号包裹**形态）
// 一律拒；纯只读 find 用法与「检索里的同名文本」不受影响；并补一条「未评估态不可写盘」的 guard 端到端断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeShellCommand, isReadOnlyShellCall } from '../lib/tools/readonly.js';
import { installDifficultyGuard, EXEC_TOOLS } from '../lib/tools/core.js';

const READ_ONLY = [
  'Get-ChildItem -Force',
  'Get-ChildItem -Recurse -Filter *.go',
  'Get-Content -Encoding UTF8 docs\\engine-open-items.md',
  "Get-Content 'D:\\AI_Workspace\\x y.md'",
  'ls -la',
  'cat README.md',
  'Test-Path ./docs',
  'Select-String -Path lib\\tools\\core.js -Pattern assign_check',
  'rg -n "difficulty" lib',
  'grep -rn "foo" .',
  'find . -name *.md',
  // find 的**只读**用法不受写旗标收紧影响（-print/-print0/-printf 仅 stdout，非写盘）
  'find . -type f -print',
  'find . -type f -print0',
  'find . -printf %p',
  'find lib -name readonly.js',
  "find . -name '*.js' -type f",
  // 作用域收窄的非回归：只读检索里的同名文本（引号内 `-delete`）不得被 find 写旗标规则误拒
  'grep -rn "-delete" lib',
  'rg -n "-fprint" lib',
  'Get-ChildItem | Select-String -Pattern guard',
  'Test-Path x; Get-Content y',
  'git status --porcelain',
  'git log -n 5 --oneline',
  'git log --format=%H -n 3',
  'git diff --stat',
  'git rev-parse HEAD',
  'git ls-files',
  'git branch -a',
  'git config --get user.name',
  'git stash list',
  'git remote -v',
  'git worktree list',
  'node --version',
  'python --version',
  'pnpm --version',
  'echo hello',
  'cd D:\\AI_Workspace\\DSH\\DSH; git status --porcelain',
  'cd docs; Get-ChildItem',
  // 误拒修复回归（2026-09-14 用户裁决：影响可用性/可能误导的摩擦点须修）
  '$files = Get-ChildItem -Recurse -Force',
  'Select-String -Path lib\\tools\\core.js -Pattern "difficulty|assign_check"',
  'Select-String -Pattern "->" -Path a.md',
  'grep -rn "Set-Content" lib',
  'Get-ChildItem 2>&1',
  'Get-ChildItem -Recurse 2>$null',
  'git -C D:\\dsh\\Punky-plugin\\packages\\dsh-punky-swarm status --porcelain',
  'git --no-pager log -n 3',
  '(Get-Item .).FullName',
];

const NOT_READ_ONLY = [
  'Set-Content out.txt -Value x',
  'Get-Content a.md > b.txt',
  'Get-ChildItem > out.txt',
  'rm -rf tmp',
  'sudo rm x',
  'git commit -m "x"',
  'git status; rm -rf x',
  'git stash',
  'git branch new-feature',
  'git config user.name x',
  'git tag v1.0',
  'git remote add origin url',
  'git worktree add ../wt',
  'npm install',
  'winget list',
  'curl https://example.com',
  'Get-ChildItem | Out-File x.txt',
  'Get-ChildItem -Recurse | Remove-Item',
  'Get-Content x; Add-Content y z',
  'echo "text" | tee f.txt',
  'node -e "console.log(1)"',
  'python -c "print(1)"',
  'bash -c "echo 1"',
  '$(Get-Date)',
  'find . -delete',
  // find 写侧旗标族（2026-09-15 对抗评审 B2）：落盘旗标与执行旗标一个都不放行
  'find . -fprint out.txt',
  'find . -name x -fprint out.txt',
  'find . -fprint0 out.bin',
  'find . -fprintf out.txt %p',
  'find . -fls out.txt',
  'find . -name x -exec rm {} ;',
  'find . -name x -execdir rm {} ;',
  'find . -name x -ok rm {} ;',
  'find . -name x -okdir rm {} ;',
  // 引号包裹形态：旗标 token 被掩码抹掉不是放行理由（掩码是修误拒的手段，不是逃逸通道）
  'find . "-fprint" out.txt',
  "find . -name x '-delete'",
  'Get-ChildItem; find . -fprint o.txt',
  'echo hi > f.txt',
  'mystery-tool --flag',
  '',
  // 放松形态后仍必须拒绝的旁路（防「放宽即漏」）
  '$x = Set-Content a.txt -Value 1',
  '$x = rm -rf y',
  '$x = ',
  'Get-ChildItem -Recurse 2>err.txt',
  '(Remove-Item x)',
  'bash -c "rm -rf x"',
  'git -C ../.. commit -m x',
  'Select-String -Pattern "a" | Out-File x.txt',
  'Get-ChildItem "unclosed',
];

test('只读白名单：明确只读命令放行（含管道/多语句只读分段）', () => {
  for (const c of READ_ONLY) {
    const r = judgeShellCommand(c);
    assert.equal(r.readonly, true, '应放行: ' + c + ' ← ' + r.reason + (r.segment ? ' @段[' + r.segment + ']' : ''));
  }
});

test('默认拒绝：写指示符 / 未知命令 / 空命令一律非只读', () => {
  for (const c of NOT_READ_ONLY) {
    const r = judgeShellCommand(c);
    assert.equal(r.readonly, false, '应拦截: ' + JSON.stringify(c));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝须给原因: ' + JSON.stringify(c));
  }
});

test('任一段非只读 ⇒ 整条非只读（分段口径）', () => {
  assert.equal(judgeShellCommand('Get-ChildItem && git status').readonly, true);
  assert.equal(judgeShellCommand('Get-ChildItem && git commit -m x').readonly, false);
  assert.equal(judgeShellCommand('git log | Select-String fix').readonly, true);
  assert.equal(judgeShellCommand('git log | tee out.txt').readonly, false);
});

test('非字符串/缺命令文本 → fail-closed', () => {
  assert.equal(judgeShellCommand(undefined).readonly, false);
  assert.equal(judgeShellCommand(null).readonly, false);
  assert.equal(judgeShellCommand(123).readonly, false);
  assert.equal(judgeShellCommand('   ').readonly, false);
});

test('isReadOnlyShellCall：仅 pwsh/bash 参与判定，其余工具不受本判定影响', () => {
  const pwsh = (command) => ({ name: 'pwsh', arguments: { command } });
  assert.equal(isReadOnlyShellCall(pwsh('git status')), true);
  assert.equal(isReadOnlyShellCall(pwsh('git commit -m x')), false);
  assert.equal(isReadOnlyShellCall({ name: 'bash', arguments: { command: 'ls -la' } }), true);
  // 非 shell 工具：即便参数里有只读命令文本也不走本判定（由 EXEC_TOOLS 名单语义接管）
  assert.equal(isReadOnlyShellCall({ name: 'write', arguments: { command: 'git status' } }), false);
  assert.equal(isReadOnlyShellCall({ name: 'subagent', arguments: {} }), false);
  // shell 工具但缺 command → fail-closed
  assert.equal(isReadOnlyShellCall({ name: 'pwsh', arguments: {} }), false);
  assert.equal(isReadOnlyShellCall({ name: 'pwsh' }), false);
  assert.equal(isReadOnlyShellCall(undefined), false);
});

// ── find 写侧旗标族（fail-closed）：不仅判非只读，且拒绝原因须可读地点名「find 写侧动作」 ──────────
test('find 写旗标：拒绝原因点名 find 写侧动作，不静默放行', () => {
  const cases = [
    'find . -fprint out.txt',
    'find . -fprint0 out.bin',
    'find . -fprintf out.txt %p',
    'find . -fls out.txt',
    'find . -delete',
    'find . -name x -exec rm {} ;',
    'find . "-fprint" out.txt',
    "find . -name x '-delete'",
  ];
  for (const c of cases) {
    const r = judgeShellCommand(c);
    assert.equal(r.readonly, false, '写旗标必须拒（默认拒绝）: ' + c);
    assert.ok(r.reason.includes('find'), '拒绝原因须点名 find 写侧动作: ' + c + ' ← ' + r.reason);
  }
});

// ── ③ 端到端：**未评估态不可写盘** ────────────────────────────────────────────
// 只读侦察面的判定内核（lib/tools/readonly.js）在 core.js 的难度门禁 guard 里决定「放行豁免」还是
// 「按执行型拦下」。故本用例直连 guard（与 lib/tools/core.js:128-131 同一分支），断言：**未评估态**
// （store 无 lastAssign 记录）下，写旗标 find 命令**拿不到只读豁免** ⇒ 被门禁拒 ⇒ 命令不执行 = 不落盘；
// 纯只读 find 仍获豁免（侦察面不被本次收紧波及）。
function guardOf(governance) {
  let fn = null;
  installDifficultyGuard(
    { tools: { guard: (g) => { fn = g; } } },
    { store: { readGovernance: () => governance, stale: () => false, bumpExecCount: () => {} } },
  );
  return fn;
}

test('未评估态端到端：写旗标 find 被门禁拦下（未执行 ⇒ 不可写盘），纯只读 find 放行', () => {
  const guard = guardOf(undefined); // 从未评估：lastAssign 缺失
  const call = (command) => guard({ name: 'pwsh', arguments: { command }, agent: { session: { id: 'sess-e2-writeflag' } } });
  assert.ok(EXEC_TOOLS.includes('pwsh'), '前提：pwsh 在执行型名单内，否则本用例会空转');
  for (const c of ['find . -name x -fprint out.txt', 'find . -fprint0 out.bin', "find . -name x '-delete'", 'find . -fls out.txt']) {
    const refused = call(c);
    assert.ok(
      typeof refused === 'string' && refused.includes('[task-difficulty-gate]'),
      '未评估态下写旗标 find 必须被难度门禁拒（拒 ⇒ 不执行 ⇒ 不落盘）: ' + c + ' ← ' + refused,
    );
  }
  assert.equal(call('find . -name x'), undefined, '纯只读 find 仍走只读侦察豁免');
  assert.equal(call('find . -type f -print0'), undefined, '只读 -print0 不受写旗标收紧影响');
});

// ═══════════════════════════════════════════════════════════════════════════════════
// DT-GAP-1 · T3：分隔符表驱动（`&` / `&&` / `;` / `|` / 换行）
//   （batch `punky-debt-fix-20261020` / lane `e2-test`；判据源 `plan/scope.md` §2 T3）
//
// 债面：只读面有两处按分隔符切段——
//   ① 主分段判定（`judgeSegment` 前的 `split(/;|&&|\|\||\||&|\r?\n/)`）；
//   ② **find 原文复扫**（`findWriteFlagInRaw`，同一套分隔符，只对段首为 `find` 的段复扫写侧旗标）。
//   两处都必须把 `&` 当作**真分隔符**：前缀只读不得「掩护」后缀的写动作。
// 表结构（AC-4 阳性对照）：**每个分隔符同一行给三格** ——
//   ① 后缀 = 写命令 ⇒ `readonly:false`；② 后缀 = 只读命令 ⇒ `readonly:true`（同分隔符的阴性对照，
//   证明拒的不是「出现了分隔符」）；③ 后缀 = find 写旗标 ⇒ `false` 且原因点名 find（覆盖第 ② 处）。
// ═══════════════════════════════════════════════════════════════════════════════════

// 分隔符单表：**同一张表**驱动只读/写两侧，避免两套口径各判一套
const SEPARATORS = [
  { name: '&（单与号）', join: (a, b) => a + ' & ' + b },
  { name: '&&（双与号）', join: (a, b) => a + ' && ' + b },
  { name: ';（分号）', join: (a, b) => a + ' ; ' + b },
  { name: '|（管道）', join: (a, b) => a + ' | ' + b },
  { name: '换行', join: (a, b) => a + '\n' + b },
];

test('T3-1 分隔符表驱动：同分隔符「后接写命令⇒拒」「后接只读⇒放」（5 分隔符 × 双侧，阳性对照成对）', () => {
  for (const sep of SEPARATORS) {
    // ① 后缀为写命令 ⇒ 整条非只读（分段口径：任一段非只读即整条非只读）
    const writeCmd = sep.join('Get-ChildItem', 'rm -rf x');
    const rw = judgeShellCommand(writeCmd);
    assert.equal(rw.readonly, false, '[' + sep.name + '] 后缀写命令须拒: ' + JSON.stringify(writeCmd));
    assert.ok(typeof rw.reason === 'string' && rw.reason.length > 0, '[' + sep.name + '] 拒绝须给原因');

    // ② **同分隔符阴性对照**：后缀换成只读命令 ⇒ 必须放行
    const roCmd = sep.join('Get-ChildItem', 'Get-Date');
    assert.equal(judgeShellCommand(roCmd).readonly, true,
      '[' + sep.name + '] 阳性对照：同分隔符后缀只读 ⇒ 须放行（否则「见分隔符即拒」不可证伪）: ' + JSON.stringify(roCmd));

    // ③ `ls & sleep 5` 类形态：sleep 不在只读白名单 ⇒ 拒，且原因点名 sleep（不是点名分隔符）
    const sleepCmd = sep.join('Get-ChildItem', 'sleep 5');
    const rs = judgeShellCommand(sleepCmd);
    assert.equal(rs.readonly, false, '[' + sep.name + '] 后缀 sleep 须拒: ' + JSON.stringify(sleepCmd));
    assert.ok(rs.reason.includes('sleep'), '[' + sep.name + '] 拒因须点名 sleep 段（证明切段生效）: ' + rs.reason);
  }
});

test('T3-2 `ls & rm -rf x` 类形态：写命令在 `&` 后缀 ⇒ 非只读（与 `;`/`|`/`&&` 同判据）', () => {
  const forms = ['Get-ChildItem & rm -rf x', 'Get-ChildItem && rm -rf x', 'Get-ChildItem ; rm -rf x',
    'Get-ChildItem | rm -rf x', 'Get-ChildItem\nrm -rf x'];
  for (const c of forms) {
    const r = judgeShellCommand(c);
    assert.equal(r.readonly, false, '须拒: ' + JSON.stringify(c));
    assert.ok(r.reason.includes('rm'), '拒因须点名 rm（写/执行类段）: ' + r.reason);
  }
  // 阳性对照：同一条命令把 `rm -rf x` 换成只读 `Get-Date` ⇒ 放行
  assert.equal(judgeShellCommand('Get-ChildItem & Get-Date').readonly, true, '阳性对照：两侧只读 ⇒ 放行');
});

test('T3-3 find 原文复扫（第 ② 处）：`&` 后缀的 find 写旗标须拒且点名 find（含引号包裹形态）', () => {
  for (const sep of SEPARATORS) {
    const bad = sep.join('Get-ChildItem', 'find . "-fprint" out.txt');
    const rb = judgeShellCommand(bad);
    assert.equal(rb.readonly, false, '[' + sep.name + '] find 写旗标须拒: ' + JSON.stringify(bad));
    assert.ok(rb.reason.includes('find'), '[' + sep.name + '] 拒因须点名 find 写侧动作: ' + rb.reason);

    // **同分隔符阴性对照**：同一 find 命令去掉写旗标 ⇒ 必须放行
    const ok = sep.join('Get-ChildItem', 'find . -name "*.md"');
    assert.equal(judgeShellCommand(ok).readonly, true,
      '[' + sep.name + '] 阳性对照：纯只读 find ⇒ 须放行: ' + JSON.stringify(ok));
  }
});

test('T3-4 `isReadOnlyShellCall` 通道：`&` 后缀写命令拿不到只读豁免（同形只读命令仍豁免）', () => {
  const pwshCall = (command) => ({ name: 'pwsh', arguments: { command } });
  assert.equal(isReadOnlyShellCall(pwshCall('Get-ChildItem & rm -rf x')), false, '`&` 后缀写 ⇒ 不豁免');
  assert.equal(isReadOnlyShellCall(pwshCall('Get-ChildItem & Get-Date')), true, '阳性对照：`&` 后缀只读 ⇒ 豁免');
  assert.equal(isReadOnlyShellCall({ name: 'bash', arguments: { command: 'ls & rm -rf x' } }), false, 'bash 通道同判');
  assert.equal(isReadOnlyShellCall({ name: 'bash', arguments: { command: 'ls & ls -la' } }), true, '阳性对照：bash 后缀只读 ⇒ 豁免');
});
