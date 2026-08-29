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

// 蟛蜞模式通信工具（3 个）：mailbox_send / mailbox_read / mailbox_ack
// 拆分自 lib/tools.js（原样搬移，行为不变）
// mailbox_send 接线 budget 环防护——inbox 永不受限（Manager 权威出口下行派发）；
//   outbox/broadcast 在 config.capabilities.budget.enabled=true 时先 chainFor+checkBudget，拒绝返回 {ok:false, code, detail}（不 throw）+ budget.rejected 事件留痕
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as mailbox from '../comms/mailbox.js';
import { chainFor, checkBudget, recordChain } from '../comms/budget.js';
import { TEXT_OUTPUT, sessionOf } from './shared.js'; // P2-01：共享辅助直引零依赖 shared.js（不再经 core.js）
import { readCapability } from '../assembly/schema.js'; // P1-01：装配开关经注册表 default 缺省合并
import { join } from 'node:path';
// R-01 发端收敛：budget.rejected 事件字面量改引 EVT 常量单点
import * as EVT from '../state/event-types.js';

function boxRoot(root, sessionId, batchId) { return join(root, 'sessions', sessionId, 'mailbox', batchId); }

// 发送方/接收方/文本推导（budget 判定输入；缺省值保证无 meta 的调用仍可记账）
function budgetFrom(args) { return args.meta?.from ?? args.lane ?? 'worker'; }
function budgetTo(box, args) { return args.meta?.to ?? (box.type === 'outbox' ? 'supervisor' : '*'); }
function budgetText(message) {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') return message.text ?? JSON.stringify(message);
  return String(message ?? '');
}

export function createMailboxTools(ctx, deps) {
  const { root, store, config = {} } = deps;

  return [
    defineTool({
      name: "mailbox_send",
      description: "向文件 mailbox 发送消息（原子写 + ackId）：inbox=Leader->worker，outbox=worker->Leader，broadcast=广播。mailbox 按会话隔离。",
      parameters: {"batchId":{"type":"string","required":true},"box":{"type":"string","required":true,"enum":["inbox","outbox","broadcast"]},"lane":{"type":"string","description":"outbox 必填"},"message":{"type":"object","required":true,"additionalProperties":true},"meta":{"type":"object","description":"元数据","additionalProperties":true},"session":{"type":"string","description":"批次归属会话"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"ackId":{"type":"string"},"code":{"type":"string"},"detail":{"type":"string"}}},
        render: (_args, value) => value.ok ? TEXT_OUTPUT('mailbox sent: ' + value.ackId) : TEXT_OUTPUT('mailbox rejected: ' + (value.code ?? '') + (value.detail ? ' — ' + value.detail : '')),
      },
      async execute(args, exec) {
        const b = args.box === 'outbox' ? { type: 'outbox', lane: args.lane } : { type: args.box };
        const sessionId = sessionOf(args, exec);
        const batchId = args.batchId;
        const rootDir = boxRoot(root, sessionId, batchId);
        // C4 环防护接线（P1-01：缺省默认开——readCapability 合并注册表 default {enabled:true}；
        //   显式 capabilities.budget.enabled:false 可关 → 零感知零开销；inbox 永不受限——Manager 追问/派发绝不因链预算被拒）
        const budgetCfg = readCapability(config, 'budget');
        if (b.type !== 'inbox' && budgetCfg?.enabled === true && store) {
          const batch = store.readBatch(sessionId, batchId);
          if (batch) {
            const chains = store.readChains(sessionId, batchId);
            const msg = { box: b, lane: args.lane ?? null, message: args.message, meta: args.meta ?? {} };
            const chain = chainFor(chains, msg); // 显式 meta.chain 继承 hop+1；无声明开新链
            const budgetMeta = {
              ...(args.meta ?? {}),
              chain,
              from: budgetFrom(args),
              to: budgetTo(b, args),
              text: budgetText(args.message),
            };
            const check = checkBudget(budgetMeta, chains, {
              maxChainHops: budgetCfg.maxChainHops ?? 4,
              maxChainRoundTrips: budgetCfg.maxChainRoundTrips ?? 2,
            });
            if (!check.ok) {
              try {
                store.appendEvent(sessionId, batchId, EVT.EVT_BUDGET_REJECTED, { code: check.code, lane: args.lane ?? null, chainId: chain.id });
              } catch { /* 事件留痕失败不阻塞拒绝返回（文件 mailbox 既有失败路径是返回值） */ }
              return { ok: false, code: check.code, detail: check.detail };
            }
            try {
              store.updateChains(sessionId, batchId, recordChain(chains, { ...msg, meta: budgetMeta }));
            } catch { /* 记账失败不阻塞发送（防护尽力而为，不破坏既有 mailbox 语义） */ }
            return mailbox.send(rootDir, b, args.message, budgetMeta); // meta.chain 透传（含 hop）
          }
        }
        return mailbox.send(rootDir, b, args.message, args.meta ?? null);
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
}
