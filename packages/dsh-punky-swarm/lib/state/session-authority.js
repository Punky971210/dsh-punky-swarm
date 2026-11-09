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

// lib/state/session-authority.js —— 会话身份 / 批归属**判定单点**（RQ-1 / D-01 / D-03 / N-04）
//
// 为什么要单点：此前「调用方身份 vs 批归属」的属主比较全仓只有 `state/store/handoff.js` 一处，
//   其余写族工具（`batch_phase` / `batch_control` / `batch_tasks_add` / `task_update` /
//   `member_settle` / `member_set_status` / `lane_dispatch` / `lane_claim` / `lane_release` /
//   `log_export(writeTo)`）**都只把 `session` 当路径参数用** —— 属主隔离完全依赖
//   `sessions/<sid>/batches/<bid>.json` 的目录结构，而 `session` 一旦被外部指定，隔离即失效。
//   ⇒ 一个带 C 档记录的会话（或 MCP 直连）可以指定他人会话 id 直接改写他人批次与成员状态。
//
// 判据位置纪律：本模块只回答「**这个调用方能不能对这条批做写**」这一个问题。
//   路径解析（写到哪里）仍归 `lib/tools/shared.js#sessionOf`；路径合法性归 `lib/state/constants.js`。
//   三者的分工**不得**互相替代或复制第二份（RQ-1 / RQ-3「禁第二套判据」）。
//
// 本模块零本包内部依赖（只读 `dispatch-events.js` 的派发记录读取点，防循环依赖）。

import { workerLanesOf } from './dispatch-events.js';

/** 无调用方会话时的**哨兵值**（B-3 不改：`sessionOfResolved` 的 fallback 级仍返回它）。
 *  它的语义是「**没有**调用方会话」，不是「一个叫 cli 的会话」—— 见 `assertNotSentinelSessionArg`。 */
export const SESSION_SENTINEL = 'cli';

/** 属主门拒码（新增，走既有 `GATE_*` 命名，不新造前缀族）。 */
export const CODE_SESSION_UNAUTHORIZED = 'GATE_SESSION_UNAUTHORIZED';

/** 显式把哨兵当真实会话用的拒码（RQ-5 后半句 / D-03）。 */
export const CODE_SESSION_SENTINEL = 'GATE_SESSION_SENTINEL_NOT_A_SESSION';

export function isSentinelSession(sessionId) {
  return sessionId === SESSION_SENTINEL;
}

/**
 * **身份面**取值单点：调用方会话 id = `exec.agent.session.id`（宿主内 agent 调用形态）。
 *
 * 与**路径面**（`lib/tools/shared.js#sessionOf`，`args.session` 优先）刻意**不对称**，
 *   且方向是防御性的：路径面决定「写哪里」，身份面决定「谁能写」——
 *   二者错位时授权侧看到的是**真实调用方** ⇒ fail-closed（N-04 实测：`handoff_submit` 因此安全）。
 *   ⚠ 后来者**不得**把它「统一成 args 优先」：那一步会把这条不对称从防御性翻成 fail-open。
 *
 * @param {{ agent?: { session?: { id?: unknown } } }} [exec]
 * @returns {string|null} 无身份面（MCP 直连 / CLI / 夹具）⇒ `null`
 */
