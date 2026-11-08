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

// @ts-check

// 派发面门面（barrel）：对外导出面与拆分前**逐名一致**（40 个），消费者零改动。
// 实现按职责分在 6 个模块，层序：role → bind → preflight → taskpack → core（mode 独立）。
// 本条同时修掉原文件三处结构瑕疵：
//   ① 原 L443 的 `import { normalizeCheckpoints }` 夹在函数之间 ⇒ 已上提到 dispatch-preflight.js 顶部；
//   ② 原 L28-29 的「import 后立刻再导出」二传手 ⇒ 改为直接 `export … from './suite.js'`（真源在 suite.js）；
//   ③ 原 L916 夹在文件中间的 `export { mailboxRootOf } from …` ⇒ 移到本门面。

export {
  batchSessionIdOfWorker,
  batchSessionIdOfWorkerResolved,
  dispatchIndexEntryOf,
  labelOf,
  laneBindingOf,
  ownerSessionIdOf,
  ownerSessionIdOfExec,
  wakeAddressOf,
} from './dispatch-bind.js';
export {
  buildStartRequest,
  dispatchLaneCore,
  mapSpawnError,
  workerSessionIdOf,
} from './dispatch-core.js';
export {
  MODE_INACTIVE_CODE,
  REPORT_CHANNEL,
  evaluateTierCDispatch,
  isChildSession,
  modeActiveFor,
  normalizeModeGate,
  presetOfSession,
} from './dispatch-mode.js';
export {
  checkpointsOf,
  preflightOf,
  renderCheckpointsBlock,
  renderPreflightBlock,
  renderPreflightLines,
} from './dispatch-preflight.js';
export {
  ROLE_MANDATORY_FIELDS,
  ROLE_SECTION_TITLES,
  ROLE_UNRESOLVED_CODE,
  deriveDenyTools,
  parseRoleFrontmatter,
  personaOfRole,
  resolveRoleRef,
  roleCorpusRoot,
  roleTeamDirs,
  roleToolVocabulary,
} from './dispatch-role.js';
export {
  composeWorkerPrompt,
  memberDispatchBudgetKeyOf,
  renderRoleGuide,
} from './dispatch-taskpack.js';
export { mailboxRootOf } from '../mailbox-paths.js';
export { SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from './suite.js';
