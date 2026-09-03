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

// 文件 agent-descriptor：国标 P4（GB/Z 185.4-2026《智能体描述》）描述生成器
// 契约：纯函数——输入装配配置（team/layer/role/skills）+ 引擎信息，输出每 role 一份描述 JSON；
//       零副作用、不消费运行时、可单测。
// ⚠ 2026-08 校准（覆盖旧 14+8 口径）：字段集以 ACS（Agent Capability Specification）原文为准——
//   registry-server/app/agent/acsSchema.json（JSON Schema 全文）为逐字字段来源；
//   旧「14+8 兼容映射层」（toLegacyDescriptor / toLegacySkill + ALL_TOOLS / LAYER_CAPABILITIES）
//   已移除（P2-06）：ACPs 兼容路径中无调用——ACPs 描述直接消费 buildAgentDescriptor 的 ACS 格式
//   （server.js:37,136 装配），描述以 ACS 格式为准。
// 派生值标记：固定值 = 本文件推导；预留 = 后续填充。
// 仅用内建能力，零新增依赖（红线：不改 node_modules）。
import { engineVersion } from './tool-descriptor.js';

// ACPs 协议版本（acsSchema.json examples：["02.01"]）
export const ACS_PROTOCOL_VERSION = '02.01';

// ACS AgentCapabilitySpec 必填 14 键（acsSchema.json required 数组原文）
export const ACS_REQUIRED_FIELDS = Object.freeze([
  'aic', 'active', 'lastModifiedTime', 'protocolVersion', 'name', 'description',
  'version', 'provider', 'securitySchemes', 'endPoints', 'capabilities',
  'defaultInputModes', 'defaultOutputModes', 'skills',
]);

// ACS AgentCapabilitySpec 可选键（acsSchema.json properties 全集 − required）
export const ACS_OPTIONAL_FIELDS = Object.freeze([
  'iconUrl', 'documentationUrl', 'webAppUrl', 'entityUserId', 'entityMeta', 'certificate',
]);

// ACS AgentSkill 必填 5 键（acsSchema.json $defs.AgentSkill required 数组原文）
export const ACS_SKILL_REQUIRED_FIELDS = Object.freeze(['id', 'name', 'description', 'version', 'tags']);

// ACS AgentSkill 可选键
export const ACS_SKILL_OPTIONAL_FIELDS = Object.freeze(['examples', 'inputModes', 'outputModes']);

/**
 * 单技能 → ACS AgentSkill（8 字段，逐字名见 acsSchema.json $defs.AgentSkill）
 * 必填 5 键恒输出；可选 3 键（examples/inputModes/outputModes）仅在提供时输出（对齐参考实现
 * demo acs.json 风格——真实数据才带，不臆造空数组）。
 * @param {string} skillName 技能名（= assembly.skills[role] 中的名字，如 'dev-coder'）
 * @param {object} [meta] SKILL.md front matter 解析子集：
 *   { description?, version?, tags?, examples?, inputModes?, outputModes?, id? }
 * @param {object} [engineInfo] { version? } 引擎信息（技能 version 缺省回退用）
 * @returns {object} ACS AgentSkill
 */
export function buildSkillDescriptor(skillName, meta = {}, engineInfo = {}) {
  const version = meta.version ?? engineInfo.version ?? engineVersion();
  const skill = {
    id: meta.id ?? `dsh.skill.${skillName}`, // 派生：与 toolId 同风格（旧口径同规则）；meta.id 可覆盖
    name: skillName,                          // 透传（= 装配技能名）
    description: meta.description ?? skillName, // 透传 front matter description
    version,                                  // front matter version ?? 引擎版本
    tags: Array.isArray(meta.tags) ? [...meta.tags] : [], // front matter tags ?? 空数组（必填键恒在）
  };
  for (const k of ACS_SKILL_OPTIONAL_FIELDS) {
    if (meta[k] !== undefined && meta[k] !== null) skill[k] = meta[k];
  }
  return skill;
}

