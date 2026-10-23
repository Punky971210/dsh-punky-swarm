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

// 批次 `punky-housekeeping-20261023` · lane c1-skillssync（H-1）：
// `scripts/check-guidance-sync.mjs` 新增的 ④「`skills/` 面 repo↔live 整树一致性」判据族的回归锁。
//
// 为什么需要它（本 lane 的问题陈述）：`syncAssets()` 每次启动都用**仓库版本覆盖** live skill。
// 外部写入者把 live 侧改大之后，重启即被静默冲掉——repo 侧 `git status` 干净、既有门禁全 GREEN，
// 因为**这个面此前没有任何校验**。本用例把「三档语义必须可区分」钉死：
//   ① 未同步（`missing-in-live` / `missing-in-repo`）
//   ② live 旧于 repo（`live-older`：部署滞后）
//   ③ **live 新于 repo（`live-newer`：外部写入 ⇒ 下次重启会被冲掉）** ← 本批要害
// 另加 `diverged`（方向不可判）与 `same`（判绿）两档作边界。
//
// 夹具纪律（硬约束，AC-H1-5 / 批次硬约束「唯一允许的 live 写 = c3 的 discipline.md 双副本」）：
//   · **绝不触碰真 live**（`%USERPROFILE%\.agents\skills`）——全部差异都在 `os.tmpdir()` 的影子目录里造，
//     以 `--skills-live <影子>` 注入；**绝不改 repo `skills/**`**（只读复制）。
//   · preset 面同时以 `--live <影子 preset 副本>` 注入 ⇒ 退出码完全由 skills 面决定，
//     用例不受「本机 live preset 是否已部署 / 是否同 sha」影响。
//   · 每条用例一个临时目录，`finally` 清理。
//
// 反向构造可复现性：反向档**不依赖真 live 当前存在差异**（实测 9/9 SAME）；mtime 一律相对
//   repo 侧同名文件的 mtime 偏移构造，不用 `Date.now()`（避免「repo 刚检出 ⇒ 偏移方向反转」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 夹具子进程不继承主测试进程的 `--import` ⇒ 解析钩子显式注入 argv（与 `test/baseline-snapshot-cli.test.js` 同形）
import { hostDepFallbackImportArgs } from './helpers/host-dep-fallback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRIPT_REL = path.join('scripts', 'check-guidance-sync.mjs');
const SKILLS_REL = 'skills';
const PRESET_REL = path.join('presets', 'punky-preset');
const TIE_MS = 3600_000; // 方向档的 mtime 偏移：远大于实现里的 1ms「不可判」容差

const sha16 = (abs) => createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);

/** repo 侧 skill 清单（**动态派生**：新增 skill 时只看「是否 all same」，不写死 9）。 */
function repoSkillNames() {
  return fs
    .readdirSync(path.join(ROOT, SKILLS_REL), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** 递归枚举常规文件的 posix 相对路径（按实现同款规则跳过 OS 噪声文件）。 */
function relFilesOf(absDir, prefix = '') {
  const out = [];
  for (const d of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...relFilesOf(path.join(absDir, d.name), rel));
    else if (d.isFile() && !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(d.name)) out.push(rel);
  }
  return out.sort();
}

/** 影子 live：`<tmp>/skills`（repo `skills/` 的只读副本）+ `<tmp>/preset`（preset 五件的副本）。 */
function makeShadow() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sync-'));
  const shadow = path.join(tmp, 'skills');
  const preset = path.join(tmp, 'preset');
  fs.cpSync(path.join(ROOT, SKILLS_REL), shadow, { recursive: true });
  fs.cpSync(path.join(ROOT, PRESET_REL), preset, { recursive: true });
  return { tmp, shadow, preset };
}

