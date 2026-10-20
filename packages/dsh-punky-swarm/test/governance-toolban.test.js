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

// 第三类判定面（工具黑名单 → 写通道路由）专项测试（2026-09-14 用户裁决 Q1=A/Q2=A/Q3/Q4/Q5=B）：
//   F 段：判定内核 judgeFileWriteCommand 正反成对（写动作命中 / 执行·构建·只读放行 / 引号掩码 / fail-closed）
//   K 段：kernel 裁决接线（toolBan 命中 → 与 rules 同列汇入 → DENY(P2) + ruleRefs + 纠正文本）
//   R 段：resolve 装载语义（inline 热加载通道 / preset 展开 / 拼接 / 重复 id 回退 / 未知 behavior fail-closed）
//   A 段：装配级端到端（静态 preset 引用生效 + runtime.json 热更免重启生效 + 坏条目载入期告警）
// harness 形态对齐 governance-preset-config.test.js（assemblyCtx/freshRoot/writeRuntime/execOf）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import {
  judgeFileWriteCommand, judgeWaitSleepCommand, matchToolBan, WRITE_CHANNEL_HINT,
  UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX, UNKNOWN_VIOLATION_CODE,
} from '../lib/governance/tool-ban.js';
import { createGovernanceKernel } from '../lib/governance/kernel.js';
import { resolveGovernanceConfig } from '../lib/governance/config.js';
import { loadPresetTable } from '../lib/governance/preset-loader.js';
import { readRefusals } from '../lib/governance/receipt-store.js';
import { writeRuntime, assemblyCtxPre } from './helpers/gate-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOT_SETTLE = 200;
const HOT_SLEEP = 1500;

// 最小合法黑名单条目（与 presets/hook-rules/l3-tool-ban.json 的 L3-W01 同构）
function banEntry(id, over = {}) {
  return {
    id, tool: 'pwsh', behavior: 'file-write', code: id, category: 'hard',
    message: `[preset L3] ${id} 测试条目：pwsh 命令含文件写动作`,
    ...over,
  };
}

// ── F 段：判定内核（纯函数，零 IO）──

const HIT_CASES = [
  ['Set-Content -Path a.txt -Value x', '写动词 cmdlet'],
  ['Out-File -FilePath a.txt', 'Out-File'],
  ['"hello" > a.txt', '重定向'],
  ['echo x >> log.txt', '追加重定向'],
  ['Get-Content a.txt | Set-Content b.txt', '管道中段的写 cmdlet'],
  ['rm -rf tmp', '段首 rm'],
  ['New-Item -ItemType File -Path a.txt', 'New-Item'],
  ['Remove-Item a.txt', 'Remove-Item'],
  ['Copy-Item a b', 'Copy-Item'],
  ['mkdir out', 'mkdir'],
  ['$c = Set-Content -Path a -Value x', '赋值前缀剥离后仍判写'],
  ['Get-ChildItem | Out-File list.txt', '管道末段写文件'],
  ['Set-Content "a > b" -Value x', 'cmdlet 在引号外（引号内字符不参与）'],
  ['Set-Content "a.txt', '未闭合引号 → fail-closed 按写处理'],
];

test('F-1 命中面：写文件动作（重定向 / 写动词 cmdlet / 段首写命令名）逐条命中', () => {
  for (const [cmd, tag] of HIT_CASES) {
    const v = judgeFileWriteCommand(cmd);
    assert.equal(v.hit, true, `应命中（${tag}）: ${cmd} → ${JSON.stringify(v)}`);
    assert.ok(typeof v.reason === 'string' && v.reason.length > 0, '命中理由非空（入收据可溯源）');
  }
});

const MISS_CASES = [
  ['Get-ChildItem -Recurse -Filter *.ts', '目录列举'],
  ['git status --porcelain', 'git 只读'],
  ['npm run build', '构建（tsc 落盘由构建进程自己做）'],
  ['npm test', '测试'],
  ['node scripts/build.mjs', '脚本执行'],
  ['tsc -p tsconfig.json', '编译'],
  ['Get-Content a.txt', '读文件'],
  ['Select-String -Path a.ts -Pattern "Set-Content"', '引号内提到 cmdlet 不误拦'],
  ['Write-Output "a > b"', '引号内重定向不误拦'],
  ['cmd /c foo 2>&1', '流合并（2>&1）不算落盘'],
  ['echo hello', '纯输出'],
  ['git log --oneline -5', 'git 只读'],
];

test('F-2 放行面：执行 / 构建 / 测试 / 只读命令与引号内文本一律放行（Q3/Q6 收窄口径）', () => {
  for (const [cmd, tag] of MISS_CASES) {
    const v = judgeFileWriteCommand(cmd);
    assert.equal(v.hit, false, `应放行（${tag}）: ${cmd} → ${JSON.stringify(v)}`);
  }
});

