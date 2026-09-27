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
// governance/preset-loader.ts —— preset 装载器：注册表/装载表/形状校验（引用键 → boot 装载）
// IO 边界：本模块是 governance 侧唯一读 preset 文件处（boot 装载一次 table → 注入 resolve 的
// presetTable；runtime 热更只管引用启用/停用，不管文件内容热切——preset 文件 = 发布资产语义，
// remount 不重读文件，fs.watch presets 目录归未来需求）。
// 依赖方向（防环）：校验纯函数（validatePresetRules 形状 / validateRuleTable 唯一性 /
//   validateToolBanEntries / validateToolBanTable）持有在 config.ts（resolve 同文件、单测既有直引
//   config.js 习惯）；本模块 import config.ts 的校验函数；config.ts 零 IO 零文件依赖不 import 本模块。
// 两类判定面（2026-09-14 第三类）：preset wrapper 允许 `rules`（参数级规则）与 `toolBan`
//   （工具黑名单条目）任一或并存——装载结果分派两张表：PresetTable（rules 面）与
//   PresetBanTable（toolBan 面，第三类）。l1-sensitive / l2-resource 走 rules 面，
//   l3-tool-ban 走 toolBan 面（该文件 rules 为空 ⇒ 不进 PresetTable）。
// 装载语义：
//   - PRESET_IDS = 注册 id 枚举（唯一权威，与 presets/hook-rules/ 四文件 stem 一致；
//     compose 组合项 2026-09-14 已废除——组合由多选叠加表达，不再是注册 id）；
//   - wrapper{_meta, rules?, toolBan?} 结构：JSON.parse → _meta 剥离只取 rules/toolBan（不洗条目对象——
//     kernel 消费纯 Rule[]/ToolBanEntry[]，零扩展字段）；形状校验（受控资产早失败）；
//   - 单文件失败 → 该 id 不入表 + errors 收集（不 throw——boot 可继续，装配侧 warn 留痕）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePresetRules, validateToolBanEntries, validateToolBanTable } from './config.js';
// 注册 id 枚举（唯一权威；runtime.json governance.hook.preset 仅接受这些 id，不接受任意路径）
//   2026-09-26 扩面：新增 `l5-wait-ban`（等待能力禁用：wait_agent + sleep），与 L1/L2（rules 面）、
//   L3（写通道路由，toolBan 面）并列。
export const PRESET_IDS = ['l1-sensitive', 'l2-resource', 'l3-tool-ban', 'l5-wait-ban'];
// 随包预设目录：<pkg>/presets/hook-rules/（由本模块位置上溯三级定位——lib/governance/preset-loader.js
//   → lib → 包根；开发/发布同构，files 已含 presets 整目录随包发布）
export const PRESETS_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'presets', 'hook-rules');
// 装载单个 preset 文件（wrapper{_meta,rules?,toolBan?}）：读 JSON → _meta 剥离 → 形状校验
//   （validatePresetRules 内含文件内 rule id 唯一 + regex 试编译；validateToolBanEntries 形状 +
//    validateToolBanTable 文件内 toolBan id 唯一）→ {rules, toolBan}。
//   id 未注册 / 文件缺失 / parse 失败 / 形状坏 / 两类判定面皆缺 → ok:false。
export function loadPresetFile(id, baseDir = PRESETS_DIR) {
    if (!PRESET_IDS.includes(id)) {
        return { ok: false, errors: [`未知 preset id '${id}'（注册 id 枚举：${PRESET_IDS.join(' / ')}）`] };
    }
    let raw;
    try {
        raw = readFileSync(join(baseDir, id + '.json'), 'utf8');
    }
    catch (e) {
        return { ok: false, errors: [`preset '${id}' 文件读取失败（${baseDir}/${id}.json）: ${String(e?.message ?? e)}`] };
    }
    if (raw.startsWith('\uFEFF'))
        raw = raw.slice(1); // UTF-8 BOM 容忍（跨平台文件编辑防御）
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return { ok: false, errors: [`preset '${id}' JSON.parse 失败: ${String(e?.message ?? e)}`] };
    }
    const wrapper = parsed;
    const hasRules = Array.isArray(wrapper?.rules);
    const hasBan = Array.isArray(wrapper?.toolBan);
    if (!wrapper || typeof wrapper !== 'object' || (!hasRules && !hasBan)) {
        return { ok: false, errors: [`preset '${id}' 顶层结构非法（须为 wrapper 对象 {"_meta":{...},"rules":[...]} 或 {"_meta":{...},"toolBan":[...]}，两者可并存）`] };
    }
    const rules = hasRules ? wrapper.rules : [];
    const shape = validatePresetRules(rules);
    if (!shape.ok) {
        return { ok: false, errors: shape.errors.map((e) => `preset '${id}' 形状校验失败: ${e}`) };
    }
    const toolBan = hasBan ? wrapper.toolBan : [];
    const banShape = validateToolBanEntries(toolBan);
    if (!banShape.ok) {
        return { ok: false, errors: banShape.errors.map((e) => `preset '${id}' 形状校验失败: ${e}`) };
    }
    const banUnique = validateToolBanTable(toolBan);
    if (!banUnique.ok) {
        return { ok: false, errors: banUnique.errors.map((e) => `preset '${id}' 形状校验失败: ${e}`) };
    }
    // _meta 剥离：只取 rules / toolBan（不洗规则对象——kernel 消费纯 Rule[]/ToolBanEntry[]；
    //   _meta 承载 JSON 注释不进收据/审计面）
    return { ok: true, rules: rules, toolBan: toolBan };
}
// 装载全部注册 id 成双表（boot 一次调用，注入 resolve opts.presetTable / opts.presetBanTable）：
//   单文件失败 → 该 id 不入表 + errors 收集（不 throw——boot 可继续，装配侧对 errors 逐条 warn 留痕）。
//   空面不入表（l3-tool-ban 无 rules ⇒ 不进 table；l1/l2 无 toolBan ⇒ 不进 banTable）——
//   catalog 计数 = 两表并计（l1 12 / l2 6 / l3 1）。
//   baseDir 可注入（单测注入坏文件目录验证容错路径）。
export function loadPresetTable(baseDir = PRESETS_DIR) {
    const table = {};
    const banTable = {};
    const errors = [];
    for (const id of PRESET_IDS) {
        const r = loadPresetFile(id, baseDir);
        if (!r.ok) {
            for (const e of r.errors)
                errors.push(e);
            continue;
        }
        if (r.rules.length > 0)
            table[id] = r.rules;
        if (r.toolBan.length > 0)
            banTable[id] = r.toolBan;
    }
    return { table, banTable, errors };
}
