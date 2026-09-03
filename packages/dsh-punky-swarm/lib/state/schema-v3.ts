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

// SchemaV3：batch schema v3 —— 新增可选字段 chains（C4 mailbox 环防护记账状态，batch JSON 唯一事实源）
//   + archived（done→archive：单向归档标记，布尔，缺省 false）
// chains shape（与 dsh-team TeamState.chains 同构）：
//   { chains: { [chainId]: { edges: { [from→to]: count }, said: { [from→to]: lastText } } }, order: [chainId] }
// 落点：batch.chains；v2→v3 迁移幂等（存量批次自动补 chains 默认 + archived:false，schema 升 3；已 v3 原样返回）
// lane 条件：condition 为 lane 级可选字段（wavePlan.wavePlan[].tasks[].condition，建批静态声明），
//   缺省 null = 恒满足（v2/v3 存量批次任务对象无该字段 → 读取天然兼容，不报错）；
//   迁移兜底由消费方（machine.checkDispatchCondition 见 null 即恒满足）+ 建批规范化共同保证，
//   migrateV2toV3 不遍历 wavePlan（chains 逻辑一字不动，避免触碰 batch 结构）。
// 断点指针：laneProgress 为批次级可选字段——
//   { laneProgress: { [laneId]: { step: number, total: number, status: 'running'|'review', updatedAt: ISO } } }
//   缺省 undefined（无进度记录 = 未断点）；status 与成员态对齐，不新增成员态；
//   沿用"可选字段 + migrate 幂等兜底"模式（不升大版本）：非法形态（非 plain object）归一为缺省，
//   存量 v3 批次缺字段 = 缺省，读取天然兼容；写入点/清退点由 lib/state/resume.js（断点指针接口）与 lane_checkpoint 承担。
// Phase 2 类型化：migrateV2toV3 输入 unknown（任意 JSON 解析产物最诚实），内部既有 typeof/Array.isArray 守卫保留，
//   字段操作在 Record<string, unknown> 上进行，边界断言返回 Batch——运行期语义零变更（断言纯类型层）。
import type { Batch, LaneProgressMap } from '../types/contracts.js';

export const BATCH_SCHEMA_V3 = 3;

export function chainsDefaults() {
  return { chains: {}, order: [] };
}

// laneProgress 缺省（undefined = 无断点进度）；对外显式化缺省语义，供消费方/测试引用
export function laneProgressDefaults() {
  return undefined;
}

// laneProgress 形态校验（批次级 plain object，值级校验由 resume.js isValidLaneProgress 承担）
export function isLaneProgress(v: unknown): v is LaneProgressMap {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// lane.condition 缺省（null = 恒满足）；建批无 condition 声明时落此缺省
export function conditionDefaults() {
  return null;
}

export function migrateV2toV3(batch: unknown): Batch {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    throw new Error('invalid batch: expected object');
  }
  const b = batch as Record<string, unknown>; // 单点断言：typeof/Array.isArray 守卫后为 plain object（字段操作面）
  if (b.schema === BATCH_SCHEMA_V3) return batch as Batch; // 幂等：已 v3 直接返回（不 clone，避免无谓分配）
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
  return next as unknown as Batch;
}
