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

// gate-lite 第二批：A2（Manager 承抽官方 roster 的**读端**）+ C（删 `「团队资产缺失」码(已删)` 死码）
//   + E（三处写域外残留清理）。
//
// 覆盖：
//   T1/T2（A2 读端 · 四级可辨）：`ctx.get('agentTeams')` 命中且 roster 有约定名 `manager` ⇒ `inRoster:true`；
//        roster 可读但无该成员 ⇒ `inRoster:false` **且落 1 条 `gate.manager_roster_gap`**（本批事实）；
//        service 不可用 ⇒ `reason:'service-unavailable'`（基线态，回显承担可读性、不落事件）；
//        调用抛错 ⇒ `reason:'not-a-team-member: …'`（异常态，回显、不落事件）。
//   T3（A2 读端 · batch_status）：`managerRoster` 与 legacy `batch.manager` 并列回显（新批以 roster 为准，旧批字段可读）。
//   T4（C 防回生）：`code: '「团队资产缺失」码(已删)'` 的**生产形态**只允许出现在 `lib/assembly/flows.js`
//        （写域外仅存的一处 legacy escalation 载荷）——若在建批告警发射面（`lib/tools/**`）重现 ⇒ 本断言红。
//   T5（E①/E②）：`lib/engine/dispatch.js` 不再导出 `UNBOUND_REPORT_CODE`；枚举/生成物不再含
//        `'GATE_SWARM_UNBOUND_REPORT'`（生产形态 `| '…'`）。
//   T6（E③）：`presets/punky-preset/references/discipline.md` 不再有「未绑定即拒」旧口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import * as EVT from '../lib/state/event-types.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { writeTempTeam } from './helpers/team-fixture.mjs';
import { seedTeamAssetSkills } from './helpers/host-skills.mjs';

seedTeamAssetSkills('software-team');

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESS = { agent: { session: { id: 'sess-b2' } } };
const SID = SESS.agent.session.id;

function mkCtx(rosterService) {
  const ctx = { tools: { register() {}, guard() {} }, logger: { warn() {}, info() {}, error() {} } };
  if (rosterService !== undefined) ctx.get = () => rosterService;
  return ctx;
}

function makeHarness(prefix, rosterService) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(root);
  const ctx = mkCtx(rosterService);
  const tools = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  assessC(store, SID, { rationale: 'fixture：gate-lite 第二批 A2 roster 读端套件（三层批 ⇒ C 档）' });
  return { root, store, byName };
}


