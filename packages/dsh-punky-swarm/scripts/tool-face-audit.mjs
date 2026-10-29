/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// G0 清障（批 `punky-g0-clear-2026-10-29` · lane `e1-ledger`）：工具面**止损判据**执行器（H-1 / H-2 / H-3）。
//
// 把蓝图 §5 那句「任一工具『既自建又适配』→ 重划」从**一句人话**变成**可观测判据**：
//   五要素 —— ① 谁扫：本脚本（只读、零第三方依赖）；② 扫什么：S1/S2/S3/S4 四集合；
//   ③ 什么算命中：H-1 / H-2 / H-3；④ 落哪：`reports/tool-face-audit.json` + stdout + 退出码；
//   ⑤ 熔断：**H-1 或 H-2 ⇒ exit 1（G1 不启动）**；**H-3 ⇒ 只告警、exit 0**（不阻断）。
//
// 纪律：**禁第二套判据**——S1/S2 与 D1/D2 一律经 `diffToolFace()` 复用（`import` 而非复制），
//   否则两处口径迟早分叉（W-6）。本脚本自身只新增「S3 蓝图面 / S4 ledger 归属面」两个读端。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diffToolFace, DELETED_5 } from './tool-face-diff.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLUEPRINT = 'D:/AI_Workspace/DSH/buddy/_research/punky-refactor-blueprint-v4.md';
const LEDGER = path.join(PKG_ROOT, 'docs/tool-face-ledger.md');
const REPORT = path.join(PKG_ROOT, 'reports/tool-face-audit.json');

const uniq = (a) => [...new Set(a)];
const sortSet = (a) => uniq(a).sort();
const setEq = (a, b) => {
  const A = sortSet(a); const B = sortSet(b);
  return A.length === B.length && A.every((x, i) => x === B[i]);
};
const minus = (a, b) => uniq(a).filter((x) => !b.includes(x));

// 蓝图 §4 三面表 vs 缺省注册集 的**具名口径差异**（是定义差异，**不是漂移**）：
//   · `log_export`：§4 归「控制面」，但**不入缺省注册**（只读导出面，缺省不注册）⇒ 只在蓝图面；
//   · `lane_checkpoint_status`：§4 以「`lane_checkpoint`（合并 status）」**散文并述**，未单列名字
//     ⇒ 只在注册面。
// 为什么必须做成具名基线而不是裸集合相等：裸比较**恒红**（今日就红 2 名），G1 将永不启动 ——
//   与 W-2 警告的 H-3 假红同型。做法与 D1 的 `SUITE_ONLY_BASELINE` 同设计：**允许已知口径差异，
//   任何超出它的新增漂移照样阻断**。原始两向差集每次全量打印进 stdout 与 json，不被隐藏。
export const BLUEPRINT_VS_REGISTRY_BASELINE = Object.freeze({
  blueprintOnly: ['log_export'],
  registryOnly: ['lane_checkpoint_status'],
});

