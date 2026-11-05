/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/mcp-data-plane.test.js —— **S4 验收层**：MCP 数据面薄包装（暴露面 / 薄包装机核 / 不绕过守卫 / 协议分层 / loopback）。
//
// 判据源：`plan/p1-pack.md` §2.1（P-1…P-5）／§2.2（暴露面 20 行）／§2.5（无 session 三态）／AC-2/4/5/6/7/8/9/10。
//
// ⚠ 隔离纪律（防把真批次写脏）：**所有** `tools/call` 都跑在**临时目录 store + 临时批次**上
//   （`fs.mkdtemp` + `createStore`），绝不碰仓库内/真实批；写工具（如 `batch_phase`）只在临时批上执行。
//
// ⚠ 证据面：`npm run check` 对 `.js` 无证据力 ⇒ 行为证据全部来自**真实调用**：
//   `installMcpDataPlane` 的 handler 被真实驱动（假 req/res 走**同一** `readBody/sendJson` 路径），
//   `ctx.tools.execute` 接到**真** `@deepseek-ai/dsh-tools` `ToolRuntime`（含真难度门禁 + 真溯源守卫）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/state/../wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { SUITE_TOOLS } from '../lib/engine/suite.js';
import { installWriteProvenanceGuard, writeProvenanceDecision } from '../lib/tools/write-provenance-guard.js';
import {
  installMcpDataPlane, exposedToolNamesOf, callableToolNamesOf, HOST_PROVIDED_TOOLS,
  MCP_PROTOCOL_VERSION, MCP_PATH, LOOPBACK_ADDRESSES, EXPOSED_KINDS,
} from '../lib/mcp/data-plane-server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

// ── 测试侧唯一手写冻结基准（**不在生产代码里**；对账基准，非第二真源；禁改成派生）──────────
//   ⚠ 口径 = **可调面**（`callableToolNamesOf(ctx)` = 声明 ∩ 实际注册面，宿主件豁免），
//     不是「静态声明面」。实测三口径：声明 20 ／ 缺省可调 **19**（`log_export` 条件注册、`logs` 默认关）／
//     `capabilities.logs.enabled=true` 可调 **20**（含）。⇒ 两态都要测（缺省态单独测会掩盖开关）。
const EXPECTED_EXPOSED_DECLARED = Object.freeze([
  'artifact_types', 'asset_claim', 'batch_control', 'batch_phase', 'batch_status',
  'batch_tasks_add', 'gate_status', 'handoff_accept', 'handoff_submit', 'handoff_view',
  'lane_checkpoint_status', 'list_agents', 'log_export', 'member_settle', 'member_set_status',
  'role_guide', 'task_pool', 'task_update', 'wait_agent', 'wave_plan',
]);
const EXPECTED_EXPOSED_DEFAULT = Object.freeze(EXPECTED_EXPOSED_DECLARED.filter((n) => n !== 'log_export'));
const EXPECTED_EXPOSED_LOGS_ON = Object.freeze([...EXPECTED_EXPOSED_DECLARED]);
const MUST_NOT_EXPOSE = Object.freeze(['lane_dispatch', 'subagent', 'swarm_report']);

