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

// 真宿主调度器实测探针（build-plan §3.2 可选补充 + 蓝图 §8『待核实』项）：
// pre 拒绝后，宿主对 tools/result 的行为实测（源码读证 HOST:3105-3137 / 3226-3261 已在报告中交叉印证）。
// 载体：cordis 真 Context + dsh-tools ToolRuntime（本 worktree node_modules 内 0.1.0-rc.6）+
//       真实 installGovernanceHook（M2 hook 端到端）——非 fake ctx。
// 观察点：
//   A) pre 拒绝（DENY 短路）→ 工具体是否执行？post-execute 是否被调用？tools/result 是否发射（冻结 Error 结果）？
//   B) ask 决策 → 无 approval 服务 → 宿主降级 deny（HOST:3305-3311）→ 同上观察。
// 用法：cd packages/dsh-punky-swarm && node scripts/probe-host-pre-reject.mjs
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { readRefusals } from '../lib/governance/receipt-store.js';

const hostVersion = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url), 'utf8')).version; } catch { return '?'; }
})();

// ── 挂载真宿主（cordis app + systemPrompt + tools；plugin() 为异步，须 await）──
const app = new Context();
await app.plugin(SystemPrompt, {});
await app.plugin(ToolRuntime, { mode: 'native' });

// 注册 1 个假工具（真工具体：按 callId 记录执行，验证 pre 拒绝后不 dispatch）
const bodyRan = []; // 每次工具体执行时 push callId
app.tools.register(defineTool({
  name: 'demo-bash',
  description: 'demo tool for governance probe',
  parameters: {
    cmd: { type: 'string', required: true },
    scope: { type: 'string' },
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
    render: (_args, value) => value,
  },
  async execute(_args, exec) {
    bodyRan.push(exec.callId);
    return { ok: true };
  },
}));

// ── 挂载真实 M2 governance hook（temp root，不碰真实 ~/.dsh/jiufeng）──
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-probe-'));
const CONFIG = {
  governance: {
    hook: {
      enabled: true,
      rules: [
        {
          id: 'R001',
          tools: ['demo-bash'],
          match: { path: '/cmd', op: 'regex', pattern: 'rm -rf' },
          violations: [{ code: 'V001', category: 'hard', message: '禁止删除命令' }],
        },
        {
          id: 'R002',
          match: { path: '/scope', op: 'eq', value: 'admin' },
          violations: [{ code: 'V002', category: 'manual_review', message: '高危操作需人工复核' }],
        },
      ],
    },
  },
};
const hook = installGovernanceHook(app, { store: null, root, config: CONFIG });
console.log(`[probe] host=dsh-tools@${hostVersion} | hook.installed=${hook.installed}`);

// ── 观察者：post-execute 与 tools/result（记录是否被触发 + 结果形态 + 冻结状态）──
const observed = { post: [], result: [] };
app.on('tools/post-execute', async (exec, result, next) => {
  observed.post.push({ name: exec.name, callId: exec.callId, isError: result.isError, kind: 'pass-through' });
  return next(); // M2 post 恒 pass-through（2.2 语义）
});
app.on('tools/result', (exec, result) => {
  observed.result.push({
    name: exec.name,
    callId: exec.callId,
    isError: result.isError,
    execFrozen: Object.isFrozen(exec),
    errorMessage: result.error?.message ?? null,
  });
});

// ── A) pre 拒绝（DENY 短路）调用 ──
const outA = await app.tools.execute({
  name: 'demo-bash',
  arguments: { cmd: 'rm -rf /' },
  callId: 'probe-deny',
  signal: new AbortController().signal,
  agent: { session: { id: 'sess-probe' } },
});

// ── B) ask → 无 approval 服务 → 降级 deny（HOST:3305-3311）──
const outB = await app.tools.execute({
  name: 'demo-bash',
  arguments: { cmd: 'ls', scope: 'admin' }, // 命中 R002（manual_review）→ REQUIRE_APPROVAL
  callId: 'probe-ask',
  signal: new AbortController().signal,
  agent: { session: { id: 'sess-probe' } },
});

// ── 对照 C) ALLOW 调用（不命中任何规则）──
const outC = await app.tools.execute({
  name: 'demo-bash',
  arguments: { cmd: 'ls' },
  callId: 'probe-allow',
  signal: new AbortController().signal,
  agent: { session: { id: 'sess-probe' } },
});

const receipts = readRefusals(root, 'sess-probe');
console.log('=== A) pre 拒绝（DENY 短路）===');
console.log(JSON.stringify({ returnIsError: outA.isError, returnError: outA.error?.message, bodyExecuted: bodyRan.includes('probe-deny') }, null, 2));
console.log('=== B) ask 无审批降级 deny ===');
console.log(JSON.stringify({ returnIsError: outB.isError, returnError: outB.error?.message, bodyExecuted: bodyRan.includes('probe-ask') }, null, 2));
console.log('=== C) ALLOW 对照 ===');
console.log(JSON.stringify({ returnIsError: outC.isError, returnValue: outC.value, bodyExecuted: bodyRan.includes('probe-allow') }, null, 2));
console.log('=== 观察者记录 ===');
console.log(JSON.stringify({ post: observed.post, result: observed.result, receipts: receipts.length }, null, 2));
console.log('=== 收据明细 ===');
for (const r of receipts) console.log(JSON.stringify({ receiptId: r.receiptId.slice(0, 8), tool: r.tool, callId: r.callId, primitive: r.decision.primitive, ruleRefs: r.ruleRefs, attemptedParams: r.attemptedParams }));

hook.dispose();
// 注：cordis fork 无 app.stop()，进程随脚本结束自然退出
