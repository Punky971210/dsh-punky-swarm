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

// lib/state/lane-exempt.js —— longrun 长程豁免「授予面」定义单点（档位表 + 载荷校验 + 归一化 + 存储形状）。
//
// 定位：豁免是**批次级可选字段** `batch.laneExempt`（laneId → LaneExemptGrant），
//   不是 `batch.lanes[lane]` 的形态变更——`lanes[lane]` 保持纯字符串（10+ 处字符串消费面零破坏），
//   旧批次无该键 → 视为「无豁免」，读取兼容零迁移（仿 assembly / laneProgress 的「无值不写键」模式）。
//
// 谁是写者：只有 `store.setMember` 的**派发面**（`pending→running` / `idle→running`）能写；
//   `store.revokeLaneExempt` 是唯一的撤销入口（显式调用，不改成员状态）。
//   成员自身在 running 中结构上调不出豁免（`lib/schema.ts` 的 running 后继不含 running/idle），
//   本模块只做「载荷合法性」判定，不做调用者身份判定（工具层无 identity，这是明文的诚实边界）。
//
// 零运行期依赖（纯常量 + 纯函数，无 import）：store.js 直接消费；探针层按需只读消费其判定结果。

// 豁免类型白名单（四值；未知值一律拒，不静默取默认——静默降级会造「以为拿到 8× 实拿 4×」的假绿灯）
export const LANE_EXEMPT_TYPES = ['ai-render', 'large-download', 'dep-install', 'none'];

// 档位默认表（类型 → 默认倍率）：只放宽**时长阈值** maxDurationMs，不放宽 noProgressWindowMs
//   （无进展窗被稀释 → checkpoint 新鲜度不再能证明「活着」，探针失去意义）
export const LANE_EXEMPT_TIERS = {
  'ai-render': 8,        // AI 绘画 / 渲染（ComfyUI 等，单张数分钟→小时）
  'large-download': 6,   // 大文件下载（模型权重 / 数据集）
  'dep-install': 4,      // 依赖库安装（npm / pip / 模型装包）
  'none': 4,             // 显式只用默认
};


// 显式倍率合法区间（闭区间；< 1 会收紧阈值，与「豁免」语义相反 → 拒）
const EXEMPT_MULTIPLIER_MIN = 1;
const EXEMPT_MULTIPLIER_MAX = 100;

// 4 个豁免门禁错误码（裸字面量 throw，形态同既有 `invalid member transition`——
//   不进 lib/state/gates.ts（那是门禁工厂）、不新增事件类型：它们是「参数面非法」，
//   无门禁载荷可留，与既有降级惯例一致）
export const EXEMPT_GATE_CODES = {
  NOT_DISPATCH: 'GATE_EXEMPT_NOT_DISPATCH',       // exempt 出现在 to!=='running'；或 revoke 与 status 并用
  INVALID: 'GATE_EXEMPT_INVALID',                 // 载荷结构非法（非对象 / type 非非空字符串 / multiplier 越界或非有限数 / stalled 非布尔）
  TYPE_UNKNOWN: 'GATE_EXEMPT_TYPE_UNKNOWN',       // type 不在白名单
  REVOKE_REQUIRED: 'GATE_EXEMPT_REVOKE_REQUIRED', // revokeExempt 但该 lane 无既有豁免（撤销只能对已授予豁免生效）
};

// 豁免类型 → 档位默认倍率（未知类型返回 null，由调用方抛 GATE_EXEMPT_TYPE_UNKNOWN；不静默兜底）
export function tierMultiplierOf(type) {
  return Object.prototype.hasOwnProperty.call(LANE_EXEMPT_TIERS, type) ? LANE_EXEMPT_TIERS[type] : null;
}

// 载荷校验（一步到位给「缺什么」的可读 reasons）：结构契约即下方校验序列
export function validateExemptPayload(exempt) {
  const reasons = [];
  if (exempt == null || typeof exempt !== 'object' || Array.isArray(exempt)) {
    reasons.push('exempt 须为对象（收到 ' + (exempt === null ? 'null' : Array.isArray(exempt) ? 'array' : typeof exempt) + '）');
    return { ok: false, reasons };
  }
  if (typeof exempt.type !== 'string' || exempt.type.length === 0) {
    reasons.push('type 须为非空字符串（收到 ' + JSON.stringify(exempt.type) + '）');
  }
  if (exempt.multiplier !== undefined) {
    if (typeof exempt.multiplier !== 'number' || !Number.isFinite(exempt.multiplier)) {
      reasons.push('multiplier 须为有限数（收到 ' + JSON.stringify(exempt.multiplier) + '）');
    } else if (exempt.multiplier < EXEMPT_MULTIPLIER_MIN || exempt.multiplier > EXEMPT_MULTIPLIER_MAX) {
      reasons.push('multiplier 须在 [' + EXEMPT_MULTIPLIER_MIN + ', ' + EXEMPT_MULTIPLIER_MAX + ']（收到 ' + exempt.multiplier + '；< 1 会收紧阈值，与豁免语义相反）');
    }
  }
  if (exempt.stalled !== undefined && typeof exempt.stalled !== 'boolean') {
    reasons.push('stalled 须为布尔（收到 ' + JSON.stringify(exempt.stalled) + '）');
  }
  return { ok: reasons.length === 0, reasons };
}

// 载荷归一化：**结构非法 upfront 抛 GATE_EXEMPT_INVALID**（同批多字段非法时按载荷一次性报全），
// 类型未知抛 GATE_EXEMPT_TYPE_UNKNOWN（detail 附合法值清单）。
// 返回 { type, multiplier, tierMultiplier, stalled } —— multiplier = 显式 > 档位表 > 兜底 1。
export function normalizeExemptPayload(exempt) {
  const v = validateExemptPayload(exempt);
  if (!v.ok) {
    throw new Error(EXEMPT_GATE_CODES.INVALID + ': exempt 载荷非法（' + v.reasons.join('; ') + '）');
  }
  const tierMultiplier = tierMultiplierOf(exempt.type);
  if (tierMultiplier === null) {
    throw new Error(EXEMPT_GATE_CODES.TYPE_UNKNOWN + ': 未知豁免类型 ' + JSON.stringify(exempt.type)
      + '（合法值：' + LANE_EXEMPT_TYPES.join(' / ') + '）');
  }
  return {
    type: exempt.type,
    multiplier: exempt.multiplier ?? tierMultiplier,
    tierMultiplier,
    stalled: exempt.stalled ?? true, // 缺省 true：豁免 lane 默认同时豁免 heartbeat stalled 追问
  };
}
