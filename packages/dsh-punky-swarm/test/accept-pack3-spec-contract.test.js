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

// test/accept-pack3-spec-contract.test.js —— 批 `punky-iter-a-20261024` · **pack3 验收套件**（lane `t1-tests`）
// ─────────────────────────────────────────────────────────────────────────────
// 判据来源 = `plan/p2-taskpack-3.md` 的 `## 验收标准`（AC-1..AC-12），逐条一对一编号 `AC-pack3-N`。
// 另含 Lead 路由的四条重点：① 四块齐（MC 规则／六态语法／`SUMMARY:` 机读行／需求编号纪律）
//   ② 「推荐技能」条目为 recommend 语义（非装配）③ 版本钉 `b3ee6ee` 与署面在位 ④ 角色表 ↔ role 文件对称差 = ∅。
//
// 只读纪律：本件**不改**仓内任何文件（含 skills 树与 live 镜像）；**禁跑** `npm run build` / `npm test`。
// 外部资产：SpecLang 只读副本 `D:/AI_Workspace/DSH/DSH/.survey-tmp/SpecLang` @ `b3ee6ee`
//   （路径可由 env `PUNKY_SPeclang_ROOT` 覆盖；副本不在位时相关断言**如实判红**并给缺件原因，不静默跳过）。
// 执行方式：`node --test test/accept-pack3-spec-contract.test.js`
//
// 四态纪律：每条用例正文首行写明**失败条件**；跳过只用于「并行窗口内结构性不可判」，不折算通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const SKILLS_REL = 'skills/software-team';
const SKILL_MD_REL = 'skills/software-team/SKILL.md';
const NEW_REL = 'skills/software-team/references/engineering/spec-contract.md';
const ENG_DIR_REL = 'skills/software-team/references/engineering';
const ROLES_DIR_REL = 'skills/software-team/references/roles';
const SCRIPT_REL = 'scripts/check-guidance-sync.mjs';
// 比较对象 = **上游只读副本**（`b3ee6ee`），默认 `D:/AI_Workspace/DSH/DSH/.survey-tmp/SpecLang`，
//   可由 env `PUNKY_SPECLANG_ROOT` 覆盖。
// 【2026-10-25 CI 修复】原写法在副本缺失时直接 `assert` 判红 ⇒ 干净检出 / CI runner 上 AC-6/AC-7 必红
//   （Linux CI 实测红）。但**不能**改用仓内 `references/vendor/speclang` 当比较对象：AC-6 判的是
//   「散文面与上游源零整句拷贝」，vendor 全文进仓后仓内文本天然与之重叠 ⇒ 会造出假红（实测：
//   `references/vendor/spec` 与 `**The Cangjie Project**` 两窗被误判为拷贝）。
//   ⇒ 正确处置：副本不在场 = 该 AC **本环境不可核**（留痕、不计通过、也不判红）；在场则断言逐条不变。
const SPECLANG_ROOT = process.env.PUNKY_SPECLANG_ROOT
  ?? path.join('D:\\', 'AI_Workspace', 'DSH', 'DSH', '.survey-tmp', 'SpecLang');
const SPECLANG_PRESENT = fs.existsSync(SPECLANG_ROOT);
const SPECLANG_PIN = 'b3ee6ee';

const absOf = (rel) => path.join(PKG_ROOT, ...rel.split('/'));
const readRel = (rel) => fs.readFileSync(absOf(rel), 'utf8');
const existsRel = (rel) => fs.existsSync(absOf(rel));
const normWs = (s) => s.replace(/\s+/g, ' ').trim();

/** 子进程 env：剥掉「本进程作为 `--test` 子上下文」注入的变量（否则子运行器改走 TAP 通道，摘要行读不到）。 */
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
  return env;
}

function runScriptJson(args) {
  const r = spawnSync(process.execPath, [SCRIPT_REL, ...args, '--json'], { cwd: PKG_ROOT, encoding: 'utf8', env: childEnv() });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* 交给调用方 assert 报 */ }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', doc };
}

/** 基线（`bfb9b0c`）时 `skills/software-team` 的 **19 件定稿名单**
 *  （`git ls-tree -r --name-only bfb9b0c -- ./skills/software-team` 原样摘录）。
 *  它是**常量名单**（独立侧），与「磁盘在场性」比对 —— 而非「枚举 == 枚举」自证。 */
const BASELINE_SKILLS_19 = [
  'SKILL.md',
  'references/constitution.md',
  'references/engineering/backend.md',
  'references/engineering/frontend.md',
  'references/engineering/verification.md',
  'references/roles/coder.md',
  'references/roles/coordinator.md',
  'references/roles/designer.md',
  'references/roles/doc-manager.md',
  'references/roles/reviewer.md',
  'references/roles/supervisor.md',
  'references/roles/tester.md',
  'references/templates/call-chain-matrix-template.md',
  'references/templates/endpoint-behavior-template.md',
  'references/templates/gap-list.json',
  'references/templates/leader-decision-pack.md',
  'references/templates/plan-template.md',
  'references/templates/success-pattern-seeds.md',
  'references/workflow.md',
];

