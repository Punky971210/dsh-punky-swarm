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

// 批次 `a3-snapshot-b1-20260915` · lane e1：§8③ 解析结果落快照（会话级正档 + 批次级指纹引用）的落地判据。
//
// 覆盖 DoD（规格 §7）：
//   D2  真实建批回显探针（档存在且格式/命名正确、batch.teamAsset 可读、事件 batch.team-asset.resolved 落盘）
//   D2b 幂等（同 hash 二次建批 ⇒ 档 mtime 不变）与版本史（改资产 ⇒ 新档 + 旧档留存）
//   D3  回显面 = **output.schema 键**的判据：工具值经**宿主真实函数**
//       `ToolRuntime.prototype.createSuccessResult`（dsh-tools 的 createSuccessResult，dispatch 路径上的同一函数）
//       校验通过；并以「删掉 schema 键的工具」作负控，证明漏补键 ⇒ ToolOutputError（非静默剥离）。
//   D4  缺省零差异（generic 批不落档/不落事件/判定面读数与无该字段的批次逐字一致）
//   D8  读路径零副作用（连续两次 gate_status 前后，批次文件 mtime 与 sessions/<sid>/ 树清单不变）
//       另含边界两例：有资产但解析失败（照写档 + 事件）、写档失败（告警 + snapshotWriteFailed，不拒建批）
//
// 隔离：所有用例一律用 mkdtemp 临时 root 建 store（不触真实库）；配合
//   `node --import ./test/helpers/isolated-home.preload.mjs --test` 运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateJsonSchemaValue, ToolOutputError, ToolRuntime } from '@deepseek-ai/dsh-tools';
import { createStore } from '../lib/state/store.js';
import { createTools } from '../lib/tools/register.js';
import { packageRoot } from '../lib/assembly/flows.js';
import { assessC } from './helpers/gate-fixture.mjs';
import { seedTeamAssetSkills } from './helpers/host-skills.mjs';

// 【P1 同步 · 宿主技能根】本套件建批用 `software-team`（TEAM 常量）⇒ 该团队声明技能必须可解析
//   （P1 §3：不可解析 / 技能根缺失 ⇒ `TEAM_ASSET_SKILLS_MISMATCH` 拒建批）⇒ 隔离 HOME 下先注入技能根。
seedTeamAssetSkills('software-team');

const SESSION = 'sess-b1-snapshot';
const TEAM = 'software-team';
const EVT_RESOLVED = 'batch.team-asset.resolved';

// ── fixtures ─────────────────────────────────────────────────────────────
function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-b1-' + tag + '-'));
}

/** 最小 wavePlan（createBatch 只读 .team 与 .wavePlan[].tasks[].id；门禁 shape 由 store 单点负责）。 */
function planOf(team, laneIds = ['e1']) {
  return {
    team,
    wavePlan: [{ wave: 1, tasks: laneIds.map((id) => ({ id, layer: 'exec', cmd: 'x', deps: [] })) }],
  };
}

/** 走真实工具面（`wave_plan`）建批所需的合规三层 tasks：plan 产物被 exec/audit 双重消费，
 *  audit 覆盖 software-team 声明 `consumes_required: ['plan/','exec/']` 的两个前缀。 */
function threeTierTasks() {
  return [
    { id: 'p1', layer: 'plan', role: 'designer', produce: ['plan/spec.md'], cmd: 'spec' },
    { id: 'e1', layer: 'exec', role: 'coder', consume: ['plan/spec.md'], outputs: ['exec/e1.md'], cmd: 'run', deps: ['p1'] },
    { id: 'a1', layer: 'audit', role: 'supervisor', consume: ['plan/spec.md', 'exec/e1.md'], produce: ['audit/a1.md'], cmd: 'review', deps: ['e1'] },
  ];
}

function batchFileOf(root, session, batchId) {
  return path.join(root, 'sessions', session, 'batches', batchId + '.json');
}

