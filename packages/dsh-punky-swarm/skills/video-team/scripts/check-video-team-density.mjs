#!/usr/bin/env node
/**
 * check-video-team-density.mjs — video-team 信息密度与结构完整性检查（S1–S7）
 *
 * 形态：**镜像** `skills/software-team/scripts/check-v3-density.mjs`
 *   （ESM `.mjs`；逐项 `add(id, pass, detail)`；**全 PASS / SKIP ⇒ exit 0；任一 FAIL ⇒ exit 1**；逐项 PASS/FAIL + detail 输出）
 *
 * 它守的是什么（本团队「防腐化装置」）：
 *   **7 个角色不许少**（S5）· **宪法不许长出软件术语**（S6）· **三条用户裁定句不许被删、禁用词不许长回来**（S7）
 *   —— 以及 S1–S4 的密度纪律（任务包键数 / Persona 长度 / 公共约束与指针句不重复）。
 *
 * 检查项（判据源 = `plan/video-team-spec.md` §⑦）：
 *   S0  ⚠ **非门禁项**（本 lane 主动补）：文件名大小写纪律 —— 盘上真实条目名须逐字为 `SKILL.md`。
 *        之所以补：规格 ② 逐字写 `SKILL.md`，而 **Windows 文件系统大小写不敏感** ⇒ 用 `statSync` 查
 *        大小写**恒 PASS**（假绿）。本项以 `readdirSync` 真实条目名核对，**不计入退出码**（不是 §⑦ 的判据）。
 *   S1  顶层键数：`SKILL.md` 首个 ```json 块的顶层键数 ≤ 10（内联行 + 缩进行两种形态都计）
 *   S2  Persona 行长度：`roles/*.md` 的 `## Persona…` 段正文（去空白）≤ 50 字符（CJK 计 1）
 *   S3  公共约束串未重复：`roles/*.md` 内命中 `constitution.md` 的公共约束条目 ⇒ 应为 0
 *   S4  指针句纪律：完整指针句命中 ≤ 0；压缩差异说明 ≤ 2 处
 *   S5  ⭐ 角色数与名单一致：`roles/*.md` 数 = 7 且文件名集合**逐字等于**七个名字
 *   S6  ⭐ 宪法独立性：`constitution.md` 内 `software-team` / `check-v3-density` / `coder` / `tester` /
 *                   `reviewer` / `docManager` 命中数**均为 0**
 *   S7  ⭐ 三条裁定句在场 + 禁令词为零：① 三条**逐字**裁定句在场；② `SKILL.md` 内 `renderer` = 0、
 *                   `docManager` / `doc-manager` = 0
 *
 * ⚠ **S7 的自伤陷阱（规格已点明，本脚本据此规避）**：裁定句 A **逐字含 `render`**（工序动词）
 *   ⇒ 若 ② 写成「查 `render` 命中 = 0」会**命中裁定句自身**造成**假红**。
 *   ⇒ **检查串必须是 `renderer`（角色名词），不是 `render`**；`docManager` 须覆盖 `docManager` 与 `doc-manager` **两种写法**。
 *
 * ⚠ **S3 / S4 的口径声明（诚实边界，勿误读为「已核」）**：规格 `§⑦` 把 S3 的模板串定义为
 *   「**以 `constitution.md` 的公共约束句为模板串**」，但**规格正文未冻结该句的字面值**
 *   （它由同批并行的 `e2-constitution` lane 产出）⇒ 本脚本**不硬编码**该句（硬编码即与 e2 的实际产出脱钩，
 *   会得到「看着在查、其实永远不命中」的假绿）。改用**结构性判据**，且**只收紧不放松**：
 *     S3 = `roles/*.md` 内是否**逐字内联**了 `constitution.md` 的**任一条目原文**（内联即重复 ⇒ FAIL）
 *     S4 = 完整指针句命中 ≤ 0 且压缩差异说明 ≤ 2（指针句模板串同上取自 `constitution.md` 的公共约束条目）
 *   ⇒ 若 `constitution.md` 不在场（本批**归位前**它属 e2 的写域、可能尚未落盘）⇒ S3/S4 记 **SKIP**（**不是 PASS**），
 *     并在 detail 写明「缺件」；**SKIP 不参与 exit code**（只有 FAIL 才 exit 1）。
 *
 * 用法：
 *   node check-video-team-density.mjs [--root <path>]
 *   · `--root <path>`：显式指定 video-team 根（该目录下应有 `SKILL.md` 与 `references/`）
 *        —— 本批**归位前**用：`--root <批次产物根>/exec`（五条 exec lane 的产物同层）
 *   · 缺省（无参数）：**自动探测**两态
 *       ① `<脚本所在目录>/..`（**归位后**：`skills/video-team/scripts/` ⇒ `skills/video-team/`）
 *       ② `<本仓 skills/>/video-team`（脚本被放在别处时的兜底）
 *     二者**均不可用** ⇒ **exit 2**（fail-closed，不拿空目录当「全 PASS」）。
 * 退出码：**门禁项（S1–S7）全 PASS / SKIP ⇒ 0；S1–S7 任一 FAIL ⇒ 1**；参数或根不可用 = 2（未知参数 ⇒ 2，fail-closed）。
 *         ⚠ 口径说明：**S0 属非门禁项**，其 FAIL **不影响退出码**（否则等于工单外扩门禁，
 *            会让「S1–S7 全通过」这一批级结论出现非预期红灯）—— 但仍**逐字打印**，由 Leader/audit 裁决。
 *
 * 只读：本脚本**不写任何文件**（无 fs 写调用）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ═══════════════════ 参数解析（**未知参数 ⇒ exit 2**，fail-closed） ═══════════════════ */
