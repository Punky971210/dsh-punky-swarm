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

// 会话级临时团队资产根（teamsRoot）：wave_plan 工具面接线 + 「尽力」资产面 + 防逃逸 + 门禁不可绕过
// 契约（以 `lib/tools/core.js#resolveTeamAssetFace` 为准；【2026-09-27 用户裁决 · 全批反转】）：
//   ① 显式且可用的 teamsRoot ⇒ 资产查找**替换**为 <teamsRoot>/presets/<team>/（loader 口径 TEAM_ASSET_DIR='presets'），
//      **不回落**包内 presets/：资产缺失/非法 ⇒ 建批照常 + 原 `TEAM_ASSET_*` 码进 `warnings` 留痕（**不拒建批**）；
//   ② teamsRoot/team 词法 + 防逃逸（非绝对路径 / 含 `..` 段 / team 非 kebab-case）⇒ **忽略该根**
//      （`TEAMS_ROOT_IGNORED` 留痕、不写批次键）——原 `GATE_TEAMS_ROOT_INVALID` / `GATE_TEAMS_ROOT_ASSET_NOT_FOUND`
//      拒态家族**已删除**；纯校验函数（`resolveTeamsRootOption` / `assertTeamsRootLexical`）保留在模块内、已退出工具面调用；
//   ③ 缺省 teamsRoot ⇒ 包内 presets/ 面「尽力」解析（无资产标签照常建批 + 留痕）；
//   ④ 临时团队批次**同受 Tier3 门禁**（entry 缺 consume 拒派 / audit 未验收拒 complete）。
//
// 覆盖分组：T1 正向（技能前缀来源）+ T2 缺失 + T3 非法 + T4 逃逸/词法 + T5 向后兼容 + T6 门禁 + T7 入参契约。
// 消费构建产物：lib/tools/core.js（**不在** scripts/copy-ts-built.mjs 回拷清单，只改 .js、无 .ts）+
//   lib/wave-plan.js（teamsRoot 支持属**前批工作树未提交改动**，非本批产出）+ createTools 真实注册面。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { assessC, registerManager } from './helpers/gate-fixture.mjs';
import { clearRoleCache, packageRoot } from '../lib/assembly/flows.js';
import { resolveTeamsRootOption, assertTeamsRootLexical } from '../lib/tools/core.js';
import { loadTeamAsset } from '../lib/assembly/team-asset.js';

// ── fixtures ──

const SESS = { agent: { session: { id: 'sess-troot' } } };
const TMP_TEAM = 'tmp-team';

// 【2026-09-25 反转 · 宿主技能根】旧口径：P1 起团队资产的 `skills` 必须**可解析**
//   （不可解析 ⇒ `TEAM_ASSET_SKILLS_MISMATCH` 拒建批；技能根不存在/不可读 ⇒ **同码拒**，不静默跳过）。
//   现行口径（recommend 语义，见 `plan/recommend-spec.md` §1.3 三态表）：**技能根不存在/不可读 ⇒ 不拒建批**
//   ——该态**不落**告警（守既有 `if (res.ok)` 守卫）⇒ 本文件两处「精确空 warnings」断言（T1 / T5）语义不变。
//   据此：本文件**不再**注入宿主技能根（原写盘播种夹具已随批 `onto-fixture-purge-20260925` 撤除）。

// 临时团队资产（技能前缀刻意与包内不同 ⇒ lane cmd 前缀可反证来源）
function tmpAsset() {
  return {
    team: TMP_TEAM,
    layers: {
      plan: { roles: ['outline-designer'], skills: { 'outline-designer': ['TMP-PLAN-SKILL'] } },
      exec: { roles: ['scribe'], skills: { scribe: ['TMP-EXEC-SKILL'] } },
      audit: { roles: ['fact-checker'], skills: { 'fact-checker': ['TMP-AUDIT-SKILL'] } },
    },
    roles: { extra: ['outline-designer', 'scribe', 'fact-checker'], plan_leads: ['outline-designer'], audit_leads: ['fact-checker'] },
    flows: {
      plan: { produce_field: 'produce' },
      exec: { produce_field: 'outputs', entry_requires: ['consume'] },
      audit: {
        produce_field: 'produce',
        // P2（audit 职责声明化）：含 audit lane + 解析到团队资产 ⇒ 必须声明 audit_contract；
        // 本 fixture 的 T1/T5 断言 warnings 零告警，故给**实内容**（空 {} / exempt 会落 GATE_AUDIT_CONTRACT_EXEMPT 告警）
        audit_contract: {
          criteria_from: 'plan/**',
          verdict: ['pass', 'fail', 'skip'],
        },
      },
    },
  };
}

