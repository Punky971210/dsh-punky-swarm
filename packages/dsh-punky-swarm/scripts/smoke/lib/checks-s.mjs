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

// S 组 · 状态机 / 门禁面（进程内，合成 ctx）：H-05 … H-10（H-08 含 **H-08b** 旧格式锁子项）。
// 每项自带阳性对照：先跑「应通过」的输入，再跑「应被拒 / 应被检出」的输入。

import fs from 'node:fs';
import path from 'node:path';
import { expect, expectThrow } from './support.mjs';

/** 合规三层 tasks（对齐 `test/helpers/gate-fixture.mjs#threeTierTasks` 的同形自建：audit 双前缀消费）。 */
function threeTierTasks(laneIds = ['e1', 'e2']) {
  const spec = 'plan/spec.md';
  return [
    { id: 'p1', layer: 'plan', produce: [spec], cmd: 'spec' },
    ...laneIds.map((id) => ({ id, layer: 'exec', consume: [spec], outputs: ['exec/' + id + '.md'], cmd: 'run', deps: ['p1'] })),
    { id: 'a1', layer: 'audit', consume: [spec, ...laneIds.map((id) => 'exec/' + id + '.md')], produce: ['audit/a1.md'], cmd: 'review', deps: laneIds },
  ];
}

/** 建一条合规三层批（供本项自用：**项与项之间不共享前置** —— 否则一条红会级联污染下一条的读数）。 */
async function ensureBatch(mount, batchId, session) {
  const tasks = threeTierTasks();
  await mount.tools.get('wave_plan').execute({ batchId, tasks, assembly: { auditLane: 'a1' }, session });
  return batchId;
}

/** H-05 三层批缺 `assembly` ⇒ 拒建批 + **零批次落盘**。 */
async function h05(sm) {
  const mount = sm.mount({}, { subagents: { start: async () => ({ result: Promise.resolve({}) }) } });
  try {
    const wavePlan = mount.tools.get('wave_plan');
    expect(wavePlan, '阳性对照失败：wave_plan 未注册（裸配置应注册 wave_plan；两档工具数真值见 scripts/smoke/lib/checks-k.mjs 的 EXPECTED_TOOLS_*）');
    const tasks = threeTierTasks();

    // ── 阴性面：缺 assembly ──
    const msg = await expectThrow(
      () => wavePlan.execute({ batchId: 'smoke-h05-noasm', tasks, session: sm.session }),
      /GATE_ROLE_ASSEMBLY_MISSING/, 'H-05 三层批缺 assembly');
    expect(/auditLane/.test(msg), 'H-05 拒态文案未点名 auditLane（可补性不足）：' + msg.slice(0, 300));
    expect(!sm.batchExists('smoke-h05-noasm'), '拒建批后仍落了批文件（门禁打在落盘之后）');

    // ── 阳性对照：带 assembly 必须建成（否则「拒」不具判别力）──
    await wavePlan.execute({ batchId: sm.h05BatchId, tasks, assembly: { auditLane: 'a1' }, session: sm.session });
    expect(sm.batchExists(sm.h05BatchId), '阳性对照失败：带 assembly 的合规三层批未落盘');
    return '缺 assembly ⇒ GATE_ROLE_ASSEMBLY_MISSING 且零批次落盘 · 带 assembly ⇒ 建成 ' + sm.h05BatchId;
  } finally { mount.disposer(); }
}

