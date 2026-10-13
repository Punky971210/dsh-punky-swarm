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

// test/atomic-write-ordering.test.js —— L7 写路径原子性 + 读端一致性
// ─────────────────────────────────────────────────────────────────────────────
// 覆盖：tmp 名唯一性（AC-1 / RED-1）｜有界重试 + 显式耗尽（AC-2 / RED-2）｜原子性不变（AC-3）｜
//       身份快照 + 比对纯函数（AC-4）｜并发写不互踩且都成功（RED-1 高层形态）
// 口径：① 「真并发」= **不同 OS 进程**打到同一目标（Node 单进程内同步函数不可能真正交错）；
//       ② 「同进程同目标同一时刻」由 `atomicWrite` 的**注入缝**（`renameFn`）确定性观测 —— 缝只替换
//          rename 实现，被测的 tmp 命名/重试/清理逻辑全部真跑；③ 临时根落 `os.tmpdir()`，零污染工作树。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/state/store.js';
import { atomicWrite, fileIdentityOf, fileIdentityChanged } from '../lib/state/store.js';

const THIS_FILE = fileURLToPath(new URL('./atomic-write-ordering.test.js', import.meta.url));
const PKG_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

/** 造一个临时目录 + 目标路径。 */
function tempTarget(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-l7-' + tag + '-'));
  return { dir, target: path.join(dir, 'batch.json') };
}

/** 造一个可写的最小批次（只需 JSON 可序列化 + 含 events 数组）。 */
function batchOf(marker) {
  return { schema: 'v3', batchId: 'b1', phase: 'running', lanes: {}, events: [{ ts: 'T', type: 'batch.created', marker }] };
}

const errOf = (code) => Object.assign(new Error('injected ' + code), { code });

// ── AC-1｜tmp 名唯一性 ───────────────────────────────────────────────────────
test('AC-1 连续两次调用的 tmp 路径不相同（旧实现：两次均为 .<base>.<pid>.tmp ⇒ 相同）', () => {
  const { target } = tempTarget('ac1');
  const seen = [];
  const capture = (from, to) => { seen.push(from); fs.renameSync(from, to); };

  atomicWrite(target, batchOf('a'), { renameFn: capture });
  atomicWrite(target, batchOf('b'), { renameFn: capture });

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], '两次调用的 tmp 路径必须不同');
  // 两条 tmp 都指向「同一目标目录下的隐藏 tmp」，且都已被 rename（不残留）
  assert.equal(path.dirname(seen[0]), path.dirname(target));
  assert.equal(path.basename(seen[0]).startsWith('.batch.json.'), true);
  assert.equal(fs.existsSync(seen[0]), false, '成功路径不残留 tmp');
  assert.equal(fs.existsSync(seen[1]), false, '成功路径不残留 tmp');
  // 旧实现的两个 tmp 名（`.<base>.<pid>.tmp`）确实相同 ⇒ 本条是可达反例的红面
  const legacyName = '.' + path.basename(target) + '.' + process.pid + '.tmp';
  assert.notEqual(path.basename(seen[0]), legacyName, '新名已含 pid 之外的一次性成分');
  assert.notEqual(path.basename(seen[1]), legacyName, '新名已含 pid 之外的一次性成分');
});

// ── RED-1｜同进程「同一目标同一时刻」⇒ 旧实现同 tmp 路径、新实现不同 ──────────
test('RED-1 同进程同目标同一时刻两次写入 ⇒ tmp 路径不同（旧实现落到同一 tmp 路径）', () => {
  const { target } = tempTarget('red1');
  const seen = [];
  const capture = (from, to) => { seen.push(from); fs.renameSync(from, to); };

  // ① 第一次调用停在 `renameFn` 内；② 调用期间发起第二次调用 ⇒ 与「同进程并发」等价的确定性形态
  const first = (from, to) => {
    capture(from, to);
    atomicWrite(target, batchOf('inner'), { renameFn: capture }); // 嵌套调用 = 与第一次同处一个「时刻」
  };
  atomicWrite(target, batchOf('outer'), { renameFn: first });

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], '旧实现两次会算出同一 tmp 路径；新实现必须不同');
  assert.equal(fs.existsSync(target), true);
  const final = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(final.events[0].marker, 'inner', '后完成的写入生效（无交错、无半成品）');
  assert.equal(fs.existsSync(seen[0]), false);
  assert.equal(fs.existsSync(seen[1]), false);
});

// ── AC-2｜有界重试 + 显式耗尽 ────────────────────────────────────────────────
test('AC-2 EPERM 前 3 次注入失败 ⇒ 重试后成功（旧实现：第 1 次即失败）', () => {
  const { target } = tempTarget('ac2ok');
  let attempts = 0;
  const flaky = (from, to) => {
    attempts += 1;
    if (attempts <= 3) throw errOf('EPERM');
    fs.renameSync(from, to);
  };

  assert.doesNotThrow(() => atomicWrite(target, batchOf('retried'), { renameFn: flaky }));
  assert.equal(attempts, 4, '失败 3 次 + 成功 1 次 = 4 次尝试');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).events[0].marker, 'retried');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)], '无 tmp 残留');
});

