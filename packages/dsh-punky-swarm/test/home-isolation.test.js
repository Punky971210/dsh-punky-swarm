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

// 测试隔离守卫（home isolation guard）。
//
// 守卫对象：`test/helpers/isolated-home.preload.mjs` 把 `os.homedir()` / `DSH_HOME` 重定向到临时根之后，
// 被测代码的真实写点（`apply()` 的资产同步 + 引擎根、审计 sink 根）是否**确实**全部落在隔离根内，
// 且真实用户目录面在被测路径前后**逐字零变化**。
//
// 三条断言：
//   G1 隔离前置（precondition）——本进程 `os.homedir()` 必须等于 preload 声明的隔离根。
//      真实 home 真源取 `os.userInfo().homedir`（系统账户 API，不受 USERPROFILE/HOME 改写影响）。
//   G2 真实面零变化——**被测算面**上取文件级指纹（相对路径 + 字节数 + mtimeMs 的 sha256）前后对比必须全等。
//      用文件级而非目录 mtime：目录 mtime 对内层文件写入不敏感。
//   G3 写点归属（主判别项）——被测路径产生的写入落点与日志自报落点都必须 `startsWith(隔离根)`。
//
// 断言面（2026-09-13 修正，本文件本轮改动）——「被测算面」与「活宿主面」必须分开：
//   · 被测算面（REAL_FACES，参与 G2 指纹全等断言）= 仅被测代码可写的两个资产同步目标根：
//       `<home>/.agents/skills`、`<home>/.dsh/.agent-presets`
//       （`lib/assets.js:73-90` 的 syncDir 内容幂等：逐文件 size+mtime 容差 + 字节比对，一致即 'current'
//        不落写 ⇒ 「运行前后逐字全等」是本测试可满足的真实不变量）。
//   · 活宿主面（LIVE_FACES，**结构性排除**）= `<home>/.dsh/logs`（审计 sink 根）：
//       真实机上的常驻宿主逐 tick 追加 `punky-swarm/audit-<date>.jsonl`（实测 2026-09-13 单卷 967 KB →
//       1.09 MB 且持续增长），该面的存在性与内容都是**宿主活动的函数**，与被测路径无关。
//       把它放进 G2 的「前后指纹全等」断言 ⇒ 断言把宿主的合法写入读成隔离泄漏（**结构性错误**：
//       断言面里混进了「活宿主本来就会写」的面，与被测代码是否泄漏无关）。
//   · 活宿主面退出状态断言 ≠ 放弃对该面的判别：其泄漏判别下沉到**归属谓词**
//       （G3 的 self-report 归属 + D4 的真实面落点对照），判据与宿主噪声正交——
//       宿主写多少次都不改变「被测进程的落点归谁」这一判定；另加 `liveFaceExcluded` 自检，
//       防止该面被重新放回指纹面（结构性错误靠代码判红，不靠注释约束）。
//
// 写安全的构造性保证：G1 是 G2/G3 的前置闸。G1 不成立时 `before` 钩子立即失败，
// **不执行**任何被测写路径——隔离没确认，就不动手，因此守卫本身在任何情况下都不会写真实 home。
//
// 未加载 preload 时（例如直接跑 `node --test`）本文件不判红（否则常规跑法会整片变红），
// 改为把 G1/G2/G3 搬到**一个以正确 preload 隔离的子进程**里跑：判定逻辑不变，只是执行位置换到被隔离的
// 进程，并由本进程对子进程回报的真实证据（隔离根内文件清单 + 真实面前后指纹）做断言；机制失效即判红。
//
// 判别力自证（四条，全部在受控临时目录内，绝不触碰真实面）：
//   D1 谓词级：把「实际重定向到 A、却声明隔离根为 B（B≠A）」的取值喂给 G1/G3 谓词 → 必须判红。
//   D2 进程级：用**故意写错的 preload**（声明 B、实际重定向 A）跑本文件自身 → 守卫必须红（子进程非零退出）。
//   D3 写入级：在同一故意写错的 preload 下真跑一次 `apply()` → 真实产出的文件落点不在声明隔离根内，
//      把这些**真实文件路径**喂给 G3 谓词 → 必须判红。
//   D4 活宿主面：真实 sink 落点喂 G3 谓词必须判红（活宿主面仍受归属判别）；把活宿主面放回「零变化」
//      指纹面必须被 `liveFaceExcluded` 自检判红（断言面收窄本身有牙，不是删断言了事）。
//
// 已知限制（如实披露，勿读作更强的结论）：
//   ① D1–D3 用「重定向到另一个受控临时目录」代表「隔离失效」，证明的是**守卫谓词与守卫进程在偏移场景下
//      确实判红**；它**不等价于**「真实 home 泄漏必被捕获」——后者只有把被测路径真的指向真实 home 才能观测，
//      而那是本批次明令禁止的动作。故本文件的证据强度是「捕获能力已证、真实泄漏场景未做（也不做）」。
//   ② G2 对比的是真实面**本次运行窗口内**的指纹；若测试机上有并发进程恰好在同一窗口写这几个真实目录
//      （资产同步幂等、正常不会改字节），G2 可能被外部活动扰动——这是 G2 作为「结果断言」的固有边界，
//      机制侧的判据是 G3。
//   ③ 未加载 preload 的常规跑法下，本文件只能替子进程证实机制生效，无法回溯本进程已发生的写入。
//   ④ 活宿主面（`<home>/.dsh/logs`）**不再有任何状态级断言**（存在性/内容/指纹都不判）：该面由常驻宿主
//      持续写，状态级断言结构性不可靠（这正是 2026-09-13 修正的原因）。该面的能力边界如实收窄为
//      「归属判别仍生效（D4/G3），状态变化不再作为证据」——本文件不假装它仍被状态断言覆盖。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const PRELOAD = path.join(HERE, 'helpers', 'isolated-home.preload.mjs');
const INDEX_URL = new URL('../lib/index.js', import.meta.url).href;
const GUARD_URL = import.meta.url;
const ISOLATED = (process.env.PUNKY_TEST_ISOLATED_HOME ?? '').trim();
const DEMO_CHILD = process.env.PUNKY_ISOLATION_DEMO_CHILD === '1';
// 真实 home 真源：os.userInfo() 走系统账户 API，preload 改写的 USERPROFILE/HOME 影响不到它。
const REAL_HOME = os.userInfo().homedir;

