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

// F2 锁契约测试（批次 `punky-fix-f2-20261022` · lane `e4-tester`）
//   判据源：`plan/fix-spec-f2.md` §1（锁契约）+ AC-1 / AC-2 / AC-6 / AC-7 / AC-8
//   回指缺陷：A1-P1-02（并发 `acquire(force:true)` 双成功）、A1-P2-06（`release` token 守卫短路）
//
// 可证伪性纪律（不变量 7）：
//   · 每条阴性断言在同一测试内**先**给出同输入形状的阳性对照（同文件、同调用、只换一个事实）；
//   · 代数判据用**返回载荷** `takeover.from.fence` / `fence`（leader 已裁口径：不用子进程预读
//     `readFence`——预读值 ≠ `acquire` 内部 CAS 代数，本机实测 5/20 轮假失败）；
//   · 「零胜出档」（Windows `renameSync` 瞬时 EPERM ⇒ `takeover-contended`，见 change-lock.md R-6）
//     以「锁内容逐字未改」为判据，不硬要求 `fence ∈ {2,3}`（那是 K-6 已登记的活性边界，不是安全边界）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquire, release, isLocked } from '../lib/lock.js';

const LOCK_MODULE_URL = pathToFileURL(fileURLToPath(new URL('../lib/lock.js', import.meta.url))).href;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-f2-lock-'));
let seq = 0;
const lockOf = (tag) => path.join(dir, (++seq) + '-' + tag + '.lock');
const rawOf = (p) => fs.readFileSync(p, 'utf8');
const recOf = (p) => JSON.parse(rawOf(p));

// ── T-1a · AC-1：同代竞争恰一胜出（预置票号，确定性构造，零竞态）────────────────────────
test('T-1a 同代竞争（预置票号）：force 接管被拒 takeover-contended 且旧锁逐字未改；删票号后正面接管成功 fence=2', async () => {
  const lock = lockOf('contend');
  const a = await acquire(lock);
  assert.equal(a.ok, true, '阳性前置：首建锁成功');
  assert.equal(a.fence, 1, '新建锁代数 = 1');
  const before = rawOf(lock);

  // 预置票号 = 模拟「同代对手已抢到 fence 2 的票号」（票号名由旧 fence+1 派生）
  fs.writeFileSync(lock + '.takeover-2', '{}');
  const logs = [];
  const denied = await acquire(lock, { force: true, ticketTtlMs: 0, warn: (m) => logs.push(m) });

  assert.equal(denied.ok, false, '票号被占 ⇒ 不得接管');
  assert.equal(denied.conflict, true);
  assert.equal(denied.reason, 'takeover-contended', '拒绝原因须为普通字符串 takeover-contended（零新造 GATE_ 码）');
  assert.equal(denied.fence, 1, '回显的代数 = 旧锁代数（未被提升）');
  assert.equal(rawOf(lock), before, '旧锁内容必须逐字未改（不得被删/被改）');
  assert.equal(isLocked(lock), true, '锁文件仍在');
  assert.equal(recOf(lock).token, a.token, '旧锁 token 未变');
  assert.equal(recOf(lock).fence, 1, '旧锁 fence 未变');
  assert.equal(logs.length, 0, '被拒路径不得产生接管留痕（只留真接管）');

  // 阳性对照：同一调用、只删掉票号 ⇒ 必须成功且 fence = 2
  fs.unlinkSync(lock + '.takeover-2');
  const logs2 = [];
  const ok = await acquire(lock, { force: true, ticketTtlMs: 0, warn: (m) => logs2.push(m) });
  assert.equal(ok.ok, true, '阳性对照：无票号竞争时接管须成功');
  assert.equal(ok.fence, 2, '接管后代数 = 旧值 + 1');
  assert.equal(ok.takeover.from.fence, 1, '返回载荷 takeover.from.fence = 旧代数（代数判据真源）');
  assert.equal(ok.takeover.to.fence, 2);
  assert.equal(ok.takeover.from.token, a.token, '留痕载荷回显旧持有者 token');
  const after = recOf(lock);
  assert.equal(after.fence, 2, '盘上代数已提升');
  assert.equal(after.token, ok.token, '盘上持有者 = 新 token');

  // AC-8：接管成功恰 1 行留痕，字段齐备
  assert.equal(logs2.length, 1, '接管成功须恰 1 行 warn 留痕');
  const line = logs2[0];
  for (const frag of ['lane lock 接管', 'fence 1→2', 'from token=', 'pid=', 'holderState=', 'kind=', 'prevTs=']) {
    assert.ok(line.includes(frag), '留痕行须含 `' + frag + '`（实际：' + line + '）');
  }

  // 旧凭证失效（凭证失效面真实判据，规格 §1.2 第 4 条）
  assert.deepEqual(release(lock, a.token), { ok: false, reason: 'token-mismatch' }, '旧持有者放不掉新锁');
  assert.equal(isLocked(lock), true);
  assert.deepEqual(release(lock, ok.token), { ok: true });
  assert.equal(isLocked(lock), false);
});

