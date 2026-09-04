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

// governance/preset-loader.ts —— M5-b preset 装载（preset-build-20260903，preset-impl 设计 §2.4）
// IO 边界：本模块是 governance 侧唯一读 preset 文件处（boot 装载一次 table → 注入 resolve 的
// presetTable；runtime 热更只管引用启用/停用，不管文件内容热切——preset 文件 = 发布资产语义，
// remount 不重读文件，fs.watch presets 目录归未来需求）。
// 依赖方向（防环，设计 §2.4）：校验纯函数（validatePresetRules 形状 / validateRuleTable 唯一性）
//   持有在 config.ts（resolve 同文件、单测既有直引 config.js 习惯）；本模块 import config.ts 的
//   校验函数；config.ts 零 IO 零文件依赖不 import 本模块。
// 装载语义：
//   - PRESET_IDS = 注册 id 枚举（唯一权威，与 presets/hook-rules/ 三文件 stem 一致）；
//   - wrapper{_meta, rules} 结构：JSON.parse → _meta 剥离只取 rules（不洗规则对象——
//     kernel 消费纯 Rule[]，零扩展字段）；形状校验 validatePresetRules（受控资产早失败）；
//   - 单文件失败 → 该 id 不入表 + errors 收集（不 throw——boot 可继续，装配侧 warn 留痕）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rule } from './types.js';
import { validatePresetRules } from './config.js';

// 注册 id 枚举（唯一权威；runtime.json governance.hook.preset 仅接受这些 id，不接受任意路径）
export const PRESET_IDS: readonly string[] = ['l1-sensitive', 'l2-resource', 'compose'];

// 随包预设目录：<pkg>/presets/hook-rules/（由本模块位置上溯三级定位——lib/governance/preset-loader.js
//   → lib → 包根；开发/发布同构，files 已含 presets 整目录随包发布，package.json A8）
export const PRESETS_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'presets', 'hook-rules');

export type PresetTable = Readonly<Record<string, readonly Rule[]>>;

export type PresetLoadResult =
  | { ok: true; rules: Rule[] }
  | { ok: false; errors: string[] };

// 装载单个 preset 文件（wrapper{_meta,rules}）：读 JSON → _meta 剥离 → 形状校验（validatePresetRules
//   内含文件内 id 唯一 + regex 试编译）→ Rule[]。id 未注册 / 文件缺失 / parse 失败 / 形状坏 → ok:false。
export function loadPresetFile(id: string, baseDir = PRESETS_DIR): PresetLoadResult {
  if (!PRESET_IDS.includes(id)) {
    return { ok: false, errors: [`未知 preset id '${id}'（注册 id 枚举：${PRESET_IDS.join(' / ')}）`] };
  }
  let raw: string;
  try {
    raw = readFileSync(join(baseDir, id + '.json'), 'utf8');
  } catch (e) {
    return { ok: false, errors: [`preset '${id}' 文件读取失败（${baseDir}/${id}.json）: ${String((e as Error)?.message ?? e)}`] };
  }
  if (raw.startsWith('\uFEFF')) raw = raw.slice(1); // UTF-8 BOM 容忍（跨平台文件编辑防御）
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`preset '${id}' JSON.parse 失败: ${String((e as Error)?.message ?? e)}`] };
  }
  const wrapper = parsed as { _meta?: unknown; rules?: unknown } | null | undefined;
  if (!wrapper || typeof wrapper !== 'object' || !Array.isArray(wrapper.rules)) {
    return { ok: false, errors: [`preset '${id}' 顶层结构非法（须为 wrapper 对象 {"_meta":{...},"rules":[...]}）`] };
  }
  const shape = validatePresetRules(wrapper.rules);
  if (!shape.ok) {
    return { ok: false, errors: shape.errors.map((e) => `preset '${id}' 形状校验失败: ${e}`) };
  }
  // _meta 剥离：只取 rules（不洗规则对象——kernel 消费纯 Rule[]；_meta 承载 JSON 注释不进收据/审计面）
  return { ok: true, rules: wrapper.rules as Rule[] };
}

// 装载全部注册 id 成表（boot 一次调用，注入 resolve opts.presetTable）：
//   单文件失败 → 该 id 不入表 + errors 收集（不 throw——boot 可继续，装配侧对 errors 逐条 warn 留痕）。
//   baseDir 可注入（单测注入坏文件目录验证容错路径）。
export function loadPresetTable(baseDir = PRESETS_DIR): { table: PresetTable; errors: string[] } {
  const table: Record<string, readonly Rule[]> = {};
  const errors: string[] = [];
  for (const id of PRESET_IDS) {
    const r = loadPresetFile(id, baseDir);
    if (r.ok) table[id] = r.rules;
    else for (const e of r.errors) errors.push(e);
  }
  return { table, errors };
}
