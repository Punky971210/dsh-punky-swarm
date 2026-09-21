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

// 清债补锁（2026-09-16 评审回执）：
//   SC-1（P-C）套件一致性（**全量**，2026-09-16 批 `suite-registry-20260916` 升级）：只读清单是执行型清单子集；
//        成员 deny **由注册表 `SUITE_TOOLS.filter(memberDeny)` 派生**（13 项，导出名/内容/顺序逐字不变、不含 mcp__*）；
//        模式门覆盖集同源派生（9 项，含本批新补 5 件）。原「modeGate 覆盖 = 写面全集」的缺口 N3 由本批注册表收口。
//   SC-2（N2/H3）`dispatch.gate` **真热更**：同一套工具面，仅切换热更快照即从 warn 变 enforce（无需重建 tools）。
//   SC-3（N5）派发失败后**无残留句柄**（否则绑定缺口观测会报幽灵 `token-ttl-expired`）。
//   SC-4（注册表批）**实现面双向一致**：静态声明面（`lib/tools/*.js` 内 `assertModeActive` / `assertMemberActionTierC`
//        调用点）＝ 行为面（非白名单模式 + 最小合法入参 ⇒ `GATE_MODE_INACTIVE`）＝ 注册表 `modeGate` 集。
//   注：DR-5（provider 缺配 ⇒ 降级仅发句柄）已由 engine-dispatch.test.js 的 T3 覆盖，不重复。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { EXEC_TOOLS } from '../lib/tools/core.js';
import { SHELL_TOOLS } from '../lib/tools/readonly.js';
import { SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from '../lib/engine/dispatch.js';
import { SUITE_TOOLS } from '../lib/engine/suite.js';
import { pendingHandles, __resetLaneHandles } from '../lib/bridge/lane-handle.js';
import { threeTierTasks, seedArtifacts, assessC, registerManager } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills, withDefaultTeam } from './helpers/host-skills.mjs';

// 【P1 同步】`team` 现为必填且必须解析到资产 ⇒ 本套件建批统一补 software-team；其 skills 须可解析 ⇒ 先注入技能根。
seedTeamAssetSkills('software-team');

const SID = 'sess-sc';

// ── SC-1 套件一致性（全量，批 `suite-registry-20260916`） ──────────────────────
// 断言的**事实源是注册表**（`lib/engine/suite.js` 的 `SUITE_TOOLS`），不是人肉清单：
//   · deny：表内 `memberDeny` 派生集 ≡ `dispatch.js` 再导出 ≡ 冻结现值（**14 项**：既有 13 项**相对顺序逐字不变**
//     ——P3a control lane 的 `batch_control` 紧跟 `batch_phase` 之后插入（相位工具相邻，见下方 LEGACY 注释））、不含 `mcp__*`；
//   · 模式门：表内 `modeGate` 派生集 ≡ `dispatch.js` 再导出 ≡ 冻结现值（**10 项**：既有 9 项 + P3a `batch_control`）、不含 `mcp__*`。
// 实现面（调用点 / 行为）与注册表的**双向**比对落 SC-4 —— 本用例只负责「表 ↔ 导出」这一侧。
// 旧 13 项冻结序列（**项与项之间的相对顺序是本用例真正锁的东西**；新项只允许**插入**、不得重排）：
const LEGACY_DENY = [
  'assign_check', 'wave_plan', 'member_status', 'member_settle', 'batch_phase',
  'lane_dispatch', 'lane_claim', 'lane_release', 'gate_status', 'artifact_types', 'asset_claim',
  'subagent', 'subagent_fork',
];
// 现值 = 旧序列前 5 项 + P3a 追加的 `batch_control`（紧跟 `batch_phase`，相位工具相邻）+ 旧序列剩余 8 项。
// 【task-22 变更登记】P1 `handoff_submit` **不入 deny**（改归 `comms` 族 / 成员面）⇒ 本序列回到 **14 项**，
//   与 `task-21` 的临时 15 项相比：**旧 13 项相对顺序零变化**，变更显式登记于本注释 + `suite.js` 表条目注释。
const BATCH_CONTROL_INSERT_AT = 5;
const FROZEN_DENY = [
  ...LEGACY_DENY.slice(0, BATCH_CONTROL_INSERT_AT),
  'batch_control',
  ...LEGACY_DENY.slice(BATCH_CONTROL_INSERT_AT),
  // N1-R4-1c：图变更写入口 ⇒ 成员不得改图（与 batch_control 同为人工/治理面）
  'batch_tasks_add',
  // N1-R4-2：池内任务**加边**（图变更写入口 #2）⇒ 同上（成员不得改图）
  'task_update',
];
/** P3a 之后新增的 deny 项（用于「旧 13 项相对顺序逐字不变」的过滤判据）。 */
const POST_LEGACY_DENY_ADDED = ['batch_control', 'batch_tasks_add', 'task_update'];
const FROZEN_MODE_GATED = [
  'assign_check', 'wave_plan', 'member_status', 'member_settle', 'batch_phase',
  'lane_dispatch', 'lane_claim', 'lane_release', 'asset_claim',
  // 【P3a control lane 追加】人工干预面同样受模式门（非生效模式零治理写入）
  'batch_control',
  // 【task-22 变更登记】P1 `handoff_submit` **不入模式门**（归 `comms` 族：交接是生产者的动作，
  //   须成员可调用 ⇒ 不落 `assertModeActive`）；【N1-R4-1c】+`batch_tasks_add`、【N1-R4-2】+`task_update`
  //   （两件均为图变更写入口）⇒ **12 项**。
  'batch_tasks_add',
  'task_update',
];
// 本批（`suite-registry-20260916`）新补的模式门 5 件：原实现面无覆盖（`assign_check` 文档表误标 ✅）
const NEW_MODE_GATED = ['batch_phase', 'lane_claim', 'lane_release', 'asset_claim', 'assign_check'];
const sortedUnique = (xs) => [...new Set(xs)].sort();

