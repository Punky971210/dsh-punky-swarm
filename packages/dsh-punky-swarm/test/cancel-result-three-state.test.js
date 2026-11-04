// test/cancel-result-three-state.test.js
//
// 【批 `punky-three-tasks-20261103` · lane `impl-cancel`】T-B：`cancel` 回报面**三态**的可达用例。
//
// ## 修的是什么（T-B）
// `lib/ports.ts` 的 `AgentRuntime.cancel(runId): Promise<void>` **零回报**，而同一处注释本就写着
// 「语义为『停止等待』，**不得把未知当已停**」—— `void` 签名**结构性无法表达**该区分 ⇒ 报错黑洞。
// 本批改为 `Promise<CancelResult>`（`cancelled` / `skipped` / `rejected`），适配器把宿主返回**归一**到三态。
//
// ## 为什么必须测「归一」而不是只测「返回了个对象」
// 宿主的取消原语形态各异（对象 / 布尔 / undefined）。真正危险的是**不可识别形态**：
// 若实现把它默认成 `cancelled`，调用方就会以为「已停」⇒ 正是契约禁止的「把未知当已停」。
// 故 `undefined` / 垃圾值的用例是**fail-closed 的关键判别点**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAgentPort } from '../lib/provider-dsh/agent.js';

/** 夹具：宿主 subagent 服务的 `cancel` 返回指定形态。 */
const portOf = (cancelImpl) => createAgentPort({ subagents: { cancel: cancelImpl } });

test('V-1 宿主返回 {outcome:cancelled} ⇒ 透出 cancelled', async () => {
  const r = await portOf(async () => ({ outcome: 'cancelled' })).cancel('run-1');
  assert.deepEqual(r, { outcome: 'cancelled' }, '实测=' + JSON.stringify(r));
});

test('V-2 宿主返回布尔 true ⇒ cancelled（布尔取消原语）', async () => {
  const r = await portOf(async () => true).cancel('run-1');
  assert.deepEqual(r, { outcome: 'cancelled' }, '实测=' + JSON.stringify(r));
});

test('V-3 宿主返回 {outcome:skipped, reason} ⇒ skipped + 保留 reason（不是「已停」）', async () => {
  const r = await portOf(async () => ({ outcome: 'skipped', reason: 'run-not-found' })).cancel('run-1');
  assert.deepEqual(r, { outcome: 'skipped', reason: 'run-not-found' }, '实测=' + JSON.stringify(r));
  assert.notEqual(r.outcome, 'cancelled', 'skipped 绝不能被读成「已停」');
});

test('V-4 宿主返回布尔 false ⇒ skipped（不当作已停）', async () => {
  const r = await portOf(async () => false).cancel('run-1');
  assert.equal(r.outcome, 'skipped');
  assert.equal(typeof r.reason, 'string', 'skip 必须给出成因，便于调用方追');
});

test('V-5 ★fail-closed 关键点：宿主返回 {outcome:rejected} ⇒ rejected 透出', async () => {
  const r = await portOf(async () => ({ outcome: 'rejected', reason: 'host-refused' })).cancel('run-1');
  assert.deepEqual(r, { outcome: 'rejected', reason: 'host-refused' }, '实测=' + JSON.stringify(r));
});

test('V-6 ★fail-closed 关键点：宿主返回 undefined / null / 垃圾值 ⇒ **rejected**（禁默认 cancelled）', async () => {
  for (const raw of [undefined, null, 'ok', 42, { }, { outcome: 'unknown-state' }]) {
    const r = await portOf(async () => raw).cancel('run-1');
    assert.equal(r.outcome, 'rejected',
      '前契约零回报 ⇒ 不可识别形态必须判 rejected；实际 raw=' + JSON.stringify(raw) + ' ⇒ ' + JSON.stringify(r));
    assert.equal(r.reason, 'host-return-unrecognized', 'rejected 必须带可辨识成因');
    assert.notEqual(r.outcome, 'cancelled', '**绝不**把「不知道」当「已停」');
  }
});

test('V-7 null 适配器（bus）也必须显式三态、不得返 undefined（源码守卫）', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../lib/bus/index.js', import.meta.url)), 'utf8');
  assert.equal(/cancel:\s*async\s*\(\)\s*=>\s*\{\s*\}/.test(src), false,
    'null 适配器的 cancel **不得**仍是空函数体（那会返回 undefined ⇒ 契约违背）');
  assert.match(src, /cancel:\s*async\s*\(\)\s*=>\s*\(\s*\{\s*outcome:\s*'skipped'/,
    'null 适配器必须显式返回 skip 三态（无运行时 ⇒ 无对象可取消，但不是「已停」）');
});

test('V-8 变异（改回恒 void）：不可识别形态会退化成 undefined ⇒ 本文件的 V-6 必红', async () => {
  // 变异体 = 契约修复前的行为：把宿主返回**原样透出**（`Promise<void>` 语义）
  const voidAdapter = async (cancelImpl) => cancelImpl();
  const raw = await voidAdapter(async () => undefined);
  assert.equal(raw, undefined, '变异体确实退化为零回报');
  // 真实现的同一输入 ⇒ rejected（两者**读数不同** ⇒ V-6 对该变异有判别力）
  const real = await portOf(async () => undefined).cancel('run-1');
  assert.equal(real.outcome, 'rejected');
  assert.notEqual(raw, real.outcome,
    '变异（恒 void）与真实现的读数不同 ⇒ V-6 能抓住「把未知当已停」的回归');
});
