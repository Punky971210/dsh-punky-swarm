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

// Gates：Tier3 层间门禁（设计 §3.3/§四/§五/§15）——entry（consume 前置）/ exit（outputs/produce 前置 + Plan 契约 checkPlanContract）/ complete（audit 验收前置）
// 纯函数闭包工厂：createGates(root) 注入 root；门禁函数签名 (sessionId, batchId, batch, lane)——batch 对象显式传入，不持有状态
// Phase 2 类型化：wavePlan 任务属性访问经 taskOf 单点断言（findTask 保持 JS，返回 object|null → WavePlanTask，
//   断言依据：findTask 语义即"按 id 定位 buildWavePlan 持久形态任务"）；Batch/批事件判别联合收窄（零断言消解 TS2339）；
//   gate 函数返回类型沿用结构推断（消费方 store.js 等为 JS，无类型约束）——运行期语义零变更（断言纯类型层）。
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../schema.js';
import { runCommand } from './command-exec.js';
// P1-07 单点收敛：SESSION_RE/isAbsPath 定义迁至 constants.js；isAbsPath 保持导出
// （store.js:24 等既有消费方 import { isAbsPath } from './gates.js' 不受影响）。
import { SESSION_RE, isAbsPath } from './constants.js';
// P1-04 单点：findTask 收敛至 task-utils.js（原 :108 本地定义删除，调用点不变）
import { findTask } from './task-utils.js';
// R-07 读端收敛：e.type 比较改引 EVT 常量单点（member.settled 读端 :117）
import * as EVT from './event-types.js';
import type { Batch, Layer, WavePlanTask } from '../types/contracts.js';
export { isAbsPath };

// 局部类型化包装：findTask（task-utils.js，保持 JS）返回 object|null → 属性访问全报"属性不存在"。
// taskOf 为唯一断言点：findTask 遍历 batch.wavePlan[].tasks 按 t.id === lane 返回 buildWavePlan 持久形态任务
// → WavePlanTask 类型成立（运行期零变化，断言纯类型层）。
function taskOf(batch: Batch | null, lane: string): WavePlanTask | null {
  return findTask(batch, lane) as WavePlanTask | null;
}

// 任务数组字段（gates 只读 consume/produce/outputs 三类，t[field] 索引合法化）
type TaskArrayField = 'consume' | 'produce' | 'outputs';

// targets 门禁（O2）marker 逃生声明标记：目标文件含独立行 `targets-claimed: true` 即视为已变更（跳过 mtime 比对）。
// 行首锚定独立行正则（仿 needHuman 独立行模式）——内嵌/注释/非行首不误判（NFR3）。
export const TARGETS_CLAIMED_RE = /^targets-claimed:\s*true$/m;

// needHuman：audit 产物人工裁决声明检测（纯函数，与 checkExitGate 同源文件解析）——
// 产物含独立行 `needHuman: true`（正则 /^needHuman:\s*true$/m）即声明人工裁决需求；
// 缺失/空文件/目录跳过（零感知：缺产物由 exit gate 既有语义拒，本函数不补刀）
export function detectNeedHuman(artifactsDir: string, producePaths: string[]) {
  if (!Array.isArray(producePaths) || producePaths.length === 0) return { declared: false, path: null };
  for (const p of producePaths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (/^needHuman:\s*true$/m.test(content)) return { declared: true, path: p };
  }
  return { declared: false, path: null };
}

// 命令 gate（V1）：产物独立行声明 `gate: <命令>`（行首锚定正则，与 needHuman 独立行模式同源）
// 内嵌/注释/非行首不误判；`gate: false` 视为显式禁用声明不计入（spec G1）；空命令（gate: 后无内容）不计入（spec G8）
export const GATE_LINE_RE = /^gate:\s*(.+)$/gm;