/** S3：蓝图 §4 三面表内反引号小写名集（§4.1 护栏面是**判定面**，不入集合）。 */
export function readBlueprintFace(bpPath = BLUEPRINT) {
  const lines = fs.readFileSync(bpPath, 'utf8').split('\n');
  const a = lines.findIndex((l) => l.startsWith('## 4.'));
  if (a < 0) throw new Error('blueprint §4 not found: ' + bpPath);
  let b = lines.findIndex((l, i) => i > a && /^## 5\./.test(l));
  if (b < 0) b = lines.length;
  const rows = lines.slice(a, b).filter((l) => /^\|\s*\*\*(数据面|控制面|删除)\*\*/.test(l));
  return uniq(rows.join('\n').match(/`([a-z_]+)`/g)?.map((s) => s.replace(/`/g, '')) ?? []);
}

/** S4：ledger §2 的 `归属` 列（H-1 唯一登记位）⇒ 返回 {belongRows:[{tool,belong}], both:[names]} */export function readLedgerBelong(ledgerPath = LEDGER) {
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n');
  const head = lines.find((l) => /^\|\s*工具名\s*\|/.test(l));
  if (!head) throw new Error('ledger §2 table header not found');
  const cols = head.split('|').map((s) => s.trim()).filter(Boolean);
  const iName = cols.findIndex((c) => c === '工具名');
  const iBelong = cols.findIndex((c) => c === '归属');
  if (iName < 0 || iBelong < 0) throw new Error('ledger §2 missing 工具名/归属 column');
  const belongRows = [];
  for (const l of lines.slice(lines.indexOf(head) + 2)) {
    if (!l.startsWith('|')) break;
    const cells = l.split('|').map((s) => s.trim());
    const name = (cells[iName + 1] ?? '').replace(/`/g, '');
    const belong = cells[iBelong + 1] ?? '';
    if (!name) continue;
    belongRows.push({ tool: name, belong });
  }
  return { belongRows, both: belongRows.filter((r) => r.belong === 'both').map((r) => r.tool) };
}

/** docstring 自述数（H-3 样本源） */export function readDocstringCount(root = PKG_ROOT) {
  const src = fs.readFileSync(path.join(root, 'lib/engine/suite.js'), 'utf8');
  const m = src.match(/套件工具全集（\*\*(\d+) 件\*\*/);
  return m ? Number(m[1]) : null;
}

/** 跑一次审计（纯函数；不写盘）。 */
export function auditToolFace(opts = {}) {
  const diff = diffToolFace('current', { root: opts.root });
  const s1 = diff.s1;
  const s2 = diff.s2;
  const s3raw = readBlueprintFace(opts.blueprint ?? BLUEPRINT);
  const s3 = minus(s3raw, DELETED_5);          // 按投影比较（§4 仍列删除面 5 件）
  const { both } = readLedgerBelong(opts.ledger ?? LEDGER);
  const docN = readDocstringCount(opts.root);

  const hits = [];
  // H-1（G0 止损原文直译）：ledger 里出现「既自建又适配」
  if (both.length > 0) hits.push({ criterion: 'H-1', names: both });
  // H-2（集合漂移三项，逐名打印）
  const driftForward = minus(s1, s2).filter((n) => !diff.baseline.includes(n));
  const driftBackward = minus(s2, s1);
  const registryProj = minus(s2, DELETED_5);
  const blueprintOnly = s3.filter((n) => !registryProj.includes(n));
  const registryOnly = registryProj.filter((n) => !s3.includes(n));
  const blueprintDrift = (setEq(blueprintOnly, BLUEPRINT_VS_REGISTRY_BASELINE.blueprintOnly)
    && setEq(registryOnly, BLUEPRINT_VS_REGISTRY_BASELINE.registryOnly))
    ? [] : uniq([...blueprintOnly, ...registryOnly]);
  if (driftForward.length || driftBackward.length || blueprintDrift.length) {
    hits.push({ criterion: 'H-2', names: uniq([...driftForward, ...driftBackward, ...blueprintDrift].sort()) });
  }
  // H-3（只告警）：docstring 自述数 ≠ 运行时全集
  const warn = [];
  if (docN !== null && docN !== s1.length) warn.push({ criterion: 'H-3', names: [String(docN) + ' != ' + s1.length] });

  const block = hits.length > 0;
  return {
    s1, s2, s3,
    s4both: both,
    faceDiff: { blueprintOnly, registryOnly, baseline: BLUEPRINT_VS_REGISTRY_BASELINE },
    display: {
      current: s1.length,
      afterDelete: minus(s1, DELETED_5).length,
      default: s2.length,
      defaultAfterDelete: minus(s2, DELETED_5).length,
    },
    checks: { D1: diff.checks.D1, D2: diff.checks.D2, D3: diff.checks.D3 },
    hits,
    warn,
    exit: block ? 1 : 0,
  };
}

function main(argv) {
  const json = (argv ?? []).includes('--json');
  const r = auditToolFace();
  const payload = {
    generatedAt: new Date().toISOString(),
    criteria: ['H-1', 'H-2', 'H-3'],
    s1: r.s1, s2: r.s2, s3: r.s3, s4both: r.s4both,
    faceDiff: r.faceDiff,
    口径展示位: r.display,
    checks: r.checks,
    hits: r.hits,
    warn: r.warn,
    exit: r.exit,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(payload, null, 2) + '\n');
  if (json) { process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); process.exit(r.exit); }
  const out = [];
  out.push('== 工具面止损审计（G0）==');
  out.push('S1 源码全集 ' + r.s1.length + ' 名 ｜ S2 缺省注册 ' + r.s2.length + ' 名 ｜ S3 蓝图 §4 投影 ' + r.s3.length + ' 名 ｜ S4 both ' + r.s4both.length + ' 名');
  out.push('蓝图面口径差异（原始两向，非判据）：只在蓝图 = [' + r.faceDiff.blueprintOnly.join(', ') + ']'
    + ' ｜ 只在注册 = [' + r.faceDiff.registryOnly.join(', ') + ']'
    + ' ｜ 具名基线 = ' + JSON.stringify(r.faceDiff.baseline));
  out.push('口径展示位·非判据：current ' + r.display.current + ' / afterDelete ' + r.display.afterDelete
    + ' / default ' + r.display.default + ' / defaultAfterDelete ' + r.display.defaultAfterDelete);
  out.push('D1/D2/D3（复用 diffToolFace）：' + JSON.stringify(r.checks));
  if (r.hits.length === 0) out.push('H-1 / H-2：无命中 ✅');
  for (const h of r.hits) out.push('HIT ' + h.criterion + ' 阻断：' + (h.names.length ? h.names.join(', ') : '（见判据定义）'));
  for (const w of r.warn) out.push('WARN ' + w.criterion + ' docstring drift: ' + w.names.join(', ') + '（只告警、不阻断）');
  out.push('落盘：reports/tool-face-audit.json');
  out.push('RESULT: ' + (r.exit === 0 ? 'PASS（H-1/H-2 均未命中）' : 'BLOCK（G1 不启动）'));
  process.stdout.write(out.join('\n') + '\n');
  process.exit(r.exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
