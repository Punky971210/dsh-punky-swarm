#!/usr/bin/env node
/**
 * probe-assets-defer.mjs —— 「syncAssets 移出 apply 同步段」的**真代码** RED→GREEN 验证器
 *   （判据源 `plan/coldstart-and-sessionfix.md` · AC-3 / AC-4 / AC-6）
 *
 * 与 `probe-boot-cost.mjs` 的分工：
 *   · probe-boot-cost.mjs  = **定量**（同构复算各段毫秒，`--assets=inline|deferred` 两种调度）⇒ AC-1/AC-2。
 *   · probe-sweep-defer.mjs= 定性（上一批：mailbox sweep 是否还在 apply 返回前执行）。
 *   · **本文件**           = 定性 + 冷态构造（AC-3/AC-4/AC-6）：import **真** `apply()`，只观察
 *                            「apply 返回那一刻 / 首个 tick 之后 / tick 前被 dispose」三个时刻的文件系统与日志面。
 *
 * 为什么必须三进程（AC-4② 的硬要求）：
 *   「tick 前被 dispose ⇒ 本次同步取消 ⇒ **下次启动补同步**」这一承诺只能在**两个独立进程**里证明：
 *   进程一（`--child=early-dispose`）取消后目标目录**仍不存在**，进程二（`--child=normal`）随后启动即补齐。
 *   同进程内重跑会被 `recoveredThisProcess` 进程级幂等位短路（第二次 apply 的同步块整块不执行）⇒ 假绿。
 *
 * 冷态前置（AC-3 的硬要求）：
 *   `syncDir` 对一致目标返回 `'current'` 且**零写盘、零日志** ⇒ 若目标目录已存在，「跑了」与「没跑」
 *   在文件面与日志面**都不可辨**。故每个子进程在 `apply()` 前**显式删空**
 *   `<home>/.dsh/.agent-presets/punky-preset` 与 `<home>/.agents/skills`，把「冷态」构造成事实而不是假设。
 *
 * 副作用收窄（可核，全部落在一次性 tmp home 内）：
 *   · `USERPROFILE` / `HOME` / `DSH_HOME` 指向 tmp home（`os.homedir()` 走 USERPROFILE ⇒ 资产落点在 tmp 内）；
 *   · `PUNKY_AUDITLOG_SINK_DIR` 指向 tmp home 下的 `audit-sink`（不碰活宿主 `~/.dsh/logs/punky-swarm`）；
 *   · `config.root` 指向 tmp home 下的 `punky-root`（不碰真实引擎状态根）。
 *
 * 用法：
 *   node scripts/probe-assets-defer.mjs [--json=<outfile>]     # 协调器：跑三个子进程并汇总（**推荐**）
 *   node scripts/probe-assets-defer.mjs --child=normal|early-dispose|skills-blocked|manifest-corrupt --home=<p>
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const i = argv.indexOf(hit);
  return argv[i + 1] ?? dflt;
};
const CHILD = argOf('child', null);
const HOME_ARG = argOf('home', null);
const JSON_OUT = argOf('json', null);

const t = () => process.hrtime.bigint();
const msOf = (a, b) => Number(b - a) / 1e6;   // ns → ms
const sha256Of = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** 资产落点（C-4）：预设目录条 / 自举条 / 技能目录根。 */
const presetDirOf = (home) => join(home, '.dsh', '.agent-presets', 'punky-preset');
const bootstrapFileOf = (home) => join(presetDirOf(home), 'asset-manifest.json');
const skillsDirOf = (home) => join(home, '.agents', 'skills');

/** 三条资产日志的判据（AC-3① 要求 apply 返回那一刻计数为 0）。 */
const ASSET_LOG_PATTERNS = [/asset synced:/, /asset sync failed:/, /asset manifest 不可用/];
const countAssetLogs = (lines) => lines.filter((l) => ASSET_LOG_PATTERNS.some((re) => re.test(String(l)))).length;

