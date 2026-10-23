#!/usr/bin/env node
// 只读校验：**Agent 指引双层同步**（注入面 agent.cordis.yml ↔ 正文 references/discipline.md）
//           + **repo ↔ live 副本一致性**（同一 preset 的两份落地）。
//
// 用法：
//   node scripts/check-guidance-sync.mjs                校验（repo 侧 + 缺省 live 路径）
//   node scripts/check-guidance-sync.mjs --live <dir>   指定 live preset 目录
//   node scripts/check-guidance-sync.mjs --skills-live <dir>  指定 live skills 根（缺省 ~/.agents/skills）
//   node scripts/check-guidance-sync.mjs --no-live      跳过 live 面（preset 面 + skills 面一并跳过）
//   node scripts/check-guidance-sync.mjs --json         机读输出
//
// 参数纪律（fail-closed）：未知参数 / `--live` 或 `--skills-live` 缺值、重复出现、与 `--no-live` 并用
//   ⇒ 用法打 stderr、exit 2。
// 退出码：0 = 全绿；1 = 有失败项；2 = 参数错误。
//   skills 面（④）任何一个 `status !== 'same'` 计 1 项失败 ⇒ 退出码 1（0/1/2 三档语义不变）。
//
// 四条判据（① ② ③ 与 discipline.md §11/§12 的「指引同步」口径同源；④ 是**独立的新判据族**，
//   不复用 `SYNC_FILES`——`scripts/smoke/lib/checks-x.mjs:28` 有该五件清单的第二副本，扩它会造成双副本漂移）：
//   ① repo ↔ live：preset 五件的 sha256 必须逐字相同（改指引必须双副本同 sha）
//   ② 正向：注入面内联清单里每个 `#§X` 指针，必须在正文里真实存在
//   ③ 反向：正文里每个 `## §X` 小节，必须在注入面内联清单里有一行（详情面白名单除外）
//   ④ repo ↔ live：`skills/<name>/**` 整树逐文件 sha256（**按 repo 侧枚举**；live 侧另有数百个
//      第三方 skill，反向全等必然恒红）。**只让差异可见**：本判据**零写盘**，不覆盖任何一侧，
//      差异谁对由 Leader/用户裁。为什么需要它：`syncAssets()` 每次启动都用仓库版本覆盖 live skill，
//      外部写入者改过的 live 版本会被**静默冲掉**（唯一痕迹就靠这条判据留下）。
//
// 详情面白名单（DETAIL_ONLY）：引擎侧接线细节、**刻意不进注入面**的小节；新增白名单项须在本行写明理由。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PRESET_REL = path.join('presets', 'punky-preset');
const GUIDANCE = 'agent.cordis.yml';
const BODY = path.join('references', 'discipline.md');
const SYNC_FILES = [
  GUIDANCE,
  BODY,
  path.join('references', 'manager.md'),
  'preset.yml',
  'asset-manifest.json',
];

// 详情面白名单：这些小节**刻意不进注入面**（引擎接线细节，按需读正文即可）。
//   0m 派发套件落地细节｜0n 模式跟随装载口径｜0o 团队标签与团队资产口径（2026-09-27 订正：team 降为可选标签）
//   0j 临时组队与 Leader 编排纪律｜0l 能力发现前置（本部署实机检索口径）
// ⚠ 2026-09-26 用户裁决「**指引中不提及挂起内容**；落盘挂起内容快照，之后再回写」⇒ 已从正文**整体移出** 4 节：
//   §0f（L0 watch 消费协议）｜§0g（Leader 唤醒协议 · Manager 代劳指挥）｜
//   §0h（longrun 长程豁免 R-3）｜§0i（消费留痕与 D-1 纪律版）
//   ⇒ 原文**逐字**存档于 `reports/onto-suspended-items-snapshot-20260926.md`（§三），解挂时按该件回写。
//   ⇒ 故本白名单**同步移除** `0f`/`0g`/`0h`（正文已无该节，留着是永不匹配的死项）
//     与 `0r`（本就无正文节，属历史残留）。
const DETAIL_ONLY = new Set(['0m', '0n', '0o', '0j', '0l']);

