/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/host-tools-ledger.test.js —— **M1 反回归锁**：宿主工具「事实集 / 豁免子集 / 条件注册」三者不得混同，
// 且**新增宿主工具未登记 ⇒ 必红**（历史的 D 档 `member.dispatch=0` 就是漏登记 `spawn_teammate` 造成的）。
//
// 判据源：`plan/p1-pack.md`（M1）＋ `exec/e1-hosttools.md`。
// 三层判据（缺一层都会退化成「看起来像锁」）：
//   ① **完备性**：`HOST_PROVIDED_TOOLS ∪ CONDITIONAL_REGISTRATION` ≡ `HOST_TOOL_LEDGER` 里
//      `registeredByEngine:false` 的全部行 —— 新增宿主工具而未登记 ⇒ 差集非空 ⇒ 红；
//   ② **成对**：真实常量 ⇒ 差集**空**（防「恒红」的锁：只会报红、不会报绿也是坏锁）；
//   ③ **顺序/分开**：`HOST_PROVIDED_TOOLS` = 7 件**内容**断言，且 `HOST_INTERSECT_EXEMPT` 是**独立常量（2 件）**，
//      **不得**假设两者可合并（合并会让 `subagent` 等未注册件被豁免 = 允许「宣告了却调不到」）。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/host-tools-ledger.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_PROVIDED_TOOLS, HOST_INTERSECT_EXEMPT, CONDITIONAL_REGISTRATION, HOST_TOOL_LEDGER,
} from '../lib/governance/host-tools.js';

/** 锚：7 件宿主工具的事实集（测试侧手写对账基准；**与 lib 互校**，任一侧改动都要能被发现）。 */
const EXPECTED_HOST_PROVIDED = Object.freeze([
  'interrupt_agent', 'list_agents', 'send_message', 'spawn_teammate', 'subagent', 'subagent_fork', 'wait_agent',
]);

/**
 * 完备性判定（纯函数，参数化 ⇒ **可对变异输入直接验证红形态**，无需临时文件）。
 * 两根轴**分开比**（实测账本形状：`registeredByEngine` 为 `false` = 宿主提供；为字符串
 * `'capability:logs'` = 本仓按能力位**条件注册**）：
 *   · 宿主轴：账本 `registeredByEngine === false` 的 name 集 ⇔ `provided`
 *   · 条件轴：账本 `providedBy` 以 `engine:conditional` 开头的 name 集 ⇔ `conditional`
 * @returns {string[]} 违规描述（空 = 完备）
 */
function completenessViolations({ provided, conditional, ledger }) {
  const hostRows = ledger.filter((row) => row && row.registeredByEngine === false).map((row) => row.name);
  const condRows = ledger.filter((row) => row && String(row.providedBy).startsWith('engine:conditional')).map((row) => row.name);
  const diff = (actual, expected, label) => [
    ...expected.filter((n) => !actual.includes(n)).map((n) => label + '·未登记：' + n + '（账本有、常量无）'),
    ...actual.filter((n) => !expected.includes(n)).map((n) => label + '·多登记：' + n + '（常量有、账本无）'),
  ];
  return [
    ...diff(provided, hostRows, '宿主轴'),
    ...diff(conditional, condRows, '条件轴'),
  ];
}

test('M1-1 完备性＋成对：真实常量 ⇒ 违规为空；**变异账本新增一行 ⇒ 违规非空（必红）**', () => {
  // ② 成对（绿侧）：真实常量必须完备 —— 否则锁只会恒红
  assert.deepEqual(
    completenessViolations({ provided: HOST_PROVIDED_TOOLS, conditional: CONDITIONAL_REGISTRATION, ledger: HOST_TOOL_LEDGER }),
    [],
    '真实常量必须完备（HOST_PROVIDED_TOOLS ∪ CONDITIONAL_REGISTRATION ≡ 账本 registeredByEngine:false 全集）',
  );

  // ① 完备性（红侧）：往账本里加一条「宿主新提供、本仓未登记」的行 ⇒ 必须被抓到
  const mutatedLedger = [...HOST_TOOL_LEDGER, { name: 'brand_new_host_tool', providedBy: 'host:x', registeredByEngine: false, face: 'dispatch' }];
  const v = completenessViolations({ provided: HOST_PROVIDED_TOOLS, conditional: CONDITIONAL_REGISTRATION, ledger: mutatedLedger });
  assert.equal(v.length > 0, true, '新增宿主工具而未登记 ⇒ **必须报红**（这就是 D 档漏登记 spawn_teammate 的同型缺陷）');
  assert.equal(v.some((x) => x.includes('brand_new_host_tool')), true, '违规须**点名**未登记的工具；实际=' + JSON.stringify(v));

  // 反向变异：常量里塞一个账本没有的名字 ⇒ 也必须被抓到（防「只查一边」）
  const v2 = completenessViolations({ provided: [...HOST_PROVIDED_TOOLS, 'ghost_tool'], conditional: CONDITIONAL_REGISTRATION, ledger: HOST_TOOL_LEDGER });
  assert.equal(v2.some((x) => x.includes('ghost_tool')), true, '多登记（账本无）同样必须报红；实际=' + JSON.stringify(v2));
});

