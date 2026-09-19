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

// e3-red-tests（批次 watch-state-surface-r2）——状态面扩面的 **RED 判据**（先于修复落地，当前必须失败）。
//
// 依据：plan/surface-design.md §1 状态域与扫描准入 / §2 判据分派表 / §3 档位分层 / §4 盲跑判据 /
//       §6.1 D6 悬挂成员可见性 + plan/spec.md 验收 B1-B8、C1-C4。
//
// 方法学（红线，不可放宽）：
//   · 判定逻辑**一律由被测代码给出**：本文件只驱动真实导出
//     （createStore / createLaneHeartbeat(...).longrunStatus + tick / createHeartbeatTools /
//      createLongrunTools / createTools → batch_status）；不重写、不 mock、不近似任何判据。
//   · 直写批次 JSON 只用于**铺设状态与时间锚点**（既有 test/watch-heartbeat.test.js W6c 先例），
//     不写入任何判定结果；所有 reason/candidate/state 均由被测函数在断言点实时计算。
//   · 临时根只用 os.tmpdir()；真实批次状态根 ~/.dsh/punky-preset/sessions/** 全程**只读**
//     （R12 的真实样本仅按字节复制进临时根，探针只作用于临时根 ⇒ 零污染）。
//   · 每条用例都配「应当被拒 / 应当不产」的反例，避免自证式断言（防假绿）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import * as mailbox from '../lib/comms/mailbox.js';
import {
  createLaneHeartbeat,
  createHeartbeatTools,
  createLongrunTools,
  LONGRUN_DEFAULTS,
  LONGRUN_REASON,
  LONGRUN_REASON_EXEMPT_ACTIVE,
} from '../lib/watch/lane-heartbeat.js';
import { createTools } from '../lib/tools/register.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const mkRoot = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const ctx = { tools: { register: () => {} } };

// §3 统计口径表达式（design 逐字）：正常长跑候选数 = count(candidate ∧ state==='running' ∧ exempt == null ∧ !specialTask)
//   任何把 T1x（豁免）/ T3（paused）/ T5（盲跑）/ T6（悬挂）计入 T1 的表达都视为口径错误（验收项 C4）。
const isNormalLongrunCandidate = (v) => v.candidate === true
  && v.state === 'running'
  && (v.exempt ?? null) === null
  && v.specialTask !== true;

// 夹具：经真实 store 写面建批 → 直写镜像铺设 lanes / 事件锚点 / 豁免表（只铺状态与时间）。
function seedBatch({ S, batchId, tasks, decide }) {
  const root = mkRoot('punky-wsr-');
  const store = createStore(root);
  const plan = buildWavePlan({ batchId, tasks });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'planning' });
  const file = store.batchFile(S, batchId);
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  decide(b);
  fs.writeFileSync(file, JSON.stringify(b, null, 2));
  const engine = (opts = {}) => createLaneHeartbeat({ store, mailbox, root, ...opts });
  return { root, store, S, batchId, engine, exec: { agent: { session: { id: S } } } };
}

// ---- 真实样本定位（只读）：gate-regression-audit / a1-audit-verdict（§6.1 具名验收样本）----
// 注意：isolated-home.preload 会把 USERPROFILE/HOME 重定向到隔离根，故真实 home 必须经 os.userInfo()
//   取（preload 自身即以此方式自检「不许撞真实 home」）；全程只读，不做任何写入。
const REAL_SESSIONS_DIR = (() => {
  try { return path.join(os.userInfo().homedir, '.dsh', 'punky-preset', 'sessions'); } catch { return null; }
})();
function findRealSample() {
  try {
    if (!REAL_SESSIONS_DIR || !fs.existsSync(REAL_SESSIONS_DIR)) return null;
    for (const s of fs.readdirSync(REAL_SESSIONS_DIR)) {
      const f = path.join(REAL_SESSIONS_DIR, s, 'batches', 'gate-regression-audit.json');
      if (fs.existsSync(f)) return f;
    }
  } catch { /* 只读探测失败 → 退回合成等价夹具 */ }
  return null;
}

// 悬挂成员夹具：优先把**真实样本字节**复制进临时根（保真），取其形状兜底；
//   backdateMs 非空时把全部事件 ts 前推，制造「末事件早于 24h」的僵尸批形态（覆盖 §1.2「悬挂视图不受僵尸过滤」）。
function danglingFixture({ backdateMs = null } = {}) {
  const S = 'sess-wsr-dangling';
  const batchId = 'gate-regression-audit';
  const root = mkRoot('punky-wsr-dangling-');
  const store = createStore(root);
  const dir = path.join(root, 'sessions', S, 'batches');
  fs.mkdirSync(dir, { recursive: true });
  const real = findRealSample();
  const b = real
    ? JSON.parse(fs.readFileSync(real, 'utf8'))
    : {
      schema: 3,
      sessionId: S,
      batchId,
      phase: 'aborted',
      lanes: { 'p1-survey-spec': 'merged', 'a1-audit-verdict': 'idle' },
      wavePlan: [],
      events: [{ ts: iso(Date.now() - 2 * HOUR), type: 'batch.phase', from: 'running', to: 'aborted' }],
    };
  const at = Date.now() - (backdateMs ?? 2 * HOUR);
  b.events = (b.events ?? []).map((e) => ({ ...e, ts: iso(at) }));
  if (b.events.length === 0) b.events = [{ ts: iso(at), type: 'batch.phase', from: 'running', to: 'aborted' }];
  b.updatedAt = iso(at);
  fs.writeFileSync(path.join(dir, batchId + '.json'), JSON.stringify(b, null, 2));
  return {
    root, store, S, batchId, real,
    engine: (opts = {}) => createLaneHeartbeat({ store, mailbox, root, ...opts }),
    exec: { agent: { session: { id: S } } },
  };
}

