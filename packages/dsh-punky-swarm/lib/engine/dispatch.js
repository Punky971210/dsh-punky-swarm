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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueLaneHandle, consumeLaneHandle, firstLineOf } from '../bridge/lane-handle.js';
import { renderArchContext } from './arch-context.js';
import { createAgentPort } from '../provider-dsh/agent.js';
import { EVT_MEMBER_DISPATCH } from '../state/event-types.js';

import { SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from './suite.js';
export { SUITE_DENY_TOOLS, MODE_GATED_TOOLS };
import { readCapability } from '../assembly/schema.js';
import { expectedWorkerSessionOf } from '../verify/binding.js';
import { applyInjectionBudget } from '../comms/inject-budget.js';
import { resumeClauseFor } from '../wave-plan.js';

const LABEL_PREFIX = 'punky-swarm:';

const ownerOfExec = (exec) => exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;
export function labelOf(batchId, lane) {
  return LABEL_PREFIX + String(batchId) + ':' + String(lane);
}

const asSessionId = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
export function ownerSessionIdOfExec(exec) {
  return asSessionId(exec?.agent?.session?.id);
}
export function ownerSessionIdOf(source) {
  return asSessionId(source?.ownerSessionId);
}
export function wakeAddressOf(hit) {
  return ownerSessionIdOf(hit) ?? hit?.sessionId ?? null;
}

//     **禁建第二套 worker→批 索引**，本函数只 `get`。
export function batchSessionIdOfWorker(dispatchIndex, exec) {
  if (!(dispatchIndex instanceof Map)) return null;
  const workerSessionId = ownerSessionIdOfExec(exec);
  if (!workerSessionId) return null;
  const hit = dispatchIndex.get(workerSessionId);
  return asSessionId(hit?.sessionId);
}

function dispatchIndexHitOf(dispatchIndex, workerSessionId) {
  return dispatchIndex.get(workerSessionId);
}

/**
 * @param {{listAllBatches?: Function, readBatch?: Function}|null|undefined} store 事件流数据源（缺 ⇒ 不命中）
 * @param {Map|null|undefined} dispatchIndex 既有**唯一** worker→批 索引（缺 / 非 Map ⇒ 不命中）
 * @param {{agent?: {session?: {id?: string}}}|null|undefined} exec 调用方 Agent（取键口径同写侧单点）
 * @param {object|undefined} logger 可选 cordis logger（**生产必传**，见 `lib/index.js` 调用方）：
 *   仅用于把 `laneBindingOf` 的 `batch-enum-failed:` / `batch-read-failed:` 两态**真可辨**；
 *   不传 = 静默（向后兼容），但生产路径不传 = M-1「能力在、接不到」的重演。
 * @returns {string|null} 批归属会话 id；未命中 / 数据源不可用 / 反查抛错 ⇒ `null`
 */
export function batchSessionIdOfWorkerResolved(store, dispatchIndex, exec, logger) {
  try {
    const hot = batchSessionIdOfWorker(dispatchIndex, exec);
    if (hot) return hot;
    const workerSessionId = ownerSessionIdOfExec(exec);
    if (!workerSessionId) return null;
    if (!(dispatchIndex instanceof Map)) return null;
    const bind = laneBindingOf(store, workerSessionId, logger);
    if (!bind) return null;
    const existing = dispatchIndexHitOf(dispatchIndex, workerSessionId);
    const owner = ownerSessionIdOf(bind);
    if (!existing || (ownerSessionIdOf(existing) === null && owner)) {
      dispatchIndex.set(workerSessionId,
        dispatchIndexEntryOf(bind.sessionId, bind.batchId, bind.lane, owner));
    }
    return batchSessionIdOfWorker(dispatchIndex, exec);
  } catch {
    return null;
  }
}

export function dispatchIndexEntryOf(sessionId, batchId, lane, ownerSessionId) {
  const entry = { sessionId, batchId, lane };
  if (ownerSessionId) {
    Object.defineProperty(entry, 'ownerSessionId', {
      value: ownerSessionId, enumerable: false, writable: true, configurable: true,
    });
  }
  return entry;
}


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

function listOf(v) { return Array.isArray(v) ? v : []; }

const PREFLIGHT_SECTION_TITLE = '## 开工前必做';
const PREFLIGHT_HEADERS = Object.freeze([
  '1. 查知识库（`weknora_search`）——命中即按「正向做法」执行并登记来源；无命中写一行「无命中」照常推进：',
  '2. 调用技能（`skill`）——开工前先读该技能正文，按其契约做事：',
  '3. 使用 MCP——行尾写用途，否则不知道该拿它干什么：',
  '4. 本任务检查表——逐条照做，不用翻文档：',
]);
const PREFLIGHT_SUBITEM_ABSENT = '   - （本任务未声明此项）';
const PREFLIGHT_MCP_WHY_ABSENT = '（用途未声明）';
const PREFLIGHT_KB_SOLE_HINT = '   - （提示：知识库关键词建议 2-3 个，当前仅 1 个）';
const PREFLIGHT_UNDECLARED_LINE = '> ⚠ 本任务未声明开工前必做项（`preflight` 的 kb / skills / mcp / checklist 四段全缺）：'
  + '请自行判断是否需要查知识库、调用技能、使用 MCP，并把结论写进回报的 `knowledge_hits` / `skills_used` / `mcp_used`。';

const kbItemTextOf = (k) => '`weknora_search("' + k + '")`';
const skillItemTextOf = (s) => '`skill("' + s + '")`';
const mcpItemTextOf = (m) => '`' + String(m.tool).trim() + '` —— '
  + ((typeof m.why === 'string' ? m.why.trim() : '') || PREFLIGHT_MCP_WHY_ABSENT);

export function preflightOf(task) {
  try {
    const raw = task?.preflight;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { declared: false, decl: null };
    return { declared: true, decl: raw };
  } catch {
    return { declared: false, decl: null };
  }
}

export function renderPreflightLines(decl) {
  if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
    return [PREFLIGHT_SECTION_TITLE, PREFLIGHT_UNDECLARED_LINE];
  }
  const stringsOf = (v) => listOf(v).filter((x) => typeof x === 'string' && x.trim() !== '');
  const kb = stringsOf(decl.kb);
  const skills = stringsOf(decl.skills);
  const mcp = listOf(decl.mcp).filter((m) => m && typeof m === 'object' && typeof m.tool === 'string' && m.tool.trim() !== '');
  const checklist = stringsOf(decl.checklist);
  const L = [PREFLIGHT_SECTION_TITLE];
  L.push(PREFLIGHT_HEADERS[0]);
  if (kb.length) {
    for (const k of kb) L.push('   - ' + kbItemTextOf(k));
    if (kb.length === 1) L.push(PREFLIGHT_KB_SOLE_HINT);
  } else L.push(PREFLIGHT_SUBITEM_ABSENT);
  L.push(PREFLIGHT_HEADERS[1]);
  if (skills.length) for (const s of skills) L.push('   - ' + skillItemTextOf(s));
  else L.push(PREFLIGHT_SUBITEM_ABSENT);
  L.push(PREFLIGHT_HEADERS[2]);
  if (mcp.length) {
    for (const m of mcp) L.push('   - ' + mcpItemTextOf(m));
  } else L.push(PREFLIGHT_SUBITEM_ABSENT);
  L.push(PREFLIGHT_HEADERS[3]);
  if (checklist.length) for (const c of checklist) L.push('   - ' + c.trim());
  else L.push(PREFLIGHT_SUBITEM_ABSENT);
  return L;
}

