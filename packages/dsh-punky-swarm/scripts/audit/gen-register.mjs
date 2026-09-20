// 生成 docs/frozen-register-2026-09-21.md（冻结登记）
//   用法：cd packages/dsh-punky-swarm && node scripts/audit/dead-code2.mjs && node scripts/audit/classify.mjs && node scripts/audit/gates.mjs && node scripts/audit/gen-register.mjs
//   本文件 2026-09-21 由 scripts/audit/out/ 迁入 scripts/audit/（原位置在 gitignore 的 out/ 内 ⇒ 登记不可复现）。
import fs from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'scripts', 'audit', 'out');
const unwired = JSON.parse(fs.readFileSync(join(OUT, 'unwired-summary.json'), 'utf8'));
const ledger = JSON.parse(fs.readFileSync(join(OUT, 'gate-ledger.json'), 'utf8'));

const norm = (s) => s.replace(/\\/g, '/');
const TS_BACKED = new Set([
  'lib/schema', 'lib/state/schema-v3', 'lib/state/machine-rules', 'lib/state/gates',
  'lib/wave-plan', 'lib/types/contracts',
  'lib/governance/types', 'lib/governance/decisions', 'lib/governance/classify',
  'lib/governance/narrow', 'lib/governance/tool-ban', 'lib/governance/config',
  'lib/governance/kernel', 'lib/governance/preset-loader', 'lib/governance/index',
]);
const dedupe = (arr) => {
  const m = new Map();
  for (const r of arr) {
    const f = norm(r.file).replace(/\.(d\.ts|ts|js)$/, '');
    const k = f + '::' + r.name;
    if (!m.has(k)) m.set(k, { base: f, name: r.name, tests: r.testUse || 0, ts: TS_BACKED.has(f) });
  }
  return [...m.values()];
};

const c1 = dedupe(unwired.C1).sort((a, b) => b.tests - a.tests || a.base.localeCompare(b.base));
const b1kept = dedupe(unwired.B1).sort((a, b) => a.base.localeCompare(b.base));

// 非码 GATE_* 标识符（前缀伪影 / 正则常量 / 环境变量名 / 已退役码留痕）——**不得**计入门禁口径
const ghosts = ledger.filter((r) => r.kind === 'ghost');
const nonCodes = ledger.filter((r) => !['typed', 'thrown'].includes(r.kind));
const libOnly = ledger.filter((r) => ['typed', 'thrown'].includes(r.kind) && r.prod.length > 0 && r.testHits === 0);
const kindCount = (k) => nonCodes.filter((r) => r.kind === k).length;

// 门禁码 → [类别, 拦什么]（人工判读，随新引擎形态重议）
const GATE_CLASS = {
  GATE_ARTIFACT_MISSING: ['哨兵', '产物在场判定的**内部哨兵**：出口门将其改写为 `GATE_EXIT_MISSING_<LAYER>`（缺在场按层族回落），不直接外显'],
  GATE_COMPLETE_EXEC_PENDING: ['收口主门', 'exec 层未全部终态即拒 complete（`pending` 回显待收 lane）'],
  GATE_COMPLETE_NO_AUDIT: ['收口主门', '批内 audit 层为空即拒 complete'],
  GATE_NO_DECLARATION: ['判据门', 'presence 契约：声明清单为空' ],
  GATE_EXEC_INPUT_MISSING: ['建批门', 'exec lane 未消费 `plan/` 产物（批级 `consumes_required` / 逐 lane `_per_lane` 两档）'],
  GATE_DIFFICULTY_INVALID: ['工具门', '`assign_check` 的 difficulty 非 A\\|B\\|C（无默认档）'],
  GATE_DIFFICULTY_RATIONALE_MISSING: ['工具门', '`assign_check` 的 rationale 缺失或 < 12 字'],
  GATE_EVENT_CONST_MISSING: ['fail-closed 守卫', '事件常量缺位时**拒绝写入**（防落 `type:undefined` 污染审计面）'],
  GATE_HANDOFF_LEGACY_PASSTHROUGH: ['留痕码', '入口侧：存量批无 `batch.handoffs` ⇒ 放行**但留痕**（不静默、不砸存量）'],
  GATE_HANDOFF_SETTLE_LEGACY_PASSTHROUGH: ['留痕码', '出口侧：同上（结算侧镜像）'],
  GATE_SKILL_MISSING: ['告警码', '技能在宿主技能根不可解析 ⇒ 建批留痕告警（`plan.warnings`，不阻断建批）'],
};

