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

// lib/comms/topic-runtime.js —— R2 topic 运行时装配（index.js 装配点，生命周期与 trajectory 桥同形）
// 设计依据：exec/panel-design.md §3.2（装配面/接线面/命名/开关）+ §3.2.4（trajectory 桥并存不统一）
//   - 开关：capabilities.topic.enabled（readCapability 缺省合并 {enabled:false}，默认关）；enabled 时装配面创建
//     运行时（start/stop 供 R1 热更新实时启停），关闭时零挂载零路径（与 acps/bridge config 短路同构）
//   - 发布方（首批枚举，设计 §3.2.3）：store.setMember/setPhase 调用点埋点（onStateChange → publishStateChange）
//   - 命名：swarm.<eventType>.<sessionId>.<batchId>（点分倒置，前缀固定便于 readTopic 精确过滤与日志检索）
//   - 落盘：emitTopic 的 ctx 携带 {root, sessionId, batchId} 才落 mailbox broadcast（topic.js 既有语义不变）；
//     publishConfigChanged（R1→R2 可选镜像）无 session 归属 → 仅进程内分发，不落 mailbox
//   - topic.js 三函数签名零改动（本文件只做装配与接线，不透改底层模块）
import { subscribeTopic, emitTopic, readTopic } from './topic.js';

export function createTopicRuntime(ctx, { root, logger } = {}) {
  let started = false;
  const log = logger ?? ctx?.logger ?? null;

  // topic 命名规范：swarm.<eventType>.<sessionId>.<batchId>
  function topicOf(type, sessionId, batchId) {
    return 'swarm.' + type + '.' + sessionId + '.' + batchId;
  }

  // 状态机事件发布（store 调用点埋点 → 本函数）：
  //   ev = { type: 'member.settled' | 'batch.phase', sessionId, batchId, lane?, from, to, note? }
  // 未 start / 载荷不齐 → 零发布（不落盘不抛错）；异常由 emitTopic 内部隔离
  function publishStateChange(ev) {
    if (!started) return { published: false, reason: 'not-started' };
    if (!ev || !ev.type || !ev.sessionId || !ev.batchId) {
      return { published: false, reason: 'invalid-event' };
    }
    const topic = topicOf(ev.type, ev.sessionId, ev.batchId);
    const payload = { ...ev, ts: new Date().toISOString() };
    // ctx 携带 {root, sessionId, batchId} → 落 mailbox broadcast（topic.js 既有语义）；root 缺省（测试）仅进程内分发
    return emitTopic(topic, payload, { root, sessionId: ev.sessionId, batchId: ev.batchId });
  }

  // 配置变更镜像（R1→R2 可选，设计 §3.4）：swarm.config.changed——无 session 归属 → 仅进程内分发
  function publishConfigChanged(change) {
    if (!started) return { published: false, reason: 'not-started' };
    return emitTopic('swarm.config.changed', { ...change, ts: new Date().toISOString() }, { root });
  }

  function start() {
    started = true;
    log?.info?.('[dsh-punky-swarm] topic runtime started');
    return { started: true };
  }

  function stop() {
    started = false;
    log?.info?.('[dsh-punky-swarm] topic runtime stopped');
    return { stopped: true };
  }

  return {
    start, stop,
    publishStateChange, publishConfigChanged,
    subscribeTopic, emitTopic, readTopic,
    topicOf, isStarted: () => started,
  };
}
