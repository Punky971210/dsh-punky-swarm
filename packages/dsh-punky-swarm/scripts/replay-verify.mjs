#!/usr/bin/env node
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

// scripts/replay-verify.mjs —— 事件重放校验腿的 **CLI 薄壳**（唯一写盘点）
// ─────────────────────────────────────────────────────────────────────────────
// 【只做什么】读批 → 调纯函数裁决 → 落**诊断产物** → 打印摘要。**恒 exit 0**。
// 【不做什么（硬约束）】不写批次 JSON、不写事件流、不改任何状态文件、不新增批次 JSON 顶层键、
//   不发射事件、不新增 `GATE_*` 拒码、不阻断任何 merged —— 差异只作观察，落诊断产物供取证。
// 【读批单点】一律走 `createStore(root).readBatch(session, batch)`（禁另写一套 JSON 读法）。
// 【只读性自证】读批前后各取一次状态文件快照 `{sha256, mtimeMs, size}`，逐项相等才置
//   `stateFileDigest.unchanged = true`；不等则置 `false` 并在 stdout 告警（**仍 exit 0**）。
// 【落点】`<artifactsDirOf(session,batch)>/<out>/<batchId>.json`（默认 `<out>` = `replay-verify`）。
//
// 用法：
//   node scripts/replay-verify.mjs --session <sessionId> --batch <batchId>
//        [--root <engineRoot>] [--out <artifactsSubDir>] [--json] [--help|-h]
//   退出码：恒 0（含批不存在 / 状态文件变更告警等一切非致命情形）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/state/store.js';
import { replayVerifyVerdict } from '../lib/engine/replay-verify.js';

// 诊断产物 schema 标识（**冻结值**，消费方按此判读）
export const REPLAY_VERIFY_SCHEMA = 'punky-replay-verify@1';

// 既有脚本口径：`PUNKY_ROOT` 优先，缺省 `~/.dsh/punky-preset`
const DEFAULT_ROOT = process.env.PUNKY_ROOT ?? path.join(os.homedir(), '.dsh', 'punky-preset');
// 诊断子目录缺省（批次产物根之下）
const DEFAULT_OUT = 'replay-verify';

const USAGE = [
  '用法：node scripts/replay-verify.mjs --session <sessionId> --batch <batchId> [--root <engineRoot>] [--out <dir>] [--json]',
  '  --root <engineRoot>   引擎根（缺省 $PUNKY_ROOT，再缺省 ~/.dsh/punky-preset）',
  '  --session <sessionId> 必填：会话 ID',
  '  --batch <batchId>     必填：批次 ID',
  '  --out <dir>           诊断子目录（缺省 replay-verify），相对批次产物根',
  '  --json                诊断 JSON 也打到 stdout',
  '  --help, -h            打印本用法（零副作用）',
  '  口径：只读校验，恒 exit 0；差异落诊断产物，不改任何状态。',
  '',
].join('\n');

/**
 * 参数面 fail-closed：未知参数 / 缺必填 ⇒ 返回 `error`（调用方打用法、**不进入任何写盘分支**）。
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT, session: null, batch: null, out: DEFAULT_OUT, json: false, help: false, error: null };
  let skipValue = false;
  for (const [i, a] of argv.entries()) {
    if (skipValue) { skipValue = false; continue; }
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--root' || a === '--session' || a === '--batch' || a === '--out') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.trim() === '') { args.error = a + ' 需要一个非空值'; return args; }
      if (a === '--root') args.root = v;
      else if (a === '--session') args.session = v;
      else if (a === '--batch') args.batch = v;
      else args.out = v;
      skipValue = true;
    } else { args.error = '未知参数：' + a; return args; }
  }
  if (args.session === null) args.error = '缺少 --session';
  else if (args.batch === null) args.error = '缺少 --batch';
  return args;
}

/**
 * 状态文件快照：`{sha256, mtimeMs, size}`；文件不在场 ⇒ `null`（readBatch 已在前方判定存在性）。
 * @param {string} file 批次 JSON 绝对路径
 */
