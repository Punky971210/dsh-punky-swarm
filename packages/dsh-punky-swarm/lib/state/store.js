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

// BatchStore：批次状态文件唯一事实源（原子写 + 事件日志 + 状态机迁移 + 恢复语义）
// v2：批次绑定 session——root/sessions/<sessionId>/batches/*.json；存量 root/batches 迁移到 legacy
// Tier3：层间门禁（entry/exit/Plan 契约/complete）由 state/gates.js 承担，createStore 经 createGates(root) 注入调用
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../schema.js';
import { createGates, isAbsPath } from './gates.js';
import { BATCH_SCHEMA_V3, migrateV2toV3, chainsDefaults, conditionDefaults, handoffsDefaults } from './schema-v3.js';
import * as machine from './machine.js';
import { loadRules } from './machine-rules.js';
import { createArchive } from './archive.js'; // done→archive（complete 钩子）
// 团队资产解析快照写单点（§8③：解析结果落会话级正档 + 批次级指纹引用）——本文件只做**建批侧接线**：
//   解析 + 写档 + 字段/事件载荷的构建全在 lib/assembly/snapshot.js，store 不复制其语义
import * as snapshot from '../assembly/snapshot.js';
import { createCorruptRegistry } from './corrupt-registry.js'; // 损坏批次旁路清单
import { SESSION_RE } from './constants.js'; // 单点（原本文件定义迁出）
import { laneProgressClear, laneProgressWrite } from './resume.js'; // 断点指针：结算终态清退 + 原子写合并（纯函数，本文件落盘）
// longrun 长程豁免授予面定义单点（档位表 + 载荷校验/归一 + 4 个 GATE 错误码 + 白名单）；
// 本文件只做接线：派发面写入 batch.laneExempt + 同次 atomicWrite 落 lane.exempt.* 事件
import { EXEMPT_GATE_CODES, normalizeExemptPayload } from './lane-exempt.js';
// findTask 单点：收敛至 task-utils.js（原本地定义删除）
import { findTask } from './task-utils.js';
import { buildWavePlan, topoWaves } from '../wave-plan.js'; // N1-R4-1c：池内追加任务的归一化 + 分层/环检测（判据与建批期同源）
// 事件 type 常量单点：newEvent 调用 type 一律引用本模块常量（禁止裸字面量）
import * as EVT from './event-types.js';
// 违规计数纯函数（governance/escalation.js，零依赖纯模块——只 import state/event-types.js，
//   无循环依赖：store.js → escalation.js → event-types.js 单向链）。默认计入原语集（DENY/NARROW）亦复用
//   escalation.js 导出常量（单一事实源——config resolve 默认与纯函数签名缺省同源）。
import { countGovernanceRefusals, DEFAULT_ESCALATION_PRIMITIVES } from '../governance/escalation.js';

const STORE_SCHEMA = BATCH_SCHEMA_V3;

// D7（豁免继承/清退留痕）事件名 —— **单点已迁入 `lib/state/event-types.js`**（设计 §5.1「迁入」项；
//   原文案寄居本文件并自述「该文件在本批 writeForbidden 内」，该理由随 `event-types.js` 成为本批写域而失效）。
//   本文件**保留再导出**（R-32 断言再导出值逐字仍在）⇒ 既有导入面零破坏；
//   字面值逐字不变（`lib/watch/lane-heartbeat.js` 的 `exemptClearedAtOf` 按**同一字面量**反查，改值即静默断链）。
export const EVT_LANE_EXEMPT_INHERITED = EVT.EVT_LANE_EXEMPT_INHERITED;
export const EVT_LANE_EXEMPT_CLEARED = EVT.EVT_LANE_EXEMPT_CLEARED;

// ── V-4 写端（e2-gov-repair）：门禁逃生/降级载荷 → 批次事件 ─────────────────────────
// 契约（`plan/spec.md` §5.3 ＋ `plan/techdebt-design.md` §2.1）：
//   ① 门禁只**产载荷**（`{escape:{kind,…}}` / `{escapes:[…]}` / `{degrades:[…]}`）；落盘**唯一**在此写端，
//      且仅出现在**写路径**（`setMember` 的统一 atomicWrite 前）⇒ 只读视图（`gate_status`）绝不发射。
//   ② **fail-closed**：事件常量缺位时**抛明确错误**（`GATE_EVENT_CONST_MISSING`），
//      **绝不**写入 `type: undefined` / 空串（防「语义失名事件」污染审计面）。
//   ③ 载荷键 `escape.type` 属事件名，**不得**占用载荷 `type` 键 ⇒ 白名单式搬运（下方 *_OF 映射）。
const GATE_EVENT_CONST_MISSING = 'GATE_EVENT_CONST_MISSING';
// escape 载荷可透传键（与 e1 逐字同一契约：`{kind,lane,reason?,gate?,path?,artifact?}`）；
//   `type` 显式排除（newEvent 的 `type` 是事件名槽位）。
const ESCAPE_PAYLOAD_KEYS = ['kind', 'lane', 'reason', 'gate', 'path', 'artifact'];
// degrade 载荷可透传键（`{kind,declaredField,effective,layers,lanes,…}`，同样排除 `type`）。
const DEGRADE_PAYLOAD_KEYS = ['kind', 'declaredField', 'effective', 'layers', 'lanes', 'reason'];

// fail-closed 事件类型解析：常量必须是**非空字符串**才允许写盘（单一守卫，供 gate.escape / gate.degrade 共用）。
// 抛出即停手（调用点不落盘）——「缺常量 ⇒ 明确错误」优先于「写一条无名事件」。
function requireEventType(evt, name) {
  const t = evt ? evt[name] : undefined;
  if (typeof t !== 'string' || t.length === 0) {
    throw new Error(GATE_EVENT_CONST_MISSING + ': event type constant "' + name
      + '" is absent/empty in lib/state/event-types.js ⇒ 拒绝写入（fail-closed：不得写 type:undefined；'
      + '请先落常量再由写端发射）');
  }
  return t;
}
// 白名单搬运：只透传上述键中**已存在**的项（缺省不写键，避免 `undefined` 噪音）。
function pickPayload(keys, src) {
  const out = {};
  for (const k of keys) {
    if (src && src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out;
}
// 门禁结果 → 待落事件清单（纯函数，零副作用：不读盘、不写盘 ⇒ 可单测）。
//   来源面（e1 载荷形态）：`res.escape`（单条）/ `res.escapes[]`（多条）/ `res.degrades[]`（降级）。
//   `lane` 缺省由调用方补（门禁未带 lane 时以被结算 lane 为准，保证「每条事件可归因」）。
export function gateEscapeEvents(res, lane) {
  if (!res || typeof res !== 'object') return [];
  const raw = [
    ...(res.escape ? [res.escape] : []),
    ...(Array.isArray(res.escapes) ? res.escapes : []),
  ];
  return raw
    .filter((e) => e && typeof e === 'object' && typeof e.kind === 'string' && e.kind.length > 0)
    .map((e) => ({ payload: { ...pickPayload(ESCAPE_PAYLOAD_KEYS, e), lane: e.lane ?? lane } }));
}
function gateDegradeEvents(res, lane) {
  if (!res || !Array.isArray(res.degrades)) return [];
  return res.degrades
    .filter((d) => d && typeof d === 'object' && typeof d.kind === 'string' && d.kind.length > 0)
    .map((d) => ({ payload: { ...pickPayload(DEGRADE_PAYLOAD_KEYS, d), lane: d.lane ?? lane } }));
}

// ── B2（蓝图 §8⑤ 运行期**首触校验**）：契约缺声明的**待落事件计算**（纯函数，零副作用） ──────────────
// 契约（规格 §1.4 W-4 ＋ §1.1 R-3/R-4/R-5）：
//   ① **非拒态**：只产观察事件——不改任何判定、不改任何 exit code、不新增 `GateErrorCode`
//      （与 gate.escape / gate.degrade 同族的留痕面）；
//   ② 去重键 = `(batchId, gateKind, layer)`——**不含 lane**；「**只报一次/批**」
//      （batchId 维度由「批次 JSON 即该批」天然蕴含：判据取自本批 `batch.events`）；
//   ③ **跨重启幂等**：判据 = `batch.events` 里已存在同键事件 ⇒ 不再发（批次 JSON 是持久事实源，
//      与 `EVT_LANE_LONGRUN_UNCONSUMED` 的 (lane, runningSince) 去重同法）；
//   ④ **只由写路径调用**：本函数只**计算**、不落盘 ⇒ 落盘唯一在 store 写端（`setMember` / `setPhase`），
//      **只读视图（`gate_status` 等）不经本路径**（R-5 硬边界；本函数被只读调用也不产生任何写效果）；
//   ⑤ 载荷键**白名单搬运**：`type` 是 `newEvent` 的事件名槽位，载荷**不得**占用（同 escape/degrade 纪律）。
const CONTRACT_MISSING_PAYLOAD_KEYS = ['cause', 'gateKind', 'layer', 'lane', 'declared', 'source', 'degrade', 'problems'];
export function contractMissingEvents(batch, res, lane) {
  const cm = res && typeof res === 'object' ? res.contractMissing : null;
  if (!cm || typeof cm !== 'object') return [];
  const gateKind = typeof cm.gateKind === 'string' ? cm.gateKind : '';
  if (gateKind.length === 0) return []; // 无 gateKind ⇒ 不可去重、不可归因 ⇒ 不落（fail-safe，不写失名事件）
  const layer = typeof cm.layer === 'string' ? cm.layer : null;
  const key = gateKind + '@' + (layer ?? '-');
  const events = batch && Array.isArray(batch.events) ? batch.events : [];
  for (const e of events) {
    if (!e || e.type !== EVT.EVT_GATE_CONTRACT_MISSING) continue;
    if (String(e.gateKind ?? '') + '@' + (e.layer ?? '-') === key) return []; // 同键已留痕 ⇒ 不再发（跨重启幂等）
  }
  return [{
    payload: {
      ...pickPayload(CONTRACT_MISSING_PAYLOAD_KEYS, cm),
      cause: typeof cm.cause === 'string' ? cm.cause : 'undeclared',
      gateKind,
      layer,
      lane: cm.lane ?? lane ?? null,
      declared: cm.declared === true,
      problems: Array.isArray(cm.problems) ? [...cm.problems] : [],
    },
  }];
}

// 事件类型解析（**注入式**，默认取单点常量表 `lib/state/event-types.js`）：
//   写端在**每次落盘前**解析常量 ⇒ 缺位即抛（fail-closed）。`evt` 参数为生产零改动前提下的
//   可注入缝（缺省 = EVT namespace import，逐字同源）、供探针以「人为缺常量」实测守卫行为。
function resolveGateEventTypes(evt = EVT) {
  return {
    escape: requireEventType(evt, 'EVT_GATE_ESCAPE'),
    degrade: requireEventType(evt, 'EVT_GATE_DEGRADE'),
    // B2（§8⑤）：契约缺声明首触留痕——与 escape/degrade 同一 fail-closed 守卫（缺位即抛，绝不写失名事件）。
    contractMissing: requireEventType(evt, 'EVT_GATE_CONTRACT_MISSING'),
  };
}
function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // Windows: MoveFileEx REPLACE_EXISTING
}

// C 子项：连续失败升级（spec C）——计数纯函数（顶层导出，供单测）：
// 从事件流末尾向前扫描，统计连续 member.settled 且 to === 'failed' 的事件数（含本次刚 push 的结算）；
// 遇 member.settled 但 to !== 'failed'（merged/conflict/skipped/review/running 等）即停止（归零语义 C-计数）；
// 非 member.settled 事件（worktree.checkpoint / batch.phase / gate.* 等）不打断计数。
export function countConsecutiveFailedSettles(events) {
  const evs = events ?? [];
  let count = 0;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (!e || e.type !== EVT.EVT_MEMBER_SETTLED) continue;
    if (e.to === 'failed') count++;
    else break;
  }
  return count;
}

