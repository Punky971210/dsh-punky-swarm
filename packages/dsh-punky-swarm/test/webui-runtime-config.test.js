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

// webui-config-build-20260903 / 设计 §3 测试表：webui-runtime-config——服务端受控白名单预检
//   （validateGovernancePayload 纯函数，§1.4）与写通道集成（读-改-写保留 + validateOverlay 兜底 +
//   tmp+rename 原子写，§1.5）。临时根一律落 D 盘（D:\dsh\_tmp\webui-config-build\，用户落盘纪律）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateGovernancePayload, createRuntimeConfigService } from '../lib/webui/runtime-config.js';

const TMP_BASE = 'D:\\dsh\\_tmp\\webui-config-build';
fs.mkdirSync(TMP_BASE, { recursive: true });
const freshRoot = () => fs.mkdtempSync(path.join(TMP_BASE, 'rtcfg-'));

// 合法受控 payload（§1.2 表单字段全集形态）
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
