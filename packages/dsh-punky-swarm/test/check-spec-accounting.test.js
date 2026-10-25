// S-10 装牙：`scripts/check-spec-accounting.mjs` 的行为判据（真实事故驱动）。
//
// 事故来源（可核）：批次 `edu-backend-m0-r6-20261026` 的 `plan/r6-scope.md` 把 `CC-*` 与
//   `hoare-check` 派给 audit，并写明「若不可用须显式记未执行 + 原因」；但 `audit/r6-acceptance.md`
//   与 `audit/r6-gap-list.json` 对二者的命中均为 **0**，批次仍 complete。
//   ⇒ 本判据要能红在那次事故的形态上：**要求提到过、验收没交代** ⇒ exit 1。
//
// 四态纪律：每条用例首行写失败条件；跳过只用于结构性不可判，不折算通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PKG_ROOT, 'scripts', 'check-spec-accounting.mjs');

/** 建一个临时工作目录并写入给定文件。 */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-acc-'));
  for (const [name, body] of Object.entries(files)) {
    const abs = path.join(dir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

/** 跑脚本，返回 {code, out, err}（不用 assert.throws，要拿退出码与输出）。 */
function run(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

const PLAN_BLOCK = [
  '# plan',
  '',
  'spec-accounting:',
  '  - CC-mapping',
  '  - hoare-check',
  '',
  '## 其它',
  '- 与本门无关的正文',
  '',
].join('\n');

test('T1 声明块 + 两条都给了读数 ⇒ exit 0 且 SUMMARY 为 PROCEED', () => {
  // 失败条件：合法输入被判红（把门做得过严，成员会绕过它）。
  const d = fixture({
    'plan.md': PLAN_BLOCK,
    'audit.md': '| CC-mapping | 全量对照 ⇒ 读数 12/12 命中 | PASS |\n| hoare-check | exit 0 | PASS |\n',
  });
  const r = run(['--plan', path.join(d, 'plan.md'), '--acceptance', path.join(d, 'audit.md')]);
  assert.equal(r.code, 0, '应放行；实际输出：\n' + r.out + r.err);
  assert.match(r.out, /SUMMARY: spec-accounting 2 declared, 2 covered, 0 missing\. \[PROCEED\]/);
});

test('T2 无声明块、正文只提及 `CC-*` / `hoare-check` ⇒ 仍按提及派生（此处缺 hoare ⇒ 红）', () => {
  // 失败条件：只在正文提过的要求被视为「没提过」⇒ 正是 r6 事故的形态（要求写在 prose 里，验收没交代）。
  const d = fixture({
    'plan.md': '本批由 audit 执行 `CC-*` 一致性与 `hoare-check` 硬门。\n',
    'audit.md': '| CC-mapping | 读数 12/12 | PASS |\n',
  });
  const r = run(['--plan', path.join(d, 'plan.md'), '--acceptance', path.join(d, 'audit.md')]);
  assert.equal(r.code, 1, '缺 hoare-check 交代应判红；实际：' + r.code + '\n' + r.out);
  assert.match(r.out, /MISS {2}hoare-check/);
  assert.match(r.out, /\[BLOCK\]/);
});

test('T3 声明块里的要求完全未出现于验收 ⇒ exit 1 且逐条点名', () => {
  // 失败条件：missing 清单为空却判红，或判红但说不出缺哪条（不可复核）。
  const d = fixture({ 'plan.md': PLAN_BLOCK, 'audit.md': '# 验收\n\n全部通过。\n' });
  const r = run(['--plan', path.join(d, 'plan.md'), '--acceptance', path.join(d, 'audit.md')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /CC-mapping/);
  assert.match(r.out, /hoare-check/);
  assert.match(r.out, /2 declared, 0 covered, 2 missing/);
});

test('T4 「未执行」但无原因 ⇒ 仍判红（防万能豁免）', () => {
  // 失败条件：写一句「未执行」就能过关 ⇒ 本门退化成通行证，比没有门更坏。
  const d = fixture({
    'plan.md': 'spec-accounting:\n  - hoare-check\n',
    'audit.md': '| hoare-check | 未执行 | |\n',
  });
  const r = run(['--plan', path.join(d, 'plan.md'), '--acceptance', path.join(d, 'audit.md')]);
  assert.equal(r.code, 1, '无原因的未执行必须判红；实际：' + r.code + '\n' + r.out);
  assert.match(r.out, /未执行但未给原因|既无读数/);
});

test('T5 「未执行 + 原因」⇒ exit 0（保留合法豁免路径）', () => {
  // 失败条件：合法豁免被判红 ⇒ 成员只能造假读数（门把人逼向作弊）。
  const d = fixture({
    'plan.md': 'spec-accounting:\n  - hoare-check\n',
    'audit.md': '| hoare-check | 未执行 — 原因：本批无并发契约，霍尔推理无对象 | ⧗ |\n',
  });
  const r = run(['--plan', path.join(d, 'plan.md'), '--acceptance', path.join(d, 'audit.md')]);
  assert.equal(r.code, 0, '带原因的未执行应放行；实际：' + r.code + '\n' + r.out);
  assert.match(r.out, /1 declared, 1 covered, 0 missing/);
});

test('T6 传目录（内恰 1 个 md）⇒ 可解析；目录内多个 md ⇒ exit 2（fail-closed）', () => {
  // 失败条件：多文件目录被随便挑一个 ⇒ 判据对象不确定，红绿都不可复核。
  const ok = fixture({ 'plan/only.md': PLAN_BLOCK, 'acc/only.md': '| CC-mapping | 读数 1 | \n| hoare-check | exit 0 |\n' });
  const r1 = run(['--plan', path.join(ok, 'plan'), '--acceptance', path.join(ok, 'acc')]);
  assert.equal(r1.code, 0, '唯一 md 的目录应可读；实际：\n' + r1.out + r1.err);

  const bad = fixture({ 'plan/a.md': PLAN_BLOCK, 'plan/b.md': PLAN_BLOCK });
  const r2 = run(['--plan', path.join(bad, 'plan'), '--acceptance', path.join(bad, 'plan', 'a.md')]);
  assert.equal(r2.code, 2, '多 md 目录必须 fail-closed');
  assert.match(r2.err, /\.md 不唯一/);
});

test('T7 缺参数 / 未知参数 ⇒ exit 2（用法错误不得当「无要求」放行）', () => {
  // 失败条件：少了 --acceptance 仍 exit 0 ⇒ 没核就报绿。
  const r1 = run(['--plan', 'x.md']);
  assert.equal(r1.code, 2);
  assert.match(r1.err, /缺 --acceptance/);
  const r2 = run(['--plan', 'x.md', '--acceptance', 'y.md', '--bogus']);
  assert.equal(r2.code, 2);
  assert.match(r2.err, /未知参数/);
});

test('T8 产物文件不存在 ⇒ exit 2（fail-closed，不静默当作空）', () => {
  // 失败条件：路径写错返回 0 ⇒ 门形同虚设（最容易发生的误用）。
  const d = fixture({ 'plan.md': PLAN_BLOCK });
  const r = run(['--plan', path.join(d, 'plan.md'), '--acceptance', path.join(d, 'nope.md')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /不存在/);
});

test('T9 既无声明块、正文也未提及 ⇒ exit 0 但明说「无要求可核」（不装作核过）', () => {
  // 失败条件：无要求时输出「已核通过」式的含糊结论 ⇒ 让人误以为机械面已验。
  const d = fixture({ 'plan.md': '# plan\n\n本批只加日志。\n', 'audit.md': '# 验收\n\n通过。\n' });
  const r = run(['--plan', path.join(d, 'plan.md'), '--acceptance', path.join(d, 'audit.md')]);
  assert.equal(r.code, 0);
  assert.match(r.out, /0 declared, 0 covered, 0 missing/);
  assert.match(r.out, /无要求可核/);
});

test('T10 `--json` 给逐条明细（declared/detail），供面板或门禁复核', () => {
  // 失败条件：只给汇总不给明细 ⇒ 红的时候无法定位是哪条、为什么。
  const d = fixture({ 'plan.md': PLAN_BLOCK, 'audit.md': '| CC-mapping | 读数 3/3 |\n' });
  const r = run(['--plan', path.join(d, 'plan.md'), '--acceptance', path.join(d, 'audit.md'), '--json']);
  assert.equal(r.code, 1);
  const jsonText = r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonText);
  assert.deepEqual(parsed.declared, ['CC-mapping', 'hoare-check']);
  const hc = parsed.detail.find((x) => x.id === 'hoare-check');
  assert.equal(hc.state, 'missing');
});

test('T11 族形态 `CC-*` 按前缀匹配：验收给任意 CC-xxx 读数即算交代；一行都没有则红', () => {
  // 失败条件：`CC-*` 被当作「具体 id CC-* 」导致永远匹配不到 ⇒ 合法产物被判红；
  //   或者反过来被忽略 ⇒ 族要求静默蒸发（r6 plan 就写的这个形态）。
  const bad = fixture({
    'plan.md': '$CC-* 一致性与 hoare-check 硬门。\n',
    'audit.md': '| hoare-check | exit 0 | PASS |\n',
  });
  const r1 = run(['--plan', path.join(bad, 'plan.md'), '--acceptance', path.join(bad, 'audit.md')]);
  assert.equal(r1.code, 1, 'CC- 类一行读数都没有 ⇒ 应判红；实际：' + r1.code + '\n' + r1.out);
  assert.match(r1.out, /MISS {2}CC-\*/);

  const ok = fixture({
    'plan.md': '$CC-* 一致性与 hoare-check 硬门。\n',
    'audit.md': '| CC-mapping | 读数 12/12 | PASS |\n| hoare-check | exit 0 | PASS |\n',
  });
  const r2 = run(['--plan', path.join(ok, 'plan.md'), '--acceptance', path.join(ok, 'audit.md')]);
  assert.equal(r2.code, 0, '给了具体 CC-xxx 读数应算族已交代；实际：\n' + r2.out);
});
