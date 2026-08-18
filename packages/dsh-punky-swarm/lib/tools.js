// 蟛蜞模式治理工具（13 个），defineTool 规范含 output.schema + output.render
// v2：全部工具感知 session——批次归属当前执行会话（exec.agent.session.id），可被 args.session 覆盖
// Tier3：wave_plan 支持三层契约字段 + team 装配注入；新增 assign_check（委派形态判定 A/B/C）、gate_status（门禁状态查询）、artifact_types（产物类型注册表）
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildWavePlan, validateWavePlan } from './wave-plan.js';
import { resolveAssembly } from './assembly.js';
import { ARTIFACT_TYPES } from './artifact-types.js';
import * as mailbox from './mailbox.js';
import * as lock from './lock.js';
import { join } from 'node:path';

const TEXT_OUTPUT = (text) => [{ type: 'text', text }];

function sessionOf(args, exec) {
  if (args && typeof args.session === 'string' && args.session.length) return args.session;
  return exec?.agent?.session?.id ?? 'cli';
}
function boxRoot(root, sessionId, batchId) { return join(root, 'sessions', sessionId, 'mailbox', batchId); }
function lockPath(root, sessionId, batchId, lane) { return join(root, 'sessions', sessionId, '.locks', batchId + '.' + lane + '.lock'); }

export function createTools(ctx, deps) {
  const { store, root, config = {} } = deps;
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
        const b = store.setPhase(sessionOf(args, exec), args.batchId, args.phase);
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
      description: "委派形态判定（设计 §10/§15.3 N3）：判断任务应由 Leader 直做（A）/ 轻量委派 subagent（B，需独立上下文/工具面时）/ 必须走流水线批次（C）。输入任务特征（并行?/多角色?/门禁?/可恢复?/需独立上下文?），返回判定与原因；C 类任务应走 wave_plan 建批。",
      parameters: {"parallel":{"type":"boolean","description":"需要并行或任务间依赖（DAG）"},"multiRole":{"type":"boolean","description":"需要多角色协作（编码+测试+审查分离）"},"gate":{"type":"boolean","description":"需要门禁/审计（人审、验收、gap-list）"},"recoverable":{"type":"boolean","description":"需要跨轮治理/可恢复/可审计"},"needIsolation":{"type":"boolean","description":"需要独立上下文/工具面（查代码、跑测试等）"},"session":{"type":"string"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"form":{"type":"string","required":true},"allowed":{"type":"boolean","required":true},"reasons":{"type":"array","required":true,"items":{"type":"string"}}}},
        render: (_args, value) => TEXT_OUTPUT('assign form: ' + value.form + (value.allowed ? ' (allowed)' : ' (must use batch)')),
      },
      async execute(args) {
        const reasons = [];
        if (args.parallel) reasons.push('需要并行或任务依赖（DAG）');
        if (args.multiRole) reasons.push('需要多角色协作（编码+测试+审查分离）');
        if (args.gate) reasons.push('需要门禁/审计（人审、验收、gap-list）');
        if (args.recoverable) reasons.push('需要跨轮治理/可恢复/可审计');
        if (reasons.length) return { form: 'C', allowed: false, reasons };
        return { form: args.needIsolation ? 'B' : 'A', allowed: true, reasons: [] };
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
      description: "成员结算：按状态机迁移（running->review->merged/failed/skipped/conflict），写入 member.settled 事件。Tier3 门禁：plan merged 前 L0 结构校验、exec merged 前 outputs 校验、audit merged 前 produce 校验。批次按会话隔离。",
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
