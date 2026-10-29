/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// G0 清障（批 `punky-g0-clear-2026-10-29` · lane `e1-ledger`）：
//   工具面**双向差集**判据（只读、ESM、零第三方依赖）。
//
// 要解决的问题：工具面有三个互不相认的来源——① 源码全集 `lib/engine/suite.js` 的 `entry(...)`；
//   ② 运行时缺省注册集（`createTools` 缺省面）；③ 冻结名单 `test/tools.test.js` 的 `TOOL_NAMES`。
//   三者靠人眼对账 ⇒ 任一处漂移都「发现了也不可判」。本脚本把它们变成**三条集合判据**（D1/D2/D3），
//   两向合格才 exit 0。
//
// 纪律（三条，均来自任务包）：
//   · **判据主体是身份集合**（哪些名字、往哪个方向多/少），不是总数；`39/34/31/26` 只作展示位（禁作判据）。
//   · **只读**：不写任何文件、不调 git、无第三方依赖（写盘面在 `tool-face-audit.mjs`，一次一份 JSON）。
//   · **导出纯函数 + CLI 门**：`diffToolFace()` 供测试/审计单独 import，**import 即执行是禁止的**
//     （否则下游 `audit` 与 `e2` 的复用面直接失效）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 已裁删除的 5 件（用户 2026-10-29 裁定「删全部 5 件」）。**集合，不是计数**：
//   `34` / `26` 由本集合投影得出，禁手写数字。
export const DELETED_5 = Object.freeze([
  'mailbox_send', 'mailbox_read', 'mailbox_ack', 'lane_heartbeat', 'lane_longrun',
]);

// 源码全集里**不入缺省注册**的基线 8 名（现状事实，非目标）：`log_export`（只读导出面，缺省不注册）
//   + 宿主面 7 件（`subagent` / `subagent_fork` / `send_message` / `interrupt_agent` / `list_agents` /
//   `wait_agent` / `spawn_teammate`；定义点在宿主管家包，本仓仅登记）。
//   ⚠ 宿主面是 **7 件**不是 6 件：`wait_agent` 在 `lib/**` 内无真 `name:` 定义点（首个 grep 命中是
//   `lib/engine/suite.js:135` 的注释），实测见 docs/tool-face-ledger.md §5。
export const SUITE_ONLY_BASELINE = Object.freeze([
  'log_export', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
  'wait_agent', 'spawn_teammate',
]);

const READ = { encoding: 'utf8' };
const SORT = (arr) => [...arr].sort();
const uniq = (arr) => [...new Set(arr)];
const setEq = (a, b) => {
  const A = SORT(uniq(a)); const B = SORT(uniq(b));
  return A.length === B.length && A.every((x, i) => x === B[i]);
};
const minus = (a, b) => uniq(a).filter((x) => !b.includes(x));

/** S1：源码全集（`lib/engine/suite.js` 的 `entry('name'` 行，按注册序）。 */
export function readSuiteNames(root = PKG_ROOT) {
  const src = fs.readFileSync(path.join(root, 'lib/engine/suite.js'), READ);
  return uniq([...src.matchAll(/^\s{2}entry\('([a-z_]+)'/gm)].map((m) => m[1]));
}

/** S2：运行时缺省注册集（临时 root 建 store，`createTools` **不传 config** ⇒ 缺省面）。 */
export function readDefaultRegistered(root = PKG_ROOT) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-face-diff-'));
  const store = createStore(tmpRoot, { logger: { warn() {}, info() {}, error() {} } });
  const ctx = { tools: { register() {}, guard: () => () => {} }, logger: { log() {}, warn() {}, info() {}, error() {} } };
  const names = createTools(ctx, { store, root: tmpRoot }).tools.map((t) => t.name);
  // 临时 root 只在内存里用一次，不落任何文件进仓库（`mkdtempSync` 落 OS 临时目录）
  return uniq(names);
}

/** 冻结名单（`test/tools.test.js` 的 `TOOL_NAMES`），返回 {names, line}。 */
export function readFrozenNames(root = PKG_ROOT) {
  const lines = fs.readFileSync(path.join(root, 'test/tools.test.js'), READ).split('\n');
  const idx = lines.findIndex((l) => /const TOOL_NAMES\s*=/.test(l));
  if (idx < 0) throw new Error('TOOL_NAMES not found in test/tools.test.js');
  let end = idx;
  const body = [];
  for (; end < lines.length; end++) {
    body.push(lines[end]);
    if (/\]/.test(lines[end])) break;
  }
  return { names: uniq([...body.join('\n').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])), line: idx + 1 };
}

