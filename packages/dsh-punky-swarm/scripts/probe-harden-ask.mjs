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

// M2 硬化真宿主 ask 双路径探针（exec-tester lane；harden-plan §5.5 原型 B + p1-manifest 移交⑥）
// 真宿主 = cordis 真 Context + dsh-tools ToolRuntime（本 worktree node_modules @deepseek-ai/dsh-tools
//   0.1.0-rc.6）+ 真实 installGovernanceHook（wiring 端到端）——非 fake ctx。
// 观察点（serviceAsk HOST:3296-3347 逐分支真宿主实测）：
//   路径① 有审批服务（ctx.provide('approval') → request 返回 'allowed-once'）→ 宿主放行 dispatch
//         （工具体执行 bodyRan）→ post 补记收据 ask.outcome=allowed-once；
//   路径② 无审批服务（approval === void 0）→ 宿主降级 deny（reason 保留 ask.reason，HOST:3298-3304）
//         → post 补记收据 ask.outcome=denied-no-approval（infer 默认分支）。
// 用法：cd packages/dsh-punky-swarm && node scripts/probe-harden-ask.mjs
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGovernanceHook } from '../lib/governance/wiring.js';
import { readRefusals, verifyRefusals } from '../lib/governance/receipt-store.js';

const hostVersion = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url), 'utf8')).version; } catch { return '?'; }
})();

// REQUIRE_APPROVAL 规则（manual_review → ask；scope=admin 命中）
const ASK_CFG = {
  governance: {
    hook: {
      enabled: true,
      rules: [
        {
          id: 'real-approval-rule',
          tools: ['demo-edit'],
          match: { path: '/scope', op: 'eq', value: 'admin' },
          violations: [{ code: 'RA1', category: 'manual_review', message: '高危管理操作需人工复核（真宿主 ask 探针）' }],
        },
      ],
    },
  },
};

async function mountApp({ withApproval }) {
  const app = new Context();
  await app.plugin(SystemPrompt, {});
  await app.plugin(ToolRuntime, { mode: 'native' });
  const bodyRan = [];
  const approvalCalls = [];
  if (withApproval) {
    // 审批服务（allowed-once 自动放行）；记录 request 入参供证据输出
    app.provide('approval', {
      request: async (req) => {
        approvalCalls.push(req);
        return 'allowed-once';
      },
    });
  }
  app.tools.register(defineTool({
    name: 'demo-edit',
    description: 'demo tool for real-host ask probe',
    parameters: {
      scope: { type: 'string' },
      cmd: { type: 'string' },
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-real-ask-'));
  const hook = installGovernanceHook(app, { store: null, root, config: ASK_CFG });
  const execArgs = {
    name: 'demo-edit',
    arguments: { scope: 'admin', cmd: 'userdel alice' },
    callId: 'real-ask-' + (withApproval ? 'allow' : 'degrade'),
    signal: new AbortController().signal,
    agent: { session: { id: 'sess-real' } }, // serviceAsk 需 agent 路由（HOST:3305-3311）
  };
  const out = await app.tools.execute(execArgs);
  return { app, root, bodyRan, approvalCalls, out, execArgs, hook };
}

const a = await mountApp({ withApproval: true });   // 路径① allowed-once
const b = await mountApp({ withApproval: false });  // 路径② 无审批服务降级 deny

const ra = readRefusals(a.root, 'sess-real');
const rb = readRefusals(b.root, 'sess-real');
const rA = ra.find((r) => r.callId === a.execArgs.callId);
const rB = rb.find((r) => r.callId === b.execArgs.callId);

console.log('=== 路径① 有审批服务（allowed-once）===');
console.log(JSON.stringify({
  host: 'dsh-tools@' + hostVersion,
  approvalRequestCalls: a.approvalCalls.length,
  dispatched: a.bodyRan.includes(a.execArgs.callId),
  returnIsError: a.out.isError,
  receiptAsk: rA?.ask ?? null,
}, null, 2));
console.log('=== 路径② 无审批服务（降级 deny）===');
console.log(JSON.stringify({
  host: 'dsh-tools@' + hostVersion,
  approvalRequestCalls: b.approvalCalls.length,
  dispatched: b.bodyRan.includes(b.execArgs.callId),
  returnIsError: b.out.isError,
  returnError: b.out.error?.message,
  receiptAsk: rB?.ask ?? null,
}, null, 2));
console.log('=== 验链 ===');
console.log(JSON.stringify({ pathA: verifyRefusals(a.root, 'sess-real'), pathB: verifyRefusals(b.root, 'sess-real') }, null, 2));

a.hook.dispose();
b.hook.dispose();
// 注：cordis fork 无 app.stop()，进程随脚本结束自然退出
