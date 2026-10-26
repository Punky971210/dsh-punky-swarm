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
//   ② **并发前提已不成立（2026-10-27 实测改写）**：本机常驻使用 Agent Teams 并行 ⇒ 「同一窗口内没有并发写」
//      这一隐含前提结构性失效。实测一次真红的形态是 `~/.dsh/.agent-presets 文件数 10 !== 11`
//      （方向 = **减少**）—— `lib/assets.js` 的 `syncDir` 更新路径是**整目录 rmSync + cpSync**，
//      窗口内会瞬时看不到文件 ⇒ 「取 after 时 cp 未完成」与「终态真少一个文件」两种情形**必须区分**。
//      ⇒ G2 改为**三态判定**（`g2Verdict`）：
//        · `green`：after 与 before 四字段逐字全等；
//        · `inconclusive{transient}`：after ≠ before 但 `settleMs`（默认 500ms，**恰 1 次**重取）后 after2 == before
//          —— 并发同步 rm+cp 的中间态；
//        · `inconclusive{unattributable}`：差异持久且**不可归因**于被测运行；
//        · `red`：差异持久**且**可归因（差异项 ∩ 被测产物面 ≠ ∅）。
//      **`inconclusive` 永不计入通过**（`g2Summary().passed === (red===0 && inconclusive===0)`）；
//      默认 `strict`：inconclusive ⇒ 本用例红（无消费者时 fail-closed）。残量上界如实登记（见 `g2Verdict` 注释表）。
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
    // D7 要求：每个 LIVE 面必须携带三要素，且 collateralGate 是本文件内**实际执行并判红过**的判据名
    writer: 'resident-host-audit-sink',
    noiseClass: 'append-only（宿主逐 tick 追加，与被测路径无关）',
    collateralGate: 'D4 活宿主面归属对照',
  },
];
// D7：已真实执行并判红过的**归属兜底判据**登记表（名字 → 何处执行）
const LIVE_FACE_GATES = {
  'D4 活宿主面归属对照': 'D4 用例内 attributionVerdict([REAL_SINK_PROBE], ISOLATED).ok === false',
};
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
  if (!fs.existsSync(root)) return { root, exists: false, count: 0, sumBytes: 0, digest: 'absent', files: [] };
  const files = walkFiles(root);
  const h = crypto.createHash('sha256');
  let sum = 0;
  for (const f of files) {
    h.update(f.rel + '\u0000' + f.size + '\u0000' + f.mtimeMs + '\n');
    sum += f.size;
  }
  // files 仅用于**路径级 diff 与内容对照**（A3）；digest 口径保持 rel+size+mtimeMs 不变（AC-14）
  const withHash = files.map((f) => ({
    rel: f.rel, size: f.size, mtimeMs: f.mtimeMs,
    sha256: crypto.createHash('sha256').update(readIfExists(path.join(root, f.rel))).digest('hex'),
  }));
  return { root, exists: true, count: files.length, sumBytes: sum, digest: h.digest('hex'), files: withHash };
}

const snapshotReal = () => REAL_FACES.map((p) => fingerprint(p));
const listFiles = (root) => (fs.existsSync(root) ? walkFiles(root).map((f) => path.join(root, f.rel)) : []);
const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'punky-guard-' + tag + '-'));
const readIfExists = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// ── G2 三态判定（噪声治理：green / red / inconclusive{transient|unattributable}）──
// 规格 §方案 二；`settleMs` 默认 500ms、**恰 1 次**重取（禁循环重试到绿）。
const G2_SETTLE_MS = (() => {
  const raw = process.env.PUNKY_G2_SETTLE_MS;
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return 500;
  return Math.min(5000, Math.max(100, Math.floor(n)));
})();

