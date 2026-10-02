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

// 门禁闭包上下文 `GatesCx`（**只有类型，零运行期导出**）——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分新增：各 builder 的 cx 形参类型单一来源。
//   依赖方向单向：`gates.ts`（组合器）→ 各 builder → 本文件；本文件不 import 任何 builder（零环）。
//   注：门禁函数槽此处按**调用签名**声明（返回值为结构对象，消费方 `store.js` / 门禁内部均按 JS 语义读键）；
//   `composeGates` 的返回面类型**不经此处**——它由 `assembleGates` 的**结构推断**给出（与拆分前逐字同形）。

import type { Batch } from '../../types/contracts.js';
import { flowsForBatch } from '../../assembly/flows.js';
import type { GatesHelpers } from './helpers.js';
import type { PresenceInput, PresenceVerdict } from './presence.js';
import type { ReasonVocabularyVerdict, VocabularyView } from './reason-vocabulary.js';

/** 门禁判定载荷（结构对象；与原闭包推断面等价）。 */
export type GateVerdict = Record<string, any>;

/** 门禁函数槽（四参 + 可选第五参：needHuman 门为 `note`、命令门为 `deps`）。 */
export type GateFn = (
  sessionId: string, batchId: string, batch: Batch, lane: string, extra?: any,
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
  // ── 各 builder 装配的门禁函数槽（构建序 = 依赖拓扑序，见 gates.ts#assembleGates）──
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
