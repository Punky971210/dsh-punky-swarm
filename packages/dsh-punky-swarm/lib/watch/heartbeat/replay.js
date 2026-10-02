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

// W1-① 重放/恢复**周期兜底**档（独立于 longrun 档开关）
//   （【2026-10-02 · 内务批 波 2】随 `createLaneHeartbeat` 巨型函数拆分下沉，代码与本注释逐字搬移）。
import { replayBatch } from '../../engine/replay.js';

// ── W1-① 重放/恢复：**周期兜底**（本 tick 涉及的全部 `running` 批） ─────────────────────
// 为什么要在心跳里再跑一次（缺口，实测口径见 `lib/engine/replay.js` 文件头）：
//   链推进由 `member.settled` 驱动；若**推进发生在运行期**且失败/无人补（门禁挂起、进程退出、
//   装配期扫描窗口未覆盖），批次会永久停在「lane 已 merged、下一环从未被决策」。装配期只扫一次，
//   覆盖不到「启动之后才死的」，故需一个**周期兜底**。心跳 tick 是既有唯一周期面 ⇒ 挂在这里。
//
// ★ 语义边界（**必须与原纪律并读，不得混同**）：
//   心跳既有的 stalled / longrun / binding-gap 三档是「**只标记不自动处置**」——它们只产候选/留痕，
//   成员状态与批次相位**一律不动**（Manager/Leader 人审）。本档**不是**自动处置：
//   `replayBatch` 固定 `noDispatch: true` ⇒ 只**补一条链推进决策**（落 `chain.step{dispatch.mode:'manual-pending'}`），
//   **不派发**、**不改相位**、**不改任何成员状态**（真派仍归 Leader/Manager，与 S12 裁决一致）。
//   两者同处一 tick 但**互不影响**：本档不读也不写心跳 state 表，三档的判据/阈值/输出一字未改。
//   边界自证：本档命中时批相位恒为 `running`（`replayBatch` 内的相位闸），故不可能与
//   「终态批只出悬挂视图」「paused 批次档」等路径交叉。
//
// 三条硬纪律（与装配期扫描 `lib/index.js` **逐字同源**，防「写了不生效」或「静默危害」）：
//   ① 只处理 `running` 批（`replayBatch` 内相位闸 + 此处预筛，双保险）；
//   ② 一律只决策不派发（`replayBatch` 内固定 `noDispatch`）；
//   ③ 全程 try/catch 不抛（单批隔离）+ **零命中零日志**（守「缺省配置零 warn」契约 legacy-fix T4.3）。
// 有界：会话数与批次数均设上限（同装配期常量），防大批量时本拍扫盘过久。
// 去重/幂等不在本档重复实现：`replayBatch` 的 `advancedAfter(ts >= 结算时刻)` 判据保证
//   「同一现场重复重放 ⇒ 零新增 `chain.step`」⇒ 本 tick 反复跑不会重复推进（RI-2 回归锁）。
const REPLAY_MAX_SESSIONS = 5;
const REPLAY_MAX_BATCHES = 20;
export async function replayTick(cx) {
  const hits = [];
  let replayed = 0;
  try {
    const targets = [];
    const sessions = (typeof cx.store.listSessions === 'function' ? cx.store.listSessions() : []).slice(0, REPLAY_MAX_SESSIONS);
    for (const sessionId of sessions) {
      const ids = typeof cx.store.listBatches === 'function' ? cx.store.listBatches(sessionId) : [];
      for (const batchId of ids) {
        if (targets.length >= REPLAY_MAX_BATCHES) break;
        try { if (cx.store.readBatch(sessionId, batchId)?.phase === 'running') targets.push({ sessionId, batchId }); }
        catch { /* 坏批跳过（与装配期扫描同隔离口径） */ }
      }
      if (targets.length >= REPLAY_MAX_BATCHES) break;
    }
    for (const t of targets) {
      try {
        const r = await replayBatch({ store: cx.store, root: cx.engineRoot, liveConfig: cx.liveConfig ?? cx.config }, cx.ctxOf(), t);
        if (r && r.replayed > 0) { replayed += r.replayed; hits.push(t.batchId); }
      } catch { /* 单批隔离：一批失败不影响其余 */ }
    }
    if (replayed > 0) {
      // 有补决策才 info 一行（**零命中零日志**）；措辞与装配期扫描（lib/index.js）对齐，
      //   便于两条路径在同一日志面上辨认来源。logger 缺省（测试/旧调用方）⇒ 静默，不 throw。
      try {
        cx.logger?.info?.('[dsh-punky-swarm] replay(心跳)：补链推进决策 ' + replayed + ' 处（' + hits.join(',')
          + '）—— 重放只落「待派清单」，真派仍由 Leader/Manager 在工具面执行');
      } catch { /* 日志失败不影响补决策已落盘的事实 */ }
    }
  } catch { /* 扫描面失败不影响心跳 */ }
  return { replayed, batches: hits };
}
