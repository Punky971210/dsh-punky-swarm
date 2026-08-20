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

// 资产同步：把包内 presets/ 与 skills/ 同步到用户目录（参照 dsh-liangshen 语义）
// 幂等：目标目录字节一致则跳过（current），否则整体覆盖（synced）；只动插件自有目录，不碰用户其他预设/技能。
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MTIME_TOLERANCE_MS = 1000

/** 包根目录（lib/assets.js -> 包根）。 */
export function packageRoot() {
  return fileURLToPath(new URL('../', import.meta.url))
}

function filesUnder(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(root)
  return out
}

/** 文件字节一致性（size + mtime 容差快速否定，等价字节比对兜底）。 */
function sameFile(a, b) {
  const sa = statSync(a)
  const sb = statSync(b)
  if (sa.size !== sb.size) return false
  if (Math.abs(sa.mtimeMs - sb.mtimeMs) > MTIME_TOLERANCE_MS) return false
  return readFileSync(a).equals(readFileSync(b))
}

/** 目录幂等同步：'synced'（已写入/覆盖）| 'current'（已是最新）。 */
export function syncDir(sourceDir, targetDir) {
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  if (!existsSync(targetDir)) {
    cpSync(sourceDir, targetDir, { recursive: true, preserveTimestamps: true })
    return 'synced'
  }
  for (const file of filesUnder(sourceDir)) {
    const dest = join(targetDir, relative(sourceDir, file))
    if (!existsSync(dest) || !sameFile(file, dest)) {
      rmSync(targetDir, { recursive: true, force: true })
      cpSync(sourceDir, targetDir, { recursive: true, preserveTimestamps: true })
      return 'synced'
    }
  }
  return 'current'
}

/**
 * 同步预设与技能到用户目录。
 * @param opts.home - 用户主目录（测试可注入）；缺省 homedir()。
 * @param opts.packageRoot - 包根（测试可注入）；缺省按 import.meta.url 解析。
 * @returns [{asset, status: 'synced'|'current'|'missing-source'|'failed', error?}]
 */
export function syncAssets(opts = {}) {
  const home = opts.home ?? homedir()
  const root = opts.packageRoot ?? packageRoot()
  const jobs = [
    { rel: 'presets/jiufeng', target: join(home, '.dsh', '.agent-presets', 'jiufeng') },
    { rel: 'skills/jiufeng-team', target: join(home, '.agents', 'skills', 'jiufeng-team') },
  ]
  const results = []
  for (const job of jobs) {
    const src = join(root, job.rel)
    if (!existsSync(src)) {
      results.push({ asset: job.rel, status: 'missing-source' })
      continue
    }
    try {
      mkdirSync(dirname(job.target), { recursive: true })
      const status = syncDir(src, job.target)
      results.push({ asset: job.rel, status })
    } catch (error) {
      results.push({ asset: job.rel, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