function readBatchJson(root, session, batchId) {
  return JSON.parse(fs.readFileSync(batchFileOf(root, session, batchId), 'utf8'));
}

function snapshotsDirOf(root, session) {
  return path.join(root, 'sessions', session, 'team-assets');
}

/** 目录树清单（相对路径排序数组；不存在 ⇒ 空数组）——用于「读路径零副作用」对照。 */
function treeOf(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? rel + '/' + e.name : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
    }
  };
  walk(dir, '');
  return out;
}

function sha16(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * 宿主输出校验路径（**真实宿主函数**）：与 `dsh-tools` 的 `createSuccessResult` 同一实现
 * （差异仅 `this` 为最小桩：实例字段 canonicalResults/concludingExecutions 由宿主构造器初始化，
 *  两个方法取自原型本体）。校验失败 ⇒ `ToolOutputError`（**不是**静默剥离）——与宿主 dispatch 同判据。
 * @returns {{value: unknown, content: unknown}}
 */
function hostOutputGate(tool, value, args = {}) {
  const stub = {
    canonicalResults: new WeakMap(),
    concludingExecutions: new WeakSet(),
    markCanonical: ToolRuntime.prototype.markCanonical,
    materializeFinalResult: ToolRuntime.prototype.materializeFinalResult,
  };
  const exec = { arguments: args, parent: undefined, token: Symbol('b1-probe') };
  return ToolRuntime.prototype.createSuccessResult.call(stub, exec, tool, value);
}

/** 去掉 output.schema 某键的工具副本（负控：模拟「漏补 schema 键」的宿主形态）。 */
function toolWithoutSchemaKey(tool, key) {
  const properties = { ...tool.output.schema.properties };
  delete properties[key];
  return { ...tool, output: { ...tool.output, schema: { ...tool.output.schema, properties } } };
}

function makeToolHarness(store, root) {
  const reg = [];
  const ctx = { tools: { register: (t) => reg.push(t) }, logger: console };
  const { tools } = createTools(ctx, { store, root });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

const SESS_OF = (id) => ({ agent: { session: { id } } });

// ── D2：真实建批回显探针 ──────────────────────────────────────────────────
test('D2 有资产批：会话级正档（格式/命名）+ batch.teamAsset + 事件 batch.team-asset.resolved', () => {
  const root = tmpRoot('ok');
  const store = createStore(root);
  store.createBatch(SESSION, { batchId: 'b1-ok', wavePlan: planOf(TEAM) });

  // ① 档存在且命名 = <team>.<assetHash>.json
  const dir = snapshotsDirOf(root, SESSION);
  assert.ok(fs.existsSync(dir), '会话级 team-assets 目录落盘');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, '单次解析 ⇒ 单档');
  const fileName = files[0];
  assert.match(fileName, new RegExp('^' + TEAM + '\\.[0-9a-f]{16}\\.json$'), '档名 = <team>.<16 位 hex>.json');

  // ② 档格式正确（UTF-8 无 BOM / LF / JSON.parse 可解析 / 键齐备 / 不含资产正文）
  const raw = fs.readFileSync(path.join(dir, fileName), 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), 'UTF-8 无 BOM');
  assert.ok(!raw.includes('\r\n'), 'LF 行尾');
  const doc = JSON.parse(raw);
  assert.equal(doc.schema, 1);
  assert.equal(doc.kind, 'team-asset-snapshot');
  assert.equal(doc.team, TEAM);
  assert.equal(doc.rootKind, 'package');
  assert.equal(path.resolve(doc.root), path.resolve(packageRoot()), '内置团队 ⇒ 解析根 = 包根');
  assert.ok(fs.existsSync(doc.assetPath), 'assetPath 指向真实资产');
  assert.equal(doc.assetHash, sha16(fs.readFileSync(doc.assetPath)), 'assetHash = sha256(原始字节) 前 16 位');
  assert.equal(fileName, TEAM + '.' + doc.assetHash + '.json', '档名 hash 与档内容一致');
  assert.equal(typeof doc.assetSig, 'string');
  assert.ok(doc.assetSig.startsWith(doc.assetPath + ':'), 'assetSig = 路径:mtimeMs:size');
  assert.ok(Number.isInteger(doc.assetBytes) && doc.assetBytes > 0);
  assert.equal(doc.resolved.ok, true);
  assert.equal(typeof doc.resolved.severity, 'string');
  for (const k of ['produceFields', 'produceFieldDeclared', 'consumeFields', 'consumeProblems', 'entryRequires', 'flags', 'flagsResolved', 'presenceGlobs']) {
    assert.ok(Object.prototype.hasOwnProperty.call(doc.summary, k), 'summary.' + k + ' 齐备');
  }
  assert.ok('contract' in doc.summary && 'auditContract' in doc.summary);
  assert.ok(!('unwired' in doc.summary), 'unwired 单独平铺（不嵌在 summary 内）');
  assert.ok(Array.isArray(doc.unwired));
  // 【2026-09-18 清债翻牌】原断言「unwired 含 state_machine」；三条历史条目已随清债移除（退役键改「声明即拒」）
  //   ⇒ 台账为空、投影面为空。断言由「含某键」改为「**为空**」（更强：封堵回填无注解条目）。
  assert.deepEqual(doc.unwired, [], '2026-09-18 清债：台账为空 ⇒ 快照 unwired 面为空（无未接线声明）');
  assert.deepEqual(doc.summary.produceFields.exec, ['produce', 'outputs'], '被检面恒并集');
  assert.equal(doc.summary.entryRequires.exec.source, 'team-asset:entry_requires');
  assert.equal(doc.summary.flagsResolved['exec.targets'].effective, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(doc, 'asset'), '不复制资产正文');
  assert.ok(!raw.includes('"skills"'), '档内不含资产正文片段');

  // ③ batch.teamAsset 可读（指纹引用 + 键级摘要，不含正文/完整 summary）
  const bj = readBatchJson(root, SESSION, 'b1-ok');
  assert.ok(bj.teamAsset, 'batch.teamAsset 落盘');
  assert.equal(bj.teamAsset.snapshotPath, 'team-assets/' + fileName);
  assert.equal(bj.teamAsset.assetHash, doc.assetHash);
  assert.equal(bj.teamAsset.ok, true);
  assert.equal(bj.teamAsset.severity, doc.resolved.severity);
  assert.deepEqual(bj.teamAsset.summaryKeys.produceFields, ['produce', 'outputs']);
  assert.equal(bj.teamAsset.summaryKeys.entryRequiresSource.exec, 'team-asset:entry_requires');
  assert.deepEqual(bj.teamAsset.summaryKeys.unwiredKeys, [], '2026-09-18 清债：批次侧 unwiredKeys 亦为空');
  assert.equal(bj.teamAsset.summaryKeys.contractSections.join('|'), '## 验收标准|## 约束');
  assert.ok(!(('summary' in bj.teamAsset) || ('asset' in bj.teamAsset)), '批字段只带指纹 + 键级摘要');

  // ④ 事件落盘且不占用 type 槽位
  const ev = bj.events.find((e) => e.type === EVT_RESOLVED);
  assert.ok(ev, 'batch.team-asset.resolved 落盘');
  assert.equal(ev.type, EVT_RESOLVED);
  assert.equal(ev.team, TEAM);
  assert.equal(ev.ok, true);
  assert.equal(ev.snapshotPath, bj.teamAsset.snapshotPath);
  assert.equal(ev.assetHash, doc.assetHash);
  assert.ok(Array.isArray(ev.problems) && Array.isArray(ev.unwiredKeys));
  assert.equal(ev.snapshotWriteFailed, undefined, '成功路径不带 snapshotWriteFailed');

  // ⑤ 档先于批次落盘（同一次建批事务内的先后）
  const snapStat = fs.statSync(path.join(dir, fileName));
  const batchStat = fs.statSync(batchFileOf(root, SESSION, 'b1-ok'));
  assert.ok(snapStat.mtimeMs <= batchStat.mtimeMs + 1, '档 mtime 不晚于批次文件（档先于批次落盘）');
});

