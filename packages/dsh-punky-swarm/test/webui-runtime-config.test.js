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

// webui-runtime-config——服务端受控白名单预检
//   （validateGovernancePayload 纯函数）与写通道集成（读-改-写保留 + validateOverlay 兜底 +
//   tmp+rename 原子写）。临时根一律落 D 盘（D:\dsh\_tmp\，用户落盘纪律）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateGovernancePayload, validateWatchPayload, createRuntimeConfigService } from '../lib/webui/runtime-config.js';

const TMP_BASE = 'D:\\dsh\\_tmp\\webui-config-build';
fs.mkdirSync(TMP_BASE, { recursive: true });
const freshRoot = () => fs.mkdtempSync(path.join(TMP_BASE, 'rtcfg-'));

// 合法受控 payload（表单字段全集形态）
const VALID = {
  governance: {
    hook: {
      enabled: true,
      preset: 'l1-sensitive',
      escalation: { enabled: false, threshold: 3, windowMs: 600000, primitives: ['DENY', 'NARROW'] },
      flags: { narrow: false },
    },
  },
};
const firstError = (r) => r.errors?.[0];

test('校验-1 顶层白名单：非对象 payload / 顶层未知键 → 400 invalid-value / unknown-top-level', () => {
  assert.equal(validateGovernancePayload(null).ok, false);
  assert.equal(validateGovernancePayload([1]).ok, false);
  assert.equal(validateGovernancePayload(42).ok, false);
  const r = validateGovernancePayload({ governance: { hook: {} }, capabilities: { x: 1 } });
  assert.equal(r.ok, false);
  assert.equal(firstError(r).field, 'capabilities');
  assert.equal(firstError(r).code, 'unknown-top-level');
});

test('校验-2 governance 仅 hook；governance/hook 缺失或非对象 → 400 invalid-value', () => {
  const r1 = validateGovernancePayload({ governance: { foo: 1, hook: {} } });
  assert.equal(r1.ok, false);
  assert.equal(firstError(r1).code, 'field-not-allowed');
  assert.equal(validateGovernancePayload({}).ok, false); // governance 缺失
  assert.equal(validateGovernancePayload({ governance: {} }).ok, false); // hook 缺失
  assert.equal(validateGovernancePayload({ governance: { hook: 'x' } }).ok, false);
});

test('校验-3 hook 表单外键（rules/defaults/pause/defer）→ 400 field-not-allowed（受控表单不开放任意规则 JSON）', () => {
  for (const key of ['rules', 'defaults', 'pause', 'defer']) {
    const r = validateGovernancePayload({ governance: { hook: { [key]: key === 'rules' ? [] : false } } });
    assert.equal(r.ok, false, `hook.${key} 必须拒绝`);
    assert.equal(firstError(r).code, 'field-not-allowed');
    assert.equal(firstError(r).field, `governance.hook.${key}`);
  }
});

test('校验-4 enabled 非布尔 → 400 invalid-value', () => {
  for (const v of ['true', 1, null, {}]) {
    const r = validateGovernancePayload({ governance: { hook: { enabled: v } } });
    assert.equal(r.ok, false);
    assert.equal(firstError(r).field, 'governance.hook.enabled');
    assert.equal(firstError(r).code, 'invalid-value');
  }
});

test('校验-5 preset 值域：合法 id 过 / 未知 id → unknown-preset / 非法形态与空数组 → invalid-value', () => {
  assert.equal(validateGovernancePayload(VALID).ok, true);
  assert.equal(validateGovernancePayload({ governance: { hook: { preset: 'l2-resource' } } }).ok, true);
  assert.equal(validateGovernancePayload({ governance: { hook: { preset: ['l1-sensitive', 'compose'] } } }).ok, true);
  const unknown = validateGovernancePayload({ governance: { hook: { preset: 'no-such' } } });
  assert.equal(unknown.ok, false);
  assert.equal(firstError(unknown).code, 'unknown-preset');
  const unknownArr = validateGovernancePayload({ governance: { hook: { preset: ['l1-sensitive', 'bogus'] } } });
  assert.equal(unknownArr.ok, false);
  assert.equal(firstError(unknownArr).code, 'unknown-preset');
  for (const bad of [[], 12, { id: 'x' }, true, ['']]) {
    const r = validateGovernancePayload({ governance: { hook: { preset: bad } } });
    assert.equal(r.ok, false, `preset=${JSON.stringify(bad)} 必须拒绝`);
    assert.equal(firstError(r).code, 'invalid-value');
  }
});

