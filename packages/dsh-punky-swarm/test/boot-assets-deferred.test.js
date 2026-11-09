/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/boot-assets-deferred.test.js —— **冷启动瘦身** 的回归锁（判据源 `plan/coldstart-and-sessionfix.md` 组 A）
//
// 覆盖验收项：
//   · AC-3  真代码时序：`apply()` 返回那一刻目标目录**仍不存在**且三条资产日志计数为 0；
//           首个 tick 后目录存在、`asset-manifest.json` 与包内清单**逐字节相等**（sha256）
//   · AC-4  tick 前 dispose ⇒ 目标目录仍未创建 **且** 出现 `asset sync skipped` warn（不静默）；
//           两个独立进程 ⇒ 进程一跳过、进程二补齐（「下次启动补同步」不是口头承诺）
//   · AC-6  异常态日志面不丢失（`asset sync failed: <asset>: <err>` 仍出现，只是时机后移到首个 tick）
//
// 为什么 AC-4 走**子进程探针**而不是进程内再 apply 一次：
//   `recoveredThisProcess` 是**进程级一次位**（`lib/index.js:131`）⇒ 同进程第二次 `apply()` 的恢复块整块不执行，
//   读数会是假绿。AC-4 的「两个独立进程」是判据的硬要求，故落在 `scripts/probe-assets-defer.mjs` 里跑，本文件只断言其读数。
//
// 冷态前置（AC-3 硬要求）：`syncDir` 对一致目标返回 'current' 且**零写盘零日志** ⇒ 目标目录若已存在，
//   「跑了」与「没跑」在文件面与日志面都不可辨。故本文件在 `apply()` 前**显式删空**两个落点。
//
// 跑法（必须带 preload，否则 apply 会写真实用户主目录）：
//   node --import ./test/helpers/isolated-home.preload.mjs --test test/boot-assets-deferred.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';
import { assemblyCtxEffect } from './helpers/gate-fixture.mjs';

const HOME = os.homedir();
const PRESET_DIR = path.join(HOME, '.dsh', '.agent-presets', 'punky-preset');
const SKILLS_DIR = path.join(HOME, '.agents', 'skills');
const BOOTSTRAP = path.join(PRESET_DIR, 'asset-manifest.json');
const PKG_MANIFEST = fileURLToPath(new URL('../presets/punky-preset/asset-manifest.json', import.meta.url));

