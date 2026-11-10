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

// @ts-check

// 派发面 · 角色语料：frontmatter 解析 + role 目录定位 + 工具面/deny 派生。
// 本层零内部依赖（只依赖 node 内置），是派发面最底层。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROLE_UNRESOLVED_CODE = 'GATE_ROLE_UNRESOLVED';

export const ROLE_SECTION_TITLES = Object.freeze({
  responsibilities: '## 你的职责',
  authorities: '## 你被授权决定',
  deliverables: '## 交付要求',
});

export const ROLE_MANDATORY_FIELDS = Object.freeze(['id', 'title', 'layer', 'mission', 'responsibilities']);

const DEFAULT_ROLE_TEAM = 'software-team';
const ROLE_DIR_SEGMENTS = ['references', 'roles'];

export function roleCorpusRoot() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export function roleTeamDirs({ root = roleCorpusRoot(), fsImpl = fs } = {}) {
  const skillsRoot = path.join(root, 'skills');
  let names = [];
  try {
    names = fsImpl.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
  const withRoles = names.filter((n) => {
    try { return fsImpl.statSync(path.join(skillsRoot, n, ...ROLE_DIR_SEGMENTS)).isDirectory(); } catch { return false; }
  });
  const ordered = (withRoles.includes(DEFAULT_ROLE_TEAM) ? [DEFAULT_ROLE_TEAM] : [])
    .concat(withRoles.filter((n) => n !== DEFAULT_ROLE_TEAM).sort());
  return ordered.map((n) => path.join(skillsRoot, n, ...ROLE_DIR_SEGMENTS));
}

const KV_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/;

function stripQuotes(raw) {
  const s = String(raw ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function inlineListOf(raw) {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of s.slice(1, -1)) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(stripQuotes).filter((x) => x !== '');
}

function yamlScalar(raw) {
  const t = String(raw ?? '').trim();
  const list = inlineListOf(t);
  if (list) return list;
  if (t === 'true') return true;
  if (t === 'false') return false;
  return stripQuotes(t);
}

function yamlBlockOf(blockLines) {
  if (blockLines.some((l) => /^\s*-\s/.test(l))) {
    const items = [];
    let cur = null;
    for (const line of blockLines) {
      const dash = /^\s*-\s*(.*)$/.exec(line);
      if (dash) {
        const kv = KV_LINE.exec(dash[1].trim());
        cur = kv ? { map: { [kv[1]]: yamlScalar(kv[2]) } } : { scalar: yamlScalar(dash[1]) };
        items.push(cur);
        continue;
      }
      const kv = KV_LINE.exec(line.trim());
      if (kv && cur?.map) cur.map[kv[1]] = yamlScalar(kv[2]);
    }
    return items.map((it) => (it.map ? it.map : it.scalar));
  }
  const map = {};
  for (const line of blockLines) {
    const kv = KV_LINE.exec(line.trim());
    if (kv) map[kv[1]] = yamlScalar(kv[2]);
  }
  return map;
}

export function parseRoleFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = KV_LINE.exec(line);
    if (!kv) continue;
    const rest = kv[2];
    if (rest !== undefined && rest.trim() !== '') { out[kv[1]] = yamlScalar(rest); continue; }
    const block = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i]);
    out[kv[1]] = block.length ? yamlBlockOf(block) : '';
  }
  return out;
}

function bodySectionOf(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return '';
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (lines[i].trim()) out.push(lines[i].trim());
  }
  return out.join(' ');
}

function missingMandatoryOf(fm) {
  return ROLE_MANDATORY_FIELDS.filter((k) => {
    const v = fm[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
}

function roleDataOfText(text, source) {
  const fm = parseRoleFrontmatter(text);
  if (!fm) throw new Error(ROLE_UNRESOLVED_CODE + ': 角色文件无可用 YAML frontmatter · ' + source);
  const missing = missingMandatoryOf(fm);
  if (missing.length) {
    throw new Error(ROLE_UNRESOLVED_CODE + ': 角色 ' + String(fm.id ?? '(无 id)') + ' 缺必填字段 '
      + missing.join('/') + ' · ' + source);
  }
  return { ...fm, persona_text: bodySectionOf(text, '## Persona（注入用）'), source };
}

/**
 * @returns {object|null} role 数据对象
 */
export function resolveRoleRef(roleRef, { root = roleCorpusRoot(), team, fsImpl = fs, warn } = {}) {
  if (roleRef && typeof roleRef === 'object') return roleRef;
  const id = typeof roleRef === 'string' ? roleRef.trim() : '';
  if (!id) return null;
  const dirs = team
    ? [path.join(root, 'skills', String(team), ...ROLE_DIR_SEGMENTS)]
    : roleTeamDirs({ root, fsImpl });
  const hits = [];
  for (const dir of dirs) {
    const file = path.join(dir, id + '.md');
    try { if (fsImpl.statSync(file).isFile()) hits.push(file); } catch {  }
  }
  if (!hits.length) {
    throw new Error(ROLE_UNRESOLVED_CODE + ': role "' + id + '" 在 ' + dirs.length + ' 个角色目录内零命中'
      + '（' + (team ? 'team=' + team : '团队序=' + dirs.join(' | ')) + '）'
      + ' ⇒ 拒派（role 数据面缺失**不得**静默退回硬编码骨架）');
  }
  if (hits.length > 1) {
    warn?.('[dsh-punky-swarm] role "' + id + '" 在 ' + hits.length + ' 个团队内重名 ⇒ 按团队序取首个：'
      + hits[0] + '（其余：' + hits.slice(1).join(' · ') + '）');
  }
  return roleDataOfText(fsImpl.readFileSync(hits[0], 'utf8'), hits[0]);
}

function allowOfRole(roleData) {
  const allow = roleData?.tools?.allow;
  return Array.isArray(allow) ? allow.filter((t) => typeof t === 'string' && t.trim() !== '') : [];
}

export function roleToolVocabulary({ root = roleCorpusRoot(), fsImpl = fs, warn } = {}) {
  const vocab = [];
  for (const dir of roleTeamDirs({ root, fsImpl })) {
    let files = [];
    try { files = fsImpl.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        for (const t of allowOfRole(roleDataOfText(fsImpl.readFileSync(full, 'utf8'), full))) {
          if (!vocab.includes(t)) vocab.push(t);
        }
      } catch (e) {
        warn?.('[dsh-punky-swarm] role 语料解析跳过 ' + full + '：' + String(e?.message ?? e));
      }
    }
  }
  return vocab;
}

// 【legacy · R-3】意图声明降级前的反推实现：**派发主路径缺省不再调用本函数**
//   （`dispatch-core.js` 仅当 role 显式声明 `tools.deny_derived: true` 时才回退到它；缺省 false ⇒ 不反推）。
//   保留导出 = 单测面 + 存量调用点零断链（`dispatch.js` 仍转出，`test/engine-dispatch.test.js` 仍直调）。
export function deriveDenyTools(allow, opts = {}) {
  const list = (Array.isArray(allow) ? allow : [])
    .filter((t) => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim());
  if (!list.length) return [];
  return roleToolVocabulary(opts).filter((t) => !list.includes(t));
}

export function personaOfRole(roleData) {
  if (!roleData || typeof roleData !== 'object') return undefined;
  const parts = [roleData.title, roleData.mission, roleData.persona_text]
    .map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return parts.length ? parts.join('；') : undefined;
}

export function listOf(v) { return Array.isArray(v) ? v : []; }
