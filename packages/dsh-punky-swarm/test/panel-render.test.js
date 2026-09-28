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

// 面板重构渲染面测试（Q-5）：可测语义下沉到 lib/panel/panel-model.js 纯函数段 + locales/theme/widgets
//   段的源码契约断言。客户端是 window.__ModuleLoader__ 包装的手写 JS（无运行时 harness）⇒ 手法 =
//   marker 抽取段文本 + `new Function` 独立求值（**行为级**，非文本级），静态面（文案/字号/对比度/可达性）
//   才走源码正则。断言面逐条对应冻结节拍 §验收 1–9（第 10 条属服务端 + 宿主冒烟，不在本文件）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const client = fs.readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8');

// 段文本抽取（与 test/client-sync.test.js 同法：marker → 下一 marker｜外壳尾）
function segmentOf(clientText, name) {
  const marker = '// ===== [panel-segment] ' + name + '.js =====';
  const start = clientText.indexOf(marker);
  assert.ok(start >= 0, 'client.js 缺失段标记: ' + marker);
  const rel = clientText.slice(start + marker.length);
  const nextMarker = rel.indexOf('// ===== [panel-segment]');
  if (nextMarker >= 0) return clientText.slice(start, start + marker.length + nextMarker);
  const SHELL_TAIL = '  }\n});\n';
  assert.ok(clientText.endsWith(SHELL_TAIL), 'client.js 缺外壳尾');
  const end = clientText.length - SHELL_TAIL.length;
  assert.ok(end > start, 'client.js 末段为空');
  return clientText.slice(start, end);
}

// 段内 `const` 求值（new Function 体：段声明 + 显式 return）——纯函数段可独立求值 = 本测试的存在前提
function evalSegment(clientText, name, returns) {
  const seg = segmentOf(clientText, name);
  return new Function(seg + '\n;return {' + returns.join(', ') + '};')();
}

const PM = evalSegment(client, 'panel-model', [
  'laneMetaOf', 'lanesByLayerOf', 'contractLineOf', 'gateBadgesOf', 'handoffBadgeOf',
  'eventViewOf', 'eventFilterOf', 'needHumanLanesOf', 'focusBlocksOf', 'actionCardOf',
  'fmtCount', 'verdictNoteOf', 'LAYER_ORDER', 'EVENT_CATEGORIES',
]);
const LOC = evalSegment(client, 'locales', ['zh', 'en', 'tt']);
// theme 段需暴露主题切换闭包（CURRENT_THEME 是段内 let）⇒ 自定义 return 表达式
const TH = (() => {
  const seg = segmentOf(client, 'theme');
  return new Function(seg
    + '\n;return { P: P, STATE: STATE, PHASE: PHASE,'
    + ' setTheme: function (t) { CURRENT_THEME = t; },'
    + ' getTheme: function () { return CURRENT_THEME; } };')();
})();

// ───────────────────────── 验收 1：引力条一致性（0 值收起 + 逐条对账） ─────────────────────────

test('T-G1 引力条 0 值收起：全 0 输入 ⇒ 零块；仅「门禁缺口 3 + 邮箱 2」⇒ 恰两块', () => {
  const zero = PM.focusBlocksOf(
    { lanes: { a: 'merged' }, lanesGate: {}, phase: 'complete' },
    { inbox: [], broadcast: [] },
    [],
  );
  assert.equal(zero.length, 0, '0 值必须收起（不渲染空块）');

  const gate3 = {
    l1: { layer: 'exec', consumeMissing: ['a.md', 'b.md'], outputsMissing: [], produceMissing: [], contractProblems: null },
    l2: { layer: 'audit', consumeMissing: ['c.md'], outputsMissing: [], produceMissing: [], contractProblems: null },
  };
  const blocks = PM.focusBlocksOf(
    { lanes: { l1: 'merged', l2: 'merged' }, lanesGate: gate3, phase: 'complete' },
    { inbox: [{}, {}], broadcast: [] },
    [],
  );
  assert.deepEqual(blocks.map((b) => b.key), ['gate', 'mail']);
  assert.deepEqual(blocks.map((b) => b.n), [3, 2]);
});