function runCli(args) {
  return spawnSync(process.execPath, [...hostDepFallbackImportArgs(), path.join(ROOT, SCRIPT_REL), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

/** 在影子目录上跑（preset 面也用影子副本 ⇒ 退出码只由 skills 面决定）。 */
function runShadow(s, extra = []) {
  return runCli(['--live', s.preset, '--skills-live', s.shadow, ...extra]);
}

function withShadow(fn) {
  const s = makeShadow();
  try {
    fn(s);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
}

/** 把影子里某文件的 mtime 设成「repo 同名文件 mtime ± 偏移」（方向可判），或 `0` 偏移（方向不可判）。 */
function setLiveMtime(s, rel, offsetMs) {
  const repoAbs = path.join(ROOT, SKILLS_REL, rel);
  const liveAbs = path.join(s.shadow, rel);
  const target = new Date(fs.statSync(repoAbs).mtimeMs + offsetMs);
  fs.utimesSync(liveAbs, target, target);
}

/** 影子内某文件改成「内容与 repo 不同」（追加一行，不依赖编码/行尾）。 */
function divergeLive(s, rel) {
  fs.appendFileSync(path.join(s.shadow, rel), '\n<!-- 影子差异：模拟外部写入 -->\n');
}

// ── 1. 判绿档 + 既有读数不回归（AC-H1-8 / AC-H1-5 的只读面） ────────────────
test('skills-1 影子全同 ⇒ 逐 skill 全 same、exit 0、既有三判据读数行格式不变', () => {
  withShadow((s) => {
    const skills = repoSkillNames();
    const r = runShadow(s);
    assert.equal(r.status, 0, `影子全同必须 exit 0；stderr=${r.stderr}`);
    assert.match(
      r.stdout.split('\n')[0],
      /^\[guidance\] 注入面条目=\d+｜正文 §小节=\d+｜live=/,
      '既有首行读数格式逐字未变',
    );
    assert.match(
      r.stdout,
      /\[skills\] repo=.*｜live=.*｜skill same=\d+ diff=0｜file total=\d+ same=\d+ diff=0/,
      'skills 汇总行在场且 diff=0',
    );
    assert.ok(r.stdout.includes(`skill same=${skills.length} diff=0`), `应逐 skill 全 same（当前 ${skills.length} 个）`);
    for (const name of skills) {
      assert.ok(r.stdout.includes(`[skills]   OK   ${name} files=`), `${name} 应有 OK 行`);
    }
    assert.equal(
      r.stdout.split('\n').filter((l) => l.startsWith('[guidance]   OK ')).length,
      5,
      'preset 五件的既有 OK 行仍在（既有判据零回归）',
    );
    const files = relFilesOf(path.join(ROOT, SKILLS_REL));
    assert.ok(r.stdout.includes(`file total=${files.length} same=${files.length} diff=0`), '逐文件计数与 repo 侧一致');
    assert.equal(r.stderr, '', '全绿时 stderr 为空');
  });
});

// ── 2. 要害档：live 新于 repo（外部写入）——AC-H1-1 ─────────────────────────
test('skills-2 AC-H1-1 外部写入 live ⇒ live-newer + exit 1 + 点名 skill/相对路径', () => {
  withShadow((s) => {
    const rel = 'video-team/SKILL.md';
    divergeLive(s, rel);
    setLiveMtime(s, rel, TIE_MS); // live 比 repo 新 ⇒ 方向可判
    const r = runShadow(s);
    assert.equal(r.status, 1, '差异必须判红（exit 1）');
    assert.ok(r.stderr.includes('[skills]'), 'stderr 带 [skills] 段前缀（与既有 [guidance] 段可区分）');
    assert.ok(r.stderr.includes('live-newer'), `命中 live-newer 档；stderr=${r.stderr}`);
    assert.ok(r.stderr.includes(rel), `点名 ${rel}`);
    assert.ok(r.stderr.includes('勿自动覆盖'), '文案定向：提醒不要自动覆盖');
    assert.match(r.stdout, /\[skills\]   DIFF video-team status=live-newer/, 'skill 级聚合行标 live-newer');
    assert.match(r.stdout, /\[skills\] repo=.*skill same=\d+ diff=1/, '汇总行如实报 1 项差异');
  });
});

// ── 3. 判据只认内容、不认时间——AC-H1-2 ────────────────────────────────────
test('skills-3 AC-H1-2 内容同 repo 时 mtime 更晚 / 更早都判绿（mtime 不参与判红判绿）', () => {
  withShadow((s) => {
    const rel = 'video-team/SKILL.md';
    const repoAbs = path.join(ROOT, SKILLS_REL, rel);
    const liveAbs = path.join(s.shadow, rel);
    const original = fs.readFileSync(repoAbs);

    // ① 内容还原 + 保留「更晚」的 mtime
    fs.writeFileSync(liveAbs, original);
    setLiveMtime(s, rel, TIE_MS);
    const later = runShadow(s);
    assert.equal(later.status, 0, '内容与 repo 相同 ⇒ 必须判绿（哪怕 live mtime 更晚）');

    // ② 内容相同 + mtime 早于 repo
    setLiveMtime(s, rel, -TIE_MS);
    const earlier = runShadow(s);
    assert.equal(earlier.status, 0, '内容与 repo 相同 ⇒ 必须判绿（哪怕 live mtime 更早）');
    assert.equal(later.stdout, earlier.stdout, '两次读数逐字一致（幂等）');
  });
});

// ── 4. live 旧于 repo（部署滞后） ──────────────────────────────────────────
test('skills-4 live 旧于 repo ⇒ live-older + exit 1', () => {
  withShadow((s) => {
    const rel = 'video-team/SKILL.md';
    divergeLive(s, rel);
    setLiveMtime(s, rel, -TIE_MS);
    const r = runShadow(s);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('live-older'), `命中 live-older 档；stderr=${r.stderr}`);
    assert.ok(r.stderr.includes(rel));
    assert.ok(r.stderr.includes('需重新同步'), '文案定向：提醒重新同步');
  });
});

// ── 5. 方向不可判（mtime 落在容差内） ─────────────────────────────────────
test('skills-5 内容不同且 mtime 不可判方向 ⇒ diverged + exit 1', () => {
  withShadow((s) => {
    const rel = 'video-team/SKILL.md';
    divergeLive(s, rel);
    setLiveMtime(s, rel, 0); // 与 repo 同（差异 < 1ms）⇒ 方向不可判
    const r = runShadow(s);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('diverged'), `命中 diverged 档；stderr=${r.stderr}`);
    assert.ok(r.stderr.includes('方向不可判'));
  });
});

// ── 6. 未同步（live 缺文件）——AC-H1-3 ────────────────────────────────────
test('skills-6 AC-H1-3 未同步 ⇒ missing-in-live + exit 1 + 点名相对路径', () => {
  withShadow((s) => {
    const rel = 'software-team/references/roles/coder.md';
    fs.rmSync(path.join(s.shadow, rel));
    const r = runShadow(s);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('missing-in-live'), `命中 missing-in-live；stderr=${r.stderr}`);
    assert.ok(r.stderr.includes(rel), `点名 ${rel}`);
    assert.ok(r.stderr.includes('未同步'), '文案定向：未同步');
  });
});

// ── 7. 外部新增（live 多出文件）——AC-H1-4 ────────────────────────────────
test('skills-7 AC-H1-4 live 多出文件 ⇒ missing-in-repo + exit 1 + 点名该文件', () => {
  withShadow((s) => {
    const rel = 'video-team/references/extra.md';
    fs.mkdirSync(path.dirname(path.join(s.shadow, rel)), { recursive: true });
    fs.writeFileSync(path.join(s.shadow, rel), '# 外部新增\n');
    const r = runShadow(s);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('missing-in-repo'), `命中 missing-in-repo；stderr=${r.stderr}`);
    assert.ok(r.stderr.includes(rel), `点名 ${rel}`);
    assert.ok(r.stderr.includes('外部新增'), '文案定向：外部新增');
  });
});

