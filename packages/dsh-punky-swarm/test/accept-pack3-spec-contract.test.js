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
//
// ⚠ 【R-2 / 丙案 重分类 · 2026-11-09 · 批 `punky-gate-fix` · lane `e3-docs-unlink`】
//   用户裁决：**测试链只绑代码、不绑文档**（2026-11-09）；注入面（`presets/**`、`skills/**`）按**丙案**
//   只保留两条硬断言：**① frontmatter 合法；② `references` 引用的文件确实存在**。
//   本件承载丙案 13 例中的 8 例（`#23`..`#30`），按「**子断言粒度**」拆分（H-06：`AC-pack3-15` 整例留 /
//   整例删都错），处置如下：
//
//   | 处置 | 上批编号 | 原行 | 现值 |
//   |---|---|---|---|
//   | **保留（②）** | `#29` 的**存在性子断言** | 原 `:450` 例内 `:472-483` | → `AC-pack3-15c`（独立坐标，逐条 `fs.existsSync`） |
//   | **并入**（子断言级，不计例数） | `#30` 的 `:495` | 原 `:495` | → 并入 `AC-pack3-15c`（`doc-manager.md` 必须存在） |
//   | **移出** | `#23` `:176` / `#24` `:190` / `#25` `:210` / `#27` `:416` / `#28` `:435` / `#30` 主体 `:492-499` | 同左 | 整例删除（就地留痕） |
//   | **改写（①）** | `#26` `:340` | 原 `:340-363` | → `AC-pack3-8`**重写为 frontmatter 合法性**（可解析 + 必备键在场 + 列表键为数组） |
//
//   另按 §2.3-A（文档内容绑定）移出 2 例：`AC-pack3-6`（`#11` 24 字窗 / 12-gram 重合率 — 纯文案篇幅重叠）
//   与 `AC-pack3-7`（`#10` 版本钉 `b3ee6ee` 的文案同步）。
//   ⇒ 净结果：本件从 **17 例**收敛为 **9 例**，其中 7 例是**代码面/流程面**判据（集合在场、对称差、体积、
//   引擎面零命中、porcelain 两类、禁区），1 例丙案①（frontmatter），1 例丙案②（references 存在性）。
//
// ⚠ **`#26` 选择「改写」而非「移出」的理由（留痕）**：丙案两条硬断言里 ② 已由 `AC-pack3-15c` 独占，
//   若 ① 也移出则「注入面只留两条硬断言」退化成一条。改写用**零依赖结构解析**（不引 `js-yaml`：
//   它不是本包 `dependencies`/`devDependencies` 的声明项，仅以传递依赖形态在 `node_modules` 里，
//   而 AC-24 禁 `npm install` / 禁 lockfile 变更 ⇒ 引它 = 造一条在干净检出上可能必红的隐式依赖）。
//
// 只读纪律：本件**不改**仓内任何文件（含 skills 树与 live 镜像）；**禁跑** `npm run build` / `npm test`。
// 执行方式：`node --test test/accept-pack3-spec-contract.test.js`
//
// 四态纪律：每条用例正文首行写明**失败条件**；跳过只用于「并行窗口内结构性不可判」，不折算通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 丙案硬断言① 的解析器 = **引擎自己的**那一份（非自造、非新增依赖）；与 `resolveRoleRef` 同一条解析路径。
import { parseRoleFrontmatter, ROLE_MANDATORY_FIELDS } from '../lib/engine/dispatch-role.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const SKILLS_REL = 'skills/software-team';
const SKILL_MD_REL = 'skills/software-team/SKILL.md';
const NEW_REL = 'skills/software-team/references/engineering/spec-contract.md';
const ROLES_DIR_REL = 'skills/software-team/references/roles';
// 【G04③ 死码已删（批 `punky-g1-gapfix-2026-10-29` · lane `t1-verify`）】
//   原「已退役脚本的路径常量」与「JSON 版 spawn 包装函数」整链删除：该包装在本文件**无任何调用点**
//   （实测 grep 仅命中定义），其体内 spawn 该脚本的一行因此**不是活引用**；
//   与之配套的「子进程 env 剥离」辅助函数随之孤儿化（唯一使用者是被删的包装）⇒ 一并删除。
//   本文件另一处 `spawnSync('git', …)` 是**活引用**，`node:child_process` 导入保留；**未动任何活断言**（C-6）。
// 【R-2 · 2026-11-09】随上表所列 8 例的删除/改写而**孤儿化**的常量与辅助函数已一并删除
//   （只清理本次改动造成的死码）：`ENG_DIR_REL` / `normWs` / `windowsOf` / `SPECLANG_ROOT` /
//   `SPECLANG_PRESENT` / `SPECLANG_PIN` / `speclangSources` / `noteSpeclangAbsent` /
//   `RECOMMEND_TOKENS` / `ASSEMBLY_BAN` / `VENDOR_MARK`。
//   连带删除的还有「SpecLang 上游只读副本」整段说明（其唯一消费者是被删的 `AC-pack3-6`/`AC-pack3-7`
//   与死码 `noteSpeclangAbsent`）——**这不影响**任何保留判据：`AC-pack3-15c` 判的是**仓内** vendor 副本
//   的指针存在性，与上游副本无关。