/** H-06 audit 不消费 plan 层产物 ⇒ 拒建批 `GATE_AUDIT_INPUT_MISSING`。 */
async function h06(sm) {
  const mount = sm.mount({}, { subagents: { start: async () => ({ result: Promise.resolve({}) }) } });
  try {
    const wavePlan = mount.tools.get('wave_plan');
    const spec = 'plan/spec.md';
    const blind = [
      { id: 'p1', layer: 'plan', produce: [spec], cmd: 'spec' },
      { id: 'e1', layer: 'exec', consume: [spec], outputs: ['exec/e1.md'], cmd: 'run', deps: ['p1'] },
      // audit 只消费 exec 产物，**不碰 plan/** ⇒ 盲审
      { id: 'a1', layer: 'audit', consume: ['exec/e1.md'], produce: ['audit/a1.md'], cmd: 'review', deps: ['e1'] },
    ];
    const msg = await expectThrow(
      () => wavePlan.execute({ batchId: 'smoke-h06-blind', tasks: blind, assembly: { auditLane: 'a1' }, session: sm.session }),
      /GATE_AUDIT_INPUT_MISSING/, 'H-06 audit 不消费 plan 产物');
    expect(/no audit lane consumes a plan-layer product/.test(msg),
      'H-06 拒态文案不含判据原文（`no audit lane consumes a plan-layer product`）：' + msg.slice(0, 300));
    expect(!sm.batchExists('smoke-h06-blind'), '拒建批后仍落了批文件');

    // ── 阳性对照：同批把 audit 的 consume 补上 plan 锚点 ⇒ 通过（证明拒因确实是缺锚点）──
    const anchored = blind.map((t) => (t.id === 'a1' ? { ...t, consume: [spec, 'exec/e1.md'] } : t));
    await wavePlan.execute({ batchId: 'smoke-h06-ok', tasks: anchored, assembly: { auditLane: 'a1' }, session: sm.session });
    expect(sm.batchExists('smoke-h06-ok'), '阳性对照失败：补上 plan 锚点后仍建不成批');
    return '无 plan 锚点 ⇒ GATE_AUDIT_INPUT_MISSING（文案含判据原文）· 补锚点后建成 smoke-h06-ok';
  } finally { mount.disposer(); }
}

/** H-07 `startActivation` 形态宿主 ⇒ 拒派 `GATE_DISPATCH_CAPABILITY_MISSING` + **三零**。 */
async function h07(sm) {
  // ── 阳性对照：探针单点必须能分辨两种宿主形态（否则「拒派」无从归因）──
  const probeStart = sm.dispatchProbe({ subagents: { start() {} } });
  const probeActivation = sm.dispatchProbe({ subagents: { startActivation() {} } });
  expect(probeStart.form === 'start', '阳性对照失败：`{start}` 形态未被探针识别（实得 form=' + probeStart.form + '）');
  expect(probeActivation.form === 'activation', '阳性对照失败：`{startActivation}` 形态未被探针识别（实得 form=' + probeActivation.form + '）');

  const mount = sm.mount({}, { subagents: { startActivation: () => ({}) } });
  try {
    const wavePlan = mount.tools.get('wave_plan');
    const tasks = threeTierTasks();
    // leader-direct：本批不登记 Manager，让 entry 门的 Manager 前置不成为归因噪音
    await wavePlan.execute({ batchId: sm.h07BatchId, tasks, assembly: { managerPlan: 'leader-direct', auditLane: 'a1' }, session: sm.session });    const before = sm.batchOf(sm.h07BatchId);
    expect(before && before.lanes.e1 === 'pending', '阳性对照失败：' + sm.h07BatchId + '.e1 初始态不是 pending');

    const msg = await expectThrow(
      () => mount.tools.get('lane_dispatch').execute({ batchId: sm.h07BatchId, lane: 'e1', session: sm.session }),
      /GATE_DISPATCH_CAPABILITY_MISSING/, 'H-07 startActivation 形态拒派');

    const after = sm.batchOf(sm.h07BatchId);
    // 三零：① lane 仍 pending ② 零 member.dispatch 事件 ③ 批相位不变（并加严：零新增事件）
    expect(after.lanes.e1 === 'pending', '拒派后 lane 不再是 pending（' + after.lanes.e1 + '）——拒派打在状态变更之后');
    expect(after.phase === before.phase, '拒派后批相位变化：' + before.phase + ' → ' + after.phase);
    const dispatchEvents = (after.events ?? []).filter((e) => e.type === 'member.dispatch');
    expect(dispatchEvents.length === 0, '拒派后出现 member.dispatch 事件（' + dispatchEvents.length + ' 条）——句柄/登记已落下');
    expect((after.events ?? []).length === (before.events ?? []).length,
      '拒派后事件流新增 ' + ((after.events ?? []).length - (before.events ?? []).length) + ' 条（应零写入）');
    expect(/状态变更之前/.test(msg), 'H-07 拒态文案未声明「拒派打在状态变更之前」（可诊断性）：' + msg.slice(0, 200));
    return '拒派生 GATE_DISPATCH_CAPABILITY_MISSING · 三零成立（lane=pending / 相位=' + after.phase + ' / 事件 +0 / member.dispatch 0）';
  } finally { mount.disposer(); }
}

