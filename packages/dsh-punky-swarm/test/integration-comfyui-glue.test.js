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

// 集成声明守卫测试：comfyui-glue 子模块关系（docs/integrations/comfyui-glue.md）
// A2-1 ~~工具名集合逐字（取自声明文档正文，防文档漂移）~~ ——【R-2 已删除，2026-11-09，见下注】
// A2-2 punky 代码目录零 comfyui-glue 模块引用（R1 解耦硬约束，静态扫描）
// A2-3 package.json.files **不含** docs 条目（Q-10@closeout：22 条 docs 全出包；原口径是 P-3「已登记进发布白名单」）
// 本测试只读本仓自身文件：不 import 外部包、不连网络、不读仓外路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const DOC_REL = 'docs/integrations/comfyui-glue.md';
const DOC_EN_REL = 'docs/integrations/comfyui-glue.en.md';
const THIS_TEST = path.resolve(fileURLToPath(import.meta.url));

// 能力名集合（逐字，大小写敏感）── 【R-2 随 A2-1 删除】
//   【2026-11-09 · 批 `punky-gate-fix` · lane `e3-docs-unlink`】原常量 `EXPECTED_TOOLS`（4 名
//   `comfy_*`）唯一的使用者是 `A2-1`（「声明文档的工具名集合逐字等于这 4 名」）；A2-1 整例删除后
//   该常量**孤儿化** ⇒ 一并删除。**代码面守卫未削**：这 4 名由宿主/MCP 侧提供，本仓 `lib/` 内
//   `comfy_` 命中 = 0（见同文件 `A2-2` 的 R1 静态扫描）。

// R1：代码目录（文档与测试自身除外）
const CODE_DIRS = ['lib', 'test', 'scripts'];

function listFilesRecursive(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// 【R-2 移出 · 2026-11-09 · 批 `punky-gate-fix` · lane `e3-docs-unlink`】原用例
//   `A2-1 声明文档的工具名集合逐字等于 4 名（防文档漂移）`（§2.3-A `#4`，原 `:63-78`）**整例删除**。
//   判定对象 = `docs/integrations/comfyui-glue{,.en}.md` 的**正文工具名集合** = 文档内容一致性
//   （用户裁决：测试链只绑代码）。上批削弱评估（W-5）判「代码面另有承接」的结论复核后仍成立：
//   ① `lib/` 内 `comfy_` 命中 = 0（宿主/MCP 侧提供，本仓不注册）⇒ 代码面无同名漂移风险；
//   ② 本文件 `A2-2`（R1 零模块引用静态扫描）与 `A2-3`（`package.json.files` 不含 docs 条目）
//      两条**代码面/发行面**判据保留在链上。
//   守卫去向：**接受失守**（文档 ↔ 契约的 4 名同步），文档由项目内人工维护。

test('A2-2 punky 代码目录零 comfyui-glue 模块引用（R1 静态扫描）', () => {
  const offenders = [];
  for (const relDir of CODE_DIRS) {
    const abs = path.join(root, relDir);
    if (!fs.existsSync(abs)) continue;
    for (const file of listFilesRecursive(abs)) {
      if (path.resolve(file) === THIS_TEST) continue; // 白名单：本守卫测试自身的断言字面量
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.includes('comfyui-glue')) {
          offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `lib/ test/ scripts/ 内不得出现 comfyui-glue 引用（R1 零模块引用）：\n${offenders.join('\n')}`,
  );
});

// 【判据更新 · 留痕】原断言编码 **P-3 发布白名单**（「`docs/integrations/comfyui-glue{,.en}.md` 必须出现在
//   `package.json.files`」）。该裁定已被 **Q-10@closeout 覆盖**（批 `punky-closeout-20261023`，2026-10-23：
//   22 条 `docs/*` 全移出 `files`）⇒ 方向**反转**：不再要求「必须含」，而是要求「必须不含」。
//   注意两面都要有才是完整判据：docs 文件**仍在仓内**，只是**不随包发布**（`files` 白名单形态）。
//   ⚠ 【R-2 · 2026-11-09】原此处写「A2-1 已断言在场」作「仓内面」的旁证 —— A2-1 已按 R-2 删除
//   （它判的是文档内容），故本句改为「仓内面不再由测试断言」（`docs/**` 按 `.gitignore` 不入库，
//   断言其内容只会造假绿）。本条判「发布面」，始终是 `package.json` 的**代码面**事实。
test('A2-3 package.json.files 不含任何 docs 条目（Q-10@closeout：22 条 docs 全出包）', () => {
  assert.ok(Array.isArray(pkg.files), 'package.json.files 必须是数组（逐文件白名单形态）');
  const docsEntries = pkg.files.filter((rel) => typeof rel === 'string' && rel.startsWith('docs/'));
  assert.deepEqual(docsEntries, [], 'package.json.files 不得再含任何 docs 条目（Q-10@closeout：22 条全出包）');
  // 逐条点名这两条（本文件被测的集成文档）：它们是 Q-10 的实例，不是泛泛的「docs 前缀」污染。
  for (const rel of [DOC_REL, DOC_EN_REL]) {
    assert.equal(
      pkg.files.includes(rel),
      false,
      `package.json.files 不得再含 ${rel}（Q-10@closeout 已移出；机制 = files 白名单，不是 .gitignore）`,
    );
  }
});