// ─ D2b：幂等与版本史 ────────────────────────────────────────────────────
test('D2b 幂等（同 hash 不重写）与版本史（改资产 ⇒ 新档 + 旧档留存）', () => {
  const root = tmpRoot('idem');
  const store = createStore(root);
  const dir = snapshotsDirOf(root, SESSION);

  store.createBatch(SESSION, { batchId: 'b2-a', wavePlan: planOf(TEAM) });
  const first = fs.readdirSync(dir);
  assert.equal(first.length, 1);
  const snap0 = fs.statSync(path.join(dir, first[0]));

  store.createBatch(SESSION, { batchId: 'b2-b', wavePlan: planOf(TEAM) });
  assert.deepEqual(fs.readdirSync(dir), first, '同 hash ⇒ 同档（不新增文件）');
  const snap1 = fs.statSync(path.join(dir, first[0]));
  assert.equal(snap1.mtimeMs, snap0.mtimeMs, 'no-op：档不被重写（mtime 不变）');

  // 版本史：临时 teamsRoot（rootKind=teams-root）——改资产 ⇒ 新 hash ⇒ 新档，旧档留存
  const teamsRoot = tmpRoot('teams-root');
  const assetDir = path.join(teamsRoot, 'presets', 'b1-vhist-team');
  fs.mkdirSync(assetDir, { recursive: true });
  const assetFile = path.join(assetDir, 'team-asset.json');
  const assetV1 = {
    team: 'b1-vhist-team',
    layers: { exec: { roles: ['coder'], skills: { coder: ['test-driven-development'] } } },
    flows: { plan: { produce_field: 'produce' }, exec: { produce_field: 'outputs' } },
  };
  fs.writeFileSync(assetFile, JSON.stringify(assetV1, null, 2) + '\n');

  store.createBatch(SESSION, { batchId: 'b2-c', wavePlan: planOf('b1-vhist-team'), teamsRoot });
  const v1 = fs.readdirSync(dir).filter((f) => f.startsWith('b1-vhist-team.'));
  assert.equal(v1.length, 1, '临时团队同样落会话级档');
  const docV1 = JSON.parse(fs.readFileSync(path.join(dir, v1[0]), 'utf8'));
  assert.equal(docV1.rootKind, 'teams-root');
  assert.equal(path.resolve(docV1.root), path.resolve(teamsRoot), 'teamsRoot 批的解析根 = 临时根');
  assert.equal(docV1.summary.produceFieldDeclared.exec, 'outputs');

  const assetV2 = { ...assetV1, flows: { ...assetV1.flows, exec: { produce_field: 'produce' } } };
  fs.writeFileSync(assetFile, JSON.stringify(assetV2, null, 2) + '\n');
  fs.utimesSync(assetFile, new Date(), new Date(Date.now() + 5000)); // 保证签名（mtime）变化

  store.createBatch(SESSION, { batchId: 'b2-d', wavePlan: planOf('b1-vhist-team'), teamsRoot });
  const v2 = fs.readdirSync(dir).filter((f) => f.startsWith('b1-vhist-team.'));
  assert.equal(v2.length, 2, '新版新档 + 旧版旧档留存');
  const docs = v2.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.equal(new Set(docs.map((d) => d.assetHash)).size, 2, '两档 hash 不同');
  assert.deepEqual(
    docs.map((d) => d.summary.produceFieldDeclared.exec).sort(),
    ['outputs', 'produce'],
    '两档各自记录当时声明',
  );
  assert.notEqual(readBatchJson(root, SESSION, 'b2-c').teamAsset.assetHash, readBatchJson(root, SESSION, 'b2-d').teamAsset.assetHash);
});

