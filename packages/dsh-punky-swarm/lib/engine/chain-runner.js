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

// engine/chain-runner.js —— **链运行期推进 · 已退役**（2026-09-18 · Q-A=C 弃用链声明）。
// ─────────────────────────────────────────────────────────────────────────────
// 【退役口径（上游裁决，硬）】`docs/engine-design-adjudication-20260918.md:181`（Q-A=C）：
//   `chain.steps/branches/pair_with/join/onFail/rework` **全部停止消费**；步级 Join 不需要；
//   `onFail` 不属当前引擎语义；`rework` 用 gap-list 表达（失败 lane 终态，重做 = 重开新批）。
// 【拓扑真源（唯一）】运行期 DAG 真源 = **批次 `wavePlan[].tasks[].deps`（入边声明） + `batch.handoffs`
//   （逐边交接事实）**；判定单点 = `lib/state/gates.js` 的 `handoffRecordVerdictOf`。
//   `chain` 段自此**不参与建批期展开、不参与运行期决策、不参与派发**（建批期八条静态校验按容忍口径保留，见
//   `lib/assembly/chain.js`）。
// 【本模块现状·零既有调用点】`advanceChainAfterSettle` **保留导出**，但两处历史调用点
//   （`lib/tools/core.js` 的 `member_settle` 内、`lib/engine/auto-settle.js` 的自动结算路）**已随
//   批次 `engine-debt-cleanup-2-20260918`（G-02 死调用清退）一并删除**；`lib/engine/replay.js` 侧
//   为**注释留痕、无调用**。⇒ `lib/` 内**零调用**（`CALL=0 / IMPORT=0`），调用面仅剩 `test/**` 的历史读端。
//   函数本体**首行 no-op**：不读链、不判步、不写 `chain.step`、不派发、不改相位 —— 与退役前
//   `leader-direct` 批的既有 no-op 同形，只是**扩展到所有批**（语义收敛，非分叉）。
//   保留导出的理由 = 历史读端/测试的 **ESM 面兼容**（缺符号 = 加载期缺导出，会掩盖真读数；硬断言见
//   `test/m1-on-removed.test.js`、`test/gap-s12-chain-downgrade.test.js`）。「无自动推进」的自动化缺口
//   （`discipline.md` 的 W-13/R-6）在本批**显式挂起**（followup：handoff 成功触发自动推进，本批不实现开关）。
// 【`chain.step` 冻结语义（D8 · T-09，本批显式写死）】三句硬口径：
//   ① **冻结新增**：本模块**不再写** `chain.step`（原唯一写点 `chainStepPayload` 已随退役删除）⇒ 新批恒零新增；
//   ② **兼容读**：磁盘历史批的 `chain.step` 事件**照常可读**，读端为 `lib/assembly/chain.js` 的 `chainEchoOf`
//      （`batch_status.chain` / `log_export` 同一实现）—— 事件 `via` 取值白名单 `CHAIN_STEP_VIA` 不改；
//   ③ **读端不读本模块**：`chainEchoOf` 与 `log_export` **均不 import 本模块**（读端只吃批次事件流，
//      本模块零参与）⇒ 本模块的退役/清退**不波及任何读端**（兼容硬锁）。
// 【本批删除面（逐条，勿回退）】
//   · 步映射 / 汇合 / 下一跳 / 配对解析的运行期调用（`chainStepForLane` / `chainLanesOfStep` / `chainNextOf` /
//     `perLaneTargetOf` / `pairedLaneOf`）—— 符号本体在 `lib/assembly/chain.js` **冻结保留**（历史读端与
//     既有纯函数用例），**运行期零消费**；
//   · `chainStepPayload`（`chain.step` 载荷单点构造器，唯一写点已随之消失）；
//   · `countReworkAttempts`（K2 回边计数：其唯一调用方在本模块内）；
//   · `pauseBatch`（链停轮写相位：停轮面改由门禁 / Leader 裁决承担）；
//   · 无挂载点降级（`no-mount-point` 待派清单）与并发闸 `deferred` 分支（闸本身已随 Q-B 取消，见
//     `lib/engine/dispatch.js`「取消并发闸 · 退役登记」）；
//   · 对 `dispatchLaneCore` 的调用（链不再派发；派发只剩工具面单通道）。
// 【保留面（禁删）】
//   · `redispatchableFrom`（状态机判据单点投影，`lib/schema.js` 的 `canTransitionMember`；**非链语义**）；
//   · 历史 `chain.step` 事件的**读端**（`chainEchoOf` / `log_export`）不读本模块，退役不波及（兼容硬锁）。

import { canTransitionMember } from '../schema.js';

/** 可被推进派发的成员态（判据 = 状态机，**不另立口径**）：能迁到 `running` 且非终态。
 *  【保留面】链推进退役不改状态机口径；本函数只做「态 → 可迁否」投影，仍被读端与既有用例引用。 */
export function redispatchableFrom(state) {
  return canTransitionMember(state, 'running');
}

/** 【已退役 · 2026-09-18 Q-A=C】链推进入口：**首行 no-op**。
 *  不读链、不判步、不写 `chain.step`、不派发、不改相位（`chain` 声明存在与否，本函数行为恒同 —— 容忍口径：
 *  五队资产仍带 `chain` 段 ⇒ 不得报错、不得静默改语义，见规格 §3）。
 *  保留导出的理由 = 三处既有调用点不因退役而在 ESM 面缺符号（缺符号 = 加载期缺导出，会掩盖真读数）；
 *  **不得**在此重建第二套推进实现（禁双推进源）。
 *  @returns {{ok: true, action: 'none', reason: 'retired', note: string}} */
export async function advanceChainAfterSettle() {
  return {
    ok: true,
    action: 'none',
    from: null,
    to: null,
    via: null,
    dispatched: [],
    skipped: [],
    reason: 'retired',
    note: 'chain-advance-retired-20260918',
  };
}
