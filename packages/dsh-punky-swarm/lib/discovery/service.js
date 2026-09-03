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

// ADP 发现服务（Agent Discovery Protocol）：独立模块，核心无感知。
// 消费 tool-descriptor catalog（工具目录）与 agent-descriptor 目录（智能体描述），
// 提供 POST /discover 语义查询（type: explicit/exploratory/trending/filtered）+ .well-known 预置。
// 基准：ACPs-community v2.1.0（discovery-server/app/discovery/service.py 响应构造 + acps_sdk/adp 模型）。
// active 语义：装配可配 discovery.enabled（默认开）；节点 active=false 不出现在查询结果（读 config 键，默认 active=true）。

import {
  QUERY_TYPES, QUERY_TYPE_EXPLICIT, ADP_ERROR, FILTER_OPERATORS,
  validateDiscoveryRequest, normalizeLimit, successResponse, failureResponse,
} from './schema.js';
import { evaluateFilter } from './filter.js';

const LOCAL_SERVER_AIC = 'AIC-DS-A'; // 参考实现 _build_response 默认 forwardChain 首跳占位（服务自身 AIC）

// ── 内部条目模型 ──
// entry = { aic, name, description, version, active, skills: AgentSkill[], acs: <原始描述>, acsView: <ACS 形状归一视图> }
// AgentSkill = { id, name, description, version, tags }
// acsView：filter 条件作用于 ACS 形状字段（aic/active/name/description/version/skills.*），
//   与原始描述（tool 6 属性 / agent 14+8）解耦——filter 引擎不感知描述器内部字段形态。
function toAgentSkill(skill) {
  return {
    id: skill.skillId ?? skill.id ?? '',
    name: skill.name ?? '',
    description: skill.description ?? '',
    version: skill.version ?? '',
    tags: Array.isArray(skill.tags) ? skill.tags : [],
  };
}

function buildAcsView(entry) {
  return {
    aic: entry.aic,
    active: entry.active,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    skills: entry.skills,
  };
}

// 节点 active 判定：config.nodes[<aic|name>].active === false → 隐藏；描述自带 active=false → 隐藏；缺省 active=true
function isNodeActive(entry, nodes) {
  const override = nodes?.[entry.aic] ?? nodes?.[entry.name];
  if (override && typeof override === 'object' && override.active === false) return false;
  if (entry.acs && typeof entry.acs === 'object' && entry.acs.active === false) return false;
  return true;
}