test('校验-6 escalation 值域：threshold<1/非整数、windowMs<1000/非数、primitives 越界（含 REQUIRE_APPROVAL）→ 400 invalid-value', () => {
  const esc = (over) => validateGovernancePayload({ governance: { hook: { escalation: { enabled: true, threshold: 3, windowMs: 600000, primitives: ['DENY'], ...over } } } });
  assert.equal(esc({}).ok, true);
  assert.equal(esc({ threshold: 1 }).ok, true);
  assert.equal(esc({ threshold: 0 }).ok, false);
  assert.equal(esc({ threshold: 2.5 }).ok, false);
  assert.equal(esc({ threshold: '3' }).ok, false);
  assert.equal(esc({ windowMs: 1000 }).ok, true);
  assert.equal(esc({ windowMs: 999 }).ok, false);
  assert.equal(esc({ windowMs: Infinity }).ok, false);
  assert.equal(esc({ primitives: ['DENY', 'NARROW', 'DEFER', 'PAUSE'] }).ok, true);
  assert.equal(esc({ primitives: ['REQUIRE_APPROVAL'] }).ok, false, 'REQUIRE_APPROVAL 红线不可配入');
  assert.equal(esc({ primitives: ['DENY', 'FOO'] }).ok, false);
  assert.equal(esc({ primitives: [] }).ok, false, '空列表引擎会回退默认 → 拒绝');
  assert.equal(esc({ primitives: 'DENY' }).ok, false);
  assert.equal(esc({ enabled: 'yes' }).ok, false);
  // escalation 段未知子键 → field-not-allowed
  const r = validateGovernancePayload({ governance: { hook: { escalation: { foo: 1 } } } });
  assert.equal(r.ok, false);
  assert.equal(firstError(r).code, 'field-not-allowed');
});

test('校验-7 flags：仅 narrow；narrow 非布尔 / pause、defer 在 flags 内 → 拒绝', () => {
  assert.equal(validateGovernancePayload({ governance: { hook: { flags: { narrow: true } } } }).ok, true);
  const nb = validateGovernancePayload({ governance: { hook: { flags: { narrow: 'yes' } } } });
  assert.equal(nb.ok, false);
  assert.equal(firstError(nb).field, 'governance.hook.flags.narrow');
  const p = validateGovernancePayload({ governance: { hook: { flags: { pause: true } } } });
  assert.equal(p.ok, false);
  assert.equal(firstError(p).code, 'field-not-allowed');
  const d = validateGovernancePayload({ governance: { hook: { flags: { defer: true } } } });
  assert.equal(d.ok, false);
  assert.equal(firstError(d).code, 'field-not-allowed');
});

test('校验-8 规则表冲突守卫：现有 overlay rules 非空 + preset 引用变化 → preset-conflicts-inline-rules；引用不变/无 rules → 过', () => {
  const manual = { governance: { hook: { rules: [{ id: 'R1', match: {}, violations: [] }] } } };
  // 现有文件 hook 含 preset 'l1-sensitive' + 手工 rules；提交换 preset → 拒
  const curHook = { preset: 'l1-sensitive', rules: manual.governance.hook.rules };
  const switchR = validateGovernancePayload({ governance: { hook: { preset: 'l2-resource' } } }, curHook);
  assert.equal(switchR.ok, false);
  assert.equal(firstError(switchR).code, 'preset-conflicts-inline-rules');
  // 省略 preset（=删键回静态）同样视为引用变化 → 拒
  const omitR = validateGovernancePayload({ governance: { hook: { enabled: false } } }, curHook);
  assert.equal(omitR.ok, false);
  assert.equal(firstError(omitR).code, 'preset-conflicts-inline-rules');
  // preset 引用不变 → 过（可保存其它字段）
  const same = validateGovernancePayload({ governance: { hook: { enabled: false, preset: 'l1-sensitive' } } }, curHook);
  assert.equal(same.ok, true);
  // 无手工 rules → 任意切换过
  const noRules = validateGovernancePayload({ governance: { hook: { preset: 'l2-resource' } } }, { preset: 'l1-sensitive' });
  assert.equal(noRules.ok, true);
});