/** 冷态构造：显式删空目标（若已存在则「跑了/没跑」不可辨 —— 见文件头）。 */
const wipeAssets = (home) => {
  const removed = [];
  for (const p of [presetDirOf(home), skillsDirOf(home)]) {
    if (exists(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); }
  }
  return removed;
};

// ══════════════════════════════════════════════════════════════════════════════════════
// 子进程：真 `apply()` + 三个时刻的读数
// ══════════════════════════════════════════════════════════════════════════════════════
const runChild = async () => {
  const home = HOME_ARG;
  if (!CHILD || !home) throw new Error('子进程模式需 --child=<kind> 与 --home=<path>');
  // 环境重定向必须在 import 被测模块**之前**（`homedir()` 在调用期取值，但模块级也可能派生 DSH_HOME）
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.DSH_HOME = join(home, '.dsh');
  process.env.PUNKY_AUDITLOG_SINK_DIR = join(home, 'audit-sink');

  const wiped = wipeAssets(home);   // 冷态前置（AC-3）
  // AC-6 的 two 形态都用「落点不可写/形态非法」构造，不触碰包内清单：
  //   skills-blocked ⇒ 把 `<home>/.agents/skills` 造成**普通文件** ⇒ 5 条技能资产 mkdirSync 失败
  if (CHILD === 'skills-blocked') {
    fs.mkdirSync(join(home, '.agents'), { recursive: true });
    fs.writeFileSync(skillsDirOf(home), 'blocked-by-probe', 'utf8');
  }

  const { apply } = await import('../lib/index.js');
  const { assemblyCtxEffect } = await import('../test/helpers/gate-fixture.mjs');
  const { syncAssets, MANIFEST_REL, packageRoot } = await import('../lib/assets.js');

  const { ctx } = assemblyCtxEffect();
  // 夹具 logger 缺 `exporter`，而 mountAuditLog 的身份判定要求它是函数（lib/auditlog/sink.js:139）
  ctx.logger.exporter = () => () => {};
  const root = join(home, 'punky-root');
  const config = { root, mailbox: { sweepOnStart: false } };

  const beforeApply = {
    presetDirExists: exists(presetDirOf(home)),
    skillsDirExists: exists(skillsDirOf(home)),
    wiped,
    skillsDirIsFile: (() => { try { return exists(skillsDirOf(home)) && !fs.statSync(skillsDirOf(home)).isDirectory(); } catch { return false; } })(),
  };

  const a = t();
  const disposer = apply(ctx, config);
  const applySyncMs = msOf(a, t());
  // ① apply 返回那一刻（= 同步段结束）
  const atReturn = {
    presetDirExists: exists(presetDirOf(home)),
    skillsDirExists: exists(skillsDirOf(home)),
    assetLogCount: countAssetLogs(ctx.calls.info) + countAssetLogs(ctx.calls.warn),
    infoCount: ctx.calls.info.length,
    warnCount: ctx.calls.warn.length,
    applySyncMs: Number(applySyncMs.toFixed(3)),
  };

  let disposedEarly = null;
  if (CHILD === 'early-dispose') {
    // AC-4①：`apply()` 后**立即**模拟宿主卸载（在首个 tick 之前）。
    //   ⚠ 夹具（`test/helpers/gate-fixture.mjs` 的 `assemblyCtxEffect`）把 `ctx.effect` 实现成**惰性工厂**：
    //   只有 `runEffects()` 才会真跑 cleanup；真 cordis 是在 fiber dispose 时自动做这一步。
    //   ⇒ 要让本读数对应「宿主热重载/卸载」真实语义，必须**两件都做**：
    //     ① `ctx.runEffects()` = 宿主对每个 `ctx.effect` 注册项执行 cleanup（**这才是取消 deferred 任务的通道**）；
    //     ② `disposer()`        = 插件自身 `return () => {...}` 的释放（httpSurface/releaseAll）。
    //   只做 ② 的读数**不是**本判据的读数（cleanup 没跑 ⇒ 会看到「照样同步」的假绿/假红）。
    const warnsBefore = ctx.calls.warn.length;
    const ranEffects = ctx.runEffects();
    disposer();
    disposedEarly = {
      presetDirExists: exists(presetDirOf(home)),
      skillsDirExists: exists(skillsDirOf(home)),
      ranEffects,
      skippedWarn: ctx.calls.warn.slice(warnsBefore).filter((l) => String(l).includes('asset sync skipped')),
      afterTick: null,
    };
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
    disposedEarly.afterTick = {
      presetDirExists: exists(presetDirOf(home)),
      skillsDirExists: exists(skillsDirOf(home)),
      assetLogCount: countAssetLogs(ctx.calls.info) + countAssetLogs(ctx.calls.warn),
    };
  } else {
    // ② 首个 tick 之后（= 延迟同步应已完成）
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
  }

  const afterTick = {
    presetDirExists: exists(presetDirOf(home)),
    skillsDirExists: exists(skillsDirOf(home)),
    assetLogCount: countAssetLogs(ctx.calls.info) + countAssetLogs(ctx.calls.warn),
    syncedAssets: ctx.calls.info.filter((l) => String(l).includes('asset synced:')).map((l) => String(l).split('asset synced:')[1].trim()),
    failedAssets: ctx.calls.warn.filter((l) => String(l).includes('asset sync failed:')).map((l) => String(l).trim()),
    manifestWarns: ctx.calls.warn.filter((l) => String(l).includes('asset manifest 不可用')).map((l) => String(l).trim()),
    skippedWarns: ctx.calls.warn.filter((l) => String(l).includes('asset sync skipped')).map((l) => String(l).trim()),
  };

  // ③ 清单字节一致性（AC-3②）：落点自举条 vs 包内 `presets/punky-preset/asset-manifest.json`
  const pkgManifest = join(packageRoot(), MANIFEST_REL);
  const bootstrap = bootstrapFileOf(home);
  const bytes = {
    pkgPath: pkgManifest,
    skipPath: bootstrap,
    pkgBytes: exists(pkgManifest) ? fs.statSync(pkgManifest).size : null,
    skipBytes: exists(bootstrap) ? fs.statSync(bootstrap).size : null,
    pkgSha256: exists(pkgManifest) ? sha256Of(pkgManifest) : null,
    skipSha256: exists(bootstrap) ? sha256Of(bootstrap) : null,
  };
  bytes.equal = bytes.pkgBytes !== null && bytes.pkgBytes === bytes.skipBytes && bytes.pkgSha256 === bytes.skipSha256;

  // ④ 清单态读数（AC-4② 的 `manifest=ok`）：`manifest !== 'ok'` 才打日志 ⇒ 只能经**幂等二次读**取态。
  //   第二次调用应全部 `current`（零写盘）⇒ 顺带证明幂等。
  //   ⚠ **early-dispose 形态不做这一步**：它是「补同步」的反面样本，若在探针自身里再调 `syncAssets()`
  //   就会把刚落空的目录重建出来 ⇒ 直接污染 AC-4② 的「进程一退出后目录仍不存在」读数（本探针首版踩过）。
  let postTick = null;
  if (CHILD !== 'early-dispose') {
    try {
      const r = syncAssets({ home });
      postTick = {
        manifest: r.manifest,
        results: (r.results ?? []).map((x) => ({ asset: x.asset, status: x.status })),
        writes: (r.results ?? []).filter((x) => x.status === 'synced').map((x) => x.asset),
      };
    } catch (e) {
      postTick = { error: String(e?.message ?? e) };
    }
  }

  // ⑤ AC-6 的 `asset manifest 不可用（<态>）` 分支：**不可经真 apply() 到达**（`syncAssets()` 在 apply 内
  //   裸调 ⇒ 清单根恒为包内 `packageRoot()`，无注入位）。此处给两段可达证据：
  //     (a) 数据面：用同签名 `syncAssets({home, packageRoot})` 造 corrupt 清单 ⇒ 态可达；
  //     (b) 源码面：`lib/index.js` 里该 warn 的表达式仍在（本批只挪调用点，未改日志面）。
  const manifestBranch = {
    reachableThroughApply: false,
    reason: 'apply 内 `syncAssets()` 为裸调（无 opts）⇒ 清单根 = packageRoot()，探针无法在不改包内文件的前提下注入损坏清单',
  };
  if (CHILD === 'manifest-corrupt') {
    const tmpPkg = join(home, 'tmp-pkg');
    fs.mkdirSync(join(tmpPkg, 'presets', 'punky-preset'), { recursive: true });
    fs.writeFileSync(join(tmpPkg, MANIFEST_REL), '{ "manifestVersion": 1, "broken', 'utf8');
    const r = syncAssets({ home: join(home, 'manifest-home'), packageRoot: tmpPkg });
    manifestBranch.dataPlane = {
      manifest: r.manifest,
      statuses: (r.results ?? []).map((x) => x.asset + ':' + x.status),
    };
  }
  const indexSrc = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  manifestBranch.warnExpressionPresentInIndex = indexSrc.includes("asset manifest 不可用（' + manifest + '）");

  if (CHILD !== 'early-dispose') { try { disposer?.(); } catch { /* 清理失败不污染读数 */ } }

  return {
    kind: CHILD,
    home,
    node: process.version,
    childPid: process.pid,
    beforeApply,
    atReturn,
    afterTick,
    disposedEarly,
    manifestBytes: bytes,
    postTickIdempotentRead: postTick,
    manifestBranch,
    engineWarnAll: ctx.calls.warn,
    effectsRegistered: (ctx.effects ?? []).map((e) => e.label),
  };
};

