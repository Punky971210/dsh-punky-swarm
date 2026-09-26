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

// L5 · 等待能力禁用（`l5-wait-ban`）—— **判定内核**行为测试。
//  用户裁决 2026-09-26：「加入一个规则，禁用 wait_agent 工具和 sleep 能力避免 Agent 滥用等待功能」；
//  2026-09-27 补测试（用户口径：「l5-wait-ban 是我下的决定，实测已经生效，补测试即可」）。
//
// 本文件补的是**规则表结构之外的判定内核**（此前仅覆盖 registry/装载/面板/README 标识集）：
//   ① `judgeWaitSleepCommand`（`wait-sleep` 行为面）：段首判定 —— 命中 / 放行 / 分段 / 赋值前缀 / 引号掩码 / fail-closed
//   ② `matchToolBan`（**公开入口**，`kernel.js:143` 的消费面）：工具名过滤 + 三分支分派 + 未知 behavior fail-closed
//   ③ `TOOL_BAN_BEHAVIORS`（`config.ts:135`）：枚举 ↔ 规则表 ↔ 实现三方一致
// 纪律：直引 ../lib/governance/*.js 编译产物（npm run build 回拷 .js）；断言按实现行为
//   （源实现：tool-ban.ts:98-133 judgeWaitSleepCommand / :156-178 judgeBehavior / :181-209 matchToolBan）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeWaitSleepCommand, matchToolBan } from '../lib/governance/tool-ban.js';
import { TOOL_BAN_BEHAVIORS } from '../lib/governance/config.js';

// 最小黑名单条目（形状与 presets/hook-rules/l5-wait-ban.json 同构）
function ban(tool, behavior, over = {}) {
  return { id: 'T-' + behavior, tool, behavior, code: 'T-' + behavior, category: 'hard', message: 'm', ...over };
}
// 命中判定（读 matchToolBan 的公开返回）
const hit = (entries, name, command) =>
  matchToolBan(entries, { name, arguments: command === undefined ? {} : { command } }).violations.length > 0;

// ── ① judgeWaitSleepCommand：命中面（8 个 WAIT_SLEEP_HEADS 逐个）──
test('L5-K-1 wait-sleep 判定：8 个段首命令全部命中（PowerShell 6 + POSIX/cmd 2）', () => {
  const heads = ['start-sleep', 'sleep', 'wait-event', 'wait-process', 'wait-job', 'wait-service', 'wait', 'timeout'];
  for (const h of heads) {
    const v = judgeWaitSleepCommand(h + ' 5');
    assert.equal(v.hit, true, h + ' 应命中：' + JSON.stringify(v));
    assert.ok(String(v.reason).includes(h), h + ' 的 reason 应点名该 head：' + v.reason);
  }
});

test('L5-K-2 wait-sleep 判定：大小写与空白容错（head 归一化）', () => {
  for (const s of ['Start-Sleep -Seconds 5', '  SLEEP 3  ', 'Wait-Process -Name x']) {
    assert.equal(judgeWaitSleepCommand(s).hit, true, s + ' 应命中（大小写不敏感）');
  }
});

// ── ② judgeWaitSleepCommand：放行面（本机实测放行的主路径不误拦）──
test('L5-K-3 wait-sleep 判定：放行面 —— 执行/构建/只读命令不误拦', () => {
  for (const s of ['npm test', 'node --test', 'Get-ChildItem .', 'git status --porcelain', 'npx tsc --noEmit', 'grep -r foo lib/']) {
    const v = judgeWaitSleepCommand(s);
    assert.equal(v.hit, false, s + ' 应放行：' + JSON.stringify(v));
  }
});

// ── ③ 分段：任一段段首为等待命令即拒 ──
test('L5-K-4 wait-sleep 判定：分段后任一段命中即拒（; / && / || / | / 换行）；非段首不命中', () => {
  for (const s of ['echo hi; sleep 5', 'npm test && start-sleep 3', 'true || wait-event x', 'cat a | timeout 5 cat', 'echo a\nsleep 1']) {
    assert.equal(judgeWaitSleepCommand(s).hit, true, JSON.stringify(s) + ' 应命中（后续段是等待）');
  }
  assert.equal(judgeWaitSleepCommand('echo sleep 5').hit, false, 'sleep 作为参数（非段首）⇒ 不命中（段首判定口径）');
});