/**
 * 装配角色 → ACS AgentCapabilitySpec（Agent 描述，逐字字段名见 acsSchema.json 根对象）
 * 必填 14 键恒输出（值取诚实推导默认，可经 engineInfo 覆盖）；可选 6 键仅在提供时输出。
 * 派生值说明（诚实标注，spec §3.2）：
 * - aic：注册服务分配的 OID 身份码——本引擎无 ARSP 注册，输出派生占位 `${team}.${layer}.${role}`，
 *   真实 AIC 需按 spec §3.4（10 级编码 + CRC-16 校验）由注册服务分配后经 engineInfo.aic 覆盖；
 * - active：默认 true（引擎装配角色即可用），engineInfo.active 可覆盖；
 * - lastModifiedTime：ISO 8601；engineInfo.lastModifiedTime ?? engineInfo.generatedAt ?? 当前时刻；
 * - provider：{ countryCode: 'CN', organization: owner ?? 'dsh' }（AgentProvider 全可选字段）；
 * - securitySchemes：默认 {}（引擎 agent 经本地文件 mailbox 通信、无网络认证声明；接入真实
 *   端点时经 engineInfo.securitySchemes 注入，如 mutualTLS）；
 * - endPoints：默认 []（引擎 agent 非网络服务端点；接入时经 engineInfo.endPoints 注入）；
 * - capabilities：默认 { streaming:false, notification:false, messageQueue:[] }（如实：无 SSE/
 *   异步推送/MQ），engineInfo.capabilities 可覆盖；
 * - defaultInputModes / defaultOutputModes：默认 ['text/plain','application/json']（指令文本 +
 *   JSON 参数/回执，引擎 mailbox/工具层实际承载格式）。
 * @param {object} assembly 装配配置 { team, layers: { <layer>: { roles: string[], skills: { [role]: string[] } } }, owner? }
 * @param {string} layer 层名（plan/exec/audit）
 * @param {string} role 角色名（如 'coder'）
 * @param {object} [engineInfo] ACS 覆盖 + 引擎信息：
 *   { version?, owner?, skillMeta?, generatedAt?, aic?, active?, lastModifiedTime?, protocolVersion?,
 *     iconUrl?, documentationUrl?, webAppUrl?, provider?, securitySchemes?, endPoints?,
 *     capabilities?, defaultInputModes?, defaultOutputModes?, entityUserId?, entityMeta?, certificate? }
 *   skillMeta: { [skillName]: { description?, version?, tags?, examples?, inputModes?, outputModes? } }
 * @returns {object} ACS AgentCapabilitySpec
 */
export function buildAgentDescriptor(assembly, layer, role, engineInfo = {}) {
  const team = assembly.team ?? 'generic';
  const layerCfg = assembly.layers?.[layer];
  const skillNames = Array.isArray(layerCfg?.skills?.[role]) ? layerCfg.skills[role] : [];
  const skillMetaMap = engineInfo.skillMeta ?? {};
  const skills = skillNames.map((name) => buildSkillDescriptor(name, skillMetaMap[name] ?? {}, engineInfo));
  // description：取 skills[0] 对应 SKILL.md description；无则用 role 名
  const description = skills[0]?.description ?? role;
  const owner = assembly.owner ?? engineInfo.owner ?? 'dsh';

  const descriptor = {
    aic: engineInfo.aic ?? `${team}.${layer}.${role}`, // 派生占位；真实 AIC 需注册服务分配（见上）
    active: engineInfo.active ?? true,
    lastModifiedTime: engineInfo.lastModifiedTime ?? engineInfo.generatedAt ?? new Date().toISOString(),
    protocolVersion: engineInfo.protocolVersion ?? ACS_PROTOCOL_VERSION,
    name: role,                                        // 透传（= 角色名）
    description,                                       // 首技能 SKILL.md description ?? role 名
    version: engineInfo.version ?? engineVersion(),    // 引擎版本，可被 config 覆盖
    provider: engineInfo.provider ?? { countryCode: 'CN', organization: owner }, // AgentProvider 派生
    securitySchemes: engineInfo.securitySchemes ?? {}, // 默认空（如实：无网络认证声明）
    endPoints: engineInfo.endPoints ?? [],             // 默认空数组（schema default）
    capabilities: engineInfo.capabilities ?? { streaming: false, notification: false, messageQueue: [] },
    defaultInputModes: engineInfo.defaultInputModes ?? ['text/plain', 'application/json'],
    defaultOutputModes: engineInfo.defaultOutputModes ?? ['text/plain', 'application/json'],
    skills,                                            // assembly.skills[role] 的 ACS AgentSkill 数组
  };
  for (const k of ACS_OPTIONAL_FIELDS) {
    if (engineInfo[k] !== undefined && engineInfo[k] !== null) descriptor[k] = engineInfo[k];
  }
  return descriptor;
}

/**
 * 装配配置 → 全部角色的 ACS AgentCapabilitySpec 列表（主入口）
 * 遍历 assembly.layers[*].roles[*]，每 role 生成一份描述
 * @param {object} assembly 装配配置（见 buildAgentDescriptor）
 * @param {object} [engineInfo]（见 buildAgentDescriptor）
 * @returns {Array<object>} 每 role 一份 ACS AgentCapabilitySpec
 */
export function buildAgentDescriptors(assembly, engineInfo = {}) {
  const layers = assembly?.layers ?? {};
  const descriptors = [];
  for (const layer of Object.keys(layers)) {
    const roles = layers[layer]?.roles ?? [];
    for (const role of roles) {
      descriptors.push(buildAgentDescriptor(assembly, layer, role, engineInfo));
    }
  }
  return descriptors;
}

/**
 * 智能体描述目录快照（对齐 buildToolCatalog 形态）：持有全量 ACS 描述 + 只读 list()；
 * 供 register.js 按 aip.enabled 门控生成、api.js 挂 /agents 只读端点。
 * @param {object} assembly 装配配置
 * @param {object} [engineInfo]（见 buildAgentDescriptor；建议传 generatedAt 固定 lastModifiedTime）
 * @returns {{ generatedAt: string, descriptors: ReadonlyArray<object>, list(): object[] }}
 */
export function buildAgentCatalog(assembly, engineInfo = {}) {
  const descriptors = buildAgentDescriptors(assembly, engineInfo);
  return {
    generatedAt: engineInfo.generatedAt ?? new Date().toISOString(),
    descriptors: Object.freeze(descriptors),
    list() {
      return descriptors.slice();
    },
  };
}