// ④ skills 面：**独立判据族**，与 `SYNC_FILES` 零交集（见文件头「四条判据」）。
//   repo 侧枚举根 = `<repo>/skills`（9 skill / 56 文件）；live 侧根缺省 = `%USERPROFILE%\.agents\skills`。
const SKILLS_REL = 'skills';
// OS 噪声文件：两侧都可能由资源管理器/系统生成，不参与逐文件比对（否则「内容全同」也会判红）。
const SKILL_IGNORE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
// 逐文件 status：`same` 判绿；`missing-in-live` / `missing-in-repo` / `live-newer` / `live-older` /
//   `diverged` 五档判红（另在 skill 级有 `skipped` 语义：live 根整体不存在 ⇒ 落 note、不判红）。
//   方向只由 mtime 命名、**只写进文案**——判红/判绿的唯一真值是「sha 是否相等」与「文件是否存在」
//   （复制/检出/clone 都会重写 mtime，把方向当判据会造出假红/假绿）。
//   skill 级聚合取下列优先序中最高的一档：
const SKILL_DIFF_PRIORITY = ['missing-in-live', 'missing-in-repo', 'live-newer', 'live-older', 'diverged'];
// `live-newer` / `live-older` / `diverged` 的分界线：|Δmtime| ≤ 1ms ⇒ **方向不可判**（`diverged`）。
// 为什么不用严格 `===`：`utimes` 还原 mtime 实测残留亚毫秒误差（`Date` 只有整毫秒、double→100ns tick
//   有舍入），严格相等在真实文件系统上**不可达** ⇒ 该档会变成永远不可触发的死码。
//   1ms 容差既保住可达构造（用例 AC-H1-2 之外的 `diverged` 档），又不吞掉真实的方向语义
//   （外部写入 / 部署滞后都远超 1ms）。
const SKILL_MTIME_TIE_MS = 1;
const SKILL_DIFF_HINT = {
  'missing-in-live': '未同步（live 缺该文件）',
  'missing-in-repo': 'live 多出文件（外部新增）',
  'live-newer': 'live 较新：疑似外部写入，**勿自动覆盖**，由 Leader/用户裁',
  'live-older': 'live 较旧：疑似部署滞后，需重新同步',
  diverged: '方向不可判：按内容差异处置',
};

const USAGE = `用法：
  node scripts/check-guidance-sync.mjs [--live <dir>] [--skills-live <dir>] [--no-live] [--json]

  --live <dir>         live preset 目录（缺省 ${path.join('%USERPROFILE%', '.dsh', '.agent-presets', 'punky-preset')}）
  --skills-live <dir>  live skills 根（缺省 ${path.join('%USERPROFILE%', '.agents', 'skills')}）
  --no-live            跳过 repo↔live 面（preset 面与 skills 面一并跳过）
  --json               机读输出
`;