// =====================================================================================
// RS-1 · 状态面扩面（C-2 / D1 / R1 / R2）——非 running 态必须出现在探针输出
// =====================================================================================
test('RS-1 [C-2/D1/R1/R2] review/idle/pending 态须出现在探针输出（不得短路为 lane-not-running）', async () => {
  // ⚠ idle 语义（**用户裁决 Q-H，2026-09-14，写死不得曲解**）：蟛蜞的 `idle` = **崩溃恢复落位态**
  //   （宿主重启/异常退出后，in-flight 的 running/review lane 被 store.recoverBatches() 落 idle——
  //   见 lib/state/store.js:698-743），**不是** JiuwenSwarm 的「静息常驻态」（READY/PAUSED，那边明文「不得催促」）。
  //   dsh 对子 Agent 的设计是**单次即弃置**（可拉起 continuable 成员，但大多时候不使用已有成员续跑），
  //   与 JiuwenSwarm「受管理的单 Agent、拉起即永续」**不属同一生态位**。
  //   ⇒ 本条只核 idle 的 **state/reason 可见性与判据归属**；**不得**据此推导「idle 超时即催促成员」，
  //   更**不得**把 idle 时长当作 running 长跑的主判据（该负例见 RS-2 (f)）。
  const nowTs = Date.now();
  const at = nowTs - 3 * HOUR;
  const f = seedBatch({
    S: 'sess-wsr-1',
    batchId: 'b-wsr-1',
    tasks: ['l-run', 'l-rev', 'l-idle', 'l-pend', 'l-merged'].map((id) => ({ id, cmd: 'work', outputs: ['exec/' + id + '/out.txt'] })),
    decide: (b) => {
      b.phase = 'running';
      b.lanes = { 'l-run': 'running', 'l-rev': 'review', 'l-idle': 'idle', 'l-pend': 'pending', 'l-merged': 'merged' };
      b.events = [
        { ts: iso(at), type: 'batch.phase', from: 'planning', to: 'running' },
        { ts: iso(at), type: 'member.dispatch', lane: 'l-run' },
        { ts: iso(at), type: 'member.settled', lane: 'l-rev', from: 'running', to: 'review' },
        { ts: iso(at), type: 'member.settled', lane: 'l-idle', from: 'running', to: 'idle' },
        { ts: iso(at), type: 'member.settled', lane: 'l-merged', from: 'review', to: 'merged' },
      ];
    },
  });
  const engine = f.engine();
  const expectRows = ['l-idle', 'l-pend', 'l-rev', 'l-run'];

  // (a) judge 面：非 running 态必须给出自身 state，且**不得**短路成 lane-not-running
  const rev = engine.longrunStatus(f.S, f.batchId, 'l-rev', nowTs);
  assert.equal(rev.state, 'review', 'D2：review 态必须透出 state（当前 lib/watch/lane-heartbeat.js:254 直接 return reason=lane-not-running）');
  assert.notEqual(rev.reason, 'lane-not-running', 'C-2：lane-not-running 短路必须删除（§1.2）');
  const idle = engine.longrunStatus(f.S, f.batchId, 'l-idle', nowTs);
  assert.equal(idle.state, 'idle', 'D2：idle 态必须透出 state');
  assert.notEqual(idle.reason, 'lane-not-running', 'C-2：idle 不得短路为 lane-not-running');
  const pend = engine.longrunStatus(f.S, f.batchId, 'l-pend', nowTs);
  assert.equal(pend.state, 'pending', 'D2：pending 态必须透出 state');
  assert.notEqual(pend.reason, 'lane-not-running', 'C-2：pending 不得短路为 lane-not-running');

  // (b) 工具面（lane_longrun）：缺省 lane 过滤须按状态（§1.2 应删 :804/:870 的「仅 running」）
  const [lrTool] = createLongrunTools(ctx, { store: f.store, root: f.root, config: { capabilities: { watch: { enabled: true } } }, heartbeat: engine });
  const lq = await lrTool.execute({ batchId: f.batchId }, f.exec);
  assert.deepEqual(
    lq.lanes.map((r) => r.lane).sort(),
    expectRows,
    'C-2/§6.1：lane_longrun 缺省过滤须返回全部**非终态** lane（终态 merged 排除）。'
      + '当前 lane-heartbeat.js:870 仅 filter(l => batch.lanes[l] === \'running\')。实际=' + JSON.stringify(lq.lanes.map((r) => r.lane)),
  );
  for (const row of lq.lanes) {
    assert.equal(typeof row.state, 'string', 'D2/A 栏③：lane_longrun 输出须含 state 字段（lane=' + row.lane + '）');
  }

  // (c) 工具面（lane_heartbeat）：同上，缺省过滤 + state 字段透出（§6.1 A 栏②③）
  const [hbTool] = createHeartbeatTools(ctx, { store: f.store, root: f.root, config: { capabilities: { watch: { enabled: true } } }, heartbeat: engine });
  const hq = await hbTool.execute({ batchId: f.batchId }, f.exec);
  assert.deepEqual(
    hq.lanes.map((r) => r.lane).sort(),
    expectRows,
    'C-2/§6.1：lane_heartbeat 缺省过滤须返回全部非终态 lane（当前 lane-heartbeat.js:804 仅 running）',
  );
  for (const row of hq.lanes) {
    assert.equal(typeof row.state, 'string', 'D2/A 栏③：lane_heartbeat 输出须含 state 字段（lane=' + row.lane + '）');
  }
});

