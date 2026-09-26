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

// test/s2-prime-wake-probe.test.js —— S-2′ 可行性实验（`reports/onto-s2-push-probe-report.md` §7）
//
// 命题（H）：**插件 handler（普通调用栈）内**能否取到 Leader agent 并**唤醒**它 —— 用宿主自用的原语
//   `agent.followup(msg)`（= `send(msg, 'next-turn', wake=true)`，`dsh-agent-loop/lib/index.js:800-814`）。
//
// 与 S-2 的分别（前一 lane 已裁）：S-2（handler 内代发 `send_message`）被证伪 —— 瓶颈不在工具执行面，
//   而在 `dsh-subagent` 的**发送方身份授权**（one-shot lane worker 不是 resident continuable child）。
//   S-2′ 绕开该授权面，直推 `Agent.followup`，因此**本文件全程不调用 `send_message` / `subagents`**。
//
// 实验形态（最小、可逆、单文件）：
//   · 进程内装配**真实宿主包**（`@deepseek-ai/dsh-{agent,agent-loop,session,llm,tools,system-prompt,session-projection}`
//     —— 取自本机 dsh 发行目录，即**与运行中宿主同版本**的同一批包），做出**真实 Agent**；
//   · 探针**工具**由**独立插件 fiber** 注册（`inject` **不含 `agents`**）——刻意复刻 onto 的注入面
//     （`lib/index.js:86` `inject = ['tools','webServer','subagents']`），因此 handler 必须走
//     `ctx.get('agents')` **非注入读**（先例 `lib/tools/core.js:577` `ctx.get('agentTeams')`）；
//   · 经**真实 ToolRuntime** `ctx.tools.execute(...)` 触发 handler（不是直调函数）。
//
// ⚠ 边界声明（如实）：
//   1. **不触碰本会话 / 不触碰运行中宿主的 Leader** —— 本文件在独立 node 进程内自建宿主分片，
//      被唤醒的是**本进程内新建的探针 Agent**，不是任何真实 Leader 会话；因此无任何会话噪声。
//      （任务包「只调 1 次、消息写明『实验』」的口径按此落实：唤醒调用只发生在本进程自建 Agent 上。）
//   2. 本文件**只落 `swarm_report` 兼底路的可达性证据模型**，**不改** `lib/engine/auto-settle.js` 的
//      `subagent/end` 主路，也不改任何 `lib/**`。
//   3. 宿主根不可解析（非本机 / 未安装 dsh 发行目录）时**整组 skip**，绝不失败 —— 本文件不是回归判据，
//      是一次性能力实验；跑法见报告。
//
// 跑法（**禁 `npm test`**：build 会重写受控 `lib/*.js`）：
//   cd packages/dsh-punky-swarm
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/s2-prime-wake-probe.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 宿主核心包根候选（含 dsh-agent-loop 的那一层 `@deepseek-ai`）。 */
const HOST_ROOT_CANDIDATES = [
  process.env.DSH_CORE_ROOT,
  'D:/Program Files/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
];

function resolveHostRoot() {
  for (const root of HOST_ROOT_CANDIDATES) {
    if (!root) continue;
    try {
      if (fs.existsSync(path.join(root, 'dsh-agent-loop', 'lib', 'index.js'))) return root;
    } catch { /* 候选无效，继续 */ }
  }
  return null;
}

const HOST_ROOT = resolveHostRoot();
const SKIP = HOST_ROOT === null;
const SKIP_REASON = '宿主核心包根不可解析（需 dsh 发行目录含 dsh-agent-loop）；本文件是一次性能力实验，非回归判据';
const loadHost = (pkg) => import(pathToFileURL(path.join(HOST_ROOT, pkg, 'lib', 'index.js')).href);

function hostVersion(pkg) {
  try { return JSON.parse(fs.readFileSync(path.join(HOST_ROOT, pkg, 'package.json'), 'utf8')).version; }
  catch { return '?'; }
}

/** 一句话原始事实读数（供报告逐字引用，不走断言失败路径）。 */
function reading(tag, value) {
  console.log('[S2P] ' + tag + ' = ' + JSON.stringify(value));
}

/**
 * 装配一份**真实宿主分片**。
 * @param withAgents 是否挂 `dsh-agent`（`agents` 服务）—— RED② 需要 `false` 以构造「服务缺失」。
 * @returns {{ app, agents, agentLoop, LlmMod, defineTool, serviceNames }}
 */
