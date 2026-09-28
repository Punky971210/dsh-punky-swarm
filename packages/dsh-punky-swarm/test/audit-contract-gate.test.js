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
// 【2026-09-27 批 3 · T-15/D-6 归因】原 `import { loadTeamAsset, TEAM_ASSET_CODES } from '../lib/assembly/team-asset.js'`
//   已删（**本体已删除**：A-5/A-6/A-9 实测 0 命中 ⇒ 该 import 是文件级 ESM 缺符号的直接根因）。
import { anchorSpecOf, assessC, seedArtifacts, threeTierTasks } from './helpers/gate-fixture.mjs';
// 【2026-09-27 批 3 · T-15/D-6 归因】原 `import { writeTempTeam } from './helpers/team-fixture.mjs'` 已删
//   （真实骨架 5 件已删，T-4/A-9；`writeTempTeam` 导出本身已随 helper 收口删除）。
import { fileURLToPath } from 'node:url';

const SESS = { agent: { session: { id: 'sess-p2' } } };
// 【可移植性修复 2026-09-16】原写法 `new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')`
//   手工剥盘符但**未做 URL 解码** ⇒ 包路径含空格时得到 `%20`（实测：副本目录名带空格即 ENOENT）。
//   统一改走 `fileURLToPath`（本仓其余测试/脚本均用此写法）。
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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


function tasks3() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1/o.md'], deps: ['p1'], cmd: 'code' },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1/o.md'], produce: ['audit/a.md'], deps: ['e1'], cmd: 'accept' },
  ];
}

// ── 已删（2026-09-27 批 3 · T-15/D-6 归因，三例同因）：原 test「P2：团队资产声明了 audit_contract → 建批通过且
//    无豁免告警」/「P2：团队资产缺 audit_contract → 拒建批 GATE_AUDIT_CONTRACT_MISSING」/「P2：显式空
//    audit_contract → 放行并落豁免告警」──
//   面已消失 = **`flows.audit.audit_contract` 团队声明面**（T-6：`resolveTeamFlows` 读端删除 ⇒ 恒返「无声明」；
//   T-1：`lib/assembly/team-asset.js` 本体删除）⇒ 三例所断言的「声明驱动建批门」**无载体、恒不触发**
//   （`exec/consumers.md` §二.6 逐字记载：`GATE_AUDIT_CONTRACT_MISSING` / `GATE_AUDIT_CONTRACT_EXEMPT` 的判据
//    全部取自团队声明 ⇒ 声明面不存在后为空转面，删除 = 零行为变更）；
//   夹具 `writeTempTeam` 读已删的 5 件真实骨架（T-4/A-9）⇒ 调用即抛，三例整条不可达。
//   ⇒ 按 D-6「面已消失者随删 + 归因」删除；**不可等值反转**（反转成「零告警」= 恒真空转，纪律 15⑤）。
//   **存活面**（本文件其余用例全部原样在册）：锚点门（引擎基线单态）、`globMatchesPath` 末段回退回归、
//   Q-A4 opt-2 的纯函数三态与两构造器契约。引擎默认判据源锚点门（`GATE_AUDIT_INPUT_MISSING` /
//   `GATE_AUDIT_CRITERIA_MISSING`）由 `gates-vocabulary-contract` / `gate-hardening-red` T10 等在册用例覆盖。

