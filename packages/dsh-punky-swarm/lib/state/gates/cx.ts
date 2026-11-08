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


import type { Batch } from '../../types/contracts.js';
import { flowsForBatch } from '../../assembly/flows.js';
import type { GatesHelpers } from './helpers.js';
import type { PresenceInput, PresenceVerdict } from './presence.js';
import type { ReasonVocabularyVerdict, VocabularyView } from './reason-vocabulary.js';

/** 门禁判定载荷（结构对象；与原闭包推断面等价）。 */
export type GateVerdict = Record<string, unknown>;

/** 门禁函数槽（四参 + 可选第五参：needHuman 门为 `note`、命令门为 `deps`）。 */
export type GateFn = (
  sessionId: string, batchId: string, batch: Batch, lane: string, extra?: unknown,
) => GateVerdict;

export interface GatesCx extends GatesHelpers {
  root: string;
  sessionsDir: string;
  vocabOpts: { root: string | null };
  readCfg: () => unknown;
  flowsOf: (batch: Batch) => ReturnType<typeof flowsForBatch>;
  laneStartedAt: (batch: Batch, lane: string) => string;
  presenceJudge: (input: PresenceInput) => PresenceVerdict;
  reasonVocabularyVerdict: (artifactsDir: string, paths: string[], opts?: { root?: string | null }) => ReasonVocabularyVerdict;
  vocabularyViewOf: (opts?: { root?: string | null }) => VocabularyView;
  checkEntryGate: GateFn;
  checkPlanContract: GateFn;
  checkExitGate: GateFn;
  checkNeedHumanGate: GateFn;
  checkCommandGate: (sessionId: string, batchId: string, batch: Batch, lane: string, deps?: { runCommand?: unknown }) => GateVerdict;
  checkTargetsGate: GateFn;
  checkCompleteGate: (batch: Batch) => GateVerdict;
  checkSettleHandoffGate: GateFn;
  gateStrengthOf: (batch: Batch) => GateVerdict;
  gateStatus: (sessionId: string, batchId: string, lane: string) => GateVerdict;
  gateStatusOfBatch: (sessionId: string, batchId: string) => Record<string, GateVerdict>;
  gateStatusMapOfBatch: (sessionId: string, batchId: string) => Record<string, GateVerdict>;
  teamAssetViewOf: (batch: Batch | null | undefined) => { teamAsset: unknown; declaration: unknown; declarationMissing: boolean };
  unwiredEntriesOf: (batch: Batch) => Array<Record<string, unknown>>;
}