// ── D3：回显面 = output.schema 键（宿主真实输出校验路径）────────────────────
test('D3 回显面：gate_status / batch_status 值经宿主 createSuccessResult 通过，且含 teamAsset/declaration/declarationMissing', async () => {
  const root = tmpRoot('d3');
  const store = createStore(root);
  assessC(store, SESSION); // G1：wave_plan 建批面要求本会话 C 档
  const byName = makeToolHarness(store, root);
  const exec = SESS_OF(SESSION);

  await byName.wave_plan.execute({ batchId: 'b3-tools', tasks: threeTierTasks(), team: TEAM, assembly: { managerPlan: 'leader-direct', auditLane: 'a1' } }, exec);

  // schema 键齐备（漏补即失败的直接判据）
  assert.ok(byName.gate_status.output.schema.properties.teamAsset, 'gate_status.output.schema.teamAsset');
  assert.ok(byName.gate_status.output.schema.properties.declaration, 'gate_status.output.schema.declaration');
  assert.ok(byName.gate_status.output.schema.properties.declarationMissing, 'gate_status.output.schema.declarationMissing');
  assert.ok(byName.batch_status.output.schema.properties.teamAsset, 'batch_status.output.schema.teamAsset');

  // 真实工具调用（DSL 参数面 + execute）
  const gs = await byName.gate_status.execute({ batchId: 'b3-tools' }, exec);
  assert.ok(gs.teamAsset, 'gate_status.teamAsset 回显');
  assert.ok(gs.declaration, 'gate_status.declaration 回显（当场从正档读出）');
  assert.equal(gs.declarationMissing, false);
  const snapAbs = path.join(snapshotsDirOf(root, SESSION), path.basename(gs.teamAsset.snapshotPath));
  assert.deepEqual(gs.declaration, JSON.parse(fs.readFileSync(snapAbs, 'utf8')), 'declaration = 正档内容（不现算）');
  const hostGs = hostOutputGate(byName.gate_status, gs, { batchId: 'b3-tools' });
  assert.deepEqual(hostGs.value, gs, '经宿主 createSuccessResult 校验通过（未补键 ⇒ 必 ToolOutputError）');

  const bs = await byName.batch_status.execute({ batchId: 'b3-tools' }, exec);
  assert.ok(bs.teamAsset, 'batch_status.teamAsset 回显');
  assert.deepEqual(bs.teamAsset, gs.teamAsset);
  hostOutputGate(byName.batch_status, bs, { batchId: 'b3-tools' });

  // 负控：删掉 schema 键的工具 ⇒ 宿主必拒（证明本探针对「漏补键」有牙，且失败形态为抛错非剥离）
  assert.throws(
    () => hostOutputGate(toolWithoutSchemaKey(byName.gate_status, 'teamAsset'), gs, { batchId: 'b3-tools' }),
    (e) => e instanceof ToolOutputError && /teamAsset/.test(e.message),
    '漏补 schema 键 ⇒ ToolOutputError',
  );
  assert.throws(
    () => hostOutputGate(toolWithoutSchemaKey(byName.batch_status, 'teamAsset'), bs, { batchId: 'b3-tools' }),
    (e) => e instanceof ToolOutputError && /teamAsset/.test(e.message),
  );
  // 同源旁证：宿主 schema 校验函数对未声明键同样报 violation（非静默剥离）
  assert.ok(validateJsonSchemaValue(toolWithoutSchemaKey(byName.gate_status, 'teamAsset').output.schema, gs, 'value').length > 0);

  // 缺档（正档被删）⇒ declaration 键缺席 + declarationMissing:true（不 throw、不现算）。
  //   键缺席 = 规格 §2.2「declaration:null」在本引擎闭集 output.schema 下的**唯一可表达形态**：
  //   已实测 `type:['object','null']` 在两版 dsh-tools 均抛 `unreachable variant in JsonSchemaType`
  //   ⇒ 显式事实由 `declarationMissing:true` 承载（不静默）。
  fs.rmSync(snapAbs);
  const gs2 = await byName.gate_status.execute({ batchId: 'b3-tools' }, exec);
  assert.equal(gs2.declaration, undefined, '缺档 ⇒ declaration 键不写（闭集 schema 无法表达 null）');
  assert.equal(gs2.declarationMissing, true);
  assert.ok(gs2.teamAsset, '批次字段仍在（信息不丢）');
  hostOutputGate(byName.gate_status, gs2, { batchId: 'b3-tools' });
});