export function createStore(root, { rules, logger, onStateChange, readConfig } = {}) {
  const sessionsDir = path.join(root, 'sessions');
  const legacyDir = path.join(root, 'batches');
  // 门禁侧的**热配置读取器**（`task-27`）：装配点可注入（与工具面 `deps.readConfig` 同源）；
  //   未注入 ⇒ 门禁闭包回落 `lib/hot/config-watch.js` 的模块级生效快照（`createGates` 内处理）。
  //   本文件**只传递**，不解析门开关、不读 env（门顺序与既有语义一字不动）。
  const gates = createGates(root, typeof readConfig === 'function' ? { readConfig } : {});
  // 损坏批次旁路清单：与 governance.json 同层；批次 JSON 结构零变更
  const corruptRegistry = createCorruptRegistry(root);
  // 留痕日志（可选注入；缺省 console——与 index.js ctx.logger 解耦，保持 createStore 既有调用点零改动）
  const log = logger ?? console;
  // 棘轮规则表（createStore(root, { rules }) 注入 loadRules 产物；未注入 = 默认规则 = schema 常量同引用，行为不变）
  // **接线已落地（A-①）**：装配点 `lib/index.js:108-112` 传 `rules: loadRules(config)`（**整份 config**
  //   ⇒ loadRules 内部自取 `config.ratchet`，machine-rules.js:78）⇒ 生产链路可达，`config.ratchet` 不再是死配置。
  //   本行形态**保持** `rules ?? loadRules()` 不变：无参兜底只服务「不传 rules 的调用方」（工具/测试直建 store），
  //   其返回与注入默认表**同引用**（machine-rules.js:82-84）⇒ 缺省零差异。
  const ratchet = rules ?? loadRules();
  // 归档器装配（createStore 签名不变；归档目标 = <root>/sessions/<sid>/archive/<bid>/）
  const archive = createArchive(root);

  function sessionDir(sessionId) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionsDir, sessionId);
  }
  function batchesDirOf(sessionId) {
    return path.join(sessionDir(sessionId), 'batches');
  }
  function artifactsDirOf(sessionId, batchId) {
    return path.join(sessionDir(sessionId), 'artifacts', batchId);
  }
  // condition 校验的 fileExists DI（machine 纯逻辑，路径解析在本侧）——相对路径解析到批次产物根，绝对路径直接用；存在性判定（existsSync）
  function conditionFileExists(sessionId, batchId) {
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    return (p) => fs.existsSync(isAbsPath(p) ? p : path.join(artifactsDir, p));
  }

  // 存量迁移：root/batches/*.json -> sessions/legacy/batches/（一次，幂等）
  function migrateLegacy() {
    if (!fs.existsSync(legacyDir)) return 0;
    let moved = 0;
    for (const f of fs.readdirSync(legacyDir)) {
      if (!f.endsWith('.json')) continue;
      const dst = path.join(batchesDirOf('legacy'), f);
      fs.mkdirSync(batchesDirOf('legacy'), { recursive: true });
      fs.renameSync(path.join(legacyDir, f), dst);
      moved++;
    }
    try { fs.rmdirSync(legacyDir); } catch {}
    return moved;
  }

  function batchFile(sessionId, batchId) {
    if (!SESSION_RE.test(batchId)) throw new Error('invalid batchId');
    return path.join(batchesDirOf(sessionId), batchId + '.json');
  }

  function newEvent(type, fields = {}) {
    return { ts: new Date().toISOString(), type, ...fields };
  }

  // 状态事件发布钩子（topic 接线）：setMember/setPhase 调用点埋点——
  // appendEvent 为闭包内部函数，外部 wrap 该导出属性无法拦截内部迁移（调用点埋点固化），
  // 故必须在调用点埋。onStateChange 缺省未装配（topic 默认关）→ 零行为变化；
  // 异常隔离（发布失败不阻断状态机）。载荷为纯数据摘要，topic 命名由装配侧（topic-runtime）负责。
  function emitStateChange(ev) {
    try { onStateChange?.(ev); } catch { /* 隔离：topic 发布失败不阻断状态机 */ }
  }

  // ── B2（§8⑤）写端发射器：契约缺声明**首触留痕**（`setMember` / `setPhase` 共用同一实现，杜绝第二套语义）──
  //   与 `gatePayloads`（escape/degrade 统一收集器）的**唯一差异 = 时序**：本类事件按 `(gateKind, layer)`
  //   去重，故**即时 push**——push 后再评估去重，同一次迁移内的第二次触达自然被拦（规格 §1.6 风险表第 2 行）。
  //   fail-closed：事件类型在**此刻**经 `resolveGateEventTypes()` 解析，常量缺位即抛（原子写尚未执行 ⇒ 不落盘）。
  //   告警与事件**同源一次**（U-3）：每条事件恰好一条 `logger.warn`，不得「有事件无告警」或反之。
  //   只写路径：本发射器只在 `setMember` / `setPhase` 内被构造使用；只读视图不持有它（R-5 可核）。
  function makeContractMissingSink(getBatch, getLane) {
    return (res) => {
      const batch = getBatch();
      const items = contractMissingEvents(batch, res, getLane());
      if (items.length === 0) return 0;
      const type = resolveGateEventTypes().contractMissing;
      for (const item of items) {
        batch.events.push(newEvent(type, item.payload));
        log.warn?.('[dsh-punky-swarm] gate.contract_missing: ' + item.payload.gateKind + '@' + (item.payload.layer ?? '-')
          + '(lane=' + String(item.payload.lane ?? '-') + ') —— 团队资产未声明该检查项 ⇒ 引擎缺省接管；'
          + '首触留痕，只报一次/批（degrade=' + String(item.payload.degrade?.kind ?? '-') + '）');
      }
      return items.length;
    };
  }

  // 团队资产解析快照（§8③，批次 `a3-snapshot-b1-20260915`）：**建批侧**写档单点（`lib/assembly/snapshot.js`）——
  //   · 档 = 会话级派生观察档（`<sessionDir>/team-assets/<team>.<hash>.json`），**不参与任何门禁判定**；
  //   · 时点 = 本事务内（档先于批次落盘），与批次字段/事件同一次 atomicWrite ⇒ 无「批已存在、解析记录还没写」的中间态；
  //   · **不得**把写盘挂到 `resolveTeamFlows`（读端）：`gate_status`/面板/20+ 判定点的共同取数入口不得成写者；
  //   · 无资产 ⇒ 只写 `ok:false` 字段（不写档、不落事件）；写档失败 ⇒ 告警 + 字段/事件双留痕，**不拒建批**。
  function teamAssetRefFor(sessionId, team, teamsRoot) {
    try {
      return snapshot.teamAssetRefOf({ sessionDirAbs: sessionDir(sessionId), team, teamsRoot: teamsRoot ?? null });
    } catch (error) {
      // 防御：快照面任何意外都不得阻断建批（观察面故障 ≠ 治理面拒态）
      return {
        field: { team: team ?? null, snapshotWriteFailed: true, ok: false },
        event: null,
        snapshotPath: null,
        warning: '[dsh-punky-swarm] team-asset snapshot skipped: ' + String(error && error.message),
      };
    }
  }

  // C+ 档装配声明（assembly，batch JSON 顶层可选字段）：缺省 undefined → 不写键（仿 laneProgress 零噪音模式，
  // schema 不升、旧批无键读取兼容零迁移——C+ 门禁归一化产物随建批持久化，供运行期/审计按需消费）
  // 【2026-09-18 · Q-B 取消并发闸】形参 `concurrency`（缺省 5）与下方落盘位**逐字不变**（纯声明 + 回显）：
  //   引擎内**不再有任何分支读它做准入**（原唯一执行点 = `lib/engine/dispatch.js` 的并发闸，已随 Q-B 删除）；
  //   保留字段的判据 = 既有批次 JSON 读取 / 面板数字 / `batch_status` 回显 / 既有测试断言逐字不变。
  function createBatch(sessionId, { batchId, wavePlan, concurrency = 5, phase = 'planning', assembly, teamsRoot }) {
    schema.assertBatchPhase(phase);
    const file = batchFile(sessionId, batchId);
    if (fs.existsSync(file)) throw new Error('batch already exists: ' + batchId);
    const lanes = {};
    for (const w of wavePlan.wavePlan) {
      for (const t of w.tasks) lanes[t.id] = 'pending';
    }
    // P1（2026-09-16，D-3）：`?? 'generic'` 兜底已清退——建批面 `team` 必填（`lib/tools/core.js` 构造期拒），
    //   此处再回落 `'generic'` 会成**第二个默认值真源**（历史批自带 `team:'generic'` 字段，读取侧零迁移）。
    const team = wavePlan.team;
    const ta = teamAssetRefFor(sessionId, team, teamsRoot);
    if (ta.warning) log.warn?.(ta.warning);
    const batch = {
      schema: STORE_SCHEMA,
      sessionId,
      batchId,
      phase,
      concurrency,
      team,
      wavePlan: wavePlan.wavePlan,
      lanes,
      chains: chainsDefaults(), // 环防护记账状态（v3 字段，唯一事实源）
      // P1 交接门（handoff gate）：**新建批恒写** `handoffs`（空对象 = 该批无 deps ⇒ 未交接门恒放行）。
      //   字段**存在性**即「本批受新门约束」的判据（裁决 ①=B：存量批无本键 ⇒ 放行 + `lane.handoff.gap` 告警）。
      //   建批期意图声明（裁决 ②=A 的判据来源）= 下方按 `task.deps` 逐边种一条 `status:'pending'` 交接。
      handoffs: handoffsDefaults(),
      archived: false, // 单向归档标记（v3 可选字段，缺省 false；complete 归档后置 true）
      ...(assembly !== undefined ? { assembly } : {}), // 装配声明（C+ 归一化 decl）；未声明不写键（旧批/非 C+ 批零噪音）
      // 会话级临时团队资产根（显式给出时才写键）：门禁读端据此解析该团队的 `flows` 声明
      // （否则 flows 只按包根解析 → 临时团队的 entry_requires/contract/needhuman/complete 不生效）
      ...(teamsRoot ? { teamsRoot } : {}),
      // §8③ 团队资产解析冻结的**指纹引用**（不复制资产正文、不复制完整 summary；旧批无本键 = 读取兼容零迁移）
      teamAsset: ta.field,
      events: [
        newEvent(EVT.EVT_BATCH_CREATED, { batchId, sessionId }),
        // 解析冻结事件：与批次字段同一次 atomicWrite（无资产 ⇒ ta.event 为 null ⇒ 不落本事件）
        ...(ta.event ? [newEvent(EVT.EVT_BATCH_TEAM_ASSET_RESOLVED, ta.event)] : []),
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // P1 交接门：按 `task.deps` 的**每条入边**种一条 `pending` 交接（建批期意图声明 = 裁决 ②=A 的判据来源）。
    //   语义：下游 lane 一旦声明 deps，就在黑板（本批 handoffs）留下「我期望上游 X 交接过来」的**机器可判事实**；
    //   上游未提交（status 仍 pending）/产物不在场/契约不合规 ⇒ entry 门拒 `GATE_HANDOFF_MISSING`（缺哪条边、缺哪件产物）。
    //   此为**纯数据种入**（不写事件、不派发、不改任何成员态）——事件面只在 `recordHandoff`（真实交接）与拒态留痕发生。
    for (const w of batch.wavePlan ?? []) {
      for (const t of w.tasks ?? []) {
        if (!t || typeof t.id !== 'string') continue;
        const deps = Array.isArray(t.deps) ? t.deps.filter((d) => typeof d === 'string' && d.length > 0) : [];
        if (deps.length === 0) continue;
        const list = [];
        for (const from of deps) {
          list.push({
            from, to: t.id, batch: batchId, step: null,
            artifacts: [], contract: { consumedFrom: from, assertions: [] },
            status: 'pending', ts: batch.createdAt, officialTaskId: null,
          });
        }
        batch.handoffs[t.id] = list;
      }
    }
    atomicWrite(file, batch);
    return batch;
  }

  // ── N1-R4-1c：池内追加任务（**图变更的唯一写入口**）─────────────────────────────
  // 纪律（K1 + 2026-09-21 13:3x 用户裁定）：
  //   ① 只**增**不改：既有任务（含未派发的）一概不动——「已派发即冻结」，且本接口不提供改任务语义。
  //   ② **不新建拒码**（迁移门禁再议）⇒ 非法输入抛**普通 Error**（不带 `GATE_` 前缀，不进 66 码集合）；
  //      唯一例外 = 批终态，复用既有 `GATE_BATCH_TERMINAL`。
  //   ③ 单次 `atomicWrite`：wavePlan 重归一化 + lanes 播种 + handoffs 播种 + `plan.mutated` 留痕同一次落盘。
  //   ④ 判据与建批期**同源**：归一化走 `buildWavePlan`、分层/环检测走 `topoWaves`（不另写一份判据）。
  function addPoolTasks(sessionId, batchId, incoming, { reason = null, author = null } = {}) {
    const file = batchFile(sessionId, batchId);
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId + ' @' + sessionId);
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); task append rejected');
    }
    const list = Array.isArray(incoming) ? incoming : [];
    if (list.length === 0) throw new Error('task append rejected: tasks 为空（须至少给出一条）');
    const existing = new Set(Object.keys(batch.lanes ?? {}));
    const ids = [];
    for (const t of list) {
      const id = t && typeof t.id === 'string' ? t.id.trim() : '';
      if (!id) throw new Error('task append rejected: 任务 id 须为非空字符串（实际=' + JSON.stringify(t?.id ?? null) + '）');
      if (existing.has(id)) throw new Error('task append rejected: 任务 id 已存在 ⇒ ' + id + '（本接口只增不改）');
      if (ids.includes(id)) throw new Error('task append rejected: 本次追加内 id 重复 ⇒ ' + id);
      ids.push(id);
    }
    const baseTasks = (batch.wavePlan ?? []).flatMap((w) => (Array.isArray(w?.tasks) ? w.tasks : []));
    const merged = [...baseTasks, ...list.map((t) => ({ ...t, id: String(t.id).trim() }))];
    // 环检测（判据同源 = `topoWaves`）：成环/悬空引用时它无法分层 ⇒ 前置拦截并给出可读提示（不静默）。
    try {
      // 注：`topoWaves` 返回 `{ waves, order }`（**不是数组**）；成环/悬空引用由它自抛（'cycle detected' / 'unknown id'）。
      const res = topoWaves(merged);
      if (!res || !Array.isArray(res.waves) || res.waves.length === 0) throw new Error('topoWaves 返回空');
    } catch (e) {
      throw new Error('task append rejected: 合并后的任务图不可分层（deps 成环或引用悬空）⇒ '
        + ids.join(', ') + '（' + String(e?.message ?? e) + '）');
    }
    const plan = buildWavePlan({
      batchId, tasks: merged, team: batch.team, concurrency: batch.concurrency ?? 5,
    });
    const lanes = { ...batch.lanes };
    const handoffs = { ...(batch.handoffs ?? {}) };
    const ts = new Date().toISOString();
    for (const t of list) {
      const id = String(t.id).trim();
      lanes[id] = 'pending';
      const deps = Array.isArray(t.deps) ? t.deps.filter((d) => typeof d === 'string' && d.length > 0) : [];
      if (deps.length === 0) continue;
      handoffs[id] = deps.map((from) => ({
        from, to: id, batch: batchId, step: null,
        artifacts: [], contract: { consumedFrom: from, assertions: [] },
        status: 'pending', ts, officialTaskId: null,
      }));
    }
    const revision = (batch.planRevision ?? 0) + 1;
    const next = {
      ...batch,
      wavePlan: plan.wavePlan,
      lanes,
      handoffs,
      planRevision: revision,
      updatedAt: ts,
      events: [...(batch.events ?? []), newEvent(EVT.EVT_PLAN_MUTATED, {
        added: ids, reason: reason ?? null, author: author ?? null, revision,
      })],
    };
    atomicWrite(file, next);
    return next;
  }

  // 三态读取基础函数（readBatch 的语义来源，纯读取无副作用）：
  //   { status:'ok', batch } | { status:'missing' } | { status:'corrupt', error }
  function readBatchResult(sessionId, batchId) {
    const file = batchFile(sessionId, batchId);
    if (!fs.existsSync(file)) return { status: 'missing' };
    try {
      return { status: 'ok', batch: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      return { status: 'corrupt', error: err };
    }
  }

  function readBatch(sessionId, batchId) {
    const res = readBatchResult(sessionId, batchId);
    if (res.status === 'corrupt') {
      // 损坏隔离（②，P0，D-001）：幂等登记旁路清单；仅首次登记时 warn 留痕（INV-2 不重复刷日志）；
      // 损坏与不存在共用 null 返回值——需区分语义的调用方走 isCorrupt() 二次查询
      const r = corruptRegistry.markBatchCorrupt(sessionId, batchId, res.error);
      if (r.first) {
        log.warn?.('[dsh-punky-swarm] corrupt batch isolated: ' + sessionId + '/' + batchId
          + ' (' + ((res.error && res.error.message) || res.error) + ')；已登记 corrupt-batches.json，'
          + '修复/删除文件后经 clearCorruptMark 清除标记');
      }
      return null;
    }
    return res.batch; // ok → batch；missing → undefined（调用点按 null 语义处理）
  }

  // 区分「损坏」与「不存在」（readBatch 两者均返回 null）
  function isCorrupt(sessionId, batchId) {
    return corruptRegistry.isCorrupt(sessionId, batchId);
  }

  function listBatches(sessionId) {
    const dir = batchesDirOf(sessionId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  function listSessions() {
    if (!fs.existsSync(sessionsDir)) return [];
    return fs.readdirSync(sessionsDir)
      .filter((s) => SESSION_RE.test(s) && fs.existsSync(batchesDirOf(s)) && fs.readdirSync(batchesDirOf(s)).some((f) => f.endsWith('.json')))
      .sort();
  }

  // 升级写公共内联函数——failed-escalate 与 governance-escalate 双源复用（写路径同构，
  // 杜绝第二套暂停语义）。只做「paused 迁移 + 两事件同批追加」（不写盘），落盘由调用点统一 atomicWrite
  // （保持单次原子写：paused + batch.phase + 源事件同批落盘，不调 setPhase 二次写防竞态）；
  // 状态事件发布亦由调用点统一触发（事件载荷 reason 区分双源）。
  // 棘轮校验（machine.applyBatchTransition running→paused bv.ok）在调用点完成——本函数不重复校验。
  function escalatePausedWrite(batch, { reason, eventType, fields }) {
    batch.phase = 'paused';
    batch.events.push(newEvent(EVT.EVT_BATCH_PHASE, { from: 'running', to: 'paused', reason }));
    batch.events.push(newEvent(eventType, fields));
  }

  // 违规计数记录 + 窗口评估 + 达阈值升级（批事件流单一事实源，原子写）。
  //   入参 escalation = 装配侧 resolve 产物（{enabled, threshold, windowMs, primitives}）；调用方（桥接/
  //   测试）负责归属后传入本方法。防御纵深（与计入过滤同标准，方法内重复守卫——桥接过滤
  //   遗漏不误计不误升级）：enabled!==true → 零记录零升级（关态零路径）；ruleRefs 空（状态门收据）
  //   → 零记录零升级（全排除）；primitive ∉ primitives → 零记录零升级（DEFER/PAUSE/类别外默认不计）。
  //   升级执行：escalation.enabled ∧ phase==='running' → countGovernanceRefusals 窗口计数 ≥
  //   threshold ∧ 棘轮 bv.ok → 公共函数 escalatePausedWrite（reason='governance-escalate' + 载荷事件）；
  //   单次原子写（记录与升级同批落盘，不调 setPhase 二次写）；paused 后 phase 闸自然挡重复；
  //   埋点：升级伴随 emitStateChange batch.phase（reason='governance-escalate'，与 failed-escalate 对称）。
  //   观察者纪律：失败（批次缺失等）上抛由调用方 catch warn 隔离；本方法为同步段无 await。
  //   返回 batch（含可能升级后的最新形态）；未升级 = 仅追加 governance.refusal 记录。
  function recordGovernanceRefusal(sessionId, batchId, { lane, receiptId, primitive, ruleRefs, tool, escalation = {} } = {}) {
    // 防御守卫：enabled 关态 / 状态门收据（ruleRefs=[]）/ primitive 不在计入集 → 零事件零升级
    if (escalation.enabled !== true) return null; // 不误调不误记（T20：enabled=false 批事件流零 governance.refusal）
    if (!Array.isArray(ruleRefs) || ruleRefs.length === 0) return null; // 状态门收据永不计数（T12）
    const primSet = new Set(escalation.primitives ?? DEFAULT_ESCALATION_PRIMITIVES);
    if (!primSet.has(primitive)) return null; // DEFER/PAUSE/REQUIRE_APPROVAL 等默认不计（T12）
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    // 可计入收据 → 批事件流追加 governance.refusal（ts 由 newEvent 基座携带）
    batch.events.push(newEvent(EVT.EVT_GOVERNANCE_REFUSAL, { lane, receiptId, primitive, ruleRefs, tool }));
    // 仅 phase==='running' 时评估；paused/planning 等 phase 只记录不升级
    let escalated = false;
    if (batch.phase === 'running') {
      const now = Date.now();
      const count = countGovernanceRefusals(batch.events, {
        windowMs: escalation.windowMs,
        primitives: escalation.primitives,
        now,
      });
      if (count >= (escalation.threshold ?? 3)) {
        const bv = machine.applyBatchTransition('running', 'paused', { rules: ratchet });
        if (bv.ok) {
          // 尾窗收据摘要（升级载荷 receiptIds 供审计回查）：窗口内可计入 refusal 的 receiptId 清单
          const receiptIds = [];
          for (const e of batch.events) {
            if (!e || e.type !== EVT.EVT_GOVERNANCE_REFUSAL) continue;
            if (e.receiptId === undefined || e.receiptId === null) continue; // 兼容缺 receiptId 记录（不摘要）
            const tsMs = typeof e.ts === 'number' ? e.ts : Date.parse(String(e.ts ?? ''));
            if (Number.isNaN(tsMs)) continue;
            if (now - tsMs > escalation.windowMs) continue; // 窗口外不计入摘要（与计数窗口同界）
            receiptIds.push(e.receiptId);
          }
          escalatePausedWrite(batch, {
            reason: 'governance-escalate',
            eventType: EVT.EVT_BATCH_GOVERNANCE_ESCALATE,
            fields: { count, windowMs: escalation.windowMs, lane, receiptIds },
          });
          escalated = true;
        }
      }
    }
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    if (escalated) {
      emitStateChange({ type: 'batch.phase', sessionId, batchId, from: 'running', to: 'paused', reason: 'governance-escalate' });
    }
    return batch;
  }

  // longrun 长程豁免：撤销唯一入口（显式调用，不改成员状态）。
  // 与 setMember **互斥**（工具层已保证两者不得并用：revokeExempt 携带 status → GATE_EXEMPT_NOT_DISPATCH）；
  // 契约：`laneExempt` 无该 lane → 拒 GATE_EXEMPT_REVOKE_REQUIRED（撤销只能由显式调用产生，不可隐式产生）；
  // 成功 → 删条目（表空则整键删除，保持「无值不写键」）+ 同一次 atomicWrite 追加 lane.exempt.revoked。
  function revokeLaneExempt(sessionId, batchId, lane) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    const grant = batch.laneExempt?.[lane];
    if (!grant) {
      throw new Error(EXEMPT_GATE_CODES.REVOKE_REQUIRED
        + ': lane ' + lane + ' 无既有豁免（撤销须显式调用，且仅对已授予豁免的 lane 有效；无豁免可撤 → 不产生任何写入）');
    }
    const next = { ...batch.laneExempt };
    delete next[lane];
    // 表空 → 整键删除（不在批次 JSON 留下空对象噪音，旧批/非豁免批形态保持一致）
    if (Object.keys(next).length === 0) delete batch.laneExempt;
    else batch.laneExempt = next;
    const revokedAt = new Date().toISOString();
    batch.events.push(newEvent(EVT.EVT_LANE_EXEMPT_REVOKED, {
      lane,
      exemptType: grant.type,
      multiplier: grant.multiplier,
      at: revokedAt,
      grantedAt: grant.grantedAt,
    }));
    // D7 次选留痕（与 revoked **同一事实、同一时刻、同一次写盘**）：显式撤销 = 「清退」的动作面，
    //   revoked 记「谁做的动作」、cleared 记「清退这一状态变化」——读端 `exemptClearedAtOf`（e1 探针）
    //   据此把清退时间透出为 `exemptClearedAt`，使「撤销后重新计时」可见。
    //   两者**不合并**：revoked 是豁免撤销的专用事件（既有读端），cleared 是通用清退留痕（含 D7 次选语义）。
    batch.events.push(newEvent(EVT_LANE_EXEMPT_CLEARED, { lane, clearedAt: revokedAt, reason: 'explicit-revoke' }));
    batch.laneExemptCleared = { ...(batch.laneExemptCleared ?? {}), [lane]: revokedAt };
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return batch;
  }

  // longrun 豁免清退（纯函数，返回新 batch）：豁免是「本次派发」的属性，不是 lane 的长期属性。
  // 调用点：① 结算终态（批次归档前清理）② 显式撤销后的兜底清退。**默认仍静默**
  //   （不产 lane.exempt.revoked——该事件专表「Leader 显式撤销」；读端以最近一次 lane.exempt.granted 为准判读）。
  // D7（2026-09-14）：`clearedAt` 给出时**改为留痕清退**——写 `batch.laneExemptCleared[lane]`（批量级时间戳）
  //   + 字面量事件 `lane.exempt.cleared`（payload `{lane, clearedAt, from}`），使「清退事实」在探针读端可见
  //   （`lib/watch/lane-heartbeat.js:325-337` `exemptClearedAtOf` 的两个通道），把旧口径下「静默清退 ⇒
  //   长任务恢复后重新变成长跑候选（误报）」变成**可见的重新计时**。
  //   事件名走**字面量**（`lib/state/event-types.js` 本批无写者，禁越域新增常量；e1 同款处置见其 §6）。
  //   清退**只改「清退事实」字段 + 事件**，不产 reason 码（G-5 裁定见 exec/manager-binding-impl.md §5：
  //   `reason` 恒由 state 判据给出，D2「reason 必须与 state 对齐」优先于 §6.2 次选的 `reason='exempt-cleared'`）。
  function laneExemptClear(batch, lane, clearedAt = null) {
    if (!batch?.laneExempt?.[lane]) return batch;
    const next = { ...batch.laneExempt };
    delete next[lane];
    if (Object.keys(next).length === 0) delete batch.laneExempt;
    else batch.laneExempt = next;
    if (clearedAt) {
      batch.laneExemptCleared = { ...(batch.laneExemptCleared ?? {}), [lane]: clearedAt };
      batch.events.push(newEvent(EVT_LANE_EXEMPT_CLEARED, { lane, clearedAt }));
    }
    return batch;
  }

  function setMember(sessionId, batchId, lane, to, note = null, exempt = undefined, owner = undefined) {
    let batch = readBatch(sessionId, batchId); // 终态清退经 laneProgressClear 返回新 batch（不突变入参）
    if (!batch) throw new Error('batch not found: ' + batchId);
    // 终态批次冻结：complete / aborted 之后不再接受任何成员迁移（防「已收口批次仍被改写成 running」的治理自相矛盾）
    if (schema.isBatchTerminal(batch.phase)) {
      throw new Error('GATE_BATCH_TERMINAL: batch ' + batchId + ' is ' + batch.phase + ' (terminal); member transition rejected');
    }
    schema.assertMemberState(to);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    // 豁免参数面强校验（R-5）：exempt 只能在「派发面」（to==='running'）出现——
    // 出现（含 null）且 to!=='running' → 拒 GATE_EXEMPT_NOT_DISPATCH（状态与批次 JSON 均不变，无写入）。
    // 置位在既有迁移校验之前：豁免是**参数面非法**（与 invalid member transition 同族、直接 throw、无门禁载荷可留），
    // 优先判定可让「非法迁移 + 非法豁免参数」的调用得到语义明确的豁免错误码。
    if (exempt !== undefined && to !== 'running') {
      throw new Error(EXEMPT_GATE_CODES.NOT_DISPATCH
        + ': exempt 仅允许出现在派发面（to=running），当前 to=' + to + '（豁免只能在派发时附带授予）');
    }
    const from = batch.lanes[lane];
    // Q3-A①（Leader 附则，本批 e2 落地）：`review` 结算到 failed / skipped / conflict 三态**必须**带非空 note。
    //   语义：失败/跳过/冲突是「决策面」终态，缺理由 ⇒ 后来者无法复盘（零留痕的失败）。
    //   边界（逐字）：① **只**约束 `from === 'review'`（`pending`/`running`→failed 为既有语义，不动）；
    //   ② **只**约束 failed/skipped/conflict —— `merged` **不得**加同一要求（其已有 Exit/Targets/Command/needHuman 四门）；
    //   ③ 拒 = **零写入**（在既有豁免参数面检查之后、迁移校验之前抛出：不落盘、不改 batch、不产事件）。
    //   拒码：`GATE_SETTLE_NOTE_MISSING`（新引入，本批唯一新增拒绝码）。
    const SETTLE_NOTE_REQUIRED = ['failed', 'skipped', 'conflict'];
    if (from === 'review' && SETTLE_NOTE_REQUIRED.includes(to)) {
      const reason = typeof note === 'string' ? note.trim() : '';
      if (reason.length === 0) {
        throw new Error('GATE_SETTLE_NOTE_MISSING: review -> ' + to + ' 必须携带非空 note（失败/跳过/冲突的理由，供审计复盘）；'
          + '实测 note=' + JSON.stringify(note ?? null) + ' ⇒ 拒结算（零写入）。'
          + '注：`merged` 不受本要求约束（其已由 Exit/Targets/Command/needHuman 四门把关）。');
      }
    }
    // 豁免授予载荷（归一后；null = 本次调用无授予意图）。声明在函数作用域：entry 门禁分支内赋值、
    // 统一写盘点消费（entry 门禁失败会提前 throw/return，不会带着未授予的载荷走到写盘）。
    let exemptGrant = null;
    // V-4 写端收集器（本批 e2）：门禁**放行/降级**路径的 escape/degrade 载荷在此汇聚，
    //   统一在下方「统一写盘点」（member.settled 之前、同一次 atomicWrite）落盘 ⇒ 单次原子写、零重复。
    //   收集项形如 {type:'escape'|'degrade', res}——真正的常量解析延后到落盘前（fail-closed 语义最紧）。
    const gatePayloads = [];
    const collect = (kind, res) => { if (res) gatePayloads.push({ kind, res }); };
    // B2（§8⑤）首触留痕发射器（**即时 push**，与上方延迟收集器并存：两者互不影响既有事件面）
    const emitContractMissing = makeContractMissingSink(() => batch, () => lane);
    // 迁移判定走 machine（rules 可注入；默认规则与 schema 常量同引用，行为不变）
    const mv = machine.applyMemberTransition(from, to, { rules: ratchet });
    // D-4（2026-09-16 清债）：状态机保持严格（非法迁移仍拒），但**报错必须自带下一步**——
    //   活体实测高频踩点：`running -> merged/skipped` 被拒（结算前须先经 review）。
    //   把可用路径与下一步调用样例写在同一条错误里，省掉 Leader「猜一步再试」的往返。
    //   （合法迁移表 = MEMBER_TRANSITIONS；此处提示的是最常见的 review 中转，不改变判定。）
    const d4Hint = (from === 'running' && (to === 'merged' || to === 'skipped'))
      ? ' ⇒ 下一步：先 `member_status({ batchId, lane, status: "review" })` 置 review，再 `member_settle({ batchId, lane, status: "' + to + '" })`'
        + '（`running -> ' + to + '` 不在迁移表内；review 为合并/跳过的唯一中转）'
      : '';
    if (!mv.ok) throw new Error('invalid member transition: ' + from + ' -> ' + to + d4Hint);
    // Tier3 门禁：派发（condition + entry）与结算（exit/Plan 契约）+ needHuman（review 挂起检测 / merged 人工裁决闸）
    if (to === 'running') {
      // 派发前条件校验（lane.condition 静态声明，DI fileExists）——不满足 → 不派发、自动落 skipped（既有终态迁移）+ lane.skipped 事件；wavePlan 不动不重算
      const cond = machine.checkDispatchCondition(sessionId, batchId, batch, lane, { fileExists: conditionFileExists(sessionId, batchId) });
      if (!cond.ok) {
        // 落 skipped 同样过棘轮表（fail-closed 优先：收紧配置删掉 from→skipped 时拒绝自动跳过，不绕过规则表）
        const skip = machine.applyMemberTransition(from, 'skipped', { rules: ratchet });
        if (!skip.ok) {
          throw new Error('invalid member transition: ' + from + ' -> skipped (condition unmet: ' + cond.missing.join(', ') + '; ratchet forbids auto-skip)');
        }
        // condition 自动 skipped 亦为结算终态——清退 laneProgress 断点指针（不残留脏指针）
        batch = laneProgressClear(batch, lane);
        batch.lanes[lane] = 'skipped'; // pending→skipped 既有合法迁移
        batch.events.push(newEvent(EVT.EVT_LANE_SKIPPED, { lane, from, note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.events.push(newEvent(EVT.EVT_MEMBER_SETTLED, { lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        // R2 调用点埋点：condition 自动 skipped 亦为结算终态（member.settled 事件发布）
        emitStateChange({ type: 'member.settled', sessionId, batchId, lane, from, to: 'skipped', note: 'condition unmet: ' + cond.missing.join(', ') });
        return batch;
      }
      const g = gates.checkEntryGate(sessionId, batchId, batch, lane);
      // V-4 写端（e2）：entry 门的**放行侧**逃生载荷（standalone / idle-recovery-passthrough）落盘。
      //   拒侧（g.ok===false）无 escape 载荷（其留痕走下方既有 GATE_ENTRY_MISSING 事件）⇒ 天然不重复。
      if (g.ok) collect('escape', g);
      emitContractMissing(g); // B2（§8⑤ P-1 entry_requires）：放行/降级侧采集体 = 门禁返回值（拒侧不采）
      if (!g.ok) {
        // 载荷兼容：GATE_ENTRY_MISSING 用 `missing`；GATE_AUDIT_CRITERIA_MISSING（P1）等用 `problems`。
        //   **取非空者**：旧写法 `g.missing ?? g.problems` 在「missing 存在但为空数组 + problems 有内容」时会吞掉 problems
        //   ⇒ 抛错文案只剩码字、丢掉可执行提示（历史实机复验：留痕事件里 problems 是全的，但工具抛错无细节）。
        //   改后取非空者，两类门禁的抛错都带回提示。注：本条注释原引用的 GATE_MANAGER_NOT_RAISED 已随
        //   gate-lite 第二批 A 项删除（该门整体移除），提示取非空者这一**机制**保留不变。
        const detail = (g.missing && g.missing.length) ? g.missing : (g.problems ?? []);
        // P1 交接门拒态（2026-09-17）：码 = `GATE_HANDOFF_MISSING`（裁决 ④=A 新造独立码）⇒ 落**专用**缺口事件
        //   `lane.handoff.gap`（含**缺哪条边 / 缺哪件产物**，即 `missing[]`），**不再**复用 `gate.entry.missing`
        //   （语义独立、审计可辨：交接 ≠ consume 在场）。其余 entry 拒码（GATE_ENTRY_MISSING / STANDALONE_* /
        //   AUDIT_*）走原路径**逐字不变**。
        if (g.code === 'GATE_HANDOFF_MISSING') {
          batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, { lane, code: g.code, missing: g.missing ?? [], ...(g.problems ? { problems: g.problems } : {}) }));
        } else {
          batch.events.push(newEvent(EVT.EVT_GATE_ENTRY_MISSING, { lane, missing: g.missing ?? [], ...(g.problems ? { problems: g.problems } : {}) }));
        }
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + (detail.length ? ': ' + detail.join(', ') : ''));
      }
      // P1 存量批放行留痕（裁决 ①=B：**不静默、不砸存量**）：本批无 `batch.handoffs` 字段（旧批）但该 lane
      //   声明了 deps 入边 ⇒ 未交接门整体放行 ⇒ 落 `lane.handoff.gap{legacy:true}` 告警，使「本 lane 是在无
      //   交接约束下开工的」在事件流里**可核**（不阻断、不追溯拒批）。闸门判据来自 gates.ts 的放行标记
      //   `handoffLegacy`（门禁纯函数不写事件 ⇒ 落盘一律在本写路径，R-5 边界不变）。
      if (g.handoffLegacy === true) {
        batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, {
          lane, code: 'GATE_HANDOFF_LEGACY_PASSTHROUGH', legacy: true, missing: [],
          problems: ['本批无 `batch.handoffs` 字段（存量批）⇒ 未交接门整体放行；本 lane 开工**未**受交接约束（裁决 ①=B：不静默、不砸存量）'],
        }));
      }
      // longrun 长程豁免授予（派发面唯一写入点，R-2/R-6）：entry 门禁通过后校验并归一载荷——
      //   非法结构 → GATE_EXEMPT_INVALID；未知 type → GATE_EXEMPT_TYPE_UNKNOWN（均在既有 guard 分支**零写入**语义下，
      //   即校验失败时不落盘、不改 batch（与 GATE_ENTRY_MISSING 拒派同族；entry 分支已在上方提前返回）。
      // 授予记录与本次迁移**同一次 atomicWrite** 落盘（下方统一写盘点），并携带 grantedFrom = 派发面来源（结构性证据）。
      if (exempt != null) {
        exemptGrant = normalizeExemptPayload(exempt);
      }
    }
    if (to === 'review') {
      // audit lane 产物含 needHuman 声明 → 事件 lane.needhuman 留痕（Manager 转达人工裁决）
      const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, null);
      collect('escape', nh); // V-4 写端（e2）：review 态关闭档留痕（needhuman-off）
      emitContractMissing(nh); // B2（§8⑤ P-3 needhuman @audit）：首触留痕
      if (nh.declared) batch.events.push(newEvent(EVT.EVT_LANE_NEEDHUMAN, { lane, path: nh.path }));
    }
    if (to === 'merged') {
      const g = gates.checkExitGate(sessionId, batchId, batch, lane);
      // V-4 写端（e2）：exit 门的降级载荷（produce-field-widened 等）——**放行侧**落盘；
      //   拒侧（!g.ok）不落 degrade（既有 gate.exit_missing 已留痕，避免同一次失败双事件）。
      if (g.ok) collect('degrade', g);
      emitContractMissing(g); // B2（§8⑤ P-2 contract @plan）：plan 契约门的放行侧采集体
      if (!g.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_EXIT_MISSING, { lane, code: g.code, detail: g.problems ?? g.missing }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + ': ' + (g.problems ?? g.missing).join(', '));
      }
      batch.events.push(newEvent(EVT.EVT_GATE_PASSED, { lane, gate: 'exit' }));
      // targets 门禁：exec 层声明 targets（批次产物根外目标文件）→ merged 前置校验——
      // exit gate 之后、command gate 之前（增量接线，不改既有门禁顺序与语义）。
      // 失败（missing/unchanged）→ gate.target_blocked 事件 + 抛错拒 merged（lane 留 review，成员态不变，与 exit gate 同语义）；
      // 通过且 declared → gate.target.passed 事件留痕；未声明/非 exec/逃生阀 → 零感知（无事件）。
      const tg = gates.checkTargetsGate(sessionId, batchId, batch, lane);
      collect('escape', tg); // V-4 写端（e2）：targets 面的 env 阀 / 团队关闭留痕（env-gate-disabled / targets-off）
      emitContractMissing(tg); // B2（§8⑤ P-5 targets @exec）：放行侧首触留痕
      if (!tg.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_TARGET_BLOCKED, { lane, code: tg.code, missing: tg.missing ?? [], unchanged: tg.unchanged ?? [] }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(tg.code + ': targets 未通过校验（missing=' + (tg.missing ?? []).join(', ') + '; unchanged=' + (tg.unchanged ?? []).join(', ') + '）');
      }
      if (tg.declared) {
        batch.events.push(newEvent(EVT.EVT_GATE_TARGET_PASSED, { lane, mode: tg.mode ?? 'mtime', targets: tg.targets ?? [] }));
      }
      // 命令 gate（V1）：exec 层产物声明行 `gate: <命令>` → merged 前置确定性执行（checkExitGate 之后、needHuman 之前）
      // 成功/未声明 → gate.exit 事件（declared 时）后继续；失败+needHuman 声明 → 转人工闸（escalation，merged 须 note 含 human: 证据）；
      // 失败+未声明 → gate.exit_blocked 事件 + 抛 GATE_EXIT_*（拒 merged，lane 留 review）
      const cg = gates.checkCommandGate(sessionId, batchId, batch, lane);
      collect('escape', cg); // V-4 写端（e2）：命令面留痕（env-gate-disabled / command-declared-off）
      emitContractMissing(cg); // B2（§8⑤ P-4 gate_command @exec）：放行侧首触留痕
      if (!cg.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_EXIT_BLOCKED, { lane, code: cg.code, command: cg.command ?? null, exitCode: cg.exitCode ?? null, detail: cg.detail ?? null, escalation: cg.needHumanEscalation === true }));
        if (cg.needHumanEscalation) {
          // 转人工闸：复用 needHuman 证据契约（note 含 `human:<裁决人>:<时间>:<结论>`）；无证据 → GATE_NEEDHUMAN_PENDING 挂起
          const evidence = typeof note === 'string' ? (note.match(/^human:.+/m) ?? [null])[0] : null;
          if (!evidence) {
            batch.updatedAt = new Date().toISOString();
            atomicWrite(batchFile(sessionId, batchId), batch);
            throw new Error('GATE_NEEDHUMAN_PENDING: 命令 gate 失败（' + cg.code + '）且产物声明 needHuman，merged 须 note 含 human: 证据');
          }
          batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note })); // 人工裁决留痕（note 可回溯）
        } else {
          batch.updatedAt = new Date().toISOString();
          atomicWrite(batchFile(sessionId, batchId), batch);
          throw new Error(cg.code + ': ' + (cg.detail ?? 'command gate failed'));
        }
      } else if (cg.declared) {
        batch.events.push(newEvent(EVT.EVT_GATE_EXIT, { lane, commands: cg.commands ?? [], results: cg.results ?? [], outputTruncated: cg.outputTruncated === true }));
      }
      // needHuman 人工闸（merged 前置，与 checkExitGate 并列）——声明 lane 缺 human: 证据 → 拒 GATE_NEEDHUMAN_PENDING
      const nh = gates.checkNeedHumanGate(sessionId, batchId, batch, lane, note);
      collect('escape', nh); // V-4 写端（e2）：merged 前置 needHuman 面关闭档留痕（needhuman-off）
      emitContractMissing(nh); // B2（§8⑤ P-3 needhuman @audit）：merged 前置面的首触（同键已被 review 态拦下）
      if (!nh.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_NEEDHUMAN_BLOCKED, { lane, code: nh.code, path: nh.path }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(nh.code + ': ' + nh.message);
      }
      if (nh.declared) batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note })); // 人工裁决留痕（note 可回溯）
      // ── P2-A（裁决 D3，2026-09-17）：出口侧收紧「有下游 ⇒ 须至少一条已成立交接」───────────────
      // 位置纪律：**放在既有门链末尾**（exit → targets → command → needHuman 之后、写盘点之前）⇒
      //   **既有门顺序与语义一字不动**（本批只**新增**判定；D2「保留 exit 门」由此自然成立）。
      // 语义：本 lane 有下游却无一条已成立交接 ⇒ 拒 `GATE_HANDOFF_MISSING` + 落 `lane.handoff.gap` 缺口事件；
      //   Leader 例外（note 含 `human:<裁决人>:<时间>:<结论>`）⇒ 放行 + `human.decision` 留痕；
      //   存量批（无 `batch.handoffs`）⇒ 放行 + `lane.handoff.gap{legacy:true}` 留痕（不静默、不砸存量）。
      //   门开关经**唯一解析点**（`wave-plan.ts#handoffGateEnabledOf`，读 runtime.json `gates.handoff.settle`
      //   + env 兜底，缺省关）⇒ 关闭时本段零行为变化（既有批零回归）；`task-27` 后改 runtime.json 即热生效。
      const shg = gates.checkSettleHandoffGate(sessionId, batchId, batch, lane, note);
      if (shg.legacy === true) {
        batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, {
          lane, code: 'GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH', legacy: true, missing: [],
          problems: ['本批无 `batch.handoffs` 字段（存量批）⇒ 出口侧交接门放行；本 lane 结算**未**受交接约束（不静默、不砸存量）'],
        }));
      } else if (!shg.ok) {
        batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, {
          lane, code: shg.code, missing: shg.missing ?? [], ...(shg.problems ? { problems: shg.problems } : {}),
        }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(shg.code + ': ' + (shg.missing ?? []).join(', ') + (shg.problems?.length ? ' ——' + shg.problems[0] : ''));
      } else if (shg.humanException === true) {
        batch.events.push(newEvent(EVT.EVT_HUMAN_DECISION, { lane, note: 'handoff-exception: ' + String(note ?? '') }));
      }
    }
    // lane 结算终态（merged/failed/skipped/conflict，member_settle 语义）清退 laneProgress
    // 断点指针（不残留脏指针；批次 complete 后整块随批次归档由 archive 覆盖）
    if (schema.isMemberTerminal(to)) {
      batch = laneProgressClear(batch, lane);
      batch = laneExemptClear(batch, lane); // 结算终态同步清退 longrun 豁免（免残留到后续批次读端）
    }
    batch.lanes[lane] = to;
    // N1-R4-1b（K1 公共池）：**派发 = 唯一出池动作** ⇒ 在同一 atomicWrite 内把 `owner` 写进任务声明面。
    //   · 只在派发面（`to === 'running'`）写；`owner` 非字符串（含缺省 undefined）⇒ **零写入**（既有行为不变）。
    //   · 写的是 `wavePlan[].tasks[].owner`（声明面），与 `lanes[lane]`（执行面）**同一次落盘** ⇒ 二者不会漂移。
    //   · **非改派**：已出池（owner 非空）⇒ **不覆盖**（K1：已派发即冻结；换人 = 作废 + 池内新增替代 + gap-list 留痕）。
    if (to === 'running' && typeof owner === 'string' && owner.length > 0) {
      const wp = Array.isArray(batch.wavePlan) ? batch.wavePlan : [];
      for (let wi = 0; wi < wp.length; wi++) {
        const tasks = wp[wi]?.tasks;
        if (!Array.isArray(tasks)) continue;
        const ti = tasks.findIndex((x) => x && x.id === lane);
        if (ti < 0) continue;
        if (typeof tasks[ti].owner === 'string' && tasks[ti].owner.length > 0) break; // 已出池 ⇒ 不覆盖
        batch.wavePlan = wp.map((w, i) => (i !== wi ? w : {
          ...w,
          tasks: w.tasks.map((t, j) => (j !== ti ? t : { ...t, owner })),
        }));
        batch.events.push(newEvent(EVT.EVT_TASK_OWNER_ASSIGNED, { lane, owner, from }));
        break;
      }
    }
    // 豁免授予落盘（与本次迁移同一 atomicWrite）：以最后一次派发面授予为准（覆盖旧记录，不设「已存在则拒」——
    // 避免阻塞 idle→running 重派；重派后阈值以新授予为准，探针侧 runningSince 亦从新 stint 起算）。
    // D7（2026-09-14，§6.2 **首选=继承**）：派发面无授予（exemptGrant 为 null）且 `to === 'running'` 时——
    //   ① 该 lane **仍有**旧豁免 ⇒ **继承**：保留 `batch.laneExempt[lane]`（阈值/倍率/stalled 语义原样延续，
    //      避免「长任务恢复重派 ⇒ 阈值被打回基准 ⇒ 重新变成长跑候选」的误报）+ 更新 `grantedAt` 为本次（新 stint 起算）
    //      + 写 `grantedFrom = from`（语义扩展为「显式授予 / 继承」两种来源）+ 字面量事件 `lane.exempt.inherited` 留痕。
    //   ② 该 lane **已无**旧豁免（此前终态清退 / 显式撤销）⇒ 走下方 `laneExemptClear` 兜底；**若确有清退发生**
    //      则以字面量事件 `lane.exempt.cleared` + `batch.laneExemptCleared[lane]` **留痕清退**
    //      （D7 次选的留痕面；e1 读端 `exemptClearedAtOf` 的两个通道都能读到）。
    //   **两条落法不并存于同一次迁移**：先看「有无可继承的旧豁免」——有则继承（不产 cleared），
    //   无则清退（不产 inherited）；即任一次重派**至多**产一条 `lane.exempt.*` 留痕事件（除本次显式授予）。
    //   显式撤销入口不变（`revokeLaneExempt`），继承**不妨碍**它：撤销仍整键删除并写 `lane.exempt.revoked`。
    let exemptInherited = null;
    if (!exemptGrant && to === 'running') {
      const prev = batch.laneExempt?.[lane];
      if (prev) {
        const inheritedAt = new Date().toISOString();
        exemptInherited = { ...prev, grantedAt: inheritedAt, grantedFrom: from, inheritedAt, inheritedFrom: prev.grantedAt ?? null };
        batch.laneExempt = { ...batch.laneExempt, [lane]: exemptInherited };
        batch.events.push(newEvent(EVT_LANE_EXEMPT_INHERITED, {
          lane, from, to: 'running',
          exemptType: exemptInherited.type,
          multiplier: exemptInherited.multiplier,
          tierMultiplier: exemptInherited.tierMultiplier,
          stalled: exemptInherited.stalled,
          grantedFrom: from,
          inheritedFrom: prev.grantedAt ?? null,
        }));
      } else {
        const at = new Date().toISOString();
        const cleared = laneExemptClear(batch, lane, at);
        // 仅当**确有一次清退发生**（laneExemptCleared 记到该 lane）才算「留痕清退」：避免对从未授予的 lane
        // 产出 cleared 事件噪音（与「零静默」互补的「零假留痕」）。
        if (cleared.laneExemptCleared?.[lane] === at) batch = cleared;
      }
    }
    if (exemptGrant) {
      const grantedAt = new Date().toISOString();
      batch.laneExempt = {
        ...(batch.laneExempt ?? {}),
        [lane]: { grantedAt, grantedFrom: from, ...exemptGrant },
      };
      // 载荷键纪律：newEvent(type, fields) 的 `type` 键承载**事件名**（引擎多处按 `e.type` 读取与过滤，
      // 如 log_export 的 `e.type.startsWith('gate.')`、面板 label、batch_status），载荷**不得**占用该键 →
      // 豁免类型一律写 `exemptType`（唯一无歧义的命名键；载荷表的 `type` 即事件名本身）。
      batch.events.push(newEvent(EVT.EVT_LANE_EXEMPT_GRANTED, {
        lane, from, to: 'running',
        exemptType: exemptGrant.type,
        multiplier: exemptGrant.multiplier,
        tierMultiplier: exemptGrant.tierMultiplier,
        stalled: exemptGrant.stalled,
        grantedFrom: from,
      }));
    }
    // ── V-4 统一写盘点（e2-gov-repair）：逃生/降级载荷 → 批次事件 ──────────────────────────
    // 时序：在 member.settled 之前、统一 atomicWrite 之内 ⇒ 「门禁已判 + 留痕同批落盘」不可分割。
    // fail-closed：常量在此刻解析（`resolveGateEventTypes()`），缺位即抛 GATE_EVENT_CONST_MISSING
    //   ⇒ **不落盘**（原子写尚未执行）⇒ 绝不产生 `type:undefined` 事件。
    // 只写路径：本段仅存在于 `setMember`（写路径）；`gate_status` 等只读调用不经过本函数（R-04 可核）。
    if (gatePayloads.length > 0) {
      const evtTypes = resolveGateEventTypes();
      for (const item of gatePayloads) {
        const eventsOf = item.kind === 'degrade' ? gateDegradeEvents(item.res, lane) : gateEscapeEvents(item.res, lane);
        for (const ev of eventsOf) {
          batch.events.push(newEvent(item.kind === 'degrade' ? evtTypes.degrade : evtTypes.escape, ev.payload));
        }
      }
    }
    batch.events.push(newEvent(EVT.EVT_MEMBER_SETTLED, { lane, from, to, note: note ?? null }));
    // 连续失败升级——failed 结算后计数：同批次最近连续 failed ≥3 且批次 running → 触发 paused。
    // 单次原子写：paused 迁移 + batch.phase 事件 + batch.failed-escalate 事件与本次结算同批落盘（不调 setPhase 二次写盘，避免竞态）。
    // 棘轮校验 fail-closed：running→paused 迁移被部署收紧删除时 bv.ok=false，不触发、不绕过棘轮；
    // phase 闸（T-2）：paused 后 phase 非 running 自然不重复；人工 resume 后计数从当前事件流重新评估；
    // 不自动重试：failed 仍为终态（schema failed: [] 不变），重做=重开新批次。
    // 升级写走公共内联函数 escalatePausedWrite（failed-escalate 与 governance-escalate 双源复用，
    //   写路径同构杜绝第二套暂停语义）；本段行为零变化（reason='failed-escalate' + batch.failed-escalate 事件原样）。
    let escalated = false;
    if (to === 'failed' && batch.phase === 'running') {
      const streak = countConsecutiveFailedSettles(batch.events);
      if (streak >= 3) {
        const bv = machine.applyBatchTransition('running', 'paused', { rules: ratchet });
        if (bv.ok) {
          escalatePausedWrite(batch, {
            reason: 'failed-escalate',
            eventType: EVT.EVT_BATCH_FAILED_ESCALATE,
            fields: { lane, count: streak },
          });
          escalated = true;
        }
      }
    }
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    // 调用点埋点：member.settled（结算终态/返工入 review 等全部迁移）+ 伴随的 batch.phase（failed-escalate）
    emitStateChange({ type: 'member.settled', sessionId, batchId, lane, from, to, note: note ?? null });
    if (escalated) {
      emitStateChange({ type: 'batch.phase', sessionId, batchId, from: 'running', to: 'paused', reason: 'failed-escalate' });
    }
    return batch;
  }

  function setPhase(sessionId, batchId, to, { reason = null } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    // B2（§8⑤）首触留痕发射器：与 `setMember` **共用同一实现**；complete 面无 lane 归因 ⇒ lane 缺省 null
    const emitContractMissing = makeContractMissingSink(() => batch, () => null);
    schema.assertBatchPhase(to);
    const from = batch.phase;
    // ── M0′-②（2026-09-17 裁决）：相位迁移**事由**（`reason`）随事件落盘 ──────────────────────
    //   动机：`batch.phase` 是「为何不推进」的唯一跨会话可核事实源（审计入口 = `log_export` markdown
    //   时间线）；只有 `{from,to}` 时，读端无法区分「链停轮」与「人工停轮」。
    //   归一化：仅**非空字符串**（trim 后）计事由，其余（缺省 / 空串 / 空白串 / 非字符串）一律 null
    //   ⇒ **非空才写键**，保持既有 `{from,to}` 形态零污染（历史读端与既有深比较不受影响）。
    //   词表（形如 `<source>` 或 `<source>:<detail>`）见 `lib/state/event-types.js` 的 EVT_BATCH_PHASE 登记。
    const reasonStr = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
    // 批次阶段迁移判定走 machine（rules 可注入；默认规则与 schema 常量同引用，行为不变）
    const bv = machine.applyBatchTransition(from, to, { rules: ratchet });
    if (!bv.ok) throw new Error('invalid batch phase transition: ' + from + ' -> ' + to);
    if (to === 'complete') {
      const g = gates.checkCompleteGate(batch);
      // B2（§8⑤ P-6 complete @audit）：`setPhase` 是**独立函数**（无 `setMember` 的收集器作用域）⇒
      //   本处自建同一发射器（共用 `makeContractMissingSink`，杜绝第二套语义）；落盘点 = 本函数尾部
      //   同一次 `atomicWrite`（与 batch.phase / gate.manager_missing 事件同批落盘，不可分割）。
      emitContractMissing(g);
      if (!g.ok) {
        batch.events.push(newEvent(EVT.EVT_GATE_COMPLETE_BLOCKED, { code: g.code, pending: g.pending }));
        batch.updatedAt = new Date().toISOString();
        atomicWrite(batchFile(sessionId, batchId), batch);
        throw new Error(g.code + (g.pending ? ': ' + g.pending.join(', ') : ''));
      }
      // 批次收口告警（非阻断）：**按声明触发**——声明 `managerPlan: 'raise'`（引擎缺省值即 raise）的批若未登记
      // `batch.manager` → 落 `gate.manager_missing`（携带 execLanes 与 managerPlan 供读端定位）。
      // 2026-09-14 由「按 exec lane 数 ≥3」改为「按声明」：原口径会把**显式声明 leader-direct** 的合法批
      // 也报成「Manager 缺失」（声明与告警语义矛盾 = 误导）；无 assembly 的历史批次不告警（宽容，免追溯噪音）。
      const managerPlan = batch.assembly?.managerPlan ?? null;
      if (managerPlan === 'raise' && !batch.manager) {
        const execLanes = (batch.wavePlan ?? []).flatMap((w) => w.tasks ?? []).filter((t) => (t.layer ?? 'exec') === 'exec').length;
        batch.events.push(newEvent(EVT.EVT_GATE_MANAGER_MISSING, { execLanes, managerPlan }));
      }
    }
    batch.phase = to;
    batch.events.push(newEvent(EVT.EVT_BATCH_PHASE, reasonStr ? { from, to, reason: reasonStr } : { from, to }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    // 调用点埋点：batch.phase 迁移事件发布（规划→运行→暂停→终态等全部阶段迁移）
    emitStateChange({ type: 'batch.phase', sessionId, batchId, from, to, ...(reasonStr ? { reason: reasonStr } : {}) });
    // complete 钩子——门禁通过 + phase 写入后自动归档（单向、幂等）；
    // 失败仅记录 archive.failed（archiveBatch 内部处理），不阻断 complete；try/catch 兜底意外异常（如批次文件不可读）
    if (to === 'complete') {
      try {
        archive.archiveBatch(sessionId, batchId);
      } catch (err) {
        try {
          const b = readBatch(sessionId, batchId);
          if (b) {
            b.events.push(newEvent(EVT.EVT_ARCHIVE_FAILED, { reason: String((err && err.message) || err) }));
            b.updatedAt = new Date().toISOString();
            atomicWrite(batchFile(sessionId, batchId), b);
          }
        } catch { /* 兜底也失败：静默（complete 已置位，审计可经 archive/ 目录状态判断） */ }
      }
    }
    return batch;
  }

  // Manager 拉起登记（唯一写入口）：写批次级 `manager` 字段 + `batch.manager.raised` 事件。
  // 【gate-lite 第二批 · A（2026-09-17 用户裁决「全删 + 改造为官方 roster 承抽」）】**三码已删**：
  //   `GATE_MANAGER_TERMINAL` / `GATE_MANAGER_PHASE_INVALID` / `GATE_MANAGER_AGENT_ID_REQUIRED` 不再存在
  //   ⇒ 登记**不再按 phase 或 agentId 拒绝**：
  //     · 任意 phase（含终态）均可登记事实（幂等；不改批次阶段、不改成员状态）；
  //     · `agentId` 缺失/空白 ⇒ **不写垃圾记录**（返回 null，调用方按「既无 phase 又无 manager」如实报错），
  //       **不抛门禁错**（不静默：调用方拿到 null 后走既有显式报错分支）。
  //   在册判定的**新真源 = 官方 roster**（读端 `lib/tools/core.js#managerRosterOf`；建批期落
  //   `gate.manager_roster_gap`）。本函数降级为**legacy 登记面**（旧批/离线记录，读端并列回显）。
  function markManagerRaised(sessionId, batchId, payload = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const agentId = typeof payload.agentId === 'string' ? payload.agentId.trim() : '';
    if (!agentId) return null; // 空 agentId：不拒、不写垃圾（空值门禁已删，A 批口径）
    // 幂等：同一 agentId 重复登记 → 直接返回既有记录，**不重复写事件**（防审计噪音：例如
    //   「先登记、后迁移」的调用序下，同一次阶段迁移被重试时会二次登记）。
    if (batch.manager && batch.manager.agentId === agentId) return batch.manager;
    const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : undefined;
    const at = new Date().toISOString();
    batch.manager = note ? { agentId, raisedAt: at, note } : { agentId, raisedAt: at };
    batch.events.push(newEvent(EVT.EVT_BATCH_MANAGER_RAISED, note ? { agentId, note } : { agentId }));
    batch.updatedAt = at;
    atomicWrite(batchFile(sessionId, batchId), batch);
    emitStateChange({ type: EVT.EVT_BATCH_MANAGER_RAISED, sessionId, batchId, agentId });
    return batch.manager;
  }

  function appendEvent(sessionId, batchId, type, fields = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    batch.events.push(newEvent(type, fields));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return batch;
  }

  // ---- P1 交接门：交接记录写入（**唯一写路径内新增**，裁决 ③=A）----
  // 纪律（`docs/p1-handoff-gate-changeplan-20260917.md` §5「触碰唯一写路径」的缓解措施）：
  //   · **只新增函数**，既有写入语义（createBatch/appendEvent/setMember/atomicWrite）一字不改；
  //   · `batch.handoffs` 与 `lane.handoff` 审计事件**同一次 atomicWrite** ⇒ 「交了」与「记了」不可分叉；
  //   · 交接成立性判据（artifacts 在场 / contract 合规）**不在本函数重判**（单点判定在 entry 门，禁双重判定）：
  //     本函数只判**结构性前提**（批次存在 / 入边已在建批期种条 / artifacts 非空 / assertions 非空 / consumedFrom 指回入边），
  //     存在性事实由 `tools/core.js` 的交接工具面在**调用前**判定并回显缺口（与门禁判据同源：`presenceOfArtifact`）。
  const HANDOFF_MISSING = 'GATE_HANDOFF_MISSING';
  function recordHandoff(sessionId, batchId, { from, to, artifacts, assertions, officialTaskId = null } = {}) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const fail = (problems, missing) => {
      const r = { ok: false, code: HANDOFF_MISSING, problems, missing };
      batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF_GAP, { lane: to ?? null, code: HANDOFF_MISSING, missing, problems }));
      batch.updatedAt = new Date().toISOString();
      atomicWrite(batchFile(sessionId, batchId), batch);
      return r;
    };
    if (typeof from !== 'string' || !from.length) return fail(['handoff from 必填（上游 lane id）'], ['from']);
    if (typeof to !== 'string' || !to.length) return fail(['handoff to 必填（下游 lane id）'], ['to']);
    // 存量批（无 `handoffs` 字段）⇒ 不受新门约束 ⇒ 交接**不可登记**（否则会给存量批凭空开新门）：
    //   明确拒 + 回显（不静默），与裁决 ①=B「存量批放行 + 留痕」同向（放行的是**开工**，不是**新建交接载体**）。
    if (batch.handoffs == null || typeof batch.handoffs !== 'object' || Array.isArray(batch.handoffs)) {
      return fail(['本批无 `batch.handoffs`（存量批）⇒ 交接载体不存在，交接不予登记（新门只对新建批生效，裁决 ①=B）'], ['batch.handoffs']);
    }
    const list = Array.isArray(batch.handoffs[to]) ? batch.handoffs[to] : null;
    if (!list) return fail(['下游 lane ' + to + ' 无建批期交接声明（`deps` 入边未种条）⇒ 交接不成立'], ['edge:' + from + '->' + to]);
    const rec = list.find((r) => r && r.from === from) ?? null;
    if (!rec) return fail(['交接入边 ' + from + '->' + to + ' 不在建批期声明中（下游 deps 未含该上游）'], ['edge:' + from + '->' + to]);
    const arts = Array.isArray(artifacts) ? artifacts.filter((p) => typeof p === 'string' && p.trim().length > 0) : [];
    const asrt = Array.isArray(assertions) ? assertions.filter((a) => typeof a === 'string' && a.trim().length > 0) : [];
    const problems = [];
    const missing = [];
    if (arts.length === 0) { problems.push('artifacts 必填（至少一件上游交付产物）'); missing.push('artifacts'); }
    if (asrt.length === 0) { problems.push('contract.assertions 必填（至少一条下游可核断言）'); missing.push('contract.assertions'); }
    if (problems.length) return fail(problems, missing);
    rec.artifacts = [...arts];
    rec.contract = { consumedFrom: from, assertions: [...asrt] };
    rec.status = 'submitted';
    rec.ts = new Date().toISOString();
    if (officialTaskId !== null && officialTaskId !== undefined) rec.officialTaskId = String(officialTaskId);
    batch.events.push(newEvent(EVT.EVT_LANE_HANDOFF, { lane: to, from, to, artifacts: [...arts], assertions: [...asrt], handoffBatch: batchId }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return { ok: true, code: null, from, to, artifacts: [...arts], assertions: [...asrt], record: { ...rec } };
  }

  // ---- 环防护 budget：chains 状态读写（批次 v3 字段，原子写复用 atomicWrite）----
  // readChains：读 batch.chains；v2 存量批次经 migrateV2toV3 幂等补默认（只读不落盘）
  function readChains(sessionId, batchId) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) return null;
    return migrateV2toV3(batch).chains ?? chainsDefaults();
  }
  // updateChains：patch = 完整新 chains 状态（recordChain 纯函数产出），原子写；v2 存量批次迁移落盘（schema 升 3 + chains 补全）
  function updateChains(sessionId, batchId, patch) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = migrateV2toV3(batch);
    next.chains = patch ?? chainsDefaults();
    next.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), next);
    return next.chains;
  }

  // ---- 断点指针持久化（laneProgress）----
  // updateLaneProgress：lane_checkpoint 携带 progress 时经 laneProgressWrite 纯函数合并后原子写
  // （不突变入参；worktree.checkpoint 事件留痕由调用方 lane-tools 承担，本接口只写指针）。
  // 清退走 setMember 终态分支（laneProgressClear），本接口只增不删。
  function updateLaneProgress(sessionId, batchId, lane, progress) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = laneProgressWrite(batch, lane, progress);
    next.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), next);
    return next;
  }

  // asset_claim 归位：Leader 已直做产物复制进批次 artifacts/<batchId>/（保留内容，不移动），事件留痕。
  // 安全：target 必须是批次内相对路径——拒绝绝对路径、盘符前缀、.. / . / 空段；解析后仍须落在 artifacts 目录内（纵深防御）。
  function claimAsset(sessionId, batchId, { source, target }) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (typeof target !== 'string' || !target.length) throw new Error('invalid target path: ' + target + ' (must be batch-relative)');
    if (isAbsPath(target) || /^[A-Za-z]:/.test(target)) throw new Error('invalid target path: ' + target + ' (must be batch-relative, no absolute path)');
    const segments = target.split(/[\\/]+/);
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error('invalid target path: ' + target + ' (must be batch-relative, no .. or empty segment)');
    }
    let st;
    try { st = fs.statSync(source); } catch { throw new Error('source not found: ' + source); }
    if (!st.isFile()) throw new Error('source is not a file: ' + source);
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    const dest = path.join(artifactsDir, ...segments);
    const base = path.resolve(artifactsDir) + path.sep;
    if (!path.resolve(dest).startsWith(base)) throw new Error('target escapes artifacts dir: ' + target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest); // 保留内容，不移动（避免破坏已引用）
    batch.events.push(newEvent(EVT.EVT_ASSET_CLAIMED, { lane: null, source, target }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return { ok: true, claimedPath: target, batchId };
  }

  function batchSettled(batch) {
    const lanes = Object.values(batch.lanes ?? {});
    return batch.phase === 'running' && lanes.length > 0 && lanes.every(schema.isMemberTerminal);
  }

  function batchAutoReleaseable(batch) {
    const lanes = Object.values(batch.lanes ?? {});
    if (!batch || lanes.length === 0) return false;
    return batch.phase === 'running' && lanes.every((s) => s === 'merged');
  }

  // ---- 恢复审计辅助（只读探测，无副作用）----
  // lastActiveAt（上次活动时间）：events 中该 lane 最近一条带 lane 字段事件（member.settled / worktree.checkpoint /
  // lane.skipped / lane.needhuman 等）的 ts；无 lane 事件 → 回退 batch.updatedAt
  function lastActiveAtOf(batch, lane) {
    const evs = batch.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].lane === lane && evs[i].ts) return evs[i].ts;
    }
    return batch.updatedAt;
  }
  // produced（已产出产物清单）：复用 gate 语义（gates.js fileExistsNonEmpty 同款判定：目录或 size>0）——
  // 契约字段 exec→outputs / plan·audit→produce，逐项探测 artifactsDirOf 下解析路径存在且非空；
  // 产出清单 = 契约中已存在的相对路径数组（绝对路径契约按 resolveArtifact 语义直接探测）
  function producedOf(sessionId, batchId, batch, lane) {
    const t = findTask(batch, lane);
    if (!t) return [];
    const field = t.layer === 'exec' ? 'outputs' : (t.layer === 'plan' || t.layer === 'audit' ? 'produce' : null);
    if (!field || !Array.isArray(t[field])) return [];
    const artifactsDir = artifactsDirOf(sessionId, batchId);
    const existsNonEmpty = (p) => {
      try {
        const st = fs.statSync(isAbsPath(p) ? p : path.join(artifactsDir, p));
        return st.isDirectory() || st.size > 0;
      } catch { return false; }
    };
    return t[field].filter(existsNonEmpty);
  }

  function recoverBatches() {
    const recovered = [];
    const corrupt = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) {
        const batch = readBatch(sessionId, batchId);
        if (!batch) {
          // 损坏批次隔离：登记已由 readBatch 幂等完成（首次才 warn）；汇总 corrupt 后跳过，不击穿循环
          if (isCorrupt(sessionId, batchId)) corrupt.push(sessionId + '/' + batchId);
          continue;
        }
        if (schema.isBatchTerminal(batch.phase)) continue;
        const recoveredLanes = [];
        const detail = [];
        for (const [lane, state] of Object.entries(batch.lanes)) {
          if (state === 'running' || state === 'review') {
            batch.lanes[lane] = 'idle';
            recoveredLanes.push(lane);
            // 审计详情：from 原态 / lastActiveAt 反查 / produced 复用 gate 语义（置 idle 前采集，只读不改产物）；
            // outcome='crashed'：进程崩溃重启后 in-flight lane 被强制落 idle 的结局记账值
            // （只记不改：非成员态、不拦截、不新增迁移；随既有 system.recovered.detail 供重派前经事件流查询）
            detail.push({ lane, from: state, lastActiveAt: lastActiveAtOf(batch, lane), produced: producedOf(sessionId, batchId, batch, lane), outcome: 'crashed' });
          }
        }
        if (recoveredLanes.length > 0) {
          // 恢复期清退**本进程已不持有**的 lane 锁：崩溃前的持有者进程已不存在 → 该锁是死锁，
          // 不清退会让「核对后重派」在 lane_claim 处永久冲突（唯一出路是 force 接管，而 force 不校验持有者活性）。
          for (const lane of recoveredLanes) {
            try { fs.rmSync(path.join(sessionsDir, sessionId, '.locks', batchId + '.' + lane + '.lock'), { force: true }); } catch { /* 清锁失败不阻断恢复 */ }
          }
          // 保留 recoveredLanes（向后兼容，既有测试断言其存在），新增 detail 审计详情数组
          batch.events.push(newEvent(EVT.EVT_SYSTEM_RECOVERED, { batchId, sessionId, recoveredLanes, detail }));
          batch.updatedAt = new Date().toISOString();
          atomicWrite(batchFile(sessionId, batchId), batch);
          recovered.push(sessionId + '/' + batchId);
        }
      }
    }
    // 向后兼容：返回数组形态（.length/.join 兼容 index.js:86-87 既有消费与 resume.js:60 原样透传）；
    // corrupt 汇总以非破坏性属性暴露（设计「{ recovered, corrupt }」语义经 recovered.corrupt 获得）
    recovered.corrupt = corrupt;
    if (corrupt.length) {
      log.warn?.('[dsh-punky-swarm] recovery skipped ' + corrupt.length + ' corrupt batch(es): ' + corrupt.join(', '));
    }
    return recovered;
  }

  // 孤儿 worker 显式回收：lane.stalled 处置扩展——只标记 → 可显式回收。
  // 语义：管理命令（显式触发，仿 recoverBatches 直写先例，不经棘轮表/不放宽 MEMBER_TRANSITIONS）；
  //       默认不自动处置（人审保留）；lane.stalled 仍非成员状态（不新增成员态，语义保持）。
  // 前置校验：批次不存在/损坏 → throw；lane 非 running → throw（防双回收/误回收：终态 lane 永不回收）。
  // 事件：lane.recycled { lane, from:'running', reason:'stalled', outcome:'interrupted', note } 留痕；
  //   outcome='interrupted'：运行中被显式回收（停滞证据 → 脱离在飞态）的结局记账值
  //   （只记不改：非成员态、不拦截、不新增迁移；watch stalled/longrun 信号零变，仅处置落 idle 时记账）；
  //   回收后走既有 member_status idle→running 重派。
  function recycleStalledLane(sessionId, batchId, lane) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    if (!(lane in batch.lanes)) throw new Error('unknown lane: ' + lane);
    if (batch.lanes[lane] !== 'running') throw new Error('lane not running: ' + lane + ' (state=' + batch.lanes[lane] + ')');
    // 校验该 lane 存在 lane.stalled 事件（batch.events 反查；stalled 只标记，回收须有停滞证据）
    const hasStalled = (batch.events ?? []).some((e) => e.type === EVT.EVT_LANE_STALLED && e.lane === lane);
    if (!hasStalled) throw new Error('no lane.stalled event for lane: ' + lane + ' (recycle requires stalled evidence)');
    batch.lanes[lane] = 'idle';
    batch.events.push(newEvent(EVT.EVT_LANE_RECYCLED, { lane, from: 'running', reason: 'stalled', outcome: 'interrupted', note: null }));
    batch.updatedAt = new Date().toISOString();
    atomicWrite(batchFile(sessionId, batchId), batch);
    return { ok: true, lane, from: 'running', to: 'idle' };
  }

  function listAllBatches() {
    const all = [];
    for (const sessionId of listSessions()) {
      for (const batchId of listBatches(sessionId)) all.push({ sessionId, batchId });
    }
    return all;
  }

  // ---- 会话级治理状态（governance.json v2）----
  // 每回合任务难度评估（A/B/C）的事实源：lastAssign + history 审计 + 执行型工具计数 + pendingBatch
  const GOV_SCHEMA = 2;
  function govDefaults() {
    return { schema: GOV_SCHEMA, execToolCount: 0, pendingBatch: false, pendingSince: null, lastAssign: null, history: [] };
  }
  function governanceFile(sessionId) {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
    return path.join(sessionDir(sessionId), 'governance.json');
  }
  // 无文件/损坏 → 返回默认（调用方无需判空）
  function readGovernance(sessionId) {
    const file = governanceFile(sessionId);
    if (!fs.existsSync(file)) return govDefaults();
    try { return { ...govDefaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch { return govDefaults(); }
  }
  // 原子写：读当前（或默认）→ 合并 patch → 落盘
  function writeGovernance(sessionId, patch) {
    const next = { ...readGovernance(sessionId), ...patch };
    atomicWrite(governanceFile(sessionId), next);
    return next;
  }
  // 执行型工具调用计数（**纯观察面**）：execToolCount 累计 + lastAssign.execCallsSince 递增。
  // 【2026-09-16 用户裁决】这两项**仅作提示/观察**，**不作为升档或评估过期依据**——
  //   难度档位依据已彻底改写为「每回合主动写入的 difficulty + 判据」（见 lib/tools/core.js 门禁 1）。
  function bumpExecCount(sessionId) {
    const g = readGovernance(sessionId);
    g.execToolCount = (g.execToolCount ?? 0) + 1;
    if (g.lastAssign) g.lastAssign.execCallsSince = (g.lastAssign.execCallsSince ?? 0) + 1;
    atomicWrite(governanceFile(sessionId), g);
    return g;
  }
  // 评估过期判定：从未评估 / 距 lastAssign.at ≥ maxAgeMs(30min) / 时间戳非法。
  // 【2026-09-16 用户裁决】原 `execCallsSince ≥ maxCalls(20)` 判据**已移除**：难度档位依据已彻底改写，
  //   调用计数不再是档位/过期的依据（旧判据还会被只读侦察计数灌水误触发重评）。
  //   `maxCalls` 入参保留但**忽略**（向后兼容既有调用方与测试签名）。
  function stale(sessionId, { maxAgeMs = 30 * 60 * 1000 } = {}) {
    const g = readGovernance(sessionId);
    if (!g.lastAssign) return true;
    const at = Date.parse(g.lastAssign.at);
    if (!Number.isFinite(at)) return true; // 时间戳非法按过期处理（宁严勿松）
    return Date.now() - at >= maxAgeMs;
  }
  // 会话内是否有活跃（非终态）批次：pendingBatch 语义基于此（建批后清锁、批次终态后旧锁失效）
  function hasActiveBatch(sessionId) {
    return listBatches(sessionId).some((id) => {
      const b = readBatch(sessionId, id);
      return b && !schema.isBatchTerminal(b.phase);
    });
  }

  return {
    createBatch, readBatch, readBatchResult, isCorrupt, listBatches, listSessions, listAllBatches,
    setMember, setPhase, appendEvent, claimAsset,
    addPoolTasks, // N1-R4-1c：池内追加任务（图变更唯一写入口；单次 atomicWrite，只增不改）
    recordHandoff, // P1 交接门：交接记录唯一写入入口（`batch.handoffs` + `lane.handoff` 事件同一次 atomicWrite）
    markManagerRaised, // Manager 拉起登记唯一入口（批 event + 批字段，不改成员状态）
    revokeLaneExempt, // longrun 豁免撤销唯一入口（显式调用；不改成员状态）
    recordGovernanceRefusal, // 违规计数记录 + 窗口评估 + 升级（批事件流单一事实源）
    readChains, updateChains, updateLaneProgress, // laneProgress 断点指针持久化
    batchSettled, batchAutoReleaseable,
    recoverBatches, recycleStalledLane, migrateLegacy, batchFile, sessionsDir, artifactsDirOf, gateStatus: gates.gateStatus,
    // TD-21 / N-13（2026-09-18 清理波）：批级门禁视图单点暴露（一次读批 → `{lane: gateView}`）——
    //   `lib/api.js` 的 `lanesGate` 投影唯一读端；与逐 lane 兼容外壳 `gateStatus` 同源同实现（`gates.ts`
    //   的 `gateStatusOfLane` 单点），差别只在读盘次数（投影段由 N 次降为 1 次）。
    gateStatusOfBatch: gates.gateStatusOfBatch,
    gateStatusMapOfBatch: gates.gateStatusMapOfBatch,
    // §8③ 快照读端（只读视图：读 `batch.teamAsset.snapshotPath` 指向的会话级正档，缺档 ⇒ declarationMissing；
    //   **不参与任何门禁判定**、读路径不 throw、缺档不回落现算）
    teamAssetViewOf: gates.teamAssetViewOf,
    readGovernance, writeGovernance, bumpExecCount, stale, hasActiveBatch, governanceFile,
    // 损坏旁路清单：幂等登记 / 只读清单 / 人工修复后清除标记（透传 corrupt-registry）
    corruptRegistry: { markBatchCorrupt: corruptRegistry.markBatchCorrupt, listCorruptBatches: corruptRegistry.listCorruptBatches, clearCorruptMark: corruptRegistry.clearCorruptMark, corruptFileOf: corruptRegistry.corruptFileOf },
    // 归档只读/幂等面（batch_status 面板与审计查询用）
    archive: { archiveBatch: archive.archiveBatch, readManifest: archive.readManifest, listArchived: archive.listArchived },
  };
}