const absOf = (rel) => path.join(PKG_ROOT, ...rel.split('/'));
const readRel = (rel) => fs.readFileSync(absOf(rel), 'utf8');
const existsRel = (rel) => fs.existsSync(absOf(rel));

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
// 【R-2 移出】AC-pack3-2（上批 §2.3-C `#23`，原 `:176-185`）
//   原判据：新文件 `## S-n` 条目 ≥ 4 且既有三件 `S-`/`C-` 前缀命中 = 0。
//   移除依据：判定对象 = `spec-contract.md` 正文的**编号族形态**（文档内容一致性）。
//   守卫去向：**接受失守**；丙案①（frontmatter 合法）不覆盖正文编号族，丙案② 只覆盖 references 存在性。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// 【R-2 移出】AC-pack3-2b（上批 §2.3-C `#24`，原 `:190-205`）
//   原判据：新文件覆盖四块（MC-1..MC-8 / 六态 4 档＋2 旁路 / `SUMMARY:` 机读行 / 需求编号族）。
//   移除依据：判定对象 = `spec-contract.md` 正文**章节与编号覆盖**（文档内容一致性）。
//   守卫去向：**接受失守**（同 `#23`）。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// 【R-2 移出】AC-pack3-3（上批 §2.3-C `#25`，原 `:210-225`）
//   原判据：挂载命中文件数 = 1（SKILL.md）＋ N（挂载 role 文件数），且 ≥ 7（目录结构齐）。
//   移除依据：判定对象 = `skills/software-team` 树下**哪些文件正文提到了 `spec-contract`**
//   （文档内容一致性 + 目录结构齐）。丙案② 只保「被引用的**文件**是否存在」，不保「引用它的文件有几个」。
//   守卫去向：**部分承接** —— `AC-pack3-4`（表集 ↔ role 文件集对称差 = ∅）仍在链上，
//   但「下标集 ⊆ 上标集」的等式半边失守 ⇒ 登记 followup。
// ═══════════════════════════════════════════════════════════════════════════════

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
// 【R-2 移出】AC-pack3-6（上批 §2.3-A `#11`，原 `:257-315`）
//   原判据：新文件与 SpecLang 上游源的字面重合度（24 字窗命中 = 0 / 12-gram ≤ 15% / 锚点可解析）。
//   移除依据：判定对象 = 两件**文本**的篇幅重叠率，纯文案面、零代码面含义（上批削弱评估 W-8）。
//   守卫去向：**接受失守**（防整句拷贝转为人工评审）；连带删除其专用辅助
//   `normWs`/`windowsOf`/`speclangSources`/`noteSpeclangAbsent`/`SPECLANG_*` 常量。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// 【R-2 移出】AC-pack3-7（上批 §2.3-A `#10`，原 `:320-335`）
//   原判据：版本钉 `b3ee6ee` 出现在 2 件；`The Cangjie Project` / `权利人待确认` / `Apache-2.0` 各 ≥1。
//   移除依据：判定对象 = 文档正文的**版本号与署面措辞同步**，纯文案（W-8「无代码面含义」）。
//   守卫去向：**接受失守**（版本钉与许可署面由人工维护）。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// AC-8（**丙案① 改写**）role frontmatter 合法：可解析 + 必备键在场 + `skills` 为数组
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-8 role frontmatter 合法：引擎同源解析器可解析、`ROLE_MANDATORY_FIELDS` 全在场、`skills` 为数组', () => {
  // 失败条件：某 role 文件无可用 frontmatter（`parseRoleFrontmatter` 返回 null）/ 缺
  //           `ROLE_MANDATORY_FIELDS` 中任一键（值为 undefined|null|''|空数组）/ `skills:` 在场但不是数组
  //           （写成标量 `skills: speclang` ⇒ 下游 `listOf` 会把它当单元素列表或按字符串读 = 静默错读）。
  // 【丙案① 改写 · 留痕（`#26`＝原 `:340-363`）】原判据 = 「role frontmatter 的 `skills:` 内**零 speclang**」
  //   （字段**内容**约束）⇒ 按 R-2 移出（文档/注入面内容一致性）；改判**字段合法性**（丙案硬断言①）。
  //   **不自造 YAML 解析器、不引 `js-yaml`**（它不是本包声明的依赖；AC-24 禁 `npm install` / 禁 lockfile
  //   变更 ⇒ 引它等于造一条在干净检出上可能必红的隐式依赖）：直接用**引擎自己的**解析器
  //   `parseRoleFrontmatter` + 必填键常量 `ROLE_MANDATORY_FIELDS`（`lib/engine/dispatch-role.js`）
  //   ⇒ 本断言跟踪的是**真实消费方契约**（`resolveRoleRef` 走的同一解析路径），解析器演进时这里自动跟随。
  const dir = absOf(ROLES_DIR_REL);
  const roleFiles = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  // 防「零文件 ⇒ 恒绿」
  assert.ok(roleFiles.length >= 7, `role 文件须 ≥ 7 件（含 doc-manager），实测 ${roleFiles.length}`);
  const problems = [];
  for (const name of roleFiles) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const fm = parseRoleFrontmatter(text);
    if (!fm) { problems.push(`${name}: 无可用 frontmatter（\`---\` 块缺失或形态不符）`); continue; }
    const missing = ROLE_MANDATORY_FIELDS.filter((k) => {
      const v = fm[k];
      return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    });
    if (missing.length) problems.push(`${name}: 缺必备键 ${missing.join('/')}`);
    if (Object.prototype.hasOwnProperty.call(fm, 'skills') && !Array.isArray(fm.skills)) {
      problems.push(`${name}: \`skills:\` 须为数组形态，实测 ${JSON.stringify(fm.skills)}`);
    }
  }
  assert.deepEqual(problems, [], 'role frontmatter 不合法（丙案硬断言①）：' + JSON.stringify([...new Set(problems)]));
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
// 【R-2 移出】AC-pack3-13（上批 §2.3-C `#27`，原 `:416-428`）
//   原判据：SKILL.md 与 role 文件里的 `S-n` 引用全部解析到 `spec-contract.md` 现役小节。
//   移除依据：判定对象 = 文档**内部编号**的定义面（`## S-n` 小节是否还在）＝ 文档内容一致性；
//   它**不是**「引用的文件是否存在」（丙案②只判文件级存在性，不判文档内锚点）。
//   守卫去向：**接受失守**。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// 【R-2 移出】AC-pack3-14（上批 §2.3-C `#28`，原 `:435-444`）
//   原判据：适配层含「映射摘要」与「原件为准」硬声明，且声明位于六态表之前（结构顺序）。
//   移除依据：判定对象 = 文档正文的**措辞在场与相对位置**（文档内容一致性 + 结构顺序）。
//   守卫去向：**接受失守**。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// AC-15c（**丙案② 唯一保留项**）`references/vendor/speclang/*` 指针逐条在场
//   主子断言 = 原 `AC-pack3-15` 内的 `:472-483`（`fs.existsSync` 死指针检测）
//   并入子断言 = 原 `AC-pack3-15b` 的 `:495`（`doc-manager.md` 必须存在）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-15c `references/vendor/speclang/*` 指针逐条在场（死指针 = 红）；`doc-manager.md` 必须存在', () => {
  // 失败条件：任一处 `references/vendor/speclang/<x>` 路径不解析（死指针 ⇒ 成员点不开原件）；
  //           或 `doc-manager.md` 不在盘（角色集缺口，应由 AC-pack3-1 先红）。
  // 【H-06 拆解】原 `AC-pack3-15` 把**存在性**（`:472-483`）与**内容/措辞**（`:457-468` 的
  //   `RECOMMEND_TOKENS`/`ASSEMBLY_BAN`、`:484-485` 的 holders 集合相等）混在一例 ⇒ 整例留/整例删都错。
  //   本用例只留**存在性**半边（丙案②），内容/措辞半边随丙案移出（就地留痕见下）。
  // 【并入】原 `AC-pack3-15b` 的 `:495`（`doc-manager.md` 必须存在）—— 子断言级并入，不另计例数。
  const dir = absOf(ROLES_DIR_REL);
  const docManager = path.join(dir, 'doc-manager.md');
  assert.ok(fs.existsSync(docManager), 'doc-manager.md 必须存在（缺失 = 角色集缺口，应由 AC-pack3-1 先红）');
  const dead = [];
  const pointers = new Set();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      for (const m of line.matchAll(/`(references\/vendor\/speclang\/[^`]+)`/g)) {
        const rel = m[1].replace(/\/+$/, '');
        pointers.add(rel);
        const abs = path.join(PKG_ROOT, 'skills/software-team', rel);
        if (!fs.existsSync(abs)) dead.push(`${name}: ${rel} ⇒ 不存在`);
      }
    }
  }
  assert.deepEqual(dead, [], '死指针（路径不可解析，成员点不开）：' + JSON.stringify(dead));
  // 防「零指针 ⇒ 恒绿」的下界棘轮：本仓既有 4 个 vendor 子目录被指针引用，少于此数说明指针被整体删掉
  //   （删掉指针不属本判据要放行的演进：那会让丙案②变成空断言）。
  assert.ok(pointers.size >= 4,
    '被引用的 `references/vendor/speclang/*` 路径须 ≥ 4 条（下界棘轮，防「删指针换绿」使本断言空转），实测 '
      + pointers.size + '：' + JSON.stringify([...pointers].sort()));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 【R-2 移出】AC-pack3-15 主体（上批 §2.3-C `#29` 的**内容/措辞半边**，原 `:450-488` 除 `:472-483`）
//   移出子断言：① `RECOMMEND_TOKENS`（同行须含 recommend/选读/不在册/不构成失败 语义词）；
//              ② `ASSEMBLY_BAN`（同行不得含 必装/强依赖/缺则拒/未就绪即拒）；
//              ③ `holders` 集合**精确等于** coder/coordinator/designer/reviewer/supervisor/tester 六名。
//   移除依据：三条都判**文档正文的措辞与挂载名单**（`#29` 的持存子断言已在 `AC-pack3-15c` 保留）。
//   守卫去向：**接受失守**（措辞语义与挂载名单由人工评审；`AC-pack3-4` 仍守「表 ↔ 文件」两本账）。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// 【R-2 移出】AC-pack3-15b 主体（上批 §2.3-C `#30` 的**内容半边**，原 `:496-499`）
//   移出子断言：`doc-manager.md` 正文**不得出现** `vendor/speclang/` 指针（内容断言）。
//   保留子断言：同例 `:495`（`doc-manager.md` 必须存在）→ 已**并入** `AC-pack3-15c`。
//   移除依据：判定对象 = 文档正文内容；丙案② 只判「被引用的文件是否存在」，不判「该不该引用」。
//   守卫去向：**接受失守**（K-3「doc-manager 不挂规格面」由人工评审守）。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// AC-11 越界检查
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack3-11 skills 面只许 .md 变更；baselines/docs/reports 零变更', () => {
  // 失败条件：改了别的 team skill（写域只有 software-team）/ 写了基线或文档（W8：基线单写者 = Leader）。
  const paths = gitPorcelain();
  // 【Leader L-3 · 2026-11-10】AD-11 同类先例：原子断言「skills 变更只许落在 `software-team/` 内」
  //   本质是**批窗口写域冻结**（pack3 开工时的写域快照），已被后续**合法演进**打红——批次
  //   `punky-gate-fix` 按用户 N-5 裁决改 `design/research/video/writing-team/**/SKILL.md` 的交接门文案。
  //   照 AD-11 口径弃该半段，改为**不依赖批窗口的等价不变量**：`skills/**` 内只许 `.md` 变更
  //   （禁夹带脚本、资产或可执行文件）。判据强度不降（仍拦"往 skills 里塞代码"），只去掉时间性。
  const skillPaths = paths.filter((p) => /^packages\/dsh-punky-swarm\/skills\//.test(p));
  const nonMd = skillPaths.filter((p) => !p.endsWith('.md'));
  assert.deepEqual(nonMd, [], 'skills/** 只许 .md 变更（禁夹带脚本/资产）：' + JSON.stringify(nonMd));
  // 【2026-11-09】`baselines/test-baseline.json` 单文件放行（基线单写者 = Leader 的受控重冻；
  //   测试树改动后必须同步，否则 e2-1 / e2-13 红）；`docs/` `reports/` 仍为禁区。
  const forbidden = paths.filter((p) => !/^packages\/dsh-punky-swarm\/baselines\/test-baseline\.json$/.test(p)
    && /^packages\/dsh-punky-swarm\/(baselines|docs|reports)\//.test(p));
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