test('【2026-09-27 批 3 反转·二次】无团队资产（未注册团队名）⇒ 建批成功 + 批次 JSON 落盘 + **零资产留痕**', async () => {
  const { root, byName } = makeHarness();
  // 口径沿革：① 旧旧口径「无资产 ⇒ 跳过 audit_contract 检查（零感知）、建批照常」→ ② P1（2026-09-16）反转为
  //   「无资产 ⇒ 构造期拒 `TEAM_ASSET_NOT_FOUND` + 零批次 JSON 落盘」→ ③ 2026-09-27（上一批）「team 降为可选标签」
  //   反转为「建批照常 + 原码进 `warnings` 留痕」→ ④ **本批（批 3）二次反转**：`team` 降为**可选自由标签**、
  //   **团队资产面整体退役**（T-1/T-6）⇒ 资产查找面**不存在**，`warnings` **恒为空**（不再有 `TEAM_ASSET_*` 留痕）。
  //   ⇒ 真值再反转一次：由「必须有 `TEAM_ASSET_NOT_FOUND` 留痕」改为「**零资产留痕**」；建批成功 + 批次 JSON 落盘
  //   两条存活断言**逐字保留**（断言数不减：原 3 条 → 现 3 条，把「留痕在场」严格换为「留痕为空集」）。
  const out = await byName.wave_plan.execute({
    batchId: 'p2-none', team: 'no-such-team-xyz', tasks: tasks3(), assembly: { auditLane: 'a1' },
  }, SESS);
  assert.equal(out.batchId, 'p2-none', '无资产团队不得再被构造期拒（team 已是可选自由标签）');
  assert.deepEqual(out.warnings, [],
    '团队资产面已整体退役 ⇒ 零资产留痕（原 `TEAM_ASSET_NOT_FOUND` 码已入退役锁，A-10）；实测=' + JSON.stringify(out.warnings));
  assert.equal(fs.existsSync(path.join(root, 'sessions', SESS.agent.session.id, 'batches', 'p2-none.json')), true, '批次 JSON 落盘');
});

// ── A 方案（2026-09-14）：三个字段的**消费点**测试（此前为声明白契约，无消费） ──

// ── 已删（2026-09-27 批 3 · T-15/D-6 归因，两例同因）：原 test「A：consumes_required 未被满足 → 拒建批
//    （建批期加强门禁生效）」/「A：criteria_from 指名锚点 → 未被指名的 plan 产物带标题不顶用（entry 期）」──
//   面已消失 = **`audit_contract.consumes_required` / `.criteria_from` 两处团队声明位**（T-1/T-6）
//   ⇒ ① `GATE_AUDIT_INPUT_MISSING` 的团队声明分支**无载体**（引擎默认面 `plan/` 前缀锚点在册，覆盖不丢）；
//      ② `criteria_from` 指名锚点面删净（判据源 A-8 基线含 `criteria_from`；指引 §12 已改为
//         「锚点**今日仅一态 = 引擎基线**」）⇒ 「按 glob 指名」不可构造，**不可等值反转**（反转即恒真空转）。

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

test('A：complete 门禁白名单（2026-09-27 批 3 反转）：声明面删净 ⇒ 引擎基线 {pass,skip} ⇒ skipped **放行**', () => {
  const { store } = makeHarness();
  const bf = store.batchFile('sess-p2', 'p2-vd');
  fs.mkdirSync(path.dirname(bf), { recursive: true });
  fs.writeFileSync(bf, JSON.stringify({
    batchId: 'p2-vd', sessionId: 'sess-p2', team: 'probe-team', phase: 'running', concurrency: 2,
    wavePlan: [{ tasks: tasks3() }], lanes: { p1: 'merged', e1: 'merged', a1: 'skipped' }, events: [], updatedAt: new Date().toISOString(),
  }), 'utf8');
  // 【T-15/D-6 等值反转（面仍在：complete 门禁本体）】原用例以「团队资产 `verdict: ['pass']` 声明」为唯一真源
  //   断言 `store.setPhase(..., 'complete')` **抛** `GATE_COMPLETE_AUDIT_FAILED`。裁决面（verdict 声明）已随
  //   T-1/T-6 删净 ⇒ complete 白名单回落**引擎基线 {pass,skip}**（`lib/state/gates.js` 的 Q-7 基线）
  //   ⇒ `skipped` 属白名单 ⇒ 真值反转：**不抛**。
  //   断言强度不减：① `doesNotThrow`（原 `throws` 的对偶，精确判定）；② **并列补正控制**（audit=failed ⇒ 仍抛
  //   同一既有码）——证明「不抛」不是门禁失效，而是白名单口径改变；③ 白名单真源标注精确等值。
  assert.doesNotThrow(() => store.setPhase('sess-p2', 'p2-vd', 'complete'),
    '引擎基线白名单含 skip ⇒ skipped 审计 lane 可 complete（原 verdict 收窄面已退役）');
  const bf2 = store.batchFile('sess-p2', 'p2-vd2');
  fs.writeFileSync(bf2, JSON.stringify({
    batchId: 'p2-vd2', sessionId: 'sess-p2', team: 'probe-team', phase: 'running', concurrency: 2,
    wavePlan: [{ tasks: tasks3() }], lanes: { p1: 'merged', e1: 'merged', a1: 'failed' }, events: [], updatedAt: new Date().toISOString(),
  }), 'utf8');
  assert.throws(() => store.setPhase('sess-p2', 'p2-vd2', 'complete'), /GATE_COMPLETE_AUDIT_FAILED/,
    '正控制：audit=failed ⇒ 仍拒同一既有码（门禁未失效）');
  const b2 = store.readBatch('sess-p2', 'p2-vd2');
  assert.equal(b2.phase, 'running', '被拒后相位不得推进（零静默改写）');
});

