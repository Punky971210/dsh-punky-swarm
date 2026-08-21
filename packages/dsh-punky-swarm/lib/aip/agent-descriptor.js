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

// 文件 agent-descriptor：国标 P4（GB/Z 185.4-2026《智能体描述》）14+8 属性映射（P1-3）
// 契约：纯函数——输入装配配置（team/layer/role/skills）+ 引擎信息，输出每 role 一份
//       14 项属性 + 8 项技能属性的国标描述 JSON；零副作用、不消费运行时、可单测。
// 装配 enabled 开关：本文件不自行检查开关（保持纯函数），由调用方（register.js 装配解析
//       注入点）按 config.aip.enabled === true 门控后调用；enabled 非 true 时不生成、零开销
//       （与 P0-1 tool-descriptor 共用开关语义，决策包 §2.4 / §6）。
// ⚠ 校准注记（决策包 §2.1，如实保留）：字段全集以国标正式文本 GB/Z 185.4-2026 为准；
//   下表为基于 AIP 协议（Discovery 原语）与既有装配/技能体系的推导映射，实施前需校准国标
//   原文（openatom 解读 https://aip.openatom.tech/explore/journalism/detail/501599532505763840 ；
//   GB/Z 185.4-2026 文本 https://www.bzchaxun.com/view/6040053112000000.html ）。
//   派生值标记：固定值 = 本批契约推导；预留 = P3-13 / 后续批次填充。
// 仅用内建能力，零新增依赖（红线：不改 node_modules）。

// ── 工具名全集（14，与 register.js 聚合一致；capabilities 由 layer 推导用）──
// 决策包 §1.2 14 工具清单：core 11 + mailbox 3；lane-tools.js 为 0 骨架
const ALL_TOOLS = [
  'wave_plan', 'batch_phase', 'batch_status', 'artifact_types', 'assign_check',
  'asset_claim', 'gate_status', 'lane_claim', 'lane_release', 'member_settle',
  'member_status', 'mailbox_send', 'mailbox_read', 'mailbox_ack',
];

// layer → capabilities 推导（决策包 §2.2 #6：plan→[wave_plan,batch_phase,…]、
// exec→全部 14、audit→[gate_status,batch_status,…]；具体清单从治理工具集推导，实施时可调）
// - plan  层：规划/建批/门禁判定类治理工具（无写执行的执行面）
// - exec  层：全部 14（执行面完整，含 mailbox 收发与批次推进）
// - audit 层：只读核验类（查询/门禁/产物核验，无副作用写）
const LAYER_CAPABILITIES = {
  plan: ['wave_plan', 'batch_phase', 'batch_status', 'artifact_types', 'assign_check', 'gate_status'],
  exec: ALL_TOOLS,
  audit: ['batch_status', 'artifact_types', 'gate_status', 'member_status', 'mailbox_read'],
};

// 引擎默认版本：对齐 package.json version（0.2.1）；调用方可经 engineInfo.version 覆盖
const DEFAULT_ENGINE_VERSION = '0.2.1';

// ── 8 项技能属性映射（决策包 §2.3；来源：SKILL.md front matter 解析结果，经 engineInfo.skillMeta 注入）──

/**
 * 单技能 → 国标 8 项技能属性
 * @param {string} skillName 技能名（= assembly.skills[role] 中的名字，如 'dev-coder'）
 * @param {object} [meta] SKILL.md front matter 解析子集：{ description?, version?, triggers? }
 * @param {object} [engineInfo] { version? } 引擎信息（技能 version 缺省回退用）
 * @returns {object} 8 项技能属性 JSON
 */
