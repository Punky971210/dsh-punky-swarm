#!/usr/bin/env node
// 资产一致性核验（引擎自带，零依赖）：逐团队核验
//   ① 装配资产加载期校验是否通过（loadTeamAsset）
//   ② 资产引用的技能名能否解析（宿主技能根 ∪ 包内 skills/；判定取「目录名 ∪ frontmatter name」）
//   ③ 团队技能文档（skills/<team>/SKILL.md）与资产的角色/技能是否一致（差异清单）
// 用法：node scripts/check-team-assets.mjs [--root <pkgRoot>] [--json]
// 退出码：0 = 全部一致；1 = 存在「技能不可解析」或「资产引用但技能文档未提及」
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : path.dirname(HERE);
const AS_JSON = process.argv.includes('--json');

const { loadTeamAsset } = await import('file://' + path.join(ROOT, 'lib', 'assembly', 'team-asset.js').replace(/\\/g, '/'));

// 可解析名集合 = 目录名 ∪ 各 SKILL.md frontmatter 的 name（两者常不一致）
function namesOf(dir) {
  const set = new Set();
  if (!dir || !fs.existsSync(dir)) return set;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.')) continue;
    set.add(d.name);
    const md = path.join(dir, d.name, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    try {
      const head = fs.readFileSync(md, 'utf8').slice(0, 400);
      const m = head.match(/^name:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m);
      if (m) set.add(m[1]);
    } catch { /* 单文件读取失败忽略 */ }
  }
  return set;
}

const hostSkills = path.join(os.homedir(), '.agents', 'skills');
const pkgSkills = path.join(ROOT, 'skills');
const resolvable = new Set([...namesOf(hostSkills), ...namesOf(pkgSkills)]);

// 团队：presets/<team>/team-asset.{yml,json}
const presetsDir = path.join(ROOT, 'presets');
const teams = fs.existsSync(presetsDir)
  ? fs.readdirSync(presetsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((t) => fs.existsSync(path.join(presetsDir, t, 'team-asset.yml')) || fs.existsSync(path.join(presetsDir, t, 'team-asset.json')))
  : [];

const report = [];
let failed = false;

for (const team of teams) {
  const r = loadTeamAsset(ROOT, team);
  const entry = { team, ok: !!r.ok, problems: r.problems ?? [], skills: [], unresolved: [], docOnlySkills: [], notInDoc: [] };
  if (!r.ok || !r.asset || !r.asset.layers) { report.push(entry); failed = true; continue; }

  const assetSkills = new Set();
  const assetRoles = new Set();
  for (const layer of Object.values(r.asset.layers)) {
    for (const role of layer?.roles ?? []) assetRoles.add(role);
    for (const arr of Object.values(layer?.skills ?? {})) for (const s of arr ?? []) assetSkills.add(s);
  }
  entry.skills = [...assetSkills].sort();
  entry.roles = [...assetRoles].sort();

  for (const s of assetSkills) if (!resolvable.has(s)) entry.unresolved.push(s);

  // 团队技能文档：提取文档中出现的「已注册技能名」token，做双向差集
  const teamSkill = path.join(pkgSkills, team, 'SKILL.md');
  if (fs.existsSync(teamSkill)) {
    const text = fs.readFileSync(teamSkill, 'utf8');
    const docSkills = new Set();
    for (const name of resolvable) {
      const re = new RegExp('(^|[^-\\w/])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^-\\w])');
      if (re.test(text)) docSkills.add(name);
    }
    entry.notInDoc = [...assetSkills].filter((s) => !docSkills.has(s)).sort();
    entry.docOnlySkills = [...docSkills].filter((s) => !assetSkills.has(s)).sort();
  } else {
    entry.notInDoc = ['(缺 skills/' + team + '/SKILL.md)'];
    failed = true;
  }
  if (entry.unresolved.length > 0 || entry.notInDoc.length > 0) failed = true;
  report.push(entry);
}

if (AS_JSON) {
  console.log(JSON.stringify({ teams: report, resolvableNames: resolvable.size }, null, 2));
} else {
  console.log('资产一致性核验：团队 ' + teams.length + ' 个；可解析技能名合计 ' + resolvable.size + '\n');
  for (const e of report) {
    const bad = e.unresolved.length + e.notInDoc.length;
    console.log((bad === 0 && e.ok ? 'PASS ' : 'FAIL ') + e.team + (e.ok ? '' : ' 加载期校验不过: ' + JSON.stringify(e.problems)));
    console.log('   角色: ' + (e.roles ?? []).join(', '));
    console.log('   技能: ' + (e.skills ?? []).join(', '));
    if (e.unresolved.length) console.log('   ✗ 不可解析技能: ' + e.unresolved.join(', '));
    if (e.notInDoc.length) console.log('   ✗ 资产引用但团队技能文档未提及: ' + e.notInDoc.join(', '));
    if (e.docOnlySkills.length) console.log('   ⚠ 团队技能文档提及但资产未装配（信息项）: ' + e.docOnlySkills.join(', '));
  }
}
process.exit(failed ? 1 : 0);
