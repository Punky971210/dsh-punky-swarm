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
export const BATCH_SCHEMA_V3 = 3;
export function chainsDefaults() {
    return { chains: {}, order: [] };
}
// laneProgress 缺省（undefined = 无断点进度）；对外显式化缺省语义，供消费方/测试引用
export function laneProgressDefaults() {
    return undefined;
}
// laneProgress 形态校验（批次级 plain object，值级校验由 resume.js isValidLaneProgress 承担）
export function isLaneProgress(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}
// lane.condition 缺省（null = 恒满足）；建批无 condition 声明时落此缺省
export function conditionDefaults() {
    return null;
}
export function migrateV2toV3(batch) {
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
        throw new Error('invalid batch: expected object');
    }
    const b = batch; // 单点断言：typeof/Array.isArray 守卫后为 plain object（字段操作面）
    if (b.schema === BATCH_SCHEMA_V3)
        return batch; // 幂等：已 v3 直接返回（不 clone，避免无谓分配）
    const next = { ...b };
    if (next.chains == null || typeof next.chains !== 'object' || Array.isArray(next.chains)) {
        next.chains = chainsDefaults();
    }
    // archived 迁移兜底（与 chains 兜底并列；chains/condition 逻辑不动）
    if (next.archived == null || typeof next.archived !== 'boolean') {
        next.archived = false;
    }
    // laneProgress 迁移兜底（幂等）——非法形态（非 plain object）归一为缺省（undefined）；
    // 合法形态原样保留（含空对象 {} = 无进度记录）；缺省 undefined 不写字段（零噪音，读兼容）
    if (next.laneProgress != null && !isLaneProgress(next.laneProgress)) {
        delete next.laneProgress;
    }
    next.schema = BATCH_SCHEMA_V3;
    // 边界断言（经 unknown 桥）：Record<string, unknown> 无 Batch 必填字段不充分重叠——迁移产物与 Batch 契约同源
    // （store.createBatch 形态 + 兜底字段），断言纯类型层、运行期零变更
    return next;
}
