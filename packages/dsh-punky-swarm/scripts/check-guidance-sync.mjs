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
const SYNC_FILES = [
  GUIDANCE,
  BODY,
  path.join('references', 'manager.md'),
  'preset.yml',
  'asset-manifest.json',
];

// 详情面白名单：这些小节**刻意不进注入面**（引擎接线细节，Leader/Manager 按需读正文即可）。
//   0m 派发套件落地细节｜0n 模式跟随装载口径｜0o 团队资产必填与缺省链的内部校验序
const DETAIL_ONLY = new Set(['0m', '0n', '0o']);

const USAGE = `用法：
  node scripts/check-guidance-sync.mjs [--live <dir>] [--no-live] [--json]

  --live <dir>  live preset 目录（缺省 ${path.join('%USERPROFILE%', '.dsh', '.agent-presets', 'punky-preset')}）
  --no-live     跳过 repo↔live 面
  --json        机读输出
`;

function parseArgs(argv) {
  const out = { live: undefined, noLive: false, json: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--no-live') { out.noLive = true; continue; }
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
    const m = /^\s{6}([0-9]{1,2}[a-z]?)\.\s+(\S.*)$/.exec(line);
    if (!m) return;
    const pointers = [...m[2].matchAll(/#§([0-9]+[a-z]?)/g)].map((x) => x[1]);
    out.push({ id: m[1], pointers });
  });
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`[guidance] 参数错误：${args.error}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const failures = [];
  const notes = [];
  const repoPreset = path.join(ROOT, PRESET_REL);
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
