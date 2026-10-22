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

// F3 · 批级 `__rev` CAS（K-1）验收套件 —— spec AC-1 / AC-2 / AC-3 / AC-6。
//
// 判据形态纪律（本件的存在意义）：
//   · 「并发双写恰一成功」用 `createStore({ revRaceHook })` **确定性构造**（不抽样、不 sleep 抢时序）；
//   · 每处负数断言配**同输入的阳性对照**（AC-1(5) / AC-2④ / AC-3 再写一次）；
//   · **禁整体快照断言**：`__rev` 是引擎内部字段，只断言具名字段（spec S2-C3 代价段）；
//   · **反证段**（`CAS 退化`）：在 **`lib/` 的临时副本**上做文本变异（仓库零改动）⇒ 本件判据必须变红，
//     证明判据抓得到「CAS 退化为无条件覆盖」与「回写缺失导致的盘/对象不同步」这两种退化形态。
//
// 运行形态：`node --import ./test/helpers/isolated-home.preload.mjs --test test/f3-rev-cas.test.js`
//   （不带 preload 会因真实 `~/.agents/skills` 存在产生环境假红）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { createTools } from '../lib/tools/register.js';
import { tempRoot, threeTierTasks, seedArtifacts, assessC } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = 'sess-f3-rev';

// ── 小工具（只读/只写测试自己的临时根，不触碰仓库）──────────────────────────────
function batchFileOf(root, session, batchId) {
  return path.join(root, 'sessions', session, 'batches', batchId + '.json');
}
function readDisk(root, batchId, session = S) {
  return JSON.parse(fs.readFileSync(batchFileOf(root, session, batchId), 'utf8'));
}
function diskRev(root, batchId, session = S) {
  return readDisk(root, batchId, session).__rev;
}
function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function tmpResidue(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
}
function countOf(batch, type) {
  return (batch.events ?? []).filter((e) => e && e.type === type).length;
}
function planOf(batchId, tasks) {
  return buildWavePlan({ batchId, tasks: tasks ?? [{ id: 'x' }] });
}
function execOf(session) {
  return { agent: { session: { id: session } } };
}
function toolCtx() {
  return { tools: { register: () => {}, guard: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } };
}

// ── AC-2 并发双写恰一成功（最重）────────────────────────────────────────────
test('T-1/AC-2 并发双写恰一成功：读到旧快照者必抛，盘上只留胜者事实', () => {
  const root = tempRoot('f3-rev-ac2-');
  let storeB;
  let armed = false; // 一次性：hook 内先落盘对手，再 disarm（防递归）
  const storeA = createStore(root, {
    revRaceHook: ({ sessionId, batchId }) => {
      if (!armed) return;
      armed = false;
      storeB.appendEvent(sessionId, batchId, 'probe.foreign', {}); // 对手在本轮读取之后提交
    },
  });
  storeB = createStore(root);
  storeB.createBatch(S, { batchId: 'b-cas', wavePlan: planOf('b-cas') });
  const rev0 = diskRev(root, 'b-cas');
  assert.equal(rev0, 1, '建批首写经 commitBatch ⇒ 盘上 __rev = 1（ENOENT 视 0）');

  armed = true;
  let conflict = null;
  try { storeA.appendEvent(S, 'b-cas', 'probe.mine', {}); } catch (err) { conflict = err; }

  // ① 后到者必抛（修前是静默覆盖 ⇒ 本断言即 RED 判据）
  assert.ok(conflict, 'A 读到旧快照 ⇒ 必须抛，不得静默覆盖');
  assert.equal(conflict.code, 'BATCH_VERSION_CONFLICT');
  // ② 错误三字段（batchId / expected / actual）
  assert.equal(conflict.batchId, 'b-cas');
  assert.equal(conflict.expected, rev0);
  assert.equal(conflict.actual, rev0 + 1);
  // ③ 恰一成功（确定性可判，无概率成分）
  const disk = readDisk(root, 'b-cas');
  assert.equal(countOf(disk, 'probe.foreign'), 1, 'B 的成功写必须留下恰 1 条');
  assert.equal(countOf(disk, 'probe.mine'), 0, 'A 的写必须零落盘');
  assert.equal(disk.__rev, rev0 + 1, '只发生一次成功写 ⇒ rev 只前进 1');
  // ④ 阳性对照（同输入形态，只不注入对手）：重读后重试必成功
  const storeC = createStore(root);
  const after = storeC.appendEvent(S, 'b-cas', 'probe.retry', {});
  assert.equal(after.__rev, rev0 + 2, '重试成功且回写在场（返回对象 rev == 新盘上 rev）');
  assert.equal(countOf(readDisk(root, 'b-cas'), 'probe.retry'), 1);
});

