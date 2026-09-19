import type { Rule, ToolBanEntry } from './types.js';
export declare const PRESET_IDS: readonly string[];
export declare const PRESETS_DIR: string;
export type PresetTable = Readonly<Record<string, readonly Rule[]>>;
export type PresetBanTable = Readonly<Record<string, readonly ToolBanEntry[]>>;
export type PresetLoadResult = {
    ok: true;
    rules: Rule[];
    toolBan: ToolBanEntry[];
} | {
    ok: false;
    errors: string[];
};
export declare function loadPresetFile(id: string, baseDir?: string): PresetLoadResult;
export declare function loadPresetTable(baseDir?: string): {
    table: PresetTable;
    banTable: PresetBanTable;
    errors: string[];
};