/** 展示位（非判据）：docstring 自述数 + 蓝图 §4 表内派生数。 */
export function readDisplayOnly(root = PKG_ROOT, blueprintPath = null) {
  const src = fs.readFileSync(path.join(root, 'lib/engine/suite.js'), READ);
  const m = src.match(/套件工具全集（\*\*(\d+) 件\*\*/);
  let blueprintSec4Names = [];
  if (blueprintPath && fs.existsSync(blueprintPath)) {
    const bp = fs.readFileSync(blueprintPath, READ).split('\n');
    const a = bp.findIndex((l) => l.startsWith('## 4.'));
    if (a >= 0) {
      let b = bp.findIndex((l, i) => i > a && /^## 5\./.test(l));
      if (b < 0) b = bp.length;
      // 只取 §4 的三面表行（数据面/控制面/删除）——§4.1 护栏面是**判定面**，不是工具名集合
      //   （否则 `sleep`/`pwsh` 等行为面词会混进「工具名派生数」，把展示位搞成无意义的大数）。
      const faceRows = bp.slice(a, b).filter((l) => /^\|\s*\*\*(数据面|控制面|删除)\*\*/.test(l));
      blueprintSec4Names = uniq(faceRows.join('\n').match(/`([a-z_]+)`/g)?.map((s) => s.replace(/`/g, '')) ?? []);
    }
  }
  return { docstringCount: m ? Number(m[1]) : null, blueprintSec4Names };
}

/**
 * 双向差集 + 三条集合判据。
 * @param {'current'|'after-delete'} project 投影：`after-delete` = 两侧同时减去 `DELETED_5`
 */
export function diffToolFace(project = 'current', opts = {}) {
  const root = opts.root ?? PKG_ROOT;
  const drop = project === 'after-delete' ? DELETED_5 : [];
  const s1 = readSuiteNames(root);
  const s2 = readDefaultRegistered(root);
  const frozen = readFrozenNames(root).names;
  const a = minus(s1, drop);   // 源码全集投影
  const b = minus(s2, drop);   // 缺省注册投影
  // 冻结名单也**同投影**：否则 `after-delete` 拿 26 名去比未投影的 31 名，判据必红
  //   （任务包 §2.4 要求「两种投影今天都必须 exit 0」，故三侧同投影是唯一自洽读法）。
  const frozenProjected = minus(frozen, drop);
  const forward = minus(a, b);
  const backward = minus(b, a);
  const checks = {
    D1: setEq(forward, SUITE_ONLY_BASELINE),
    D2: backward.length === 0,
    D3: setEq(b, frozenProjected),
  };
  return {
    project,
    s1, s2,
    frozen, frozenProjected,
    projected: { a, b },
    forward, backward,
    baseline: [...SUITE_ONLY_BASELINE],
    deleted: [...DELETED_5],
    checks,
    ok: checks.D1 && checks.D2 && checks.D3,
  };
}

function nameList(arr) {
  return arr.length === 0 ? '∅' : arr.join(', ');
}

function main(argv) {
  const args = argv ?? [];
  const json = args.includes('--json');
  const projArg = args.find((x) => x.startsWith('--project'));
  let project = 'current';
  if (projArg) {
    project = projArg.includes('=') ? projArg.split('=')[1] : args[args.indexOf(projArg) + 1];
    if (project !== 'current' && project !== 'after-delete') {
      console.error('unknown --project=' + project + '（允许：current | after-delete）');
      process.exit(2);
    }
  }
  const r = diffToolFace(project);
  const display = readDisplayOnly(PKG_ROOT, 'D:/AI_Workspace/DSH/buddy/_research/punky-refactor-blueprint-v4.md');
  const payload = {
    project: r.project,
    forward: r.forward,
    backward: r.backward,
    baseline: r.baseline,
    checks: r.checks,
    ok: r.ok,
    display: {
      runtimeAll: r.s1.length,
      runtimeAfterDelete: minus(r.s1, DELETED_5).length,
      frozenAll: r.frozen.length,
      frozenAfterDelete: minus(r.frozen, DELETED_5).length,
      docstringDrift: display.docstringCount,
      blueprintSec4: display.blueprintSec4Names.length,
      note: '展示位·非判据',
    },
  };
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.exit(r.ok ? 0 : 1);
  }
  const out = [];
  out.push('== 工具面双向差集 ==  投影=' + r.project);
  out.push('');
  out.push('D1 前向差集 (S1 ∖ S2) 应恰等于基线集');
  out.push('   实得 : ' + nameList(r.forward));
  out.push('   基线 : ' + nameList(r.baseline));
  out.push('   结论 : ' + (r.checks.D1 ? '集合相等 ✅' : '❌ 逐名差异见上'));
  out.push('');
  out.push('D2 反向差集 (S2 ∖ S1) 应为空集');
  out.push('   实得 : ' + nameList(r.backward));
  out.push('   结论 : ' + (r.checks.D2 ? '∅ ✅' : '❌ 反向差集非空'));
  out.push('');
  out.push('D3 缺省注册集 vs 冻结名单（TOOL_NAMES' + (r.project === 'after-delete' ? ' 同投影' : '') + '）');
  out.push('   结论 : ' + (r.checks.D3 ? '集合相等 ✅' : '❌ 集合不相等'));
  out.push('');
  out.push('展示位·非判据：运行时全集 ' + payload.display.runtimeAll
    + ' / 删后 ' + payload.display.runtimeAfterDelete
    + ' / 冻结 ' + payload.display.frozenAll
    + ' / 删后冻结 ' + payload.display.frozenAfterDelete
    + ' ｜ 附：docstring 自述 ' + payload.display.docstringDrift
    + '（≠ 运行时全集 ⇒ H-3 常驻告警样本）、蓝图 §4 派生 ' + payload.display.blueprintSec4);
  out.push('');
  out.push('RESULT: ' + (r.ok ? 'PASS（D1∧D2∧D3）' : 'FAIL'));
  process.stdout.write(out.join('\n') + '\n');
  process.exit(r.ok ? 0 : 1);
}

// CLI 门：**仅当直接执行才跑**（`import` 不产生输出、不改变退出语义）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