function parseArgs(argv) {
  let root = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) {
        console.error('usage: node check-video-team-density.mjs [--root <video-team-dir>]');
        console.error('  --root 需要一个非空路径值');
        process.exit(2);
      }
      root = v;
      i++;
      continue;
    }
    // 未知参数 ⇒ exit 2（**不忽略**：静默忽略参数会让「带错参数」跑成「看似全 PASS」）
    console.error('usage: node check-video-team-density.mjs [--root <video-team-dir>]');
    console.error('  未知参数：' + a);
    process.exit(2);
  }
  return { root };
}

/* ═══════════════════ 根解析：显式 --root 优先；缺省两态自动探测 ═══════════════════ */
/**
 * 判「该目录是否 video-team 根」。**两态都认**（本批实测的形态差异，见文件头 §两态）：
 *   · **归位后**：`<根>/SKILL.md` 在场（另有 `references/`）
 *   · **归位前（本批 exec/ 实测）**：五条 lane 的产物**平铺**在同层 ——
 *     `skill.md`（⚠ 实测为**小写**，见头注）+ `constitution.md` + `roles/` + `workflow.md` + `templates/`
 *       ⇒ 只认 `SKILL.md` 会把「归位前态」判成「根不可用」而 exit 2（**错杀**）。
 */
function looksLikeTeamRoot(dir) {
  const has = (rel) => { try { return fs.statSync(path.join(dir, rel)).isFile(); } catch { return false; } };
  const hasDir = (rel) => { try { return fs.statSync(path.join(dir, rel)).isDirectory(); } catch { return false; } };
  if (has('SKILL.md') || has('skill.md')) return true;
  // 平铺态兜底：三件以上见证物同层 ⇒ 认该目录为语义根
  let witnesses = 0;
  if (has('constitution.md')) witnesses++;
  if (has('workflow.md')) witnesses++;
  if (hasDir('roles')) witnesses++;
  if (hasDir('templates')) witnesses++;
  return witnesses >= 3;
}
function resolveRoot(explicit) {
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!looksLikeTeamRoot(abs)) {
      console.error('exit 2 — --root 下未找到 video-team 内容（SKILL.md/skill.md 或 ≥3 件套见证物）：' + abs);
      console.error('  （fail-closed：不拿空目录当「全 PASS」）');
      process.exit(2);
    }
    return { root: abs, how: 'explicit --root' };
  }
  const candidates = [
    path.resolve(__dirname, '..'),                              // 归位后：skills/video-team/scripts/ → skills/video-team/
    path.resolve(__dirname, '..', 'skills', 'video-team'),      // 脚本放在别处时的兜底
  ];
  for (const c of candidates) {
    if (looksLikeTeamRoot(c)) return { root: c, how: 'auto-detect: ' + c };
  }
  console.error('exit 2 — 自动探测失败：以下候选均无 video-team 内容');
  for (const c of candidates) console.error('  · ' + c);
  console.error('  （fail-closed：不拿空目录当「全 PASS」）');
  process.exit(2);
}