function stateFileDigestOf(file) {
  const st = fs.statSync(file);
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { sha256, mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * 单次校验执行（可在进程内直调，便于端到端单测；零 process.exit）。
 * @param {{root: string, session: string, batch: string, out: string, json?: boolean}} opts
 */
export function runReplayVerify(opts) {
  const root = path.resolve(opts.root);
  const store = createStore(root);
  // 批次 JSON 路径由 store 的路径单点给出（含 id 合法性校验）；此处**只解析路径、不读内容**
  const batchFile = store.batchFile(opts.session, opts.batch);
  const exists = fs.existsSync(batchFile);

  if (!exists) {
    return { status: 'batch-missing', root, session: opts.session, batch: opts.batch, batchFile, wrote: null, verdict: null };
  }

  const before = stateFileDigestOf(batchFile);
  const batch = store.readBatch(opts.session, opts.batch); // 读批单点
  if (batch === null || batch === undefined) {
    return { status: 'batch-unreadable', root, session: opts.session, batch: opts.batch, batchFile, wrote: null, verdict: null };
  }
  const verdict = replayVerifyVerdict(batch);
  const after = stateFileDigestOf(batchFile); // 读批后复取（只读性自证）
  const unchanged = before.sha256 === after.sha256 && before.mtimeMs === after.mtimeMs && before.size === after.size;

  const artifact = {
    schema: REPLAY_VERIFY_SCHEMA,
    ok: verdict.ok,
    laneDiffs: verdict.laneDiffs,
    phaseDiff: verdict.phaseDiff,
    eventsScanned: verdict.eventsScanned,
    generatedAt: new Date().toISOString(),
    stateFileDigest: { before, after, unchanged },
    ...(verdict.degraded !== undefined ? { degraded: verdict.degraded } : {}),
  };

  const outDir = path.join(store.artifactsDirOf(opts.session, opts.batch), opts.out);
  fs.mkdirSync(outDir, { recursive: true }); // 落盘前建父目录（目录不存在不 ENOENT）
  const outFile = path.join(outDir, opts.batch + '.json');
  fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  return {
    status: 'ok',
    root,
    session: opts.session,
    batch: opts.batch,
    batchFile,
    outFile,
    wrote: outFile,
    unchanged,
    verdict,
    artifact,
  };
}

/** 人类可读摘要（stdout）。 */
function printSummary(res) {
  const p = (s) => process.stdout.write(s + '\n');
  if (res.status === 'batch-missing') {
    p('[replay-verify] 批不存在：' + res.session + '/' + res.batch);
    p('[replay-verify] 期望路径：' + res.batchFile);
    p('[replay-verify] 未落盘、未改任何状态；exit 0');
    return;
  }
  if (res.status === 'batch-unreadable') {
    p('[replay-verify] 批不可读（损坏隔离 / 读取失败）：' + res.session + '/' + res.batch);
    p('[replay-verify] 未落盘、未改任何状态；exit 0');
    return;
  }
  const v = res.verdict;
  p('[replay-verify] session=' + res.session + ' batch=' + res.batch);
  p('[replay-verify] ok=' + v.ok + ' eventsScanned=' + v.eventsScanned
    + ' laneDiffs=' + v.laneDiffs.length + ' phaseDiff=' + (v.phaseDiff === null ? 'null' : 'present')
    + (v.degraded !== undefined ? ' degraded=' + v.degraded : ''));
  for (const d of v.laneDiffs) {
    p('[replay-verify]   lane ' + d.lane + '：状态文件=' + String(d.stateFile) + ' 事件推导=' + String(d.fromEvents));
  }
  if (v.phaseDiff !== null) {
    p('[replay-verify]   phase：状态文件=' + String(v.phaseDiff.stateFile) + ' 事件推导=' + String(v.phaseDiff.fromEvents));
  }
  p('[replay-verify] 诊断产物已写入：' + res.outFile);
  p('[replay-verify] stateFileDigest.unchanged=' + res.unchanged);
  if (!res.unchanged) {
    p('[replay-verify] ⚠ 告警：状态文件在本次读取前后快照不一致（sha256/mtimeMs/size 至少一项变化）—— 只告警，不改态，exit 0');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); process.exit(0); }
  if (args.error) {
    process.stderr.write('[replay-verify] 参数错误：' + args.error + '\n');
    process.stderr.write(USAGE);
    process.exit(0); // 恒 exit 0：参数错误也不以非零码拒态（只告警）
  }
  let res;
  try {
    res = runReplayVerify(args);
  } catch (err) {
    process.stderr.write('[replay-verify] 运行异常（只告警、不改态）：' + ((err && err.message) || err) + '\n');
    process.exit(0);
  }
  printSummary(res);
  if (args.json && res.artifact !== undefined) process.stdout.write(JSON.stringify(res.artifact, null, 2) + '\n');
  process.exit(0);
}

// 仅在被当作入口执行时跑 main（被 import 时不产生副作用 —— 供端到端单测直调 runReplayVerify）
const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) main();
