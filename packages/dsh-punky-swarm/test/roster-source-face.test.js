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

// test/roster-source-face.test.js —— **`rosterSource` 面语义**的钉死用例
// （批 `punky-arch-refine-20261101` · lane `dg-impl` · Q-E=乙）
//
// 用户裁决：「roster 名册在适配层和引擎内核中间是**自建**」⇒ 该面的 `available` **只看自建表机制是否就绪**，
//   **不再探测宿主 `agentTeams`**。旧语义（探宿主团队服务）在非 Team 宿主上恒 false —— 那正是被废除的「降级」。
//
// 本文件三条核心命题：
//   AC-7 **与宿主无关**：喂一个**没有 `agentTeams`** 的 ctx，`rosterSource.available` 仍 `true`（改回探宿主必红）。
//   AC-8 **禁止「表非空」当就绪**：零批 store（建批期结构性恒空）也必须 `true`。
//   AC-9 **就绪判据可判读**：机制缺位时 `available:false` 且 `reason` 以 `roster-table-unwired:` 开头。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { capabilityReport } from '../lib/capabilities.js';
import { rosterTableReadyOf } from '../lib/tools/host-surface.js';
import { createStore } from '../lib/state/store.js';

const SILENT = { warn() {}, info() {}, error() {}, debug() {} };
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-roster-face-'));
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ } });

const faceOf = (store) => {
  const report = capabilityReport({ ports: { rosterSource: rosterTableReadyOf(store) } });
  return report.host.find((h) => h.key === 'rosterSource');
};

// ── AC-7：**与宿主无关**（本裁决的判别器）──────────────────────────────────────────────────
//   旧实现 `createRosterPort(ctx, null).available` 在「ctx 无 agentTeams」时为 false ⇒ 本断言必红。
test('AC-7 无 agentTeams 的 ctx ⇒ rosterSource.available === true（自建表就绪，与宿主无关）', () => {
  // 关键：store 是真实引擎 store；ctx 里**故意没有** agentTeams / agents 服务。
  const store = createStore(ROOT, { logger: SILENT });
  const face = faceOf(store);
  assert.equal(face.available, true,
    '自建表机制就绪 ⇒ 该面「有」；宿主有没有团队服务**不得**影响它（旧语义按宿主判 ⇒ 此处会红）');
  assert.equal(face.reason, null, 'available:true ⇒ reason 必须为 null');
});

// ── AC-8：**禁止「表非空」当就绪** ──────────────────────────────────────────────────────────
//   建批期表结构性恒空（同 batchId 不可重建 ⇒ raise 批 14/14 空）⇒ 用「表非空」判就绪 = 每个新批都判不可用。
test('AC-8 零批 store（表结构性恒空）⇒ 仍 available === true（禁把「表空」读成「不可用」）', () => {
  const emptyRoot = path.join(ROOT, 'empty-engine');
  const store = createStore(emptyRoot, { logger: SILENT });
  // 前置：全新引擎根 ⇒ 尚不存在 sessions 目录 ⇒ **零批**（不依赖 `listBatches` 的参数形状）
  assert.equal(typeof store.listBatches, 'function', '夹具前提：store 具备批枚举面');
  assert.equal(fs.existsSync(path.join(emptyRoot, 'sessions')), false, '夹具前提：全新引擎根，尚无 sessions 目录（零批）');
  const face = faceOf(store);
  assert.equal(face.available, true, '「表空」是建批期定义性状态，**不是**能力缺口');
});

// ── AC-9：机制缺位 ⇒ `available:false` 且成因可判读（不是静默、不是 false 无因）────────────────
test('AC-9 就绪判据可判读：机制缺位 ⇒ available:false 且 reason 以 roster-table-unwired: 开头', () => {
  const broken = { readBatch: () => null, listBatches: () => [] }; // 缺 markManagerRaised ③
  const ready = rosterTableReadyOf(broken);
  assert.equal(ready.available, false, '缺唯一写点 ⇒ 面没装');
  assert.match(String(ready.reason), /^roster-table-unwired:/, '成因须可判读并点名缺的条件；实际=' + ready.reason);
  assert.ok(String(ready.reason).includes('markManagerRaised'), '成因须点名**具体**缺的条件（可定位）');

  assert.equal(rosterTableReadyOf(null).available, false, 'store 完全缺失 ⇒ 面没装（不得静默当可用）');
  assert.match(String(rosterTableReadyOf(null).reason), /^roster-table-unwired: store$/);
});

// ── AC-10 反向锁：`available:false` 的成因**分两类**，只有「我方装配」类才该在启动告警里出现 ────────
//   落点：`lib/index.js` 的 `WIRED_ISSUE_RE`（`port-absent:` / `roster-table-unwired:`）。
//   本用例在**报告层**锁住这两类成因的形状 —— 若有人把命名改掉，启动告警的判别式会静默失效。
test('AC-10 成因分两类可辨：port-absent（我方没装端口）vs face-unavailable（宿主拿不到）', () => {
  const portAbsent = capabilityReport({ ports: {} }).host.find((h) => h.key === 'toolSurface');
  assert.equal(portAbsent.available, false, '词表内有该面但 ports 里没有 ⇒ 面没装');
  assert.match(String(portAbsent.reason), /^port-absent:/, '「没装端口」须用 port-absent: 前缀（启动告警据此前缀判）');

  const hostDown = capabilityReport({ ports: { toolSurface: { available: false } } }).host.find((h) => h.key === 'toolSurface');
  assert.equal(hostDown.available, false, '端口自报不可用 ⇒ 面不可用');
  assert.match(String(hostDown.reason), /^face-unavailable:/, '「宿主拿不到」须用 face-unavailable: 前缀（**不进**启动告警）');
});