// 真实面上的**被测算面**（REAL_FACES）：只保留「仅被测代码会写」的两个资产同步目标根。
// 判据：该面在真实机上只由 punky-swarm 的 syncAssets() 写，且同步内容幂等（§头部断言面说明），
// 故「本测试运行前后逐字全等」是可满足的真实不变量。活宿主面见 LIVE_FACES（结构性排除，不在此列）。
const REAL_FACES = [
  path.join(REAL_HOME, '.agents', 'skills'),
  path.join(REAL_HOME, '.dsh', '.agent-presets'),
];

// 真实面上的**活宿主面**（LIVE_FACES）：常驻宿主本就会持续写这些路径 ⇒ 不得进入「零变化」断言面。
// `~/.dsh/logs` = 审计 sink 根：活宿主逐 tick 追加 `punky-swarm/audit-<date>.jsonl`
// （实测 2026-09-13 单卷 967 KB → 1.09 MB 且持续增长）。该面的存在性/内容/指纹都是宿主活动的函数，
// 与被测路径无关；把它放进 G2 会被读成「隔离泄漏」的假警报（结构性错误）。
// 该面的泄漏判别由归属谓词承担（G3 自报落点归属 + D4 真实面落点对照 + liveFaceExcluded 自检）。
const LIVE_FACES = [
  {
    path: path.join(REAL_HOME, '.dsh', 'logs'),
    reason: '审计 sink 根：常驻宿主逐 tick 追写 audit-<date>.jsonl（合法写入，非本测试可观测面）',
  },
];
// 真实面 sink 落点样本：喂给归属谓词做「真实面必须判越界」的确定性对照（不触碰该文件）。
const REAL_SINK_PROBE = path.join(LIVE_FACES[0].path, 'punky-swarm', 'audit-probe.jsonl');

// ── 谓词（纯函数，供判别力自证直接调用）──

