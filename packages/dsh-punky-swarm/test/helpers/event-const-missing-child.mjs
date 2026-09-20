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

// ─────────────────────────────────────────────────────────────────────────────
// R3-4 · `GATE_EVENT_CONST_MISSING` 真 E2E 的**子进程驱动**（被 `gate-event-const-e2e-r34.test.js` 派生）
//
// 为什么必须是子进程：破坏发生在**模块加载期**（loader hook 改写 `event-types.js` 源码），
//   而模块图在进程内**只求值一次** ⇒ 同一进程无法"改后再加载"。故每档破坏 = 一个全新子进程。
//
// 驱动路径（与本包既有 RED 用例 R-01 同一条生产路径，`test/gate-techdebt-red.test.js:277`）：
//   建一条「exec lane 确无 plan 上游 + standalone 事实齐备」的合规批
//   ⇒ `store.setMember(sessionId, batchId, 'e1', 'running')` 派发
//   ⇒ entry 门放行并产 **escape 载荷**（`kind:'standalone'`）
//   ⇒ `setMember` 的统一写盘点调用 `resolveGateEventTypes()` 解析 3 个事件常量
//   ⇒ 常量缺位则 **抛出且不落盘**（atomicWrite 尚未执行）。
//
// 本脚本只**采集事实**（不判绿红）：判定全部在父测试内（避免"子进程自述即通过"）。
//   输出 = stdout 单行 `##R34##{json}`；父测试按前缀取行解析，并**独立复算**批文件 sha256 交叉核验。
//
// 自证义务（防假绿）：`sabotageApplied` —— 点名常量在 import 后确为 `undefined`；
//   未点名（对照档）则三常量皆非空字符串。二者任一不成立 ⇒ 父测试直接判红，
//   绝不让「钩子失效」被误读成「守卫失效 / 守卫是死码」。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createStore } from '../../lib/state/store.js';
import { buildWavePlan } from '../../lib/wave-plan.js';
import * as EVT from '../../lib/state/event-types.js';
import { seedTeamAssetSkills } from './host-skills.mjs';

// 【防线】`node --test` 会把 `test/**` 下**所有**模块当测试文件收集执行（本仓既有惯例：
//   `test/helpers/gate-fixture.mjs` 等各在运行日志里占一条文件级 Subtest）。
//   本文件是**被派生的驱动脚本**、不是用例 ⇒ 无父进程标记时**立即退出**：
//   否则每跑一次全量就会空跑一遍建批并往 stdout 打一行 `##R34##`（噪音；且若建批因环境失败，
//   还会让这个"无断言的空文件测试"报红）。
if (process.env.PSWARM_R34_CHILD !== '1') process.exit(0);

/** 守卫 `resolveGateEventTypes()` 一次解析的三常量（`lib/state/store.js:149-156`）。 */
const GUARDED = ['EVT_GATE_ESCAPE', 'EVT_GATE_DEGRADE', 'EVT_GATE_CONTRACT_MISSING'];
/** 点名要抹掉的常量（空 = 对照档，不破坏）。 */
const names = (process.env.PSWARM_SABOTAGE_CONSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const SID = 's-r34-e2e';
const BATCH = 'r34';
const out = {
  names, sabotaged: {}, control: {}, setup: null, threw: false, message: null,
  weakenGuard: process.env.PSWARM_WEAKEN_GUARD === '1',
};
out.sabotaged = Object.fromEntries(GUARDED.map((n) => [n, typeof EVT[n] === 'string' ? EVT[n] : null]));
out.control.sabotageApplied = names.length === 0
  ? GUARDED.every((n) => typeof EVT[n] === 'string' && EVT[n].length > 0)
  : names.every((n) => EVT[n] === undefined)
    && GUARDED.filter((n) => !names.includes(n)).every((n) => typeof EVT[n] === 'string' && EVT[n].length > 0);

try {
  seedTeamAssetSkills('software-team');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-r34-e2e-'));
  out.root = root;
  const store = createStore(root);

  const execTask = (id, over = {}) => ({
    id, layer: 'exec', role: 'coder', cmd: 'run', deps: ['p1'], consume: ['plan/spec.md'],
    outputs: ['exec/' + id + '.md'], ...over,
  });
  const plan = buildWavePlan({
    batchId: BATCH,
    tasks: [
      execTask('spec1', { deps: [], consume: null, outputs: ['exec/spec.md'] }),
      execTask('e1', { deps: [], consume: null, standalone: true, standaloneReason: '本批确实无 plan 上游' }),
      { id: 'a1', layer: 'audit', role: 'supervisor', cmd: 'accept', deps: ['e1'], consume: [], produce: [] },
    ],
    team: 'software-team',
  });
  store.createBatch(SID, { batchId: BATCH, wavePlan: plan, concurrency: plan.concurrency });

  const b = store.readBatch(SID, BATCH);
  Object.assign(b.lanes, { spec1: 'pending', e1: 'pending', a1: 'pending' });
  b.team = 'software-team';
  b.phase = 'running';
  // `buildWavePlan` 归一化**不保留** `standaloneReason`（`test/gate-techdebt-red.test.js:256` R-01b 实测）
  //   ⇒ 夹具落盘后补写，使 entry 门的 standalone 事实核验可过、被检面收敛为「守卫」单一变量。
  b.wavePlan.flatMap((w) => w.tasks).find((x) => x.id === 'e1').standaloneReason = '本批确实无 plan 上游';

  const batchFile = path.join(root, 'sessions', SID, 'batches', BATCH + '.json');
  fs.writeFileSync(batchFile, JSON.stringify(b, null, 2), 'utf8');
  const artDir = path.join(root, 'sessions', SID, 'artifacts', BATCH, 'exec');
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, 'e1.md'), 'out');

  out.batchFile = batchFile;
  const before = fs.readFileSync(batchFile);
  out.beforeSha = crypto.createHash('sha256').update(before).digest('hex');
  out.setup = { ok: true };

  try {
    store.setMember(SID, BATCH, 'e1', 'running');
  } catch (e) {
    out.threw = true;
    out.message = String(e?.message ?? e);
  }

  const after = fs.readFileSync(batchFile);
  out.afterSha = crypto.createHash('sha256').update(after).digest('hex');
  const disk = JSON.parse(after.toString('utf8'));
  out.lanes = disk.lanes;
  out.events = (disk.events ?? []).map((e) => [e.type ?? null, e.kind ?? null]);
  out.escapeCount = (disk.events ?? []).filter((e) => e.type === 'gate.escape').length;
  // 「零失名事件」：任何 type 非字符串的事件都算污染（守卫要防的正是 `type: undefined`）
  out.undefinedTypeCount = (disk.events ?? []).filter((e) => typeof e.type !== 'string' || e.type.length === 0).length;
} catch (e) {
  out.setup = { ok: false, err: String(e?.stack ?? e?.message ?? e) };
}

process.stdout.write('##R34##' + JSON.stringify(out) + '\n');
