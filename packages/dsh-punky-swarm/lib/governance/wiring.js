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

// governance/wiring.js —— 宿主触点接线（G8，JS，对齐 evidence.js 模式）
// 订阅宿主 tools/pre-execute（HOST:3105 waterfall，deny→Error :3116-3128、ask→serviceAsk :3303-3347）
//   + tools/post-execute（HOST:3367 waterfall；2.2 pass-through 观察者恒 next()，先例 evidence.js:245）。
// 组合：createGovernanceKernel（G6）裁决 → createRefusalReceipt（G6）收据 → writeRefusal（G9）落盘
//   （失败仅 warn 不阻断——观察者纪律，evidence.js:242-244）→ primitiveToPreDecision（G2）决策映射。
// 事件序不变量（§8）：pre→execute→post→result（HINV:68-88）；本 wiring 不调用 ctx.emit 篡改事件流；
//   pre 拒绝短路径（HOST:3117-3128 next({kind:'post-result', result: Error})）→ execute 不执行，
//   但该 post-result 仍经 finalizeScheduledExecution → postExecute（HOST:3008/3232）触发 tools/post-execute
//   waterfall——post 观察者在 ask 降级 deny 路径同样被调用（P1 outcome 补记可行性依据，HOST 复核）。
//   收据已在 pre 同步落盘、不依赖 tools/result 事件。
// 与 ctx.tools.guard（难度门禁）组合（§6.3 / HOST:3116）：kernel 判 ALLOW → next() 透传，难度门禁照常生效
//   （两门禁串行叠加）；kernel 判 deny/ask → 返回决策对象短路，难度门禁不再参与。guard 无 allow 语义
//   （HTYPES:481-488），难度门禁只可能收紧不可能被本 hook 放行绕过。
// P1 硬化（harden-plan §5.2）：
//   A. DEFER/PAUSE 从「标签/指引」升级为文件态简版状态机（state-store.js）——pre 链 kernel.decide 之前做
//      状态前置检查（deferred/paused 未过期 → 直接 deny + gate 收据；惰性过期在 readSessionState 读时自动清理）；
//      DEFER（P5 flag.defer=true）/ PAUSE（P3 flag.pause=true）命中 → 写状态（副作用）+ 收据 deferMeta/pauseMeta；
//      flag-off 折叠 DENY 无状态副作用（S6 区分）；禁 setInterval/禁端点（契约束，N-7 维持）。
//   B. REQUIRE_APPROVAL ask 接线（HOST:3303-3354）——pre 返回 {kind:'ask'} 交宿主 serviceAsk，收据同步落盘
//      ask.initiated（channel/initiated/requestId=callId）；post 观察者尽力补记 ask.outcome（infer 自 result，
//      isError→降级 deny 各分支 / 非错误→allowed-once），写失败仅 warn、不改返回语义（§4.4）。
// P2 硬化（harden-plan §5.3 B）：双层桥接——构造参数 onRefusal?(receipt)（收据落盘成功同步回调，
//   抛错隔离 warn）；装配层注入实现写批级事件流 <root>/governance/events/refusal-<sessionId>.jsonl
//   （仅事件可见性，不触发批级状态迁移——归 M5-a）；dispose 断开回调（幂等）。
import { createGovernanceKernel, createRefusalReceipt, primitiveToPreDecision, resolveGovernanceConfig } from './index.js';
import { writeRefusal, patchRefusalAsk } from './receipt-store.js';
import { readSessionState, setDeferred, setPaused } from './state-store.js';