/** H-08 / H-08b lane 锁：stale lock 接管（fence X→Y + 留痕）与旧格式锁拒接管（逐字节未改）。 */
async function h08(sm) {
  const mount = sm.mount({}, { subagents: { start: async () => ({ result: Promise.resolve({}) }) } });
  const lane = 'e2';
  try {
    const claim = mount.tools.get('lane_claim');
    const release = mount.tools.get('lane_release');
    const lockFile = sm.lockPathOf(sm.h07BatchId, lane);

    // ── 阳性对照：无锁时正常认领成功（fence=1），并能按 token 释放 ──
    const fresh = await claim.execute({ batchId: sm.h07BatchId, lane, session: sm.session });
    expect(fresh.ok === true, '阳性对照失败：无锁时认领失败（' + JSON.stringify(fresh) + '）');
    const rec1 = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    expect(rec1.fence === 1 && rec1.token === fresh.token, '阳性对照失败：新锁记录不符（' + JSON.stringify(rec1) + '）');
    const rel = await release.execute({ batchId: sm.h07BatchId, lane, token: fresh.token, session: sm.session });
    expect(rel.ok === true, '阳性对照失败：按 token 释放失败（' + JSON.stringify(rel) + '）');
    expect(!fs.existsSync(lockFile), '阳性对照失败：释放后锁文件仍在');

    // ── 正题：stale lock（pid 不存在 + 有 token/fence）⇒ 接管，fence X→Y，留痕 kind=stale-takeover ──
    const deadPid = sm.deadPid;
    expect(typeof deadPid === 'number', '阳性对照失败：找不到「确实不存在」的 pid（stale 构造不可达）');
    sm.ledger.writeFile(lockFile, JSON.stringify({ token: 'smoke-stale-holder', ts: Date.now() - 60000, pid: deadPid, fence: 3 }));
    const warnsBefore = mount.ctx.calls.warn.length;
    const taken = await claim.execute({ batchId: sm.h07BatchId, lane, force: true, session: sm.session });
    expect(taken.ok === true, 'stale lock 未被接管（' + JSON.stringify(taken) + '）——死锁不可恢复');
    const rec2 = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    expect(rec2.fence === 4, '接管后 fence = ' + rec2.fence + '，期望 4（X→Y 未成立）');
    expect(rec2.token === taken.token, '接管后锁 token 不是本次调用者');
    const takeoverWarns = mount.ctx.calls.warn.slice(warnsBefore).join('\n');
    expect(/kind=stale-takeover/.test(takeoverWarns), '接管告警缺 kind=stale-takeover（可观测面消失）：' + takeoverWarns.slice(0, 400));
    expect(/fence 3→4/.test(takeoverWarns), '接管告警缺 `fence 3→4`：' + takeoverWarns.slice(0, 400));

    // ── H-08b：旧格式锁（**无 token/fence**）⇒ 拒接管且锁文件逐字节未改（零写入）──
    const legacyBody = JSON.stringify({ token: 'smoke-legacy-holder', ts: Date.now() - 120000 });
    sm.ledger.writeFile(lockFile, legacyBody);
    const beforeBytes = fs.readFileSync(lockFile);
    const legacy = await claim.execute({ batchId: sm.h07BatchId, lane, force: true, session: sm.session });
    expect(legacy.ok === false, 'H-08b 旧格式锁被吞掉了（ok=' + JSON.stringify(legacy) + '）——强接管不认格式');
    expect(legacy.reason === 'lock-legacy-format', 'H-08b 拒因 = ' + String(legacy.reason) + '，期望 lock-legacy-format');
    const afterBytes = fs.readFileSync(lockFile);
    expect(afterBytes.equals(beforeBytes), 'H-08b 拒接管却改动了锁文件（零写入被破）');
    const tickets = fs.readdirSync(path.dirname(lockFile)).filter((n) => n.includes('.takeover-'));
    expect(tickets.length === 0, 'H-08b 拒接管却留下票号文件：' + tickets.join(','));
    return 'stale(pid=' + deadPid + ',fence 3→4) 接管成功 + 留痕 kind=stale-takeover · 旧格式锁拒接管(lock-legacy-format) 且逐字节未改';
  } finally {
    // 清掉我们造的锁（隔离根内，但让坏格式锁不污染后续项）
    const lockFile = sm.lockPathOf(sm.h07BatchId, lane);
    try { fs.rmSync(lockFile, { force: true }); } catch { /* 已是终态 */ }
    mount.disposer();
  }
}