test('SC-1 套件一致性（全量）：deny ≡ 注册表派生（16 项，既有 13 项顺序逐字不变）；modeGate 覆盖集 ≡ 注册表派生（12 项，含新补 5 件 + P3a batch_control + R4 两件图写入口）；均不含 mcp__*', () => {
  // ① 只读清单与执行型清单同源（原断言保留）
  const leakedShell = SHELL_TOOLS.filter((t) => !EXEC_TOOLS.includes(t));
  assert.deepEqual(leakedShell, [], '只读判定只作用于 shell 类工具，二者必须同源');
  // ② 注册表单点：name 唯一 + 五字段闭集 + 条目冻结（防「表被顺手扩面」而两面口径悄悄漂移）
  assert.deepEqual(sortedUnique(SUITE_TOOLS.map((t) => t.name)), SUITE_TOOLS.map((t) => t.name).sort(),
    'name 是唯一键（表内不得重名）');
  for (const t of SUITE_TOOLS) {
    assert.deepEqual(Object.keys(t).sort(), ['kind', 'memberDeny', 'modeGate', 'name', 'write'], t.name + '：字段闭集（五字段）');
    assert.equal(typeof t.modeGate, 'boolean', t.name + '：modeGate 须为布尔');
    assert.equal(typeof t.memberDeny, 'boolean', t.name + '：memberDeny 须为布尔');
    assert.ok(Object.isFrozen(t), t.name + '：表条目须冻结');
  }
  // ③ deny 面：注册表派生 ≡ 再导出 ≡ 现值（**前 13 项**顺序逐字不变 + P3a 追加项）
  const derivedDeny = SUITE_TOOLS.filter((t) => t.memberDeny).map((t) => t.name);
  assert.deepEqual([...SUITE_DENY_TOOLS], FROZEN_DENY, '成员 deny 必须是精确集合（16 项：旧 13 项相对顺序不变 + P3a batch_control + R4 两件图写入口 batch_tasks_add/task_update；task-22 后 handoff_submit 不入 deny）');
  assert.deepEqual([...SUITE_DENY_TOOLS].filter((n) => !POST_LEGACY_DENY_ADDED.includes(n)), LEGACY_DENY,
    '去掉 P3a 之后追加的项后必须**逐字等于**旧 13 项序列（新项只允许追加，不得重排/删项）');
  assert.equal([...SUITE_DENY_TOOLS].indexOf('batch_control'), BATCH_CONTROL_INSERT_AT,
    'P3a 新项落位 = 紧跟 batch_phase（相位工具相邻；落位是断言面，防静默挪位）');
  assert.deepEqual([...SUITE_DENY_TOOLS], derivedDeny, 'deny 必须由注册表派生（表 → 导出单向同源，不退回字面量）');
  assert.ok(Object.isFrozen(SUITE_DENY_TOOLS), 'deny 派生结果须冻结（既有不可变契约）');
  assert.deepEqual(SUITE_DENY_TOOLS.filter((t) => t.startsWith('mcp__')), [], 'MCP 等普通工具不得入 deny（用户口径）');
  assert.ok(SUITE_DENY_TOOLS.includes('subagent') && SUITE_DENY_TOOLS.includes('subagent_fork'), '禁成员嵌套派发');
  assert.ok(SUITE_DENY_TOOLS.includes('batch_control'), '人工干预面（batch_control）必须对成员移除');
  // ④ 模式门面：注册表派生 ≡ 再导出 ≡ 现值（10 项，含本批新补 5 件 + P3a batch_control）
  const derivedGate = SUITE_TOOLS.filter((t) => t.modeGate).map((t) => t.name);
  assert.deepEqual(sortedUnique([...MODE_GATED_TOOLS]), sortedUnique(FROZEN_MODE_GATED), '模式门覆盖集 = 10 项现值（task-22 后 handoff_submit 不入模式门）');
  assert.deepEqual(sortedUnique([...MODE_GATED_TOOLS]), sortedUnique(derivedGate), 'modeGate 覆盖集必须由注册表派生');
  assert.ok(Object.isFrozen(MODE_GATED_TOOLS), 'MODE_GATED_TOOLS 派生结果须冻结');
  for (const n of NEW_MODE_GATED) {
    assert.ok(MODE_GATED_TOOLS.includes(n), '本批新补的模式门工具缺（非生效模式会假放行）：' + n);
  }
  assert.ok(MODE_GATED_TOOLS.includes('batch_control'), 'P3a 干预面须受模式门（非生效模式零治理写入）');
  assert.deepEqual(MODE_GATED_TOOLS.filter((t) => t.startsWith('mcp__')), [], 'mcp__* 不入模式门');
  // ⑤ 两面关系：模式门覆盖集 ⊆ deny 集（模式门工具均属套件写面）
  assert.deepEqual(MODE_GATED_TOOLS.filter((n) => !SUITE_DENY_TOOLS.includes(n)), [],
    '模式门覆盖集必须落在 deny 集内（两面同源于一张表）');
});

