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

// 成员 / lane 工具面（自 `lib/tools/core.js` **原样搬移**）：lane_claim / lane_release / member_settle /
//   lane_dispatch / member_set_status。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertModeActive, assertMemberActionTierC, readLiveConfig, lockPath, ownerOfExec } from './tier-gate.js';
// 【I-04】派发输入绑定校验：判定单点在 lib/verify/binding.js（纯函数），本文件只调用。
import { dispatchBindingDecision } from '../verify/binding.js';
import { settleDecoupled } from '../engine/settle.js'; // I-12：结算与状态推进解耦（失败不阻塞推进）
import * as lock from '../lock.js';
import {
  dispatchLaneCore, // P2：派发核心（**唯一实现**：工具面 `lane_dispatch` 与链引擎自动推进共用）
  // 【已删 · 勿回加】`assertConcurrencyAdmit`（并发闸准入）：随 **Q-B 取消并发闸**（2026-09-18 用户裁决）删除——
  //   `member_set_status(status='running')` 直派面**不再做容量准入**（高并发不得被限流），
  //   故本文件对该导出**零引用**；`lib/engine/dispatch.js` 侧同批删除该导出（另一 lane 写域），两侧删齐即为终态。
} from '../engine/dispatch.js';

export function buildLaneTools(cx) {
  const { ctx, deps, store, root } = cx;
  // 【批 `d-override-fix-20261011` · lane `e4-session-bind`】批归属会话 resolver（注入单点，
  //   缺省 `undefined` ⇒ `sessionOf` 逐字回落原三级路径、零行为变化）。
  const { resolveBatchSession } = deps ?? {};
  return [
    defineTool({
      name: "lane_claim",
      description: "以 O_EXCL 单写者锁认领 lane（同批同 lane 仅一写者）。冲突先拒，可 wait 或 force 接管；锁按会话隔离。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"任务 ID"},"waitMs":{"type":"integer","description":"等待毫秒（默认 0 = 直接冲突返回）"},"force":{"type":"boolean","description":"force 接管（默认 false）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"token":{"type":"string"},"conflict":{"type":"boolean"},"reason":{"type":"string"},"lockPath":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane claimed') : TEXT_OUTPUT('lane conflict'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, 'lane 锁认领（lane_claim）'); // 模式门（E 阶段）：非生效模式不得落锁（零治理写入），先于取锁
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        // 【Leader 直做 · F2 AC-8 工具面接线（e1-lock 交接项）】`warn` 透传：force 接管是**治理事件**
        //   （接管了他人的单写者锁），生产路径必须留一行日志，否则「接管可审计」只存在于返回载荷里。
        //   复用 `cx.ctx.logger`（**注意**：`createTools(cx)` 把 `ctx` 放在 `cx` 顶层，`deps` 里没有 `ctx`
        //   —— 2026-10-22 真机验证抓到：写成 `deps?.ctx?.logger` 会静默落到空，接管零留痕）；
        //   缺 logger 时静默降级（不阻断取锁）。**不加前缀**：`lib/lock.js` 的 warn 文本自带 `[dsh-punky-swarm]`。
        const warn = (m) => { try { ctx?.logger?.warn?.(m); } catch { /* 留痕失败不阻断取锁 */ } };
        const r = await lock.acquire(lockPath(root, sessionId, args.batchId, args.lane), { waitMs: args.waitMs ?? 0, force: args.force === true, warn });
        // 【F2-G07 · 批 `punky-fix-f3-20261022`】失败成因**透传**（原处把成因硬折叠成**同一句固定文案**，
        //   把 `takeover-contended` / `lock-legacy-format` / `lock-unparseable` 全抹平 ⇒ 调用方
        //   无法区分「他人持有」与「锁文件格式陈旧」，处置动作也就无从选择）。
        //   回落仅限 `r.reason` **不是非空字符串**（无 reason 的旧实现/桩 ⇒ 文案逐字回旧，防 `undefined`
        //   泄漏进 schema）；成功路径返回形状**零变更**（不附加 reason 键）。
        if (!r.ok) {
          const reason = (typeof r.reason === 'string' && r.reason) ? r.reason : 'lane locked';
          return { ok: false, conflict: true, reason };
        }
        return { ok: true, token: r.token };
      },
    }),
    defineTool({
      name: "lane_release",
      description: "释放 lane 锁（须持 token，不匹配即拒）；锁按会话隔离。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"token":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"reason":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane released') : TEXT_OUTPUT('release failed: ' + (value.reason ?? '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, 'lane 锁释放（lane_release）'); // 模式门（E 阶段）：非生效模式不介入治理面（认领侧同样被门），先于释放
        return lock.release(lockPath(root, sessionOf(args, exec, resolveBatchSession), args.batchId, args.lane), args.token);
      },
    }),
    defineTool({
      name: "member_settle",
      description: "成员结算：running->review->merged/failed/skipped/conflict，限该批 owner 或已登记 Manager。merged 前验 Tier3（plan 契约、exec outputs、audit produce、targets 落盘）；audit lane 产物含独立行 needHuman: true 时 merged 的 note 须带 human:<裁决人>:<时间>:<结论>，缺则拒 GATE_NEEDHUMAN_PENDING（conflict 驳回不强制）；exec 层可声明 gate: <命令>（exit 0 通过）。audit lane 不自动结算 ⇒ 先 member_set_status(review) 再调本工具；完成判定靠三查（batch_status、log_export、产物根 glob）。abort 批 danglingLanes 属预期残留。失败必带 GATE_* 码。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":["merged","failed","skipped","conflict"]},"note":{"type":"string","description":"简短备注（只留元数据，不复制正文）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' settled -> ' + value.status),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1（Q2=B 收窄）：写成员状态 = 调用方自己 C 档，或该批已登记的 Manager
        // 【I-04】绑定校验**必须早于** `store.setMember`（写入不可逆：事后补不出"当时谁被派发"）。
        //   只拦「本批某条 lane 的 worker 去结算另一条 lane」；Leader/owner/Manager 属治理面，放行。
        const bindingOfSettle = dispatchBindingDecision({
          batch: store.readBatch(sessionId, args.batchId),
          lane: args.lane,
          caller: exec?.agent?.session?.id ?? null,
          where: 'member_settle(lane=' + args.lane + ')',
        });
        if (!bindingOfSettle.ok) throw new Error(bindingOfSettle.reason);
        // 【I-12】结算与状态推进**解耦**：推进是独立动作、结算是旁挂动作。
        //   结算抛错 ⇒ **状态照样推进**（`stateAdvanced:true`），失败只进 `settleError`、**不向上抛**。
        //   若把两者耦合（结算失败则状态不变），一次记账故障就会让"该进终态"这个事实也丢掉。
        const settleOutcome = settleDecoupled({
          store,
          sessionId,
          batchId: args.batchId,
          lane: args.lane,
          status: args.status,
          note: args.note ?? null, // 只留元数据
          settle: (b) => store.batchSettled(b),
        });
        // 【G-02 死调用清退 · 2026-09-18】原此处调 `advanceChainAfterSettle`（结算事实落盘后触发链推进）。
        //   链推进**已全退役**（2026-09-18 Q-A=C）：被调函数首行即 `return {reason:'retired'}`、全参未被读取
        //   ⇒ 该调用**零行为**，故连 import 一并删除（勿回加）。推进缺口（handoff 成功触发自动推进）
        //   与 `chain.step` 冻结语义见 `lib/engine/chain-runner.js` 头注释。
        return { batchId: args.batchId, lane: args.lane, status: settleOutcome.batch.lanes[args.lane], settled: settleOutcome.settled };
      },
    }),
  ];
}

