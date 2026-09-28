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
// R3-4 · `GATE_EVENT_CONST_MISSING` **真 E2E**（把 R3-2 的"围栏"升级为"行为证明"）
//
// 来源：`docs/gate-assertion-blueprint-2026-09-21.md` §6.2 的 R3-4 条 —— 原文「子进程 + `module.register()`
//   loader 钩子：在 `load()` 里把 `lib/state/event-types.js` 的 `export const <CONST> = …` 改写为
//   `= undefined`，再驱动一条产 `gate.escape` 的路径，断言「抛且零落盘」」。
//
// 为什么 R3-2 只能落围栏（原文留档）：该守卫的注入缝 `resolveGateEventTypes(evt = EVT)` 是**模块私有**
//   （导出它 = 解冻 C1 未接线项），而默认实参 `import * as EVT` 的 ESM 命名空间**实测不可改**
//   （`Object.isExtensible === false`；`delete ns.X` ⇒ `TypeError: Cannot delete property … of [object Module]`）
//   ⇒ 进程内无法制造「常量缺位」。R3-4 换用**加载期源码改写**：不触碰生产代码，也不解冻任何登记项。
//
// 断言的对象是**生产路径的真实行为**（不是源码文本）：
//   派发 `setMember(…, 'running')` → entry 门放行并产 escape 载荷 → 统一写盘点解析 3 个事件常量
//   → 常量缺位 ⇒ **抛出 `GATE_EVENT_CONST_MISSING` 且批文件逐字节不变**（`atomicWrite` 未执行）。
//
// 独立复算纪律（防"子进程自述即通过"）：子进程输出的 `afterSha` 由**父测试读盘复算**交叉核验；
//   「零落盘」判据 = 复算值 === `beforeSha`。
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(PKG, 'test', 'helpers', 'event-const-missing-child.mjs');
const PRELOADS = ['./test/helpers/isolated-home.preload.mjs', './test/helpers/event-const-sabotage.preload.mjs'];
const MARK = '##R34##';
const CODE = 'GATE_EVENT_CONST_MISSING';

/**
 * 派生一个子进程执行「破坏档 / 对照档」并回读其采集 JSON。
 * `names` 空 ⇒ 不破坏（对照档）。
 */
function runChild(names = [], { weakenGuard = false } = {}) {
  const env = { ...process.env };
  // 两个"启用标记"：子进程侧的两个 helper 被 `--test` 收集执行时会自查这两个变量，
  //   未见标记即静默退出/不注册（见各自文件头「防线」注释）⇒ 本处必须显式置位，否则驱动不生效。
  env.PSWARM_R34_CHILD = '1';
  env.PSWARM_EVENT_CONST_HOOK = '1';
  if (names.length > 0) env.PSWARM_SABOTAGE_CONSTS = names.join(',');
  else delete env.PSWARM_SABOTAGE_CONSTS;
  if (weakenGuard) env.PSWARM_WEAKEN_GUARD = '1';
  else delete env.PSWARM_WEAKEN_GUARD;
  const args = [];
  for (const p of PRELOADS) args.push('--import', p);
  args.push(CHILD);
  const stdout = execFileSync(process.execPath, args, { cwd: PKG, env, encoding: 'utf8' });
  const line = String(stdout).split(/\r?\n/).find((l) => l.startsWith(MARK));
  assert.ok(line, '子进程须输出采集行 ' + MARK + '；实测 stdout 尾部=' + JSON.stringify(String(stdout).slice(-600)));
  const out = JSON.parse(line.slice(MARK.length));
  assert.equal(out.setup.ok, true, '子进程夹具须建成功：' + JSON.stringify(out.setup));
  return out;
}