// ── SC-2 热更真生效（N2/H3） ────────────────────────────────────────────────
// 【gate-lite 第二批 · B（2026-09-17 用户裁决）】**拒态已删**：原 `GATE_SUBAGENT_OUTSIDE_LANES`
//   不再存在 ⇒ 本用例断言面由「enforce 无重启即拦」翻转为「**两档皆不拦，热更只影响留痕文案**」
//   （结构保留：同一 guard / 同一 tools 实例下切快照即生效，不重建、不重启）。
test('SC-2 dispatch.gate 热更：同一工具面下 warn → enforce 均不拦（拒态已删），留痕随快照即时刷新', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-sc2-'));
  const store = createStore(root);
  const warns = [];
  const ctx = {
    tools: { register: () => {}, guard: (fn) => { ctx.__guard = fn; return () => {}; } },
    logger: { warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} },
  };
  // 热更快照 = 可变对象引用（readConfig 每次调用读它的当前值）
  const live = { dispatch: { provider: 'spawn' } };
  const { tools } = createTools(ctx, { store, root, config: {}, readConfig: () => live });
  const by = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
  assessC(store, SID, { rationale: 'fixture：模式门/G1 前置评估（三层批 ⇒ C 档）' });
  const exec = (name) => ({ name, arguments: { prompt: 'no-handle' }, agent: { session: { id: SID } } });

  // ① 缺省 warn：C 档无句柄派发只留痕不拦
  assert.equal(ctx.__guard(exec('subagent')), undefined, 'warn 模式不得拦');
  assert.ok(warns.some((w) => /dispatch without valid lane handle/.test(w)), '必须留痕');

  // ② 仅切热更快照 ⇒ enforce 下**同样不拦**（原码已删）；留痕仍逐次产出（可观测，不静默）
  live.dispatch.gate = 'enforce';
  const reason = ctx.__guard(exec('subagent'));
  assert.equal(reason, undefined, 'enforce 不再是拒因（码已删）：实际=' + String(reason));
  assert.ok(warns.some((w) => /dispatch without valid lane handle/.test(w)), '留痕照旧（非静默放行）');

  // ③ 切回 warn ⇒ 恢复放行（热更双向）
  live.dispatch.gate = 'warn';
  assert.equal(ctx.__guard(exec('subagent')), undefined);
  void by;
});

