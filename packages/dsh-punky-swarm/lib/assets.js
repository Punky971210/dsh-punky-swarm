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
// 清单驱动：job 表来源 = 包内 presets/punky-preset/asset-manifest.json（M 层）+ 内置自举条（B 层，文件粒度）。
// 清单不可用（缺失/读取失败/JSON 破损/schema 不合规/落点越界）一律整体回退内置默认表，绝不静默不同步。
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const MTIME_TOLERANCE_MS = 1000

/** 资产清单的包内相对路径（B 层自举条 rel；禁止作为清单 assets[] 条目出现——自举回环）。 */
export const MANIFEST_REL = 'presets/punky-preset/asset-manifest.json'

/** 落点根枚举 -> 用户机解析根（清单只写枚举，不写绝对路径；两值即 Q-2 冻结落点）。 */
const TARGET_ROOTS = {
  preset: ['.dsh', '.agent-presets'],
  skill: ['.agents', 'skills'],
}

/** 内置默认资产表（清单不可用时的降级表；落点与冻结值逐字等价）。 */
const DEFAULT_ASSETS = [
  { rel: 'presets/punky-preset', target: { root: 'preset', subpath: 'punky-preset' } },
  // P1（2026-09-16）：引擎自建团队资产随包发布 + 同步登记（与 asset-manifest.json 同批同形，两处必须一致）。
  //   注意（如实标注）：**运行期真源始终是包内** `presets/engine-team/team-asset.yml`（读端 `packageRoot()`）；
  //   本条的落点 `<home>/.dsh/.agent-presets/engine-team/` 是**交付/审计副本**，不是 teamsRoot 形态
  //   （teamsRoot 解析 `<root>/presets/<team>/team-asset.*`），故它不被引擎当资产根读——登记目的是「资产随包可审计」。
  { rel: 'presets/engine-team', target: { root: 'preset', subpath: 'engine-team' } },
  { rel: 'skills/software-team', target: { root: 'skill', subpath: 'software-team' } },
  // P1（2026-09-17）：engine-team 技能文档随包发布 + 同步登记（与 asset-manifest.json 同批同形，两处必须一致）。
  { rel: 'skills/engine-team', target: { root: 'skill', subpath: 'engine-team' } },
  { rel: 'skills/design-team', target: { root: 'skill', subpath: 'design-team' } },
  // 退役（2026-09-17）：原「团队装配资产说明」技能条目随该技能目录**整体退役**删除（清单条目 11 → 10）——
  //   其内容已并入 `skills/software-team/SKILL.md` 的「装配资产（team-asset）说明与用途」章节。
  { rel: 'skills/review-execution', target: { root: 'skill', subpath: 'review-execution' } },
  { rel: 'skills/acceptance-gate', target: { root: 'skill', subpath: 'acceptance-gate' } },
  { rel: 'skills/retro-and-memory', target: { root: 'skill', subpath: 'retro-and-memory' } },
  { rel: 'skills/research-team', target: { root: 'skill', subpath: 'research-team' } },
  { rel: 'skills/writing-team', target: { root: 'skill', subpath: 'writing-team' } },
]

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