// 临时团队三项任务（含 plan 计划角色 + audit 验收角色；exec 仅 1 条 ⇒ 不触发 C+ 装配门禁噪音）
function tmpTasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'outline-designer', produce: ['plan/outline.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'scribe', consume: ['plan/outline.md'], outputs: ['exec/draft.md'], deps: ['p1'], cmd: 'write-it' },
    { id: 'a1', layer: 'audit', role: 'fact-checker', consume: ['plan/outline.md', 'exec/draft.md'], produce: ['audit/check.md'], deps: ['e1'], cmd: 'check-it' },
  ];
}

// 包内软件工程团队任务（角色取 presets/software-team 声明；exec 仅 1 条 ⇒ 无 C+ 噪音）
function pkgTasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'plan-it' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/out.md'], deps: ['p1'], cmd: 'build-it' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/out.md'], produce: ['audit/report.md'], deps: ['e1'], cmd: 'verify-it' },
  ];
}

// <teamsRoot>/presets/<team>/team-asset.json；asset === null → 不写文件（测缺失）；string → 原样写入（测坏 JSON）
function mkTeamsRoot(team, asset, { writeFile = true } = {}) {
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-troot-teams-'));
  if (team) fs.mkdirSync(path.join(teamsRoot, 'presets', team), { recursive: true });
  if (writeFile && asset !== null) {
// 【F2 白名单】本文件**故意**直接写 team-asset（loader/边界自测需要造「坏资产 / 缺文件 / 字符串原文」形态，
//   而 `writeSyntheticTeam` 的形状下限校验会挡住它们）⇒ 登记在 test/fixture-team-ledger.test.js 的白名单内。
    fs.writeFileSync(path.join(teamsRoot, 'presets', team, 'team-asset.json'), typeof asset === 'string' ? asset : JSON.stringify(asset), 'utf8');
  }
  return teamsRoot;
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-troot-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {} }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // G1 前置（新门禁）：`wave_plan` / `member_status` 属 C 档动作 ⇒ 先把本会话评估为 C（同 assign_check 落盘函数）
  assessC(store, SESS.agent.session.id, { rationale: 'fixture：teamsRoot 临时团队套件建批前置评估（三层多线 ⇒ C 档）' });
  return { root, store, byName };
}

const batchFileOf = (root, batchId) => path.join(root, 'sessions', SESS.agent.session.id, 'batches', batchId + '.json');
const cmdsOf = (out) => out.wavePlan.flatMap((w) => w.tasks).map((t) => t.id + ' | ' + t.cmd);

// T8 专用资产：audit_contract 追加 `consumes_required: ['plan/', 'audit/']`。
// 【r2 同步 · D3 的证人更换】D3 的原判据是「临时资产声明 `exec.entry_requires:['consume']` ⇒ 无 consume 拒派」，
//   但 r2 · B1 后 consume 强制**不依赖团队声明**（缺声明即拒，`entryRequiresOf` 只留痕 `requiredBy` 标注；
//   E-5 清退后原布尔读端 enforcesConsumeEntry 已删，entryRequiresOf 为唯一读端）
//   ⇒ 该声明**不再具备可区分性**（有无资产同样拒派，无法反证「临时资产被试读」）。
//   故改用仍具门禁可区分性的团队声明面：`audit_contract.consumes_required`（core.js 建批期确定性校验，
//   只在**解析到团队资产**时生效）——「有资产 ⇒ 拒建批 / 无资产 ⇒ 放行」这一对即可反证来源。
function tmpAssetGated() {
  const a = tmpAsset();
  a.flows.audit.audit_contract.consumes_required = ['plan/', 'audit/'];
  return a;
}

// T8 对照组资产（【P1 同步】证人更换）：同形资产但**不声明** `exec.entry_requires`——
//   P1 后「不传 teamsRoot（无资产）」已被构造期拒堵死（批次建不出来，无法承载 entry 门对照），
//   故把「缺团队声明」这一变量改由**资产内容**表达（少一个键），判据（引擎基线缺声明即拒派）逐字不变。
function tmpAssetNoEntry() {
  const a = tmpAsset();
  a.flows.exec = { produce_field: 'outputs' };
  return a;
}

// ── T8 D3 补全：临时团队的 `flows` 声明在门禁读端生效（批次持久化 teamsRoot）──

