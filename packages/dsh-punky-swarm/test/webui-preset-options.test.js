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

// 治理配置页「规则预设」多选项静态断言（2026-09-14）：防「面板漏规则集」（L3 未出现的位置就在这里）
// 与「compose 组合项语义回潮」两类回归。
// 形态：客户端 bundle（lib/client.js）为手写 JS（window.__ModuleLoader__ 包装，无运行时 harness），
//   故本测试读源码做契约级断言——与 test/preset-rules.test.js 的 V9（读 README 核清单）同法。
// 断言面：① 可选装载 id 集合 = 三个平级规则集（含 l3-tool-ban）；
//         ② 选项集合不含 compose（组合由多选叠加表达；compose 仅保留 legacy 回显映射）；
//         ③ 中英文案键齐备（l1/l2/l3 + 合计行），compose 文案键已移除；
//         ④ 合计行为通用实现（不依赖「恰好两项」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'lib', 'client.js'), 'utf8');

// 面板可选装载 id 集合（源码解析；解析失败即断言失败——不静默跳过）
function optionIds() {
  const m = /function presetOptionIds\(\)\s*\{\s*return\s*\[([^\]]*)\]/.exec(src);
  assert.ok(m, 'presetOptionIds 定义存在（面板多选项唯一来源）');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('W1 规则预设多选项：presetOptionIds = [l1-sensitive, l2-resource, l3-tool-ban, l5-wait-ban]（L3/L5 在面板内）', () => {
  assert.deepEqual(optionIds(), ['l1-sensitive', 'l2-resource', 'l3-tool-ban', 'l5-wait-ban'],
    '四个规则集平级多选；L3（工具黑名单）与 L5（等待能力禁用）必须在面板选项内——否则面板看不到新规则集');
});

test('W2 单选遗产已清除：选项集合不含 compose；面板不再做任何 compose / 单值自动迁移', () => {
  assert.equal(optionIds().includes('compose'), false, 'compose 不得作为面板选项出现（组合 = 多选叠加）');
  assert.equal(/id === 'compose'/.test(src), false, 'compose 专用迁移分支须删除（全面清除单选遗产）');
  assert.equal(/presetMeaningKey\('compose'\)/.test(src), false,
    '不得再以 compose 文案渲染「组合摘要行」（compose 文案键已删，用了就是漏改）');
});

test('W3 文案面：zh/en 各含 l1/l2/l3 + 合计行键；compose 文案键已删', () => {
  for (const key of ['gov.preset.l1', 'gov.preset.l2', 'gov.preset.l3', 'gov.preset.total']) {
    const hits = src.split('"' + key + '"').length - 1;
    assert.equal(hits, 2, `${key} 应在 zh/en 两份 locales 各出现一次（实际 ${hits}）`);
  }
  assert.equal(src.includes('gov.preset.compose'), false, 'compose 文案键应删除（不再有组合项语义）');
});

test('W4 合计行：fmtN2 通用实现（已选 N 项 · 合计 M 条），不依赖固定两项', () => {
  assert.match(src, /function fmtN2\(k, n, m\)/, 'fmtN2 双占位符格式化存在');
  assert.match(src, /fmtN2\('gov\.preset\.total', presetSel\.length, presetTotal\)/, '合计行调用点在档');
  assert.equal(/presetSel\.length === 2/.test(src), false, '不得再以「恰好两项」判定组合摘要');
});

test('W5 单值形态不再自动迁移（单选遗产清除）：formPresetOf 只接受数组，非数组原样保留交后端拒', () => {
  assert.match(src, /if \(!Array\.isArray\(pv\)\) return \{ custom: pv \}/, '非数组形态不得自动包装或迁移');
  assert.equal(/typeof pv === 'string' \? \[pv\]/.test(src), false, '不得保留单值字符串的自动包装（单选遗产）');
});