const ASSET_LOG_PATTERNS = [/asset synced:/, /asset sync failed:/, /asset manifest 不可用/];
const countAssetLogs = (calls) => [...calls.info, ...calls.warn].filter((l) => ASSET_LOG_PATTERNS.some((re) => re.test(String(l)))).length;
const sha256Of = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('AC-3 真 apply()：同步段内零资产写入，首个 tick 内完整同步一次（逐字节一致）', async () => {
  // ── 真实主目录硬守卫（P0 安全，2026-11-10 事故后补）────────────────────────
  //   本用例会 `rm -rf` 两个落点。它们由 `os.homedir()` 派生 ⇒ **未加载
  //   `test/helpers/isolated-home.preload.mjs` 时指向真实用户主目录**，
  //   历史事故即由此发生（一次抹掉 ~/.agents/skills 与 ~/.dsh/.agent-presets/punky-preset）。
  //   真源 = `os.userInfo().homedir`（系统账户 API，不受 USERPROFILE/HOME 改写影响）。
  //   ⇒ 两者相等即「隔离未生效」，必须拒跑，不许靠调用方「记得带 preload」。
  assert.notEqual(
    path.resolve(os.homedir()),
    path.resolve(os.userInfo().homedir),
    '拒绝在真实主目录上执行：本用例会删除 ' + PRESET_DIR + ' 与 ' + SKILLS_DIR
      + '。请以 `node --import ./test/helpers/isolated-home.preload.mjs --test test/boot-assets-deferred.test.js` 运行。',
  );
  // ── 冷态构造（不是假设）──
  for (const p of [PRESET_DIR, SKILLS_DIR]) fs.rmSync(p, { recursive: true, force: true });
  assert.equal(fs.existsSync(PRESET_DIR), false, '前置：预设落点必须不存在');
  assert.equal(fs.existsSync(SKILLS_DIR), false, '前置：技能落点必须不存在');

  const { ctx } = assemblyCtxEffect();
  ctx.logger.exporter = () => () => {};   // mountAuditLog 的身份判定要求 logger.exporter 是函数
  process.env.PUNKY_AUDITLOG_SINK_DIR = path.join(HOME, 'audit-sink');
  const config = { root: path.join(HOME, 'punky-root'), mailbox: { sweepOnStart: false } };

  const disposer = apply(ctx, config);
  try {
    // ① apply 返回那一刻（= 同步段结束）
    const atReturn = {
      preset: fs.existsSync(PRESET_DIR),
      skills: fs.existsSync(SKILLS_DIR),
      assetLogs: countAssetLogs(ctx.calls),
    };
    assert.equal(atReturn.preset, false, 'apply() 返回时预设落点**必须仍不存在**（同步已移出同步段）');
    assert.equal(atReturn.skills, false, 'apply() 返回时技能落点**必须仍不存在**');
    assert.equal(atReturn.assetLogs, 0, 'apply() 返回时三条资产日志计数必须为 0（实测 ' + atReturn.assetLogs + '）');

    // ② 首个 tick 之后（给一个宏任务窗口，确认不是「更晚才有」的漂移）
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
    const afterTick = {
      preset: fs.existsSync(PRESET_DIR),
      skills: fs.existsSync(SKILLS_DIR),
      assetLogs: countAssetLogs(ctx.calls),
      synced: ctx.calls.info.filter((l) => String(l).includes('asset synced:')).map((l) => String(l).split('asset synced:')[1].trim()),
    };
    assert.equal(afterTick.preset, true, '首个 tick 后预设落点必须存在（延迟 ≠ 丢同步）');
    assert.equal(afterTick.skills, true, '首个 tick 后技能落点必须存在');
    assert.ok(afterTick.assetLogs >= 1, '首个 tick 后必须出现资产日志（实测 ' + afterTick.assetLogs + '）');
    assert.deepEqual(afterTick.synced.sort(), [
      'presets/punky-preset', 'skills/design-team', 'skills/research-team',
      'skills/software-team', 'skills/video-team', 'skills/writing-team',
    ], '冷态首次安装应逐条 `asset synced`（6 条资产，一条不增一条不减）');

    // ③ 自举条字节一致（清单文件本体）
    assert.equal(fs.existsSync(BOOTSTRAP), true, '自举条 asset-manifest.json 必须落盘');
    assert.equal(fs.statSync(BOOTSTRAP).size, fs.statSync(PKG_MANIFEST).size, '自举条字节数必须与包内清单相等');
    assert.equal(sha256Of(BOOTSTRAP), sha256Of(PKG_MANIFEST), '自举条 sha256 必须与包内清单相等');
  } finally {
    try { ctx.runEffects(); } catch { /* 夹具清理失败不影响判据 */ }
    disposer?.();
  }
});

// ── AC-4 / AC-6 子进程面：**已随 `scripts/probe-assets-defer.mjs` 一并移除**（2026-11-10）──
// 移除原因（P0 安全）：该探针的 `wipeAssets()` 会 `rm -rf <home>/.agents/skills` 与
//   `<home>/.dsh/.agent-presets/punky-preset`，而准入只校验 `--home` 非空、**不校验它是不是真实主目录**
//   ⇒ 2026-11-10 01:51 抹掉真机技能树（两目标 CreationTime 同被重置为 01:53:13，签名吻合）。
// 覆盖缺口（登记 F-13，非静默降级 —— 不写假绿断言）：
//   · AC-4①「tick 前 dispose ⇒ 目标目录仍未创建 + `asset sync skipped` warn」
//   · AC-4②「两个独立进程 ⇒ 进程一跳过、进程二补齐」（只能跨进程验证，进程内必假绿）
//   · AC-6「异常态 `asset sync failed: <asset>: <err>` 不丢」
// 补回方式（待排期）：子进程探针改为 mkdtemp 临时 home + USERPROFILE/HOME/DSH_HOME 三变量隔离，
//   并在探针与调用侧**双向**拒绝 `home === os.userInfo().homedir`。

