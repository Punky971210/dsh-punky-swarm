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
// A2-1 工具名集合逐字（取自声明文档正文，防文档漂移）
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

// 能力名集合（逐字，大小写敏感）—— 与 docs/integrations/comfyui-glue.md §2 一致
const EXPECTED_TOOLS = [
  'comfy_fetch_output',
  'comfy_object_info',
  'comfy_probe',
  'comfy_run',
];

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

test('A2-1 声明文档的工具名集合逐字等于 4 名（防文档漂移）', () => {
  const docPath = path.join(root, DOC_REL);
  const docEnPath = path.join(root, DOC_EN_REL);
  assert.ok(fs.existsSync(docPath), `missing declaration doc: ${DOC_REL}`);
  assert.ok(fs.existsSync(docEnPath), `missing declaration doc: ${DOC_EN_REL}`);

  for (const rel of [DOC_REL, DOC_EN_REL]) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const found = [...new Set(text.match(/comfy_[a-z_]+/g) ?? [])].sort();
    assert.deepEqual(
      found,
      EXPECTED_TOOLS,
      `${rel}: 工具名集合必须逐字等于契约的 4 名（多写/少写/改名都会被本断言拦下）`,
    );
  }
});

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
//   注意两面都要有才是完整判据：docs 文件**仍在仓内**（A2-1 已断言在场，故「不含」不是「文件不存在」的假绿），
//   只是**不随包发布**。所以本条是「发布面」判据，A2-1 是「仓内面」判据，二者不可互相替代。
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
