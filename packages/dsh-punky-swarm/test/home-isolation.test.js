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
import { MANIFEST_REL } from '../lib/assets.js';
// ── 【p2-idle-window · 乙裁决】隔离判据谓词的**单点定义**在 `test/helpers/verdicts.mjs`（跨文件单点）──
//   四谓词（`g1Verdict` / `attributionVerdict` / `faceDiff` / `g2Verdict`）＋三个依赖
//   （`normPath` / `sameFace` / `toPosix`）全部从那里导入 ⇒ 本文件内**零定义**。
//   ⚠ `liveFaceExcluded` 仍在本文件内，它用 `normPath` —— 靠本行导入即可工作。
import { normPath, sameFace, toPosix, g1Verdict, attributionVerdict, faceDiff, g2Verdict } from './helpers/verdicts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const PRELOAD = path.join(HERE, 'helpers', 'isolated-home.preload.mjs');
const INDEX_URL = new URL('../lib/index.js', import.meta.url).href;
const GUARD_URL = import.meta.url;
const ISOLATED = (process.env.PUNKY_TEST_ISOLATED_HOME ?? '').trim();
const DEMO_CHILD = process.env.PUNKY_ISOLATION_DEMO_CHILD === '1';
// 真实 home 真源：os.userInfo() 走系统账户 API，preload 改写的 USERPROFILE/HOME 影响不到它。
const REAL_HOME = os.userInfo().homedir;

// 真实面上的**被测算面**（REAL_FACES）：只保留「仅被测代码会写 + 内容幂等」的面。
//
// 【p3-migrate · 2026-11-01】面集变更（FU-2 迁移 + FU1-4 引擎根纳入）：
//   · `~/.agents/skills` **迁出** → LIVE_FACES：实测 hot（rv-adversarial FU-2：max mtime 自行前进），
//     把它留在「零变化」断言面里等于把**外部写者**的合法写入读成本方泄漏（结构性假红）。
//   · `~/.dsh/punky-preset`（真实引擎根）**纳入** → LIVE_FACES（本插件最大最敏感的写面，此前零覆盖）。
//   · `~/.dsh/.agent-presets` **保留**在 REAL_FACES —— 这不是遗漏，而是**防真空锚点**：
//       ① 其**唯一写者**是本插件 `syncAssets()`（manifest 见 `lib/assets.js:34` 与 `:45-53` 的 `root: 'preset'` 项）；
//       ② 同步内容**幂等**，且 `p0-digest` 已把 digest 改为 **sha256 内容口径**（去 mtime）⇒「零变化」是可满足的不变量；
//       ③ 若把两面全迁出，REAL_FACES = [] ⇒ G2 的 `REAL_FACES.map(...)` 产出空数组 ⇒ **断言恒真、测试体面消失**。
//          `P3-a` 用例把「非空」做成**可达红**判据（见文件末尾 p3 段），不靠注释自证。
//   活宿主面一律见 LIVE_FACES（结构性排除，不在此列）；两向重复声明由 D7（`:265 liveFaceJustified`）判红。
const REAL_FACES = [
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
  // ── 【p3-migrate · FU-2】技能资产面迁入 LIVE（实测 hot：max mtime 自行前进）──
  {
    path: path.join(REAL_HOME, '.agents', 'skills'),
    reason: '技能资产根：实测 hot（rv-adversarial FU-2：max mtime 自行前进）；留在「零变化」断言面会把外部写者的合法写入读成本方泄漏',
    writer: 'resident-host-syncAssets + 外部安装器（rv-adversarial FU-2 实测 mtime 前进）',
    noiseClass: 'mtime 前进 / 内容可能被同源重写（非本测试可观测面）',
    collateralGate: 'D4 活宿主面归属对照',
    // D7 硬要求：资产面进 LIVE 必须给归属兜底，否则「沉默写」失去唯一结果面兜底 = 删断言
    attributionFallback: 'G3 自报落点归属 + I1/I2 写入拦截（目标 realpath ⊆ 隔离根，越界即记录；删除型亦可抓）',
  },
  // ── 【p3-migrate · FU1-4】真实引擎根纳入（本插件最大最敏感的写面，此前零覆盖）──
  {
    path: path.join(REAL_HOME, '.dsh', 'punky-preset'),
    reason: '真实引擎根：store（batches/sessions/mailbox/locks）由常驻宿主与本插件共同持续写 ⇒ 无法做「零变化」断言，但**必须有归属兜底**（此前零覆盖）',
    writer: 'punky-swarm engine (store/sessions/mailbox/locks) + resident host',
    noiseClass: 'append+rewrite+delete（sessions 持续增长、batches 重写、locks 增删）',
    collateralGate: 'P3-b 引擎根写入拦截探针',
  },
];
// D7：已真实执行并判红过的**归属兜底判据**登记表（名字 → 何处执行）
const LIVE_FACE_GATES = {
  'D4 活宿主面归属对照': 'D4 用例内 attributionVerdict([REAL_SINK_PROBE], ISOLATED).ok === false',
  'P3-b 引擎根写入拦截探针': 'P3-b 用例内：throw 模式子进程写真实引擎根 ⇒ intercept 报告 violations 含 resolvedPath 落在引擎根下，且真实文件不存在（拦截先于落盘）',
};

// 真实引擎根（p3 探针用；与 LIVE_FACES 项同源，避免第二处硬编码）
const REAL_ENGINE_ROOT = path.join(REAL_HOME, '.dsh', 'punky-preset');
// 真实面 sink 落点样本：喂给归属谓词做「真实面必须判越界」的确定性对照（不触碰该文件）。
const REAL_SINK_PROBE = path.join(LIVE_FACES[0].path, 'punky-swarm', 'audit-probe.jsonl');

// ── 谓词（纯函数，供判别力自证直接调用）──

// ── 【p2-idle-window · 乙裁决】隔离判据谓词已**外移**到 `test/helpers/verdicts.mjs`（跨文件单点定义）──
//   移出：`normPath` / `g1Verdict` / `attributionVerdict` / `sameFace` / `toPosix` / `faceDiff` / `g2Verdict`
//   依赖一并搬出并由本文件**导入回来**（不做第二份副本，否则「单点」变成两份）。
//   导出名与签名一字未改 ⇒ 本文件所有调用点零改动（含 `liveFaceExcluded`，它用 `normPath`）。


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

/**
 * 文件级指纹。
 *
 * **digest 口径 = `rel + size + sha256`（内容口径，FU1-2 修复）** —— **不含 `mtimeMs`**。
 *   为什么改：本文件的 `faceDiff`（下方）一直只比 `sha256` / `size`，而 digest 却含 mtime ⇒ **两套口径并存**。
 *   后果是**幂等重同步**（内容逐字全同、只有 mtime 变）也让 `sameFace` 判假 ⇒ 落到归因分支 ⇒ 假泄漏/不确定。
 *   `mtimeMs` 仍保留在 `files[]` 里供**证据展示**，但**不进 digest**（它是「何时写的」，不是「写了什么」）。
 *
 * ⚠ 旧注释所称「digest 口径保持 rel+size+mtimeMs 不变（AC-14）」**已作废**：AC-14 随之改为内容口径。
 */
export function fingerprint(root) {
  if (!fs.existsSync(root)) return { root, exists: false, count: 0, sumBytes: 0, digest: 'absent', files: [] };
  const files = walkFiles(root);
  const h = crypto.createHash('sha256');
  let sum = 0;
  const withHash = files.map((f) => {
    const sha256 = crypto.createHash('sha256').update(readIfExists(path.join(root, f.rel))).digest('hex');
    h.update(f.rel + '\u0000' + f.size + '\u0000' + sha256 + '\n');
    sum += f.size;
    return { rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, sha256 };
  });
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

// （`sameFace` / `toPosix` / `faceDiff` 已随四谓词外移到 `test/helpers/verdicts.mjs`，由本文件导入。）

// （`g2Verdict` 三态判定的**唯一实现**已外移到 `test/helpers/verdicts.mjs`，由本文件导入。）

/** 汇总：`passed` 唯一真源 = red===0 && inconclusive===0（规格 §方案 四.3）。 */
export function g2Summary(faceResults) {
  const rs = Array.isArray(faceResults) ? faceResults : [];
  const faces = rs.length;
  const green = rs.filter((r) => r.status === 'green').length;
  const red = rs.filter((r) => r.status === 'red').length;
  const inconclusive = rs.filter((r) => r.status === 'inconclusive').length;
  const transient = rs.filter((r) => r.subclass === 'transient').length;
  const unattributable = rs.filter((r) => r.subclass === 'unattributable').length;
  // unmatched **真聚合**：逐面取 attribution.unmatched.length 求和。
  // （反面教材：`sum.__unmatched ?? 0` —— 该字段根本不存在 ⇒ 恒 0 ⇒ 让人误以为"永远没有未命中"。）
  const unmatched = rs.reduce((n, r) => n + (r?.attribution?.unmatched?.length ?? 0), 0);
  // 四通道齐平（RES-1）：`unresolved` 恰是这条链最初要"不许静默"的通道，此前**没有汇总位**；
  // `hits` 同样只在 detail 里可见。两者都按上面 same-source reduce 聚合（**不得**写 `sum.__xxx ?? 0` 式假字段）。
  const unresolved = rs.reduce((n, r) => n + (r?.attribution?.unresolved?.length ?? 0), 0);
  const hits = rs.reduce((n, r) => n + (r?.attribution?.hits?.length ?? 0), 0);
  const passed = red === 0 && inconclusive === 0;
  const verdict = red > 0 ? 'red' : inconclusive > 0 ? 'inconclusive' : 'green';
  return { faces, green, red, inconclusive, transient, unattributable, unmatched, unresolved, hits, passed, verdict, detail: rs };
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
export function evalFace({ face, before, after, attributed = [], faceMap = null }) {
  const after2 = sameFace(before, after) ? after : refingerprint(face);
  return g2Verdict({ face, before, after, after2, attributed, faceMap });
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

/**
 * 资产落点映射（**manifest 驱动，粒度 = 目录级前缀**；不使用 startsWith('skills') 这类猜法）。
 * 真源：`lib/assets.js` 的清单条目 `{ rel, target: { root, subpath } }`（只读该 JSON，不改被测代码）。
 * 形如 `presets/punky-preset → preset/punky-preset` 被正确映为 `.dsh/.agent-presets/punky-preset/...`，
 * 而不再被错映成 `.agent-presets/presets/punky-preset`。
 */
export const FACE_ROOT_REL = { preset: '.dsh/.agent-presets', skill: '.agents/skills' };
let _assetMap = null;
export function assetMap() {
  if (_assetMap) return _assetMap;
  const raw = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, MANIFEST_REL), 'utf8'));
  _assetMap = (raw.assets ?? []).map((a) => ({
    rel: a.rel,
    root: a.target?.root,
    subpath: a.target?.subpath,
    faceRootRel: FACE_ROOT_REL[a.target?.root] ?? null,
    targetPrefixRel: [FACE_ROOT_REL[a.target?.root], a.target?.subpath].filter(Boolean).join('/'),
  }));
  return _assetMap;
}

/** 隔离根相对 → 面相对（A1/A3 的键空间转换）；映射不到返回 null。 */
export function isoRelToFace(isoRel) {
  const norm = toPosix(isoRel);
  // 语义修正（D9-b 抓到）：**面内路径要保留 subpath**。
  // `.dsh/.agent-presets/punky-preset/agent.cordis.yml` 的面相对键是 `punky-preset/agent.cordis.yml`
  // （面根 = `.dsh/.agent-presets`），不是 `agent.cordis.yml`。
  // manifest 在此只决定「这条 iso 路径落在哪个面 + 是否属已知资产」，不参与面内路径切分。
  // 取**最长 targetPrefix** 判归属（防「面根级」条目抢先匹配）。
  let best = null;
  for (const a of assetMap()) {
    if (!a.targetPrefixRel) continue;
    if (!(norm === a.targetPrefixRel || norm.startsWith(a.targetPrefixRel + '/'))) continue;
    if (!best || a.targetPrefixRel.length > best.targetPrefixRel.length) best = a;
  }
  if (!best) return null;
  const faceRoot = toPosix(best.faceRootRel);
  if (norm === faceRoot) return { faceRootRel: best.faceRootRel, rel: '' };
  if (!norm.startsWith(faceRoot + '/')) return null;
  return { faceRootRel: best.faceRootRel, rel: norm.slice(faceRoot.length + 1) };
}
/** 面相对 → 隔离根相对（A3 内容对照用）：隔离 home 与真实 home 同形 ⇒ 仅前置面根。
 *  仍要求该 rel 落在**已知资产**的 subpath 下（否则不是被测同步产物，不参与归因）。 */
export function faceRelToIso(faceRootRel, faceRel) {
  const root = toPosix(faceRootRel);
  const rel = toPosix(faceRel);
  const known = assetMap().some((a) => toPosix(a.faceRootRel) === root && a.subpath && rel.startsWith(a.subpath + '/'));
  if (!known) return null;
  return root + '/' + rel;
}