/** H-09 `log_export.writeTo`：根内成功（落盘事件数 = 应为数）/ 越根拒（三种逃逸）且零落盘。 */
async function h09(sm) {
  const mount = sm.mount({ capabilities: { logs: { enabled: true } } }, { subagents: { start: async () => ({ result: Promise.resolve({}) }) } });
  try {
    const logExport = mount.tools.get('log_export');
    expect(logExport, '阳性对照失败：logs 开启后 log_export 未注册');
    // 自建批次（不借用 H-05 的批：项与项之间不共享前置，防级联污染读数）
    const bid = await ensureBatch(mount, 'smoke-h09', sm.session);
    // 造两条可数事件（事件类型是过滤器的唯一靶点）
    sm.store.appendEvent(sm.session, bid, 'smoke.marker', { lane: 'e1', n: 1 });
    sm.store.appendEvent(sm.session, bid, 'smoke.marker', { lane: 'e2', n: 2 });
    const expected = (sm.batchOf(bid).events ?? []).filter((e) => String(e.type).startsWith('smoke')).length;
    expect(expected === 2, '阳性对照失败：应为事件数 = ' + expected + '，期望 2');

    const artifactsDir = sm.artifactsDirOf(bid);
    const out = await logExport.execute({
      batchId: bid, session: sm.session, type: 'smoke', format: 'markdown', writeTo: 'audit/event-log.md',
    });
    expect(out.ok === true, '阳性对照失败：根内 writeTo 未成功（' + JSON.stringify(out).slice(0, 300) + '）');
    expect(out.exported === expected, '落盘事件数 = ' + out.exported + '，应为 ' + expected);
    const dest = path.join(artifactsDir, 'audit', 'event-log.md');
    expect(fs.existsSync(dest), '根内 writeTo 未落盘：' + dest);
    expect(fs.statSync(dest).size > 0, '根内 writeTo 落了个空文件');
    sm.ledger.record(dest, 'plugin-write');

    // ── 三种逃逸：`..` 段 / `.` 段（同属「空段」判据分支）/ 绝对路径 —— 全部必须拒且零落盘 ──
    //    注：`writeTo: ''` 在工具面语义是「未提供 writeTo」（`if (args.writeTo)` 短路）⇒ 它**不构成**逃逸面，
    //    故第三例用 `./dot.md`（落到 `segs.some(s => s === '' || s === '.' || s === '..')` 的同一判据分支）。
    const outside = path.join(sm.isoRoot, 'escape-outside.md');
    const bad = [
      { writeTo: '../escape.md', re: /no \.\. or empty segment/, label: '../ 逃逸' },
      { writeTo: './dot.md', re: /no \.\. or empty segment/, label: '. 段（空段分支）' },
      { writeTo: outside, re: /must be batch-relative/, label: '绝对路径逃逸' },
    ];
    const seen = [];
    for (const probe of bad) {
      const msg = await expectThrow(
        () => logExport.execute({ batchId: bid, session: sm.session, format: 'markdown', writeTo: probe.writeTo }),
        probe.re, 'H-09 ' + probe.label);
      seen.push(probe.label + '⇒' + String(msg).slice(0, 60));
    }
    expect(!fs.existsSync(path.join(artifactsDir, '..', 'escape.md')), '../escape.md 被写到批次根外');
    expect(!fs.existsSync(outside), '绝对路径 writeTo 被落盘：' + outside);
    return '根内 audit/event-log.md 成功（exported=' + out.exported + '/' + expected + '）· 三种逃逸全拒且零落盘（'
      + seen.join(' | ') + '）';
  } finally { mount.disposer(); }
}