/** 双模式：默认 strict（无消费者 ⇒ fail-closed）。report 必须显式给路径 + 消费者名，否则视为无效。 */
export function g2NoiseMode(env = process.env) {
  const raw = String(env.PUNKY_G2_NOISE ?? '').trim();
  const mode = raw === '' ? 'strict' : raw;
  if (mode !== 'strict' && mode !== 'report') return { mode: 'strict', invalid: true, raw };
  if (mode === 'report') {
    const reportPath = String(env.PUNKY_G2_NOISE_REPORT ?? '').trim();
    const consumer = String(env.PUNKY_G2_NOISE_CONSUMER ?? '').trim();
    if (!reportPath || !consumer) {
      return { mode, invalid: true, raw, missing: [!reportPath && 'PUNKY_G2_NOISE_REPORT', !consumer && 'PUNKY_G2_NOISE_CONSUMER'].filter(Boolean) };
    }
    return { mode, invalid: false, raw, reportPath, consumer };
  }
  return { mode, invalid: false, raw };
}

const sameFace = (x, y) => !!x && !!y && x.exists === y.exists && x.count === y.count && x.sumBytes === y.sumBytes && x.digest === y.digest;

/** 路径级 diff（added / removed / changed），供证据结构与归因使用。 */
export function faceDiff(before, after) {
  const b = new Map((before?.files ?? []).map((f) => [f.rel, f]));
  const a = new Map((after?.files ?? []).map((f) => [f.rel, f]));
  const added = [...a.keys()].filter((k) => !b.has(k)).sort();
  const removed = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && (b.get(k).sha256 !== a.get(k).sha256 || b.get(k).size !== a.get(k).size)).sort();
  return { added, removed, changed };
}

/**
 * 三态判定（纯函数）。
 * 判定顺序：green（四字段全等）→ transient（after2 == before）→ red（差异项 ∩ attributed ≠ ∅）→ unattributable。
 * 残量上界（规格 §三.3，如实写死，不得读作"已覆盖"）：
 *   · 已存在路径的字节覆盖且内容与同步产物相同 ⇒ 无法区分写者 ⇒ unattributable；
 *   · 已存在路径被删除且无自报 ⇒ 收敛则 transient，否则 unattributable；
 *   · 仅 mtime 变化而字节相同 ⇒ unattributable（cpSync 跨卷可能不保留 mtime）。
 */
export function g2Verdict({ face, before, after, after2, attributed = [] }) {
  const delta = faceDiff(before, after);
  const diffPaths = [...delta.added, ...delta.removed, ...delta.changed];
  if (sameFace(before, after)) {
    return { face, status: 'green', delta, diffPaths: [], evidence: { before, after, after2: after2 ?? null } };
  }
  if (after2 && sameFace(before, after2)) {
    return { face, status: 'inconclusive', subclass: 'transient', delta, diffPaths, reason: '差异在 settleMs 内收敛（并发 syncDir 的 rm+cp 中间态）', evidence: { before, after, after2 } };
  }
  const claimed = new Set((attributed ?? []).map((p) => String(p)));
  const hits = diffPaths.filter((p) => claimed.has(p));
  if (hits.length > 0) {
    return { face, status: 'red', delta, diffPaths, attributedHits: hits, reason: '差异持久且可归因于被测运行（差异项 ∩ 被测产物面 ≠ ∅）', evidence: { before, after, after2: after2 ?? null } };
  }
  return { face, status: 'inconclusive', subclass: 'unattributable', delta, diffPaths, reason: '差异持久且不可归因（外来写者的终态改动 / 写者不可区分）', evidence: { before, after, after2: after2 ?? null } };
}

/** 汇总：`passed` 唯一真源 = red===0 && inconclusive===0（规格 §方案 四.3）。 */
export function g2Summary(faceResults) {
  const rs = Array.isArray(faceResults) ? faceResults : [];
  const faces = rs.length;
  const green = rs.filter((r) => r.status === 'green').length;
  const red = rs.filter((r) => r.status === 'red').length;
  const inconclusive = rs.filter((r) => r.status === 'inconclusive').length;
  const transient = rs.filter((r) => r.subclass === 'transient').length;
  const unattributable = rs.filter((r) => r.subclass === 'unattributable').length;
  const passed = red === 0 && inconclusive === 0;
  const verdict = red > 0 ? 'red' : inconclusive > 0 ? 'inconclusive' : 'green';
  return { faces, green, red, inconclusive, transient, unattributable, passed, verdict, detail: rs };
}