/**
 * 归因集合构建（A1 ∪ A3）。**两者都输出面相对键 + 来源标注**。
 *  A1 = 隔离根内出现过的文件（经 manifest 映射到面相对）；
 *  A3 = 差异项的内容与隔离根**同路径逐字相同**（sha256 相等）—— 第二个真实来源。
 * 注：A2 按裁决**不接**（生产路径 A2 ⊆ A1，无独立增益；见 D9-b）。
 */
export function buildAttribution({ isoFiles = [], faceRootRel, faceDelta }) {
  const root = toPosix(faceRootRel);
  const entries = [];
  for (const f of isoFiles) {
    // ⚠ A1 = **全量存在性枚举**：不区分 added / changed / **removed**（判据对三种差异同形生效）。
    //   ⇒ 「真实面丢 X ∧ 隔离根有 X ⇒ red」与 A1 的定义**逐字同义**，无需额外分支（判据已存在，D14 钉住它）。
    //   重构警告：若把此处收窄成「只处理 added/changed」，red 分支会静默消失 —— D14-a 就是为此设的红线。
    const m = isoRelToFace(f.rel);
    if (m && toPosix(m.faceRootRel) === root && m.rel) entries.push({ kind: 'faceRel', rel: m.rel, source: 'A1' });
  }
  // A3：内容同路径逐字相同（只有 added/changed 可做内容对照；removed 无内容）
  const isoByRel = new Map(isoFiles.map((f) => [toPosix(f.rel), f]));
  for (const rel of [...(faceDelta?.added ?? []), ...(faceDelta?.changed ?? [])]) {
    const isoRel = faceRelToIso(faceRootRel, rel);
    if (!isoRel) continue;
    const isoFile = isoByRel.get(toPosix(isoRel));
    if (!isoFile || !isoFile.sha256) continue;
    // 键空间统一到 posix：faceDelta 的 rel 来自 walkFiles（Windows 下是反斜杠），不归一化会比不中
    entries.push({ kind: 'faceRel', rel: toPosix(rel), source: 'A3', sha256: isoFile.sha256 });
  }
  const uniq = [];
  const seen = new Set();
  for (const e of entries) {
    const k = e.rel + '|' + e.source;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
  }
  return uniq;
}

/**
 * D3 面级 backstop 的三档判定（**纯谓词**）。
 *
 * 判定顺序唯一（不许重排）：
 *   ① `ourRelSet` 不可用 ⇒ `unknown-red`（fail-closed：不得当成"真实面没变化"）
 *   ② 逐面 `faceDiff` ⇒ changed = added ∪ removed ∪ changed（已 posix，键 = 面根 + '|' + rel）
 *   ③ 全面无变化 ⇒ `green`（**归属判据仍是必要条件**，由调用方同时核：claimed 零写 + 每条 actual 越界）
 *   ④ 有变化：hit = changed ∩ ourRelSet
 *        hit ≠ ∅ ⇒ `leak-red`（我方产物出现在真实面 = 强证据）
 *        hit = ∅ ⇒ `foreign-red`（变化项全在我方产物之外 = 第三方；消息点名"不可归因于本演示"）
 *
 * ⚠ **签名刻意只有 { before, after, ourRelSet }** —— 不含任何时间/重试/阈值参数，
 *   ⇒ "再取一次就放过""变化幅度小于阈值就容忍"这两类吸收**结构上不可能**实现。
 *   这是结构性约束，不靠实现者自觉（审计可 grep 签名核验）。
 */
export function d3RealFaceVerdict({ before, after, ourRelSet }) {
  if (!(ourRelSet instanceof Set)) {
    return { status: 'unknown-red', faces: [], changed: [], hits: [], message: 'ourRelSet 不可用（fail-closed）：不得当成「真实面没变化」' };
  }
  const n = Math.max(before?.length ?? 0, after?.length ?? 0);
  const faces = [];
  const changed = [];
  for (let i = 0; i < n; i++) {
    const root = before?.[i]?.root ?? after?.[i]?.root ?? REAL_FACES[i];
    const faceRoot = toPosix(path.relative(REAL_HOME, String(root)));
    const d = faceDiff(before?.[i], after?.[i]);
    const rels = [...d.added, ...d.removed, ...d.changed].map((r) => toPosix(String(r)));
    faces.push({ faceRoot, root: String(root), changedCount: rels.length });
    for (const rel of rels) changed.push({ faceRoot, rel, key: faceRoot + '|' + rel });
  }
  if (changed.length === 0) {
    return { status: 'green', faces, changed: [], hits: [], message: '真实面逐面零变化（面级 backstop 生效；归属判据为必要条件，由调用方同时核）' };
  }
  const hits = changed.filter((c) => ourRelSet.has(c.key));
  if (hits.length > 0) {
    return {
      status: 'leak-red', faces, changed, hits,
      message: '我方产物出现在真实面（强证据，不可放过）：' + hits.map((c) => c.faceRoot + '/' + c.rel).join(', '),
    };
  }
  return {
    status: 'foreign-red', faces, changed, hits: [],
    message: 'foreign：真实面变化项**全在我方产物之外**，不可归因于本演示（第三方写）；差异项：'
      + changed.map((c) => c.faceRoot + '/' + c.rel).join(', '),
  };
}

/** 我方产物面相对键集合：`writtenUnderActual` → 隔离根相对 → `isoRelToFace`（manifest 驱动、最长前缀）→ 面相对键。 */
function d3OurRelSet(report, actualRoot) {
  try {
    const keys = new Set();
    for (const p of report?.writtenUnderActual ?? []) {
      const isoRel = path.relative(actualRoot, String(p));
      if (!isoRel || isoRel.startsWith('..')) continue;
      const m = isoRelToFace(isoRel);
      if (m && m.rel) keys.add(toPosix(m.faceRootRel) + '|' + toPosix(m.rel));
    }
    return keys;
  } catch {
    return null;   // 不可用 ⇒ 谓词走 unknown-red（fail-closed）
  }
}

