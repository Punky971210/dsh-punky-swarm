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

// P2（2026-09-14 用户裁决 B）：audit 职责声明化——`flows.audit.audit_contract` 的建批期门禁
//   缺键 → 拒建批 GATE_AUDIT_CONTRACT_MISSING；显式空 {} / {exempt:true} → 放行 + 留痕告警 GATE_AUDIT_CONTRACT_EXEMPT；
//   无团队资产（generic / 无该资产）→ 跳过（零感知）。测试用「复制内置资产再改一处」构造三形态，避免手搓资产骨架。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { globMatchesPath } from '../lib/assembly/flows.js';
import { loadTeamAsset, TEAM_ASSET_CODES } from '../lib/assembly/team-asset.js';
import { anchorSpecOf, assessC, seedArtifacts, threeTierTasks } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills } from './helpers/host-skills.mjs';
import { fileURLToPath } from 'node:url';

// 【P1 同步 · 宿主技能根】本套件的临时团队资产（`probe-team`）以包内 `software-team` 资产为骨架 ⇒
//   其 skills 与 software-team 同集；P1 起这些 skills 必须**可解析**（不可解析 / 技能根缺失 ⇒
//   `TEAM_ASSET_SKILLS_MISMATCH` 拒建批）⇒ 隔离 HOME 下先显式注入宿主技能根。
seedTeamAssetSkills('software-team');

const SESS = { agent: { session: { id: 'sess-p2' } } };
// 【可移植性修复 2026-09-16】原写法 `new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')`
//   手工剥盘符但**未做 URL 解码** ⇒ 包路径含空格时得到 `%20`（实测：副本目录名带空格即 ENOENT）。
//   统一改走 `fileURLToPath`（本仓其余测试/脚本均用此写法）。
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ASSET = path.join(PKG, 'presets', 'software-team', 'team-asset.yml');

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-p2-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger: console };
  const tools = createTools(ctx, { store, root });
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  // G1 前置（新门禁）：`wave_plan` / `member_status` 属 C 档动作 ⇒ 建批前先评估为 C（同 assign_check 落盘函数）
  assessC(store, SESS.agent.session.id, { rationale: 'fixture：audit 契约门套件建批前置评估（多 lane 并行 ⇒ C 档）' });
  return { root, store, byName };
}

// 写一份「临时团队资产」：以包内 software-team 资产为骨架，按 mutate 改一处；返回 teamsRoot
function writeTempTeam(prefix, team, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(root, 'presets', team);
  fs.mkdirSync(dir, { recursive: true });
  const asset = JSON.parse(fs.readFileSync(SRC_ASSET, 'utf8'));
  mutate(asset);
  fs.writeFileSync(path.join(dir, 'team-asset.yml'), JSON.stringify(asset, null, 2), 'utf8');
  return root;
}

function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'], cmd: 'code' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'], cmd: 'accept' },
  ];
}