export function buildDispatchTools(cx) {
  const { ctx, deps, store, root } = cx;
  const { resolveBatchSession } = deps ?? {};
  return [
    defineTool({
      name: "lane_dispatch",
      description: '集群派发：为 lane 发一次性句柄 + 置 running + 引擎自派 worker；门禁同 member_set_status(running)（限 owner/Manager，exec 需 consume 齐备）。自派按次收窄成员工具面并写 member.dispatch；能力位 fail-closed：provider 不支持 toolFilter/depthLimit 或为 startActivation 形态 ⇒ 拒派（mode=rejected、code=GATE_DISPATCH_CAPABILITY_UNAVAILABLE），打在状态变更之前。ctx.subagents 不可取 ⇒ 降级仅发句柄（spawned:false + 成因）。句柄含 firstLine（供人工直派形态粘贴），TTL 30 分钟。',
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"},"prompt":{"type":"string","description":"Leader 补充的任务要点（可选）：接在引擎「角色/契约/纪律」骨架之后"},"exempt":{"type":"object","additionalProperties":false,"description":"longrun 豁免：type=ai-render|large-download|dep-install|none（档位 8/6/4/4）；multiplier [1,100]；stalled 缺省 true","properties":{"type":{"type":"string","required":true,"enum":["ai-render","large-download","dep-install","none"]},"multiplier":{"type":"number"},"stalled":{"type":"boolean"}}}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"token":{"type":"string"},"firstLine":{"type":"string"},"ttlMs":{"type":"number"},"spawned":{"type":"boolean","required":true},"workerSessionId":{"type":"string"},"spawnNote":{"type":"string"},"mode":{"type":"string","enum":["degraded","rejected"],"description":"结局面：degraded=派了但无法保证｜rejected=主动拒派（收窄不可核）；成功路径 spawned:true 不产本字段"},"code":{"type":"string","description":"拒码，仅 mode==='rejected' 时给（GATE_DISPATCH_CAPABILITY_UNAVAILABLE）"},"unconfirmed":{"type":"boolean","description":"派发已尝试但无法确认（不可确认 ≠ 失败）"},"reason":{"type":"string","description":"机器可判短码；spawnNote=长文供人读"}}},
        render: (_args, value) => TEXT_OUTPUT('lane ' + value.lane + ' dispatched'
          // 【D-1 补】按 mode 三分渲染（旧实现只看 spawned ⇒ rejected 被渲染成「仅发句柄」，措辞与语义相反）。
          + (value.mode === 'rejected'
            ? '（拒派：' + String(value.spawnNote ?? '') + '）'
            : value.spawned
              ? '（引擎自派：worker=' + String(value.workerSessionId) + '）'
              : '（仅发句柄：' + String(value.spawnNote ?? '') + '）')
          + '\n' + value.firstLine),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1：与 member_set_status 同源（内含模式门 E 阶段）
        // P2（2026-09-16，lane e-chain）：**派发核心已抽出**至 `lib/engine/dispatch.js` 的 `dispatchLaneCore`
        //   ——工具面与推进链的自动派发走**同一条**路径（同 Tier3 entry 门、同句柄、同任务包骨架、同
        //   `member.dispatch` 登记），禁第二套实现。本 execute 只留「工具面门禁 + 出参整形」。
        //   句柄生命周期（P0）：成功自派 ⇒ 核心内部立即 `consumeLaneHandle`（自派即发放即作废）；
        //   两处降级「仅发句柄」分支 **不消费**（句柄须保持有效供人工直派形态）——口径与实现同在核心头注释。
        return await dispatchLaneCore({
          ctx, store, root, liveConfig: readLiveConfig(deps), exec, sessionId,
          dispatchIndex: deps?.dispatchIndex,   // 修复③：自派写点同步写索引（与读侧同一 Map 引用）
          batchId: args.batchId, lane: args.lane,
          leaderPrompt: args.prompt ?? '', exempt: args.exempt,
        });
      },
    }),
  ];
}