// ── ④ 赋值前缀：剥掉【变量名=】前缀后仍按段首判 ──
test('L5-K-5 wait-sleep 判定：只剥「变量名=」前缀（不剥整段赋值 —— 如实记录实现行为）', () => {
  // 实现口径（tool-ban.ts:124 `s.replace(ASSIGN_RE, '')`）：ASSIGN_RE 只消「变量名=」这一前缀，
  //   因此 `A=1 sleep 2` 剥后段首为 `1`（仍不是 sleep）⇒ **不命中**；等待命令须**自成一段**才命中。
  assert.equal(judgeWaitSleepCommand('A=1 sleep 2').hit, false, '只剥变量名 ⇒ 段首为 `1` ⇒ 不命中（实现如此，非缺陷）');
  assert.equal(judgeWaitSleepCommand('A=1; sleep 2').hit, true, '★分号断开 ⇒ 等待自成一段 ⇒ 命中');
  assert.equal(judgeWaitSleepCommand('FOO= sleep 2').hit, true, '★仅 `FOO=` 前缀 ⇒ 剥后段首即 sleep ⇒ 命中');
});

// ── ⑤ 引号掩码：引号内的等待词不算命令 ──
test('L5-K-6 wait-sleep 判定：引号内的等待词被掩码（echo "sleep 5" 放行）', () => {
  assert.equal(judgeWaitSleepCommand('echo "sleep 5"').hit, false, '双引号内容不参与段首判定');
  assert.equal(judgeWaitSleepCommand("Write-Output 'start-sleep'").hit, false, '单引号同理');
});

// ── ⑥ fail-closed：边界不明时按等待处理 ──
test('L5-K-7 wait-sleep 判定：空/非字符串不命中；**未闭合引号 fail-closed 命中**', () => {
  for (const v of ['', '   ', null, undefined, 42]) {
    assert.equal(judgeWaitSleepCommand(v).hit, false, JSON.stringify(v) + ' 无等待动作可判 ⇒ 不命中');
  }
  const bad = judgeWaitSleepCommand('echo "unclosed');
  assert.equal(bad.hit, true, '★未闭合引号 ⇒ 命令边界不明 ⇒ fail-closed 命中');
  assert.ok(String(bad.reason).includes('未闭合'), 'reason 须点名未闭合引号：' + bad.reason);
});

// ── ⑦ matchToolBan 公开面：工具名过滤 + 三分支 ──
test('L5-K-8 matchToolBan 工具名过滤：条目 tool 不匹配 ⇒ 永不命中（即使 behavior 是 tool-disabled）', () => {
  const entries = [ban('wait_agent', 'tool-disabled')];
  assert.equal(hit(entries, 'wait_agent'), true, '同名 ⇒ 命中');
  assert.equal(hit(entries, 'bash'), false, '异名 ⇒ 不命中（工具名是第一道闸）');
});

test('L5-K-9 matchToolBan 分支 tool-disabled：**不看参数**（本会话活体实测口径）', () => {
  const entries = [ban('wait_agent', 'tool-disabled')];
  // 无 command / 空 args / 含命令 —— 三种入参都应命中
  assert.equal(hit(entries, 'wait_agent'), true, '无 command 也须命中（这正是 tool-disabled 存在的理由）');
  assert.equal(hit(entries, 'wait_agent', ''), true, '空 command 也须命中');
  assert.equal(hit(entries, 'wait_agent', 'sleep 99'), true, '含等待命令也命中（不看参数）');
  const v = matchToolBan(entries, { name: 'wait_agent', arguments: {} });
  assert.ok(String(v.violations[0].message).includes('tool-disabled：不看参数'), '判定依据须可溯源：' + v.violations[0].message);
  assert.deepEqual(v.ruleRefs, ['T-tool-disabled'], 'ruleRefs 收集条目 id');
});

