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

// runCommand 冒烟（Coder 最小自检口径；全量断言归 Tester——test/command-exec.test.js 追加）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, truncateOutput, matchesForbidden, DEFAULT_FORBIDDEN_PATTERNS } from '../lib/state/command-exec.js';
// D1 交叉核对用：L3 工具黑名单的权威判定内核（`gate:` 面与工具面须同判同一批写盘路径）
import { judgeFileWriteCommand } from '../lib/governance/tool-ban.js';
// D1-A12 用：基线护栏的**同一份**词法口径（`scripts/` 为 .mjs 共享内核，非 tsc 产物，可直接 import）
import { countSource } from '../scripts/baseline-snapshot-core.mjs';

// D1 用例中的重定向字符：**不写字面量**——本文件自身会被 L3 工具面 hook 检查写命令，
// 且仓库编码铁律要求文件 UTF-8 无 BOM/LF，此处用字符码构造，保证命令行与源码都不出现裸重定向符。
const GT = String.fromCharCode(62);       // 单个重定向符
const GTGT = GT + GT;                     // 追加重定向符

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-cmdexec-'));

test('runCommand：exit 0 → ok:true, exitCode:0', () => {
  const r = runCommand({ command: 'node -e "process.exit(0)"', timeoutMs: 5000, retries: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(r.forbidden, false);
  assert.equal(r.timedOut, false);
});

test('runCommand：exit 非 0 → ok:false, exitCode 携带', () => {
  const r = runCommand({ command: 'node -e "process.exit(3)"', timeoutMs: 5000, retries: 0 });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.exitCode, 3);
});

test('runCommand：黑名单命中 → forbidden:true, ok:false，不执行', () => {
  const r = runCommand({ command: 'rm -rf /tmp/xxx', timeoutMs: 5000, retries: 0 });
  assert.equal(r.forbidden, true);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.equal(r.error, 'GATE_EXIT_FORBIDDEN');
});

// 【F-7 注释订正：**仅单元层可达**，不改判定】本例外是**单元层**直接调用可达；**集成层不可达**——
//   引擎写路径传给 `runCommand` 的 `command` 只来自 `detectGate().commands`，该数组按「空/`false` 不计入」
//   恒不含空串（`gates.ts`）；F-7 起「空 `gate:` 行」由 `checkCommandGate` 的 `emptyCommand` 首判短路直接拒载
//   （抛 `GATE_EXIT_NO_COMMAND`，**不经过本守卫**）。本守卫保留：它守的是 `runCommand` 自身的入参契约，
//   不得被读成「集成层已由它兜住」。
test('runCommand：空命令 → GATE_EXIT_NO_COMMAND', () => {
  const r = runCommand({ command: '   ', timeoutMs: 5000, retries: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'GATE_EXIT_NO_COMMAND');
});

test('runCommand：输出截断（maxOutputBytes 生效，truncated 标记）', () => {
  const r = runCommand({ command: 'node -e "process.stdout.write(\'x\'.repeat(100))"', timeoutMs: 5000, retries: 0, maxOutputBytes: 10 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.output.length, 10);
  assert.equal(r.truncated, true);
});

test('runCommand：超时 → timedOut:true, ok:false（不挂起）', () => {
  const r = runCommand({ command: 'node -e "setTimeout(()=>{}, 5000)"', timeoutMs: 300, retries: 0 });
  assert.equal(r.timedOut, true, JSON.stringify(r));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'GATE_EXIT_TIMEOUT');
});

test('runCommand：重试语义——非 0 按 retries 重试（retries:2 → 执行 3 次）', () => {
  const countFile = path.join(tmp, 'retry-count-' + Date.now() + '.txt');
  const cmd = 'node -e "require(\'fs\').appendFileSync(process.env.GATE_COUNT_FILE,\'x\');process.exit(1)"';
  const r = runCommand({ command: cmd, timeoutMs: 5000, retries: 2, env: { ...process.env, GATE_COUNT_FILE: countFile } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.exitCode, 1);
  assert.equal(fs.readFileSync(countFile, 'utf8').length, 3, 'expect 3 executions (1 + 2 retries)');
});

test('runCommand：成功即停——exit 0 不触发重试（执行 1 次）', () => {
  const countFile = path.join(tmp, 'retry-ok-' + Date.now() + '.txt');
  const cmd = 'node -e "require(\'fs\').appendFileSync(process.env.GATE_COUNT_FILE,\'x\')"';
  const r = runCommand({ command: cmd, timeoutMs: 5000, retries: 2, env: { ...process.env, GATE_COUNT_FILE: countFile } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(countFile, 'utf8').length, 1, 'expect 1 execution');
});

test('matchesForbidden：默认黑名单覆盖破坏性/部署类命令', () => {
  for (const bad of ['rm -rf /tmp/x', 'git push origin main', 'npm publish', 'drop database app', 'kubectl delete ns x', 'mkfs.ext4 /dev/sdb', 'sudo whoami']) {
    assert.equal(matchesForbidden(bad, DEFAULT_FORBIDDEN_PATTERNS), true, 'expect forbidden: ' + bad);
  }
  assert.equal(matchesForbidden('python -m pytest -q', DEFAULT_FORBIDDEN_PATTERNS), false);
  assert.equal(matchesForbidden('node --check lib/a.js', DEFAULT_FORBIDDEN_PATTERNS), false);
});

test('truncateOutput：短输出不截断，长输出截断', () => {
  assert.deepEqual(truncateOutput('abc', 10), { output: 'abc', truncated: false });
  const r = truncateOutput('x'.repeat(100), 8);
  assert.equal(r.output.length, 8);
  assert.equal(r.truncated, true);
});

// ---- Tester 全量补充：V10 默认 8192B 截断 / V11 cwd 自控 / 黑名单覆盖度评估 ----

test('runCommand：默认输出截断 8192B 生效（GATE_MAX_OUTPUT_BYTES 未设时）', () => {
  const prev = process.env.GATE_MAX_OUTPUT_BYTES;
  delete process.env.GATE_MAX_OUTPUT_BYTES;
  try {
    const r = runCommand({ command: 'node -e "process.stdout.write(\'x\'.repeat(9000))"', timeoutMs: 5000, retries: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.output.length, 8192, 'expect default 8192 bytes');
    assert.equal(r.truncated, true);
  } finally {
    if (prev !== undefined) process.env.GATE_MAX_OUTPUT_BYTES = prev;
  }
});

test('runCommand：cwd 生效 + `cd /d <dir> && <cmd>` 自控（命令在正确目录执行）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-cwd-'));
  // 平台分支：Windows cmd 跨盘须 `/d` 开关，POSIX sh 用裸 `cd`（引擎透传 shell 语义；本用例 os.tmpdir 同盘，裸 cd 语义等价）
  const cdPrefix = process.platform === 'win32' ? 'cd /d ' : 'cd ';
  const r = runCommand({ command: cdPrefix + JSON.stringify(dir) + ' && node -e "process.stdout.write(process.cwd())"', timeoutMs: 5000, retries: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.output.trim().replace(/\\/g, '/'), dir.replace(/\\/g, '/'), 'expect cwd = cd 目录');
});

test('黑名单覆盖度评估：当前 DEFAULT_FORBIDDEN_PATTERNS 覆盖已列模式（回归）', () => {
  const covered = [
    'rm -rf /tmp/x', 'rm -fr /x', 'rm -rvf /x',
    'drop database app', 'drop table users',
    'mkfs.ext4 /dev/sdb', 'format c:', 'dd if=/dev/zero of=/dev/sda',
    'git push origin main', 'npm publish', 'yarn publish', 'pnpm publish',
    'kubectl apply -f x.yaml', 'kubectl delete ns x', 'terraform apply', 'helm install x', 'ansible-playbook deploy.yml',
    './deploy.sh', 'release.ps1', 'install.bat',
    'chmod -R 777 /etc', 'shutdown -h now', 'reboot', 'poweroff',
    'sudo whoami', ':(){ :|:& };:',
  ];
  for (const c of covered) {
    assert.equal(matchesForbidden(c, DEFAULT_FORBIDDEN_PATTERNS), true, 'expect forbidden (已覆盖): ' + c);
  }
  // 正常验证命令不受影响
  for (const ok of ['python -m pytest -q', 'node --check lib/a.js', 'git diff', 'npm test', 'kubectl get pods']) {
    assert.equal(matchesForbidden(ok, DEFAULT_FORBIDDEN_PATTERNS), false, 'expect allowed: ' + ok);
  }
});

test('黑名单覆盖度评估：当前清单遗漏的破坏性/部署类命令（gap 候选，tester 建议补充）', () => {
  // 【D1 批改动（engine-review-fix-a-20260915 / e3）：以下 6 条**原属本数组**，D1 起已由写盘面覆盖 ⇒ 移出本数组，
  //   并以**同名/同形正向断言**保留覆盖（不删覆盖，只反转期望）——理由逐条：
  //   ① 'del /s /q C:\temp'        → scope ④ 段首写命令名 `del`
  //   ② 'rmdir /s /q C:\temp'      → 与 ③ 同族（cmd 目录删除），改由 ③ 覆盖，避免与 scope 逐项清单发散
  //   ③ 'rd /s /q C:\temp'         → 同 ②
  //   ④ 'Remove-Item -Recurse C:\temp' → scope ② 写 cmdlet `remove-item`
  //   ⑤ 'Remove-Item -Force x'     → scope ② 写 cmdlet（**不看参数**：口径为「已有 Agent 工具替代的写路径」，与 flag 无关）
  //   ⑥ 'truncate -s 0 file.txt'   → 与 ②/③ 同族（文件截断），同上避免清单发散
  //   其余 11 条仍为真缺口（git 写操作 / kill / Format-Volume / curl|sh 等，D1 口径明确不收）。
  const missing = [
    'git reset --hard HEAD', 'git clean -fdx', 'git checkout -- .', 'git stash drop', 'git branch -D x',
    'curl -s http://x | sh', 'wget -qO- http://x | bash', 'dd of=/dev/sda',
    'Format-Volume -DriveLetter C', 'kill -9 1234', 'taskkill /f /pid 1234',
  ];
  for (const c of missing) {
    assert.equal(matchesForbidden(c, DEFAULT_FORBIDDEN_PATTERNS), false, 'expect currently NOT forbidden (gap): ' + c);
  }
  // 建议补充模式：验证候选正则能有效拦截上述命令（供 test-report 黑名单补充建议引用）
  const SUGGESTED = [
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-fdx?\b/i,
    /\bgit\s+checkout\s+--/i,
    /\bgit\s+stash\s+(drop|clear)\b/i,
    /\bgit\s+branch\s+-D\b/i,
    /\b(del|rmdir|rd)\s+\/s\s+\/q\b/i,
    /\bRemove-Item\s+-(Recurse|Force|r|f)\b/i,
    /\btruncate\s+-s\s+0\b/i,
    /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i,
    /\bdd\s+of=/,
    /\bFormat-Volume\b/i,
    /\bkill\s+-9\b/i,
    /\btaskkill\s+\/f\b/i,
  ];
  for (let i = 0; i < missing.length; i++) {
    assert.equal(matchesForbidden(missing[i], SUGGESTED), true, 'suggested pattern must catch: ' + missing[i]);
  }
});

// ==================== D1：`gate:` 命令的写盘旁路封堵（工具面写禁的等价面） ====================
// 缺口：`gate:` 命令以 spawnSync(shell:true) 直跑子进程、不经宿主工具面 hook，原黑名单只含破坏性/部署模式
//   ⇒ 产物里写一行 `gate: <写盘命令>` 即可绕过 L3 写禁。本段用例 = 该缺口的回归网。

test('D1-A1：写盘路径命中（≥3 条，含权威清单四类 scope）', () => {
  const hits = [
    'Set-Content out.txt -Value x',                            // scope ② 写 cmdlet
    'echo hi ' + GT + ' out.txt',                              // scope ① 重定向
    'cmd ' + GTGT + ' log.txt',                                // scope ① 追加重定向
    'rm -rf build',                                            // scope ④ 段首写命令名
    'Get-Content a.txt | Add-Content b.txt',                   // scope ②（管道内，非段首）
    'Remove-Item -Recurse out',                                // scope ②
    'find . -name "*.ts" -exec rm {} ;',                       // scope ③ find -exec
    'node x.mjs -OutFile y.txt',                               // scope ③ 落盘参数
    'npm run build ' + GT + ' log.txt',                        // scope ①（**构建命令被写盘改造**——正是旁路形态）
  ];
  for (const c of hits) {
    assert.equal(matchesForbidden(c, DEFAULT_FORBIDDEN_PATTERNS), true, 'expect forbidden (D1 写盘): ' + c);
  }
});

test('D1-A2：常规闭环命令保持放行（≥3 条，L3 not_in_scope 同款）', () => {
  const allows = [
    'npm run build',
    'npm test',
    'node x.mjs',
    'node --test lib/',
    'git status',
    'Get-ChildItem -Recurse lib',
    'npm run build && npm test',
    'python -m pytest -q',
    'kubectl get pods',
  ];
  for (const c of allows) {
    assert.equal(matchesForbidden(c, DEFAULT_FORBIDDEN_PATTERNS), false, 'expect allowed: ' + c);
  }
});

test('D1-A3：重定向误伤控制——`=>` / `->` 与引号字面量内的 `>` 均不判命中', () => {
  // 判断依据：重定向符只在「前邻非 `=` / `-`」且「不在引号字面量内」时才成立 ⇒ 箭头语法与字符串内容不误伤
  const allows = [
    'node -e "x = a ' + GT + ' b"',
    'node -e "if (a => b) {}"',
    'grep -rn "Set-Content" lib',
    'Select-String -Pattern "->" -Path a.md',
  ];
  for (const c of allows) {
    assert.equal(matchesForbidden(c, DEFAULT_FORBIDDEN_PATTERNS), false, 'expect allowed（误伤控制）: ' + c);
  }
});

test('D1-A4：`2>&1` / `2>$null` 流合并不算落盘（L3 同款判据）', () => {
  assert.equal(matchesForbidden('Get-ChildItem 2' + GT + '&1 | Select-Object -First 1', DEFAULT_FORBIDDEN_PATTERNS), false);
  assert.equal(matchesForbidden('echo a 2' + GT + '$null', DEFAULT_FORBIDDEN_PATTERNS), false);
});

test('D1-A5：段首判定不误伤参数位/参数值出现写命令名', () => {
  assert.equal(matchesForbidden('xargs rm', DEFAULT_FORBIDDEN_PATTERNS), false, '`rm` 在参数位 ⇒ 放行');
  assert.equal(matchesForbidden('npm run build --touch=false', DEFAULT_FORBIDDEN_PATTERNS), false, '写命令名在参数值 ⇒ 放行');
  assert.equal(matchesForbidden('git config user.name "chmod"', DEFAULT_FORBIDDEN_PATTERNS), false, '写命令名在引号字面量 ⇒ 放行');
});

test('D1-A6：tester 建议清单中被 D1 覆盖的 6 条，其建议正则仍须命中（覆盖不丢失）', () => {
  // 这 6 条 D1 起已由写盘面覆盖（见上方 gap 用例的改动说明），此处把「原建议正则仍有效」钉住
  assert.equal(matchesForbidden('del /s /q C:\\temp', [/\b(del|rmdir|rd)\s+\/s\s+\/q\b/i]), true);
  assert.equal(matchesForbidden('rmdir /s /q C:\\temp', [/\b(del|rmdir|rd)\s+\/s\s+\/q\b/i]), true);
  assert.equal(matchesForbidden('rd /s /q C:\\temp', [/\b(del|rmdir|rd)\s+\/s\s+\/q\b/i]), true);
  assert.equal(matchesForbidden('Remove-Item -Recurse C:\\temp', [/\bRemove-Item\s+-(Recurse|Force|r|f)\b/i]), true);
  assert.equal(matchesForbidden('Remove-Item -Force x', [/\bRemove-Item\s+-(Recurse|Force|r|f)\b/i]), true);
  assert.equal(matchesForbidden('truncate -s 0 file.txt', [/\btruncate\s+-s\s+0\b/i]), true);
});

test('D1-A7：runCommand 端到端——写盘命令 forbidden:true 且不执行（exitCode null + outbox 无副作用）', () => {
  const marker = path.join(tmp, 'd1-marker-' + Date.now() + '.txt');
  const writeCmd = 'node -e "require(\'fs\').writeFileSync(process.env.GATE_MARKER, \'x\')" ';
  const r = runCommand({
    command: writeCmd + GT + ' "' + marker + '"',
    timeoutMs: 5000,
    retries: 0,
    env: { ...process.env, GATE_MARKER: marker },
  });
  assert.equal(r.forbidden, true, JSON.stringify(r));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.equal(r.error, 'GATE_EXIT_FORBIDDEN');
  assert.equal(fs.existsSync(marker), false, '写盘命令须**未被执行**（无落盘副作用）');
});

test('D1-A8：无重定向的同一条命令仍正常执行（对照组，证明被拦的是重定向而非命令本身）', () => {
  const marker = path.join(tmp, 'd1-control-' + Date.now() + '.txt');
  const sameCmd = 'node -e "require(\'fs\').writeFileSync(process.env.GATE_MARKER, \'x\')"';
  const r = runCommand({ command: sameCmd, timeoutMs: 5000, retries: 0, env: { ...process.env, GATE_MARKER: marker } });
  assert.equal(r.forbidden, false);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(marker), true, '对照组：命令确实可执行（差异只在重定向符）');
});

test('D1-A9：已知未覆盖面（内联解释器写）如实登记——本批不拦，随 followup 收敛', () => {
  // 权威清单 boundary 明示：`node -e fs.writeFileSync` / `python -c open(w)` 首批不覆盖（followup）
  assert.equal(matchesForbidden('node -e "require(\'fs\').writeFileSync(\'a\',\'x\')"', DEFAULT_FORBIDDEN_PATTERNS), false);
  assert.equal(matchesForbidden('python -c "open(\'a\',\'w\').write(\'x\')"', DEFAULT_FORBIDDEN_PATTERNS), false);
});

test('D1-A10：与 L3 工具面交叉核对——已收 cmdlet 之名两侧同判为写（同一批写路径，不各判一套）', () => {
  // 工具面走引号掩码 + 段首/全串判定；若本面收回 cmdlet 面却与其判断相左，即两套写禁相互矛盾
  const bothWrite = ['Set-Content out.txt -Value x', 'Out-File -FilePath o.txt', 'Get-ChildItem | Add-Content b.txt'];
  for (const c of bothWrite) {
    assert.equal(judgeFileWriteCommand(c).hit, true, 'L3 工具面须判为写: ' + c);
    assert.equal(matchesForbidden(c, DEFAULT_FORBIDDEN_PATTERNS), true, 'gate 面须判为写: ' + c);
  }
});

test('D1-A11：与 L3 工具面的**有意差异**钉住（本面窄于工具面）', () => {
  // 差异一（未闭合引号）：工具面 fail-closed（边界不明即按写文件处理，整条拒）；
  //   本面不新开拒绝位，退化为「只看引号外文本」——写命令名在引号外时两侧同判写（如实钉住，勿写成相反）；
  assert.equal(judgeFileWriteCommand('Set-Content "a.txt').hit, true, 'L3 工具面：未闭合引号 fail-closed');
  assert.equal(matchesForbidden('Set-Content "a.txt', DEFAULT_FORBIDDEN_PATTERNS), true, 'gate 面：cmdlet 在引号外 ⇒ 仍判写');
  // 差异二（确认偏窄的实例）：写命令名**完全落在引号内**、引号又未闭合时，工具面按写拒，本面放行 ⇒ 本面更窄。
  //   注：此处刻意不用 `rm -rf` 作样本——那会命中**基线破坏性模式**（`\brm\s+-rf\b` 是整串词域匹配、不做引号感知），
  //   从而遮住本面自身的判定差异，样本就失去了鉴别力。
  assert.equal(judgeFileWriteCommand('echo "mkdir /tmp/x').hit, true, 'L3 工具面：未闭合引号 fail-closed（整条拒）');
  assert.equal(matchesForbidden('echo "mkdir /tmp/x', DEFAULT_FORBIDDEN_PATTERNS), false, 'gate 面：窄口径不判写（有意差异）');
});

test('D1-A12（基线护栏加固）：D1 净增断言非空转——写盘面断言实存且无恒真形态', () => {
  // 守护目标：D1 的净增断言不得被「等价替换」掏空（如改写为 `assert.ok(true)` 一类恒真形态），
  //   也不得靠撤下写盘面样本、挪去别处凑数来虚报净增。
  // 口径刻意**不读 `baselines/test-baseline.json` 的当前值**：该文件按定义随「断言净增」不断重生成
  //   （本批 e6 正是它的守卫 lane），拿它做「必须大于」比较会在别 lane 正确地重生成基线时把本用例判红
  //   ——那是自指陷阱（判红原因与被守护对象无关）。故改用**结构证据**：
  //   ① 写盘面样本断言实存且达到样本量级（首参为 `DEFAULT_FORBIDDEN_PATTERNS` 的断言行）；
  //   ② 本文件不含恒真形态断言（复用 `countSource` 的同一份词法口径）。
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const d1AssertLines = selfSrc.split('\n')
    .filter((l) => l.includes('assert.') && l.includes('DEFAULT_FORBIDDEN_PATTERNS')).length;
  const live = countSource(selfSrc);

  assert.ok(d1AssertLines >= 18, 'D1 写盘面断言须实存（预期 ≥18，实测=' + d1AssertLines + '）');
  assert.equal(live.tautologies, 0, '本文件不得含恒真形态断言（实测命中=' + live.tautologies + '）');
  assert.ok(live.asserts >= d1AssertLines, '断言总数须不小于写盘面样本数（实测=' + live.asserts + '）');
});

