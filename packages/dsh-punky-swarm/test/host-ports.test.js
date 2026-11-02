/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/host-ports.test.js —— 宿主端口层（`lib/host-ports/index.js`）：**适配面契约** + **反向约束**。
//
// 判据源：`plan/p1-pack.md`（端口面形状裁定）＋ `e1-contract` 的 C-5 探针实测。
// 边界：module-level（本仓无加载对象）⇒ 只断端口层的**模块内行为**，不含宿主级可用声称。
//
// ★ 两处**判据订正**（均已与 Lead 对齐，写进断言而不是放宽）：
//   ① `mountRoute` 缺 webServer ⇒ **不抛**，返回 `{mounted:false}` 且**未注册**
//      ——「静默成功」的反面是「**可判定的降级**」，不是「必须抛」（先例 `data-plane-server.js:218-226`）；
//   ② `invokeTool` 的 signal 校验校的是 **`aborted` 属性**，不是 `instanceof AbortSignal`
//      ⇒ 手写 `{aborted:false}` 这种 signal-like **必须放行**（否则会把合法适配挡在门外）。
//
// 跑法（必须带 preload）：
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/host-ports.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createToolsPort, createHttpPort, HOST_PORT_INVALID,
} from '../lib/provider-dsh/tools-http.js';
import { createAgentPort, HOST_PORT_UNSUPPORTED } from '../lib/provider-dsh/agent.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 计数型 ctx：记录 register / execute 调用，便于证明「真调了 / 真没调」。 */
function ctxOf(overrides = {}) {
  const registered = [];
  const executed = [];
  const tools = {
    get: (name) => (name === 'known' ? { name: 'known' } : null),
    register: (def) => { registered.push(def); },
    guard: () => {},
    execute: async (exec) => { executed.push(exec); return { ok: true, name: exec.name, hadSignal: typeof exec?.signal?.aborted === 'boolean' }; },
  };
  return {
    registered,
    executed,
    ctx: {
      tools: overrides.tools ?? tools,
      ...(overrides.webServer === undefined
        ? {}
        : { webServer: overrides.webServer }),
    },
  };
}

/**
 * 【P0-3 门禁解冻 · 批 `punky-adapter-p0-20261031`】派发入口**单点解析**。
 *
 * 拆分动作 S-1 会把端口方法 `spawn` 改名 `execute`（`plan/contract-shape.md` §3）。原用例直接写
 * `port.spawn(...)`（6 处）⇒ 改名即全红，但那红是**方法名**红，不是**行为**红。
 * 这里不冻结方法名，同时守住两条真实回归：**恰有 1 个入口**（禁两个并存 / 禁一个都没有）。
 * 语义没有放松：入口存在性、拒态、载荷形状仍由各用例逐条断言。
 */
function dispatchEntryOf(port) {
  // 【ly-impl · 批 `punky-arch-refine-20261101`】契约动词改名 `execute` → `push_execute`。
  //
  // 判据**语义升级**（不是放宽）：原判据「派发入口恰有 1 个（execute|spawn）」的前提是
  //   **两个对等动词并存**（旧 `execute` 是空契约、`spawn` 是实跑动词）⇒ 该判据在改名后**失效**：
  //   `push_execute`（契约唯一派发动词）与 `spawn`（**C 通道内部原子步骤**，不再是对等入口）**同时在场**。
  // ⇒ 新判据由两条组成，比原来更严：
  //   ① **契约动词必须在场**：`push_execute` 是函数；
  //   ② **旧动词必须绝迹**：`execute` **不得**以别名形式残留（留别名 = 语义混淆未消除）。
  assert.equal(typeof port?.push_execute, 'function', '契约派发动词 `push_execute` 必须存在');
  assert.equal(typeof port?.execute, 'undefined', '旧动词 `execute` **不得**以别名残留（一次改净）');
  const fn = port.push_execute.bind(port);
  // 兼容 shim：本文件既有用例按**旧 spawn 形状**传参；`push_execute` 的新签名是 `(spec, options)`。
  //   ⇒ 把旧形状包成 `(spec, options)`：`spec` 取最小合法 `ExecSpec`（无绑定会话 ⇒ 走 C 通道），
  //   `options` 原样透传（`toolFace`/`persona`/`maxDepth` 等 C 通道入参）。**断言意图一字未改**。
  return (args = {}) => fn(
    {
      runId: 'host-ports-probe',
      targetId: args.label ?? 'probe-lane',
      member: { id: args.label ?? 'probe-lane' },
      session: { id: null, params: null },
      taskPkg: { id: args.label ?? 'probe-lane' },
      contract: { id: 'host-ports-probe', sha256: null },
    },
    args,
  );
}