/**
 * **布局解析（两态）**：返回实际在场的路径 —— 同族件在**归位前**为平铺、**归位后**在 `references/` 下。
 *   · SKILL：`SKILL.md` / `skill.md` 两写法都认（**大小写差异在 detail 里显式报出**，见 S5/S6 相邻项）；
 *   · constitution / roles / workflow / templates：`<根>/x` 与 `<根>/references/x` 两位置都试。
 */
function resolveLayout(root) {
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const pickFile = (...rels) => rels.map((r) => ({ rel: r, abs: path.join(root, r) })).find((c) => isFile(c.abs)) ?? { rel: rels[0], abs: path.join(root, rels[0]) };
  const pickDir = (...rels) => rels.map((r) => ({ rel: r, abs: path.join(root, r) })).find((c) => isDir(c.abs)) ?? { rel: rels[0], abs: path.join(root, rels[0]) };
  return {
    skill: pickFile('SKILL.md', 'skill.md'),                                   // ⚠ 顺序即优先级：规范写法优先
    constitution: pickFile('references/constitution.md', 'constitution.md'),
    roles: pickDir('references/roles', 'roles'),
    workflow: pickFile('references/workflow.md', 'workflow.md'),
    templates: pickDir('references/templates', 'templates'),
  };
}

/* ═══════════════════ 判据常量（**逐字冻结自规格 §0.2 / §0.3 / §⑦**，不自行改写） ═══════════════════ */
/*
 * ⚠⚠ **两栏的权威归属「相反」—— 严禁合并成一栏**（Leader 2026-10-14 修正）
 *
 *   【FORBIDDEN 栏】权威在 **本常量表 + 规格**。
 *     ⇒ 被检文件内须**零出现**；**唯一的允许项**由 Leader 裁定 (c) 给出：
 *        `docManager` 允许**恰好一次**、且**只允许落在裁定 B 行内**（因为裁定 B 逐字引用它）。
 *     ⇒ 「被检文件里放什么」= **最小内容**：不列举禁用串、不复述检查项；合规自述用中立表述。
 *
 *   【REQUIRED 栏】权威在 **用户裁定面 / 规格原文**，**不在本表**。
 *     ⇒ 本表**只用于核「在场性」**（三条裁定句逐字出现）；被检文件内**必须逐字出现、不得改写标点**。
 *     ⇒ 「被检文件里放什么」= **逐字副本**（**不能最小化** —— 最小化会反过来触 S7-1 / AC-3 红）。
 *
 *   ⇒ 两栏的「家」在**相反的两侧**：**禁用串的家在脚本，必须出现串的家在裁定面**。
 *     （否则后来者会自然把两栏同向处理：把「必须出现」的三句也一并「最小化」⇒ 直接造假红。）
 */

/** §0.3 七个角色名 —— **逐字名单（按此顺序）**；S5 的比对目标 */
const ROLE_NAMES = ['coordinator', 'designer', 'producer', 'captioner', 'motion-designer', 'audio-engineer', 'supervisor'];

/* ── 【REQUIRED 栏】权威在**用户裁定面 / 规格原文**，不在本表；本表只核「在场性」 ── */
/** §0.2 三条用户裁定句（**逐字原文**）；S7-1 的在场判据 ⇒ 被检文件内必须逐字带上、不得改写标点 */
const RULINGS = [
  { id: 'A', text: '按满配成员规格，render 不需要，因为导出是成片之后的工序' },
  { id: 'B', text: '不要 docManager ⇒ 归档归 supervisor' },
  { id: 'C', text: '导出是成片之后的工序' },
];
/** 语义别名（与两栏口径对照阅读；与 `RULINGS` **同源**，非第二份数据） */
const REQUIRED_S7 = RULINGS;

/* ── 【FORBIDDEN 栏】权威在**本常量表 + 规格**；被检文件内须零出现（允许项见注释） ── */
/** S6 宪法独立性：`constitution.md` 内这六串命中均须为 0（**无允许项**） */
const FORBIDDEN_S6 = ['software-team', 'check-v3-density', 'coder', 'tester', 'reviewer', 'docManager'];

