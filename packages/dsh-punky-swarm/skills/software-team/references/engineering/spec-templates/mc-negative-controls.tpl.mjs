#!/usr/bin/env node
// 负控跑法模板：证明「校验器对本批依赖的每条规则真的会红」。
//
// 为什么必须有：校验器输出 `SUMMARY: 0 failures [PROCEED]` 只证明「当前 spec 没踩已知规则」，
//   不证明「规则真的生效」。若某条规则在实现里失效（或字段改名导致它恒不触发），
//   绿行照样出现——这就是假绿。唯一解法是**构造变异体**：改坏一处 ⇒ 必须红。
//
// 用法：拷成本批产物（如 plan/progress/mc-negative-controls.mjs），改成你的 spec 路径与变异清单，
//   用 `node <本文件>` 跑；全绿输出 `SUMMARY: mc-controls <n>/<n> reachable. [PROCEED]`，有漏则 exit 1。
//
// 纪律：变异体一律写临时副本，跑完删除；**绝不原地改 spec**。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 配置（按本批改这两行）────────────────────────────────────────────────
const SPEC = path.resolve('plan/speclang.yaml');       // 本批 spec
const VALIDATOR = path.resolve('scripts/speclang-validate.mjs'); // 仓内薄壳（或 rb 原件）
const RUBY = process.env.SPECLANG_RUBY ?? null;         // ruby 不在 PATH 时给绝对路径
// ────────────────────────────────────────────────────────────────────────

/** 每条变异：id = 期望命中的规则标签；mutate 返回「改坏后的 spec 文本」。 */
const MUTATIONS = [
  {
    id: 'MC-1', // 例：删掉必填字段 feature_goal
    mutate: (text) => text.replace(/^\s*feature_goal:.*$/m, ''),
  },
  {
    id: 'MC-3', // 例：让某条契约的 subsystem 指向不存在的子系统（悬空归属）
    mutate: (text) => text.replace(/subsystem: SUBSYS-.*$/m, 'subsystem: SUBSYS-NOT-EXIST'),
  },
  // TODO(本批)：把你要依赖的每条规则都补一条变异；一条变异没红 = 该规则不可依赖，须如实登记。
];

function runValidator(specPath) {
  const args = [];
  if (RUBY) args.push('--ruby=' + RUBY);
  args.push(specPath);
  try {
    const out = execFileSync(process.execPath, [VALIDATOR, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

const baseText = fs.readFileSync(SPEC, 'utf8');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-controls-'));
let reachable = 0;
const misses = [];

try {
  // 前置：原 spec 必须是绿的，否则下面的红分不清是「变异生效」还是「本来就红」。
  const baseline = runValidator(SPEC);
  if (baseline.code !== 0) {
    process.stdout.write('SUMMARY: mc-controls 0/' + MUTATIONS.length + ' reachable. [BLOCK] baseline-red\n');
    process.stdout.write('[mc] 前置失败：原 spec 未通过（exit ' + baseline.code + '）。先修 spec，再谈负控。\n');
    process.exit(1);
  }

  for (const [i, m] of MUTATIONS.entries()) {
    const mutated = m.mutate(baseText);
    if (mutated === baseText) {
      misses.push(m.id + '（变异未改动文本 ⇒ 变异构造失效，不是规则不可达）');
      continue;
    }
    const f = path.join(tmpDir, 'mc-' + i + '.yaml');
    fs.writeFileSync(f, mutated, 'utf8');
    const r = runValidator(f);
    const hit = r.code !== 0 && r.out.includes(m.id);
    if (hit) { reachable += 1; process.stdout.write('  ok    ' + m.id + '  (exit ' + r.code + ')\n'); }
    else misses.push(m.id + '（exit ' + r.code + '，' + (r.code === 0 ? '没红' : '红了但未命中该标签') + '）');
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const total = MUTATIONS.length;
if (misses.length === 0) {
  process.stdout.write('SUMMARY: mc-controls ' + reachable + '/' + total + ' reachable. [PROCEED]\n');
  process.exit(0);
}
for (const m of misses) process.stdout.write('  MISS  ' + m + '\n');
process.stdout.write('SUMMARY: mc-controls ' + reachable + '/' + total + ' reachable. [BLOCK]\n');
process.exit(1);
