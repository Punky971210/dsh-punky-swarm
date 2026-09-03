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

// lib/tools/git-utils.js —— git 调用单点（R-06 runGit 下沉）
// -----------------------------------------------------------------------------
// 原 runGit 定义于 lane-tools.js（P1-05 起 merge-agent 消费 lane-tools 导出版），
// lane-tools.js ↔ merge-agent.js 相互 import 构成双向环（运行时 live binding 无碍，
// 但静态引用环可读性差、易踩初始化顺序坑）。R-06 把 runGit/gitBin 下沉到本零依赖
// 模块：lane-tools.js 与 merge-agent.js 均改引本文件，双向环消除。
// 零依赖：仅 node:child_process（不 import 任何本包模块，避免环）。
import { execFileSync } from 'node:child_process';

const gitBin = () => process.env.DSH_GIT_BIN ?? 'git';

// git 调用统一契约（仿 study-taskswarm git.ts runGit）：同步、{ ok, stdout, stderr, code }；
// git 缺失/不可执行 → ok:false + 清晰错误（不挂起、不静默失败，验收 T5）
export function runGit(repo, args, { cwd } = {}) {
  try {
    const out = execFileSync(gitBin(), args, {
      cwd: cwd ?? repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, stdout: String(out ?? '').trim(), stderr: '', code: 0 };
  } catch (e) {
    const stderr = e?.stderr ? String(e.stderr).trim() : (e?.message ? String(e.message) : String(e));
    return { ok: false, stdout: '', stderr, code: typeof e?.status === 'number' ? e.status : -1 };
  }
}