/** 汇总行（机器可解析，规格 §方案 二.4）。 */
export function formatG2Summary(sum) {
  const head = `[G2] faces=${sum.faces} green=${sum.green} red=${sum.red} inconclusive=${sum.inconclusive} transient=${sum.transient} unattributable=${sum.unattributable} unmatched=${sum.unmatched ?? 0} unresolved=${sum.unresolved ?? 0} hits=${sum.hits ?? 0}`;
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
  // 【2026-10-31 遗留收口 · 补宿主契约桩】`apply` 自 G1 declare 批起在装配末尾执行
  //   `assertRequired(capabilityReport(...))`，要求 `tools` / `webServer` / `subagents` **三键齐备**、
  //   缺一即 fail-closed 抛错。此处原只给 `tools` ⇒ `before()` 直接抛
  //   `capability-missing: webServer,subagents`，本文件 21 条用例集体红（与 gate-fixture.mjs 头注
  //   同源，属同一笔夹具欠债）。补**最小桩**，不放宽任何判据：本文件断言的是「写点归属 / 真实面
  //   零变化 / 面级 backstop 三档」，与服务桩形态无关；`assertRequired` 的语义一字未动。
  const ctx = {
    logger,
    root: { logger },
    tools: { register() {} },
    subagents: { start: async () => ({}), startActivation: async () => ({}), listMembers: async () => [] },
    webServer: { register: () => () => {}, dispose() {} },
  };
  const { apply } = await import(INDEX_URL);
  apply(ctx, {});
  // 【冷启动瘦身 · 资产同步延迟化（批 punky-coldstart-session-20261109）】`syncAssets()` 已移出
  //   `apply()` 同步段，改由 apply 返回后的**首个 tick**（setImmediate）执行 ⇒ 本节拍若仍在此刻取
  //   指纹与日志，会漏掉全部资产写点与 `asset synced` 行（G3/D3/D11/D14-a 的假红）。
  //   ⇒ 显式等一个 tick，把「apply 之后」统一定义为「延迟同步落盘之后」。判据强度不变：
  //     等 tick **不会**让越界写落进隔离根（取消/失败路径另有 warn，见 exec/coldstart-session/notice.md）。
  await new Promise((r) => setImmediate(r));
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
    const isoFiles = (m.report?.fileMeta ?? []).map((f) => ({
      rel: path.relative(m.report.sentinel, f.p),
      sha256: f.sha256,
    }));
    const g2Results = REAL_FACES.map((face, i) => {
      const before = m.realBefore[i];
      const after = m.realAfter[i];
      const attributed = buildAttribution({
        isoFiles,
        faceRootRel: path.relative(REAL_HOME, face),
        faceDelta: faceDiff(before, after),
      });
      return evalFace({ face, before, after, attributed });
    });
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
  const g2Results = REAL_FACES.map((face, i) => {
    const before = state.realBefore[i];
    const after = state.realAfter[i];
    // A1∪A3（面相对键 + 来源标注）：A1 = 隔离根枚举经 manifest 映射；A3 = 内容同路径逐字相同
    const attributed = buildAttribution({
      isoFiles: state.isolatedAfter?.files ?? [],
      faceRootRel: path.relative(ISOLATED, face),
      faceDelta: faceDiff(before, after),
    });
    return evalFace({ face, before, after, attributed });
  });
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
    // ── 静态自检（照 A-6 范式）：① 防渐进削弱、② 防整段删除 —— 各管一种破坏方式 ──
    //    自我命中防范：搜索串**拼接构造**（字面量不连续）+ 锚点用「行首 + 尾随空格」。
    {
      const srcSelf = fs.readFileSync(fileURLToPath(GUARD_URL), 'utf8');
      const NL = String.fromCharCode(10);
      const bodyAnchor = NL + "test('D3 ";
      const at = srcSelf.indexOf(bodyAnchor);
      assert.notEqual(at, -1, '静态自检：必须能定位 D3 用例体锚点');
      const next = srcSelf.indexOf(NL + "test('", at + bodyAnchor.length);
      const d3Body = srcSelf.slice(at + 1, next < 0 ? srcSelf.length : next);
      // **集合式**（不是计数式）：每个可删点各一个 needle，缺哪个报哪个。
      // 为什么不数总数：合法新增第 5 处调用时会**假红**（数量断言的老毛病，本轮正治这个）。
      // needle 全部**拼接构造**（字面量不连续）⇒ 自检自身不被匹配。
      const needles = [
        ['① 对照组 REAL_SINK_PROBE', 'attribution' + 'Verdict([REAL_SINK_PROBE], report.claimedRoot)'],
        ['② 合并判据 .every', 'attribution' + 'Verdict([p], report.claimedRoot).ok === false'],
        ['③ 逐条 actual 循环', 'attribution' + 'Verdict([p], report.claimedRoot).ok, false'],
        ['④ claimed 零写', 'attribution' + 'Verdict(report.writtenUnderClaimed'],
        ['⑤ 面级 backstop 调用点', 'd3RealFace' + 'Verdict('],
      ];
      // 每个可删点**各自一条断言**（显式 5 条，不用 for 包起来）：
      //   · 红点天然点名"缺哪一处"；
      //   · 断言调用点数不下降（基线对账有"断言零下降"判据：聚合/循环都会让它掉数）。
      const missMsg = (label, nd) => '静态自检：D3 体缺可删点 → ' + label + '（needle=' + nd + '）｜逐处点名、不报总数（合法新增不判红）';
      assert.equal(d3Body.includes(needles[0][1]), true, missMsg(needles[0][0], needles[0][1]));
      assert.equal(d3Body.includes(needles[1][1]), true, missMsg(needles[1][0], needles[1][1]));
      assert.equal(d3Body.includes(needles[2][1]), true, missMsg(needles[2][0], needles[2][1]));
      assert.equal(d3Body.includes(needles[3][1]), true, missMsg(needles[3][0], needles[3][1]));
      assert.equal(d3Body.includes(needles[4][1]), true, missMsg(needles[4][0], needles[4][1]));
    }

    for (const p of report.writtenUnderActual) {
      // 逐条证据：这些**真实文件**若交给 G3 谓词核对归属，必须判越界
      assert.equal(attributionVerdict([p], report.claimedRoot).ok, false, '越界落点必须判红：' + p);
    }
    assert.equal(attributionVerdict(report.writtenUnderClaimed, report.claimedRoot).ok, true, '对照组判绿');
    // ── D3 主判据（**三条件并进同一条 assert**）：面级 backstop + 归属必要条件 ──
    //    合并理由：让"渐进削弱"（删掉三条件中一条、另两条还在）**必须改这一行**，
    //    而不能靠删一条相邻断言悄悄减条件 —— 审计据此判 B 的正是这一点。
    //    ⚠ 澄清（a18 收紧表述）：合并保证的只是「削弱必落在**同一行 diff**」= **可审性**；
    //      「削弱即变红」由**下方静态自检**承担，**不是合并带来的**。
    //      构造①实证：删掉 `&& claimedEmpty` 后 D3 **仍绿** ⇒ 不得读成「合并即防削弱」。
    {
      const actualAllOutside = report.writtenUnderActual.every((p) => attributionVerdict([p], report.claimedRoot).ok === false);
      const claimedEmpty = report.writtenUnderClaimed.length === 0;
      const v = d3RealFaceVerdict({ before: realBefore, after: snapshotReal(), ourRelSet: d3OurRelSet(report, actual) });
      assert.ok(v.status === 'green' && actualAllOutside && claimedEmpty,
        'D3 面级 backstop + 归属必要条件（同一判据）：' + v.message
        + ' / actualAllOutside=' + actualAllOutside + ' / claimedEmpty=' + claimedEmpty);
    }
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
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
const sentinel = (process.env.PUNKY_TEST_ISOLATED_HOME ?? '').trim();
const real = os.userInfo().homedir;
const calls = { info: [], warn: [], error: [] };
const logger = { info: (...a) => calls.info.push(a.join(' ')), warn: (...a) => calls.warn.push(a.join(' ')), error: (...a) => calls.error.push(a.join(' ')), exporter: () => () => {} };
const ctx = { logger, root: { logger }, tools: { register() {} }, subagents: { start: async () => ({}), startActivation: async () => ({}), listMembers: async () => [] }, webServer: { register: () => () => {}, dispose() {} } }; // 2026-10-31 遗留收口：apply 装配需三件宿主键齐备（同 before() 的补桩；否则子进程直接抛 capability-missing，探针拿不到元数据）
const mod = await import(${JSON.stringify(indexUrl)});
mod.apply(ctx, {});
// 冷启动瘦身：资产同步已改为 apply 返回后首个 tick 执行 ⇒ 本探针必须在 tick 之后再取文件面读数，
// 否则「资产已同步」恒假（探针缺陷，不是产品读数）。
await new Promise((r) => setImmediate(r));
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
  fileMeta: walk(sentinel).map((p) => ({
    p,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
  })),
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
const ctx = { logger, root: { logger }, tools: { register() {} }, subagents: { start: async () => ({}), startActivation: async () => ({}), listMembers: async () => [] }, webServer: { register: () => () => {}, dispose() {} } }; // 2026-10-31 遗留收口：apply 装配需三件宿主键齐备（同 before() 的补桩；否则子进程直接抛 capability-missing，探针拿不到元数据）
const mod = await import(${JSON.stringify(indexUrl)});
mod.apply(ctx, {});
// 冷启动瘦身：资产同步在首个 tick 内完成 ⇒ 写点探针必须等一个 tick 再枚举文件面。
await new Promise((r) => setImmediate(r));
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

// ─────────────────────────────────────────────────────────────────────────────
// D9-a / D9-b / D10：A2 弃接的正面证据 + 键空间回归（新增，**并列**于 D1–D8）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A2 归因源（仅**取证用**，生产路径不接 —— 裁决见 exec/a2-wiring.md）：
 * 从 `apply()` 的自报日志解析三类落点，并按 **manifest** 映射回面相对。
 *   · `engine root: <p>` ⇒ 面不在 REAL_FACES（结构性惰性）
 *   · `audit log sink mounted: <p>` ⇒ 落在 .dsh/logs（LIVE 面，已排除）
 *   · `asset synced: <rel>` ⇒ 用 manifest 的 rel→subpath 映射（**不猜前缀**）
 */
export function a2RelsFromLogs(lines, faceRootRel) {
  const root = String(faceRootRel).split(path.sep).join('/');
  const out = { assetRels: [], inert: [], live: [], unknown: [] };
  for (const line of lines ?? []) {
    const engine = String(line).match(/engine root:\s*(.+?)；/);
    if (engine) { out.inert.push(engine[1].trim()); continue; }
    const sink = String(line).match(/audit log sink mounted:\s*(.+)$/);
    if (sink) { out.live.push(sink[1].trim()); continue; }
    const synced = String(line).match(/asset synced:\s*(.+)$/);
    if (synced) {
      const rel = synced[1].trim().split('/').join('/');
      const hit = assetMap().find((a) => rel === a.rel || rel.startsWith(a.rel + '/'));
      if (!hit || hit.faceRootRel !== root) continue;
      out.assetRels.push(hit.subpath + rel.slice(hit.rel.length));
      continue;
    }
    out.unknown.push(String(line).trim());
  }
  return out;
}

const mkFaceFiles = (rels) => rels.map((r) => ({ rel: r, size: 10, mtimeMs: 1, sha256: 'h-' + r }));
const mkFaceOf = (rels) => ({
  exists: true, count: rels.length, sumBytes: rels.length * 10,
  digest: 'd-' + rels.join(','), files: mkFaceFiles(rels),
});

test('D9-a 谓词级：隔离**部分**失效下 A1∪A3 ⇒ unattributable；+A2 ⇒ red（增益真实但生产不可达）', () => {
  const before = mkFaceOf(['f0', 'f1', 'f10']);
  const after = mkFaceOf(['f0', 'f1']);          // f10 被删（持久）
  const diff = faceDiff(before, after);
  assert.deepEqual(diff.removed, ['f10'], '差异项应是面相对的 f10');

  // A1∪A3：隔离根里出现的都是**其它**路径（部分失效场景：越界写没有走一次完整同步）
  const a1a3 = [
    { kind: 'faceRel', rel: 'software-team/SKILL.md', source: 'A1' },
    { kind: 'faceRel', rel: 'punky-preset/agent.cordis.yml', source: 'A3' },
  ];
  const noA2 = g2Verdict({ face: 'F', before, after, after2: after, attributed: a1a3 });
  assert.equal(noA2.status, 'inconclusive', 'A1∪A3 覆盖不到 ⇒ 只能 unattributable');
  assert.equal(noA2.subclass, 'unattributable');
  assert.equal(noA2.attribution.hits.length, 0, 'A1∪A3 命中数应为 0');

  // +A2（日志自称的落点）⇒ 映射到面相对后命中 ⇒ red
  const withA2 = [
    ...a1a3,
    { kind: 'a2Rel', rel: 'engine-root-shadow', source: 'A2' },
  ];
  const faceMapA2 = (rel, kind) => (kind === 'a2Rel' && rel === 'engine-root-shadow' ? 'f10' : null);
  const withA2Result = g2Verdict({ face: 'F', before, after, after2: after, attributed: withA2, faceMap: faceMapA2 });
  assert.equal(withA2Result.status, 'red', 'A2 在该场景有独立增益（能命中 A1∪A3 覆盖不到的差异项）');
  assert.deepEqual(withA2Result.attributedHits, ['f10']);
  assert.equal(withA2Result.attribution.hits[0].kind, 'a2Rel', '命中须带来源标注');
});

test('D9-b 生产路径 A2 ⊆ A1（弃接 A2 的正面证据；出现新写点形态即判红）', () => {
  const m = mechanismRun();
  assert.ok(m.report && Array.isArray(m.report.fileMeta), '子进程应回报文件元数据（sha256）');
  const isoFiles = (m.report.fileMeta ?? []).map((f) => ({ rel: path.relative(m.report.sentinel, f.p), sha256: f.sha256 }));

  // A1：隔离根枚举 → 面相对
  const a1 = new Set();
  for (const f of isoFiles) {
    const mapped = isoRelToFace(f.rel);
    if (mapped && mapped.rel) a1.add(mapped.faceRootRel + '|' + mapped.rel);
  }

  // A2：日志自报 → 面相对（manifest 驱动）
  const faceRootRel = path.relative(REAL_HOME, REAL_FACES.find((p) => p.endsWith('.agent-presets')) ?? REAL_FACES[0]);
  const a2 = a2RelsFromLogs(m.report.logs ?? [], faceRootRel);
  const a2Keys = new Set(a2.assetRels.map((r) => String(faceRootRel).split(path.sep).join('/') + '|' + r));

  // ⚠ 粒度对齐（p1 口径）：A2 报的是**资产目录**（\`asset synced: presets/punky-preset\`），
  // A1 报的是**文件**（\`punky-preset/agent.cordis.yml\`）⇒ 子集判定必须按**目录级前缀**比较，
  // 否则恒假红。注意这不是放宽：若某个 A2 目录在 A1 下**一个文件都没有**，仍会进 a2Only ⇒ 判红。
  const a1Keys = [...a1];
  const coveredByA1 = (k) => a1Keys.some((x) => x === k || x.startsWith(k + '/'));
  const a2Only = [...a2Keys].filter((k) => !coveredByA1(k));
  process.stderr.write('[D9-b] a1=' + a1.size + ' a2=' + a2Keys.size + ' a2Only=' + JSON.stringify(a2Only)
    + ' inert=' + a2.inert.length + ' live=' + a2.live.length
    + ' sampleA1=' + JSON.stringify(a1Keys.filter((x) => x.includes('agent-presets')).slice(0, 3))
    + ' isoPreset=' + JSON.stringify(isoFiles.map((f) => f.rel).filter((r) => r.includes('agent-presets')).slice(0, 3))
    + String.fromCharCode(10));
  assert.deepEqual(a2Only, [],
    'A2 ∖ A1 非空 ⇒ 出现「新写点形态」：弃接 A2 的裁决须重评（差异项：' + JSON.stringify(a2Only) + '）');

  // fail-closed 规格：**合法空集不判红** —— 幂等时 syncDir 返回 'current' ⇒ 不打 'asset synced'
  // （`idempotent-no-synced`）。此时 A2 为空是**合法**的，subset 平凡成立；不是"结论空转"。
  if (a2Keys.size === 0) {
    assert.equal((m.report.logs ?? []).some((l) => /asset synced:/.test(String(l))), false,
      'A2 为空时须确认原因是幂等（日志里确实没有 asset synced 行），否则是解析失联');
    process.stderr.write('[D9-b] a2=0 合法空集（idempotent-no-synced：syncDir 已 current ⇒ 不打 asset synced）\n');
  } else {
    assert.ok(a2Keys.size > 0, 'A2 非空时 subset 判定才有对象（本例已保障）');
  }
});

test('D10 键空间回归：isoRel 直塞不得命中（a1Hits===0），faceRel 才命中', () => {
  const before = mkFaceOf(['f0', 'f10']);
  const after = mkFaceOf(['f0']);
  // ① 键空间错：把 isoRel 当 faceRel 直塞（即"改回去"的形态）⇒ 不得命中
  const wrong = g2Verdict({ face: 'F', before, after, after2: after, attributed: [{ kind: 'isoRel', rel: 'f10' }] });
  assert.equal(wrong.status, 'inconclusive', 'isoRel 直塞不得判 red（键空间未对齐）');
  assert.equal(wrong.attribution.hits.length, 0, 'a1Hits 必须为 0');
  assert.deepEqual(wrong.attribution.unresolved, [{ rel: 'f10', kind: 'isoRel' }], '映射不到须显式暴露 unresolved');
  // ② 同一 isoRel 经 faceMap 映射 ⇒ 命中
  const mapped = g2Verdict({ face: 'F', before, after, after2: after, attributed: [{ kind: 'isoRel', rel: 'f10' }], faceMap: (rel) => (rel === 'f10' ? 'f10' : null) });
  assert.equal(mapped.status, 'red', '经 faceMap 映射到面相对后才可命中');
  // ③ 扁平字符串（faceRel）向后兼容，仍直接命中（D5 用法不破）
  const legacy = g2Verdict({ face: 'F', before, after, after2: after, attributed: ['f10'] });
  assert.equal(legacy.status, 'red', '扁平字符串=faceRel，须保持向后兼容');
});

// ─────────────────────────────────────────────────────────────────────────────
// D11：**生产链**（A1∪A3 → faceRel 键）在「真实面确实变了」的受控场景下必须得 red
// 规格 plan/prod-red-spec.md（K-2 面根换位 · A-1..A-6 · R-1..R-3 · AC-11）
//
// 为什么需要换场景：生产两侧都已接 buildAttribution，但 before/after 取的是**真实面**；
// 隔离生效 ⇒ 真实面零变化 ⇒ diffPaths=[] ⇒ g2Verdict 直接 green ⇒ hits 分支**从未执行**。
// ⇒ red 不可达不是接线缺失，是「隔离成功时真实面必然无差异」的必然结果 ⇒ 只能换场景。
//
// 构造：ctlFace = <mkdtemp>/.dsh/.agent-presets 充当**假真实面**；isoFiles 取**生产真实产物**；
//       唯一构造 = 向 ctlFace 逐字复制 punky-preset/agent.cordis.yml（**必须 subpath 嵌套**：
//       写在面根时新旧映射结果相同 ⇒ 反向对照不红 ⇒ 用例失去鉴别力）。
// ─────────────────────────────────────────────────────────────────────────────

/** 生产的隔离根（与 productionIsoFiles 同源）：进程内 = ISOLATED；子进程 = 机制探针 sentinel。 */
function productionIsoRoot() {
  if (ISOLATED && state.applied) return ISOLATED;
  return mechanismRun().report.sentinel;
}

/** 生产 isoFiles：进程内取 state.isolatedAfter.files（含 sha256）；子进程取 report.fileMeta。 */
function productionIsoFiles() {
  if (ISOLATED && state.applied) {
    return (state.isolatedAfter?.files ?? []).map((f) => ({ rel: f.rel, sha256: f.sha256 }));
  }
  const m = mechanismRun();
  return (m.report?.fileMeta ?? []).map((f) => ({
    rel: path.relative(m.report.sentinel, f.p),
    sha256: f.sha256,
  }));
}

/** 取出本文件里 D11 用例体的源码文本（供 A-6 / R-3 静态自检）。 */
function d11BlockSrc() {
  const src = fs.readFileSync(fileURLToPath(GUARD_URL), 'utf8'); // GUARD_URL 是 file:// URL，Windows 下须转路径
  // ⚠ 不能用裸 "test('D11" 定位：本函数自身那句字面量会被先搜到（自我命中 ⇒ 只取到碎片）。
  //    改为「行首 + 真实声明（D11 后有空格）」双条件。
  const NL = String.fromCharCode(10);
  const anchor = NL + "test('D11 ";
  const start = src.indexOf(anchor);
  if (start < 0) return '';
  const next = src.indexOf(NL + "test('", start + anchor.length);
  return src.slice(start + 1, next < 0 ? src.length : next);
}

/** 修复前形态的映射（**吃掉 subpath**），仅作反向对照用；生产代码不引入该参数。 */
function oldIsoRelToFaceBuggy(isoRel) {
  const norm = String(isoRel).split(path.sep).join('/');
  for (const a of assetMap()) {
    if (!a.targetPrefixRel) continue;
    if (norm.startsWith(a.targetPrefixRel + '/')) {
      return { faceRootRel: a.faceRootRel, rel: norm.slice(a.targetPrefixRel.length + 1) };
    }
  }
  return null;
}

test('D11 生产链 red 可达性：真实产物 isoFiles + 面根换位 ⇒ status=red（键空间对齐才成立）', () => {
  const realBeforeSnap = snapshotReal();                       // R-1 前置快照
  const dir = tmpRoot('d11');
  const ctlFace = path.join(dir, '.dsh', '.agent-presets');     // K-2：充当假真实面
  const probeRel = 'punky-preset/agent.cordis.yml';             // ① 必须 subpath 嵌套
  try {
    fs.mkdirSync(ctlFace, { recursive: true });

    // ── 生产 isoFiles + AC-11 前置 fail-closed ──
    const isoFiles = productionIsoFiles();
    const hasProbe = isoFiles.some((f) => String(f.rel).split(path.sep).join('/') === '.dsh/.agent-presets/' + probeRel);
    assert.equal(hasProbe, true,
      'AC-11：生产 isoFiles 里必须存在 .dsh/.agent-presets/' + probeRel + '（缺失即判红，不得静默降级成「无差异 ⇒ green」）');
    const probeIso = isoFiles.find((f) => String(f.rel).split(path.sep).join('/') === '.dsh/.agent-presets/' + probeRel);
    assert.ok(probeIso && probeIso.sha256, 'AC-11：该文件必须带 sha256（A3 内容对照的前提）');

    // ── 唯一构造：向 ctlFace 逐字复制（内容取自隔离根真实产物 → 与 isoFile 内容逐字相同）──
    const before = fingerprint(ctlFace);                         // 空面
    fs.mkdirSync(path.join(ctlFace, 'punky-preset'), { recursive: true });
    // 副本源必须与 isoFiles **同源**：进程内 = ISOLATED；子进程 = 机制探针的 sentinel（其 assets 已同步）
    // 复制源：
    //   · 进程内路径 ⇒ 隔离根内的**真实产物**（probeIso.rel 为隔离根相对）；
    //   · 子进程路径 ⇒ 其隔离根在子进程退出时**已被 preload 清理**（契约：本进程创建的根退出即清），
    //     故取包内源文件，并用 sha256 与 report 里的产物指纹**逐字比对**（相等才允许复制）。
    const isoRoot = (ISOLATED && state.applied) ? ISOLATED : null;
    // 包内源路径由 manifest 推出：asset.rel（包内相对）+ 面内路径去掉 subpath 前缀后的尾段
    const probeAsset = assetMap().find((x) => x.subpath && probeRel.startsWith(x.subpath + '/'));
    const pkgRel = probeAsset ? probeAsset.rel + probeRel.slice(probeAsset.subpath.length) : probeRel;
    const copySrc = isoRoot ? path.join(isoRoot, probeIso.rel) : path.join(PACKAGE_ROOT, pkgRel);
    assert.equal(fs.existsSync(copySrc), true, 'AC-11：复制源必须可读：' + copySrc);
    fs.copyFileSync(copySrc, path.join(ctlFace, probeRel));
    const copiedSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ctlFace, probeRel))).digest('hex');
    assert.equal(copiedSha, probeIso.sha256,
      '构造必须与**生产产物**逐字相同（sha256 相等）：copied=' + copiedSha + ' produced=' + probeIso.sha256);
    const after = fingerprint(ctlFace);
    const faceDelta = faceDiff(before, after);
    const addedPosix = faceDelta.added.map((r) => r.split(path.sep).join('/'));
    assert.deepEqual(addedPosix, [probeRel], 'R-3 前置：构造只新增 punky-preset/agent.cordis.yml（subpath 嵌套）；实测 ' + JSON.stringify(addedPosix));

    // ── 生产链：buildAttribution（A1∪A3，面相对键 + 来源）→ evalFace → g2Verdict ──
    const attribution = buildAttribution({ isoFiles, faceRootRel: '.dsh/.agent-presets', faceDelta });
    const result = evalFace({ face: ctlFace, before, after, attributed: attribution });

    // A-1 该红必红
    assert.equal(result.status, 'red', 'A-1：键空间对齐后必须判 red；实测 status=' + result.status + ' subclass=' + (result.subclass ?? '-'));
    // A-2 键空间无未解析项
    assert.ok(result.attribution.bySource.faceRel >= 1, 'A-2：须有 faceRel 条目（实测 bySource=' + JSON.stringify(result.attribution.bySource) + '）');
    assert.deepEqual(result.attribution.unresolved, [], 'A-2：unresolved 必须为空');
    // A-3 命中项必须来自生产谓词（不是手工字面量）
    assert.equal(result.attribution.hits.every((h) => h.kind === 'faceRel' && ['A1', 'A3'].includes(h.source)), true,
      'A-3：hits 必须全部 kind=faceRel 且 source ∈ {A1,A3}；实测 ' + JSON.stringify(result.attribution.hits));
    // A-4 A3 真在跑（用 source 集合，**不用** bySource.a3 —— 该键从不递增，语义是尝试数）
    const sources = new Set(attribution.map((e) => e.source));
    assert.equal(sources.has('A1'), true, 'A-4：source 集合须含 A1；实测 ' + JSON.stringify([...sources]));
    assert.equal(sources.has('A3'), true, 'A-4：source 集合须含 A3（A3 未真跑即红）；实测 ' + JSON.stringify([...sources]));
    // A-5 精确身份（丢 subpath 会变短）
    // A-5：命中值必须**精确**等于面相对键（丢 subpath 会变短 ⇒ 红）；A1 与 A3 各可能命中一次，故按值判定而非去重后计数
    assert.ok(result.attributedHits.length >= 1, 'A-5：attributedHits 不得为空');
    assert.equal(result.attributedHits.every((h) => h === probeRel), true,
      'A-5：attributedHits 必须精确含 ' + probeRel + '；实测 ' + JSON.stringify(result.attributedHits));

    // ── K-3 反向对照：同一输入，把映射换成「吃掉 subpath」（本地反事实函数，不给生产加 mapper 参数）──
    const oldEntries = [];
    for (const f of isoFiles) {
      const m = oldIsoRelToFaceBuggy(f.rel);
      if (m && String(m.faceRootRel).split(path.sep).join('/') === '.dsh/.agent-presets' && m.rel) {
        oldEntries.push({ kind: 'faceRel', rel: m.rel, source: 'A1' });
      }
    }
    const oldAttribution = oldEntries;
    const legacy = g2Verdict({ face: ctlFace, before, after, after2: after, attributed: oldAttribution });
    assert.equal(legacy.status, 'inconclusive', 'K-3：旧映射（吃掉 subpath）下必须只能 unattributable；实测 ' + legacy.status);
    assert.equal(legacy.subclass, 'unattributable', 'K-3：旧映射必须落到 unattributable');
    assert.equal(legacy.attribution.hits.length, 0, 'K-3：旧映射命中数必须为 0');
    assert.notEqual(legacy.status, result.status,
      'K-3：新旧结论**必须不同**（相同 ⇒ 本用例不依赖键空间 ⇒ 失去鉴别力 ⇒ 判红）');

    // ── A-6 立身之本：D11 必须真走生产链（静态检查自身源码）──
    const body = d11BlockSrc();
    assert.ok(body.includes('buildAttribution('), 'A-6：D11 用例体必须调用 buildAttribution(（真走生产链）');
    const forbidden = 'attributed' + ': [';
    assert.equal(body.includes(forbidden), false, 'A-6：D11 用例体不得出现手工归因数组字面量（' + forbidden + '）');

    // ── R-1 真实面零变化（构造/判定全程）──
    const realAfterSnap = snapshotReal();
    for (let i = 0; i < REAL_FACES.length; i++) {
      const b = realBeforeSnap[i];
      const a = realAfterSnap[i];
      assert.equal(a.exists, b.exists, 'R-1：真实面存在性逐字全等：' + REAL_FACES[i]);
      assert.equal(a.count, b.count, 'R-1：真实面文件数逐字全等：' + REAL_FACES[i]);
      assert.equal(a.sumBytes, b.sumBytes, 'R-1：真实面字节和逐字全等：' + REAL_FACES[i]);
      assert.equal(a.digest, b.digest, 'R-1：真实面指纹逐字全等：' + REAL_FACES[i]);
    }
    // ── R-2 构造根归属：自身归属自洽 + **不在任何真实面（REAL_FACES）内** ──
    // ⚠ 平台事实（实测）：本机 `os.tmpdir()` 位于真实 home 之下
    //    （`C:\Users\ADMINI~1\AppData\Local\Temp` 经 realpath 展开为 `C:\Users\Administrator\AppData\Local\Temp`），
    //    故「ctlFace ∉ REAL_HOME」在本平台**不可满足**，也不是安全判据；真正的安全不变量是
    //    「ctlFace ∉ 任一 REAL_FACE」。这里按后者断言，并显式记录前者为平台事实（不静默改口径）。
    assert.equal(attributionVerdict([ctlFace], ctlFace).ok, true, 'R-2a：ctlFace 是其自身合法根（归属自洽）');
    const ctlNorm = normPath(ctlFace);
    for (const realFace of REAL_FACES) {
      const faceNorm = normPath(realFace);
      const inside = ctlNorm === faceNorm || ctlNorm.startsWith(faceNorm + (process.platform === 'win32' ? '\\' : '/'));
      assert.equal(inside, false, 'R-2b：ctlFace **不得**落在任何真实面内：' + realFace);
    }
    process.stderr.write('[D11] R-2 平台事实：ctlFace 在 homedir 之下 = '
      + attributionVerdict([ctlFace], REAL_HOME).ok + '；在 REAL_FACES 之下 = false\n');
    // ── R-3 静态可核：本用例内所有写调用目标均以 ctlFace 为前缀，且不与 REAL_HOME 同行 ──
    let writeLines = 0;
    for (const line of body.split('\n')) {
      if (!/\b(fs\.(writeFileSync|mkdirSync|copyFileSync|renameSync|rmSync|appendFileSync)\()/.test(line)) continue;
      assert.equal(/REAL_HOME/.test(line), false, 'R-3：写调用行不得出现 REAL_HOME：' + line.trim());
      // teardown 例外：`fs.rmSync(dir, ...)` 清的是 mkdtemp 根（ctlFace 在其内），本身不是构造写点
      const isTeardown = /fs\.rmSync\(dir\b/.test(line);
      assert.equal(isTeardown || /ctlFace/.test(line), true,
        'R-3：除 teardown 外，写调用必须以 ctlFace 为前缀：' + line.trim());
      if (!isTeardown) writeLines += 1;
    }
    assert.ok(writeLines >= 2, 'R-3：构造写点须 ≥2（mkdir + copyFile）且均指向 ctlFace；实测 ' + writeLines);

    process.stderr.write('[D11] status=' + result.status
      + ' hits=' + JSON.stringify(result.attributedHits)
      + ' sources=' + JSON.stringify([...sources])
      + ' legacy=' + legacy.status + '/' + (legacy.subclass ?? '-')
      + ' a6=ok\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D12：扁平 `faceRel` 字符串**含分隔符**时也必须命中（钉住 PR-1：faceRel 是唯一没有
//      `unresolved` 通道的 kind —— 不命中就静默跳过）
//
// 构造纪律：反斜杠一律**不手写字面量**（bash/JS 转义会把 \\b 之类吃掉）。
//   这里用 `path.join` 拼（Windows 下天然是反斜杠），并断言它真的含分隔符。
// ─────────────────────────────────────────────────────────────────────────────

test('D12 faceRel 自防御：含分隔符的扁平键必须命中，且未命中项要进 unresolved（不静默）', () => {
  const posixRel = 'punky-preset/agent.cordis.yml';
  const backslashRel = path.join('punky-preset', 'agent.cordis.yml');   // ← 用 path.join 构造，不手写反斜杠
  const before = mkFaceOf([]);
  const after = mkFaceOf([posixRel]);

  // ① 含分隔符的扁平 faceRel（旧行为：恒不命中且**静默**）
  const v = g2Verdict({ face: 'F', before, after, after2: after, attributed: [backslashRel] });
  assert.equal(v.status, 'red',
    'D12-1：含分隔符的 faceRel 必须命中（旧实现下此处恒为 inconclusive 且**无 unresolved 记录**）；实测 '
    + v.status + ' / hits=' + JSON.stringify(v.attributedHits) + ' / unresolved=' + JSON.stringify(v.attribution.unresolved));
  assert.equal(v.attributedHits.every((h) => h === posixRel), true,
    'D12-2：命中项必须是**归一化后的面相对键**；实测 ' + JSON.stringify(v.attributedHits));
  assert.deepEqual(v.attribution.unresolved, [],
    'D12-3：已命中条目不得污染 unresolved；实测 ' + JSON.stringify(v.attribution.unresolved));

  // ② 向后兼容：无分隔符的扁平键（D5 用法）必须照旧命中
  const plain = g2Verdict({ face: 'F', before, after, after2: after, attributed: ['agent.cordis.yml'] });
  assert.equal(plain.status, 'inconclusive', 'D12-4：不存在的面相对键不得命中（无分隔符语义不变）');
  const plainHit = g2Verdict({ face: 'F', before, after, after2: after, attributed: ['agent.cordis.yml'] });
  assert.equal(plainHit.attribution.unresolved.length, 1,
    'D12-5：**未命中的 faceRel 也必须进 unresolved**（与 isoRel/a2Rel 通道对齐，不得静默跳过）');

  // ③ 真的不存在的带分隔符键：同样要进 unresolved
  const missing = g2Verdict({ face: 'F', before, after, after2: after, attributed: [path.join('nope', 'x.txt')] });
  assert.equal(missing.attribution.unresolved.length, 1,
    'D12-6：不存在的带分隔符 faceRel 必须进 unresolved；实测 ' + JSON.stringify(missing.attribution.unresolved));

  process.stderr.write('[D12] backslashKey=' + JSON.stringify(backslashRel)
    + ' hasSep=' + (backslashRel.includes(String.fromCharCode(92)) || backslashRel.includes('/'))
    + ' status=' + v.status
    + ' hits=' + JSON.stringify(v.attributedHits)
    + ' unresolvedOnHit=' + JSON.stringify(v.attribution.unresolved)
    + ' unresolvedOnMiss=' + missing.attribution.unresolved.length + String.fromCharCode(10));
});

// ─────────────────────────────────────────────────────────────────────────────
// D13：第四通道（映射成功但未命中）+ RED 证据的可复跑半 + 读数接通
//
// ⚠ **RED 证据分两半（不可互相替代）**：
//   · 可复跑半（本用例 D13-2）：`oldLookup` 对含分隔符裸键必 miss —— 纯函数、零副作用、零腐化，**这是可复现证据**。
//   · **不可复跑半**：「旧版 miss 时**静默**（三处全不记）」本质是**缺一段代码**，无法执行 ⇒ 只能引用档案：
//       exec/faceRel-normalize.md:74-78（修前 RED 原始回显：`inconclusive / hits=undefined / unresolved=[]`）
//       与 gap-faceRel.json 的 `red_before_fix` 字段。
//     **此半不可复跑，勿引作可复现证据。**
//   · 反向 patch / harness 本批**明确不做**（脏树风险 + 等价后门 + 必腐化）。
// ─────────────────────────────────────────────────────────────────────────────

test('D13 第四通道 + 读数接通：映射成功未命中要可见，summary/文本要对得上（含可复跑的旧查找反事实）', () => {
  const posixKey = 'punky-preset/agent.cordis.yml';
  const before = mkFaceOf([]);
  const after = mkFaceOf([posixKey]);
  const mapToMiss = (rel) => (rel === 'iso-unmatched' ? 'not-in-diff.txt' : null);

  // ── D13-1a 分流正确：hits=1 / unmatched=1 / unresolved=0 ──
  const v = g2Verdict({
    face: 'F', before, after, after2: after,
    attributed: [posixKey, { kind: 'isoRel', rel: 'iso-unmatched', source: 'A1' }],
    faceMap: mapToMiss,
  });
  assert.equal(v.status, 'red', 'D13-1a：命中存在 ⇒ status=red（实测 ' + v.status + '）');
  assert.equal(v.attribution.hits.length, 1, 'D13-1a：hits 必须恰 1（实测 ' + v.attribution.hits.length + '）');
  assert.equal(v.attribution.unmatched.length, 1,
    'D13-1a：映射成功但未命中必须进 unmatched（修复前这里三处全不记）；实测 ' + JSON.stringify(v.attribution.unmatched));
  assert.equal(v.attribution.unresolved.length, 0,
    'D13-1a：映射成功的条目不得污染 unresolved；实测 ' + JSON.stringify(v.attribution.unresolved));

  // ── D13-1b 读数接通：summary.unmatched 与汇总文本一致 ──
  const sum = g2Summary([v]);
  assert.equal(sum.unmatched, 1, 'D13-1b：g2Summary().unmatched 必须真聚合（实测 ' + sum.unmatched + '）');
  const text = formatG2Summary(sum);
  assert.equal(text.includes('unmatched=1'), true, 'D13-1b：汇总行必须渲染 unmatched=1；实测：' + text.split(String.fromCharCode(10))[0]);

  // ── D13-1c 未命中不改变命中数 ──
  const onlyHit = g2Verdict({ face: 'F', before, after, after2: after, attributed: [posixKey] });
  assert.deepEqual(v.attributedHits, onlyHit.attributedHits,
    'D13-1c：多一个未命中条目不得改变命中集合');

  // ── D13-2 可复跑的旧查找反事实（照 oldIsoRelToFaceBuggy 的范式）──
  const diffSet = new Set([posixKey]);
  const backendKey = path.join('punky-preset', 'agent.cordis.yml');   // 反斜杠用 path.join 造，不手写字面量
  const oldLookup = (set, rel) => set.has(rel);                        // 修复前的查找
  const newLookup = (set, rel) => set.has(rel) || set.has(toPosix(rel)); // 修复后的自防御
  assert.equal(backendKey === posixKey, false, 'D13-2 前置：构造键必须真的含分隔符（实测 ' + JSON.stringify(backendKey) + '）');
  assert.equal(oldLookup(diffSet, backendKey), false, 'D13-2a：旧查找对含分隔符裸键**必 miss**（可复跑证据）');
  assert.equal(newLookup(diffSet, backendKey), true, 'D13-2b：新查找**必命中**（可复跑证据）');

  // ── 真实量级读数：生产归因下的 unmatched 条数（诊断字段，不设语义契约）──
  const realIdx = REAL_FACES.findIndex((p) => p.endsWith('.agent-presets'));
  const realDelta = ISOLATED && state.applied
    ? faceDiff(state.realBefore[realIdx], state.realAfter[realIdx])
    : faceDiff(mechanismRun().realBefore[realIdx], mechanismRun().realAfter[realIdx]);
  const realAttr = buildAttribution({ isoFiles: productionIsoFiles(), faceRootRel: '.dsh/.agent-presets', faceDelta: realDelta });
  const realDiff = new Set([...(realDelta.added ?? []), ...(realDelta.changed ?? [])].map((r) => toPosix(r)));
  const unmatchedOnReal = realAttr.filter((e) => !realDiff.has(toPosix(e.rel))).length;

  process.stderr.write('[D13] unmatchedOnRealAttribution=' + unmatchedOnReal
    + ' (realAttr=' + realAttr.length + ' realDiff=' + realDiff.size + ')'
    + ' hits=' + v.attribution.hits.length
    + ' unmatched=' + v.attribution.unmatched.length
    + ' unresolved=' + v.attribution.unresolved.length
    + ' summaryUnmatched=' + sum.unmatched
    + ' oldLookupMiss=' + (oldLookup(diffSet, backendKey) === false)
    + ' newLookupHit=' + (newLookup(diffSet, backendKey) === true) + String.fromCharCode(10));
});

// D13-4：四通道汇总齐平 —— **聚合**与**渲染**两条都要断。
// 反面教材：a14 的 `sum.__unmatched ?? 0` 是"渲染接了但聚合没接"（字段不存在 ⇒ 恒 0）。
test('D13-4 汇总通道齐平：unresolved / hits 既要进 g2Summary 聚合，也要出现在汇总行文本', () => {
  const before = mkFaceOf([]);
  const after = mkFaceOf(['f10']);
  // 一条命中（扁平 faceRel）+ 一条未映射（isoRel 无 faceMap ⇒ unresolved）
  const v = g2Verdict({
    face: 'F', before, after, after2: after,
    attributed: ['f10', { kind: 'isoRel', rel: 'unmapped-key', source: 'A1' }],
  });
  assert.equal(v.attribution.hits.length, 1, 'D13-4 前置：hits 须为 1（实测 ' + v.attribution.hits.length + '）');
  assert.equal(v.attribution.unresolved.length, 1, 'D13-4 前置：unresolved 须为 1（实测 ' + v.attribution.unresolved.length + '）');

  const sum = g2Summary([v]);
  const text = formatG2Summary(sum).split(String.fromCharCode(10))[0];

  // 聚合接上了
  assert.equal(sum.unresolved, 1, 'D13-4a：g2Summary().unresolved 必须真聚合（实测 ' + sum.unresolved + '）');
  assert.equal(sum.hits, 1, 'D13-4b：g2Summary().hits 必须真聚合（实测 ' + sum.hits + '）');
  // 渲染接上了
  assert.equal(text.includes('unresolved=1'), true, 'D13-4c：头行必须渲染 unresolved=1；实测：' + text);
  assert.equal(text.includes('hits=1'), true, 'D13-4d：头行必须渲染 hits=1；实测：' + text);
  // 不得退化成假字段（两个都有值才说明聚合真的读了 detail）
  assert.equal(Number.isFinite(sum.unresolved) && Number.isFinite(sum.hits), true, 'D13-4e：聚合值必须是有限数');

  process.stderr.write('[D13-4] unresolved=' + sum.unresolved
    + ' hits=' + sum.hits
    + ' unresolvedInText=' + text.includes('unresolved=1')
    + ' hitsInText=' + text.includes('hits=1') + String.fromCharCode(10));
});

// ─────────────────────────────────────────────────────────────────────────────
// D14：**removed 的归因红线**（AC-10：不新增生产分支 —— 判据已在 A1 里）
//
// 为什么必须有这条：全仓此前**没有一条用例**走过「真实面丢 X ∧ 隔离根有 X ⇒ red」。
//   · D6 / D9-a 只断 `delta.removed` 的**形状**；
//   · D11 构造的是 **added**，不是 removed。
// ⇒ 若将来有人把 A1 重构成「只处理 added/changed」（看着像"对齐 A3"的合理重构），
//   **零断言会红，red 分支静默消失**。D14-a 就是钉这条的。
// ─────────────────────────────────────────────────────────────────────────────

/** 受控面：把生产产物按面相对 rel 复制进 ctlFace（源与 D11 同口径：隔离根真实产物优先，子进程用包内源 + sha 校验）。 */
function materializeProbeInto(ctlFace, probeRel, isoFile) {
  const posixRel = String(probeRel).split(path.sep).join('/');
  const isoRoot = (ISOLATED && state.applied) ? ISOLATED : null;
  let copySrc;
  if (isoRoot) {
    copySrc = path.join(isoRoot, String(isoFile.rel));
  } else {
    const asset = assetMap().find((x) => x.subpath && posixRel.startsWith(x.subpath + '/'));
    const pkgRel = asset ? asset.rel + posixRel.slice(asset.subpath.length) : posixRel;
    copySrc = path.join(PACKAGE_ROOT, pkgRel);
  }
  fs.mkdirSync(path.dirname(path.join(ctlFace, posixRel)), { recursive: true });
  fs.copyFileSync(copySrc, path.join(ctlFace, posixRel));
  const copiedSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ctlFace, posixRel))).digest('hex');
  assert.equal(copiedSha, isoFile.sha256, '构造须与生产产物逐字相同（sha256 相等）：' + posixRel);
}

test('D14-a 该红必红：真实面**丢** X 且隔离根有 X ⇒ red，且 source 必须是 A1（A3 对 removed 不适用）', () => {
  const probeRel = 'punky-preset/agent.cordis.yml';
  const isoRel = '.dsh/.agent-presets/' + probeRel;

  // ── fail-closed 两分法：**取不到** isoFiles ⇒ 判红并点名；**取到空集**才是合法 ──
  let isoFiles;
  try {
    isoFiles = productionIsoFiles();
  } catch (e) {
    assert.fail('AC-10 fail-closed：isoFiles 不可用（' + (e && e.message ? e.message : String(e))
      + '）⇒ 判红并点名；**不得**把"取不到"当成"隔离根也没有"（那会把泄漏判成外部删除，方向正好反）');
  }
  const isoFile = isoFiles.find((f) => String(f.rel).split(path.sep).join('/') === isoRel);
  assert.ok(isoFile, 'D14 前置：生产 isoFiles 须含 ' + isoRel + '（空集本身合法，但本构造需要真实产物）');

  const dir = tmpRoot('d14a');
  const ctlFace = path.join(dir, '.dsh', '.agent-presets');
  try {
    materializeProbeInto(ctlFace, probeRel, isoFile);
    const before = fingerprint(ctlFace);                    // 有该文件
    fs.rmSync(path.join(ctlFace, probeRel));                // **删除** ⇒ removed 方向
    const after = fingerprint(ctlFace);
    const faceDelta = faceDiff(before, after);

    const removedPosix = (faceDelta.removed ?? []).map((r) => String(r).split(path.sep).join('/'));
    assert.ok(removedPosix.includes(probeRel),
      'D14-a 前置：差异必须在 **removed** 侧（先写后删）；实测 removed=' + JSON.stringify(removedPosix));

    const attr = buildAttribution({ isoFiles, faceRootRel: '.dsh/.agent-presets', faceDelta });
    const result = evalFace({ face: ctlFace, before, after, attributed: attr });

    assert.equal(result.status, 'red',
      'D14-a：真实面丢 X ∧ 隔离根有 X ⇒ 必须 red（A1 全量枚举已覆盖 removed）；实测 ' + result.status + '/' + (result.subclass ?? '-'));
    assert.equal(result.attribution.hits.length >= 1, true, 'D14-a：须有命中');
    assert.equal(result.attribution.hits.every((h) => h.source === 'A1'), true,
      'D14-a：命中来源必须**全部是 A1**（A3 对 removed 不适用，出现 A3 说明构造或判据错了）；实测 '
      + JSON.stringify(result.attribution.hits.map((h) => h.source)));
    assert.deepEqual(result.attributedHits, [probeRel], 'D14-a：命中键须精确为 ' + probeRel + '（已 posix，不再包 toPosix）');

    // ── D14-b 反向对照：同一 isoFiles，换一个**资产前缀下但隔离根没有**的 rel ──
    const absentRel = 'punky-preset/__absent__.yml';
    const dir2 = tmpRoot('d14b');
    const ctlFace2 = path.join(dir2, '.dsh', '.agent-presets');
    try {
      fs.mkdirSync(path.join(ctlFace2, 'punky-preset'), { recursive: true });
      fs.writeFileSync(path.join(ctlFace2, absentRel), 'external-delete', 'utf8');
      const before2 = fingerprint(ctlFace2);
      fs.rmSync(path.join(ctlFace2, absentRel));
      const after2 = fingerprint(ctlFace2);
      const delta2 = faceDiff(before2, after2);
      const removed2 = (delta2.removed ?? []).map((r) => String(r).split(path.sep).join('/'));
      assert.ok(removed2.includes(absentRel), 'D14-b 前置：差异须在 removed 侧；实测 ' + JSON.stringify(removed2));

      const attr2 = buildAttribution({ isoFiles, faceRootRel: '.dsh/.agent-presets', faceDelta: delta2 });
      const result2 = evalFace({ face: ctlFace2, before: before2, after: after2, attributed: attr2 });
      assert.equal(result2.status, 'inconclusive',
        'D14-b：隔离根**也没有**该 rel ⇒ 不得 red（否则"凡删除都算泄漏"）；实测 ' + result2.status);
      assert.equal(result2.subclass, 'unattributable', 'D14-b：须落 unattributable');
      assert.equal(result2.attribution.hits.length, 0, 'D14-b：hits 必须为 0');

      // ── 合成断言：两者结论必须不同，否则本用例不区分"被移过去的泄漏"与"外部删除" ──
      assert.notEqual(result2.status, result.status,
        'D14 合成：D14-a 与 D14-b 结论必须不同（相同 ⇒ 用例无鉴别力）');

      process.stderr.write('[D14] a=' + result.status + '/' + result.attribution.hits.map((h) => h.source).join(',')
        + ' b=' + result2.status + '/' + (result2.subclass ?? '-') + '/hits=' + result2.attribution.hits.length
        + ' removedHasRel=' + removedPosix.includes(probeRel)
        + ' sourceAllA1=' + result.attribution.hits.every((h) => h.source === 'A1')
        + ' syntheticDiffer=' + (result2.status !== result.status) + String.fromCharCode(10));
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D15：三档必须可区分（受控面 `ctlReal`，不碰真实面）
//
// 为什么用受控面：真等宿主写真实面不可控（可能整轮都不写）⇒ 用受控面把三档变成确定性构造，
// 同时满足「不写真实面」与「不改 lib」。
//
// D15-b 定档 = **判红但带归因**（不是判绿）：宿主 syncAssets 与我们写的是同一份资产，
// 同 rel 同内容的掩盖是**结构性**不可区分（要 OS 级写审计/fs 拦截，都不可用）⇒ 判绿等于把失败模式设为放过。
// ─────────────────────────────────────────────────────────────────────────────

test('D15 面级 backstop 三档可区分：leak-red / foreign-red / green（受控面构造）', () => {
  const dir = tmpRoot('d15');
  const ctlReal = path.join(dir, '.dsh', '.agent-presets');
  try {
    fs.mkdirSync(ctlReal, { recursive: true });
    const faceRoot = toPosix(path.relative(REAL_HOME, ctlReal));

    // ── D15-a：写我方产物（∈ ourRelSet）⇒ leak-red ──
    const oursRel = 'punky-preset/agent.cordis.yml';
    const beforeA = fingerprint(ctlReal);
    fs.mkdirSync(path.join(ctlReal, 'punky-preset'), { recursive: true });
    fs.writeFileSync(path.join(ctlReal, oursRel), 'ours', 'utf8');
    const afterA = fingerprint(ctlReal);
    const ourRelSet = new Set([faceRoot + '|' + oursRel]);
    const a = d3RealFaceVerdict({ before: [beforeA], after: [afterA], ourRelSet });
    assert.equal(a.status, 'leak-red', 'D15-a：我方产物出现在真实面 ⇒ leak-red；实测 ' + a.status);
    assert.equal(a.message.includes(oursRel), true, 'D15-a：消息须点名该 rel；实测 ' + a.message);
    assert.equal(a.hits.length, 1, 'D15-a：hits 须指出 1 条越界产物');

    // ── D15-b：写第三方产物（∉ ourRelSet）⇒ foreign-red，且消息带归因话术 ──
    const foreignRel = 'liangshen/README.md';
    const beforeB = fingerprint(ctlReal);
    fs.mkdirSync(path.join(ctlReal, 'liangshen'), { recursive: true });
    fs.writeFileSync(path.join(ctlReal, foreignRel), 'theirs', 'utf8');
    const afterB = fingerprint(ctlReal);
    const b = d3RealFaceVerdict({ before: [beforeB], after: [afterB], ourRelSet });
    assert.equal(b.status, 'foreign-red', 'D15-b：第三方写真实面 ⇒ foreign-red（**判红**，不是判绿）；实测 ' + b.status);
    assert.equal(b.message.includes('foreign'), true, 'D15-b：消息须标 foreign；实测 ' + b.message);
    assert.equal(b.message.includes('不可归因于本演示'), true, 'D15-b：消息须写明不可归因于本演示；实测 ' + b.message);
    assert.equal(b.hits.length, 0, 'D15-b：不得栽赃我方（hits=0）');

    // ── D15-c：面不变 + 归属全越界 ⇒ green ──
    const beforeC = fingerprint(ctlReal);
    const c = d3RealFaceVerdict({ before: [beforeC], after: [beforeC], ourRelSet });
    assert.equal(c.status, 'green', 'D15-c：逐面零变化 ⇒ green；实测 ' + c.status);
    // 归属必要条件（claimed 零写 + 每条 actual 落点越界）在此同时成立：
    assert.equal(attributionVerdict([], ctlReal).ok, true, 'D15-c：claimed 零写 ⇒ 归属自洽（必要条件）');

    // ── 合成断言：三档必须可区分 ──
    assert.notEqual(a.status, b.status, 'D15 合成：leak-red 与 foreign-red 必须不同（相同 ⇒ 归因没起作用 ⇒ 无鉴别力）');
    assert.notEqual(a.status, c.status, 'D15 合成：有变化与无变化必须不同');
    assert.notEqual(b.status, c.status, 'D15 合成：foreign 与 green 必须不同');

    // ── fail-closed：ourRelSet 不可用 ⇒ unknown-red（不得当成"没变化"）──
    const unknown = d3RealFaceVerdict({ before: [beforeC], after: [beforeC], ourRelSet: null });
    assert.equal(unknown.status, 'unknown-red', 'D15 附加：ourRelSet 不可用 ⇒ unknown-red（fail-closed）');

    process.stderr.write('[D15] a=' + a.status + ' b=' + b.status + ' c=' + c.status
      + ' distinguishable=' + (a.status !== b.status && a.status !== c.status && b.status !== c.status)
      + ' unknown=' + unknown.status + String.fromCharCode(10));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FU1-1 / FU1-2 根因修复的**可达构造**（批 `punky-isolation-rootfix-20261101` · lane `p0-digest`）
//   两条根因：① A3「只比 rel，不比内容」② face 级 digest 含 `mtimeMs` 而 `faceDiff` 只比内容。
//   下面三条只依赖纯函数 + 真实临时目录，**不触碰真实 home**、不依赖宿主状态。
// ══════════════════════════════════════════════════════════════════════════════

test('F1 【FU1-2】同内容不同 mtime ⇒ 判 same（旧实现 digest 含 mtimeMs ⇒ 判 different）', () => {
  const dir = tmpRoot('f1');
  try {
    writeRelFile(dir, path.join('a', 'x.txt'), 'hello');
    const before = fingerprint(dir);
    // 只推 mtime，内容逐字不变 —— 这正是「常驻宿主幂等重同步」的形态
    const t = new Date(Date.now() + 60000);
    fs.utimesSync(path.join(dir, 'a', 'x.txt'), t, t);
    const after = fingerprint(dir);

    assert.notEqual(before.files[0].mtimeMs, after.files[0].mtimeMs, '构造前提：mtime 确实变了');
    assert.equal(before.files[0].sha256, after.files[0].sha256, '构造前提：内容逐字未变');
    assert.equal(after.digest, before.digest, '内容口径：mtime 变化**不得**改变 digest（旧实现在此不同）');
    assert.deepEqual(faceDiff(before, after), { added: [], removed: [], changed: [] }, 'faceDiff 不得报告变化');
    const v = g2Verdict({ face: dir, before, after, after2: null, attributed: [] });
    assert.equal(v.status, 'green', '同内容不同 mtime ⇒ same（green）；实测=' + v.status);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F2 【FU1-1】同 rel 不同内容 ⇒ **不**归因为我方（旧实现只比 rel ⇒ 假泄漏 red）', () => {
  const dir = tmpRoot('f2');
  try {
    writeRelFile(dir, path.join('.dsh', 'x.json'), 'host-version-2'); // 真实面内容（宿主写的另一版本）
    const after = fingerprint(dir);
    const cur = after.files[0];
    const before = {
      root: dir, exists: true, count: 1, sumBytes: 4, digest: 'seed',
      files: [{ rel: cur.rel, size: 4, mtimeMs: 1, sha256: 'deadbeef' }],
    };
    // 我方（隔离根）在**同一 rel** 上的内容与真实面**不同**
    const v = g2Verdict({
      face: dir, before, after, after2: null,
      attributed: [{ kind: 'faceRel', rel: cur.rel, source: 'A3', sha256: 'cafebabe' }],
    });
    assert.notEqual(v.status, 'red', '内容不同 ⇒ **不得**判泄漏（旧实现命中 rel 即 red = 假泄漏）；实测=' + v.status);
    assert.equal(v.attribution.hits.length, 0, '不得计入 hits');
    assert.ok(v.attribution.unmatched.some((u) => u.reason === 'content-mismatch'),
      '内容不匹配必须**可见**（进 unmatched.content-mismatch，不静默吞掉）；实测=' + JSON.stringify(v.attribution.unmatched));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F3 【FU1-1】同 rel 同内容 ⇒ 判泄漏（内容判据仍咬得住）+ 变异：去掉 sha256 比较必红', () => {
  const dir = tmpRoot('f3');
  try {
    writeRelFile(dir, path.join('.dsh', 'x.json'), 'same-bytes');
    const after = fingerprint(dir);
    const cur = after.files[0];
    const before = {
      root: dir, exists: true, count: 1, sumBytes: 4, digest: 'seed',
      files: [{ rel: cur.rel, size: 4, mtimeMs: 1, sha256: 'deadbeef' }],
    };

    // ① 我方内容 == 真实面当前内容 ⇒ 真泄漏（判据是内容，不是路径）
    const hit = g2Verdict({
      face: dir, before, after, after2: null,
      attributed: [{ kind: 'faceRel', rel: cur.rel, source: 'A3', sha256: cur.sha256 }],
    });
    assert.equal(hit.status, 'red', '内容逐字相同 ⇒ 判泄漏；实测=' + hit.status);
    assert.equal(hit.attribution.hits.length >= 1, true, '同内容须计入 hits');

    // ② 变异 1：内容不同（sha256 改掉）⇒ 不归因（等价于 F2 的反向对照）
    const diff = g2Verdict({
      face: dir, before, after, after2: null,
      attributed: [{ kind: 'faceRel', rel: cur.rel, source: 'A3', sha256: 'f'.repeat(64) }],
    });
    assert.notEqual(diff.status, 'red', '内容不同 ⇒ 不归因；实测=' + diff.status);

    // ③ 变异 2（= 旧实现形态）：条目不带 sha256 ⇒ 只比 rel ⇒ 路径命中即 red。
    //    这条就是被修掉的**假泄漏**：把 sha256 比较去掉，F2 的 `notEqual(red)` 必红。
    const legacy = g2Verdict({
      face: dir, before, after, after2: null,
      attributed: [{ kind: 'faceRel', rel: cur.rel, source: 'A1' }],
    });
    assert.equal(legacy.status, 'red', '变异验证：去掉 sha256 比较（只比 rel）⇒ 判泄漏（F2 会因此变红）');
    process.stderr.write('[F3] hit=' + hit.status + ' diff=' + diff.status + ' legacy=' + legacy.status
      + String.fromCharCode(10));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// I1–I4 写入拦截（lane `p1-intercept`）
//
// 【本段是**纯新增**】只追加在文件末尾，不改动上方任何既有用例（并行 lane `p2-idle-window`
//   / `p3-migrate` 会继续改本文件，故新增段一律独立命名空间 I*，不与既有 G*/D*/F* 交叉）。
//
// 与 G3 的差别（本段存在的理由）：G3 靠「日志自报落点 + 隔离根文件数增长」做事后归属 ⇒
//   ① 日志没覆盖的写点抓不到；② `rm`/`unlink` 不增长计数 ⇒ 抓不到。本段改用**因果拦截**
//   （`test/helpers/write-intercept.mjs`，由 preload 在**被测代码 import 之前**安装），
//   按目标 realpath 判 ⊆ 隔离根 ⇒ 写与删同一条判据。
//
// 安全性：所有构造都在 `os.tmpdir()` 下的**独立空目录**里造（`tmpRoot('icpt-*')`），
//   不写、不删任何真实用户资产面；拦截根由 isolated-home preload 现建（每个子进程一个）。
// ══════════════════════════════════════════════════════════════════════════════════════

const INTERCEPT_PRELOAD = path.join(HERE, 'helpers', 'write-intercept.preload.mjs');

/** 受害探针源码：preload 已装好拦截**之后**才执行；`named` 模式走**命名导入**，用来证命名绑定也被包住。 */
function interceptProbeSrc() {
  return [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "function countUnder(root) {",
    "  let n = 0;",
    "  const walk = (d) => {",
    "    let ents = [];",
    "    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }",
    "    for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else n += 1; }",
    "  };",
    "  walk(root);",
    "  return n;",
    "}",
    "const ROOT = process.env.PUNKY_TEST_ISOLATED_HOME;",
    "const OUT = process.env.PUNKY_PROBE_OUT;",
    "const MODE = process.env.PUNKY_PROBE_MODE;",
    "const report = { mode: MODE, root: ROOT, beforeCount: countUnder(ROOT), threw: false, err: null };",
    "try {",
    "  if (MODE === 'write') { fs.writeFileSync(OUT, 'leak'); }",
    "  else if (MODE === 'rm') { fs.rmSync(OUT); }",
    "  else if (MODE === 'legit') { fs.writeFileSync(path.join(ROOT, 'legit.txt'), 'ok'); }",
    "  else if (MODE === 'named') { const named = await import('node:fs'); named.writeFileSync(OUT, 'named-leak'); }",
    "  else { throw new Error('unknown mode: ' + MODE); }",
    "} catch (e) { report.threw = true; report.err = String((e && e.message) || e); }",
    "report.afterCount = countUnder(ROOT);",
    "process.stdout.write('@@PROBE@@' + JSON.stringify(report) + '@@END@@');",
  ].join('\n');
}

/** 在「双 preload（隔离 + 写入拦截）」的子进程里跑一次探针，返回 {probe, intercept, out, outside}。 */
function interceptRun(tag, mode) {
  const dir = tmpRoot('icpt-' + tag);
  const outside = path.join(dir, 'outside-target');       // **根外**目标：独立空目录里的临时文件（非真实资产面）
  fs.writeFileSync(outside, 'seed', 'utf8');              // 预建 ⇒ rm 模式有东西可删
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, interceptProbeSrc(), 'utf8');
  const reportFile = path.join(dir, 'intercept-report.txt');
  const env = {
    PUNKY_PROBE_OUT: outside,
    PUNKY_PROBE_MODE: mode,
    PUNKY_INTERCEPT_REPORT: reportFile,
    // 只有父进程自己已隔离时才显式给根；否则留给 preload 回落 PUNKY_TEST_ISOLATED_HOME（子进程现建）
    ...(ISOLATED ? { PUNKY_INTERCEPT_ROOT: ISOLATED } : {}),
  };
  const r = spawnToFiles(process.execPath, [
    '--import', pathToFileURL(PRELOAD).href,
    '--import', pathToFileURL(INTERCEPT_PRELOAD).href,
    probe,
  ], env, dir);
  const pick = (text) => {
    const m = String(text ?? '').match(/@@(?:PROBE|REPORT)@@([\s\S]*?)@@END@@/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };
  const probeReport = pick(r.out);
  const interceptReport = pick(readIfExists(reportFile));
  return { dir, outside, out: r.out, status: r.status, probe: probeReport, intercept: interceptReport };
}

test('I1【写入拦截】直接写**根外**路径 ⇒ 拦截命中且红（G3 的「文件数增长」判据抓不到）', () => {
  const run = interceptRun('write', 'write');
  try {
    assert.ok(run.intercept, '拦截报告必须在场（缺报告 ⇒ 拦截没装上，判红）；子进程输出：' + run.out.slice(0, 600));
    const v = (run.intercept.violations ?? []).find((x) => x.api === 'writeFileSync' && x.verdict === 'outside-root');
    assert.ok(v, '越界写必须被拦截并记为 outside-root；实际 violations=' + JSON.stringify(run.intercept.violations));
    assert.equal(fs.existsSync(run.outside), true, '拦截是「记录并放行」语义：文件确实被写出来了（不是靠不写来假装通过）');
    // G3 盲区证据：这次写**没有**让隔离根文件数增长，也没有任何日志自报落点 ⇒ 增长型判据看不见它
    assert.equal(run.probe.afterCount, run.probe.beforeCount,
      'G3 盲区取证：根外写不改变隔离根计数 ⇒ 「文件数应增长」型判据对它无判别力');
    process.stderr.write('[I1] violation=' + JSON.stringify(v) + String.fromCharCode(10));
  } finally {
    fs.rmSync(run.dir, { recursive: true, force: true });
  }
});

test('I2【写入拦截】rm **根外**路径 ⇒ 同样被抓到（旧 G3 的核心盲区：删除不增长计数）', () => {
  const run = interceptRun('rm', 'rm');
  try {
    assert.ok(run.intercept, '拦截报告必须在场；子进程输出：' + run.out.slice(0, 600));
    const v = (run.intercept.violations ?? []).find((x) => x.api === 'rmSync' && x.verdict === 'outside-root');
    assert.ok(v, '越界删除必须被拦截并记为 outside-root；实际 violations=' + JSON.stringify(run.intercept.violations));
    assert.equal(fs.existsSync(run.outside), false, '删除确实发生（拦截是取证面，不是阻断面）');
    assert.equal(run.probe.afterCount, run.probe.beforeCount,
      'G3 盲区取证：删除**只会减少**文件数、永不增长 ⇒ 「隔离根计数增长」判据对删除型写点结构性不可达');
    process.stderr.write('[I2] violation=' + JSON.stringify(v) + String.fromCharCode(10));
  } finally {
    fs.rmSync(run.dir, { recursive: true, force: true });
  }
});

test('I3【写入拦截】正常路径零误报：根内写 ⇒ 0 violation 且记为 inside-root', () => {
  const run = interceptRun('legit', 'legit');
  try {
    assert.ok(run.intercept, '拦截报告必须在场；子进程输出：' + run.out.slice(0, 600));
    assert.deepEqual(run.intercept.violations, [], '根内写不得报越界（零误报）；实际=' + JSON.stringify(run.intercept.violations));
    assert.equal((run.intercept.allowed ?? []).some((x) => x.verdict === 'inside-root'), true,
      '根内写应被记为 inside-root（证明拦截确实经过、不是没装上）');
    assert.equal(fs.existsSync(path.join(run.probe.root, 'legit.txt')), true, '根内写确实落地');
  } finally {
    fs.rmSync(run.dir, { recursive: true, force: true });
  }
});

test('I4【写入拦截】覆盖清单 + **生产面形态守卫**：lib/** 不得以命名导入取变更型 fs 入口', () => {
  // 机制事实（I4 首版就是在这里红的，红得对）：
  //   ES 命名导入在 import 时**绑定到原始函数引用** ⇒ 包裹 `fs.writeFileSync`（模块对象属性）
  //   改不了已绑定的局部名 ⇒ 用命名导入的调用点**结构上不可被拦**。
  //   故「可被拦」的真正前提 = 生产代码一律走**命名空间属性访问**（`fs.writeFileSync(...)`）。
  //   ⇒ 本用例把该前提做成**静态守卫**（任一新文件用命名导入取变更型入口即红）；
  //     运行时侧「命名空间调用确实被拦」由 I1/I2/I3 承担（同一份拦截报告）。
  const run = interceptRun('static', 'legit');
  try {
    assert.ok(run.intercept, '拦截报告必须在场；子进程输出：' + run.out.slice(0, 600));
    const covered = run.intercept.covered ?? [];
    const MUST_COVER = ['fs.writeFileSync', 'fs.appendFileSync', 'fs.mkdirSync', 'fs.rmSync',
      'fs.unlinkSync', 'fs.renameSync', 'fs.copyFileSync', 'fs.openSync'];
    const missing = MUST_COVER.filter((k) => !covered.includes(k));
    assert.deepEqual(missing, [], '变更型入口清单不得缺项（缺一即该形态的写点整类不被拦）；缺=' + JSON.stringify(missing));
    assert.equal(covered.includes('fs.promises.writeFile'), true, 'promise 面亦须覆盖');
  } finally {
    fs.rmSync(run.dir, { recursive: true, force: true });
  }

  // ── 静态守卫：生产面形态（本轮把 5 处命名导入改为命名空间后应转绿）──
  const MUTATING_NAMES = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rm', 'unlinkSync',
    'rmdirSync', 'renameSync', 'copyFileSync', 'cpSync', 'symlinkSync', 'linkSync', 'truncateSync', 'openSync'];
  const offenders = [];
  const walkLib = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules' && ent.name !== '.tsbuild') walkLib(p); continue; }
      if (!/\.(js|ts)$/.test(ent.name) || /\.d\.ts$/.test(ent.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:fs['"]/g)) {
        const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        const bad = names.filter((n) => MUTATING_NAMES.includes(n));
        if (bad.length > 0) offenders.push(path.relative(PACKAGE_ROOT, p).split(path.sep).join('/') + ' → ' + bad.join(','));
      }
    }
  };
  walkLib(path.join(PACKAGE_ROOT, 'lib'));
  assert.deepEqual(offenders, [],
    'lib/** 不得以命名导入取变更型 fs 入口（命名导入结构性不可被写入拦截）——请改 `import fs from \'node:fs\'` + `fs.xxx(...)`；违规：'
    + JSON.stringify(offenders));
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 【p2b-idle-window · FU-1 三件套之③】**空转窗校准**：测量外部写者的自然变化率（**不是等待**）
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// ## 为什么需要它
// 「W1 的变化全都能归因于我方」这句话，只有在**外部写者本来就不怎么写**时才有意义。
//   不做校准就只能「假设」外部安静；做了校准才能**测量**它，并把它从 W1 里扣掉。
//
// ## 两个窗（**窗长都来自真实工作，零 sleep**）
//   · **W0 窗（只读）**：`A = snapshotReal()` → 对每个 REAL_FACE 跑一次 `walkFiles`（与 apply 窗等量的
//     全量遍历、**不写任何东西**）→ `B = snapshotReal()`；
//   · **W1 窗（写）**：复用**既有 apply 驱动** `mechanismRun()`（本文件 `:572`）——它返回的
//     `realBefore`/`realAfter` 正是其内部那次 apply 的前后快照。
//   ⇒ 两窗时长分别由「一次全量遍历」与「一次真实 apply」决定，**不含任何固定等待**。
//
// ## 断言形态（集合差为空，不依赖时长）
//   `⋃W1 \ (⋃W0 ∪ 我方写点) = ∅`
//
// ## ⚠ 诚实边界（不得读作「已覆盖」）
//   · **我方写点 = manifest 声明的写入面前缀**（`assetMap()` 的 `targetPrefixRel`）= **允许面（上界）**，
//     不是"本次实际写到的文件清单"。方向偏安全（不会因多认合法面而假红），但它**不能**独立证明
//     「没有多写」——那由 G2 指纹全等 + G3 归属断言承担。
//   · `p0-digest` 已把 digest 改成 **sha256 内容口径**（去 `mtimeMs`）⇒ W0 里出现项只能是**真实内容变化**。
test('P2b 空转窗校准：W0 实测外部变化率 ＋ W1 ⊆ (W0 ∪ 我方写点)（无 sleep）', () => {
  // ── 我方写点（**声明面上界**）：manifest 的 targetPrefixRel 按面根归并 ──
  const oursByFaceRoot = new Map();
  for (const a of assetMap()) {
    if (!a.faceRootRel || !a.targetPrefixRel) continue;
    if (!oursByFaceRoot.has(a.faceRootRel)) oursByFaceRoot.set(a.faceRootRel, new Set());
    oursByFaceRoot.get(a.faceRootRel).add(a.targetPrefixRel);
  }
  const rootRelOfFace = (facePath) => toPosix(path.relative(REAL_HOME, facePath));
  const isOurs = (facePath, rel) => {
    const prefixes = oursByFaceRoot.get(rootRelOfFace(facePath));
    if (!prefixes) return false;
    const r = toPosix(rel);
    for (const p of prefixes) if (r === p || r.startsWith(p + '/')) return true;
    return false;
  };

  // ── W0 窗：只读全量遍历（等量工作，不写）──
  const A = snapshotReal();
  for (const f of REAL_FACES) walkFiles(f.path);   // 只读：与 apply 窗可比的真实耗时
  const B = snapshotReal();
  const w0 = REAL_FACES.map((f, i) => faceDiff(A[i], B[i]));
  const w0Items = w0.flatMap((d, i) => [...d.added, ...d.removed, ...d.changed]
    .map((rel) => ({ face: REAL_FACES[i], rel })));

  // ── W1 窗：复用既有 apply 驱动（mechanismRun 内的 realBefore → realAfter）──
  const mech = mechanismRun();
  const w1 = REAL_FACES.map((f, i) => faceDiff(mech.realBefore[i], mech.realAfter[i]));
  const w1Items = w1.flatMap((d, i) => [...d.added, ...d.removed, ...d.changed]
    .map((rel) => ({ face: REAL_FACES[i], rel })));

  // ── 实测数字（**验收 2**：W0 是可读数字，不是被断言的常量）──
  const keyOf = (x) => rootRelOfFace(x.face) + '|' + toPosix(x.rel);
  const w0Keys = new Set(w0Items.map(keyOf));
  const oursItems = w1Items.filter((x) => isOurs(x.face, x.rel));
  const unaccounted = w1Items.filter((x) => !w0Keys.has(keyOf(x)) && !isOurs(x.face, x.rel));
  const w0Ours = w0Items.filter((x) => isOurs(x.face, x.rel));
  console.log('[P2b] W0 实测：' + w0Items.length + ' 项变化（其中落在我方声明面内 ' + w0Ours.length
    + ' 项）｜W1：' + w1Items.length + ' 项（我方面内 ' + oursItems.length + '）｜未归置：' + unaccounted.length
    + '｜W0 明细=' + JSON.stringify(w0Items.map(keyOf)));

  // ── 断言（**验收 3**：集合差为空，不依赖时长）──
  assert.deepEqual(unaccounted.map(keyOf), [],
    'W1 \ (W0 ∪ 我方写点) 必须为空 —— apply 窗里的每一处变化，要么空转窗里本来就有（外部写者），'
    + '要么落在我方声明的写入面内。未归置项：' + JSON.stringify(unaccounted.map(keyOf))
    + '｜W0 实测=' + JSON.stringify([...w0Keys]));
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 【p3-migrate · 2026-11-01】面集迁移的**三条验收**（纯新增段，不改上方任何用例）
//
//   ① `REAL_FACES` 非空证明（防「空面真空」——G2 的 map 产出空数组会变成恒真）；
//   ② 真实引擎根**写入拦截**探针（`~/.dsh/punky-preset` 此前零覆盖；FU1-4）；
//   ③ 判别力变异验证（抽 2 条既有断言：D4 活宿主面自检 / G2 零变化指纹）。
//
//   ⚠ p3-b 的安全性：子进程用 `PUNKY_INTERCEPT_THROW=1` ⇒ p1 拦截器**先记录再抛**，
//     抛出发生在调用原始 `writeFileSync` **之前** ⇒ 真实引擎根**不会产生任何文件**。
//     父进程仍以 try/finally 兜底清理同名探针（防拦截未生效时留残）。
// ══════════════════════════════════════════════════════════════════════════════════════════

test('P3-a REAL_FACES 非空证明：迁移后断言面不得为空（给实际清单）', () => {
  assert.ok(Array.isArray(REAL_FACES) && REAL_FACES.length >= 1,
    'REAL_FACES 不得为空——空面会让 G2 的 REAL_FACES.map(...) 产出 [] ⇒ 断言恒真、测试体面消失');
  assert.deepEqual(REAL_FACES, [path.join(REAL_HOME, '.dsh', '.agent-presets')],
    'REAL_FACES 实际清单（唯一保留面 = .agent-presets：唯一写者 syncAssets + 内容幂等 + p0 内容口径 digest）；实测='
    + JSON.stringify(REAL_FACES));
  // 与快照函数对齐（防「面集改了但 snapshotReal 没跟上」的静默错位）
  const snap = snapshotReal();
  assert.equal(snap.length, REAL_FACES.length, 'snapshotReal() 长度必须与 REAL_FACES 一致');
  assert.ok(snap.every((s) => s && typeof s.digest === 'string'),
    '每个真实面快照都必须带内容口径 digest（p0-digest）');
  // 与 LIVE 面互斥（D7 同判据，这里再钉一次「迁移后不双声明」）
  const live = new Set(LIVE_FACES.map((f) => normPath(f.path)));
  assert.deepEqual(REAL_FACES.filter((p) => live.has(normPath(p))), [],
    'REAL 与 LIVE 不得双声明：' + JSON.stringify(REAL_FACES));
  assert.deepEqual(liveFaceJustified(REAL_FACES, LIVE_FACES).offenders, [],
    'LIVE_FACES 三要素/兜底必须齐备（含新迁入的技能面 attributionFallback 与引擎根 collateralGate）');
});

/** 引擎根探针：子进程在 throw 模式下写真实引擎根，返回 {probe, intercept, target, out}。 */
function engineRootProbeRun() {
  const dir = tmpRoot('p3-engine');
  const target = path.join(REAL_ENGINE_ROOT, '.p3-intercept-probe-' + process.pid + '-' + Date.now() + '.txt');
  const probe = path.join(dir, 'engine-probe.mjs');
  fs.writeFileSync(probe, [
    "import fs from 'node:fs';",
    "const report = { target: process.env.PUNKY_PROBE_ENGINE_TARGET, threw: false, err: null };",
    "try { fs.writeFileSync(report.target, 'p3-leak'); } catch (e) { report.threw = true; report.err = String((e && e.message) || e); }",
    "process.stdout.write('@@PROBE@@' + JSON.stringify(report) + '@@END@@');",
  ].join('\n'), 'utf8');
  const reportFile = path.join(dir, 'intercept-report.txt');
  const env = {
    PUNKY_PROBE_ENGINE_TARGET: target,
    PUNKY_INTERCEPT_REPORT: reportFile,
    PUNKY_INTERCEPT_THROW: '1',
    ...(ISOLATED ? { PUNKY_INTERCEPT_ROOT: ISOLATED } : {}),
  };
  const r = spawnToFiles(process.execPath, [
    '--import', pathToFileURL(PRELOAD).href,
    '--import', pathToFileURL(INTERCEPT_PRELOAD).href,
    probe,
  ], env, dir);
  const pick = (text) => {
    const m = String(text ?? '').match(/@@(?:PROBE|REPORT)@@([\s\S]*?)@@END@@/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };
  return { dir, target, out: r.out, probe: pick(r.out), intercept: pick(readIfExists(reportFile)) };
}

test('P3-b 引擎根写入拦截：写真实 ~/.dsh/punky-preset 必须被抓（此前零覆盖）+ 拦截先于落盘', () => {
  const run = engineRootProbeRun();
  try {
    assert.ok(run.intercept, '拦截报告必须在场（缺报告 ⇒ 拦截没装上，判红）；子进程输出：' + run.out.slice(0, 600));
    const hit = (run.intercept.violations ?? []).find((x) => x.verdict === 'outside-root'
      && normPath(String(x.resolvedPath ?? '')).startsWith(normPath(REAL_ENGINE_ROOT)));
    assert.ok(hit, '写真实引擎根必须被记录为 outside-root（resolvedPath 落在 ' + REAL_ENGINE_ROOT + ' 之下）；实际='
      + JSON.stringify(run.intercept.violations));
    assert.equal(run.probe.threw, true, 'throw 模式下探针必须收到拦截异常（证明拦截在调用栈上真的生效）；实际='
      + JSON.stringify(run.probe));
    assert.equal(fs.existsSync(run.target), false,
      '拦截必须先于落盘：真实引擎根不得出现探针文件（否则本探针本身就污染了真实面）');
    process.stderr.write('[P3-b] hit=' + JSON.stringify(hit) + String.fromCharCode(10));
  } finally {
    try { if (fs.existsSync(run.target)) fs.rmSync(run.target, { force: true }); } catch { /* 兜底清理 */ }
    fs.rmSync(run.dir, { recursive: true, force: true });
  }
});

test('P3-c 判别力变异（2 条既有断言）：迁移若回退 / 指纹判据若失效 ⇒ 必红', () => {
  // ── 变异 1（既有断言：D4 活宿主面自检 `liveFaceExcluded`）──
  //   把已迁出的技能面**塞回**「零变化」断言面 ⇒ 该既有自检必须判红（这就是迁移的必要性证明）
  const skillsFace = path.join(REAL_HOME, '.agents', 'skills');
  const reverted = liveFaceExcluded([...REAL_FACES, skillsFace]);
  assert.equal(reverted.ok, false, '变异 1：把已迁出的技能面塞回 REAL 断言面 ⇒ 活宿主面自检必须判红');
  assert.deepEqual(reverted.offenders, [skillsFace], '变异 1：自检须**精确点名**被误纳的面');

  // ── 变异 2（既有断言：G2 真实面零变化指纹）──
  //   在受控临时面上造「同 rel、内容变化」⇒ g2Verdict 必须 red；对照组同内容不同 mtime 必须 green（p0 内容口径）
  const dir = tmpRoot('p3-mut');
  try {
    const face = dir;
    writeRelFile(face, path.join('.dsh', 'p3.json'), 'v1');
    const before = fingerprint(face);
    writeRelFile(face, path.join('.dsh', 'p3.json'), 'v2-changed');
    const changed = fingerprint(face);
    const settled = fingerprint(face);   // 收敛后的第二次读数（**不 sleep**：受控临时面无外部写者）
    const relPosix = toPosix(path.join('.dsh', 'p3.json'));
    const changedSha = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(face, '.dsh', 'p3.json'))).digest('hex');
    // 归因项形状照既有先例（F3：`{kind:'faceRel', rel, source:'A3', sha256}`）——
    //   不传 attributed 会落到 inconclusive{unattributable}（D6 口径），那是「不可归因」而不是「判据失效」。
    const attributed = [{ kind: 'faceRel', rel: relPosix, source: 'A3', sha256: changedSha }];
    const red = g2Verdict({ face, before, after: changed, after2: settled, attributed });
    assert.equal(red.status, 'red', '变异 2：内容真变 + 可归因 ⇒ G2 判据必须 red（否则「零变化」是恒真断言）；实测='
      + red.status + ' subclass=' + (red.subclass ?? '-'));
    assert.deepEqual(red.delta.changed.map(toPosix), [relPosix], '变异 2：red 须点名变化的相对路径（posix 归一后比较）');
    // 反向对照：内容不变、仅 mtime 前进 ⇒ 必须 green（证明 p0 的内容口径没被回退成 mtime 口径）
    const green = g2Verdict({ face, before: changed, after: settled, after2: settled, attributed });
    assert.equal(green.status, 'green', '变异 2 对照：内容不变（仅时间前进）必须 green；实测=' + green.status);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