test('校验-9 windowSeconds 秒语义值域（webui-config-fix2-20260904）：≥1 过 / <1、非数、字符串、Infinity 拒；与旧 windowMs 互斥', () => {
  const escOnly = (esc) => validateGovernancePayload({ governance: { hook: { escalation: esc } } });
  assert.equal(escOnly({ windowSeconds: 600 }).ok, true);
  assert.equal(escOnly({ windowSeconds: 1 }).ok, true);
  assert.equal(escOnly({ windowSeconds: 1.5 }).ok, true, '非整数秒 ×1000 = 1500ms 仍在 ms 合法域（引擎域）');
  assert.equal(escOnly({ windowSeconds: 0.5 }).ok, false, '<1s → 换算 500ms 越 ms 域');
  assert.equal(escOnly({ windowSeconds: 0 }).ok, false);
  assert.equal(escOnly({ windowSeconds: -1 }).ok, false);
  assert.equal(escOnly({ windowSeconds: '600' }).ok, false);
  assert.equal(escOnly({ windowSeconds: Infinity }).ok, false);
  assert.equal(escOnly({ windowSeconds: null }).ok, false);
  assert.equal(firstError(escOnly({ windowSeconds: 0 })).field, 'governance.hook.escalation.windowSeconds');
  // 新旧字段同送 → 互斥拒绝（歧义线协议）
  const both = escOnly({ windowSeconds: 60, windowMs: 60000 });
  assert.equal(both.ok, false);
  assert.equal(firstError(both).field, 'governance.hook.escalation.windowSeconds');
  assert.equal(firstError(both).code, 'invalid-value');
  // 旧 windowMs（ms）语义原样保持（向后兼容）
  assert.equal(escOnly({ windowMs: 1000 }).ok, true);
  assert.equal(escOnly({ windowMs: 999 }).ok, false);
});

test('写-1 首次写（文件缺失 bootstrap）：写全量 → runtime.json 落盘、governance 段精确、tmp 不残留', () => {
  const root = freshRoot();
  const svc = createRuntimeConfigService({ root });
  const out = svc.writeGovernance(VALID);
  assert.equal(out.ok, true);
  assert.deepEqual(out.written.hook, VALID.governance.hook);
  const file = path.join(root, 'config', 'runtime.json');
  assert.equal(fs.existsSync(file), true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(parsed, { governance: { hook: VALID.governance.hook } });
  assert.equal(fs.existsSync(path.join(root, 'config', '.runtime.json.tmp')), false, 'tmp 不残留');
});

test('写-2 读-改-写保留：其它顶层键 + 手工 rules 原样保留；escalation 缺省不动', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const manualRules = [{ id: 'M1', match: {}, violations: [] }];
  const base = {
    aip: { enabled: true },
    capabilities: { discovery: { enabled: true } },
    governance: { hook: { enabled: false, preset: 'l1-sensitive', rules: manualRules, escalation: { enabled: true, threshold: 5 } } },
  };
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(base, null, 2));
  const svc = createRuntimeConfigService({ root });
  // 同 preset 提交（表单保持 preset 选择）→ 守卫过；rules 保留
  const out = svc.writeGovernance({ governance: { hook: { enabled: true, preset: 'l1-sensitive', flags: { narrow: true } } } });
  assert.equal(out.ok, true);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal(parsed.aip.enabled, true, '其它顶层键保留');
  assert.deepEqual(parsed.capabilities, { discovery: { enabled: true } }, '其它顶层键保留');
  assert.equal(parsed.governance.hook.rules === manualRules, false, 'JSON 往返后为新引用');
  assert.deepEqual(parsed.governance.hook.rules, manualRules, '手工 rules 原样保留');
  assert.deepEqual(parsed.governance.hook.escalation, { enabled: true, threshold: 5 }, 'escalation 省略不动该段');
  assert.equal(parsed.governance.hook.enabled, true, 'enabled 更新');
  assert.equal(parsed.governance.hook.flags.narrow, true, 'flags.narrow 更新（flags 整段合并保留原键）');
});