async function mountHost({ withAgents }) {
  const { Context } = await loadHost('cordis');
  const Sessions = (await loadHost('dsh-session')).default;
  const LlmMod = await loadHost('dsh-llm');
  const Tools = (await loadHost('dsh-tools')).default;
  const SysPrompt = (await loadHost('dsh-system-prompt')).default;
  const Proj = (await loadHost('dsh-session-projection')).default;

  const app = new Context();
  await app.plugin(Sessions, {});
  await app.plugin(Proj, {});
  await app.plugin(LlmMod.default, {});
  await app.plugin(Tools, { mode: 'native' });
  await app.plugin(SysPrompt, {});
  if (withAgents) {
    // `agents` 服务（AgentRegistry：live 句柄注册表）由 `dsh-agent` 注册；
    // Agent 的**构造与驱动**由 `dsh-agent-loop` 工厂承担（`AgentLoop` :1511 super(ctx,'agentLoop')、
    // :1522 ctx.agents.setFactory(this)）—— 两者缺一不可（缺 loop ⇒ `no agent factory registered`）。
    const Agents = (await loadHost('dsh-agent')).default;
    await app.plugin(Agents, {});
    const AgentLoop = (await loadHost('dsh-agent-loop')).default;
    await app.plugin(AgentLoop, { maxParallelToolCalls: 10, agents: [] });
  }
  return { app, LlmMod, defineTool: (await loadHost('dsh-tools')).defineTool };
}

/** 可控 LLM 适配器：每轮流被外部 release 阻塞 —— 借此把 Agent 稳定停在 `running`，观测 latch。 */
function installBlockingLlm(LlmMod, app, calls) {
  class BlockingAdapter extends LlmMod.LlmAdapter {
    stream() {
      const release = Promise.withResolvers();
      calls.push({ release });
      return (async function* () {
        await release.promise;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '已唤醒' };
        yield { type: 'finish', reason: 'stop' };
      })();
    }
  }
  app.llm.registerAdapter(['s2probe'], new BlockingAdapter());
}

/**
 * 探针插件：**独立 fiber**，`inject` 只有 `tools`（**刻意不含 `agents`**，复刻 onto 注入面）。
 * handler 内逐条照做 §7 步骤 1–5。
 */
function probePlugin(defineTool, record) {
  return {
    name: 's2-prime-wake-probe',
    inject: ['tools'],
    apply(ctx) {
      ctx.tools.register(defineTool({
        name: 's2_wake_probe',
        description: 'S-2′ 探针：handler 内 ctx.get("agents") 取 Leader 并 followup 唤醒（实验用）',
        parameters: {
          leaderId: { type: 'string', required: true },
          invoke: { type: 'boolean' }, // false = 只读前置态、不 followup（RED① 基线对照）
        },
        output: {
          schema: { type: 'object', properties: {}, additionalProperties: true },
          render: (_args, value) => value,
        },
        async execute(args) {
          const out = {
            serviceAvailable: false,
            leaderFound: false,
            statusBefore: null,
            statusAfter: null,
            returned: null,
            invoked: false,
            error: null,
          };
          try {
            // ① ctx.get('agents')：非注入读（onit 侧先例 lib/tools/core.js:577 ctx.get('agentTeams')）
            const agents = ctx.get('agents');
            out.serviceAvailable = agents !== undefined && agents !== null;
            if (!out.serviceAvailable) { record(out); return out; }
            // ② Leader agent 句柄（同 dsh-subagent/lib/index.js:1257 this.ctx.agents.get(activation.parentSession)）
            const leader = agents.get(args.leaderId);
            out.leaderFound = leader !== undefined && leader !== null;
            if (!out.leaderFound) { record(out); return out; }
            // ③ 前置状态（idle | running，dsh-agent-loop/lib/index.js:790 get status）
            out.statusBefore = leader.status;
            if (args.invoke === false) { record(out); return out; }
            // ④ follower 唤醒（dsh-agent-loop/lib/index.js:806-807 followup → (next-turn, wake=true)）
            const message = args.message ?? null;
            out.returned = leader.followup(message ?? undefined) ?? null;
            out.invoked = true;
            out.statusAfter = leader.status;
            record(out);
            return out;
          } catch (error) {
            out.error = String(error && error.message ? error.message : error);
            record(out);
            throw error; // 不吞异常
          }
        },
      }));
    },
  };
}