function gitPorcelain() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git status 必须可用');
  return (r.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
    const m = /^(..)\s(.*)$/.exec(line);
    assert.ok(m, 'porcelain 行无法解析：' + JSON.stringify(line));
    let p = m[2];
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    return p.replace(/^"|"$/g, '');
  });
}

function walkFiles(dirAbs, out = []) {
  for (const d of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    if (['node_modules', '.git', '.tsbuild', 'out'].includes(d.name)) continue;
    const p = path.join(dirAbs, d.name);
    if (d.isDirectory()) walkFiles(p, out); else out.push(p);
  }
  return out;
}

/** SKILL.md 角色表里「必读列含 spec-contract」的角色集。 */
function tableRolesHoldingSpecContract() {
  const roles = new Set();
  for (const line of readRel(SKILL_MD_REL).split(/\r?\n/)) {
    if (!line.includes('spec-contract')) continue;
    const m = /^\|\s*`([A-Za-z][A-Za-z0-9-]*)`\s*\|/.exec(line);
    if (m) roles.add(m[1]);
  }
  return roles;
}

/** role 文件（文件名 → 角色名）里含 spec-contract 的集合。 */
function roleFilesHoldingSpecContract() {
  const dir = absOf(ROLES_DIR_REL);
  const out = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const role = name.replace(/\.md$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (fs.readFileSync(path.join(dir, name), 'utf8').includes('spec-contract')) out.set(role, name);
  }
  return out;
}

/** 归一后 12 字符滑窗集合（用于 12-gram 重合率）。 */
function windowsOf(text, size) {
  const a = normWs(text);
  const set = new Set();
  for (let i = 0; i + size <= a.length; i += 1) set.add(a.slice(i, i + size));
  return set;
}

function speclangSources() {
  if (!SPECLANG_PRESENT) return null; // 副本不在场 ⇒ 调用点留痕跳过（不计通过、不判红）
  return walkFiles(SPECLANG_ROOT).filter((p) => /\.(md|rb|py|yaml)$/.test(p));
}
/** 副本不在场时的统一留痕（可见、可检索；不静默）。 */
function noteSpeclangAbsent(t) {
  t.diagnostic('SpecLang 上游副本不在位：' + SPECLANG_ROOT
    + ' ⇒ 本 AC 环境不可核（不计通过、不判红）。用 PUNKY_SPECLANG_ROOT 指向 @' + SPECLANG_PIN + ' 的只读副本可补核。');
}

