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

// K 组 · 载入 / 装配面（进程内，无需真宿主）：H-01 … H-04。
// 每项**自带阳性对照（P）**：先跑「应通过」的输入，再跑「应被拒 / 应被检出」的输入。
// P 不过 ⇒ 该项 FAIL 且文案带 `阳性对照失败`（判据自身可疑，不是被测对象的问题）。

import fs from 'node:fs';
import path from 'node:path';
import {
  activeHandlesCount, expect, expectThrow, guardFingerprint, makeAssemblyCtx, readJson, sha256File, skip,
} from './support.mjs';

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ⚠ **判据输入前提订正（c1 实测，2026-10-23）**：plan 的 D-1.2 / H-03 与 `lib/tools/register.js` 的注释都写
//   「实测工具总数：裸配置 20 / patch 全开 21」，但 HEAD `0b2947d` 实测 = **31 / 32**（差集仍恰 = `log_export`）。
//   成因：20/21 是更早版本的读数，`register.js` 的注释随工具面扩张未同步（文档漂移，非行为漂移）。
//   ⇒ 本项**按 HEAD 实测基线钉死**（31/32）而不是抄规格里过时的 20/21：钉死的目的是「后续任何注册面漂移即红」，
//     钉一个当前就不成立的数会让冒烟在干净 HEAD 上恒红（那就不是判据了）。
//   订正已登记进 `exec/change-host-smoke.md`「规格输入前提订正」段，供 a1 复核。
//   【G3 B1 删 5 件后重钉】**裸配置 26 / patch 全开 27**（差集仍恰 = `log_export`）；取数命令见
//     `exec/e3-impl.md` §⑨（`createTools` 裸 `{}` vs `{capabilities:{logs:{enabled:true}}}` 两次实测）。
//
// 【2026-11-07 · 假绿实证 → 计数之上加「集合身份」层】
//   实证：工具**换名**（`member_status` → `member_set_status`）后总数不变 ⇒ 只靠计数的判据对该类漂移
//   **失明**；该漂移当时只被下面的枚举取值**偶然**抓到（取不到值 ⇒ 非数组才红）。
//   ⇒ 在计数之外**加一层集合身份**：期望集从 `test/tools.test.js` 的冻结名单 `TOOL_NAMES` **派生**
//   （全仓唯一权威；`tool-descriptor` / `tool-face-ledger` 同源），不手抄。
//   两个计数常量**保留**（既有交叉校验件 `judging-toolcount` / `housekeeping-h2` 引用它们做真源自洽）。
//   两层并存：计数先失败快定位，集合再兜住「换名 / 增 / 删」三类漂移（后者计数抓不到）。
const LOG_TOOLS_EXTRA = ['log_export']; // patch 全开相对裸配置的唯一增量（差集判据见下）
const EXPECTED_TOOLS_BARE = 27;   // 【2026-11-07 · G-2】+1 = `taskpack_for`（D 档任务包取件口，只读）
const EXPECTED_TOOLS_FULL = 28;