// =====================================================================================
// RS-2 · 判据分派（D1 / B2）——review「待结算时长」≠ running「总时长 + 无进展窗」
//   口径（用户裁决 Q-H，2026-09-14）：dsh 子 Agent 单次即弃置、单步任务 ⇒ **总时长即任务时长**；
//   `running` 的长跑判据 = **总时长（当前 stint）** 20min 基准 + 5min 无进展窗；
//   **不得**引入「idle 时长 / 无活动时长」作 running 的主判据（那是 JiuwenSwarm 生态位语义，dsh 下不适用）。
//   本用例既证 review 与 running 判据**不同源**，又以 (f) 负例证「用 idle 时长判 running」是错的。
// =====================================================================================
test('RS-2 [D1/B2] review 用「待结算时长」、running 用「总时长 + 无进展窗」——两态判据必须可区分（不是同一把尺）', () => {
  const nowTs = Date.now();
  const at = nowTs - 3 * HOUR;
  const cp = nowTs - 1_000; // 新鲜 checkpoint（远小于 noProgressWindowMs=5min）
  // (f) 负例夹具用：该 lane 先经**5h30m 的 idle 段落位**（崩溃恢复），随后才被恢复重派为 running 仅 60s。
  const idleLandedAt = nowTs - 5.5 * HOUR;
  const redispatchAt = nowTs - 60_000;
  const f = seedBatch({
    S: 'sess-wsr-2',
    batchId: 'b-wsr-2',
    tasks: ['l-rev', 'l-rev-cp', 'l-run', 'l-run-cp', 'l-run-idle'].map((id) => ({ id, cmd: 'work', outputs: ['exec/' + id + '/out.txt'] })),
    decide: (b) => {
      b.phase = 'running';
      b.lanes = { 'l-rev': 'review', 'l-rev-cp': 'review', 'l-run': 'running', 'l-run-cp': 'running', 'l-run-idle': 'running' };
      b.events = [
        { ts: iso(at), type: 'batch.phase', from: 'planning', to: 'running' },
        { ts: iso(at), type: 'member.settled', lane: 'l-rev', from: 'running', to: 'review' },
        { ts: iso(at), type: 'member.settled', lane: 'l-rev-cp', from: 'running', to: 'review' },
        { ts: iso(at), type: 'member.dispatch', lane: 'l-run' },
        { ts: iso(at), type: 'member.dispatch', lane: 'l-run-cp' },
        // 两条 review/running lane 各带一条**新鲜** checkpoint：若判据是「无活动」，两条都不该产。
        { ts: iso(cp), type: 'worktree.checkpoint', lane: 'l-rev-cp', step: 1, total: 2 },
        { ts: iso(cp), type: 'worktree.checkpoint', lane: 'l-run-cp', step: 1, total: 2 },
        // l-run-idle：6h 前首派 → 5h30m 前崩溃恢复落 idle → 60s 前**恢复重派**（新 stint）
        { ts: iso(nowTs - 6 * HOUR), type: 'member.dispatch', lane: 'l-run-idle' },
        { ts: iso(idleLandedAt), type: 'member.settled', lane: 'l-run-idle', from: 'running', to: 'idle' },
        { ts: iso(redispatchAt), type: 'member.dispatch', lane: 'l-run-idle' },
      ];
    },
  });
  const engine = f.engine();

  const rev = engine.longrunStatus(f.S, f.batchId, 'l-rev', nowTs);
  const revCp = engine.longrunStatus(f.S, f.batchId, 'l-rev-cp', nowTs);
  const run = engine.longrunStatus(f.S, f.batchId, 'l-run', nowTs);
  const runCp = engine.longrunStatus(f.S, f.batchId, 'l-run-cp', nowTs);

  // (a) review + 无活动 → 产「待结算时长」档
  assert.equal(rev.state, 'review');
  assert.equal(rev.reason, 'review-awaiting-settle', '§2：review 判据 reason 码须为 review-awaiting-settle');
  assert.equal(typeof rev.stateAnchorTs, 'string', 'D2：须透出 stateAnchorTs（review 锚点=最近一次 →review 迁移 ts）');
  assert.equal(Date.parse(rev.stateAnchorTs), at, '§2：review 计时锚点=最近一次 →review 迁移事件 ts');
  assert.equal(typeof rev.stateResidentMs, 'number', 'D2：须透出 stateResidentMs');

  // (b) **关键判别**：review 带新鲜 checkpoint 仍必须产 —— §2 明文「review 待结算时长（**禁**用『无活动』判）」
  assert.equal(revCp.reason, 'review-awaiting-settle', '§2：review 判据必须忽略活动新鲜度（明文禁用「无活动」判）；'
    + '若此处收到 activity-fresh / checkpoint-fresh / 无产出，即证明仍在用「无活动」一把尺');
  assert.equal(revCp.checkpointFresh, true, '（前件核对）该 lane 的 checkpoint 确实新鲜，故本分支才有判别力');

  // (c) running + 无活动 → 产既有长跑候选（守恒：Q-C 基准 20min + 5min 无进展窗）
  assert.equal(run.state, 'running');
  assert.equal(run.candidate, true, '守恒：running 越 maxDurationMs 且三窗皆不新鲜 ⇒ 候选');
  assert.equal(run.reason, LONGRUN_REASON);
  assert.equal(run.durationMs, 3 * HOUR, 'Q-H：running 的时长口径 = **总时长**（当前 stint：最近一次 member.dispatch 起算）');

  // (d) running + 新鲜 checkpoint → 不得产（守恒：无进展窗保留，R15 既有不回归）
  assert.equal(runCp.candidate, false, '守恒：running 侧无进展窗必须保留（新鲜 checkpoint ⇒ 不产）');

  // (e) 两态判据不同源：reason 必须不同（同尺子实现必在此失败）
  assert.notEqual(rev.reason, run.reason, '§2 假绿检查：review 与 running 的 reason 必须不同');

  // (f) **Q-H 负例（本轮用户裁决）**：用「idle 时长 / 无活动时长」判 running 长跑是**错的**。
  //     该 lane 的 idle 段落位距今 5h30m（远超任何阈值），但**新 stint 总时长仅 60s** ⇒ 正确判据下**不产**候选。
  //     若实现（错误地）改用 idle 时长 / 「距上次活动时长」作 running 的主判据，5h30m 会让它误产候选 ⇒ 本分支失败。
  const ridle = engine.longrunStatus(f.S, f.batchId, 'l-run-idle', nowTs);
  assert.equal(ridle.state, 'running');
  assert.equal(ridle.durationMs, 60_000, 'Q-H：durationMs 锚点必须是**最近一次 member.dispatch**（新 stint 总时长=60s）；'
    + '取 idle 落位 ts（5h30m）即证明误用了 idle 时长作 running 判据');
  assert.equal(ridle.candidate, false, 'Q-H 负例：总时长 60s < 20min 基准 ⇒ running **不产**候选；'
    + '若按 idle 时长（5h30m）判则会误产 ⇒ 该判据在 dsh 生态位下不适用（子 Agent 单次即弃置、单步任务 ⇒ 总时长即任务时长）');
});