test('L5-K-10 matchToolBan 分支 wait-sleep：看 command（等待命中 / 普通放行）', () => {
  const entries = [ban('pwsh', 'wait-sleep'), ban('bash', 'wait-sleep')];
  assert.equal(hit(entries, 'pwsh', 'Start-Sleep -Seconds 5'), true, '★pwsh + 等待命令 ⇒ 命中');
  assert.equal(hit(entries, 'bash', 'sleep 3'), true, '★bash + sleep ⇒ 命中');
  assert.equal(hit(entries, 'pwsh', 'Get-ChildItem .'), false, 'pwsh + 只读 ⇒ 放行（本会话实测放行）');
  assert.equal(hit(entries, 'bash', 'npm test'), false, 'bash + 构建 ⇒ 放行');
});

test('L5-K-11 matchToolBan 分支 file-write：看 command（写动词命中 / 只读放行）', () => {
  const entries = [ban('pwsh', 'file-write')];
  assert.equal(hit(entries, 'pwsh', 'echo x > f.txt'), true, '写动词 ⇒ 命中');
  assert.equal(hit(entries, 'pwsh', 'Get-ChildItem'), false, '只读 ⇒ 放行');
});

// ── ⑧ 未知 behavior：fail-closed（不静默放行）──
test('L5-K-12 matchToolBan 未知 behavior ⇒ **fail-closed 命中**（不静默放行，2026-09-15 B1 起）', () => {
  const entries = [ban('pwsh', 'bogus-behavior')];
  assert.equal(hit(entries, 'pwsh', 'anything'), true, '★未知 behavior 必须 fail-closed（宁可误拦也不裸奔）');
  const v = matchToolBan(entries, { name: 'pwsh', arguments: { command: 'anything' } });
  assert.ok(String(v.violations[0].message).includes('bogus-behavior'), 'message 须点名未实现的行为面：' + v.violations[0].message);
  assert.ok(String(v.violations[0].message).includes('保守按命中处理'), 'message 须声明保守口径');
});

// ── ⑨ 边界：空表 / 非法条目不炸 ──
test('L5-K-13 matchToolBan 边界：空表 / 非数组 / 非法条目 ⇒ 零命中且不抛', () => {
  assert.deepEqual(matchToolBan([], { name: 'x' }), { violations: [], ruleRefs: [] }, '空表 ⇒ 零命中');
  assert.deepEqual(matchToolBan(null, { name: 'x' }), { violations: [], ruleRefs: [] }, '非数组 ⇒ 零命中');
  assert.deepEqual(matchToolBan([null, 'x', 42], { name: 'x' }), { violations: [], ruleRefs: [] }, '非法条目 ⇒ 跳过不炸');
});

// ── ⑩ 枚举 ↔ 规则表 ↔ 实现 三方一致 ──
test('L5-K-14 枚举面：TOOL_BAN_BEHAVIORS 恰三值，且每值都有**已实现**分支（无「在册却无实现」）', () => {
  assert.deepEqual([...TOOL_BAN_BEHAVIORS], ['file-write', 'tool-disabled', 'wait-sleep'], '枚举三值（与 types.ts:115 / config.ts:135 同源）');
  // 每个 behavior 喂**它自己负责的触发样本** ⇒ 必须落在已实现分支（而非「未知 ⇒ fail-closed」兜底）
  const sampleOf = {
    'file-write': 'echo x > f.txt',
    'tool-disabled': undefined,
    'wait-sleep': 'sleep 1',
  };
  for (const b of TOOL_BAN_BEHAVIORS) {
    const v = matchToolBan([ban('t', b)], { name: 't', arguments: sampleOf[b] === undefined ? {} : { command: sampleOf[b] } });
    assert.ok(v.violations.length > 0, b + ' 应有可判分支（样本：' + JSON.stringify(sampleOf[b]) + '）');
    assert.equal(
      String(v.violations[0].message).includes('未实现'),
      false,
      '★' + b + ' 不得落入「未知行为面」兜底（枚举与实现须一一对应）：' + v.violations[0].message,
    );
  }
});