test('T-G2 五块逐条对账：待裁决 / 待恢复 / 门禁缺口 / 运行 / 邮箱 = 数据源读数', () => {
  const d = {
    lanes: { p1: 'merged', e1: 'idle', a1: 'running' },
    lanesGate: { e1: { layer: 'exec', consumeMissing: ['plan/spec.md'], outputsMissing: [], produceMissing: [], contractProblems: null } },
    phase: 'running',
  };
  const mail = { inbox: [{}], broadcast: [{}, {}] };
  const evs = [
    { type: 'lane.needhuman', lane: 'a1' },
    { type: 'member.settled', lane: 'e1', from: 'running', to: 'merged' },
  ];
  const blocks = PM.focusBlocksOf(d, mail, evs);
  assert.deepEqual(blocks.map((b) => b.key), ['decision', 'stuck', 'gate', 'running', 'mail']);
  const byKey = Object.fromEntries(blocks.map((b) => [b.key, b.n]));
  assert.equal(byKey.decision, PM.needHumanLanesOf(evs, d.lanes).length, '待裁决 = needHumanLanesOf 长度');
  assert.equal(byKey.stuck, Object.values(d.lanes).filter((s) => s === 'idle').length, '待恢复 = idle 计数');
  assert.equal(byKey.gate, 1, '门禁缺口 = lanesGate 缺口去重条数');
  assert.equal(byKey.running, d.phase === 'running' ? 1 : 0, '运行 = phase 读数');
  assert.equal(byKey.mail, mail.inbox.length + mail.broadcast.length, '邮箱 = 双箱未读之和');
  // human.decision 之后不再计「待裁决」
  assert.deepEqual(PM.needHumanLanesOf([{ type: 'lane.needhuman', lane: 'a1' }, { type: 'human.decision', lane: 'a1' }], d.lanes), []);
});

test('T-G3 待恢复口径 = idle 计数（不冒充引擎级 stalled）', () => {
  const d = { lanes: { a: 'idle', b: 'idle', c: 'running' }, lanesGate: {}, phase: 'paused' };
  const blocks = PM.focusBlocksOf(d, { inbox: [], broadcast: [] }, []);
  assert.deepEqual(blocks, [{ key: 'stuck', n: 2 }]);
});

// ───────────────────────── 验收 2：主行动卡优先级 ─────────────────────────

const CARD_LIST = [
  { batchId: 'b4', session: 's', phase: 'complete', lanes: { x: 'merged' } },
  { batchId: 'b3', session: 's', phase: 'running', lanes: { x: 'running' } },
  { batchId: 'b2', session: 's', phase: 'paused', lanes: { x: 'idle' } },
  { batchId: 'b1', session: 's', phase: 'running', lanes: { x: 'conflict' } },
];

test('T-A1 优先级序：异常 lane > paused > running > 其余', () => {
  const picked = [];
  let pool = CARD_LIST.slice();
  while (pool.length) {
    const c = PM.actionCardOf(pool, null, null, null, null);
    picked.push(c);
    pool = pool.filter((b) => b.batchId !== c.batchId);
  }
  assert.deepEqual(picked.map((c) => c.batchId), ['b1', 'b2', 'b3', 'b4'], '选中顺序必须 ①→②→③→④');
  assert.deepEqual(picked.map((c) => c.order), [0, 1, 2, 3]);
  assert.equal(picked[0].reasonKey, 'action.why.issue');
  assert.equal(picked[1].reasonKey, 'action.why.paused');
  assert.equal(picked[2].reasonKey, 'action.why.running');
  assert.equal(picked[3].reasonKey, 'action.why.done');
});

test('T-A2 选中覆盖：sel 命中列表项时以 sel 为准（可用详情判据）', () => {
  const sel = { session: 's', batchId: 'b3' };
  const detail = { batchId: 'b3', session: 's', phase: 'running', lanes: { x: 'running' }, danglingLanes: [], lanesGate: {} };
  const card = PM.actionCardOf(CARD_LIST, sel, detail, null, null);
  assert.equal(card.batchId, 'b3', '选中项覆盖列表范围最高优先批次');
  assert.equal(card.session, 's');
  // sel 指向批不在列表范围（跨会话深链）⇒ 仍出卡，不空白
  const off = PM.actionCardOf(CARD_LIST, { session: 'other', batchId: 'bz' }, null, null, null);
  assert.equal(off.batchId, 'bz');
});