test('写-3 preset 删键回出厂（省略 preset 键）；escalation 整段合并仅覆盖提交子键', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(
    { governance: { hook: { enabled: true, preset: 'l1-sensitive', escalation: { enabled: true, threshold: 7, windowMs: 300000 } } } }, null, 2));
  const svc = createRuntimeConfigService({ root });
  // 省略 preset → 删键回静态出厂（叠加语义 T4-4 模式）
  const out = svc.writeGovernance({ governance: { hook: { enabled: true, escalation: { enabled: false } } } });
  assert.equal(out.ok, true);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal('preset' in parsed.governance.hook, false, 'preset 键已删（回出厂空表）');
  assert.deepEqual(parsed.governance.hook.escalation,
    { enabled: false, threshold: 7, windowMs: 300000 }, 'escalation 整段合并：仅 enabled 覆盖，threshold/windowMs 保留');
});

test('写-4 validateOverlay 兜底与坏 base 处置：坏 base JSON → 500 不回写不覆盖', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const svc = createRuntimeConfigService({ root });
  // 坏 base（非 JSON / 非对象）→ ok:false status 500，文件原样保留（不吞不覆盖）
  fs.writeFileSync(path.join(dir, 'runtime.json'), '{ not-json', 'utf8');
  const bad = svc.writeGovernance(VALID);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 500);
  assert.match(bad.error, /unreadable/);
  assert.equal(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'), '{ not-json', '坏 base 不被覆盖');
  fs.writeFileSync(path.join(dir, 'runtime.json'), '[1,2]', 'utf8');
  const notObj = svc.writeGovernance(VALID);
  assert.equal(notObj.ok, false);
  assert.equal(notObj.status, 500);
});