// =====================================================================================
// RS-3 · pending 未派发时长（D1 / R3）+ planning 反例
// =====================================================================================
test('RS-3 [D1/R3] pending 计时锚点=batch→running；批次仍 planning ⇒ 不产', () => {
  const nowTs = Date.now();
  const runningAt = nowTs - 25 * 60_000; // 25min > pendingWindowMs 建议基准 20min
  const f = seedBatch({
    S: 'sess-wsr-3',
    batchId: 'b-wsr-3-run',
    tasks: [{ id: 'l-pend', cmd: 'work', outputs: ['exec/l-pend/out.txt'] }],
    decide: (b) => {
      b.phase = 'running';
      b.lanes = { 'l-pend': 'pending' };
      b.events = [{ ts: iso(runningAt), type: 'batch.phase', from: 'planning', to: 'running' }];
    },
  });
  const engine = f.engine();
  const v = engine.longrunStatus(f.S, f.batchId, 'l-pend', nowTs);
  assert.equal(v.state, 'pending');
  assert.equal(v.reason, 'pending-undispatched', '§2：pending 判据 reason 码须为 pending-undispatched（当前无该判据）');
  assert.equal(Date.parse(v.stateAnchorTs), runningAt, '§2：pending 锚点 = 最近 batch.phase→running 事件 ts（**不是** member.dispatch —— pending lane 无 dispatch）');

  // 反例：批次仍 planning ⇒ 期后端未派发，**不得**产（§1.2 准入矩阵）
  const f2 = seedBatch({
    S: 'sess-wsr-3b',
    batchId: 'b-wsr-3-plan',
    tasks: [{ id: 'l-pend', cmd: 'work', outputs: ['exec/l-pend/out.txt'] }],
    decide: (b) => {
      b.phase = 'planning';
      b.lanes = { 'l-pend': 'pending' };
      b.events = [{ ts: iso(nowTs - 3 * HOUR), type: 'batch.created' }];
    },
  });
  const v2 = f2.engine().longrunStatus(f2.S, f2.batchId, 'l-pend', nowTs);
  assert.notEqual(v2.reason, 'pending-undispatched', '§1.2：planning 批不得产 pending 判据（不扫成员）');
  assert.equal(v2.candidate, false, '§1.2：planning 批不得产候选');
});