// ── H1 invokeTool：缺 signal ⇒ 抛 host-port-invalid:（贴原文）＋ 放行对照 ────────────────
test('H1 invokeTool 缺 signal ⇒ 抛 host-port-invalid:（普通 Error，code undefined，非 GATE_）', async () => {
  const h = ctxOf();
  const port = createToolsPort(h.ctx);
  let thrown = null;
  try { await port.invokeTool({ name: 'known', args: {} }); } catch (e) { thrown = e; }
  assert.ok(thrown, '缺 signal ⇒ **必须拒**（宿主真身会抛原生 TypeError，端口层要给出自己的可读码）');
  assert.equal(String(thrown.message).startsWith(HOST_PORT_INVALID), true,
    '拒因前缀必须为 ' + HOST_PORT_INVALID + '；实际=' + thrown.message);
  assert.equal(String(thrown.message).includes('invokeTool 需要 AbortSignal'), true, '文案须点名缺什么；实际=' + thrown.message);
  assert.equal(thrown.code, undefined, '必须是**普通 Error**（不得自带 GATE_ 码族）');
  assert.equal(h.executed.length, 0, '被拒时**不得触达宿主 execute**（拒在调用之前）');

  // 放行对照（同构造，只补 signal）⇒ 真的调了宿主且宿主拿到了合规 signal
  const signal = new AbortController().signal;
  const out = await port.invokeTool({ name: 'known', args: { x: 1 }, signal });
  assert.deepEqual(out, { ok: true, name: 'known', hadSignal: true }, '带合法 signal ⇒ 放行并透传宿主返回值');
  assert.equal(h.executed.length, 1, '放行路径必须**真调**宿主 execute');
  assert.equal(h.executed[0].signal, signal, '宿主收到的就是调用方给的 signal（不被替换）');
});

// ── H2 反例：校的是 `aborted` 属性，不是 instanceof ─────────────────────────────────
test('H2 非 AbortSignal（{} / null / 数字）⇒ 拒；而 **signal-like `{aborted:false}` ⇒ 放行**（证明校属性不校原型）', async () => {
  const h = ctxOf();
  const port = createToolsPort(h.ctx);
  for (const bad of [{}, null, 42, 'sig', { aborted: 'yes' }]) {
    let thrown = null;
    try { await port.invokeTool({ name: 'known', signal: bad }); } catch (e) { thrown = e; }
    assert.ok(thrown, JSON.stringify(bad) + ' 非法 ⇒ 必须拒');
    assert.match(String(thrown.message), new RegExp(HOST_PORT_INVALID), JSON.stringify(bad) + ' 拒因前缀须为 ' + HOST_PORT_INVALID);
  }
  // ★ 关键对照：手写 signal-like（非 AbortSignal 实例）必须**放行** —— 否则适配层会挡住合法宿主替身
  const signalLike = { aborted: false };
  const out = await port.invokeTool({ name: 'known', signal: signalLike });
  assert.equal(out.ok, true, '**signal-like 必须放行**（证：校验看 `aborted` 属性，不看 instanceof）');
  assert.equal(h.executed.at(-1).signal, signalLike, '原样透传 signal-like');
});

// ── H3 getTool / hasTool：未注册 ⇒ null / false（不抛） ────────────────────────────
test('H3 getTool 未注册 ⇒ null；hasTool 同形；工具面缺失 ⇒ 两者皆降级不抛', () => {
  const h = ctxOf();
  const port = createToolsPort(h.ctx);
  assert.equal(port.getTool('known')?.name, 'known', '已注册 ⇒ 返回定义');
  assert.equal(port.getTool('nope'), null, '未注册 ⇒ **null**（C-3 约定，不抛）');
  assert.equal(port.hasTool('known'), true);
  assert.equal(port.hasTool('nope'), false);
  // 对照：ctx 无 tools ⇒ available:false，各方法降级
  const bare = createToolsPort({});
  assert.equal(bare.available, false, '无 ctx.tools ⇒ available:false');
  assert.equal(bare.getTool('known'), null, '不可用时 getTool ⇒ null（不抛）');
  assert.equal(bare.hasTool('known'), false);
});

