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

// E4 legacy-fix 单测（punky-finalize 决策包 §4 审计遗留修正）：
//   T4.1 warn 触发（非法组合 → apply 后 logger.warn 含错误文本）
//   T4.2 不炸宿主（非法配置 apply 正常返回、disposer 正常产出、不 throw）
//   T4.3 缺省零 warn（空/缺省 config 零 warn；禁用能力零校验零 warn）
//   T4.4 回归（全量 node --test 兜底，本文件不重复断言）
//   T4.5 合并生效（mount.js 不再定义本地 resolveVerifyConfig/VERIFY_DEFAULTS，消费路径指向 lib/schema.js）
//   T4.6 语义不变（mount.js re-export 与 lib/schema.js 同一函数引用；边界行为抽查与 verify-mount.test.js 同断言值）
//   T4.7 无越界（index.js 的 mountVerify 挂载调用点原样保留）
// 副作用说明（决策包 §5.4）：apply 首调触发 syncAssets（幂等：目标字节一致则跳过——测试机资产目录
//   已存在 → current 零写入）与 store 恢复（temp root 无 in-flight 批次 → 零操作）；recoveredThisProcess
//   首调后置 true，后续 apply 不再触发资产同步。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { resolveVerifyConfig as schemaResolve } from '../lib/schema.js';
import * as mountMod from '../lib/verify/mount.js';

// mock ctx（§5.4 处置：tools.register 空实现、webServer 缺席、logger 收集）——createTools 经
// ctx.tools.register 注册；installDifficultyGuard 对 ctx.tools.guard 可选链，缺省安全跳过。
function makeCtx() {
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  return { logger, calls, tools: { register() {} } };
}

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-legacy-'));
}

test('T4.1 warn 触发：非法组合 → apply 后 logger.warn 含错误文本（逐条）', () => {
  // DEP-1：verify enabled=true + mode 非法
  const ctx = makeCtx();
  const disposer = apply(ctx, {
    root: freshRoot(),
    capabilities: { verify: { enabled: true, mode: 'bogus' } },
  });
  const warns = ctx.calls.warn;
  assert.ok(
    warns.some((w) => w.includes('[dsh-punky-swarm] config: ') && w.includes('DEP-1')),
    'warn 含前缀 + DEP-1 错误文本（实际: ' + JSON.stringify(warns) + '）',
  );

  // DEP-2：trajectory autoFail=true 无 enabled（多错误逐条 warn）
  const ctx2 = makeCtx();
  apply(ctx2, { root: freshRoot(), capabilities: { trajectory: { autoFail: true } } });
  assert.ok(
    ctx2.calls.warn.some((w) => w.includes('[dsh-punky-swarm] config: ') && w.includes('DEP-2')),
    'DEP-2 亦逐条 warn（实际: ' + JSON.stringify(ctx2.calls.warn) + '）',
  );
  disposer();
});

test('T4.2 不炸宿主：非法配置 apply 正常返回 disposer、不 throw', () => {
  const ctx = makeCtx();
  let disposer;
  assert.doesNotThrow(() => {
    disposer = apply(ctx, {
      root: freshRoot(),
      capabilities: {
        verify: { enabled: true, mode: 'bogus' },
        budget: { enabled: true, maxChainHops: -1 },
      },
    });
  }, '非法配置（DEP-1 + DEP-4）apply 不 throw');
  assert.equal(typeof disposer, 'function', 'disposer 正常产出');
  assert.doesNotThrow(() => disposer(), 'disposer 可安全调用（幂等清理）');
});

test('T4.3 缺省零 warn：空/缺省 config 零 warn；默认关能力不触发校验', () => {
  const ctx = makeCtx();
  apply(ctx, { root: freshRoot() });
  assert.equal(ctx.calls.warn.length, 0, '缺省 config → 零 warn');

  // 禁用能力（verify.mode 非法但 enabled 非 true）→ validateCapabilities 零报错 → 零 warn
  const ctx2 = makeCtx();
  apply(ctx2, { root: freshRoot(), capabilities: { verify: { mode: 'bogus' } } });
  assert.equal(ctx2.calls.warn.length, 0, '禁用能力零校验零 warn');

  // 全缺省（config 不传，走默认 {}）
  const ctx3 = makeCtx();
  apply(ctx3, { root: freshRoot() });
  assert.equal(ctx3.calls.warn.length, 0, '空 config → 零 warn');
});

test('T4.5 合并生效：mount.js 不再定义本地 resolveVerifyConfig/VERIFY_DEFAULTS，消费路径指向 lib/schema.js', () => {
  const src = fs.readFileSync(new URL('../lib/verify/mount.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from '../schema.js'"), 'mount.js 消费路径指向 lib/schema.js');
  assert.ok(!src.includes('function resolveVerifyConfig('), '本地 resolveVerifyConfig 定义已删');
  assert.ok(!src.includes('VERIFY_DEFAULTS = Object.freeze'), '本地 VERIFY_DEFAULTS 定义已删');
  // 导出面保持（re-export）：verify-mount.test.js 既有的 from mount.js import 不破
  assert.equal(typeof mountMod.resolveVerifyConfig, 'function');
  assert.equal(typeof mountMod.VERIFY_DEFAULTS, 'object');
});

test('T4.6 语义不变：mount.js 与 lib/schema.js 同一 resolveVerifyConfig（同源引用 + 边界行为一致）', () => {
  assert.equal(mountMod.resolveVerifyConfig, schemaResolve, 'mount.js re-export 即 lib/schema.js 原函数');
  // 边界抽查（与 verify-mount.test.js 既有用例同断言值）：P1-01 缺省默认开（等价 readCapability 合并）/ enforce / 非法 mode 回退 advisory
  assert.deepEqual(mountMod.resolveVerifyConfig({}), { enabled: true, mode: 'advisory' });
  assert.deepEqual(mountMod.resolveVerifyConfig({ capabilities: { verify: { enabled: false } } }), { enabled: false, mode: 'advisory' });
  assert.deepEqual(
    mountMod.resolveVerifyConfig({ capabilities: { verify: { enabled: true, mode: 'enforce' } } }),
    { enabled: true, mode: 'enforce' },
  );
  assert.deepEqual(
    mountMod.resolveVerifyConfig({ capabilities: { verify: { enabled: true, mode: 'weird' } } }),
    { enabled: true, mode: 'advisory' },
    '非法 mode 回退 advisory（gate 同语义）',
  );
});

test('T4.7 无越界：index.js 的 verify 挂载调用点原样保留（不触碰 gate.js/evidence.js）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('mountVerify(ctx, { root, config })'), 'mountVerify 挂载调用点未动');
  // 本 lane 改动文件白名单：只允许 index.js / verify/mount.js（源码面），gate.js / evidence.js 不在其列
  assert.ok(!src.includes('installEvidenceCapture('), 'index.js 无直接证据捕获调用（挂载经 mountVerify 单一接缝，注释提及不属调用）');
});