// =====================================================================================
// RS-4 · paused 独立滞留档（Q-B / R4）——不是长跑候选
// =====================================================================================
test('RS-4 [Q-B/R4/D1] paused 批次须产独立提示档 paused-awaiting-decision，且不计入正常长跑候选', () => {
  const nowTs = Date.now();
  const runAt = nowTs - 4 * HOUR;
  const pausedAt = nowTs - 3 * HOUR;
  const f = seedBatch({
    S: 'sess-wsr-4',
    batchId: 'b-wsr-4',
    tasks: [{ id: 'l-run', cmd: 'work', outputs: ['exec/l-run/out.txt'] }],
    decide: (b) => {
      b.phase = 'paused';
      b.lanes = { 'l-run': 'running' };
      b.events = [
        { ts: iso(runAt), type: 'batch.phase', from: 'planning', to: 'running' },
        { ts: iso(runAt), type: 'member.dispatch', lane: 'l-run' },
        { ts: iso(pausedAt), type: 'batch.phase', from: 'running', to: 'paused' },
      ];
    },
  });
  const v = f.engine().longrunStatus(f.S, f.batchId, 'l-run', nowTs);
  assert.equal(v.state, 'paused', 'D1：paused 须有自身 state 档（当前 lib/watch/lane-heartbeat.js:255 短路为 batch-not-running）');
  assert.equal(v.reason, 'paused-awaiting-decision', '§2：paused 判据 reason 码须为 paused-awaiting-decision');
  assert.equal(Date.parse(v.stateAnchorTs), pausedAt, '§2：paused 锚点 = 最近 batch.phase→paused 事件 ts');
  assert.equal(isNormalLongrunCandidate(v), false, '§3 统计口径：T3（paused 滞留）**不计入**正常长跑候选（Q-B：不并入长跑判据）');
  assert.notEqual(v.reason, LONGRUN_REASON, 'Q-B：paused 档不得复用长跑候选判据 reason');
});

// =====================================================================================
// RS-5 · 豁免特殊档（D3 / Q-C / R6）——独立档位 + single 标注 + 不混入正常长跑统计
// =====================================================================================
test('RS-5 [D3/Q-C/R6] 豁免 lane 走 T1x 独立档（specialTask）且不混入正常长跑统计', () => {
  const nowTs = Date.now();
  const at = nowTs - 5 * HOUR;
  const f = seedBatch({
    S: 'sess-wsr-5',
    batchId: 'b-wsr-5',
    tasks: ['l-norm', 'l-ex-mid', 'l-ex-over'].map((id) => ({ id, cmd: 'work', outputs: ['exec/' + id + '/out.txt'] })),
    decide: (b) => {
      b.phase = 'running';
      b.lanes = { 'l-norm': 'running', 'l-ex-mid': 'running', 'l-ex-over': 'running' };
      b.laneExempt = {
        'l-ex-mid': { grantedAt: iso(at), grantedFrom: 'pending', type: 'ai-render', multiplier: 8, stalled: true },
        'l-ex-over': { grantedAt: iso(at), grantedFrom: 'pending', type: 'ai-render', multiplier: 8, stalled: true },
      };
      b.events = [
        { ts: iso(at), type: 'batch.phase', from: 'planning', to: 'running' },
        { ts: iso(nowTs - 3 * HOUR), type: 'member.dispatch', lane: 'l-norm' },   // 180min > 20min基准
        { ts: iso(nowTs - 30 * 60_000), type: 'member.dispatch', lane: 'l-ex-mid' }, // 30min：> 20min 但 < 160min（8×20min）
        { ts: iso(nowTs - 4 * HOUR), type: 'member.dispatch', lane: 'l-ex-over' },   // 240min > 160min：越放宽后阈值
      ];
    },
  });
  const engine = f.engine();
  const norm = engine.longrunStatus(f.S, f.batchId, 'l-norm', nowTs);
  const mid = engine.longrunStatus(f.S, f.batchId, 'l-ex-mid', nowTs);
  const over = engine.longrunStatus(f.S, f.batchId, 'l-ex-over', nowTs);

  // 守恒（当前即绿）：豁免未越放宽阈值 ⇒ 不产，reason=exempt-active
  assert.equal(mid.candidate, false, '守恒：豁免未越放宽后阈值 ⇒ 不产');
  assert.equal(mid.reason, LONGRUN_REASON_EXEMPT_ACTIVE, '守恒：reason 码 exempt-active 一字不改');

  // T1x 独立档（本批新增；当前 specialTask 字段不存在 ⇒ RED）
  assert.equal(over.exempt?.type, 'ai-render', 'Q-C：豁免记录须透出');
  assert.equal(over.thresholdMultiplier, 8, 'Q-C：豁免倍率须透出（只放宽时长阈值）');
  assert.equal(over.effectiveMaxDurationMs, 8 * LONGRUN_DEFAULTS.maxDurationMs, 'Q-C：effectiveMaxDurationMs = maxDurationMs × 倍率');
  assert.equal(over.specialTask, true, '§3/D3：豁免越阈必须走 T1x 独立档并单独标注 specialTask:true（当前无该字段）');

  // 统计口径（§3 表达式，验收项 C4）：T1 只含未豁免的 running 候选
  const t1 = [norm, mid, over].filter(isNormalLongrunCandidate).map((v) => v.lane);
  assert.deepEqual(t1, ['l-norm'], '§3 统计口径：正常长跑候选 = count(candidate ∧ state=running ∧ exempt==null ∧ !specialTask)；'
    + '豁免档（T1x）不得混入。实际=' + JSON.stringify(t1));
});