/** 轮询等待（避免固定 sleep 造成的假绿/假红）。 */
async function waitFor(predicate, budgetMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('S-2′ 可行性实验（宿主分片）', { skip: SKIP && SKIP_REASON, concurrency: false }, async (t) => {
  reading('hostRoot', HOST_ROOT);
  reading('versions', {
    'dsh-agent-loop': hostVersion('dsh-agent-loop'),
    'dsh-agent': hostVersion('dsh-agent'),
    'dsh-tools': hostVersion('dsh-tools'),
    'dsh-subagent': hostVersion('dsh-subagent'),
    'dsh-llm': hostVersion('dsh-llm'),
  });

  // ────────────────────────────────────────────────────────────────────────────
  // RED② 降级面：**服务缺失** ⇒ `ctx.get('agents')` 返回 undefined 且**不抛**
  //   （未挂 dsh-agent 的宿主分片 = onto 在非官方宿主 / 服务未挂时的形态）
  // ────────────────────────────────────────────────────────────────────────────
  await t.test('RED② 服务缺失：handler 内 ctx.get("agents") 为 undefined 且不抛（fail-safe 降级）', async () => {
    const { app, defineTool } = await mountHost({ withAgents: false });
    const recorded = [];
    await app.plugin(probePlugin(defineTool, (o) => recorded.push(o)), {});
    const out = await app.tools.execute({
      name: 's2_wake_probe',
      arguments: { leaderId: 'leader-probe', invoke: true },
      callId: 's2p-red2',
      signal: new AbortController().signal,
    });
    reading('RED② toolResult', { isError: out.isError, error: out.error?.message ?? null, value: out.value });
    assert.equal(out.isError, false, '服务缺失时 handler 不得抛错（fail-safe 降级）');
    assert.equal(out.value.serviceAvailable, false, 'ctx.get("agents") 须为 undefined/null');
    assert.equal(out.value.leaderFound, false, '服务缺失 ⇒ 取不到 Leader 句柄');
    assert.equal(recorded.length, 1, 'handler 走到了降级分支并回显读数');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 主组：真实 Agent ⇄ 探针 handler 全链路
  // ────────────────────────────────────────────────────────────────────────────
  await t.test('RED①/GREEN①③/ GREEN④ 真实 Agent 全链路', async () => {
    const { app, LlmMod, defineTool } = await mountHost({ withAgents: true });
    const calls = [];
    installBlockingLlm(LlmMod, app, calls);

    // 「Leader」= 本进程内自建的真实 Agent（id 即 §7 的 leaderSessionId）
    const LEADER_ID = 'leader-probe';
    const leaderHandle = await app.agents.create({
      sessionId: LEADER_ID,
      agentOptions: { provider: 's2probe', model: 's2probe-model' },
    });
    const leader = leaderHandle.agent;
    const statusTrail = [];
    leader.ctx.on('agent/status', (p) => statusTrail.push(p?.status ?? null));

    const turnStarts = () => leader.session.snapshotEvents().filter((e) => e.type === 'turn/start').length;
    const userMessages = () => leader.session.snapshotEvents().filter((e) => e.type === 'user/message').length;
    const mkMsg = (text) => LlmMod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

    // 调用方 agent（模拟「lane worker 在自己 handler 里推 Leader」的调用栈归属）
    const callerHandle = await app.agents.create({
      sessionId: 'worker-probe',
      agentOptions: { provider: 's2probe', model: 's2probe-model' },
    });

    const recorded = [];
    await app.plugin(probePlugin(defineTool, (o) => recorded.push(o)), {});
    const execProbe = (args, callId) => app.tools.execute({
      name: 's2_wake_probe',
      arguments: args,
      callId,
      signal: new AbortController().signal,
      agent: callerHandle.agent, // handler 经真实 ToolRuntime 调度，exec.agent = 调用方（同 swarm_report 形态）
    });

    reading('GREEN① 服务可用', { agentsService: typeof app.get('agents'), leaderRegistered: app.agents.get(LEADER_ID) === leader });
    assert.equal(app.agents.get(LEADER_ID), leader, 'GREEN②：leader 已登记为 live Agent');
    assert.equal(leader.status, 'idle', '前置：Leader 初始为 idle');

    // ── RED① 基线：handler 内**不调用** followup ⇒ Leader 保持 idle、零新轮 ──
    const baseOut = await execProbe({ leaderId: LEADER_ID, invoke: false }, 's2p-red1');
    await new Promise((r) => setTimeout(r, 300));
    reading('RED① 不调用', {
      handlerReading: baseOut.value,
      statusAfterWindow: leader.status,
      turnStarts: turnStarts(),
      llmCalls: calls.length,
    });
    assert.equal(baseOut.value.serviceAvailable, true, 'RED① 前置：服务可用');
    assert.equal(baseOut.value.leaderFound, true, 'RED① 前置：Leader 可解析');
    assert.equal(baseOut.value.invoked, false, 'RED①：未 followup');
    assert.equal(leader.status, 'idle', 'RED①：不调用 ⇒ Leader 不被唤醒（仍 idle）');
    assert.equal(turnStarts(), 0, 'RED①：不调用 ⇒ 零新 turn（基线成立）');
    assert.equal(calls.length, 0, 'RED①：不调用 ⇒ 零 LLM 轮');

    // ── GREEN①③ handler 内 idle 唤醒 ──
    const wakeOut = await execProbe(
      { leaderId: LEADER_ID, invoke: true, message: mkMsg('实验：S-2′ handler 内 followup 唤醒探针') },
      's2p-green3',
    );
    const opened = await waitFor(() => calls.length === 1);
    reading('GREEN③ handler 内 idle 唤醒', {
      handlerReading: wakeOut.value,
      observedTurnStart: opened,
      turnStarts: turnStarts(),
      llmCalls: calls.length,
      statusTrail: [...statusTrail],
    });
    assert.equal(wakeOut.value.serviceAvailable, true, 'GREEN①：handler 内 ctx.get("agents") 可用');
    assert.equal(wakeOut.value.leaderFound, true, 'GREEN①：leaderFound=true');
    assert.equal(wakeOut.value.statusBefore, 'idle', 'GREEN③：前置态为 idle');
    assert.equal(wakeOut.value.statusAfter, 'running', 'GREEN③：followup 同步把 idle 推入 running（开新 turn）');
    assert.equal(opened, true, 'GREEN③：观测到 Leader 开了新 turn（LLM 轮已发起）');
    assert.equal(turnStarts(), 1, 'GREEN③：会话内 turn/start = 1');
    assert.deepEqual(statusTrail, ['running'], 'GREEN③：agent/status 事件为 running');

    // ── GREEN④ running 时 latch 不丢 ──
    const latchOut = await execProbe(
      { leaderId: LEADER_ID, invoke: true, message: mkMsg('实验：S-2′ running 期 latch 探针') },
      's2p-green4',
    );
    reading('GREEN④ running latch（推入瞬间）', {
      handlerReading: latchOut.value,
      inboxNextTurn: leader.inbox.nextTurn.length,
      turnStarts: turnStarts(),
    });
    assert.equal(latchOut.value.statusBefore, 'running', 'GREEN④：前置态为 running');
    assert.equal(leader.status, 'running', 'GREEN④：running 期调用不改状态');
    assert.equal(leader.inbox.nextTurn.length, 1, 'GREEN④：消息 latch 进 next-turn 队列（不丢）');

    calls[0].release.resolve();
    const secondTurn = await waitFor(() => calls.length === 2);
    reading('GREEN④ 轮边界续轮', {
      secondTurnOpened: secondTurn,
      turnStarts: turnStarts(),
      userMessages: userMessages(),
      llmCalls: calls.length,
      inboxNextTurn: leader.inbox.nextTurn.length,
    });
    assert.equal(secondTurn, true, 'GREEN④：轮边界自动开第二轮（latch 被消费）');
    assert.equal(turnStarts(), 2, 'GREEN④：turn/start = 2');
    assert.equal(userMessages(), 2, 'GREEN④：两条消息都进了会话（无丢失）');
    assert.equal(leader.inbox.nextTurn.length, 0, 'GREEN④：latch 已被下一轮认领');

    calls[1]?.release.resolve();
    await waitFor(() => leader.status === 'idle');
    reading('收尾', { status: leader.status, statusTrail: [...statusTrail], turnStarts: turnStarts() });
    assert.equal(leader.status, 'idle', '收尾：两轮跑完回到 idle');
  });
});
