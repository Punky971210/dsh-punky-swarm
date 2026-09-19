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

// E 阶段（模式跟随）契约套件：全局装载 / 不全局生效（2026-09-16 用户裁决）
//   语义锚：`config.modes.gate` 未配置或 null ⇒ 全模式生效（旧行为）；字符串数组 ⇒ 白名单；
//           [] ⇒ 显式停用；非法形态 ⇒ 回落 + 告警；子会话（Manager/worker）继承父会话模式。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { normalizeModeGate, modeActiveFor, presetOfSession, isChildSession } from '../lib/engine/dispatch.js';
import { MODE_GATED_TOOLS } from '../lib/engine/suite.js';
import { validateOverlay, ALLOWED_TOP_KEYS } from '../lib/hot/config-watch.js';
import { seedTeamAssetSkills, withDefaultTeam } from './helpers/host-skills.mjs';

// 【P1 同步】`team` 现为必填且必须解析到资产 ⇒ 本套件（被检面是模式门）建批统一补 software-team；
//   其 skills 须可解析 ⇒ 隔离 HOME 下先注入宿主技能根。
seedTeamAssetSkills('software-team');

const MODE = 'punky-preset';

function newHarness(config = {}, root = null) {
  const r = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'punky-mode-'));
  const store = createStore(r);
  const registered = [];
  const guards = [];
  const ctx = {
    tools: { register: (t) => registered.push(t), guard: (fn) => { guards.push(fn); return () => {}; } },
    logger: { warn: () => {}, info: () => {} },
  };
  const readConfig = () => config;
  const { tools } = createTools(ctx, { store, root: r, config, readConfig });
  return { store, tools, guards, ctx, root: r, byName: withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t]))) };
}

const sess = (preset, extra = {}) => ({ agent: { session: { id: 's-' + preset, header: { agentPreset: preset, ...extra } } } });

// ── 纯函数面 ──────────────────────────────────────────────────────────────────
test('M1 normalizeModeGate：缺省/null=全模式生效；数组=白名单；[]=显式停用；非法回落+告警', () => {
  const warns = [];
  assert.equal(normalizeModeGate(undefined, (m) => warns.push(m)), null);
  assert.equal(normalizeModeGate(null, (m) => warns.push(m)), null);
  assert.deepEqual(normalizeModeGate([MODE], (m) => warns.push(m)), [MODE]);
  assert.deepEqual(normalizeModeGate([], (m) => warns.push(m)), []);
  assert.deepEqual(normalizeModeGate(['a', 'b'], (m) => warns.push(m)), ['a', 'b']);
  // 非法：非数组 / 元素非字符串 / 空串 → 回落 null 且告警（宁可见旧行为也不要幽灵配置）
  assert.equal(normalizeModeGate('punky-preset', (m) => warns.push(m)), null);
  assert.equal(normalizeModeGate([1], (m) => warns.push(m)), null);
  assert.equal(normalizeModeGate([''], (m) => warns.push(m)), null);
  assert.equal(warns.length, 3);
  assert.match(warns[0], /modes\.gate/);
});

test('M2 presetOfSession / isChildSession：从 header 取模式；子会话按 delegationDepth|parentSession 判定', () => {
  assert.equal(presetOfSession(sess(MODE)), MODE);
  assert.equal(presetOfSession({ agent: { session: { id: 'x', header: {} } } }), null);
  assert.equal(presetOfSession({}), null);
  assert.equal(isChildSession(sess(MODE)), false);
  assert.equal(isChildSession(sess(MODE, { delegationDepth: 1 })), true);
  assert.equal(isChildSession(sess(MODE, { parentSession: 's-parent' })), true);
});

