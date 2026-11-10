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

// B-04 进程树守卫（**同步 launcher 入口，非测试件**）。
//
// 为什么需要它：`spawnSync(cmd.exe, …, { timeout, killSignal:'SIGTERM' })` 的 `killSignal` 只作用于
// **直接子进程**（cmd.exe）本身，`.cmd/.bat` 里真正干活的孙进程（node/npm）会成孤儿继续跑，
// 在引擎已报 `GATE_EXIT_TIMEOUT` 之后仍与 `GATE_RETRY` 的重试实例并发写同一份产物。
//
// 本进程由 `lib/state/command-exec.js` 以 `spawnSync(process.execPath, [本文件, …])` **同步**拉起，
// 因此外层 `runCommand` 的同步面不变（`lib/state/gates/command.js:202` 同步取值, 20+ 用例同步直调）。
// 内部改用异步 `spawn` 只是为了拿到真实 `pid`（`spawnSync` 的返回值拿不到活 pid），
// 而 launcher 自身由父层 `spawnSync` 同步等待 ⇒ 对外仍是同步语义。
//
// 调用：node command-tree-guard.mjs --timeoutMs=<n> -- <commandLine>
//   `--` 之后的所有实参**原样拼回**命令行原文（父层只传一个 argv 元素，此处 join 保持宽松）。
//
// 退出码契约：
//   | 情形 | 退出码 | 其余约定 |
//   | 子进程正常结束 | **原样透传**子进程退出码 | — |
//   | 计时到点 | **124** | 已 `taskkill /F /T /PID` 杀整棵树 |
//   | spawn 失败 | **126** | stderr 首行 `TREE-GUARD-SPAWN-FAIL: <message>` |
//   | 被信号收掉（maxBuffer 超限 / 外层兜底） | **143** | 先代传杀树，不留孤儿 |
//   | 子进程被外部信号杀死（code=null） | **1** | 无 124/126 语义，交父层按非 0 处置 |
import { spawn, execFileSync } from 'node:child_process';

const TIMEOUT_EXIT_CODE = 124;
const SPAWN_FAIL_EXIT_CODE = 126;
const SIGNAL_EXIT_CODE = 143;
const KILL_TREE_TIMEOUT_MS = 10000;
const EXIT_FALLBACK_MS = 3000;
const SPAWN_FAIL_MARKER = 'TREE-GUARD-SPAWN-FAIL:';

/** spawn 失败：按契约在 stderr 首行落 marker 后以 126 退出。 */
function reportSpawnFail(message) {
  process.stderr.write(SPAWN_FAIL_MARKER + ' ' + message + '\n');
  process.exitCode = SPAWN_FAIL_EXIT_CODE;
}

/** 解析 `--timeoutMs=<n>` 与 `--` 之后的命令行原文。 */
function parseGuardArgs(argv) {
  const separatorAt = argv.indexOf('--');
  if (separatorAt === -1) return { commandLine: null, timeoutMs: Number.NaN };
  let timeoutMs = Number.NaN;
  for (const token of argv.slice(0, separatorAt)) {
    const matched = /^--timeoutMs=(\d+)$/.exec(token);
    if (matched) timeoutMs = Number(matched[1]);
  }
  return { commandLine: argv.slice(separatorAt + 1).join(' '), timeoutMs };
}

/**
 * 同步杀整棵树。taskkill 不可用 / 树已退出都不阻塞收口 —— 本函数是「尽力而为」，
 * 返回值只用于诊断，不影响退出码契约。
 */
function killProcessTree(pid) {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: KILL_TREE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function runGuard(commandLine, timeoutMs) {
  const comspec = process.env.ComSpec || 'cmd.exe';
  let timedOut = false;
  let settled = false;

  const child = spawn(comspec, ['/d', '/s', '/c', commandLine], {
    shell: false,
    windowsHide: true,
    // stdin 置 ignore：父层 spawnSync 会把 stdin 立即 EOF，此处保持同一可读语义。
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 逐块转发：父层 `maxBuffer` / `maxOutputBytes` 截断语义因此逐字不变。
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child.pid);
    // 树已杀但 close 迟迟不来时兜底收口（unref：不拖住事件循环；循环仍有句柄时照常触发）。
    const fallback = setTimeout(() => process.exit(TIMEOUT_EXIT_CODE), EXIT_FALLBACK_MS);
    fallback.unref();
  }, timeoutMs);

  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reportSpawnFail(err && err.message ? err.message : String(err));
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut) {
      process.exitCode = TIMEOUT_EXIT_CODE;
      return;
    }
    // code=null ⇒ 子进程被信号杀死，本层无 124/126 语义 ⇒ 退化为非 0。
    process.exitCode = code === null ? 1 : code;
  });

  // 防回归（必需，非发挥）：旧形态里 maxBuffer 超限 / 外层兜底的 SIGTERM 打在 cmd.exe 上，
  // 改成 launcher 后它打在本进程上 —— 若不代传为杀树，会比修复前造出更多孤儿。
  const onTerminate = () => {
    if (!settled) killProcessTree(child.pid);
    process.exitCode = SIGNAL_EXIT_CODE;
    const hard = setTimeout(() => process.exit(SIGNAL_EXIT_CODE), EXIT_FALLBACK_MS);
    hard.unref();
  };
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onTerminate);
}

const { commandLine, timeoutMs } = parseGuardArgs(process.argv.slice(2));

if (!commandLine) {
  reportSpawnFail('命令行原文缺失（`--` 之后的 argv 为空）');
} else if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  reportSpawnFail('--timeoutMs 缺失或非正数（收到: ' + String(timeoutMs) + '）');
} else {
  runGuard(commandLine, timeoutMs);
}
