#!/usr/bin/env node
// 只读校验：**Agent 指引双层同步**（注入面 agent.cordis.yml ↔ 正文 references/discipline.md）
//           + **repo ↔ live 副本一致性**（同一 preset 的两份落地）。
//
// 用法：
//   node scripts/check-guidance-sync.mjs                校验（repo 侧 + 缺省 live 路径）
//   node scripts/check-guidance-sync.mjs --live <dir>   指定 live preset 目录
//   node scripts/check-guidance-sync.mjs --no-live      跳过 live 面（仅校验注入面 ↔ 正文）
//   node scripts/check-guidance-sync.mjs --json         机读输出
//
// 参数纪律（fail-closed）：未知参数 / `--live` 缺值 / `--live` 与 `--no-live` 并用 ⇒ 用法打 stderr、exit 2。
// 退出码：0 = 全绿；1 = 有失败项；2 = 参数错误。
//
// 三条判据（与 discipline.md §11/§12 的「指引同步」口径同源）：
//   ① repo ↔ live：preset 五件的 sha256 必须逐字相同（改指引必须双副本同 sha）
//   ② 正向：注入面内联清单里每个 `#§X` 指针，必须在正文里真实存在
//   ③ 反向：正文里每个 `## §X` 小节，必须在注入面内联清单里有一行（详情面白名单除外）
//
// 详情面白名单（DETAIL_ONLY）：引擎侧接线细节、**刻意不进注入面**的小节；新增白名单项须在本行写明理由。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PRESET_REL = path.join('presets', 'punky-preset');
const GUIDANCE = 'agent.cordis.yml';
const BODY = path.join('references', 'discipline.md');
// 2026-10-21 新增：`cordis.patch.yml` 是**实际注入源**（boot 期由 loader 组合进 profile)。
//   它与 preset 的 `agent.cordis.yml` 是同一份 persona 的**两份定义**，历史上曾分叉
//   （patch 缺 0i、§0 为旧短版）而长期无人发现 ⇒ 本脚本新增 persona 一致性检查。
const PATCH = 'cordis.patch.yml';
const SYNC_FILES = [
  GUIDANCE,
  BODY,
  path.join('references', 'manager.md'),
  'preset.yml',
  'asset-manifest.json',
];

// 详情面白名单：这些小节**刻意不进注入面**（引擎接线细节，按需读正文即可）。
//   0m 派发套件落地细节｜0n 模式跟随装载口径｜0o 团队标签与团队资产口径（2026-09-27 订正：team 降为可选标签）
//   0j 临时组队与 Leader 编排纪律｜0l 能力发现前置（本部署实机检索口径）
// ⚠ 2026-09-26 用户裁决「**指引中不提及挂起内容**；落盘挂起内容快照，之后再回写」⇒ 已从正文**整体移出** 4 节：
//   §0f（L0 watch 消费协议）｜§0g（Leader 唤醒协议 · Manager 代劳指挥）｜
//   §0h（longrun 长程豁免 R-3）｜§0i（消费留痕与 D-1 纪律版）
//   ⇒ 原文**逐字**存档于 `reports/onto-suspended-items-snapshot-20260926.md`（§三），解挂时按该件回写。
//   ⇒ 故本白名单**同步移除** `0f`/`0g`/`0h`（正文已无该节，留着是永不匹配的死项）
//     与 `0r`（本就无正文节，属历史残留）。
const DETAIL_ONLY = new Set(['0m', '0n', '0o', '0j', '0l']);

const USAGE = `用法：
  node scripts/check-guidance-sync.mjs [--live <dir>] [--no-live] [--json]

  --live <dir>  live preset 目录（缺省 ${path.join('%USERPROFILE%', '.dsh', '.agent-presets', 'punky-preset')}）
  --no-live     跳过 repo↔live 面
  --root <dir>  以指定目录为包根（缺省=脚本上级目录）；仅用于变异测试/CI 隔离沙箱
  --self-test   跑检查逻辑的自证夹具（等价必绿 / 缺条目·改文本·多条目必红）
  --json        机读输出
`;

