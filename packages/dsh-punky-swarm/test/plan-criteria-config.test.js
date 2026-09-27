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

// A3 配置化（2026-09-21 用户裁定「判据改为全中文，且配置化」）：plan 判据两门的章节名不再硬编码——
//   · **锚点门** `GATE_AUDIT_CRITERIA_MISSING`：audit 层 `audit_contract.criteria_section`（新键）优先，
//     缺声明回落引擎基线 `ENGINE_BASELINE_CRITERIA_SECTION`（`## 验收标准`，全中文单一真源）；
//   · **契约门** `GATE_PLAN_CONTRACT`：`flows.plan.contract.required_sections`（既有键）优先，
//     缺声明回落 `ENGINE_BASELINE_PLAN_SECTIONS`（从 criteria 常量派生）。
// ⇒ 规格与判据解耦：团队用英文章节名 ⇒ 资产声明即可，代码零改动。
// 测试以「复制内置资产再改一处」构造（同 `audit-contract-gate.test.js` 手法，避免手搓资产骨架）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { loadTeamAsset, TEAM_ASSET_CODES } from '../lib/assembly/team-asset.js';
import { clearFlowCache, ENGINE_BASELINE_CRITERIA_SECTION, ENGINE_BASELINE_PLAN_SECTIONS } from '../lib/assembly/flows.js';
import { assessC, registerManager, seedArtifactFile } from './helpers/gate-fixture.mjs';
import { writeTempTeam } from './helpers/team-fixture.mjs';

const SESS = { agent: { session: { id: 'sess-acfg' } } };
const SID = SESS.agent.session.id;

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-acfg-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const tools = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  assessC(store, SID, { rationale: 'fixture：判据配置化套件建批前置评估（多 lane 并行 ⇒ C 档）' });
  return { root, store, byName };
}

function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'], cmd: 'code' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'], cmd: 'accept' },
  ];
}

/** 建批 + 写产物 + 走完 p1/e1 ⇒ 返回「派发 a1」的 thunk（锚点门在此触发）。 */
async function driveBatch(byName, store, root, { batchId, teamsRoot, team, specBody }) {
  await byName.wave_plan.execute({ batchId, team, teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' } }, SESS);
  registerManager(store, SID, batchId, 'mgr-' + batchId);
  seedArtifactFile(root, SID, batchId, 'plan/spec.md', specBody);
  seedArtifactFile(root, SID, batchId, 'exec/e1/o.md', 'out\n');
  const ms = (lane, status) => byName.member_status.execute({ batchId, lane, status }, SESS);
  const settle = (lane, status) => byName.member_settle.execute({ batchId, lane, status }, SESS);
  for (const [lane, st] of [['p1', 'running'], ['p1', 'review'], ['p1', 'merged'], ['e1', 'running'], ['e1', 'review'], ['e1', 'merged']]) {
    // 终态（merged/skipped/…）走 `member_settle`（状态机结算面）；中间态走 `member_status`。
    await (st === 'merged' ? settle : ms)(lane, st);
  }
  return () => ms('a1', 'running');
}

/** 默认契约门（两章）+ 附加章节的产物正文。 */
// 【2026-09-27 扩面】spec 夹具补足必要裸标题六项（对齐 ENGINE_BASELINE_PLAN_SECTIONS）
const baseSpec = (extra = '') =>
  '# spec\n\n## 概述\n- a\n\n## 问题\n- a\n\n## 方案\n- a\n\n## 需求\n- a\n\n## 验收标准\n- a\n\n## 约束\n- b\n' + extra;

test('C1 判据真源：ENGINE_BASELINE_CRITERIA_SECTION 全中文且为 PLAN_SECTIONS 成员（单一字面量）', () => {
  assert.equal(ENGINE_BASELINE_CRITERIA_SECTION, '## 验收标准');
  // 【2026-09-27 扩面】2 项 → 6 项（用户裁决：引擎校验技能的所有必要裸标题）
  assert.ok(Array.isArray(ENGINE_BASELINE_PLAN_SECTIONS) && ENGINE_BASELINE_PLAN_SECTIONS.length === 6);
  assert.equal(ENGINE_BASELINE_PLAN_SECTIONS.includes(ENGINE_BASELINE_CRITERIA_SECTION), true, '契约门须含 criteria 真源');
  assert.deepEqual([...ENGINE_BASELINE_PLAN_SECTIONS], ['## 概述', '## 问题', '## 方案', '## 需求', '## 验收标准', '## 约束']);
  assert.ok(Object.isFrozen(ENGINE_BASELINE_PLAN_SECTIONS), '基线章节集须冻结');
  // 单一字面量：flows.js 中 `## 验收标准` 只允许出现在常量定义处（防再硬编码）——
  // 由 fixture-helper-ledger 的全文扫描口径覆盖，此处锁运行期引用面。
});

test('C2 锚点门·声明覆盖（正例）：criteria_section=## Accept 且产物含之 ⇒ a1 派发放行', async () => {
  const { root, store, byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-acfg-ok-', 'acfg-team', (a) => {
    a.flows.audit.audit_contract.criteria_section = '## Accept';
  });
  clearFlowCache();
  const runA1 = await driveBatch(byName, store, root, {
    batchId: 'acfg-ok', teamsRoot, team: 'acfg-team',
    specBody: baseSpec('\n## Accept\n- c\n'),
  });
  await runA1(); // 不抛 ⇒ 锚点门按声明章节放行
});

test('C3 锚点门·声明覆盖（负例）：产物缺声明章节 ⇒ 拒且 problems 逐字指名', async () => {
  const { root, store, byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-acfg-neg-', 'acfg-team', (a) => {
    a.flows.audit.audit_contract.criteria_section = '## Accept';
  });
  clearFlowCache();
  const runA1 = await driveBatch(byName, store, root, {
    batchId: 'acfg-neg', teamsRoot, team: 'acfg-team',
    specBody: baseSpec(), // 含默认两章但**不含** ## Accept
  });
  await assert.rejects(() => runA1(), (e) => {
    const msg = String(e?.message ?? e);
    assert.ok(msg.includes('GATE_AUDIT_CRITERIA_MISSING'), '须为锚点门码：' + msg);
    assert.ok(msg.includes('lacks "## Accept"'), 'problems 须按**声明章节名**指名：' + msg);
    return true;
  });
});

