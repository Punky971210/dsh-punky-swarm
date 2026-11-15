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

// test/accept-pack3-spec-contract.test.js —— 批 `punky-iter-a-20261024` · **pack3 验收套件**（lane `t3-spec`）
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ **【2026-11-15 用户裁决「测试件不再检验文档，手动维护文档」】本件由 12 例收缩为 2 例。**
//   删除的 10 例全部是「判定对象 = 文档正文/文档目录」的判据，逐例去向如下（全部 5 条裁决口径见
//   `discipline.md#§13` 与 `skills/software-team/SKILL.md`「注入面声明纪律」）：
//
//   | 原用例 | 判定对象 | 处置 |
//   |---|---|---|
//   | `AC-pack3-1` | `skills/software-team` 树 19 件在场 + 计数 ≥20 | **删**（文档目录结构） |
//   | `AC-pack3-4` | 角色表集合 ↔ role 文件集合 对称差 | **删**（文档内容 ↔ 目录结构） |
//   | `AC-pack3-5` | 新细则 ≤ 300 行且 ≤ 16 KB | **删**（文档体积） |
//   | `AC-pack3-8` | role frontmatter 合法性（原「丙案硬断言①」） | **删**（文档内容；丙案① 随本裁决一并作废） |
//   | `AC-pack3-15c` | `references/vendor/speclang/*` 指针逐条在场（原「丙案硬断言②」） | **删**（文档内引用可达性；丙案② 一并作废） |
//   | `AC-pack3-11` | `skills/**` 只许 `.md` 变更 + `baselines/docs/reports` 零变更 | **删**（文档目录守卫） |
//   | `AC-pack3-11b` | `package.json` / `CHANGELOG.md` / `README*` 零变更 | **删**（文档目录守卫） |
//
//   ⚠ **丙案两条硬断言（2026-11-09 R-2 明确保留）自此作废** —— 这是对那条裁决的**显式推翻**，
//   不是遗忘。文档面一律人工维护，任何未来「文档一致性」机检需求须重新立裁决，不得沿用丙案。
//
//   **保留的 2 例都判代码面，不读任何 `.md`**：
//   · `AC-pack3-9`：`lib/` 内 `spec-contract` 命中 = 0（能力层不进引擎 = 红线 1）；
//   · `AC-pack3-9b`：`git status --porcelain lib/` = 0 行（守护对象是**代码目录**，非文档目录）。
//
// 只读纪律：本件**不改**仓内任何文件；**禁跑** `npm run build` / `npm test`。
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

// 【2026-11-15 孤儿清理（本裁决连带的死码）】只清理本次删除造成的死码：
//   `SKILLS_REL` / `SKILL_MD_REL` / `NEW_REL` / `ROLES_DIR_REL` 四个路径常量、
//   `absOf` / `readRel` / `existsRel` 三个只在被删用例里用到的辅助、
//   `BASELINE_SKILLS_19` 名单、`tableRolesHoldingSpecContract` / `roleFilesHoldingSpecContract` 两个枚举，
//   以及只为「丙案硬断言①」引入的 `parseRoleFrontmatter` / `ROLE_MANDATORY_FIELDS` 导入。
//   保留 `gitPorcelain`（`AC-pack3-9b` 用）、`walkFiles`（`AC-pack3-9` 用）、`spawnSync`（前者用）。

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

// ═══════════════════════════════════════════════════════════════════════════════
// AC-9 引擎面零改动（红线 1）—— **代码面**，保留
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
  // 守护对象 = **代码目录 `lib/`**，不是文档目录 ⇒ 不属 2026-11-15「文档守卫清除」范围。
  const libDirty = gitPorcelain().filter((p) => p === 'packages/dsh-punky-swarm/lib' || p.startsWith('packages/dsh-punky-swarm/lib/'));
  if (libDirty.length > 0) {
    return t.skip(`并行窗口内不可判：lib/ 有 ${libDirty.length} 行脏项，归属权在 pack2 的 build 窗口（K-7/R-08）；收口态复跑本件`);
  }
  assert.deepEqual(libDirty, [], 'lib/ 须零脏项');
});