// ── D4：缺省零差异 ──────────────────────────────────────────────────────
test('D4 缺省零差异：generic 批不落档/不落事件，判定面读数与无该字段的批次逐字一致', () => {
  const root = tmpRoot('generic');
  const store = createStore(root);
  store.createBatch(SESSION, { batchId: 'b4-generic', wavePlan: planOf('generic') });

  // ② 不出现 team-assets/ 目录（无 hash 不可命名 ⇒ 不落档）
  assert.equal(fs.existsSync(snapshotsDirOf(root, SESSION)), false, 'generic 批不产生 team-assets/ 目录');
  // ③ 字段照写 ok:false 且指纹为空
  const bj = readBatchJson(root, SESSION, 'b4-generic');
  assert.ok(bj.teamAsset, 'batch.teamAsset 照写（失败事实不静默）');
  assert.equal(bj.teamAsset.ok, false);
  assert.equal(bj.teamAsset.assetHash, null);
  assert.equal(bj.teamAsset.assetPath, null);
  assert.equal(bj.teamAsset.snapshotPath, null);
  assert.equal(bj.teamAsset.severity, 'blocking');
  assert.deepEqual(bj.teamAsset.summaryKeys.produceFields, ['produce', 'outputs']);
  assert.equal(bj.events.some((e) => e.type === EVT_RESOLVED), false, '无资产 ⇒ 不落事件（缺省零差异）');

  // ① 判定面读数与「改动前形态」（手写同形批次 JSON，无 teamAsset 键）逐字一致
  const legacy = { ...bj };
  delete legacy.teamAsset;
  legacy.batchId = 'b4-legacy';
  legacy.events = bj.events.filter((e) => e.type !== EVT_RESOLVED).map((e) => (e.type === 'batch.created' ? { ...e, batchId: 'b4-legacy' } : e));
  fs.writeFileSync(batchFileOf(root, SESSION, 'b4-legacy'), JSON.stringify(legacy, null, 2));
  assert.deepEqual(
    store.gateStatus(SESSION, 'b4-generic', 'e1'),
    store.gateStatus(SESSION, 'b4-legacy', 'e1'),
    'gateStatus 读数逐字一致（新字段不参与任何判定/派生面）',
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(store.gateStatus(SESSION, 'b4-generic', 'e1'), 'teamAsset'), 'gateStatus 逐 lane 返回形状不动');
});