export function checkpointsOf(task) {
  try {
    const cp = task?.checkpoints;
    if (cp == null) return null;
    return { items: Array.isArray(cp?.items) ? cp.items : [] };
  } catch {
    return null;
  }
}

const CP_AUX_ABSENT_LINE = '  - ⚠ 本 checkpoint 未声明 skills / kb / mcp / checklist 四段（建议性：开工前自行判断；不阻断）';

function checkpointAuxLinesOf(it) {
  const strs = (v) => listOf(v).filter((x) => typeof x === 'string' && x.trim() !== '');
  const skills = strs(it?.skills);
  const kb = strs(it?.kb);
  const mcp = listOf(it?.mcp).filter((m) => m && typeof m === 'object'
    && typeof m.tool === 'string' && m.tool.trim() !== '');
  const checklist = strs(it?.checklist);
  const L = [];
  if (skills.length) L.push('  - skills：' + skills.map(skillItemTextOf).join(' / '));
  if (kb.length) L.push('  - kb：' + kb.map(kbItemTextOf).join(' / '));
  if (mcp.length) L.push('  - mcp：' + mcp.map(mcpItemTextOf).join('；'));
  if (checklist.length) L.push('  - checklist：' + checklist.map((c) => c.trim()).join(' / '));
  return L;
}

export function renderCheckpointsBlock(checkpoints) {
  if (checkpoints == null) return '';
  //   ⚠ **禁**在本文件另写一份逐项归一（`seen.has` / `isAbsPath` / 自建 items 循环）：抄一份就有一份漂移面。
  let declared = null;
  try {
    declared = normalizeCheckpoints(checkpoints);
  } catch {
    declared = null;
  }
  const items = Array.isArray(declared?.items) ? declared.items : [];
  if (items.length === 0) {
    const discardedAll = (() => {
      try {
        return Array.isArray(checkpoints)
          && checkpoints.some((it) => it != null && typeof it === 'object' && !Array.isArray(it));
      } catch {
        return false;
      }
    })();
    return '## checkpoint 计划\n' + (discardedAll
      ? '> ⚠ 本任务声明了 `checkpoints`，但归一化后为空（成因②：声明了项，但全部在归一化中被丢弃 —— 缺 `id` / `id` 重复 / `target` 为绝对路径的项会被丢弃）'
      : '> ⚠ 本任务声明了 `checkpoints`，但归一化后为空（成因①：原始没有任何可归一的一项 —— 声明为空，或形态既非数组也非 `{items:[…]}`）')
      + ' ⇒ 本 lane 无 checkpoint 计划；如需留痕请自行调用 `lane_checkpoint`。';
  }
  const lines = ['## checkpoint 计划'];
  lines.push('本 lane 共 ' + items.length + ' 个 checkpoint；建议 `lane_checkpoint(progress:{step,total:' + items.length + '})`'
    + '（`total` 由你自己填，引擎不与本行的 ' + items.length + ' 比对）。');
  for (const it of items) {
    const target = typeof it?.target === 'string' && it.target ? it.target : '（未声明目标）';
    const rounds = Number.isInteger(it?.rounds) && it.rounds >= 1 ? it.rounds : 1;
    const extra = [];
    if (Array.isArray(it?.outputs) && it.outputs.length > 0) extra.push('产出=' + it.outputs.join(' / '));
    if (typeof it?.acceptance === 'string' && it.acceptance) extra.push('验收=' + it.acceptance);
    if (it?.ctxBudget != null) extra.push('ctxBudget=' + it.ctxBudget);
    if (rounds > 1) extra.push('rounds=' + rounds);
    lines.push('- `' + (typeof it?.id === 'string' ? it.id : '?') + '` → ' + target
      + (extra.length > 0 ? '（' + extra.join('；') + '）' : ''));
    const aux = checkpointAuxLinesOf(it);
    if (aux.length > 0) lines.push(...aux);
    else lines.push(CP_AUX_ABSENT_LINE);
  }
  return lines.join('\n');
}

