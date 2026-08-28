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

// 文件 topic：broadcast topic 订阅/分发
// 两路分发：① 进程内 handler 同步调用（异常隔离）；② 可选落 mailbox broadcast box（复用 mailbox.send，ackId 原子写语义）
// 消费侧跨进程经 mailbox_read(box=broadcast) 读取，readTopic 提供按 topic/sinceTs 过滤的只读辅助
//
// 接线状态（exec-panel-b 批②，R3 SSE hub）：
//   - subscribeTopicPrefix（前缀订阅，R3 hub 订阅 `swarm.` 用，exec-b 新增，签名零改动）；
//   - 装配开关 capabilities.topic.enabled（CAPABILITY_REGISTRY 注册表默认关，显式开启才接线）仍归 exec-a 装配；
//   - 消费点不得绕过 mailbox 公共接口（与既有广播语义同源：mailbox.send/readUnacked）。
import { join } from 'node:path';
import { send as mailboxSend, readUnacked } from './mailbox.js';

const registry = new Map(); // Map<topic, Set<handler>>
const prefixRegistry = new Map(); // Map<prefix, Set<handler>>（前缀订阅，emitTopic 按 startsWith 分发）

function assertTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('invalid topic: ' + String(topic));
  }
}

function boxRoot(root, sessionId, batchId) {
  return join(root, 'sessions', sessionId, 'mailbox', batchId);
}

export function subscribeTopic(topic, handler) {
  assertTopic(topic);
  if (typeof handler !== 'function') throw new Error('invalid handler: ' + String(handler));
  let set = registry.get(topic);
  if (!set) { set = new Set(); registry.set(topic, set); }
  set.add(handler); // 同 topic 同 handler 幂等
  let unsubscribed = false;
  return function unsubscribe() {
    if (unsubscribed) return; // 幂等，重复调用 no-op
    unsubscribed = true;
    const s = registry.get(topic);
    if (s) {
      s.delete(handler);
      if (s.size === 0) registry.delete(topic);
    }
  };
}

// 前缀订阅（R3 SSE hub 订阅 `swarm.` 用，exec-panel-b 新增；签名与 subscribeTopic 同形，handler 收 (topic, payload)）
// 语义：emitTopic(topic) 时，topic.startsWith(prefix) 的前缀订阅者全部收到（精确注册与前缀注册并存、互不影响）
export function subscribeTopicPrefix(prefix, handler) {
  assertTopic(prefix); // 前缀不得为空（空前缀会匹配一切，禁止）
  if (typeof handler !== 'function') throw new Error('invalid handler: ' + String(handler));
  let set = prefixRegistry.get(prefix);
  if (!set) { set = new Set(); prefixRegistry.set(prefix, set); }
  set.add(handler); // 同 prefix 同 handler 幂等
  let unsubscribed = false;
  return function unsubscribe() {
    if (unsubscribed) return; // 幂等，重复调用 no-op
    unsubscribed = true;
    const s = prefixRegistry.get(prefix);
    if (s) {
      s.delete(handler);
      if (s.size === 0) prefixRegistry.delete(prefix);
    }
  };
}

export function emitTopic(topic, payload, ctx = {}) {
  assertTopic(topic);
  // ① 进程内分发：同步调用，异常隔离（单 handler 抛错不影响其余、不向上传播）
  let delivered = 0;
  const handlers = registry.get(topic);
  if (handlers) {
    for (const h of [...handlers]) {
      try { h(payload); delivered++; } catch { /* 隔离 */ }
    }
  }
  // ①b 前缀分发（R3 SSE hub 订阅 `swarm.`）：handler 收 (topic, payload)，异常隔离
  for (const [prefix, prefixHandlers] of prefixRegistry) {
    if (!topic.startsWith(prefix)) continue;
    for (const h of [...prefixHandlers]) {
      try { h(topic, payload); delivered++; } catch { /* 隔离 */ }
    }
  }
  // ② 可选落 mailbox broadcast box（root/sessionId/batchId 齐备才落盘）
  let sent = 0;
  let ackId = null;
  const { root, sessionId, batchId } = ctx;
  if (root && sessionId && batchId) {
    const msg = { topic, payload, ts: new Date().toISOString() };
    const res = mailboxSend(boxRoot(root, sessionId, batchId), { type: 'broadcast' }, msg);
    sent = res.ok ? 1 : 0;
    ackId = res.ackId ?? null;
  }
  return { delivered, sent, ackId };
}

export function readTopic(root, { sessionId, batchId, topic, sinceTs = 0 } = {}) {
  const items = readUnacked(boxRoot(root, sessionId, batchId), { type: 'broadcast' }, { sinceTs });
  return items
    .filter((it) => it.message?.topic === topic)
    .map((it) => ({ ackId: it.ackId, topic: it.message.topic, payload: it.message.payload, ts: it.message.ts }));
}