/** 冻结名单（唯一权威 = `test/tools.test.js` 的 `TOOL_NAMES`）。派生而非手抄 ⇒ 双源不一致即红。 */
function frozenToolNames(repoRoot) {
  const p = path.join(repoRoot, 'test', 'tools.test.js');
  expect(fs.existsSync(p), '阳性对照失败：冻结名单定义点不存在（' + p + '）');
  const src = fs.readFileSync(p, 'utf8');
  const m = src.match(/const TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/);
  expect(Boolean(m), '阳性对照失败：test/tools.test.js 未找到 `const TOOL_NAMES = [...]`（冻结名单定义点）');
  const names = [...m[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((x) => x[1]);
  expect(names.length > 0, '阳性对照失败：冻结名单解析为空（正则与写法不符）');
  return names;
}

/** H-01 部署面载入（§D-1.1-2：**读部署面，不读仓内路径**）。SKIP-able。 */
function h01(sm) {
  const { repoRoot, deployEntry, repoEntry } = sm;

  // ── 阳性对照：仓内入口真实存在且 sha 可算（不可算 ⇒ 判据自身可疑）──
  expect(fs.existsSync(repoEntry), '阳性对照失败：仓内入口不存在（' + repoEntry + '）');
  const repoSha = sha256File(repoEntry);
  expect(/^[0-9a-f]{64}$/.test(repoSha), '阳性对照失败：入口 sha 形态非法（' + repoSha + '）');
  // ── 阴性对照：不存在的入口必须被同一探针判为不可读（证明 sha 探针真的碰盘）──
  let absentDetected = false;
  try { sha256File(path.join(repoRoot, 'lib', 'index.smoke-absent.js')); } catch { absentDetected = true; }
  expect(absentDetected, '阴性对照失败：不存在的入口被判为可读（探针未碰盘）');

  if (!fs.existsSync(deployEntry)) {
    skip('缺部署面入口 ' + deployEntry + '（desktop profile 未装本插件 ⇒ 部署面不可判；不算 pass）');
  }
  const deployReal = fs.realpathSync(deployEntry);
  const expectedReal = path.join(fs.realpathSync(repoRoot), 'lib', 'index.js');
  expect(samePath(deployReal, expectedReal),
    '部署面入口 realpath 未落到仓根：' + deployReal + ' ≠ ' + expectedReal + '（软链断 / 装的是包 / 双副本）');
  const deploySha = sha256File(deployEntry);
  expect(deploySha === repoSha,
    '部署面入口与仓内入口 sha 不同（打错包 / 双副本）：deploy=' + deploySha.slice(0, 12) + ' repo=' + repoSha.slice(0, 12));
  const deployPkg = path.join(path.dirname(path.dirname(deployEntry)), 'package.json');
  const vDeploy = readJson(deployPkg).version;
  const vRepo = readJson(path.join(repoRoot, 'package.json')).version;
  expect(vDeploy === vRepo, '两侧 package.json.version 不一致：deploy=' + vDeploy + ' repo=' + vRepo);
  return 'realpath=' + deployReal + ' · entrySha256=' + deploySha.slice(0, 16) + '… · version=' + vRepo;
}

/** H-02 隔离根下真实 `apply()` 装载 + 卸载幂等（无定时器残留）。 */
async function h02(sm) {
  // ── 阴性对照：状态根不可建 ⇒ fail-closed 抛错（且抛在装配之前）──
  const blocked = path.join(sm.isoRoot, 'not-a-directory');
  sm.ledger.writeFile(blocked, 'smoke: 这是一个普通文件，用来让 mkdirSync 失败');
  const blockedMsg = await expectThrow(
    () => sm.mod.apply(makeAssemblyCtx(), { root: blocked }),
    /引擎状态根不可创建/, '阴性对照：root 不可建时必须 fail-closed');
  expect(/config\.root/.test(blockedMsg), '阴性对照：错误文案未点名配置键 config.root（可诊断性不足）：' + blockedMsg.slice(0, 300));

  // ── 正题：隔离根下真实装载（与宿主同一入口 apply(ctx, config)）──
  const before = activeHandlesCount();
  const mount = sm.mount({}, { subagents: { start: async () => ({ result: Promise.resolve({}) }) } });
  try {
    expect(typeof mount.disposer === 'function', 'apply() 未返回 disposer（不可回收 ⇒ 卸载不幂等）');
    expect(mount.ctx.calls.warn.length === 0,
      '装载期 ctx.logger.warn 非零：' + JSON.stringify(mount.ctx.calls.warn).slice(0, 600));
    expect(mount.registered.length > 0, '工具面零注册（装配面被改坏）');
    const names = mount.registered.map((t) => t?.name).filter(Boolean);
    expect(new Set(names).size === names.length, '工具名重复注册：' + names.join(','));
  } finally {
    mount.disposer();
  }
  mount.disposer(); // 二次调用必须幂等（不抛）
  const after = activeHandlesCount();
  expect(after.total === before.total,
    '卸载后活动 handle/request 未回到装载前：before=' + before.total + ' after=' + after.total
    + '（before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after) + '）');
  return '装载/卸载各 1 次 + 二次 dispose 幂等 · 零装载期 warn · 工具 ' + mount.registered.length + ' 个 · handle '
    + before.total + '→' + after.total;
}

/** H-03 工具注册面：两档真值 = 本文件 :36-37 的 EXPECTED_TOOLS_BARE / EXPECTED_TOOLS_FULL，差集恰 = log_export；member_set_status 枚举不含 idle。 */
function h03(sm) {
  const bare = sm.mount({}, { subagents: { start: async () => ({ result: Promise.resolve({}) }) } });
  const namesBare = bare.registered.map((t) => t?.name).filter(Boolean);
  bare.disposer();

  const full = sm.mount(
    { capabilities: { logs: { enabled: true }, worktree: { enabled: true }, watch: { enabled: true }, discovery: { enabled: true }, trajectory: { enabled: true }, budget: { enabled: true }, verify: { enabled: true } }, aip: { enabled: true }, dispatch: { provider: 'spawn' } },
    { subagents: { start: async () => ({ result: Promise.resolve({}) }) } });
  const namesFull = full.registered.map((t) => t?.name).filter(Boolean);
  const toolsFull = full.tools;
  full.disposer();

  expect(new Set(namesBare).size === namesBare.length, '裸配置工具名重复：' + namesBare.join(','));
  expect(new Set(namesFull).size === namesFull.length, 'patch 全开工具名重复：' + namesFull.join(','));
  // ── 第一层：计数（快速失败，沿用两个真源常量；既有交叉校验件也引用它们）──────────────
  expect(namesBare.length === EXPECTED_TOOLS_BARE,
    '裸配置工具数 = ' + namesBare.length + '，期望 ' + EXPECTED_TOOLS_BARE + '（工具注册面漂移）：' + namesBare.slice().sort().join(','));
  expect(namesFull.length === EXPECTED_TOOLS_FULL,
    'patch 全开工具数 = ' + namesFull.length + '，期望 ' + EXPECTED_TOOLS_FULL + '：' + namesFull.slice().sort().join(','));
  // ── 第二层：集合身份（**换名**这类「数量不变」的漂移只有这一层抓得住）──────────────
  //   期望集从冻结名单派生（`frozenToolNames`）；差异双向点名（缺 / 多），便于定位。
  const frozen = frozenToolNames(sm.repoRoot).sort();
  const frozenFull = [...frozen, ...LOG_TOOLS_EXTRA].sort();
  const missingOf = (got, want) => want.filter((n) => !got.includes(n));
  const extraOf = (got, want) => got.filter((n) => !want.includes(n));
  const bareSorted = namesBare.slice().sort();
  const fullSorted = namesFull.slice().sort();
  expect(JSON.stringify(bareSorted) === JSON.stringify(frozen),
    '裸配置工具名集 ≠ 冻结名单 TOOL_NAMES（test/tools.test.js）'
    + '｜缺=' + JSON.stringify(missingOf(bareSorted, frozen))
    + '｜多=' + JSON.stringify(extraOf(bareSorted, frozen)));
  expect(JSON.stringify(fullSorted) === JSON.stringify(frozenFull),
    'patch 全开工具名集 ≠ 冻结名单 + [' + LOG_TOOLS_EXTRA.join(',') + ']'
    + '｜缺=' + JSON.stringify(missingOf(fullSorted, frozenFull))
    + '｜多=' + JSON.stringify(extraOf(fullSorted, frozenFull)));
  const onlyFull = namesFull.filter((n) => !namesBare.includes(n)).sort();
  const onlyBare = namesBare.filter((n) => !namesFull.includes(n)).sort();
  expect(onlyFull.length === 1 && onlyFull[0] === 'log_export',
    '两次装载的名字差集 ≠ [log_export]：仅全开=' + JSON.stringify(onlyFull) + ' 仅裸=' + JSON.stringify(onlyBare));
  // ── 阴性对照：log_export 在裸配置里**必须**缺席（证明该开关是真开关，不是恒在）──
  expect(!namesBare.includes('log_export'), '阴性对照失败：裸配置里也注册了 log_export（能力开关失效）');
  // 【2026-11-07 修 · 假红】工具名早已从 `member_status` 改为 `member_set_status`（实测 `lib/**` 旧名
  //   **0 命中**、新名 **35 命中**），本行仍用旧名 ⇒ 恒取 `undefined` ⇒ 本项恒红（假红）。
  //   现对齐真实工具名；旧名残留只在本冒烟自身的真值表里，与引擎实现无关。
  const enumOf = toolsFull.get('member_set_status')?.parameters?.properties?.status?.enum;
  expect(Array.isArray(enumOf), 'member_set_status.parameters.properties.status.enum 不是数组：' + JSON.stringify(enumOf));
  expect(JSON.stringify(enumOf) === JSON.stringify(['pending', 'running', 'review']),
    'member_set_status.status 闭集 = ' + JSON.stringify(enumOf) + '，期望 ["pending","running","review"]（idle 被放回枚举？）');
  // ── 阴性对照：`idle` 必须**不在**闭集里（它就是本项要防的漂移）──
  expect(!enumOf.includes('idle'), '阴性对照失败：`idle` 出现在 member_set_status.status 闭集里');
  return '裸配置 ' + namesBare.length + ' / patch 全开 ' + namesFull.length + ' · 差集=' + JSON.stringify(onlyFull)
    + ' · member_set_status.status=' + JSON.stringify(enumOf);
}

/** H-04 真实 home 守卫面指纹逐字相同 + 写盘台账全在隔离根之下 + 生产面零 runTag。 */
function h04(sm) {
  const after = guardFingerprint({ deep: sm.guardDeep });
  expect(after.rows.length === sm.beforeGuard.rows.length, '守卫面行数变化（分母漂了，指纹不可比）');
  expect(after.sha === sm.beforeGuard.sha,
    '真实 home 守卫面指纹变化（隔离失效：syncAssets 经裸 os.homedir() 写到了真实 home）\n  before=' + sm.beforeGuard.sha
    + '\n  after =' + after.sha + '\n  面=' + after.rows.map((r) => r.split('=')[0]).join(' | '));
  // ── 阳性对照：同一输入的指纹可复现（否则「相同」可能来自恒定 bug）──
  const again = guardFingerprint({ deep: sm.guardDeep });
  expect(again.sha === after.sha, '阳性对照失败：同输入两次指纹不一致（指纹函数不确定）');
  // ── 写盘台账：脚本自身的每个写点都必须在隔离根之下 ──
  const escapes = sm.ledger.escapes();
  expect(escapes.length === 0, '写盘台账越界 ' + escapes.length + ' 条（隔离失效）：'
    + escapes.slice(0, 5).map((e) => e.path).join(' | '));
  expect(sm.ledger.entries.length > 0, '阳性对照失败：写盘台账为空（本应登记隔离根与 stamp 的写点）');
  // ── 生产面：真实 session/artifacts 零新增 + 生产 sink 无本次 runTag ──
  const afterProd = sm.productionAfter();
  const newSessions = afterProd.sessionNames.filter((s) => !sm.productionBefore.sessionNames.some((p) => p.name === s.name));
  expect(newSessions.length === 0, '真实 sessions/ 新增了目录（隔离失效）：' + newSessions.map((s) => s.name).join(','));
  expect(!sm.productionBefore.sessionNames.some((s) => s.name.includes(sm.runTag)),
    '阳性对照失败：真实 sessions/ 本就含同名 runTag（runTag 生成器退化）');
  const newArtifacts = [];
  for (const sessionAfter of afterProd.sessionNames) {
    const before = sm.productionBefore.sessionNames.find((p) => p.name === sessionAfter.name);
    if (!before) continue;
    for (const batch of sessionAfter.artifacts) if (!before.artifacts.includes(batch)) newArtifacts.push(sessionAfter.name + '/' + batch);
  }
  expect(newArtifacts.length === 0, '真实 artifacts/ 新增了批次目录（隔离失效）：' + newArtifacts.join(','));
  expect(sm.prodHits.hits.length === 0,
    '生产审计 sink 出现本次 runTag（隔离失效，生产日志被冒烟行污染）：' + sm.prodHits.hits.join(' | '));
  return '守卫面 sha 逐字相同 · 台账 ' + sm.ledger.entries.length + ' 条全在隔离根下 · 真实 sessions 零新增 · 生产 sink 零 runTag'
    + (sm.prodHits.notes.length ? ' · 大文件只读首尾：' + sm.prodHits.notes.join('; ') : '');
}

export function buildK(sm) {
  return [
    { id: 'H-01', title: '部署面载入（realpath ≡ 仓根 / 两侧 version / 入口 sha）· SKIP-able', run: () => h01(sm) },
    { id: 'H-02', title: 'apply() 真实装载 + 卸载幂等（零装载期 warn / handle 回基线）', run: () => h02(sm) },
    { id: 'H-03', title: '工具注册面（钉 HEAD 基线 · 两档真值 = EXPECTED_TOOLS_BARE / EXPECTED_TOOLS_FULL）+ 差集 = log_export + member_set_status 枚举', run: () => h03(sm) },
    { id: 'H-04', title: '真实 home 守卫面零漂移 + 台账全在隔离根 + 生产面零 runTag', run: () => h04(sm) },
  ];
}