function parseArgs(argv) {
  const out = { live: undefined, noLive: false, json: false, selfTest: false, root: undefined, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--no-live') { out.noLive = true; continue; }
    if (a === '--self-test') { out.selfTest = true; continue; }
    if (a === '--root') {
      if (out.root !== undefined) { out.error = '--root 重复出现'; return out; }
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { out.error = '--root 缺少目录参数'; return out; }
      out.root = v; i += 1; continue;
    }
    if (a === '--live') {
      if (out.live !== undefined) { out.error = '--live 重复出现'; return out; }
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { out.error = '--live 缺少目录参数'; return out; }
      out.live = v; i += 1; continue;
    }
    out.error = `未知参数：${a}`;
    return out;
  }
  if (out.live !== undefined && out.noLive) out.error = '--live 与 --no-live 不能并用';
  return out;
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function sectionsOf(bodyText) {
  const ids = [];
  for (const line of bodyText.split(/\r?\n/)) {
    const m = /^## §([0-9]+[a-z]?)\s/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function inlineEntriesOf(guidanceText) {
  const out = [];
  // 2026-09-18 清债轮：原载荷含 `line: i + 1`——全文件**零读点**（失败文案只用 `e.id`）⇒ 连同 `forEach` 的
  //   下标参数一并删除（死字段 + 死参数）。只保留有消费的两项：`id`（清单/反向查重）与 `pointers`（正向校验）。
  guidanceText.split(/\r?\n/).forEach((line) => {
    // ⚠ 2026-09-25 改动：缩进判定由**恰好 6 空格**放宽为 **≥6 空格**（`/^\s{6,}/`）。
    //   ■ 改动当时的名义理由：注入面据称要改为 `@deepseek-ai/dsh-agent-preset` 的 `plugins` 形态，
    //     条目会多一层缩进 ⇒ 严格 6 匹配落空。
    //   ■ ⚠ **该前提已不成立**：A-3（改 `plugins` 形态）**已于同日回滚**（repo=live=`CC517E91E3550D62`）。
    //   ■ ⚠ 且此放宽**疑似「未裁决的设计」**（用户 2026-09-26 裁决：**需注明背景、不下结论**）。
    //   ■ 现状事实（2026-09-26，由 onto-worker-notify 批 accept lane 报出 AU-05）：**放宽是 load-bearing** ——
    //     当前注入面条目缩进 > 6（`cordis.patch.yml` 的 `prefix:` 段内）⇒ **严格 6 会解析到 0 条**、
    //     放宽得 26 条；**两种口径都 exit 0**（条目数下降**不等价于**失败，故不会自曝）。
    //   ■ ⇒ **待裁项**：① 认定放宽正确（并在正文注明其 load-bearing）｜② 改为**按结构解析**
    //     （在 `prefix:` 段内按 `NN.` / `NNa.` 行匹配，不依赖缩进宽度）。
    //   ■ **未裁前保持现状（放宽），不得单方面改回严格。**
    const m = /^\s{6,}([0-9]{1,2}[a-z]?)\.\s+(\S.*)$/.exec(line);
    if (!m) return;
    const pointers = [...m[2].matchAll(/#§([0-9]+[a-z]?)/g)].map((x) => x[1]);
    out.push({ id: m[1], pointers });
  });
  return out;
}

// 2026-10-21 新增：逐条抽取纪律条目（id → 正文），用于两份 persona 定义的一致性比对。
//   判据刻意用「结构行匹配」`^\s+NN[a-z]?\.` 而非缩进宽度 —— 与 AU-05 待裁的缩进口径**解耦**，
//   避免本检查被那个未裁项连带（该待裁项明令「未裁前保持现状，不得单方面改回严格」）。
function personaRulesOf(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+([0-9]{1,2}[a-z]?)\.\s+(\S.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

// 纯函数：比对两份纪律条目，返回失败项（供主流程与 --self-test 共用，保证「测的就是跑的」）。
function diffPersonaRules(a, b, labelA, labelB) {
  const out = [];
  for (const id of a.keys()) {
    if (!b.has(id)) out.push(`§${id} 仅存在于 ${labelA}`);
  }
  for (const id of b.keys()) {
    if (!a.has(id)) out.push(`§${id} 仅存在于 ${labelB}`);
  }
  for (const [id, ta] of a) {
    const tb = b.get(id);
    if (tb !== undefined && tb !== ta) out.push(`§${id} 文本不一致（${labelA} 与 ${labelB}）`);
  }
  return out;
}

// 2026-10-21 新增自查：证明「本检查真的会红」。
//   纪律依据：任何「一致/通过」类判据若不配可失败对照，就无法区分「检查通过」与「检查根本没生效」。
//   本函数用三组合成夹具断言 —— 等价必绿、缺条目必红、改文本必红。
function runSelfTest() {
  const base = personaRulesOf('                0. alpha\n                1. beta\n');
  const same = personaRulesOf('                0. alpha\n                1. beta\n');
  const missing = personaRulesOf('                0. alpha\n');
  const changed = personaRulesOf('                0. alpha\n                1. beta-CHANGED\n');
  const extra = personaRulesOf('                0. alpha\n                1. beta\n                2. gamma\n');

  const rows = [];
  const eq = diffPersonaRules(base, same, 'A', 'B');
  if (eq.length !== 0) rows.push('✗ 等价两份被误判为不一致：' + eq.join('; '));
  if (!diffPersonaRules(base, missing, 'A', 'B').some((d) => d.includes('仅存在于'))) rows.push('✗ 缺条目未被检出');
  if (!diffPersonaRules(base, changed, 'A', 'B').some((d) => d.includes('文本不一致'))) rows.push('✗ 文本漂移未被检出');
  if (!diffPersonaRules(base, extra, 'A', 'B').some((d) => d.includes('仅存在于'))) rows.push('✗ 多出条目未被检出');

  if (rows.length) {
    process.stderr.write(rows.join('\n') + '\n');
    return 1;
  }
  process.stdout.write('[guidance] SELF-TEST PASS：等价必绿 / 缺条目必红 / 文本漂移必红 / 多出条目必红\n');
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) process.exit(runSelfTest());
  if (args.error) {
    process.stderr.write(`[guidance] 参数错误：${args.error}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const failures = [];
  const notes = [];
  // `--root` 仅用于变异测试 / CI 隔离沙箱：让检查跑在临时副本上，从而能证明「它真的会红」，
  //   不必改动受版本控制的真实文件。
  const rootDir = args.root ? path.resolve(args.root) : ROOT;
  const repoPreset = path.join(rootDir, PRESET_REL);
  const guidancePath = path.join(repoPreset, GUIDANCE);
  const bodyPath = path.join(repoPreset, BODY);
  for (const p of [guidancePath, bodyPath]) {
    if (!fs.existsSync(p)) failures.push({ check: 'presence', detail: `缺文件：${p}` });
  }
  if (failures.length) {
    process.stderr.write(failures.map((f) => `[guidance] ${f.detail}`).join('\n') + '\n');
    process.exit(1);
  }

  const guidanceText = fs.readFileSync(guidancePath, 'utf8');
  const bodyText = fs.readFileSync(bodyPath, 'utf8');
  const entries = inlineEntriesOf(guidanceText);
  const sections = sectionsOf(bodyText);
  const entryIds = new Set(entries.map((e) => e.id));
  const sectionIds = new Set(sections);

  // ② 正向：注入面指针（**若有**）必须解析到正文真实小节。
  //    注：不强制「每条都带指针」——注入面里有自足条目（规范句本身即完整契约），强制会造出假失败。
  for (const e of entries) {
    for (const t of e.pointers) {
      if (!sectionIds.has(t)) failures.push({ check: 'forward', detail: `注入面 ${e.id} 指向 §${t}，正文无此小节` });
    }
  }

  // ③ 反向：正文小节必须在注入面出现（白名单除外）
  for (const s of sections) {
    if (entryIds.has(s)) continue;
    if (DETAIL_ONLY.has(s)) { notes.push(`详情面（白名单）§${s} 未进注入面`); continue; }
    failures.push({ check: 'reverse', detail: `正文 §${s} 未进注入面清单（注入面缺该规范句；如属详情面请加入 DETAIL_ONLY）` });
  }

  // ① repo ↔ live
  const livePreset = args.noLive
    ? null
    : (args.live ?? path.join(process.env.USERPROFILE ?? '', '.dsh', '.agent-presets', 'punky-preset'));
  const syncRows = [];
  if (livePreset) {
    if (!fs.existsSync(livePreset)) {
      notes.push(`live preset 不存在，跳过：${livePreset}`);
    } else {
      for (const rel of SYNC_FILES) {
        const a = path.join(repoPreset, rel);
        const b = path.join(livePreset, rel);
        const ea = fs.existsSync(a); const eb = fs.existsSync(b);
        if (!ea || !eb) { failures.push({ check: 'sync', detail: `缺副本：${rel} repo=${ea} live=${eb}` }); continue; }
        const sa = sha256(a); const sb = sha256(b);
        syncRows.push({ file: rel, same: sa === sb, repo: sa.slice(0, 16), live: sb.slice(0, 16) });
        if (sa !== sb) failures.push({ check: 'sync', detail: `副本不一致：${rel} repo=${sa.slice(0, 16)} live=${sb.slice(0, 16)}` });
      }
    }
  }

  // ④ 2026-10-21 新增：实际注入源（cordis.patch.yml）与 preset 的 persona 必须一致。
  //    历史事实：两份曾分叉（patch 缺 0i、§0 为旧短版）且长期无人发现 —— 本检查即为防复发。
  const patchPath = path.join(rootDir, PATCH);
  const presetRules = personaRulesOf(guidanceText);
  const personaRows = [];
  if (!fs.existsSync(patchPath)) {
    failures.push({ check: 'persona', detail: `缺实际注入源：${PATCH}` });
  } else {
    const patchRules = personaRulesOf(fs.readFileSync(patchPath, 'utf8'));
    const diffs = diffPersonaRules(presetRules, patchRules, GUIDANCE, PATCH);
    personaRows.push({ preset: presetRules.size, patch: patchRules.size, diffs: diffs.length });
    for (const d of diffs) failures.push({ check: 'persona', detail: d });
  }

  const result = {
    ok: failures.length === 0,
    repoPreset,
    livePreset: livePreset ?? null,
    inlineEntries: entries.length,
    bodySections: sections.length,
    detailOnly: [...DETAIL_ONLY],
    sync: syncRows,
    notes,
    failures,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`[guidance] 注入面条目=${entries.length}｜正文 §小节=${sections.length}｜live=${livePreset ?? '(skipped)'}\n`);
    for (const r of syncRows) process.stdout.write(`[guidance]   ${r.same ? 'OK ' : 'DIFF'} ${r.file} repo=${r.repo} live=${r.live}\n`);
    for (const n of notes) process.stdout.write(`[guidance]   NOTE ${n}\n`);
    for (const f of failures) process.stderr.write(`[guidance]   FAIL ${f.check}: ${f.detail}\n`);
    process.stdout.write(`[guidance] ${result.ok ? 'GREEN 指引双层与副本一致性成立' : `RED ${failures.length} 项失败`}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

main();