import { normalizeCheckpoints } from '../wave-plan.js';

export function renderPreflightBlock(preflight, { injectBudget = null } = {}) {
  let text;
  try {
    text = renderPreflightLines(
      (preflight && typeof preflight === 'object' && !Array.isArray(preflight)) ? preflight : null,
    ).join('\n');
  } catch {
    text = [PREFLIGHT_SECTION_TITLE, PREFLIGHT_UNDECLARED_LINE].join('\n');
  }
  try {
    const budgeted = applyInjectionBudget(text, { surface: 'taskpack.preflight', thresholds: injectBudget, kind: 'perBlock' });
    return typeof budgeted?.text === 'string' ? budgeted.text : text;
  } catch {
    return text;
  }
}

export function renderRoleGuide(roleData) {
  const L = [];
  L.push(ROLE_SECTION_TITLES.responsibilities);
  const personaText = typeof roleData?.persona_text === 'string' ? roleData.persona_text.trim() : '';
  if (personaText) L.push('- **角色定位**：' + personaText);
  const mission = typeof roleData?.mission === 'string' ? roleData.mission.trim() : '';
  if (mission) L.push('- **使命**：' + mission);
  for (const r of listOf(roleData?.responsibilities)) L.push('- ' + r);
  L.push('');
  L.push(ROLE_SECTION_TITLES.authorities);
  const authorities = listOf(roleData?.authorities);
  if (authorities.length) for (const a of authorities) L.push('- ' + a);
  else L.push('- （role 未声明）');
  L.push('');
  L.push(ROLE_SECTION_TITLES.deliverables);
  const deliverables = listOf(roleData?.deliverables);
  for (const d of deliverables) {
    const form = (typeof d === 'string') ? d.trim() : String(d?.form ?? '').trim();
    const must = (d && typeof d === 'object' && Array.isArray(d.must_contain)) ? d.must_contain : [];
    L.push('- 交付件：' + (form || '（形态未声明）'));
    if (must.length) L.push('  - 必含结构：' + must.map((x) => '`' + x + '`').join(' / '));
  }
  const skills = listOf(roleData?.skills);
  if (skills.length) L.push('- 规格：见技能 ' + skills.map((s) => '`' + s + '`').join(' / '));
  const hints = listOf(roleData?.acceptance_hints);
  if (!deliverables.length && !skills.length && !hints.length) L.push('- （role 未声明）');
  for (const h of hints) L.push('- 达标提示：' + h);
  return L.join('\n');
}

function appendRoleSections(L, roleData) {
  L.push('');
  L.push(...renderRoleGuide(roleData).split('\n'));
}

function roleCellOf(roleRef, roleData) {
  const bare = (typeof roleRef === 'string' && roleRef.trim())
    ? roleRef.trim()
    : String(roleData?.id ?? roleData?.title ?? '-');
  return roleData?.title ? '`' + bare + '`（' + roleData.title + '）' : '`' + bare + '`';
}

export function memberDispatchBudgetKeyOf(injectBudget) {
  return injectBudget?.enabled === false ? { budgetEnabled: false } : {};
}