/** 读盘复算（独立于子进程自述）。 */
function shaOf(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function eventsOnDisk(out) {
  return JSON.parse(fs.readFileSync(out.batchFile, 'utf8')).events ?? [];
}
function cleanup(out) {
  try { fs.rmSync(out.root, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
}

// ── 对照档（**必须先过**：证明驱动路径本身有效，"零落盘"不是"什么都没发生"） ──────────────────
// 若缺此档，破坏档的"批文件未变"可由「驱动路径整体失效」冒充 ⇒ 假证据。本档 = 排除该可能。

test('R3-4 对照：常量齐备 ⇒ 派发放行 + 落 gate.escape{kind:"standalone"}（驱动路径有效性前置）', () => {
  const out = runChild([]);
  try {
    assert.equal(out.control.sabotageApplied, true,
      '对照档须证明三常量俱在（否则"未破坏"不成立）：' + JSON.stringify(out.sabotaged));
    assert.equal(out.threw, false, '常量齐备 ⇒ 不得抛：' + String(out.message));
    assert.equal(out.lanes.e1, 'running', '派发须生效：' + JSON.stringify(out.lanes));
    assert.equal(out.escapeCount, 1, '须真落 gate.escape 事件（本档是"被检路径确实会走到常量解析"的证明）：'
      + JSON.stringify(out.events));
    assert.equal(out.events.find(([t]) => t === 'gate.escape')[1], 'standalone', '载荷 kind 须为 standalone');
    assert.equal(out.undefinedTypeCount, 0, '不得出现失名事件（type 非字符串）');
    // 独立复算：写路径确实改写了磁盘（对照档 sha 必须变）
    assert.equal(shaOf(out.batchFile), out.afterSha, '父测试复算须与子进程自述一致');
    assert.notEqual(out.beforeSha, out.afterSha, '放行 ⇒ 磁盘须被改写（否则对照档无证明力）');
  } finally { cleanup(out); }
});

// ── 破坏档 ①：抹掉**本次路径要用到的** `EVT_GATE_ESCAPE` ─────────────────────────────────

test('R3-4 E2E：event-types.js 缺 EVT_GATE_ESCAPE ⇒ 抛 GATE_EVENT_CONST_MISSING 且**零落盘**', () => {
  const out = runChild(['EVT_GATE_ESCAPE']);
  try {
    assert.equal(out.control.sabotageApplied, true,
      '前置自证：被点名常量须真为 undefined（钩子未生效 ⇒ 本档无效，不得读成守卫失效）');
    assert.equal(out.sabotaged.EVT_GATE_ESCAPE, null, '前置：EVT_GATE_ESCAPE 须已缺位');
    assert.equal(out.sabotaged.EVT_GATE_DEGRADE, 'gate.degrade', '前置：其余两常量逐字不变（只改点名项）');

    assert.equal(out.threw, true, 'fail-closed：常量缺位必须抛，实测未抛 ⇒ 会写失名事件');
    assert.match(out.message, new RegExp('^' + CODE + ':'), '拒码须是 ' + CODE + '：' + String(out.message));
    assert.match(out.message, /"EVT_GATE_ESCAPE"/, '错误须**点名**缺位常量（可归因）：' + String(out.message));

    // 零落盘（独立复算 + 三重判据）
    assert.equal(shaOf(out.batchFile), out.afterSha, '父测试复算须与子进程自述一致');
    assert.equal(out.afterSha, out.beforeSha, '抛出须发生在 atomicWrite 之前 ⇒ 批文件逐字节不变');
    assert.equal(out.lanes.e1, 'pending', '零写入：成员迁移不得生效：' + JSON.stringify(out.lanes));
    assert.equal(out.escapeCount, 0, '不得落下 gate.escape：' + JSON.stringify(out.events));
    assert.equal(out.undefinedTypeCount, 0, '**不得出现 type:undefined**（守卫存在的唯一理由）');

    const disk = eventsOnDisk(out);
    assert.equal(disk.some((e) => typeof e.type !== 'string'), false, '磁盘复读：不得有失名事件');
    // 【2026-09-27 批 3 · T-15/D-6 等值反转（面仍在：建批期磁盘事件面）】原断言 `disk.length === 2`
    //   （建批期两条：`batch.created` / 资产正档解析事件）。资产正档写端已随 **T-7** 删除
    //   （`exec/delete-assets.md` §四 第 7/12 点：`store.js` 的 `teamAssetRefFor()` 与该事件常量
    //   的发射点整条删除）⇒ 建批期磁盘事件**只剩 1 条**，真值反转。
    //   【2026-09-28 批 4 `cleanup-tail-20260927` E-4(d)】该事件**常量本体与全部读端**已随 E-4 **删净**
    //   （并已并入退役锁 `test/retired-codes-lock.test.js`）⇒ 下方 `disk.some(...)` 的反向断言**逐字保留**：
    //   它比对的是**磁盘事件 `type` 字面量**，不依赖已删常量或面板分类器 ⇒ 仍具防回生价值，**不属删断言换绿**。
    //   断言强度不减：由「条数 = 2」→「条数 = 1 **且** 逐字点名唯一在册事件 type」（点名校验比原断言更严）。
    assert.equal(disk.length, 1, '磁盘事件仍只有建批期一条（batch.created；原 `batch.team-asset.resolved` 写点已随 T-7 删除）：'
      + JSON.stringify(disk.map((e) => e.type)));
    assert.equal(disk[0].type, 'batch.created', '逐字点名唯一在册建批期事件 type');
    assert.equal(disk.some((e) => e.type === 'batch.team-asset.resolved'), false,
      '资产正档事件已随 T-7 删净（不得回生）');
  } finally { cleanup(out); }
});

// ── 破坏档 ②③：抹掉**本次路径用不到**的另两常量 ⇒ 同样抛（钉死"一次解析三常量"语义） ──────────
// 语义说明（**当前实现语义的正面锁，不是"应当如此"的规范主张**）：`resolveGateEventTypes()`
//   （`lib/state/store.js:149-156`）无条件解析三常量 ⇒ **任一缺位即拒**，即便本次载荷只用其中一枚。
//   方向 fail-closed（拒得更早），且使「缺位」在**任何**门禁留痕路径上都立即暴露，而非等到该类型首次被用到。
//   若将来改造为按需（lazy）解析 ⇒ 本两档**必然转红**，届时须重新裁决该语义（转红 = 提示重裁，非回归）。

for (const name of ['EVT_GATE_DEGRADE', 'EVT_GATE_CONTRACT_MISSING']) {
  test('R3-4 E2E：缺 ' + name + '（本路径未使用）⇒ 仍抛 ' + CODE + '（一次解析三常量 ⇒ 任一缺位即拒）', () => {
    const out = runChild([name]);
    try {
      assert.equal(out.control.sabotageApplied, true, '前置自证：' + name + ' 须已缺位且其余两枚完好');
      assert.equal(out.sabotaged[name], null, '前置：' + name + ' 须已缺位');
      assert.equal(out.threw, true, '三常量由同一次 resolveGateEventTypes 解析 ⇒ 缺任一即抛');
      assert.match(out.message, new RegExp('"' + name + '"'), '错误须点名 ' + name + '：' + String(out.message));
      assert.equal(shaOf(out.batchFile), out.afterSha, '父测试复算须与子进程自述一致');
      assert.equal(out.afterSha, out.beforeSha, '零落盘：批文件逐字节不变');
      assert.equal(out.lanes.e1, 'pending', '零写入：成员迁移不得生效');
      assert.equal(out.undefinedTypeCount, 0, '不得出现 type:undefined');
    } finally { cleanup(out); }
  });
}

// ── 负向对照（**判别力证明**）：削弱守卫 + 抹常量 ⇒ 不再拒且**真写下失名事件** ──────────────
// 存在理由：上三档断言的是「零落盘 / 零失名事件」。若这两个"零"其实是**无条件成立**的
//   （例如 atomicWrite 恰好因别的原因不执行），那它们就**不构成对守卫的证据**。
//   本档把守卫判据置 `false`（`if (false) {`，纯加载期改写、不落盘任何源码改动）：
//   同一路径必须**放行并写下 `type: undefined` 的事件** ⇒ 反证"零"确是守卫的功劳，且本套件能看见污染。
// 绊线意义：将来若有人删/弱化该守卫 ⇒ 本档转红（值回票价的是它，不是"零"本身）。

test('R3-4 负向对照：削弱守卫（判据置 false）＋缺 EVT_GATE_ESCAPE ⇒ 不拒且**写下 type:undefined 事件**', () => {
  const out = runChild(['EVT_GATE_ESCAPE'], { weakenGuard: true });
  try {
    assert.equal(out.weakenGuard, true, '前置：负向档开关须已生效');
    assert.equal(out.control.sabotageApplied, true, '前置：EVT_GATE_ESCAPE 须已缺位');
    assert.equal(out.threw, false, '守卫被削弱 ⇒ 不再 fail-closed（若仍抛，说明削弱未生效）');
    assert.ok(out.undefinedTypeCount >= 1,
      '守卫缺席 ⇒ 必须能看见失名事件污染（`type` 非字符串）；实测=' + JSON.stringify(out.events));
    assert.equal(out.lanes.e1, 'running', '守卫缺席 ⇒ 写路径走完：' + JSON.stringify(out.lanes));
    // 独立复算：确实落了盘（与前三档的「零落盘」形成对照）
    assert.equal(shaOf(out.batchFile), out.afterSha, '父测试复算须与子进程自述一致');
    assert.notEqual(out.beforeSha, out.afterSha, '守卫缺席 ⇒ 磁盘被改写（这正是 fail-closed 要防的）');
  } finally { cleanup(out); }
});
