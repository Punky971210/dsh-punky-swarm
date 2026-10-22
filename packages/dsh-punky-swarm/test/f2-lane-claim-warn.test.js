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

// `lane_claim` 接管留痕的**真实 cx 形状**回归（2026-10-22 真机验证 #2 失败后的补测）
//
// 为什么单开一件（不改 f2-lock-takeover.test.js）：
//   `punky-fix-f2-20261022` 的 AC-8 用「手搓 deps + 假 logger」验收据 ⇒ 单元面绿，**真机零留痕**。
//   根因：装配面是 `createTools(ctx, deps)` → `const cx = { ctx, deps, store, root, config }`
//   （`lib/tools/core.js:193`）⇒ **`ctx` 在 `cx` 顶层，`deps` 里没有 `ctx`**。写成 `deps?.ctx?.logger`
//   时 `warn` 仍是函数（`lock.js` 会走告警分支），但内部取不到 logger ⇒ 静默无输出、还被 try/catch 吞掉。
//
// 判据形态（本件的存在意义）：
//   · 阳性：**真实 cx 形状**（`ctx.logger` 有值）⇒ force 接管必须恰 1 条含 `lane lock 接管` 的 warn；
//   · 阴性：**旧错误形状**（`ctx` 无 logger、只有 `deps.ctx.logger`）⇒ 必须 0 条——
//     证明「用假 deps 注入」这类验收据**结构上抓不到**该缺陷（防后人再把判据改回注入式）；
//   · 首建（非接管）不计留痕：同一把锁首次 claim 必须 0 条（防「任何 claim 都告警」的假绿）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';

const SESS_ID = 'sess-f2-warn';

/** 记录 warn 的假 logger（只实现 warn；其余交给 noop）。 */
function fakeLogger() {
  const warns = [];
  return {
    warns,
    logger: {
      warn: (m) => { warns.push(String(m)); },
      info: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

/** 真实装配形状：`ctx` 顶层带 logger（与宿主一致）。 */
function harnessReal(logger) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f2warn-real-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} }, logger };
  const { tools } = createTools(ctx, { store, root });
  const tool = Object.fromEntries(tools.map((t) => [t.name, t]))['lane_claim'];
  return { root, store, tool };
}

/** 旧错误形状：`ctx` 无 logger，只有 `deps.ctx.logger`（复刻 2026-10-22 的那个写法）。 */
function harnessLegacyShape(logger) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f2warn-legacy-'));
  const store = createStore(root);
  const ctx = { tools: { register: () => {}, guard: () => {} } }; // 无 logger
  const { tools } = createTools(ctx, { store, root, ctx: { logger } }); // 旧写法把 ctx 塞进 deps
  const tool = Object.fromEntries(tools.map((t) => [t.name, t]))['lane_claim'];
  return { root, store, tool };
}

const CLAIM = { batchId: 'b-f2-warn', lane: 'v1', session: SESS_ID };

test('lane_claim 接管留痕（真实 cx 形状）：首建 0 条，force 接管恰 1 条且写明 fence 递进', async () => {
  const { warns, logger } = fakeLogger();
  const { tool } = harnessReal(logger);

  const first = await tool.execute({ ...CLAIM }, { agent: { session: { id: SESS_ID } } });
  assert.equal(first.ok, true, '首次认领应成功（阳性对照：同调用、只少一步接管）');
  assert.equal(warns.length, 0, '首建锁不是接管 ⇒ 不得留痕');

  const second = await tool.execute({ ...CLAIM, force: true }, { agent: { session: { id: SESS_ID } } });
  assert.equal(second.ok, true, 'force 接管应成功');
  assert.equal(warns.length, 1, '接管必须恰留 1 条（多了=重复告警，少了=静默接管）');
  assert.match(warns[0], /lane lock 接管/, 'warn 文案须点明「接管」');
  assert.match(warns[0], /fence 1→2/, 'warn 文案须含 fence 递进（可审计的代数证据）');
  assert.equal((warns[0].match(/\[dsh-punky-swarm\]/g) ?? []).length, 1,
    '前缀恰 1 次（F2-G02：双前缀会让日志检索噪声化）');
});

test('lane_claim 接管留痕（旧错误形状 · 阴性对照）：只把 ctx 塞进 deps ⇒ 必 0 条（证明注入式验收据抓不到）', async () => {
  const { warns, logger } = fakeLogger();
  const { tool } = harnessLegacyShape(logger);

  await tool.execute({ ...CLAIM }, { agent: { session: { id: SESS_ID } } });
  const second = await tool.execute({ ...CLAIM, force: true }, { agent: { session: { id: SESS_ID } } });
  assert.equal(second.ok, true, '锁本身仍应成功（缺陷只在留痕面）');
  assert.equal(warns.length, 0,
    '旧形状下必然 0 条留痕 —— 本断言是「防判据退化」的锁：若有人把 buildLaneTools 改回读 deps.ctx.logger，'
    + '第一条阳性用例会红，而这条会继续绿；两条同时存在才能把判据钉在真实装配形状上');
});
