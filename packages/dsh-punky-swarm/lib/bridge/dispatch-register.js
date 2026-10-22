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

// bridge/dispatch-register.js —— 派发登记点（dispatch registration）：装配层观察派发工具，把
//   「worker 会话 → { sessionId, batchId, lane }」写为 member.dispatch 批次事件。
// 背景：归属读侧骨架（dispatchIndex，从批次事件 member.dispatch 幂等重建）依赖写侧登记；
//   本模块经装配层 post-execute 观察 Manager 派发（member_status(status=running) 意图）
//   → resolveBatchContext 得当前批/lane → store.appendEvent 写 member.dispatch
//   （与读侧骨架对接零改动生效：启动重建 + miss 惰性重建，幂等）；
//   未取到批上下文（非 Manager 派发场景）→ 不登记（无登记静默降级语义）。
// 零宿主改造：仅订阅宿主既有 tools/post-execute waterfall（pass-through 恒 next()）；
//   swarm 自身工具（member_status 等）同样流经该 waterfall → 兜底解析 = 观察同会话
//   member_status(status=running) 的派发意图（时序：先置 running 再派发 worker）。
// 语义红线：漏计不误暂停（安全侧）——解析不出批上下文宁可跳过；不引入任何批级状态迁移。
import { EVT_MEMBER_DISPATCH } from '../state/event-types.js';
import { ownerSessionIdOfExec, dispatchIndexEntryOf } from '../engine/dispatch.js'; // 【本批 W-2】写侧取值/索引值构造单点（禁在本文件自写取值式或值形状）
import { sessionOf } from '../tools/shared.js'; // 会话解析与 swarm 工具同源（args.session ?? exec.agent.session.id）
import { parseLaneHandleFromText, consumeLaneHandle, textOfDispatchArgs } from './lane-handle.js'; // 派发句柄（C 档唯一凭证）

// 派发类工具名单（装配注入可经 deps.tools 覆盖/扩列）。
// 【2026-09-22 · S2 one-shot 化 · send_message 唤醒退役（用户裁定「彻底功能分离」，勿回退）】
//   原名单含 `send_message`（0g worker 唤醒：对 continuable 常驻子会话投递消息触发其下一轮）。
//   dispatch 已改**一次性执行器语义**（`lib/engine/dispatch.js` 头部「one-shot 化」）：worker 跑完即弃，
//   **无可唤醒对象** ⇒ 本名单移除 `send_message`；唤醒/续聊/coldResume 等 continuous 能力整体归
//   teammate runner（agent-team 方案，设计稿 §4/B5）。配套：worker deny 追加连续控制族
//   （`suite.js` 表尾 4 件）——成员对 `send_message` 的调用面在 deny 面收口，登记面不再观察。
//   兼容面（**只读，禁删**）：`extractWorkerSessionId` 的 `send_message` 分支**保留**（纯函数防御面，
//   deps.tools 显式注入仍可观察；R1 纯函数回归继续锁死其键名解析正确性）。
export const DEFAULT_DISPATCH_TOOLS = ['subagent', 'subagent_fork'];