// ── T-1b · AC-7：旧格式 / 不可解析锁 → 拒接管且零删除（配新格式阳性对照）─────────────────
test('T-1b 旧格式锁（无 fence）：force 拒 lock-legacy-format 且零删除；补 fence 后同调用成功；不可解析锁同理', async () => {
  const lock = lockOf('legacy');
  // 旧格式 = v0.5.2 形态（有 token 无 fence）
  fs.writeFileSync(lock, JSON.stringify({ token: 'T-LEGACY', ts: 1, pid: 1 }));
  const before = rawOf(lock);
  const denied = await acquire(lock, { force: true, ticketTtlMs: 0 });
  assert.equal(denied.ok, false, '旧格式 ⇒ 不得接管');
  assert.equal(denied.reason, 'lock-legacy-format');
  assert.equal(rawOf(lock), before, '旧格式锁内容必须逐字未改（不得被删/被改）');
  assert.equal(isLocked(lock), true);
  assert.equal(fs.existsSync(lock + '.takeover-2'), false, '被拒时不得残留票号');
  assert.deepEqual(release(lock, 'T-LEGACY'), { ok: false, reason: 'lock-legacy-format' }, 'release 对旧格式同样 fail-closed');
  assert.equal(rawOf(lock), before, 'release 被拒后文件仍在且未改');

  // 阳性对照：同形状 + 补 `fence` ⇒ 同调用必须成功
  fs.writeFileSync(lock, JSON.stringify({ token: 'T-LEGACY', ts: 1, pid: 1, fence: 1 }));
  const ok = await acquire(lock, { force: true, ticketTtlMs: 0 });
  assert.equal(ok.ok, true, '阳性对照：合规锁 ⇒ 接管成功');
  assert.equal(ok.fence, 2);
  assert.equal(recOf(lock).token, ok.token);
  release(lock, ok.token);

  // 不可解析：JSON 垃圾 ⇒ lock-unparseable，零删除
  const lock2 = lockOf('garbage');
  fs.writeFileSync(lock2, 'not-json{');
  const before2 = rawOf(lock2);
  const bad = await acquire(lock2, { force: true, ticketTtlMs: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'lock-unparseable');
  assert.equal(rawOf(lock2), before2, '不可解析锁不得被删/被改');
});

// ── T-1c · AC-6：release 越权面（缺 token / 空串 / 不匹配）⇒ 拒且锁仍在 ────────────────────
test('T-1c release 越权：undefined/空串 ⇒ token-required 且锁仍在；不匹配 ⇒ token-mismatch；正 token 才删', async () => {
  const lock = lockOf('release');
  const a = await acquire(lock);

  assert.deepEqual(release(lock, undefined), { ok: false, reason: 'token-required' }, '缺 token 不得释放');
  assert.deepEqual(release(lock, ''), { ok: false, reason: 'token-required' }, '空串 token 不得释放');
  assert.equal(isLocked(lock), true, '被拒后原持有者仍持有（锁文件仍在）');
  assert.equal(recOf(lock).token, a.token, '锁内容未被动过');

  assert.deepEqual(release(lock, 'not-the-token'), { ok: false, reason: 'token-mismatch' }, '错误 token 不得释放');
  assert.equal(isLocked(lock), true);

  // 阳性对照：真 token ⇒ ok 且锁消失
  assert.deepEqual(release(lock, a.token), { ok: true });
  assert.equal(isLocked(lock), false);
  // 既有幂等语义保留（锁不存在 ⇒ ok:true）
  assert.deepEqual(release(lock, 'any-string'), { ok: true }, '锁不存在时 release 仍幂等 ok:true');
});

// ── T-1d · AC-2：跨进程双 force 收敛不变量（代数取返回载荷；不用预读 fence）───────────────
const CHILD = path.join(dir, 'f2-lock-child.mjs');
fs.writeFileSync(CHILD, [
  "import { acquire } from " + JSON.stringify(LOCK_MODULE_URL) + ';',
  'const lock = process.argv[2];',
  'const r = await acquire(lock, { force: true });',
  'process.stdout.write(JSON.stringify(r));',
].join('\n'));

function runChild(lock) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CHILD, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', (e) => resolve({ spawnError: String(e && e.code || e) }));
    cp.on('close', (code) => resolve({ code, out, err }));
  });
}