// ── D8：读路径零副作用 ──────────────────────────────────────────────────
test('D8 只读面零副作用：连续两次 gate_status 前后，批次文件 mtime 与 sessions/<sid>/ 树清单不变', async () => {
  const root = tmpRoot('ro');
  const store = createStore(root);
  assessC(store, SESSION);
  const byName = makeToolHarness(store, root);
  const exec = SESS_OF(SESSION);
  await byName.wave_plan.execute({ batchId: 'b8-ro', tasks: threeTierTasks(), team: TEAM, assembly: { managerPlan: 'leader-direct', auditLane: 'a1' } }, exec);

  const sessionDir = path.join(root, 'sessions', SESSION);
  const treeBefore = treeOf(sessionDir);
  const batchStatBefore = fs.statSync(batchFileOf(root, SESSION, 'b8-ro')).mtimeMs;
  const snapFilesBefore = fs.readdirSync(snapshotsDirOf(root, SESSION)).map((f) => {
    return { f, m: fs.statSync(path.join(snapshotsDirOf(root, SESSION), f)).mtimeMs };
  });

  await byName.gate_status.execute({ batchId: 'b8-ro' }, exec);
  await byName.gate_status.execute({ batchId: 'b8-ro' }, exec);
  await byName.batch_status.execute({ batchId: 'b8-ro' }, exec);

  assert.deepEqual(treeOf(sessionDir), treeBefore, '目录树不变（读路径不新增/不删除文件）');
  assert.equal(fs.statSync(batchFileOf(root, SESSION, 'b8-ro')).mtimeMs, batchStatBefore, '批次文件 mtime 不变（只读视图绝不发射）');
  assert.deepEqual(
    fs.readdirSync(snapshotsDirOf(root, SESSION)).map((f) => ({ f, m: fs.statSync(path.join(snapshotsDirOf(root, SESSION), f)).mtimeMs })),
    snapFilesBefore,
    '正档不被读路径重写',
  );
});