// 拒绝正文统一格式（蓝图 §6.3）：[governance:<primitive>] <reason>（对齐难度门禁 [task-difficulty-gate] 前缀风格）
// reason 取 kernel 裁决 reason（含违规明细/路径——模型可据此修正参数）。
// NARROW 落地形态（HTYPES:415-416 宿主禁止输入改写——arguments 已记录与展示）：
//   narrowedParams 以 deny + 指引（reason 内参数修正指引）落地，不实际改写调用参数（核查表 N-8）。
// P0 硬化（harden-plan §5.1 A.3）：NARROW 原语恒含基础修正指引（保持原语义，兼容无 narrow 字段的 A1 场景）；
//   决策携带 narrowedParams（NARROW 必填 / DENY 窄域指引）时追加钳制明细（clamped path: from → to，
//   模型可据此重发合规参数）；不实际改写 exec.arguments。
export function formatDecision(d) {
  let reason = `[governance:${d.primitive}] ${d.reason}`;
  if (d.primitive === 'NARROW' || (d.primitive === 'DENY' && d.narrowedParams !== undefined)) {
    reason += '；参数修正指引：宿主禁止输入改写，请按收窄指引修正参数后重新发起调用';
  }
  if (d.narrowedParams !== undefined) {
    const clamped = d.narrowedParams?.clamped;
    if (Array.isArray(clamped) && clamped.length > 0) {
      const detail = clamped
        .map((c) => `${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
        .join('、');
      reason += `；钳制明细：${detail}`;
    }
  }
  return reason;
}

// 引擎级 hook 挂载（index.js apply 内调用；对齐 mountVerify 模式，PK lib/index.js:344-347）：
//   governance.hook.enabled 缺省 true（已敲定 2026-08-31）→ 订阅 pre/post；显式 enabled:false → inert（零运行时路径）；
//   ctx.on 缺失 → inert 静默降级（宿主能力缺失不炸）。
// 返回 { dispose, installed, refusals: { count() } }（蓝图 §2 表 G8）。
// store 参数预留（蓝图签名；2.2 未消费——会话级状态跟随宿主 exec.agent.session）。
// P2 硬化（harden-plan §5.3 B）：构造参数新增可选 onRefusal?(receipt) —— 双层桥接回调
//   （收据落盘成功 → 同步回调；回调抛错隔离 try/catch warn，不阻断 pre 裁决——观察者纪律
//   evidence.js:242-244 同款）。装配层（lib/index.js）注入实现 → 写批级事件流文件
//   <root>/governance/events/refusal-<sessionId>.jsonl（零依赖 node:fs 追加；事件序不变量 §4.4：
//   桥接在 pre 同步路径内调用，不 ctx.emit、不异步脱离事件流）。dispose 时回调断开（幂等）。
export function installGovernanceHook(ctx, { store, root, config, logger, onRefusal, presetTable } = {}) {
  // 配置读取：cordis.patch.yml 顶层 governance.hook 键（蓝图 §7；I2-4 对齐断言）。
  // 缺省/空对象 → GOVERNANCE_DEFAULTS（enabled:true, rules:[], defaults.deny:DENY, flags 全 false）。
  // M5-b（preset-build，C2）：resolve opts 注入 presetTable（boot 装载一次的 preset 表——wiring 内部
  //   resolve 与装配侧快照基准一致）+ warn 封装（logger.warn，非静默——preset 装载失败回退空表时
  //   显式留痕，防「以为武装实则裸奔」假安全）。
  const log = logger ?? ctx?.logger ?? null;
  const cfg = resolveGovernanceConfig(config?.governance?.hook ?? {}, {
    presetTable,
    warn: (m) => log?.warn?.('[governance] ' + m),
  });
  const inert = (reason) => ({ installed: false, reason, refusals: { count: () => 0 }, dispose() {} });
  if (cfg.enabled !== true) return inert('disabled');
  if (!root || typeof ctx?.on !== 'function') return inert('ctx.on unavailable');
  const kernel = createGovernanceKernel(cfg);
  let refusalCount = 0;
  // P2 双层桥接回调（可选；dispose 置空断开——回调随之失效，幂等 B4）
  let refusalCb = typeof onRefusal === 'function' ? onRefusal : null;
  // P1 ask 关联表（hook 实例内存态）：callId → { receiptId, sessionId }——pre 记 initiated 时登记，
  //   post 观察者按 callId 查表尽力补记 outcome；实例级内存态跨 pre/post 调用存活（宿主同 call 连续触发），
  //   进程重启丢失仅影响「补记」（outcome 保持 initiated 态，收据本身已在 pre 落盘——不丢审计）。
  const pendingAsks = new Map();

  // 会话 id 归一（对齐宿主 exec.agent.session；无 agent → 'cli'，与 receipt-store 缺省口径一致）
  const sessionIdOf = (exec) => exec?.agent?.session?.id ?? 'cli';

  // pre-execute 处理链（蓝图 §6.1 模板 + P1 硬化）：
  //   1. 【P1 状态前置检查，kernel.decide 之前】读会话状态（readSessionState 内惰性过期自动清理）：
  //      deferred/paused 未过期 → 直接 deny（reason 含 retry-after/pauseToken + until），写 gate 收据
  //      （decision.primitive=DEFER/PAUSE、ruleRefs=[] 可与触发收据区分），不触碰状态（窗口不延长）；
  //   2. kernel.decide → ALLOW → next() 透传（落到 HOST:3105 兜底 {kind:"allow"}，难度门禁仍生效）；
  //   3. 【P1 状态副作用】DEFER 命中 → setDeferred 写状态 + 收据 deferMeta；PAUSE 命中 → setPaused + pauseMeta
  //      （写失败仅 warn，deny 仍成立——fail-closed 不因状态写失败放行）；flag-off 折叠 DENY 无状态副作用；
  //   4. 非 ALLOW → createRefusalReceipt + writeRefusal（失败仅 warn 不阻断裁决）；
  //   5. REQUIRE_APPROVAL → 收据附 ask.initiated + 登记 pendingAsks → {kind:'ask'}
  //      （→ serviceAsk HOST:3106,3303-3347；无 approval 服务/无 agent → 宿主降级 deny）；
  //   6. DENY/DEFER/NARROW/PAUSE → {kind:'deny'}（2.2 统一 deny + 收据元信息；宿主 materializeFinalResult 为 Error，HOST:3116-3128）。
  const pre = async (exec, next) => {
    const sessionId = sessionIdOf(exec);
    // ── P1 状态前置检查（kernel 之前；gate 收据 ruleRefs=[] 与触发收据区分）──
    // 读失败（IO/权限异常）→ warn + 视为 idle：状态门不可用不阻断调用链（规则层 kernel 仍生效，非 fail-open）
    let st;
    try {
      st = readSessionState(root, sessionId);
    } catch (e) {
      log?.warn?.('[governance] session state read failed (state gate bypassed, kernel still applies): ' + String(e?.message ?? e));
      st = { status: 'idle' };
    }
    if (st.status === 'deferred' || st.status === 'paused') {
      const gatePrimitive = st.status === 'deferred' ? 'DEFER' : 'PAUSE';
      const gateReason = st.status === 'deferred'
        ? `会话处于延后挂起（deferId=${st.deferId}, retryAfterMs=${st.retryAfterMs}, until=${st.until}）：retry-after 窗口内重试被拒（惰性过期自动恢复）`
        : `会话处于暂停（pauseToken=${st.pauseToken}, until=${st.until}）：同会话工具调用被拒（过期自动恢复）`;
      const gateDecision = {
        primitive: gatePrimitive,
        priority: gatePrimitive === 'DEFER' ? 5 : 3,
        reason: gateReason,
        ruleRefs: [],
      };
      const gateReceipt = createRefusalReceipt({
        tool: exec.name,
        callId: exec.callId,
        sessionId,
        decision: gateDecision,
        attemptedParams: exec.arguments,
      });
      if (st.status === 'deferred') {
        gateReceipt.deferMeta = { deferId: st.deferId, retryAfterMs: st.retryAfterMs, until: st.until };
      } else {
        gateReceipt.pauseMeta = { pauseToken: st.pauseToken, until: st.until };
      }
      try {
        writeRefusal(root, gateReceipt);
        refusalCount++;
        // P2 双层桥接：收据落盘成功 → 同步回调（抛错隔离，不阻断裁决）
        try {
          refusalCb?.(gateReceipt);
        } catch (e) {
          log?.warn?.('[governance] refusal bridge callback failed (isolated): ' + String(e?.message ?? e));
        }
      } catch (e) {
        log?.warn?.('[governance] refusal receipt write failed (observer, does not block decision): ' + String(e?.message ?? e));
      }
      return { kind: 'deny', reason: formatDecision(gateDecision) };
    }
    const d = kernel.decide({ name: exec.name, arguments: exec.arguments });
    if (d.primitive === 'ALLOW') return next();
    // ── P1 状态副作用（DEFER/PAUSE 触发；写失败仅 warn——deny 不因状态写失败放行，fail-closed）──
    let deferMeta;
    let pauseMeta;
    if (d.primitive === 'DEFER') {
      try {
        deferMeta = setDeferred(root, sessionId, {});
      } catch (e) {
        log?.warn?.('[governance] DEFER state write failed (deny stands): ' + String(e?.message ?? e));
      }
    } else if (d.primitive === 'PAUSE') {
      try {
        pauseMeta = setPaused(root, sessionId);
      } catch (e) {
        log?.warn?.('[governance] PAUSE state write failed (deny stands): ' + String(e?.message ?? e));
      }
    }
    const receipt = createRefusalReceipt({
      tool: exec.name,
      callId: exec.callId,
      sessionId,
      decision: d,
      attemptedParams: exec.arguments,
    });
    if (deferMeta !== undefined) receipt.deferMeta = deferMeta;
    if (pauseMeta !== undefined) receipt.pauseMeta = pauseMeta;
    if (d.primitive === 'REQUIRE_APPROVAL') {
      // P1 ask 显式化：收据 pre 同步落盘 ask.initiated（channel=宿主 serviceAsk，requestId=callId 宿主审批关联）
      receipt.ask = { channel: 'host-serviceAsk', initiated: receipt.ts, requestId: exec.callId };
    }
    try {
      writeRefusal(root, receipt);
      refusalCount++;
      // P2 双层桥接：收据落盘成功 → 同步回调（抛错隔离，不阻断裁决——观察者纪律）
      try {
        refusalCb?.(receipt);
      } catch (e) {
        log?.warn?.('[governance] refusal bridge callback failed (isolated): ' + String(e?.message ?? e));
      }
      if (receipt.ask !== undefined) {
        pendingAsks.set(exec.callId, { receiptId: receipt.receiptId, sessionId });
      }
    } catch (e) {
      log?.warn?.('[governance] refusal receipt write failed (observer, does not block decision): ' + String(e?.message ?? e));
    }
    const mapped = primitiveToPreDecision(d.primitive); // 'pass' | {kind:'ask'|'deny', reason}（G2 映射；wiring 只消费不自行组合）
    if (mapped === 'pass') return next();
    // reason = 统一前缀正文 + P1 状态元信息（模型侧可区分「会话延后/暂停中」vs「该次越界拒绝」）
    let reason = formatDecision(d);
    if (d.primitive === 'DEFER' && deferMeta !== undefined) {
      reason += `；会话延后挂起：deferId=${deferMeta.deferId}，retryAfterMs=${deferMeta.retryAfterMs}，until=${deferMeta.until}（窗口内重试将被拒，惰性过期自动恢复）`;
    } else if (d.primitive === 'PAUSE' && pauseMeta !== undefined) {
      reason += `；会话已暂停：pauseToken=${pauseMeta.pauseToken}，until=${pauseMeta.until}（暂停期间同会话工具调用被拒，过期自动恢复）`;
    }
    return { kind: mapped.kind, reason };
  };

  // P1 ask outcome 推断（尽力补记；只读 result 不改造语义）：isError=false → 实际执行 → 必为 allowed-once；
  //   isError=true → 降级 deny——按宿主 serviceAsk 拒绝 reason 文本（HOST:3303-3354）分支识别，
  //   文本不可识别（默认=无审批服务降级，reason 保留 ask.reason 即本 wiring reason）→ denied-no-approval。
  const inferAskOutcome = (result) => {
    if (result?.isError !== true) return 'allowed-once';
    const msg = [
      typeof result?.error?.message === 'string' ? result.error.message : '',
      (() => {
        const c = result?.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ');
        return '';
      })(),
    ].join(' ');
    if (/no agent to route it through/.test(msg)) return 'denied-no-agent';
    if (/user rejected/.test(msg)) return 'denied-rejected';
    if (/was cancelled/.test(msg)) return 'denied-cancelled';
    if (/no approval channel is available/.test(msg)) return 'unavailable';
    return 'denied-no-approval'; // 默认：无审批服务降级（宿主保留 ask.reason，无特征文本）
  };

  // post-execute：2.2 pass-through 观察者——恒 next()（先例 evidence.js:232-247）；职责=不篡改结果。
  // 2.3 预留不实现：block/替换 content|value（HTYPES:431-445；HOST:3367-3395 postExecute 应用）仅显式规则开启
  //   （design.md:132）——归 M5，本批不做，代码注释标注留待。
  // P1 增强（仍在 pass-through 语义内）：next() 前尽力补记 ask.outcome（查 pendingAsks → infer → patchRefusalAsk；
  //   任何失败仅 warn，绝不阻断/改变返回语义 §4.4）。
  const post = async (exec, result, next) => {
    try {
      const sessionId = sessionIdOf(exec);
      const pending = pendingAsks.get(exec.callId);
      if (pending !== undefined && pending.sessionId === sessionId) {
        pendingAsks.delete(exec.callId);
        const outcome = inferAskOutcome(result);
        patchRefusalAsk(root, sessionId, pending.receiptId, outcome);
      }
    } catch (e) {
      log?.warn?.('[governance] ask outcome patch failed (observer, does not block result): ' + String(e?.message ?? e));
    }
    return next();
  };

  const disposePre = ctx.on('tools/pre-execute', pre);
  const disposePost = ctx.on('tools/post-execute', post);
  let disposed = false;
  return {
    installed: true,
    refusals: { count: () => refusalCount },
    // 依次卸载 pre + post listener（ctx.on 返回的 disposer 先例 evidence.js:247）；卸载后 listener 不再触发（I1-1 断言）。
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingAsks.clear(); // 实例内存态随卸载清理（幂等）
      refusalCb = null;    // P2：桥接回调断开（dispose 后不再触发，B4）
      if (typeof disposePre === 'function') disposePre();
      if (typeof disposePost === 'function') disposePost();
    },
  };
}
