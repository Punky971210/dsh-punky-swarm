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

// F3 · `lane_claim` reason 透传（F2-G07）验收套件 —— spec AC-7，按 Leader 裁定口径（A）：
//   · **force 档三档**必须拿到**具体** reason（`lock-unparseable` / `lock-legacy-format` / `takeover-contended`）；
//   · **非 force 档**只判「**不被无条件折叠**」：上游有 reason 就透传、无 reason 回落 `'lane locked'`。
//     ⚠ 可达性限制（`lib/lock.js` 冻结，本批不动）：非 force 分支**本就不产生 reason**（`acquire` 的两个
//     `return {ok:false, conflict:true, lockPath}` 无 `reason` 键）⇒ 「非 force 拿到具体 reason」在冻结面上
//     **结构性不可达**；故非 force 一侧只断言兜底文案与类型，透传分支由 force 三档证成。
//   · 三档 reason **互不相同** 且都 ≠ `'lane locked'` —— 这是「不被折叠」的反证式判据（折叠实现会在此变红）。
//
// 运行形态：`node --import ./test/helpers/isolated-home.preload.mjs --test test/f3-lane-claim-reason.test.js`
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { lockPath } from '../lib/tools/tier-gate.js';
import { tempRoot } from './helpers/gate-fixture.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = 'sess-f3-reason';