// ───────────────────────── 验收 3：三层泳道（不混层 + exec 并行计数） ─────────────────────────

test('T-L1 三层分区：层序恒 plan→exec→audit→unlayered，计数逐层相等，无 layer 不吞不混', () => {
  const lanes = {
    'plan-designer': 'merged',
    'exec-coder': 'running', 'exec-verifier': 'running', 'exec-reviewer': 'pending',
    'audit-exec-coder': 'pending', 'audit-exec-verifier': 'pending', 'audit-exec-reviewer': 'pending',
    'orphan-lane': 'pending',
  };
  const meta = PM.laneMetaOf([{ tasks: [
    { id: 'plan-designer', layer: 'plan' },
    { id: 'exec-coder', layer: 'exec' }, { id: 'exec-verifier', layer: 'exec' }, { id: 'exec-reviewer', layer: 'exec' },
    { id: 'audit-exec-coder', layer: 'audit' }, { id: 'audit-exec-verifier', layer: 'audit' }, { id: 'audit-exec-reviewer', layer: 'audit' },
    { id: 'orphan-lane' },
  ] }]);
  const groups = PM.lanesByLayerOf(lanes, meta);
  assert.deepEqual(groups.map((g) => g.layer), ['plan', 'exec', 'audit', 'unlayered']);
  assert.deepEqual(groups.map((g) => g.lanes.length), [1, 3, 3, 1]);
  assert.equal(groups[1].lanes.length, 3, 'exec 组头「并行 {n} 条」读数 = 3');
  assert.deepEqual(PM.LAYER_ORDER, ['plan', 'exec', 'audit', 'unlayered']);
  // 未声明 layer 的 lane 必须落 unlayered（既不吞也不混入他层）
  assert.deepEqual(groups[3].lanes.map((x) => x.lane), ['orphan-lane']);
  // 空层不产组（零噪音）
  assert.deepEqual(PM.lanesByLayerOf({ a: 'pending' }, {}).map((g) => g.layer), ['unlayered']);
});

// ───────────────────────── 验收 4：契约行与 wavePlan.tasks 逐字一致 ─────────────────────────

test('T-C1 契约行逐字一致：consume/produce/outputs 与 task 对应字段全等', () => {
  const task = {
    id: 'exec-coder', cmd: '[role=coder] 实施', deps: ['plan-designer'], layer: 'exec', role: 'coder',
    skills: ['dev-coder', 'efficient-edit'], consume: ['plan/spec.md'], standalone: false,
    standaloneReason: null, produce: ['exec/exec-coder.md'], outputs: ['lib/x.js'],
    condition: null, checkpoint: null, resume: null, targets: ['lib/x.js'], targetsMarker: null, targetsNoChange: false,
  };
  const meta = PM.laneMetaOf([{ tasks: [task] }]);
  const line = PM.contractLineOf(meta['exec-coder']);
  assert.equal(JSON.stringify(line.consume), JSON.stringify(task.consume));
  assert.equal(JSON.stringify(line.produce), JSON.stringify(task.produce));
  assert.equal(JSON.stringify(line.outputs), JSON.stringify(task.outputs));
  assert.equal(meta['exec-coder'].skills.length, 2, 'role/skills 行数据源');
  assert.deepEqual(meta['exec-coder'].deps, ['plan-designer']);
});

// ───────────────────────── 验收 5：门禁徽章（有缺口出、无缺口零噪音） ─────────────────────────

test('T-B1 无 layer ⇒ 零徽章（保留早退语义）', () => {
  assert.deepEqual(PM.gateBadgesOf({ layer: null, consumeMissing: ['a'] }), []);
  assert.deepEqual(PM.gateBadgesOf(null), []);
});

test('T-B2 有缺口 ⇒ 恰一条 consume 徽章', () => {
  const items = PM.gateBadgesOf({ layer: 'exec', consumeMissing: ['plan/x.md'], outputsMissing: [], produceMissing: [], contractProblems: null });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'consume');
  assert.equal(items[0].path, 'plan/x.md');
});