test('C4 锚点门·缺声明回落引擎基线（全中文）：只认 ## 验收标准，不认英文章节（且两通道独立）', async () => {
  const { root, store, byName } = makeHarness();
  // plan 契约声明 `## 需求`（**不动** audit）⇒ 证明 plan/audit 两条配置通道互不影响。
  const teamsRoot = writeTempTeam('punky-acfg-fb-', 'acfg-team', (a) => {
    // 注（2026-09-26 团队资产瘦身）：夹具骨架不再预置 `flows.<layer>.contract`
    //   ⇒ 须**显式建对象**后再写章节（否则 `Cannot set properties of undefined`）。
    a.flows.plan.contract = { ...(a.flows.plan.contract ?? {}), required_sections: ['## 需求'] };
  });
  clearFlowCache();
  // 4a 负例：过契约门（## 需求）但缺默认 criteria 章 ⇒ a1 拒（回落 `## 验收标准`，不认 ## Accept）
  const runA1neg = await driveBatch(byName, store, root, {
    batchId: 'acfg-fb-neg', teamsRoot, team: 'acfg-team',
    specBody: '# spec\n\n## 需求\n- r\n\n## Accept\n- c\n',
  });
  await assert.rejects(() => runA1neg(), (e) => {
    const msg = String(e?.message ?? e);
    assert.ok(msg.includes('GATE_AUDIT_CRITERIA_MISSING'), msg);
    assert.ok(msg.includes('lacks "## 验收标准"'), '缺声明须回落全中文基线：' + msg);
    return true;
  });
  // 4b 正例：补上 ## 验收标准 ⇒ 放行
  const runA1ok = await driveBatch(byName, store, root, {
    batchId: 'acfg-fb-ok', teamsRoot, team: 'acfg-team',
    specBody: '# spec\n\n## 需求\n- r\n\n## 验收标准\n- a\n',
  });
  await runA1ok();
});

test('C5 契约门·required_sections 声明覆盖：按声明章节判（缺 ⇒ 拒且指名）', async () => {
  const { root, store, byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-acfg-plan-', 'acfg-team', (a) => {
    // 注（2026-09-26 团队资产瘦身）：同 C4 —— 夹具骨架无 `contract`，须显式建对象。
    a.flows.plan.contract = { ...(a.flows.plan.contract ?? {}), required_sections: ['## 需求'] };
  });
  clearFlowCache();
  // 5a 负例：spec 只含默认两章 ⇒ p1 merged 拒（契约门按声明 `## 需求` 判）
  const p1neg = await driveBatch(byName, store, root, {
    batchId: 'acfg-plan-neg', teamsRoot, team: 'acfg-team',
    specBody: baseSpec().replace('## 需求\n- a\n\n', ''),   // 【扩面适配】负例须缺【声明的 ## 需求】
  }).then((runA1) => runA1).catch((e) => e);
  const msgNeg = String(p1neg?.message ?? p1neg);
  assert.ok(p1neg instanceof Error, '缺声明章节须拒：' + msgNeg);
  assert.ok(msgNeg.includes('GATE_PLAN_CONTRACT'), msgNeg);
  // 注（2026-09-26）：引擎对**自定义 required_sections 缺失**的文案已更新为
  //   `no plan artifact carries a criteria section (## 需求)`（原为 `lacks "## 需求"`）。
  //   ⇒ 两种文案都接受（判据是「被拒 + 指名缺失章节」，不是措辞）。
  assert.ok(
    msgNeg.includes('lacks "## 需求"') || msgNeg.includes('no plan artifact carries a criteria section (## 需求)'),
    '须指名缺失的声明章节：' + msgNeg,
  );
  // 5b 正例：含 ## 需求 ⇒ p1 merged 放行（并顺带走完 e1；a1 锚点按默认中文判 ⇒ spec 须含 ## 验收标准）
  const runA1 = await driveBatch(byName, store, root, {
    batchId: 'acfg-plan-ok', teamsRoot, team: 'acfg-team',
    specBody: '# spec\n\n## 需求\n- r\n\n## 验收标准\n- a\n',
  });
  await runA1();
});

test('C6 声明面校验：criteria_section 非字符串 ⇒ TEAM_ASSET_BAD_TYPE（fail-closed，不留静默面）', () => {
  const teamsRoot = writeTempTeam('punky-acfg-bad-', 'acfg-team', (a) => {
    a.flows.audit.audit_contract.criteria_section = 123;
  });
  clearFlowCache();
  const r = loadTeamAsset(teamsRoot, 'acfg-team');
  assert.equal(r.ok, false, '非法类型须拒载');
  const dump = JSON.stringify(r.problems);
  const hit = r.problems.some((p) => {
    const s = typeof p === 'string' ? p : JSON.stringify(p);
    return s.includes('TEAM_ASSET_BAD_TYPE') && s.includes('criteria_section');
  });
  assert.ok(hit, '须有 criteria_section 的 BAD_TYPE 条目：' + dump);
});