test('写-5 400 校验拒绝不落盘（文件保持原样）', () => {
  const root = freshRoot();
  const svc = createRuntimeConfigService({ root });
  const out = svc.writeGovernance({ governance: { hook: { preset: 'no-such-preset' } } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(firstError(out).code, 'unknown-preset');
  assert.equal(fs.existsSync(path.join(root, 'config', 'runtime.json')), false, '拒绝不落盘');
});

test('写-6 多轮写叠加：enabled 翻转 + preset 切换（无 rules 场景）文件内容收敛', () => {
  const root = freshRoot();
  const svc = createRuntimeConfigService({ root });
  assert.equal(svc.writeGovernance(VALID).ok, true);
  const out2 = svc.writeGovernance({ governance: { hook: { enabled: false, preset: 'l2-resource', flags: { narrow: true } } } });
  assert.equal(out2.ok, true);
  const parsed = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime.json'), 'utf8'));
  assert.deepEqual(parsed.governance.hook, {
    enabled: false,
    preset: 'l2-resource',
    escalation: { enabled: false, threshold: 3, windowMs: 600000, primitives: ['DENY', 'NARROW'] },
    flags: { narrow: true },
  });
});

test('写-7 windowSeconds → windowMs 换算归一落盘（×1000；windowSeconds 为线协议键不落盘）', () => {
  const root = freshRoot();
  const svc = createRuntimeConfigService({ root });
  const out = svc.writeGovernance({
    governance: { hook: {
      enabled: true, preset: 'l1-sensitive',
      escalation: { enabled: true, threshold: 3, windowSeconds: 300, primitives: ['DENY'] },
      flags: { narrow: false },
    } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.written.hook.escalation.windowMs, 300000, 'written 回显 ms（×1000）');
  assert.equal('windowSeconds' in out.written.hook.escalation, false, 'windowSeconds 不落盘');
  const parsed = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime.json'), 'utf8'));
  assert.equal(parsed.governance.hook.escalation.windowMs, 300000);
  assert.equal('windowSeconds' in parsed.governance.hook.escalation, false);
});

test('写-8 窗口换算覆盖语义：windowSeconds 覆盖既有 windowMs；旧 windowMs 提交不二次换算', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(
    { governance: { hook: { escalation: { enabled: true, threshold: 7, windowMs: 600000, primitives: ['DENY'] } } } }, null, 2));
  const svc = createRuntimeConfigService({ root });
  // 新语义 windowSeconds 90 → 覆盖为 90000ms
  const s = svc.writeGovernance({ governance: { hook: { escalation: { enabled: true, windowSeconds: 90 } } } });
  assert.equal(s.ok, true);
  let parsed = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal(parsed.governance.hook.escalation.windowMs, 90000);
  // 旧语义 windowMs 45000 → 原样透传（不 ×1000 二次换算，向后兼容）
  const m = svc.writeGovernance({ governance: { hook: { escalation: { enabled: true, windowMs: 45000 } } } });
  assert.equal(m.ok, true);
  parsed = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal(parsed.governance.hook.escalation.windowMs, 45000);
  assert.equal(parsed.governance.hook.escalation.threshold, 7, '未提交子键保留');
});

// ── watch 写通道（新增）──
// validateWatchPayload 纯函数（payload = POST body 的 capabilities 段，字段名锚 capabilities.*）+ writeWatch
//   集成（读-改-写保留 / longrun 整段合并仅覆盖显式子键 / 双段任一 400 整写拒绝 / validateOverlay 兜底 500 /
//   原子写 / governance 键不受影响）。

// ---- validateWatchPayload：capabilities 段白名单仅 watch ----
test('watch校验-1 capabilities 段白名单仅 watch：discovery 等其它能力键 → field-not-allowed（400 code）', () => {
  for (const extra of ['discovery', 'verify', 'trajectory', 'topic']) {
    const r = validateWatchPayload({ [extra]: { enabled: true } });
    assert.equal(r.ok, false, `capabilities.${extra} 必须拒绝`);
    assert.equal(firstError(r).code, 'field-not-allowed');
    assert.equal(firstError(r).field, 'capabilities.' + extra, '字段名锚 capabilities.*');
  }
});

test('watch校验-2 watch 子键白名单仅 enabled/longrun：scanIntervalMinutes/maxMissed/probeTemplate → field-not-allowed', () => {
  for (const key of ['scanIntervalMinutes', 'intervalsMinutes', 'maxMissed', 'probeTemplate']) {
    const r = validateWatchPayload({ watch: { [key]: key === 'probeTemplate' ? 'hi' : 5 } });
    assert.equal(r.ok, false, `watch.${key} 必须拒绝（表单外键走手工 runtime.json 路径）`);
    assert.equal(firstError(r).code, 'field-not-allowed');
    assert.equal(firstError(r).field, 'capabilities.watch.' + key);
  }
});

test('watch校验-3 longrun 键白名单：仅 enabled + 阈值留门 maxDurationMs/noProgressWindowMs；其它 → field-not-allowed', () => {
  for (const key of ['scanIntervalMinutes', 'maxMissed', 'foo']) {
    const r = validateWatchPayload({ watch: { longrun: { [key]: 1 } } });
    assert.equal(r.ok, false, `watch.longrun.${key} 必须拒绝`);
    assert.equal(firstError(r).code, 'field-not-allowed');
    assert.equal(firstError(r).field, 'capabilities.watch.longrun.' + key);
  }
  // 合法：enabled + 双阈值同段过
  assert.equal(validateWatchPayload({ watch: { enabled: true, longrun: { enabled: false, maxDurationMs: 999000, noProgressWindowMs: 123000 } } }).ok, true);
});

test('watch校验-4 enabled 值域布尔：watch.enabled / longrun.enabled 非布尔 → invalid-value', () => {
  for (const v of ['true', 1, null, {}, []]) {
    const r1 = validateWatchPayload({ watch: { enabled: v } });
    assert.equal(r1.ok, false, `enabled=${JSON.stringify(v)} 必须拒绝`);
    assert.equal(firstError(r1).field, 'capabilities.watch.enabled');
    assert.equal(firstError(r1).code, 'invalid-value');
    const r2 = validateWatchPayload({ watch: { longrun: { enabled: v } } });
    assert.equal(r2.ok, false);
    assert.equal(firstError(r2).field, 'capabilities.watch.longrun.enabled');
    assert.equal(firstError(r2).code, 'invalid-value');
  }
});

test('watch校验-5 阈值留门值域（Leader 裁决 2）：正整数 ms ≥1 过 / 0、负数、小数、字符串、Infinity、NaN 拒', () => {
  const lr = (over) => validateWatchPayload({ watch: { longrun: { ...over } } });
  // 留门放行：正整数 ms ≥1（含 1 与超大整数，无引擎外上封顶）
  assert.equal(lr({ maxDurationMs: 1 }).ok, true);
  assert.equal(lr({ maxDurationMs: 1_200_000 }).ok, true);
  assert.equal(lr({ noProgressWindowMs: 1 }).ok, true);
  assert.equal(lr({ noProgressWindowMs: 300_000 }).ok, true);
  assert.equal(lr({ maxDurationMs: 1, noProgressWindowMs: 1 }).ok, true);
  // 拒绝：0 / 负数 / 小数 / 字符串 / Infinity / NaN
  for (const bad of [0, -5, 1.5, '100', Infinity, NaN]) {
    for (const k of ['maxDurationMs', 'noProgressWindowMs']) {
      const r = lr({ [k]: bad });
      assert.equal(r.ok, false, `${k}=${String(bad)} 必须拒绝`);
      assert.equal(firstError(r).field, 'capabilities.watch.longrun.' + k);
      assert.equal(firstError(r).code, 'invalid-value');
    }
  }
});

test('watch校验-6 结构形态：payload 非对象 → invalid-value；watch/longrun 非对象 → invalid-value；null/undefined = 无事可写 ok', () => {
  assert.equal(validateWatchPayload([1]).ok, false);
  assert.equal(firstError(validateWatchPayload([1])).field, 'capabilities');
  assert.equal(validateWatchPayload(42).ok, false);
  assert.equal(validateWatchPayload('x').ok, false);
  const wBad = validateWatchPayload({ watch: 'x' });
  assert.equal(wBad.ok, false);
  assert.equal(firstError(wBad).field, 'capabilities.watch');
  const lrBad = validateWatchPayload({ watch: { longrun: 5 } });
  assert.equal(lrBad.ok, false);
  assert.equal(firstError(lrBad).field, 'capabilities.watch.longrun');
  // 无 capabilities 段（null/undefined）= 无事可写（签名对称占位）
  assert.equal(validateWatchPayload(null).ok, true);
  assert.equal(validateWatchPayload(undefined).ok, true);
  assert.equal(validateWatchPayload({}).ok, true, '空 capabilities 段 = 无事可写');
});

test('watch校验-7 合法 payload 全过 + 错误码枚举沿用（UI 映射零新增）', () => {
  assert.equal(validateWatchPayload({ watch: { enabled: false } }).ok, true);
  assert.equal(validateWatchPayload({ watch: { longrun: { enabled: false } } }).ok, true);
  assert.equal(validateWatchPayload({ watch: { enabled: true, longrun: { enabled: true, maxDurationMs: 600000, noProgressWindowMs: 60000 } } }).ok, true);
  // 错误码集合未越枚举（沿用 governance 同枚举，UI 双语映射零新增）
  const codes = new Set();
  const collect = (r) => { for (const e of r.errors) codes.add(e.code); };
  collect(validateWatchPayload({ discovery: { enabled: true } }));
  collect(validateWatchPayload({ watch: { scanIntervalMinutes: 5 } }));
  collect(validateWatchPayload({ watch: { enabled: 'yes' } }));
  collect(validateWatchPayload({ watch: { longrun: { maxDurationMs: 0 } } }));
  assert.deepEqual([...codes].sort(), ['field-not-allowed', 'invalid-value']);
});

// ---- writeWatch 集成 ----

test('watch写-1 capabilities-only 首写：落盘 capabilities.watch 精确、written 仅含 capabilities、tmp 不残留', () => {
  const root = freshRoot();
  const svc = createRuntimeConfigService({ root });
  const out = svc.writeWatch({ capabilities: { watch: { enabled: false, longrun: { enabled: false } } } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.written, { capabilities: { watch: { enabled: false, longrun: { enabled: false } } } });
  const file = path.join(root, 'config', 'runtime.json');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { capabilities: { watch: { enabled: false, longrun: { enabled: false } } } });
  assert.equal('governance' in out.written, false, 'written 仅含本次实际提交段');
  assert.equal(fs.existsSync(path.join(root, 'config', '.runtime.json.tmp')), false, 'tmp 不残留（原子写）');
});

test('watch写-2 读-改-写保留：capabilities 其余子键 + watch 深层键 + 其它顶层键 + governance 键全保留', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const base = {
    aip: { enabled: true },
    mailbox: { sweepOnStart: false },
    capabilities: {
      discovery: { enabled: true, port: 3333 },
      watch: {
        enabled: true, scanIntervalMinutes: 5, maxMissed: 3, probeTemplate: 'hi {lane}',
        longrun: { enabled: true, maxDurationMs: 999000, noProgressWindowMs: 123000 },
      },
    },
    governance: { hook: { preset: 'l1-sensitive', enabled: true } },
  };
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(base, null, 2));
  const svc = createRuntimeConfigService({ root });
  // 只提交 watch.enabled + longrun.enabled（表单两开关）——深层键与其它段全部原样
  const out = svc.writeWatch({ capabilities: { watch: { enabled: false, longrun: { enabled: false } } } });
  assert.equal(out.ok, true);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal(parsed.aip.enabled, true, '其它顶层键保留');
  assert.deepEqual(parsed.mailbox, { sweepOnStart: false }, '其它顶层键保留');
  assert.deepEqual(parsed.capabilities.discovery, { enabled: true, port: 3333 }, 'capabilities 其余子键原样保留');
  assert.deepEqual(parsed.capabilities.watch, {
    enabled: false, scanIntervalMinutes: 5, maxMissed: 3, probeTemplate: 'hi {lane}',
    longrun: { enabled: false, maxDurationMs: 999000, noProgressWindowMs: 123000 },
  }, 'watch 深层键保留；longrun 整段合并仅覆盖显式提交子键（enabled），阈值原样');
  assert.deepEqual(parsed.governance, base.governance, 'governance 键不受影响');
  // written.capabilities = 合并后 capabilities 全量（含 discovery）
  assert.equal(out.written.capabilities.discovery.enabled, true);
  assert.equal(out.written.capabilities.watch.enabled, false);
  assert.equal('governance' in out.written, false);
});