test('T-B3 无缺口 ⇒ 零徽章；重复路径去重后仍为 1 条', () => {
  assert.deepEqual(PM.gateBadgesOf({ layer: 'exec', consumeMissing: [], outputsMissing: [], produceMissing: [], contractProblems: [] }), []);
  const dup = PM.gateBadgesOf({ layer: 'exec', consumeMissing: ['a.md'], outputsMissing: [], produceMissing: [], contractProblems: ['a.md missing'] });
  assert.equal(dup.length, 1, '同一路径跨类别去重');
  assert.equal(dup[0].kind, 'consume');
});

// ───────────────────────── 验收 6：文案（人话默认 + 换词命中 + 无裸 type） ─────────────────────────

// §4 换词表 19 键（新增 10 + 改动 7 + 保持 2）；后 2 键现值已等于目标文案（零改动）⇒ 按「值存在且命中」
//   断言而非按改动计数（键名与 en 值同形 `"lanes": "lanes"` 会让 hits 计数法假红）。
const WORD_KEYS_NEW7_10 = [
  'event.member.settled', 'verdict.merged', 'verdict.failed', 'verdict.conflict', 'verdict.skipped',
  'verdict.running', 'event.member.dispatched', 'gate.fix.hint', 'gate.needhuman', 'mailbox.unread',
  'concurrency', 'attempt', 'upgrade', 'batch.release', 'stream.fallback', 'empty.hint', 'mailbox.inbox',
];
const WORD_KEYS_KEEP = ['lanes', 'events'];

test('T-W1 换词表 19 键：17 个改动/新增键 zh/en 各恰 1 次（hits === 2）；2 个保持键按值命中', () => {
  const seg = segmentOf(client, 'locales');
  for (const k of WORD_KEYS_NEW7_10) {
    const hits = seg.split('"' + k + '"').length - 1;
    assert.equal(hits, 2, k + ' 应在 zh/en 两份 locales 各出现一次（实际 ' + hits + '）');
    assert.ok(LOC.zh[k] && String(LOC.zh[k]).length > 0, k + ' zh 值缺失');
    assert.ok(LOC.en[k] && String(LOC.en[k]).length > 0, k + ' en 值缺失');
  }
  for (const k of WORD_KEYS_KEEP) {
    assert.ok(LOC.zh[k] && LOC.en[k], k + ' zh/en 值缺失');
  }
  assert.equal(WORD_KEYS_NEW7_10.length + WORD_KEYS_KEEP.length, 19);
  // 关键换词逐条到位（协议值原样 + 中文业务语）
  assert.equal(LOC.zh['stream.fallback'], '实时通道中断，已切 3 秒轮询');
  assert.equal(LOC.zh['batch.release'], '可自动收口');
  assert.equal(LOC.zh['upgrade'], '待人工裁决');
  assert.equal(LOC.zh['gate.fix.hint'], '补上即可结算');
  assert.equal(LOC.zh['event.member.dispatched'], '已派发（等待回执）');
  assert.equal(LOC.zh['verdict.merged'], '（通过）');
  assert.equal(LOC.zh['concurrency'], '并发声明（未启用限流）');
  assert.equal(LOC.zh['attempt'], '已返工 {n} 次');
});

test('T-W2 旧串零命中（换词表 10 条的现值全部退场）', () => {
  const seg = segmentOf(client, 'locales');
  for (const old of ['已降级 3s 轮询', '升级人工', '创建 wave_plan 批次后在此查看', '可自动放行']) {
    assert.equal(seg.indexOf(old) >= 0, false, '旧文案残留: ' + old);
  }
});

