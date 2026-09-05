import type { Rule } from './types.js';
export declare const PRESET_IDS: readonly string[];
export declare const PRESETS_DIR: string;
export type PresetTable = Readonly<Record<string, readonly Rule[]>>;
export type PresetLoadResult = {
    ok: true;
    rules: Rule[];
} | {
    ok: false;
    errors: string[];
};
export declare function loadPresetFile(id: string, baseDir?: string): PresetLoadResult;
export declare function loadPresetTable(baseDir?: string): {
    table: PresetTable;
    errors: string[];
};
