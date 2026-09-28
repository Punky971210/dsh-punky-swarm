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

// 批 onekey-install-20260927 · lane exec-smoke：**I-6 三面只读自检入口**的判据用例。
//
// 判据面（判据源 `plan/install-spec.md` §验收标准 I-6，逐条对齐）：
//   (a) `scripts/selfcheck-install.mjs` 存在且**只读**（对真实 home 零写入）；
//   (b) `--home <tmp> --json` ⇒ `exit 0` 且 stdout 为合法 JSON，含三面键 + 底层 `results` / `manifest`；
//   (c) **缺口态**：不完整的 home（空目录）⇒ `exit` 非 0 且 JSON 列出缺口项；
//   (d) home **显式可注入**（`--home`），且脚本**不引用 `DSH_HOME`** 作为 home 来源（grep 级断言）。
//
// 污染红线（D-4）：本用例**不对真实 home 写入**。第 1 例是**只读**取证（前后 sha256 守卫），
//   其余各例的 home 一律落在 `os.tmpdir()` 下的自建目录（用例退出即清理）。
//
// 隔离说明（`test/helpers/isolated-home.preload.mjs`）：测试进程内 `os.homedir()` 已被重定向到隔离根，
//   而**真实 home 真源** = `os.userInfo().homedir`（系统账户 API，不受 USERPROFILE / HOME 影响）
//   —— 与 preload `:55-58`、`exec/failsoft-probe.mjs:17` 同源口径。本用例的守卫面按后者取。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELFCHECK = path.join(PKG, 'scripts', 'selfcheck-install.mjs');
const REAL_HOME = os.userInfo().homedir;

/** 八个团队技能指针目录（与判据源 §概述 三面映射 ③ 逐字一致）。 */
const SKILL_NAMES = [
  'acceptance-gate', 'design-team', 'engine-team', 'research-team',
  'retro-and-memory', 'review-execution', 'software-team', 'writing-team',
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 只读快照：给定根下逐文件 sha256 + 聚合 digest（零写入）。 */
function snapshotTree(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push([p, sha(fs.readFileSync(p))]);
    }
  };
  walk(root);
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    files: out.length,
    digest: sha(Buffer.from(out.map(([p, h]) => h + '\t' + p).join('\n'), 'utf8')),
    entries: out,
  };
}

/** 真实 home 的守卫面：`.agents/skills/**` + `.dsh/.agent-presets/punky-preset/**`（只读）。 */
function realHomeSnapshot() {
  const skills = snapshotTree(path.join(REAL_HOME, '.agents', 'skills'));
  const preset = snapshotTree(path.join(REAL_HOME, '.dsh', '.agent-presets', 'punky-preset'));
  const entries = [...skills.entries, ...preset.entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    files: entries.length,
    digest: sha(Buffer.from(entries.map(([p, h]) => h + '\t' + p).join('\n'), 'utf8')),
    entries,
  };
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 建「已安装」合成 home：profile manifest 两包齐备（面①②）；资产由自检脚本自身同步（面③）。 */
function syntheticInstalledHome() {
  const home = mkTmp('punky-selfcheck-ok-');
  const profileDir = path.join(home, '.dsh', 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'dsh-punky-swarm': 'file:./dsh-punky-swarm-0.5.0.tgz',
      '@deepseek-ai/dsh-experimental-agent-team-profile': '0.1.7-rc.2',
    },
    dsh: { profile: { bundles: ['dsh-punky-swarm', '@deepseek-ai/dsh-experimental-agent-team-profile'] } },
  }, null, 2) + '\n', 'utf8');
  return home;
}

