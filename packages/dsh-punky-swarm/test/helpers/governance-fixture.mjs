import { createStore } from '../../lib/state/store.js';
import { buildWavePlan } from '../../lib/wave-plan.js';

/**
 * governance 面最小批次夹具（G7 下沉，2026-09-22：governance-escalate / governance-preset-config
 * 两份同形实现合并——差异仅 laneId 单轴；单 lane、running 态、不播产物）。
 */
export function seedGovernanceBatch(root, sessionId, batchId, laneId = 'l1') {
  const store = createStore(root);
  store.createBatch(sessionId, { batchId, wavePlan: buildWavePlan({ batchId, tasks: [{ id: laneId }] }), phase: 'running' });
  return store;
}