// ── 装配床：真 store（临时目录）+ 真 createTools + 真 ToolRuntime（含两守卫）+ MCP 挂载 ────────
async function makeBed(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-mcp-t1-'));
  const store = createStore(root);
  // 临时批（隔离：绝不用真实批次；写工具只在它上面跑）
  //   ⚠ 三层批约束：exec 层必须至少有一条 audit lane，故临时批用 exec + audit 两层最小骨架。
  store.createBatch('sess-mcp-t1', {
    batchId: 'b-mcp-t1',
    wavePlan: buildWavePlan({ batchId: 'b-mcp-t1', tasks: [{ id: 'e1', layer: 'exec' }, { id: 'a1', layer: 'audit', deps: ['e1'] }] }),
    phase: 'planning',
  });
  fs.mkdirSync(path.join(root, 'sessions', 'sess-mcp-t1', 'artifacts', 'b-mcp-t1'), { recursive: true });

  // ① 先用 createTools 得到**真实定义**（tools/list 的 inputSchema 取它们）
  //   ⚠ `config` 可注入：`log_export` 是**条件注册**（`capabilities.logs.enabled` 默认关）
  //     ⇒ logs 关/开两态的可调面分别是 19 / 20 件。
  const defCtx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
  const { tools: defs } = createTools(defCtx, { store, root, config });
  const byName = new Map(defs.map((d) => [d.name, d]));

  const app = new Context();
  app.systemPrompt = { tools() {}, section() {} };
  const rt = new ToolRuntime(app, { mode: 'native', maxParallelSubCalls: 4 });
  const executed = new Map();
  for (const d of defs) {
    rt.register({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok:' + d.name }] },
      async execute(args) {
        executed.set(d.name, (executed.get(d.name) ?? 0) + 1);
        // 业务错夹具：`batch_phase` 收到**不存在的批** ⇒ 抛错（真实语义 = 「批必须存在」；
        //   与 G5 的样例一致，且它恒在可调面内，不受 `logs` 开关影响）
        if (d.name === 'batch_phase' && String(args?.batchId ?? '') === 'no-such-batch') throw new Error('batch not found: no-such-batch');
        // 备用的「必然业务失败」样例（logs 打开时也可用）：`log_export` + `batchId:'boom'`
        if (d.name === 'log_export' && String(args?.batchId ?? '') === 'boom') throw new Error('fixture business failure');
        return { ok: true, name: d.name };
      },
    });
  }
  // ② 宿主桩：`HOST_PROVIDED_TOOLS` 在生产里由**宿主**注册（不在本仓 `createTools` 面内）。
  //   本床只装本仓工具；若不补宿主桩，「宣告即可达」性质断言会把**宿主件**误判成 unknown tool
  //   —— 那是**床的缺口**，不是产品缺口。故按「宿主确实提供它们」补最小桩。
  //   注意：它们**不进** `ctx.tools.get`（`byName` 只来自本仓 createTools）⇒ G1a 的可调面求交仍把
  //   `HOST_PROVIDED_TOOLS` 当豁免项，与生产口径完全一致。
  for (const hostName of HOST_PROVIDED_TOOLS) {
    rt.register({
      name: hostName,
      description: '宿主动作桩：' + hostName,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok:' + hostName }] },
      async execute() { executed.set(hostName, (executed.get(hostName) ?? 0) + 1); return { ok: true, name: hostName }; },
    });
  }
  rt.guard((execution) => writeProvenanceDecision(execution));

  // ③ MCP 面：ctx.webServer.register 捕获 handler；ctx.tools.get/execute 接真 runtime
  let mounted = null;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register: (route) => { mounted = route; return () => { mounted = null; }; } },
    // 【判据变种 #28 · 杀掉「替身比宿主宽容」的假绿】原替身 `rt.execute({ ...exec, signal: new AbortController().signal })`
    //   **自己补 signal** ⇒ 掩盖了「调用方根本不传 signal」这类缺口（宿主真身会抛原生
    //   `ERR_INVALID_ARG_TYPE: signals[0] is not of type AbortSignal.`，见 C-1 探针）。
    //   现改为**原样透传**：缺就是缺、错就是错，替身不再替调用方兜底。
    tools: { get: (name) => byName.get(name) ?? null, execute: async (exec) => rt.execute(exec) },
  };
  const dispose = installMcpDataPlane(ctx, {});
  assert.ok(mounted && typeof mounted.handler === 'function', '前置：MCP 面必须挂到 webServer.register 且给出 handler');
  return { root, store, rt, executed, handler: mounted.handler, route: mounted, dispose, byName, ctx };
}

/** 假 req（Readable + socket.remoteAddress + method）；假 res 收集 statusCode/body。 */
function reqOf(body, { method = 'POST', remoteAddress = '127.0.0.1' } = {}) {
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  stream.method = method;
  stream.socket = { remoteAddress };
  return stream;
}
function resOf() {
  const res = {
    statusCode: 0, headers: {}, chunks: [], body: undefined, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    // `sendJson` 走 `res.writeHead(status, headers)`（宿主/Node 原生形态）
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers); return this; },
    end(s) { this.ended = true; if (s !== undefined) { this.chunks.push(String(s)); this.body = this.chunks.join(''); } },
  };
  return res;
}
async function rpc(handler, frame, opts) {
  const res = resOf();
  await handler(reqOf(typeof frame === 'string' ? frame : JSON.stringify(frame), opts), res);
  return { statusCode: res.statusCode, ended: res.ended, body: res.body, json: res.body ? JSON.parse(res.body) : null };
}
const callFrame = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

