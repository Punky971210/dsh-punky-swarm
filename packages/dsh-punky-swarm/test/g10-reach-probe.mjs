// G-10 可达构型探针（**只读形态**，不落任何写域外改动）——
//   lane `e1-g10` · 批 `g10-fix-20261012`；用途 = 在**未改任何源码**的前提下，逐点取「修前逐字读数」：
//     ① 建批期 `deps` 种子（`createBatch`）⇒ 后置 lane 的边**没有声明位**；
//     ② 运行期 `recordHandoff` 对未声明边的**逐字拒态**（`GATE_HANDOFF_MISSING`）；
//     ③ 结算出口门 `checkSettleHandoffGate` 对「无 deps 下游」的后置 lane ⇒ **静默放行**（D3 未闭合）。
//   为何只读：本 lane 任务包「写域」仅 `lib/tools/**` + `lib/wave-plan.js` + `test/**`，而实现所需的三处判定点
//   全部在 `lib/state/**`（详见 change-report 的写域冲突节）⇒ 本探针只取读数，供 Leader 裁决。
//   运行：`node test/g10-reach-probe.mjs`（自建临时 root，零触碰真实状态根）。
process.env.PSWARM_HANDOFF_GATE = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SESSION = 'sess-g10-probe';
const BATCH = 'g10-probe-batch';
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-g10-probe-'));
const line = (s) => process.stdout.write(s + '\n');
const dump = (label, v) => line(label + ': ' + JSON.stringify(v));

// 门开关：走唯一解析点（runtime.json 为真源，env 兜底）——探针同时武装两层，确保「开启态」语义可见。
fs.mkdirSync(path.join(root, 'config'), { recursive: true });
fs.writeFileSync(path.join(root, 'config', 'runtime.json'), JSON.stringify({ gates: { handoff: { entry: true, settle: true } } }, null, 2));

const store = createStore(root);
const artifactsRoot = store.artifactsDirOf(SESSION, BATCH);
const seed = (rel, body = 'out') => {
  const abs = path.join(artifactsRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
};

// ── 构型：三层批 p1(plan) → e2(exec) → a1(audit)；a1 声明 deps=['e2'] 并有 plan 判据源 ─────────────
const tasks = [
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan-it' },
  { id: 'e2', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], deps: ['p1'], cmd: 'build' },
  { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify' },
];
const wp = buildWavePlan({ batchId: BATCH, tasks, team: null, concurrency: 5 });
store.createBatch(SESSION, { batchId: BATCH, wavePlan: wp, phase: 'running' });
seed('plan/spec.md', SPEC_OK);
seed('exec/e2.md');
seed('audit/a1.md');
line('== 构型：三层批 ' + BATCH + '（p1 → e2 → a1；a1.deps=[e2]）==');
dump('① 建批期 handoffs keys（= deps 声明的 to 集合）', Object.keys(store.readBatch(SESSION, BATCH).handoffs));

// ── ② 运行期追加**后置 lane** `e3`（批运行中经 batch_tasks_add 的同一写入口 addPoolTasks）────────
//      形态 = V2：e3 与 a1 **同层序在后**（a1 的 deps 已冻结在先）⇒ 结构性无法成为 a1 的 deps。
store.addPoolTasks(SESSION, BATCH, [
  { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], cmd: 'late-fix' },
], { reason: 'G-10 探针：批运行中追加的后置 lane' });
seed('exec/e3.md', 'late product');
const afterAppend = store.readBatch(SESSION, BATCH);
dump('② 追加后 wavePlan 顺序（声明序真源）', (afterAppend.wavePlan ?? []).flatMap((w) => w.tasks.map((t) => t.id)));
dump('② 追加后 handoffs keys（e3 **没有**任何出边声明位）', Object.keys(afterAppend.handoffs));
dump('② plan.mutated 事件', (afterAppend.events ?? []).filter((e) => e.type === 'plan.mutated').map((e) => ({ added: e.added, revision: e.revision })));

// ── ③ 修前逐字拒态：后置 lane e3 向已声明下游 a1 交产物 ──────────────────────────────────────
const r1 = store.recordHandoff(SESSION, BATCH, {
  from: 'e3', to: 'a1', artifacts: ['exec/e3.md'], assertions: ['probe: e3 产物可核'],
  caller: { sessionId: SESSION, from: 'e3' },
});
dump('③ recordHandoff(e3 -> a1) 修前读数', { ok: r1.ok, code: r1.code, missing: r1.missing, problems: r1.problems });
const gapEvents = (store.readBatch(SESSION, BATCH).events ?? []).filter((e) => e.type === 'lane.handoff.gap');
dump('③ 拒态留痕 lane.handoff.gap', gapEvents.map((e) => ({ code: e.code, missing: e.missing })));