// ── SC-3 失败路径无残留句柄（N5） ───────────────────────────────────────────
// K3（2026-09-21）改判：回滚目标由 `review` 改 `failed`（返工边 `review→running` 已去除 ⇒ 回滚到 review 会卡在非终态且重派必被拒）。
test('SC-3 派发失败 ⇒ lane 置 failed 且**无残留句柄**（无幽灵 token-ttl-expired）', async () => {
  __resetLaneHandles();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-sc3-'));
  const store = createStore(root);
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    subagents: { startContinuable: async () => { throw new Error('spawn boom'); } },
  };
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn' } } });
  const by = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
  const exec = { agent: { session: { id: SID } } };
  assessC(store, SID, { rationale: 'fixture：三层批建批前置评估（多线并行 ⇒ C 档）' });
  await by.wave_plan.execute({ batchId: 'b-sc3', tasks: threeTierTasks(['e1'], { auditId: 'a1' }), assembly: { auditLane: 'a1' } }, exec);
  await by.batch_phase.execute({ batchId: 'b-sc3', phase: 'running' }, exec);
  registerManager(store, SID, 'b-sc3', 'mgr-1');
  seedArtifacts(root, SID, 'b-sc3', ['e1'], { planProduct: 'plan/spec.md' });

  await assert.rejects(() => by.lane_dispatch.execute({ batchId: 'b-sc3', lane: 'e1' }, exec), /GATE_DISPATCH_FAILED/);
  assert.equal(store.readBatch(SID, 'b-sc3').lanes.e1, 'failed', 'K3：派发失败即终态（不得停在 running，亦不得停在非终态 review）');
  const residual = pendingHandles().filter((h) => h.batchId === 'b-sc3' && h.lane === 'e1');
  assert.deepEqual(residual, [], '失败路径必须作废已发句柄（否则心跳报幽灵 token-ttl-expired）');
  __resetLaneHandles();
});