// ══ G1 暴露面（**两条判据并用**：交集式抓「少宣告」；性质式抓「宣告但调不通」）════════════════
//   ⚠ 为什么两条都要：**「集合相等」在两个集合都错的时候仍然相等** —— 旧的
//     「声明 20 ≡ 手抄期望 20」之所以绿，正是因为两边都基于静态声明、同错相消（`log_export` 实际调不通却被掩盖）。
//     性质式（∀ 宣告名 ⇒ 不得 unknown tool）会随**注册面真实性**一起变化，不会被两边同错骗过。
test('G1a 交集式：可调面（declared ∩ 注册面，宿主件豁免）≡ 精确值 —— logs 关 19 / 开 20（两态）', async () => {
  // ── 态①：缺省（logs 默认关 ⇒ 无 log_export）──
  const off = await makeBed({});
  try {
    const derived = exposedToolNamesOf(); // 生产侧**声明**面（供对照，不作判据主体）
    assert.deepEqual([...derived].sort(), [...EXPECTED_EXPOSED_DECLARED].sort(), '声明面 ≡ 手写基准（20 名）');
    assert.deepEqual([...derived].sort(), SUITE_TOOLS.filter((t) => EXPOSED_KINDS.includes(t.kind)).map((t) => t.name).sort(),
      '声明面必须是「kind ∈ 暴露族」的现场过滤（禁手抄名单）');

    const callable = callableToolNamesOf(off.ctx); // **复用 lib 导出**：与实现同源，不在 test 里重写求交
    assert.deepEqual([...callable].sort(), [...EXPECTED_EXPOSED_DEFAULT].sort(),
      '缺省可调面必须**精确为 19 件**（`log_export` 条件注册、logs 关 ⇒ 不可调；不是 >=15 之类的宽口径）');
    assert.equal(callable.includes('log_export'), false, 'logs 关 ⇒ `log_export` **不得**出现在可调面');

    const r = await rpc(off.handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const listed = r.json.result.tools.map((t) => t.name).sort();
    assert.deepEqual(listed, [...callable].sort(), 'tools/list 名集 ≡ 可调面（不是声明面）');
    for (const t of r.json.result.tools) assert.equal(t.inputSchema.type, 'object', t.name + '：inputSchema.type 必须 object');
    for (const n of MUST_NOT_EXPOSE) assert.equal(listed.includes(n), false, n + ' 不得出现在暴露面');

    // 注入两态（集合式）：基准塞 lane_dispatch ⇒ 与可调面不等 ⇒ 红形态成立
    const injected = [...EXPECTED_EXPOSED_DEFAULT, 'lane_dispatch'].sort();
    assert.notDeepEqual(injected, [...callable].sort(), '注入 lane_dispatch 后必须与可调面不等（否则对撞形同虚设）');
    assert.deepEqual([...EXPECTED_EXPOSED_DEFAULT].sort(), [...callable].sort(), '还原基准后必须重新相等');
  } finally { off.dispose(); }

  // ── 态②：logs 开（`capabilities.logs.enabled=true` ⇒ 含 log_export）──
  const on = await makeBed({ capabilities: { logs: { enabled: true } } });
  try {
    const callable = callableToolNamesOf(on.ctx);
    assert.deepEqual([...callable].sort(), [...EXPECTED_EXPOSED_LOGS_ON].sort(),
      'logs 开 ⇒ 可调面必须**精确为 20 件**（含 log_export）');
    assert.equal(callable.includes('log_export'), true, 'logs 开 ⇒ `log_export` 必须可调（证明 logs 是真开关，不是装样子）');
    const r = await rpc(on.handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = r.json.result.tools.map((t) => t.name).sort();
    assert.deepEqual(listed, [...callable].sort(), 'logs 开时 tools/list 名集 ≡ 可调面（20）');
    // 两态差集必须恰为 {log_export}（开关只影响这一件）
    const offNames = EXPECTED_EXPOSED_DEFAULT;
    assert.deepEqual(listed.filter((n) => !offNames.includes(n)), ['log_export'], '两态差集必须恰为 log_export');
  } finally { on.dispose(); }
});

test('G1b 性质式：∀ name ∈ tools/list ⇒ 调用**不得**返回 unknown tool（允许参数错/业务失败 isError）', async () => {
  const bed = await makeBed({ capabilities: { logs: { enabled: true } } }); // 20 件全开态下测性质
  try {
    const listed = (await rpc(bed.handler, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).json.result.tools.map((t) => t.name);
    assert.ok(listed.length > 0, '前置：tools/list 非空');
    const unreadable = [];
    for (const name of listed) {
      // 故意缺参：允许 参数错 / 业务失败（isError），**不允许** unknown tool
      const r = await rpc(bed.handler, callFrame(name, {}, 10));
      const text = r.json?.error ? JSON.stringify(r.json.error) : JSON.stringify(r.json?.result ?? null);
      if (/unknown tool/i.test(text)) unreadable.push(name + ' → ' + text);
    }
    assert.deepEqual(unreadable, [], '被 tools/list 宣告却调不通（unknown tool）的名字集合必须为空 —— 「宣告即可达」');
  } finally { bed.dispose(); }
});

// ══ G2 薄包装机核（源码两面 grep：import = 0、判据/策略码 = 0；唯一派发点）══════════════════
test('G2 薄包装机核：state/(store|gates) import = 0；判据/策略码 = 0；.execute( 恰 1 处且为 ctx.tools.execute(', () => {
  const files = fs.readdirSync(path.join(PKG, 'lib/mcp')).filter((f) => f.endsWith('.js')).map((f) => path.join(PKG, 'lib/mcp', f));
  assert.ok(files.length >= 1, '前置：lib/mcp 下至少一个 .js');
  const srcAll = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  const stateImports = [...srcAll.matchAll(/from\s+['"][^'"]*state\/(store|gates)(\.[cm]?js)?['"]/g)].map((m) => m[0]);
  assert.deepEqual(stateImports, [], 'lib/mcp/** 不得 import state/store 或 state/gates（薄包装不看状态机）');

  const policy = ['gateDecision', 'judge', 'matchToolBan', 'assertModeActive', 'canSettle', 'SUITE_DENY_TOOLS', 'MODE_GATED_TOOLS'];
  const hits = policy.filter((token) => new RegExp('\\b' + token + '\\b').test(srcAll));
  assert.deepEqual(hits, [], 'lib/mcp/** 不得出现判据/策略码（本层不做决策，只转发）');

  // 【G5 收口 · 适配面下沉后的判据订正】派发从「直调 ctx.tools.execute」下沉到**端口层**
  //   `lib/host-ports/`（用户裁定的设计纲：宿主差异全部关在适配层内）⇒ 唯一派发点的**形态**变了，
  //   但「只有一处派发、且走可核的端口方法」这条**判据不变**。禁令也同步收紧：本层**不得直触** `ctx.tools.*`。
  // 【TR3 ③ 已出清】原第三条正则 `/ctx\.tools\./ = false` 已删 —— 其保护面（lib/ 内除端口层与 bus 外
  //   不得直触宿主面）现由 `test/host-ports.test.js:110-123` 的 H4 反向约束承担：**读文件扫描、含注释/日志、
  //   豁免 lib/host-ports/ 与 lib/bus/**，扫描面比本条只扫 lib/mcp 更宽**。
  //   替代有效性的证明（实测）：向副本包的 `lib/api.js` 注入 `ctx.tools.execute` ⇒ H4 变红，
  //   断言原文 `宿主面必须**只在端口层**被触达（适配面单点）；越界点=["lib/api.js:400 → ctx.tools."]`。
  // 【①② 保留（无替代保护面）】下面两条正则**不得删**：`.execute(`=0 与「唯一派发点恰 1 处」在其余测试中
  //   **没有同口径的替代扫描** ⇒ 删了就是不可逆的判据净损失（K-2）。
  const executes = [...srcAll.matchAll(/\.execute\(/g)];
  assert.equal(executes.length, 0, 'lib/mcp/** 内不得再直调 .execute(（派发已下沉到端口层）');
  assert.equal((srcAll.match(/createToolsPort\(ctx\)\.invokeTool\(/g) ?? []).length, 1,
    '唯一派发点必须是 `createToolsPort(ctx).invokeTool(`（恰 1 处 ⇒ 单点、可核、走宿主链路 + guard）');
  const directObjExec = [...srcAll.matchAll(/\b(tool|definition|def|t)\.execute\(/g)].map((m) => m[0]);
  assert.deepEqual(directObjExec, [], '禁止直调工具对象 .execute(（会绕过守卫）');
  assert.equal((srcAll.match(/listen\(/g) ?? []).length, 0, '不得 listen(（不新起端口）');
  assert.equal((srcAll.match(/createServer\(/g) ?? []).length, 0, '不得 createServer(（复用 webServer）');
  assert.equal(/ctx\.webServer\./.test(srcAll), false, 'lib/mcp/** 不得直触 `ctx.webServer.`（同上，经 createHttpPort）');
  assert.ok((srcAll.match(/remoteAddress/g) ?? []).length >= 1, '必须有 remoteAddress 判定（loopback 校验）');
});

// ══ G3 不绕过守卫（最重）：缺 L1 ⇒ 拒 且**工具体未跑**；`session` 不能冒充 run 身份 ══════════
test('G3 缺 L1 ⇒ 拒（isError + source-run-id-missing: + 工具体未执行）', async () => {
  const bed = await makeBed();
  try {
    const before = bed.executed.get('batch_phase') ?? 0;
    const r = await rpc(bed.handler, callFrame('batch_phase', { batchId: 'b-mcp-t1', phase: 'running', session: 'sess-mcp-t1' }));
    assert.equal(r.json.error, undefined, '工具**业务/守卫拒**不得走 error 帧（P-5 分层）');
    assert.equal(r.json.result.isError, true, '缺 L1 ⇒ isError:true');
    const text = r.json.result.content[0].text;
    assert.ok(text.includes('source-run-id-missing:'), 'text 必须含 source-run-id-missing:；实际=' + text);
    assert.equal(bed.executed.get('batch_phase') ?? 0, before, '工具体**不得执行**（计数器不变）');
  } finally { bed.dispose(); }
});

test('G3b 【硬契约】**只塞 arguments.session 冒充**、不带 sourceRunId ⇒ 仍须拒（session ≠ run 身份）', async () => {
  const bed = await makeBed();
  try {
    const before = bed.executed.get('batch_phase') ?? 0;
    const r = await rpc(bed.handler, callFrame('batch_phase', { batchId: 'b-mcp-t1', phase: 'running', session: 'sess-impersonate' }));
    assert.equal(r.json.result.isError, true, '仅 arguments.session 不得被当作 L1/L2 证据 ⇒ 必须拒');
    const text = r.json.result.content[0].text;
    assert.ok(text.includes('source-run-id-missing: batch_phase'), '拒因须指名；实际=' + text);
    assert.equal(bed.executed.get('batch_phase') ?? 0, before, '工具体不得执行');
    // 反向对照：同一请求**加上** L1 ⇒ 才允许
    const ok = await rpc(bed.handler, callFrame('batch_phase', { batchId: 'b-mcp-t1', phase: 'running', session: 'sess-impersonate', sourceRunId: 'run-x' }, 2));
    assert.notEqual(ok.json.result?.isError, true, '带 L1 ⇒ 不得 isError（证明上一条不是恒拒）');
  } finally { bed.dispose(); }
});

// ══ G4 带 L1 ⇒ 能成（阳性对照；隔离批次上真执行）════════════════════════════════════════════
test('G4 带 L1 ⇒ 正常执行（阳性对照；写操作只落在临时批）', async () => {
  const bed = await makeBed();
  try {
    const before = bed.executed.get('batch_phase') ?? 0;
    const r = await rpc(bed.handler, callFrame('batch_phase', { batchId: 'b-mcp-t1', phase: 'running', sourceRunId: 'run-x' }));
    assert.equal(r.json.error, undefined, '不得是协议错误帧');
    assert.notEqual(r.json.result?.isError, true, '带 L1 ⇒ 不得 isError');
    assert.deepEqual(r.json.result.content[0].type, 'text', 'CallToolResult.content[0].type === text');
    assert.equal(typeof r.json.result.content[0].text, 'string', 'text 必须是 string（MCP CallToolResult 形状）');
    assert.equal(bed.executed.get('batch_phase') ?? 0, before + 1, '工具体必须真被执行（1 次）');
    // 隔离自证：写只落在临时批
    assert.equal(bed.store.readBatch('sess-mcp-t1', 'b-mcp-t1').phase, 'planning', '桩定义不写批（写操作只在真宿主运行时才会改批；本用例证明隔离面）');
  } finally { bed.dispose(); }
});

// ══ G5 协议错误分层（P-5）：工具错 = result+isError；协议错 = error 帧 ═════════════════════════
test('G5 协议分层：未知方法 -32601 / 畸形帧 -32600 / 解析错 -32700 / 未暴露工具 -32601 / 业务错=result+isError', async () => {
  const bed = await makeBed();
  try {
    const unknownMethod = await rpc(bed.handler, { jsonrpc: '2.0', id: 3, method: 'resources/list' });
    assert.equal(unknownMethod.json.error?.code, -32601, '未知方法 ⇒ -32601；实际=' + JSON.stringify(unknownMethod.json));

    const malformed = await rpc(bed.handler, { id: 4, method: 'tools/list' }); // 缺 jsonrpc
    assert.equal(malformed.json.error?.code, -32600, '畸形帧 ⇒ -32600；实际=' + JSON.stringify(malformed.json));

    const badJson = await rpc(bed.handler, '{not json');
    assert.equal(badJson.json.error?.code, -32700, '无法解析 ⇒ -32700；实际=' + JSON.stringify(badJson.json));

    const unexposed = await rpc(bed.handler, callFrame('lane_dispatch', { batchId: 'b-mcp-t1', lane: 'e1' }, 5));
    assert.equal(unexposed.json.error?.code, -32601, '未暴露工具 ⇒ -32601（不落工具层）；实际=' + JSON.stringify(unexposed.json));
    assert.equal(bed.executed.get('lane_dispatch') ?? 0, 0, '未暴露工具**不得**被执行');

    // 业务错：选 **`batch_phase` + 不存在的批** —— 理由（换掉原先的 log_export）：
    //   ① `batch_phase` **恒在缺省可调面内**（不受 `logs` 开关影响，稳定性最好）；
    //   ② 它的真实业务语义就是「批必须存在」⇒ 传 `batchId:'no-such-batch'` 必业务失败（此处桩按同一语义抛错）；
    //   ③ 断言目标仍是 MCP 层的 **P-5 分层**：业务失败 ⇒ `result.isError`（模型可读并可自恢复），**不是** error 帧。
    const biz = await rpc(bed.handler, callFrame('batch_phase', { batchId: 'no-such-batch', phase: 'running', sourceRunId: 'run-x' }, 6));
    if (biz.json.error === undefined) {
      assert.equal(biz.json.result.isError, true, '业务错 ⇒ result.isError:true');
      assert.equal(typeof biz.json.result.content[0].text, 'string', '业务错必须带上可读 text（模型可自恢复）');
    } else {
      assert.fail('业务错被包成 error 帧（违反 P-5 分层）：' + JSON.stringify(biz.json.error));
    }
  } finally { bed.dispose(); }
});

// ══ G6 loopback 白名单（三值放行 / 非 loopback 拒）══════════════════════════════════════════
test('G6 loopback：127.0.0.1 / ::1 / ::ffff:127.0.0.1 三值放行；非 loopback ⇒ -32600；GET ⇒ -32600', async () => {
  const bed = await makeBed();
  try {
    assert.deepEqual([...LOOPBACK_ADDRESSES].sort(), ['127.0.0.1', '::1', '::ffff:127.0.0.1'], '白名单三值');
    for (const addr of LOOPBACK_ADDRESSES) {
      const r = await rpc(bed.handler, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, { remoteAddress: addr });
      assert.equal(r.json.error, undefined, addr + ' 必须放行（loopback 白名单内）');
    }
    const remote = await rpc(bed.handler, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, { remoteAddress: '10.0.0.7' });
    assert.equal(remote.json.error?.code, -32600, '非 loopback ⇒ -32600；实际=' + JSON.stringify(remote.json));

    const got = await rpc(bed.handler, '', { method: 'GET' });
    assert.equal(got.json.error?.code, -32600, 'GET ⇒ -32600（只开 POST）；实际=' + JSON.stringify(got.json));
  } finally { bed.dispose(); }
});

// ══ G7 协议面（initialize / notifications）═════════════════════════════════════════════════
test('G7 initialize 回钉死协议版本；notifications/initialized 通知不回包（202）', async () => {
  const bed = await makeBed();
  try {
    const init = await rpc(bed.handler, { jsonrpc: '2.0', id: 9, method: 'initialize', params: {} });
    assert.equal(init.json.result.protocolVersion, MCP_PROTOCOL_VERSION, 'initialize 必须回 ' + MCP_PROTOCOL_VERSION);
    assert.equal(init.json.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.json.result.capabilities.tools.listChanged, false);

    const notif = await rpc(bed.handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notif.statusCode, 202, '通知不回包 ⇒ 202');
    assert.equal(notif.ended, true);
    assert.equal(MCP_PATH, '/mcp', '挂载路径钉死 /mcp');
  } finally { bed.dispose(); }
});

// ══ G8 每条判据的可红构造（变异 handler，同一驱动面）══════════════════════════════════════════
const mutantHandlerOf = (kind) => async (req, res) => {
  // 复用真实现的「输入 → 输出」形状，只在**目标判据面**注入变异
  const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
  const frame = body ? JSON.parse(body) : {};
  const id = frame.id ?? null;
  const reply = (obj) => { res.statusCode = 200; res.end(JSON.stringify(obj)); };
  if (kind === 'no-loopback-check') {
    // 变异 A：不做 loopback 校验（任何来源都放行）
    return reply({ jsonrpc: '2.0', id, result: { tools: [] } });
  }
  if (kind === 'expose-all') {
    // 变异 B：暴露全部 suite 工具（含 lane_dispatch/subagent/swarm_report）
    return reply({ jsonrpc: '2.0', id, result: { tools: SUITE_TOOLS.map((t) => ({ name: t.name, description: '', inputSchema: { type: 'object' } })) } });
  }
  if (kind === 'session-as-l1') {
    // 变异 C：把 arguments.session 当 L1 证据（冒充 run 身份）
    const args = frame.params?.arguments ?? {};
    const allowed = typeof args.sourceRunId === 'string' || typeof args.session === 'string';
    return reply({ jsonrpc: '2.0', id, result: allowed ? { content: [{ type: 'text', text: 'ok' }], isError: false } : { content: [{ type: 'text', text: 'Error: source-run-id-missing: x' }], isError: true } });
  }
  // 变异 D：业务错包成 error 帧（违反 P-5）
  return reply({ jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error: business failure' } });
};
async function expectRed(fn) { try { await fn(); return false; } catch { return true; } }

test('G8 可红形态：4 个变异（不校 loopback / 暴露全量 / session 冒充 L1 / 业务错包 error 帧）各让对应判据变红', async () => {
  const redLoop = await expectRed(async () => {
    const h = mutantHandlerOf('no-loopback-check');
    const r = await rpc(h, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { remoteAddress: '10.0.0.7' });
    assert.equal(r.json.error?.code, -32600, '非 loopback 必须 -32600');
  });
  assert.equal(redLoop, true, '变异 A ⇒ G6 变红');

  const redExpose = await expectRed(async () => {
    const h = mutantHandlerOf('expose-all');
    const r = await rpc(h, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    for (const n of MUST_NOT_EXPOSE) assert.equal(r.json.result.tools.map((t) => t.name).includes(n), false, n + ' 不得暴露');
  });
  assert.equal(redExpose, true, '变异 B ⇒ G1 变红');

  // G1b 性质断言的**可红证明**：把「宣告了但调不通」的名字塞进 tools/list ⇒ 性质断言必红。
  //   这正是「集合相等」抓不到而性质式抓得到的形态（两个集合都错时仍相等）。
  const redProperty = await expectRed(async () => {
    const bed = await makeBed({ capabilities: { logs: { enabled: true } } });
    try {
      const listed = (await rpc(bed.handler, { jsonrpc: '2.0', id: 21, method: 'tools/list' })).json.result.tools.map((t) => t.name);
      const withGhost = [...listed, 'ghost_uncallable']; // 注入：宣告一个注册面里不存在的名字
      const unreadable = [];
      for (const name of withGhost) {
        const r = await rpc(bed.handler, callFrame(name, {}, 22));
        const text = JSON.stringify(r.json?.error ?? r.json?.result ?? null);
        if (/unknown tool/i.test(text)) unreadable.push(name);
      }
      assert.deepEqual(unreadable, [], '宣告即可达：不得出现 unknown tool（实际未可达：' + JSON.stringify(unreadable) + '）');
    } finally { bed.dispose(); }
  });
  assert.equal(redProperty, true, '性质式断言对「宣告但调不通」必须变红');

  const redSession = await expectRed(async () => {
    const h = mutantHandlerOf('session-as-l1');
    const r = await rpc(h, callFrame('batch_phase', { batchId: 'b', phase: 'running', session: 'sess-impersonate' }, 3));
    assert.equal(r.json.result.isError, true, '仅 session 必须拒（不得冒充 L1）');
  });
  assert.equal(redSession, true, '变异 C ⇒ G3b 变红');

  const redBiz = await expectRed(async () => {
    const h = mutantHandlerOf('business-error-frame');
    const r = await rpc(h, callFrame('batch_phase', { batchId: 'b', phase: 'running', sourceRunId: 'run-x' }, 4));
    assert.equal(r.json.error, undefined, '业务错不得走 error 帧');
  });
  assert.equal(redBiz, true, '变异 D ⇒ G5 业务错分层变红');
});

// ══ G9 【本批核心回归锁】signal 缺陷不复发 ═══════════════════════════════════════════════════
//   背景（实测）：改前 `installMcpDataPlane` 派发时不带 `signal` ⇒ 宿主 `AbortSignal.any` 抛原生
//   `TypeError / code=ERR_INVALID_ARG_TYPE / signals[0] is not of type AbortSignal.`；
//   该 TypeError 又被 P-5 分层包成 `result.isError` ⇒ **看着像"工具报错"，其实全是接线缺陷**。
//   ⇒ 本用例钉「这条错误路径不再出现」，并**自带变异**证明它有杀伤力（防回归锁退化成装饰）。
//   ⚠ 三种复发形态都要认（**这是变异测试逼出来的**：首版只认 ERR_INVALID_ARG_TYPE，
//     而本运行时的实际复发形态是 `Cannot read properties of undefined (reading 'aborted')`
//     —— 与 G5 冒烟批在真实例上实测到的那一条**逐字相同**）。
const SIGNAL_ERR_PATTERNS = [
  /ERR_INVALID_ARG_TYPE/,
  /signals\[0\] is not of type AbortSignal/i,
  /Cannot read properties of undefined \(reading 'aborted'\)/, // ← 本仓实测复发签名
];

/** 断言响应文本**不含**宿主原生 signal 类型错（正向用例与变异用例共用同一判据）。 */
function assertNoSignalTypeError(text, where) {
  for (const re of SIGNAL_ERR_PATTERNS) {
    assert.equal(re.test(text), false,
      where + '：响应不得含 ' + re + '（signal 缺陷复发）；实际=' + String(text).slice(0, 220));
  }
}

test('G9 【核心回归锁】真 tools/call 响应不含 ERR_INVALID_ARG_TYPE / signals[0] is not of type AbortSignal', async () => {
  const bed = await makeBed();
  try {
    const r = await rpc(bed.handler, callFrame('batch_status', { batchId: 'b-mcp-t1', sourceRunId: 'run-x' }, 31));
    const text = JSON.stringify(r.json ?? null);
    assertNoSignalTypeError(text, '正向：带合法 signal 的 tools/call');
    assert.equal(bed.executed.get('batch_status') ?? 0, 1,
      '工具体必须真被执行（否则"没报错"也可能只是根本没跑到）');
  } finally { bed.dispose(); }
});

test('G9b 变异必红：替身在 execute 侧**吞掉 signal**（模拟改前接线）⇒ 同一断言必红', async () => {
  const bed = await makeBed();
  try {
    // 变异点必须在 execute 侧：端口层已校调用方传的 signal，所以复发形态是「signal 没送到宿主」
    const realExecute = bed.ctx.tools.execute.bind(bed.ctx.tools);
    bed.ctx.tools.execute = async (exec) => realExecute({ ...exec, signal: undefined });
    const r = await rpc(bed.handler, callFrame('batch_status', { batchId: 'b-mcp-t1', sourceRunId: 'run-x' }, 32));
    const text = JSON.stringify(r.json ?? null);
    let red = false;
    try { assertNoSignalTypeError(text, '变异：signal 被吞'); } catch { red = true; }
    assert.equal(red, true, 'signal 被吞时该断言**必须红**（否则回归锁形同虚设）；实际响应=' + text.slice(0, 240));
  } finally { bed.dispose(); }
});