function parseArgs(argv) {
  const out = { live: undefined, skillsLive: undefined, noLive: false, json: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--no-live') { out.noLive = true; continue; }
    if (a === '--live') {
      if (out.live !== undefined) { out.error = '--live 重复出现'; return out; }
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { out.error = '--live 缺少目录参数'; return out; }
      out.live = v; i += 1; continue;
    }
    if (a === '--skills-live') {
      if (out.skillsLive !== undefined) { out.error = '--skills-live 重复出现'; return out; }
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { out.error = '--skills-live 缺少目录参数'; return out; }
      out.skillsLive = v; i += 1; continue;
    }
    out.error = `未知参数：${a}`;
    return out;
  }
  if (out.live !== undefined && out.noLive) out.error = '--live 与 --no-live 不能并用';
  else if (out.skillsLive !== undefined && out.noLive) out.error = '--skills-live 与 --no-live 不能并用';
  return out;
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function sectionsOf(bodyText) {
  const ids = [];
  for (const line of bodyText.split(/\r?\n/)) {
    const m = /^## §([0-9]+[a-z]?)\s/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function inlineEntriesOf(guidanceText) {
  const out = [];
  // 2026-09-18 清债轮：原载荷含 `line: i + 1`——全文件**零读点**（失败文案只用 `e.id`）⇒ 连同 `forEach` 的
  //   下标参数一并删除（死字段 + 死参数）。只保留有消费的两项：`id`（清单/反向查重）与 `pointers`（正向校验）。
  guidanceText.split(/\r?\n/).forEach((line) => {
    // ⚠ 2026-09-25 改动：缩进判定由**恰好 6 空格**放宽为 **≥6 空格**（`/^\s{6,}/`）。
    //   ■ 改动当时的名义理由：注入面据称要改为 `@deepseek-ai/dsh-agent-preset` 的 `plugins` 形态，
    //     条目会多一层缩进 ⇒ 严格 6 匹配落空。
    //   ■ ⚠ **该前提已不成立**：A-3（改 `plugins` 形态）**已于同日回滚**（repo=live=`CC517E91E3550D62`）。
    //   ■ ⚠ 且此放宽**疑似「未裁决的设计」**（用户 2026-09-26 裁决：**需注明背景、不下结论**）。
    //   ■ 现状事实（2026-09-26，由 onto-worker-notify 批 accept lane 报出 AU-05）：**放宽是 load-bearing** ——
    //     当前注入面条目缩进 > 6（`cordis.patch.yml` 的 `prefix:` 段内）⇒ **严格 6 会解析到 0 条**、
    //     放宽得 26 条；**两种口径都 exit 0**（条目数下降**不等价于**失败，故不会自曝）。
    //   ■ ⇒ **待裁项**：① 认定放宽正确（并在正文注明其 load-bearing）｜② 改为**按结构解析**
    //     （在 `prefix:` 段内按 `NN.` / `NNa.` 行匹配，不依赖缩进宽度）。
    //   ■ **未裁前保持现状（放宽），不得单方面改回严格。**
    const m = /^\s{6,}([0-9]{1,2}[a-z]?)\.\s+(\S.*)$/.exec(line);
    if (!m) return;
    const pointers = [...m[2].matchAll(/#§([0-9]+[a-z]?)/g)].map((x) => x[1]);
    out.push({ id: m[1], pointers });
  });
  return out;
}

// ── ④ skills 面：整树逐文件 sha（**只读**；不覆盖任何一侧） ──────────────────────

/** sha256 前 16 位；读不到返回 `null`（由调用方落 `diverged`，**不静默判绿**）。 */
function sha16Safe(abs) {
  try { return sha256(abs).slice(0, 16); } catch { return null; }
}

/**
 * 递归枚举**常规文件** ⇒ `Map<relPosix, {size, mtimeMs, abs}>`。
 * 符号链接**不计入且不跟随**（跟随会读进 repo/live 之外的目标，判据面失控）——只落 note。
 * `SKILL_IGNORE_NAMES`（OS 噪声文件）一律跳过，否则「内容全同」也会因 `.DS_Store` 判红。
 */
function listRegularFiles(absDir, notes) {
  const files = new Map();
  const walk = (dir, prefix) => {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      notes.push(`目录不可读，跳过：${dir}（${error?.code ?? error}）`);
      return;
    }
    dirents.sort((x, y) => (x.name < y.name ? -1 : (x.name > y.name ? 1 : 0)));
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isSymbolicLink()) { notes.push(`符号链接不计入（不跟随）：${abs}`); continue; }
      if (d.isDirectory()) { walk(abs, rel); continue; }
      if (!d.isFile() || SKILL_IGNORE_NAMES.has(d.name)) continue;
      const st = fs.statSync(abs);
      files.set(rel, { size: st.size, mtimeMs: st.mtimeMs, abs });
    }
  };
  walk(absDir, '');
  return files;
}

/**
 * 单 skill 逐文件比较 ⇒ 行数组 `{skill, file, status, repoSha16, liveSha16, repoBytes, liveBytes, relPath}`。
 * `liveSkillDir === null` 表示该 skill 在 live 侧整目录缺失（此时 repo 侧全部文件计 `missing-in-live`）。
 */
function compareSkillTree(skill, repoSkillDir, liveSkillDir, notes) {
  const repoFiles = fs.existsSync(repoSkillDir) ? listRegularFiles(repoSkillDir, notes) : new Map();
  const liveFiles = liveSkillDir && fs.existsSync(liveSkillDir) ? listRegularFiles(liveSkillDir, notes) : new Map();
  const names = [...new Set([...repoFiles.keys(), ...liveFiles.keys()])].sort();
  return names.map((file) => {
    const a = repoFiles.get(file) ?? null;
    const b = liveFiles.get(file) ?? null;
    const repoSha16 = a ? sha16Safe(a.abs) : null;
    const liveSha16 = b ? sha16Safe(b.abs) : null;
    let status;
    if (a && !b) status = 'missing-in-live';
    else if (!a && b) status = 'missing-in-repo';
    else if (repoSha16 && liveSha16 && repoSha16 === liveSha16) status = 'same';
    else if (!repoSha16 || !liveSha16) status = 'diverged';
    // 方向只用于**命名**：|Δmtime| ≤ 1ms ⇒ 不可判（见 SKILL_MTIME_TIE_MS 的可达性说明）
    else if (Math.abs(b.mtimeMs - a.mtimeMs) <= SKILL_MTIME_TIE_MS) status = 'diverged';
    else if (b.mtimeMs > a.mtimeMs) status = 'live-newer';
    else status = 'live-older';
    return {
      skill,
      file,
      relPath: `${skill}/${file}`,
      status,
      repoSha16,
      liveSha16,
      repoBytes: a ? a.size : null,
      liveBytes: b ? b.size : null,
    };
  });
}

/**
 * 按 **repo 侧 `skills/*\/`** 枚举（live 侧有数百个第三方 skill，绝不能反向要求全等）。
 * 返回 `{ root, same, diff, fileTotals, skills: [...], failures: [...] }`；
 * `failures` 非空 ⇒ 该判据族不通过（调用方计入退出码 1）。
 */
function compareSkills(repoSkillsRoot, liveSkillsRoot, notes) {
  const skillNames = fs
    .readdirSync(repoSkillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKILL_IGNORE_NAMES.has(d.name))
    .map((d) => d.name)
    .sort();
  const skills = [];
  const failures = [];
  const fileTotals = { total: 0, same: 0, diff: 0 };
  for (const skill of skillNames) {
    const repoSkillDir = path.join(repoSkillsRoot, skill);
    const liveSkillDir = path.join(liveSkillsRoot, skill);
    const liveDirMissing = !fs.existsSync(liveSkillDir);
    const files = compareSkillTree(skill, repoSkillDir, liveDirMissing ? null : liveSkillDir, notes);
    const diffs = files.filter((f) => f.status !== 'same');
    let status = 'same';
    if (liveDirMissing) status = 'missing-in-live';
    else if (diffs.length > 0) status = SKILL_DIFF_PRIORITY.find((s) => diffs.some((f) => f.status === s)) ?? 'diverged';
    skills.push({ skill, status, same: status === 'same', liveDirMissing, files });
    fileTotals.total += files.length;
    fileTotals.same += files.length - diffs.length;
    fileTotals.diff += diffs.length;
    for (const f of diffs) failures.push({ ...f, hint: SKILL_DIFF_HINT[f.status] ?? '内容与 repo 不一致' });
    // 空 skill 目录 + live 缺目录 ⇒ 无逐文件行可报，落一条目录级失败（否则「真缺口」会判绿）
    if (liveDirMissing && diffs.length === 0) {
      failures.push({
        skill,
        file: '',
        relPath: `${skill}/`,
        status: 'missing-in-live',
        repoSha16: null,
        liveSha16: null,
        repoBytes: null,
        liveBytes: null,
        hint: SKILL_DIFF_HINT['missing-in-live'],
      });
    }
  }
  const sameCount = skills.filter((s) => s.status === 'same').length;
  return { root: liveSkillsRoot, same: sameCount, diff: skills.length - sameCount, fileTotals, skills, failures };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`[guidance] 参数错误：${args.error}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const failures = [];
  const notes = [];
  const repoPreset = path.join(ROOT, PRESET_REL);
  const guidancePath = path.join(repoPreset, GUIDANCE);
  const bodyPath = path.join(repoPreset, BODY);
  for (const p of [guidancePath, bodyPath]) {
    if (!fs.existsSync(p)) failures.push({ check: 'presence', detail: `缺文件：${p}` });
  }
  if (failures.length) {
    process.stderr.write(failures.map((f) => `[guidance] ${f.detail}`).join('\n') + '\n');
    process.exit(1);
  }

  const guidanceText = fs.readFileSync(guidancePath, 'utf8');
  const bodyText = fs.readFileSync(bodyPath, 'utf8');
  const entries = inlineEntriesOf(guidanceText);
  const sections = sectionsOf(bodyText);
  const entryIds = new Set(entries.map((e) => e.id));
  const sectionIds = new Set(sections);

  // ② 正向：注入面指针（**若有**）必须解析到正文真实小节。
  //    注：不强制「每条都带指针」——注入面里有自足条目（规范句本身即完整契约），强制会造出假失败。
  for (const e of entries) {
    for (const t of e.pointers) {
      if (!sectionIds.has(t)) failures.push({ check: 'forward', detail: `注入面 ${e.id} 指向 §${t}，正文无此小节` });
    }
  }

  // ③ 反向：正文小节必须在注入面出现（白名单除外）
  for (const s of sections) {
    if (entryIds.has(s)) continue;
    if (DETAIL_ONLY.has(s)) { notes.push(`详情面（白名单）§${s} 未进注入面`); continue; }
    failures.push({ check: 'reverse', detail: `正文 §${s} 未进注入面清单（注入面缺该规范句；如属详情面请加入 DETAIL_ONLY）` });
  }

  // ① repo ↔ live
  const livePreset = args.noLive
    ? null
    : (args.live ?? path.join(process.env.USERPROFILE ?? '', '.dsh', '.agent-presets', 'punky-preset'));
  const syncRows = [];
  if (livePreset) {
    if (!fs.existsSync(livePreset)) {
      notes.push(`live preset 不存在，跳过：${livePreset}`);
    } else {
      for (const rel of SYNC_FILES) {
        const a = path.join(repoPreset, rel);
        const b = path.join(livePreset, rel);
        const ea = fs.existsSync(a); const eb = fs.existsSync(b);
        if (!ea || !eb) { failures.push({ check: 'sync', detail: `缺副本：${rel} repo=${ea} live=${eb}` }); continue; }
        const sa = sha256(a); const sb = sha256(b);
        syncRows.push({ file: rel, same: sa === sb, repo: sa.slice(0, 16), live: sb.slice(0, 16) });
        if (sa !== sb) failures.push({ check: 'sync', detail: `副本不一致：${rel} repo=${sa.slice(0, 16)} live=${sb.slice(0, 16)}` });
      }
    }
  }

  // ④ repo ↔ live：`skills/*/` 整树逐文件 sha（独立判据族；**按 repo 侧枚举**）
  const repoSkillsRoot = path.join(ROOT, SKILLS_REL);
  const liveSkillsRoot = args.noLive
    ? null
    : (args.skillsLive ?? path.join(process.env.USERPROFILE ?? '', '.agents', 'skills'));
  let skillsResult = null;
  if (liveSkillsRoot) {
    if (!fs.existsSync(repoSkillsRoot)) {
      notes.push(`repo skills 不存在，跳过 skills 面：${repoSkillsRoot}`);
    } else if (!fs.existsSync(liveSkillsRoot)) {
      // 环境未部署（如 CI）⇒ 不判红；但 live 根**存在**而某 skill 目录缺失 ⇒ `missing-in-live` 判红（真缺口）。
      notes.push(`live skills 不存在，跳过：${liveSkillsRoot}`);
    } else {
      skillsResult = compareSkills(repoSkillsRoot, liveSkillsRoot, notes);
    }
  }
  const skillsFailures = skillsResult?.failures ?? [];

  const result = {
    ok: failures.length === 0 && skillsFailures.length === 0,
    repoPreset,
    livePreset: livePreset ?? null,
    inlineEntries: entries.length,
    bodySections: sections.length,
    detailOnly: [...DETAIL_ONLY],
    sync: syncRows,
    notes,
    failures,
    // 新增键（既有键一字未改、向后兼容）：`null` = 该面未执行（`--no-live`，或 live/repo skills 根不存在）
    skills: skillsResult,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`[guidance] 注入面条目=${entries.length}｜正文 §小节=${sections.length}｜live=${livePreset ?? '(skipped)'}\n`);
    for (const r of syncRows) process.stdout.write(`[guidance]   ${r.same ? 'OK ' : 'DIFF'} ${r.file} repo=${r.repo} live=${r.live}\n`);
    if (skillsResult) {
      const ft = skillsResult.fileTotals;
      process.stdout.write(`[skills] repo=${repoSkillsRoot}｜live=${skillsResult.root}｜skill same=${skillsResult.same} diff=${skillsResult.diff}｜file total=${ft.total} same=${ft.same} diff=${ft.diff}\n`);
      for (const s of skillsResult.skills) {
        const diffCount = s.files.filter((f) => f.status !== 'same').length;
        if (s.status === 'same') process.stdout.write(`[skills]   OK   ${s.skill} files=${s.files.length}\n`);
        else process.stdout.write(`[skills]   DIFF ${s.skill} status=${s.status} files=${s.files.length} diff=${diffCount}\n`);
      }
      for (const f of skillsFailures) {
        process.stderr.write(`[skills]   FAIL ${f.status}: ${f.relPath} repo=${f.repoSha16 ?? '(none)'} live=${f.liveSha16 ?? '(none)'} bytes=${f.repoBytes ?? '-'}/${f.liveBytes ?? '-'} — ${f.hint}\n`);
      }
    }
    for (const n of notes) process.stdout.write(`[guidance]   NOTE ${n}\n`);
    for (const f of failures) process.stderr.write(`[guidance]   FAIL ${f.check}: ${f.detail}\n`);
    const totalFailed = failures.length + skillsFailures.length;
    process.stdout.write(`[guidance] ${result.ok ? 'GREEN 指引双层与副本一致性成立' : `RED ${totalFailed} 项失败`}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

main();
