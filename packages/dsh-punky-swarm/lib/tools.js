// 蟛蜞模式治理工具（14 个），defineTool 规范含 output.schema + output.render
// v2：全部工具感知 session——批次归属当前执行会话（exec.agent.session.id），可被 args.session 覆盖
// Tier3：wave_plan 支持三层契约字段 + team 装配注入；新增 assign_check（委派形态判定 A/B/C）、gate_status（门禁状态查询）、artifact_types（产物类型注册表）、asset_claim（直做产物归位）
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildWavePlan, validateWavePlan } from './wave-plan.js';
import { resolveAssembly } from './assembly.js';
import { ARTIFACT_TYPES } from './artifact-types.js';
import * as mailbox from './mailbox.js';
import * as lock from './lock.js';
import { join } from 'node:path';

const TEXT_OUTPUT = (text) => [{ type: 'text', text }];

// 执行型工具名单（有副作用/写盘/派发执行）：guard 计数与拦截用；可被 config.escalation.execTools 覆盖
const EXEC_TOOLS = [
  'pwsh', 'bash', 'write', 'edit', 'run_code', 'workflow', 'ralph',
  'ssh_exec', 'ssh_cluster', 'ssh_upload', 'ssh_download', 'subagent', 'subagent_fork',
];

// 清 pendingBatch（wave_plan 建批 / 批次 complete|aborted 后调用；无治理状态时不创建文件）
function clearPendingBatch(store, sessionId) {
  const g = store.readGovernance(sessionId);
  if (g.pendingBatch || g.pendingSince || g.lastAssign) {
    store.writeGovernance(sessionId, { pendingBatch: false, pendingSince: null });
  }
}

function sessionOf(args, exec) {
  if (args && typeof args.session === 'string' && args.session.length) return args.session;
  return exec?.agent?.session?.id ?? 'cli';
}
function boxRoot(root, sessionId, batchId) { return join(root, 'sessions', sessionId, 'mailbox', batchId); }
function lockPath(root, sessionId, batchId, lane) { return join(root, 'sessions', sessionId, '.locks', batchId + '.' + lane + '.lock'); }

