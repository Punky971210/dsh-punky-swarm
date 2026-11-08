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
import { EXEMPT_GATE_CODES } from '../lane-exempt.js';
const EVT_LANE_EXEMPT_CLEARED = EVT.EVT_LANE_EXEMPT_CLEARED;
const EVT_LANE_EXEMPT_INHERITED = EVT.EVT_LANE_EXEMPT_INHERITED;

export function buildMemberExempt(cx) {
  const { readBatch, newEvent, commitBatch } = cx;


  function laneExemptClear(batch, lane, clearedAt = null) {
    if (!batch?.laneExempt?.[lane]) return batch;
    const next = { ...batch.laneExempt };
    delete next[lane];
    if (Object.keys(next).length === 0) delete batch.laneExempt;
    else batch.laneExempt = next;
    if (clearedAt) {
      batch.laneExemptCleared = { ...(batch.laneExemptCleared ?? {}), [lane]: clearedAt };
      batch.events.push(newEvent(EVT_LANE_EXEMPT_CLEARED, { lane, clearedAt }));
    }
    return batch;
  }

  function applyLaneExemptOnDispatch(batch, { lane, from, to, exemptGrant }) {
  let exemptInherited = null;
  if (!exemptGrant && to === 'running') {
    const prev = batch.laneExempt?.[lane];
    if (prev) {
      const inheritedAt = new Date().toISOString();
      exemptInherited = { ...prev, grantedAt: inheritedAt, grantedFrom: from, inheritedAt, inheritedFrom: prev.grantedAt ?? null };
      batch.laneExempt = { ...batch.laneExempt, [lane]: exemptInherited };
      batch.events.push(newEvent(EVT_LANE_EXEMPT_INHERITED, {
        lane, from, to: 'running',
        exemptType: exemptInherited.type,
        multiplier: exemptInherited.multiplier,
        tierMultiplier: exemptInherited.tierMultiplier,
        stalled: exemptInherited.stalled,
        grantedFrom: from,
        inheritedFrom: prev.grantedAt ?? null,
      }));
    } else {
      const at = new Date().toISOString();
      const cleared = laneExemptClear(batch, lane, at);
      if (cleared.laneExemptCleared?.[lane] === at) batch = cleared;
    }
  }
  if (exemptGrant) {
    const grantedAt = new Date().toISOString();
    batch.laneExempt = {
      ...(batch.laneExempt ?? {}),
      [lane]: { grantedAt, grantedFrom: from, ...exemptGrant },
    };
    batch.events.push(newEvent(EVT.EVT_LANE_EXEMPT_GRANTED, {
      lane, from, to: 'running',
      exemptType: exemptGrant.type,
      multiplier: exemptGrant.multiplier,
      tierMultiplier: exemptGrant.tierMultiplier,
      stalled: exemptGrant.stalled,
      grantedFrom: from,
    }));
  }
    return batch;
  }

  return { laneExemptClear, applyLaneExemptOnDispatch };
}