export function buildSkillDescriptor(skillName, meta = {}, engineInfo = {}) {
  const version = meta.version ?? engineInfo.version ?? DEFAULT_ENGINE_VERSION;
  return {
    skillId: `dsh.skill.${skillName}`, // 派生：与 toolId 同风格（决策包 §2.3 #1）
    name: skillName,                    // 透传（决策包 §2.3 #2）
    description: meta.description ?? skillName, // 透传 front matter description（决策包 §2.3 #3）
    version,                            // front matter version ?? 引擎版本（决策包 §2.3 #4）
    inputParams: [],                    // 推导：[] 起步，技能多为指令式触发，参数化留后续（决策包 §2.3 #5）
    outputParams: [],                   // 推导：[] 起步（决策包 §2.3 #6）
    triggerConditions: meta.triggers ?? [], // 推导：front matter triggers（若有）（决策包 §2.3 #7）
    dependencies: [],                   // 技能包自包含（决策包 §2.3 #8）
  };
}

/**
 * 装配角色 → 国标 14 项属性 + 8 项技能属性描述（单角色）
 * @param {object} assembly 装配配置 { team, layers: { <layer>: { roles: string[], skills: { [role]: string[] } } }, owner? }
 * @param {string} layer 层名（plan/exec/audit）
 * @param {string} role 角色名（如 'coder'）
 * @param {object} [engineInfo] { version?, owner?, skillMeta? }
 *   skillMeta: { [skillName]: { description?, version?, triggers? } } SKILL.md front matter 解析结果注入
 * @returns {object} 14 项属性 JSON（含 skills 8 项数组）
 */
export function buildAgentDescriptor(assembly, layer, role, engineInfo = {}) {
  const team = assembly.team ?? 'generic';
  const layerCfg = assembly.layers?.[layer];
  const skillNames = Array.isArray(layerCfg?.skills?.[role]) ? layerCfg.skills[role] : [];
  const skillMetaMap = engineInfo.skillMeta ?? {};
  const skills = skillNames.map((name) => buildSkillDescriptor(name, skillMetaMap[name] ?? {}, engineInfo));
  // description：取 skills[0] 对应 SKILL.md description；无则用 role 名（决策包 §2.2 #3）
  const description = skills[0]?.description ?? role;
  return {
    // ── 14 项属性（决策包 §2.2）──
    agentId: `${team}.${layer}.${role}`,        // 派生：team.layer.role（决策包 §2.2 #1，与 toolId 同风格）
    name: role,                                  // 透传（决策包 §2.2 #2）
    description,                                 // 首技能 SKILL.md description ?? role 名（决策包 §2.2 #3）
    version: engineInfo.version ?? DEFAULT_ENGINE_VERSION, // 引擎版本，可被 config 覆盖（决策包 §2.2 #4）
    owner: assembly.owner ?? engineInfo.owner ?? 'dsh',    // 装配来源 ?? 默认 dsh（决策包 §2.2 #5）
    capabilities: LAYER_CAPABILITIES[layer] ?? [],          // 由 layer 推导（决策包 §2.2 #6）
    skills,                                    // assembly.skills[role] 的 8 项数组（决策包 §2.2 #7）
    interactionModes: ['point-to-point', 'group'], // 固定：mailbox 三件套语义（决策包 §2.2 #8）
    communicationProtocols: ['dsh-file-mailbox'],  // 固定：mailbox 文件协议（决策包 §2.2 #9；P2-9 封装后补国标协议名）
    securityLevel: 'session-isolated',             // 固定推导：会话隔离/锁（决策包 §2.2 #10）
    trustLevel: null,                              // 预留：P3-13 信任链接入后填充（决策包 §2.2 #11）
    region: null,                                  // 预留：部署信息，缺省不填（决策包 §2.2 #12）
    language: 'zh-CN',                             // 预留：装配/技能主语言（决策包 §2.2 #13）
    serviceLevel: null,                            // 预留：P3-13 凭证发行后填充（决策包 §2.2 #14）
  };
}

/**
 * 装配配置 → 全部角色的 14+8 属性描述列表（P1-3 主入口）
 * 遍历 assembly.layers[*].roles[*]，每 role 生成一份描述（决策包 §2.4）
 * @param {object} assembly 装配配置 { team, layers: { <layer>: { roles, skills } }, owner? }
 * @param {object} [engineInfo] { version?, owner?, skillMeta? }（见 buildAgentDescriptor）
 * @returns {Array<object>} 每 role 一份 14 项属性 JSON（含 skills 8 项数组）
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
