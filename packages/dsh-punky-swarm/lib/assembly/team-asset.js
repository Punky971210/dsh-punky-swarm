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

// 团队资产（team-asset）声明：加载 + 加载期不变量校验
// ─────────────────────────────────────────────────────────────────────────────
// 定位：
//   把「层语义 / 产物字段 / 必填契约 / 流程开关 / 返工策略 / 状态机收紧」从引擎硬编码里
//   搬进**每团队一份**的声明资产 `presets/<team>/team-asset.yml`，成为「与引擎绑定的资产」。
//   本模块只做两件事：① 找到并解析声明；② 加载期不变量校验（fail = 拒载该团队，不炸宿主）。
//   **本文件不改动任何既有行为**：门禁/状态机是否读声明由后续切片接入，
//   且缺声明时一律回落现状语义。
//
// 校验方式（「加载期不变量」这一半）：
//   3. 加载期不变量断言（本文件）
//   4. 运行期首触校验（声明未覆盖的迁移点首次触发 → 事件 + 降级跳过 + 告警）
//
// 格式：引擎**零运行时依赖**（package.json 无 dependencies，无 YAML 解析器），
//   既有资产清单惯例为 JSON（asset-manifest.json）。故声明文件采用
//   **`.yml` 文件名 + JSON 子集内容**（YAML 1.2 是 JSON 超集 ⇒ 内容既是合法 JSON 也是合法 YAML）。
//   读取顺序：`team-asset.json` → `team-asset.yml`（按 JSON 解析）；两者都失败 → 明确报错。
//   若后续引入 YAML 解析器，本模块的解析入口可平滑放开为完整 YAML。
//
// 读端纪律：**容忍 BOM**（U+FEFF）——实测 runtime.json 读端因 BOM 拒读，
//   本模块一律先剥 BOM 再 parse，避免同类缺陷复发。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMBER_STATES, MEMBER_TRANSITIONS } from '../schema.js';

// ── 常量：可拔插面的白名单（引擎基础语义，声明不得越界）──
export const TEAM_ASSET_DIR = 'presets';
export const TEAM_ASSET_FILENAMES = Object.freeze(['team-asset.json', 'team-asset.yml']);
export const PRODUCE_LAYERS = Object.freeze(['plan', 'exec', 'audit']); // 有「产出存在性」语义的层
export const FLOW_SECTIONS = Object.freeze([...PRODUCE_LAYERS, 'complete']);
export const PRODUCE_FIELDS = Object.freeze(['produce', 'outputs']); // 产物字段名白名单
export const ENTRY_REQUIREMENTS = Object.freeze(['consume']); // 派发前可要求的项（白名单）
export const ESCALATIONS = Object.freeze(['human', 'none']);
export const ROLE_EXTRA_RE = /^[a-z][a-z0-9-]*$/; // 扩展角色词法（kebab-case）
export const BOM = '\uFEFF';