test('F-3 边界：空 / 非字符串 / 空白命令不命中（无写动作可判）', () => {
  for (const bad of ['', '   ', undefined, null, 42, {}]) {
    assert.equal(judgeFileWriteCommand(bad).hit, false, `非命令形态不命中: ${JSON.stringify(bad)}`);
  }
});

test('F-4 matchToolBan：工具名 / 行为面 fail-closed / 缺 code 退路 / 无条目零命中', () => {
  const entries = [banEntry('L3-W01')];
  const hit = matchToolBan(entries, { name: 'pwsh', arguments: { command: 'Set-Content -Path a -Value x' } });
  assert.deepEqual(hit.ruleRefs, ['L3-W01']);
  assert.equal(hit.violations.length, 1);
  assert.equal(hit.violations[0].category, 'hard');
  assert.match(hit.violations[0].message, /改用 edit \/ write/);
  // 工具名不匹配（bash 未登记）→ 不命中（行为面非法也不外延到别的工具）
  assert.deepEqual(matchToolBan(entries, { name: 'bash', arguments: { command: 'Set-Content a' } }).ruleRefs, []);
  assert.deepEqual(matchToolBan([banEntry('L3-W10', { behavior: 'bogus' })],
    { name: 'bash', arguments: { command: 'rm -rf a' } }).ruleRefs, [],
  '工具名不匹配仍是零命中（fail-closed 只收在「条目工具名已匹配」的口上）');
  // 命令干净 → 不命中
  assert.deepEqual(matchToolBan(entries, { name: 'pwsh', arguments: { command: 'Get-ChildItem' } }).ruleRefs, []);
  // 无 command 字段（非 shell 形态）→ 不命中
  assert.deepEqual(matchToolBan(entries, { name: 'pwsh', arguments: {} }).ruleRefs, []);
  // 空 / 缺省条目 → 零命中
  assert.deepEqual(matchToolBan(undefined, { name: 'pwsh', arguments: { command: 'rm a' } }).ruleRefs, []);
  assert.deepEqual(matchToolBan([], { name: 'pwsh', arguments: { command: 'rm a' } }).ruleRefs, []);
});

// F-5（2026-09-15 B1）：未知 / 缺失 behavior ⇒ **fail-closed 命中**（此前 hit:false = fail-open 逃逸面）
test('F-5 未知 / 缺失 behavior ⇒ fail-closed 命中（对齐 readonly 面，拒绝文案写明行为面）', () => {
  const unknown = matchToolBan([banEntry('L3-W09', { behavior: 'interpreter-write' })],
    { name: 'pwsh', arguments: { command: 'rm -rf a' } });
  assert.deepEqual(unknown.ruleRefs, ['L3-W09'], '未知 behavior 不再静默放行（工具名已匹配即保守拒绝）');
  assert.equal(unknown.violations.length, 1);
  assert.match(unknown.violations[0].message, new RegExp(UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX), '拒绝文案写明行为面未实现（可溯源）');
  assert.match(unknown.violations[0].message, /interpreter-write/, '拒绝文案指名被告知的行为面值');
  assert.match(unknown.violations[0].message, /改用 edit \/ write/, '纠正文本照常携带');
  assert.equal(unknown.violations[0].code, 'L3-W09', '命中收据 code 非空');
  // 缺失 behavior（undefined / null）同口径 fail-closed
  for (const missing of [undefined, null]) {
    const v = matchToolBan([banEntry('L3-W08', { behavior: missing })],
      { name: 'pwsh', arguments: { command: 'rm -rf a' } });
    assert.deepEqual(v.ruleRefs, ['L3-W08'], `behavior=${String(missing)} ⇒ fail-closed 命中`);
  }
});

// F-6（2026-09-15 B1）：坏条目命中后 code 不留空——条目 id 退路 / 无 id 落显式 unknown
test('F-6 缺 code 条目命中：code 退路 = 条目 id，无 id 才落 unknown（拒绝文案绝不留空）', () => {
  const noCode = matchToolBan([banEntry('L3-W07', { code: undefined })],
    { name: 'pwsh', arguments: { command: 'rm -rf a' } });
  assert.equal(noCode.violations.length, 1, '缺 code 不影响命中判定');
  assert.equal(noCode.violations[0].code, 'L3-W07', '缺 code → 退路为条目 id（与 ruleRefs 同源可回查）');
  const noCodeNoId = matchToolBan([{ tool: 'pwsh', behavior: 'file-write', message: 'm' }],
    { name: 'pwsh', arguments: { command: 'rm -rf a' } });
  assert.equal(noCodeNoId.violations.length, 1);
  assert.equal(noCodeNoId.violations[0].code, UNKNOWN_VIOLATION_CODE, '无 id 无 code → 显式 unknown（不传 undefined）');
  assert.notEqual(noCodeNoId.violations[0].code, undefined, '拒绝文案 code 不再为 undefined');
  const emptyCode = matchToolBan([banEntry('L3-W06', { code: '' })],
    { name: 'pwsh', arguments: { command: 'New-Item a.txt' } });
  assert.equal(emptyCode.violations[0].code, 'L3-W06', '空串 code 同按缺失处理');
});