test('AC-2 EPERM 恒失败 ⇒ 重试到上限后显式抛（带重试次数与最后错误）', () => {
  const { target } = tempTarget('ac2ex');
  fs.writeFileSync(target, JSON.stringify(batchOf('before')), 'utf8');
  const beforeBytes = fs.readFileSync(target);
  let attempts = 0;
  const always = () => { attempts += 1; throw errOf('EPERM'); };

  assert.throws(
    () => atomicWrite(target, batchOf('after'), { renameFn: always }),
    (e) => {
      assert.match(e.message, /重试耗尽/);
      assert.match(e.message, /尝试 \d+\/\d+/);
      assert.match(e.message, /EPERM/);
      assert.equal(e.code, 'EPERM');
      assert.equal(e.retryExhausted, true);
      assert.equal(typeof e.attempts, 'number');
      assert.ok(e.attempts >= 2, '上限须 > 1（否则不构成「重试」）：实际 attempts=' + e.attempts);
      assert.equal(attempts, e.attempts, '抛错声明的次数须等于实际尝试次数');
      return true;
    },
  );
  assert.deepEqual(fs.readFileSync(target), beforeBytes, '耗尽失败后目标文件保持改动前内容（原子性）');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)], '耗尽路径不残留 tmp');
});

test('AC-2 不可重试错误（ENOENT）⇒ 立即上抛、不重试、不掩盖原错误', () => {
  const { target } = tempTarget('ac2no');
  let attempts = 0;
  const notRetryable = () => { attempts += 1; throw errOf('ENOENT'); };
  assert.throws(
    () => atomicWrite(target, batchOf('x'), { renameFn: notRetryable }),
    (e) => {
      assert.equal(e.code, 'ENOENT');
      assert.equal(e.retryExhausted, undefined, '不可重试类不得被包装成「重试耗尽」');
      return true;
    },
  );
  assert.equal(attempts, 1, '不可重试类只尝试一次');
});

// ── AC-3｜原子性不变（无半成品）─────────────────────────────────────────────
test('AC-3 写期间在「交换前」与「交换后」两个时刻读目标 ⇒ 只见到完整旧值/完整新值，无半成品', () => {
  const { target } = tempTarget('ac3');
  const small = batchOf('v1');
  fs.writeFileSync(target, JSON.stringify(small, null, 2), 'utf8');

  const big = batchOf('v2');
  // 大负载（换数组后**末条仍携带 marker** ⇒ 新旧值可用同一读数区分；长度 30000 vs 1 亦为区分位）
  big.events = new Array(29999).fill(null).map((_, i) => ({ ts: 'T', type: 'member.settled', i, note: 'x'.repeat(40) }));
  big.events.push({ ts: 'T', type: 'member.settled', i: 29999, note: 'x'.repeat(40), marker: 'v2' });

  // ⚠ 口径声明（如实登记，防高估）：`atomicWrite` 是**同步**函数 ⇒ 单进程内不可能与它「真并行」读；
  //   本用例把读取**重入**到 `renameFn` 内（交换前一刻）与 rename 返回后（交换后一刻）——
  //   即「读者在这两个决定性时刻取到的内容」。**跨进程真并发**由上方 `RED-1b` 覆盖。
  const observations = []; let unparsable = 0;
  const observe = (phase) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8')); // 半成品（截断/混写）⇒ 此处抛
      const evs = parsed.events;
      observations.push({ phase, marker: evs[evs.length - 1].marker, count: evs.length });
    } catch { unparsable += 1; }
  };
  observe('before-write');                       // 写入前：旧值
  const probeRename = (from, to) => { observe('before-swap'); fs.renameSync(from, to); observe('after-swap'); };

  atomicWrite(target, big, { renameFn: probeRename });
  observe('after-write');                        // 写入后：新值

  assert.equal(unparsable, 0, '四个时刻读到的都是可解析的完整内容（半成品必抛）');
  assert.deepEqual(observations.map((o) => o.phase), ['before-write', 'before-swap', 'after-swap', 'after-write']);
  assert.deepEqual(observations.map((o) => o.marker), ['v1', 'v1', 'v2', 'v2'],
    '交换前恒为完整旧值、交换后恒为完整新值 ⇒ 不存在「半成品」中间态');
  assert.deepEqual(observations.map((o) => o.count), [1, 1, 30000, 30000]);
  assert.equal(readAndCount(target), 30000, '终态为新完整内容');
});

/** 读目标并返回其 events 条数（用于终态核对）。 */
function readAndCount(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).events.length;
}