/**
 * S7 禁令串（**注意：用 `renderer` 而非 `render`** —— 裁定句 A 逐字含 `render`，查它会自伤）。
 * 允许项（Leader 裁定 (c) + 本 lane 同法补齐）：
 *   · `renderer`   ⇒ 允许出现在**裁定 A 行**内（行外一律 FAIL）
 *   · `docManager` ⇒ 允许**恰好一次**且必须在**裁定 B 行**内（行外一律 FAIL）
 *   · `doc-manager`⇒ **无允许项**（它不在任何逐字引用里）
 */
const FORBIDDEN_S7 = ['renderer', 'doc-manager'];

const strip = (s) => s.replace(/\s+/g, '');
const countOf = (hay, needle) => hay.split(needle).length - 1;
const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
/** 正则字面量转义（裁定句含 `，` `⇒` 等，须转义后再拼进 RegExp） */
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ═══════════════════ 结果收集器（**三态**：PASS / FAIL / SKIP） ═══════════════════ */
const results = [];
const add = (id, state, detail) => results.push({ id, state, detail });
const PASS = 'PASS', FAIL = 'FAIL', SKIP = 'SKIP';

/* ═══════════════════ 取件（布局两态，见 resolveLayout） ═══════════════════ */
const { root, how } = resolveRoot(parseArgs(process.argv.slice(2)).root);
const LAYOUT = resolveLayout(root);
const SKILL_PATH = LAYOUT.skill.abs;
const CONSTITUTION_PATH = LAYOUT.constitution.abs;
const ROLES_DIR = LAYOUT.roles.abs;

const skillText = readIf(SKILL_PATH);
const constitutionText = readIf(CONSTITUTION_PATH);
const roleFiles = (() => {
  try {
    return fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return null;
  }
})();

/* ─────────── S0：文件名大小写纪律（规格 ② 逐字为 `SKILL.md`） ─────────── */
/* ⚠ **本项是本 lane 踩到的第三处「检查自伤」，也是最危险的一处 —— 它原本是【假绿】**：
 *   Windows 文件系统**大小写不敏感** ⇒ `fs.statSync('SKILL.md')` 在盘上为 `skill.md` 时**照样成功**
 *   （实测：`SKILL.md` / `skill.md` / `Skill.md` / `SKILL.MD` **四个写法 Test-Path 全为 True**）
 *   ⇒ 若按「能否读到 SKILL.md」判大小写，**永远 PASS**（与「真的合规」在输出上无法区分）。
 * ⇒ 订正口径：**以 `readdirSync` 的真实条目名比对**（枚举是大小写忠实的，stat 不是）。
 *   ⚠ 本项**不参与退出码**（把「命名风格」与「防腐化硬判据」的红灯分开，避免混读）。 */
{
  const realNames = (() => { try { return fs.readdirSync(root); } catch { return []; } })();
  const exact = realNames.includes('SKILL.md');
  const wrongCase = realNames.find((n) => n.toLowerCase() === 'skill.md' && n !== 'SKILL.md') ?? null;
  const s0Pass = skillText !== null && exact;
  add('S0', s0Pass ? PASS : FAIL,
    skillText === null
      ? `SKILL.md 不在场（试过 SKILL.md / skill.md）：${path.join(root, 'SKILL.md')}（**不计入退出码**）`
      : (exact
        ? '文件名大小写合规：`SKILL.md`（spec ② 逐字；以 `readdirSync` 真实条目名核对，非 `statSync`）'
        : `**文件名大小写不符**：盘上真实条目名 = \`${wrongCase}\`，spec ② 逐字要求 \`SKILL.md\``
          + ' ⇒ 归位前须订正（大小写敏感文件系统下会加载失败；Windows 的 `statSync` 查不出此差异）；'
          + '⚠ 本项**不计入退出码**，故不会掩盖 S1–S7 的判定'));
}

