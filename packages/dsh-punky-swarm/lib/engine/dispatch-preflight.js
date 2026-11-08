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

// 派发面 · 开工前必做 + checkpoint 渲染（纯函数，输入声明 → 输出文本）。

import { applyInjectionBudget } from '../comms/inject-budget.js';
import { normalizeCheckpoints } from '../wave-plan.js';
import { listOf } from './dispatch-role.js';

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