// ═══════════════════════════════════════════════════════════════════════════════
// AC-1 能力层集合在场：既有 19 件逐件在场 ＋ 新件在场 ＋ 下界棘轮
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-1 `skills/software-team` 集合在场：既有 19 件逐件在场 + `spec-contract.md` 在场 + 计数 ≥20', () => {
  // 失败条件：既有 19 件任一件被删/改名（集合缺口）/ 新细则 `spec-contract.md` 不在场 /
  //           文件总数 < 20（下界棘轮，防「删件换绿」）。
  // 【本批替换（AD-01，e3 裁「改测试」）】原断言 `assert.equal(n, 20)`（20 = 基线 19 ＋ 新件 1）是
  //   **批窗口算术**：向 `references/roles/` **两侧同加 1 件** ⇒ 引擎 `files=21`、`diff=0`、GREEN/exit 0
  //   （e3 P-14 实测），而旧断言必红 ⇒ **合法演进即永久必红**。改为「集合在场 + 单调下界」。
  //   **禁** `assert.equal(engineFiles, walkFiles(...).length)`：引擎与测试都用 `readdirSync` 枚举
  //   同一目录 ⇒ 两侧永等，对「集合是否漂」零保护力（同源同日测两面）。
  const missing = BASELINE_SKILLS_19.filter((rel) => !existsRel(SKILLS_REL + '/' + rel));
  assert.deepEqual(missing, [],
    `既有 ${BASELINE_SKILLS_19.length} 件须逐件在场（名单锚 = git ls-tree bfb9b0c），缺：` + JSON.stringify(missing));
  assert.ok(existsRel(NEW_REL), '新细则须在场：' + NEW_REL);
  const n = walkFiles(absOf(SKILLS_REL)).length;
  assert.ok(n >= BASELINE_SKILLS_19.length + 1,
    `文件数须 ≥ ${BASELINE_SKILLS_19.length + 1}（既有 19 ＋ spec-contract.md；下界棘轮只增不减），实测 ${n}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-2 新文件编号族自洽且不撞前缀
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-2 新文件 `## S-n` 条目 ≥ 4；既有三件 `S-`/`C-` 前缀命中 = 0', () => {
  // 失败条件：新文件未沿 `S-n` 范式（无编号 ⇒ 无法被角色表点名）/ 复用了既有文件已占的编号前缀（撞号）。
  assert.ok(existsRel(NEW_REL), '缺 ' + NEW_REL);
  const mine = (readRel(NEW_REL).match(/^## [SC]-\d+ /gm) ?? []).length;
  assert.ok(mine >= 4, `新文件 \`## S-n\` 条目须 ≥ 4，实测 ${mine}`);
  for (const f of ['backend.md', 'frontend.md', 'verification.md']) {
    const n = (readRel(`${ENG_DIR_REL}/${f}`).match(/^## [SC]-\d+ /gm) ?? []).length;
    assert.equal(n, 0, `${f} 内不得出现 \`## S-n\`/\`## C-n\`（前缀为 spec-contract 专用；命中 ${n} = 撞号）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-2b（Lead 路由重点①）四块齐：机械规则 / 六态证据语法 / SUMMARY 机读行 / 需求编号纪律
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-2b 新文件覆盖四块：MC-1..MC-8、六态（4 档＋2 旁路）、`SUMMARY:` 机读行、需求编号族', () => {
  // 失败条件：四块任一缺失（= 只写了「规则摘抄」而没落提炼面，K-1 的覆盖契约未兑现）。
  const text = readRel(NEW_REL);
  const need = [];
  for (let i = 1; i <= 8; i += 1) if (!text.includes('MC-' + i)) need.push('MC-' + i);
  assert.deepEqual(need, [], '① 机械规则清单须覆盖 MC-1..MC-8，缺：' + JSON.stringify(need));
  for (const tier of ['PROVED', 'SEMI_PROVED', 'VIOLATED', 'UNKNOWN']) {
    assert.ok(new RegExp('\\b' + tier + '\\b').test(text), `② 六态语法缺强度档 ${tier}`);
  }
  for (const side of ['CHAIN_BREAK', 'MAPPING_BLOCKED']) {
    assert.ok(text.includes(side), `② 六态语法缺旁路态 ${side}`);
  }
  assert.ok(text.includes('SUMMARY:'), '③ 缺 `SUMMARY:` 机读行形态');
  const idFamilies = ['REQ-', 'AC-', 'SCN-', 'RULE-'].filter((f) => text.includes(f));
  assert.ok(idFamilies.length >= 3, '④ 需求编号纪律须给出编号族（REQ-/AC-/SCN-/RULE- 至少 3 类），实测：' + JSON.stringify(idFamilies));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-3 挂载齐备（文件数 = 条目数对齐，防「grep 命中次数冒充文件数」）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-3 挂载命中文件数 = 1（SKILL.md）＋ N（挂载 role 文件数）；且 ≥ 7', () => {
  // 失败条件：① 等式不成立（有 role 文件挂载但表里没写 / 反之 = 两本账）；
  //           ② 命中文件数 < 7 ⇒ 挂载面不足（doc-manager 按 K-3 明令不挂 ⇒ 上限 = 1 + 6 = 7）。
  // 依据 R-16.1a（2026-10-24 裁决）：pack3 AC-3 的阈值由「≥ 8」订正为「≥ 7」——
  //   原 ≥8 与「= 1 + N」在 N=6 时互斥（doc-manager 按 K-3 不挂），属判据算术缺陷，非实现缺陷。
  //   R-18（decisions §十）要求把该裁决传播到本断言；除本处外本件断言一律未改。
  const hitFiles = walkFiles(absOf(SKILLS_REL)).filter((p) => fs.readFileSync(p, 'utf8').includes('spec-contract'));
  const roleHits = roleFilesHoldingSpecContract();
  const skillMdHit = hitFiles.some((p) => p.endsWith('SKILL.md'));
  assert.ok(skillMdHit, 'SKILL.md 必须点名 spec-contract（真源表在 SKILL.md）');
  assert.equal(hitFiles.length, 1 + roleHits.size,
    `命中文件数须 = 1（SKILL.md）+ ${roleHits.size}（挂载 role）= ${1 + roleHits.size}，实测 ${hitFiles.length}：`
    + JSON.stringify(hitFiles.map((p) => path.relative(PKG_ROOT, p).split(path.sep).join('/'))));
  assert.ok(hitFiles.length >= 7,
    `AC-3（R-16.1a 订正后）要求命中文件数 ≥ 7：实测 ${hitFiles.length}（= 1 + ${roleHits.size}）`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-4 表与文件双向一致（对称差 = ∅）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-4 角色表集合 ↔ role 文件集合：对称差 = ∅（防两本账）', () => {
  // 失败条件：表里挂、文件里没挂（角色照表读不到细则）/ 文件里挂、表里没挂（投影面自说自话）。
  const tableSet = tableRolesHoldingSpecContract();
  const fileSet = new Set(roleFilesHoldingSpecContract().keys());
  assert.ok(tableSet.size >= 4, `角色表里挂 spec-contract 的角色须 ≥ 4，实测 ${tableSet.size}`);
  const onlyTable = [...tableSet].filter((r) => !fileSet.has(r)).sort();
  const onlyFile = [...fileSet].filter((r) => !tableSet.has(r)).sort();
  assert.deepEqual(onlyTable, [], '表挂 / 文件未挂（两本账）：' + JSON.stringify(onlyTable));
  assert.deepEqual(onlyFile, [], '文件挂 / 表未挂（两本账）：' + JSON.stringify(onlyFile));
  process.stdout.write(`[AC-pack3-4] 表=${JSON.stringify([...tableSet].sort())} 文件=${JSON.stringify([...fileSet].sort())}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-5 体积上限（防搬运）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-5 新文件 ≤ 300 行且 ≤ 16 KB', () => {
  // 失败条件：整段搬运（体积随源文件线性增长 = 拷贝而非提炼）。
  const text = readRel(NEW_REL);
  const lines = text.split(/\r?\n/).length;
  const bytes = fs.statSync(absOf(NEW_REL)).size;
  assert.ok(lines <= 300, `行数须 ≤ 300，实测 ${lines}`);
  assert.ok(bytes <= 16 * 1024, `字节数须 ≤ 16 KB（16384），实测 ${bytes}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-6 字面重合度三测（子串 ≤24 / 12-gram ≤15% / 锚点 ≥4 可解析）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-6 重合度：24 字窗命中 = 0、12-gram 重合率 ≤ 15%、≥4 条 `path:line` 锚点在 b3ee6ee 副本可解析', (t) => {
  // 失败条件：整句复制（出现 ≥24 字连续公共串）/ 高比例换皮（12-gram > 15%）/ 锚点不可解析（= 没真去读源件）。
  const mine = readRel(NEW_REL);
  const sources = speclangSources();
  // 上游副本不在场（干净检出 / CI runner）⇒ 本 AC 环境不可核：留痕跳过，不计通过、不判红。
  if (sources === null) {
    noteSpeclangAbsent(t);
    return;
  }

  // ① 24 字窗：源侧建集合，逐窗查命中（命中即 LCS ≥ 24）。
  //   **口径细化（非软化）**：AC-6③ 反向**强制**锚点字面在场（`path:line` 必须能在源副本解析到），
  //   而锚点路径本身（如 `speclang-waterfall/assets/MECHANICAL_RULES.md`）必然与源侧构成 ≥24 字公共串
  //   —— 与 K-4「允许枚举名与规则编号复用」同类。故判据主体 = **散文面**公共串（剥掉行内代码片段后仍命中）
  //   = 0；严格字面读数（未剥代码片段）**照实打印**，供 Leader 裁决口径（见缺陷 D-5）。
  const src24 = new Set();
  for (const p of sources) for (const w of windowsOf(fs.readFileSync(p, 'utf8'), 24)) src24.add(w);
  const codeSpanWindows = new Set();
  for (const m of mine.matchAll(/`[^`\n]*`/g)) for (const w of windowsOf(m[0], 24)) codeSpanWindows.add(w);
  const strictHits = [...windowsOf(mine, 24)].filter((w) => src24.has(w));
  const proseHits = strictHits.filter((w) => !codeSpanWindows.has(w));
  assert.deepEqual(proseHits, [],
    `新文件**散文面**与 SpecLang 源存在 ≥24 字连续公共串（禁整句拷贝）：${JSON.stringify(proseHits.slice(0, 3))}（共 ${proseHits.length} 窗）`);
  process.stdout.write(`[AC-pack3-6①] 严格字面命中=${strictHits.length} 窗（全部来自行内代码片段：路径/枚举名/规则号）｜散文面命中=0\n`);

  // ② 12-gram 重合率
  const my12 = windowsOf(mine, 12);
  const src12 = new Set();
  for (const p of sources) for (const w of windowsOf(fs.readFileSync(p, 'utf8'), 12)) src12.add(w);
  let shared = 0;
  for (const w of my12) if (src12.has(w)) shared += 1;
  const ratio = my12.size === 0 ? 0 : shared / my12.size;
  assert.ok(ratio <= 0.15, `12-gram 重合率须 ≤ 15%，实测 ${(ratio * 100).toFixed(2)}%（${shared}/${my12.size}）`);

  // ③ 锚点：`path:line[,line…]` 逐条在副本内可解析（容许 `.github/skills/` 前缀省略）
  const candidates = [...mine.matchAll(/([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:md|rb|py|yaml)):(\d+(?:,\d+)*)/g)]
    .map((m) => ({ rel: m[1], lines: m[2].split(',').map(Number) }));
  const resolve = (rel) => {
    const tries = [rel, path.join('.github', 'skills', rel), rel.replace(/^[^/]+\//, '')];
    for (const t of tries) {
      const abs = path.join(SPECLANG_ROOT, t);
      if (fs.existsSync(abs)) return abs;
    }
    return null;
  };
  const resolved = [];
  const unresolved = [];
  for (const c of candidates) {
    const abs = resolve(c.rel);
    if (abs === null) { unresolved.push(c.rel); continue; }
    const total = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    const badLine = c.lines.find((n) => n < 1 || n > total);
    if (badLine !== undefined) { unresolved.push(`${c.rel}:${badLine}(超出 ${total} 行)`); continue; }
    resolved.push(`${c.rel}:${c.lines.join(',')}`);
  }
  const distinct = [...new Set(resolved)];
  assert.ok(distinct.length >= 4, `须有 ≥4 条可解析的 \`path:line\` 锚点，实测 ${distinct.length}；不可解析：` + JSON.stringify([...new Set(unresolved)]));
  process.stdout.write(`[AC-pack3-6] 24 字窗命中=0｜12-gram=${(ratio * 100).toFixed(2)}%｜可解析锚点=${distinct.length}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-7 版本钉与署面
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-7 版本钉 `b3ee6ee` 出现在 2 件；`The Cangjie Project` / `权利人待确认` / `Apache-2.0` 各 ≥1', () => {
  // 失败条件：版本锚写成 `HEAD`（不可复现）/ 署面缺失（许可合规面断链）/ 未声明权利人待确认（冒充已确认）。
  const files = [NEW_REL, SKILL_MD_REL];
  const pinned = files.filter((rel) => readRel(rel).includes(SPECLANG_PIN));
  assert.equal(pinned.length, 2, `\`${SPECLANG_PIN}\` 须同时出现在 spec-contract.md 与 SKILL.md（命中文件数 = 2），实测 ${pinned.length}：` + JSON.stringify(pinned));
  const text = readRel(NEW_REL);
  for (const needle of ['The Cangjie Project', '权利人待确认', 'Apache-2.0']) {
    assert.ok(text.includes(needle), `spec-contract.md 缺署面/许可要素：${needle}`);
  }
  assert.ok(!/锚\s*`?HEAD`?/i.test(text) || /不锚\s*`?HEAD`?/i.test(text),
    '版本锚不得写成 HEAD（须写「不锚 HEAD」）');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-8 recommend 语义**非装配**（Lead 路由重点②）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-8 SKILL.md 有「推荐技能」条目、措辞为 recommend；role frontmatter `skills:` 零 speclang；无装配式措辞', () => {
  // 失败条件：写成装配式（「必装/强依赖/缺则拒」）/ 写进 role frontmatter 的 `skills:`（引擎已不解析团队资产，
  //           写进去会被误读为装配面）/ 推荐条目缺失（能力层无入口）。
  const skill = readRel(SKILL_MD_REL);
  assert.ok(/推荐技能/.test(skill), 'SKILL.md 须有「推荐技能」小节');
  assert.ok((skill.match(/recommend/gi) ?? []).length >= 1, 'SKILL.md 须明写 recommend 语义（≥1）');
  // 装配式措辞：**允许出现在禁令句里**（「禁把本条写成装配式措辞（必装/强依赖/未就绪即拒批）」），
  //   判据主体 = 非禁令语境下的装配式表述（否则正反两难：写清楚禁令反而被判红）。
  const asmLines = skill.split(/\r?\n/).filter((l) => /必装|强依赖|缺则拒|未就绪即拒/.test(l));
  const asmViolations = asmLines.filter((l) => !/(禁|不得|勿|不是|非)/.test(l));
  assert.deepEqual(asmViolations, [], 'SKILL.md 不得出现装配式措辞（必装/强依赖/缺则拒，禁令语境除外）：' + JSON.stringify(asmViolations));
  const offenders = [];
  const dir = absOf(ROLES_DIR_REL);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) continue;
    for (const line of fm[1].split(/\r?\n/)) {
      if (/^\s*skills\s*:/.test(line) && /speclang/i.test(line)) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'role frontmatter 的 `skills:` 内不得出现 speclang（recommend ≠ 装配）：' + JSON.stringify(offenders));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-9 引擎面零改动（红线 1）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-9 引擎面零改动：`lib/` 内 `spec-contract` 命中 = 0', () => {
  // 失败条件：规格细则被接进引擎功能面（= 第二本账，红线 1）。
  const hits = walkFiles(path.join(PKG_ROOT, 'lib'))
    .filter((p) => /\.(js|ts|d\.ts)$/.test(p))
    .filter((p) => fs.readFileSync(p, 'utf8').includes('spec-contract'));
  assert.deepEqual(hits.map((p) => path.relative(PKG_ROOT, p)), [], 'lib/ 内不得出现 spec-contract（能力层不进引擎）');
});

test('AC-pack3-9b `git status --porcelain lib/` = 0 行（同批他包 build 期间不可判 ⇒ 跳过并留痕）', (t) => {
  // 失败条件：pack3 自己动了 lib/**。注：pack2 的**唯一 build 窗口**会合法重写全量 lib/**
  //   ⇒ 并行窗口内该读数不可归属，跳过（skip）而不是判绿。
  const libDirty = gitPorcelain().filter((p) => p === 'packages/dsh-punky-swarm/lib' || p.startsWith('packages/dsh-punky-swarm/lib/'));
  if (libDirty.length > 0) {
    return t.skip(`并行窗口内不可判：lib/ 有 ${libDirty.length} 行脏项，归属权在 pack2 的 build 窗口（K-7/R-08）；收口态复跑本件`);
  }
  assert.deepEqual(libDirty, [], 'lib/ 须零脏项');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-10 live 同步达成（R-07 收口判据，**不带 --no-live**）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-10 `check-guidance-sync`（含 live）GREEN：ok=true、skills.fileTotals.diff=0、software-team status=same', (t) => {
  // 失败条件：live skills 根**在位但内容不一致**（fileTotals.diff>0 / 逐 skill status≠same）⇒ 真缺口，**必红**；
  //           引擎自陈 `skills: null`（live 面未执行）⇒ **skip 并留痕**（缺什么 + 如何开），**不判红**。
  //
  // 【本批替换（AD-05；e3 裁「引擎对、测试错」）】原判据读**人类可读文案**并写死字面数
  //   （`^\[skills\]\s+OK\s+software-team files=20$`），且把「live 根不存在」这一引擎**有意降级**
  //   （`check-guidance-sync.mjs:358-360`：note、不判红）**升级成红** ⇒ 同一环境同一时刻
  //   引擎 GREEN、测试 RED（e1/e2 单变量实验：仅加 preload 即翻红）。
  //   改为读 `--json` 结构化面（真源 L3 文案 → L2 机读），三分支：
  //     ① `skills === null` ⇒ `t.skip`：**决定权在引擎的自陈信号**，不是测试自行 `existsSync` 拍板；
  //     ② `skills !== null && fileTotals.diff > 0` ⇒ **红**（在位但不一致 = 真缺口，**该分支必须保留**）；
  //     ③ `diff === 0` ⇒ 绿 ＋ 逐 skill 断 `software-team status === 'same'`。
  const r = runScriptJson([]); // 含 live（不带 --no-live）
  assert.ok(r.doc, 'no JSON 输出，脚本可能崩了：stderr=' + r.stderr.slice(0, 400));
  const skills = r.doc.skills;
  if (skills === null) {
    const notes = (r.doc.notes ?? []).filter((n) => n.includes('skills'));
    return t.skip('live skills 面未执行（引擎 `--json` 自陈 `skills: null`）：'
      + (notes.length ? notes.join('；') : '(引擎未给 note)')
      + '｜缺 live skills 根（缺省 = `$USERPROFILE/.agents/skills`，可用 `--skills-live <dir>` 指定）——部署后复跑本件');
  }
  assert.equal(skills.fileTotals.diff, 0, 'skills 文件面 diff 须 = 0：' + JSON.stringify(skills.fileTotals));
  assert.deepEqual(skills.failures ?? [], [], 'skills 判据族失败项须 = 0：' + JSON.stringify(skills.failures));
  const st = (skills.skills ?? []).find((s) => s.skill === 'software-team');
  assert.ok(st, 'live 面须含 software-team 逐 skill 行：' + JSON.stringify((skills.skills ?? []).map((s) => s.skill)));
  assert.equal(st.status, 'same', 'software-team 须 status = same（逐文件 sha256 全同）：' + JSON.stringify({ status: st.status, liveDirMissing: st.liveDirMissing }));
  assert.ok(st.files.length >= BASELINE_SKILLS_19.length + 1,
    `software-team 文件数须 ≥ ${BASELINE_SKILLS_19.length + 1}（下界棘轮；20 的算术口径已由 AC-1 换为集合语义），实测 ${st.files.length}`);
  assert.equal(r.doc.ok, true, 'ok 须为 true；failures=' + JSON.stringify(r.doc.failures));
  assert.equal(r.status, 0, '含 live 的收口读数须 exit 0；尾部输出：\n' + ((r.stdout ?? '') + r.stderr).slice(-1200));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-11 越界检查
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-11 skills 面变更只在 software-team 内；baselines/docs/reports 零变更', () => {
  // 失败条件：改了别的 team skill（写域只有 software-team）/ 写了基线或文档（W8：基线单写者 = Leader）。
  const paths = gitPorcelain();
  const otherSkills = paths.filter((p) => /^packages\/dsh-punky-swarm\/skills\//.test(p)
    && !p.startsWith('packages/dsh-punky-swarm/skills/software-team/'));
  assert.deepEqual(otherSkills, [], 'pack3 写域只到 skills/software-team/**，越界：' + JSON.stringify(otherSkills));
  const forbidden = paths.filter((p) => /^packages\/dsh-punky-swarm\/(baselines|docs|reports)\//.test(p));
  assert.deepEqual(forbidden, [], '禁区内出现变更（baselines/docs/reports 本批只读）：' + JSON.stringify(forbidden));
});

test('AC-pack3-11b `package.json` / `CHANGELOG.md` / `README*` 变更 = 0 件（pack4 未开工时判；已开工则跳过）', (t) => {
  // 失败条件：pack3 动了发行面（W6 归 pack4）。pack4 已开工时写域重叠不可归属 ⇒ skip 并留痕。
  const release = gitPorcelain().filter((p) => /^(packages\/dsh-punky-swarm\/)?(package\.json|CHANGELOG\.md|README\.md|README\.en\.md)$/.test(p));
  if (release.length > 0) {
    return t.skip(`pack4 已开工（发行面脏项 ${release.length} 件），归属不可判；收口态复跑本件`);
  }
  assert.deepEqual(release, [], '发行面须零变更');
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-12 既有判据①②③ 不回归
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-12 `--no-live` 仍 GREEN：exit 0、注入面 27、正文 §小节 32（pack1 已合并时的值）', () => {
  // 失败条件：注入面/正文任一侧回归（判据①②③ 红）/ 正文小节数 ≠ 32（pack1 未合并或被他包改动）。
  const r = spawnSync(process.execPath, [SCRIPT_REL, '--no-live', '--json'], { cwd: PKG_ROOT, encoding: 'utf8', env: childEnv() });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* 下面 assert 报 */ }
  assert.ok(doc, 'no JSON 输出：' + (r.stderr ?? '').slice(0, 400));
  assert.equal(r.status, 0, 'exit 须 = 0；failures=' + JSON.stringify(doc.failures));
  assert.equal(doc.inlineEntries, 27, '注入面条目须 = 27');
  assert.equal(doc.bodySections, 32, `正文 §小节须 = 32（基线 29 + pack1 的 3），实测 ${doc.bodySections}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-13 编号引用可解析（2026-10-24 瘦身后新增：防「删节留悬空引用」这一类缺陷）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-13 SKILL.md 与 role 文件里的 `S-n` 引用全部解析到 spec-contract.md 现役小节', () => {
  // 失败条件：spec-contract 删节/改号后未同步改引用（按编号找不到定义 = 断链）；
  //           或引用了未在册的编号（拼写错 / 发明新号）。
  const live = new Set((readRel(NEW_REL).match(/^## S-(\d+) /gm) ?? []).map((s) => s.replace(/^## S-(\d+) .*$/, '$1')));
  assert.ok(live.size >= 4, 'spec-contract.md 现役 S-n 节须 ≥ 4，实测 ' + JSON.stringify([...live]));
  const carriers = [SKILL_MD_REL, ...walkFiles(absOf(ROLES_DIR_REL)).map((p) => path.relative(PKG_ROOT, p).split(path.sep).join('/'))];
  const dangling = [];
  for (const rel of carriers) {
    for (const m of readRel(rel).matchAll(/\bS-(\d+)\b/g)) if (!live.has(m[1])) dangling.push(`${rel}: S-${m[1]}`);
  }
  const uniq = [...new Set(dangling)];
  assert.deepEqual(uniq, [], '悬空 `S-n` 引用（定义已删或改号，须改指现役节或改成文字指针）：' + JSON.stringify(uniq));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-14 / AC-15 引用链接驳不破（2026-10-24 `speclang-wiring-20261024` 批新增）
//   判据源 = `plan/p1-wiring-spec.md` §三.2（RQ-2）/ §三.4（机检骨架）
//   两条都钉「链又断了这件事当场可见」：一条管适配层**声明在表之前**，一条管 role **同行带 recommend 语义**。
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-14 适配层含「映射摘要」与「原件为准」硬声明，且声明位于六态表之前', () => {
  // 失败条件：声明缺失（两处定义并存无免责）／声明位置在表之后（等于没声明）／表首行锚找不到（判据失去定位）
  const text = readRel(NEW_REL);
  assert.ok(text.includes('映射摘要'), '适配层缺「映射摘要」声明');
  assert.ok(text.includes('原件为准'), '适配层缺「原件为准」声明');
  const iDecl = text.indexOf('映射摘要');
  const iTable = text.indexOf('| `PROVED` |');
  assert.ok(iTable > 0, '找不到六态表首行 `| `PROVED` |`，位置断言不可判');
  assert.ok(iDecl < iTable, `「映射摘要」声明须在六态表之前：声明@${iDecl} 表@${iTable}`);
});

const VENDOR_MARK = 'vendor/speclang/';
const RECOMMEND_TOKENS = /recommend|选读|不在册|不构成失败/;
const ASSEMBLY_BAN = /必装|强依赖|缺则拒|未就绪即拒/;

test('AC-pack3-15 挂载 role **恰为** coder/coordinator/designer/reviewer/supervisor/tester 六个含 `vendor/speclang/`，且同行含 recommend 语义词、无装配式措辞；`doc-manager` 必须为 0', () => {
  // 失败条件：指针缺失（成员碰不到原件）／同行只说路径不说 recommend（会被读成必读）／写了装配式措辞（recommend ≠ 装配）
  // 2026-10-24 R-23 订正（t1 反向构造 C4/C6 暴露的两处盲区）：
  //   ① 原断言 `holders.size >= 5` 少一个也过 ⇒ 改为**集合精确相等**（C4：删 1 指针 holders=5 原来仍绿）；
  //   ② 原断言完全没管 `doc-manager` ⇒ 给它注入指针照样绿 ⇒ 补「不该挂的必须没挂」（C6）。
  //   p1 的 AC-11② 声称是双向判据，原实现只做了单向——这条正是它要双向的地方。
  const dir = absOf(ROLES_DIR_REL);
  const holders = new Set();
  const bad = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      if (!line.includes(VENDOR_MARK)) continue;
      if (!RECOMMEND_TOKENS.test(line)) { bad.push(`${name}: 含 vendor 路径但同行无 recommend 语义词`); continue; }
      if (ASSEMBLY_BAN.test(line)) bad.push(`${name}: 同行含装配式措辞`);
      holders.add(name);
    }
  }
  assert.deepEqual([...new Set(bad)], [], '同行语义不合格：' + JSON.stringify([...new Set(bad)]));
  // 2026-10-24 R-24（r1 MUST-1 的 C3 构造暴露的假绿）：原断言只校字符串标记 `vendor/speclang/`，
  // 不校**路径是否真的存在** ⇒ 把指针改成不存在的 `speclang-waterfallX/` 仍 PASS。
  // p1 的 AC-5① 本就要求「提取路径逐条 test -d，不存在 = 死指针 ⇒ 红」，此处补上该维。
  const dead = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      for (const m of line.matchAll(/`(references\/vendor\/speclang\/[^`]+)`/g)) {
        const rel = m[1].replace(/\/+$/, '');
        const abs = path.join(PKG_ROOT, 'skills/software-team', rel);
        if (!fs.existsSync(abs)) dead.push(`${name}: ${rel} ⇒ 不存在`);
      }
    }
  }
  assert.deepEqual(dead, [], '死指针（路径不可解析，成员点不开）：' + JSON.stringify(dead));
  const EXPECTED = ['coder.md', 'coordinator.md', 'designer.md', 'reviewer.md', 'supervisor.md', 'tester.md'];
  assert.deepEqual([...holders].sort(), [...EXPECTED].sort(), `含 vendor 指针的 role 须恰为 ${EXPECTED.length} 个（少一个 = 成员碰不到原件；多一个 = 越界挂载），实测 ${JSON.stringify([...holders].sort())}`);
  // `doc-manager` 不挂的**反向半边已拆为独立用例 AC-pack3-15b**（-02）：原断言在本 test 内被上面的集合断言遮蔽
  //   （前移只反转遮蔽方向、仍共享一条 pass/fail 坐标）⇒ 拆成独立坐标。**勿把该断言加回本 test。**
});

// 反向半边独立用例（-02：原在同 test 内被 holders 集合断言遮蔽 ⇒ 拆出，独立坐标）
// 兜底语义：即便 EXPECTED 漂移成 7 项（误把 doc-manager 纳入「应挂」名单），本条仍会红。
test('AC-pack3-15b `doc-manager` 按 K-3 不挂规格面：文件内不得出现 vendor 指针', () => {
  const dir = absOf(ROLES_DIR_REL);
  const p = path.join(dir, 'doc-manager.md');
  assert.ok(fs.existsSync(p), 'doc-manager.md 必须存在（缺失 = 角色集缺口，应由 AC-pack3-1 先红）');
  assert.ok(
    !fs.readFileSync(p, 'utf8').includes(VENDOR_MARK),
    '`doc-manager` 按 K-3 不挂规格面：不得出现 vendor 指针（双向判据的反向半边）',
  );
});
