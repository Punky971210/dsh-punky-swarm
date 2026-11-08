import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../../lib/tools/register.js';
import { createStore } from '../../lib/state/store.js';
import { threeTierTasks, seedArtifacts, assessC } from './gate-fixture.mjs';
import { withDefaultTeam } from './skill-paths.mjs';

/**
 * dispatch 面测试统一 harness（G7 下沉，2026-09-22：dispatch-failure-rollback /
 * dispatch-prompt-compose 两份同形单轴变体合并；调用侧一行适配，调用点零改动）。
 * 装配序：tmp 根 → store → ctx（start 桩可注入，默认自足桩）→ createTools → C 档评估
 * → wave_plan（三层批 + auditLane）→ running → 产物播种。
 * @param {object} [o]
 * @param {string} [o.SID]      会话 id（各测试文件保持原值）
 * @param {string} [o.batchId]  批次 id（同上）
 * @param {Function} [o.start]  `rt.start(provider, request)` 桩（缺省 = 自足成功桩）
 * @param {boolean} [o.markCmd] 给 tasks 打 CMD-MARK 标记（prompt-compose 断言用）
 * @param {object|null} [o.taskExtra] 任务级附加字段（缺省 `null` ⇒ 既有套件任务对象**逐字不变**）
 * @returns {Promise<{by,exec,store,captured,root,SID,batchId}>}
 */
export async function makeDispatchHarness({ SID = 'sess-dfx', batchId = 'b-dfx', start, markCmd = false, taskExtra = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-dfx-'));
  const store = createStore(root);
  const captured = [];
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    subagents: {
      start: async (provider, request) => {
        captured.push({ provider, ...request });
        return start
          ? start(provider, request)
          : { id: 'worker-stub-1', result: Promise.resolve({ output: [], stopReason: 'completed' }) };
      },
    },
  };
  const { tools } = createTools(ctx, { store, root, config: { dispatch: { provider: 'spawn' } } });
  const by = withDefaultTeam(Object.fromEntries(tools.map((t) => [t.name, t])));
  const exec = { agent: { session: { id: SID } } };
  assessC(store, SID, { rationale: 'fixture：三层批建批前置评估（多线并行 ⇒ C 档）' });
  const tasks = threeTierTasks(['e1'], { auditId: 'a1' });
  if (markCmd) for (const t of tasks) t.cmd = 'CMD-MARK-' + t.id + ' 的任务说明';
  // 【ckpt-wire · 批 `punky-checkpoint-wire-20261106` · lane `e1-resume`】任务级附加字段注入位
  //   （用途：`{ resume: true }` 验派发路径 R-4「`laneTask.resume` ⇒ 任务包」）。
  //   缺省 `null` ⇒ 不改任何任务对象 ⇒ 既有套件零影响。
  if (taskExtra) for (const t of tasks) Object.assign(t, taskExtra);
  await by.wave_plan.execute({ batchId, tasks, assembly: { auditLane: 'a1' } }, exec);
  await by.batch_phase.execute({ batchId, phase: 'running' }, exec);
  seedArtifacts(root, SID, batchId, ['e1'], { planProduct: 'plan/spec.md' });
  return { by, exec, store, captured, root, SID, batchId };
}
