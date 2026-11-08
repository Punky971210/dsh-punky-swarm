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

// 证据捕获面单测（裁决侧已退役，本面只剩「捕获 → 台账」一条活路）：
//   A2.1 enabled=true：挂 tools/post-execute → 真实派发 → ledger 落盘、count()>0、pass-through 不断链、dispose 退订无残留
//   A2.2 缺省默认开；显式 enabled=false → installed:false、零副作用
//   A2.3 ctx.on / root 缺失 → 静默降级不 throw
//   A2.4 只有「可复核产物类」工具产证据（KIND_BY_TOOL 是唯一判据，无第二份排除名单）
//   A2.5 退役面守卫：裁决侧模块与注册表不再回流
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountVerify, resolveVerifyConfig } from '../lib/verify/mount.js';
import { installEvidenceCapture } from '../lib/verify/evidence.js';
import * as selector from '../lib/verify/selector.js';

// fake ctx（参照 trajectory.test.js R5 先例）：可查注册表、可派发、可退订
function makeCtx() {
  const registered = new Map();
  return {
    logger: { info() {}, warn() {}, error() {} },
    on: (ev, fn) => { registered.set(ev, fn); return () => { registered.delete(ev); }; },
    has: (ev) => registered.has(ev),
    get: (ev) => registered.get(ev),
  };
}

// 真实 post-execute 派发形状：exec（ToolExecution）→ result → next 透传
function dispatch(listener, exec, result) {
  let nextCalls = 0;
  const ret = listener(exec, result, () => { nextCalls++; return 'NEXT'; });
  return { ret, nextCalls };
}

const ledgerPathOf = (root, sessionId) => path.join(root, 'verify', 'ledger-' + sessionId + '.jsonl');
const readLedgerLines = (root, sessionId) => {
  const file = ledgerPathOf(root, sessionId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
};

test('A2.1 enabled=true：挂载注册 post-execute 监听，真实派发 → ledger 落盘、count>0、pass-through 不断链', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const ctx = makeCtx();
  const m = mountVerify(ctx, { root, config: { capabilities: { verify: { enabled: true } } } });
  assert.equal(m.installed, true, 'enabled=true 应安装');
  assert.ok(ctx.has('tools/post-execute'), 'post-execute 监听已注册');
  assert.equal(typeof ctx.get('tools/post-execute'), 'function');

  // 真实 post-execute 派发（read 工具 → quote_with_location 证据）
  const exec = { name: 'read', callId: 'c-1', arguments: { file_path: '/tmp/x.md' }, agent: { session: { id: 'sess-1' } } };
  const { ret, nextCalls } = dispatch(ctx.get('tools/post-execute'), exec, { content: 'hello evidence' });
  assert.equal(ret, 'NEXT', 'pass-through：listener 返回 next() 结果，不断链');
  assert.equal(nextCalls, 1, 'next 被调用一次');
  assert.equal(m.count(), 1, '捕获计数 1');

  const entries = readLedgerLines(root, 'sess-1');
  assert.equal(entries.length, 1, 'ledger-<session>.jsonl 落盘一行');
  assert.equal(entries[0].tool, 'read');
  assert.equal(entries[0].kind, 'quote_with_location');
  assert.equal(entries[0].ok, true);
  assert.equal(entries[0].summary, 'hello evidence', '摘要内联在台账行里（无 blob 层）');
  assert.equal(typeof entries[0].selectorKey, 'string');
  assert.ok(!fs.existsSync(path.join(root, 'verify', 'blobs')), '不产 blob 目录（内容寻址层已退役）');

  // dispose 退订无残留
  m.dispose();
  assert.ok(!ctx.has('tools/post-execute'), '退订后监听无残留');
  m.dispose(); // 幂等
});