function errText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 清单路径规则（rel / target.subpath 共用）：非空、`/` 分隔、无前导 `/`、段不得命中 ''/'.'/'..'、无 `\` 与 `:`。 */
function isValidRelPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\\') || value.includes(':') || value.startsWith('/')) return false
  return value.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** 单行人类可读文本：trim 后长度 ∈ [1, 200]。 */
function isText(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200
}

/**
 * 清单 schema 校验（逐字段可判定谓词）。
 * @returns {string|null} 首个违规字段名（合法为 null）。
 */
function firstSchemaViolation(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'manifestVersion'
  if (raw.manifestVersion !== 1) return 'manifestVersion'
  if (!isText(raw.description)) return 'description'
  if (!Array.isArray(raw.assets) || raw.assets.length < 1) return 'assets'
  for (const asset of raw.assets) {
    if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) return 'rel'
    if (!isValidRelPath(asset.rel)) return 'rel'
    if (asset.rel === MANIFEST_REL) return 'bootstrap-cycle'
    if (asset.note !== undefined && !isText(asset.note)) return 'note'
    const target = asset.target
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return 'target.root'
    if (target.root !== 'preset' && target.root !== 'skill') return 'target.root'
    if (!isValidRelPath(target.subpath)) return 'target.subpath'
  }
  return null
}

/**
 * 落点渲染：join(ROOT[root], subpath)。
 * 防御性兜底：解析结果必须以 ROOT[root] 为前缀，越界返回 { ok:false, reason:'target.escape' }
 * （schema 路径规则已使其不可达，此处为纵深防御，单测直调覆盖）。
 * @returns {{ok: true, path: string}|{ok: false, reason: string}}
 */
export function resolveTarget(home, target) {
  const segs = TARGET_ROOTS[target.root]
  if (!segs) return { ok: false, reason: 'target.root' }
  const base = join(home, ...segs)
  const path = join(base, target.subpath)
  const back = relative(base, path)
  if (back.startsWith('..') || isAbsolute(back)) return { ok: false, reason: 'target.escape' }
  return { ok: true, path }
}

/** B 层自举条落点：预设根下 `punky-preset/asset-manifest.json`（文件粒度，与 M 层目录条互不依赖）。 */
function bootstrapTarget(home) {
  return join(home, ...TARGET_ROOTS.preset, 'punky-preset', 'asset-manifest.json')
}

/**
 * 读清单 -> 校验 -> 产出 job 表（M 层）；任何不可用态均回退内置默认表。
 * @returns {{manifest: string, jobs: [{rel: string, target: string}]}}
 */
function loadJobs(root, home) {
  const defaultJobs = DEFAULT_ASSETS.map((asset) => ({ rel: asset.rel, target: resolveTarget(home, asset.target).path }))
  const manifestPath = join(root, MANIFEST_REL)
  if (!existsSync(manifestPath)) return { manifest: 'missing', jobs: defaultJobs }

  let text
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch {
    return { manifest: 'read-error', jobs: defaultJobs }
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1)

  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { manifest: 'parse-error', jobs: defaultJobs }
  }

  const violation = firstSchemaViolation(raw)
  if (violation) return { manifest: 'schema-invalid:' + violation, jobs: defaultJobs }

  const jobs = []
  for (const asset of raw.assets) {
    const resolved = resolveTarget(home, asset.target)
    if (!resolved.ok) return { manifest: 'schema-invalid:' + resolved.reason, jobs: defaultJobs }
    jobs.push({ rel: asset.rel, target: resolved.path })
  }
  return { manifest: 'ok', jobs }
}

/**
 * 同步预设与技能到用户目录（清单驱动）。
 * B 层自举条恒先行、文件粒度、不进 results；M 层 = 清单 assets[]（不可用时 = 内置默认表）。
 * @param opts.home - 用户主目录（测试可注入）；缺省 homedir()。
 * @param opts.packageRoot - 包根（测试可注入）；缺省按 import.meta.url 解析。
 * @returns {{results: [{asset, status: 'synced'|'current'|'missing-source'|'failed', error?}], manifest: string}}
 *   manifest ∈ 'ok' | 'missing' | 'read-error' | 'parse-error' | 'schema-invalid:<首个违规字段名>'
 */
export function syncAssets(opts = {}) {
  const home = opts.home ?? homedir()
  const root = opts.packageRoot ?? packageRoot()
  const { manifest, jobs } = loadJobs(root, home)
  const results = []

  // B 层（自举条）：只复制清单文件本体，破「要同步清单必须先读清单」的环；成功态不进 results。
  // 失败必须可观测（禁静默）：沿用逐条 failed 语义入 results（仅失败时进，成功态 results 长度不受影响）。
  const bootstrapSrc = join(root, MANIFEST_REL)
  if (existsSync(bootstrapSrc)) {
    try {
      const dest = bootstrapTarget(home)
      mkdirSync(dirname(dest), { recursive: true })
      syncDir(bootstrapSrc, dest)
    } catch (error) {
      results.push({ asset: MANIFEST_REL, status: 'failed', error: errText(error) })
    }
  }

  // M 层：清单驱动条目（降级态 = 内置默认表），逐条语义与既有实现一致。
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
      results.push({ asset: job.rel, status: 'failed', error: errText(error) })
    }
  }
  return { results, manifest }
}