/* ─────────── S1：任务包顶层键数 ≤ 10 ─────────── */
if (skillText === null) {
  add('S1', FAIL, 'SKILL.md 不在场：' + SKILL_PATH);
} else {
  const jsonBlock = skillText.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (!jsonBlock) {
    add('S1', FAIL, 'SKILL.md 未找到 ```json 任务包示例块（取「首个 json 块」口径）');
  } else {
    const block = jsonBlock[1];
    // 两种形态都计：① 块首行的内联键（`{ id, role, layer,`）② 两空格缩进的独立行键（四空格内层不匹配）
    const firstLine = (block.match(/^\{\s*([^\n]*)/m) || [])[1] || '';
    const inlineKeys = firstLine.split(',').map((k) => k.trim())
      .filter((k) => /^[a-zA-Z\u4e00-\u9fa5]+$/.test(k));
    const rowKeys = [...block.matchAll(/^  ([^ :{][^:]*?):/gm)].map((m) => m[1].trim());
    const keys = [...inlineKeys, ...rowKeys];
    add('S1', keys.length <= 10 ? PASS : FAIL,
      `任务包顶层键数 = ${keys.length}（要求 ≤10）；键：${keys.join(' / ') || '（无）'}`);
  }
}

/* ─────────── S2：Persona 段长度 ≤ 50 字符（去空白，CJK 计 1） ─────────── */
if (roleFiles === null) {
  add('S2', FAIL, 'roles 目录不在场：' + ROLES_DIR);
} else if (roleFiles.length === 0) {
  add('S2', FAIL, 'roles 目录为空：' + ROLES_DIR);
} else {
  const over = [];
  for (const f of roleFiles) {
    const c = readIf(path.join(ROLES_DIR, f));
    if (c === null) { over.push(`${f}:(不可读)`); continue; }
    const m = c.match(/## Persona[^\n]*\n([\s\S]*?)(?=\n## |$)/);
    const p = m ? strip(m[1]) : '';
    if (p.length > 50) over.push(`${f}:${p.length}`);
  }
  add('S2', over.length === 0 ? PASS : FAIL, over.length === 0
    ? `Persona 全部 ≤50 字符（去空白后计；覆盖 ${roleFiles.length} 个角色文件）`
    : `超限：${over.join('，')}`);
}

/* ─────────── S5：角色数 = 7 且名单**逐字**一致（硬失败面） ─────────── */
{
  const expected = [...ROLE_NAMES].sort();
  if (roleFiles === null) {
    add('S5', FAIL, 'roles 目录不在场：' + ROLES_DIR);
  } else {
    const actual = roleFiles.map((f) => f.replace(/\.md$/, ''));
    const actualSorted = [...actual].sort();
    const missing = expected.filter((n) => !actualSorted.includes(n));
    const extra = actualSorted.filter((n) => !expected.includes(n));
    const ok = roleFiles.length === 7 && missing.length === 0 && extra.length === 0;
    add('S5', ok ? PASS : FAIL,
      `roles/*.md 数 = ${roleFiles.length}（要求 7）；`
      + `缺失 = ${missing.length ? missing.join(', ') : '（无）'}；`
      + `多余 = ${extra.length ? extra.join(', ') : '（无）'}；`
      + `实测名单 = ${actualSorted.join(', ') || '（无）'}`);
  }
}

/* ─────────── S6：宪法独立性（硬失败面） ─────────── */
if (constitutionText === null) {
  add('S6', FAIL, 'constitution.md 不在场：' + CONSTITUTION_PATH);
} else {
  const hits = FORBIDDEN_S6
    .map((s) => ({ s, n: countOf(constitutionText, s) }))
    .filter((x) => x.n > 0);
  add('S6', hits.length === 0 ? PASS : FAIL, hits.length === 0
    ? `宪法独立性成立：${FORBIDDEN_S6.map((s) => `${s}=0`).join(' ')}`
    : `违禁串命中：${hits.map((x) => `${x.s}=${x.n}`).join('，')}（要求均为 0）`);
}

/* ─────────── S7：三条裁定句在场 + 禁令词为零（硬失败面） ───────────
 * 【Leader 订正（2026-10-14，采纳 e1-skill 推荐 (c)）】S7 拆为**三项**，其中 ② 改为「允许项的可判形态」：
 *   S7-1  三条裁定句**逐字**在场（§①② 的逐字优先）
 *   S7-2  `docManager` **命中 ≤ 1**，且**若 = 1 必须仅出现在裁定 B 行内**
 *           —— 裁定 B 逐字即 `不要 docManager ⇒ 归档归 supervisor`，**两者不可能同时为 0**；
 *              订正把「逐字引用」从「禁令」里**显式划出**（与 §⑦ 已为 `render` 做过的处理**同族同法**）。
 *   S7-3  `doc-manager` 命中 **= 0**（**无例外**：它只在禁例清单里，不在任何逐字引用里）；
 *         `renderer` 命中 = 0，**但沿用 S7-2 同法**：允许其出现在**裁定 A 行**内
 *           （⚠ 这是本 lane 主动补的一处：规格只处理了「查 `render` 会自伤」，
 *              **未处理「若裁定 A 行含 `renderer`，查 `renderer` 同样自伤」** —— 同族同源，
 *              故一并用「仅限裁定 A 行」表达，闭合该族）。
 */
{
  if (skillText === null) {
    add('S7-1', FAIL, 'SKILL.md 不在场：' + SKILL_PATH);
    add('S7-2', FAIL, 'SKILL.md 不在场：' + SKILL_PATH);
    add('S7-3', FAIL, 'SKILL.md 不在场：' + SKILL_PATH);
  } else {
    // 行面辅助（**须先于 S7-1 声明**：S7-1 依赖「独立裁定行」判定，不再用全文包含）
    const lines = skillText.split('\n');
    //   ⚠ 前缀匹配**不加行尾锚** —— 真实文档常在裁定句后加括注（如「…（renderer 系被裁席位）」），
    //     加 `$` 会找不到该行 ⇒ S7-2/S7-3 的「允许项行」判据随之失准（由可达反例 RED-7a 暴露）。
    const rulingLineIdx = (id) => lines.findIndex((l) => new RegExp(`^\\s*-\\s*\\*\\*裁定 ${id}\\*\\*\\s*[:：]`).test(l));
    const raA = rulingLineIdx('A');
    const linesForRuling = lines;

    /* S7-1：三条裁定句**各自以独立「裁定 X」行逐字在场**
     * ⚠ 本 lane 实测的**第二处自伤/漏判**（由可达反例 RED-3 暴露）：
     *   裁定 C（`导出是成片之后的工序`）**是裁定 A 的子串**
     *   （A = `按满配成员规格，render 不需要，因为导出是成片之后的工序` 的后半）
     *   ⇒ 若 S7-1 写成「全文去空白后 `includes(句)`」，**删掉 C 所在行后仍会 PASS**（被 A 行满足）
     *     ⇒ **假绿**（检查形同虚设）。
     * ⇒ 订正口径：**必须是该句独占一条 `- **裁定 X**：<句>` 行** ——
     *   即「三条裁定句**各有一行**」，而不是「三句话的字面出现在全文某处」。
     */
    /** 判「裁定 X 是否以独立一行、逐字带上该句」；返回 {ok, seen} */
    const rulingLineCheck = (ruling) => {
      // 口径：**行首锚定** + `裁定 X` + 冒号 + 可选 `` ` `` + **逐字句** + 可选闭合反引号 + **允许行尾附加说明**。
      //   ⚠ 行尾**不**要求「恰好在反引号处结束」：真实文档常在引用后加括注
      //     （如「… 因为导出是成片之后的工序`（renderer 系被裁席位）」）。
      //   ⚠ 行尾宽限**不会**重新引入 RED-3 的假绿 —— 因为**行首锚定**已限定「本句必须出现在
      //     `- **裁定 X**：` 这一行内」，不可能被**另一条裁定行**的字面满足。
      const re = new RegExp('^\\s*-\\s*\\*\\*裁定 ' + ruling.id + '\\*\\*\\s*[:：]\\s*`?' + escRe(ruling.text) + '`?');
      const hit = linesForRuling.find((l) => re.test(l));
      return { ok: Boolean(hit), seen: hit ? hit.trim().slice(0, 80) : null };
    };
    const absentStandalone = RULINGS.filter((r) => !rulingLineCheck(r).ok);
    add('S7-1', absentStandalone.length === 0 ? PASS : FAIL,
      `三条裁定句**各自独立成行**逐字在场：${absentStandalone.length === 0
        ? 'A/B/C 三行齐备且逐字相符'
        : '不符 ' + absentStandalone.map((r) => `${r.id}（该行实测=${
          JSON.stringify(rulingLineCheck(r).seen ?? '（无此行）')}）`).join('，')}`
      + `｜**允许项：本项核「在场性」，不核「零命中」** —— 三条裁定句逐字引用自身所含的 render / docManager **不导致本项失败**`
      + `（依据：规格 §0.2「逐字原文，不得改写标点」+ §⑦ S7①；且 C 是 A 的子串，故本项要求**独立成行**而非全文包含）`);

    /* S7-2：docManager ≤1 且仅出现在裁定 B 行内 */
    const dmB = rulingLineIdx('B');
    const dmHits = lines.map((l, i) => ({ l, i })).filter((x) => x.l.includes('docManager'));
    const dmStray = dmHits.filter((x) => x.i !== dmB);
    const dmOk = dmHits.length <= 1 && dmStray.length === 0;
    add('S7-2', dmOk ? PASS : FAIL,
      `docManager 命中 = ${dmHits.length}（允许 ≤1）｜落在裁定 B 行内 = ${dmHits.filter((x) => x.i === dmB).length}`
      + `｜裁定 B 行之外 = ${dmStray.length}（须为 0）`
      + `｜裁定 B 行 = ${dmB >= 0 ? 'L' + (dmB + 1) : '**未找到**'}`
      + (dmStray.length ? `｜越界行：${dmStray.map((x) => 'L' + (x.i + 1)).join(',')}` : '')
      + `｜**允许项：裁定 B 行内逐字引用 \`docManager\` ⇒ 豁免零命中**（依据：Leader 2026-10-14 裁定 (c) + 规格 §0.2「逐字、不得改写标点」）；`
      + `**例外仅此一处**，且由「行外 = ${dmStray.length}」这一读数独立把守`);

    /* S7-3：`FORBIDDEN_S7` 逐串计数，**允许项按「仅限裁定 X 行内」表达**（行外一律 FAIL） */
    const allowLineOf = { renderer: raA }; // doc-manager 无允许项
    const parts = [];
    let s73Ok = true;
    for (const s of FORBIDDEN_S7) {
      const hs = lines.map((l, i) => ({ l, i })).filter((x) => x.l.includes(s));
      const allow = allowLineOf[s];
      // 判据：**行外命中数必须为 0**（allow 未定义时，任何命中即行外）
      const strayCount = hs.filter((x) => x.i !== allow).length;
      if (strayCount > 0) s73Ok = false;
      parts.push(
        `${s} 命中 = ${hs.length}`
        + (s === 'renderer' ? '（角色名检查，**不查工序动词 render**）' : '（**无允许项**）')
        + `｜行外 = ${strayCount}（须为 0）`
        + (hs.length ? `｜行号 ${hs.map((x) => 'L' + (x.i + 1)).join(',')}` : ''),
      );
    }
    add('S7-3', s73Ok ? PASS : FAIL, parts.join(' ｜ ') + ` ｜裁定 A 行 = ${raA >= 0 ? 'L' + (raA + 1) : '**未找到**'}`);
  }
}

/* ─────────── S3 / S4：公共约束串与指针句（口径见文件头；缺 constitution ⇒ SKIP，**不是 PASS**） ─────────── */
if (constitutionText === null || roleFiles === null) {
  const why = constitutionText === null
    ? `constitution.md 不在场（${CONSTITUTION_PATH}）`
    : `roles 目录不在场（${ROLES_DIR}）`;
  add('S3', SKIP, `SKIP — 无法判定（${why}）；**不等于通过**，待 e2-constitution / e3-roles 产物落盘后重跑`);
  add('S4', SKIP, `SKIP — 无法判定（${why}）；**不等于通过**，待 e2-constitution / e3-roles 产物落盘后重跑`);
} else {
  // 抽取 constitution.md 的**条目标原文**（表格行第 3 列「说明」；去表头/分隔行）
  const clauseTexts = [];
  for (const line of constitutionText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim());
    // 形如 ['', 条目, 类型, 说明, ''] ⇒ cells.length ≥ 4，且类型 ∈ {MUST, SHOULD}
    if (cells.length < 4) continue;
    const type = cells[2];
    if (type !== 'MUST' && type !== 'SHOULD') continue;
    const desc = cells[3];
    if (desc && desc.length >= 8) clauseTexts.push(desc); // 短占位不构成可判模板串
  }
  const uniqClauses = [...new Set(clauseTexts)];
  const compactClauses = uniqClauses.map(strip).filter((s) => s.length >= 8);

  /* S3：roles/*.md 内**逐字内联**任一条目原文 ⇒ 重复 ⇒ FAIL（口径：只收紧不放松） */
  {
    const dup = [];
    if (compactClauses.length === 0) {
      add('S3', SKIP, 'SKIP — constitution.md 内未抽到可判条目原文（表格第 3 列、≥8 字符）；**不等于通过**');
    } else {
      for (const f of roleFiles) {
        const c = readIf(path.join(ROLES_DIR, f));
        if (c === null) continue;
        const cs = strip(c);
        for (const cl of compactClauses) {
          if (cs.includes(cl)) { dup.push(`${f} 内联宪法条目「${cl.slice(0, 24)}…」`); break; }
        }
      }
      add('S3', dup.length === 0 ? PASS : FAIL, dup.length === 0
        ? `roles/*.md 无宪法条目全文内联（比对 ${compactClauses.length} 条模板串 × ${roleFiles.length} 个角色文件）`
        : `重复内联：${dup.join('；')}`);
    }
  }

  /* S4：完整指针句命中 ≤ 0；压缩差异说明 ≤ 2 处 */
  {
    if (compactClauses.length === 0) {
      add('S4', SKIP, 'SKIP — 同 S3：无可判指针/约束模板串；**不等于通过**');
    } else {
      const fullHits = [];
      const compactMarks = [];
      for (const f of roleFiles) {
        const c = readIf(path.join(ROLES_DIR, f));
        if (c === null) continue;
        const cs = strip(c);
        const nFull = compactClauses.filter((cl) => cs.includes(cl)).length;
        if (nFull > 0) fullHits.push(`${f}:${nFull}`);
        // 压缩差异说明：显式短指针标记（带「差异」语义的收敛句）
        if (/协作方式：公共语义单一来源见[^\n]*；本角色差异如下/.test(c)) compactMarks.push(f);
      }
      const ok = fullHits.length === 0 && compactMarks.length <= 2;
      add('S4', ok ? PASS : FAIL,
        `完整指针句（= 宪法条目全文）命中 ${fullHits.length} 个文件（要求 0：${fullHits.join('，') || '无'}）；`
        + `压缩差异说明 ${compactMarks.length} 处（要求 ≤2：${compactMarks.join('，') || '无'}）`);
    }
  }
}

/* ═══════════════════ 汇总输出 ═══════════════════ */
/**
 * 门禁项 = **S1–S7**（规格 §⑦ 的检查项）；**S0 为非门禁项**。
 *   · S0 是**本 lane 主动补的**「文件名大小写纪律」——它守的是**归位可移植性**，
 *     **不属于**规格 §⑦ 的七项判据 ⇒ 若让它参与退出码，就等于**工单外扩了门禁**，
 *     会让「S1–S7 全通过」这一批级结论出现非预期红灯（a1 会把它读成规格不达）。
 *   · 但它**仍必须显式报出**（见 S0 detail）——「非门禁」不等于「不说」：
 *     报出后由 Leader/audit 决定是否在归位前订正。
 *   ⇒ 退出码口径：**S1–S7 全 PASS/SKIP ⇒ 0；S1–S7 任一 FAIL ⇒ 1**（与规格 §⑦ 逐字一致）。
 */
const GATING_IDS = new Set(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7-1', 'S7-2', 'S7-3']);
const gating = results.filter((r) => GATING_IDS.has(r.id));
const gatingFails = gating.filter((r) => r.state === FAIL);
const nonGatingFails = results.filter((r) => !GATING_IDS.has(r.id) && r.state === FAIL);
const passes = results.filter((r) => r.state === PASS);
const skips = results.filter((r) => r.state === SKIP);

console.log('=== check-video-team-density (S1–S7) ===');
console.log(`root = ${root}  （${how}）`);
console.log(`布局 = SKILL:${LAYOUT.skill.rel} ｜ constitution:${LAYOUT.constitution.rel} ｜ roles:${LAYOUT.roles.rel}`);
for (const r of results) {
  console.log(`${r.state.padEnd(4)}  ${r.id}  ${r.detail}`);
}
console.log(`--- 门禁项（S1–S7）：${gating.length - gatingFails.length}/${gating.length} 通过 ⇒ exit ${gatingFails.length === 0 ? 0 : 1} ---`);
console.log(`--- 全项：${passes.length} PASS / ${results.filter((r) => r.state === FAIL).length} FAIL / ${skips.length} SKIP （共 ${results.length} 项）---`);
if (nonGatingFails.length > 0) {
  console.log(`⚠ 非门禁项 FAIL（**不影响退出码**，须人工裁决是否归位前订正）：${nonGatingFails.map((r) => r.id).join(', ')}`);
}
if (skips.length > 0) {
  console.log(`⚠ SKIP 项不计入通过，也不参与退出码：${skips.map((s) => s.id).join(', ')}（缺件，须补件后重跑）`);
}
process.exit(gatingFails.length === 0 ? 0 : 1);