export function callerSessionIdOf(exec) {
  const sid = exec?.agent?.session?.id;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

/**
 * 批归属属主判定 —— **全仓唯一**的 `callerSessionId === batch.sessionId` 比较点。
 * （`state/store/handoff.js` 的交接授权已改为消费本函数，禁再写第二份比较。）
 *
 * @param {{ sessionId?: unknown }|null|undefined} batch
 * @param {string|null|undefined} callerSessionId
 * @returns {boolean}
 */
export function isBatchOwner(batch, callerSessionId) {
  return Boolean(callerSessionId)
    && typeof batch?.sessionId === 'string'
    && callerSessionId === batch.sessionId;
}

/**
 * 显式 `session` 参数不得取哨兵（RQ-5 后半句 / D-03）。
 *
 * `'cli'` 是「没有调用方会话」的标记。显式把它当会话指定 = 要求引擎「对一个不存在的会话做读写」，
 *   而历史行为是**照做**：`path.join(<root>/sessions,'cli')` + `mkdirSync(recursive)` ⇒ 磁盘上真的
 *   出现 `sessions/cli/batches/*.json`，于是 MCP 直连落下的产物与真实会话产物在目录结构上不可区分，
 *   审计读面无法区隔「谁写的」。
 *
 * ⚠ 只管**显式**一档（`args.session`）。`fallback` 一档（无调用方会话 ⇒ 解析结果就是哨兵）**不动**：
 *   `test/tools.test.js:202-207` 明确要求 fallback 形态下 `wave_plan` 成功且回显 `sessionId:'cli'`，
 *   改它属另一批（需与 e4 的 store 层目录约定一起动）。
 *
 * @param {Record<string, unknown>|null|undefined} args
 * @param {string} where 工具名（进错误文案）
 */
export function assertNotSentinelSessionArg(args, where) {
  const raw = args?.session;
  if (typeof raw === 'string' && raw.length > 0 && isSentinelSession(raw)) {
    throw new Error(CODE_SESSION_SENTINEL + ': ' + where + ' 的显式 `session` 取了哨兵 `' + SESSION_SENTINEL + '`'
      + ' —— 该值表示「**没有**调用方会话」，不是可读写的真实会话（RQ-5：哨兵不得被显式 session 当作真实会话）。'
      + '处置：① 真实会话形态 ⇒ 传该会话 id；② 确定要一个独立黑板书桌 ⇒ 显式命名（如 session:"probe-x"）；'
      + '③ 本就无调用方会话 ⇒ 直接省略 `session`（走 fallback 解析，语义与既有行为一致）。');
  }
}

/**
 * 写族入口**属主门**（D-01 / RQ-1 / RQ-6）。
 *
 * 判定表（四档，全部零写入）：
 *
 * | 调用方身份 | 批是否存在 | 结果 |
 * |---|---|---|
 * | 无（MCP 直连 / CLI / 夹具） | —            | `role:'unidentified'` **放行** —— 没有身份可**比**（不是「跳过校验」而是「无从校验」）；残余风险登记在案 |
 * | 有                          | 否           | `role:'absent'` **放行** —— 交给调用方既有的 `batch not found` 收口（**不改既有错误文案**） |
 * | 有                          | 是，调用方 = `batch.sessionId` | `role:'owner'` 放行 |
 * | 有                          | 是，调用方在该批有 `member.dispatch` 绑定 | `role:'dispatch'` 放行（成员面：worker 只写自己那条 lane 的批） |
 * | 有                          | 是，以上皆否 | **抛 `GATE_SESSION_UNAUTHORIZED`**（越权，零写入） |
 *
 * 为什么「无身份」放行而不是 fail-closed：MCP 直连面（`RESIDENT_TOOL_NAMES` 常驻 7 件）与 CLI
 *   形态**从来**没有 `agent.session`，若在此 fail-closed，常驻面与全部夹具会一并不可用 ——
 *   那是「把工具面关掉」而不是「加授权」。该档的隔离仍由「路径按 `session` 参数构造 + 目录隔离」承担。
 *
 * @param {object} p
 * @param {object} p.store          状态端口（只需 `readBatch`）
 * @param {string} p.sessionId      解析出的落点会话（`sessionOf` 的结果）
 * @param {string} p.batchId        目标批次
 * @param {object} [p.exec]         工具执行上下文（身份面来源）
 * @param {string} [p.where]        工具名，进错误文案
 * @returns {{ok:boolean, role:'unidentified'|'absent'|'owner'|'dispatch', lanes?:string[]}}
 * @throws {Error} `GATE_SESSION_UNAUTHORIZED`：调用方有身份、批存在、且既非 owner 又无派发绑定
 */
export function authorizeBatchWrite({ store, sessionId, batchId, exec, where = 'write' }) {
  const caller = callerSessionIdOf(exec);
  if (!caller) return { ok: true, role: 'unidentified' };
  let batch = null;
  //   读失败**不**当作越权（否则一次 I/O 抖动会变成拒态）；交给调用方既有路径收口。
  try { batch = store?.readBatch?.(sessionId, batchId) ?? null; } catch { batch = null; }
  if (!batch) return { ok: true, role: 'absent' };
  if (isBatchOwner(batch, caller)) return { ok: true, role: 'owner' };
  const lanes = workerLanesOf(batch, caller);
  if (lanes.length > 0) return { ok: true, role: 'dispatch', lanes };
  throw new Error(CODE_SESSION_UNAUTHORIZED + ': ' + where + ' 越权被拒（零写入）—— '
    + '调用方会话 ' + caller + ' 对批次 ' + JSON.stringify(String(batchId)) + '（归属会话 '
    + JSON.stringify(String(batch?.sessionId ?? '')) + '）既非 owner、也无该批的 `member.dispatch` 绑定。'
    + '显式 `session` 只用于「定位自己有权写的落点」，**不得**用于指定他人会话（D-01/RQ-1 属主门）。'
    + '处置：① 写自己的批 ⇒ 省略 `session` 或传自己的会话 id；② 成员写自己那条 lane ⇒ 省略 `session`（走派发绑定解析）；'
    + '③ 确需跨会话治理 ⇒ 由批归属会话（Leader）执行。');
}