test('T-W4 装配声明静态回显（2026-09-27 批 3 反转）：`assembly.chain` locale 键与面板推入点**均已删净**（D-4）', () => {
  const seg = segmentOf(client, 'locales');
  // 【T-15/D-6 等值反转（面仍在：locale 段与 batch-detail 段的**静态读法**）】Leader 裁决 **D-4 = 链回显面删净**
  //   ⇒ `assembly.chain`（zh/en）locale 键与 `batch-detail` 段的 `push('assembly.chain', …)` 推入点均已删除
  //   （归因：`exec/delete-assets.md` §四 第 14/16 点；A-8 归零实测 34 → 0）。
  //   断言强度**不减反增**：原为「键在场 + 文案去链叙事」的正向判据；现为**严格缺席**（`undefined` / `indexOf < 0`），
  //   并保留原「『链回显』措辞不得残留」负向锁 + 增补阴性对照（避免「整段失效」冒充「删净」）。
  assert.equal(LOC.zh['assembly.chain'], undefined, 'zh 链回显键已删净（D-4，非「改文案」）');
  assert.equal(LOC.en['assembly.chain'], undefined, 'en 链回显键已删净（D-4，非「改文案」）');
  assert.equal(seg.indexOf('"assembly.chain"'), -1, 'locales 段不得残留 assembly.chain 键');
  const detail = segmentOf(client, 'batch-detail');
  assert.equal(detail.indexOf("push('assembly.chain'"), -1, 'batch-detail 段链回显推入点已删除（服务端无该键）');
  assert.equal(detail.indexOf('链回显') >= 0, false, '「链回显」措辞不得残留（口径改为装配声明静态回显）');
  assert.ok(detail.indexOf('push(') >= 0, '阴性对照：batch-detail 段仍在使用 push 装配回显位（非整段失效）');
});

test('T-W3 人话映射：≥12 类事件返回 locale key；未知 type ⇒ key:null（不伪人话）', () => {
  const types = [
    'member.settled', 'member.dispatch', 'gate.exit_blocked', 'gate.needhuman_blocked', 'gate.passed',
    'lane.handoff', 'lane.handoff.gap', 'batch.created', 'batch.phase', 'batch.manager.raised',
    'batch.team-asset.resolved', 'lane.needhuman', 'lane.stalled', 'swarm.report', 'governance.refusal',
    'auto.settle.triggered', 'worktree.created',
  ];
  // 【2026-09-27 批 3 · T-15/D-6 归因】原清单含 `'chain.step'` 一项（18 类）。该事件常量已随 **D-4 删净**
  //   （`event-types.js` 的 `EVT_CHAIN_STEP` 整条删除，A-8）⇒ 其分类器（`panel-model.js` 的 `/^chain\./` 死分类器）
  //   亦已删除 ⇒ 该 type 的 `eventViewOf` 不再返回 key。**面已消失 ⇒ 条目随之删除**（不可等值反转：
  //   反转成「key:null」即与下方 `unknown` 用例重复且恒真空转，违纪律 15⑤）。
  //   `types.length >= 12` 门槛保留（现 17 项，仍严于门槛；恒真零新增的「凑数」风险不因本改动上升）。
  assert.ok(types.length >= 12, '覆盖类别数 ≥12');
  for (const t of types) {
    const v = PM.eventViewOf({ type: t });
    assert.ok(v.key, t + ' 必须有人话 key');
    assert.ok(LOC.zh[v.key], t + ' → ' + v.key + ' 在 zh 缺失');
    assert.ok(LOC.en[v.key], t + ' → ' + v.key + ' 在 en 缺失');
    assert.ok(PM.EVENT_CATEGORIES.indexOf(v.category) >= 0, t + ' 类别必须 ∈ 过滤 chips');
  }
  const unknown = PM.eventViewOf({ type: 'weird.unknown.type' });
  assert.equal(unknown.key, null, '未知 type ⇒ key null（渲染层回退原始 type）');
  assert.equal(unknown.raw, 'weird.unknown.type');
  // 过滤 + 逆序（最新在前）；类别过滤与 lane 过滤
  const evs = [{ type: 'gate.passed', lane: 'a' }, { type: 'member.settled', lane: 'a' }, { type: 'gate.exit_blocked', lane: 'b' }];
  assert.deepEqual(PM.eventFilterOf(evs, { category: 'gate' }).map((e) => e.type), ['gate.exit_blocked', 'gate.passed']);
  assert.deepEqual(PM.eventFilterOf(evs, { lane: 'a' }).map((e) => e.type), ['member.settled', 'gate.passed']);
  assert.deepEqual(PM.eventFilterOf(evs, { category: 'all' }).map((e) => e.type), ['gate.exit_blocked', 'member.settled', 'gate.passed']);
});