// ══════════════════════════════════════════════════════════════════════════════════════
// 协调器：一次性 tmp home + 三个独立子进程（AC-3 / AC-4① / AC-4②+AC-6）
// ══════════════════════════════════════════════════════════════════════════════════════
const runCoordinator = async () => {
  const selfFile = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const home = fs.mkdtempSync(join(tmpdir(), 'punky-assets-defer-'));
  const childEnv = (h) => ({
    ...process.env,
    USERPROFILE: h, HOME: h, DSH_HOME: join(h, '.dsh'),
    PUNKY_AUDITLOG_SINK_DIR: join(h, 'audit-sink'),
  });
  const runChildProc = (kind, h) => {
    const r = spawnSync(process.execPath, [selfFile, '--child=' + kind, '--home=' + h], {
      encoding: 'utf8', env: childEnv(h), timeout: 120000,
    });
    const out = String(r.stdout ?? '');
    const m = /@@REPORT@@([\s\S]*?)@@END@@/.exec(out);
    let report = null;
    if (m) { try { report = JSON.parse(m[1]); } catch { report = null; } }
    return { kind, status: r.status, report, stderr: String(r.stderr ?? '').slice(-1200), rawTail: out.slice(-600) };
  };

  // ── 进程一：tick 前 dispose ⇒ 取消必须留 warn（AC-4①），且目标目录**仍未创建** ──
  const early = runChildProc('early-dispose', home);
  const afterEarly = { presetDirExists: exists(presetDirOf(home)), skillsDirExists: exists(skillsDirOf(home)) };

  // ── 进程二：正常启动 ⇒ 首个 tick 内补齐（AC-3 + AC-4②）──
  const normal = runChildProc('normal', home);
  const afterNormal = { presetDirExists: exists(presetDirOf(home)), skillsDirExists: exists(skillsDirOf(home)) };

  // ── 进程三：落点不可写形态 ⇒ `asset sync failed` 仍出现（AC-6，且条数对应）──
  const blockedHome = fs.mkdtempSync(join(tmpdir(), 'punky-assets-blocked-'));
  const blocked = runChildProc('skills-blocked', blockedHome);

  // ── 进程四：清单不可用分支的**数据面**可达性（AC-6 的另一半；见子进程 ⑤ 的 reason）──
  const manifestHome = fs.mkdtempSync(join(tmpdir(), 'punky-assets-manifest-'));
  const manifestChild = runChildProc('manifest-corrupt', manifestHome);

  const out = {
    tool: 'probe-assets-defer.mjs',
    clock: 'process.hrtime.bigint()',
    node: process.version,
    coordinatorPid: process.pid,
    home,
    // AC-3：真代码时序（冷态构造 = 每个子进程 apply 前显式删空目标）
    ac3: {
      coldPrecondition: early.report?.beforeApply ?? null,
      atApplyReturn: normal.report?.atReturn ?? null,
      afterFirstTick: normal.report?.afterTick ?? null,
      manifestBytesEqual: normal.report?.manifestBytes ?? null,
      pass: Boolean(
        normal.report
        && normal.report.atReturn.presetDirExists === false
        && normal.report.atReturn.skillsDirExists === false
        && normal.report.atReturn.assetLogCount === 0
        && normal.report.afterTick.assetLogCount >= 1
        && normal.report.manifestBytes.equal === true,
      ),
    },
    // AC-4①：tick 前 dispose ⇒ 目录仍未创建 + 出现 `asset sync skipped` warn
    ac4EarlyDispose: {
      child: early.report ? { atApplyReturn: early.report.atReturn, disposedEarly: early.report.disposedEarly } : null,
      filesystemAfterChildExit: afterEarly,
      pass: Boolean(
        early.report
        && early.report.disposedEarly
        && early.report.disposedEarly.presetDirExists === false
        && early.report.disposedEarly.afterTick.presetDirExists === false
        && early.report.disposedEarly.skippedWarn.length >= 1
        && afterEarly.presetDirExists === false,
      ),
    },
    // AC-4②：两个独立进程 ⇒ 进程一跳过、进程二补齐（`下次启动补同步` 不是口头承诺）
    ac4NextBootCatchUp: {
      afterEarlyChildExit: afterEarly,
      afterNormalChildExit: afterNormal,
      normalManifestRead: normal.report?.postTickIdempotentRead ?? null,
      pass: Boolean(
        afterEarly.presetDirExists === false && afterEarly.skillsDirExists === false
        && afterNormal.presetDirExists === true && afterNormal.skillsDirExists === true
        && normal.report?.postTickIdempotentRead?.manifest === 'ok',
      ),
    },
    // AC-6：异常态的日志面**不丢失**（只是时机后移到首个 tick）
    ac6: {
      skillsBlocked: {
        child: blocked.report ? {
          atApplyReturn: blocked.report.atReturn,
          afterFirstTick: blocked.report.afterTick,
        } : null,
        failedWarnCount: blocked.report?.afterTick?.failedAssets?.length ?? null,
        lines: blocked.report?.afterTick?.failedAssets ?? null,
      },
      manifestBranch: normal.report?.manifestBranch ?? null,
      pass: Boolean(
        blocked.report
        && blocked.report.atReturn.assetLogCount === 0
        && (blocked.report.afterTick.failedAssets?.length ?? 0) >= 1,
      ),
    },
    raw: {
      early: { status: early.status, stderr: early.stderr, rawTail: early.rawTail },
      normal: { status: normal.status, stderr: normal.stderr, rawTail: normal.rawTail },
      blocked: { status: blocked.status, stderr: blocked.stderr, rawTail: blocked.rawTail },
      manifestChildStatus: manifestChild.status,
    },
  };
  for (const d of [home, blockedHome, manifestHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响读数 */ }
  }
  return out;
};

const main = async () => {
  const out = CHILD ? await runChild() : await runCoordinator();
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2), 'utf8');
  if (CHILD) process.stdout.write('@@REPORT@@' + JSON.stringify(out) + '@@END@@\n');
  else process.stdout.write(JSON.stringify(out, null, 2) + '\n');
};

main().then(
  () => process.exit(0),
  (e) => { process.stderr.write('PROBE FAILED: ' + (e?.stack ?? e) + '\n'); process.exit(1); },
);
