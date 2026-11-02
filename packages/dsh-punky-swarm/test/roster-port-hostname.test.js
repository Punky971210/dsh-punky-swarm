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

// test/roster-port-hostname.test.js —— **C2-a 退场判据 ② 的门禁**（批 `punky-adapter-split-20261031`
//   · lane `w5-roster-port`）：引擎侧**宿主服务名 = 0**，宿主名只允许出现在 `lib/provider-dsh/**`。
//
// ## 为什么需要这条门（终验原话）
//
// `audit/a1-split-gate.md` 判 C2-a 未完成：引擎侧仍留 **4 处**宿主名，而 **`lib/provider-dsh/**` 内
// `roster|sessionOf|notifyLeader` 命中 = 0** ⇒ 引擎直取宿主服务、**无实现承接**；且**全量绿说明没有
// 任何断言约束它**（「明天再写一处也无人发现」）。本文件就是那条缺席的断言。
//
// ## 判据口径（与 criteria-v4 §0.3 同源：**机检式必须剥注释**）
//
// 扫面 = `lib/**/*.js` − `lib/provider-dsh/**`；源码先经 `codeOnly()`（复用 `scripts/baseline-snapshot-core.mjs`
// 的唯一计数内核）抹掉注释与字符串内容 ⇒ 注释里的**历史留痕/溯源说明**（如「原 `ctx.get('agentTeams')` 已删」）
// **不计**，只有**真实取值语句**才算违例。
//
// ## 判别力（防「恒绿」的三向对照，见 §G2/G3）
//
//   G1 真实树 ⇒ 违例 **0**（当前结论）
//   G2 **阳性对照**：把实现改回裸读取形态（4 种形态逐条构造）⇒ 扫描器**必报**（⇒ 门能红）
//   G3 **阴性对照**：把同样形态写进注释 ⇒ 扫描器**不得**报（⇒ 门不假红）
//
// 另附运行期面（G4–G7）：证明 `RosterSource` / `notifyLeader` **真的在 provider 里生效**，
// 而不是「契约在场但无实现」——那正是本 lane 要消灭的形态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from '../scripts/baseline-snapshot-core.mjs';
import { createRosterPort, ROSTER_QUERY_FAILED } from '../lib/provider-dsh/roster.js';
import { createAgentPort } from '../lib/provider-dsh/agent.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDER_DIR = 'lib/provider-dsh/';

/** 引擎侧**禁止**的宿主服务名形态：5 名（AC-2 全集）× 3 形态（dot / get / 常量）+ 宿主方法。
 *  ⚠ 每条都是「取值/调用」形态，不是裸词提及 —— 后者会与注释溯源说明误撞（G3 兜底）。
 *  ⚠ dot 锚 `(?:ctx|hostCtx)`：裸 `.tools` 会大面积误撞配置字段（FO-1/2 加固，实测 175 文件 0 误报）。 */
const HOST_NAMES = ['tools', 'webServer', 'subagents', 'agentTeams', 'agents'];
const FORMS = Object.fromEntries(HOST_NAMES.flatMap((n) => [
  [`ctx.${n}`, new RegExp('\\b(?:ctx|hostCtx)\\s*\\??\\.\\s*' + n + '\\b')],
  [`ctx.get('${n}')`, new RegExp('\\b(?:ctx|hostCtx)\\s*\\??\\.\\s*get\\s*\\(\\s*[\'"]' + n + '[\'"]')],
  [`${n}.SERVICE`, new RegExp('\\b' + n.replace(/([A-Z])/g, '_$1').toUpperCase() + '_SERVICE\\b')],
]));
FORMS['listMembers('] = /\.\s*listMembers\s*\(/;

/** 一段源码的违例命中（**注释/字符串内的同形文本不计**）。纯函数 ⇒ 可用合成样本做正/负对照。
 *
 * ⚠ 判定方法（本文件最容易写错的地方，务必按此实现）：
 *   不能直接「先 `codeOnly()` 再匹配」—— `codeOnly` 会把**字符串字面量**一并抹成空格，
 *   而这里要抓的正是 `ctx.get('<名>')` 这种**字符串里带宿主名**的形态 ⇒ 直接匹配 masked 文本会
 *   **整段漏检**（假绿）。正解 = 在**原始源**上匹配、再用 masked 文本判「该处是不是注释/字符串」：
 *     原始匹配段的 masked 切片**全为空白** ⇒ 该处已被抹掉（注释或字符串）⇒ 不计；
 *     否则 ⇒ 是真实代码 ⇒ 计违例。
 *   （masked 与 raw **等长**，故按 index 切片可对齐 —— `codeOnly` 的长度保持性有既有用例兜底。）
 */
function hostNameHitsOf(src) {
  const masked = codeOnly(src);
  const hits = [];
  for (const [form, re] of Object.entries(FORMS)) {
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of src.matchAll(globalRe)) {
      const seg = masked.slice(m.index, m.index + m[0].length);
      if (seg.trim() === '') continue; // 全被 mask ⇒ 落在注释/字符串里（如溯源说明）
      hits.push({ form, sample: String(m[0]).trim(), line: src.slice(0, m.index).split('\n').length });
      break; // 同一形态每条只报一次
    }
  }
  return hits;
}