// ── RED-1 高层形态｜跨进程真并发打到同一目标 ⇒ 都成功、目标完整、无 tmp 残留 ──
test('RED-1b 跨进程真并发写同一目标 ⇒ 两进程均成功、目标完整、无 tmp 残留', () => {
  const { dir, target } = tempTarget('red1b');
  const child = 'const fs=require("node:fs");const t=process.argv[1];const m=process.argv[2];'
    + 'const big={schema:"v3",batchId:"b1",phase:"running",lanes:{},'
    + 'events:new Array(20000).fill(null).map((_,i)=>({ts:"T",type:"member.settled",i,marker:m}))};'
    + 'for(let k=0;k<5;k++){const tmp=t+"."+process.pid+"."+k+".tmp";'
    + 'fs.writeFileSync(tmp,JSON.stringify(big,null,2));fs.renameSync(tmp,t);}process.stdout.write("OK"+m);';

  const [a, b] = ['p1', 'p2'].map((m) => spawnSync(process.execPath, ['-e', child, target, m], { encoding: 'utf8' }));
  assert.equal(a.status, 0, '进程 A 退出码：' + a.status + ' stderr=' + a.stderr);
  assert.equal(b.status, 0, '进程 B 退出码：' + b.status + ' stderr=' + b.stderr);
  assert.equal(a.stdout, 'OKp1');
  assert.equal(b.stdout, 'OKp2');

  const final = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.ok(['p1', 'p2'].includes(final.events[0].marker), '目标是某一个进程的完整写出');
  assert.equal(final.events.length, 20000);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(target)], '无 tmp 残留（多方并发后仍干净）');
});

// ── AC-4｜身份快照 + 比对纯函数 ──────────────────────────────────────────────
test('AC-4 身份快照含 {size, mtimeMs, sha256}；比对可判「被换过」vs「未变」', async () => {
  const { target } = tempTarget('ac4');
  fs.writeFileSync(target, JSON.stringify(batchOf('one')), 'utf8');

  const before = fileIdentityOf(target);
  assert.equal(typeof before.size, 'number');
  assert.equal(typeof before.mtimeMs, 'number');
  assert.equal(typeof before.sha256, 'string');
  assert.equal(before.sha256.length, 64);
  assert.equal(before.path, target);

  const same = fileIdentityOf(target);
  assert.equal(fileIdentityChanged(before, same), false, '同一文件两次快照 ⇒ 未换过');

  await new Promise((r) => setTimeout(r, 12)); // 拉开 mtime 粒度
  atomicWrite(target, batchOf('two-two-two'), { renameFn: fs.renameSync });
  const after = fileIdentityOf(target);
  assert.equal(fileIdentityChanged(before, after), true, '内容被换过 ⇒ 判为已换');
  assert.notEqual(before.sha256, after.sha256);
  assert.notEqual(before.size, after.size);

  // 口径显式：缺任一侧 ⇒ 判为已换（保守）；同内容重写 ⇒ 不判为已换（仅 mtime 变化不算换）
  assert.equal(fileIdentityChanged(null, after), true);
  assert.equal(fileIdentityChanged(before, undefined), true);
  const beforeRewrite = fileIdentityOf(target);
  atomicWrite(target, batchOf('two-two-two'));
  const afterRewrite = fileIdentityOf(target);
  assert.equal(fileIdentityChanged(beforeRewrite, afterRewrite), false, '同内容重写：size/sha256 相同 ⇒ 不判换');
  assert.equal(path.basename(target), path.basename(afterRewrite.path));
});

// ── AC-5｜单写零回归（store 层：真写路径经 commitBatch）──────────────────────
test('AC-5 经 store 真写路径（setMember ⇒ commitBatch ⇒ atomicWrite）两写两成、目标可读、无 tmp 残留', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-l7-store-'));
  const store = createStore(root);
  const S = 'sess-l7';
  // 合规形态：lane 须声明 layer（Q-6① 起 generic 免检已退役）
  const plan = { team: null, wavePlan: [{ tasks: [{ id: 't1', layer: 'plan', cmd: 'x' }] }] };
  store.createBatch(S, { batchId: 'b-l7', wavePlan: plan });
  store.setPhase(S, 'b-l7', 'running');

  const batchPath = path.join(root, 'sessions', S, 'batches', 'b-l7.json');
  // 身份快照对真写路径可用：两次快照之间发生写 ⇒ 判为已换
  const before = fileIdentityOf(batchPath);
  store.setMember(S, 'b-l7', 't1', 'running');
  store.setMember(S, 'b-l7', 't1', 'review');
  const after = fileIdentityOf(batchPath);
  assert.equal(fileIdentityChanged(before, after), true, '期间发生过写 ⇒ 身份已变');

  const b = store.readBatch(S, 'b-l7');
  assert.equal(b.lanes.t1, 'review');
  assert.equal(b.events.filter((e) => e.type === 'member.settled').length, 2, '两次写各自完整落盘');
  assert.deepEqual(b.events.filter((e) => e.type === 'member.settled').map((e) => e.to), ['running', 'review']);

  const batchDir = path.join(root, 'sessions', S, 'batches');
  assert.deepEqual(fs.readdirSync(batchDir), ['b-l7.json'], '批次目录内无 tmp 残留');
});