// 问题码（加载期不变量）：拒载该团队时不炸宿主，交由调用方告警 + 降级
export const TEAM_ASSET_CODES = Object.freeze({
  NOT_FOUND: 'TEAM_ASSET_NOT_FOUND',
  BAD_JSON: 'TEAM_ASSET_BAD_JSON',
  BAD_TYPE: 'TEAM_ASSET_BAD_TYPE',
  MISSING_FIELD: 'TEAM_ASSET_MISSING_FIELD',
  FIELD_NOT_ALLOWED: 'TEAM_ASSET_FIELD_NOT_ALLOWED',
  ENTRY_REQUIRE_UNKNOWN: 'TEAM_ASSET_ENTRY_REQUIRE_UNKNOWN',
  CONTRACT_EMPTY: 'TEAM_ASSET_CONTRACT_EMPTY',
  LAYER_UNKNOWN: 'TEAM_ASSET_LAYER_UNKNOWN',
  ROLE_LEXICAL: 'TEAM_ASSET_ROLE_LEXICAL',
  SKILLS_MISMATCH: 'TEAM_ASSET_SKILLS_MISMATCH',
  STATE_OVERRIDE_UNKNOWN_STATE: 'TEAM_ASSET_STATE_OVERRIDE_UNKNOWN_STATE',
  STATE_OVERRIDE_WIDENS: 'TEAM_ASSET_STATE_OVERRIDE_WIDENS',
  STATE_KIND_INVALID: 'TEAM_ASSET_STATE_KIND_INVALID',
  REWORK_INVALID: 'TEAM_ASSET_REWORK_INVALID',
  LEAD_NOT_IN_LAYERS: 'TEAM_ASSET_LEAD_NOT_IN_LAYERS',
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);

export function stripBom(text) {
  return typeof text === 'string' && text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

// ── 解析：JSON 子集（含 BOM 容忍）──
export function parseTeamAsset(text, { path = null } = {}) {
  const problems = [];
  let asset = null;
  try {
    asset = JSON.parse(stripBom(text));
  } catch (e) {
    problems.push({
      code: TEAM_ASSET_CODES.BAD_JSON,
      path: path ?? '(text)',
      message: '声明必须是 JSON 子集（.yml 文件名亦按 JSON 内容书写）：' + String(e?.message ?? e),
    });
    return { ok: false, asset: null, problems };
  }
  if (!isPlainObject(asset)) {
    problems.push({ code: TEAM_ASSET_CODES.BAD_TYPE, path: path ?? '(root)', message: '声明根必须是对象' });
    return { ok: false, asset: null, problems };
  }
  return { ok: true, asset, problems };
}

// ── 加载期不变量校验（纯函数，便于测试与调用方复用）──
export function validateTeamAsset(asset) {
  const problems = [];
  const push = (code, path, message) => problems.push({ code, path, message });

  if (!isPlainObject(asset)) {
    push(TEAM_ASSET_CODES.BAD_TYPE, '(root)', '声明必须是对象');
    return { ok: false, problems };
  }
  if (!isNonEmptyString(asset.team)) push(TEAM_ASSET_CODES.MISSING_FIELD, 'team', 'team 必填（非空字符串）');

  // ① layers：每层 roles/skills 一一对应（沿用既有 assembly 结构，零新概念）
  if (!isPlainObject(asset.layers)) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'layers', 'layers 必填（对象）');
  } else {
    for (const [layer, def] of Object.entries(asset.layers)) {
      if (!isPlainObject(def)) { push(TEAM_ASSET_CODES.BAD_TYPE, `layers.${layer}`, '层定义必须是对象'); continue; }
      if (!isStringArray(def.roles)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `layers.${layer}.roles`, 'roles 必填（非空字符串数组）'); continue; }
      if (!isPlainObject(def.skills)) { push(TEAM_ASSET_CODES.SKILLS_MISMATCH, `layers.${layer}.skills`, 'skills 必填（对象）'); continue; }
      for (const role of def.roles) {
        if (!isStringArray(def.skills[role])) push(TEAM_ASSET_CODES.SKILLS_MISMATCH, `layers.${layer}.skills.${role}`, '每个 role 必须有非空 skills 数组');
      }
    }
  }

  // ② roles.extra：扩展角色词法（引擎基础集之外的自定义角色名）
  //    `plan_leads` / `audit_leads`——该团队认可的**额外牵头角色**（与引擎基础集并集）；
  //    不变量：每个声明的牵头角色必须在某层 layers[*].roles 里真实存在（否则声明悬空 = 无意义）
  const allLayerRoles = new Set();
  if (isPlainObject(asset.layers)) {
    for (const def of Object.values(asset.layers)) {
      if (isPlainObject(def) && Array.isArray(def.roles)) for (const r of def.roles) allLayerRoles.add(String(r).trim().toLowerCase());
    }
  }
  if (asset.roles != null) {
    if (!isPlainObject(asset.roles)) push(TEAM_ASSET_CODES.BAD_TYPE, 'roles', 'roles 必须是对象');
    else {
      if (asset.roles.extra != null) {
        if (!Array.isArray(asset.roles.extra)) push(TEAM_ASSET_CODES.BAD_TYPE, 'roles.extra', 'roles.extra 必须是数组');
        else {
          const seen = new Set();
          for (const r of asset.roles.extra) {
            if (!isNonEmptyString(r) || !ROLE_EXTRA_RE.test(r)) push(TEAM_ASSET_CODES.ROLE_LEXICAL, 'roles.extra', `扩展角色词法非法：${JSON.stringify(r)}（要求 kebab-case）`);
            else if (seen.has(r)) push(TEAM_ASSET_CODES.ROLE_LEXICAL, 'roles.extra', `扩展角色重复：${r}`);
            else seen.add(r);
          }
        }
      }
      for (const key of ['plan_leads', 'audit_leads']) {
        if (asset.roles[key] == null) continue;
        if (!Array.isArray(asset.roles[key])) { push(TEAM_ASSET_CODES.BAD_TYPE, 'roles.' + key, key + ' 必须是数组'); continue; }
        const seenLead = new Set();
        for (const r of asset.roles[key]) {
          if (!isNonEmptyString(r) || !ROLE_EXTRA_RE.test(r)) push(TEAM_ASSET_CODES.ROLE_LEXICAL, 'roles.' + key, `牵头角色词法非法：${JSON.stringify(r)}（要求 kebab-case）`);
          else if (seenLead.has(r)) push(TEAM_ASSET_CODES.ROLE_LEXICAL, 'roles.' + key, `牵头角色重复：${r}`);
          else {
            seenLead.add(r);
            if (!allLayerRoles.has(r)) push(TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS, 'roles.' + key, `牵头角色 ${r} 未出现在任何 layers[*].roles（声明悬空）`);
          }
        }
      }
    }
  }

  // ③ flows：层→产物字段/入口要求/契约/开关
  if (!isPlainObject(asset.flows)) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'flows', 'flows 必填（对象）');
  } else {
    for (const [layer, flow] of Object.entries(asset.flows)) {
      const at = `flows.${layer}`;
      if (!FLOW_SECTIONS.includes(layer)) { push(TEAM_ASSET_CODES.LAYER_UNKNOWN, at, `未知层：${layer}（允许：${FLOW_SECTIONS.join('/')}）`); continue; }
      if (!isPlainObject(flow)) { push(TEAM_ASSET_CODES.BAD_TYPE, at, '层流程定义必须是对象'); continue; }

      // complete 段只声明完成判据，不声明产物字段
      if (layer === 'complete') {
        if (flow.require_audit_outcomes != null && !isStringArray(flow.require_audit_outcomes)) {
          push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.require_audit_outcomes`, '必须是非空字符串数组');
        }
        continue;
      }

      if (!isNonEmptyString(flow.produce_field)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.produce_field`, 'produce_field 必填');
      else if (!PRODUCE_FIELDS.includes(flow.produce_field)) push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `${at}.produce_field`, `不在白名单：${flow.produce_field}（允许：${PRODUCE_FIELDS.join('/')}）`);

      if (flow.consume_field != null && !isNonEmptyString(flow.consume_field)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.consume_field`, 'consume_field 必须是非空字符串');

      if (flow.entry_requires != null) {
        if (!Array.isArray(flow.entry_requires)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.entry_requires`, 'entry_requires 必须是数组');
        else for (const r of flow.entry_requires) {
          if (!ENTRY_REQUIREMENTS.includes(r)) push(TEAM_ASSET_CODES.ENTRY_REQUIRE_UNKNOWN, `${at}.entry_requires`, `未知要求：${JSON.stringify(r)}（允许：${ENTRY_REQUIREMENTS.join('/')}）`);
        }
      }

      for (const flag of ['targets', 'gate_command', 'needhuman']) {
        if (flow[flag] != null && typeof flow[flag] !== 'boolean') push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.${flag}`, `${flag} 必须是布尔`);
      }

      if (flow.contract != null) {
        if (!isPlainObject(flow.contract)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.contract`, 'contract 必须是对象');
        else {
          if (!isStringArray(flow.contract.artifact_globs)) push(TEAM_ASSET_CODES.CONTRACT_EMPTY, `${at}.contract.artifact_globs`, 'artifact_globs 必填（非空字符串数组）');
          if (!isStringArray(flow.contract.required_sections)) push(TEAM_ASSET_CODES.CONTRACT_EMPTY, `${at}.contract.required_sections`, 'required_sections 必填（非空字符串数组）');
        }
      }

      if (flow.progress_contract != null) {
        if (!isPlainObject(flow.progress_contract)) push(TEAM_ASSET_CODES.BAD_TYPE, `${at}.progress_contract`, 'progress_contract 必须是对象');
        else {
          if (!isNonEmptyString(flow.progress_contract.dir)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.progress_contract.dir`, 'dir 必填');
          if (!isNonEmptyString(flow.progress_contract.naming)) push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.progress_contract.naming`, 'naming 必填');
        }
      }
    }
  }

  // ④ state_machine：只允许收紧/白名单扩展，不得删减内核态（S-2）
  if (asset.state_machine != null) {
    const sm = asset.state_machine;
    if (!isPlainObject(sm)) push(TEAM_ASSET_CODES.BAD_TYPE, 'state_machine', 'state_machine 必须是对象');
    else {
      if (sm.kind !== 'tighten-only') push(TEAM_ASSET_CODES.STATE_KIND_INVALID, 'state_machine.kind', `kind 必须是 'tighten-only'（收到：${JSON.stringify(sm.kind)}）`);
      if (sm.overrides != null) {
        if (!isPlainObject(sm.overrides)) push(TEAM_ASSET_CODES.BAD_TYPE, 'state_machine.overrides', 'overrides 必须是对象');
        else for (const [from, tos] of Object.entries(sm.overrides)) {
          const at = `state_machine.overrides.${from}`;
          if (!Object.prototype.hasOwnProperty.call(MEMBER_TRANSITIONS, from)) {
            push(TEAM_ASSET_CODES.STATE_OVERRIDE_UNKNOWN_STATE, at, `未知内核态：${from}（内核态：${MEMBER_STATES.join('/')}）`);
            continue;
          }
          if (!Array.isArray(tos)) { push(TEAM_ASSET_CODES.BAD_TYPE, at, '必须是数组'); continue; }
          const allowed = MEMBER_TRANSITIONS[from] ?? [];
          for (const to of tos) {
            if (!allowed.includes(to)) push(TEAM_ASSET_CODES.STATE_OVERRIDE_WIDENS, at, `只允许收紧：${from}→${to} 不在内核图谱内（内核允许：${allowed.join('/') || '（无）'}）`);
          }
        }
      }
    }
  }

  // ⑤ rework：返工策略（专业流程语义，可拔插）
  if (asset.rework != null) {
    const rw = asset.rework;
    if (!isPlainObject(rw)) push(TEAM_ASSET_CODES.BAD_TYPE, 'rework', 'rework 必须是对象');
    else {
      if (rw.allowed != null && typeof rw.allowed !== 'boolean') push(TEAM_ASSET_CODES.REWORK_INVALID, 'rework.allowed', '必须是布尔');
      if (rw.max_attempts != null && (!Number.isInteger(rw.max_attempts) || rw.max_attempts < 1)) push(TEAM_ASSET_CODES.REWORK_INVALID, 'rework.max_attempts', '必须是正整数');
      if (rw.escalate != null && !ESCALATIONS.includes(rw.escalate)) push(TEAM_ASSET_CODES.REWORK_INVALID, 'rework.escalate', `必须是 ${ESCALATIONS.join('/')}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

// ── 读盘：`<root>/presets/<team>/team-asset.{json,yml}` ──
export function teamAssetCandidates(root, team) {
  const dir = join(root, TEAM_ASSET_DIR, team);
  return TEAM_ASSET_FILENAMES.map((f) => join(dir, f));
}

export function readTeamAsset(root, team) {
  const candidates = teamAssetCandidates(root, team);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    return {
      ok: false, asset: null, path: null,
      problems: [{ code: TEAM_ASSET_CODES.NOT_FOUND, path: candidates.join(' | '), message: `未找到团队声明（${team}）` }],
    };
  }
  let text;
  try {
    text = readFileSync(found, 'utf8');
  } catch (e) {
    return { ok: false, asset: null, path: found, problems: [{ code: TEAM_ASSET_CODES.NOT_FOUND, path: found, message: '读取失败：' + String(e?.message ?? e) }] };
  }
  const parsed = parseTeamAsset(text, { path: found });
  return { ...parsed, path: found };
}

// loadTeamAsset：读盘 + 解析 + 加载期不变量校验（调用方据 ok 决定「用声明 / 回落现状」）
export function loadTeamAsset(root, team) {
  const read = readTeamAsset(root, team);
  if (!read.ok) return read;
  const v = validateTeamAsset(read.asset);
  return { ok: v.ok, asset: read.asset, path: read.path, problems: v.problems };
}
