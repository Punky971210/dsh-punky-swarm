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

// test/artifact-types.test.js —— R1「契约三小件」·产物类型注册表增量面（exec-1 lane）
// ─────────────────────────────────────────────────────────────────────────────
// 被检面 = `lib/artifact-types.js`（纯增量：可选 `elements?` / `subsections?`）+ 其**唯一回显读端**
//          `lib/tools/core.js:996`（`artifact_types` 工具）。
// 判据来源：`docs/r1-blueprint-spec.md` §2.2（含「回归断言」条）+ §3 S-①。
//
// 覆盖口径：
//   ① 既有 10 条键集**恒为** `{type,dir,layer,desc}`（防「顺手给所有条目加空数组」的读端形状漂移）；
//   ② 既有 10 条的 `type`/`dir`/`layer`/`desc` **逐字不变**（冻结基线快照对照）；
//   ③ 带 `elements`/`subsections` 的条目 ⇒ 回显**多两键**且键序 = type+dir+layer+desc+elements+subsections；
//   ④ 缺省不声明新字段时，回显**不含**两键（键集不漂移）；
//   ⑤ `artifact_types` 工具 `output.schema` **不新增 required**（`additionalProperties:true` 已允许）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTIFACT_TYPES, artifactTypesView } from '../lib/artifact-types.js';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';

// 冻结基线：R1 施工前实测原文（10 条 × 四字段，逐字）
const BASELINE = [
  { type: 'plan', dir: 'plan/', layer: 'plan', desc: '任务层产物（排期/模块清单/摸底）' },
  { type: 'spec', dir: 'plan/', layer: 'plan', desc: '执行规范（模板层定义内部结构）' },
  { type: 'taskTree', dir: 'plan/', layer: 'plan', desc: '任务树（细拆）' },
  { type: 'survey', dir: 'plan/', layer: 'plan', desc: '代码摸底报告（现状/入口/依赖/风险）' },
  { type: 'code', dir: 'exec/', layer: 'exec', desc: '代码/实现产物' },
  { type: 'testReport', dir: 'exec/', layer: 'exec', desc: '测试报告' },
  { type: 'review', dir: 'audit/', layer: 'audit', desc: '审查证据' },
  { type: 'gapList', dir: 'audit/', layer: 'audit', desc: '差距清单' },
  { type: 'acceptance', dir: 'audit/', layer: 'audit', desc: '验收报告' },
  { type: 'retrospective', dir: 'audit/', layer: 'audit', desc: '复盘报告（记忆沉淀输入，记忆工具开放语义）' },
];

// 工具夹具（同 `tools.test.js` 形：createStore + createTools）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-artifact-types-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const store = createStore(root);
const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) }, logger: console };
const { tools } = createTools(ctx, { store, root });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// ─────────────────────────────────────────────────────────────────────────────
// ① / ② 既有 10 条：键集不变 + 四字段逐字不变
// ─────────────────────────────────────────────────────────────────────────────

test('① 既有 10 条键集**恒为** {type,dir,layer,desc}（禁形状漂移）', () => {
  assert.equal(ARTIFACT_TYPES.length, 10);
  for (const t of ARTIFACT_TYPES) {
    assert.deepEqual(Object.keys(t), ['type', 'dir', 'layer', 'desc'], t.type + ' 键集漂移');
    assert.equal('elements' in t, false, t.type + ' 不得凭空多 elements');
    assert.equal('subsections' in t, false, t.type + ' 不得凭空多 subsections');
  }
});

test('② 既有 10 条四字段**逐字不变**（冻结基线对照）', () => {
  const view = ARTIFACT_TYPES.map((t) => ({ type: t.type, dir: t.dir, layer: t.layer, desc: t.desc }));
  assert.deepEqual(view, BASELINE);
});

;

// ─────────────────────────────────────────────────────────────────────────────
// ③ / ④ 新字段：回显多两键；缺省不声明则键集不变
// ─────────────────────────────────────────────────────────────────────────────

