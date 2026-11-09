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

// test/accept-pack1-guidance.test.js —— 批 `punky-iter-a-20261024` · **pack1 验收套件**（lane `t1-tests`）
// ─────────────────────────────────────────────────────────────────────────────
// 判据来源 = `plan/p2-taskpack-1.md` 的 `## 验收标准`（AC-1..AC-12），**逐条一对一**编号 `AC-pack1-N`。
//
// ⚠ 【R-2 移出登记 · 2026-11-09 · 批 `punky-gate-fix` · lane `e3-docs-unlink`】
//   用户裁决：**测试链只绑代码、不绑文档**（2026-11-09）；注入面（`presets/**`、`skills/**`）按**丙案**
//   只保留两条硬断言（① frontmatter 合法；② `references` 引用的文件确实存在），其余结构完整性断言
//   随文档内容一致性校验一并移出。据此本件**移出 4 例**，仅保留唯一的**常驻不变量**用例 `AC-pack1-12`：
//
//   | 原用例 | 上批编号/原行 | 判定对象 | 守卫去向 |
//   |---|---|---|---|
//   | `AC-pack1-2` §0i/§0s/§0t 小节在场且 id 不重复 | §2.3-C `#19`（原 `:144-153`） | `discipline.md` 正文小节标题 | **接受失守**（小节结构由人工维护）；丙案①「frontmatter 合法」不覆盖 `.md` 小节齐备 |
//   | `AC-pack1-6` 注入面条目 vs 正文 24 字窗命中 = 0 | §2.3-C `#20`（原 `:158-182`） | 两件文档的文本重合率 | **接受失守**（属「文案与正文职责边界」，非可机检注入契约） |
//   | `AC-pack1-7` §0k 含 `SUMMARY:` 机读行 + 4 档强度 | §2.3-C `#21`（原 `:187-209`） | `discipline.md` §0k 正文 | **接受失守**；机读契约的下游解析器另有 `gate-*`/`judging` 面用例（已随 R-2 一并移出）⇒ 登记 followup |
//   | `AC-pack1-10` §0f/§0g/§0h 悬空引用 = 0 | §2.3-C `#22`（原 `:214-230`） | `discipline.md` **内部小节号**是否仍有定义 | **接受失守** |
//
//   **`#22` 的归类更正（H-05，勿沿用旧理由）**：原判据比对的是 `discipline.md` 的**内部小节号**
//   `§0f/§0g/§0h` 是否仍有定义面，**不是**「引用的文件是否存在」⇒ 不属丙案硬断言②（文件存在性），
//   故归**移出**，不得再以「引用可达 ⇒ 保留」为理由留在链上。
//
// 只读纪律：
//   · 本件不写目标仓任何文件（读文本 + 只读命令 `spawnSync`）。
//   · **禁跑** `npm run build` / `npm test`（首段 build 会重写全量 `lib/**` = pack2 的独占窗口）。
//   · 执行方式：`node --test test/accept-pack1-guidance.test.js`
//
// 四态纪律：每条用例正文首行写明**失败条件**；报告侧四态（通过/失败/跳过/未验证）逐位留档，
//   跳过只用于「并行窗口内结构性不可判」，**不折算**为通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
// 【R-2 · 2026-11-09】随上述 4 例删除而**孤儿化**的常量/辅助函数已一并删除（只清理本次改动造成的死码）：
//   `DISCIPLINE_REL` / `GUIDANCE_REL` / `BATCH_ARTIFACTS` / `absOf` / `readRel` / `normWs` /
//   `SECTION_RE` / `sectionOf` / `windowHits` / `inlineEntriesOf` / `TMP` + `test.after`（负例夹具早已删除，
//   该钩子恒空转）/ `fs` 导入。
//   另删两处**历史遗留死码**（本文件内零调用点，且目标件已不存在）：`BASELINE`（`'bfb9b0c'`）与
//   `CODER_TEST_REL`（指向 `test/guidance-id-coverage.test.js`，该件**不在盘**）。