// ── H4 ★ 反向约束：lib/ 内除适配层（host-ports，未来 provider-dsh）外，`ctx.tools.` / `ctx.webServer.` = 0 ──
test('H4 反向约束（含注释/日志，读文件扫描）：lib/ 内除适配层与 provider 承载体外不得直触 ctx.tools./ctx.webServer.', () => {
  const violations = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (!ent.name.endsWith('.js')) continue;
      const rel = path.relative(PKG, abs).split(path.sep).join('/');
      // 豁免面：适配层本体 + 其 provider 承载体（唯一允许读 ctx.tools/ctx.webServer 的地方）。
      // 【P0-3 解冻】原只 skip `lib/host-ports/`；拆分后该目录整体迁入 `lib/provider-dsh/`
      //   （contract-shape §8.2）⇒ 豁免面必须**同时**覆盖两者，否则迁移即红。
      //   ⚠ 不扩大豁免语义：两者都是「宿主触达面」，本断言的目标面（引擎/业务层）一字未减。
      if (rel.startsWith('lib/host-ports/') || rel.startsWith('lib/provider-dsh/')) continue;
      const src = fs.readFileSync(abs, 'utf8'); // 全文含注释 —— 这是「反向约束」比 grep 代码行更严的地方
      for (const m of src.matchAll(/ctx\.(tools|webServer)\./g)) {
        const line = src.slice(0, m.index).split('\n').length;
        violations.push(rel + ':' + line + ' → ' + m[0]);
      }
    }
  };
  walk(path.join(PKG, 'lib'));
  assert.deepEqual(violations, [],
    '宿主面必须**只在端口层**被触达（适配面单点）；越界点=' + JSON.stringify(violations.slice(0, 12)));
});

// ── H5 mountRoute 缺 webServer ⇒ {mounted:false} 且未注册（判据订正）──────────────
test('H5 mountRoute 缺 webServer ⇒ 返回 {mounted:false} 且**未注册**（可判定降级，不抛）', () => {
  const h = ctxOf(); // 无 webServer
  const port = createHttpPort(h.ctx);
  assert.equal(port.available, false, '缺 ctx.webServer ⇒ available:false');
  let out = null;
  assert.doesNotThrow(() => { out = port.mountRoute({ method: 'POST', path: '/x', handler: () => {} }); },
    '缺 webServer **不得抛**（C-5 探针契约；先例 data-plane-server.js:218-226）');
  assert.equal(out.mounted, false, '**结果必须可判定**：mounted:false');
  assert.equal(typeof out.dispose, 'function', 'dispose 仍须是函数（调用方不必分支）');
  // 放行对照：给了 webServer ⇒ mounted:true 且真的注册
  const registeredRoutes = [];
  const h2 = ctxOf({ webServer: { register: (route) => { registeredRoutes.push(route); return () => {}; } } });
  const port2 = createHttpPort(h2.ctx);
  const out2 = port2.mountRoute({ method: 'POST', path: '/mcp', handler: () => {} });
  assert.equal(out2.mounted, true, '有 webServer ⇒ mounted:true（与上面的 false 成对）');
  assert.equal(registeredRoutes.length, 1, '有 webServer ⇒ 必须真的注册一次');
  assert.equal(registeredRoutes[0].path, '/mcp', '注册的路线与入参一致');
});

// ══ T-1…T-5 智能体端口（取件自 `e3-agentport.md` §「供 t1-test 取用的 5 条建议用例」）══════════
//   ⚠ T-4 是本批**最关键**的一条：它钉「按次收窄通道（`request.toolFilter`）确有收窄面、
//     而 activation 通道只能经 preset 承载」这个**实测事实** —— 将来谁再改能力位判定，这条会立刻红。
//   【P0-3 门禁解冻】本块已按「断言**功能面读数**、不冻结宿主形态值」重写：
//     · `port.form` / `out.form`（宿主形态值）→ 换 `available` / `canNarrow` / `capsKnown` / 通道取值域；
//     · `port.toolFaceVia`（别名）→ 删除（contract-shape §5.2 #7：别名并入 `narrowVia`）；
//     · `port.spawn(...)`（方法名）→ `dispatchEntryOf(port)` 单点解析（改名 `execute` 不触红）。

test('T-1 无宿主面：createAgentPort(null) ⇒ available:false、通道读数 none、派发入口抛 host-port-unsupported:', async () => {
  const port = createAgentPort(null);
  assert.equal(port.available, false, '无 ctx.subagents ⇒ available:false');
  // 【P0-3 解冻】原 `port.form === null` 是宿主形态值断言（J6-e / AC-5″ 清除对象）。
  //   功能面等价：**有收窄需求时**能力位必须为 false（无宿主面不可能收窄）。
  //   该读数跨改造稳定：现状 available=false ⇒ false；真读数（无见证）⇒ 仍 false。
  assert.equal(port.canNarrow({ toolFace: { deny: ['x'] } }), false, '无宿主面 + 有收窄需求 ⇒ canNarrow 必须 false');
  assert.equal(port.narrowVia, 'none', 'narrowVia ⇒ none');
  assert.equal(port.depthVia, 'none', 'depthVia ⇒ none');
  await assert.rejects(() => dispatchEntryOf(port)({ provider: 'p', label: 'l', prompt: 'x' }),
    (e) => {
      assert.equal(String(e.message).startsWith(HOST_PORT_UNSUPPORTED), true, '拒因前缀=' + e.message);
      return true;
    }, '无宿主面时派发入口必须拒（禁静默成功）');
});