test('T8 D3：批次持久化 teamsRoot ⇒ 临时资产的 flows 在门禁读端生效（r2 同步：证人改为团队级 consumes_required；【P1 同步】对照证人改为「有资产但不声明 entry_requires」）', async () => {
  const { root, store, byName } = makeHarness();
  const teamsRoot = mkTeamsRoot(TMP_TEAM, tmpAssetGated());
  try {
    clearRoleCache();
    // exec lane **不声明** consume；plan 产物须被下游 consume（r2 · A1）⇒ 由 audit lane 消费。
    const tasksNoAuditPrefix = [
      { id: 'p1', layer: 'plan', role: 'outline-designer', produce: ['plan/outline.md'], cmd: 'plan-it' },
      { id: 'e1', layer: 'exec', role: 'scribe', outputs: ['exec/draft.md'], deps: ['p1'], cmd: 'write-it' },
      { id: 'a1', layer: 'audit', role: 'fact-checker', consume: ['plan/outline.md'], produce: ['audit/check.md'], deps: ['e1'], cmd: 'check-it' },
    ];
    // ① 门禁读端（建批期，**可区分判据**）：临时资产声明 `consumes_required` 含 'audit/'，
    //    而本构造无 audit lane 消费 audit/ 前缀产物 ⇒ 拒建批；该声明只可能来自临时资产。
    await assert.rejects(
      () => byName.wave_plan.execute({ batchId: 'troot-t8-rej', tasks: tasksNoAuditPrefix, team: TMP_TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS),
      /GATE_AUDIT_INPUT_MISSING/,
      '临时资产的 flows 必须在门禁读端生效（D3 补全的核心判据）',
    );
    // ② 落盘面：满足该声明的合规批 ⇒ 建批成功且批次持久化 teamsRoot（缺省不写键）
    const tasksOk = [...tasksNoAuditPrefix,
      { id: 'a2', layer: 'audit', role: 'fact-checker', consume: ['audit/check.md'], produce: ['audit/retro.md'], deps: ['a1'], cmd: 'retro-it' }];
    const out = await byName.wave_plan.execute({ batchId: 'troot-t8', tasks: tasksOk, team: TMP_TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
    assert.equal(out.batchId, 'troot-t8');
    const raw = JSON.parse(fs.readFileSync(batchFileOf(root, 'troot-t8'), 'utf8'));
    assert.equal(raw.teamsRoot, teamsRoot, 'D3：批次须持久化 teamsRoot，门禁读端才可按临时资产生效');
    // ③ 对照：**同一团队名 + 另一临时资产（不声明 `exec.entry_requires`）** ⇒ 门禁**不依赖团队声明**，引擎基线同样拒派。
    //    【P1 同步】旧口径的证人「不传 teamsRoot（无资产）」在 P1 后**不可达**（无资产 ⇒ 构造期拒，
    //    批次根本建不出来）⇒ 证人改为「**有资产但不声明 entry_requires**」：判据（缺声明即拒）逐字不变，
    //    断言强度未降（原断言面 = 无资产的裸批 + entry 拒；今 = 裸声明资产的批 + entry 拒）。
    const bareRoot = mkTeamsRoot(TMP_TEAM, tmpAssetNoEntry());
    await byName.wave_plan.execute({ batchId: 'troot-t8-ctl', tasks: tasksNoAuditPrefix, team: TMP_TEAM, teamsRoot: bareRoot, assembly: { auditLane: 'a1' } }, SESS);
    const ctl = JSON.parse(fs.readFileSync(batchFileOf(root, 'troot-t8-ctl'), 'utf8'));
    assert.equal(ctl.teamsRoot, bareRoot, '对照组批次照常持久化其临时根（缺省不写键的判据由 T5/T7 面覆盖）');
    // ④ 【r2 同步 · B1】门禁**不依赖团队声明**：无 consume 的 exec lane 在缺省（无资产）下同样拒派
    //    —— 旧口径「缺省 ⇒ 空 consume 免检、同形 lane 可派」已废除（引擎基线收紧侧）。
    //    G2 前置（2026-09-14 新门禁）：`assembly` 缺省归一化为 `managerPlan: 'raise'` ⇒ exec 层派发前须先登记
    //    Manager，否则 entry 门先以 「未拉起 Manager」码(已删) 拦下、吞掉本用例的被检面（GATE_ENTRY_MISSING）。
    registerManager(store, SESS.agent.session.id, 'troot-t8-ctl', 'mgr-t8ctl');
    await assert.rejects(
      () => byName.member_status.execute({ batchId: 'troot-t8-ctl', lane: 'e1', status: 'running' }, SESS),
      /GATE_ENTRY_MISSING/,
      'r2 同步：缺省不再回落免检（引擎基线收紧侧）——缺声明即拒',
    );
  } finally {
    fs.rmSync(teamsRoot, { recursive: true, force: true });
  }
});

// ── T1 正向：临时资产建批成功 + 技能前缀按临时资产注入（与包内不同以证来源）──

test('T1 正向：teamsRoot 临时资产建批成功，lane cmd 技能前缀按临时资产注入（非包内 dev-*）', async () => {
  const { root, byName } = makeHarness();
  const teamsRoot = mkTeamsRoot(TMP_TEAM, tmpAsset());
  try {
    clearRoleCache();
    const out = await byName.wave_plan.execute({ batchId: 'troot-t1', tasks: tmpTasks(), team: TMP_TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
    assert.equal(out.batchId, 'troot-t1');
    assert.deepEqual(cmdsOf(out), [
      'p1 | [role=outline-designer] [skills=TMP-PLAN-SKILL] plan-it',
      'e1 | [role=scribe] [skills=TMP-EXEC-SKILL] write-it',
      'a1 | [role=fact-checker] [skills=TMP-AUDIT-SKILL] check-it',
    ], '技能前缀 = 临时资产的 skills（非包内装配）');
    // 同源证据：扩展角色/牵头角色经 resolveTeamRoles(args.team, {root: teamsRoot}) 读到同一临时根
    assert.deepEqual(out.warnings, [], '临时资产声明的扩展角色/牵头角色生效 ⇒ 装配声明面与建批面同源');
    assert.ok(!cmdsOf(out).some((c) => /dev-|report-blind-audit/.test(c)), '不含任何包内技能前缀');
    // 批次落盘：team 记录为临时团队
    const raw = JSON.parse(fs.readFileSync(batchFileOf(root, 'troot-t1'), 'utf8'));
    assert.equal(raw.team, TMP_TEAM);
    // 同任务 + 缺省 teamsRoot（包内无 tmp-team 资产）⇒ 【2026-09-27 反转】P1 的「无资产 ⇒ 构造期拒 + 零批次 JSON
    //   落盘」已按用户裁决退役：现口径 = **照常建批 + 原 `TEAM_ASSET_NOT_FOUND` 码进 `warnings` 留痕**
    //   （判据面未删：由「拒态码 + 零落盘」等价翻转为「同一原码留痕 + 批次落盘」）。
    const ctl = await byName.wave_plan.execute({ batchId: 'troot-t1-ctl', tasks: tmpTasks(), team: TMP_TEAM, assembly: { auditLane: 'a1' } }, SESS);
    const ctlHit = ctl.warnings.find((w) => /^TEAM_ASSET_/.test(w.code));
    assert.ok(ctlHit, '无资产标签须留原码留痕（不再拒建批）：' + JSON.stringify(ctl.warnings));
    assert.equal(ctlHit.code, 'TEAM_ASSET_NOT_FOUND', '留痕码 = 原拒态码（零新造）');
    assert.equal(fs.existsSync(batchFileOf(root, 'troot-t1-ctl')), true, '批次 JSON 落盘（P1 的「拒后零落盘」已反转）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
    clearRoleCache();
  }
});

// ── T2 反例 1【2026-09-27 反转】：资产缺失（不回落包内）⇒ 建批照常 + TEAM_ASSET_NOT_FOUND 留痕 ──

test('T2 资产缺失【反转】：目录不存在 / 目录存在但文件缺失 ⇒ 建批成功 + 批次 JSON 落盘 + TEAM_ASSET_NOT_FOUND 留痕', async () => {
  const { root, byName } = makeHarness();
  const emptyRoot = mkTeamsRoot('', null, { writeFile: false }); // teamsRoot 下无 presets/
  const dirOnly = mkTeamsRoot('ghost-team', null, { writeFile: false }); // 目录在、文件缺
  try {
    // 旧口径（P1 起）：`GATE_TEAMS_ROOT_ASSET_NOT_FOUND` 拒建批 + 零批次 JSON 落盘（拒态家族**已删除**）。
    //   现口径：临时根可用（绝对路径、无 `..` 段）但**资产缺失** ⇒ 该标签走「无资产」路径 + 原 `TEAM_ASSET_NOT_FOUND`
    //   码留痕，**建批照常**（判据面未删，只等价反转读数两侧：拒→留痕、零落盘→落盘）。`assembly` 为夹具必需
    //   （本批含 audit 层 ⇒ `GATE_ASSEMBLY_*` 门仍在，与本批被检面无涉）。
    const o1 = await byName.wave_plan.execute({ batchId: 'troot-t2a', tasks: tmpTasks(), team: 'ghost-team', teamsRoot: emptyRoot, assembly: { auditLane: 'a1' } }, SESS);
    const o2 = await byName.wave_plan.execute({ batchId: 'troot-t2b', tasks: tmpTasks(), team: 'ghost-team', teamsRoot: dirOnly, assembly: { auditLane: 'a1' } }, SESS);
    for (const [bid, out] of [['troot-t2a', o1], ['troot-t2b', o2]]) {
      assert.equal(out.batchId, bid, bid + '：资产缺失不得再拒建批');
      assert.ok(out.warnings.some((w) => w.code === 'TEAM_ASSET_NOT_FOUND'),
        bid + '：缺失须留痕 TEAM_ASSET_NOT_FOUND：' + JSON.stringify(out.warnings));
      assert.equal(fs.existsSync(batchFileOf(root, bid)), true, bid + '：批次 JSON 落盘（原「拒建批：无批次 JSON 落盘」已反转）');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    fs.rmSync(dirOnly, { recursive: true, force: true });
  }
});

// ── T3 反例 2【2026-09-27 反转】：资产存在但非法 ⇒ 原码留痕 + 建批照常（不回落、不静默降级）──

test('T3 资产非法【反转】：层 / 角色词法 / 字段缺失 / 坏 JSON ⇒ 原 TEAM_ASSET_* 码留痕 + 建批成功', async () => {
  const { root, byName } = makeHarness();
  const cases = [
    ['troot-t3-entry', 'bad-entry', { ...tmpAsset(), team: 'bad-entry', flows: { ...tmpAsset().flows, plan: { ...tmpAsset().flows.plan, entry_requires: ['nope'] } } }, /^TEAM_ASSET_ENTRY_REQUIRE_UNKNOWN/],
    // 【K-2 换码（2026-09-18 用户裁决）· case①】原 case① 用 `flows.nope`（未知层 ⇒ `LAYER_UNKNOWN`）；
    //   K-2 后该码**退出 BLOCKING_CODES**（本机无外部自建 team ⇒ 暂时用不到 ⇒ 先清理）⇒ 不再被
    //   `assertTeamAssetReady` 拒 ⇒ 换一个**确属 blocking** 的码：`flows.plan.entry_requires: ['nope']`
    //   ⇒ `ENTRY_REQUIRE_UNKNOWN`（∈ BLOCKING_CODES）。**不放宽断言**：下面的四类码面数组与序号仍逐字保留
    //   （仅第 1 项换码）；**未知层的「不否决」语义另有专门用例**（本测试下半的 `troot-t3-layer` 留痕面）。
    // 【R2-3 一致性（2026-09-17 裁决 B）· 取 ⓑ 方案】原 case② 用 `roles.extra: ['Not_Kebab']`（`ROLE_LEXICAL`）
    //   证明「资产非法 ⇒ 构造期拒」——但 R2-3 后 `ROLE_LEXICAL` 是 **warning 级**（不在 `BLOCKING_CODES`）
    //   ⇒ 该资产不再被 `assertTeamAssetReady` 拒，走到建批门禁才抛 `GATE_ROLE_ASSEMBLY_MISSING`（非 TEAM_ASSET_* 码）。
    //   裁定取 ⓑ：换一个**确属 blocking** 的码（`layers.exec.skills` 缺字段 ⇒ `SKILLS_MISMATCH`，见
    //   `lib/assembly/team-asset.js:238`），**不放宽断言**。warning 码（`ROLE_LEXICAL` 留痕不否决）的
    //   语义锚点由 `test/team-asset.test.js` 的 `R2-3-a` 承担（三条 warning 码逐条）。
    ['troot-t3-skills', 'bad-skills', { ...tmpAsset(), team: 'bad-skills', layers: { ...tmpAsset().layers, exec: { roles: ['scribe'] } } }, /^TEAM_ASSET_SKILLS_MISMATCH/],
    ['troot-t3-field', 'bad-field', { team: 'bad-field', flows: { plan: { produce_field: 'produce' } } }, /^TEAM_ASSET_MISSING_FIELD/],
    ['troot-t3-json', 'bad-json', '{ this is not json', /^TEAM_ASSET_BAD_JSON/],
  ];
  const roots = [];
  try {
    const seen = [];
    for (const [batchId, team, asset] of cases) {
      const teamsRoot = mkTeamsRoot(team, asset);
      roots.push(teamsRoot);
      // 【2026-09-27 反转】旧口径「非法资产 ⇒ 构造期拒（`TEAM_ASSET_*` 码原样透出）+ 零批次 JSON 落盘」已退役：
      //   现口径 = **建批照常**（team = 可选标签）+ 同一原码进 `warnings` 留痕。**判据面逐字保留**：仍是
      //   「四类 / 同序 / 一类一码」，只把读数源由 `throw` 的 message 换成 `warning.code`；`assembly` 为夹具必需
      //   （本批含 audit 层 ⇒ `GATE_ASSEMBLY_*` 门仍在，与本批被检面无涉）。
      const out = await byName.wave_plan.execute({ batchId, tasks: tmpTasks(), team, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
      const hit = out.warnings.find((w) => /^TEAM_ASSET_/.test(w.code));
      assert.ok(hit, batchId + ' 必须以 TEAM_ASSET_* 码留痕：' + JSON.stringify(out.warnings));
      seen.push(hit.code);
      assert.equal(fs.existsSync(batchFileOf(root, batchId)), true, '建批照常：' + batchId + ' 批次 JSON 落盘（原「拒建批：无批次 JSON 落盘」已反转）');
    }
    assert.deepEqual(seen, ['TEAM_ASSET_ENTRY_REQUIRE_UNKNOWN', 'TEAM_ASSET_SKILLS_MISMATCH', 'TEAM_ASSET_MISSING_FIELD', 'TEAM_ASSET_BAD_JSON'], '四类非法资产各自的原始码（**结构逐字保留**：四类 / 同序 / 一类一码；第 1 项随 K-2 换码 LAYER_UNKNOWN → ENTRY_REQUIRE_UNKNOWN（前者已降 warning、不再拒载），第 2 项随 R2-3 ⓑ 换码 ROLE_LEXICAL → SKILLS_MISMATCH）');
    // K-2 留痕面（2026-09-18 用户裁决）：**未知层（warning 级）不得否决建批**——与上四例「资产非法 ⇒ 拒」成对照
    const layerRoot = mkTeamsRoot('k2-layered', { ...tmpAsset(), team: 'k2-layered', flows: { nope: { produce_field: 'produce' } } });
    roots.push(layerRoot);
    await byName.wave_plan.execute({ batchId: 'troot-t3-layer', tasks: tmpTasks(), team: 'k2-layered', teamsRoot: layerRoot, assembly: { auditLane: 'a1' } }, SESS);
    // 反面对照：同一 tasks + 同一临时根下的**合法**资产可建批（证 T3 拒的是资产本身，不是环境）
    const okRoot = mkTeamsRoot(TMP_TEAM, tmpAsset());
    roots.push(okRoot);
    const out = await byName.wave_plan.execute({ batchId: 'troot-t3-ok', tasks: tmpTasks(), team: TMP_TEAM, teamsRoot: okRoot, assembly: { auditLane: 'a1' } }, SESS);
    assert.ok(out.lanes.p1 === 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
  }
});

// ── T4 反例 3【2026-09-27 反转】：逃逸与词法违规 ⇒ 忽略该根 + TEAMS_ROOT_IGNORED 留痕（工具面）；
//      纯校验函数面（`resolveTeamsRootOption` / `assertTeamsRootLexical`）逐字保留 ──

test('T4 逃逸/词法【反转】：team 穿越、teamsRoot 相对路径与 .. 段 ⇒ 建批照常 + TEAMS_ROOT_IGNORED 留痕 + 不写批次键（工具面 + 纯校验面）', async () => {
  const { root, byName } = makeHarness();
  const teamsRoot = mkTeamsRoot(TMP_TEAM, tmpAsset());
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-troot-outside-'));
  // 逃逸目标：伪造 <teamsRoot>/../evil/presets/evil 资产，证「穿越面**不再被读**」（词法判据仍在，但出口从拒改为忽略）
  fs.mkdirSync(path.join(outside, 'presets', 'evil'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'presets', 'evil', 'team-asset.json'), JSON.stringify({ ...tmpAsset(), team: 'evil' }), 'utf8');
  const traversals = [
    ['troot-t4-team-dotdot', { team: '../evil', teamsRoot }, 'label-not-kebab'],
    ['troot-t4-team-backslash', { team: '..\\evil', teamsRoot }, 'label-not-kebab'],
    ['troot-t4-team-slash', { team: 'evil/presets', teamsRoot }, 'label-not-kebab'],
    ['troot-t4-root-relative', { team: TMP_TEAM, teamsRoot: 'relative/dir' }, 'lexical'],
    ['troot-t4-root-dotdot', { team: TMP_TEAM, teamsRoot: teamsRoot + path.sep + '..' + path.sep + 'evil' }, 'lexical'],
  ];
  try {
    // 旧口径：五例一律 `GATE_TEAMS_ROOT_INVALID` 拒建批 + 零批次落盘（该拒态家族**已删除**）。
    //   现口径：不可用根 ⇒ **忽略 + 留痕 + 建批照常**；防逃逸判据（kebab-case 白名单 / 绝对路径 / 禁 `..`）**逐字未删**，
    //   只是出口由「拒」改为「忽略」，且「忽略」必须在返回值与批次键上**可见**（不静默、不写无效声明）。
    for (const [batchId, args, reason] of traversals) {
      const out = await byName.wave_plan.execute({ batchId, tasks: tmpTasks(), assembly: { auditLane: 'a1' }, ...args }, SESS);
      assert.equal(out.batchId, batchId, batchId + '：不可用根不得再拒建批');
      const w = out.warnings.find((x) => x.code === 'TEAMS_ROOT_IGNORED');
      assert.ok(w, batchId + '：忽略须留痕 TEAMS_ROOT_IGNORED（不静默）：' + JSON.stringify(out.warnings));
      assert.equal(w.reason, reason, batchId + '：忽略理由须可辨（' + reason + '）');
      const raw = JSON.parse(fs.readFileSync(batchFileOf(root, batchId), 'utf8'));
      assert.equal('teamsRoot' in raw, false, batchId + '：被忽略的根**不得**写批次键（防「声明了却不生效」）');
      assert.equal(fs.existsSync(batchFileOf(root, batchId)), true, batchId + '：批次 JSON 落盘');
      // 防逃逸：穿越目标未被读入（既无该路径的资产留痕，也无该标签的技能前缀）
      assert.ok(!out.warnings.some((x) => x.path && String(x.path).includes('evil')), batchId + '：穿越目标不得被读入');
      assert.ok(!out.wavePlan.flatMap((w2) => w2.tasks).some((t) => /evil/.test(String(t.cmd ?? ''))), batchId + '：穿越标签不得进技能前缀面');
    }
    // 纯校验面（**保留**：这两个函数仍在模块内、判据逐字未变，只是已退出工具面调用）：
    // 不经宿主 arg 类型校验：非字符串 teamsRoot → 旧码（函数级契约）
    assert.throws(() => resolveTeamsRootOption(TMP_TEAM, 42), /GATE_TEAMS_ROOT_INVALID: teamsRoot must be a non-empty absolute path string/);
    assert.throws(() => assertTeamsRootLexical(TMP_TEAM, '   '), /GATE_TEAMS_ROOT_INVALID/);
    // 合法路径经词法面通过（对照组）
    assert.equal(typeof assertTeamsRootLexical(TMP_TEAM, teamsRoot), 'string');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ── T5 向后兼容：缺省 teamsRoot ⇒ 既有行为逐字不变 ──

test('T5 向后兼容：缺省 teamsRoot → 包内 software-team 技能前缀逐字不变；punky-preset 退役（无前缀，告警留痕）；临时资产不参与', async () => {
  const { root, byName } = makeHarness();
  const teamsRoot = mkTeamsRoot(TMP_TEAM, tmpAsset());
  try {
    clearRoleCache();
    // ① 既有场景：team='software-team' 不传 teamsRoot → 前缀 = 包内 presets/software-team 声明
    const out = await byName.wave_plan.execute({ batchId: 'troot-t5-pkg', tasks: pkgTasks(), team: 'software-team', assembly: { auditLane: 'a1' } }, SESS);
    // 注（2026-09-26 团队资产瘦身）：`software-team` 现为 859 B 最小骨架，
    //   技能装配随之更新（每 role 的 skills 数组）。⇒ 断言按**新骨架**逐字对照。
    assert.deepEqual(cmdsOf(out), [
      'p1 | [role=designer] [skills=spec-writing,writing-plans] plan-it',
      'e1 | [role=coder] [skills=test-driven-development,systematic-debugging] build-it',
      'a1 | [role=supervisor] [skills=acceptance-gate,verification-before-completion,retro-and-memory] verify-it',
    ], '缺省 teamsRoot：包内软件工程团队装配逐字不变（新骨架）');
    // 注（2026-09-26 团队资产瘦身）：新骨架显式写 `audit_contract: {}` ⇒ 必然产生
    //   GATE_AUDIT_CONTRACT_EXEMPT 留痕（空声明 = 声明无契约，合法态，非缺陷）。
    //   ⇒ 本用例不测告警 ⇒ 断言口径改为「除去骨架留痕后为空」。
    const benignT5 = new Set(['GATE_AUDIT_CONTRACT_EXEMPT']);
    assert.deepEqual(out.warnings.filter((w) => !benignT5.has(w.code)), [], '包内声明齐备 ⇒ 无角色告警（除去骨架两条留痕）');
    // 前缀来源自证：逐字等于包内资产声明（独立读盘对照；根由模块位置推导，**不依赖 cwd**——
    // 命令 gate 的 cwd 契约是 worktree/GATE_REPO_ROOT 兜底 artifacts 根，故测试不得用 process.cwd()）
    const pkgAsset = loadTeamAsset(packageRoot(), 'software-team');
    assert.equal(pkgAsset.ok, true);
    assert.deepEqual(pkgAsset.asset.layers.plan.skills.designer, ['spec-writing', 'writing-plans'],
      '前缀来源自证：逐字等于新骨架声明（859 B 最小骨架，2026-09-26 瘦身）');
    // ② punky-preset（**预设/模式资产**，非团队资产；团队资产文件不存在）：
    //    【2026-09-27 反转】P1 的「无资产 ⇒ 构造期拒 + 零批次 JSON 落盘」已退役 ⇒ 回到「不阻断建批」，
    //    但**不再静默**：原 `TEAM_ASSET_NOT_FOUND` 码进 warnings 留痕（判据面等价：码面与落盘两侧都还在，只是读数反转）。
    const jf = await byName.wave_plan.execute({ batchId: 'troot-t5-jf', tasks: pkgTasks(), team: 'punky-preset', assembly: { auditLane: 'a1' } }, SESS);
    const jfHit = jf.warnings.find((w) => w.code === 'TEAM_ASSET_NOT_FOUND');
    assert.ok(jfHit, 'punky-preset 是模式名、不是团队资产 ⇒ 须留痕 TEAM_ASSET_NOT_FOUND：' + JSON.stringify(jf.warnings));
    assert.ok(!cmdsOf(jf).some((c) => /\[skills=/.test(c)), '无资产 ⇒ 不加任何技能前缀（前缀面判据逐字不变）');
    assert.equal(fs.existsSync(batchFileOf(root, 'troot-t5-jf')), true, '批次 JSON 落盘（P1 的「拒后零落盘」已反转）');
    // ③ 对照：同 tasks 传临时根（team=tmp-team）→ 前缀换成临时资产（证明 ①② 的包内前缀不是偶然）
    const outTmp = await byName.wave_plan.execute({ batchId: 'troot-t5-tmp', tasks: tmpTasks(), team: TMP_TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
    assert.match(outTmp.wavePlan[0].tasks[0].cmd, /\[skills=TMP-PLAN-SKILL\]/);
    assert.ok(!cmdsOf(out).some((c) => /TMP-/.test(c)), '缺省 teamsRoot 时临时资产完全不参与');
    assert.ok(fs.existsSync(batchFileOf(root, 'troot-t5-pkg')), '包内资产批次照常落盘');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
    clearRoleCache();
  }
});

// ── T6 A5：临时团队批次同受 Tier3 门禁（不可绕过）──

test('T6 门禁不可绕过（临时团队语境）：exec 缺 consume 拒派 GATE_ENTRY_MISSING；audit 未验收拒 complete', async () => {
  const { root, store, byName } = makeHarness();
  const teamsRoot = mkTeamsRoot(TMP_TEAM, tmpAsset());
  try {
    clearRoleCache();
    // 临时团队建批（e1.consume=['plan/outline.md'] 未落盘）
    await byName.wave_plan.execute({ batchId: 'troot-t6', tasks: tmpTasks(), team: TMP_TEAM, teamsRoot, assembly: { auditLane: 'a1' } }, SESS);
    // G2 前置（2026-09-14 新门禁）：本批声明（缺省归一化）`managerPlan: 'raise'` ⇒ exec 层派发前须先登记 Manager；
    //   否则 entry 门先返 「未拉起 Manager」码(已删)，本用例的被检面（GATE_ENTRY_MISSING）不可达。
    registerManager(store, SESS.agent.session.id, 'troot-t6', 'mgr-t6');
    await assert.rejects(
      () => byName.member_status.execute({ batchId: 'troot-t6', lane: 'e1', status: 'running' }, SESS),
      /GATE_ENTRY_MISSING: plan\/outline\.md/,
      'exec 缺 consume 产物 → 派发被拒',
    );
    await byName.batch_phase.execute({ batchId: 'troot-t6', phase: 'running' }, SESS);
    await assert.rejects(
      () => byName.batch_phase.execute({ batchId: 'troot-t6', phase: 'complete' }, SESS),
      /GATE_EXIT_PENDING_AUDIT: a1/,
      'audit 未验收 → complete 被拒',
    );
    const raw = JSON.parse(fs.readFileSync(batchFileOf(root, 'troot-t6'), 'utf8'));
    assert.equal(raw.phase, 'running', 'complete 被拒：批次仍在 running');
    assert.ok(raw.events.some((e) => e.type === 'gate.entry.missing'), 'gate.entry.missing 事件留痕');
    assert.ok(raw.events.some((e) => e.type === 'gate.complete_blocked'), 'gate.complete_blocked 事件留痕');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(teamsRoot, { recursive: true, force: true });
    clearRoleCache();
  }
});

// ── T7 入参契约：teamsRoot 顶层声明为 string；非字符串由宿主 arg 校验拒（不进 execute）──

test('T7 入参契约：parameters 顶层含 teamsRoot(string)；非字符串在宿主 arg 校验面即拒', async () => {
  const { byName } = makeHarness();
  // defineTool 已把参数 DSL 编译为 JSON Schema（宿主同一条校验路径）
  assert.equal(byName.wave_plan.parameters.properties.teamsRoot?.type, 'string', 'parameters 顶层 teamsRoot 已声明为 string');
  assert.equal('teamsRoot' in byName.wave_plan.parameters.properties, true);
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'troot-t7', tasks: tmpTasks(), team: TMP_TEAM, teamsRoot: 42 }, SESS),
    /invalid arguments: "teamsRoot" must be a string/,
  );
  // 不传 teamsRoot：既有调用面零影响（同一次调用成功建批）
  // 【P1 同步】`team` 现为必填且必须解析到资产 ⇒ 补 `team:'software-team'`（包内资产，技能根已由本文件模块级注入）；
  //   本用例的判据（缺省 teamsRoot 不影响建批）不变。
  const out = await byName.wave_plan.execute({ batchId: 'troot-t7-ok', team: 'software-team', tasks: [{ id: 'x' }, { id: 'y', deps: ['x'] }] }, SESS);
  assert.ok(out.lanes.x === 'pending');
});
