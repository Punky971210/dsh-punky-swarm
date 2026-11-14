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


import {
  QUERY_TYPES, QUERY_TYPE_EXPLICIT, ADP_ERROR, FILTER_OPERATORS,
  validateDiscoveryRequest, normalizeLimit, successResponse, failureResponse,
} from './schema.js';
import { evaluateFilter } from './filter.js';

const LOCAL_SERVER_AIC = 'AIC-DS-A'; // 参考实现 _build_response 默认 forwardChain 首跳占位（服务自身 AIC）

function toAgentSkill(skill) {
  return {
    id: skill.id ?? '',
    name: skill.name ?? '',
    description: skill.description ?? '',
    version: skill.version ?? '',
    tags: Array.isArray(skill.tags) ? skill.tags : [],
  };
}

/** filter 的合成记录：**描述符全字段 ∪ 条目级四键**（`aic`/`active`/`kind`/`skills`）。
 *  单点构造（此前是 `buildAcsView`，只留了六键 ⇒ 描述符其余字段不可过滤）。 */
function filterRecordOf(entry) {
  return {
    ...(entry.acs && typeof entry.acs === 'object' ? entry.acs : {}),
    aic: entry.aic,
    active: entry.active,
    kind: entry.kind,
    skills: entry.skills,
  };
}

function isNodeActive(entry, nodes) {
  const override = nodes?.[entry.aic] ?? nodes?.[entry.name];
  if (override && typeof override === 'object' && override.active === false) return false;
  if (entry.acs && typeof entry.acs === 'object' && entry.acs.active === false) return false;
  return true;
}

export function createDiscoveryService({ catalog, agentDescriptors = [], config = {} }) {
  const nodes = (config && typeof config.nodes === 'object' && config.nodes) || {};

  const entries = [];

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
    entries.push(entry);
  }

  for (const d of agentDescriptors) {
    const skills = Array.isArray(d.skills) ? d.skills.map(toAgentSkill) : [];
    const entry = {
      aic: d.aic ?? '',
      name: d.name ?? '',
      description: d.description ?? '',
      version: d.version ?? '',
      skills,
      acs: d,
      kind: 'agent',
    };
    entry.active = isNodeActive(entry, nodes);
    entries.push(entry);
  }

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

  function applyFilterAndActive(request, scored) {
    const activeOnly = scored.filter((e) => e.entry.active === true);
    // 【⑧-2 · 2026-11-08 裁决甲】filter 作用于**完整描述符**，不是压缩视图。
    //   旧实现压成 `acsView = {aic,active,name,description,version,skills}` ⇒ 工具描述符的
    //   `toolId`/`inputParam`/`outputParam`、席位描述符的 `provider`/`endPoints`/`protocolVersion`
    //   与 `kind` 全部不可过滤（外部按这些字段查会「查不到但确实存在」）。
    //   合成口径 = **描述符全字段 ∪ 条目级四键**（`aic`/`active`/`kind`/`skills`）：后四键只有条目
    //   才有（工具描述符用 `toolId` 不用 `aic`），去掉它们会让 `field:'aic'` 这类既有查询反向失效。
    const filtered = request.filter
      ? activeOnly.filter((e) => evaluateFilter(filterRecordOf(e.entry), request.filter))
      : activeOnly;
    return filtered;
  }

  function buildResponse(request, rows, durationMs) {
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
      const shuffled = [...rows].sort(() => Math.random() - 0.5);
      return buildResponse(request, shuffled.slice(0, limit), Date.now() - started);
    }

    const scored = entries.map((entry) => ({ entry, score: scoreEntry(entry, request.query) }));
    const rows = applyFilterAndActive(request, scored);
    const sorted = request.type === QUERY_TYPE_EXPLICIT
      ? [...rows].sort((a, b) => b.score - a.score)
      : [...rows].sort((a, b) => String(a.entry.name).localeCompare(String(b.entry.name)));
    const matched = request.type === QUERY_TYPE_EXPLICIT ? sorted.filter((r) => r.score > 0) : sorted;
    return buildResponse(request, matched.slice(0, limit), Date.now() - started);
  }

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