test('M3 modeActiveFor：缺省全模式生效；白名单命中/未命中；无 header 按未命中；子会话继承', () => {
  assert.equal(modeActiveFor({}, sess('liangshen')), true, '未配置 modes.gate ⇒ 旧行为（全模式生效）');
  assert.equal(modeActiveFor({ modes: { gate: null } }, sess('liangshen')), true);
  assert.equal(modeActiveFor({ modes: { gate: [MODE] } }, sess(MODE)), true);
  assert.equal(modeActiveFor({ modes: { gate: [MODE] } }, sess('liangshen')), false);
  assert.equal(modeActiveFor({ modes: { gate: [MODE] } }, sess('standard')), false);
  assert.equal(modeActiveFor({ modes: { gate: [MODE] } }, { agent: { session: { id: 's', header: {} } } }), false,
    '未记录 preset 的会话（无 header.agentPreset）按未命中 ⇒ 不介入');
  assert.equal(modeActiveFor({ modes: { gate: [MODE] } }, sess('liangshen', { delegationDepth: 1 })), true,
    '子会话继承父会话模式（Manager 结算面不被误锁）');
  assert.equal(modeActiveFor({ modes: { gate: [] } }, sess(MODE)), false, '[] = 显式停用');
});

// ── guard 面（难度门禁） ───────────────────────────────────────────────────────
function fireGuard(h, exec, name = 'pwsh') {
  const reasons = [];
  for (const g of h.guards) { const r = g({ name, arguments: {}, ...exec }); if (r) reasons.push(r); }
  return reasons;
}

test('G1 guard：白名单外模式 ⇒ 难度门禁全放行且**不计数**（其他模式零影响）', () => {
  const h = newHarness({ modes: { gate: [MODE] } });
  const exec = sess('liangshen');
  assert.deepEqual(fireGuard(h, exec), []);
  assert.equal(h.store.readGovernance('s-liangshen')?.execToolCount ?? 0, 0, '未生效模式不写治理状态（不计数）');
});

test('G2 guard：白名单内模式且未评估 ⇒ 照旧拦（本模式治理不被削弱）', () => {
  const h = newHarness({ modes: { gate: [MODE] } });
  const reasons = fireGuard(h, sess(MODE));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /\[task-difficulty-gate\]/);
  assert.equal(h.store.readGovernance('s-' + MODE)?.execToolCount, 1, '生效模式照常计数');
});

test('G3 guard：未配置 modes.gate ⇒ 保持旧行为（未评估即拦）', () => {
  const h = newHarness({});
  const reasons = fireGuard(h, sess('liangshen'));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /\[task-difficulty-gate\]/);
});

// ── 套件工具面 ────────────────────────────────────────────────────────────────
test('T1 套件工具：白名单外模式 ⇒ 拒 GATE_MODE_INACTIVE（先于 G1 档位语义）', async () => {
  const h = newHarness({ modes: { gate: [MODE] } });
  await assert.rejects(
    () => h.byName.wave_plan.execute({ batchId: 'b-x', tasks: [{ id: 't1', cmd: 'x' }] }, sess('liangshen')),
    (e) => /GATE_MODE_INACTIVE/.test(e.message) && /modes\.gate/.test(e.message),
  );
  await assert.rejects(
    () => h.byName.member_status.execute({ batchId: 'b-x', lane: 'e1', status: 'running' }, sess('standard')),
    (e) => /GATE_MODE_INACTIVE/.test(e.message),
  );
});

test('T2 套件工具：白名单内模式但非 C 档 ⇒ 抛 G1 的 GATE_BATCH_REQUIRES_C（模式门不掩盖档位门）', async () => {
  const h = newHarness({ modes: { gate: [MODE] } });
  await assert.rejects(
    () => h.byName.wave_plan.execute({ batchId: 'b-y', tasks: [{ id: 't1', cmd: 'x' }] }, sess(MODE)),
    (e) => /GATE_BATCH_REQUIRES_C/.test(e.message),
  );
});

// ── 热更入口 ──────────────────────────────────────────────────────────────────
test('H1 热更：modes / dispatch 已进 ALLOWED_TOP_KEYS，overlay 校验放行；未知键仍拒', () => {
  assert.ok(ALLOWED_TOP_KEYS.has('modes'));
  assert.ok(ALLOWED_TOP_KEYS.has('dispatch'));
  assert.equal(validateOverlay({ modes: { gate: [MODE] } }).ok, true);
  assert.equal(validateOverlay({ dispatch: { provider: 'spawn', gate: 'warn' } }).ok, true);
  assert.equal(validateOverlay({ modes2: { gate: [MODE] } }).ok, false, '未知顶层键（防幽灵配置）仍拒');
});