/** 递归收集 `lib/**\/*.js`（排除 provider 面），返回 `[{ rel, src }]`。 */
function engineFaceEntries() {
  const out = [];
  const walk = (absDir) => {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const rel = path.relative(PKG, abs).split(path.sep).join('/');
      if (rel.startsWith(PROVIDER_DIR)) continue; // 宿主名**唯一**允许面
      out.push({ rel, src: fs.readFileSync(abs, 'utf8') });
    }
  };
  walk(path.join(PKG, 'lib'));
  return out;
}

// ══ G1 · 真实树：引擎侧宿主名 = 0 ══════════════════════════════════════════════════
test('G1 引擎侧宿主服务名 = 0（扫 lib/** 减 provider-dsh；剥注释后按「取值/调用」形态判）', () => {
  const entries = engineFaceEntries();
  assert.ok(entries.length > 100, '扫面必须覆盖整个 lib 面（防「扫了个空目录」的假绿）；实际文件数=' + entries.length);
  const violations = entries.flatMap(({ rel, src }) => hostNameHitsOf(src).map((h) => rel + ' → ' + h.form + '（' + h.sample + '）'));
  assert.deepEqual(violations, [],
    '引擎侧不得再直取宿主服务（C2-a 退场判据 ②）：宿主名只允许出现在 ' + PROVIDER_DIR + '**'
    + '\n实际违例：\n' + violations.join('\n'));
});

// ══ G2 · 阳性对照：改回裸读取形态 ⇒ 必报（证明门能红，不是恒绿）════════════════════════
test('G2 阳性对照：4 种「裸读取」形态逐个必被扫描器抓到（改回旧实现即红）', () => {
  const cases = [
    "const svc = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : null;",
    "const svc = typeof ctx?.get === 'function' ? ctx.get('agents') : null;",
    "const AGENT_TEAMS_SERVICE = 'agentTeams';",
    'const rows = agentTeams.listMembers(exec?.agent);',
  ];
  for (const src of cases) {
    const hits = hostNameHitsOf(src);
    assert.ok(hits.length > 0, '该形态必须被检出（否则门会漏掉重新写回去的实现）：' + src);
  }
});

// ══ G3 · 阴性对照：同样的形态写在注释里 ⇒ 不报（剥注释生效，防假红）══════════════════════
test('G3 阴性对照：注释里的同形文本不得被误判（剥注释口径与仓内计数内核同源）', () => {
  const commentOnly = [
    "// 历史留痕：原实现是 ctx.get('agentTeams')，本批已删。",
    "/* 原 AGENT_TEAMS_SERVICE 常量已删除 */",
    "// 旧代码：agentTeams.listMembers(agent) 取行",
  ].join('\n');
  assert.deepEqual(hostNameHitsOf(commentOnly), [], '注释里的溯源说明不是「取值」，不得误报（否则门会逼人删掉审计留痕）');
});

// ══ G4 · 验收②：provider 内确有 roster 实现（不是「契约在场但无实现」）══════════════════
test('G4 provider 面承载 roster 功能：provider-dsh 内 roster|sessionOf|notifyLeader 命中 > 0', () => {
  const providerFiles = fs.readdirSync(path.join(PKG, 'lib/provider-dsh')).filter((f) => f.endsWith('.js'));
  const hits = [];
  for (const f of providerFiles) {
    const code = codeOnly(fs.readFileSync(path.join(PKG, 'lib/provider-dsh', f), 'utf8'));
    for (const token of ['roster', 'sessionOf', 'notifyLeader']) {
      if (new RegExp(token, 'i').test(code)) hits.push(f + ':' + token);
    }
  }
  assert.ok(hits.length > 0, 'provider 面必须承载该功能（终验实测此处曾为 0 ⇒ 「引擎直取、无实现承接」）');
  assert.ok(hits.some((h) => /sessionOf/.test(h)), '`RosterSource.sessionOf` 必须真有实现');
  assert.ok(hits.some((h) => /notifyLeader/.test(h)), '`AgentRuntime.notifyLeader` 必须真有实现');
});