// ── AC-1 失配必抛 + 字段齐 + 零落盘 + 无 tmp 残留 ─────────────────────────────
test('T-1/AC-1 失配必抛（非 GATE_ 码）+ 零落盘 + 无 tmp 残留', () => {
  const root = tempRoot('f3-rev-ac1-');
  const file = batchFileOf(root, S, 'b-mis');
  let armed = false;
  let hookExpected = null;
  let opponentSha = null; // 对手提交后的盘上 sha256（零落盘的对照基准）
  const store = createStore(root, {
    revRaceHook: ({ expected }) => {
      if (!armed) return;
      armed = false;
      hookExpected = expected;
      // 模拟「对手刚提交」：把盘上记录整份重写成 expected+1
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...disk, __rev: expected + 1 }, null, 2));
      opponentSha = sha256Of(file);
    },
  });
  store.createBatch(S, { batchId: 'b-mis', wavePlan: planOf('b-mis') });

  armed = true;
  let conflict = null;
  try { store.appendEvent(S, 'b-mis', 'probe.mine', {}); } catch (err) { conflict = err; }

  assert.ok(conflict, '失配必须抛');
  assert.equal(hookExpected, 1, 'hook 观测到的声明值 = 本轮读到的 rev');
  // 码面：普通字符串码，**非 GATE_ 前缀**（零新造拒码）
  assert.equal(conflict.code, 'BATCH_VERSION_CONFLICT');
  assert.equal(conflict.code.startsWith('GATE_'), false);
  assert.equal(conflict.message.startsWith('GATE_'), false);
  // 字段面
  assert.equal(conflict.batchId, 'b-mis');
  assert.equal(conflict.expected, 1);
  assert.equal(conflict.actual, 2);
  // 文案四段：事实 / 判别 / 零副作用 / 修复提示
  assert.match(conflict.message, /__rev=1/);
  assert.match(conflict.message, /__rev=2/);
  assert.match(conflict.message, /本次写入未落盘/);
  assert.match(conflict.message, /重新读取该批次后重试/);
  // 零落盘：盘上 sha256 逐字等于 hook 写入版（本次未覆盖）
  assert.ok(opponentSha, 'hook 必须真的改写盘上记录（构造无效则本条判据失效）');
  assert.equal(sha256Of(file), opponentSha, '失配档必须零落盘（盘上仍是 hook 写入的那一版）');
  assert.equal(countOf(readDisk(root, 'b-mis'), 'probe.mine'), 0, '不得留下本次事件');
  // 无 tmp 残留（atomicWrite 的 tmp 名以 .tmp 结尾且与批次同目录）
  assert.deepEqual(tmpResidue(path.dirname(file)), [], '失配档必须无 tmp 残留');

  // 阳性对照（同输入形态、只不注入对手）
  const store2 = createStore(root);
  const ok = store2.appendEvent(S, 'b-mis', 'probe.mine', {});
  assert.equal(ok.__rev, 3, '通过档 rev 前进到 3（2 ⇒ 3）');
  assert.equal(countOf(readDisk(root, 'b-mis'), 'probe.mine'), 1);
});