// 从 post-execute (exec, result) 提取被派发 worker 会话 id（childId/agentId）。
// 宿主结构化 result：subagent → ToolExecutionResult.value = {kind:'continuable', subagentId}（continuable 后台模式，
// subagentId = startContinuable childId = 会话 id）；background jobId / foreground runId 非会话 id（不登记——
// 无持久 worker 会话可归属，静默）；send_message → 目标在 `args.agent_id`（宿主实签名；`args.subagent_id` 作回落）。
// 【S2 退役登记（2026-09-22）】`send_message` 已退出观察名单（one-shot 化）；本函数分支为**纯函数防御面**保留
//   （deps.tools 显式注入仍可观察；R1 回归锁死其键名解析）。提取不到 → null（不登记）。
export function extractWorkerSessionId(exec, result) {
  if (!exec || typeof exec.name !== 'string') return null;
  const name = exec.name;
  if (name !== 'subagent' && name !== 'subagent_fork' && name !== 'send_message') return null; // 非派发类不提取
  if (result?.isError === true) return null; // 派发失败无 worker 会话（观察者仍透传，不登记）
  if (name === 'send_message') {
    // 【T-14/G-10#3 键名校正】宿主 `send_message` 参数面为 `{agent_id, message}` ⇒ 主取 `agent_id`；
    //   `subagent_id` 作**回落防御**（旧夹具 / 宿主键名再漂移时仍能提取，避免静默漏登记）。
    const id = exec?.arguments?.agent_id ?? exec?.arguments?.subagent_id;
    return typeof id === 'string' && id.length ? id : null;
  }
  // subagent / subagent_fork：结构化 value（host ToolExecutionResult）或平铺 result 兼容
  const v = (result && typeof result === 'object' && 'value' in result ? result.value : result) ?? {};
  if (v && typeof v === 'object') {
    if (v.kind === 'background' || v.kind === 'foreground') return null; // jobId/runId 非会话 id
    for (const k of ['subagentId', 'childId', 'agentId']) {
      if (typeof v[k] === 'string' && v[k].length) return v[k];
    }
  }
  // 兼容文本形态（部分宿主 result 仅 content 文本）：started subagent <id> / subagent <id>
  const c = result?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c)
    ? c.map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : '')).join(' ')
    : '';
  const m = /(?:started\s+)?(?:subagent|agent)\s+([A-Za-z0-9._-]+)/i.exec(text);
  return m ? m[1] : null;
}