export function createDiscoveryService({ catalog, agentDescriptors = [], config = {} }) {
  // config = capabilities.discovery 解析结果（{ enabled, nodes }）
  const nodes = (config && typeof config.nodes === 'object' && config.nodes) || {};

  // ── 目录装配：工具条目（tool-descriptor catalog）+ 智能体条目（agent-descriptor 目录）──
  const entries = [];

  // 工具：每个工具 = 一条目，技能 = 工具自身（P7 载体：skill 即 tool）
  const toolList = (catalog && typeof catalog.list === 'function') ? catalog.list() : [];
  for (const d of toolList) {
    const entry = {
      aic: d.toolId ?? d.name ?? '',
      name: d.name ?? '',
      description: d.description ?? '',
      version: d.version ?? '',
      skills: [{ id: d.toolId ?? d.name ?? '', name: d.name ?? '', description: d.description ?? '', version: d.version ?? '', tags: [] }],
      acs: d,
      kind: 'tool',
    };
    entry.active = isNodeActive(entry, nodes);
    entry.acsView = buildAcsView(entry);
    entries.push(entry);
  }

  // 智能体：agent-descriptor 目录（每 role 一份描述）
  for (const d of agentDescriptors) {
    const skills = Array.isArray(d.skills) ? d.skills.map(toAgentSkill) : [];
    const entry = {
      aic: d.agentId ?? d.aic ?? '',
      name: d.name ?? '',
      description: d.description ?? '',
      version: d.version ?? '',
      skills,
      acs: d,
      kind: 'agent',
    };
    entry.active = isNodeActive(entry, nodes);
    entry.acsView = buildAcsView(entry);
    entries.push(entry);
  }

  // ── 显式查询打分（能力/名称/身份码关键词匹配；本地确定性匹配，无 LLM——诚实披露）──
  // 参考实现 exploratory 依赖 LLM 拆解子任务；本插件为单机治理插件，无 LLM 依赖，
  // exploratory 退化为「query 关键词匹配 + filter 过滤」（本地模式），结果 memo 标注 local。
  function scoreEntry(entry, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return 0;
    const corpus = [
      entry.name, entry.description, entry.aic,
      ...entry.skills.flatMap((s) => [s.id, s.name, s.description, ...s.tags]),
    ].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    for (const token of q.split(/\s+/)) {
      if (!token) continue;
      if (corpus.includes(token)) score += 1;
      if ((entry.name ?? '').toLowerCase() === token) score += 2; // 名称精确命中加权
      if ((entry.aic ?? '').toLowerCase() === token) score += 2;  // 身份码精确命中加权
    }
    return score;
  }

  // 结果行 → DiscoveryAgentSkill：取最佳命中技能（显式查询）或首个技能
  function toAgentSkillRow(entry, query) {
    let skillId = '';
    if (entry.skills.length > 0) {
      if (query) {
        const q = String(query).trim().toLowerCase();
        const scored = entry.skills
          .map((s) => ({ s, score: [s.id, s.name, s.description, ...s.tags].filter(Boolean).join(' ').toLowerCase().includes(q) ? 1 : 0 }))
          .sort((a, b) => b.score - a.score);
        skillId = scored[0].s.id;
      } else {
        skillId = entry.skills[0].id;
      }
    }
    return { aic: entry.aic, skillId, ranking: 0, memo: undefined };
  }

  // 过滤 + active + limit → 结果条目（含评分）
  function applyFilterAndActive(request, scored) {
    const activeOnly = scored.filter((e) => e.entry.active === true);
    const filtered = request.filter
      ? activeOnly.filter((e) => evaluateFilter(e.entry.acsView, request.filter))
      : activeOnly;
    return filtered;
  }

  function buildResponse(request, rows, durationMs) {
    // rows: [{ entry, score? }] 已按 ranking 排序
    const acsMap = {};
    const agentSkills = rows.map(({ entry, score }, idx) => {
      const row = toAgentSkillRow(entry, request.type === QUERY_TYPE_EXPLICIT ? request.query : null);
      row.ranking = idx + 1;
      row.memo = request.type === 'trending' ? 'trending'
        : request.type === 'filtered' ? 'Filtered query result'
          : request.type === 'exploratory' ? 'exploratory-local (no LLM decomposition)'
            : (score !== undefined && score > 0) ? 'keyword score: ' + score : undefined;
      if (row.memo === undefined) delete row.memo;
      acsMap[entry.aic] = entry.acs;
      return row;
    });

    const group = request.type === 'filtered' ? 'filtered'
      : request.type === 'trending' ? 'trending'
        : request.type === 'exploratory' ? (request.query || 'exploratory')
          : (request.query || '');
    const agentGroups = [{ group, agentSkills }];
    const route = {
      forwardChain: (Array.isArray(request.forwardChain) && request.forwardChain.length > 0)
        ? request.forwardChain
        : [LOCAL_SERVER_AIC],
      agentGroups,
      status: 'ok',
      durationMs: Math.round(durationMs),
    };
    return successResponse({ acsMap, agents: agentGroups, routes: [route] });
  }

  // ── discover：统一 POST /discover 语义 ──
  function discover(raw = {}) {
    const started = Date.now();
    const err = validateDiscoveryRequest(raw);
    if (err) return err; // { error: { code, message, data } }

    const request = { ...raw, type: raw.type ?? QUERY_TYPE_EXPLICIT };
    const limit = normalizeLimit(request.limit);

    if (request.type === 'filtered') {
      const rows = applyFilterAndActive(request, entries.map((entry) => ({ entry })));
      return buildResponse(request, rows.slice(0, limit), Date.now() - started);
    }

    if (request.type === 'trending') {
      const rows = applyFilterAndActive(request, entries.map((entry) => ({ entry })));
      // 参考实现 discover_agents_trending：随机打散后取前 limit
      const shuffled = [...rows].sort(() => Math.random() - 0.5);
      return buildResponse(request, shuffled.slice(0, limit), Date.now() - started);
    }

    // explicit / exploratory：关键词打分 + 过滤
    const scored = entries.map((entry) => ({ entry, score: scoreEntry(entry, request.query) }));
    const rows = applyFilterAndActive(request, scored);
    const sorted = request.type === QUERY_TYPE_EXPLICIT
      ? [...rows].sort((a, b) => b.score - a.score)
      : [...rows].sort((a, b) => String(a.entry.name).localeCompare(String(b.entry.name)));
    // 显式查询：score=0 表示无命中 → 仅返回有命中条目（与参考实现检索语义一致）
    const matched = request.type === QUERY_TYPE_EXPLICIT ? sorted.filter((r) => r.score > 0) : sorted;
    return buildResponse(request, matched.slice(0, limit), Date.now() - started);
  }

  // ── .well-known 预置：声明发现服务地址/协议版本/能力概要 ──
  function wellKnown() {
    return {
      protocol: 'ACPs',
      protocolVersion: '02.01', // ACPs v2.1.0（参考实现 ACS protocolVersion 示例）
      service: 'dsh-punky-swarm',
      discovery: {
        endpoint: '/api/dsh-punky-swarm/discover',
        transport: 'HTTP_JSON',
        security: ['mutualTLS'],
      },
      capabilities: {
        queryTypes: QUERY_TYPES,
        defaultLimit: 5,
        maxLimit: 50,
        filterOperators: FILTER_OPERATORS,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    discover,
    wellKnown,
    // 只读快照（测试/诊断用）
    stats: () => ({
      enabled: config.enabled !== false,
      entries: entries.length,
      tools: entries.filter((e) => e.kind === 'tool').length,
      agents: entries.filter((e) => e.kind === 'agent').length,
      active: entries.filter((e) => e.active === true).length,
    }),
  };
}

export { ADP_ERROR };
