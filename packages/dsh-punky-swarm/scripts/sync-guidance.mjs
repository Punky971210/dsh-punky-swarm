#!/usr/bin/env node
// 指引同步：**只复制，不判定**（退役 `check-guidance-sync.mjs` 的校验面后的替代动作）
//
// 定位：指引维护不常做，且「改 repo 就要同步 live」这件事不需要用测试锚定来保证。
//   本脚本只做一件事：把 repo 侧指引面复制到 live 侧；内容相同则跳过。
//   **不产出「校验通过/不通过」结论**——需要核对时直接看两份文件，或看本脚本的回显。
//
// 复制面（两个 live 根，互不相同，勿混）：
//   ① 注入面五件 → `<profile>/.dsh/.agent-presets/punky-preset/`（可用 `--live=` 覆盖）
//   ② skills 整树  → `<profile>/.agents/skills/`（可用 `--skills-live=` 覆盖；`--no-skills` 跳过）
//
// 用法：
//   node scripts/sync-guidance.mjs                 # 五件 + skills 全同步
//   node scripts/sync-guidance.mjs --no-skills     # 只同步五件
//   node scripts/sync-guidance.mjs --dry-run       # 只列将复制/跳过，不落盘
//
// 退出码（与仓内其他脚本同约定）：0 = 全成功（含全部跳过）；1 = 有复制失败；2 = 参数错误 / 源缺失。
// 幂等：内容相同即跳过，重复执行不产生额外写入。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PRESET_REL = path.join('presets', 'punky-preset');
const SKILLS_REL = 'skills';

/** 注入面五件（相对 preset 根）。 */
const SYNC_FILES = [
  'agent.cordis.yml',
  path.join('references', 'discipline.md'),
  path.join('references', 'manager.md'),
  'preset.yml',
  'asset-manifest.json',
];

const SKILL_IGNORE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const USAGE = `用法：
  node scripts/sync-guidance.mjs [--no-skills] [--dry-run] [--live=<dir>] [--skills-live=<dir>]

复制面：
  注入面五件 → <live>（缺省 %USERPROFILE%/.dsh/.agent-presets/punky-preset）
  skills 整树 → <skills-live>（缺省 %USERPROFILE%/.agents/skills；--no-skills 跳过）

退出码：0 全成功（含全跳过）/ 1 有复制失败 / 2 参数错误或源缺失`;

function parseArgs(argv) {
  const out = { noSkills: false, dryRun: false, live: null, skillsLive: null, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--no-skills') { out.noSkills = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a.startsWith('--live=')) { out.live = a.slice('--live='.length); continue; }
    if (a.startsWith('--skills-live=')) { out.skillsLive = a.slice('--skills-live='.length); continue; }
    out.error = `未知参数：${a}`;
    return out;
  }
  return out;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function copyIfChanged(src, dst, result, dryRun) {
  if (!fs.existsSync(src)) {
    result.failed.push(`${src}（源缺失）`);
    return;
  }
  if (fs.existsSync(dst) && sha256(src) === sha256(dst)) {
    result.skipped.push(path.relative(ROOT, src));
    return;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  result.copied.push(path.relative(ROOT, src));
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKILL_IGNORE_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  if (args.error) { console.error(`${args.error}\n\n${USAGE}`); return 2; }

  const home = os.homedir();
  const liveRoot = args.live ?? path.join(home, '.dsh', '.agent-presets', 'punky-preset');
  const skillsLive = args.skillsLive ?? path.join(home, '.agents', 'skills');

  const result = { copied: [], skipped: [], failed: [] };
  const presetRoot = path.join(ROOT, PRESET_REL);

  if (!fs.existsSync(presetRoot)) {
    console.error(`源缺失：${presetRoot}`);
    return 2;
  }

  for (const rel of SYNC_FILES) {
    copyIfChanged(path.join(presetRoot, rel), path.join(liveRoot, rel), result, args.dryRun);
  }

  if (!args.noSkills) {
    const skillsRoot = path.join(ROOT, SKILLS_REL);
    for (const src of walkFiles(skillsRoot)) {
      const rel = path.relative(skillsRoot, src);
      copyIfChanged(src, path.join(skillsLive, rel), result, args.dryRun);
    }
  }

  const verb = args.dryRun ? '将复制' : '已复制';
  console.log(`[sync] live=${liveRoot}`);
  if (!args.noSkills) console.log(`[sync] skills-live=${skillsLive}`);
  console.log(`[sync] ${verb} ${result.copied.length} 件 · 跳过（内容相同）${result.skipped.length} 件 · 失败 ${result.failed.length} 件`);
  for (const f of result.copied) console.log(`[sync]   ${verb}: ${f}`);
  for (const f of result.failed) console.error(`[sync]   失败: ${f}`);

  return result.failed.length === 0 ? 0 : 1;
}

process.exitCode = main();