// =====================================================================================
// RS-6 · 盲跑 BR-1 空依赖在跑（C-3 / D4 / R7）
// =====================================================================================
test('RS-6 [D4/BR-1/R7] 空依赖在跑 ⇒ 候选 blind-run-no-deps；wavePlan 缺该项 ⇒ 不产', () => {
  const nowTs = Date.now();
  const at = nowTs - 3 * HOUR;
  const f = seedBatch({
    S: 'sess-wsr-6',
    batchId: 'b-wsr-6',
    tasks: [{ id: 'l-blind', cmd: 'work', consume: [], deps: [], outputs: ['exec/l-blind/out.txt'] }],
    decide: (b) => {
      b.phase = 'running';
      b.lanes = { 'l-blind': 'running', 'l-absent': 'running' }; // l-absent 故意不登记进 wavePlan
      b.events = [
        { ts: iso(at), type: 'batch.phase', from: 'planning', to: 'running' },
        { ts: iso(at), type: 'member.dispatch', lane: 'l-blind' },
        { ts: iso(at), type: 'member.dispatch', lane: 'l-absent' },
      ];
    },
  });
  const engine = f.engine();
  const v = engine.longrunStatus(f.S, f.batchId, 'l-blind', nowTs);
  assert.equal(v.reason, 'blind-run-no-deps', '§4.1 BR-1：consume 空 ∧ deps 空 ∧ 在跑越宽限 ⇒ 候选 blind-run-no-deps（当前无该判据）');
  assert.equal(v.candidate, true, '§4.1：BR-1 产出为**候选**');

  // 反例：wavePlan 缺该项 ⇒ 不得产 BR-1（记 unverified，零静默）
  const v2 = engine.longrunStatus(f.S, f.batchId, 'l-absent', nowTs);
  assert.notEqual(v2.reason, 'blind-run-no-deps', '§4.1 反例：wavePlan 缺该 lane ⇒ 不产 BR-1（零静默：以 unverified 记账，不猜）');
});

// =====================================================================================
// RS-7 · 盲跑 BR-2 上游产物运行期消失（C-3 / D4 / R8）+ 派发时不可解析的反例
// =====================================================================================
test('RS-7 [D4/BR-2/R8] 上游产物派发时可解析、探针时消失 ⇒ 候选；派发时亦不可解析 ⇒ 不产（转 BR-3）', () => {
  const root = mkRoot('punky-wsr-7-');
  const store = createStore(root);
  const S = 'sess-wsr-7';
  const batchId = 'b-wsr-7';
  const t0 = Date.now() - 3 * HOUR; // 派发时刻
  const plan = buildWavePlan({
    batchId,
    tasks: [
      { id: 'l-br2', cmd: 'work', consume: ['exec/up/out.txt'], outputs: ['exec/l-br2/out.txt'] },
      { id: 'l-br3', cmd: 'work', consume: ['exec/never/out.txt'], outputs: ['exec/l-br3/out.txt'] },
    ],
  });
  store.createBatch(S, { batchId, wavePlan: plan, phase: 'planning' });
  const file = store.batchFile(S, batchId);
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  b.phase = 'running';
  b.lanes = { 'l-br2': 'running', 'l-br3': 'running' };
  b.events = [
    { ts: iso(t0), type: 'batch.phase', from: 'planning', to: 'running' },
    { ts: iso(t0), type: 'member.dispatch', lane: 'l-br2' },
    { ts: iso(t0), type: 'member.dispatch', lane: 'l-br3' },
  ];
  fs.writeFileSync(file, JSON.stringify(b, null, 2));

  // 派发时刻上游产物**可解析**（存在且非空）——见 §4.1 路径解析口径 resolveArtifact
  const up = path.join(store.artifactsDirOf(S, batchId), 'exec', 'up', 'out.txt');
  fs.mkdirSync(path.dirname(up), { recursive: true });
  fs.writeFileSync(up, 'upstream-v1');

  // 注入可控时钟：① 让「首个 tick 观测」落在派发之后（可解析）；② 探针时刻与观测相隔 > noProgressWindowMs，
  //   以排除「心跳 entry 的 fresh 宽限」这一无关变量（否则 activity-fresh 会掩盖 BR 判据本身是否成立）。
  let fake = t0 + 60_000;
  const engine = createLaneHeartbeat({ store, mailbox, root, now: () => fake });
  engine.tick(); // 派发后的**首个 tick 观测**：此处制品可解析（BR-2 的证据来源，§4.1）
  fs.rmSync(up, { force: true }); // 运行期消失
  fake = t0 + 3 * HOUR;
  engine.tick(); // 探针时刻：不可解析
  const nowTs = fake;

  const v2 = engine.longrunStatus(S, batchId, 'l-br2', nowTs);
  assert.equal(v2.reason, 'blind-run-upstream-missing', '§4.1 BR-2：派发时可解析 ∧ 探针时不可解析 ⇒ 候选 blind-run-upstream-missing（当前无该判据）');
  assert.equal(v2.candidate, true, '§4.1：BR-2 产出为**候选**');

  const v3 = engine.longrunStatus(S, batchId, 'l-br3', nowTs);
  assert.notEqual(v3.reason, 'blind-run-upstream-missing', '§4.1 反例：派发时刻亦不可解析（本来就没有）⇒ 不得产 BR-2，须转 BR-3');
});

