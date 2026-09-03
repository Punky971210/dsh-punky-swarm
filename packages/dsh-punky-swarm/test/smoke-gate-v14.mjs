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

// V14 集成冒烟（独立脚本，非 test 套件）：真实批次 exec lane 声明 gate → merged 前置执行 → 事件流顺序核对
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-smoke-v14-'));
const store = createStore(root);
const SID = 's-smoke-v14';
const specOk = '# Spec\n## 验收标准\n- done\n## 约束\n- none\n';

function art(batchId, rel, content) {
  const abs = path.join(root, 'sessions', SID, 'artifacts', batchId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function set(b, lane, to, note) {
  try { return store.setMember(SID, b, lane, to, note); } catch (e) { return e; }
}
function runLane(b, lane) {
  const r1 = set(b, lane, 'running'); if (r1 instanceof Error) return r1;
  const r2 = set(b, lane, 'review'); if (r2 instanceof Error) return r2;
  return set(b, lane, 'merged');
}

const TASKS = [
  { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
  { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/report.md'], cmd: 'code', deps: ['p1'] },
  { id: 'a1', layer: 'audit', role: 'reviewer', produce: ['audit/acceptance.md'], cmd: 'review', deps: ['e1'] },
];

const out = { scenarios: [] };

// 场景 A：gate 全通过 → gate.exit 事件在 member.settled(merged) 之前
{
  const bid = 'b-smoke-a';
  store.createBatch(SID, { batchId: bid, wavePlan: buildWavePlan({ batchId: bid, tasks: TASKS, team: 'jiufeng' }) });
  art(bid, 'plan/spec.md', specOk);
  runLane(bid, 'p1');
  art(bid, 'exec/report.md', '# 验证\ngate: node -e "process.exit(0)"\n');
  const r = runLane(bid, 'e1');
  const b = store.readBatch(SID, bid);
  const idxExit = b.events.findIndex((e) => e.type === 'gate.exit');
  const idxSettled = b.events.findIndex((e) => e.type === 'member.settled' && e.lane === 'e1' && e.to === 'merged');
  out.scenarios.push({
    name: 'A-gate-pass',
    ok: !(r instanceof Error) && b.lanes.e1 === 'merged' && idxExit >= 0 && idxExit < idxSettled,
    laneState: b.lanes.e1,
    eventOrder: { gateExit: idxExit, mergedSettled: idxSettled },
    gateExit: b.events[idxExit],
  });
}

// 场景 B：gate 失败（非 0）→ gate.exit_blocked → 拒 merged 抛 GATE_EXIT_NONZERO，lane 留 review
{
  const bid = 'b-smoke-b';
  store.createBatch(SID, { batchId: bid, wavePlan: buildWavePlan({ batchId: bid, tasks: TASKS, team: 'jiufeng' }) });
  art(bid, 'plan/spec.md', specOk);
  runLane(bid, 'p1');
  art(bid, 'exec/report.md', '# 验证\ngate: node -e "process.exit(2)"\n');
  const r = runLane(bid, 'e1');
  const b = store.readBatch(SID, bid);
  const ev = b.events.find((e) => e.type === 'gate.exit_blocked');
  out.scenarios.push({
    name: 'B-gate-fail-no-human',
    ok: r instanceof Error && /GATE_EXIT_NONZERO/.test(r.message) && b.lanes.e1 === 'review' && ev && ev.exitCode === 2,
    laneState: b.lanes.e1,
    error: r instanceof Error ? r.message : 'no error',
    blockedEvent: ev,
  });
}

// 场景 C：gate 失败 + needHuman → gate.exit_blocked(escalation) → 无证据 GATE_NEEDHUMAN_PENDING → human: 证据 merged + human.decision
{
  const bid = 'b-smoke-c';
  store.createBatch(SID, { batchId: bid, wavePlan: buildWavePlan({ batchId: bid, tasks: TASKS, team: 'jiufeng' }) });
  art(bid, 'plan/spec.md', specOk);
  runLane(bid, 'p1');
  art(bid, 'exec/report.md', '# 验证\ngate: node -e "process.exit(1)"\nneedHuman: true\n');
  const s1 = set(bid, 'e1', 'running'); const s2 = set(bid, 'e1', 'review');
  const s3 = set(bid, 'e1', 'merged', 'no evidence');
  const b1 = store.readBatch(SID, bid);
  const evBlocked = b1.events.find((e) => e.type === 'gate.exit_blocked');
  const s4 = set(bid, 'e1', 'merged', 'human:user@2026-08-25:accept');
  const b2 = store.readBatch(SID, bid);
  out.scenarios.push({
    name: 'C-gate-fail-human-gate',
    ok: !(s1 instanceof Error) && !(s2 instanceof Error) && s3 instanceof Error && /GATE_NEEDHUMAN_PENDING/.test(s3.message)
      && evBlocked && evBlocked.escalation === true && b1.lanes.e1 === 'review'
      && !(s4 instanceof Error) && b2.lanes.e1 === 'merged'
      && b2.events.some((e) => e.type === 'human.decision'),
    pendingError: s3 instanceof Error ? s3.message : 'none',
    blockedEscalation: evBlocked ? evBlocked.escalation : null,
    finalLane: b2.lanes.e1,
    hasHumanDecision: b2.events.some((e) => e.type === 'human.decision'),
  });
}

// 场景 D：未声明 gate → 零感知（无 gate.* 事件）
{
  const bid = 'b-smoke-d';
  store.createBatch(SID, { batchId: bid, wavePlan: buildWavePlan({ batchId: bid, tasks: TASKS, team: 'jiufeng' }) });
  art(bid, 'plan/spec.md', specOk);
  runLane(bid, 'p1');
  art(bid, 'exec/report.md', '# 验证\n- 无 gate 声明\n');
  const r = runLane(bid, 'e1');
  const b = store.readBatch(SID, bid);
  const hasGateEvents = b.events.some((e) => e.type === 'gate.exit' || e.type === 'gate.exit_blocked');
  out.scenarios.push({
    name: 'D-no-declare-zero-sensing',
    ok: !(r instanceof Error) && b.lanes.e1 === 'merged' && !hasGateEvents,
    laneState: b.lanes.e1,
    hasGateEvents,
  });
}

const allOk = out.scenarios.every((s) => s.ok);
console.log('SMOKE_V14_RESULT:', allOk ? 'PASS' : 'FAIL');
console.log(JSON.stringify(out, null, 2));
process.exit(allOk ? 0 : 1);
