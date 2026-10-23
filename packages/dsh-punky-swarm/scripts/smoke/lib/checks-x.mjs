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

// X 组 · 只读仓面 + 真机面：H-11 … H-14（部分 SKIP-able；SKIP 单列、不算 pass）。
//
// ⚠ **边界声明（必须随读数一起传播）**：H-14 的「改完忘了重启」判据 = **活体进程启动时间 vs 部署面最新
//   mtime** ⇒ 这是**时间序推断，不是内容比对**。它能检出「进程早于改动」，不能证明「进程内加载的模块内容
//   等于盘上内容」。升级为内容比对需要宿主暴露「已加载模块摘要」端点（`lib/api.js` 无该字段，不在本批写域）。

import fs from 'node:fs';
import path from 'node:path';
import { expect, listFiles, pwshJson, sha256File, skip } from './support.mjs';

/** `check-guidance-sync.mjs` 的同一份五件清单（repo ↔ live 必须逐字同 sha）。 */
const SYNC_FILES = [
  'agent.cordis.yml',
  path.join('references', 'discipline.md'),
  path.join('references', 'manager.md'),
  'preset.yml',
  'asset-manifest.json',
];

// ── H-11 零消费点三条抽样（逐行分类，禁用命中计数）─────────────────────────────

const IMPORT_VERIFY_GATE = /from\s+['"][^'"]*verify\/gate(?:\.js)?['"]/;
const CREATE_COMPLETION_CALL = /createCompletionGate\s*\(/;

function isCommentLine(text) {
  const t = text.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

/** 逐行分类工具（纯函数，供阳性/阴性对照复用）。 */
function classifyLines(lines) {
  const importVerifyGate = [];
  const identitySameLine = [];
  const completionGateCalls = [];
  for (const row of lines) {
    const { file, no, text } = row;
    if (isCommentLine(text)) {
      // 注释行**不参与**可执行面判定（但它仍参与 import 面判定：注释掉的 import 也不算消费点）
      continue;
    }
    if (IMPORT_VERIFY_GATE.test(text)) importVerifyGate.push(file + ':' + no + ' ' + text.trim());
    if (/'identity'/.test(text) && /readCapability/.test(text)) identitySameLine.push(file + ':' + no + ' ' + text.trim());
    if (CREATE_COMPLETION_CALL.test(text)
      && !/export\s+function\s+createCompletionGate/.test(text)
      && !/^\s*import\b/.test(text)) completionGateCalls.push(file + ':' + no + ' ' + text.trim());
  }
  return { importVerifyGate, identitySameLine, completionGateCalls };
}

function h11(sm) {
  const libFiles = listFiles(path.join(sm.repoRoot, 'lib')).filter((f) => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.mjs'));
  expect(libFiles.length > 0, '阳性对照失败：lib/ 下扫不到任何 .js/.ts（读端坏了）');
  const lines = [];
  let scanned = 0;
  for (const abs of libFiles) {
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    scanned += 1;
    const rel = path.relative(sm.repoRoot, abs).split(path.sep).join('/');
    const parts = text.split(/\r?\n/);
    for (let i = 0; i < parts.length; i += 1) lines.push({ file: rel, no: i + 1, text: parts[i] });
  }
  expect(scanned === libFiles.length, '阳性对照失败：有文件读不进来（' + scanned + '/' + libFiles.length + '）');

  // ── 阳性对照：同一分类器对**已知存在**的模式必须有命中（否则「0 命中」可能来自读端失效）──
  const sanity = classifyLines([
    { file: 'synthetic.js', no: 1, text: "import { createCompletionGate } from './verify/gate.js';" },
    { file: 'synthetic.js', no: 2, text: "const gate = createCompletionGate({ config });" },
    { file: 'synthetic.js', no: 3, text: "const x = readCapability(config, 'identity');" },
  ]);
  expect(sanity.importVerifyGate.length === 1 && sanity.completionGateCalls.length === 1 && sanity.identitySameLine.length === 1,
    '阳性对照失败：分类器对合成样例漏判（' + JSON.stringify(sanity) + '）');
  // ── 阴性对照：注释行/定义行不得被算成消费点 ──
  const negative = classifyLines([
    { file: 'synthetic.js', no: 1, text: '  // import { x } from "./verify/gate.js";' },
    { file: 'synthetic.js', no: 2, text: 'export function createCompletionGate({ config = {} } = {}) {' },
  ]);
  expect(negative.importVerifyGate.length === 0 && negative.completionGateCalls.length === 0,
    '阴性对照失败：注释行/定义行被误判为消费点（' + JSON.stringify(negative) + '）');

  const real = classifyLines(lines);
  const problems = [];
  if (real.importVerifyGate.length !== 0) problems.push('lib/ 下仍有 `verify/gate` import：' + real.importVerifyGate.length + ' 处 → ' + real.importVerifyGate.slice(0, 3).join(' | '));
  if (real.identitySameLine.length !== 0) problems.push("`'identity'` 与 readCapability 同行出现：" + real.identitySameLine.length + ' 处 → ' + real.identitySameLine.slice(0, 3).join(' | '));
  if (real.completionGateCalls.length !== 0) problems.push('createCompletionGate 可执行调用：' + real.completionGateCalls.length + ' 处 → ' + real.completionGateCalls.slice(0, 3).join(' | '));
  expect(problems.length === 0, '接线状态漂移（评估结论可能已过期，需更新台账）：\n  ' + problems.join('\n  '));
  return '扫 ' + scanned + ' 文件 / ' + lines.length + ' 行：verify/gate import=0 · identity+readCapability 同行=0 · createCompletionGate 可执行调用=0'
    + '（分类器已过阳性 + 阴性双对照）';
}

// ── H-12 构建新鲜度：lib/**/*.ts 与同名 .js 的 mtime ────────────────────────────

/** 扫 `dir` 下的 ts/js 同名配对（`dir` = `lib/` 或阳性对照用的夹具目录）。 */
function stalePairsIn(dir) {
  const pairs = [];
  const tsFiles = listFiles(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  for (const ts of tsFiles) {
    const js = ts.slice(0, -3) + '.js';
    if (!fs.existsSync(js)) continue;
    const mTs = fs.statSync(ts).mtimeMs;
    const mJs = fs.statSync(js).mtimeMs;
    pairs.push({ ts, js, mTs, mJs, stale: mJs < mTs });
  }
  return pairs;
}

function h12(sm) {
  // ── 阳性对照：合成一对「ts 比 js 新」的文件必须被判为 stale（判据可达）──
  const probeDir = path.join(sm.isoRoot, 'h12-probe');
  sm.ledger.mkdirp(probeDir);
  const tsProbe = path.join(probeDir, 'a.ts');
  const jsProbe = path.join(probeDir, 'a.js');
  sm.ledger.writeFile(jsProbe, 'x');
  sm.ledger.writeFile(tsProbe, 'y');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(jsProbe, old, old);
  const probe = stalePairsIn(probeDir);
  expect(probe.length === 1 && probe[0].stale === true, '阳性对照失败：ts 比 js 新却未判为 stale（判据不可达）');
  // ── 阴性对照：js 比 ts 新 ⇒ 不 stale ──
  //   ⚠ 用「未来 +60s」而不是 `new Date()`：`fs.utimesSync` 的时间落盘精度可能粗于文件写入的 mtime
  //   （实测本机出现「设为 now 但不成立」⇒ 判据自带 flake）。留 60s 余量是有意为之，且不改变判据语义
  //   （判据只比大小，不比真实时刻）。
  fs.utimesSync(jsProbe, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  const probe2 = stalePairsIn(probeDir);
  expect(probe2.length === 1 && probe2[0].stale === false, '阴性对照失败：js 比 ts 新却仍判 stale');

  const pairs = stalePairsIn(path.join(sm.repoRoot, 'lib'));
  expect(pairs.length > 0, '阳性对照失败：lib/ 下找不到任何 ts/js 配对（判据空跑 = 假绿）');
  const stale = pairs.filter((p) => p.stale);
  if (stale.length === 0) return '配对 ' + pairs.length + ' 组全部新鲜（mtime(js) ≥ mtime(ts)）';
  const detail = stale.slice(0, 5).map((p) => path.relative(sm.repoRoot, p.js).split(path.sep).join('/')
    + '（js 早于 ts ' + Math.round((p.mTs - p.mJs) / 1000) + 's）').join(' | ');
  if (sm.allowStaleBuild) {
    skip('改 .ts 未 npm run build（' + stale.length + '/' + pairs.length + ' 组）+ --allow-stale-build 显式豁免 ⇒ SKIP 不算 pass：' + detail);
  }
  throw new Error('改 .ts 未 `npm run build` ⇒ 运行期跑旧 .js（' + stale.length + '/' + pairs.length + ' 组）：' + detail
    + ' —— 修法固定：`npm run build`（或显式 --allow-stale-build 记为 SKIP）');
}

// ── H-13 真实 home 下的准则面五件同 sha · SKIP-able ─────────────────────────────

function h13(sm) {
  if (sm.noLive) skip('--no-live：跳过真实 home 准则面（repo↔live 面），不算 pass');
  const liveDir = path.join(sm.realHome, '.dsh', '.agent-presets', 'punky-preset');
  if (!fs.existsSync(liveDir)) skip('真实 home 无 live preset 目录（' + liveDir + '）⇒ 双层面不可判，不算 pass');
  const repoDir = path.join(sm.repoRoot, 'presets', 'punky-preset');

  // ── 阳性对照：探针能读到 repo 侧五件（缺一件说明本判据的分母就不对）──
  for (const rel of SYNC_FILES) {
    expect(fs.existsSync(path.join(repoDir, rel)), '阳性对照失败：repo 侧缺 ' + rel + '（判据分母不全）');
  }
  // ── 阴性对照：不存在的相对路径必须判为「缺」──
  let absentDetected = false;
  try { sha256File(path.join(liveDir, 'agent.smoke-absent.yml')); } catch { absentDetected = true; }
  expect(absentDetected, '阴性对照失败：不存在的 live 文件被判为可读');

  const rows = [];
  const problems = [];
  for (const rel of SYNC_FILES) {
    const repoAbs = path.join(repoDir, rel);
    const liveAbs = path.join(liveDir, rel);
    if (!fs.existsSync(liveAbs)) { problems.push(rel + '：live 侧缺失（asset 同步未落 / 被删）'); continue; }
    const a = sha256File(repoAbs);
    const b = sha256File(liveAbs);
    if (a !== b) problems.push(rel + '：sha 不同（repo=' + a.slice(0, 12) + ' live=' + b.slice(0, 12) + '）');
    rows.push(rel + '=' + a.slice(0, 12));
  }
  expect(problems.length === 0, 'guidance 双层面漂移（repo ↔ live 五件必须同 sha）：\n  ' + problems.join('\n  '));
  return '五件同 sha（' + rows.join(' · ') + '）· live=' + liveDir;
}

// ── H-14 活体宿主新鲜度（时间序推断）· SKIP-able ───────────────────────────────

const LIVE_CMD = /dsh-punky-swarm|profiles[\\/]desktop|DSH Desktop\.exe/i;

const ENUM_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|electron|DSH' } |",
  "Select-Object ProcessId,Name,@{n='start';e={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' } }},CommandLine |",
  'ConvertTo-Json -Compress',
].join(' ');

function newestSurfaceMtime(repoRoot) {
  const surfaces = [path.join(repoRoot, 'package.json'), path.join(repoRoot, 'lib'), path.join(repoRoot, 'presets'), path.join(repoRoot, 'skills')];
  let newestMs = 0;
  let newestPath = '';
  let count = 0;
  for (const surface of surfaces) {
    if (!fs.existsSync(surface)) continue;
    const files = fs.statSync(surface).isDirectory() ? listFiles(surface) : [surface];
    for (const abs of files) {
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      count += 1;
      if (stat.mtimeMs > newestMs) { newestMs = stat.mtimeMs; newestPath = path.relative(repoRoot, abs).split(path.sep).join('/'); }
    }
  }
  return { newestMs, newestPath, count };
}

/**
 * 新鲜度比对**纯函数**（H-14 的唯一判据实现）：候选进程启动时间 vs 部署面最新 mtime。
 * 抽成纯函数是为了给它**阳性/阴性对照**（合成输入即可判别，不必等真出现「旧进程」才能验证判据是否可用）。
 * @param {Array<{ProcessId?: number|string, Name?: string, start?: string}>} candidates
 * @param {number} newestMs
 */
function compareFreshness(candidates, newestMs) {
  const stale = [];
  const fresh = [];
  const unknown = [];
  for (const row of candidates) {
    const startMs = Date.parse(String(row?.start ?? ''));
    if (!Number.isFinite(startMs)) { unknown.push(row); continue; }
    const label = 'pid=' + String(row?.ProcessId ?? '?') + ' (' + String(row?.Name ?? '?') + ')';
    if (startMs < newestMs) stale.push(label + ' 启动 ' + new Date(startMs).toISOString() + ' 早于最新改动 ' + new Date(newestMs).toISOString());
    else fresh.push(label + ' 启动 ' + new Date(startMs).toISOString());
  }
  return { stale, fresh, unknown };
}

function h14(sm) {
  const tag = '（**时间序推断，不是内容比对**：判据 = 活体进程启动时间 vs 部署面最新 mtime；'
    + '不证明进程内已加载模块内容 ≡ 盘上内容 —— 见本文件头边界声明）';
  if (sm.noLive) skip('--no-live：跳过活体宿主枚举' + tag);
  if (process.platform !== 'win32') skip('非 Windows（' + process.platform + '）⇒ 进程枚举判据不适用' + tag);

  // ── 阳性对照：比对函数必须能判出「启动早于改动」（否则 FAIL 无从归因）──
  const nowMs = Date.now();
  const probe = compareFreshness([
    { ProcessId: 1, Name: 'probe-stale', start: new Date(nowMs - 60000).toISOString() },
    { ProcessId: 2, Name: 'probe-fresh', start: new Date(nowMs + 60000).toISOString() },
    { ProcessId: 3, Name: 'probe-unknown', start: '' },
  ], nowMs);
  expect(probe.stale.length === 1 && /probe-stale/.test(probe.stale[0]), '阳性对照失败：启动早于最新改动的候选未被判为 stale');
  // ── 阴性对照：启动晚于最新改动 ⇒ 不得误报 ──
  expect(probe.fresh.length === 1 && /probe-fresh/.test(probe.fresh[0]), '阴性对照失败：启动晚于改动仍被判 stale（误报）');
  expect(probe.unknown.length === 1, '阴性对照失败：启动时间不可解析的候选未被单列（会被静默当作通过）');

  const surface = newestSurfaceMtime(sm.repoRoot);
  expect(surface.count > 0 && surface.newestMs > 0, '阳性对照失败：部署面 mtime 读不到（' + JSON.stringify(surface) + '）');

  const enumerated = pwshJson(ENUM_SCRIPT);
  if (!enumerated.ok) skip('进程枚举不可用（' + String(enumerated.error).slice(0, 240) + '）⇒ 活体面不可判' + tag);
  const candidates = (enumerated.rows ?? []).filter((row) => {
    if (!row) return false;
    if (Number(row.ProcessId) === process.pid) return false;
    return LIVE_CMD.test(String(row.CommandLine ?? '')) || LIVE_CMD.test(String(row.Name ?? ''));
  });
  if (candidates.length === 0) skip('枚举不到命中「desktop profile / 本插件」的活体进程（0 候选）⇒ 活体面不可判' + tag);

  const verdict = compareFreshness(candidates, surface.newestMs);
  expect(verdict.stale.length === 0, '**宿主在跑旧代码**（改完没重启）：\n  ' + verdict.stale.join('\n  ')
    + '\n  ⇒ 处置：重启 DSH Desktop 后复跑本冒烟' + tag);
  return '候选进程 ' + candidates.length + ' 个全部晚于部署面最新改动（' + surface.newestPath + ' @ '
    + new Date(surface.newestMs).toISOString() + '）· 扫描 ' + surface.count + ' 文件'
    + (verdict.unknown.length ? ' · 启动时间不可解析 ' + verdict.unknown.length + ' 个（已单列，不计入判据）' : '') + tag;
}

export function buildX(sm) {
  return [
    { id: 'H-11', title: '零消费点三条抽样（逐行分类，禁命中计数）', run: () => h11(sm) },
    { id: 'H-12', title: '构建新鲜度 mtime(js) ≥ mtime(ts)（--allow-stale-build ⇒ SKIP）', run: () => h12(sm) },
    { id: 'H-13', title: '真实 home 准则面五件同 sha · SKIP-able', run: () => h13(sm) },
    { id: 'H-14', title: '活体宿主新鲜度（时间序推断，非内容比对）· SKIP-able', run: () => h14(sm) },
  ];
}