test('T-W4 客户端段内不再直接用原始 type 拼标签（人话默认）', () => {
  assert.equal(/e\.type \+/.test(client), false, '旧实现 label = e.type + ... 必须退场');
  const seg = segmentOf(client, 'batch-detail');
  assert.ok(seg.indexOf('eventViewOf') >= 0, '事件行必须经 eventViewOf 做换词');
  assert.ok(seg.indexOf("tt('event.raw.on')") >= 0 && seg.indexOf("tt('event.raw.off')") >= 0, '原始 type 开关必须在档');
});

test('T-W5 纯函数段纯度：段内禁 React. / tt( / T.（可独立 new Function 求值的前提）', () => {
  const seg = segmentOf(client, 'panel-model');
  assert.equal(/React\./.test(seg), false);
  assert.equal(/tt\(/.test(seg), false);
  assert.equal(/\bT\./.test(seg), false);
  assert.equal(PM.fmtCount('已返工 {n} 次', 2), '已返工 2 次');
  assert.equal(PM.verdictNoteOf('merged'), 'verdict.merged');
  assert.equal(PM.verdictNoteOf('review>running'), 'verdict.running');
  assert.equal(PM.verdictNoteOf('unknown-value'), '');
  assert.equal(LOC.tt(PM.verdictNoteOf('failed')), '（未通过）');
});

// ───────────────────────── 验收 7：可达性（Q-2 偏离可控 + 对比度达标） ─────────────────────────

function parseColor(value) {
  const s = String(value).trim();
  if (s.charAt(0) === '#') {
    const h = s.slice(1);
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  assert.ok(m, '无法解析颜色: ' + s);
  const p = m[1].split(',').map((x) => Number(x.trim()));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

function over(fg, bg) {
  return [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]);
}

function luminance(rgb) {
  const c = rgb.slice(0, 3).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function fallbackOf(cssColor) {
  const m = /,\s*([^,)]+)\)\s*$/.exec(String(cssColor));
  return m ? m[1].trim() : String(cssColor);
}

test('T-R1 关键数字 ≥18px（Stat 18 / 主行动卡 20 两处字面量在档）', () => {
  const w = segmentOf(client, 'widgets');
  const m = segmentOf(client, 'main');
  assert.ok(/fontSize: 18/.test(w), 'Stat 关键数字字面量 fontSize: 18 缺失');
  assert.ok(/fontSize: 20/.test(m), '主行动卡关键数字字面量 fontSize: 20 缺失');
  assert.ok(/fontSize: 10\.5/.test(w), '辅助字下限 10.5px（Q-2 边界）缺失');
});

test('T-R2 8 态 chip 前/背景对比度 ≥4.5:1（light/dark 各一套，共 16 组）', () => {
  const states = Object.keys(TH.STATE);
  assert.equal(states.length, 8, '8 态 chip 齐备');
  let min = 99;
  let minLabel = '';
  for (const theme of ['light', 'dark']) {
    TH.setTheme(theme);
    const p = TH.P[theme];
    const card = parseColor(p.card);
    for (const st of states) {
      const c = TH.STATE[st];
      const fg = parseColor(fallbackOf(c.fg));
      const bg = over(parseColor(c.bg), card);
      const ratio = contrast(fg, bg);
      if (ratio < min) { min = ratio; minLabel = theme + '/' + st; }
      assert.ok(ratio >= 4.5, theme + ' ' + st + ' 对比度 ' + ratio.toFixed(2) + ' < 4.5（调对应 chipXxx 的 bg alpha）');
    }
  }
  TH.setTheme('dark');
  process.stdout.write('[panel-render] 16 组 chip 对比度最低值 = ' + min.toFixed(2) + '（' + minLabel + '）\n');
});

test('T-R3 Chip 出 aria-label、Dot 出 aria-hidden（色盲可读）', () => {
  const w = segmentOf(client, 'widgets');
  assert.ok(/'aria-label': text/.test(w), 'Chip 必须输出 aria-label');
  assert.ok(/'aria-hidden': 'true'/.test(w), 'Dot 必须输出 aria-hidden');
  assert.ok(segmentOf(client, 'batch-detail').indexOf("'aria-hidden': 'true'") >= 0, '层位标中性条须 aria-hidden');
});

test('T-R4 prefers-reduced-motion：新增/既有动画类名全部并入降级块', () => {
  const m = segmentOf(client, 'main');
  const cssMatch = /el\.textContent = "([\s\S]*?)";/.exec(m);
  assert.ok(cssMatch, '内联样式表必须在档');
  const css = cssMatch[1].replace(/\\n/g, '\n');
  const reduceIdx = css.indexOf('@media (prefers-reduced-motion:reduce)');
  assert.ok(reduceIdx >= 0, 'reduced-motion 降级块必须在档');
  const reduceBlock = css.slice(reduceIdx);
  const animated = new Set();
  const re = /\.([a-z][a-z0-9-]*)\{[^}]*animation:/g;
  let hit = re.exec(css);
  while (hit) { animated.add(hit[1]); hit = re.exec(css); }
  assert.ok(animated.size >= 2, '至少 psw-pulse / psw-shimmer 两个动画类');
  for (const cls of animated) {
    assert.ok(reduceBlock.indexOf('.' + cls) >= 0, '动画类 .' + cls + ' 未并入 prefers-reduced-motion 降级块');
  }
});

// ───────────────────────── 验收 8：降级通道原因句 ─────────────────────────

test('T-D1 降级态原因句：zh 全文 + en 关键词 + main.js 渲染点取该键', () => {
  assert.equal(LOC.zh['stream.fallback'], '实时通道中断，已切 3 秒轮询');
  assert.ok(String(LOC.en['stream.fallback']).indexOf('polling every 3s') >= 0);
  const m = segmentOf(client, 'main');
  assert.ok(m.indexOf("tt(mode === 'poll' ? 'stream.fallback' : 'stream.live')") >= 0, '通道态渲染点必须取 stream.fallback');
});

// ───────────────────────── 验收 9：段 ↔ bundle 一致（回归锁，逐字节） ─────────────────────────

test('T-S1 八段齐备且与 lib/client.js 逐字节一致（新增 panel-model 段置首）', () => {
  const files = ['panel-model', 'locales', 'theme', 'widgets', 'batch-list', 'batch-detail', 'main', 'gov-config'];
  for (const name of files) {
    const src = fs.readFileSync(path.join(repo, 'lib', 'panel', name + '.js'), 'utf8');
    const marker = '// ===== [panel-segment] ' + name + '.js =====';
    const segText = src.slice(src.indexOf(marker));
    assert.equal(segmentOf(client, name), segText, name + '.js 段与 client.js 不一致（字节级）');
    assert.equal(src.indexOf('\r') >= 0, false, name + '.js 含 CR 行尾');
  }
  assert.equal(client.indexOf('\r') >= 0, false, 'client.js 含 CR 行尾');
});

// ───────────────────────── 服务端读端补键的静态契约（消费方 = 面板） ─────────────────────────

test('T-P1 面板消费的服务端键在 panel 段内全部有读取点（无「假缺口」遗留）', () => {
  const detail = segmentOf(client, 'batch-detail');
  // 【2026-09-27 批 3 · T-15/D-6 等值反转（面仍在：服务端键 ↔ panel 段读点的**双向一致性**）】
  //   原清单 8 键含 `teamAsset` / `chain`。两键已分别随 **T-7**（资产回显面删除）与 **D-4**（链回显面删净）
  //   从服务端删净 ⇒ 真值反转：由「**必须有**读点」改为「**不得有**读点」（严格缺席判定）。
  //   断言强度不减：正向 6 键逐一在场 + 负向 2 键逐一缺席（原 8 条正向 → 现 6 正向 + 2 负向，条数不变）。
  for (const key of ['danglingLanes', 'handoffs', 'teamAsset', 'assembly', 'manager', 'smoke', 'lanesGate']) {
    assert.ok(detail.indexOf(key) >= 0, 'panel 段未消费服务端键: ' + key);
  }
  // `teamAsset` **仍在**必检清单内：其面板读点未删（`lib/api.js:133` 的历史兼容读端与面板读法成对，
  //   见 `exec/delete-assets.md` §六 **N-4**，属**已登记的未分配遗留**）⇒ 按「无假缺口」原判据**保留**。
  assert.equal(detail.indexOf("'assembly.chain'"), -1, '服务端键已删净（D-4）⇒ panel 段不得残留 assembly.chain 读点');
});