// ── 8. 整 skill 目录缺失（真缺口，与「环境未部署」区分） ──────────────────
test('skills-8 整个 skill 目录在 live 侧缺失 ⇒ missing-in-live（live 根存在 ⇒ 判红）', () => {
  withShadow((s) => {
    const skill = 'retro-and-memory';
    fs.rmSync(path.join(s.shadow, skill), { recursive: true, force: true });
    const r = runShadow(s);
    assert.equal(r.status, 1, 'live 根存在而 skill 目录缺失是真缺口，必须红');
    assert.match(r.stdout, new RegExp(`\\[skills\\]   DIFF ${skill} status=missing-in-live`));
    assert.ok(r.stderr.includes('missing-in-live'));
  });
});

// ── 9. 环境未部署不恒红——AC-H1-6 ─────────────────────────────────────────
test('skills-9 AC-H1-6 live skills 根不存在 ⇒ note 跳过 + exit 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sync-none-'));
  try {
    const s = makeShadow();
    try {
      const r = runCli(['--live', s.preset, '--skills-live', path.join(tmp, 'nope')]);
      assert.equal(r.status, 0, `环境未部署不得恒红；stderr=${r.stderr}`);
      assert.ok(r.stdout.includes('live skills 不存在，跳过'), 'note 明确跳过原因');
      assert.equal(r.stderr, '');
      assert.ok(!r.stdout.includes('[skills] repo='), '未执行 ⇒ 不输出 skills 汇总行');
    } finally {
      fs.rmSync(s.tmp, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 10. 参数纪律 fail-closed——AC-H1-7 ────────────────────────────────────
test('skills-10 AC-H1-7 --skills-live 缺值 / 重复 / 与 --no-live 并用 ⇒ exit 2 + 用法打 stderr', () => {
  withShadow((s) => {
    const cases = [
      { label: '缺值', args: ['--skills-live'] },
      { label: '重复', args: ['--skills-live', s.shadow, '--skills-live', s.shadow] },
      { label: '与 --no-live 并用', args: ['--skills-live', s.shadow, '--no-live'] },
      { label: '被下一个开关吞掉的伪值', args: ['--skills-live', '--no-live'] },
    ];
    for (const c of cases) {
      const r = runCli(c.args);
      assert.equal(r.status, 2, `${c.label} 必须 exit 2；实际 ${r.status}`);
      assert.ok(r.stderr.includes('用法'), `${c.label}：stderr 带用法`);
      assert.ok(r.stderr.includes('参数错误'), `${c.label}：stderr 点明参数错误`);
      assert.equal(r.stdout, '', `${c.label}：参数错误时不得有正常输出`);
    }
  });
});

// ── 11. --no-live 同时跳过 preset 面与 skills 面——AC-H1-7 后半 ────────────
test('skills-11 AC-H1-7 --no-live 时输出里没有 [skills] 段（skills 面一并跳过）', () => {
  const r = runCli(['--no-live']);
  assert.equal(r.status, 0, `--no-live 只校验注入面/正文；stderr=${r.stderr}`);
  assert.ok(r.stdout.includes('[guidance]'), '既有 guidance 段仍在');
  assert.ok(!r.stdout.includes('[skills]'), 'skills 面必须一并跳过');
  assert.ok(!r.stdout.includes('skill same='), '不残留 skills 汇总读数');
});

// ── 12. --json 向后兼容——AC-H1-8 ────────────────────────────────────────
test('skills-12 AC-H1-8 --json 既有键集合不变，仅新增 skills 段', () => {
  withShadow((s) => {
    const r = runShadow(s, ['--json']);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(
      Object.keys(j).filter((k) => k !== 'skills'),
      ['ok', 'repoPreset', 'livePreset', 'inlineEntries', 'bodySections', 'detailOnly', 'sync', 'notes', 'failures'],
      '既有键与顺序一字不变',
    );
    assert.equal(j.ok, true);
    assert.equal(j.sync.length, 5, '既有 sync 段仍是五件');
    assert.deepEqual(j.failures, [], '既有 failures 段不受 skills 面污染（skills 失败只落 skills.failures）');
    assert.equal(j.skills.same, repoSkillNames().length, 'skills.same = skill 数');
    assert.equal(j.skills.diff, 0);
    assert.equal(j.skills.fileTotals.same, relFilesOf(path.join(ROOT, SKILLS_REL)).length, 'fileTotals.same = 文件数');
    const first = j.skills.skills[0];
    assert.equal(first.status, 'same');
    const row = first.files[0];
    for (const key of ['file', 'relPath', 'status', 'repoSha16', 'liveSha16', 'repoBytes', 'liveBytes']) {
      assert.ok(key in row, `逐文件行含 ${key}`);
    }
    assert.equal(row.repoSha16, row.liveSha16, '全同时两侧 sha16 相同');
  });
});

// ── 13. 零写盘 / 零触碰（校验只读）——AC-H1-5 的仓侧与影子侧 ──────────────
test('skills-13 校验零写盘：跑完 repo skills/** 与影子两侧的 sha 与 mtime 逐字不变', () => {
  withShadow((s) => {
    const snapshot = (absRoot) => {
      const out = new Map();
      for (const rel of relFilesOf(absRoot)) {
        const abs = path.join(absRoot, rel);
        out.set(rel, { sha: sha16(abs), mtimeMs: fs.statSync(abs).mtimeMs });
      }
      return out;
    };
    const repoBefore = snapshot(path.join(ROOT, SKILLS_REL));
    const shadowBefore = snapshot(s.shadow);
    const r = runShadow(s);
    assert.equal(r.status, 0, `全同必须绿；stderr=${r.stderr}`);
    const repoAfter = snapshot(path.join(ROOT, SKILLS_REL));
    const shadowAfter = snapshot(s.shadow);
    assert.deepEqual([...repoAfter.entries()], [...repoBefore.entries()], 'repo skills/** 零改动（内容 + mtime）');
    assert.deepEqual([...shadowAfter.entries()], [...shadowBefore.entries()], 'live 侧零改动（不 cp / 不 write / 不 rm）');
    assert.equal(repoAfter.size, repoBefore.size, 'repo skills 文件数不变');
  });
});

// ── 14. OS 噪声文件不参与比对（否则「内容全同」也会判红） ──────────────────
test('skills-14 影子里多出 .DS_Store / Thumbs.db ⇒ 不计入差异、仍 exit 0', () => {
  withShadow((s) => {
    fs.writeFileSync(path.join(s.shadow, 'video-team', '.DS_Store'), 'noise');
    fs.writeFileSync(path.join(s.shadow, 'video-team', 'Thumbs.db'), 'noise');
    const r = runShadow(s);
    assert.equal(r.status, 0, `OS 噪声文件不得判红；stderr=${r.stderr}`);
    assert.ok(
      r.stdout.includes(`file total=${relFilesOf(path.join(ROOT, SKILLS_REL)).length} same=`),
      '噪声文件既不计入 total 也不计入 diff',
    );
    assert.ok(!r.stdout.includes('.DS_Store'), '噪声文件不出现在读数里');
  });
});