/**
 * D7 谓词：每个 LIVE_FACE 必须三要素齐备，且 collateralGate 必须是**本文件内实际执行并判红过**的判据名；
 * 资产面移入 LIVE 面时还必须给 attributionFallback（否则沉默写失去兜底 ⇒ 等于删断言）。
 */
export function liveFaceJustified(faces, liveFaces, gates = LIVE_FACE_GATES) {
  const offenders = [];
  const realPaths = new Set((faces ?? []).map((p) => normPath(p)));
  for (const lf of liveFaces ?? []) {
    const p = lf?.path;
    if (!p) { offenders.push({ path: p, why: '缺 path' }); continue; }
    if (realPaths.has(normPath(p))) { offenders.push({ path: p, why: '同一面同时出现在 REAL_FACES（双向声明）' }); continue; }
    if (!lf.writer) offenders.push({ path: p, why: '缺 writer（写者未声明）' });
    if (!lf.noiseClass) offenders.push({ path: p, why: '缺 noiseClass（噪声类型未声明）' });
    if (!lf.collateralGate) offenders.push({ path: p, why: '缺 collateralGate（无归属兜底 = 删断言）' });
    else if (!(lf.collateralGate in (gates ?? {}))) offenders.push({ path: p, why: 'collateralGate 未实际执行过：' + lf.collateralGate });
    const isAssetFace = /[\\/]\.agents[\\/]skills$|[\\/]\.agent-presets$/.test(String(p));
    if (isAssetFace && !lf.attributionFallback) {
      offenders.push({ path: p, why: '资产面移入 LIVE 面但未给 attributionFallback（沉默写失去唯一结果面兜底）' });
    }
  }
  return { ok: offenders.length === 0, offenders };
}

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } };
/** 终态稳定化：等 settleMs 后**重取一次**（禁循环）。 */
const refingerprint = (face) => { sleepSync(G2_SETTLE_MS); return fingerprint(face); };

/**
 * **两条路径共用的单点判定**（AC-15 的实现基础）：
 * 差异未收敛时由**当前进程**自行 sleep+重取一次 after2（真实面父进程可读，不必依赖子进程回报），
 * 并把归因集合一并传入 ⇒ transient / red 在**两条路径上都可达**。
 * （修复前子进程路径写死 `after2 = after`、`attributed = []` ⇒ transient 与 red 在该路径恒不可达。）
 */
export function evalFace({ face, before, after, attributed = [] }) {
  const after2 = sameFace(before, after) ? after : refingerprint(face);
  return g2Verdict({ face, before, after, after2, attributed });
}

/** 子进程回报的隔离根文件清单 → 相对路径集合（A1）；父进程据此给出带 face 归属的相对路径。 */
function relSet(files, root) {
  const out = new Set();
  for (const f of files ?? []) {
    const rel = path.relative(root, String(f));
    if (rel && !rel.startsWith('..')) out.add(rel);
  }
  return out;
}