// 【F-4 拒载反例 → **2026-09-18 K-2 翻牌**】承接上方用例迁出的证据面：
//   E-4 口径下，声明 legacy 键 `flows.complete.require_audit_outcomes` 的资产**静默合法**（引擎只是不读它）；
//   F-4 后 `complete` 退出 `FLOW_SECTIONS` ⇒ 该键 ⇒ `TEAM_ASSET_LAYER_UNKNOWN`。
//   **K-2（2026-09-18 用户裁决）**：本机无外部自建 team ⇒ 未知层判定暂时用不到 ⇒ 该码**退出 BLOCKING_CODES**
//   ⇒ 资产**不再拒载**（`ok:true`），改以 **warning 留痕**（码面/文案/严重级三重锚**逐字保留**，断言强度不减）。
//   本用例与 `team-asset.test.js`（单元级）、`gate-flows.test.js`（集成级）构成三处同码同形态锚。
// ── 已删（2026-09-27 批 3 · T-15/D-6 归因）：原 test「F-4 + K-2：声明 flows.complete（E-4 废键所在层）
//    ⇒ LAYER_UNKNOWN warning 级（不拒载、留痕可读）」＋ 其上方 legacy-retire / K-2 沿革注释块 ──
//   面已消失 = ① `flows.complete` 团队声明位（T-1 装载器删除 + T-6 读端删除）；② 用例直接消费
//   `loadTeamAsset()` 与 `TEAM_ASSET_CODES.LAYER_UNKNOWN` —— **本体与码族均已删除**（A-5/A-6/A-9 = 0 命中；A-10 入锁）；
//   ③ 夹具 `writeTempTeam` 读已删的 5 件真实骨架（T-4/A-9）⇒ 调用即抛。
//   ⇒ 「未知层 warning 级」四重锚（码面 / 严重级 / 文案 / 层被跳过）的**载体不存在**，按 D-6 删除；
//   **不可等值反转**（反转成「零 problem」= 恒真空转）。同码同形态锚的**存活面**见
//   `gate-flows` 的 complete 重写用例（无声明 ⇒ 引擎基线放行，`jf.ok === true` 臂）。

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

// ── 已删（2026-09-27 批 3 · T-15/D-6 归因，两例同因）：原 test「Q-A4 opt-2：五份现役资产的自适应值 = 缺省
//    （零行为变化）」/「Q-A4 opt-2：同一具体路径资产下——旧缺省必失配（控件）/ 喂 asset 后 entry 门放行（活证据）」──
//   面已消失 = ① 两例的**被检对象**是「五份现役团队资产」（`presets/{software,engine,design,research,writing}-team/
//      team-asset.yml`）与「资产 `criteria_from` 具体路径声明」：5 件资产已随 **T-4/A-9** 删除、装载器随 **T-1** 删除
//      ⇒ `loadTeamAsset(PKG, team)` 与 `writeTempTeam`（读真实骨架）**均不可调用**（调用即抛 / ESM 缺符号）；
//   ② 「收窄式 `criteria_from`（具体路径）与夹具锚点失配」这一**事故形态**的载体已不存在
//      （判据源 A-8 + 指引 §12：锚点**今日仅一态 = 引擎基线**）⇒ 控件臂与活证据臂同时失去对象。
//   **不可等值反转**：反转成「零失配」= 恒真空转（纪律 15⑤：无命中构造即空转）。
//   **存活面**：Q-A4 opt-2 的**纯函数三态**（`anchorSpecOf` 未声明/glob/具体路径）与**两构造器契约**
//   （`threeTierTasks` 接受 `opts.asset` / `opts.spec` 优先级）两例**原样在册**——它们不依赖任何团队资产文件。