test('M1-2 `HOST_PROVIDED_TOOLS` = **7 件**（内容断言，非仅计数）', () => {
  assert.deepEqual([...HOST_PROVIDED_TOOLS].sort(), [...EXPECTED_HOST_PROVIDED].sort(),
    '宿主提供事实集必须逐名相等（任一侧增删都要在此暴露）；实际=' + JSON.stringify([...HOST_PROVIDED_TOOLS]));
  // 历史缺陷的具体形态：漏 `spawn_teammate` ⇒ 下面这条会指名道姓地红
  assert.equal(HOST_PROVIDED_TOOLS.includes('spawn_teammate'), true,
    '`spawn_teammate` 必须在宿主事实集内（它是 D 档派发入口，漏了 ⇒ D 档 member.dispatch 恒 0）');
});

test('M1-3 三个常量**必须分开**：豁免子集 ⊂ 事实集，且 `CONDITIONAL_REGISTRATION` 独立', () => {
  const provided = new Set(HOST_PROVIDED_TOOLS);
  // 豁免子集（策略）必须是事实集的**真子集**（2 件），不得与事实集同值
  assert.notDeepEqual([...HOST_INTERSECT_EXEMPT], [...HOST_PROVIDED_TOOLS],
    '豁免子集**不得**等于 7 件事实集（否则 subagent/spawn_teammate 等未注册件会被豁免 = 允许「宣告了却调不到」）');
  for (const name of HOST_INTERSECT_EXEMPT) {
    assert.equal(provided.has(name), true, '豁免子集成员 ' + name + ' 必须同时属于宿主事实集');
  }
  assert.deepEqual([...HOST_INTERSECT_EXEMPT].sort(), ['list_agents', 'wait_agent'],
    '豁免子集内容 = 宿主 Team 面两个只读件（本仓不注册属正常形态）');
  // 条件注册是**另一根轴**（`logs` capability 决定是否注册），不得并入事实集
  assert.deepEqual([...CONDITIONAL_REGISTRATION], ['log_export'],
    '条件注册面 = log_export（logs 默认关 ⇒ 不注册）');
  assert.equal(provided.has('log_export'), false,
    '条件注册件**不得**混进宿主事实集（两者语义不同：宿主提供 vs 本仓按开关注册）');
});

test('M1-4 账本自洽：每行有 name/providedBy/registeredByEngine，且 face 非空（防「登记个空壳凑数」）', () => {
  for (const row of HOST_TOOL_LEDGER) {
    assert.equal(typeof row.name, 'string', '账本行必须有 name：' + JSON.stringify(row));
    assert.equal(row.name.length > 0, true, 'name 不得为空');
    assert.equal(typeof row.providedBy === 'string' && row.providedBy.length > 0, true, row.name + ' 必须有 providedBy（证据锚）');
    // 实测形状两态：`false`（宿主提供，本仓永不注册）/ 非空字符串（如 `'capability:logs'`，本仓条件注册）
    const registered = row.registeredByEngine;
    const isHost = registered === false;
    const isConditional = typeof registered === 'string' && registered.length > 0;
    assert.equal(isHost || isConditional, true,
      row.name + '：registeredByEngine 必须为 false 或非空字符串（实际=' + JSON.stringify(registered) + '）');
    assert.equal(typeof row.face === 'string' && row.face.length > 0, true, row.name + ' 必须有 face（归属面）');
  }
});