/** 写入**指定相对路径**的文件（供“窗口内先消失后恢复”的受控构造使用）。 */
function writeRelFile(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

/** 可归因集合（A1∪A3 简化）：隔离根内出现过的**同相对路径**即视为被测产物面落点候选。 */
function attributedRels(st) {
  return [...new Set((st.isolatedAfter?.files ?? []).map((f) => f.rel))];
}

/** 汇总行（机器可解析，规格 §方案 二.4）。 */
export function formatG2Summary(sum) {
  const head = `[G2] faces=${sum.faces} green=${sum.green} red=${sum.red} inconclusive=${sum.inconclusive} transient=${sum.transient} unattributable=${sum.unattributable}`;
  const detail = sum.detail.map((r) => {
    const st = r.status === 'inconclusive' ? `inconclusive(${r.subclass})` : r.status;
    const d = r.diffPaths?.length ? ` diff=${JSON.stringify(r.diffPaths)}` : '';
    return `  detail: ${r.face} = ${st}${d}`;
  });
  return [head, ...detail].join('\n');
}

/** 汇总 → 出口：strict 下 inconclusive/red ⇒ 判红；report 下写报告 + diagnostic，但 passed 不得改真。 */
function emitAndGate(results, ctx = {}) {
  const sum = g2Summary(results);
  process.stderr.write(formatG2Summary(sum) + '\n');
  const noise = g2NoiseMode();
  if (noise.mode === 'report') {
    if (noise.invalid) {
      assert.fail('[G2] report 模式缺消费者（' + (noise.missing ?? ['非法取值']).join(' / ') + '）⇒ 退化为静默绿，拒绝');
    }
    try {
      fs.appendFileSync(noise.reportPath, JSON.stringify({ ts: new Date().toISOString(), consumer: noise.consumer, ...sum, detail: undefined }) + '\n', 'utf8');
    } catch (e) {
      assert.fail('[G2] report 模式报告写入失败 ⇒ 拒绝静默（' + e.message + '）');
    }
    return sum;
  }
  if (sum.red > 0) assert.fail('[G2] red（真实面发生了可归因于被测运行的持久变化）\n' + formatG2Summary(sum));
  if (sum.inconclusive > 0) {
    assert.fail('[G2] inconclusive(strict)：差异既非可归因的持久变化、也非可收敛的中间态；无消费者时 fail-closed\n' + formatG2Summary(sum));
  }
  return sum;
}

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
    // 子进程路径同样由**父进程**自行 settle 重取 after2 + 接 A1 归因
    // （真实面在父进程可读；修复前 after2/attributed 写死 ⇒ transient/red 恒不可达 = 实际 flake 路径上的漏洞）
    const childRels = relSet(m.report?.writtenFiles, m.report?.sentinel);
    const g2Results = REAL_FACES.map((face, i) => evalFace({
      face,
      before: m.realBefore[i],
      after: m.realAfter[i],
      attributed: [...childRels],
    }));
    emitAndGate(g2Results);
    // 活宿主面不参与上面的「零变化」断言（宿主持续追写该面）；改用归属对照 + 断言面自检
    // （D4 已就同一谓词/同一自检给出判别力演示）。
    assert.equal(attributionVerdict([REAL_SINK_PROBE], m.report.sentinel).ok, false,
      '对照组：真实 <home>/.dsh/logs 落点必须被判越界（活宿主面退出状态断言）');
    assert.equal(liveFaceExcluded(REAL_FACES).ok, true,
      '「零变化」断言面不得包含活宿主面：' + JSON.stringify(liveFaceExcluded(REAL_FACES).offenders));
    return;
  }
  assert.ok(state.applied, '被测路径已执行（G1 不成立时本用例由前置闸阻断）');
  // 三态判定（规格 §方案 二）：差异时**恰 1 次** settleMs 重取；不 bail，一次收全四字段证据
  const attributed = attributedRels(state);
  const g2Results = REAL_FACES.map((face, i) => evalFace({
    face,
    before: state.realBefore[i],
    after: state.realAfter[i],
    attributed,
  }));
  emitAndGate(g2Results);
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
  assert.equal(fs.existsSync(path.join(presetDir, 'punky-preset')), true, '预设资产落在隔离根内');
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
const preset = path.join(sentinel, '.dsh', '.agent-presets', 'punky-preset');
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

// ── D5 反向自检：可归因的持久越界写必须判 red（不得降级为 inconclusive）──
// 规格 §方案 五.2 D5 / AC-2。构造沿用 D3 口径（受控临时目录，不触真实面）。

