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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePresetRules, validateToolBanEntries, validateToolBanTable } from './config.js';
export const PRESET_IDS = ['l1-sensitive', 'l2-resource', 'l3-tool-ban', 'l5-wait-ban'];
export const PRESETS_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'presets', 'hook-rules');
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
        raw = raw.slice(1);
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
    return { ok: true, rules: rules, toolBan: toolBan };
}
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
