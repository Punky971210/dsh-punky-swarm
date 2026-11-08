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

// 【⑥-2 · 2026-11-08 裁决丙「两套人工闸合并为一个 ask」】allowlist 判定的现役被测面。
//
// ── 语义变更（旧口径已退役，勿照旧注释读）──────────────────────────────────────────────
//   旧：`tools/tier-gate.js` 的 guard 直接判 allowlist，`ask` 落成**同步拒绝串**
//       （`approval-needed-409: <tool>`），调用方须自带 `approval.digest` 票据重发。
//   新：allowlist 判据归 `governance/wiring.js` 的 **pre-execute hook**，与内核规则共用**同一套**
//       ask 机制（`REQUIRE_APPROVAL`：收据 `ask` 块 + 宿主 serviceAsk + 事后回填）。
//       票据语义保留：`approval.digest === canonicalDigest(参数去掉 approval)` ⇒ 视为已批准、直接放行。
//   ⇒ `ASK_REQUIRED_409` / `ASK_APPROVAL_ARGS_MISMATCH` 两个前缀**整条退役**（本文件末尾有退役锁）。
//
// ── 判据纪律 ────────────────────────────────────────────────────────────────────────
//   · **两态成对**：每条「拒/ask」都必须有同夹具的「放行」对照，证明拒不是恒真；
//   · **身份集合**：断言收据的 `decision.primitive` / `ruleRefs`，不用命中计数；
//   · **作用域不变**：allowlist 只治理执行型工具（`allowlistScope` = `config.escalation.execTools`
//     缺省 `EXEC_TOOLS`），治理工具面不受影响 —— 这条是搬迁时最容易丢的边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { installGovernanceHook } from '../lib/governance/wiring.js';
import { canonicalDigest, ALLOWLIST_DENIED } from '../lib/governance/allowlist.js';
import { readRefusals, refusalDirOf } from '../lib/governance/receipt-store.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const SESSION = 'sess-i19';
const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/** 组装 hook。`allowlist` 缺省（undefined）= 未配置（整段关闭）；`{}` 之外的 scope 可覆写。 */
function makeHook({ allowlist, scope } = {}) {
  const root = tempRoot('i19-');
  const handlers = {};
  const ctx = {
    on: (name, fn) => { handlers[name] = fn; return () => {}; },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  };
  const store = {
    readGovernance: () => ({ lastAssign: { difficulty: 'B', form: 'B', at: new Date('2026-01-01T00:00:00.000Z').toISOString() } }),
    stale: () => false,
  };
  const config = allowlist === undefined ? {} : { tools: { allowlist } };
  const hook = installGovernanceHook(ctx, {
    store, root, config, allowlistScope: scope ?? ['write', 'pwsh', 'bash', 'edit'],
  });
  assert.equal(hook.installed, true, 'hook 须装配成功（root + ctx.on 齐备）');
  const pre = handlers['tools/pre-execute'];
  assert.equal(typeof pre, 'function', 'pre-execute 钩子须已挂载');
  return { pre, root, receipts: () => readRefusals(root, SESSION) };
}

/** 执行型调用（非只读 shell 旁路、在默认 scope 内）。 */
function writeExec(args) {
  return { name: 'write', callId: 'call-i19', arguments: args, agent: { session: { id: SESSION } } };
}

const PASS_NEXT = async () => 'NEXT';

test('I-19-1 default deny：空白名单 ⇒ hook 返回 deny（前缀 allowlist-denied + 工具名），并落收据', async () => {
  const { pre, receipts } = makeHook({ allowlist: [] });
  const ret = await pre(writeExec({ path: 'a.md', content: 'x' }), PASS_NEXT);
  assert.equal(ret.kind, 'deny', 'kind 必须是 deny');
  assert.ok(String(ret.reason).includes(ALLOWLIST_DENIED), '拒因须含 allowlist-denied，收到：' + ret.reason);
  assert.ok(String(ret.reason).includes('write'), '拒因须带工具名');
  assert.deepEqual(receipts().map((r) => r.decision.primitive), ['DENY'], '拒态收据原语 = DENY');
  assert.deepEqual(receipts().flatMap((r) => r.ruleRefs), ['tools.allowlist'], '收据可溯源到 allowlist');
});

test('I-19-2 ask 走宿主审批：需批准且无票据 ⇒ kind=ask + 收据带 ask 块（不再是同步拒绝串）', async () => {
  const { pre, receipts } = makeHook({ allowlist: [{ tool: 'write', requireApproval: true }] });
  const ret = await pre(writeExec({ path: 'a.md', content: 'x' }), PASS_NEXT);
  assert.equal(ret.kind, 'ask', 'ask 必须走宿主审批（合并后的唯一 ask 通道）');
  assert.equal(typeof ret.reason, 'string');
  const [r] = receipts();
  assert.equal(r.decision.primitive, 'REQUIRE_APPROVAL', '收据原语 = REQUIRE_APPROVAL');
  assert.ok(r.ask && r.ask.channel === 'host-serviceAsk', '收据须带 ask 块（合并的实质：同一套审批面）');
  assert.equal(r.ask.outcome, undefined, '初始态 outcome 未定（由 post-execute 回填）');
});

