// 灵活装配 × 角色词法白名单 事实核查探针（leader 直做；零依赖，可直接 node 运行）
// ─────────────────────────────────────────────────────────────────────────────
// 用途：不跑测试、直接复现「leader 的灵活装配是否作废」——按**资产的两种声明写法**建批，
//   打印 buildWavePlan 的 warnings 与每条 lane 的 cmd（[role=…] [skills=…] 前缀是否真注入）。
// 由来（2026-09-14）：用户报告「灵活装配指引与角色白名单对不上」；本探针给出两条可复现缺口：
//   C1/C3 词法面不同源（角色只写 layers[*].roles ⇒ 旧读端判 GATE_ROLE_INVALID）
//   C4    缓存陈旧（同进程内改资产不重载 ⇒ 修正隔空失效直到重启）
// 复跑预期（修复后）：C1 = 仅 GATE_ROLE_MISSING×2（牵头未声明，语义保留）；C2/C3 = 零告警；
//   C4-run2 的 extra / leads / warnings **立即**反映新资产（修复前与 run1 逐字相同）。
// 运行：node scripts/probes/flex-assembly-audit.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildWavePlan, normalizeAssemblyDecl, assemblyGate, VALID_ROLES, ROLE_EXTENSIONS } = await import('../../lib/wave-plan.js');
const { resolveAssembly } = await import('../../lib/assembly.js');
const { resolveTeamRoles, unionRoleVocabulary, packageRoot } = await import('../../lib/assembly/flows.js');

const line = (s) => console.log(s);
const PKG_ROOT = packageRoot();

// 【F-8 修复（2026-09-15）】lane 声明补齐 `produce` / `consume` / `outputs`：
//   原声明**全部缺产物字段** ⇒ `buildWavePlan` 的 plan 在场不变量（lib/wave-plan.js 的 GATE_PLAN_PRESENCE_MISSING）
//   直接抛错 ⇒ 探针在第 94 行崩溃、该探针的**覆盖能力整体失效**（既存缺陷，与 F-3 的废键清理无因果）。
//   补法遵循引擎不变量：plan lane 必须声明 `produce`，且**必须被至少一条 lane 消费**（否则 GATE_ORPHAN_PRODUCT 拒建批）。
const tasksOf = () => [
  { id: 'p1', layer: 'plan', role: 'planner', produce: ['plan/spec.md'], cmd: '# plan' },
  { id: 'e1', layer: 'exec', role: 'builder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e1/out.md'], cmd: '# exec1' },
  { id: 'e2', layer: 'exec', role: 'builder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e2/out.md'], cmd: '# exec2' },
  { id: 'e3', layer: 'exec', role: 'builder', deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e3/out.md'], cmd: '# exec3' },
  { id: 'a1', layer: 'audit', role: 'verifier', deps: ['e1', 'e2', 'e3'], consume: ['plan/spec.md', 'exec/e1/out.md', 'exec/e2/out.md', 'exec/e3/out.md'], produce: ['audit/a.md'], cmd: '# audit' },
];

// 按**该团队自己声明的角色**生成 lane（角色词法集是 per-team 的：换团队而角色不换 = 真·用错角色，本就该告警）
// 【F-8 修复同步】同 `tasksOf`：lane 必须带产物字段（plan `produce` 且被消费），否则 plan 在场不变量拒建批。
function tasksFromAsset(asset) {
  const rolesOf = (l) => (asset.layers?.[l]?.roles ?? []);
  const t = [{ id: 'p1', layer: 'plan', role: rolesOf('plan')[0], produce: ['plan/spec.md'], cmd: '# plan' }];
  const exec = rolesOf('exec');
  for (let i = 0; i < 3; i++) t.push({ id: 'e' + (i + 1), layer: 'exec', role: exec[i % exec.length], deps: ['p1'], consume: ['plan/spec.md'], outputs: ['exec/e' + (i + 1) + '/out.md'], cmd: '# exec' + (i + 1) });
  t.push({ id: 'a1', layer: 'audit', role: rolesOf('audit')[0], deps: ['e1', 'e2', 'e3'], consume: ['plan/spec.md', 'exec/e1/out.md', 'exec/e2/out.md', 'exec/e3/out.md'], produce: ['audit/a.md'], cmd: '# audit' });
  return t;
}

const assetOf = ({ extra = null, leads = null } = {}) => ({
  manifest: { version: 1, requires_engine: '>=0.4.4', hash: 'x', source: 'probe' },
  ...(extra || leads ? { roles: { ...(extra ? { extra } : {}), ...(leads ?? {}) } } : {}),
  layers: {
    plan: { roles: ['planner'], skills: { planner: ['spec-writing'] } },
    exec: { roles: ['builder'], skills: { builder: ['test-driven-development'] } },
    audit: { roles: ['verifier'], skills: { verifier: ['acceptance-gate'] } },
  },
  // 【legacy 废键清理（lane e3）】原 `flows.complete` 段的已废键 `require_` + `audit_outcomes` 声明**整行删除**：
  //   该键已于 `legacy-retire-20260915`（E-4）**完全清退**（lib/assembly/team-asset.js:266-270；读端唯一真源 =
  //   `flows.audit.audit_contract.verdict`，见 lib/state/gates.ts:395）⇒ 探针内保留该声明属「写了不生效」的欺骗面。
  //   故本文件对该键 0 命中（E3-A1 判据）；`flows.complete` 整段消失 ⇒ 与 F-4（complete 层合法性）无交互。
  flows: {
    plan: { produce_field: 'produce', entry_requires: [], contract: { artifact_globs: ['plan/*spec.md'], required_sections: ['## 验收标准', '## 约束'] } },
    exec: { produce_field: 'outputs', consume_field: 'consume', entry_requires: ['consume'], targets: true, gate_command: true },
    audit: { produce_field: 'produce', consume_field: 'consume', entry_requires: ['consume'], needhuman: true, audit_contract: { criteria_from: 'plan/**', consumes_required: ['plan/', 'exec/'], verdict: ['pass', 'fail', 'skip'] } },
  },
  state_machine: { kind: 'tighten-only', overrides: {} },
});