export function composeWorkerPrompt({
  batchId, lane, cmd, layer, role, consume = [], produce = [], outputs = [], firstLine, leaderPrompt = '', artifactsRoot,
  batchSessionId,
  singleArtifactWrite = false,
  roleRoot, roleTeam,
  checkpoints = null,
  context = null,
  resume = false,
  injectBudget = null,
  archContext = null,
  preflight = null,
  logger = null,
}) {
  const roleData = resolveRoleRef(role, { root: roleRoot ?? roleCorpusRoot(), team: roleTeam });
  const budgeted = injectBudget?.enabled === true;
  const cmdBudget = budgeted
    ? applyInjectionBudget(String(cmd ?? '（未声明 cmd）'), { surface: 'taskpack.cmd', thresholds: injectBudget, kind: 'perItem' }).text
    : cmd;
  const leaderPromptBudget = budgeted
    ? applyInjectionBudget(leaderPrompt, { surface: 'taskpack.leaderPrompt', thresholds: injectBudget, kind: 'perItem' }).text
    : leaderPrompt;
  const archContextBudget = budgeted && typeof archContext === 'string' && archContext.length > 0
    ? applyInjectionBudget(archContext, { surface: 'taskpack.archContext', thresholds: injectBudget, kind: 'perItem' }).text
    : archContext;
  const L = [];
  L.push(firstLine);
  L.push('');
  L.push('# 任务包（引擎自派 · ' + labelOf(batchId, lane) + '）');
  L.push('- **lane**：`' + lane + '`｜**层**：`' + (layer ?? '-') + '`｜**角色**：' + roleCellOf(role, roleData));
  L.push('- **目标**：' + String(cmdBudget ?? '（未声明 cmd）'));
  if (consume.length) L.push('- **消费件**：' + consume.map((p) => '`' + p + '`').join('、'));
  if (produce.length) L.push('- **产出面**：' + produce.map((p) => '`' + p + '`').join('、'));
  if (outputs.length) L.push('- **产物**：' + outputs.map((p) => '`' + p + '`').join('、'));
  if (artifactsRoot) L.push('- **批次产物根**：`' + artifactsRoot + '`（产物落此处，勿落工作区根）');
  if (typeof batchSessionId === 'string' && batchSessionId.length > 0) {
    L.push('- **批归属会话**：`' + batchSessionId + '`——**调用治理工具（`lane_checkpoint` / `handoff_submit` / `mailbox_*` / '
      + '`member_settle` / `asset_claim` / `log_export` 等）时必须显式传 `session:"' + batchSessionId + '"`**；'
      + '省略时引擎按 worker 绑定自动归属（重启重建窗口内可能解析不到 ⇒ 显式传参是唯一可靠路径）。');
  }
  if (roleData) appendRoleSections(L, roleData);
  if (typeof archContextBudget === 'string' && archContextBudget.length > 0) {
    L.push('');
    L.push(archContextBudget);
  }
  const contextBudget = budgeted && typeof context === 'string' && context.length > 0
    ? applyInjectionBudget(context, { surface: 'taskpack.context', thresholds: injectBudget, kind: 'perItem' }).text
    : context;
  if (typeof contextBudget === 'string' && contextBudget.length > 0) {
    L.push('');
    L.push('## 项目上下文');
    L.push(contextBudget);
  }
  let preflightBlock;
  try {
    preflightBlock = renderPreflightBlock(preflight, { injectBudget });
  } catch (e) {
    try {
      logger?.warn?.('[dsh-punky-swarm] composeWorkerPrompt: 开工前必做段渲染失败 ⇒ 降级为警示行（不阻断派发）：'
        + String(e?.message ?? e));
    } catch {  }
    preflightBlock = renderPreflightBlock(null, { injectBudget });
  }
  let checkpointsBlock = '';
  try {
    checkpointsBlock = renderCheckpointsBlock(checkpoints);
  } catch (e) {
    try {
      logger?.warn?.('[dsh-punky-swarm] composeWorkerPrompt: checkpoint 计划段渲染失败 ⇒ 跳过该段（不阻断派发）：'
        + String(e?.message ?? e));
    } catch {  }
    checkpointsBlock = '';
  }
  if (checkpointsBlock) {
    L.push('');
    L.push(...String(checkpointsBlock).split('\n'));
  }
  const resumeClause = resumeClauseFor({ resume });
  if (resumeClause) {
    L.push('');
    L.push(resumeClause);
  }
  L.push('');
  L.push(...String(preflightBlock).split('\n'));
  L.push('');
  L.push('## 纪律');
  const roleAllowFace = listOf(roleData?.tools?.allow)
    .filter((x) => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
  if (roleAllowFace.length > 0) {
    L.push('本 lane 的角色工具面：' + roleAllowFace.map((t) => '`' + t + '`').join(' / ')
      + '。**只使用这些工具**；越界即违规（会被产物审计与纪律核查发现）。');
    L.push('（治理类工具 ' + SUITE_DENY_TOOLS.length + ' 件已由引擎在 preset 面**技术禁用**；'
      + '其余角色边界靠本条约束 —— 引擎不为角色面提供技术沙箱。）');
  }
  let ruleNo = 0;
  const rule = (text) => { ruleNo += 1; L.push(ruleNo + '. ' + text); };
  rule('写盘只用 `edit`/`write`；临时件用 `node -e` 的 `fs`；UTF-8 无 BOM、LF。');
  rule('禁 `git` 写；禁重启宿主；只碰本 lane 文件域。');
  rule('断言「没有某工具/技能」前先实机核：`grep`/`glob` 扫宿主安装面与引擎源码，或按名直调看回执（折叠 ≠ 禁用），勿凭印象断言「没有」。');
  rule('完成/失败均**显式回报**（不给静默降级）；回报只给元数据与结论，不复制正文。');
  rule('**【交接】完成时必须 `handoff_submit` 向【本 lane 的全部出边】交接**（含**聚合 audit lane**）——');
  L.push('   若本批含 audit 层而本 lane 是 plan/exec 层，则该边**必须交**；漏交会被 `GATE_HANDOFF_MISSING` 拒，');
  L.push('   批会被停轮。对 `a1-*` 这类**聚合 audit lane**（有多个入边），**每条上游线都要各自交一次**。');
  if (layer === 'plan') {
    rule('**【plan 产物】正文必须含六个【裸标题】**（行首恰为该串，非 `###`、无缩进/前缀）：');
    L.push('   `## 概述` / `## 问题` / `## 方案` / `## 需求` / `## 验收标准` / `## 约束`；');
    L.push('   **内容允许为空，标题一个都不能缺** —— 缺任一即被 `GATE_PLAN_CONTRACT` 拒（内容不校，只校标题）。');
  }
  rule('**【回报编号口径】**本 lane 的**验收项**编号以**判据源中承载 exec 验收项的那一章**为准（**章号与编号形态随判据源自定**：如 `§6` + `L-AC-1..N`，或 `V-1..V-28`）；');
  L.push('   判据源 `## 验收标准` 章内的自检项编号属于**规格自检**，**不是**本 lane 的验收项。');
  L.push('   回报引用验收项时：**照抄该章的编号 + 原文**（禁自行重排、禁把自检项编号当作验收项回填）。');
  const writeTargets = [...new Set([...produce, ...outputs].filter((p) => typeof p === 'string' && p.trim().length > 0))];
  const singleArtifactWriteLane = singleArtifactWrite === true || (layer === 'audit' && writeTargets.length === 1);
  if (singleArtifactWriteLane) {
    rule('**【progress 快照 · 本 lane = 单件写盘 lane】**写盘约束 = **只写声明的这一件产物**；');
    L.push('   ⇒ 本任务包**自动抑制**「每完成一子步骤即落 progress 快照」一行（该纪律与本 lane 的**单件写盘约束直接冲突**，'
      + '两条打架时**以更严者为准** = 单件约束）；');
    L.push('   子步骤记录写进**该件产物正文**或**汇报**里，**不得**另开进度快照文件（多写一件即越界）。');
  } else {
    rule('**【progress 快照】**每完成一个子步骤即落 `<lane>/progress/NN-<slug>.md`（禁攒批；崩溃后新 worker 据此跳过已完成步骤）。');
  }
  if (leaderPromptBudget) {
    L.push('');
    L.push('## 任务要点（Leader 补充）');
    L.push(leaderPromptBudget);
  }
  const composed = L.join('\n');
  if (!budgeted) return composed;
  return applyInjectionBudget(composed, { surface: 'taskpack.total', thresholds: injectBudget, kind: 'total' }).text;
}

export function buildStartRequest({
  batchId, lane, parent, prompt, denyTools = SUITE_DENY_TOOLS, extraDeny = [], persona, role, roleRoot, roleTeam,
  maxDepth = 1, signal,
}) {
  const roleData = resolveRoleRef(role, { root: roleRoot ?? roleCorpusRoot(), team: roleTeam });
  const effectivePersona = persona !== undefined ? persona : personaOfRole(roleData);
  const derivedDeny = deriveDenyTools(roleData?.tools?.allow, { root: roleRoot ?? roleCorpusRoot() });
  return {
    label: labelOf(batchId, lane),
    signal: signal ?? new AbortController().signal,
    parent,
    prompt: [{ type: 'text', text: prompt }],
    toolFilter: { deny: [...new Set([...denyTools, ...derivedDeny, ...extraDeny])] },
    ...(effectivePersona !== undefined ? { persona: effectivePersona } : {}),
    maxDepth,
  };
}

export function mapSpawnError(err) {
  const raw = String(err?.message ?? err ?? '');
  if (/capabilit|toolFilter|depthLimit/i.test(raw)) {
    return { code: 'GATE_DISPATCH_CAPABILITY_UNAVAILABLE', message: 'provider 能力位不足（toolFilter/depthLimit）⇒ 拒派，不以弱换强：' + raw };
  }
  if (/provider|unknown provider|not resolvable/i.test(raw)) {
    return { code: 'GATE_DISPATCH_PROVIDER_INVALID', message: 'provider 不可解析（检查 config.dispatch.provider）：' + raw };
  }
  return { code: 'GATE_DISPATCH_FAILED', message: '引擎自派失败：' + raw };
}

export function workerSessionIdOf(start, warn) {
  if (!start || typeof start !== 'object') return null;
  if (typeof start.id === 'string' && start.id) return start.id;
  for (const k of ['childId', 'subagentId']) {
    if (typeof start[k] === 'string' && start[k]) {
      warn?.('start 未返回实现面字段 `id` → 回落 `' + k + '`（continuable 时代契约字段，防御性保留；若两者皆缺请查宿主返回形态）');
      return start[k];
    }
  }
  return null;
}


function spawnNoteOf(reason) {
  const tail = '⇒ 仅发句柄（请把 firstLine 交给直派形态；该形态门禁属 C 阶段）';
  if (reason === 'runtime-unavailable') {
    return '适配层 agent 功能面不可用（端口 `available=false`，成因 runtime-unavailable：服务未注入，或取值被 provider 侧守卫拒绝）' + tail;
  }
  return '适配层 agent 功能面**在位但不含可用启动入口**（成因 no-start-entry：两个入口皆不可调用；入口选择属 provider 内部）' + tail;
}

const activeRuns = new Map();
function trackOneShotRun(workerSessionId, run, warn) {
  if (!run || typeof run !== 'object' || !(run.result instanceof Promise)) {
    warn?.('start 返回载荷缺 `result`（Promise）⇒ run 终态不可跟踪（留痕不阻断；若宿主形态变更请按本载荷适配）');
    return;
  }
  activeRuns.set(workerSessionId, run);
  run.result.then(
    () => { activeRuns.delete(workerSessionId); },
    (e) => {
      activeRuns.delete(workerSessionId);
      warn?.('one-shot worker run 失败（留痕不进判定，结算走门禁）：' + String(e?.message ?? e) + ' · worker=' + workerSessionId);
    },
  );
}


// ── 派发核心（**唯一实现**：工具面与链引擎共用，禁第二套） ──────────────────────
export async function dispatchLaneCore({ ctx, store, root, liveConfig, exec, sessionId, batchId, lane, leaderPrompt = '', exempt, dispatchIndex }) {
  let laneTask = null;
  try {
    const wp = store.readBatch(sessionId, batchId)?.wavePlan ?? [];
    const flat = Array.isArray(wp) ? wp.flatMap((w) => w?.tasks ?? []) : (wp.tasks ?? []);
    laneTask = flat.find((t) => t && t.id === lane) ?? null;
  } catch { laneTask = null; }
  const roleData = resolveRoleRef(laneTask?.role, { warn: (m) => ctx?.logger?.warn?.(m) });
  const denyAllForAsk = [...new Set([...SUITE_DENY_TOOLS, ...(liveConfig?.dispatch?.denyTools ?? [])])];
  const askToolFace = { deny: denyAllForAsk };
  const askPersona = liveConfig?.dispatch?.persona !== undefined
    ? liveConfig.dispatch.persona
    : personaOfRole(roleData);
  const agentPort = createAgentPort(ctx, {
    presetFor: (ask) => {
      const presetId = typeof liveConfig?.dispatch?.agentPreset === 'string'
        && liveConfig.dispatch.agentPreset.length > 0
        ? liveConfig.dispatch.agentPreset
        : null;
      if (!presetId) return null;
      const coverage = liveConfig?.dispatch?.presetCoverage;
      const entry = coverage !== null && typeof coverage === 'object' ? coverage[presetId] : null;
      const tools = entry !== null && typeof entry === 'object' && Array.isArray(entry.tools) ? entry.tools : null;
      if (tools === null) return presetId;
      const deny = Array.isArray(ask?.toolFace?.deny) ? ask.toolFace.deny : [];
      if (deny.some((t) => tools.includes(t))) return null;
      return { preset: presetId, covers: [...tools] };
    },
  });
  if (agentPort.available && !agentPort.canNarrow({ role: laneTask?.role, toolFace: askToolFace, persona: askPersona })) {
    const presetConfigured = typeof liveConfig?.dispatch?.agentPreset === 'string'
      && liveConfig.dispatch.agentPreset.length > 0;
    const rejectedOf = (note) => ({
      batchId,
      lane,
      status: 'pending',
      spawned: false,
      mode: 'rejected',
      code: 'GATE_DISPATCH_CAPABILITY_UNAVAILABLE',
      spawnNote: note,
    });
    if (!presetConfigured) {
      return rejectedOf('通道在，但本次 ask 的收窄不可核：未配置 `config.dispatch.agentPreset`（无收窄见证）⇒ 拒派，不以弱换强。'
        + '功能面读数 = agent 端口 `available=true` 但 `canNarrow(本次 ask)` = false（收窄只能经 `agentPreset` 组 composition）；'
        + ' ⚠ 但 **`maxDepth` 原生可用**（`request.maxDepth`，受 `capabilities.depthLimit` 约束）——不是「什么都做不了」。'
        + ' 填 `config.dispatch.agentPreset`（指向已按 toolFace 收窄的 preset）后即可正常自派。'
        + ' ｜ 拒派打在状态变更之前：lane=' + lane + ' 保持待派发（无句柄、无 `member.dispatch` 事件、批相位不变）。');
    }
    return rejectedOf('通道在，但本次 ask 的收窄不可核：已配置 `config.dispatch.agentPreset`，'
      + '但适配层**无法核对**它对**本次**请求的收窄（真读数口径，P0-6 D-2）：需要 '
      + '`config.dispatch.presetCoverage[<preset 名>].tools` 声明该 preset **实际拿到**的工具面，'
      + '且该声明必须**非空**、并与本次要禁的工具集**不相交**（「声明为空集」不算收窄 —— 空集与任何集的交集恒为空，'
      + '那会让判据退化成恒真）。'
      + ' ⚠ **这不是「配置问题」**：`a1-gate` 上批实测 —— 纯 D 宿主**已配** `agentPreset` + `presetCoverage` 仍被拒，'
      + '成因是「**本次 ask** 的收窄不可核」，不是配置缺项、也不是通道不存在。'
      + ' ⇒ 拒派（不宣称未核实的收窄）｜ lane=' + lane + ' 保持待派发（无句柄、无 `member.dispatch` 事件、批相位不变）。');
  }
  const artifactsRoot = root
    ? String(root).replace(/[\\/]+$/, '') + '/sessions/' + sessionId + '/artifacts/' + batchId
    : undefined;
  const b = store.setMember(sessionId, batchId, lane, 'running', null, exempt, ownerOfExec(exec));
  const h = issueLaneHandle({ batchId, lane, sessionId });
  const base = { batchId, lane, status: b.lanes[lane], token: h.token, firstLine: h.firstLine, ttlMs: h.ttlMs };
  if (!agentPort.available) {
    return { ...base, spawned: false, mode: 'degraded', spawnNote: spawnNoteOf(agentPort.reason) };
  }
  const provider = liveConfig?.dispatch?.provider ?? null;
  if (!provider) {
    ctx?.logger?.warn?.('[dsh-punky-swarm] lane_dispatch: 未配置 config.dispatch.provider ⇒ 仅发句柄（不猜 provider）· lane=' + lane);
    return { ...base, spawned: false, mode: 'degraded', spawnNote: '未配置 config.dispatch.provider ⇒ 仅发句柄（补配置后重派，或用 firstLine 直派）' };
  }
  const injectBudget = readCapability(liveConfig, 'injectBudget');
  const prompt = composeWorkerPrompt({
    batchId, lane, cmd: laneTask?.cmd, layer: laneTask?.layer, role: roleData,
    consume: laneTask?.consume ?? [], produce: laneTask?.produce ?? [], outputs: laneTask?.outputs ?? [],
    firstLine: h.firstLine, leaderPrompt, artifactsRoot,
    batchSessionId: sessionId,
    singleArtifactWrite: laneTask?.singleArtifactWrite === true,
    injectBudget,
    archContext: renderArchContext({ targets: laneTask?.targets ?? null }),
    preflight: laneTask?.preflight ?? null,
    context: laneTask?.context ?? null,
    checkpoints: laneTask?.checkpoints ?? null,
    resume: laneTask?.resume === true,
    logger: ctx?.logger ?? null,
  });
  let start = null;
  try {
    if (!exec?.agent) throw new Error('缺少调用方 Agent —— 派发必须在工具流水线内调用（exec.agent 决定子会话挂载点）');
    const denyAll = [...new Set([...SUITE_DENY_TOOLS, ...(liveConfig?.dispatch?.denyTools ?? [])])];
    const denyDropped = new Set();
    for (let attempt = 0; ; attempt++) {
      try {
        const builtRequest = buildStartRequest({
          batchId, lane, parent: exec.agent, prompt,
          denyTools: denyAll.filter((n) => !denyDropped.has(n)),
          extraDeny: [],
          persona: liveConfig?.dispatch?.persona,
          role: roleData,
        });
        const boundSessionId = expectedWorkerSessionOf(store.readBatch(sessionId, batchId), lane);
        const pushed = await agentPort.push_execute(
          {
            runId: h.token,
            targetId: laneTask?.roster ?? lane,
            member: { id: laneTask?.roster ?? lane, title: laneTask?.role ?? undefined },
            session: { id: boundSessionId, params: null },
            taskPkg: { id: lane, wave: laneTask?.wave, deps: laneTask?.deps ?? [] },
            contract: {
              id: laneTask?.contract?.id ?? lane,
              sha256: laneTask?.contract?.sha256 ?? null,
            },
          },
          {
            provider,
            label: builtRequest.label,
            prompt: builtRequest.prompt,
            parent: exec.agent,
            signal: builtRequest.signal,
            role: laneTask?.role,
            toolFace: builtRequest.toolFilter,
            persona: builtRequest.persona,
            maxDepth: builtRequest.maxDepth,
            agent: exec.agent,
          },
        );
        if (pushed && pushed.errorCode === 'PUSH_UNCONFIRMED') {
          return { ...base, spawned: false, mode: 'degraded', unconfirmed: true, reason: 'PUSH_UNCONFIRMED' };
        }
        start = pushed?.run ?? { id: pushed?.sessionId ?? null };
        break;
      } catch (e) {
        const um = /unknown global tools?\s+["'`]?([A-Za-z0-9_.:-]+)/i.exec(String(e?.message ?? e));
        const unknownName = um ? um[1] : null;
        if (unknownName && !denyDropped.has(unknownName) && denyDropped.size < 8) {
          denyDropped.add(unknownName);
          ctx?.logger?.warn?.('[dsh-punky-swarm] lane_dispatch: 宿主工具面无 "' + unknownName
            + '" ⇒ 从 deny 名单移除后重试（0.1.7 兼容自愈，第 ' + (attempt + 1) + ' 次）');
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    const m = mapSpawnError(e);
    try { store.setMember(sessionId, batchId, lane, 'failed', 'dispatch-failed'); } catch {  }
    try { consumeLaneHandle(h.token, { batchId, lane }); } catch {  }
    throw new Error(m.code + ': ' + m.message
      + ' ｜ 已将 lane=' + lane + ' 置 failed（无 worker 挂载；派发失败即终态）⇒ 恢复步骤：记入 gap-list 并开新任务批次，'
      + '**不可原地重派**（K3：返工边 review→running 已去除，重派会被 `invalid member transition` 拒）；'
      + '如需人工核查：`gate_status({ batchId: "' + batchId + '", lane: "' + lane + '" })`。');
  }
  const workerSessionId = workerSessionIdOf(start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  if (!workerSessionId) {
    throw new Error('GATE_DISPATCH_FAILED: rt.start 未返回 worker 会话 id（载荷=' + JSON.stringify(start)
      + '） —— 契约字段为 `id`（`SubagentRun.id` = 子会话 id；与 `subagent/end` 事件 `info.id` 同源）；'
      + '宿主返回形态若变更请按本载荷适配。');
  }
  trackOneShotRun(workerSessionId, start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  const ownerSessionId = ownerSessionIdOfExec(exec);
  const budgetKey = injectBudget?.enabled === false ? { budgetEnabled: false } : {};
  store.appendEvent(sessionId, batchId, EVT_MEMBER_DISPATCH, ownerSessionId
    ? { lane, workerSessionId, ownerSessionId, ...budgetKey }
    : { lane, workerSessionId, ...budgetKey });
  if (dispatchIndex instanceof Map && workerSessionId && !dispatchIndex.has(workerSessionId)) {
    dispatchIndex.set(workerSessionId,
      dispatchIndexEntryOf(sessionId, batchId, lane, ownerSessionId));
  }
  try { consumeLaneHandle(h.token, { batchId, lane }); } catch {  }
  return { ...base, spawned: true, workerSessionId };
}

export function readGateMode(config) {
  return 'warn';
}

export function configuredGateMode(config) {
  const m = config?.dispatch?.gate;
  return typeof m === 'string' && m.length > 0 ? m : null;
}


export function laneBindingOf(store, sessionId, logger) {
  if (!sessionId || !store || typeof store.listAllBatches !== 'function') return null;
  let all = [];
  try {
    all = store.listAllBatches() ?? [];
  } catch (e) {
    logger?.warn?.('[dsh-punky-swarm] batch-enum-failed: ' + String(e?.message ?? e)
      + '（laneBindingOf · session=' + sessionId + '）⇒ 返 null；这是**枚举失败**，不是「无批绑定」');
    return null;
  }
  for (const { sessionId: ownerSession, batchId } of all) {
    let b = null;
    try {
      b = store.readBatch(ownerSession, batchId);
    } catch (e) {
      logger?.warn?.('[dsh-punky-swarm] batch-read-failed: ' + String(ownerSession) + '/' + String(batchId)
        + '（' + String(e?.message ?? e) + '）⇒ 跳过该批继续；这是**读失败**，不是「批不存在」');
      continue;
    }
    for (const ev of b?.events ?? []) {
      if (ev?.type === 'member.dispatch' && ev.workerSessionId === sessionId && ev.lane) {
        const bind = { sessionId: ownerSession, batchId, lane: ev.lane };
        const owner = ownerSessionIdOf(ev);
        if (owner) {
          Object.defineProperty(bind, 'ownerSessionId', {
            value: owner, enumerable: false, writable: true, configurable: true,
          });
        }
        return bind;
      }
    }
  }
  return null;
}

export { mailboxRootOf } from '../mailbox-paths.js';

export const REPORT_CHANNEL = Object.freeze({ leader: 'broadcast', manager: 'inbox' });

export function evaluateTierCDispatch({ tier, toolName, argsText, config, handleCheck }) {
  const mode = readGateMode(config);
  const configuredMode = configuredGateMode(config);
  const isDispatchTool = toolName === 'subagent' || toolName === 'subagent_fork';
  if (!isDispatchTool || tier !== 'C') {
    return { applies: false, ok: true, mode, configuredMode, handleReason: null, denyReason: null, warnNote: null };
  }
  const r = typeof handleCheck === 'function' ? handleCheck(argsText) : { ok: false, reason: 'no-handle-check' };
  if (r.ok) return { applies: true, ok: true, mode, configuredMode, handleReason: null, denyReason: null, warnNote: null };
  const handleReason = r.reason ?? 'invalid-handle';
  return {
    applies: true, ok: true, mode, configuredMode, handleReason, denyReason: null,
    warnNote: 'dispatch without valid lane handle under tier C（生效档=' + mode
      + (configuredMode === null ? '' : '，配置写的是 ' + configuredMode)
      + '；留痕不拦，`enforce` 拒态已随码删除且**勿回加**）'
      + ' · tool=' + toolName + ' · handle=' + handleReason
      + ' —— 仍建议：先 `lane_dispatch({ batchId, lane })` 取句柄并把 `firstLine` 写入子代理任务包首行。',
  };
}

export const MODE_INACTIVE_CODE = 'GATE_MODE_INACTIVE';

export function presetOfSession(exec) {
  const p = exec?.agent?.session?.header?.agentPreset;
  return typeof p === 'string' && p ? p : null;
}

export function isChildSession(exec) {
  const h = exec?.agent?.session?.header;
  return !!(h && (h.delegationDepth > 0 || h.parentSession));
}

export function normalizeModeGate(raw, warn) {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const bad = raw.filter((x) => typeof x !== 'string' || x === '');
    if (bad.length) {
      warn?.('modes.gate 元素须为非空字符串（got ' + JSON.stringify(bad) + '）⇒ 回落「全模式生效」');
      return null;
    }
    return [...raw];
  }
  warn?.('modes.gate 须为字符串数组或 null（got ' + JSON.stringify(raw) + '）⇒ 回落「全模式生效」');
  return null;
}

/**
 * @param config 当前生效配置快照
 * @param exec   工具调用上下文
 * @returns {boolean} true = 启用（旧行为）；false = 本模式不生效 ⇒ 门禁/计数/套件工具全部不介入
 */
export function modeActiveFor(config, exec, warn) {
  const gate = normalizeModeGate(config?.modes?.gate, warn);
  if (gate === null) return true;
  if (isChildSession(exec)) return true;
  const preset = presetOfSession(exec);
  return preset !== null && gate.includes(preset);
}