test('A2.2 缺省默认开：缺省配置 installed:true；显式 enabled=false → installed:false、零副作用', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const ctx = makeCtx();
  const m = mountVerify(ctx, { root, config: {} });
  assert.equal(m.installed, true, '缺省配置 → verify 默认开');
  assert.ok(ctx.has('tools/post-execute'), '缺省默认开 → post-execute 监听注册');
  m.dispose();

  const ctx2 = makeCtx();
  const m2 = mountVerify(ctx2, { root, config: { capabilities: { verify: { enabled: false } } } });
  assert.equal(m2.installed, false);
  assert.equal(m2.reason, 'disabled');
  assert.ok(!ctx2.has('tools/post-execute'), '无监听注册');
  assert.ok(!fs.existsSync(path.join(root, 'verify')), '无 verify 目录产生（零副作用）');
});

test('A2.3 ctx.on / root 缺失：静默降级不 throw（宿主能力缺失）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const m = mountVerify({ logger: console }, { root, config: { capabilities: { verify: { enabled: true } } } });
  assert.equal(m.installed, false);
  assert.equal(m.reason, 'ctx.on unavailable');
  assert.equal(m.count(), 0, '零捕获');
  const m2 = mountVerify(makeCtx(), { config: { capabilities: { verify: { enabled: true } } } });
  assert.equal(m2.installed, false);
  assert.equal(m2.reason, 'ctx.on unavailable');
});

test('A2.4 只有「可复核产物类」工具产证据：KIND_BY_TOOL 是唯一判据', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const ctx = makeCtx();
  const m = mountVerify(ctx, { root, config: { capabilities: { verify: { enabled: true } } } });
  const fire = (name, id) => dispatch(
    ctx.get('tools/post-execute'),
    { name, callId: id, arguments: {}, agent: { session: { id: 'sess-3' } } },
    { content: name + '-out' },
  );
  // 控制面 / 治理面 / 纯查询：都不产证据
  fire('wave_plan', 'c-3');
  fire('member_settle', 'c-4');
  fire('todo_write', 'c-5');
  assert.equal(m.count(), 0, '非产物类工具不产证据');
  // 四类可复核产物：都产证据
  fire('write', 'c-6');
  fire('pwsh', 'c-7');
  fire('glob', 'c-8');
  fire('grep', 'c-9');
  assert.equal(m.count(), 4, '四类可复核产物各产一条');
  assert.deepEqual(
    readLedgerLines(root, 'sess-3').map((e) => e.tool),
    ['write', 'pwsh', 'glob', 'grep'],
    '台账按发射顺序追加',
  );
  m.dispose();
});

test('A2.5 退役面守卫：裁决侧模块不得回流，selector 只留规范化与哈希', () => {
  const gateFile = new URL('../lib/verify/gate.js', import.meta.url);
  assert.equal(fs.existsSync(gateFile), false, 'lib/verify/gate.js 已退役（接线属功能立项，不在重构范围）');
  assert.deepEqual(
    Object.keys(selector).sort(),
    ['canonicalizeArgs', 'stableHash'],
    'selector 导出面只剩两个纯函数（注册表/冻结器已随裁决侧退役）',
  );
});

test('resolveVerifyConfig 边界：缺省默认开 / 显式关才关', () => {
  assert.deepEqual(resolveVerifyConfig({}), { enabled: true });
  assert.deepEqual(resolveVerifyConfig({ capabilities: {} }), { enabled: true });
  assert.deepEqual(resolveVerifyConfig({ capabilities: { verify: { enabled: false } } }), { enabled: false });
  assert.deepEqual(resolveVerifyConfig({ capabilities: { verify: { enabled: true } } }), { enabled: true });
  // 非布尔值一律按开（只有显式 false 才关）
  assert.deepEqual(resolveVerifyConfig({ capabilities: { verify: { enabled: 'no' } } }), { enabled: true });
});

test('A2.1 显式 DI：installEvidenceCapture 幂等安装与关闭', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const cap = installEvidenceCapture(makeCtx(), { root, enabled: true });
  assert.equal(cap.installed, true);
  cap.dispose();
  const capOff = installEvidenceCapture(makeCtx(), { root, enabled: false });
  assert.equal(capOff.installed, false, '显式 enabled=false → 不安装');
});