// write=false ⇒ **只读**该根（包内团队用：探针绝不往包内 `presets/` 写文件——
//   曾因误用同一入口在包内留下 4 份 `team-asset.json`，被 `test/writing-team-asset.test.js` 的资产路径断言逮住）
function build(root, team, asset, tag, { taskList = null, write = true } = {}) {
  if (write) {
    const dir = join(root, 'presets', team);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'team-asset.json'), JSON.stringify({ ...asset, team }, null, 2), 'utf8');
  }
  const tasks = taskList ?? tasksOf();
  const roles = resolveTeamRoles(team, { root });
  const vocab = roles.ok ? unionRoleVocabulary(roles) : [];
  const asmResolved = resolveAssembly(team, null, { root });
  const allRoles = [...new Set(Object.values(asset.layers ?? {}).flatMap((l) => l.roles ?? []))];
  const asm = normalizeAssemblyDecl({ managerPlan: 'raise', auditLane: 'a1', coordinatorLane: 'p1', roles: allRoles }, vocab);
  const plan = buildWavePlan({ batchId: 'probe-' + team, tasks, concurrency: 3, team, assembly: asmResolved ?? undefined, teamsRoot: root });
  const gate = assemblyGate(plan.wavePlan.flatMap((w) => w.tasks), asm.decl);
  const codes = plan.warnings.map((w) => w.code + (w.role ? ':' + w.role : '') + (w.missing ? ':' + w.missing : ''));
  line('── ' + tag + ' (team=' + team + ')');
  line('   roles.extra=' + JSON.stringify(roles.extra) + ' lexVocab=' + JSON.stringify(vocab));
  line('   plan_leads=' + JSON.stringify(roles.planLeads) + ' audit_leads=' + JSON.stringify(roles.auditLeads) + ' asmGate=' + (gate === 'ok' ? 'ok' : gate.code));
  line('   warnings=' + (codes.length ? JSON.stringify(codes) : '[] (零告警)'));
  for (const w of plan.wavePlan) for (const t of w.tasks) line('   lane ' + t.id + ' -> ' + t.cmd);
  return codes;
}

line('白名单基线: VALID_ROLES=' + JSON.stringify(VALID_ROLES) + ' ROLE_EXTENSIONS=' + JSON.stringify(ROLE_EXTENSIONS));
line('包根 = ' + PKG_ROOT);
const ROOT = mkdtempSync(join(tmpdir(), 'flexprobe-'));
line('临时根 = ' + ROOT);
line('');

// ① 包内四团队（内置路径对照）：lane 角色取**各自资产**声明，应零告警 + 前缀逐字按各自资产
for (const team of ['software-team', 'design-team', 'research-team', 'writing-team']) {
  const asset = JSON.parse(readFileSync(join(PKG_ROOT, 'presets', team, 'team-asset.yml'), 'utf8'));
  build(PKG_ROOT, team, asset, 'pkg-' + team, { taskList: tasksFromAsset(asset), write: false });
  line('');
}

// ② 临时团队四种写法（leader 灵活装配的实际写法；各自独立 team 名 ⇒ 缓存键隔离）
const cases = [
  ['C1 只写 layers.roles（无 roles 段、无牵头）', 'probe-c1', assetOf({})],
  ['C2 layers.roles + roles.extra + leads（旧指引口径）', 'probe-c2', assetOf({ extra: ['planner', 'builder', 'verifier'], leads: { plan_leads: ['planner'], audit_leads: ['verifier'] } })],
  ['C3 layers.roles + 仅 plan/audit_leads（无 extra）', 'probe-c3', assetOf({ leads: { plan_leads: ['planner'], audit_leads: ['verifier'] } })],
];
for (const [tag, team, asset] of cases) {
  build(ROOT, team, asset, tag);
  line('');
}

// ③ 缓存陈旧性：同 team、同 root，先建批，再按告警补声明、重建批（**不清缓存**）
line('== C4 同进程内「先建批 → 按告警改资产 → 重建批」（缓存新旧判定）==');
build(ROOT, 'probe-c4', assetOf({}), 'C4-run1（资产无 roles 段、无牵头）');
build(ROOT, 'probe-c4', assetOf({ extra: ['planner', 'builder', 'verifier'], leads: { plan_leads: ['planner'], audit_leads: ['verifier'] } }), 'C4-run2（同 team 同 root，资产已补 extra+leads）');