// 声明解析纯函数（同 detectNeedHuman 模式：缺失/空/目录跳过、零感知）：
// 遍历 produce/outputs 并集 → 收集所有命中行命令（保序）→ { declared, commands, path }
// 全部命中行为空/禁用 → declared=false（零感知，C2/G8）
export function detectGate(artifactsDir: string, paths: string[]) {
  if (!Array.isArray(paths) || paths.length === 0) return { declared: false, commands: [], path: null };
  const commands = [];
  let declaredPath: string | null = null;
  for (const p of paths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    GATE_LINE_RE.lastIndex = 0; // /g 正则复用防 lastIndex 泄漏
    let m;
    while ((m = GATE_LINE_RE.exec(content)) !== null) {
      const cmd = m[1].trim();
      if (cmd.length === 0 || cmd === 'false') continue; // 空命令 / gate: false（禁用声明）不计入
      commands.push(cmd);
      if (!declaredPath) declaredPath = p;
    }
  }
  return { declared: commands.length > 0, commands, path: declaredPath };
}

export function createGates(root: string) {
  const sessionsDir = path.join(root, 'sessions');

  function sessionDir(sessionId: string) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionsDir, sessionId);
  }
  function artifactsDirOf(sessionId: string, batchId: string) {
    return path.join(sessionDir(sessionId), 'artifacts', batchId);
  }
  function batchFile(sessionId: string, batchId: string) {
    if (!SESSION_RE.test(batchId)) throw new Error('invalid batchId');
    return path.join(sessionDir(sessionId), 'batches', batchId + '.json');
  }
  function readBatch(sessionId: string, batchId: string): Batch | null {
    const file = batchFile(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    try {
      // 单点断言：批次 JSON 由 store.createBatch 写入（Batch 契约同源形态），JSON.parse 产物断言为 Batch
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Batch;
    } catch {
      // 损坏批次隔离（v2-node-robustness ②，AC-1 读路径不 throw）：损坏 → null（登记在 store 旁路清单，本文件不重复）
      return null;
    }
  }

  // ---- Tier3 门禁辅助 ----
  // lane 启动时间（O2 targets 门禁基准）：events 末尾向前反查最近一条 `member.settled` 且 lane 匹配且
  // to==='running' 的事件 ts（ISO）——返工（review→running）会 push 新的 running 结算事件 → 基准重置（重新计时）；
  // 无 → 回退 batch.createdAt（防御；正常 merged 必有 running 事件）。遍历模式仿 store.js lastActiveAtOf。
  // e.type === EVT 常量值（'member.settled'）在 BatchEvent 判别联合下收窄；兜底分支字段 unknown 与 === 比较不受影响
  function laneStartedAt(batch: Batch, lane: string): string {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e && e.type === EVT.EVT_MEMBER_SETTLED && e.lane === lane && e.to === 'running' && e.ts) return e.ts;
    }
    return batch.createdAt;
  }
  function resolveArtifact(sessionId: string, batchId: string, rel: string) {
    return isAbsPath(rel) ? rel : path.join(artifactsDirOf(sessionId, batchId), rel);
  }
  function fileExistsNonEmpty(p: string) {
    try {
      const st = fs.statSync(p);
      return st.isDirectory() || st.size > 0;
    } catch { return false; }
  }
  // Entry Gate（设计 §四）：exec 与 audit lane 派发前 consume 必须全部存在且非空
  // P2-03：条件覆盖 audit 层（原仅 exec——audit lane 声明 consume 时缺产物同样应拒派 GATE_ENTRY_MISSING）
  function checkEntryGate(sessionId: string, batchId: string, batch: Batch, lane: string) {
    const t = taskOf(batch, lane);
    if (!t || (t.layer !== 'exec' && t.layer !== 'audit') || !Array.isArray(t.consume) || t.consume.length === 0) return { ok: true };
    const missing = t.consume.filter((p: string) => !fileExistsNonEmpty(resolveArtifact(sessionId, batchId, p)));
    return missing.length ? { ok: false, code: 'GATE_ENTRY_MISSING', missing } : { ok: true };
  }
  // Plan 契约产物结构校验：仅 plan 产物——spec 必填章节 + task-tree JSON 可解析
  function checkPlanContract(sessionId: string, batchId: string, batch: Batch, lane: string) {
    const t = taskOf(batch, lane);
    if (!t || t.layer !== 'plan' || !Array.isArray(t.produce)) return { ok: true };
    const problems = [];
    for (const p of t.produce) {
      const abs = resolveArtifact(sessionId, batchId, p);
      if (!fileExistsNonEmpty(abs)) { problems.push(p + ' missing'); continue; }
      const content = fs.readFileSync(abs, 'utf8');
      if (p.endsWith('spec.md')) {
        if (!content.includes('## 验收标准')) problems.push(p + ' lacks "## 验收标准"');
        if (!content.includes('## 约束')) problems.push(p + ' lacks "## 约束"');
      } else if (p.endsWith('.json')) {
        try { JSON.parse(content); } catch { problems.push(p + ' invalid JSON'); }
      }
    }
    return problems.length ? { ok: false, code: 'GATE_PLAN_CONTRACT', problems } : { ok: true };
  }
  // Exit Gate（设计 §五）：exec→outputs 存在；audit→produce 存在；plan→Plan 契约
  function checkExitGate(sessionId: string, batchId: string, batch: Batch, lane: string) {
    const t = taskOf(batch, lane);
    if (!t || !t.layer) return { ok: true };
    if (t.layer === 'plan') return checkPlanContract(sessionId, batchId, batch, lane);
    const field = t.layer === 'exec' ? 'outputs' : (t.layer === 'audit' ? 'produce' : null);
    if (!field || !Array.isArray(t[field]) || t[field].length === 0) return { ok: true };
    const missing = t[field].filter((p: string) => !fileExistsNonEmpty(resolveArtifact(sessionId, batchId, p)));
    return missing.length ? { ok: false, code: 'GATE_EXIT_MISSING_' + t.layer.toUpperCase(), missing } : { ok: true };
  }
  // needHuman Gate（复用 review 态挂起）：audit lane 产物声明 needHuman →
  // review→merged 前置人工裁决证据（note 契约 `human:<裁决人>:<时间>:<结论>`，如 human:user@2026-08-21:accept）
  // 缺证据 → GATE_NEEDHUMAN_PENDING；conflict 驳回不强制（评审驳回/人工否决语义）；
  // 未声明/非 audit lane → 零感知（{ ok: true, declared: false }）
  function checkNeedHumanGate(sessionId: string, batchId: string, batch: Batch, lane: string, note?: string | null) {
    const t = taskOf(batch, lane);
    if (!t || t.layer !== 'audit' || !Array.isArray(t.produce) || t.produce.length === 0) {
      return { ok: true, declared: false, path: null };
    }
    const det = detectNeedHuman(artifactsDirOf(sessionId, batchId), t.produce);
    if (!det.declared) return { ok: true, declared: false, path: null };
    const evidence = typeof note === 'string' ? (note.match(/^human:.+/m) ?? [null])[0] : null;
    if (evidence) return { ok: true, declared: true, path: det.path, evidence };
    return {
      ok: false, code: 'GATE_NEEDHUMAN_PENDING', declared: true, path: det.path,
      message: 'audit lane 声明 needHuman，须 Manager 转达人工裁决（merged 需 note 含 human: 证据 / conflict 驳回）',
    };
  }
  // 命令 gate（V1，设计 §组件 2 / spec G2-G10、C5-C7）：exec 层产物声明行 `gate: <命令>` → merged 前置确定性执行 → 退出码判定
  // 签名与既有门禁一致（batch 显式传入，不持有状态）；执行器经 deps.runCommand 注入（DI，默认真实执行器，测试可注入 mock）
  // cwd 契约（C7）：lane worktree 根（若已建）→ GATE_REPO_ROOT（批次 repo 根配置，V1 env 注入）→ artifacts 根兜底
  function commandCwd(sessionId: string, batchId: string, lane: string) {
    const wt = path.join(sessionDir(sessionId), 'worktrees', batchId, lane);
    try { if (fs.statSync(wt).isDirectory()) return wt; } catch { /* 未建 worktree，继续 */ }
    const repoRoot = process.env.GATE_REPO_ROOT;
    if (repoRoot) { try { if (fs.statSync(repoRoot).isDirectory()) return repoRoot; } catch { /* 无效则跳过 */ } }
    return artifactsDirOf(sessionId, batchId);
  }
  function checkCommandGate(
    sessionId: string, batchId: string, batch: Batch, lane: string,
    deps: { runCommand?: typeof runCommand } = {},
  ) {
    // 总开关（GATE_ENABLED=false → 全部零感知，应急逃生阀）
    if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') return { ok: true, declared: false };
    const t = taskOf(batch, lane);
    if (!t || t.layer !== 'exec') return { ok: true, declared: false }; // 仅约束 exec 层验证声明（D-005）
    // produce ∪ outputs 并集（去重保序）
    const fields = [...new Set([...(t.produce ?? []), ...(t.outputs ?? [])])];
    const det = detectGate(artifactsDirOf(sessionId, batchId), fields);
    if (!det.declared) return { ok: true, declared: false }; // 未声明 gate → 零感知（C2/G10）
    if (det.commands.length === 0) {
      return { ok: false, code: 'GATE_EXIT_NO_COMMAND', command: null, exitCode: null, declared: true, needHumanEscalation: false, detail: 'gate 行命中但命令解析为空（防空命令假通过）' };
    }
    const run = deps.runCommand ?? runCommand;
    const results: Array<{ command: string; exitCode: number | null; durationMs: number }> = [];
    let failed: { code: string; command: string; exitCode: number | null; detail: string } | null = null;
    let outputTruncated = false;
    for (const command of det.commands) {
      const r = run({ command, cwd: commandCwd(sessionId, batchId, lane) });
      if (r.truncated) outputTruncated = true;
      const res = { command, exitCode: r.exitCode ?? null, durationMs: r.durationMs ?? 0 };
      results.push(res);
      if (r.forbidden) { failed = { code: 'GATE_EXIT_FORBIDDEN', command, exitCode: null, detail: '黑名单命中（只读守卫，不执行）' }; break; }
      if (r.timedOut) { failed = { code: 'GATE_EXIT_TIMEOUT', command, exitCode: res.exitCode, detail: '命令超时（重试后仍超时）' }; break; }
      if (r.error && r.error.startsWith('GATE_EXIT_SPAWN_FAIL')) { failed = { code: 'GATE_EXIT_SPAWN_FAIL', command, exitCode: null, detail: r.error }; break; }
      if (r.error === 'GATE_EXIT_NO_COMMAND') { failed = { code: 'GATE_EXIT_NO_COMMAND', command, exitCode: null, detail: r.error }; break; }
      if (!r.ok) { failed = { code: 'GATE_EXIT_NONZERO', command, exitCode: res.exitCode, detail: '退出码 ' + res.exitCode + '（非 0，重试后仍失败）' }; break; }
    }
    if (failed) {
      // C5/G9：失败且产物同时声明 needHuman → 转人工闸（不抛错，store 接线转 checkNeedHumanGate 语义）
      const nh = detectNeedHuman(artifactsDirOf(sessionId, batchId), fields);
      return { ok: false, ...failed, declared: true, needHumanEscalation: nh.declared, path: det.path };
    }
    return { ok: true, declared: true, commands: det.commands, results, outputTruncated, path: det.path };
  }
  // targets 门禁（O2，设计 §1.2）：exec 层 lane 声明 targets（批次产物根外目标文件绝对路径）→ merged 前置校验
  // 每个 target：①存在性（statSync 为文件；缺失/目录 → missing）；②变更性——mtime 晚于 lane 启动时间
  // （默认 mtime 路径），或 marker 逃生（任务级 targetsMarker 非空 或 env GATE_TARGETS_MODE==='marker' →
  // 目标文件内容含独立行 `targets-claimed: true` 即视为已变更，跳过 mtime 比对，两模式不叠加）；
  // 未声明 targets / 非 exec 层 / GATE_ENABLED=false → 零感知（{ ok: true, declared: false }，与 checkCommandGate D-005 对称）。
  // 判定：missing 非空 → { ok:false, code:'GATE_TARGET_MISSING', missing }；unchanged 非空 →
  // { ok:false, code:'GATE_TARGET_UNCHANGED', unchanged }；全过 → { ok:true, declared:true, mode:'mtime'|'marker' }。
  // 诚实披露：mtime/marker 均为低成本实证（非密码学证据），防「口头声称零成本通过」；恶意伪造归 O5 人审。
  function checkTargetsGate(sessionId: string, batchId: string, batch: Batch, lane: string) {
    // 总开关（GATE_ENABLED=false → 全批零感知，应急逃生阀，与 checkCommandGate 同源）
    if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') return { ok: true, declared: false };
    const t = taskOf(batch, lane);
    if (!t || t.layer !== 'exec' || !Array.isArray(t.targets) || t.targets.length === 0) {
      return { ok: true, declared: false }; // 未声明 / 非 exec 层 → 零感知
    }
    const startAt = laneStartedAt(batch, lane);
    const startMs = Date.parse(startAt);
    const markerMode = (typeof t.targetsMarker === 'string' && t.targetsMarker.length > 0)
      || String(process.env.GATE_TARGETS_MODE).toLowerCase() === 'marker';
    const missing: string[] = [];
    const unchanged: string[] = [];
    for (const target of t.targets) {
      let st;
      try { st = fs.statSync(target); } catch { missing.push(target); continue; }
      if (!st.isFile()) { missing.push(target); continue; } // 目录/非文件视同缺失（与 detectNeedHuman 文件判定同源）
      if (markerMode) {
        let claimed = false;
        try {
          claimed = TARGETS_CLAIMED_RE.test(fs.readFileSync(target, 'utf8'));
        } catch { /* 读失败 → 视为未声明（fail-closed，落到 unchanged） */ }
        if (claimed) continue; // 标记命中 → 视为已变更（跳过 mtime 比对）
        unchanged.push(target);
        continue;
      }
      // mtime 主路径（默认）：目标文件 mtime 必须晚于 lane 最近 running 启动时间
      const mtimeMs = new Date(st.mtime).getTime();
      if (!(Number.isFinite(mtimeMs) && Number.isFinite(startMs) && mtimeMs > startMs)) unchanged.push(target);
    }
    if (missing.length > 0) {
      return { ok: false, declared: true, code: 'GATE_TARGET_MISSING', missing, unchanged: [], mode: markerMode ? 'marker' : 'mtime', targets: [...t.targets] };
    }
    if (unchanged.length > 0) {
      return { ok: false, declared: true, code: 'GATE_TARGET_UNCHANGED', missing: [], unchanged, mode: markerMode ? 'marker' : 'mtime', targets: [...t.targets] };
    }
    return { ok: true, declared: true, missing: [], unchanged: [], mode: markerMode ? 'marker' : 'mtime', targets: [...t.targets] };
  }
  // Complete Gate（设计 §5.2）：audit 层必须存在且全部 settled 且无 failed/conflict；exec 层全部 settled
  function checkCompleteGate(batch: Batch) {
    const layers: Record<Layer, string[]> = { plan: [], exec: [], audit: [] };
    for (const w of batch.wavePlan ?? []) {
      for (const t of w.tasks) if (t.layer && layers[t.layer]) layers[t.layer].push(t.id);
    }
    if (layers.exec.length === 0 && layers.audit.length === 0) return { ok: true }; // generic 批次
    const laneState = (id: string) => batch.lanes[id];
    const allTerminal = (ids: string[]) => ids.every((id: string) => schema.isMemberTerminal(laneState(id)));
    if (layers.audit.length === 0) return { ok: false, code: 'GATE_COMPLETE_NO_AUDIT' };
    if (!allTerminal(layers.audit)) return { ok: false, code: 'GATE_EXIT_PENDING_AUDIT', pending: layers.audit.filter((id: string) => !schema.isMemberTerminal(laneState(id))) };
    if (layers.audit.some((id: string) => ['failed', 'conflict'].includes(laneState(id)))) return { ok: false, code: 'GATE_COMPLETE_AUDIT_FAILED' };
    if (layers.exec.length && !allTerminal(layers.exec)) return { ok: false, code: 'GATE_COMPLETE_EXEC_PENDING', pending: layers.exec.filter((id: string) => !schema.isMemberTerminal(laneState(id))) };
    return { ok: true };
  }
  // 门禁状态查询（gate_status 工具用，设计 §8 M1）：lane 的 layer/契约字段/缺失清单/plan 契约问题
  function gateStatus(sessionId: string, batchId: string, lane: string) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) {
      // 损坏批次（文件存在但解析失败）→ 返回 corrupt 视图不 throw（AC-1 读路径不 throw）；不存在 → throw
      if (fs.existsSync(batchFile(sessionId, batchId))) {
        return { lane, layer: null, state: null, team: null, corrupt: true, consume: [], produce: [], outputs: [], consumeMissing: [], outputsMissing: [], produceMissing: [], contractProblems: null, targets: [], targetsMissing: [], targetsUnchanged: [] };
      }
      throw new Error('batch not found: ' + batchId);
    }
    const t = taskOf(batch, lane);
    if (!t) return { lane, layer: null, state: batch.lanes[lane], gates: 'generic', team: batch.team };
    const missing = (field: TaskArrayField) => (Array.isArray(t[field]) ? t[field] : []).filter((p: string) => !fileExistsNonEmpty(resolveArtifact(sessionId, batchId, p)));
    const contract = t.layer === 'plan' ? checkPlanContract(sessionId, batchId, batch, lane) : null;
    // targets 探测（O2，设计 §1.5）：声明清单 + 缺失清单 + 未变更清单——仅 stat（存在性 + mtime 路径），
    // 不读文件正文（marker 命中判定留给门禁执行时，避免 gate_status 读文件成本，见 design Open Question 3）
    const targets: string[] = Array.isArray(t.targets) ? [...t.targets] : [];
    const startAt = laneStartedAt(batch, lane);
    const startMs = Date.parse(startAt);
    const statFile = (p: string): fs.Stats | null => { try { const st = fs.statSync(p); return st.isFile() ? st : null; } catch { return null; } };
    const targetsMissing = targets.filter((p: string) => statFile(p) === null);
    const targetsUnchanged = targets.filter((p: string) => {
      if (targetsMissing.includes(p)) return false;
      const st = statFile(p);
      if (!st) return true; // 探测竞态：stat 失败视同未变更（保守）
      const mtimeMs = new Date(st.mtime).getTime();
      return !(Number.isFinite(mtimeMs) && Number.isFinite(startMs) && mtimeMs > startMs);
    });
    return {
      lane, layer: t.layer ?? null, state: batch.lanes[lane], team: batch.team,
      consume: t.consume ?? [], produce: t.produce ?? [], outputs: t.outputs ?? [],
      consumeMissing: missing('consume'), outputsMissing: missing('outputs'), produceMissing: missing('produce'),
      contractProblems: contract && !contract.ok ? contract.problems : null,
      targets, targetsMissing, targetsUnchanged,
    };
  }

  return { checkEntryGate, checkPlanContract, checkExitGate, checkNeedHumanGate, checkCommandGate, checkTargetsGate, checkCompleteGate, gateStatus };
}