// ── K 段：kernel 裁决接线 ──

test('K-1 toolBan 命中 → 与 rules 同列汇入 → DENY(P2) + ruleRefs + 纠正文本', () => {
  const kernel = createGovernanceKernel(resolveGovernanceConfig({ toolBan: [banEntry('L3-W01')] }));
  const d = kernel.decide({ name: 'pwsh', arguments: { command: 'Set-Content -Path a.txt -Value x' } });
  assert.equal(d.primitive, 'DENY');
  assert.equal(d.priority, 2, 'hard → P2');
  assert.deepEqual(d.ruleRefs, ['L3-W01']);
  assert.match(d.reason, /P2/);
  assert.match(d.reason, /改用 edit \/ write \/ str-replace-editor/, '拒绝正文携带写通道路由纠正文本');
  // 只读命令透传（Q2：pwsh 只读放行）
  assert.equal(kernel.decide({ name: 'pwsh', arguments: { command: 'Get-ChildItem -Recurse' } }).primitive, 'ALLOW');
});

test('K-2 零拦截基线：rules 空 + toolBan 空 → decide 恒 ALLOW（出厂默认不变）', () => {
  const kernel = createGovernanceKernel(resolveGovernanceConfig({}));
  assert.equal(kernel.decide({ name: 'pwsh', arguments: { command: 'Set-Content -Path a -Value x' } }).primitive, 'ALLOW');
});

test('K-3 两类判定面共存：同调用 rules 与 toolBan 双命中 → ruleRefs 两条保序', () => {
  const rule = {
    id: 'R-TEST', tools: ['pwsh'],
    match: { path: '/command', op: 'regex', pattern: 'Set-Content' },
    violations: [{ code: 'R-TEST', category: 'manual_review', message: '参数级规则命中' }],
  };
  const kernel = createGovernanceKernel(resolveGovernanceConfig({ rules: [rule], toolBan: [banEntry('L3-W01')] }));
  const d = kernel.decide({ name: 'pwsh', arguments: { command: 'Set-Content -Path a -Value x' } });
  assert.deepEqual(d.ruleRefs, ['L3-W01', 'R-TEST'], 'toolBan 命中先行、参数规则随后（保序）');
  assert.equal(d.primitive, 'DENY', 'hard（toolBan）优先于 manual_review');
});

test('K-4 条目可显式改档：category manual_review → REQUIRE_APPROVAL（不外延默认档语义）', () => {
  const kernel = createGovernanceKernel(resolveGovernanceConfig({ toolBan: [banEntry('L3-W99', { category: 'manual_review' })] }));
  const d = kernel.decide({ name: 'pwsh', arguments: { command: 'Remove-Item a.txt' } });
  assert.equal(d.primitive, 'REQUIRE_APPROVAL');
  assert.equal(d.priority, 1);
});

// K-5（2026-09-15 B1）：未知 behavior 的**双层**防线——装载层拒载（resolve 回退空表 + warn），
//   运行期（快照直喂内核的旁路/旧快照场景）fail-closed 命中 ⇒ DENY
test('K-5 未知 behavior：装载层拒载 + 内核层 fail-closed 命中（双层防线，均无透传）', () => {
  // 第一层：inline 通道装载期拒绝（坏条目不入表）
  const warns = [];
  const resolved = resolveGovernanceConfig({ toolBan: [banEntry('L3-W09', { behavior: 'interpreter-write' })] }, { warn: (m) => warns.push(m) });
  assert.deepEqual(resolved.toolBan, [], '装载层拒载未知 behavior（回退空表）');
  assert.ok(warns.some((m) => /behavior 非法: interpreter-write/.test(m)), '装载层告警指名原因');
  assert.equal(createGovernanceKernel(resolved).decide({ name: 'pwsh', arguments: { command: 'rm -rf tmp' } }).primitive, 'ALLOW',
    '回退空表 = 零拦截（不静默武装，也不误伤）');
  // 第二层：绕过装载层直喂内核（旧快照 / 内联构造）⇒ 运行期 fail-closed 命中
  const kernel = createGovernanceKernel({ ...resolved, toolBan: [banEntry('L3-W09', { behavior: 'interpreter-write' })] });
  const d = kernel.decide({ name: 'pwsh', arguments: { command: 'rm -rf tmp' } });
  assert.equal(d.primitive, 'DENY', '运行期未知 behavior 不再透传 ALLOW');
  assert.deepEqual(d.ruleRefs, ['L3-W09']);
  assert.match(d.reason, new RegExp(UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX), '拒绝正文含行为面未实现说明');
  assert.match(d.reason, /改用 edit \/ write/, '拒绝正文含写通道路由纠正文本');
  assert.equal(kernel.decide({ name: 'pwsh', arguments: { command: 'Get-ChildItem' } }).primitive, 'DENY',
    '未知 behavior 条目对所有命令 fail-closed（该行为面无法判定命令是否写盘）');
});