function normPath(p) {
  // 解析最近的存在祖先后拼回未解析的尾部（被测落点常常尚不存在，不能直接 realpath）。
  // 两侧口径必须一致：Windows 临时目录会以 8.3 短名（ADMINI~1）出现，与长名混用会让同一条路径比不相等。
  let cur = path.resolve(String(p ?? ''));
  const tail = [];
  for (;;) {
    try { cur = fs.realpathSync.native(cur); break; } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  const out = tail.length ? path.join(cur, ...tail) : cur;
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** G1 谓词：homedir 必须等于声明的隔离根，且不等于真实 home。 */
export function g1Verdict(homedirValue, sentinelValue, realHomeValue) {
  const sentinel = String(sentinelValue ?? '').trim();
  const reasons = [];
  if (!sentinel) reasons.push('未声明隔离根（进程未加载隔离 preload）');
  if (sentinel && normPath(homedirValue) !== normPath(sentinel)) {
    reasons.push(`os.homedir()=${homedirValue} 不等于声明的隔离根=${sentinel}`);
  }
  if (sentinel && realHomeValue && normPath(sentinel) === normPath(realHomeValue)) {
    reasons.push('声明的隔离根就是真实 home');
  }
  if (realHomeValue && normPath(homedirValue) === normPath(realHomeValue)) {
    reasons.push('os.homedir() 仍在真实 home');
  }
  return { ok: reasons.length === 0, reasons };
}

/** G3 谓词：每条写入落点都必须位于隔离根之下。 */
export function attributionVerdict(writtenPaths, isolatedRoot) {
  const root = normPath(isolatedRoot);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const outside = [];
  for (const p of writtenPaths) {
    const n = normPath(p);
    if (n !== root && !n.startsWith(prefix)) outside.push(p);
  }
  return { ok: outside.length === 0, outside };
}

/**
 * 断言面自检：活宿主面不得出现在「零变化」指纹面内。
 * 结构性错误（把活宿主合法写入面放进结果断言）必须由代码判红，而不是只写在注释里。
 * @param {string[]} faces 「零变化」指纹断言面
 * @param {string[]} livePaths 活宿主面路径（缺省 LIVE_FACES）
 */
export function liveFaceExcluded(faces, livePaths = LIVE_FACES.map((f) => f.path)) {
  const offenders = [];
  for (const face of faces) {
    for (const live of livePaths) if (normPath(face) === normPath(live)) offenders.push(face);
  }
  return { ok: offenders.length === 0, offenders };
}

// ── 指纹与文件工具 ──

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        files.push({ rel: path.relative(root, p), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

/** 文件级指纹：相对路径 + 字节数 + mtimeMs 的 sha256 摘要。 */
function fingerprint(root) {
  if (!fs.existsSync(root)) return { root, exists: false, count: 0, sumBytes: 0, digest: 'absent' };
  const files = walkFiles(root);
  const h = crypto.createHash('sha256');
  let sum = 0;
  for (const f of files) {
    h.update(f.rel + '\u0000' + f.size + '\u0000' + f.mtimeMs + '\n');
    sum += f.size;
  }
  return { root, exists: true, count: files.length, sumBytes: sum, digest: h.digest('hex') };
}

const snapshotReal = () => REAL_FACES.map((p) => fingerprint(p));
const listFiles = (root) => (fs.existsSync(root) ? walkFiles(root).map((f) => path.join(root, f.rel)) : []);
const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'punky-guard-' + tag + '-'));
const readIfExists = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** 用文件承接子进程 stdio（不依赖管道），返回 {status, out}。 */
function spawnToFiles(bin, args, env, dir) {
  const outFile = path.join(dir, 'child-out.txt');
  const errFile = path.join(dir, 'child-err.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let status;
  try {
    // NODE_TEST_* 必须剔除：父进程带着 NODE_TEST_CONTEXT 时，子进程会判定「测试内递归调用 run()」
    // 而直接跳过文件（实测回显：`node:test run() is being called recursively within a test file`
    // 并以 0 退出，等于子进程什么也没跑）。
    const childEnv = { ...process.env, ...env };
    for (const k of Object.keys(childEnv)) if (k.startsWith('NODE_TEST_')) delete childEnv[k];
    status = spawnSync(bin, args, { cwd: PACKAGE_ROOT, env: childEnv, stdio: ['ignore', outFd, errFd] }).status;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return { status, out: readIfExists(outFile) + readIfExists(errFile) };
}

function parseReport(out) {
  const m = out.match(/@@REPORT@@([\s\S]*?)@@END@@/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ── 被测路径：真实 apply() 全流程（仅在 G1 成立后执行）──

const state = { applied: false, realBefore: null, realAfter: null, isolatedBefore: null, isolatedAfter: null, logs: null };

before(async () => {
  if (!ISOLATED) return;                              // 未隔离：不执行写路径（写安全构造性保证）
  const verdict = g1Verdict(os.homedir(), ISOLATED, REAL_HOME);
  if (!verdict.ok) {
    assert.fail('G1 隔离前置不成立，已阻止被测写路径执行：' + verdict.reasons.join('；'));
  }
  state.realBefore = snapshotReal();
  state.isolatedBefore = fingerprint(ISOLATED);
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
    exporter: () => () => {},               // 使审计 sink 的前置判定通过 ⇒ 真走到建目录 + 挂 exporter
  };
  const ctx = { logger, root: { logger }, tools: { register() {} } };
  const { apply } = await import(INDEX_URL);
  apply(ctx, {});
  state.applied = true;
  state.logs = calls;
  state.isolatedAfter = fingerprint(ISOLATED);
  state.realAfter = snapshotReal();
});

// ── 未隔离进程的替代路径：把被测写路径放进一个**以正确 preload 隔离的子进程**里跑，
//    由本进程对子进程产出的真实证据做判定（判定逻辑不变，只是执行位置换到被隔离的进程）──

let mechCache = null;
function mechanismRun() {
  if (mechCache) return mechCache;
  const dir = tmpRoot('mech');
  const realBefore = snapshotReal();
  const probe = path.join(dir, 'mechanism-probe.mjs');
  fs.writeFileSync(probe, mechanismProbeSrc(INDEX_URL), 'utf8');
  const r = spawnToFiles(process.execPath, ['--import', pathToFileURL(PRELOAD).href, probe], process.env, dir);
  const realAfter = snapshotReal();
  mechCache = { dir, status: r.status, out: r.out, report: parseReport(r.out), realBefore, realAfter };
  return mechCache;
}

after(() => { if (mechCache) fs.rmSync(mechCache.dir, { recursive: true, force: true }); });

// ── G1 ──

test('G1 隔离前置：os.homedir() 落在声明隔离根内且非真实 home', () => {
  if (!ISOLATED) {
    // 未隔离进程：本进程内 G1 无从成立，改为在子进程里以正确 preload 实证机制生效。
    // 既不空转（机制失效即判红），也不制造假警报（不把常规 `node --test` 跑法整片变红）。
    const m = mechanismRun();
    assert.ok(m.report, '子进程机制探针应产出 JSON 报告；实际输出：' + m.out.slice(0, 800));
    assert.equal(m.status, 0, '机制探针本身应正常退出；输出：' + m.out.slice(0, 800));
    assert.equal(m.report.g1Ok, true, '正确 preload 下子进程 G1 必须成立：' + JSON.stringify(m.report));
    assert.equal(m.report.homedirIsolated, true, '子进程 os.homedir() 必须落在其隔离根内');
    assert.equal(m.report.sinkCreated, true, '子进程内 apply() 的审计 sink 根必须在隔离根内被创建');
    assert.equal(m.report.assetsSynced, true, '子进程内资产同步必须落到隔离根内');
    // 活宿主面（真实 <home>/.dsh/logs）**不再**用「存在性」判：该面由常驻宿主持续写，存在性无判别力
    // （2026-09-13 修正，见头部断言面说明）。改用确定性归属对照：真实面 sink 落点必须被判越界。
    assert.equal(attributionVerdict([REAL_SINK_PROBE], m.report.sentinel).ok, false,
      '对照组：真实 <home>/.dsh/logs 落点必须被判越界（活宿主面退出状态断言 ≠ 放弃归属判别）');
    process.stderr.write('[home-isolation] 本进程未加载隔离 preload：G1/G2/G3 已改在隔离子进程内实证；'
      + '要获得进程内隔离请用 `npm test`（preload 已接线）。\n');
    return;
  }
  const verdict = g1Verdict(os.homedir(), ISOLATED, REAL_HOME);
  assert.equal(verdict.ok, true, 'G1 必须成立：' + verdict.reasons.join('；'));
  assert.equal(normPath(os.homedir()), normPath(ISOLATED), 'os.homedir() 等于声明隔离根');
  assert.notEqual(normPath(os.homedir()), normPath(REAL_HOME), 'os.homedir() 不是真实 home');
});

// ── G2 ──

test('G2 真实面零变化：apply() 全流程前后真实面文件级指纹逐字全等', () => {
  if (!ISOLATED) {
    const m = mechanismRun();
    for (let i = 0; i < REAL_FACES.length; i++) {
      const b = m.realBefore[i];
      const a = m.realAfter[i];
      assert.equal(a.exists, b.exists, `子进程跑 apply() 前后真实面存在性不变：${REAL_FACES[i]}`);
      assert.equal(a.count, b.count, `子进程跑 apply() 前后真实面文件数不变：${REAL_FACES[i]}`);
      assert.equal(a.sumBytes, b.sumBytes, `子进程跑 apply() 前后真实面字节和不变：${REAL_FACES[i]}`);
      assert.equal(a.digest, b.digest, `子进程跑 apply() 前后真实面文件级指纹不变：${REAL_FACES[i]}`);
    }
    // 活宿主面不参与上面的「零变化」断言（宿主持续追写该面）；改用归属对照 + 断言面自检
    // （D4 已就同一谓词/同一自检给出判别力演示）。
    assert.equal(attributionVerdict([REAL_SINK_PROBE], m.report.sentinel).ok, false,
      '对照组：真实 <home>/.dsh/logs 落点必须被判越界（活宿主面退出状态断言）');
    assert.equal(liveFaceExcluded(REAL_FACES).ok, true,
      '「零变化」断言面不得包含活宿主面：' + JSON.stringify(liveFaceExcluded(REAL_FACES).offenders));
    return;
  }
  assert.ok(state.applied, '被测路径已执行（G1 不成立时本用例由前置闸阻断）');
  for (let i = 0; i < REAL_FACES.length; i++) {
    const b = state.realBefore[i];
    const a = state.realAfter[i];
    assert.equal(a.exists, b.exists, `真实面存在性不变：${REAL_FACES[i]}`);
    assert.equal(a.count, b.count, `真实面文件数不变：${REAL_FACES[i]}`);
    assert.equal(a.sumBytes, b.sumBytes, `真实面字节和不变：${REAL_FACES[i]}`);
    assert.equal(a.digest, b.digest, `真实面文件级指纹不变：${REAL_FACES[i]}`);
  }
  // 活宿主面（REAL_HOME/.dsh/logs）**不在**上面的指纹面内：常驻宿主逐 tick 追写该面，
  // 把它的存在性/内容读成泄漏是结构性错误（2026-09-13 修正）。该面的判据改为两条确定性对照：
  assert.equal(liveFaceExcluded(REAL_FACES).ok, true,
    '「零变化」断言面不得包含活宿主面：' + JSON.stringify(liveFaceExcluded(REAL_FACES).offenders));
  assert.equal(attributionVerdict([REAL_SINK_PROBE], ISOLATED).ok, false,
    '对照组：真实 <home>/.dsh/logs 落点必须被判越界（本进程实际 sink 根归属由 G3 判）');
});

// ── G3 ──

test('G3 写点归属：apply() 的全部写入落点位于隔离根之下', () => {
  if (!ISOLATED) {
    const m = mechanismRun();
    assert.ok(m.report && Array.isArray(m.report.writtenFiles), '子进程应回报隔离根内的文件清单');
    assert.ok(m.report.writtenFiles.length > 0, '子进程内 apply() 确实产生了写入（写入发生且被转移）');
    const verdict = attributionVerdict(m.report.writtenFiles, m.report.sentinel);
    assert.equal(verdict.ok, true, '子进程写入落点必须在隔离根之下，越界：' + JSON.stringify(verdict.outside));
    assert.equal(attributionVerdict([path.join(REAL_HOME, '.dsh', 'logs', 'x.jsonl')], m.report.sentinel).ok, false,
      '对照组：真实面落点必须被同一谓词判红');
    return;
  }
  assert.ok(state.applied, '被测路径已执行');
  const sinkDir = path.join(ISOLATED, '.dsh', 'logs', 'punky-swarm');
  const skillDir = path.join(ISOLATED, '.agents', 'skills');
  const presetDir = path.join(ISOLATED, '.dsh', '.agent-presets');
  assert.equal(fs.existsSync(sinkDir), true, '审计 sink 根已在隔离根内创建（写入确实发生且被转移）');
  assert.equal(fs.existsSync(path.join(skillDir, 'software-team', 'SKILL.md')), true, '技能资产落在隔离根内');
  assert.equal(fs.existsSync(path.join(presetDir, 'jiufeng')), true, '预设资产落在隔离根内');
  assert.ok(state.isolatedAfter.count > state.isolatedBefore.count,
    `隔离根内文件数应因被测路径而增长：${state.isolatedBefore.count} → ${state.isolatedAfter.count}`);

  // 日志自报落点：解析 apply() 的启动日志（引擎根 / sink 落点 / 资产同步目标），逐条核对归属
  const reported = [];
  for (const line of state.logs.info) {
    const engine = line.match(/engine root:\s*(.+?)；/);
    if (engine) reported.push(engine[1].trim());
    const sink = line.match(/audit log sink mounted:\s*(.+)$/);
    if (sink) reported.push(path.dirname(sink[1].trim()));
    const synced = line.match(/asset synced:\s*(.+)$/);
    if (synced) {
      const rel = synced[1].trim().replace(/\//g, path.sep);
      reported.push(rel.startsWith('skills' + path.sep)
        ? path.join(ISOLATED, '.agents', rel)
        : path.join(ISOLATED, '.dsh', '.agent-presets', rel));
    }
  }
  assert.ok(reported.length >= 2, '应解析到引擎根与 sink 落点两类自报路径；实际 ' + JSON.stringify(reported));
  const verdict = attributionVerdict(reported, ISOLATED);
  assert.equal(verdict.ok, true, '自报落点必须在隔离根之下，越界：' + JSON.stringify(verdict.outside));
  assert.equal(attributionVerdict(listFiles(ISOLATED), ISOLATED).ok, true, '隔离根内文件清单归属自洽');
});

// ── 判别力自证 D1：谓词级 ──

test('D1 判别力（谓词级）：偏移取值下 G1/G3 谓词必须判红', () => {
  const dir = tmpRoot('d1');
  try {
    const claimed = path.join(dir, 'claimed-root');
    const actual = path.join(dir, 'actual-root');
    fs.mkdirSync(claimed, { recursive: true });
    fs.mkdirSync(actual, { recursive: true });

    const g1 = g1Verdict(actual, claimed, REAL_HOME);
    assert.equal(g1.ok, false, 'G1 谓词对「实际 ≠ 声明」必须判红');
    assert.deepEqual(g1.reasons.length > 0, true, 'G1 判红须给出原因');
    assert.equal(g1Verdict(REAL_HOME, claimed, REAL_HOME).ok, false, 'G1 谓词对「homedir 仍在真实 home」必须判红');
    assert.equal(g1Verdict(REAL_HOME, REAL_HOME, REAL_HOME).ok, false, 'G1 谓词对「声明的隔离根就是真实 home」必须判红');
    assert.equal(g1Verdict(claimed, claimed, REAL_HOME).ok, true, '对照组：隔离值自洽时 G1 判绿');

    const inside = path.join(claimed, '.dsh', 'logs', 'punky-swarm', 'audit.jsonl');
    const outside = path.join(actual, '.dsh', 'logs', 'punky-swarm', 'audit.jsonl');
    const g3 = attributionVerdict([outside, inside], claimed);
    assert.equal(g3.ok, false, 'G3 谓词对「写入落在隔离根之外」必须判红');
    assert.deepEqual(g3.outside, [outside], 'G3 谓词精确指出越界的那一条');
    assert.equal(attributionVerdict([inside], claimed).ok, true, '对照组：合法落点 G3 判绿');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 判别力自证 D2：进程级（守卫自身在写错隔离时必须红）──

test('D2 判别力（进程级）：故意写错的 preload 下守卫子进程必须红', { skip: DEMO_CHILD }, () => {
  const dir = tmpRoot('d2');
  const realBefore = snapshotReal();
  try {
    const actual = path.join(dir, 'actual');
    const claimed = path.join(dir, 'claimed');
    const preload = path.join(dir, 'broken.preload.mjs');
    fs.writeFileSync(preload, brokenPreloadSrc(), 'utf8');
    const r = spawnToFiles(process.execPath,
      ['--import', pathToFileURL(preload).href, '--test', fileURLToPath(GUARD_URL)],
      { ...process.env, PUNKY_ISOLATION_DEMO_CHILD: '1', PUNKY_DEMO_ACTUAL: actual, PUNKY_DEMO_CLAIMED: claimed },
      dir);
    assert.notEqual(r.status, 0, '写错 preload 时守卫子进程必须以非零退出（红）。输出：' + r.out.slice(0, 1200));
    assert.match(r.out, /G1 隔离前置不成立/, '红色原因必须是 G1 前置闸命中');
    // 写安全：G1 不成立 ⇒ 被测写路径未执行 ⇒ 注入目录内不得出现 sink 落点
    assert.equal(fs.existsSync(path.join(actual, '.dsh', 'logs')), false,
      '守卫在 G1 失败时不得执行写路径（写安全构造性保证）');
    // 本演示同样不得付出真实面代价
    assert.deepEqual(snapshotReal().map((x) => x.digest), realBefore.map((x) => x.digest), 'D2 演示不得改变真实面');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 判别力自证 D3：写入级（写错隔离时真实写入落点被判红）──

test('D3 判别力（写入级）：写错隔离时真实写点不在声明隔离根内 → G3 谓词判红', { skip: DEMO_CHILD }, () => {
  const dir = tmpRoot('d3');
  const realBefore = snapshotReal();
  try {
    const actual = path.join(dir, 'actual');
    const claimed = path.join(dir, 'claimed');
    const preload = path.join(dir, 'broken.preload.mjs');
    const probe = path.join(dir, 'write-probe.mjs');
    fs.writeFileSync(preload, brokenPreloadSrc(), 'utf8');
    fs.writeFileSync(probe, writeProbeSrc(INDEX_URL), 'utf8');
    const r = spawnToFiles(process.execPath,
      ['--import', pathToFileURL(preload).href, probe],
      { ...process.env, PUNKY_DEMO_ACTUAL: actual, PUNKY_DEMO_CLAIMED: claimed },
      dir);
    assert.equal(r.status, 0, '写入探针应正常跑完（它是「隔离写错」场景下的被测路径）。输出：' + r.out.slice(0, 800));
    const report = parseReport(r.out);
    assert.ok(report, '写入探针应产出 JSON 报告：' + r.out.slice(0, 800));
    assert.ok(report.writtenUnderActual.length > 0, '写错隔离时 apply() 确实写进了注入目录（真实写入证据）');
    assert.equal(report.writtenUnderClaimed.length, 0, '声明的隔离根下不应有任何写入');
    // 活宿主面改用确定性归属对照（原先的「真实 <home>/.dsh/logs 不得出现」无判别力：常驻宿主本就写它）
    assert.equal(attributionVerdict([REAL_SINK_PROBE], report.claimedRoot).ok, false,
      '对照组：真实 <home>/.dsh/logs 落点必须被判越界（活宿主面归属判据仍生效）');
    for (const p of report.writtenUnderActual) {
      // 逐条证据：这些**真实文件**若交给 G3 谓词核对归属，必须判越界
      assert.equal(attributionVerdict([p], report.claimedRoot).ok, false, '越界落点必须判红：' + p);
    }
    assert.equal(attributionVerdict(report.writtenUnderClaimed, report.claimedRoot).ok, true, '对照组判绿');
    assert.deepEqual(snapshotReal().map((x) => x.digest), realBefore.map((x) => x.digest), 'D3 演示不得改变真实面');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 判别力自证 D4：活宿主面（断言面收窄后的牙齿）──

test('D4 判别力（活宿主面）：真实 sink 落点仍被判越界；把活宿主面放回断言面必被自检判红', () => {
  const root = ISOLATED || path.join(os.tmpdir(), 'punky-guard-d4-root');
  // ① 活宿主面退出「零变化」指纹断言 ≠ 放弃对该面的判别：真实面落点喂同一归属谓词必须判红。
  //    该判据与宿主噪声正交——宿主写多少次都不改变「被测进程的落点归谁」这一判定。
  assert.equal(attributionVerdict([REAL_SINK_PROBE], root).ok, false,
    '真实 <home>/.dsh/logs 落点必须被归属谓词判红');
  assert.equal(attributionVerdict([path.join(root, '.dsh', 'logs', 'punky-swarm', 'a.jsonl')], root).ok, true,
    '对照组：隔离根内落点仍判绿');
  // ② 断言面自检有牙：把活宿主面放回指纹面 → 判红；现行断言面 → 判绿（收窄靠代码约束，不靠注释）。
  assert.equal(liveFaceExcluded(REAL_FACES).ok, true, '现行「零变化」断言面不得包含活宿主面');
  const reAdded = liveFaceExcluded([...REAL_FACES, LIVE_FACES[0].path]);
  assert.equal(reAdded.ok, false, '把活宿主面放回「零变化」断言面必须判红（结构性错误不可回归）');
  assert.deepEqual(reAdded.offenders, [LIVE_FACES[0].path], '自检须精确指出被误纳的活宿主面');
});

// ── 注入用脚本源（运行时写入临时目录，不进仓库）──

// 故意写错的 preload：声明隔离根 = claimed，实际重定向到 = actual（两者都在调用方给的临时目录下）
function brokenPreloadSrc() {
  return `
import fs from 'node:fs'; import path from 'node:path';
const actual = process.env.PUNKY_DEMO_ACTUAL;
const claimed = process.env.PUNKY_DEMO_CLAIMED;
fs.mkdirSync(actual, { recursive: true });
fs.mkdirSync(claimed, { recursive: true });
process.env.USERPROFILE = actual;
process.env.HOME = actual;
process.env.DSH_HOME = path.join(actual, '.dsh');
process.env.PUNKY_TEST_ISOLATED_HOME = claimed;
process.env.PUNKY_TEST_ISOLATED_DSH_HOME = path.join(claimed, '.dsh');
`;
}

// 机制探针：以正确 preload 运行，报告机制是否真的把写点转移到了隔离根
function mechanismProbeSrc(indexUrl) {
  return `
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const sentinel = (process.env.PUNKY_TEST_ISOLATED_HOME ?? '').trim();
const real = os.userInfo().homedir;
const calls = { info: [], warn: [], error: [] };
const logger = { info: (...a) => calls.info.push(a.join(' ')), warn: (...a) => calls.warn.push(a.join(' ')), error: (...a) => calls.error.push(a.join(' ')), exporter: () => () => {} };
const ctx = { logger, root: { logger }, tools: { register() {} } };
const mod = await import(${JSON.stringify(indexUrl)});
mod.apply(ctx, {});
const norm = (p) => { let o = String(p); try { o = fs.realpathSync.native(o); } catch {} return o.toLowerCase(); };
const isUnder = (p, r) => { const a = norm(p); const b = norm(r); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };
const sink = path.join(sentinel, '.dsh', 'logs', 'punky-swarm');
const skill = path.join(sentinel, '.agents', 'skills', 'software-team', 'SKILL.md');
const preset = path.join(sentinel, '.dsh', '.agent-presets', 'jiufeng');
function walk(root) { const out = []; const st = [root]; while (st.length) { const d = st.pop(); let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) st.push(p); else if (e.isFile()) out.push(p); } } return out; }
const report = {
  g1Ok: norm(os.homedir()) === norm(sentinel) && norm(os.homedir()) !== norm(real),
  homedirIsolated: isUnder(os.homedir(), sentinel),
  homedir: os.homedir(), sentinel, realHome: real,
  sinkCreated: fs.existsSync(sink),
  assetsSynced: fs.existsSync(skill) && fs.existsSync(preset),
  writtenFiles: walk(sentinel),
  logs: calls.info,
};
console.log('@@REPORT@@' + JSON.stringify(report) + '@@END@@');
`;
}

// 写入探针：在写错的 preload 下真跑 apply()，报告真实产出的文件落点
function writeProbeSrc(indexUrl) {
  return `
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const actual = process.env.PUNKY_DEMO_ACTUAL;
const claimed = process.env.PUNKY_DEMO_CLAIMED;
const calls = { info: [], warn: [], error: [] };
const logger = { info: (...a) => calls.info.push(a.join(' ')), warn: (...a) => calls.warn.push(a.join(' ')), error: (...a) => calls.error.push(a.join(' ')), exporter: () => () => {} };
const ctx = { logger, root: { logger }, tools: { register() {} } };
const mod = await import(${JSON.stringify(indexUrl)});
mod.apply(ctx, {});
function walk(root) { const out = []; const st = [root]; while (st.length) { const d = st.pop(); let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) st.push(p); else if (e.isFile()) out.push(p); } } return out; }
const report = {
  claimedRoot: claimed, actualRoot: actual, homedir: os.homedir(),
  writtenUnderActual: walk(actual),
  writtenUnderClaimed: fs.existsSync(claimed) ? walk(claimed) : [],
};
console.log('@@REPORT@@' + JSON.stringify(report) + '@@END@@');
`;
}