// ── SC-4 注册表 ↔ 实现面 双向一致（批 `suite-registry-20260916`） ──────────────
// 「实现面」取**两份独立证据**（同源于注册表会假绿，故不用人肉清单、也不只读常量）：
//   ① 静态声明面：`lib/tools/*.js` 每个 `defineTool({...})` 块内是否真的落模式门——
//      `assertModeActive(`（首行直调）或经 `assertMemberActionTierC(` 链式覆盖（后者内部首行即调前者）；
//   ② 行为面：`config.modes.gate = ['punky-preset']` + 会话 preset = `standard`（非白名单）下，
//      用**最小合法入参**（由工具自身 `parameters` schema 派生）逐件调用 ⇒ 必须拒 `GATE_MODE_INACTIVE`，
//      且治理状态**零写入**（零介入面口径）。
// 两侧集合都必须与注册表 `modeGate` 派生集**双向相等**：多一处 = 表漏登、少一处 = 假覆盖。
const TOOLS_DIR = new URL('../lib/tools/', import.meta.url);
// 注释剥离：防「注释里提到过 assertModeActive」被误判成实现面覆盖。
// 【P1 同步 · 扫描器修正】原实现用正则 `/\*[\s\S]*?\*\//g` —— **注释正文里的 glob 片段会破坏配对**：
//   `lib/tools/core.js` 的文档注释中含 `presets/*`（无同行的 `*/`）⇒ 该 `/*` 会去与**后面**某个 `*/` 配成一对，
//   造成"从注释里某处起，一直吞掉大段真实代码"（实测：core.js 的 14 个 `defineTool({` 块被吞到 4 个 ⇒
//   静态声明面只剩 1 件工具 ⇒ 误判"少一处=假覆盖"）。判据未变（仍要求块内出现模式门标记），只是把扫描器
//   改成**状态机版**（识别字符串与注释边界），使「注释里提到」仍被正确排除、真实代码不再被误吞。
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i += 1; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      for (i += 1; i < src.length; i += 1) {
        out += src[i];
        if (src[i] === '\\') { i += 1; out += src[i] ?? ''; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    out += c;
  }
  return out;
}
/** 静态声明面：逐文件切 `defineTool({` 块 → 取块内首个 `name: "…"` → 看块内有无模式门标记。 */
function staticModeGateDecls(dir) {
  const found = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = stripComments(fs.readFileSync(new URL(f, dir), 'utf8'));
    for (const chunk of src.split('defineTool({').slice(1)) { // 每块 = 一件工具定义（下一 defineTool 之前）
      const m = /name:\s*["']([A-Za-z_][\w]*)["']/.exec(chunk);
      if (!m) continue;
      if (/assertModeActive\(|assertMemberActionTierC\(/.test(chunk)) found.push(m[1]);
    }
  }
  return found;
}
/** 最小合法入参：只填 schema 的 required 槽（模式门先于参数/状态校验，故取值本身不参与判定）。 */
function minArgs(def) {
  const spec = def.parameters ?? {};
  const out = {};
  for (const k of spec.required ?? []) {
    const p = spec.properties?.[k] ?? {};
    if (Array.isArray(p.enum) && p.enum.length) out[k] = p.enum[0];
    else if (p.type === 'string') out[k] = 'probe';
    else if (p.type === 'integer' || p.type === 'number') out[k] = 1;
    else if (p.type === 'boolean') out[k] = true;
    else if (p.type === 'array') out[k] = [];
    else if (p.type === 'object') out[k] = {};
  }
  return out;
}

test('SC-4 实现面一致：静态声明面 = 行为面 = 注册表 modeGate 集（双向，含新补 5 件真生效）', async () => {
  const derivedGate = sortedUnique(SUITE_TOOLS.filter((t) => t.modeGate).map((t) => t.name));
  // ① 静态声明面 ↔ 注册表（双向）
  assert.deepEqual(sortedUnique(staticModeGateDecls(TOOLS_DIR)), derivedGate,
    '实现面落模式门的工具必须与注册表 modeGate 集双向相等（多一处=表漏登；少一处=假覆盖）');
  // ② 装配面：注册的工具必须全部登记进表；表内未注册者只允许「非默认注册」三件
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-sc4-'));
  const store = createStore(root);
  const config = { modes: { gate: ['punky-preset'] } };
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  };
  // 【task-22】P1 交接两工具已改**常驻注册**（「工具是机制、门是策略」）⇒ 本用例**无需再择入 env**。
  //   注意 `handoff_submit` 的 `modeGate:false`（`comms` 族）⇒ 它**不在** ③ 的 `derivedGate` 名单内；
  //   其「成员可调、不落模式门」的行为面证据落在 ④ 反向抽样。
  const { tools } = createTools(ctx, { store, root, config, readConfig: () => config });
  const byName = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
  const NOT_REGISTERED_BY_DEFAULT = ['subagent', 'subagent_fork', 'log_export']; // 宿主派发工具 + 可选能力组（logs）
  assert.deepEqual(SUITE_TOOLS.map((t) => t.name).filter((n) => !byName[n]), NOT_REGISTERED_BY_DEFAULT,
    '表内未注册的只允许非默认注册三件（其余必须真实注册）');
  assert.deepEqual(tools.map((t) => t.name).filter((n) => !SUITE_TOOLS.some((t) => t.name === n)), [],
    '注册的工具必须全部登记进注册表（单点表不得漏登）');
  // ③ 行为面：非白名单模式 + 最小合法入参 ⇒ 逐件命中模式门，且零治理写入
  const exec = { agent: { session: { id: 's-standard', header: { agentPreset: 'standard' } } } };
  const govBefore = store.readGovernance('s-standard') ?? null;
  const hit = [];
  for (const n of derivedGate) {
    await assert.rejects(() => byName[n].execute(minArgs(byName[n]), exec),
      (e) => /GATE_MODE_INACTIVE/.test(e.message), n + '：非生效模式下必须被模式门拒（先于参数/状态校验）');
    hit.push(n);
  }
  assert.deepEqual(sortedUnique(hit), derivedGate, '行为面命中集合必须与注册表 modeGate 集双向相等');
  assert.deepEqual(store.readGovernance('s-standard') ?? null, govBefore, '非生效模式必须零治理写入（不计数、不留痕）');
  // ④ 反向抽样：表内 modeGate:false 的工具不得误报模式门（防「门面铺得过宽」）。
  //   【task-22 补入】`handoff_submit`（`comms` 族 / 成员面 / modeGate:false）——本项即「成员可调、
  //   不落模式门」的**行为面证据**：非生效模式下它不得抛 `GATE_MODE_INACTIVE`（业务侧报错不算违规）。
  for (const n of ['batch_status', 'artifact_types', 'gate_status', 'handoff_submit']) {
    assert.ok(byName[n], n + ' 应真实注册（常驻注册：交接两工具不再随 env 出现/消失）');
    let msg = '';
    try { await byName[n].execute(minArgs(byName[n]), exec); } catch (e) { msg = String(e.message); }
    assert.ok(!/GATE_MODE_INACTIVE/.test(msg), n + ' 未登记模式门，不得误报 GATE_MODE_INACTIVE');
  }
  // ⑤ 【task-22】成员面成员性：两件交接工具**不入** deny 集（成员可调用），且不入模式门集
  assert.equal(SUITE_DENY_TOOLS.includes('handoff_submit'), false, 'handoff_submit 为成员面 ⇒ 不得入 deny 集');
  assert.equal(MODE_GATED_TOOLS.includes('handoff_submit'), false, 'handoff_submit 归 comms 族 ⇒ 不得入模式门集');
  assert.equal(SUITE_DENY_TOOLS.includes('handoff_view'), false, 'handoff_view 为只读面 ⇒ 不得入 deny 集');
  fs.rmSync(root, { recursive: true, force: true });
});
