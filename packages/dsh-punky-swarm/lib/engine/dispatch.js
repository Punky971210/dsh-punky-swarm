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

// engine/dispatch.js —— **引擎自派**（engine-side dispatch）：C 档集群派发的执行通道。
// 定位：
//   · **可见性期收窄是唯一按次可用的收窄通道**：宿主 `subagent` 工具的模型面参数**不含** `toolFilter`
//     （`dsh-tool-subagent/lib/index.js:402-428`；`toolFilter` 只在插件配置 zod schema `:255-269` = 部署期静态），
//     而 `ctx.subagents.start(name, request)` 的 `request.toolFilter` 是**按次**的（one-shot 与 continuable 走
//     **同一** `applyChildComposition`，`dsh-subagent-in-process-driver/lib/index.js:173-176`）
//     ⇒ 只有程序化调用者（= 本模块）能按次收窄。
//   · **能力位前置**（调研收敛点 K4，5 源共识）：provider 不支持 `toolFilter` 时**拒派**，不「以弱换强」。
//   · **唯一写路径**（改善 W6）：自派成功后由引擎**直接写** `member.dispatch{lane, workerSessionId}`，
//     不再依赖 post-execute 事后观察（观察保留为兜底，覆盖 Leader 直派旧形态）。
//   · **失败显式**（修 W5）：任何失败路径都给出可读原因，不静默降级。
// 本模块是**纯函数 + 策略常量**（便于单测）；真正的 spawn 调用在 `lib/tools/core.js` 的 `lane_dispatch` 内
//   （必须在**工具流水线内**执行：`exec.agent` 在场，子会话才能正确挂到本会话）。
//
// ── 【2026-09-22 · one-shot 化（用户裁定「dispatch 彻底改为一次性执行器语义」）】 ──────────
//   · **spawn 通道**：`startContinuable` → **`rt.start(provider, request)`**（one-shot，fire-and-forget）：
//     run 生命周期属主 = 本模块 `activeRuns` 持有的 run 对象（`dsh-subagent-in-process-driver` 文件头：
//     "the one quiescent lifecycle owner held by the provider's caller"），**与 Leader 工具回合无关**；
//     引擎持引用、不调 `dispose` ⇒ worker 跑到完成（V-1 三层互证，见活体核报告）。
//   · **signal 纪律（禁透传 `exec.signal`）**：官方工具 foreground 用 `exec.signal`、background **故意新建
//     controller**（`dsh-tool-subagent/lib/index.js:559 / :543`）——`exec.signal` 随工具调用结束而中止 ⇒
//     本模块缺省**自持永不中止 signal**（`new AbortController().signal`），保 worker 跨回合跑完。
//   · **能力退役**：引擎侧**零** steer/queuePrompt/coldResume 依赖（2026-09-22 全库取证，19 条命中逐条判读）；
//     send_message worker 唤醒（continuous 专属）随 S2 退役。durable 会话/唤醒/续跑等 continuous 能力
//     **全部归 teammate runner**（agent-team 方案，`docs/agent-team-bridge-design-draft-v0-2026-09-21.md` §4/B5）
//     —— 两方案共用黑板与门禁，**不共用会话语义**。
//   · 依据：`docs/dispatch-one-shot-redesign-plan-2026-09-21.md` + 活体核
//     `docs/dispatch-one-shot-verification-2026-09-21.md`（V-1/V-2/V-3 全过）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueLaneHandle, consumeLaneHandle, firstLineOf } from '../bridge/lane-handle.js';
// 派发登记事件常量（原在 `lib/tools/core.js` 侧引用；派发核心抽出后由本模块写，故此处直引）
// 【2026-09-18 · Q-B 取消并发闸】原同址直引的 `EVT_GATE_CONCURRENCY_BLOCKED` 已从本模块写端移除（唯一写点
//   随闸删除）；常量本体仍在 `lib/state/event-types.js` **冻结保留**（历史批磁盘事件面读端逐字不变）。
import { EVT_MEMBER_DISPATCH } from '../state/event-types.js';
// 【2026-09-18 · Q-B】原 `isBatchTerminal` 只为并发闸判据的「让位面」而引（`concurrencyVerdictOf`
//   的 `batch-terminal` 分支）；闸取消后本模块**零读点** ⇒ import 一并删除（不保留第二套批终态判据）。

/** 成员 deny 集（B2 的 deny 清单，S2 起含宿主连续控制族 4 件 ⇒ 20 项）+ 模式门覆盖集：**单点注册表在 `engine/suite.js`**（`SUITE_TOOLS`），
 *  本模块 `import` 后**再导出**（导出名不变、内容随注册表演进；不得退回字面量）。
 *  ⚠ 必须 `import` + `export {}` 两句分开写：`export … from` 只做透传、**不建本地绑定**，
 *  而本模块的 `buildStartRequest({ denyTools = SUITE_DENY_TOOLS })` 缺省值依赖本地符号（活体实测报 ReferenceError）。
 *  口径边界、`subagent`/`subagent_fork` 必 deny 的理由、以及 `mcp__*` 不入表的口径，均随实现迁至 `suite.js` 表头注释。 */
import { SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from './suite.js';
export { SUITE_DENY_TOOLS, MODE_GATED_TOOLS };

/**
 * 第二绑定键（B3，学 agent-teams 的 label 做法）：可从**子会话事件/描述**反解析 (batchId, lane)，
 * 不依赖引擎内存，重启后仍可核。
 */
const LABEL_PREFIX = 'punky-swarm:';

// N1-R4-1b：**派发面 owner 取值**（唯一来源 = 调用方 Agent 标识）。取不到 ⇒ `null` ⇒ `setMember` **零写入**
//   （既有行为不变）——owner 是声明面，缺失只影响池视图，不阻断任何门禁。
const ownerOfExec = (exec) => exec?.agent?.id ?? exec?.agent?.agentId ?? exec?.agent?.session?.id ?? null;
export function labelOf(batchId, lane) {
  return LABEL_PREFIX + String(batchId) + ':' + String(lane);
}

// ── role 数据面（P2 · 批 `role-injection-refactor-20261006` / lane `e02-inject`）─────────────────
// 三处注入（依据判据源 `plan/role-injection-spec.md` 的 R-3/R-4/R-5 ＋ 计划 §2.3/§2.4）：
//   ① `composeWorkerPrompt()`：role 独占「## 你的职责 / ## 你被授权决定 / ## 交付要求」三段；
//   ② `buildStartRequest().persona`：由 role 的 `title` + `mission` + 工作方式（正文 Persona 段）派生
//      —— 同 role 跨批稳定；
//   ③ `buildStartRequest().toolFilter.deny`：由 `tools.allow` **反推**，与冻结集 `SUITE_DENY_TOOLS` 合并。
// **结构隔离代替优先级判定**（计划 §2.4）：Leader 的 `prompt` 只有一个落点
//   `## 任务要点（Leader 补充）`，role 三段与「## 纪律」段 Leader **无位置可写** ⇒ 不存在覆盖问题；
//   故本段**不含**任何「谁优先」的判定器（一处都不许有 —— 那是被明令否决的实现路径）。
// **降级路径**（计划 §10.4 Q-5 = 乙→甲）：role **已声明但解析不到** ⇒ **拒派**（`GATE_ROLE_UNRESOLVED`），
//   **不得**静默退回硬编码骨架（零静默，C-8）。**未声明 role**（`null` / `undefined` / 空串，如 generic
//   lane）不是「查不到」⇒ 维持既有骨架形态（**零行为变化**）。
// **单点真源**（N-1）：role 解析 + allow→deny 反推各只有一处实现（本段）；`lib/wave-plan.ts` 只做 role
//   **归一化与合法集校验**（layer 缺省 + `GATE_ROLE_INVALID` 告警），不持有任何数据面解析。

/** role 解析不到的**拒派码**（与「能力位前置 = 拒派」同口径；零静默）。 */
export const ROLE_UNRESOLVED_CODE = 'GATE_ROLE_UNRESOLVED';

/** 三段**裸标题**（行首逐字、**无后缀**）：写成 `## 你的职责（…）` 会让裸标题判据失配。 */
export const ROLE_SECTION_TITLES = Object.freeze({
  responsibilities: '## 你的职责',
  authorities: '## 你被授权决定',
  deliverables: '## 交付要求',
});

/** 必填字段（计划 §3.2「缺一即拒」）。**`deliverables` 不在其中**（本批 R-1 起转**可选**）：
 *  它是角色级**形态提示**，不是硬真源 —— 批次级产物路径归 `wavePlan.produce/outputs` ＋ `handoff_submit`；
 *  故缺席**不判缺、不抛 `GATE_ROLE_UNRESOLVED`、不回落**（零静默由「交付要求段少行/占位」表达，不由拒派表达）。
 *  **只对文件解析面生效**：模块级直调传入的 role 对象不强制，
 *  因为直调只构造需要的字段位（见判据源 L-AC-3/L-AC-4 的可达构造）。 */
export const ROLE_MANDATORY_FIELDS = Object.freeze(['id', 'title', 'layer', 'mission', 'responsibilities']);

/** 默认团队（同 id 跨团队重名时的**团队序首位**）。依据 = 仓库既有约定
 *  `test/helpers/skill-paths.mjs` 的 `withDefaultTeam(byName, team = 'software-team')`，非本段新造。 */
const DEFAULT_ROLE_TEAM = 'software-team';
const ROLE_DIR_SEGMENTS = ['references', 'roles'];

/** 包根（`lib/engine/` → 包根）：role 语料库（`<包根>/skills/<team>/references/roles/`）的起点。 */
export function roleCorpusRoot() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/** 角色语料目录（**团队序**：默认团队优先，其余按目录名字典序）。目录不在场 ⇒ 该团队不参与解析。 */
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

// ── YAML frontmatter 子集解析（**无第三方依赖**，只覆盖 role 语料的实际形态）──────────────────────
// 覆盖面：顶层 `key: 标量` / `key: [a, b]` / `key:` + `  - 标量` / `key:` + `  - k: v`（含续行）
//         / 嵌套映射（`tools:` + `  allow: […]`）。**不覆盖**多行块标量、锚点、注释块——语料内不存在。
const KV_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/;

function stripQuotes(raw) {
  const s = String(raw ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** inline 列表 `[a, b]` → 数组（**引号内的逗号不算分隔符**）；非列表形态 ⇒ null。 */
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

/** 块体解析：`- 标量` 列表 / `- k: v`（含续行）对象列表 / 映射。 */
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

/** 解析 role 文件的 YAML frontmatter（`---` 围栏之间的顶层键）。无围栏 ⇒ null。 */
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

/** 正文段抽取（行首恰为 `## <heading>` 起、至下一个 `## ` 前）：取「工作方式」= `## Persona（注入用）`。 */
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

/** 文件文本 → role 数据对象（必填缺一即抛 `GATE_ROLE_UNRESOLVED`）。 */
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
 * role 解析（**单点真源**）：
 *   · 已是对象 ⇒ 原样直用（模块级直调 / 引擎内部已解析面）；对象缺字段**不**在此强制（直调只构造需要的位）；
 *   · 非空字符串 ⇒ 按团队序在语料库内查 `<team>/references/roles/<id>.md`；零命中 ⇒ **抛 `GATE_ROLE_UNRESOLVED`**；
 *     多命中（同 id 跨团队重名，如 `designer` / `coordinator`）⇒ 按团队序取首个并**留痕告警**（确定性 + 可复现）；
 *   · `null` / `undefined` / 空串 ⇒ **null**（= 未声明，**不是**「查不到」）⇒ 调用方维持既有形态。
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
    try { if (fsImpl.statSync(file).isFile()) hits.push(file); } catch { /* 该团队无此 role */ }
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

/**
 * 引擎 role 语料库的**工具词汇表** = 全部 role 文件 `tools.allow` 的并集（保序去重）。
 * ⚠ 结构安全（**这是「反推全集」的选型理由，勿改回 `SUITE_TOOLS`**）：词汇表**只由 role 语料自身生成**
 *   ⇒ 它**结构上不可能**含引擎治理面工具（`handoff_submit` / `swarm_report` / `lane_checkpoint` /
 *   `batch_status` … 都不在任何 role 的 allow 内）⇒ 反推**不可能** deny 掉 worker 的回报/交接面。
 *   若把全集取成 `SUITE_TOOLS`（38 件），反推会把上述治理面整体 deny ⇒ **worker 再也交不了接、回不了报**
 *   （与任务包纪律「必须 `handoff_submit`」直接矛盾）—— 该路径已实测排除。
 */
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

/** `tools.allow` **反推 deny**（R-5）：`词汇表 \ allow`。
 *  未声明 / 空 `allow` ⇒ 返回 `[]`（**不反推**）—— 否则「无工具声明」会被反推成「全词汇表 deny」，
 *  静默阉割 worker 的读写能力（零静默：宁可不禁，不许误禁）。 */
export function deriveDenyTools(allow, opts = {}) {
  const list = (Array.isArray(allow) ? allow : [])
    .filter((t) => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim());
  if (!list.length) return [];
  return roleToolVocabulary(opts).filter((t) => !list.includes(t));
}

/** 人格级注入（R-4）：`title` + `mission` + 工作方式（role 正文 `## Persona（注入用）` 段）。 */
export function personaOfRole(roleData) {
  if (!roleData || typeof roleData !== 'object') return undefined;
  const parts = [roleData.title, roleData.mission, roleData.persona_text]
    .map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return parts.length ? parts.join('；') : undefined;
}

function listOf(v) { return Array.isArray(v) ? v : []; }

/** 任务级三段渲染**单点**（D-0 / R-1）——**role 独占**：职责（含 mission）/ 授权 / 交付要求
 *  （形态 `form` + `must_contain` + 规格指向 `skills` + `acceptance_hints`）。
 *
 *  **边界约定（防行为漂移，逐字受判据源 `## 方案` 3 约束）**：
 *   · 返回**不含前导空行**、**不含尾随空行**的三段块文本（以 `\n` 连接）；
 *   · 首行**恰为** `ROLE_SECTION_TITLES.responsibilities`；末行 = 最后一条交付件/达标提示行；
 *   · 前导空行归**调用方**（`appendRoleSections` 的 `L.push('')`）、尾随空行归 `composeWorkerPrompt`
 *     —— **二者都不得**被吸进本单点（吸进来即改变 C-1 产出的字节）。
 *
 *  **纯函数、零 IO**：只吃**已解析**的 role 对象。**禁**把 `resolveRoleRef` 搬进来、**禁**接受 role id 字符串
 *  —— 解析单点（`resolveRoleRef`）与渲染单点（本函数）**两个单点、不许合并**（N-1）。
 *  三段标题**只**经 `ROLE_SECTION_TITLES` 产出（R-5：禁在别处再写字面量）。
 * @param {object} roleData 已解析的 role 数据对象
 * @returns {string} 三段块文本
 */
export function renderRoleGuide(roleData) {
  const L = [];
  L.push(ROLE_SECTION_TITLES.responsibilities);
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
    // 【本批 R-2/R-3】只读**形态**（`form`）：`path` 键**不读、不回落** ⇒ 段内「零路径」由**代码保证**，
    //   不依赖语料侧自觉（语料漏改也不会把路径渲进任务包）。
    //   形态**不加反引号**：反引号在本渲染色里表示「可照抄的字面量」，形态是自然语言，加引号会误导。
    //   缺形态 ⇒ 显式占位**非空串**（省成空串会渲染出空反引号对，破 R-2b 的零空反引号护栏）。
    const form = (typeof d === 'string') ? d.trim() : String(d?.form ?? '').trim();
    const must = (d && typeof d === 'object' && Array.isArray(d.must_contain)) ? d.must_contain : [];
    L.push('- 交付件：' + (form || '（形态未声明）'));
    if (must.length) L.push('  - 必含结构：' + must.map((x) => '`' + x + '`').join(' / '));
  }
  // 【本批 R-4】role 的 `skills:` 字段**成为注入源**（通道 B · 规格指向）：保序、原样、不筛选、不去重。
  //   与 `lib/wave-plan.ts` 的 `[skills=…]` 前缀通道（通道 A · 装配声明）**无优先级关系** —— B **不回填** A
  //   （不写 `t.skills`、不进 `cmd`、不入任务 sig）；两通道**并存渲染、零仲裁器**。
  //   `skills` **不进** `ROLE_MANDATORY_FIELDS`：未声明 ⇒ 本段**少一行**（可见、不静默），不拒派、不回落。
  const skills = listOf(roleData?.skills);
  if (skills.length) L.push('- 规格：见技能 ' + skills.map((s) => '`' + s + '`').join(' / '));
  const hints = listOf(roleData?.acceptance_hints);
  if (!deliverables.length && !skills.length && !hints.length) L.push('- （role 未声明）');
  for (const h of hints) L.push('- 达标提示：' + h);
  return L.join('\n');
}

/** `composeWorkerPrompt` 侧的三段**适配器**（薄壳，零逻辑）：前导空行由本层给，三段块本体来自单点。
 *  等价式（判据源 `## 方案` 3 写死）：`appendRoleSections(L, roleData)` ≡ `L.push('')`
 *  ＋ `L.push(...renderRoleGuide(roleData).split('\n'))`。**禁**在此再写任何三段模板/标题字面量。 */
function appendRoleSections(L, roleData) {
  L.push('');
  L.push(...renderRoleGuide(roleData).split('\n'));
}

/** 头行「角色」格：`<裸 role 名>（<title>）` —— **保留裸名**（既有读端断言 `` `coder` `` 不破）＋ 补标题。 */
function roleCellOf(roleRef, roleData) {
  const bare = (typeof roleRef === 'string' && roleRef.trim())
    ? roleRef.trim()
    : String(roleData?.id ?? roleData?.title ?? '-');
  return roleData?.title ? '`' + bare + '`（' + roleData.title + '）' : '`' + bare + '`';
}

/**
 * 成员任务包**骨架**（B1）：引擎侧给出「角色 / 目标 / 契约 / 产物 / 纪律」，Leader 的 `prompt` 作为任务要点追加。
 * 契约要点（与 discipline §0e 一致）：只给要素、不写实现；写盘走 edit/write；产物落批次产物根。
 */
export function composeWorkerPrompt({
  batchId, lane, cmd, layer, role, consume = [], produce = [], outputs = [], firstLine, leaderPrompt = '', artifactsRoot,
  // 【2026-09-27 · GR-13】「单件写盘 lane」显式声明位（缺省 `false` ⇒ 既有任务包逐字不变）。
  //   直调调用方可显式置 `true`；派发路径的**自动判定**见函数内 `singleArtifactWriteLane`。
  singleArtifactWrite = false,
  // 【2026-10-07 · P2】role 语料定位位（缺省 = 包根 `skills/`）；直调与隔离测试可显式指定。
  roleRoot, roleTeam,
}) {
  // role 解析（**单点真源**）：对象直用 / id 串查语料库（查不到 ⇒ 抛 `GATE_ROLE_UNRESOLVED`）/ 未声明 ⇒ null。
  const roleData = resolveRoleRef(role, { root: roleRoot ?? roleCorpusRoot(), team: roleTeam });
  const L = [];
  L.push(firstLine); // 首行：句柄标记（唯一凭证；引擎只读 exec.arguments，不注入参数）
  L.push('');
  L.push('# 任务包（引擎自派 · ' + labelOf(batchId, lane) + '）');
  L.push('- **lane**：`' + lane + '`｜**层**：`' + (layer ?? '-') + '`｜**角色**：' + roleCellOf(role, roleData));
  L.push('- **目标**：' + String(cmd ?? '（未声明 cmd）'));
  if (consume.length) L.push('- **消费件**：' + consume.map((p) => '`' + p + '`').join('、'));
  if (produce.length) L.push('- **产出面**：' + produce.map((p) => '`' + p + '`').join('、'));
  if (outputs.length) L.push('- **产物**：' + outputs.map((p) => '`' + p + '`').join('、'));
  if (artifactsRoot) L.push('- **批次产物根**：`' + artifactsRoot + '`（产物落此处，勿落工作区根）');
  // 【2026-10-07 · P2】role 三段（**结构隔离**，计划 §2.4）：本段由 role 数据独占，Leader 的 `leaderPrompt`
  //   只落在末尾的 `## 任务要点（Leader 补充）` ⇒ **结构上不存在覆盖关系**（无「谁优先」判定器）。
  if (roleData) appendRoleSections(L, roleData);
  L.push('');
  L.push('## 纪律');
  // 【2026-09-27 · 规则编号动态化】原为**字面 1..6**（第 6 条按层裁剪）⇒ 新增规则会撞号。
  //   改为**计数器**逐条编号：规则文本逐字不变，仅编号由 `rule()` 递增产出（缺规则也不会跳号）。
  let ruleNo = 0;
  const rule = (text) => { ruleNo += 1; L.push(ruleNo + '. ' + text); };
  rule('写盘只用 `edit`/`write`；临时件用 `node -e` 的 `fs`；UTF-8 无 BOM、LF。');
  rule('禁 `git` 写；禁重启宿主；只碰本 lane 文件域。');
  rule('断言「没有某工具/技能」前先实机核：`grep`/`glob` 扫宿主安装面与引擎源码，或按名直调看回执（折叠 ≠ 禁用），勿凭印象断言「没有」。');
  rule('完成/失败均**显式回报**（不给静默降级）；回报只给元数据与结论，不复制正文。');
  // ── 【2026-09-27 引导缺口补强】收本会话 5 次 `auto.settle.paused` 的教训 ──────────────
  //   实证：批 onto-engine-slim-20260926 中 4 次停轮源于「exec 线漏向聚合 audit lane 交接」
  //   （`GATE_HANDOFF_MISSING`）、1 次源于「plan 产物缺裸标题 `## 约束`」（`GATE_PLAN_CONTRACT`）。
  //   **根因不是成员失职，而是任务包没写清** —— 故在此把两条硬要求前置到骨架里。
  rule('**【交接】完成时必须 `handoff_submit` 向【本 lane 的全部出边】交接**（含**聚合 audit lane**）——');
  L.push('   若本批含 audit 层而本 lane 是 plan/exec 层，则该边**必须交**；漏交会被 `GATE_HANDOFF_MISSING` 拒，');
  L.push('   批会被停轮。对 `a1-*` 这类**聚合 audit lane**（有多个入边），**每条上游线都要各自交一次**。');
  if (layer === 'plan') {
    rule('**【plan 产物】正文必须含六个【裸标题】**（行首恰为该串，非 `###`、无缩进/前缀）：');
    L.push('   `## 概述` / `## 问题` / `## 方案` / `## 需求` / `## 验收标准` / `## 约束`；');
    L.push('   **内容允许为空，标题一个都不能缺** —— 缺任一即被 `GATE_PLAN_CONTRACT` 拒（内容不校，只校标题）。');
  }
  // ── 【2026-09-27 · GR-12】回报编号口径消歧（收「exec 验收项被写成 spec 自检项编号」的停轮教训）──
  //   背景：任务包曾把「exec 报告的验收项」称作自检项的编号；而判据源 `## 验收标准` 章内的自检项编号
  //   与 **exec 验收项**（在判据源 **§6**，形如 `L-AC-1..L-AC-N`）是**两套编号** ⇒ worker 按错位编号回报。
  rule('**【回报编号口径】**本 lane 的**验收项**编号以**判据源 §6** 为准（形如 `L-AC-1..L-AC-N`）；');
  L.push('   判据源 `## 验收标准` 章内的自检项编号属于**规格自检**，**不是**本 lane 的验收项。');
  L.push('   回报引用验收项时：**照抄 §6 的编号 + 原文**（禁自行重排、禁把自检项编号当作验收项回填）。');
  // ── 【2026-09-27 · GR-13】「单件写盘 lane」与纪律 progress 快照的冲突处置 ──
  //   背景：audit 聚合 lane 的硬约束「只写一件」（判据源明列）与「每完成一子步骤即落 progress 快照」
  //   直接冲突，worker 只能靠自行判断 ⇒ 引擎侧按 lane 的**写盘约束**自动抑制 progress 行。
  //   判定（保守、可机检）：① 显式 `singleArtifactWrite === true`；**或** ② **audit 层**且声明写盘面
  //   （`produce ∪ outputs` 去重）**恰一件**。exec / plan 层**不自动判**（progress 是其工作流组成部分）
  //   ⇒ 只走显式声明位。
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
  if (leaderPrompt) {
    L.push('');
    L.push('## 任务要点（Leader 补充）');
    L.push(leaderPrompt);
  }
  return L.join('\n');
}

/** 组装 `rt.start(provider, request)` 的 **one-shot 请求载荷**（纯函数，便于单测）。
 *  【2026-09-22 · one-shot 化】原 `buildStartSpec`（continuable 嵌套形态 `{provider,label,signal,request:{…}}`）
 *  改为**平铺 one-shot 请求**（`SubagentStartRequest`：`{label,prompt,parent,signal,toolFilter,persona?,maxDepth}`）；
 *  `provider` 改由调用方直传 `rt.start(provider, request)`（原 `spec.provider` 字段随形态删除）。
 *  ⚠ 活体实测（2026-09-16，批次 `suite-live-20260916` 首派第二层报错抓出）：宿主 `signal` 是**运行时必需字段**
 *  （缺它即抛 `Cannot read properties of undefined (reading 'throwIfAborted')`，由本模块 `mapSpawnError`
 *  归一为 `GATE_DISPATCH_FAILED`）——本字段纪律延续。
 *  ⚠ **signal 纪律（one-shot 化新增，禁透传 `exec.signal`）**：缺省给**自持永不中止**的 signal（worker 不随
 *  Leader 回合取消而中断；官方 background 分支实证 `exec.signal` 会随工具调用结束 abort，见头部「signal 纪律」）；
 *  调用方可注入自有 signal 以显式支持取消。
 *  `label`（B3）由宿主快照进子会话 descriptor（`dsh-subagent/lib/index.js:3155-3159`）⇒ 重启后仍可核。 */
export function buildStartRequest({
  batchId, lane, parent, prompt, denyTools = SUITE_DENY_TOOLS, extraDeny = [], persona, role, roleRoot, roleTeam,
  maxDepth = 1, signal,
}) {
  // 【2026-10-07 · P2】role 派生面（**单点真源**：与 `composeWorkerPrompt` 同一解析函数 `resolveRoleRef`）：
  //   ② 人格级 `persona`（R-4）：调用方**显式给值优先**（缺省派生位），否则由 role 的
  //      `title` + `mission` + 工作方式（正文 Persona 段）派生 —— 同 role 跨批稳定；
  //   ③ 权限级 `toolFilter.deny`（R-5）：冻结集 `SUITE_DENY_TOOLS` ∪ **allow 反推集** ∪ 追加集，
  //      **去重后保序**（冻结集逐项不缩水）。
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

/**
 * spawn 失败的**显式映射**（B4 能力位前置 + B6 失败显式）：
 * 宿主在 provider 缺 `toolFilter`/`depthLimit` 能力时会自行拒绝（`dsh-tool-subagent/lib/index.js:370/377`），
 * 本函数把其文案归一到我们的码面，便于调用方与审计识别。
 * @returns {{code: string, message: string}}
 */
export function mapSpawnError(err) {
  const raw = String(err?.message ?? err ?? '');
  if (/capabilit|toolFilter|depthLimit/i.test(raw)) {
    return { code: 'GATE_DISPATCH_CAPABILITY_MISSING', message: 'provider 能力位不足（toolFilter/depthLimit）⇒ 拒派，不以弱换强：' + raw };
  }
  if (/provider|unknown provider|not resolvable/i.test(raw)) {
    return { code: 'GATE_DISPATCH_PROVIDER_INVALID', message: 'provider 不可解析（检查 config.dispatch.provider）：' + raw };
  }
  return { code: 'GATE_DISPATCH_FAILED', message: '引擎自派失败：' + raw };
}

/** `rt.start` 返回的 `SubagentRun` → worker 会话 id（one-shot 化语义）。
 *  **主字段 = `id`**（`SubagentRun.id` = 子会话 id，`dsh-subagent-in-process-driver` :166/:219 实证；
 *  与宿主 `subagent/end` 事件的 `info.id` 同源 —— V-3 已核，S3 观察桥据此对齐）。
 *  兼容回落 `childId`/`subagentId`（continuable 时代契约字段，防御宿主形态漂移）：回落命中**显式告警**。
 *  旧写法 `start.id ?? start.subagentId ?? start.childId` 是**猜字段且不告警**：宿主形态一变即静默 null。
 *  取不到时**不静默**：返回 null，由调用方带**原始载荷**报错。
 *  ⚠ 勿与 `runId`（宿主观察 id，`observeRun` 的 `SubagentRunId(randomUUID())`）混淆 —— 登记面只用**会话 id**。 */
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

/** `ctx.subagents` 是否可用（能力探测；缺省即降级为「仅发句柄」，不硬失败）。
 *  ⚠ 活体实测（2026-09-16，本批 suite-live-20260916 首派抓出）：cordis 对**未在 inject 声明的服务**
 *  在取属性时**直接抛** `cannot get property "subagents" without inject`（不是返回 undefined）
 *  ⇒ 取用必须包 try/catch，否则引擎自派以原始 cordis 错崩掉，而不是走既定的「仅发句柄」降级分支（B1 语义）。
 *  正解是 `lib/index.js` 的 `inject` 补 `subagents`（声明依赖）；本 try/catch 是兜底不崩。
 *  【2026-09-22 · one-shot 化】探测面 `startContinuable` → **`start`**（one-shot 唯一通道）。 */
export function subagentRuntimeOf(ctx) {
  let rt = null;
  try {
    rt = ctx?.subagents ?? null;
  } catch {
    return null; // 未注入/注入守卫抛错 ⇒ 视为不可用（降级为「仅发句柄」，不崩）
  }
  return rt && typeof rt.start === 'function' ? rt : null;
}

// ── 【2026-09-22 · one-shot 化】run 生命周期属主登记 ──────────────────────────────
// `activeRuns` = 本进程在飞的 one-shot worker run 表（key = workerSessionId）。**唯一的 quiescent
//   lifecycle owner 是调用方持有的 run 对象**（driver 文件头明言）⇒ 引擎必须持引用直到 result settle，
//   既防 GC 语义歧义，也为将来「批次中止 ⇒ 取消 worker」留取消入口（`run.dispose()`，本批不接线）。
//   result settle ⇒ 自动摘除；rejection ⇒ **显式告警留痕**（一次性 run 失败不许静默），**不进黑板判定**
//   （结算仍走门禁——"事件由引擎写、结算走门禁"纪律不变）。
const activeRuns = new Map();
/** one-shot run 终态跟踪（非抛出：跟踪失败只告警，绝不影响派发成功路径）。 */
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
/** 在飞 one-shot worker 数（观测面；测试与心跳探针用，**零判定**）。 */
export function activeRunCount() {
  return activeRuns.size;
}


// ── 派发核心（**唯一实现**：工具面与链引擎共用，禁第二套） ──────────────────────
// P2（批次 `p2-chain-autodrive-20260916`，lane e-chain）抽出：原实现内联在
//   `lib/tools/core.js` 的 `lane_dispatch.execute`；推进链的自动派发（`lib/engine/chain-runner.js`）
//   必须与工具面**走同一条**派发路径（同 Tier3 entry 门、同句柄、同 worker 任务包骨架、同
//   `member.dispatch` 登记），否则「链自派」与「人工派发」会在门禁/登记面分裂。
//
// 句柄生命周期口径（P0 修复，Leader 裁决 ⑤，2026-09-16）——**自派即发放即作废、仅直派形态需长期有效**：
//   · **成功自派**：`member.dispatch` 登记后会立即 `consumeLaneHandle` ⇒ 句柄从 `pendingHandles` 摘除
//     （形态：引擎已把 worker 拉起来，句柄的「派发凭证」使命已完成；留着只会让绑定缺口探针
//     `bindingGapOf` 把已绑定的 lane 误报成 `token-ttl-expired` 幽灵信号）。
//   · **降级「仅发句柄」两分支**（宿主无 `ctx.subagents` / 未配置 `config.dispatch.provider`）：
//     **不得消费**——此时句柄是 Leader **人工直派形态**的唯一凭证（把 `firstLine` 原样写进子代理
//     任务包首行），消费掉它等于把「直派形态」堵死；该形态的硬门禁属 C 阶段。
//   · **失败路径**：维持既有消费（派发失败已把 lane 置 `failed`（K3 起；此前为 `review`），句柄若留在 pending 会被探针
//     报成悬挂意图）；语义等价「已回收」。
//
// @returns {Promise<{batchId, lane, status, token, firstLine, ttlMs, spawned: boolean,
//                    workerSessionId?: string, spawnNote?: string}>}
//   硬失败（spawn 抛错 / 取不到 worker 会话 id）**抛错**：错误文案自带回滚事实与恢复步骤。
export async function dispatchLaneCore({ ctx, store, root, liveConfig, exec, sessionId, batchId, lane, leaderPrompt = '', exempt }) {
  // ⓿ 【2026-10-07 · P2（lane `e02-inject`）】role 数据面**前置解析** —— 拒派必须打在状态变更之前。
  //   判据源 L-AC-5 ②「role 查不到 ⇒ 拒派」。若把解析留在 ④ 的任务包组装处，则 `setMember(running)` 已落、
  //   句柄已发放 ⇒ 拒派会留下「lane=running、无 worker、句柄悬空」的僵尸态（正是本文件 B4 段登记过的坑）。
  //   故此处先读 laneTask 并解析 role：解析失败 ⇒ 抛 `GATE_ROLE_UNRESOLVED`，**零状态变更、零句柄发放**。
  //   ⚠ 任务包里的 `batch.wavePlan` 存的是 **wave 数组**（`[{wave, tasks:[…]}]`），旧写法读 `wavePlan.tasks`
  //     恒取不到 ⇒ 任务包「目标」位退化成 `（未声明 cmd）`。此处拍平所有 wave 的 tasks（B1 活体教训）。
  let laneTask = null;
  try {
    const wp = store.readBatch(sessionId, batchId)?.wavePlan ?? [];
    const flat = Array.isArray(wp) ? wp.flatMap((w) => w?.tasks ?? []) : (wp.tasks ?? []);
    laneTask = flat.find((t) => t && t.id === lane) ?? null;
  } catch { laneTask = null; }
  const roleData = resolveRoleRef(laneTask?.role, { warn: (m) => ctx?.logger?.warn?.(m) });
  const artifactsRoot = root
    ? String(root).replace(/[\\/]+$/, '') + '/sessions/' + sessionId + '/artifacts/' + batchId
    : undefined;
  // ⓿ 【2026-09-18 · Q-B 取消并发闸】原「闸位单点」调用 `assertConcurrencyAdmit(...)` 已删 ⇒ 本函数
  //   **零容量判定**（高并发不得被限流；`batch.concurrency` 只作声明 + 回显）。删除面与理由见本文件
  //   「并发闸 · 退役登记」段。
  // ① 置 running（含 Tier3 entry 门：consume 齐备 / condition / Manager 拉起）
  // 第 7 参 owner：派发面写入 ⇒ **派发即出池**（K1）；取不到 ⇒ null ⇒ 零写入（行为不变）。
  const b = store.setMember(sessionId, batchId, lane, 'running', null, exempt, ownerOfExec(exec));
  // ② 发放一次性句柄（任务包首行形态）
  const h = issueLaneHandle({ batchId, lane, sessionId });
  const base = { batchId, lane, status: b.lanes[lane], token: h.token, firstLine: h.firstLine, ttlMs: h.ttlMs };
  // ③ 能力探测（缺 ctx.subagents ⇒ 优雅降级为「仅发句柄」，**不消费句柄**）
  const rt = subagentRuntimeOf(ctx);
  if (!rt) {
    return { ...base, spawned: false, spawnNote: '宿主未提供 ctx.subagents ⇒ 仅发句柄（请把 firstLine 交给直派形态；该形态门禁属 C 阶段）' };
  }
  // N2/D6 三事实（2026-09-18 债清 3 · 逐条实测，勿再按印象改写）：
  //   ① **可热更**：`dispatch` 在 `lib/hot/config-watch.js:80` 的 `ALLOWED_TOP_KEYS` 白名单内
  //      ⇒ `<root>/config/runtime.json` 的 `dispatch.*` 改动经 watcher 生效，**无需重启宿主**。
  //      （白名单外的顶层键会被 `validateOverlay` 判 unknown 后**静默保持旧快照**——本类改动的经典坑。）
  //   ② **读端是热更快照**：`lib/index.js:282` 的 `readConfig` 注入 = `hotConfig.readSnapshot()`
  //      ⇒ 本行 `liveConfig?.dispatch?.provider` 取的是**当前生效快照**，不是启动期静态 config。
  //   ③ **「改不生效」的第一因不是代码，是配置缺失**：现网 `C:\Users\Administrator\.dsh\punky-preset\config\runtime.json`
  //      （2026-09-18 实读 573 B）顶层键只有 `gates` / `governance` / `capabilities`，**没有 `dispatch` 段**
  //      ⇒ `liveConfig.dispatch` 为 undefined ⇒ `provider` 恒 null ⇒ 走「仅发句柄」降级分支（下文 B4）。
  //      **排查顺序**：先看 `runtime.json` 有没有写 `dispatch.provider`，再怀疑热更链路。
  //   · **调用点唯 1 处**：`lib/tools/core.js:1369`（`lane_dispatch` 工具面）。
  //     历史「多调用点」表述随链推进全退役（2026-09-18 Q-A=C，`lib/engine/chain-runner.js:51`
  //     已改为「派发只剩工具面单通道」）**作废**，勿回加。
  const provider = liveConfig?.dispatch?.provider ?? null; // 热更快照（见上三事实；原读静态 config ⇒ 假热更）
  if (!provider) {
    // B4 能力位/配置前置：不猜 provider、不「以弱换强」。
    // ⚠ N1 清债（2026-09-16 评审）：此处**不得抛错**——抛错会**丢掉刚发放的句柄**，留下
    //   「lane=running、无 worker、无句柄」的僵尸态（只能靠心跳 `lane.binding_gap` 事后发现）。
    //   与「宿主无 ctx.subagents」同族 ⇒ 同走**降级为仅发句柄**：lane 保持 running、句柄原样返回
    //   （**不消费**，见本函数头 P0 口径），Leader 可补配置后重派，或用返回的 `firstLine` 走直派形态。
    ctx?.logger?.warn?.('[dsh-punky-swarm] lane_dispatch: 未配置 config.dispatch.provider ⇒ 仅发句柄（不猜 provider）· lane=' + lane);
    return { ...base, spawned: false, spawnNote: '未配置 config.dispatch.provider ⇒ 仅发句柄（补配置后重派，或用 firstLine 直派）' };
  }
  // ④ 任务包骨架：lane 契约 + role 三段 + 纪律 + 句柄首行（B2/B3 由 buildStartRequest 注入 toolFilter/label）
  // 【2026-10-07 · P2】`laneTask` / `artifactsRoot` 的读取已**上移**到 ⓿（role 拒派须先于状态变更）；
  //   `role` 传**已解析的 role 对象**（非裸名）⇒ 三段注入生效，且「同 role 跨批稳定」。
  const prompt = composeWorkerPrompt({
    batchId, lane, cmd: laneTask?.cmd, layer: laneTask?.layer, role: roleData,
    consume: laneTask?.consume ?? [], produce: laneTask?.produce ?? [], outputs: laneTask?.outputs ?? [],
    firstLine: h.firstLine, leaderPrompt, artifactsRoot,
    // 【2026-09-27 · GR-13】lane 声明位的**直读**（`buildWavePlan` 归一化面**未持久化**该字段 ⇒ 今日恒 `false`；
    //   真实生效路径 = `composeWorkerPrompt` 内「audit 层 + 声明写盘面恰一件」的**自动判定**）。
    //   保留本行 = 为「直调派发 / 未来持久化该字段」留显式逃生位，不构成当前行为的唯一依赖。
    singleArtifactWrite: laneTask?.singleArtifactWrite === true,
  });
  // 【2026-09-22 · one-shot 化】`startContinuable(spec)` → **`rt.start(provider, request)`**：
  //   one-shot 请求**平铺**（label/prompt/parent/signal/toolFilter/persona/maxDepth 同层）；
  //   **只 await 启动、不 await `run.result`**（fire-and-forget，保住「不阻塞 Leader 回合」）；
  //   run 交 `trackOneShotRun` 持引用（终态自动摘除，失败显式告警不进判定）。
  let start = null;
  try {
    if (!exec?.agent) throw new Error('缺少调用方 Agent —— 派发必须在工具流水线内调用（exec.agent 决定子会话挂载点）');
    // 【2026-09-24 · 0.1.7-rc.1 兼容自愈（A 方案）】宿主 `tools.restrict()` 对 `toolFilter.deny` 里的
    //   **未知工具名严格抛错**（不忽略）⇒ 名单残留一个**「该 scope 不可 restrict」**的名字即触发（实例：
    //   `wait_agent` —— 它由 agent-team 层注册，**仅在启用该层的 profile 上可 restrict**；未启用则不在
    //   `restrictableNames` 内），本次自派
    //   即**确定性失败**、lane 落 `failed` 终态（K3 不可原地重派 ⇒ 代价 = 整批作废）。
    //   自愈口径：从错误文案解析未知名 → **仅从本次 deny 名单移除** → **同一次派发内重试**（句柄只发放
    //   一次、不重复消费）；非该形态的错误**照旧抛出**（绝不吞错，守 B6「失败显式」纪律）。
    const denyAll = [...new Set([...SUITE_DENY_TOOLS, ...(liveConfig?.dispatch?.denyTools ?? [])])];
    const denyDropped = new Set();
    for (let attempt = 0; ; attempt++) {
      try {
        start = await rt.start(provider, buildStartRequest({
          batchId, lane, parent: exec.agent, prompt,
          // denyTools/persona 同样读**热更快照**；【2026-10-07 · P2】`role` 传已解析对象 ⇒
          //   ② persona 由 role 派生（R-4：`title` + `mission` + 工作方式），③ deny 并入 allow 反推集（R-5）。
          denyTools: denyAll.filter((n) => !denyDropped.has(n)),
          extraDeny: [], // 已并入 denyAll（合并后再过滤，避免两路名单各有未知名时自愈失效）
          persona: liveConfig?.dispatch?.persona,
          role: roleData,
        }));
        break;
      } catch (e) {
        // 【P-2 修正（2026-09-24，独立复核发现）】宿主模板对 **≥2 个未知名** 用**复数**文案
        //   `unknown global tools "X", "Y"`（`${unknown.length > 1 ? 's' : ''}`）⇒ 正则须收 `tools?`，
        //   否则复数形态失配、`unknownName=null`、自愈静默退化为原始确定性失败（＝白做）。
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
    const m = mapSpawnError(e); // B6 失败显式：归一为可读码面，绝不静默
    // D-3（2026-09-16 清债）：派发失败**必须回滚 lane**——否则 lane 停在 `running` 却无 worker。
    //   K3（2026-09-21）改判：返工边 `review→running` 已去除 ⇒ 回滚到 `review` 会把 lane 卡在**非终态且无法重派**。
    //   回滚目标改取 `failed`（`running→failed` 在迁移表内，**零新增边**）：派发失败即终态，
    //   恢复按 K3 走「gap-list + 新任务批次」，**不再原地重派**。回滚为 best-effort，**不吞原始错误**。
    try { store.setMember(sessionId, batchId, lane, 'failed', 'dispatch-failed'); } catch { /* best-effort */ }
    // N5 清债（2026-09-16 评审）：失败路径**必须作废已发放的句柄**——否则它留在 `pendingHandles` 里，
    //   绑定缺口观测（`bindingGapOf`）会把它报成 `token-ttl-expired` 幽灵信号。句柄面没有 revoke API，
    //   故用一次性消费（`consumeLaneHandle`）把它从 pending 中摘除：token 从此作废，语义等价「已回收」。
    try { consumeLaneHandle(h.token, { batchId, lane }); } catch { /* best-effort */ }
    throw new Error(m.code + ': ' + m.message
      + ' ｜ 已将 lane=' + lane + ' 置 failed（无 worker 挂载；派发失败即终态）⇒ 恢复步骤：记入 gap-list 并开新任务批次，'
      + '**不可原地重派**（K3：返工边 review→running 已去除，重派会被 `invalid member transition` 拒）；'
      + '如需人工核查：`gate_status({ batchId: "' + batchId + '", lane: "' + lane + '" })`。');
  }
  // worker 会话 id **定点取值**（`SubagentRun.id` = 子会话 id），不再静默猜字段；
  //   兼容回落会**显式告警**，取不到则带原始载荷显式报错（不静默 null ⇒ 不留「绑定失败但无根因」）。
  const workerSessionId = workerSessionIdOf(start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  if (!workerSessionId) {
    throw new Error('GATE_DISPATCH_FAILED: rt.start 未返回 worker 会话 id（载荷=' + JSON.stringify(start)
      + '） —— 契约字段为 `id`（`SubagentRun.id` = 子会话 id；与 `subagent/end` 事件 `info.id` 同源）；'
      + '宿主返回形态若变更请按本载荷适配。');
  }
  // 【2026-09-22 · one-shot 化】run 生命周期属主登记（持引用防 GC 语义歧义；终态自动摘除；失败显式告警）。
  trackOneShotRun(workerSessionId, start, (msg) => ctx?.logger?.warn?.('[dsh-punky-swarm] ' + msg));
  // ⑤ B5 唯一写路径：自派成功即由引擎直接登记（不依赖 post-execute 事后观察）
  store.appendEvent(sessionId, batchId, EVT_MEMBER_DISPATCH, { lane, workerSessionId });
  // ⑥ **P0**：成功自派 ⇒ 立即作废句柄（口径见本函数头「自派即发放即作废、仅直派形态需长期有效」）。
  //   顺序要点：必须在 `member.dispatch` 登记**之后**——先有绑定事实、再无悬赏意图，
  //   否则「无 dispatch 事件 + 句柄已消费」会在探针面构造成一个无人认领的中间态。
  try { consumeLaneHandle(h.token, { batchId, lane }); } catch { /* best-effort：句柄面为进程内单例，不该抛 */ }
  return { ...base, spawned: true, workerSessionId };
}

// ── C 阶段：C 档派发面门禁（**软启用**，防自锁） ─────────────────────────────────
// 语义（「不写 token 即禁止派发」）：
//   · **B 档**：`subagent`/`subagent_fork` **一律放行**（单步调研/单步派发，无 lane 绑定）；
//   · **A 档**：由既有门禁 3 拒（本函数不重复判）；
//   · **C 档**：须携带**有效 lane 句柄**（`lane_dispatch` 发放；一次性 + TTL）。
// 落地形态 = `config.dispatch.gate`：`'warn'`（缺省，**只留痕告警不拦**）。
// **`'enforce'` 拒态已删**（勿回加）—— 原码
//   `subagent`/`subagent_fork`（`dsh-experimental-agent-team-profile/cordis.patch.yml:10-14`）
//   ⇒ 闸门拦的工具在官方场景不存在。现语义 = **只留痕不拦**（`evaluateTierCDispatch` 恒 `ok:true`
//   + `warnNote`）；`readGateMode` 保留（配置面仍在，供审计/热更观测，不再决定拦截）。
export function readGateMode(config) {
  const m = config?.dispatch?.gate;
  return m === 'enforce' ? 'enforce' : 'warn';
}

// ── D 阶段：成员侧套件通信（`swarm_report` → Leader / `swarm_cc` → Manager） ─────────
// 身份**由引擎反查绑定**（不靠成员自报）：`member.dispatch` 的 workerSessionId → { batchId, lane }。
// 【gate-lite 第一批 · E① 清理（2026-09-17）】**已删 `UNBOUND_REPORT_CODE` 导出与「未绑定即拒」语义**：
//   官方 Team 成员（宿主 `spawn_teammate` 拉起）**天然无 lane 绑定** ⇒ 未绑定是**常态**，硬拒即误拦
//   （实测命中 `replay-lock` / `asset-chain`）。现口径 = best-effort：消息照发、事件按「批次可否解析」
//   如实落/不落、回显 `unbound`/`eventWritten`/`notice`（唯一实现见 `lib/tools/core.js#reportTargetOf`）。
//   本段只留史迹，**不再提供常量导出**（防读端回生旧语义）。

/** 从批次事件流反查该会话绑定的 lane（worksWith 引擎自派与直派两种登记形态）。 */
export function laneBindingOf(store, sessionId) {
  if (!sessionId || !store || typeof store.listAllBatches !== 'function') return null;
  let all = [];
  try { all = store.listAllBatches() ?? []; } catch { return null; }
  for (const { sessionId: ownerSession, batchId } of all) {
    let b = null;
    try { b = store.readBatch(ownerSession, batchId); } catch { continue; }
    for (const ev of b?.events ?? []) {
      if (ev?.type === 'member.dispatch' && ev.workerSessionId === sessionId && ev.lane) {
        return { sessionId: ownerSession, batchId, lane: ev.lane };
      }
    }
  }
  return null;
}

/** 批次邮箱根（与 lane-heartbeat 同口径）：<engineRoot>/sessions/<sessionId>/mailbox/<batchId>。 */
export function mailboxRootOf(engineRoot, sessionId, batchId) {
  return String(engineRoot ?? '').replace(/[\\/]+$/, '') + '/sessions/' + sessionId + '/mailbox/' + batchId;
}

/** 成员回报的通路（0f/Manager 通道口径）：Leader 读 broadcast；Manager 读 supervisor/inbox。 */
export const REPORT_CHANNEL = Object.freeze({ leader: 'broadcast', manager: 'inbox' });

/**
 * 纯函数：给定档位/工具名/参数文本/配置，判定 C 档派发面的**留痕**处置。
 * **恒 `ok:true`（不再拒）**：原 `mode==='enforce'`
*   分支已随码删除（官方 profile 已 disable 宿主 `subagent`/`subagent_fork`）。
 *   `mode` 仍回显（`warn`/`enforce` = 配置面事实，供审计观测），但**不再影响判定**；无有效句柄一律产 `warnNote`。
 * @returns {{applies: boolean, ok: boolean, mode: 'warn'|'enforce', handleReason: string|null, denyReason: null, warnNote: string|null}}
 */
export function evaluateTierCDispatch({ tier, toolName, argsText, config, handleCheck }) {
  const mode = readGateMode(config);
  const isDispatchTool = toolName === 'subagent' || toolName === 'subagent_fork';
  if (!isDispatchTool || tier !== 'C') {
    return { applies: false, ok: true, mode, handleReason: null, denyReason: null, warnNote: null };
  }
  const r = typeof handleCheck === 'function' ? handleCheck(argsText) : { ok: false, reason: 'no-handle-check' };
  if (r.ok) return { applies: true, ok: true, mode, handleReason: null, denyReason: null, warnNote: null };
  const handleReason = r.reason ?? 'invalid-handle';
  return {
    applies: true, ok: true, mode, handleReason, denyReason: null,
    warnNote: 'dispatch without valid lane handle under tier C（mode=' + mode
      + '，留痕不拦；原 enforce 拒态已随码删除）'
      + ' · tool=' + toolName + ' · handle=' + handleReason
      + ' —— 仍建议：先 `lane_dispatch({ batchId, lane })` 取句柄并把 `firstLine` 写入子代理任务包首行。',
  };
}

// ── E 阶段：模式跟随（全局装载、不全局生效） ────────────────────────────────────
// 用户裁决（2026-09-16）：插件绑定指引使用，切到别的模式后门禁仍开着会把没有蟛蜞指引的 Agent
//   直接卡死。诉求 = 「全局装载，但不全局生效」——**运作跟随模式开关**（静态 config 或热更入口）。
// 语义（`config.modes.gate`）：
//   · 未配置 / `null` → **全模式生效**（旧行为；包缺省保持向后兼容，不因升级悄悄开启或关闭任何人）；
//   · 字符串数组      → **白名单**：只有 `header.agentPreset ∈ 白名单` 的会话启用蟛蜞治理
//     （门禁、执行型计数、套件工具一律不介入其他模式）；
//   · `[]`            → 显式停用（谁都不生效）；
//   · 其它形态        → 回落「全模式生效」+ 告警（防拼写漂移悄悄关掉门禁；宁可见旧行为也不要幽灵配置）。
// 读端：传入的 config 必须是**当前生效快照**（index.js 注入热更快照读取器）⇒ 改 runtime.json 的
//   `modes.gate` 即热生效，无需重启。
export const MODE_INACTIVE_CODE = 'GATE_MODE_INACTIVE';

/** 会话所属模式（agent preset id）：来自会话 header 的创建事实（宿主 dsh-session 校验为 string）。 */
export function presetOfSession(exec) {
  const p = exec?.agent?.session?.header?.agentPreset;
  return typeof p === 'string' && p ? p : null;
}

/** 子会话（Manager / worker）：宿主语义下 join 父会话的 standing 组合 ⇒ 模式随父，不因缺 header 被误判。 */
export function isChildSession(exec) {
  const h = exec?.agent?.session?.header;
  return !!(h && (h.delegationDepth > 0 || h.parentSession));
}

/** 归一 `config.modes.gate`（纯函数，可单测）：null = 全模式生效；数组 = 白名单。 */
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
 * 本会话是否启用蟛蜞治理（纯函数）。
 * @param config 当前生效配置快照
 * @param exec   工具调用上下文
 * @returns {boolean} true = 启用（旧行为）；false = 本模式不生效 ⇒ 门禁/计数/套件工具全部不介入
 */
export function modeActiveFor(config, exec, warn) {
  const gate = normalizeModeGate(config?.modes?.gate, warn);
  if (gate === null) return true;
  if (isChildSession(exec)) return true; // 子会话继承父会话模式（Manager 结算面不被误锁）
  const preset = presetOfSession(exec);
  return preset !== null && gate.includes(preset);
}
