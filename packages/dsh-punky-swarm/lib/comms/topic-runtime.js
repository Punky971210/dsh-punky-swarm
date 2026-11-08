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

import { subscribeTopic, emitTopic, readTopic } from './topic.js';

export function createTopicRuntime(ctx, { root, logger } = {}) {
  let started = false;
  const log = logger ?? ctx?.logger ?? null;

  function topicOf(type, sessionId, batchId) {
    return 'swarm.' + type + '.' + sessionId + '.' + batchId;
  }

  function publishStateChange(ev) {
    if (!started) return { published: false, reason: 'not-started' };
    if (!ev || !ev.type || !ev.sessionId || !ev.batchId) {
      return { published: false, reason: 'invalid-event' };
    }
    const topic = topicOf(ev.type, ev.sessionId, ev.batchId);
    const payload = { ...ev, ts: new Date().toISOString() };
    return emitTopic(topic, payload, { root, sessionId: ev.sessionId, batchId: ev.batchId });
  }

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