function execOf(session) {
  return { agent: { session: { id: session } } };
}
function toolCtx() {
  return { tools: { register: () => {}, guard: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } };
}
/** 真实装配形状（与 `test/f2-lane-claim-warn.test.js` 同源：`ctx` 在 `cx` 顶层）。 */
function harness(prefix) {
  const root = tempRoot(prefix);
  const store = createStore(root);
  const { tools } = createTools(toolCtx(), { store, root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, store, claim: byName.lane_claim };
}
/** 在 lane 的锁路径上预置一份锁文件（返沪路径供调用方进一步布置票号）。 */
function seedLock(root, batchId, lane, content) {
  const lp = lockPath(root, S, batchId, lane);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  fs.writeFileSync(lp, typeof content === 'string' ? content : JSON.stringify(content));
  return lp;
}
/** output.schema 键面校验（`additionalProperties:false` ⇒ 多一个键就是契约破坏）。 */
function assertConforms(tool, value, label) {
  const schema = tool.output.schema;
  const props = Object.keys(schema.properties);
  for (const key of Object.keys(value)) {
    assert.ok(props.includes(key), label + '：返回键 `' + key + '` 不在 output.schema.properties 内（契约破坏）');
  }
  for (const req of Object.keys(schema.properties).filter((k) => schema.properties[k].required === true)) {
    assert.ok(Object.prototype.hasOwnProperty.call(value, req), label + '：缺少必填键 `' + req + '`');
  }
  if (value.reason !== undefined) assert.equal(typeof value.reason, 'string', label + '：reason 必须是字符串');
}

test('T-3/AC-7 force 档三档必须拿到具体 reason，且三档互不相同（不被折叠）', async () => {
  const h = harness('f3-reason-force-');
  const exec = execOf(S);

  // ① 不可解析锁 ⇒ lock-unparseable
  seedLock(h.root, 'b-r', 'l-unparse', '{not-json');
  const rUnparse = await h.claim.execute({ batchId: 'b-r', lane: 'l-unparse', force: true, session: S }, exec);
  // ② 旧格式锁（有 token、缺 fence）⇒ lock-legacy-format
  seedLock(h.root, 'b-r', 'l-legacy', { token: 'stale-token' });
  const rLegacy = await h.claim.execute({ batchId: 'b-r', lane: 'l-legacy', force: true, session: S }, exec);
  // ③ 票号被占（well-formed 锁 + 新鲜票号 ⇒ 回收不了 ⇒ 接管竞争）⇒ takeover-contended
  const lpContended = seedLock(h.root, 'b-r', 'l-contended', { token: 'holder', ts: Date.now(), pid: process.pid, fence: 1 });
  fs.writeFileSync(lpContended + '.takeover-2', JSON.stringify({ token: 'other', ts: Date.now() }), 'utf8');
  const rContended = await h.claim.execute({ batchId: 'b-r', lane: 'l-contended', force: true, session: S }, exec);

  assert.equal(rUnparse.ok, false);
  assert.equal(rUnparse.conflict, true);
  assert.equal(rUnparse.reason, 'lock-unparseable', '不可解析锁必须如实透传（不得折叠为 lane locked）');
  assert.equal(rLegacy.reason, 'lock-legacy-format', '旧格式锁必须如实透传');
  assert.equal(rContended.reason, 'takeover-contended', '接管竞争必须如实透传');

  // 反折叠反证：三档必须互不相同，且都不是通用文案
  const reasons = [rUnparse.reason, rLegacy.reason, rContended.reason];
  assert.equal(new Set(reasons).size, 3, '三档 reason 互不相同（折叠实现会在此变红）');
  assert.equal(reasons.includes('lane locked'), false, '具体成因不得被折叠为通用文案 `lane locked`');

  // 三档返回都必须在 output.schema 契约内（`reason` 字段本就存在 ⇒ schema 零变更）
  assertConforms(h.claim, rUnparse, 'unparseable');
  assertConforms(h.claim, rLegacy, 'legacy');
  assertConforms(h.claim, rContended, 'contended');
});

test('T-3 RED 基线：HEAD 的工具面把三档成因硬折叠为同一文案（透传表达式在 HEAD 不存在）', () => {
  const headSrc = execFileSync('git', ['show', 'HEAD:./lib/tools/member-tools.js'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.ok(headSrc.includes("reason: 'lane locked'"), 'RED 基线：HEAD 的折叠实现必须在场');
  assert.equal(headSrc.includes("typeof r.reason === 'string'"), false,
    'RED 基线：HEAD 无透传表达式（⇒ 修前三档必然同一文案，本组 force 用例在 HEAD 上会红）');
  // 现役实现必须有透传表达式（结构面证据；行为面证据见上方 force 三档用例）
  const nowSrc = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'tools', 'member-tools.js'), 'utf8');
  assert.ok(nowSrc.includes("typeof r.reason === 'string'"), '现役实现必须含透传表达式');
  // 兜底文案在工具面**只留一处**（其余同族文案在 lib/lock.js 常量侧，不在工具面造词）
  assert.equal((nowSrc.split("'lane locked'").length - 1) >= 1, true);
});

test('T-3/AC-7 非 force 档：上游无 reason ⇒ 回落 lane locked；成功路径形状与 output.schema 未变', async () => {
  const h = harness('f3-reason-fallback-');
  const exec = execOf(S);

  // 阳性对照：合法认领成功（形状 `{ok, token}`，不附加 reason）
  const ok = await h.claim.execute({ batchId: 'b-n', lane: 'l-ok', session: S }, exec);
  assert.equal(ok.ok, true);
  assert.equal(typeof ok.token, 'string');
  assert.deepEqual(Object.keys(ok).sort(), ['ok', 'token'], '成功路径返回形状逐字未变（不得附加 reason 键）');
  assertConforms(h.claim, ok, 'claim-ok');

  // 非 force 冲突：上游（`lib/lock.js` 非 force 分支）无 reason ⇒ 必须回落兜底文案
  const conflict = await h.claim.execute({ batchId: 'b-n', lane: 'l-ok', session: S }, exec);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.reason, 'lane locked', '上游无 reason ⇒ 兜底文案（防 undefined 泄漏进 schema）');
  assert.equal(typeof conflict.reason, 'string');
  assertConforms(h.claim, conflict, 'claim-fallback');

  // output.schema 零变更（键面 + 封闭性）：reason 本就在册，故「透传」不需要改契约
  const schema = h.claim.output.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['conflict', 'lockPath', 'ok', 'reason', 'token'],
    'output.schema 键面必须与修前一致（2 键失败面 + token/lockPath）');
  assert.equal(schema.properties.reason.type, 'string');
});
