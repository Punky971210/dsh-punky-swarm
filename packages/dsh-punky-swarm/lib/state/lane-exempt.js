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

export const LANE_EXEMPT_TYPES = ['ai-render', 'large-download', 'dep-install', 'none'];

export const LANE_EXEMPT_TIERS = {
  'ai-render': 8,
  'large-download': 6,
  'dep-install': 4,
  'none': 4,
};


const EXEMPT_MULTIPLIER_MIN = 1;
const EXEMPT_MULTIPLIER_MAX = 100;

export const EXEMPT_GATE_CODES = {
  NOT_DISPATCH: 'GATE_EXEMPT_NOT_DISPATCH',
  INVALID: 'GATE_EXEMPT_INVALID',
  TYPE_UNKNOWN: 'GATE_EXEMPT_TYPE_UNKNOWN',
};

export function tierMultiplierOf(type) {
  return Object.prototype.hasOwnProperty.call(LANE_EXEMPT_TIERS, type) ? LANE_EXEMPT_TIERS[type] : null;
}

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
    stalled: exempt.stalled ?? true,
  };
}