// ── ④ 反例面：既声明路径（e2 → a1）行为对照（零回归的「修前基线」）───────────────────────────
const r2 = store.recordHandoff(SESSION, BATCH, {
  from: 'e2', to: 'a1', artifacts: ['exec/e2.md'], assertions: ['probe: e2 产物可核'],
  caller: { sessionId: SESSION, from: 'e2' },
});
dump('④ recordHandoff(e2 -> a1) 既声明路径读数（应 ok）', { ok: r2.ok, code: r2.code });

// ── ⑤ 静默本体（D3 未闭合）：e3 有产物、有交付意图，但「有无下游」集合为空 ⇒ 结算出口门零感知 ──────
//       走**真实结算路径**（`store.setMember`，出口门唯一调用点 `store/member-gates.js`），
//       而非直调门函数（`gates` 不在 store 公开面上 ⇒ 也说明门本体在 lib/state/** 内部闭合）。
const settleOf = (lane) => {
  const trail = [];
  for (const to of ['running', 'review', 'merged']) {
    try { store.setMember(SESSION, BATCH, lane, to); trail.push(to + ':ok'); }
    catch (e) { trail.push(to + ':' + String(e?.message ?? e)); break; }
  }
  return trail;
};
dump('⑤ e3 结算轨迹（后置 lane；产物已落盘）', settleOf('e3'));
const b3 = store.readBatch(SESSION, BATCH);
dump('⑤ e3 结算后状态', { e3: b3.lanes.e3, phase: b3.phase });
dump('⑤ 结算期间是否新增 lane.handoff.gap', (b3.events ?? []).filter((e) => e.type === 'lane.handoff.gap').length);
line('⑤ 结论：后置 lane 的缺口**不转红、不阻断**（下游集合为空 ⇒ 出口门无对象）—— 即 G-10 的「静默」机理。');

// ── ⑥ 对照：把同一条边改成**建批期已声明**（e3 改为真 deps）⇒ 出口门立刻有对象并转红 ─────────────
//       目的 = 证明「静默」是**声明位缺失**造成的，而不是出口门坏了（门对**已声明**的边是有效的）。
const BATCH2 = 'g10-probe-batch-declared';
const tasks2 = [
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan-it' },
  { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], deps: ['p1'], cmd: 'late-fix' },
  { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e3.md'], produce: ['audit/a1.md'], deps: ['e3'], cmd: 'verify' },
];
store.createBatch(SESSION, { batchId: BATCH2, wavePlan: buildWavePlan({ batchId: BATCH2, tasks: tasks2, team: null, concurrency: 5 }), phase: 'running' });
for (const [rel, body] of [['plan/spec.md', SPEC_OK], ['exec/e3.md', 'out'], ['audit/a1.md', 'out']]) {
  const abs = path.join(store.artifactsDirOf(SESSION, BATCH2), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}
dump('⑥ 建批期已声明构型：handoffs keys', Object.keys(store.readBatch(SESSION, BATCH2).handoffs));
const settleOf2 = (batchId, lane) => {
  const trail = [];
  for (const to of ['running', 'review', 'merged']) {
    try { store.setMember(SESSION, batchId, lane, to); trail.push(to + ':ok'); }
    catch (e) { trail.push(to + ':rejected[' + String(e?.message ?? e).split('\n')[0] + ']'); break; }
  }
  return trail;
};
dump('⑥ 已声明 e3 的结算轨迹（预期在 merged 被 GATE_HANDOFF_MISSING 拒）', settleOf2(BATCH2, 'e3'));
dump('⑥ 拒态留痕 lane.handoff.gap', (store.readBatch(SESSION, BATCH2).events ?? []).filter((e) => e.type === 'lane.handoff.gap').map((e) => ({ lane: e.lane, code: e.code, missing: e.missing })));
line('⑥ 结论：**门本体有效**（对已声明的边转红 + 落缺口事件）⇒ G-10 的静默确实只源于「后置 lane 没有声明位」。');

// ── ⑥ 实现落点可达性（写域核查）：三处判定点的**文件归属** ────────────────────────────────────
line('');
line('== ⑥ 实现所需三处判定点的文件归属（与任务包写域核对）==');
line('  R-1 提交前置  lib/state/store/handoff.js#recordHandoff（`batch.handoffs[to]` 查表）  → lib/state/**（写域外）');
line('  R-3 出口门并集 lib/state/gates/handoff.js#checkSettleHandoffGate（下游集合直读 wavePlan） → lib/state/**（写域外）');
line('  R-1 入边单点  lib/state/gates/helpers.js#handoffVerdictOf / depsOf                   → lib/state/**（写域外）');
line('  域判定（可写）lib/wave-plan.ts#consumeDepsAsymmetryOf 仅收 WaveTask[]、读 l.deps（无 handoffs 面）→ 需外部供数');
line('  上游构建脚本 scripts/copy-ts-built.mjs 的回拷清单把 state/gates/*.js 列为**生成物** ⇒ 改 .ts 后 build 会覆盖 .js');
line('');
line('probe root: ' + root);
