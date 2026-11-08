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

import { engineVersion } from './tool-descriptor.js';

export const ACS_PROTOCOL_VERSION = '02.01';


export const ACS_OPTIONAL_FIELDS = Object.freeze([
  'iconUrl', 'documentationUrl', 'webAppUrl', 'entityUserId', 'entityMeta', 'certificate',
]);


export const ACS_SKILL_OPTIONAL_FIELDS = Object.freeze(['examples', 'inputModes', 'outputModes']);

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
 * - aic：注册服务分配的 OID 身份码——本引擎无 ARSP 注册，输出派生占位 `${team}.${layer}.${role}`，
 *   真实 AIC 需按 AIC 规范（10 级编码 + CRC-16 校验）由注册服务分配后经 engineInfo.aic 覆盖；
 */
export function buildAgentDescriptor(assembly, layer, role, engineInfo = {}) {
  const team = assembly.team ?? '';
  const layerCfg = assembly.layers?.[layer];
  const skillNames = Array.isArray(layerCfg?.skills?.[role]) ? layerCfg.skills[role] : [];
  const skillMetaMap = engineInfo.skillMeta ?? {};
  const skills = skillNames.map((name) => buildSkillDescriptor(name, skillMetaMap[name] ?? {}, engineInfo));
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

export function buildAgentCatalog(assembly, engineInfo = {}) {
  const descriptors = buildAgentDescriptors(assembly, engineInfo);
  return {
    generatedAt: engineInfo.generatedAt ?? new Date().toISOString(),
    descriptors: Object.freeze(descriptors),
    list() {
      return descriptors.slice();
    },
    // 【⑧-3 · 2026-11-08】接口与 `buildToolCatalog` 对齐（后者有 `get(name)`）——
    //   两套目录此前一个能按名取、一个只能全量列，调用方被迫各自 find。
    get(name) {
      return descriptors.find((d) => d.name === name) ?? null;
    },
  };
}