// ── 边界：解析失败照写档；写档失败不拒建批 ─────────────────────────────────
test('边界：有资产但解析失败 ⇒ 照写档 + 事件；写档失败 ⇒ snapshotWriteFailed 且不拒建批', () => {
  // ① 解析失败（坏 JSON）——照写档、字段/事件如实记录 ok:false
  const root = tmpRoot('badjson');
  const store = createStore(root);
  const teamsRoot = tmpRoot('bad-asset');
  const dir = path.join(teamsRoot, 'presets', 'b1-bad-team');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team-asset.json'), '{ this is not json');
  store.createBatch(SESSION, { batchId: 'b6-bad', wavePlan: planOf('b1-bad-team'), teamsRoot });

  const files = fs.readdirSync(snapshotsDirOf(root, SESSION));
  assert.equal(files.length, 1, '解析失败也照写档（失败事实不跳过）');
  const doc = JSON.parse(fs.readFileSync(path.join(snapshotsDirOf(root, SESSION), files[0]), 'utf8'));
  assert.equal(doc.resolved.ok, false);
  assert.equal(doc.resolved.severity, 'blocking');
  assert.ok(doc.resolved.problems.some((p) => p.includes('TEAM_ASSET_BAD_JSON')));
  const bj = readBatchJson(root, SESSION, 'b6-bad');
  assert.equal(bj.teamAsset.ok, false);
  assert.equal(bj.teamAsset.severity, 'blocking');
  assert.ok(bj.events.some((e) => e.type === EVT_RESOLVED && e.ok === false), '解析失败事件落盘');

  // ② 写档失败（会话目录下 team-assets 被同名文件占位 ⇒ mkdir 失败）——告警 + 双留痕，不拒建批
  const root2 = tmpRoot('writefail');
  const store2 = createStore(root2);
  fs.mkdirSync(path.join(root2, 'sessions', SESSION), { recursive: true });
  fs.writeFileSync(path.join(root2, 'sessions', SESSION, 'team-assets'), 'blocker');
  const b2 = store2.createBatch(SESSION, { batchId: 'b6-wfail', wavePlan: planOf(TEAM) }); // 不得 throw
  assert.equal(b2.teamAsset.snapshotWriteFailed, true);
  assert.equal(b2.teamAsset.snapshotPath, null);
  assert.equal(b2.teamAsset.ok, true, '解析本身没失败（失败的只是派生观察档）');
  const ev2 = b2.events.find((e) => e.type === EVT_RESOLVED);
  assert.ok(ev2, '写档失败仍落事件');
  assert.equal(ev2.snapshotWriteFailed, true);
  assert.equal(ev2.snapshotPath, null);
});