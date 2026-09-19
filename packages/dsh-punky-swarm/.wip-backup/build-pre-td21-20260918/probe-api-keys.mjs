// 只读探针（S5 前置）：实测 `/batch` 响应键面与 chain/aipSession 条件键的触发条件，
// 用于确定 `test/api-batch-keys.test.js` 的 P-1 夹具形态。零项目写盘（只在 os.tmpdir 造夹具）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../../lib/api.js';
import { createStore } from '../../lib/state/store.js';
import { buildWavePlan } from '../../lib/wave-plan.js';
import * as aipFormat from '../../lib/comms/acps-bridge.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-probe-keys-'));
const store = createStore(root);
const S = 'sess-probe';
const lanes = ['e1', 'e2', 'e3', 'e4', 'e5'];
const tasks = [
  { id: 'p1', layer: 'plan', produce: ['plan/spec.md'], cmd: 'spec' },
  ...lanes.map((id) => ({ id, layer: 'exec', consume: ['plan/spec.md'], outputs: ['exec/' + id + '.md'], cmd: 'run', deps: ['p1'] })),
  { id: 'a1', layer: 'audit', consume: ['plan/spec.md', ...lanes.map((i) => 'exec/' + i + '.md')], produce: ['audit/a1.md'], cmd: 'review', deps: lanes },
];
const plan = buildWavePlan({ batchId: 'b-probe', team: 'software-team', tasks });
const assembly = { auditLane: 'a1', managerPlan: 'leader-direct' };
store.createBatch(S, { batchId: 'b-probe', wavePlan: plan, assembly });

const routes = [];
const ctx = { webServer: { register: (r) => { routes.push(r); return () => {}; } } };
createApi(ctx, { store, root, aipFormat });
const route = routes.find((x) => x.path === '/api/dsh-punky-swarm/batch');
let body = null;
route.handler({ url: '/api/dsh-punky-swarm/batch?batchId=b-probe&session=' + S }, { writeHead() {}, end(b) { body = JSON.parse(b); } });
console.log('keys:', JSON.stringify(Object.keys(body)));
console.log('lanes:', JSON.stringify(Object.keys(body.lanes)));
console.log('chain:', JSON.stringify(body.chain));
console.log('assembly:', JSON.stringify(body.assembly));
console.log('teamAsset keys:', JSON.stringify(Object.keys(body.teamAsset ?? {})));
console.log('aipSession:', JSON.stringify(body.aipSession));
console.log('lanesGate keys:', JSON.stringify(Object.keys(body.lanesGate ?? {})));
console.log('lanesGate.e1 keys:', JSON.stringify(Object.keys(body.lanesGate?.e1 ?? {})));
fs.rmSync(root, { recursive: true, force: true });