test('D5 判别力（该红必红）：可归因 + 持久的真实面变化必须判 red', () => {
  const dir = tmpRoot('d5');
  try {
    const face = path.join(dir, 'face');
    fs.mkdirSync(face, { recursive: true });
    const before = fingerprint(face);                       // 空面
    fs.writeFileSync(path.join(face, 'leaked.txt'), 'x');   // 模拟被测越界写
    const after = fingerprint(face);

    const attributed = g2Verdict({ face, before, after, after2: after, attributed: ['leaked.txt'] });
    assert.equal(attributed.status, 'red',
      '差异持久且可归因 ⇒ 必须 red（若返回 inconclusive 即为「把该红判成 inconclusive」）实测=' + attributed.status);
    assert.deepEqual(attributed.delta.added, ['leaked.txt'], '证据须点名新增的相对路径');
    assert.deepEqual(attributed.attributedHits, ['leaked.txt'], '须点名归因命中项');

    // 对照组：同一证据、不给归因 ⇒ 只能是 inconclusive（证明归因是 red 的必要条件）
    const unverifiable = g2Verdict({ face, before, after, after2: after, attributed: [] });
    assert.equal(unverifiable.status, 'inconclusive', '不可归因时不得判 red');
    assert.equal(unverifiable.subclass, 'unattributable');

    // 对照组：差异收敛 ⇒ transient（不得 red）
    const converged = g2Verdict({ face, before, after, after2: before, attributed: ['leaked.txt'] });
    assert.equal(converged.status, 'inconclusive', '收敛的差异不得判 red（即使可归因）');
    assert.equal(converged.subclass, 'transient');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── D6 反向自检：inconclusive 不得变绿、不得计入通过 ──
// 规格 §方案 五.2 D6 / AC-3、AC-5、AC-6、AC-7。

const mkFace = (count) => ({
  exists: true, count, sumBytes: count * 10, digest: 'digest-' + count,
  files: Array.from({ length: count }, (_, i) => ({ rel: 'f' + i, size: 10, mtimeMs: 1, sha256: 'h' + i })),
});

test('D6 判别力（不得变绿）：不可归因的持久差异 ⇒ inconclusive{unattributable} 且 passed=false', () => {
  const before = mkFace(11);
  const after = mkFace(10);
  const after2 = mkFace(10);
  const v = g2Verdict({ face: 'face-x', before, after, after2, attributed: [] });
  assert.equal(v.status, 'inconclusive', '不得 green、不得 red');
  assert.equal(v.subclass, 'unattributable', '持久且不可归因 ⇒ unattributable');
  assert.deepEqual(v.delta.removed, ['f10'], '证据须点名消失的相对路径（= 那次 10 !== 11 的形态）');

  const sum = g2Summary([v]);
  assert.equal(sum.passed, false, 'inconclusive ⇒ passed 必须 false（唯一真源 red===0 && inconclusive===0）');
  assert.equal(sum.conclusive ?? sum.verdict, 'inconclusive');

  // 错误实现自检：把 passed 写成 true 的实现必须与真源不一致（⇒ 该实现会被判违法）
  const wrongSummary = (rs) => ({ ...g2Summary(rs), passed: true });
  assert.equal(wrongSummary([v]).passed, true);
  assert.notDeepEqual(wrongSummary([v]), g2Summary([v]), '把 inconclusive 计入通过的实现必须判红');

  // 守恒式（AC-5）：faces = green + red + inconclusive；inconclusive = transient + unattributable
  const mixed = g2Summary([
    { status: 'green' },
    { status: 'red' },
    { status: 'inconclusive', subclass: 'transient' },
    { status: 'inconclusive', subclass: 'unattributable' },
  ]);
  assert.equal(mixed.faces, mixed.green + mixed.red + mixed.inconclusive, 'faces 守恒');
  assert.equal(mixed.inconclusive, mixed.transient + mixed.unattributable, '子类守恒');
  assert.equal(mixed.passed, false);
});

test('D6b 双模 fail-closed：默认 strict；report 缺消费者 ⇒ 无效（不得静默绿）', () => {
  assert.equal(g2NoiseMode({}).mode, 'strict', '不设环境变量时必须是 strict');
  assert.equal(g2NoiseMode({ PUNKY_G2_NOISE: 'strict' }).mode, 'strict');
  const noReport = g2NoiseMode({ PUNKY_G2_NOISE: 'report' });
  assert.equal(noReport.invalid, true, 'report 缺路径/消费者 ⇒ 无效');
  assert.equal(g2NoiseMode({ PUNKY_G2_NOISE: 'report', PUNKY_G2_NOISE_REPORT: '/tmp/x.jsonl' }).invalid, true, '缺消费者名 ⇒ 无效');
  const ok = g2NoiseMode({ PUNKY_G2_NOISE: 'report', PUNKY_G2_NOISE_REPORT: '/tmp/x.jsonl', PUNKY_G2_NOISE_CONSUMER: 'test-evidence-guard' });
  assert.equal(ok.invalid, false, '路径 + 消费者名齐备 ⇒ 有效');
  assert.equal(g2NoiseMode({ PUNKY_G2_NOISE: 'bogus' }).invalid, true, '非法取值 ⇒ 回落 strict 并标无效');
});

// ── D7 反向自检：不该排除的面被排除必须被抓 ──
// 规格 §方案 五.2 D7 / AC-4。

test('D7 判别力（不该排除的面被抓）：LIVE 面三要素 + 已执行兜底判据 + 资产面无兜底必红', () => {
  // 形如资产面但**不在** REAL_FACES（避免与「双向声明」分支混淆）；真实资产面另作一条构造
  const assetLike = path.join(os.tmpdir(), 'punky-d7-asset', '.agent-presets');
  const realAsset = REAL_FACES.find((p) => p.endsWith('.agent-presets')) ?? REAL_FACES[0];
  const gates = { 'D4 活宿主面归属对照': 'x' };

  assert.equal(liveFaceJustified(REAL_FACES, LIVE_FACES).ok, true,
    '现行 LIVE_FACES 应三要素齐备且 collateralGate 已实际执行过：'
    + JSON.stringify(liveFaceJustified(REAL_FACES, LIVE_FACES).offenders));

  // ② 无 justification（= 三要素全缺）
  const missing = liveFaceJustified(REAL_FACES, [{ path: assetLike }], gates);
  assert.equal(missing.ok, false, '无 justification 的 LIVE 面必须判红');
  assert.ok(missing.offenders.some((o) => /缺 writer/.test(o.why)));

  // ③ 假 collateralGate（未实际执行过的判据名）
  const fakeGate = liveFaceJustified(REAL_FACES, [{ path: path.join(REAL_HOME, '.dsh', 'logs2'), writer: 'w', noiseClass: 'n', collateralGate: '不存在的判据名' }], gates);
  assert.equal(fakeGate.ok, false, 'collateralGate 未实际执行过 ⇒ 必须判红');

  // ④ 资产面塞进 LIVE 面但无归属兜底（直接约束路线 A 的降级动作）
  const noFallback = liveFaceJustified(REAL_FACES, [{ path: assetLike, writer: 'w', noiseClass: 'n', collateralGate: 'D4 活宿主面归属对照' }], gates);
  assert.equal(noFallback.ok, false, '资产面无 attributionFallback ⇒ 必须判红（沉默写失去唯一结果面兜底）');

  // ⑤ 对照组：资产面带 attributionFallback 才允许（且仍需三要素齐备）
  const withFallback = liveFaceJustified(REAL_FACES, [{
    path: assetLike, writer: 'w', noiseClass: 'n',
    collateralGate: 'D4 活宿主面归属对照', attributionFallback: 'D4 形态：真实面落点喂 attributionVerdict 必判红',
  }], gates);
  assert.equal(withFallback.ok, true, '三要素 + 归属兜底齐备时才允许排除');

  // ⑥ 真实资产面直接塞进 LIVE_FACES（与 REAL_FACES 双向声明）⇒ 必须判红
  const doubled = liveFaceJustified(REAL_FACES, [{ path: realAsset, writer: 'w', noiseClass: 'n', collateralGate: 'D4 活宿主面归属对照', attributionFallback: 'x' }], gates);
  assert.equal(doubled.ok, false, '同一面同时出现在 REAL 与 LIVE ⇒ 必须判红（双向声明）');
  assert.ok(doubled.offenders.some((o) => /双向声明/.test(o.why)), '须给出双向声明的原因');
});

// ── D8 反向自检（回修）：子进程路径上 transient / red 必须**可达**，两条路径同一输入给同一结论 ──
// 背景：修复前子进程路径写死 `after2 = after` 与 `attributed = []`，而该路径正是并行跑时实际 flaky 的那条
// （无 preload ⇒ ISOLATED 假 ⇒ 走 mechanismRun 分支）⇒ 两条判据在该路径上恒不可达。现两路径共用 `evalFace`。

test('D8 子进程路径可达性：transient 可吸收、red 可判出、两路径同输入同结论', () => {
  const dir = tmpRoot('d8');
  try {
    // ① transient：受控面「窗口内先消失后恢复」
    const faceA = path.join(dir, 'face-transient');
    writeRelFile(faceA, 'keep.txt', 'v1');
    const beforeA = fingerprint(faceA);
    // 用 rename 移走/移回：mtime + 字节逐字不变 —— 等价于 syncDir 的 cpSync({preserveTimestamps:true}) 完成态。
    // （注意：不能"删除后重写版本"来恢复：指纹含 mtimeMs（AC-14），重写会改 mtime ⇒ after2 恒不等于 before。）
    fs.renameSync(path.join(faceA, 'keep.txt'), path.join(faceA, 'keep.txt.away')); // 模拟 rmSync 阶段（文件瞬时不见）
    const afterA = fingerprint(faceA);
    fs.renameSync(path.join(faceA, 'keep.txt.away'), path.join(faceA, 'keep.txt')); // 模拟 cpSync 完成（mtime 保留）
    const vA = evalFace({ face: faceA, before: beforeA, after: afterA, attributed: ['keep.txt'] });
    assert.equal(vA.status, 'inconclusive', '子进程路径口径：先消失后恢复 ⇒ 不得 red；实测 ' + vA.status);
    assert.equal(vA.subclass, 'transient', '必须判为 transient（settleMs 后收敛）；实测 ' + vA.subclass);
    assert.equal(g2Summary([vA]).passed, false, 'transient 不计入通过');

    // ② red：受控面「持久越界写 + 可归因」
    const faceB = path.join(dir, 'face-red');
    fs.mkdirSync(faceB, { recursive: true });
    const beforeB = fingerprint(faceB);
    writeRelFile(faceB, 'leaked.txt', 'x');
    const afterB = fingerprint(faceB);
    const vB = evalFace({ face: faceB, before: beforeB, after: afterB, attributed: ['leaked.txt'] });
    assert.equal(vB.status, 'red', '子进程路径口径：持久 + 可归因 ⇒ 必须 red（修复前此处恒为 inconclusive）；实测 ' + vB.status);
    assert.deepEqual(vB.attributedHits, ['leaked.txt']);

    // ③ 两路径一致性：同一输入喂两次（现在两路径共用 evalFace）⇒ 结论逐字相同
    const vB2 = evalFace({ face: faceB, before: beforeB, after: afterB, attributed: ['leaked.txt'] });
    assert.deepEqual(
      { status: vB2.status, subclass: vB2.subclass ?? null, diffPaths: vB2.diffPaths },
      { status: vB.status, subclass: vB.subclass ?? null, diffPaths: vB.diffPaths },
      '同一输入 ⇒ status/subclass/diffPaths 逐字一致',
    );

    // ④ 缺陷可见性：**修复前形态**（after2 = after、attributed = []）对同一输入给不同结论
    const legacySubprocessShape = g2Verdict({ face: faceB, before: beforeB, after: afterB, after2: afterB, attributed: [] });
    assert.equal(legacySubprocessShape.status, 'inconclusive',
      '修复前子进程路径对「持久可归因」也只能 inconclusive ⇒ 证明 red 原不可达');
    assert.notEqual(legacySubprocessShape.status, vB.status, '新旧形态结论必须不同（缺陷可见）');

    // 修复前的子进程形态 = after2 取 after **且** attributed 恒为 []（两个缺陷一并还原）
    const legacyTransientShape = g2Verdict({ face: faceA, before: beforeA, after: afterA, after2: afterA, attributed: [] });
    process.stderr.write('[D8] transient=' + vA.status + '/' + vA.subclass + ' red=' + vB.status + ' sameInputSameVerdict=' + (vB2.status === vB.status && (vB2.subclass ?? null) === (vB.subclass ?? null)) + ' legacy=' + legacySubprocessShape.status + '/' + (legacySubprocessShape.subclass ?? null) + String.fromCharCode(10));
    assert.equal(legacyTransientShape.status, 'inconclusive');
    assert.notEqual(legacyTransientShape.subclass, 'transient',
      '修复前子进程路径把「可收敛的中间态」也判成 unattributable ⇒ 证明 transient 原不可达');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