// 装配层登记点（对齐 mountVerify/installGovernanceHook 模式）：
//   订阅 ctx.on('tools/post-execute')——识别派发类工具 → 提取 workerSessionId → resolveBatchContext(exec)
//   （deps 显式注入优先；缺省 = 同会话 member_status(running) 派发意图兜底）→ 命中批上下文则 appendEvent
//   member.dispatch {lane, workerSessionId}（读侧骨架零改动生效）；未命中 → 不登记。
//   幂等守卫：dispatchIndex.has(workerSessionId) 已映射 → 跳过（防 send_message 重复唤醒重复登记）。
//   观察者纪律：任一失败仅 warn，恒 return next()（不阻断、不抛错）。
// 返回 { installed, dispose, count, mapping }；ctx.on 缺失 → inert 静默降级（宿主能力缺失不炸）。
export function installDispatchRegistration(ctx, deps = {}) {
  const { store, dispatchIndex, logger, resolveBatchContext, tools = DEFAULT_DISPATCH_TOOLS } = deps;
  const inert = (reason) => ({ installed: false, reason, count: () => 0, mapping: () => ({}), dispose() {} });
  if (!store || typeof ctx?.on !== 'function') return inert('ctx.on unavailable or store missing');
  const toolSet = new Set(tools);
  // 兜底意图表：callerSession -> **FIFO 队列** [{ sessionId, batchId, lane }, …]（member_status(status=running)
  //   观察落点，0g 时序「先置 running 再派发 worker」；注册成功后**消费最早一条**（shift）——一次 running
  //   对应一次 worker 派发，防 stale intent 误归属后续无关 subagent）。
  //   【A1-P1-05 · 2026-10-22】**值由单槽改为每 caller 一条队列**：`caller` 取 `exec.agent.session.id ?? 'cli'`
  //   （宿主不保证每个派发调用方都有 agent 会话 id）⇒ 两个无 agent 会话的调用方共享同一 `'cli'` 键时，
  //   单槽 `set` 会让后登记者**覆盖**先登记者 ⇒ A 批意图被 B 批派发消费（**串批归属**：member.dispatch 登记、
  //   结算、产物根判定全链跟着错）。队列保证「先声明先消费」（不丢、不互覆），且仍是**同一张表**
  //   （caller → 意图，只是每键多槽）⇒ **不新增第二套「谁在派发」索引**（真源仍只有这一张）。
  const intentBySession = new Map();
  const indexMap = dispatchIndex instanceof Map ? dispatchIndex : null;
  let registered = 0;

  // 意图**入队**（同 caller 多槽）。同一 `(batchId, lane, sessionId)` 三连重复登记**不重复入队**：宿主可能对
  //   同一条 lane 重发 running/重试，重复项入队会在消费侧制造假歧义（并挤压真实队列深度）。
  const intentEnqueue = (caller, intent) => {
    const q = intentBySession.get(caller);
    if (!Array.isArray(q)) { intentBySession.set(caller, [intent]); return; }
    if (q.some((v) => v.batchId === intent.batchId && v.lane === intent.lane && v.sessionId === intent.sessionId)) return;
    q.push(intent);
  };
  // 意图**出队**（FIFO：消费最早一条；返回被消费项，队列空即删键——既有 stale 清理语义逐字保留）。
  //   【A1-P1-05 · D-3.5 · 歧义留痕】队列长度 > 1 时一律 warn：无 caller 会话 id 时**无法从 exec 区分调用方**
  //   （宿主信息缺口）⇒ 本档只保证「不丢、不静默」，**不假装能正确归属**（遗留风险 R-2）。
  const intentShift = (caller) => {
    const q = intentBySession.get(caller);
    if (!Array.isArray(q) || q.length === 0) { intentBySession.delete(caller); return null; }
    if (q.length > 1) {
      logger?.warn?.('[dsh-punky-swarm] 同调用方多条派发意图待消费（caller=' + caller + ', pending=' + q.length
        + '）⇒ 取最早一条（FIFO）——后登记批次的归属无法从 exec 区分，本行只保证不丢失、不静默');
    }
    const head = q.shift();
    if (q.length === 0) intentBySession.delete(caller);
    return head;
  };

  const register = (sessionId, batchId, lane, workerSessionId, ownerSessionId = null) => {
    if (indexMap?.has(workerSessionId)) return false; // 幂等：已映射（含重启后重建）不重复登记
    // 【批 `lane-wake-mainpath-fix-20261010` · W-2】载荷**纯加法**：既有两个键（`lane`/`workerSessionId`）
    //   语义一字不动，追加 `ownerSessionId` = 发起该次派发的 agent 会话 id（写侧单点取值）。
    //   取不到 ⇒ **不写该键**（R-7：`'cli'` 兜底值永不可能 live，进载荷即制造死地址；读端按「缺失」走 C-3 回退）。
    //   索引值同步携带该字段（与 `lib/index.js` 的启动重建同形 ⇒ 冷/热两路读数逐字相同，L-AC-8）。
    const entry = ownerSessionId ? { lane, workerSessionId, ownerSessionId } : { lane, workerSessionId };
    store.appendEvent(sessionId, batchId, EVT_MEMBER_DISPATCH, entry);
    // 索引值走**统一构造单点**（既有 3 键形状冻结、附加读数以非枚举承载 —— 见 `dispatchIndexEntryOf` 注释）：
    //   与 `lib/index.js` 启动重建 / `lib/engine/auto-settle.js` 惰性重建**同形** ⇒ 冷/热读数逐字相同（L-AC-8）。
    indexMap?.set(workerSessionId, dispatchIndexEntryOf(sessionId, batchId, lane, ownerSessionId));
    registered++;
    return true;
  };

  const listener = (exec, result, next) => {
    try {
      if (!exec || typeof exec.name !== 'string') return next();
      const caller = exec?.agent?.session?.id ?? 'cli';
      // 【本批 W-2】写侧取值**单点**（与 W-1 同源）：**不**复用 `caller` —— `caller` 带 `'cli'` 兜底且
      //   不校验空串，而载荷要求「取不到 ⇒ 不写该键」（R-7）⇒ 两者取值式相同、**语义不同**，不得合并。
      const ownerSessionId = ownerSessionIdOfExec(exec);
      // ① member_status(status=running) → 记录派发意图（swarm 工具同流经 post-execute；非 running 清意图防 stale）
      if (exec.name === 'member_status') {
        const a = exec.arguments ?? {};
        if (a.status === 'running' && a.batchId && a.lane) {
          // 【A1-P1-05】入队（不覆盖）：同 caller 再登一条 ⇒ 两条意图并存，消费侧按 FIFO 取最早一条。
          intentEnqueue(caller, { sessionId: sessionOf(a, exec), batchId: a.batchId, lane: a.lane });
        } else {
          intentBySession.delete(caller);
        }
        return next();
      }
      // ② 非派发类工具 → 不登记（透传）
      if (!toolSet.has(exec.name)) return next();
      const workerSessionId = extractWorkerSessionId(exec, result);
      if (!workerSessionId) {
        // 【T-14/G-10#3 · 显式降级告警（不静默漏登记）】原此处**静默 `return next()`**：官方 profile 下
        //   `subagent*` 不在宿主工具面 ⇒ 其告警分支恒不进（见下方 ③′），而 `send_message` 提取失败
        //   （原读错键名 `subagent_id`）会**零告警地漏登记** ⇒ `member.dispatch` 恒零产生、下游
        //   `laneBindingOf`/自动结算整链静默失效。
        //   现口径：提取不到持久 worker 会话即**显式留痕降级**（含宿主结构化形态 `background`/`foreground`
        //   = jobId/runId 非会话 id、`isError` 失败、键缺失三类成因），再 `next()`。
        //   **不引入拒绝**（观察者纪律：恒 `next()`）。
        logger?.warn?.('[dsh-punky-swarm] dispatch register degraded（提取不到持久 worker 会话 ⇒ 本次不登记 · tool='
          + exec.name + ' · caller=' + caller + '）：键缺失/键名漂移，或结果为失败/非会话 id'
          + '（background jobId / foreground runId）——非静默降级，仅留痕不阻断');
        return next();
      }
      // ③′-a **句柄优先**（「不写 token 即禁止派发」）：任务包内含有效 lane 句柄 ⇒
      //   以句柄的 (batchId, lane) **精确登记**（一次性消费）。这修掉了原「单槽意图」缺陷——并行 N 条 lane
      //   同波派发时**全部可登记**，而非只登记最后一条。句柄是 C 档派发的**唯一凭证**（由 `lane_dispatch` 发放）；
      //   解析不到句柄时**退回既有意图路径**（本步只补登记、不引入拒绝——拒绝在 guard 档位门，另行落地）。
      const handleText = textOfDispatchArgs(exec.arguments);
      const parsed = parseLaneHandleFromText(handleText);
      if (parsed) {
        const c = consumeLaneHandle(parsed.token, { batchId: parsed.batchId, lane: parsed.lane });
        if (c.ok) {
          // 【A1-P1-05 · D-3.3】登记成功 ⇒ 从该 caller 队列 **shift() 一条**（消费最早一条；队列空才删键）。
          //   原 `delete(caller)` 会一次清空整个键 —— 单槽时等价，多槽后必须收敛为「一条派发消费一条意图」。
          if (register(c.entry.sessionId, c.entry.batchId, c.entry.lane, workerSessionId, ownerSessionId)) intentShift(caller);
          return next();
        }
        logger?.warn?.('[dsh-punky-swarm] lane handle rejected: ' + c.reason + '（lane=' + parsed.lane + '，退回意图路径）');
      } else if (exec.name === 'subagent' || exec.name === 'subagent_fork') {
        // B6（修 W5「静默降级」）：派发工具**未携带句柄**时**显式留痕**，再走既有意图兜底。
        //   对应拒绝分支已删；此处的职责只有一个——**不静默**。
        //   【A1-P2-04 · 2026-10-22 口径更正】**原写「宿主委派工具已由官方 profile 停用」——该断言顶层成立、preset 层不成立**，
        //   故**不得据此假设派发工具缺席**（**双层真相**）：宿主顶层 profile 的派发工具区段
        //   （**由 loader 在 boot 期重写、行号不稳定 ⇒ 刻意不引行号**）
        //   写 `disabled: true`，而 preset 层 `cordis.yml:770-780` 与 `presets/punky-preset/agent.cordis.yml:220-232`
        //   **未禁用**（两行 `tool-subagent` / `tool-subagent-fork` 实为**已注册**）。
        //   （曾把该区段误称「实为已注册」，属**错位引用**：它实写 `disabled: true`。）
        //   故「派发工具不带句柄」是**常态路**而非禁用路的残余：
        //   Leader 直派 / 非 C 档派发都不会带句柄 ⇒ 本行只是「常态路的留痕」，不构成本包对宿主工具面的假设。
        logger?.warn?.('[dsh-punky-swarm] dispatch without lane handle（' + exec.name + ' · caller=' + caller
          + '）⇒ 走意图兜底登记（**不设拒绝码**：宿主已注册委派工具、无句柄属常态路，本行只保证不静默）');
      }
      // ③ resolveBatchContext(exec)：显式注入优先，缺省 = 同会话派发意图兜底（装配注入 resolveBatchContext 兜底）。
      //   【A1-P1-05】意图表已多槽 ⇒ 兜底读**队首**（不在这里消费；登记成功后由 intentShift 消费最早一条）。
      const hasResolver = typeof resolveBatchContext === 'function';
      const hit = hasResolver
        ? resolveBatchContext(exec, { workerSessionId, result })
        : (intentBySession.get(caller)?.[0] ?? null);
      if (!hit || !hit.sessionId || !hit.batchId || !hit.lane) {
        // 【A1-P1-05 · D-3.4 · 零静默】原此处**零留痕**直接 `return next()`，是同函数唯一的静默丢弃面
        //   （`:170` 提取失败、`:189` 句柄被拒均有 warn）。现拆成**可辨成因三档**，各带 tool/caller/成因。
        //   留痕载体只能是 `logger.warn`（硬论证，见规格 §方案 3）：「取不到批上下文」的定义即**结构性无 batchId**
        //   ⇒ 任何批次事件都写不进去（`lane.binding_gap` 的写端要求已有 batchId+lane）⇒ 故**不新增事件类型**、
        //   不进 `store.appendEvent`；**零新造拒码**（拒码前缀一字不加；本档不产生拒绝，观察者纪律：仍 `next()`）。
        const cause = hit
          ? '批上下文不完整（缺 sessionId / batchId / lane）'
          : (hasResolver
            ? 'resolveBatchContext 反查无果（且该调用方无待消费派发意图）'
            : '该调用方无待消费派发意图（未注入 resolveBatchContext）');
        logger?.warn?.('[dsh-punky-swarm] dispatch register unbound（取不到批上下文 ⇒ 本次不登记 · tool='
          + exec.name + ' · caller=' + caller + '）：' + cause + '——非静默丢弃，仅留痕不阻断');
        return next();
      }
      if (register(hit.sessionId, hit.batchId, hit.lane, workerSessionId, ownerSessionId)) {
        // 【A1-P1-05 · D-3.3】消费意图（一次 running → 一次派发登记）；多槽下按 FIFO 消费最早一条。
        intentShift(caller);
      }
    } catch (e) {
      logger?.warn?.('[dsh-punky-swarm] dispatch registration failed (isolated, does not block): ' + String(e?.message ?? e));
    }
    return next(); // pass-through：恒透传（观察者纪律）
  };
  const dispose = ctx.on('tools/post-execute', listener);
  return {
    installed: true,
    count: () => registered,
    mapping: () => (indexMap ? Object.fromEntries([...indexMap.entries()]) : {}),
    // 【A1-P1-05】回显形状**逐字不变**（仍 `[{ caller, sessionId, batchId, lane }]`）：多槽值按队列**展平**，
    //   同一 caller 的多条意图各占一行（消费一个少一行），调用面零变化。
    pendingIntents: () => [...intentBySession.entries()].flatMap(([s, q]) => (Array.isArray(q) ? q : [q])
      .map((v) => ({ caller: s, ...v }))),
    dispose() { try { if (typeof dispose === 'function') dispose(); } catch { /* 幂等 */ } },
  };
}