const lines = [];
lines.push('# 冻结登记 · 2026-09-21（R2 清理波）');
lines.push('');
lines.push('> 本文件是**冻结项的单一台账**。冻结 = 「已声明但当前不接线 / 不修改 / 不删除」，等新引擎形态定后逐项裁定。');
lines.push('> **纪律：本表内任何符号不得被当作 AI 幻觉产物删除。** 撤销冻结必须回到本表逐项改判并留痕。');
lines.push('');
lines.push('- 基线：`e3e8cd0` → 清理波后 `5a6ce2a` → 台账修正 `c995832`');
lines.push('- 裁定依据：W2（未接线不接）/ W4（schema 随新引擎形态取舍）/ ②（无断言门禁：复核后**不删**，冻结）/ ①（B1 残留 10 项先留着）/ ③（审计追踪：生成器入库 + `--check` 软比对）');
lines.push('- 生成器：`scripts/audit/gen-register.mjs`（2026-09-21 由 gitignore 的 `out/` 迁入版本控制 ⇒ 登记可复现）');
lines.push('- 复现：`node scripts/audit/dead-code2.mjs && node scripts/audit/classify.mjs && node scripts/audit/gates.mjs && node scripts/audit/gen-register.mjs`');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## 1. C1 · 生产未接线（' + c1.length + ' 项，W2 冻结）');
lines.push('');
lines.push('判据：**生产路径零调用，仅测试引用**（且本文件内部也不使用）⇒ 声明面先行、运行面欠账。');
lines.push('');
lines.push('| 文件 | 符号 | 测试引用 | ts 源 |');
lines.push('|---|---|---:|---|');
for (const x of c1) lines.push(`| \`${x.base}.js\` | \`${x.name}\` | ${x.tests} | ${x.ts ? '✅' : '—'} |`);
lines.push('');
lines.push('### 其中特别标注（属测试基础设施，不可删）');
lines.push('');
lines.push('- `lib/bridge/lane-handle.js` `__resetLaneHandles`（66 处测试调用）、`sweepExpiredHandles`');
lines.push('- `lib/assembly/flows.js` `clearFlowCache`（67 处）、`clearRoleCache`（85 处）——测试隔离必需');
lines.push('');
lines.push('### 新引擎成型时的裁定口径（三选一，逐项落）');
lines.push('');
lines.push('1. **接线**：有安全价值者（`assertMemberTransition` / `assertBatchTransition` / `artifactTypeOf` / `typesOfLayer` / `sweepExpiredHandles` / `clear*Cache`）。参考 jiuwen `agent_teams/tools/task_manager.py` 的 `TaskResult` / `GraphMutationResult`——变更返回**显式结果对象**而非仅 throw。');
lines.push('2. **降级**：测试专用面显式登记为测试钩子（去 `export` 则断测试，故只能保留）。');
lines.push('3. **删**：无价值者（`validateAssembly` / `assertAssemblyCompleteness` 撤函数**保常量表**——`BLIND_REVIEW_ROLES` 被 `wave-plan.ts` 消费、`PRODUCE_LAYERS` / `FLOW_SECTIONS` 被 `team-asset.js` 消费）。');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## 2. B1 残留 · 真死但自带声明语义（' + b1kept.length + ' 项，冻结不删）');
lines.push('');
lines.push('判据：**内外皆零引用，但注释自带显式声明语义**（预留格式 / 骨架契约 / 白名单 / 外部规范对齐 / 版本口径 / 读端契约名）⇒ 删除等于替用户裁定「这声明还要不要」。');
lines.push('');
lines.push('| 文件 | 符号 | 声明语义 |');
lines.push('|---|---|---|');
const WHY = {
  CHAIN_VERSION: '版本口径（`CHAIN_VERSIONS[0]` = 缺省语义版本）',
  CHAIN_GUIDANCE_INJECTS: '`flows.<layer>.guidance.inject` 白名单（禁自由文本）',
  flowsDeclarationOf: '自述「gateStrength / 诊断面板的取数入口」',
  renderVerdictReport: '自述「落盘格式（**预留**：audit/verify-verdict.md）」',
  workerResumeChapter: '自述「**骨架**，增强恢复落地后填充」+ `enabled:false` 声明面',
  REASON_EXEMPT_CLEARED: '读端契约名（读端走字面量，本批无写者）',
  FORWARD_DEPTH_LIMIT_DEFAULT: '节标题「与 `acps_sdk/adp/constants.py` 一致」⇒ 外部规范对齐表',
  FORWARD_FANOUT_LIMIT_DEFAULT: '同上（外部规范对齐表）',
  FORWARD_EACH_TIMEOUT_MS_DEFAULT: '同上（外部规范对齐表）',
  FORWARD_TOTAL_TIMEOUT_MS_DEFAULT: '同上（外部规范对齐表）',
};
for (const x of b1kept) lines.push(`| \`${x.base}.js\` | \`${x.name}\` | ${WHY[x.name] || '（见源码注释）'} |`);
lines.push('');
lines.push('**裁定 ①（2026-09-21）**：**先留着，等新引擎落地再议** —— 这些符号的存废取决于新形态是否还需要该声明面，属设计决策而非清理决策。');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## 3. 无断言门禁（' + libOnly.length + ' 个，冻结）');
lines.push('');
lines.push('判据：**有生产引用但测试零断言**。硬拒收口门漏断言 = 白盒测试绿 ≠ 生产路径走过。');
lines.push('');
lines.push('**口径（2026-09-21 v3 定稿）**：台账**拒码真源 = `lib/types/contracts.ts` 的 `GateErrorCode` union**；');
lines.push('正则 `\\bGATE_[A-Z0-9_]+\\b` 只作**候选收集器**，候选再按「出现上下文」分类，非码一律移出本口径。');
lines.push('本表 = `kind ∈ {typed, thrown}` + 有生产引用 + 测试零命中。逐项判读见下。');
lines.push('');
lines.push('**两次勘误（均由「乐观污染」触发：让『没覆盖』看起来像『已覆盖』）**：');
lines.push('- v1（原始）在**源码原文**上计数 ⇒ **注释里提到某码**也算「有断言 / 有生产引用」。实测：在新增测试的注释里写一句 `GATE_ARTIFACT_MISSING`，其 `testHits` 由 0 变非 0，`--check` 误报「已消除无断言项」。');
lines.push('- v2 **去注释**（`scripts/audit/gates.mjs` 的 `shieldComments`；刻意**不**去字符串——断言普遍写成 `\'GATE_X\'` 字面量，必须计入）。');
lines.push('- v3 **改用拒码真源**：正则把 `GATE_*` 的**非码标识符**也当码收，实测混入 ' + nonCodes.length + ' 个（正则常量 ' + kindCount('regexConst') + ' · 环境变量名 ' + kindCount('envVar') + ' · 前缀伪影 ' + kindCount('ghost') + ' · 已退役码留痕 ' + kindCount('mention') + '）。');
lines.push('  · 环境变量名（**不是码**）：`GATE_ENABLED`（逃生阀）· `GATE_REPO_ROOT` · `GATE_TARGETS_MODE` · `GATE_TIMEOUT_MS` · `GATE_RETRY` · `GATE_MAX_OUTPUT_BYTES` · `GATE_FORBIDDEN_RE`');
lines.push('  · 正则常量（**不是码**）：`' + nonCodes.filter((r) => r.kind === 'regexConst').map((r) => r.id).join('` / `') + '`');
lines.push('  · 前缀伪影：`' + ghosts.map((g) => g.id).join('` / `') + '` 是源码模板拼接（`\'GATE_EXIT_MISSING_\' + layer`）被正则截成的残片');
lines.push('  · 已退役码留痕：`' + nonCodes.filter((r) => r.kind === 'mention').map((r) => r.id).join('` / `') + '`（`lib/types/contracts.ts:415-428` / `lib/state/store.js:930` 逐字记「已删除」）');
lines.push('');
lines.push('**P0 两枚**（收口主门，此前零断言 ⇒ 已由 R3-1 补**生产路径 E2E 断言**离榜）：`GATE_COMPLETE_EXEC_PENDING` / `GATE_COMPLETE_NO_AUDIT`（`test/complete-tier-gate-e2e.test.js`）。');
lines.push('> 原记「P0 三枚」，第三枚 `GATE_ARTIFACT_MISSING` 经复核为**假缺口**：它是出口门内部哨兵，按设计被重写为 `GATE_EXIT_MISSING_<LAYER>` 才外显，而该外显形态已有 12 处断言 / 3 套件（`GATE_EXIT_MISSING_AUDIT` 3 · `GATE_EXIT_MISSING_EXEC` 9）。');
lines.push('');
lines.push('| 门禁码 | 类别 | 拦什么 | 生产引用点 |');
lines.push('|---|---|---|---|');
for (const r of libOnly) {
  const [cls, what] = GATE_CLASS[r.id] ?? ['（待判读）', '（见源码）'];
  lines.push(`| \`${r.id}\` | ${cls} | ${what} | ${r.prod.map((s) => s.replace(/\\/g, '/')).join(' · ')} |`);
}
lines.push('');
lines.push('**裁定（2026-09-21，替代原 W6「都删」）**：**不删，冻结至新引擎落地**。');
lines.push('');
lines.push('- 原裁定「无断言门禁都删」所依据的清单（上游报告记 15）**含 2 个前缀伪影**（`GATE_EXIT_` / `GATE_EXIT_MISSING_`，模板拼接 `\'GATE_EXIT_MISSING_\' + layer` 被正则截出的残片），照字面执行会去删两个不存在的码。');
lines.push('- 去伪影后逐枚实地看过（v2 口径 11 项），抛出点**全在生产路径上** —— 收口主门 ×2（exec 未终态 / 无 audit ⇒ 拒 complete）、判据门、建批门（exec 未消费 `plan/`）、工具门 ×2（`assign_check` 难度档位与判据）、fail-closed 守卫（事件常量缺位 ⇒ 拒写入）、留痕/告警码 ×3、哨兵 ×1。其中两枚收口主门已由 R3-1 补测离榜，余 9 项为当前冻结面。');
lines.push('- 它们 `testHits = 0` ⇒ **删除效果无法由测试判定**（可能静默放行，也可能被别的门先拦而"看起来没变化"）⇒ 属**静默回归风险**，不是等价重构；且删门禁是**行为变更**，与蓝图 §2「修改/重构 = 本波不做」冲突。');
lines.push('');
lines.push('**勘误链**：上游甄别报告记「15 个」→ v1 台账（含注释污染 + 前缀伪影 + 非码标识符）**15** → v2 去注释 **11** → v3 拒码真源口径 **9**（其中两枚收口门已由 R3-1 补测离榜）。');
lines.push('');
lines.push('**解冻口径**：新引擎定型后按功能重议，**补测优先于删码**，且必须补**生产路径 E2E 断言**（不是白盒直调 `createGates`）。');
lines.push('');
lines.push('参考：jiuwen `schema/status.py:274-302` 的**两个镜像闸**（`PLANNING` 前 / `IN_REVIEW` 后，逐字 structurally identical mirrors）⇒ 蟛蜞 entry/exit 对偶门应有对称断言组。');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## 4. schema 循环依赖（W4 冻结，给决策树）');
lines.push('');
lines.push('**实测**：`lib/schema.ts:244` 注释逐字承认 `lib/schema.ts ⟷ lib/assembly/schema.js` **顶层循环依赖**（assembly 顶层初始化需本文件常量，静态 import 会 TDZ）。现靠运行时时序侥幸，属结构性定时炸弹。');
lines.push('');
lines.push('| 新引擎形态 | 处置 |');
lines.push('|---|---|');
lines.push('| 保留独立的 `assembly` 层 | 把 assembly 顶层初始化所需常量**下沉为独立叶子模块**（`lib/state/constants.js` 已是先例），让 `schema.ts` 单向依赖 |');
lines.push('| 并入其他层 | 随并层自然消失，不需专门消环 |');
lines.push('| 本波 | **不动**（动 `schema.ts` 波及 43 个门禁码的类型面，须独立波 + 独立 commit） |');
lines.push('');
lines.push('参考：jiuwen `workflow/engine/primitives.py:67` `_MAX_WORKFLOW_DEPTH = 1`（子工作流 = 独立脚本 + 自己的 META）⇒ **用文件边界切依赖层**；与 Onto `SUB_FLOW_CALL` 不得成环（v6 `:2530`）同构。');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## 5. C2 · 白盒面（200 项，非冗余，登记备查）');
lines.push('');
lines.push('判据：**仅测试引用，但本文件内部已消费** ⇒ `export` 多余却**不可去**（去 export 会断 200 处测试引用）。');
lines.push('');
lines.push('> 判读：这 200 项把「未接线」这件事**测没了**——测试直捅内部实现，测试绿只证明内部函数对，不证明生产路径走了它。');
lines.push('> 这是 ' + libOnly.length + ' 个无断言门禁（§3）的同一枚硬币另一面，处置同归 §3 裁定（冻结至新引擎落地）。');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## 6. 冻结项处置纪律');
lines.push('');
lines.push('1. **不得删**：本表 §1 / §2 / §3 的符号在后续任何「清理 AI 幻觉产物」的 wave 中**一律跳过**，除非回到本表对应行改判并留痕。§5 的 200 项仅可去 `export` 之念，不可去 `export` 之实（会断测试引用）。');
lines.push('2. **不得静默接线**：接线属行为变更，须新引擎形态先定 + 独立 commit + 补对应测试。');
lines.push('3. **改判留痕**：撤销冻结时，在本文件对应行加「解冻日期 + 依据 + commit」。');
lines.push('4. **单一强制点**：接线时不得新写一套，必须接既有实现（`tools/core.js:349` 逐字「禁各写一套」）。');
lines.push('5. **不得以「无断言」为删除理由**：`testHits = 0` 只证明**测试没覆盖**，不证明**代码是死的**。缺断言 ⇒ 先补测（生产路径 E2E），补完再判要不要删。');

fs.writeFileSync(join(process.cwd(), 'docs', 'frozen-register-2026-09-21.md'), lines.join('\n') + '\n');
console.log('-> docs/frozen-register-2026-09-21.md  (' + lines.length + ' 行)');
console.log('C1=' + c1.length + ' B1残留=' + b1kept.length + ' 无断言门禁=' + libOnly.length + ' 前缀伪影(剔除)=' + ghosts.length);