// ── R 段：resolve 装载语义（热加载通道 / preset 展开 / 回退纪律）──

const REAL = loadPresetTable();

test('R-1 inline 通道（热加载主干）：toolBan 进 resolved 快照 → 与空配置 JSON 不同（remount 判据成立）', () => {
  const empty = resolveGovernanceConfig({});
  const withBan = resolveGovernanceConfig({ toolBan: [banEntry('L3-W01')] });
  assert.deepEqual(empty.toolBan, []);
  assert.equal(withBan.toolBan.length, 1);
  assert.notEqual(JSON.stringify(empty), JSON.stringify(withBan),
    '快照差异 = index.js remountGovernanceHook 的比较判据（免重启热更由此成立）');
});

test('R-2 preset 展开：preset:l3-tool-ban → toolBan 1 条、rules 空（两类判定面分派）', () => {
  const c = resolveGovernanceConfig({ preset: ['l3-tool-ban'] }, { presetTable: REAL.table, presetBanTable: REAL.banTable });
  assert.deepEqual(c.toolBan.map((e) => e.id), ['L3-W01']);
  assert.deepEqual(c.rules, [], 'l3 面不产生参数规则');
  assert.equal(c.toolBan[0].tool, 'pwsh');
  assert.equal(c.toolBan[0].behavior, 'file-write');
});

test('R-3 preset + inline 保序拼接：preset 条目在前、inline 在后（两表各自拼接）', () => {
  const c = resolveGovernanceConfig(
    { preset: ['l2-resource', 'l3-tool-ban'], toolBan: [banEntry('MY-BAN-1', { behavior: 'file-write' })] },
    { presetTable: REAL.table, presetBanTable: REAL.banTable },
  );
  assert.equal(c.rules.length, 6, 'l2 规则面照常展开（rules 面不受 toolBan 面影响）');
  assert.deepEqual(c.toolBan.map((e) => e.id), ['L3-W01', 'MY-BAN-1'], 'preset 展开在前、inline 在后');
});

test('R-4 重复 id 回退：preset 的 L3-W01 + inline 同 id → 双面回退空表 + warn（宁空勿半）', () => {
  const warns = [];
  const c = resolveGovernanceConfig(
    { preset: ['l3-tool-ban'], toolBan: [banEntry('L3-W01')] },
    { presetTable: REAL.table, presetBanTable: REAL.banTable, warn: (m) => warns.push(m) },
  );
  assert.deepEqual(c.toolBan, [], '重复 toolBan id → 回退空表');
  assert.deepEqual(c.rules, [], '同一 resolve 内两类面一并回退（不部分武装）');
  assert.ok(warns.some((m) => /duplicate toolBan id 'L3-W01'/.test(m)), 'warn 定位重复 id: ' + warns.join(' | '));
});

test('R-5 未知 preset id 回退：preset 引用查无（两表皆无）→ 回退空表 + warn', () => {
  const warns = [];
  const c = resolveGovernanceConfig({ preset: ['no-such'] }, { presetTable: REAL.table, presetBanTable: REAL.banTable, warn: (m) => warns.push(m) });
  assert.deepEqual(c.rules, []);
  assert.deepEqual(c.toolBan, []);
  assert.ok(warns.some((m) => /未知 preset id 'no-such'/.test(m)));
});