test('T-1d 跨进程双 force（3 轮）：双成功必代数不同且盘上持最大代数；非持有者 release 必 token-mismatch；零胜出档锁内容未改', async (t) => {
  // 先探测子进程可用性（受限环境 EPERM/ENOENT ⇒ skip 而非 fail，规格 AC-2 降级口径）
  const probeLock = lockOf('probe');
  await acquire(probeLock);
  const probe = await runChild(probeLock);
  release(probeLock, recOf(probeLock).token);
  if (probe.spawnError || probe.code === null || probe.out === '') {
    t.skip('child_process unavailable: ' + JSON.stringify({ spawnError: probe.spawnError, code: probe.code, err: (probe.err || '').slice(0, 200) }));
    return;
  }

  let sameGenRounds = 0;
  let sequentialRounds = 0;
  let zeroWinRounds = 0;

  for (let round = 1; round <= 3; round++) {
    const lock = lockOf('xproc' + round);
    const holder = await acquire(lock);
    assert.equal(holder.fence, 1, '前置：主进程持 fence=1');
    const before = rawOf(lock);

    const [r1, r2] = await Promise.all([runChild(lock), runChild(lock)]);
    for (const r of [r1, r2]) {
      assert.equal(r.spawnError, undefined, '子进程不得启动失败');
      assert.equal(r.code, 0, '子进程须正常退出（stderr: ' + (r.err || '').slice(0, 300) + '）');
    }
    const p1 = JSON.parse(r1.out);
    const p2 = JSON.parse(r2.out);
    const parsed = [p1, p2];
    const oks = parsed.filter((p) => p.ok === true);
    const fails = parsed.filter((p) => p.ok !== true);

    // ① 双成功 ⇒ 代数必须不同（同期同代双持有 = A1-P1-02 的直接复现）
    const fences = oks.map((p) => p.fence);
    assert.equal(new Set(fences).size, fences.length, '不得出现同代双成功（代数互异是唯一胜出的结构性保证）：' + JSON.stringify(fences));
    // ② 代数判据（返回载荷）：单/双成功下 fence 必取自 {2,3}
    for (const f of fences) assert.ok([2, 3].includes(f), '接管成功载荷 fence ∈ {2,3}（实际 ' + f + '）');
    // 每个胜出者的载荷须自洽：from.fence = fence - 1（代数链内严格递增）
    for (const p of oks) {
      assert.equal(p.takeover.from.fence, p.fence - 1, '载荷自洽：from.fence = fence - 1（实际 ' + JSON.stringify(p.takeover) + '）');
    }
    if (oks.length === 2) {
      assert.deepEqual(fences.slice().sort(), [2, 3], '双成功 ⇒ 依次接管 2 → 3');
      sequentialRounds++;
    } else if (oks.length === 1) {
      assert.equal(oks[0].takeover.from.fence, 1, '单成功 ⇒ 同代竞争胜出（旧代数 1）');
      sameGenRounds++;
    } else {
      // ③ 零胜出档（Windows rename 瞬时失败 ⇒ 全员 fail-closed）：锁内容逐字未改
      zeroWinRounds++;
      assert.equal(rawOf(lock), before, '零胜出档：锁内容必须逐字未改');
      for (const f of fails) {
        assert.ok(f.conflict === true, '零胜出档回执须 conflict:true');
        assert.ok(f.reason === undefined || f.reason === 'takeover-contended', '零胜出档原因 ∈ {undefined, takeover-contended}（实际 ' + f.reason + '）');
      }
      release(lock, holder.token);
      continue;
    }

    // ④ 盘上真源：代数 = 最大胜出代数，token = 该胜出者；绝不为 1（证明发生了接管）
    const disk = recOf(lock);
    const maxFence = Math.max(...fences);
    assert.ok([2, 3].includes(disk.fence), '盘上 fence ∈ {2,3}，绝不为 1（实际 ' + disk.fence + '）');
    assert.equal(disk.fence, maxFence, '盘上代数 = 最大胜出代数');
    const winner = oks.find((p) => p.fence === maxFence);
    assert.equal(disk.token, winner.token, '盘上持有者 = 最大代数胜出者（旧 token 在盘上已不存在）');

    // ⑤ 凡非最终持有者，其 release 必被拒（凭证失效面）：有 token 的非持有者 ⇒ token-mismatch；
    //    未拿到 token 的失败方本就无凭证 ⇒ 断言其回执为 conflict（不得回 ok:true）
    for (const p of parsed) {
      if (p.token === disk.token) continue;
      if (typeof p.token === 'string') {
        assert.deepEqual(release(lock, p.token), { ok: false, reason: 'token-mismatch' },
          '非最终持有者的 release 必须 token-mismatch');
        assert.equal(isLocked(lock), true, '被拒释放不得删锁');
      } else {
        assert.ok(p.conflict === true && p.ok !== true, '未拿到 token 的一方必须是 conflict 回执');
      }
    }
    // 收尾：最终持有者可释放（阳性对照：锁面仍可用）
    assert.deepEqual(release(lock, disk.token), { ok: true });
    assert.equal(isLocked(lock), false);
  }

  t.diagnostic('跨进程 3 轮分布：同代竞争=' + sameGenRounds + ' 顺序接管=' + sequentialRounds + ' 零胜出=' + zeroWinRounds);
  assert.equal(sameGenRounds + sequentialRounds + zeroWinRounds, 3, '每轮必落且仅落一档');
});