// ══ G5 · roster 端口三档语义（契约 ports.ts:215-235）══════════════════════════════════
test('G5 createRosterPort：read 归一 + sessionOf 三档（命中 / 不在名册 / 查询失败可辨）', () => {
  const rows = [
    { id: 'sess-a', name: 'manager', role: 'lead', status: 'running' },
    { target: 'coder-1', sessionId: 'sess-b' }, // 宿主字段名漂移：target/sessionId 双键容错
  ];
  const port = createRosterPort({ get: () => ({ listMembers: () => rows }) }, {});
  assert.equal(port.available, true);
  assert.deepEqual(port.read(), [
    { name: 'manager', id: 'sess-a', role: 'lead', status: 'running' },
    { name: 'coder-1', id: 'sess-b' },
  ], '归一为契约 RosterRow（宿主字段名差异不外泄）');
  assert.equal(port.sessionOf('manager'), 'sess-a', '命中 ⇒ 会话 id');
  assert.equal(port.sessionOf('coder-1'), 'sess-b', '双键容错同样命中');
  assert.equal(port.sessionOf('nobody'), null, '名不在名册 ⇒ null（**正常态，不抛**）');

  const broken = createRosterPort({ get: () => ({ listMembers: () => { throw new Error('boom'); } }) }, {});
  assert.throws(() => broken.sessionOf('manager'), (e) => String(e.message).startsWith(ROSTER_QUERY_FAILED),
    '查询本身失败 ⇒ **抛**（「查不到」与「查询坏了」必须可分）');
  assert.throws(() => broken.read(), (e) => String(e.message).startsWith(ROSTER_QUERY_FAILED), 'read 查询失败同样抛');

  const absent = createRosterPort({}, {});
  assert.equal(absent.available, false, '服务不可用 ⇒ 功能面读数 false');
  assert.deepEqual(absent.read(), [], '不可用时 read ⇒ []（可判定降级，不抛宿主原生错）');
  assert.equal(absent.sessionOf('manager'), null, '不可用时 sessionOf ⇒ null');
});

// ══ G6 · notifyLeader 四态（契约：不可用/失败**不抛**，成因用功能面词汇）════════════════
test('G6 createAgentPort().notifyLeader：不可用 / 缺 sessionId / 取不到 / 投递成功 四态，均不抛', () => {
  const noSvc = createAgentPort({});
  assert.deepEqual(noSvc.notifyLeader({ sessionId: 's1', message: {} }),
    { delivered: false, reason: 'agent-runtime-unavailable' }, '无宿主会话服务 ⇒ 功能面成因');

  const svc = (map) => ({ get: (id) => map[id] ?? null });
  assert.deepEqual(createAgentPort({ agents: svc({}) }).notifyLeader({ message: {} }),
    { delivered: false, reason: 'session-required' }, '缺 sessionId ⇒ 明确成因（不静默）');

  assert.deepEqual(createAgentPort({ agents: svc({}) }).notifyLeader({ sessionId: 's1', message: {} }),
    { delivered: false, reason: 'leader-not-live' }, '取不到会话句柄 ⇒ leader-not-live（与旧引擎语义同名）');

  let got = null;
  const ok = createAgentPort({ agents: svc({ s1: { followup: (m) => { got = m; } } }) });
  assert.deepEqual(ok.notifyLeader({ sessionId: 's1', message: { k: 1 } }), { delivered: true, reason: null });
  assert.deepEqual(got, { k: 1 }, '消息体原样交给宿主推送原语（本层不改写语义）');

  const boom = createAgentPort({ agents: { get: () => { throw new Error('lookup-boom'); } } });
  assert.deepEqual(boom.notifyLeader({ sessionId: 's1', message: {} }),
    { delivered: false, reason: 'lookup-failed' }, '查询抛错 ⇒ 收敛成返回值（**不把宿主原生错抛给引擎**）');
});

// ══ G7 · await 兼容（契约声明 Promise，实现同步值 ⇒ 两种调用写法都成立）══════════════════
test('G7 await 兼容：read/sessionOf/notifyLeader 在同步与 await 两种写法下读数一致', async () => {
  const port = createRosterPort({ get: () => ({ listMembers: () => [{ name: 'manager', id: 'sess-a' }] }) }, {});
  assert.deepEqual(await port.read(), port.read(), 'await 与直接取同值');
  assert.equal(await port.sessionOf('manager'), port.sessionOf('manager'));
  const agentPort = createAgentPort({ agents: { get: () => ({ followup: () => {} }) } });
  const direct = agentPort.notifyLeader({ sessionId: 's', message: {} });
  assert.equal(typeof direct.then, 'undefined', '实现返回同步值（本仓引擎调用面是同步的，见 lane 产物 §RosterSource 实现面）');
  assert.deepEqual(await agentPort.notifyLeader({ sessionId: 's', message: {} }), direct, 'await 非 thenable 直接取值 ⇒ 两种写法一致');
});