test('T-2 activation + preset：功能面读数（available / canNarrow({}) / 通道取值域）＋ 派发回显 preset', async () => {
  const rt = { startActivation: async () => ({ id: 'w1' }) };
  const port = createAgentPort({ subagents: rt }, { presetFor: () => 'punkynarrow' });
  assert.equal(port.available, true, '有 activation 入口 ⇒ 功能面可用');
  // 【P0-3 解冻 · ①】原 `port.form === 'activation'` = 宿主形态值（AC-5″ 清除对象）⇒ 换能力位读数。
  //   `canNarrow({})` 的稳定性有据：p0-6 D-1 的 need=false 短路规定「无收窄需求 ⇒ true」，
  //   故改造前后**都是 true** ⇒ 本断言跨改造有效。
  assert.equal(port.canNarrow({}), true, '无收窄需求（ask={}）⇒ canNarrow true（need=false 短路）');
  // 【P0-3 解冻 · ②】原 `port.narrowVia === 'preset'` 是**形态派生值**；p0-6 D-3 把它收紧为
  //   **实测结果**（无见证 ⇒ 'none'）。⇒ 只断言**取值域**；具体值的成对用例见 T-2R（todo 登记）。
  assert.equal(['request', 'preset', 'none'].includes(port.narrowVia), true, '收窄通道取值域合法（request|preset|none）；实际=' + port.narrowVia);
  // 【P0-3 解冻 · ③】原 `port.toolFaceVia === port.narrowVia` 断言的是**别名恒等**；该别名单删
  //   （contract-shape §5.2 #7）⇒ 别名断言删除，改为 peer 通道的取值域校验。
  assert.equal(['request', 'preset', 'none'].includes(port.personaVia), true, '人格通道取值域合法；实际=' + port.personaVia);
  assert.equal(port.depthVia, 'request', '深度仍走 request（无 capabilities.depthLimit:false）');
  const out = await dispatchEntryOf(port)({ provider: 'p', label: 'l', prompt: 'x', parent: {}, role: 'r' });
  assert.equal(out.preset, 'punkynarrow', '返回的 preset 必须回显实际生效的 preset');
  // 【P0-3 解冻 · ④】原 `out.form === 'activation'` ⇒ 改为回显**功能面通道读数**（取值域校验，同 ②）。
  assert.equal(['request', 'preset', 'none'].includes(out.narrowVia), true, '返回值必须回显收窄通道读数；实际=' + out.narrowVia);
});

// ── T-2R（P0-3 前向登记 · **W3 已转绿**）`narrowVia` 必须是**实测结果**，不是形态派生值 ────────────
//   真读数（p0-6 D-3）：`via='preset'` 需 W-2 见证成立；否则 `'none'`。成对形式按 p0-6 处方：
//   「带覆盖见证 ⇒ preset；无见证 ⇒ none」。
//   【W3 落地】端口内新增单点 `witnessOf()`：解析器返回 `{preset, covers}` ⇒ 有见证；返回裸字符串
//   ⇒ `hasWitness:false` ⇒ `narrowVia='none'`（裸 id 不得声称已收窄）。todo 已摘除（registry 同步收紧）。
test('T-2R narrowVia 成对：带覆盖见证 ⇒ preset；无见证 ⇒ none', async () => {
    const rt = { startActivation: async () => ({ id: 'w1' }) };
    const withWitness = createAgentPort({ subagents: rt }, { presetFor: () => ({ preset: 'punkynarrow', covers: [] }) });
    assert.equal(withWitness.narrowVia, 'preset', '见证齐备（preset 覆盖为空集）⇒ 收窄已核实 ⇒ preset；实际=' + withWitness.narrowVia);
    const withoutWitness = createAgentPort({ subagents: rt }, { presetFor: () => 'punkynarrow' });
    assert.equal(withoutWitness.narrowVia, 'none', '裸字符串无见证 ⇒ 不得声称已收窄 ⇒ none；实际=' + withoutWitness.narrowVia);
  });