test('I-19-2b 对照：同一夹具换成「不需批准」的白名单 ⇒ 放行（ask 不是恒真）', async () => {
  const { pre, receipts } = makeHook({ allowlist: ['write'] });
  const ret = await pre(writeExec({ path: 'a.md', content: 'x' }), PASS_NEXT);
  assert.equal(ret, 'NEXT', '放行时穿透到 next()');
  assert.deepEqual(receipts(), [], '放行零收据');
});

test('I-19-3 批准 + 原参数 ⇒ 放行（签名重放命中，票据能力保留）', async () => {
  const args = { path: 'a.md', content: 'x' };
  const digest = canonicalDigest(args);
  const { pre, receipts } = makeHook({ allowlist: [{ tool: 'write', requireApproval: true }] });
  const ret = await pre(writeExec({ ...args, approval: { digest } }), PASS_NEXT);
  assert.equal(ret, 'NEXT', '票据与参数一致 ⇒ 放行');
  assert.deepEqual(receipts(), [], '放行零收据');
});

test('I-19-4 批准后改参数 ⇒ deny（approval-args-mismatch，且两摘要确实不同）', async () => {
  const approvedArgs = { path: 'a.md', content: 'x' };
  const tamperedArgs = { path: 'b.md', content: 'x' };
  const digest = canonicalDigest(approvedArgs);
  assert.notEqual(canonicalDigest(tamperedArgs), digest, '夹具前提：改参后摘要必须不同');
  const { pre, receipts } = makeHook({ allowlist: [{ tool: 'write', requireApproval: true }] });
  const ret = await pre(writeExec({ ...tamperedArgs, approval: { digest } }), PASS_NEXT);
  assert.equal(ret.kind, 'deny');
  assert.ok(String(ret.reason).includes('approval-args-mismatch'), '拒因须含 approval-args-mismatch，收到：' + ret.reason);
  assert.deepEqual(receipts().map((r) => r.decision.primitive), ['DENY']);

  // 对照：换成「当前参数」的摘要 ⇒ 同一构造立刻放行
  const { pre: pre2 } = makeHook({ allowlist: [{ tool: 'write', requireApproval: true }] });
  assert.equal(await pre2(writeExec({ ...tamperedArgs, approval: { digest: canonicalDigest(tamperedArgs) } }), PASS_NEXT),
    'NEXT', '票据与当前参数一致 ⇒ 放行（证「拒」不是恒真）');
});

test('I-19-5 未配置白名单 ⇒ 整段不执行（旧行为零变化的两态对照）', async () => {
  const plain = makeHook({});
  assert.equal(await plain.pre(writeExec({ path: 'a.md', content: 'x' }), PASS_NEXT), 'NEXT', '未配置 ⇒ 放行');
  assert.deepEqual(plain.receipts(), [], '未配置 ⇒ 零收据');

  // 对照：配置空表 ⇒ 同一调用被拒（「未配置」与「空表」是两回事）
  const strict = makeHook({ allowlist: [] });
  const ret = await strict.pre(writeExec({ path: 'a.md', content: 'x' }), PASS_NEXT);
  assert.equal(ret.kind, 'deny', '空表 = 启用且 default deny');
});

test('I-19-6 作用域不变：scope 外的工具即便空白名单也放行（allowlist 只治理执行型工具）', async () => {
  const { pre } = makeHook({ allowlist: [], scope: ['pwsh'] });
  const governanceCall = { name: 'batch_status', callId: 'c2', arguments: {}, agent: { session: { id: SESSION } } };
  assert.equal(await pre(governanceCall, PASS_NEXT), 'NEXT', '治理工具不受 allowlist 治理（边界沿用原实现）');
});

test('I-19-7 退役锁：tier-gate 不再判 allowlist，两个旧前缀在 lib/ 零命中（防回生）', () => {
  const codeLinesOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//'));
  const gate = codeLinesOf(path.join(PKG, 'lib', 'tools', 'tier-gate.js')).join('\n');
  assert.equal(/decideAllowlist|canonicalDigest/.test(gate), false, 'tier-gate 不得再引 allowlist 判据');
  assert.equal(/approval-needed-409|approval-args-mismatch/.test(gate), false, '旧前缀不得在可执行行里残留');
  // 全 lib 面：旧「409 同步拒」语义只允许出现在注释里作沿革说明
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(abs); continue; }
      if (!ent.name.endsWith('.js') || ent.name === 'client.js') continue;
      const src = fs.readFileSync(abs, 'utf8');
      for (const line of src.split('\n')) {
        if (line.trim().startsWith('//')) continue;
        if (/ASK_REQUIRED_409|ASK_APPROVAL_ARGS_MISMATCH/.test(line)) hits.push(path.relative(PKG, abs) + ': ' + line.trim());
      }
    }
  };
  walk(path.join(PKG, 'lib'));
  assert.deepEqual(hits, [], '旧常量不得在可执行行里复活：' + JSON.stringify(hits));
});
