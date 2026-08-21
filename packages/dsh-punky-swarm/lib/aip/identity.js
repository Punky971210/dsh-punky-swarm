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

// 文件 identity：国标 P2/P3 身份骨架（仅签名与类型，全部 TODO 空实现）
// 本批不落任何实现逻辑；config.aip.enabled 开启时也不激活（identity 域默认永远 off，直到专批实现）
// 国标背景：OID 分层编码 1.2.156.3088 前缀（中国 OID 注册体系），身份管理 6 大角色
//（注册机构/凭证发行方/智能体/管理服务/互联服务/资源访问域）

/**
 * OID 身份码注册：为智能体/工具分配国标 OID 分层编码（前缀 1.2.156.3088）
 * @param {object} identity 待注册身份 { kind: 'agent'|'tool', name: string }
 * @returns {Promise<{ oid: string }>} 形如 1.2.156.3088.<sub>.<id> 的身份码
 */
export async function registerIdentity(identity) {
  // TODO(P3-13): 身份码注册（分配/持久化/查重）
  throw new Error('not implemented');
}

/**
 * 凭证发行：身份管理服务向已注册身份发行凭证（含有效期/主体绑定）
 * @param {object} identity 已注册身份 { oid: string, publicKey?: string }
 * @param {object} claims 附加声明 { role?, layer?, org? }
 * @returns {Promise<{ credential: object }>} 凭证对象（含签名占位）
 */
export async function issueCredential(identity, claims) {
  // TODO(P3-13): 凭证发行（凭证结构/签名/存证）
  throw new Error('not implemented');
}

/**
 * 数字签名：对载荷签名（私钥由身份持有，验签公钥入凭证）
 * @param {string|Buffer} payload 待签内容
 * @param {string} keyRef 私钥引用（不落盘明文，仅引用）
 * @returns {Promise<{ signature: string, algorithm: string }>}
 */
export async function sign(payload, keyRef) {
  // TODO(P3-13): 数字签名（算法选型：SM2 优先——国密合规）
  throw new Error('not implemented');
}

/**
 * 信任链验证：沿凭证链向上验证至根信任锚
 * @param {object} credential 待验凭证
 * @param {Array<object>} chain 上级凭证链（自近而远）
 * @returns {Promise<{ ok: boolean, reason?: string, depth: number }>}
 */
export async function verifyTrustChain(credential, chain) {
  // TODO(P3-13): 信任链验证（根锚配置/吊销检查/路径深度限制）
  throw new Error('not implemented');
}