test('watch写-3 merge-only 省略语义：省略子键 = 不动（不删键）——阈值与 enabled 均保留/翻转各自独立', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(
    { capabilities: { watch: { enabled: false, longrun: { enabled: true, maxDurationMs: 999000 } } } }, null, 2));
  const svc = createRuntimeConfigService({ root });
  // ① 只提交 watch.enabled:true → longrun 段（含 enabled 与阈值）不动
  const out1 = svc.writeWatch({ capabilities: { watch: { enabled: true } } });
  assert.equal(out1.ok, true);
  let parsed = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal(parsed.capabilities.watch.enabled, true, 'watch.enabled 更新');
  assert.deepEqual(parsed.capabilities.watch.longrun, { enabled: true, maxDurationMs: 999000 }, '省略 longrun 键 → 该段原样不动');
  // ② 只提交 longrun.enabled:false → watch.enabled 保持
  const out2 = svc.writeWatch({ capabilities: { watch: { longrun: { enabled: false } } } });
  assert.equal(out2.ok, true);
  parsed = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  assert.equal(parsed.capabilities.watch.enabled, true, '省略 enabled → 不动');
  assert.deepEqual(parsed.capabilities.watch.longrun, { enabled: false, maxDurationMs: 999000 }, 'longrun 整段合并仅覆盖 enabled，阈值保留');
});

