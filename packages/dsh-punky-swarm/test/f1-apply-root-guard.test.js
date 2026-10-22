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

// F1 修复批次 `punky-fix-f1-20261022` · lane `e3-tester` · 缺陷 **A1-P0-01**（`apply` 顶层 `mkdirSync` 无守卫 +
// 启动日志晚于 IO）。
//
// 判据源 `plan/fix-spec.md` §方案 4 / §验收 T-4（Q3）：
//   ① `root` 不可建 ⇒ **抛错**（fail-closed：不吞、不 return、不降级继续）；
//   ② 错误消息三段可诊断：root **绝对路径** + 配置键 `config.root` + 原始 `e.code`；**不以** `GATE_` 开头（零新造拒码）；
//      `err.cause` 链在场；
//   ③ 启动日志**先于** IO：抛错时 `logger.info` 已含 `engine root: <root>；` 行，且它是 `apply` 的第一条 info；
//   ④ 正常 root ⇒ 不抛、文案逐字不变（`test/home-isolation.test.js` 的正则面）。
//
// 夹具选择（规格 §方案 4 明令）：**ENOTDIR**（root 路径中段是普通文件）——跨平台稳定、无需权限、不写系统目录；
//   **不用** EACCES/EPERM（full-access 沙箱下不可稳定构造）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { assemblyCtx, tempRoot } from './helpers/gate-fixture.mjs';

// ENOTDIR 夹具：`<tmp>/file.txt/child`，`file.txt` 是普通文件 ⇒ mkdir 必失败
function enotdirFixture(prefix) {
  const root = tempRoot(prefix);
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'not a directory', 'utf8');
  return { base: root, file, badRoot: path.join(file, 'child') };
}

test('T-4.1 A1-P0-01 root 不可建（ENOTDIR）⇒ apply 抛错：消息含 root 绝对路径 / config.root / 原始 code，不以 GATE_ 开头，cause 链在场', () => {
  const { badRoot } = enotdirFixture('punky-f1t41-');
  const ctx = assemblyCtx();
  let err = null;
  try {
    apply(ctx, { root: badRoot });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '必须抛错（fail-closed）：改前是裸 ENOTDIR 且无任何自有日志');
  const msg = String(err.message ?? '');
  assert.ok(msg.includes(badRoot), '① 消息须含 root **绝对路径**；实际=' + msg);
  assert.equal(path.isAbsolute(badRoot), true, '夹具前提：root 是绝对路径');
  assert.ok(msg.includes('config.root'), '② 消息须含配置键名 config.root（修复指向）');
  assert.ok(msg.includes('ENOTDIR'), '③ 消息须含原始 code（ENOTDIR）');
  assert.equal(msg.startsWith('GATE_'), false, '零新造拒码：不得以 GATE_ 前缀开头的错误码');
  assert.ok(err.cause, 'cause 链必须保留（可诊断性）');
  assert.equal(err.cause.code, 'ENOTDIR', 'cause.code 为原始错误码');
  assert.equal(fs.existsSync(badRoot), false, '确实没建成（抛错不是「建了再抛」的假象）');
});

test('T-4.2 A1-P0-01 启动日志先于 IO：同一 ENOTDIR 夹具抛错时，logger.info 已含 `engine root: <root>；` 且为第一条 info（改前为空）', () => {
  const { badRoot } = enotdirFixture('punky-f1t42-');
  const ctx = assemblyCtx();
  assert.throws(() => apply(ctx, { root: badRoot }));
  const infos = ctx.calls.info;
  assert.ok(infos.length >= 1, '抛错前必须已产出启动日志（改前该数组为空：日志在 mkdirSync 之后，永不达）');
  assert.equal(infos[0].includes('engine root: ' + badRoot + '；'), true,
    '首条 info 必须是引擎根日志且带**解析后的绝对路径**；实际首条=' + JSON.stringify(infos[0]));
  assert.ok(/engine root:\s*(.+?)；/.test(infos[0]), '文案须仍匹配 `test/home-isolation.test.js` 的正则面（逐字未改）');
});

test('T-4.3 A1-P0-01 阳性对照：可建 root ⇒ 不抛、启动日志照常（同文案同位置），且 disposer 可用', () => {
  const goodRoot = tempRoot('punky-f1t43-');
  const ctx = assemblyCtx();
  let disposer = null;
  assert.doesNotThrow(() => { disposer = apply(ctx, { root: goodRoot }); }, '正常 root 不得抛（守卫不得误伤正路）');
  assert.ok(typeof disposer === 'function', 'apply 返回 disposer');
  assert.equal(fs.existsSync(goodRoot), true, 'root 已建');
  assert.ok(ctx.calls.info.some((line) => line.includes('engine root: ' + goodRoot + '；')), '启动日志照常（文案逐字不变）');
  assert.equal(ctx.calls.info[0].includes('engine root: ' + goodRoot + '；'), true, '日志位置同前（首条 info）');
  disposer();
});
