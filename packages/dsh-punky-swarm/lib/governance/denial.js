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

// 拒因分级：从拒码反推「该做什么」的唯一单点。
//   分级按**根因**（`errorFamily` 由产生点按成因直接给出），不按 message 文本匹配 ——
//   文案一改就失效，靠正则从消息里猜族是最脆的形态。
//   同一族的不同码 ⇒ **同一动作**：动作取决于「哪一类原因」，不取决于「具体哪一个码」。

export const ERROR_FAMILY_UNMAPPED = 'error-family-unmapped:';

export const DENIAL_FAMILIES = Object.freeze(['tier', 'mode', 'allowlist', 'approval']);

const REPAIR_ACTION_BY_FAMILY = Object.freeze({
  tier: 'assess', // 先做只读侦察再 assign_check，写入难度与判据
  mode: 'switch-mode', // 当前模式不生效 ⇒ 换到该模式允许的路径
  allowlist: 'grant-allowlist', // 不在白名单 ⇒ 由调用方把工具/参数加进 tools.allowlist
  approval: 'obtain-approval', // 需批准 ⇒ 取得批准票据（摘要须与当前参数一致）
});

export function repairActionOf(errorFamily) {
  if (typeof errorFamily !== 'string' || errorFamily.length === 0) {
    throw new Error(ERROR_FAMILY_UNMAPPED + ' <empty>（族名须为非空字符串）');
  }
  const action = REPAIR_ACTION_BY_FAMILY[errorFamily];
  if (action === undefined) {
    throw new Error(ERROR_FAMILY_UNMAPPED + ' ' + errorFamily + '（已映射族：' + DENIAL_FAMILIES.join('/') + '）');
  }
  return action;
}

export function classifyDenial(denial) {
  const errorFamily = denial?.errorFamily;
  const errorCode = denial?.errorCode;
  if (typeof errorCode !== 'string' || errorCode.length === 0) {
    throw new Error(ERROR_FAMILY_UNMAPPED + ' ' + String(errorFamily) + ' <errorCode 缺失>（每个拒码都必须有动作）');
  }
  return { errorFamily, errorCode, action: repairActionOf(errorFamily) };
}