// R-6（2026-09-15 B1）：inline 通道坏条目 ⇒ 载入期 warn **指名条目索引与原因** + 回退空表（非静默接收）
test('R-6 inline 坏条目：warn 指名 toolBan[i] 与原因，回退空表（不再静默武装进内核）', () => {
  const warns = [];
  const c = resolveGovernanceConfig(
    { toolBan: [{ id: 'BAD-1', behavior: 'interpreter-write' }, { tool: 'pwsh', behavior: 'file-write' }] },
    { warn: (m) => warns.push(m) },
  );
  assert.deepEqual(c.toolBan, [], '坏条目 ⇒ 回退空表（宁空勿半）');
  assert.ok(warns.some((m) => /inline toolBan 形状校验失败/.test(m) && /toolBan\[0\]\(BAD-1\)\.code/.test(m)),
    'warn 指名条目索引 0 + 条目 id + 缺失字段: ' + warns.join(' | '));
  assert.ok(warns.some((m) => /toolBan\[0\]\(BAD-1\)\.behavior 非法: interpreter-write/.test(m)), 'warn 指名未知 behavior 值');
  assert.ok(warns.some((m) => /toolBan\[1\]\.id 缺失/.test(m)), '缺 id 条目同样被点名（索引 1）');
  const clean = resolveGovernanceConfig({ toolBan: [banEntry('L3-W01')] }, { warn: (m) => warns.push('UNEXPECTED:' + m) });
  assert.equal(clean.toolBan.length, 1, '合法条目零形状差（仅坏条目回退）');
  assert.equal(warns.filter((m) => m.startsWith('UNEXPECTED')).length, 0, '合法 inline 表不产生任何告警');
});

// R-7（2026-09-15 B1）：inline 通道 id 唯一性同受校验（与 preset 分支同纪律）
test('R-7 inline 重复 id：接 validateToolBanTable → 回退空表 + warn 定位重复 id', () => {
  const warns = [];
  const c = resolveGovernanceConfig({ toolBan: [banEntry('DUP-1'), banEntry('DUP-1')] }, { warn: (m) => warns.push(m) });
  assert.deepEqual(c.toolBan, [], '重复 inline id ⇒ 回退空表');
  assert.ok(warns.some((m) => /duplicate toolBan id 'DUP-1'/.test(m)), 'warn 定位重复 id: ' + warns.join(' | '));
  // 两条通道对称性：preset 分支同样拒绝（对照断言，防止单侧回退）
  const wk = [];
  const viaPreset = resolveGovernanceConfig({ preset: ['l3-tool-ban'], toolBan: [banEntry('L3-W01')] },
    { presetTable: REAL.table, presetBanTable: REAL.banTable, warn: (m) => wk.push(m) });
  assert.deepEqual(viaPreset.toolBan, [], 'preset×inline 同 id 走 preset 分支回退（既有纪律不变）');
});

// ── A 段：装配级端到端（静态 preset 引用 + runtime.json 热更）──

// ── 装配级 fake ctx：`assemblyCtxPre()` 基线 + `preCount()`（取自 'helpers/gate-fixture.mjs'；F4 收敛，原 11 份同名副本）
function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-toolban-'));
}
function execOf(name, args, sessionId) {
  return {
    name, arguments: args,
    callId: 'call-' + name + '-' + Math.random().toString(36).slice(2, 8),
    ...(sessionId ? { agent: { session: { id: sessionId } } } : {}),
  };
}

test('A-1 装配级静态引用：apply preset:l3-tool-ban → pwsh 写文件 DENY + 收据溯源；只读命令透传', async () => {
  const root = freshRoot();
  writeRuntime(root, {});
  const ctx = assemblyCtxPre();
  const disposer = apply(ctx, { root, governance: { hook: { preset: ['l3-tool-ban'] } } });
  try {
    await sleep(HOT_SETTLE);
    assert.equal(ctx.preCount(), 1, 'hook 已挂（toolBan 面就位）');
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    const out = await pre(execOf('pwsh', { command: 'Set-Content -Path a.txt -Value x' }), () => {});
    assert.equal(out.kind, 'deny');
    assert.match(out.reason, /^\[governance:DENY\]/);
    assert.match(out.reason, /改用 edit \/ write/, '拒绝正文含纠正文本');
    assert.match(out.reason, /L3-W01（preset l3-tool-ban）/, '规则引用含 preset 归属（wiring 前缀映射）');
    const receipts = readRefusals(root, 'cli');
    assert.equal(receipts.length, 1, '收据落盘');
    assert.deepEqual(receipts[0].ruleRefs, ['L3-W01']);
    // Q2：pwsh 只读命令放行（只拦「修改或写文件」）
    let next = 0;
    await pre(execOf('pwsh', { command: 'Get-ChildItem -Recurse -Filter *.ts' }), () => { next++; });
    await pre(execOf('pwsh', { command: 'git status --porcelain' }), () => { next++; });
    assert.equal(next, 2, '只读命令 ALLOW 透传');
    // Q6：构建命令放行（tsc 落盘属构建自身行为）
    await pre(execOf('pwsh', { command: 'npm run build' }), () => { next++; });
    assert.equal(next, 3, '构建命令 ALLOW 透传');
    assert.equal(readRefusals(root, 'cli').length, 1, '放行调用不产收据');
  } finally {
    disposer();
  }
});