/** H-10 审计 sink 降级可见性：正常写盘零 stderr / 追加失败恰见 `[punky-auditlog] ` 行（≤2）。 */
function h10(sm) {
  const sink = sm.sink;
  const stats0 = sink.auditlogStats();
  expect(stats0.mounted === true, '阳性对照失败：审计 sink 未挂载（apply 未走到 mountStartupPrelude）');
  expect(Object.prototype.hasOwnProperty.call(stats0, 'stderrNotices'),
    'auditlogStats() 键集缺 stderrNotices（失败面不可观测）');
  expect(stats0.stderrNotices === 0, '阳性对照失败：装载期已有 stderr 告警 ' + stats0.stderrNotices + ' 条');

  const lines = [];
  const original = process.stderr.write;
  const capture = (chunk) => { lines.push(String(chunk)); return true; };
  process.stderr.write = capture;
  try {
    // ── 正常写盘：必须真的写进去（否则「零 stderr」可能来自根本没走到写路径）──
    const segment = path.join(stats0.sinkDir, stats0.filename);
    sink.exportMessage({ sn: 1, ts: Date.now(), type: 'info', level: 2, name: 'host-smoke', args: ['正常写盘探针'] });
    expect(fs.existsSync(segment), '阳性对照失败：正常写盘后主卷文件不存在（sink 被关或写路径断了）：' + segment);
    const sizeAfterOk = fs.statSync(segment).size;
    expect(sizeAfterOk > 0, '阳性对照失败：正常写盘后主卷为空（0 字节）');
    const statsOk = sink.auditlogStats();
    expect(statsOk.stderrNotices === 0, '正常写盘却产生 stderr 告警 ' + statsOk.stderrNotices + ' 条');
    expect(lines.length === 0, '正常写盘却写了 stderr：' + lines.join('').slice(0, 300));
    expect(statsOk.writes >= 1 || statsOk.messagesSeen >= 1, '阳性对照失败：正常写盘未计入任何计数');

    // ── 失败面：当日主卷名先建成**目录** ⇒ append 抛 EISDIR ⇒ 降级路径必须可见 ──
    fs.rmSync(segment, { force: true });
    fs.mkdirSync(segment);
    sm.ledger.record(segment, 'mkdir');
    for (let i = 0; i < 5; i += 1) {
      sink.exportMessage({ sn: 100 + i, ts: Date.now(), type: 'info', level: 2, name: 'host-smoke', args: ['失败写盘探针 ' + i] });
    }
    const statsFail = sink.auditlogStats();
    expect(statsFail.failures >= 1, '失败写盘未记 failures（' + statsFail.failures + '）——降级路径不可观测');
    expect(lines.length >= 1, '失败写盘零 stderr（回到 L-1 修前的静默降级）');
    expect(lines.length <= 2, '失败写盘 stderr 条数 = ' + lines.length + '，超过硬上限 2（无界刷屏）');
    const badLines = lines.filter((l) => !l.startsWith('[punky-auditlog] '));
    expect(badLines.length === 0, 'stderr 行缺 `[punky-auditlog] ` 前缀（格式契约被破）：' + badLines.join('').slice(0, 300));
    expect(statsFail.stderrNotices === lines.length,
      'stderrNotices=' + statsFail.stderrNotices + ' 与实际 stderr 行数 ' + lines.length + ' 不等（计数与输出脱钩）');
    return '正常写盘：' + sizeAfterOk + ' B 落盘 + stderr 0 行（stderrNotices=0）· 失败写盘 5 次：stderr ' + lines.length
      + ' 行全带前缀 + failures=' + statsFail.failures + ' + stderrNotices=' + statsFail.stderrNotices;
  } finally {
    process.stderr.write = original;
    // 还原：把「目录」清掉，避免污染后续 mount（stray 告警会进 ctx.calls.warn 污染其它判据）
    try {
      const st = sm.sink.auditlogStats();
      const seg = path.join(st.sinkDir, st.filename);
      if (fs.existsSync(seg) && fs.statSync(seg).isDirectory()) fs.rmSync(seg, { recursive: true, force: true });
    } catch { /* 还原失败不放大 */ }
  }
}

export function buildS(sm) {
  return [
    { id: 'H-05', title: '三层批缺 assembly ⇒ 拒建批 + 零批次落盘', run: () => h05(sm) },
    { id: 'H-06', title: 'audit 不消费 plan 产物 ⇒ 拒建批 + 补锚点可过', run: () => h06(sm) },
    { id: 'H-07', title: 'startActivation 形态拒派 + 三零（lane/相位/事件）', run: () => h07(sm) },
    { id: 'H-08', title: '锁接管：stale(fence X→Y + 留痕) / 旧格式拒接管且零写入（H-08b）', run: () => h08(sm) },
    { id: 'H-09', title: 'log_export.writeTo：根内成功 / 越根三种逃逸全拒且零落盘', run: () => h09(sm) },
    { id: 'H-10', title: '审计 sink：正常写盘零 stderr / 追加失败可见（≤2 行带前缀）', run: () => h10(sm) },
  ];
}