test('P2：团队资产声明了 audit_contract → 建批通过且无豁免告警', async () => {
  const { byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-p2-ok-', 'probe-team');
  const out = await byName.wave_plan.execute({
    batchId: 'p2-ok', team: 'probe-team', teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' },
  }, SESS);
  assert.equal(out.batchId, 'p2-ok');
  assert.equal(out.warnings.some((w) => w.code === 'GATE_AUDIT_CONTRACT_EXEMPT'), false, '实内容声明不应产生豁免告警');
});

test('P2：团队资产缺 audit_contract → 拒建批 GATE_AUDIT_CONTRACT_MISSING', async () => {
  const { byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-p2-miss-', 'probe-team', (a) => { delete a.flows.audit.audit_contract; });
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'p2-miss', team: 'probe-team', teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' } }, SESS),
    /GATE_AUDIT_CONTRACT_MISSING: team "probe-team" declares flows\.audit but no audit_contract/,
  );
});

test('P2：显式空 audit_contract → 放行并落豁免告警（带 reason 时一并携带）', async () => {
  const { byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-p2-exempt-', 'probe-team', (a) => { a.flows.audit.audit_contract = { exempt: true, reason: '冒烟：本团队无 audit 契约，显式豁免' }; });
  const out = await byName.wave_plan.execute({
    batchId: 'p2-exempt', team: 'probe-team', teamsRoot, tasks: tasks3(), assembly: { auditLane: 'a1' },
  }, SESS);
  const w = out.warnings.find((x) => x.code === 'GATE_AUDIT_CONTRACT_EXEMPT');
  assert.ok(w, '显式豁免须落留痕告警');
  assert.equal(w.team, 'probe-team');
  assert.match(w.reason ?? '', /显式豁免/);
});

test('【P1 反转 + 同步】无团队资产（未注册团队名）⇒ 构造期拒 TEAM_ASSET_NOT_FOUND + 零批次落盘', async () => {
  const { root, byName } = makeHarness();
  // 旧口径：「无资产 ⇒ **跳过** audit_contract 检查（零感知）、建批照常」——P1 §1/§2 已废除该路径
  //   （`team` 必填且必须解析到资产；无资产 ⇒ 构造期拒）⇒ 「零感知」在本门内**不再可达**，
  //   断言由「建批照常」反转成「拒 + 零批次 JSON 落盘」，判据未删（仍逐字核对同一入参形态）。
  let msg = null;
  try {
    await byName.wave_plan.execute({
      batchId: 'p2-none', team: 'no-such-team-xyz', tasks: tasks3(), assembly: { auditLane: 'a1' },
    }, SESS);
  } catch (e) {
    msg = String(e?.message ?? e);
  }
  assert.notEqual(msg, null, 'P1：无资产团队不得再走「跳过检查 + 建批照常」');
  assert.match(msg, /TEAM_ASSET_NOT_FOUND/, '拒态须原样透出资产码：' + String(msg));
  assert.equal(fs.existsSync(path.join(root, 'sessions', SESS.agent.session.id, 'batches', 'p2-none.json')), false, '拒后零批次 JSON 落盘');
});

// ── A 方案（2026-09-14）：三个字段的**消费点**测试（此前为声明白契约，无消费） ──

test('A：consumes_required 未被满足 → 拒建批（建批期加强门禁生效）', async () => {
  const { byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-p2-cr-', 'probe-team', (a) => {
    a.flows.audit.audit_contract = { consumes_required: ['plan/', 'exec/'], verdict: ['pass', 'fail', 'skip'] };
  });
  const tasks = tasks3().map((t) => (t.id === 'a1' ? { ...t, consume: ['plan/spec.md'] } : t)); // audit 只消费 plan
  await assert.rejects(
    () => byName.wave_plan.execute({ batchId: 'p2-cr', team: 'probe-team', teamsRoot, tasks, assembly: { auditLane: 'a1' } }, SESS),
    /GATE_AUDIT_INPUT_MISSING: audit_contract\.consumes_required not satisfied for \["exec\/"\]/,
  );
});

test('A：criteria_from 指名锚点 → 未被指名的 plan 产物带标题不顶用（entry 期）', async () => {
  const { store, byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-p2-cf-', 'probe-team', (a) => {
    a.flows.audit.audit_contract = { criteria_from: 'plan/spec.md', verdict: ['pass', 'fail', 'skip'] };
  });
  const tasks = tasks3().map((t) => (t.id === 'a1' ? { ...t, consume: ['plan/spec.md', 'plan/other.md', 'exec/e1/o.md'] } : t));
  await byName.wave_plan.execute({ batchId: 'p2-cf', team: 'probe-team', teamsRoot, tasks, assembly: { auditLane: 'a1' } }, SESS);
  const dir = store.artifactsDirOf('sess-p2', 'p2-cf');
  const write = (rel, body) => { const abs = path.join(dir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body, 'utf8'); };
  write('plan/spec.md', '# spec（被指名的锚点，故意无标题）\n');
  write('plan/other.md', '# other\n## 验收标准\n- ok\n'); // 带标题，但**不是**指名的锚点
  write('exec/e1/o.md', 'out');
  await assert.rejects(
    () => byName.member_status.execute({ batchId: 'p2-cf', lane: 'a1', status: 'running' }, SESS),
    /GATE_AUDIT_CRITERIA_MISSING/,
    '指名口径下，未被指名的 plan 产物带标题不应顶用',
  );
  write('plan/spec.md', '# spec\n## 验收标准\n- ok\n');
  const r = await byName.member_status.execute({ batchId: 'p2-cf', lane: 'a1', status: 'running' }, SESS);
  assert.equal(r.status, 'running', '补上指名锚点的裸标题行后放行');
});