test('watch写-4 双段合并：governance + capabilities.watch 同 body 单保存 → 两段各自合并落盘（Leader 裁决 1）', () => {
  const root = freshRoot();
  const svc = createRuntimeConfigService({ root });
  const out = svc.writeWatch({
    governance: { hook: { enabled: true, preset: 'l1-sensitive', flags: { narrow: true } } },
    capabilities: { watch: { enabled: false, longrun: { enabled: false } } },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.written.governance.hook.preset, 'l1-sensitive');
  assert.deepEqual(out.written.capabilities.watch, { enabled: false, longrun: { enabled: false } });
  const parsed = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime.json'), 'utf8'));
  assert.equal(parsed.governance.hook.enabled, true);
  assert.equal(parsed.governance.hook.flags.narrow, true);
  assert.deepEqual(parsed.capabilities.watch, { enabled: false, longrun: { enabled: false } });
});

test('watch写-5 双段任一 400 → 整写拒绝（无部分写，文件不落盘/保持原样）', () => {
  // (a) governance 非法 + capabilities 合法 → 400，文件不创建
  const rootA = freshRoot();
  const svcA = createRuntimeConfigService({ root: rootA });
  const a = svcA.writeWatch({
    governance: { hook: { preset: 'no-such' } },
    capabilities: { watch: { enabled: true } },
  });
  assert.equal(a.ok, false);
  assert.equal(a.status, 400);
  assert.equal(firstError(a).code, 'unknown-preset');
  assert.equal(fs.existsSync(path.join(rootA, 'config', 'runtime.json')), false, '整写拒绝不落盘');
  // (b) governance 合法 + capabilities 非法 → 400；既有文件不被部分写
  const rootB = freshRoot();
  const dirB = path.join(rootB, 'config');
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirB, 'runtime.json'), JSON.stringify({ aip: { enabled: true } }, null, 2));
  const svcB = createRuntimeConfigService({ root: rootB });
  const b = svcB.writeWatch({
    governance: { hook: { enabled: true, preset: 'l1-sensitive' } },
    capabilities: { watch: { enabled: 'yes' } },
  });
  assert.equal(b.ok, false);
  assert.equal(b.status, 400);
  assert.equal(firstError(b).field, 'capabilities.watch.enabled');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirB, 'runtime.json'), 'utf8')), { aip: { enabled: true } }, '无部分写（文件保持原样）');
});