test('③ 带 elements/subsections 的条目 ⇒ 回显含两键且键序 = type+dir+layer+desc+elements+subsections', () => {
  assert.equal(typeof artifactTypesView, 'function', '须导出唯一回显读数函数 artifactTypesView');
  const row = {
    type: 'spec', dir: 'plan/', layer: 'plan', desc: '执行规范',
    elements: ['goal', 'constraints'],
    subsections: { '## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准': 2 },
  };
  const [v] = artifactTypesView([row]);
  assert.deepEqual(Object.keys(v), ['type', 'dir', 'layer', 'desc', 'elements', 'subsections']);
  assert.deepEqual(v.elements, ['goal', 'constraints']);
  assert.deepEqual(v.subsections, { '## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准': 2 });
});

test('③ subsections 数组形（等价 level 2）与对象形**原样**回显（不归一化）', () => {
  const arr = artifactTypesView([{ type: 'plan', dir: 'plan/', layer: 'plan', desc: 'd', subsections: ['## 约束'] }]);
  assert.deepEqual(arr[0].subsections, ['## 约束']);
  const obj = artifactTypesView([{ type: 'plan', dir: 'plan/', layer: 'plan', desc: 'd', subsections: { '## 约束': 3 } }]);
  assert.deepEqual(obj[0].subsections, { '## 约束': 3 });
});

test('③ elements 回显是**副本**（读端不得回写注册表）', () => {
  const src = ['goal'];
  const [v] = artifactTypesView([{ type: 'spec', dir: 'plan/', layer: 'plan', desc: 'd', elements: src }]);
  assert.deepEqual(v.elements, ['goal']);
  assert.notEqual(v.elements, src, '须为副本，防工具调用方改到注册表');
});

test('④ 缺省不声明 ⇒ 回显**不含**两键（既有 10 条键集零漂移）', () => {
  const view = artifactTypesView(ARTIFACT_TYPES);
  assert.equal(view.length, 10);
  for (const v of view) assert.deepEqual(Object.keys(v), ['type', 'dir', 'layer', 'desc'], v.type + ' 键集漂移');
});

test('④ 非数组 elements / subsections:null ⇒ 一律按「未声明」处理（不产出畸形键）', () => {
  const [a] = artifactTypesView([{ type: 'spec', dir: 'plan/', layer: 'plan', desc: 'd', elements: 'goal' }]);
  assert.equal('elements' in a, false);
  const [b] = artifactTypesView([{ type: 'spec', dir: 'plan/', layer: 'plan', desc: 'd', subsections: null }]);
  assert.equal('subsections' in b, false);
  const [c] = artifactTypesView([{ type: 'spec', dir: 'plan/', layer: 'plan', desc: 'd', elements: undefined }]);
  assert.equal('elements' in c, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 工具面：artifact_types 回显（core.js 唯一读端）+ output.schema 不收紧
// ─────────────────────────────────────────────────────────────────────────────

test('⑤ `artifact_types` 工具回显：缺省形态键集不变，且 execute 在场', async () => {
  assert.ok(byName.artifact_types, 'artifact_types 须注册');
  const r = await byName.artifact_types.execute({});
  assert.equal(r.types.length, 10);
  for (const t of r.types) assert.deepEqual(Object.keys(t), ['type', 'dir', 'layer', 'desc'], t.type + ' 工具回显键集漂移');
  const retro = r.types.find((t) => t.type === 'retrospective');
  assert.equal(retro.dir, 'audit/');
});

test('⑤ 工具回显与 artifactTypesView **逐字同源**（单一读端，防两套口径）', async () => {
  const r = await byName.artifact_types.execute({});
  assert.deepEqual(r.types, artifactTypesView(ARTIFACT_TYPES));
});

test('⑤ `output.schema` 不新增 required（additionalProperties:true 已允许可选新键）', () => {
  const schema = byName.artifact_types.output.schema;
  assert.deepEqual(schema.required, ['types'], '顶层 required 不得新增键');
  assert.equal(schema.additionalProperties, false, '顶层 additionalProperties 不变');
  assert.deepEqual(Object.keys(schema.properties), ['types'], '顶层属性面不新增');
  const val = schema.properties.types;
  assert.equal(val.type, 'array');
  assert.equal(val.items.additionalProperties, true, '条目须保持 additionalProperties:true（新键免 required 声明）');
  assert.equal(val.items.required, undefined, '条目层不得引入 required 白名单（新键须免声明）');
});