// ── 回归：`globMatchesPath` 末段回退缺陷（2026-09-14 修）──
// 缺陷：末段回退把 `plan/**` 的末段 `**` 退化成「匹配任意路径」⇒ `plan/**` 会命中 `exec/e1/o.md`，
//   使 audit 的 `criteria_from` 锚点与 plan 内容契约的 `artifact_globs` **静默放宽**（判据形同虚设）。
// 修法：末段回退**仅对绝对路径**生效（保留其原始动机），且**末段为纯通配 `**` 时不回退**。
test('glob 回归：`plan/**` 不再命中 exec 路径；绝对路径末段回退仍生效', () => {
  assert.equal(globMatchesPath('plan/**', 'exec/e1/o.md'), false, '`**` 末段不得退化成匹配任意路径（本次缺陷回归点）');
  assert.equal(globMatchesPath('plan/**', 'plan/spec.md'), true, '正常目录前缀匹配不受影响');
  assert.equal(globMatchesPath('plan/**', 'D:/x/sess/artifacts/b1/exec/e1/o.md'), false, '绝对路径亦不得越过目录前缀');
  assert.equal(globMatchesPath('plan/spec.md', 'D:/x/sess/artifacts/b1/plan/spec.md'), true, '绝对路径末段回退（原始动机）保留');
  assert.equal(globMatchesPath('plan/*spec.md', 'D:/x/sess/artifacts/b1/plan/design-spec.md'), true, '带目录前缀的 glob 对绝对路径产物不失配');
  assert.equal(globMatchesPath('plan/*spec.md', 'D:/x/sess/artifacts/b1/exec/design-spec.md'), false, '末段回退只在末段命中时生效，不跨目录放宽');
});

test('A：verdict 成为 complete 门禁唯一真源（legacy require_audit_outcomes 不再生效）', () => {
  const { store } = makeHarness();
  const teamsRoot = writeTempTeam('punky-p2-vd-', 'probe-team', (a) => {
    a.flows.audit.audit_contract = { verdict: ['pass'] };             // 唯一真源：只允许 pass
    // 【legacy-retire-20260915 · E-4 措辞正名】原注释「legacy 更宽（若仍生效则不会拒）」——
    //   legacy 键已清退：若引擎仍读它，白名单会取更宽的 ['pass','skip'] ⇒ skipped 放行；
    //   本用例**拒**即活证据：verdict 是唯一真源，引擎已忽略该键。
    // 【F-4（2026-09-15 用户裁决 Q-D=A）· 原 `a.flows.complete = { require_audit_outcomes: ['pass','skip'] };` 行删除】
    //   F-4 后 `complete` 已退出 `FLOW_SECTIONS` ⇒ 该夹具键会使本资产**整份拒载** ⇒ 读端回落引擎基线
    //   {pass,skip} ⇒ skipped 放行 ⇒ 下方 `assert.throws(/GATE_COMPLETE_AUDIT_FAILED/)` 反而失真（假证据）。
    //   故删该 1 行夹具键、**用例与 `assert.throws` 断言逐字保留**：其活证据语义为「资产经加载期校验
    //   通过（无非法层）⇒ 只剩 `verdict` 驱动 complete 门禁 ⇒ skip 结局被拒」= verdict 是唯一真源。
    //   原「废键不再生效」这一证据面**迁为下方独立拒载反例用例**（断言该资产现被拒载，比 E-4 的
    //   「被引擎忽略」更强）。**不删用例、不删断言、不弱化断言**（Leader 追加裁决 #1）。
  });
  const bf = store.batchFile('sess-p2', 'p2-vd');
  fs.mkdirSync(path.dirname(bf), { recursive: true });
  fs.writeFileSync(bf, JSON.stringify({
    batchId: 'p2-vd', sessionId: 'sess-p2', team: 'probe-team', teamsRoot, phase: 'running', concurrency: 2,
    wavePlan: [{ tasks: tasks3() }], lanes: { p1: 'merged', e1: 'merged', a1: 'skipped' }, events: [], updatedAt: new Date().toISOString(),
  }), 'utf8');
  // audit 结局 = skipped（outcome 'skip'）不在 verdict ['pass'] 内 ⇒ complete 门禁应拒（证明 verdict 生效）
  assert.throws(() => store.setPhase('sess-p2', 'p2-vd', 'complete'), /GATE_COMPLETE_AUDIT_FAILED/);
});

