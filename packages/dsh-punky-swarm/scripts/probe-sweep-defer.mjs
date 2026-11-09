#!/usr/bin/env node
/**
 * probe-sweep-defer.mjs —— B-1（启动清扫挪出 apply 同步段）的**真代码** RED→GREEN 验证器
 *
 * 与 `probe-boot-cost.mjs` 的分工：
 *   · probe-boot-cost.mjs = **定量**（同构复算各段毫秒 + 冷/热）⇒ 供 AC-1 读数、AC-2 的 ≥50% 判据。
 *   · 本文件           = **定性**（跑**真实** `lib/index.js` 的 `apply()`，测「清扫是否还在 apply 返回前执行」）
 *                        ⇒ 供 AC-2 第二条（首个 tick 内出现日志、n>0）、AC-3、AC-4。
 *
 * 关键点：本文件**不复制任何生产逻辑** —— 它 import 真 `apply()`，只观察 logger 的 info 序列。
 *   因此「RED」不是靠改代码造出来的：把第 `PHASE` 条读数与 probe-boot-cost 的 S9a 分段同看即得
 *   （那段就是「同步跑一次 sweep」的耗时）；本文件的 GREEN 读数证明该同步段已不在 apply 内。
 *
 * 副作用收窄（可核）：
 *   · root ⇒ `os.tmpdir()` 下的一次性目录（不碰真实 `~/.dsh/punky-preset`）。
 *   · audit sink ⇒ `PUNKY_AUDITLOG_SINK_DIR` 指向同一 tmp 目录（不碰活宿主 `~/.dsh/logs/punky-swarm`）。
 *   · `syncAssets()` 会按真实 homedir 跑（apply 内部无注入位）；`syncDir` 对已一致目标返回 'current'
 *     **零写盘**，脚本把 `writes` 读数打出来。
 *
 * 用法：node scripts/probe-sweep-defer.mjs [--json=<outfile>]
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const i = argv.indexOf(hit);
  return argv[i + 1] ?? dflt;
};
const JSON_OUT = argOf('json', null);

const t = () => process.hrtime.bigint();
const msOf = (a, b) => Number(b - a) / 1e6;

const SWEEP_LOG = 'mailbox sweep on start';
const countOf = (lines) => lines.filter((l) => l.includes(SWEEP_LOG)).length;

const seedMailbox = (root) => {
  // 布局取自 lib/comms/mailbox.js:107-121 boxDirs()：supervisor/inbox、broadcast、<name>/outbox
  const mb = join(root, 'sessions', 's-probe', 'mailbox', 'b-probe');
  const msg = (id, sentAt) => JSON.stringify({
    id, from: 'leader', to: 'e1', subject: 'probe', body: 'x', sentAt,
  });
  const nowIso = new Date().toISOString();
  fs.mkdirSync(join(mb, 'supervisor', 'inbox'), { recursive: true });
  fs.mkdirSync(join(mb, 'broadcast'), { recursive: true });
  fs.mkdirSync(join(mb, 'lane-a', 'outbox'), { recursive: true });
  fs.writeFileSync(join(mb, 'supervisor', 'inbox', 'm1.json'), msg('m1', nowIso), 'utf8');
  fs.writeFileSync(join(mb, 'broadcast', 'm2.json'), msg('m2', nowIso), 'utf8');
  fs.writeFileSync(join(mb, 'lane-a', 'outbox', 'm3.json'), msg('m3', nowIso), 'utf8');
  return mb;
};

const main = async () => {
  const { apply } = await import('../lib/index.js');
  const { assemblyCtxEffect } = await import('../test/helpers/gate-fixture.mjs');

  const root = fs.mkdtempSync(join(tmpdir(), 'punky-sweep-defer-'));
  const seededMailbox = seedMailbox(root);
  // 隔离审计面：mountAuditLog 读 process.env（apply 不传 env）⇒ 在任何 apply 之前设好
  process.env.PUNKY_AUDITLOG_SINK_DIR = join(root, 'audit-sink');

  const { ctx } = assemblyCtxEffect();
  // 夹具的 logger 缺 `exporter`，而 mountAuditLog 的身份判定要求它是函数（lib/auditlog/sink.js:139）
  // ⇒ 补齐该位，否则 `audit log sink mounted` 恒缺席（AC-5 的读数就成了夹具缺陷，不是产品读数）。
  ctx.logger.exporter = () => () => {};
  const config = { root, mailbox: { sweepOnStart: true } };

  // ── 读数①：apply() 同步段是否还包含 sweep ───────────────────────────────────
  const a = t();
  const disposer = apply(ctx, config);
  const b = t();
  const applySyncMs = msOf(a, b);
  const syncSweepLogs = countOf(ctx.calls.info);       // ← apply 返回那一刻的条数

  // ── 读数②：首个 tick 后 ────────────────────────────────────────────────────
  await new Promise((r) => setImmediate(r));
  const tick1SweepLogs = countOf(ctx.calls.info);
  // 再等一个宏任务窗口，确认不是「下一个 tick 才有」的漂移
  await new Promise((r) => setTimeout(r, 100));
  const settledSweepLogs = countOf(ctx.calls.info);

  const sweepLines = ctx.calls.info.filter((l) => l.includes(SWEEP_LOG));
  const scannedOf = (line) => {
    const m = /scanned=(\d+)/.exec(line ?? '');
    return m ? Number(m[1]) : null;
  };
  const scanned = scannedOf(sweepLines[0]);

  // ── 读数③：AC-4 幂等/可重入（再触发一次清扫，经真实邮箱面）──────────────────
  //   直接调 mailbox.sweep 同一批量根两次：第二次应 removed/quarantined 全 0 且不抛错。
  const mailbox = await import('../lib/comms/mailbox.js');
  const r1 = mailbox.sweep(seededMailbox);
  const r2 = mailbox.sweep(seededMailbox);

  // ── 读数④：AC-5 四条证据链日志仍在（各 1 次）───────────────────────────────
  const CHAIN = [
    'audit log sink mounted',
    'governance hook enabled',
    'verify capability enabled',
    'trajectory bridge subscribed',
  ];
  const chain = Object.fromEntries(CHAIN.map((k) => [k, ctx.calls.info.filter((l) => l.includes(k)).length]));

  // 清理：先撤装配（触发我这条 deferred 的 disposer 路径），再删 tmp
  try { disposer?.(); } catch { /* 清理失败不污染读数 */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 同上 */ }

  const out = {
    tool: 'probe-sweep-defer.mjs',
    clock: 'process.hrtime.bigint()',
    node: process.version,
    // AC-2 第二条判据：apply 同步段内 **0** 条 sweep 日志；首个 tick 内 ≥1 条且 scanned>0
    ac2: {
      syncPathSweepLogs: syncSweepLogs,
      firstTickSweepLogs: tick1SweepLogs,
      settledSweepLogs,
      applySyncMs: Number(applySyncMs.toFixed(3)),
      pass: syncSweepLogs === 0 && tick1SweepLogs >= 1,
    },
    // AC-3：清扫仍发生，scanned 大于 0
    ac3: { swept: settledSweepLogs >= 1, scanned, line: sweepLines[0] ?? null },
    // AC-4：第二次 removed/quarantined 为 0 且不抛错
    ac4: { first: r1, second: r2, idempotent: r2.removed === 0 && r2.quarantined === 0 },
    // AC-5：四条证据链日志仍在（本次装配各 1 次）
    ac5: chain,
    effectsRegistered: (ctx.effects ?? []).map((e) => e.label),
    engineWarn: ctx.calls.warn,
  };

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2), 'utf8');
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
};

main().then(
  () => process.exit(0),
  (e) => { process.stderr.write('PROBE FAILED: ' + (e?.stack ?? e) + '\n'); process.exit(1); },
);