export function buildMemberStatusTools(cx) {
  const { deps, store } = cx;
  const { resolveBatchSession } = deps ?? {};
  return [
    // 【批 `punky-fix-house-20261023` · lane `h4-toolface`】`status` 闭集**移除 `idle`**（**对齐现状，非放宽**）：
    //   `idle` 在迁移表里**无入边**——`MEMBER_TRANSITIONS` 中 `idle` 只有出边 `idle -> running`；
    //   入 idle 的唯一通道是 `RECOVERY_IDLE_FROM`（from = running/review）+ 单点写入口
    //   `laneIdleOnRecovery`（`lib/state/store/lifecycle.js` 模块级，恢复/回收专用，不导出）。
    //   故经本工具设 `status='idle'` 必被 `setMember` 的迁移判定拒（`invalid member transition: X -> idle`）。
    //   原 enum 声明「可设」= 声明面与运行期相矛盾 ⇒ 本次只让**声明面**回到现实，状态机语义**零改**
    //   （不得反向修：把 `idle` 做成可设 = 动迁移表语义，属另一批）。
    defineTool({
      name: "member_set_status",
      description: '成员状态操作（非终态）：pending->running（派发）、running->review（提交评审）、idle->running（恢复重派）；闭集不含 idle（该态只能经恢复/回收单点进入）。限该批 owner 或已登记 Manager。running 可带 exempt。终态结算用 member_settle。',
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":["pending","running","review"],"description":"目标成员态（闭集不含 idle：该态只能经恢复/回收单点进入，设置必被状态机拒）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话）"},"exempt":{"type":"object","additionalProperties":false,"description":"longrun 豁免（仅 status=running 可带）：type=ai-render|large-download|dep-install|none（档位 8/6/4/4）；multiplier [1,100]；stalled 缺省 true","properties":{"type":{"type":"string","required":true,"enum":["ai-render","large-download","dep-install","none"]},"multiplier":{"type":"number"},"stalled":{"type":"boolean"}}}},  // 【已删 · 2026-11-05】原 `revokeExempt` 参数（撤销 longrun 豁免）随撤销面整体移除
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' status -> ' + value.status),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec, resolveBatchSession);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1（Q2=B 收窄）：写成员状态 = 调用方自己 C 档，或该批已登记的 Manager
        // 【已删 · 2026-11-05 · 勿回加】原 `revokeExempt` 分支（撤销 longrun 豁免）整体移除。
        //   用户裁决：「删掉 revokeExempt」（未裁决的需求漂移）。撤销面已从工具参数、store、事件、拒码全链清除。
        //   ⇒ 本工具现在只剩「状态迁移」一条路径，`status` 因此可以干净必填（P2 落地时移入 schema required）。
        //
        // 【P2 · 2026-11-05】**原运行时门禁 `if (args.status === undefined) throw` 已删** ——
        //   `status` 现在进了 `parameters` 的字段内 `required:true` ⇒ 经 `toInputParam` 归一化后
        //   宿主 schema 校验会先拦（`lib/aip/tool-descriptor.js:53-54`）⇒ 运行时重复门禁冗余。
        //   保留说明：schema 层拒的文案来自宿主校验器，不再是我们自己的 GATE_EXEMPT_NOT_DISPATCH。
        // 【已删 · 勿回加】原「并发闸（批级容量准入）」段（段头注释 + `assertConcurrencyAdmit` 调用）随
        //   并发闸已取消：`member_set_status(status='running')` 直派面
        //   **不再做容量准入**（高并发不得被限流），`running` 迁移一律照常放行；本文件对该符号**零引用**。
        // 第 6 参 exempt：undefined = 既有行为零变化；非空对象 = 派发面授予（参数面强校验在 store 内）
        // 第 7 参 owner：仅 `to==='running'`（派发面）写入 ⇒ 派发即出池（K1）；非派发面传值亦被忽略。
        const b = store.setMember(sessionId, args.batchId, args.lane, args.status, null, args.exempt, ownerOfExec(exec));
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
  ];
}