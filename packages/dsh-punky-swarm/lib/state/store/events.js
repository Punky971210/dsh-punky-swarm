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


import * as EVT from '../event-types.js';



const ESCAPE_PAYLOAD_KEYS = ['kind', 'lane', 'reason', 'gate', 'path', 'artifact'];
const DEGRADE_PAYLOAD_KEYS = ['kind', 'declaredField', 'effective', 'layers', 'lanes', 'reason'];

export function pickPayload(keys, src) {
  const out = {};
  for (const k of keys) {
    if (src && src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out;
}
export function gateEscapeEvents(res, lane) {
  if (!res || typeof res !== 'object') return [];
  const raw = [
    ...(res.escape ? [res.escape] : []),
    ...(Array.isArray(res.escapes) ? res.escapes : []),
  ];
  return raw
    .filter((e) => e && typeof e === 'object' && typeof e.kind === 'string' && e.kind.length > 0)
    .map((e) => ({ payload: { ...pickPayload(ESCAPE_PAYLOAD_KEYS, e), lane: e.lane ?? lane } }));
}
export function gateDegradeEvents(res, lane) {
  if (!res || !Array.isArray(res.degrades)) return [];
  return res.degrades
    .filter((d) => d && typeof d === 'object' && typeof d.kind === 'string' && d.kind.length > 0)
    .map((d) => ({ payload: { ...pickPayload(DEGRADE_PAYLOAD_KEYS, d), lane: d.lane ?? lane } }));
}

const CONTRACT_MISSING_PAYLOAD_KEYS = ['cause', 'gateKind', 'layer', 'lane', 'declared', 'source', 'degrade', 'problems'];
export function contractMissingEvents(batch, res, lane) {
  const cm = res && typeof res === 'object' ? res.contractMissing : null;
  if (!cm || typeof cm !== 'object') return [];
  const gateKind = typeof cm.gateKind === 'string' ? cm.gateKind : '';
  if (gateKind.length === 0) return [];
  const layer = typeof cm.layer === 'string' ? cm.layer : null;
  const key = gateKind + '@' + (layer ?? '-');
  const events = batch && Array.isArray(batch.events) ? batch.events : [];
  for (const e of events) {
    if (!e || e.type !== EVT.EVT_GATE_CONTRACT_MISSING) continue;
    if (String(e.gateKind ?? '') + '@' + (e.layer ?? '-') === key) return [];
  }
  return [{
    payload: {
      ...pickPayload(CONTRACT_MISSING_PAYLOAD_KEYS, cm),
      cause: typeof cm.cause === 'string' ? cm.cause : 'undeclared',
      gateKind,
      layer,
      lane: cm.lane ?? lane ?? null,
      declared: cm.declared === true,
      problems: Array.isArray(cm.problems) ? [...cm.problems] : [],
    },
  }];
}

export function countConsecutiveFailedSettles(events) {
  const evs = events ?? [];
  let count = 0;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (!e || e.type !== EVT.EVT_MEMBER_SETTLED) continue;
    if (e.to === 'failed') count++;
    else break;
  }
  return count;
}

export function buildEvents(cx) {
  const { onStateChange, log, resolveGateEventTypes } = cx;

  function newEvent(type, fields = {}) {
    return { ts: new Date().toISOString(), type, ...fields };
  }

  function emitStateChange(ev) {
    try { onStateChange?.(ev); } catch { }
  }

  function makeContractMissingSink(getBatch, getLane) {
    return (res) => {
      const batch = getBatch();
      const items = contractMissingEvents(batch, res, getLane());
      if (items.length === 0) return 0;
      const type = resolveGateEventTypes().contractMissing;
      for (const item of items) {
        batch.events.push(newEvent(type, item.payload));
        log.warn?.('[dsh-punky-swarm] gate.contract_missing: ' + item.payload.gateKind + '@' + (item.payload.layer ?? '-')
          + '(lane=' + String(item.payload.lane ?? '-') + ') —— 团队资产未声明该检查项 ⇒ 引擎缺省接管；'
          + '首触留痕，只报一次/批（degrade=' + String(item.payload.degrade?.kind ?? '-') + '）');
      }
      return items.length;
    };
  }

  function escalatePausedWrite(batch, { reason, eventType, fields }) {
    batch.phase = 'paused';
    batch.events.push(newEvent(EVT.EVT_BATCH_PHASE, { from: 'running', to: 'paused', reason }));
    batch.events.push(newEvent(eventType, fields));
  }

  return { newEvent, emitStateChange, makeContractMissingSink, escalatePausedWrite };
}