test('T-3 activation 无 preset ⇒ 抛 host-port-unsupported:（**不以 GATE_ 开头**）', async () => {
  const rt = { startActivation: async () => ({ id: 'w1' }) };
  const port = createAgentPort({ subagents: rt }, { presetFor: () => null });
  await assert.rejects(() => dispatchEntryOf(port)({ provider: 'p', label: 'l', prompt: 'x', parent: {} }),
    (e) => {
      assert.equal(String(e.message).startsWith(HOST_PORT_UNSUPPORTED), true, '前缀须为 ' + HOST_PORT_UNSUPPORTED + '；实际=' + e.message);
      assert.equal(/^GATE_/.test(String(e.message)), false, '端口层拒因**不得**用 GATE_ 码族；实际=' + e.message);
      return true;
    }, 'activation 形态缺 preset ⇒ 必须拒（否则 worker 拿到未收窄工具面）');
});

test('T-4 ★ 按次收窄通道请求形状：req **含** toolFilter/persona/maxDepth 且**不含** agentPreset（通道不串味）', async () => {
  let captured = null;
  const rt = { start: async (_provider, req) => { captured = req; return { id: 'w2' }; } };
  const port = createAgentPort({ subagents: rt }, { presetFor: () => 'should-not-be-used' });
  // 【P0-3 解冻】原 `port.form === 'start'` ⇒ 换 `capsKnown`（能力位是否已知）：本夹具未声明
  //   `capabilities` ⇒ 未知。这是**新增**的功能面覆盖（原断言只标形态），且跨改造稳定。
  assert.equal(port.capsKnown, false, '未声明 capabilities ⇒ 能力位未知（capsKnown:false）');
  // 【P0-3 解冻】原 `port.narrowVia === 'request'` 是形态派生值（p0-6 D-3 收紧为实测）⇒
  //   只断言取值域；本用例的**实质**断言是下面「捕获的 req 确实带 toolFilter」（W-1 见证本身）。
  assert.equal(['request', 'preset', 'none'].includes(port.narrowVia), true, '收窄通道取值域合法；实际=' + port.narrowVia);
  await dispatchEntryOf(port)({
    provider: 'p', label: 'l', prompt: 'x', parent: {},
    toolFace: { deny: ['a'] }, persona: 'P', maxDepth: 2,
  });
  assert.ok(captured, '必须真的调了宿主 start');
  const keys = Object.keys(captured);
  for (const k of ['toolFilter', 'persona', 'maxDepth']) {
    assert.equal(keys.includes(k), true, 'start 形态 req 必须含 ' + k + '；实际键=' + JSON.stringify(keys));
  }
  assert.deepEqual(captured.toolFilter, { deny: ['a'] }, 'toolFilter 原样透传（按次收窄通道的能力位）');
  assert.equal(captured.persona, 'P', 'persona 原样透传（端口不改写人格文本）');
  assert.equal(keys.includes('agentPreset'), false,
    'start 形态 **不得**出现 agentPreset（通道串味：那是 activation 通道的收窄载体）；实际键=' + JSON.stringify(keys));
});

test('T-5 capabilities.depthLimit:false ⇒ depthVia=none 且 req **无** maxDepth（显式降级，非静默）', async () => {
  let captured = null;
  const rt = { start: async (_provider, req) => { captured = req; return { id: 'w3' }; }, capabilities: { depthLimit: false } };
  const port = createAgentPort({ subagents: rt });
  assert.equal(port.depthVia, 'none', '宿主声明不支持深度限制 ⇒ depthVia=none');
  await dispatchEntryOf(port)({ provider: 'p', label: 'l', prompt: 'x', parent: {}, maxDepth: 2 });
  const keys = Object.keys(captured ?? {});
  assert.equal(keys.includes('maxDepth'), false,
    '不支持时**不得**把 maxDepth 塞给宿主（显式降级）；实际键=' + JSON.stringify(keys));
  // 对照：能力位缺省（未知）⇒ 仍按 request 传（宁可用不到，也不要静默丢能力）
  let captured2 = null;
  const rt2 = { start: async (_p, req) => { captured2 = req; return { id: 'w4' }; } };
  const port2 = createAgentPort({ subagents: rt2 });
  assert.equal(port2.depthVia, 'request', '能力位未知 ⇒ depthVia=request');
  await dispatchEntryOf(port2)({ provider: 'p', label: 'l', prompt: 'x', parent: {}, maxDepth: 2 });
  assert.equal(Object.keys(captured2).includes('maxDepth'), true, '未知能力位时仍应传 maxDepth（与上面成对）');
});
