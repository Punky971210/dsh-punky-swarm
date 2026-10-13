// e3-toolface：**在册工具真调回执**（① 项的一手读数）——
//   注：① 的工具实现由 Leader 追加的 lane `e4-toolface` 落地（本 lane 报出写域阻塞后转派）；
//   本脚本对**已注册**的 `handoff_accept` 做独立真调，取「成功分支 + 各拒绝分支」的逐字回执，
//   供 Tester / audit 复验（不是实现方自证）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools/register.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';

const SESSION = 'sess-e3-accept-smoke';
const SESS = { agent: { session: { id: SESSION } } };
const SPEC_OK = '# spec\n## 概述\n- x\n## 问题\n- x\n## 方案\n- x\n## 需求\n- x\n## 验收标准\n- x\n## 约束\n- y\n';
const dump = (l, v) => console.log(l + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-e3-accept-smoke-'));
fs.mkdirSync(path.join(root, 'config'), { recursive: true });
fs.writeFileSync(path.join(root, 'config', 'runtime.json'), JSON.stringify({ gates: { handoff: { entry: true, settle: true } } }), 'utf8');
const store = createStore(root);
const ctx = { tools: { register: () => {} }, logger: { info() {}, warn() {}, error() {} } };
const { tools } = createTools(ctx, { store, root, config: {} });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

dump('在册工具数', tools.length);
dump('handoff_accept 在册 / 有 output.schema', [typeof byName.handoff_accept === 'object', !!byName.handoff_accept?.output?.schema]);
dump('参数面（required / 键）', {
  required: byName.handoff_accept.parameters.required ?? null,
  keys: Object.keys(byName.handoff_accept.parameters.properties ?? {}),
});

const threeTier = (batchId, extra = {}) => {
  const tasks = [
    { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'plan' },
    { id: 'e2', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e2.md'], deps: ['p1'], cmd: 'build' },
    { id: 'a1', layer: 'audit', consume: ['plan/spec.md', 'exec/e2.md'], produce: ['audit/a1.md'], deps: ['e2'], cmd: 'verify' },
  ];
  store.createBatch(SESSION, { batchId, wavePlan: buildWavePlan({ batchId, tasks, team: null, concurrency: 5 }), phase: extra.phase ?? 'running' });
};

// ① 成功分支：追加 lane（声明序在 audit lane 之前）⇒ 下游声明接受
threeTier('sm-ok');
store.addPoolTasks(SESSION, 'sm-ok', [
  { id: 'e3', layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/e3.md'], deps: ['p1'], cmd: 'late' },
], { reason: 'smoke：追加后置 lane', author: 'probe' });
const ok = await byName.handoff_accept.execute({ batchId: 'sm-ok', from: 'e3', to: 'a1', reason: 'smoke 接受', author: 'probe' }, SESS);
dump('① 真调成功分支（e3 -> a1）', ok);
dump('   渲染面', (byName.handoff_accept.output.render({ batchId: 'sm-ok' }, ok) ?? []).map((x) => x.text).join('\n   '));
dump('   留痕 plan.mutated（accepts/revision）', store.readBatch(SESSION, 'sm-ok').events.filter((e) => e.type === 'plan.mutated').map((e) => ({ added: e.added ?? null, accepts: e.accepts ?? null, revision: e.revision })));
const again = await byName.handoff_accept.execute({ batchId: 'sm-ok', from: 'e3', to: 'a1' }, SESS);
dump('① 真调幂等分支（二次声明）', { ok: again.ok, code: again.code, idempotent: again.idempotent, revision: again.revision });

// ② 拒绝分支：S-a（to 非 audit 层）/ S-b（from 非追加 lane）/ S-c（声明序违约）
const call = async (args) => {
  try { const r = await byName.handoff_accept.execute(args, SESS); return { returned: r }; }
  catch (e) { return { thrown: true, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 120) }; }
};
dump('② 拒绝 S-a（to = exec 层 e2）', await call({ batchId: 'sm-ok', from: 'e3', to: 'e2' }));
dump('② 拒绝 S-b（from = 建批期既存 lane p1）', await call({ batchId: 'sm-ok', from: 'p1', to: 'a1' }));
threeTier('sm-sc');
store.addPoolTasks(SESSION, 'sm-sc', [
  { id: 'e3', layer: 'exec', consume: ['exec/e2.md'], outputs: ['exec/e3.md'], deps: ['e2'], cmd: 'late' },
], { reason: 'smoke：追加 lane 落在 audit lane 之后（复现本批真实序）', author: 'probe' });
dump('② 拒绝 S-c（声明序：orderOf(a1) < orderOf(e3)）', await call({ batchId: 'sm-sc', from: 'e3', to: 'a1' }));
dump('② 拒态零写入（planRevision / handoffs.a1 条目）', {
  planRevision: store.readBatch(SESSION, 'sm-sc').planRevision,
  a1Entries: (store.readBatch(SESSION, 'sm-sc').handoffs.a1 ?? []).map((r) => r.from),
});
// ③ 批终态：复用既有 GATE_BATCH_TERMINAL
threeTier('sm-term', { phase: 'aborted' });
dump('③ 拒绝：批终态（复用既有码）', await call({ batchId: 'sm-term', from: 'e3', to: 'a1' }));

fs.rmSync(root, { recursive: true, force: true });
console.log('smoke root cleaned');