test('watch写-6 顶层白名单：governance/capabilities 之外顶层键 → unknown-top-level；payload 非对象 → invalid-value', () => {
  const root = freshRoot();
  const svc = createRuntimeConfigService({ root });
  const r = svc.writeWatch({ capabilities: { watch: { enabled: true } }, ghost: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(firstError(r).code, 'unknown-top-level');
  assert.equal(firstError(r).field, 'ghost');
  assert.equal(fs.existsSync(path.join(root, 'config', 'runtime.json')), false, '拒绝不落盘');
  const notObj = svc.writeWatch('x');
  assert.equal(notObj.ok, false);
  assert.equal(notObj.status, 400);
  assert.equal(firstError(notObj).code, 'invalid-value');
});

test('watch写-7 validateOverlay 兜底：base 含 watcher 非法顶层键（手工坏文件）→ 500 overlay-rejected，不回写不覆盖', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  // 手工 base 含 validateOverlay 拒绝的未知顶层键（watcher 合法面之外，仅 commitOverlay 全量兜底能拦）
  const baseRaw = JSON.stringify({ capabilities: { discovery: { enabled: true } }, ghostTop: { x: 1 } }, null, 2);
  fs.writeFileSync(path.join(dir, 'runtime.json'), baseRaw, 'utf8');
  const svc = createRuntimeConfigService({ root });
  const out = svc.writeWatch({ capabilities: { watch: { enabled: false } } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 500);
  assert.match(out.error, /overlay-rejected/);
  assert.equal(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'), baseRaw, '兜底失败不回写不覆盖');
  assert.equal(fs.existsSync(path.join(dir, '.runtime.json.tmp')), false, 'tmp 不残留');
});

test('watch写-8 坏 base JSON → 500 unreadable 不回写（与 governance 写通道同口径）', () => {
  const root = freshRoot();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), '{ not-json', 'utf8');
  const svc = createRuntimeConfigService({ root });
  const out = svc.writeWatch({ capabilities: { watch: { enabled: false } } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 500);
  assert.match(out.error, /unreadable/);
  assert.equal(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'), '{ not-json', '坏 base 不被覆盖');
});