// ── AC-3 旧文件（无 __rev）仍可写 ──────────────────────────────────────────────
test('T-1/AC-3 旧文件（无 __rev）仍可写：undefined → 1 → 2，全程不抛', () => {
  const root = tempRoot('f3-rev-legacy-');
  const store = createStore(root);
  const file = batchFileOf(root, S, 'b-legacy');
  const now = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 手工写一份「v0.5.2 形态」的合法批次 JSON：**不含** `__rev`
  fs.writeFileSync(file, JSON.stringify({
    schema: 3,
    sessionId: S,
    batchId: 'b-legacy',
    phase: 'running',
    concurrency: 5,
    team: null,
    wavePlan: [],
    lanes: { x: 'pending' },
    chains: {},
    handoffs: {},
    archived: false,
    events: [{ ts: now, type: 'batch.created', batchId: 'b-legacy', sessionId: S }],
    createdAt: now,
    updatedAt: now,
  }, null, 2));

  // ① 读端**透出**（不剥离）：旧文件读出的对象无该键
  assert.equal(store.readBatch(S, 'b-legacy').__rev, undefined, '旧文件读出无 __rev（读端不代造）');
  // ② 不得拒写
  assert.doesNotThrow(() => store.appendEvent(S, 'b-legacy', 'probe.x', {}), '缺 __rev 不得拒写（兼容面冻结）');
  // ③ 首写升级为 1，再写为 2（no backfill：只纠正被写的那一份）
  assert.equal(diskRev(root, 'b-legacy'), 1);
  const b2 = store.appendEvent(S, 'b-legacy', 'probe.y', {});
  assert.equal(diskRev(root, 'b-legacy'), 2);
  assert.equal(b2.__rev, 2, '回写在场：返回对象 rev == 盘上 rev');
});

// ── 同一逻辑动作内两次 commit 不自冲突 ────────────────────────────────────────
test('T-1 同一逻辑动作内两次 commit 不自冲突（batch_phase 形态：markManagerRaised → setPhase）', () => {
  const root = tempRoot('f3-rev-multi-');
  const store = createStore(root);
  store.createBatch(S, { batchId: 'b-multi', wavePlan: planOf('b-multi'), phase: 'planning' });
  assert.equal(diskRev(root, 'b-multi'), 1);
  store.markManagerRaised(S, 'b-multi', { agentId: 'mgr-1' }); // 第 1 次写
  assert.equal(diskRev(root, 'b-multi'), 2);
  store.setPhase(S, 'b-multi', 'running'); // 第 2 次写（各自 readBatch ⇒ 拿到新鲜 rev）
  assert.equal(diskRev(root, 'b-multi'), 3, '第二次写必须成功（自冲突 = 回写缺失的直接症状）');
  assert.equal(store.readBatch(S, 'b-multi').__rev, 3);
  assert.equal(store.readBatch(S, 'b-multi').phase, 'running');
});

