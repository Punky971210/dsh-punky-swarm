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
//   lane_dispatch / member_status。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertModeActive, assertMemberActionTierC, readLiveConfig, lockPath, ownerOfExec } from './tier-gate.js';
import * as lock from '../lock.js';
import {
  dispatchLaneCore, // P2：派发核心（**唯一实现**：工具面 `lane_dispatch` 与链引擎自动推进共用）
  // 【已删 · 勿回加】`assertConcurrencyAdmit`（并发闸准入）：随 **Q-B 取消并发闸**（2026-09-18 用户裁决）删除——
  //   `member_status(status='running')` 直派面**不再做容量准入**（高并发不得被限流），
  //   故本文件对该导出**零引用**；`lib/engine/dispatch.js` 侧同批删除该导出（另一 lane 写域），两侧删齐即为终态。
} from '../engine/dispatch.js';

export function buildLaneTools(cx) {
  const { deps, store, root } = cx;
  return [
    defineTool({
      name: "lane_claim",
      description: "以 O_EXCL 单写者锁认领 lane（同一批次同一 lane 同时只允许一个写者）。冲突先拒绝；可 wait 或 force 接管。锁按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"任务 ID"},"waitMs":{"type":"integer","description":"等待毫秒（默认 0 = 直接冲突返回）"},"force":{"type":"boolean","description":"force 接管（默认 false）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"token":{"type":"string"},"conflict":{"type":"boolean"},"reason":{"type":"string"},"lockPath":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane claimed') : TEXT_OUTPUT('lane conflict'),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, 'lane 锁认领（lane_claim）'); // 模式门（E 阶段）：非生效模式不得落锁（零治理写入），先于取锁
        const sessionId = sessionOf(args, exec);
        const r = await lock.acquire(lockPath(root, sessionId, args.batchId, args.lane), { waitMs: args.waitMs ?? 0, force: args.force === true });
        if (!r.ok) return { ok: false, conflict: true, reason: 'lane locked' };
        return { ok: true, token: r.token };
      },
    }),
    defineTool({
      name: "lane_release",
      description: "释放 lane 锁（需持有 token；token 不匹配拒绝释放）。锁按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"token":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"reason":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane released') : TEXT_OUTPUT('release failed: ' + (value.reason ?? '')),
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, 'lane 锁释放（lane_release）'); // 模式门（E 阶段）：非生效模式不介入治理面（认领侧同样被门），先于释放
        return lock.release(lockPath(root, sessionOf(args, exec), args.batchId, args.lane), args.token);
      },
    }),
    defineTool({
      name: "member_settle",
      description: "成员结算：按状态机迁移（running->review->merged/failed/skipped/conflict），写入 member.settled 事件。**调用方限该批 owner 或该批已登记 Manager**。Tier3 门禁：plan merged 前 Plan 契约校验（spec 必填章节 + task-tree JSON）、exec merged 前 outputs 校验、audit merged 前 produce 校验；lane 声明 targets 时，merged 前逐一核对 targets 落盘（存在性，不读正文），缺则拒 merged 抛 GATE_TARGET_MISSING、未变更抛 GATE_TARGET_UNCHANGED。needHuman：audit lane 产物含独立行 `needHuman: true` 声明时，merged 须 note 携带人工裁决证据（契约 `human:<裁决人>:<时间>:<结论>`，如 human:user@2026-08-21:accept），缺则拒 GATE_NEEDHUMAN_PENDING；conflict 驳回不强制（评审驳回语义）。命令 gate（V1）：exec 层产物可含独立行 `gate: <命令>`（行首锚定，可多行顺序执行），merged 前置确定性执行并以退出码判定（exit 0 通过，事件 gate.exit）；失败拒 merged 抛 GATE_EXIT_*（lane 留 review）；失败且产物声明 `needHuman: true` → 转人工闸（merged 须 note 含 human: 证据，缺则 GATE_NEEDHUMAN_PENDING）。批次按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":["merged","failed","skipped","conflict"]},"note":{"type":"string","description":"简短备注（只留元数据，不复制正文）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' settled -> ' + value.status),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1（Q2=B 收窄）：写成员状态 = 调用方自己 C 档，或该批已登记的 Manager
        const b = store.setMember(sessionId, args.batchId, args.lane, args.status, args.note ?? null);
        // 【G-02 死调用清退 · 2026-09-18】原此处调 `advanceChainAfterSettle`（结算事实落盘后触发链推进）。
        //   链推进**已全退役**（2026-09-18 Q-A=C）：被调函数首行即 `return {reason:'retired'}`、全参未被读取
        //   ⇒ 该调用**零行为**，故连 import 一并删除（勿回加）。推进缺口（handoff 成功触发自动推进）
        //   与 `chain.step` 冻结语义见 `lib/engine/chain-runner.js` 头注释。
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
  ];
}