export function createTools(ctx, deps) {
  const { store, root, config = {} } = deps;

  // 任务难度值门禁（design task-difficulty-gate §3，引擎强制不依赖自觉）：执行型工具前置 guard
  // 同步签名 (execution) => string | undefined；execution 含 name / agent.session.id；返回 string 即拒绝
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard((execution) => {
      const sessionId = execution?.agent?.session?.id;
      if (!sessionId) return undefined;
      const execTools = config?.escalation?.execTools ?? EXEC_TOOLS;
      if (!execTools.includes(execution.name)) return undefined; // ① 非执行型：放行（治理/查询，防死锁）
      const g = store.readGovernance(sessionId);
      let reason;
      // 门禁 1：从未评估 或 已过期（execCallsSince≥20 / 距 lastAssign.at≥30min）→ 要求先评估
      if (!g?.lastAssign?.form || store.stale(sessionId)) {
        reason = '[task-difficulty-gate] 本回合尚未进行任务难度评估（A/B/C）。请先调用 assign_check(scope=full) 给出难度与执行主体，再执行 ' + execution.name;
      } else if (g.lastAssign.form === 'C' && g.pendingBatch) {
        // 门禁 2：判 C 且未建批 → 拒绝执行型（必须先 wave_plan 建批）
        reason = '[task-difficulty-gate] 任务难度=C（集群方案），必须先 wave_plan 建批。已直做产物用 asset_claim 归位，然后建批派发。';
      } else if ((execution.name === 'subagent' || execution.name === 'subagent_fork') && g.lastAssign.form === 'A') {
        // 门禁 3（一致性）：A 类不派发 subagent（需要独立上下文请重评 B）
        reason = '[task-difficulty-gate] A 类任务不派发 subagent；如确实需要独立上下文请重评 B。';
      }
      store.bumpExecCount(sessionId); // 计数与拦截分离：无论是否拦截，执行型调用都计（机制 A 观察）
      return reason;
    });
  }

  const tools = [
    defineTool({
      name: "wave_plan",
      description: "把任务按 DAG 依赖分层为 waves 并持久化为批次（wavePlan 固定语义，绝不在中途重算）。Tier3：任务可声明 layer(plan/exec/audit)/consume/produce/outputs/role/skills，建批时做三层契约静态校验；team 装配按 role 注入 skill 前缀（可插拔，不绑定 jiufeng）。批次绑定当前会话。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID（kebab-case）"},"tasks":{"type":"array","required":true,"description":"任务列表 [{id, cmd, deps?, model?, tools?, layer?, role?, skills?, consume?, produce?, outputs?}]","items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","description":"并发上限（默认 5）"},"team":{"type":"string","description":"装配团队（默认 generic；三层批推荐 jiufeng）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"wavePlan":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}},"concurrency":{"type":"integer","required":true},"lanes":{"type":"object","required":true,"additionalProperties":true}}},
        render: (_args, value) => TEXT_OUTPUT('wavePlan created: ' + value.batchId + ' @' + value.sessionId + ' (' + value.wavePlan.length + ' waves)'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const assembly = resolveAssembly(args.team, config.assembly);
        const plan = buildWavePlan({ batchId: args.batchId, tasks: args.tasks, concurrency: args.concurrency ?? 5, team: args.team, assembly });
        validateWavePlan(plan);
        const batch = store.createBatch(sessionId, { batchId: plan.batchId, wavePlan: plan, concurrency: plan.concurrency });
        clearPendingBatch(store, sessionId); // 建批解锁：判 C 后 pendingBatch=false（design §4 写入点）
        return { batchId: plan.batchId, sessionId, wavePlan: plan.wavePlan, concurrency: plan.concurrency, lanes: batch.lanes };
      },
    }),
    defineTool({
      name: "batch_phase",
      description: "批次阶段迁移：planning->running->paused->aborted|complete（终态后拒绝再写）。complete 前置：audit 层验收齐备（Tier3 门禁）。批次按会话隔离，缺省取当前执行会话。",
      parameters: {"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true,"enum":["running","paused","aborted","complete"]},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"phase":{"type":"string","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('batch ' + value.batchId + ' phase -> ' + value.phase),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const b = store.setPhase(sessionId, args.batchId, args.phase);
        if (b.phase === 'complete' || b.phase === 'aborted') clearPendingBatch(store, sessionId); // 兜底清理旧锁
        return { batchId: args.batchId, phase: b.phase };
      },
    }),
    defineTool({
      name: "batch_status",
      description: "查询批次状态（唯一事实源）：phase/lanes/wavePlan/事件摘要；不传 batchId 则列出当前会话全部批次。可用 session 指定会话。",
      parameters: {"batchId":{"type":"string","description":"批次 ID；缺省时列出该会话全部"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string"},"phase":{"type":"string"},"concurrency":{"type":"integer"},"lanes":{"type":"object","additionalProperties":true},"wavePlan":{"type":"array","items":{"type":"object","additionalProperties":true}},"eventCount":{"type":"integer"},"recentEvents":{"type":"array","items":{"type":"object","additionalProperties":true}},"settled":{"type":"boolean"},"sessionId":{"type":"string"},"batches":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => value.batchId ? TEXT_OUTPUT('batch ' + value.batchId + ' phase=' + value.phase + ' settled=' + value.settled) : TEXT_OUTPUT('batches: ' + (value.batches ?? []).length),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        if (!args.batchId) {
          return { sessionId, batches: store.listBatches(sessionId).map((id) => { const b = store.readBatch(sessionId, id); return { batchId: id, sessionId, phase: b.phase, lanes: b.lanes }; }) };
        }
        const b = store.readBatch(sessionId, args.batchId);
        if (!b) throw new Error('batch not found: ' + args.batchId + ' @' + sessionId);
        return { batchId: b.batchId, sessionId, phase: b.phase, concurrency: b.concurrency, lanes: b.lanes, wavePlan: b.wavePlan, eventCount: b.events.length, recentEvents: b.events.slice(-20), settled: store.batchSettled(b) };
      },
    }),
    defineTool({
      name: "artifact_types",
      description: "产物类型注册表（只读，Tier3 通用任务治理）：列出产物类型 → 层/目录前缀约定，供 wave_plan 声明产物与模板对齐。不绑定任何团队模板。",
      parameters: {},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"types":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('artifact types: ' + value.types.length),
      },
      async execute() {
        return { types: ARTIFACT_TYPES.map((t) => ({ type: t.type, dir: t.dir, layer: t.layer, desc: t.desc })) };
      },
    }),
    defineTool({
      name: "assign_check",
      description: "委派形态判定（设计 §10/§15.3 N3）：判断任务应由 Leader 直做（A）/ 轻量委派 subagent（B，需独立上下文/工具面时）/ 必须走流水线批次（C）。输入任务特征（并行?/多角色?/门禁?/可恢复?/需独立上下文?），返回判定与原因；C 类任务应走 wave_plan 建批。每次调用写入会话治理状态（governance.lastAssign+history），guard 依据其做执行型工具门禁。",
      parameters: {"parallel":{"type":"boolean","description":"需要并行或任务间依赖（DAG）"},"multiRole":{"type":"boolean","description":"需要多角色协作（编码+测试+审查分离）"},"gate":{"type":"boolean","description":"需要门禁/审计（人审、验收、gap-list）"},"recoverable":{"type":"boolean","description":"需要跨轮治理/可恢复/可审计"},"needIsolation":{"type":"boolean","description":"需要独立上下文/工具面（查代码、跑测试等）"},"scope":{"type":"string","enum":["current","full"],"description":"评估对象：current=当前动作，full=完整目标任务（纪律强制 full，防把小动作当整体难度）"},"session":{"type":"string"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"form":{"type":"string","required":true},"allowed":{"type":"boolean","required":true},"reasons":{"type":"array","required":true,"items":{"type":"string"}},"next":{"type":"array","required":true,"items":{"type":"string"}},"execToolCount":{"type":"integer","required":true},"escalationHint":{"type":"string","required":true},"history":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => {
          let s = 'assign form: ' + value.form + (value.form === 'C' ? ' (must use batch) → next: wave_plan' : ' (allowed)');
          if (value.escalationHint) s += ' ⚠ ' + value.escalationHint;
          return TEXT_OUTPUT(s);
        },
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const reasons = [];
        if (args.parallel) reasons.push('需要并行或任务依赖（DAG）');
        if (args.multiRole) reasons.push('需要多角色协作（编码+测试+审查分离）');
        if (args.gate) reasons.push('需要门禁/审计（人审、验收、gap-list）');
        if (args.recoverable) reasons.push('需要跨轮治理/可恢复/可审计');
        const form = reasons.length ? 'C' : (args.needIsolation ? 'B' : 'A');
        // 写入治理状态：lastAssign + history 追加（审计：每回合评估留痕）；C 类且无活跃批次 → pendingBatch=true
        const now = new Date().toISOString();
        const scope = args.scope ?? 'full';
        const g0 = store.readGovernance(sessionId);
        const history = [...(g0.history ?? []), { turn: (g0.history?.length ?? 0) + 1, form, at: now, reasons }];
        const hasActive = store.hasActiveBatch(sessionId);
        const patch = { lastAssign: { form, scope, at: now, reasons, execCallsSince: 0 }, history };
        if (form === 'C' && !hasActive) { patch.pendingBatch = true; patch.pendingSince = now; }
        else if (hasActive) { patch.pendingBatch = false; patch.pendingSince = null; } // 已有活跃批次：保持解锁
        const g = store.writeGovernance(sessionId, patch);
        const execToolCount = g.execToolCount ?? 0;
        // 升级信号（design escalation-hardgate §2.2 S4）：execToolCount≥5 且无活跃批次 → 软提示
        const escalationHint = (execToolCount >= 5 && !hasActive)
          ? 'execToolCount=' + execToolCount + ' ≥5 且无批次：任务已升级为复杂形态，必须 wave_plan 建批'
          : '';
        return { form, allowed: form !== 'C', reasons, next: form === 'C' ? ['wave_plan'] : [], execToolCount, escalationHint, history: g.history };
      },
    }),
    defineTool({
      name: "asset_claim",
      description: "归位（设计 6.3）：Leader 已直做产物（探索/探测/排障）注册为批次资产——复制 source 进 <artifacts>/<batchId>/<target>（保留内容，不移动），批次事件 asset.claimed 留痕，返回批次内路径供 wave_plan consume/produce 声明。路径防逃逸：target 必须是批次内相对路径，拒绝 .. 与绝对路径。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"source":{"type":"string","required":true,"description":"源文件绝对路径（已直做产物）"},"target":{"type":"string","required":true,"description":"批次内目标路径（相对 artifacts/<batchId>/，不得含 .. 或绝对路径）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"claimedPath":{"type":"string"},"batchId":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('asset claimed: ' + value.claimedPath),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const r = store.claimAsset(sessionId, args.batchId, { source: args.source, target: args.target });
        return { ok: r.ok, claimedPath: r.claimedPath, batchId: r.batchId };
      },
    }),
    defineTool({
      name: "gate_status",
      description: "查询批次/ lane 的门禁状态（设计 §8 M1）：layer、consume/produce/outputs 缺失清单、plan 契约问题。不传 lane 列出全部 lane。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","description":"lane ID；缺省列出全部"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"lanes":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('gate status: ' + value.lanes.length + ' lane(s)'),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        const batch = store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const ids = args.lane ? [args.lane] : Object.keys(batch.lanes);
        return { batchId: args.batchId, sessionId, lanes: ids.map((l) => store.gateStatus(sessionId, args.batchId, l)) };
      },
    }),
    defineTool({
      name: "lane_claim",
      description: "以 O_EXCL 单写者锁认领 lane（同一批次同一 lane 同时只允许一个写者）。冲突先拒绝；可 wait 或 force 接管。锁按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true,"description":"任务 ID"},"waitMs":{"type":"integer","description":"等待毫秒（默认 0 = 直接冲突返回）"},"force":{"type":"boolean","description":"force 接管（默认 false）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"token":{"type":"string"},"conflict":{"type":"boolean"},"reason":{"type":"string"},"lockPath":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('lane claimed') : TEXT_OUTPUT('lane conflict'),
      },
      async execute(args, exec) {
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
        return lock.release(lockPath(root, sessionOf(args, exec), args.batchId, args.lane), args.token);
      },
    }),
    defineTool({
      name: "member_settle",
      description: "成员结算：按状态机迁移（running->review->merged/failed/skipped/conflict），写入 member.settled 事件。Tier3 门禁：plan merged 前 Plan 契约校验（spec 必填章节 + task-tree JSON）、exec merged 前 outputs 校验、audit merged 前 produce 校验。批次按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":["merged","failed","skipped","conflict"]},"note":{"type":"string","description":"简短备注（只留元数据，不复制正文）"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' settled -> ' + value.status),
      },
      async execute(args, exec) {
        const b = store.setMember(sessionOf(args, exec), args.batchId, args.lane, args.status, args.note ?? null);
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
    defineTool({
      name: "member_status",
      description: '成员状态操作（非终态）：pending->running（派发，Tier3 门禁：exec 需 consume 齐备）、running->review（提交评审）、idle->running（恢复重派）。终态结算请用 member_settle。批次按会话隔离。',
      parameters: {"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true,"enum":["pending","running","review","idle"]},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"batchId":{"type":"string","required":true},"lane":{"type":"string","required":true},"status":{"type":"string","required":true},"settled":{"type":"boolean","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('member ' + value.lane + ' status -> ' + value.status),
      },
      async execute(args, exec) {
        const b = store.setMember(sessionOf(args, exec), args.batchId, args.lane, args.status, null);
        return { batchId: args.batchId, lane: args.lane, status: b.lanes[args.lane], settled: store.batchSettled(b) };
      },
    }),
    defineTool({
      name: "mailbox_send",
      description: "向文件 mailbox 发送消息（原子写 + ackId）：inbox=Leader->worker，outbox=worker->Leader，broadcast=广播。mailbox 按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"box":{"type":"string","required":true,"enum":["inbox","outbox","broadcast"]},"lane":{"type":"string","description":"outbox 必填"},"message":{"type":"object","required":true,"additionalProperties":true},"meta":{"type":"object","description":"元数据","additionalProperties":true},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"ackId":{"type":"string","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('mailbox sent: ' + value.ackId),
      },
      async execute(args, exec) {
        const b = args.box === 'outbox' ? { type: 'outbox', lane: args.lane } : { type: args.box };
        return mailbox.send(boxRoot(root, sessionOf(args, exec), args.batchId), b, args.message, args.meta ?? null);
      },
    }),
    defineTool({
      name: "mailbox_read",
      description: "读取 mailbox 未确认消息（ack 后不再返回）。mailbox 按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"box":{"type":"string","required":true,"enum":["inbox","outbox","broadcast"]},"lane":{"type":"string","description":"outbox 必填"},"since":{"type":"integer","description":"仅返回此时间戳(ms)之后的消息"},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"items":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT(value.items.length + ' unacked message(s)'),
      },
      async execute(args, exec) {
        const b = args.box === 'outbox' ? { type: 'outbox', lane: args.lane } : { type: args.box };
        return { items: mailbox.readUnacked(boxRoot(root, sessionOf(args, exec), args.batchId), b, { sinceTs: args.since ?? 0 }) };
      },
    }),
    defineTool({
      name: "mailbox_ack",
      description: "确认消费一条 mailbox 消息。mailbox 按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"box":{"type":"string","required":true,"enum":["inbox","outbox","broadcast"]},"lane":{"type":"string","description":"outbox 必填"},"ackId":{"type":"string","required":true},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"ackId":{"type":"string","required":true}}},
        render: (_args, value) => TEXT_OUTPUT('acknowledged: ' + value.ackId),
      },
      async execute(args, exec) {
        const b = args.box === 'outbox' ? { type: 'outbox', lane: args.lane } : { type: args.box };
        return mailbox.ack(boxRoot(root, sessionOf(args, exec), args.batchId), b, args.ackId);
      },
    }),
  ];

  return { tools, register() { for (const t of tools) ctx.tools.register(t); } };
}