/** porcelain 路径（`XY <path>`：状态位恰 2 字符 + 1 空格；**不得先 trim**，否则首行状态位被吃掉）。 */
function porcelainPaths() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git status 必须可用：' + (r.stderr ?? ''));
  return (r.stdout ?? '').split(/\r?\n/).filter((l) => l.length > 0).map((line) => {
    const m = /^(..)\s(.*)$/.exec(line);
    assert.ok(m, `porcelain 行无法解析（格式变了？）：${JSON.stringify(line)}`);
    let p = m[2];
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    return p.replace(/^"|"$/g, '');
  });
}

/** 禁区黑名单（**常驻不变量**，**不是**批窗口写域）：任何**未提交**变更都不许落在这些面上 ——
 *  `baselines/**` 单写者 = Leader；`docs/**`、`reports/**` 为只读记录面。
 *  注入面（`presets/punky-preset/**`）**不列入**本黑名单：它的判据是「repo ↔ live 同 sha256」
 *  （见 `AC-pack1-12` 首段），改一份即改另一件属**合法**演进 ⇒ 列入会与判据⑦ 造双口径。 */
const FORBIDDEN_ZONES = [
  /^packages\/dsh-punky-swarm\/baselines\//,
  /^packages\/dsh-punky-swarm\/docs\//,
  /^packages\/dsh-punky-swarm\/reports\//,
];
/** 禁区内的**唯一**合法例外（2026-11-09）：`baselines/test-baseline.json` 是「基线单写者 = Leader」
 *  的受控产物，测试树改动后**必须**同步重冻（`node scripts/baseline-snapshot.mjs --reason "<事由>"`），
 *  否则 `e2-1` / `e2-13`（基线 ≡ 实测树）会红。此处放行**单文件**，不放行目录：
 *  `baselines/` 下新增其它文件仍判越界。 */
const BASELINE_REFRESH_ALLOWED = /^packages\/dsh-punky-swarm\/baselines\/test-baseline\.json$/;

// ═══════════════════════════════════════════════════════════════════════════════
// AC-12 禁区黑名单（W8：baselines/docs/reports 单写者 = Leader）
// ═══════════════════════════════════════════════════════════════════════════════
test('AC-pack1-12 禁区（baselines/docs/reports）不得出现未提交变更', () => {
  // 已解绑：原「五件 repo↔live 同 sha256」由校验器承载；该校验器于 2026-10-28 退役（用户裁决：
  //   指引维护不常做、不需要绑测试锚定），该面改由 `scripts/sync-guidance.mjs` 的复制动作承担（无判定结论）。
  //   保留的是**常驻不变量**：禁区目录不得出现在未提交变更里（W8：基线单写者 = Leader）。

  // 【AD-11（本批替换）】原 `PACK_DOMAINS` 冻结 `punky-iter-a-20261024` 那五个**历史批名**的写域，
  //   任何后续合法改动都「不可归属」⇒ 本 lane 自己的修复文件全部不可归属（修了就红 = 自伤）。
  //   换成本批裁定的 ② 口径的**工作树半段**：只判「禁区黑名单是否被未提交变更动过」，
  //   **不判**通用写域归属（工作树脏项不判红）。
  //   **禁**「扩写写域表把本批路径塞进去」= 削判据（规格需求 8 乙类）。
  //
  //   ⚠ **②的「提交面为主」半段实测不可用（本 lane 弃用，须 Leader 复核）**：`baselines/**` 是
  //   **Leader 每批重冻面**，实测 `git log --oneline bfb9b0c..HEAD -- baselines/` ⇒ `0419b22`
  //   （本批起点 HEAD，合法引擎修复提交）已重冻 `baselines/test-baseline.json`。
  //   任何「自某历史 base 起禁区内零提交」的提交面断言 ⇒ 下一次合法重冻即**永久必红**，
  //   与本批要修的 C-1②（历史状态冻结）同病。工作树面则常驻可判：合法重冻必以**提交**形态落盘，
  //   不进工作树面 ⇒ 该判据不会因流程内动作变红。
  const forbiddenDirty = porcelainPaths().filter((p) => !BASELINE_REFRESH_ALLOWED.test(p) && FORBIDDEN_ZONES.some((re) => re.test(p)));
  assert.deepEqual(forbiddenDirty, [], '禁区（baselines/docs/reports）不得出现未提交变更（W8：基线单写者 = Leader）：'
    + JSON.stringify(forbiddenDirty));
});