export function buildDispatchTools(cx) {
  const { ctx, deps, store, root } = cx;
  return [
    defineTool({
      name: "lane_dispatch",
      description: '集群派发入口（C 档套件）：为指定 lane **发放一次性句柄 + 置 running + 由引擎自派 worker**。门禁语义同 `member_status(status=running)`（调用方限该批 owner 或该批已登记的 Manager；exec 层 lane 需 consume 齐备）。引擎自派时：① **按次收窄成员工具面**（`toolFilter.deny` 套件外治理工具 ⇒ 在成员会话里这些工具**不出现**）；② 以 `label=punky-swarm:<batchId>:<lane>` 建立**第二绑定键**（可从子会话事件反解析归属）；③ 成功后由引擎**直接写** `member.dispatch`（唯一写路径，不再依赖事后观察）；④ **能力位前置**：provider 不支持 `toolFilter`/`depthLimit` ⇒ **拒派**（不「以弱换强」）。若宿主未提供 `ctx.subagents` ⇒ **降级为「仅发句柄」**（返回 `spawned:false` 与原因，不静默）。句柄一次性、TTL 30 分钟；`firstLine` 供人工直派形态粘贴（该形态的硬门禁属 C 阶段）。',
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话"},"prompt":{"type":"string","description":"Leader 补充的任务要点（可选）：引擎给出「角色/契约/纪律」骨架后拼接在末尾"},"exempt":{"type":"object","additionalProperties":false,"description":"longrun 长程豁免授予载荷（同 member_status 派发面）：type 四值白名单 ai-render|large-download|dep-install|none（档位默认 8/6/4/4）；multiplier 可选显式倍率 [1,100]；stalled 可选（缺省 true）","properties":{"type":{"type":"string","required":true,"enum":["ai-render","large-download","dep-install","none"]},"multiplier":{"type":"number"},"stalled":{"type":"boolean"}}}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"token":{"type":"string","required":true},"firstLine":{"type":"string","required":true},"ttlMs":{"type":"number","required":true},"spawned":{"type":"boolean","required":true},"workerSessionId":{"type":"string"},"spawnNote":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('lane ' + value.lane + ' dispatched'
          + (value.spawned ? '（引擎自派：worker=' + String(value.workerSessionId) + '）' : '（仅发句柄：' + String(value.spawnNote ?? '') + '）')
          + '\n' + value.firstLine),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1：与 member_status 同源（内含模式门 E 阶段）
        // P2（2026-09-16，lane e-chain）：**派发核心已抽出**至 `lib/engine/dispatch.js` 的 `dispatchLaneCore`
        //   ——工具面与推进链的自动派发走**同一条**路径（同 Tier3 entry 门、同句柄、同任务包骨架、同
        //   `member.dispatch` 登记），禁第二套实现。本 execute 只留「工具面门禁 + 出参整形」。
        //   句柄生命周期（P0）：成功自派 ⇒ 核心内部立即 `consumeLaneHandle`（自派即发放即作废）；
        //   两处降级「仅发句柄」分支 **不消费**（句柄须保持有效供人工直派形态）——口径与实现同在核心头注释。
        return await dispatchLaneCore({
          ctx, store, root, liveConfig: readLiveConfig(deps), exec, sessionId,
          batchId: args.batchId, lane: args.lane,
          leaderPrompt: args.prompt ?? '', exempt: args.exempt,
        });
      },
    }),
  ];
}

