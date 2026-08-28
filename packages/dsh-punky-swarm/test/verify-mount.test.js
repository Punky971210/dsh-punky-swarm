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

// C3 verify 引擎级接线单测（装配统一决策包 §4.2 验收 A2.1-A2.3）：
// A2.1 enabled=true：mountVerify 挂 tools/post-execute 监听 → 真实派发 → blob + ledger 落盘、count()>0、
//     pass-through 不断链、dispose 退订无残留；捕获证据可经 evaluateAcEvidence 消费出裁决（audit lane DI 可消费）
// A2.2 enabled=false：installed:false、不注册监听、零副作用（无 verify 目录产生）
// A2.3 ctx.on 缺失：静默降级不 throw
// A2.3 DI 路径保留：createCompletionGate 原语义（enabled=false → skipped；enforce → 拦截）+ 显式 installEvidenceCapture 语义
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountVerify, resolveVerifyConfig } from '../lib/verify/mount.js';
import { installEvidenceCapture, readBlob, readLedger, storeBlob } from '../lib/verify/evidence.js';
import { createCompletionGate, evaluateAcEvidence } from '../lib/verify/gate.js';

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

test('A2.1 enabled=true：挂载注册 post-execute 监听，真实派发 → blob+ledger 落盘、count>0、pass-through 不断链', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const ctx = makeCtx();
  const m = mountVerify(ctx, { root, config: { capabilities: { verify: { enabled: true } } } });
  assert.equal(m.installed, true, 'enabled=true 应安装');
  assert.equal(m.mode, 'advisory', '缺省 mode advisory');
  assert.ok(ctx.has('tools/post-execute'), 'post-execute 监听已注册');
  assert.equal(typeof ctx.get('tools/post-execute'), 'function');

  // 真实 post-execute 派发（read 工具 → quote_with_location 证据）
  const exec = { name: 'read', callId: 'c-1', arguments: { file_path: '/tmp/x.md' }, agent: { session: { id: 'sess-1' } } };
  const { ret, nextCalls } = dispatch(ctx.get('tools/post-execute'), exec, { content: 'hello evidence' });
  assert.equal(ret, 'NEXT', 'pass-through：listener 返回 next() 结果，不断链');
  assert.equal(nextCalls, 1, 'next 被调用一次');
  assert.equal(m.count(), 1, '捕获计数 1');

  // blob + ledger 落盘（<root>/verify/）
  const blobs = fs.readdirSync(path.join(root, 'verify', 'blobs'));
  assert.equal(blobs.length, 1, '内容寻址 blob 落盘');
  const ledgerPath = path.join(root, 'verify', 'ledger-sess-1.jsonl');
  assert.ok(fs.existsSync(ledgerPath), 'ledger-<session>.jsonl 落盘');
  const entries = readLedger(root, 'sess-1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, 'read');
  assert.equal(entries[0].blobKey, blobs[0].replace(/\.json$/, ''), '台账引用同一 blobKey');

  // blob 读校验（内容哈希核对）通过 → 证据可消费
  const blob = readBlob(root, entries[0].blobKey);
  assert.equal(blob.tool, 'read');
  assert.equal(blob.ok, true);

  // dispose 退订无残留
  m.dispose();
  assert.ok(!ctx.has('tools/post-execute'), '退订后监听无残留');
  m.dispose(); // 幂等
});

test('A2.1 端到端：引擎级捕获证据 → evaluateAcEvidence 消费裁决 done（audit lane DI 可消费）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const ctx = makeCtx();
  const m = mountVerify(ctx, { root, config: { capabilities: { verify: { enabled: true, mode: 'advisory' } } } });
  assert.equal(m.installed, true);

  // 派发与 AC 清单匹配的 read 调用
  const exec = { name: 'read', callId: 'c-2', arguments: { file_path: '/tmp/y.md' }, agent: { session: { id: 'sess-2' } } };
  dispatch(ctx.get('tools/post-execute'), exec, { content: 'evidence for AC1' });

  // audit lane DI 消费路径：AC 清单 × 捕获台账 → 绑定 → 三态裁决（A2.3 DI 路径保留的端到端证明）
  const ledger = readLedger(root, 'sess-2');
  const out = evaluateAcEvidence({
    acList: [{ id: 'AC1', tool: 'read', args: { file_path: '/tmp/y.md' } }],
    ledger,
    readBlob: (key) => readBlob(root, key),
    mode: 'advisory',
  });
  assert.equal(out.result.status, 'done', '证据满足 AC → done');
  assert.equal(out.result.defects.length, 0);
  assert.equal(out.acBindings.length, 1);
  assert.equal(out.acBindings[0].acId, 'AC1');

  // 未匹配 AC（不同 args）→ MISSING_EVIDENCE
  const out2 = evaluateAcEvidence({
    acList: [{ id: 'AC2', tool: 'read', args: { file_path: '/tmp/other.md' } }],
    ledger,
    readBlob: (key) => readBlob(root, key),
    mode: 'enforce',
  });
  assert.equal(out2.result.status, 'failed');
  assert.ok(out2.result.defects.some((d) => d.code === 'MISSING_EVIDENCE'), '缺绑定 → failed');
  assert.equal(out2.result.intercepted, true, 'enforce 拦截');

  m.dispose();
});