// 【F-4 拒载反例 → **2026-09-18 K-2 翻牌**】承接上方用例迁出的证据面：
//   E-4 口径下，声明 legacy 键 `flows.complete.require_audit_outcomes` 的资产**静默合法**（引擎只是不读它）；
//   F-4 后 `complete` 退出 `FLOW_SECTIONS` ⇒ 该键 ⇒ `TEAM_ASSET_LAYER_UNKNOWN`。
//   **K-2（2026-09-18 用户裁决）**：本机无外部自建 team ⇒ 未知层判定暂时用不到 ⇒ 该码**退出 BLOCKING_CODES**
//   ⇒ 资产**不再拒载**（`ok:true`），改以 **warning 留痕**（码面/文案/严重级三重锚**逐字保留**，断言强度不减）。
//   本用例与 `team-asset.test.js`（单元级）、`gate-flows.test.js`（集成级）构成三处同码同形态锚。
test('F-4 + K-2：声明 flows.complete（E-4 废键所在层）⇒ LAYER_UNKNOWN **warning 级**（不拒载、留痕可读）', () => {
  const teamsRoot = writeTempTeam('punky-p2-f4-', 'probe-team', (a) => {
    a.flows.audit.audit_contract = { verdict: ['pass'] };              // 真源仍在（不因该层降档而另建兼容面）
    a.flows.complete = { require_audit_outcomes: ['pass', 'skip'] };   // F-4：显式声明即命中未知层
  });
  const r = loadTeamAsset(teamsRoot, 'probe-team');
  assert.equal(r.ok, true, 'K-2：未知层为 warning ⇒ 不拒载（与 Q1「都不降」的单码例外一致）');
  const p = r.problems.find((x) => x.path === 'flows.complete');
  assert.equal(p.code, TEAM_ASSET_CODES.LAYER_UNKNOWN);
  assert.equal(p.severity, 'warning', 'K-2：warning 级（码面保留、留痕可读）');
  assert.ok(p.message.includes('未知层：complete'), p.message);
  assert.ok(p.message.includes('允许：plan/exec/audit'), p.message); // 允许集**不含** complete（文案锚）
  assert.notEqual(r.asset, null, '仍回传已解析对象（既有口径）');
  // K-2 语义锚（补留痕）：未知层**被跳过** ⇒ 不对该层做字段校验（无 produce_field 的 MISSING_FIELD 级联）
  assert.equal(r.problems.some((x) => String(x.path).startsWith('flows.complete.')), false, '未知层不做后续字段校验');
});

// ── Q-A4 opt-2（2026-09-18 用户裁决）：夹具锚点**按资产声明自适应** ──────────────────────
// 根因（GAP-A1，已定案）：夹具缺省 `spec = 'plan/spec.md'`（`helpers/gate-fixture.mjs:41/:58`）与
//   「收窄式」`criteria_from`（具体路径）不兼容 ⇒ entry 门 `anchors = []` ⇒ `GATE_AUDIT_INPUT_MISSING`
//   （`gates.js:733-737`）= 上一批 6 条红的单一根因（同码同根因，非外部并发批改写）。
// 本组断言两条：①**适配规则本身**三态可判定；②**零行为变化**（无 `opts.asset` ⇒ 缺省逐字不变，
//   五份现役资产实际取值 = 缺省）。第 4 例为**活证据**：同一具体路径资产下，旧缺省必然失配（控件），
//   喂 `opts.asset` 后 entry 门放行 —— 事故形态被夹具层封堵，而非靠「把键删掉」掩盖。

test('Q-A4 opt-2：锚点自适应三态（未声明 / glob / 具体路径）', () => {
  assert.equal(anchorSpecOf(undefined), 'plan/spec.md', '①未传资产 ⇒ 既有缺省逐字不变');
  assert.equal(anchorSpecOf({}), 'plan/spec.md', '①无 flows 面 ⇒ 缺省');
  assert.equal(anchorSpecOf({ flows: { audit: { audit_contract: {} } } }), 'plan/spec.md', '①空 audit_contract ⇒ 缺省');
  assert.equal(anchorSpecOf({ flows: { audit: { audit_contract: { criteria_from: '   ' } } } }), 'plan/spec.md', '①空白串 ⇒ 缺省');
  assert.equal(anchorSpecOf({ flows: { audit: { audit_contract: { criteria_from: 'plan/**' } } } }), 'plan/spec.md', '②glob `**` ⇒ 缺省');
  assert.equal(anchorSpecOf({ flows: { audit: { audit_contract: { criteria_from: 'plan/*spec.md' } } } }), 'plan/spec.md', '②glob `*` ⇒ 缺省');
  assert.equal(anchorSpecOf({ flows: { audit: { audit_contract: { criteria_from: 'plan/plan-designer-spec.md' } } } }), 'plan/plan-designer-spec.md', '③具体路径 ⇒ 取其值');
  assert.equal(anchorSpecOf({ flows: { audit: { audit_contract: { criteria_from: ' plan/x.md ' } } } }), 'plan/x.md', '③trim 后取值');
  assert.equal(anchorSpecOf({ flows: { audit: { audit_contract: { criteria_from: 'plan/plan-designer-spec.md' } } } }, 'plan/other.md'), 'plan/plan-designer-spec.md', '③自定义 fallback 只在无声明/glob 时生效');
});