// 三层批（含 audit lane）⇒ assembly 必备 ⇒ `managerPlan` 缺省 `raise` ⇒ 触发 A2 消费点
const threeTier = () => [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'], cmd: 'code' },
  { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'], cmd: 'accept' },
];

async function buildBatch(byName, batchId, teamsRoot) {
  return await byName.wave_plan.execute({
    batchId, team: 'probe-team', teamsRoot, tasks: threeTier(), assembly: { auditLane: 'a1' },
  }, SESS);
}

const rosterService = (names) => ({ listMembers: () => names.map((n, i) => ({ id: 'sess-' + i, name: n, role: n === 'lead' ? 'lead' : 'teammate', status: 'running' })) });

test('T1 A2：roster 命中约定名 manager ⇒ inRoster:true 且不落 gap 事件', async () => {
  const { store, byName } = makeHarness('punky-b2-t1-', rosterService(['lead', 'manager']));
  const teamsRoot = writeTempTeam('punky-b2-t1-team-', 'probe-team');
  const out = await buildBatch(byName, 'b2-ok', teamsRoot);
  assert.equal(out.managerPlan, 'raise', 'assembly.managerPlan 缺省 raise 随返回值回显');
  assert.equal(out.managerRoster.ok, true);
  assert.equal(out.managerRoster.source, 'roster');
  assert.equal(out.managerRoster.inRoster, true, '约定名 manager 在册');
  assert.equal(out.managerRoster.rosterName, 'manager');
  assert.equal(out.managerRoster.member.name, 'manager');
  const evs = store.readBatch(SID, 'b2-ok').events.filter((e) => e.type === EVT.EVT_GATE_MANAGER_ROSTER_GAP);
  assert.equal(evs.length, 0, '在册 ⇒ 不落 gate.manager_roster_gap');
});

test('T2 A2：roster 可读但无 manager ⇒ inRoster:false + 落 1 条 gate.manager_roster_gap（可核事实，非拒态）', async () => {
  const { store, byName } = makeHarness('punky-b2-t2-', rosterService(['lead', 'worker']));
  const teamsRoot = writeTempTeam('punky-b2-t2-team-', 'probe-team');
  const out = await buildBatch(byName, 'b2-gap', teamsRoot);
  assert.equal(out.managerRoster.ok, true);
  assert.equal(out.managerRoster.inRoster, false, '无约定名 manager');
  assert.equal(out.managerRoster.member, null);
  const evs = store.readBatch(SID, 'b2-gap').events.filter((e) => e.type === EVT.EVT_GATE_MANAGER_ROSTER_GAP);
  assert.equal(evs.length, 1, '声明 raise 而 roster 无 Manager ⇒ 留痕 1 条');
  assert.equal(evs[0].rosterName, 'manager');
  assert.equal(evs[0].managerPlan, 'raise');
  assert.equal(EVT.EVT_GATE_MANAGER_ROSTER_GAP, 'gate.manager_roster_gap', '事件字面量（单点常量）');
});

test('T2b A2 降级：service 不可用 ⇒ service-unavailable（基线态，不落事件）；调用抛错 ⇒ not-a-team-member（异常态，不落事件）', async () => {
  // ① ctx 无 get（非官方宿主 / 单测 mock）：基线态 —— 回显承担可读性，不落批次事件
  const noSvc = makeHarness('punky-b2-t2b1-', undefined);
  const tr1 = writeTempTeam('punky-b2-t2b1-team-', 'probe-team');
  const o1 = await buildBatch(noSvc.byName, 'b2-nosvc', tr1);
  assert.equal(o1.managerRoster.ok, false);
  assert.equal(o1.managerRoster.reason, 'service-unavailable');
  assert.equal(noSvc.store.readBatch(SID, 'b2-nosvc').events.filter((e) => e.type === EVT.EVT_GATE_MANAGER_ROSTER_GAP).length, 0);
  // ② service 在册但调用抛错（调用方非 Team 成员）：异常态 —— 回显 reason，同样不落批次事件
  const throwing = { listMembers: () => { throw new Error('not a team member'); } };
  const thr = makeHarness('punky-b2-t2b2-', throwing);
  const tr2 = writeTempTeam('punky-b2-t2b2-team-', 'probe-team');
  const o2 = await buildBatch(thr.byName, 'b2-throw', tr2);
  assert.equal(o2.managerRoster.ok, false);
  assert.match(o2.managerRoster.reason, /^not-a-team-member:/);
  assert.equal(thr.store.readBatch(SID, 'b2-throw').events.filter((e) => e.type === EVT.EVT_GATE_MANAGER_ROSTER_GAP).length, 0);
});

test('T3 A2 读端：batch_status 回显 managerRoster（roster 优先）与 legacy batch.manager 并列', async () => {
  const { store, byName } = makeHarness('punky-b2-t3-', rosterService(['lead']));
  store.createBatch(SID, { batchId: 'b2-view', wavePlan: { schema: 1, team: 'probe-team', concurrency: 1, wavePlan: [{ wave: 1, tasks: [{ id: 'p1' }] }] } });
  const v0 = await byName.batch_status.execute({ batchId: 'b2-view' }, SESS);
  assert.ok(v0.managerRoster, 'managerRoster 键恒在（读端可核，不是隐性判定）');
  assert.equal(v0.managerRoster.roster.ok, true);
  assert.equal(v0.managerRoster.roster.inRoster, false, 'roster 只有 lead ⇒ 不在册');
  assert.equal(v0.managerRoster.managerPlan, null, '无 assembly ⇒ managerPlan null');
  assert.equal(v0.managerRoster.legacy, null, '未登记 ⇒ legacy 为 null');

  // legacy 登记路径（旧批/离线写入）仍可用 ⇒ 读端并列回显，新批判据以 roster 为准
  store.markManagerRaised(SID, 'b2-view', { agentId: 'mgr-legacy' });
  const v1 = await byName.batch_status.execute({ batchId: 'b2-view' }, SESS);
  assert.equal(v1.managerRoster.legacy.agentId, 'mgr-legacy', 'legacy 字段可读（兼容面）');
  assert.equal(v1.managerRoster.roster.inRoster, false, 'roster 仍为准（legacy 字段不改变在册判定）');
  assert.equal(v1.manager.agentId, 'mgr-legacy', '既有 batch.manager 回显逐字不变');
});

// ── 静态面（防回生 / 残留清理）────────────────────────────────────────────
function scan(dir, re, exts = ['.js', '.ts']) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...scan(p, re, exts)); continue; }
    if (!exts.includes(path.extname(e.name)) || e.name.endsWith('.d.ts')) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (re.test(src)) out.push(path.relative(PKG, p).replace(/\\/g, '/'));
  }
  return out;
}

// 【2026-09-21 改判】该码已按可达性审计裁定**字面删除**（连注释引用一并清除）⇒ 终态应为**lib 内零命中**；
//   原断言「仅允许存在于 flows.js」在字面删除后不再成立（那处正是被清除的注释引用）。
test('T4 C 防回生（字面删除后）：code: GATE_TEAM_ASSET_MISSING 生产形态在 lib/** 内**零命中**', () => {
  const hits = scan(path.join(PKG, 'lib'), /code:\s*'GATE_TEAM_ASSET_MISSING'/);
  assert.deepEqual(hits, [],
    '该码已字面删除（含注释引用）⇒ 生产形态须零命中；若在 lib 内重现 ⇒ 红。实际：' + JSON.stringify(hits));
});

test('T5 E①/E②：dispatch.js 不再导出 UNBOUND_REPORT_CODE；枚举与生成物不再含该码', () => {
  const dispatchSrc = fs.readFileSync(path.join(PKG, 'lib/engine/dispatch.js'), 'utf8');
  assert.ok(!/export const UNBOUND_REPORT_CODE/.test(dispatchSrc), '死导出已删');
  const tsSrc = fs.readFileSync(path.join(PKG, 'lib/types/contracts.ts'), 'utf8');
  const dtsSrc = fs.readFileSync(path.join(PKG, 'lib/types/contracts.d.ts'), 'utf8');
  assert.ok(!/\| 'GATE_SWARM_UNBOUND_REPORT'/.test(tsSrc), '枚举成员已删（源）');
  assert.ok(!/'GATE_SWARM_UNBOUND_REPORT'/.test(dtsSrc), '枚举成员已删（生成物，重建后同步）');
});

test('T6 E③：discipline.md 旧口径文本已订正（不再出现「未绑定即拒」）', () => {
  const src = fs.readFileSync(path.join(PKG, 'presets/punky-preset/references/discipline.md'), 'utf8');
  assert.ok(!/未绑定即拒/.test(src), '旧口径文本须已订正');
  assert.ok(/未绑定不再拒/.test(src), '新口径文本在位');
});