test('A2.2 P1-01 缺省默认开：缺省配置 installed:true；显式 enabled=false → installed:false、零副作用', () => {
  // 缺省（config 无 capabilities 键）：verify 默认开（resolveVerifyConfig 等价 readCapability 合并）→ installed:true
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const ctx = makeCtx();
  const m = mountVerify(ctx, { root, config: {} });
  assert.equal(m.installed, true, '缺省配置 → verify 默认开（P1-01 行为变更，旧「缺省关」为旧行为断言）');
  assert.ok(ctx.has('tools/post-execute'), '缺省默认开 → post-execute 监听注册');
  m.dispose();
  // 显式关：installed:false、不注册监听、零副作用（无 verify 目录产生）
  const ctx2 = makeCtx();
  const m2 = mountVerify(ctx2, { root, config: { capabilities: { verify: { enabled: false } } } });
  assert.equal(m2.installed, false);
  assert.equal(m2.reason, 'disabled');
  assert.ok(!ctx2.has('tools/post-execute'), '无监听注册');
  assert.ok(!fs.existsSync(path.join(root, 'verify')), '无 verify 目录产生（零副作用）');
});

test('A2.3 ctx.on 缺失：静默降级不 throw（宿主能力缺失）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const m = mountVerify({ logger: console }, { root, config: { capabilities: { verify: { enabled: true } } } });
  assert.equal(m.installed, false);
  assert.equal(m.reason, 'ctx.on unavailable');
  assert.equal(m.count(), 0, '零捕获');
  // root 缺失同源降级
  const m2 = mountVerify(makeCtx(), { config: { capabilities: { verify: { enabled: true } } } });
  assert.equal(m2.installed, false);
  assert.equal(m2.reason, 'ctx.on unavailable');
});

test('A2.3 DI 路径保留：createCompletionGate 原语义（enabled 门控 evaluate）+ 显式 installEvidenceCapture', () => {
  // 关：evaluate 返回 skipped（零运行时开销），gate 不拦截
  const offGate = createCompletionGate({ config: { capabilities: { verify: { enabled: false } } } });
  assert.equal(offGate.enabled, false);
  const r0 = offGate.evaluate({ acBindings: [{ acId: 'AC1', selectorRef: 's' }], evidence: null });
  assert.equal(r0.skipped, true);
  assert.equal(r0.status, 'done');
  assert.equal(r0.intercepted, false);

  // enforce：显式装配启用 → 缺证据拦截
  const gate = createCompletionGate({ config: { capabilities: { verify: { enabled: true, mode: 'enforce' } } } });
  assert.equal(gate.enabled, true);
  assert.equal(gate.mode, 'enforce');
  const r1 = gate.evaluate({
    acBindings: [{ acId: 'AC1', selectorRef: 'AC1:hash' }],
    evidence: { bindingsFor: () => [], readBlob: () => { throw new Error('n/a'); } },
  });
  assert.equal(r1.status, 'failed');
  assert.equal(r1.intercepted, true, 'enforce 拦截');
  assert.ok(r1.defects.some((d) => d.code === 'MISSING_EVIDENCE'));

  // advisory：同缺陷只记录不拦截
  const gate2 = createCompletionGate({ config: { capabilities: { verify: { enabled: true, mode: 'advisory' } } } });
  const r2 = gate2.evaluate({
    acBindings: [{ acId: 'AC1', selectorRef: 'AC1:hash' }],
    evidence: { bindingsFor: () => [], readBlob: () => { throw new Error('n/a'); } },
  });
  assert.equal(r2.intercepted, false, 'advisory 不拦截');
  assert.ok(r2.message.includes('advisory'), 'advisory 记录提示');

  // audit lane 显式 installEvidenceCapture（DI 消费路径本身不动）：root 显式传入 → 独立捕获实例
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const cap = installEvidenceCapture(makeCtx(), { root, enabled: true });
  assert.equal(cap.installed, true);
  cap.dispose();
  const capOff = installEvidenceCapture(makeCtx(), { root, enabled: false });
  assert.equal(capOff.installed, false, '显式 enabled=false → 不安装');
});

test('resolveVerifyConfig 边界：P1-01 缺省默认开 / mode 非法回退 advisory', () => {
  // P1-01 行为变更：缺省 = VERIFY_DEFAULTS {enabled:true}（等价 readCapability 合并；旧「缺省关」为旧行为断言）
  assert.deepEqual(resolveVerifyConfig({}), { enabled: true, mode: 'advisory' });
  assert.deepEqual(resolveVerifyConfig({ capabilities: {} }), { enabled: true, mode: 'advisory' });
  assert.deepEqual(resolveVerifyConfig({ capabilities: { verify: { enabled: false } } }), { enabled: false, mode: 'advisory' });
  assert.deepEqual(resolveVerifyConfig({ capabilities: { verify: { enabled: true } } }), { enabled: true, mode: 'advisory' });
  assert.deepEqual(resolveVerifyConfig({ capabilities: { verify: { enabled: true, mode: 'enforce' } } }), { enabled: true, mode: 'enforce' });
  assert.deepEqual(resolveVerifyConfig({ capabilities: { verify: { enabled: true, mode: 'weird' } } }), { enabled: true, mode: 'advisory' }, '非法 mode 回退 advisory（gate 同语义）');
});

test('A2.1 控制面工具不产证据（CONTROL_PLANE_TOOLS 兜底）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-vm-'));
  const ctx = makeCtx();
  const m = mountVerify(ctx, { root, config: { capabilities: { verify: { enabled: true } } } });
  // wave_plan（控制面）→ 不产证据；write（领域工具）→ 产证据
  dispatch(ctx.get('tools/post-execute'), { name: 'wave_plan', callId: 'c-3', arguments: {}, agent: { session: { id: 'sess-3' } } }, { content: 'plan' });
  assert.equal(m.count(), 0, '控制面工具不产证据');
  dispatch(ctx.get('tools/post-execute'), { name: 'write', callId: 'c-4', arguments: { file_path: '/tmp/a.md' }, agent: { session: { id: 'sess-3' } } }, { content: 'x' });
  assert.equal(m.count(), 1, 'write 证据捕获');
  m.dispose();
});