// ── AC-6 业务链路 e2e（rev 不破坏既有治理流）──────────────────────────────────
test('T-1/AC-6 业务链路 e2e：rev 单调、rev == 成功 commit 次数、事件不重复', () => {
  const root = tempRoot('f3-rev-e2e-');
  const E = 'sess-f3-e2e';
  const batchId = 'b-e2e';
  const commits = []; // hook 每次 commitBatch 入口记一次（本链路零冲突 ⇒ 次数 == 成功写次数）
  const store = createStore(root, { revRaceHook: ({ expected }) => { commits.push(expected); } });

  seedArtifacts(root, E, batchId, ['x']);
  store.createBatch(E, { batchId, wavePlan: planOf(batchId, threeTierTasks(['x'])), phase: 'running' });
  const src = path.join(root, 'e2e-src.md');
  fs.writeFileSync(src, '# e2e claim body');

  const revs = [diskRev(root, batchId, E)];
  const step = (fn) => { fn(); revs.push(diskRev(root, batchId, E)); };
  step(() => store.setMember(E, batchId, 'p1', 'running'));
  step(() => store.setMember(E, batchId, 'p1', 'review'));
  step(() => store.setMember(E, batchId, 'p1', 'merged'));
  step(() => store.setMember(E, batchId, 'x', 'running'));
  step(() => store.claimAsset(E, batchId, { source: src, target: 'explore/e2e.md' }));
  step(() => store.appendEvent(E, batchId, 'probe.e2e', {}));
  step(() => store.setMember(E, batchId, 'x', 'review'));
  step(() => store.setMember(E, batchId, 'x', 'merged'));
  step(() => store.setMember(E, batchId, 'a1', 'running'));
  step(() => store.setMember(E, batchId, 'a1', 'review'));
  step(() => store.setMember(E, batchId, 'a1', 'merged'));
  step(() => store.setPhase(E, batchId, 'complete'));

  const disk = readDisk(root, batchId, E);
  // ② 终态
  assert.equal(disk.phase, 'complete');
  assert.equal(disk.lanes.x, 'merged');
  assert.equal(disk.lanes.a1, 'merged');
  // ③ rev 严格单调递增（每一步都有写 ⇒ 每步都 +≥1）
  for (let i = 1; i < revs.length; i++) {
    assert.ok(revs[i] > revs[i - 1], 'rev 必须严格递增：step ' + i + ' = ' + revs[i] + '，前一步 = ' + revs[i - 1]);
  }
  // ③' rev == 成功 commit 次数（盘上值与写入次数一致 ⇒ 没有额外赋值点、没有旁路写）
  assert.equal(disk.__rev, commits.length, 'rev 必须等于 commitBatch 成功次数（实测 commits=' + commits.length + '）');
  assert.ok(commits.length >= revs.length - 1, '写次数不少于步数');
  // ④ 无重复条目（同一写入的同一事件不得出现两次）
  const keyOf = (e) => [e.type, e.lane ?? '', e.from ?? '', e.to ?? '', e.source ?? '', e.target ?? ''].join('|');
  const watched = disk.events.filter((e) => ['member.settled', 'batch.phase', 'asset.claimed'].includes(e.type));
  const keys = watched.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, '事件流内出现重复条目 ⇒ 说明有覆盖式重放或重复提交');
  assert.equal(disk.events.filter((e) => e.type === 'member.settled' && e.lane === 'x').length, 3, 'x 三次迁移各一条');
  // ⑤ 原子写仍有效（readDisk 内已 JSON.parse 成功即证）+ 断言具名字段而非整体快照
  assert.equal(typeof disk.createdAt, 'string');
  assert.equal(typeof disk.updatedAt, 'string');
});