test('Q-A4 opt-2：两构造器接受 opts.asset，且 opts.spec 显式给出时优先级最高', () => {
  const asset = { flows: { audit: { audit_contract: { criteria_from: 'plan/plan-designer-spec.md' } } } };
  const t = threeTierTasks(['e1'], { auditId: 'a1', asset });
  assert.equal(t[0].produce[0], 'plan/plan-designer-spec.md', 'plan 产物随资产声明对齐');
  assert.equal(t[2].consume[0], 'plan/plan-designer-spec.md', 'audit consume 同步对齐 ⇒ 声明锚点必在场');
  const t2 = threeTierTasks(['e1'], { auditId: 'a1', asset, spec: 'plan/pinned.md' });
  assert.equal(t2[0].produce[0], 'plan/pinned.md', 'opts.spec 压过自适应');
});

test('Q-A4 opt-2：五份现役资产的自适应值 = 缺省（零行为变化）', () => {
  for (const team of ['software-team', 'engine-team', 'design-team', 'research-team', 'writing-team']) {
    const r = loadTeamAsset(PKG, team);
    assert.equal(r.ok, true, team + ' 资产加载通过');
    assert.equal(anchorSpecOf(r.asset), 'plan/spec.md', team + ' 现无「具体路径」式声明 ⇒ 缺省不变');
  }
});

test('Q-A4 opt-2：同一具体路径资产下——旧缺省必失配（控件）/ 喂 asset 后 entry 门放行（活证据）', async () => {
  const { root, byName } = makeHarness();
  const teamsRoot = writeTempTeam('punky-q-a4-', 'probe-team', (a) => {
    a.flows.audit.audit_contract = { criteria_from: 'plan/plan-designer-spec.md', consumes_required: ['plan/'], verdict: ['pass', 'fail', 'skip'] };
  });
  const asset = JSON.parse(fs.readFileSync(path.join(teamsRoot, 'presets', 'probe-team', 'team-asset.yml'), 'utf8'));

  // 控件：旧缺省（不喂 asset）⇒ 锚点 glob 与在场产物失配 ⇒ 拒（复现上一批 6 红的形态）
  const stale = threeTierTasks(['e1'], { auditId: 'a1' });
  await byName.wave_plan.execute({ batchId: 'q-a4-stale', team: 'probe-team', teamsRoot, tasks: stale, assembly: { auditLane: 'a1' } }, SESS);
  seedArtifacts(root, 'sess-p2', 'q-a4-stale', ['e1'], { auditId: 'a1' });
  await assert.rejects(
    () => byName.member_status.execute({ batchId: 'q-a4-stale', lane: 'a1', status: 'running' }, SESS),
    /GATE_AUDIT_INPUT_MISSING/,
    '控件：夹具缺省 plan/spec.md 对不上具体路径锚点 ⇒ 必须拒（这就是 6 条红的形态）',
  );

  // 活证据：同一资产 + 喂 opts.asset ⇒ 锚点对齐 ⇒ 放行
  const adapted = threeTierTasks(['e1'], { auditId: 'a1', asset });
  await byName.wave_plan.execute({ batchId: 'q-a4-ok', team: 'probe-team', teamsRoot, tasks: adapted, assembly: { auditLane: 'a1' } }, SESS);
  seedArtifacts(root, 'sess-p2', 'q-a4-ok', ['e1'], { auditId: 'a1', asset });
  const r = await byName.member_status.execute({ batchId: 'q-a4-ok', lane: 'a1', status: 'running' }, SESS);
  assert.equal(r.status, 'running', '自适应后口径对齐 ⇒ entry 门放行（不再需要「删键」这种掩盖式解法）');
});
