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

//   + archived（done→archive：单向归档标记，布尔，缺省 false）
import type { Batch, LaneHandoffMap, LaneProgressMap } from '../types/contracts.js';

export const BATCH_SCHEMA_V3 = 3;

export function handoffsDefaults(): LaneHandoffMap {
  return {};
}

export function chainsDefaults() {
  return { chains: {}, order: [] };
}

function isLaneProgress(v: unknown): v is LaneProgressMap {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function conditionDefaults() {
  return null;
}

export function migrateV2toV3(batch: unknown): Batch {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    throw new Error('invalid batch: expected object');
  }
  const b = batch as Record<string, unknown>;
  if (b.schema === BATCH_SCHEMA_V3) return batch as Batch;
  const next = { ...b };
  if (next.chains == null || typeof next.chains !== 'object' || Array.isArray(next.chains)) {
    next.chains = chainsDefaults();
  }
  if (next.archived == null || typeof next.archived !== 'boolean') {
    next.archived = false;
  }
  if (next.laneProgress != null && !isLaneProgress(next.laneProgress)) {
    delete next.laneProgress;
  }
  next.schema = BATCH_SCHEMA_V3;
  return next as unknown as Batch;
}