function runSelfcheck(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SELFCHECK, ...args], {
    cwd: PKG,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

test('I-6(a) 入口存在且对真实 home 零写入（前后 sha256 逐文件全等）', () => {
  assert.equal(fs.existsSync(SELFCHECK), true, 'scripts/selfcheck-install.mjs 必须存在（I-6(a)）');

  const before = realHomeSnapshot();
  assert.ok(before.files > 0, '守卫面须可达构造（真实 home 下应有技能/预设文件）；实测 files=' + String(before.files));
  // 对真实 home 跑一次自检（脚本在真实 home 上必须走**只读**分支，不调同步写路径）
  const r = runSelfcheck(['--json']);
  const after = realHomeSnapshot();

  assert.equal(after.digest, before.digest,
    '自检对真实 home 必须零写入（D-4 污染红线）；实测 before=' + before.digest + ' after=' + after.digest
    + ' files=' + String(before.files) + '->' + String(after.files));
  assert.equal(after.files, before.files, '守卫面文件数不得变化（不得新增/删除）');
  assert.equal(r.error, undefined, '自检须可执行（spawn 无错误）：' + String(r.error && r.error.message));
});

test('I-6(b) 已安装 home ⇒ --home <tmp> --json ⇒ exit 0 + 三面键 + results/manifest', () => {
  const home = syntheticInstalledHome();
  try {
    const r = runSelfcheck(['--home', home, '--json']);
    assert.equal(r.status, 0, '三面齐备须 exit 0；实测 status=' + String(r.status) + ' stderr=' + r.stderr.slice(0, 400));
    let doc = null;
    assert.doesNotThrow(() => { doc = JSON.parse(r.stdout); }, 'stdout 须为合法 JSON；实测前 300 字符=' + r.stdout.slice(0, 300));
    for (const key of ['engine', 'preset', 'skills']) {
      assert.ok(doc[key] && typeof doc[key] === 'object', 'JSON 须含三面键 ' + key + '；实测键=' + JSON.stringify(Object.keys(doc)));
    }
    assert.ok(doc.results !== undefined && Array.isArray(doc.results), '须原样透出底层 results（数组）');
    assert.equal(typeof doc.manifest, 'string', '须原样透出底层 manifest（字符串）');
    assert.equal(doc.engine.ok, true, '面①不得有缺口：' + JSON.stringify(doc.engine.gaps ?? null));
    assert.equal(doc.preset.ok, true, '面②不得有缺口：' + JSON.stringify(doc.preset.gaps ?? null));
    assert.equal(doc.skills.ok, true, '面③不得有缺口：' + JSON.stringify(doc.skills.gaps ?? null));
    // 面③ 可达构造：同步后八个技能指针目录 + references 非空（逐项断言，非「非空即过」）
    for (const name of SKILL_NAMES) {
      assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', name, 'SKILL.md')), true,
        '面③ 技能指针须落盘：' + name);
    }
    const refs = path.join(home, '.dsh', '.agent-presets', 'punky-preset', 'references');
    assert.ok(fs.existsSync(refs) && fs.readdirSync(refs).length > 0, '面③ references 目录须非空：' + refs);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('I-6(c) 缺口态：空 home ⇒ exit 非 0 且 JSON 列出缺口项', () => {
  const home = mkTmp('punky-selfcheck-gap-');
  try {
    const r = runSelfcheck(['--home', home, '--json']);
    assert.notEqual(r.status, 0, '缺口态必须 exit 非 0；实测 status=' + String(r.status));
    let doc = null;
    assert.doesNotThrow(() => { doc = JSON.parse(r.stdout); }, '缺口态 stdout 仍须为合法 JSON（机检友好）');
    const gaps = [...(doc.engine?.gaps ?? []), ...(doc.preset?.gaps ?? []), ...(doc.skills?.gaps ?? [])];
    assert.ok(gaps.length > 0, '缺口态须列出缺口项；实测 gaps=' + JSON.stringify(gaps));
    assert.equal(doc.engine.ok, false, '空 home 的 profile manifest 缺失 ⇒ 面① 必为缺口');
    assert.ok(gaps.some((g) => String(g).includes('profile')), '缺口须点名 profile 面：' + JSON.stringify(gaps));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('I-6(d) home 显式可注入，且脚本不引用 DSH_HOME 作为 home 来源', () => {
  const src = fs.readFileSync(SELFCHECK, 'utf8');
  assert.ok(src.includes('--home'), '脚本须支持 --home 注入（I-6(d)）');
  assert.ok(!src.includes('DSH_HOME'),
    '脚本不得引用 DSH_HOME 作为 home 来源（lib/assets.js:210 只读 opts.home ?? homedir()）——grep 级断言');
  assert.ok(src.includes('userInfo'), '脚本须以 os.userInfo().homedir 识别**真实** home（只读分支判据）');
});