// =====================================================================================
// RS-8 · 盲跑 BR-3 上游从未就绪（提示档）+ 带豁免的反例
// =====================================================================================
test('RS-8 [D4/BR-3/R9] 上游从未就绪 ⇒ 提示档（非候选）；带豁免标注 ⇒ 不产', () => {
  const nowTs = Date.now();
  const at = nowTs - 3 * HOUR;
  const f = seedBatch({
    S: 'sess-wsr-8',
    batchId: 'b-wsr-8',
    tasks: [
      { id: 'l-br3a', cmd: 'work', consume: ['exec/never-a/out.txt'], outputs: ['exec/l-br3a/out.txt'] },
      { id: 'l-br3b', cmd: 'work', consume: ['exec/never-b/out.txt'], outputs: ['exec/l-br3b/out.txt'] },
    ],
    decide: (b) => {
      b.phase = 'running';
      b.lanes = { 'l-br3a': 'running', 'l-br3b': 'running' };
      b.laneExempt = { 'l-br3b': { grantedAt: iso(at), grantedFrom: 'pending', type: 'dep-install', multiplier: 4, stalled: true } };
      b.events = [
        { ts: iso(at), type: 'batch.phase', from: 'planning', to: 'running' },
        { ts: iso(at), type: 'member.dispatch', lane: 'l-br3a' },
        { ts: iso(at), type: 'member.dispatch', lane: 'l-br3b' },
      ];
    },
  });
  const engine = f.engine();
  const a = engine.longrunStatus(f.S, f.batchId, 'l-br3a', nowTs);
  assert.equal(a.reason, 'blind-run-upstream-never-ready', '§4.1 BR-3：上游产物从未可解析 ∧ 无豁免 ⇒ 提示档 blind-run-upstream-never-ready（当前无该判据）');
  assert.equal(a.candidate, false, '§4.1 产出列：BR-3 是**提示档**（非候选）⇒ candidate 不得为 true');
  assert.equal(isNormalLongrunCandidate(a), false, '§3/C4：T5 盲跑提示档不得计入正常长跑统计');

  // 反例：该 lane 已带豁免/长程标注 ⇒ 不产 BR-3
  const bv = engine.longrunStatus(f.S, f.batchId, 'l-br3b', nowTs);
  assert.notEqual(bv.reason, 'blind-run-upstream-never-ready', '§4.1 反例：已带 exempt 标注 ⇒ 不产 BR-3（豁免即已声明长程意图）');
});

// =====================================================================================
// RS-9 · D6 悬挂成员可见（终态批 + 非终态 lane）+ 不受 24h 僵尸过滤（R12 / B7）
// =====================================================================================
test('RS-9 [D6/R12/B7] 终态批的非终态 lane 须可读，且不受僵尸批 24h 过滤', async () => {
  const cases = [
    { backdateMs: null, label: '真实样本原时间' },
    { backdateMs: 30 * HOUR, label: '末事件前推 30h（超 24h 僵尸过滤窗）' },
  ];
  for (const c of cases) {
    const f = danglingFixture({ backdateMs: c.backdateMs });
    const engine = f.engine();
    engine.tick(); // 终态批：当前实现走 dropBatchEntries + continue ⇒ 全视图不可见
    const [hbTool] = createHeartbeatTools(ctx, { store: f.store, root: f.root, config: { capabilities: { watch: { enabled: true } } }, heartbeat: engine });
    const q = await hbTool.execute({ batchId: f.batchId }, f.exec);
    const row = q.lanes.find((r) => r.lane === 'a1-audit-verdict');
    assert.ok(
      row,
      '[' + c.label + '] D6/R12：终态批中的非终态 lane 必须出现在只读查询面（样本 gate-regression-audit / a1-audit-verdict）。'
        + '实际 lanes=' + JSON.stringify(q.lanes.map((r) => r.lane)),
    );
    assert.equal(row.dangling, true, '[' + c.label + '] §3 T6：悬挂项须显式标注 dangling:true');
    assert.equal(row.reason, 'dangling-member', '[' + c.label + '] §2：悬挂成员 reason 码须为 dangling-member');
    assert.equal(isNormalLongrunCandidate(row), false, '[' + c.label + '] §3：T6 悬挂视图不计入正常长跑统计');

    // 不产候选（终态批「只出悬挂视图、不产任何候选」）
    const b = f.store.readBatch(f.S, f.batchId);
    assert.equal(
      b.events.filter((e) => e.type === 'lane.longrun.candidate' && e.lane === 'a1-audit-verdict').length,
      0,
      '[' + c.label + '] D6：终态批不得产候选',
    );
  }
});

// =====================================================================================
// RS-10 · D6 对外派生视图（batch_status.danglingLanes / lanesState，§6.1 ④·B 栏）
//   注：§6.1 标注 B 栏「可否缓做 = 是」——若 Leader 裁定缓做，本条按 a1 gap-list 记为
//   「D6 未闭环」，不得静默降级；本 lane 按 §W 第 14 行（写者 e2）保留 RED。
// =====================================================================================
test('RS-10 [D6/§6.1-④] batch_status 须新增 danglingLanes / lanesState（终态批非终态 lane 恒显）', async () => {
  const f = danglingFixture({ backdateMs: null });
  const { tools } = createTools({ tools: { register: () => {} }, logger: console }, { store: f.store, root: f.root });
  const bs = Object.fromEntries(tools.map((t) => [t.name, t]))['batch_status'];
  const r = await bs.execute({ batchId: f.batchId }, f.exec);
  assert.equal(r.lanes?.['a1-audit-verdict'], 'idle', '（前件）原始 lanes 映射须保留（零破坏：D6「原 lanes 保留」）');
  assert.equal(r.lanesState?.['a1-audit-verdict'], 'idle', 'D6：batch_status 须新增 lanesState（lane→state 映射）；当前 lib/tools/core.js:319-329 无该键');
  assert.ok(Array.isArray(r.danglingLanes), 'D6：batch_status 须新增 danglingLanes 数组；当前无该键');
  assert.ok(r.danglingLanes.includes('a1-audit-verdict'), 'D6：悬挂 lane 须列入 danglingLanes（终态批恒显，不受 24h 过滤）');
  assert.equal(r.danglingLanes.includes('p1-survey-spec'), false, 'D6 反例：终态 lane（merged）不得被列为悬挂');
});