export function buildMemberStatusTools(cx) {
  const { deps, store } = cx;
  return [
    defineTool({
      name: "member_status",
      description: '成员状态操作（非终态）：pending->running（派发，Tier3 门禁：exec 需 consume 齐备）、running->review（提交评审）、idle->running（恢复重派）；**调用方限该批 owner 或该批已登记 Manager**。派发（status=running）可附带 exempt 授予 longrun 长程豁免（只在派发面生效，其它状态带 exempt 一律拒 GATE_EXEMPT_NOT_DISPATCH）；revokeExempt=true 为显式撤销（本条不得再带 status，撤销不改成员状态）。终态结算请用 member_settle。批次按会话隔离。',
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","enum":["pending","running","review","idle"],"description":"目标成员态；revokeExempt=true 时不得携带（撤销是独立显式动作）"},"session":{"type":"string","description":"批次归属会话"},"exempt":{"type":"object","additionalProperties":false,"description":"longrun 长程豁免授予载荷（仅 status=running 时允许出现；缺省 undefined = 无豁免意图）。type 四值白名单 ai-render|large-download|dep-install|none（档位默认 8/6/4/4），未知 type 拒 GATE_EXEMPT_TYPE_UNKNOWN；multiplier 可选显式倍率 [1,100]，非法拒 GATE_EXEMPT_INVALID；stalled 可选（缺省 true）= 是否同时豁免 heartbeat stalled 追问","properties":{"type":{"type":"string","required":true,"enum":["ai-render","large-download","dep-install","none"]},"multiplier":{"type":"number"},"stalled":{"type":"boolean"}}},"revokeExempt":{"type":"boolean","description":"显式撤销该 lane 的 longrun 豁免（不改成员状态）；与 status 不得并用（并用 → GATE_EXEMPT_NOT_DISPATCH）；lane 无既有豁免 → GATE_EXEMPT_REVOKE_REQUIRED"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' status -> ' + value.status),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        assertMemberActionTierC(store, sessionId, exec, 'member', { batchId: args.batchId }, deps); // G1（Q2=B 收窄）：写成员状态 = 调用方自己 C 档，或该批已登记的 Manager
        // 撤销与派发两条面互斥（R-5/R-6）：撤销是独立显式动作，携带 status 即拒（零写入）。
        // 撤销走 store.revokeLaneExempt（唯一入口）：删 laneExempt 条目 + lane.exempt.revoked 事件，
        // **不改成员状态**（不写 member.settled），故不进入任何迁移判定。
        if (args.revokeExempt === true) {
          if (args.status !== undefined) {
            throw new Error('GATE_EXEMPT_NOT_DISPATCH: revokeExempt 与 status 不得并用（撤销是独立的显式动作，不接受状态迁移）');
          }
          const rb = store.revokeLaneExempt(sessionId, args.batchId, args.lane);
          return { batchId: args.batchId, lane: args.lane, status: rb.lanes[args.lane], settled: store.batchSettled(rb) };
        }
        // status 在「撤销」路径之外仍为必填（参数表因撤销面放开 required，缺省在此补同族门禁）
        if (args.status === undefined) {
          throw new Error('GATE_EXEMPT_NOT_DISPATCH: 须给出 status（非终态迁移），或 revokeExempt=true（显式撤销豁免）');
        }
        // 【已删 · 勿回加】原「并发闸（批级容量准入）」段（段头注释 + `assertConcurrencyAdmit` 调用）随
        //   并发闸已取消：`member_status(status='running')` 直派面
        //   **不再做容量准入**（高并发不得被限流），`running` 迁移一律照常放行；本文件对该符号**零引用**。
        // 第 6 参 exempt：undefined = 既有行为零变化；非空对象 = 派发面授予（参数面强校验在 store 内）
        // 第 7 参 owner：仅 `to==='running'`（派发面）写入 ⇒ 派发即出池（K1）；非派发面传值亦被忽略。
        const b = store.setMember(sessionId, args.batchId, args.lane, args.status, null, args.exempt, ownerOfExec(exec));
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
  ];
}