test('A-2 热加载通道：runtime.json 写 inline toolBan → 免重启重挂生效（Q4「仅护栏可热加载」）', async () => {
  const root = freshRoot();
  writeRuntime(root, {});                    // 起始：无 toolBan
  const ctx = assemblyCtxPre();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true } } });
  try {
    await sleep(HOT_SETTLE);
    const pre0 = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    let next = 0;
    await pre0(execOf('pwsh', { command: 'Set-Content -Path a.txt -Value x' }), () => { next++; });
    assert.equal(next, 1, '未配置 toolBan → 零拦截（出厂空表语义）');
    // 写入 runtime.json（热更：governance.hook.toolBan）→ 等待 watchdog 重挂
    writeRuntime(root, { governance: { hook: { enabled: true, toolBan: [banEntry('L3-W01')] } } });
    await sleep(HOT_SLEEP);
    const pre1 = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    const out = await pre1(execOf('pwsh', { command: 'Set-Content -Path a.txt -Value x' }), () => {});
    assert.equal(out.kind, 'deny', '热更后写文件被拒（未重启进程）');
    assert.match(out.reason, /L3-W01/);
    let next2 = 0;
    await pre1(execOf('pwsh', { command: 'Get-ChildItem' }), () => { next2++; });
    assert.equal(next2, 1, '热更后只读命令仍透传');
  } finally {
    disposer();
  }
});

test('A-3 提示文本常量与文档口径一致：WRITE_CHANNEL_HINT 指向在册写工具', () => {
  assert.match(WRITE_CHANNEL_HINT, /edit \/ write \/ str-replace-editor/);
  assert.match(WRITE_CHANNEL_HINT, /编码头/);
});