test('H2 热更快照生效：同一工具面，白名单由热更快照切换（无需重启）', () => {
  const cfg = { modes: { gate: [MODE] } };
  const h = newHarness(cfg);
  // readConfig 返回同一对象引用 ⇒ 模拟 runtime.json 覆盖后的新快照
  assert.deepEqual(fireGuard(h, sess('liangshen')), [], '切换前：白名单外不介入');
  const next = { modes: { gate: [MODE, 'liangshen'] } };
  // 通过替换 config 对象内容模拟快照更新（readConfig 读同一引用）
  Object.assign(cfg, next);
  const reasons = fireGuard(h, sess('liangshen'));
  assert.equal(reasons.length, 1, '白名单加入该模式后，门禁立即生效（热更）');
  assert.match(reasons[0], /\[task-difficulty-gate\]/);
});

// ── 模式门反向用例：注册表本批新补 5 件（批 `suite-registry-20260916`） ─────────
// 口径同 T1，**逐件一条**：非白名单模式 + 最小合法入参 ⇒ 拒 `GATE_MODE_INACTIVE`，且**零治理写入**
//   （`lane_claim` 不落锁、`asset_claim` 不复制、`assign_check` 不写 `lastAssign`）。
// 用例名单与注册表对账：每件必须在 `MODE_GATED_TOOLS` 内（防「用例写了但表里没有」的两面漂移）。
const NEW_GATED_CASES = [
  ['batch_phase', { batchId: 'b-x', phase: 'running' }],
  ['lane_claim', { batchId: 'b-x', lane: 'e1' }],
  ['lane_release', { batchId: 'b-x', lane: 'e1', token: 'tok-x' }],
  ['asset_claim', { batchId: 'b-x', source: 'C:\\tmp\\probe.md', target: 'probe.md' }],
  ['assign_check', { difficulty: 'C', rationale: '反向用例占位判据（模式门先于档位校验，不入 governance）' }],
  // 【P3a control lane 追加】`batch_control` 亦须受模式门（非生效模式零治理写入）——追加在既有 5 件之后，
  //   既有 5 件的顺序与判据零变化。
  ['batch_control', { batchId: 'b-x', action: 'pause' }],
];

test('T3 模式门反向用例（注册表新补 6 件）：非白名单模式逐件拒 GATE_MODE_INACTIVE 且零治理写入', async () => {
  const h = newHarness({ modes: { gate: [MODE] } });
  const sid = 's-standard';
  assert.equal(NEW_GATED_CASES.length, 6, '本批新补 6 件须各一条反向用例（batch_phase/lane_claim/lane_release/asset_claim/assign_check + P3a batch_control）');
  for (const [name] of NEW_GATED_CASES) {
    assert.ok(MODE_GATED_TOOLS.includes(name), name + ' 必须在注册表 modeGate 集内（用例名单与注册表对账）');
  }
  assert.equal(h.store.readGovernance(sid)?.execToolCount ?? 0, 0, '前置：非白名单会话未被计数');
  const govBefore = h.store.readGovernance(sid) ?? null;
  for (const [name, args] of NEW_GATED_CASES) {
    assert.ok(h.byName[name], '注册表 modeGate 集成员必须真实注册：' + name);
    await assert.rejects(
      () => h.byName[name].execute(args, sess('standard')),
      (e) => /GATE_MODE_INACTIVE/.test(e.message) && /modes\.gate/.test(e.message),
      name + '：非白名单模式下必须被模式门拒（先于参数/状态校验）',
    );
    assert.deepEqual(h.store.readGovernance(sid) ?? null, govBefore, name + '：被拒时不得写治理状态（零介入面）');
  }
});
