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

// assemble-panel.mjs — exec-panel-split lane 产物：lib/panel/ 段文件 → lib/client.js 浏览器 bundle
// 零依赖（仅 node:fs/node:path 内置模块），运行于包根目录：
//   node scripts/assemble-panel.mjs
// 拼接顺序：外壳头 + locales + theme + widgets + batch-list + batch-detail + main 组装 + 外壳尾
// （与 restructure-decision.md §6.2 一致）。段文件为单一事实源；本脚本只做逐字拼接。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // scripts/.. = 包根
const PANEL_DIR = join(ROOT, 'lib', 'panel');
const OUT = join(ROOT, 'lib', 'client.js');

// 外壳头 = AGPL 头 + 原 client.js 行 1-10（window.__ModuleLoader__.load 闭包开头 + react seed require）
// AGPL 头前置（决策包 §3.3）：每次拼装产物 client.js 顶部都恰有一个 AGPL 头，重生成幂等。
const SHELL_HEAD = `/*
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

window.__ModuleLoader__.load({
  id: "dsh-punky-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    "use strict";
    // dsh-punky-swarm 蟛蜞集群监控面板客户端（只读）：注册 conversation.view 第三分页（对话/轨迹/蟛蜞集群）
    const React = require('react');
    const { useState, useEffect } = React;
`;

// 外壳尾 = 原 client.js 行 573-574（factory 闭包收尾），逐字保留
const SHELL_TAIL = `  }
});
`;

// 段拼接顺序（与决策包 §6.2 一致；函数声明提升 + const 初始化序由段内顺序保证）
const SEGMENT_ORDER = [
  'locales.js',
  'theme.js',
  'widgets.js',
  'batch-list.js',
  'batch-detail.js',
  'main.js',
];

function readSegment(name) {
  // 决策包 §3.3 实现自选：拼装时剥离段文件顶部 AGPL 头块注释（段文件作为独立源文件保留头，
  // 但 bundle 内不嵌段头）——保证 client.js 全文 AGPL 授权文本恰 1 处、顶部恰 1 个头，重生成幂等。
  const src = readFileSync(join(PANEL_DIR, name), 'utf8');
  return src.replace(/^\/\*[\s\S]*?\*\/\n+/, '');
}

const body = SEGMENT_ORDER.map(readSegment).join(''); // 各段自带尾部换行，直接拼接
const out = SHELL_HEAD + '\n' + body + SHELL_TAIL;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out, 'utf8');
const lineCount = out.split('\n').length;
console.log(`[assemble-panel] wrote ${OUT} (${lineCount} lines, ${SEGMENT_ORDER.length} segments)`);