// =====================================================================================
// RS-11 · D7 豁免继承（R13 / §6.2）——idle 恢复重派不得静默清退
//   ⚠ 定位（用户裁决 Q-H + 先前澄清）：dsh 对子 Agent 是**单次即弃置**，**大多时候不使用已有成员续跑**；
//   「唤醒/续跑已空闲成员」属**少数场景**，主场景是**返工续跑**（review→running 叫回原成员）。
//   ⇒ 本条不主张唤醒为高频主路径，只核**确凿存在的那条缺陷**：恢复重派会清退旧豁免（store.js:461 静默清退）。
// =====================================================================================
test('RS-11 [D7/R13/§6.2] idle 恢复重派（不带 exempt）后旧豁免不得被静默清退', () => {
  const f = seedBatch({
    S: 'sess-wsr-11',
    batchId: 'b-wsr-11',
    tasks: [{ id: 'l-task', cmd: 'work', outputs: ['exec/l-task/out.txt'] }],
    decide: (b) => {
      b.phase = 'running';
      b.lanes = { 'l-task': 'pending' };
      b.events = [{ ts: iso(Date.now() - 4 * HOUR), type: 'batch.created' }];
    },
  });
  const { store, S, batchId } = f;
  store.setMember(S, batchId, 'l-task', 'running', null, { type: 'ai-render' });
  assert.ok(store.readBatch(S, batchId).laneExempt?.['l-task'], '（前件）派发面授予后应有豁免条目');
  store.recoverBatches(); // 模拟宿主重启：running → idle
  assert.equal(store.readBatch(S, batchId).lanes['l-task'], 'idle', '（前件）恢复后 lane 落 idle');
  assert.ok(store.readBatch(S, batchId).laneExempt?.['l-task'], '（前件）recoverBatches 不动 laneExempt（store.js:698-743）');

  store.setMember(S, batchId, 'l-task', 'running'); // 恢复重派：**不带** exempt
  const after = store.readBatch(S, batchId);
  const inherited = after.laneExempt?.['l-task'] != null;
  const inheritedEv = after.events.some((e) => e.type === 'lane.exempt.inherited' && e.lane === 'l-task');
  const clearedEv = after.events.some((e) => e.type === 'lane.exempt.cleared' && e.lane === 'l-task');
  assert.ok(
    inherited || inheritedEv || clearedEv,
    'D7/§6.2：idle 恢复重派未带 exempt 时旧豁免**不得被静默清退**——须二选一并留痕：'
      + '① 继承（laneExempt 保留，可配 lane.exempt.inherited 事件）或 ② 显式 cleared 留痕（lane.exempt.cleared 事件 + 探针输出）。'
      + '实际：laneExempt=' + JSON.stringify(after.laneExempt ?? null)
      + '；lane.exempt.* 事件=' + JSON.stringify(after.events.filter((e) => String(e.type).startsWith('lane.exempt.')).map((e) => e.type)),
  );
});

test('RS-11b [D7 守恒/§6.2] 终态结算仍清退豁免；显式撤销入口不变', () => {
  const f = seedBatch({
    S: 'sess-wsr-11b',
    batchId: 'b-wsr-11b',
    tasks: [{ id: 'l-a', cmd: 'work', outputs: ['exec/l-a/out.txt'] }, { id: 'l-b', cmd: 'work', outputs: ['exec/l-b/out.txt'] }],
    decide: (b) => {
      b.phase = 'running';
      b.lanes = { 'l-a': 'pending', 'l-b': 'pending' };
      b.events = [{ ts: iso(Date.now() - 4 * HOUR), type: 'batch.created' }];
    },
  });
  const { store, S, batchId } = f;
  // (a) 结算终态仍清退（design §6.2「终态清退保留」；store.js:452-455）
  store.setMember(S, batchId, 'l-a', 'running', null, { type: 'ai-render' });
  store.setMember(S, batchId, 'l-a', 'failed');
  assert.equal(store.readBatch(S, batchId).laneExempt?.['l-a'], undefined, '§6.2 守恒：结算终态仍清退豁免（免残留到后续批次读端）');
  // (b) 显式撤销入口不变（store.revokeLaneExempt = 唯一显式撤销入口）
  store.setMember(S, batchId, 'l-b', 'running', null, { type: 'large-download' });
  assert.ok(store.readBatch(S, batchId).laneExempt?.['l-b'], '（前件）l-b 已获豁免');
  store.revokeLaneExempt(S, batchId, 'l-b');
  const b2 = store.readBatch(S, batchId);
  assert.equal(b2.laneExempt?.['l-b'], undefined, '§6.2 守恒：显式撤销仍生效');
  assert.equal(b2.events.filter((e) => e.type === 'lane.exempt.revoked' && e.lane === 'l-b').length, 1, '§6.2 守恒：显式撤销仍写 lane.exempt.revoked 留痕');
});