// ── AC-6 派生：既有工具投影零污染（内部字段不升格为公开契约）────────────────────
test('T-1/AC-6 既有投影零污染：wave_plan 与 batch_status 回显不含 __rev', async () => {
  const root = tempRoot('f3-rev-proj-');
  const P = 'sess-f3-proj';
  const store = createStore(root);
  const { tools } = createTools(toolCtx(), { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assessC(store, P); // G1 前置：建批只认本会话自己的 C 档

  const created = await byName.wave_plan.execute({ batchId: 'b-proj', tasks: [{ id: 'x' }], session: P }, execOf(P));
  assert.equal(created.batchId, 'b-proj');
  assert.equal(Object.prototype.hasOwnProperty.call(created, '__rev'), false, 'wave_plan 回显不得带内部字段');
  assert.deepEqual(created.lanes, { x: 'pending' }, 'wave_plan 的 lanes 投影形态逐字不变');

  const status = await byName.batch_status.execute({ batchId: 'b-proj', session: P }, execOf(P));
  assert.equal(Object.prototype.hasOwnProperty.call(status, '__rev'), false, 'batch_status 不得回显内部字段');
  assert.equal(JSON.stringify(status).includes('__rev'), false, 'batch_status 逐字段投影 ⇒ 内部字段不进输出');
  assert.equal(status.phase, 'planning');
  // 但盘上事实必须有（内部字段只在盘上，不进工具面）
  assert.equal(diskRev(root, 'b-proj', P), 1, '建批落盘仍带 __rev=1');
});

// ── 归档写面归一（原 D-2 残余已修：归档改经 commitBatch）────────────────────────────
// 【2026-10-22 更新】本用例原断言「归档绕过 CAS」——那是对**缺陷**的钉桩。D-2 已由 Leader 直做收尾：
//   `createArchive(root, { commitBatch })` 注入 + 两处批次 JSON 写点改经 `commitBatch`。
//   现改为**正向判据**：归档必须推进 rev 且必须经过 commitBatch；并保留结构面反向断言（不得再直写）。
//   回退风险：若有人把注入去掉，①②必红；若有人改回 atomicWrite 直写，③的结构面断言必红。
test('T-1 归档写面已归一：归档推进 rev 且经 commitBatch（原 D-2 残余已收）', () => {
  const root = tempRoot('f3-rev-archive-');
  const A = 'sess-f3-archive';
  const batchId = 'b-arch';
  let commitCalls = 0;
  const store = createStore(root, { revRaceHook: () => { commitCalls += 1; } });
  seedArtifacts(root, A, batchId, ['x']);
  store.createBatch(A, { batchId, wavePlan: planOf(batchId, threeTierTasks(['x'])), phase: 'running' });
  store.appendEvent(A, batchId, 'probe.before-archive', {});

  const revBefore = diskRev(root, batchId, A);
  const callsBefore = commitCalls;
  assert.equal(revBefore, 2, '建批 1 + 一次写入 ⇒ 2');

  // 直接调归档（不经 setPhase 钩子，便于单独观测「归档写」这一动作本身）
  const manifest = store.archive.archiveBatch(A, batchId);
  assert.equal(manifest.batchId, batchId);
  const afterArchive = readDisk(root, batchId, A);

  // ① 归档事实落地
  assert.equal(afterArchive.archived, true, '归档必须置 archived:true（单向标记）');
  assert.equal(fs.existsSync(path.join(root, 'sessions', A, 'archive', batchId)), true, '归档目录必须在场');
  // ② rev **必须推进**（归档是批次 JSON 的写面 ⇒ 必须参与 rev 递增，否则并发下可 rev 回退）
  assert.equal(afterArchive.__rev, revBefore + 1, '归档写必须推进 rev（经 commitBatch ⇒ CAS 生效）');
  // ③ 归档**必须经 commitBatch**（hook 计数增 1）⇒ 参与 CAS 比对
  assert.equal(commitCalls, callsBefore + 1, '归档写必须经过 commitBatch（参与 CAS 比对）');

  // 结构面（反向）：两处批次 JSON 写点必须改经 `writeBatchJson`；`atomicWrite` 只允许出现在
  //   该单点的**缺省回退**里（恰 1 处），且文件内必须引用注入的 `commitBatch`。
  const archiveSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'state', 'archive.js'), 'utf8');
  assert.ok(archiveSrc.includes('commitBatch'), '结构面：归档须接线 commitBatch（经注入）');
  assert.equal((archiveSrc.match(/atomicWrite\(batchFileOf\(/g) ?? []).length, 1,
    '结构面：atomicWrite 直写只允许 1 处（= writeBatchJson 的未注入回退），不得散落在两个写点');
  assert.ok((archiveSrc.match(/writeBatchJson\(/g) ?? []).length >= 2,
    '结构面：两处批次 JSON 写点均改经 writeBatchJson（定义形为 `writeBatchJson = (`，故 ≥2 即两处调用都在）');
});

// ── 反证：CAS 退化 / 回写缺失 ⇒ 上述判据必须变红（临时副本，仓库零改动）──────────
const CAS_COMPARE = '    if (actual !== expected) throw batchVersionConflictOf(batchId, expected, actual);';
const CAS_WRITEBACK = '    batch[BATCH_REV_KEY] = actual + 1;';

/** 把 `lib/` 复制到临时根并施加一处文本变异，返回变异模块（仓库本体零改动）。 */
async function loadMutant(mutate) {
  const dir = tempRoot('f3-mutant-');
  fs.cpSync(path.join(PKG_ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  // 副本落在包外 ⇒ 显式声明 ESM（仓库 package.json 的 `type: module` 不覆盖 tmp 根）
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const file = path.join(dir, 'lib', 'state', 'store.js');
  const src = fs.readFileSync(file, 'utf8');
  const mutated = mutate(src);
  assert.notEqual(mutated, src, '变异必须真的命中源码（未命中 ⇒ 本条判据须失败，不得静默通过）');
  fs.writeFileSync(file, mutated);
  return await import(pathToFileURL(file).href);
}

test('T-1 反证①：抽掉 CAS 比对（临时副本）⇒ 并发用例必变红', async () => {
  const mod = await loadMutant((src) => {
    assert.ok(src.includes(CAS_COMPARE), '变异锚点在场（锚点漂移时必须失败）');
    return src.replace(CAS_COMPARE, '    /* mutant: CAS 比对已移除（反证专用） */');
  });
  const root = tempRoot('f3-rev-mut-a-');
  let storeB;
  let armed = false;
  const storeA = mod.createStore(root, {
    revRaceHook: ({ sessionId, batchId }) => {
      if (!armed) return;
      armed = false;
      storeB.appendEvent(sessionId, batchId, 'probe.foreign', {});
    },
  });
  storeB = mod.createStore(root);
  storeB.createBatch(S, { batchId: 'b-mut', wavePlan: planOf('b-mut') });
  armed = true;
  let threw = null;
  try { storeA.appendEvent(S, 'b-mut', 'probe.mine', {}); } catch (err) { threw = err; }
  // 变红形态 = GREEN 断言全部反向成立（无抛 + 胜者事件被抹掉 + 静默覆盖）
  assert.equal(threw, null, 'CAS 退化 ⇒ 后到者不抛（GREEN 的「必抛」断言因此变红）');
  const disk = readDisk(root, 'b-mut');
  assert.equal(countOf(disk, 'probe.foreign'), 0, '静默 lost update：胜者事实被抹掉（GREEN 的「恰 1 条」变红）');
  assert.equal(countOf(disk, 'probe.mine'), 1);
});

test('T-1 反证②：抽掉「回写调用方对象」（临时副本）⇒ 回写在场断言必变红', async () => {
  const mod = await loadMutant((src) => {
    assert.ok(src.includes(CAS_WRITEBACK), '变异锚点在场（锚点漂移时必须失败）');
    return src.replace(CAS_WRITEBACK, '    /* mutant: 回写已移除（反证专用） */');
  });
  const root = tempRoot('f3-rev-mut-b-');
  const store = mod.createStore(root);
  const created = store.createBatch(S, { batchId: 'b-mut2', wavePlan: planOf('b-mut2') });
  // 回写缺失的真实后果（实测）：`__rev` 由 `commitBatch` 赋在**调用方对象**上，随同一次原子写落盘；
  //   不回写 ⇒ 盘上也**永远没有** `__rev` ⇒ 之后每次 `expected=0 / actual=0` **恒等通过**
  //   ⇒ CAS 退化为「无版本」形态（比「冲突」更隐蔽）。本断言把这条退化钉住：
  assert.equal(created.__rev, undefined, '删回写 ⇒ 返回对象不带新 rev（GREEN 的「回写在场」断言因此变红）');
  assert.equal(diskRev(root, 'b-mut2'), undefined, '删回写 ⇒ 盘上也没有 __rev（rev 从不前进）');
  // 退化可判性：再写一次仍「成功」（expected=0/actual=0）—— 证明 CAS 已失效而非报冲突
  const again = store.appendEvent(S, 'b-mut2', 'probe.degraded', {});
  assert.equal(again.__rev, undefined, '退化形态：写仍然成功但版本面不存在 ⇒ GREEN 的 rev 递增断言全红');
});