// A-4（2026-09-15 B1）：装配级 fail-closed——runtime.json 写坏条目 ⇒ boot 载入即 warn 指名条目、
//   hook 照常挂载（回退空表 = 零拦截，不因坏配置炸装配），随后热更合法条目照常生效
test('A-4 装配级：runtime.json 坏条目 ⇒ 载入期 warn 指名条目 + 回退空表（hook 照常挂载）', async () => {
  const root = freshRoot();
  writeRuntime(root, { governance: { hook: { enabled: true, toolBan: [{ id: 'BAD-1', behavior: 'interpreter-write' }] } } });
  const ctx = assemblyCtxPre();
  const disposer = apply(ctx, { root, governance: { hook: { enabled: true } } });
  try {
    const bootWarns = ctx.calls.warn.filter((m) => /inline toolBan/.test(m));
    assert.ok(bootWarns.length > 0, 'boot 载入期必须告警（非静默接收坏条目）：' + ctx.calls.warn.join(' | '));
    assert.ok(bootWarns.some((m) => /toolBan\[0\]\(BAD-1\)/.test(m)), '告警指名条目索引与 id');
    assert.equal(ctx.preCount(), 1, '坏配置不炸装配：hook 照常挂载（回退空表 = 零拦截）');
    await sleep(HOT_SETTLE);
    const pre = [...(ctx.listeners.get('tools/pre-execute') ?? [])][0];
    let next = 0;
    await pre(execOf('pwsh', { command: 'Set-Content -Path a.txt -Value x' }), () => { next++; });
    assert.equal(next, 1, '回退空表 ⇒ 零拦截（坏条目未被静默武装）');
    assert.equal(readRefusals(root, 'cli').length, 0, '回退空表不产收据');
  } finally {
    disposer();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════
// DT-GAP-1 · T4：分隔符表驱动覆盖 tool-ban 两处 + `.ts` ↔ 回拷 `.js` 双跑一致性
//   （batch `punky-debt-fix-20261020` / lane `e2-test`；判据源 `plan/scope.md` §2 T4）
//
// 两处消费点（同一 `maskQuoted` + 同一套分隔符切段）：
//   ① 等待面 `judgeWaitSleepCommand`（wait-sleep 判定内核）；
//   ② 写盘面 `judgeFileWriteCommand`（file-write 判定内核）。
// 债面：`&` 作为命令分隔符时两处都必须切段——「只读前缀 & 违禁后缀」不得靠前缀掩护。
// 表结构（AC-4 阳性对照）：**同一张分隔符表**逐格给「后缀 = 违禁动作 ⇒ hit:true」与
//   「后缀 = 只读动作 ⇒ hit:false」两侧成对；另加「`&` 两侧只读 ⇒ 放行」的结构性阴性对照。
// `tool-ban.js` 是 `tool-ban.ts` 的回拷生成物（`scripts/copy-ts-built.mjs` 白名单）⇒ 双跑一致性
//   钉住「改 `.ts` 忘 build」这类漂移；本环境 Node 支持原生 type stripping 时真跑，
//   否则**显式 skip（可计数、不静默通过）**。
// ═══════════════════════════════════════════════════════════════════════════════════

const TOOLBAN_SEPARATORS = [
  { name: '&', join: (a, b) => a + ' & ' + b },
  { name: '&&', join: (a, b) => a + ' && ' + b },
  { name: ';', join: (a, b) => a + ' ; ' + b },
  { name: '|', join: (a, b) => a + ' | ' + b },
  { name: '换行', join: (a, b) => a + '\n' + b },
];

test('T4-1 等待面（wait-sleep）：5 分隔符 × 「后缀 sleep⇒hit」「后缀只读⇒放行」成对', () => {
  for (const sep of TOOLBAN_SEPARATORS) {
    const hitCmd = sep.join('Get-ChildItem', 'sleep 5');
    const v = judgeWaitSleepCommand(hitCmd);
    assert.equal(v.hit, true, '[' + sep.name + '] 后缀 sleep 须命中: ' + JSON.stringify(hitCmd));
    assert.ok(String(v.reason).includes('sleep'), '[' + sep.name + '] 命中原因须点名 sleep 段: ' + v.reason);

    // **同分隔符阴性对照**：只换后缀 ⇒ 必须放行（否则「见分隔符即拒」不可证伪）
    const okCmd = sep.join('Get-ChildItem', 'Select-Object -First 1');
    assert.equal(judgeWaitSleepCommand(okCmd).hit, false,
      '[' + sep.name + '] 阳性对照：同分隔符后缀只读 ⇒ 放行: ' + JSON.stringify(okCmd));
  }
  // 结构性阴性对照：`&` 两侧只读 ⇒ 放行（证明命中的是后缀动作，不是 `&` 本身）
  assert.equal(judgeWaitSleepCommand('Get-ChildItem & Get-Date').hit, false, '阳性对照：`&` 两侧只读 ⇒ 放行');
});

test('T4-2 写盘面（file-write）：5 分隔符 × 「后缀写⇒hit」「后缀只读⇒放行」成对', () => {
  for (const sep of TOOLBAN_SEPARATORS) {
    const hitCmd = sep.join('Get-ChildItem', 'Set-Content -Path a.txt -Value x');
    assert.equal(judgeFileWriteCommand(hitCmd).hit, true, '[' + sep.name + '] 后缀写盘须命中: ' + JSON.stringify(hitCmd));

    const okCmd = sep.join('Get-ChildItem', 'Get-Date');
    assert.equal(judgeFileWriteCommand(okCmd).hit, false,
      '[' + sep.name + '] 阳性对照：同分隔符后缀只读 ⇒ 放行: ' + JSON.stringify(okCmd));
  }
  // 段首写命令名形态（与写指示符形态互补，与 command-exec 的 WRITE_HEADS 同口径）
  assert.equal(judgeFileWriteCommand('Get-ChildItem & rm -rf x').hit, true, '`&` 后缀段首 rm ⇒ 命中');
  assert.equal(judgeFileWriteCommand('Get-ChildItem & xargs rm').hit, false, '阳性对照：`rm` 在参数位 ⇒ 放行');
});

test('T4-3 `.ts` 与回拷 `.js`：可载走功能双跑；不可载走源级 parity（双路径，均不 skip）', async (t) => {
  // 【DEBT-4 · S-2】原实现在 catch 分支内直接 skip ⇒ 缺少 .ts type stripping 的运行时**静默跳过**
  //   ⇒ 该断言在那些运行时形同不存在（不可证伪）。本批改为**双路径**（两条都跑断言，无 skip 出口）：
  //     · .ts 可载 ⇒ **功能双跑**（≥15 样本，含 hit/miss 两极性）；
  //     · .ts 不可载 ⇒ **源级 parity**（单点接线 / 分隔符正则已清除 / 自持分段已清除，三条）。
  //   两条路径**都**跑断言，`t.diagnostic('T4-3 path=…')` 记录实际走了哪条（报告可核）。
  const PKG = path.join(import.meta.dirname, '..');
  let tsMod = null;
  let loadErr = null;
  try {
    // Node 原生 type stripping（Node ≥22.18 / ≥23.6 起免 flag）
    tsMod = await import('../lib/governance/tool-ban.ts');
  } catch (e) {
    loadErr = e;
    tsMod = null;
  }

  if (tsMod) {
    t.diagnostic('T4-3 path=functional（.ts 原生载入成功）');
    const jsMod = await import('../lib/governance/tool-ban.js');
    const cases = [
      ...TOOLBAN_SEPARATORS.flatMap((sep) => [
        sep.join('Get-ChildItem', 'sleep 5'),
        sep.join('Get-ChildItem', 'Set-Content -Path a.txt -Value x'),
        sep.join('Get-ChildItem', 'Get-Date'),
      ]),
      'npm test', 'Get-ChildItem', 'rm -rf x', 'ls & rm -rf x',
      'Set-Content "a.txt', // 未闭合引号：两处均应 fail-closed（边界不明）
    ];
    let compared = 0;
    for (const c of cases) {
      assert.equal(tsMod.judgeWaitSleepCommand(c).hit, jsMod.judgeWaitSleepCommand(c).hit,
        '等待面双跑不一致（改 .ts 忘 build？）: ' + JSON.stringify(c));
      assert.equal(tsMod.judgeFileWriteCommand(c).hit, jsMod.judgeFileWriteCommand(c).hit,
        '写盘面双跑不一致（改 .ts 忘 build？）: ' + JSON.stringify(c));
      compared++;
    }
    // 双极阳性对照（**不得削弱**）：样本须同时含命中与放行两类，
    //   否则「两侧都 false」也会被读成「一致」（空转）。
    assert.ok(cases.some((c) => tsMod.judgeFileWriteCommand(c).hit === true), '一致性样本须含命中样本（非全放行空转）');
    assert.ok(cases.some((c) => tsMod.judgeFileWriteCommand(c).hit === false), '一致性样本须含放行样本');
    assert.ok(cases.some((c) => tsMod.judgeWaitSleepCommand(c).hit === true), '等待面样本须含命中（否则等待面双跑空转）');
    assert.ok(compared >= 15, '样本量须 ≥15（实测 ' + compared + '）');
    return;
  }

  // ── 兜底路径：源级 parity（**不 skip**）──────────────────────────────────────────────
  t.diagnostic('T4-3 path=source-parity（.ts 载入失败：' + (loadErr?.code ?? loadErr?.name ?? 'unknown') + '）');
  const readSrc = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8');
  const tsSrc = readSrc('lib/governance/tool-ban.ts');
  const jsSrc = readSrc('lib/governance/tool-ban.js');
  const countOf = (hay, needle) => hay.split(needle).length - 1;

  // ① 单点接线：两文件各自 `import { segmentCommands }` **恰 1**，且**都在用**（调用 ≥2）
  assert.equal(countOf(tsSrc, 'import { segmentCommands }'), 1, 'P2① tool-ban.ts 须恰 1 处 import segmentCommands');
  assert.equal(countOf(jsSrc, 'import { segmentCommands }'), 1, 'P2① tool-ban.js 须恰 1 处 import segmentCommands');
  assert.ok(countOf(tsSrc, 'segmentCommands(') >= 2,
    'P2① 阳性对照：ts 须实际调用 segmentCommands ≥2 次（只 import 不用 = 未单点化；实测 '
    + countOf(tsSrc, 'segmentCommands(') + '）');
  assert.ok(countOf(jsSrc, 'segmentCommands(') >= 2,
    'P2① 阳性对照：js 回拷须同样调用 ≥2 次（实测 ' + countOf(jsSrc, 'segmentCommands(') + '）');

  // ② 分隔符正则已清除：两文件内该字面量 == 0；**阳性对照** = 单点自身必须恰有 1 份
  //   （否则搜索串写错时「处处为 0」也会绿 —— 这正是本批要堵的空转）
  const DELIM_LITERAL = '/;|&&|\\|\\||\\||&|\\r?\\n/';
  const shellSrc = readSrc('lib/shell-text.js');
  assert.equal(countOf(shellSrc, DELIM_LITERAL), 1,
    'P2② 阳性对照：单点 lib/shell-text.js 内分隔符正则须恰 1 份（实测 ' + countOf(shellSrc, DELIM_LITERAL) + '）');
  assert.equal(countOf(tsSrc, DELIM_LITERAL), 0, 'P2② tool-ban.ts 不得自持分隔符正则');
  assert.equal(countOf(jsSrc, DELIM_LITERAL), 0, 'P2② tool-ban.js 回拷不得自持分隔符正则');

  // ③ 自持分段已清除：两文件内 `.split(` == 0（分段一律走单点）
  assert.equal(countOf(tsSrc, '.split('), 0, 'P2③ tool-ban.ts 不得再自持分段 split(');
  assert.equal(countOf(jsSrc, '.split('), 0, 'P2③ tool-ban.js 回拷不得再自持分段 split(');
});
