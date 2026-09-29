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

// smoke-install.mjs —— 宿主级**安装冒烟**（批 onekey-install-20260927 · lane exec-smoke · I-7 / 纪律 §10）
//
// 一条命令走完「产包 → 干净 profile 上装 → 三面断言 → 污染守卫」，全程落在 os.tmpdir() 下。
//
// ── 双变量隔离（I-7(b) · D-4 最高优先红线）────────────────────────────────────────────────
//   `lib/assets.js:210` 的 `syncAssets` 用 **`os.homedir()`** 决定落点（`<home>/.dsh/.agent-presets/` 与
//   `<home>/.agents/skills/`），**完全不读**宿主 home 环境变量。⇒ 只隔离宿主的 home 变量**不够**：
//   `os.homedir()` 在 Windows 上取自 **USERPROFILE**（跨平台回退 HOME）⇒ **必须同时**把
//   `USERPROFILE` 与 `HOME` 指到临时目录，**另加**宿主的 home 变量（`DSH_HOME`，决定 profiles 与
//   node_modules 的所在）指到另一个临时目录。三条同时隔离 = 「双变量隔离」。
//
//   同类事故在本仓**有前科**：`test/helpers/skill-paths.mjs:29-35` 记「未隔离进程里夹具把真实
//   `<home>/.agents/skills/<name>/SKILL.md` **覆写成桩**」（2026-09-18 / 09-21 两波，共 **21 件**）。
//   本脚本据此再加一道**硬门**（I-7(c)）：冒烟前后对真实 home 的守卫面逐文件 sha256，**不等即 FAIL**。
//
// ── 端口隔离（I-7(e) · D-7 实测落实，非猜）───────────────────────────────────────────────
//   实测机制（两证）：
//     ① 运行期组合树（隔离 home 上 `dsh --profile web --dump-config`）：
//        `- id: webserver / name: '@deepseek-ai/dsh-host-webserver' / config: { host: !!js ctx.webStartup.host
//         ?? '127.0.0.1', port: !!js ctx.webStartup.port ?? 3080, … }`
//     ② 旗标定义（`@deepseek-ai/dsh-web-app/lib/startup.js:22`，CLI 层实装）：
//        `.option("--port <port>", "listen port; pass 0 to let the OS pick a free one")`
//        ⇒ `web-startup` 条目解析后 `ctx.provide('webStartup', { … port: Number(options.port) })`（`:42-47`）。
//   ⇒ **端口属被引导 app 的 args**（`dsh --help`：「arguments for the booted profile's app」）⇒ 隔离入口 =
//     **`--port 0`**（OS 分配空闲端口，官方文案逐字「let the OS pick a free one」）+ `--no-open`（不弹浏览器）。
//     CLI 层确实**无**端口环境变量（与判据源 D-7 的「未发现」一致）⇒ 结论：**可隔离**，无需退免起服路径。
//
// ── 覆盖损失登记（如实）────────────────────────────────────────────────────────────────
//   · 真实 `web` profile 的**就地 boot** 不做（会以真实 home 启动、与用户正在运行的 GUI 同 home）
//     ⇒ 本冒烟证明的是「**在干净 home 上一条命令装完并起得来**」，不是「用户既有 profile 可用」。
//   · 上游团队包走 npm 网络拉取 ⇒ 无网时不具备可复跑性（脚本会以明确读数失败，**不伪造通过**）。
//
// ── 批 dualline-fix-20260929 加固（F-1 / F-2 / 形态 B 响亮化）────────────────────────────
//   ① **F-1 硬判据（两处齐备）**：`--dump-config` **与真启动**文本中 `disabling profile plugin row`
//      计数**均须 = 0**。批 6 假绿教训：三面断言（引擎行 / 模式行 / 技能指针）**均不涉及**上游三条团队
//      子包行 ⇒ 只按三面判会让「上游行被静默停用」冒充通过。
//   ② **F-2(a) 解析层确定性**：读 profile 锁文件 ⇒ 团队族（`-profile` + 三个子包）**distinct 版本数各 = 1**；
//      并可选在临时 profile 内 `pnpm install --lockfile-only` **复解析**后复算（`--no-lock-probe` 可关）。
//      ⚠ **候选来源（批 7 新前提）**：团队族四件的**唯一候选来源 = 安装命令的显式 spec**
//      （`dsh plugin add <tarball> <team-spec>`，精确钉 `<HOST_RC>`）——**不是**本包 `dependencies`
//      （批 7 · `exec-deps-fix` 已把该键整体删除，本脚本以机械化守卫防回生，见下 ⑤）。
//   ⑤ **必要条件消除的结构守卫（防回生）**：本包 `package.json` 的 `dependencies` **不得**声明团队族 `-profile`
//      —— 该声明是「旧线候选可被解析」的**唯一**来源；加回来即重建非确定性 ⇒ 守卫当场变红。
//   ③ **安装后确定性校验 + 上限重试**：`dsh plugin add` 非 0（**形态 B**）⇒ 有上限重试
//      （`INSTALL_RETRY_LIMIT`，理由见该常量）；仍失败 ⇒ **响亮**：回显 status 并采集
//      `@deepseek-ai/dsh/lib/plugin-Dr5KNRuz.js:78` 所指 `logPath` 的诊断全文（**禁静默放过**）。
//   ④ 形态 B 属**环境 / 包管理器侧**（resolver / 共享 store / registry 往返），本批**不承诺修复**（D-8）：
//      只要求它**响亮**并可核（status + logPath 诊断），**不得**用它解释形态 A（静默混合）。
//
// 用法：
//   node scripts/smoke-install.mjs [--keep] [--boot-timeout <ms>] [--skip-boot] [--pack-dir <dir>]
//   退出码：0 = GREEN（三面齐备 + 守卫全等 + 启动无激活失败）；1 = RED（任一子项失败或不可达）。
//   本脚本**不 import 任何宿主内部包**（D-6），只走 `node:` 内置模块与子进程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));
/** 真实用户主目录真源 = 系统账户 API（不受 USERPROFILE / HOME 改写影响；与 isolated-home.preload:55-58 同源）。 */
const REAL_HOME = os.userInfo().homedir;
/** 真实宿主 home（profiles 所在）——**由真实主目录拼出**，不读环境变量（防误用已被改写的值）。 */
const REAL_DSH_HOME = path.join(REAL_HOME, '.dsh');

const SKILL_NAMES = [
  'acceptance-gate', 'design-team', 'engine-team', 'research-team',
  'retro-and-memory', 'review-execution', 'software-team', 'writing-team',
];
const TEAM_PROFILE_PKG = '@deepseek-ai/dsh-experimental-agent-team-profile';

/** 形态 B（安装整体失败）的**重试上限**。
 *  理由：批 6 实测形态 B 命中率 **2/9 ≈ 22%**（环境侧、未能确定性复现）⇒ 取 **3** 次独立尝试，
 *  残余命中率按独立同分布粗估 ≈ 0.22³ ≈ 1%（数量级估计，**非承诺**）；上限写死以免「无限重试掩盖真故障」。
 *  用尽上限仍失败 ⇒ **响亮失败** + 采集 `logPath` 诊断（禁静默）。 */
const INSTALL_RETRY_LIMIT = 3;
/** F-1 判据面：行级禁用族的**全局**采集正则（`g` ⇒ 用 `matchAll` 复算，两处扫描共用）。 */
const DISABLED_ROW_RE = /disabling profile plugin row "([^"]+)"/g;
/** F-2(a) 判据面：团队族四件 = `-profile` + 三个子包（锁面 distinct 版本须各 = 1）。 */
const TEAM_FAMILY = [
  TEAM_PROFILE_PKG,
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-tool-agent-team',
  '@deepseek-ai/dsh-experimental-client-ui-agent-team',
];

/**
 * 团队包 spec 的**钉法**（I-1(b) / D-9 / D-10）。
 *
 * ⚠ 实测偏离登记（D-13，交 Leader 裁）：判据源 I-1(b) 逐字要求 spec 紧跟 `@0.1.7-rc.2` 或 `@next`；
 *   但 **D-9 同时要求「团队包四件必须同 rc，禁混用」**，而「同 rc」的基准 = **宿主 CLI 的 rc**
 *   （本机实测 `dsh --version` = `0.1.7-rc.1`）。实测后果（本 lane 首跑取证）：在 rc.1 宿主上装 rc.2 团队包，
 *   启动期 `@deepseek-ai/dsh-app-boot` 会把两行 **`disabling profile plugin row`**：
 *     · `dsh-agent-preset-punky`（`@deepseek-ai/dsh-agent-preset@0.1.7-rc.2` 需 `…preset-registry@0.1.7-rc.2`）
 *     · `ui-agent-team`（`…client-ui-agent-team@0.1.7-rc.2` 的一组 `0.1.7-rc.2` peer）
 *   ⇒ 面② 的「模式行注册成功」**在 rc.1 宿主上不成立**（fail-soft ⇒ 进程照起、模式面静默消失）。
 *   ⇒ 本脚本据此把 spec 做成**可参数化**：缺省 = **跟随宿主 rc**（`--team-spec` 可显式覆盖为 rc.2 / next 复现该偏离）。
 *   两种钉法都在 `exec/smoke.md` 留读数；**判据源措辞是否需按 D-9 收窄为「与宿主同 rc 或 @next」由 Leader 裁**。
 */
function defaultTeamSpec(hostVersion) {
  const v = String(hostVersion ?? '').trim();
  if (/^\d+\.\d+\.\d+-rc\.\d+$/.test(v)) return TEAM_PROFILE_PKG + '@' + v;
  return TEAM_PROFILE_PKG + '@next';
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const out = { keep: false, bootTimeout: 90000, skipBoot: false, packDir: '', teamSpec: '', extraSpecs: [], line: '', lockProbe: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-lock-probe') { out.lockProbe = false; continue; }
    if (a === '--keep') { out.keep = true; continue; }
    if (a === '--skip-boot') { out.skipBoot = true; continue; }
    if (a === '--boot-timeout') { out.bootTimeout = Number(argv[i + 1] ?? 90000); i += 1; continue; }
    if (a === '--pack-dir') { out.packDir = String(argv[i + 1] ?? ''); i += 1; continue; }
    if (a === '--team-spec') { out.teamSpec = String(argv[i + 1] ?? ''); i += 1; continue; }
    // `--line <label>`：双线验证用的**产物标签**（仅回显/入摘要，不参与判定）——
    //   批 dualline-compat-20260927 · C-6 要求「两线各一次运行」可区分（如 `0.2.0-rc.1` / `0.1.7-rc.2`）。
    if (a === '--line') { out.line = String(argv[i + 1] ?? ''); i += 1; continue; }
    // `--extra-spec <spec>`（可重复）：诊断用 —— 追加**顶层** profile 依赖 spec。
    //   实测用途：把「宿主同 rc 的模式注册包」提到 profile 顶层，验证 `row-disabled:dsh-agent-preset-punky`
    //   的根因与修复方向（详见脚本头注「面② 根因」段与 `exec/smoke.md`）。
    if (a === '--extra-spec') { out.extraSpecs.push(String(argv[i + 1] ?? '')); i += 1; continue; }
  }
  return out;
}

/**
 * C-6(c) 判据面：workflow 行**单行两线通吃** —— `--dump-config` / 真启动文本中
 *  ① 该行在场（`workflow-ptc`）；② 该行**无**失败诊断（激活审计族 + 行级禁用族，同 `activationDiagnosticsOf`）。
 * 依据（判据源 §二 纠正后的实测）：`@deepseek-ai/dsh-base` 在 `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1`
 *   **三版全部**依赖 `@deepseek-ai/dsh-workflow-ptc`（无任何一版依赖旧推进器包）⇒ 单行即双线正解。
 */
const WORKFLOW_ROW_ID = 'workflow-ptc';

/**
 * 面② 的**根因**（本 lane 实测，两臂复现）：
 *   本引擎 `package.json` 的 `dependencies` 声明 `"@deepseek-ai/dsh-agent-preset": "^0.1.7-rc.1"`。
 *   `^0.1.7-rc.1` 的语义 = `>=0.1.7-rc.1 <0.2.0`（prerelease 限同 `[0,1,7]` 元组）⇒ **`0.1.7-rc.2` 满足且更高**
 *   ⇒ pnpm 按「满足 range 的最高版」解析 ⇒ 实装 `@deepseek-ai/dsh-agent-preset@0.1.7-rc.2`
 *   ⇒ 该版 peer 钉 `@deepseek-ai/dsh-agent-preset-registry@0.1.7-rc.2` ⇒ **与宿主 CLI `0.1.7-rc.1` 不兼容**
 *   ⇒ app-boot 直接 `disabling profile plugin row` 三行：`preset-minimal` / `preset-cordis` / **`dsh-agent-preset-punky`**。
 *   ⇒ **与团队包 spec 的 rc 无关**（rc.1 与 rc.2 两臂同fail）——根因在**本包依赖 range 的解析结果**。
 *   用 `--extra-spec @deepseek-ai/dsh-agent-preset@<宿主rc>` 把该包提到 profile **顶层**（顶层版本优先生效）
 *   即可验证修复方向；本轮实测该臂 **面② 转绿**（读数见 `exec/smoke.md`）。
 */

/**
 * 启动期诊断判据（**两族措辞都要抓**，缺一即假绿）：
 *   · 激活审计族：`did not activate` / `waiting for services: agentPresets`；
 *   · **行级禁用族**：`disabling profile plugin row "<id>"`（实测形态：rc 不匹配时 app-boot 直接停用该行）。
 * 首跑实测教训：只抓第一族会让「rc.2 行被禁用」冒充通过（假绿）⇒ 两族并列断言。
 */
function activationDiagnosticsOf(text, rowId) {
  const hits = [];
  if (/did not activate/.test(text)) hits.push('did-not-activate');
  if (/waiting for services: agentPresets/.test(text)) hits.push('pending-agentPresets');
  if (rowId && text.includes('disabling profile plugin row "' + rowId + '"')) hits.push('row-disabled:' + rowId);
  return hits;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** F-1 判据面：文本中**全部**被禁用的 profile 行 id（dump 面与真启动面共用，禁各写一套）。 */
function disabledRowsOf(text) {
  return [...String(text ?? '').matchAll(DISABLED_ROW_RE)].map((m) => m[1]);
}

/** F-2(a) 判据面：从 pnpm 锁文件文本取「包名 → distinct 版本集合」。
 *  只认**锁键行**（缩进 ≥2 且以 `@scope/name@ver` 起头、以冒号收尾），兼容 `packages:` /
 *  `snapshots:` 两段与 `@ver(peer@x)` 的 peer 后缀；⇒ 不会把 `resolution:`/`tarball:` 行误当版本。 */
function teamVersionsFromLock(lockText) {
  const out = new Map();
  for (const raw of String(lockText ?? '').split(/\r?\n/)) {
    const key = /^\s{2,}'?(@deepseek-ai\/[^@']+)@([0-9][^'():]*)'?(?:\(.*\))?:\s*$/.exec(raw);
    if (!key) continue;
    if (!out.has(key[1])) out.set(key[1], new Set());
    out.get(key[1]).add(key[2]);
  }
  return out;
}

/** F-2(a) 的**复解析**臂：在临时 profile 内跑 `pnpm install --lockfile-only --ignore-scripts`。
 *  失败 ⇒ `ran:false` + 原始尾部读数（**不**判 PASS、也**不**静默）；由调用方登记取值来源。 */
function runLockProbe(profileDir) {
  const jsEntry = process.env.PUNKY_PNPM_BIN ?? '';
  const cliArgs = ['install', '--lockfile-only', '--ignore-scripts'];
  const r = jsEntry
    ? spawnSync(process.execPath, [jsEntry, ...cliArgs], { encoding: 'utf8', timeout: 300000, cwd: profileDir, windowsHide: true })
    : spawnSync('pnpm ' + cliArgs.join(' '), { shell: true, encoding: 'utf8', timeout: 300000, cwd: profileDir, windowsHide: true });
  return {
    ran: r.status === 0,
    status: r.status,
    stdout: String(r.stdout ?? '').slice(-1200),
    stderr: String(r.stderr ?? '').slice(-1200),
  };
}

/** 逐文件 sha256 快照（只读，零写入）。 */
function snapshotTree(root) {
  const entries = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) entries.push([p, sha(fs.readFileSync(p))]);
    }
  };
  walk(root);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    entries,
    digest: sha(Buffer.from(entries.map(([p, h]) => h + '\t' + p).join('\n'), 'utf8')),
  };
}

/** I-7(c) 守卫面：真实 home 的两处目标树（`.agents/skills/**` + `.dsh/.agent-presets/punky-preset/**`）。 */
function realHomeGuard() {
  const skills = snapshotTree(path.join(REAL_HOME, '.agents', 'skills'));
  const preset = snapshotTree(path.join(REAL_DSH_HOME, '.agent-presets', 'punky-preset'));
  const entries = [...skills.entries, ...preset.entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    files: entries.length,
    entries,
    digest: sha(Buffer.from(entries.map(([p, h]) => h + '\t' + p).join('\n'), 'utf8')),
  };
}

function guardDiff(before, after) {
  const b = new Map(before.entries);
  const a = new Map(after.entries);
  const changed = [];
  for (const [p, h] of a) if (b.get(p) !== h) changed.push('CHANGED ' + p);
  for (const [p] of b) if (!a.has(p)) changed.push('DELETED ' + p);
  return changed;
}

/** 定位 dsh 启动器（`lib/bin.js`）；可用 PUNKY_DSH_BIN 覆盖，避免依赖 PATH 上的 .cmd 壳。 */
function resolveDshBin() {
  const candidates = [];
  if (process.env.PUNKY_DSH_BIN) candidates.push(process.env.PUNKY_DSH_BIN);
  candidates.push('D:\\Program Files\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js');
  const prefixes = [process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '', '/usr/local/lib', '/usr/lib'];
  for (const p of prefixes) {
    if (!p) continue;
    candidates.push(path.join(p, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return '';
}

/** 子进程统一入口：**一律**在隔离 env 下运行（唯一例外：`pnpm pack`，见调用处注释）。 */
function runChild(bin, args, env, timeoutMs) {
  const r = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: timeoutMs, cwd: PKG_ROOT });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? String(r.error.code) + ':' + r.error.message : '',
    args,
  };
}

/**
 * `pnpm pack`（本脚本唯一的非隔离子进程）：只读仓库 + 只写 `--pack-destination` 指向的临时目录，
 * 不触任何 home 面。Windows 上 `pnpm` 是 corepack 的 `.cmd` 垫片（实测路径 `D:\Program Files\nodejs\pnpm.CMD`）
 * ⇒ 无 `pnpm.cjs` 可直接 `execPath` 执行，故走 shell 分支；可用 PUNKY_PNPM_BIN 指定 JS 入口。
 */
function packTarball(packDir) {
  const jsEntry = process.env.PUNKY_PNPM_BIN ?? '';
  if (jsEntry) {
    const r = spawnSync(process.execPath, [jsEntry, 'pack', '--pack-destination', packDir],
      { encoding: 'utf8', timeout: 180000, cwd: PKG_ROOT });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  const quoted = '"' + packDir.replace(/"/g, '') + '"';
  const r = spawnSync('pnpm pack --pack-destination ' + quoted,
    { shell: true, encoding: 'utf8', timeout: 180000, cwd: PKG_ROOT, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 异步启动 + 到点杀掉：拿「真实启动」的 stdout/stderr 证据（I-7(e) 的真启动路径）。 */
function bootThenCapture(bin, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { env, cwd: PKG_ROOT });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 2000);
      resolve({ how, stdout, stderr, code: child.exitCode ?? null, signal: child.signalCode ?? null });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code, signal) => { clearTimeout(timer); finish('exit:' + String(code) + '/' + String(signal)); });
    child.on('error', (e) => { stderr += '\n[spawn error] ' + String(e && e.message); clearTimeout(timer); finish('spawn-error'); });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = { steps: [], checks: [], red: [], green: [] };
  const note = (line) => { report.steps.push(line); process.stdout.write('[smoke] ' + line + '\n'); };
  const check = (label, ok, detail) => {
    report.checks.push({ label, ok: !!ok, detail: detail ?? '' });
    process.stdout.write('[smoke]   ' + (ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' —— ' + detail : '') + '\n');
    return !!ok;
  };

  // ── 步骤 ②：真实 home 守卫基线（**在任何子进程之前**）──────────────────────────────
  const before = realHomeGuard();
  note('守卫基线（真实 home）：files=' + String(before.files) + ' digest=' + before.digest);
  check('I-7(c) 守卫面可达构造', before.files > 0, 'files=' + String(before.files));

  // ── 步骤 ①：临时根 + **双变量隔离** env ────────────────────────────────────────────
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'punky-smoke-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const tmpDshHome = path.join(tmpRoot, 'dsh-home');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(tmpDshHome, { recursive: true });
  // 三变量同时隔离：DSH_HOME（profiles/node_modules）+ USERPROFILE/HOME（os.homedir() ⇒ 资产落点）
  const ISO_ENV = { ...process.env, DSH_HOME: tmpDshHome, USERPROFILE: tmpHome, HOME: tmpHome };
  note('隔离根：TMP=' + tmpRoot + '  home=' + tmpHome + '  dsh-home=' + tmpDshHome);
  check('I-7(b) 子进程 env 同时隔离三变量',
    ISO_ENV.DSH_HOME === tmpDshHome && ISO_ENV.USERPROFILE === tmpHome && ISO_ENV.HOME === tmpHome,
    'DSH_HOME + USERPROFILE + HOME');

  const dshBin = resolveDshBin();
  if (!dshBin) {
    note('RED：未找到 dsh 启动器（可用 PUNKY_DSH_BIN 指定 lib/bin.js）');
    report.red.push('dsh-bin-not-found');
    return { ok: false, report, tmpRoot };
  }
  note('dsh 启动器：' + dshBin);

  const hostVersion = runChild(dshBin, ['--version'], ISO_ENV, 60000).stdout.trim();
  const teamSpec = args.teamSpec || defaultTeamSpec(hostVersion);
  note('宿主 CLI 版本：' + hostVersion + '  ⇒ 团队包 spec=' + teamSpec
    + (args.teamSpec ? '（--team-spec 显式覆盖）' : '（缺省 = 跟随宿主 rc）'));

  // ── 步骤 ③：pnpm pack（**普通 env**：只读仓库 + 只写 pack 目的目录，不触 home）──────
  const pkg = readJson(path.join(PKG_ROOT, 'package.json')) ?? {};

  // ── D-1 机械化守卫：「必要条件已消除」的结构断言（**防回生**）──────────────────────────
  //   批 7 · `exec-deps-fix` 交付：本包 `package.json` **删除了整个 `dependencies` 键** ⇒
  //   团队族四件的**唯一候选来源 = 安装命令的显式 spec**（精确钉宿主 rc）；本包不再引入任何旧线候选。
  //   本守卫把该结构事实**机检化**（防未来有人把 `dependencies` 里的 `-profile` 声明加回去 ——
  //   那会让「旧线候选可被解析」这一**必要条件**重建 ⇒ 非确定性卷土重来）。
  //   口径（按 Leader 2026-09-29 转发的新前提，二者取其一）：取**「其值不得含团队族 `-profile`」**一支
  //   —— 比「`dependencies` 键必须整体缺席」更耐用（未来无关的新增依赖不该造成假红），
  //   且**正是**必要条件本身；「键是否在场」作为**登记读数**回显（不升级为判据）。
  const declaredDeps = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : [];
  note('必要条件守卫读数：dependencies 键=' + (pkg.dependencies === undefined ? '缺席' : '在场')
    + ' 声明项=' + JSON.stringify(declaredDeps));
  check('D-1 机械化守卫：本包 dependencies 不声明团队族 -profile（唯一候选来源 = 安装命令 spec）',
    !declaredDeps.includes(TEAM_PROFILE_PKG),
    'declared=' + JSON.stringify(declaredDeps) + ' 命中=' + String(declaredDeps.includes(TEAM_PROFILE_PKG)));
  const tgzName = String(pkg.name).replace(/^@[^/]+\//, '') + '-' + String(pkg.version) + '.tgz';
  const packDir = args.packDir || path.join(tmpRoot, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const pack = packTarball(packDir);
  const tarball = path.join(packDir, tgzName);
  const packOk = pack.status === 0 && fs.existsSync(tarball);
  note('pnpm pack：status=' + String(pack.status) + ' tarball=' + tarball);
  if (!packOk) {
    process.stdout.write('[smoke] --- pnpm pack stdout ---\n' + String(pack.stdout ?? '') + '\n--- stderr ---\n' + String(pack.stderr ?? '') + '\n');
    report.red.push('pnpm-pack-failed');
    return { ok: false, report, tmpRoot };
  }
  check('I-1/I-3 可分发包产出（pnpm pack）', packOk, tgzName + ' bytes=' + String(fs.statSync(tarball).size));

  // ── 步骤 ③：唯一安装命令（I-1 形态；团队包 spec 显式列出且钉版本，D-10）──────────
  const installSpecs = [tarball, teamSpec, ...args.extraSpecs];
  note('安装命令：dsh plugin --profile web add ' + installSpecs.map((s) => (s === tarball ? '<tarball>' : s)).join(' '));
  report.installSpecs = installSpecs.map((s) => (s === tarball ? '<tarball>' : s));
  // 形态 B（安装整体失败）⇒ **有上限重试**（每次落读数）；用尽上限仍失败 ⇒ **响亮** + 采集 logPath 诊断。
  //   logPath 来源：`@deepseek-ai/dsh/lib/plugin-Dr5KNRuz.js:78` 失败时写
  //   `dsh: plugin command failed; diagnostics: <logPath>` ⇒ 从 stderr/stdout 抓该路径后读其内容（禁静默）。
  const installAttempts = [];
  let install = { status: null, signal: null, error: '', stdout: '', stderr: '' };
  const installDiagnostics = { path: '', bytes: null, tail: '', error: '' };
  for (let attempt = 1; attempt <= INSTALL_RETRY_LIMIT; attempt += 1) {
    install = runChild(dshBin, ['plugin', '--profile', 'web', 'add', ...installSpecs], ISO_ENV, 600000);
    installAttempts.push({ attempt, status: install.status, signal: install.signal, error: install.error });
    note('  安装第 ' + String(attempt) + '/' + String(INSTALL_RETRY_LIMIT) + ' 次：status=' + String(install.status)
      + ' signal=' + String(install.signal) + ' error=' + install.error);
    if (install.status === 0) break;
    const hit = /diagnostics:\s*(.+?)\s*$/m.exec(String(install.stderr ?? '') + '\n' + String(install.stdout ?? ''));
    if (hit) {
      const logPath = hit[1].replace(/^["']|["']$/g, '');
      installDiagnostics.path = logPath;
      try {
        const txt = fs.readFileSync(logPath, 'utf8');
        installDiagnostics.bytes = txt.length;
        installDiagnostics.tail = txt.slice(-3000);
      } catch (e) {
        installDiagnostics.error = String(e && e.message);
      }
    }
    if (attempt < INSTALL_RETRY_LIMIT) {
      note('  形态 B 命中 ⇒ 有上限重试（上限 ' + String(INSTALL_RETRY_LIMIT) + '；理由见脚本头注与 INSTALL_RETRY_LIMIT）');
    }
  }
  report.installAttempts = installAttempts;
  report.installDiagnostics = { path: installDiagnostics.path, bytes: installDiagnostics.bytes, error: installDiagnostics.error };
  if (install.status !== 0) {
    process.stdout.write('[smoke] --- install stdout (tail) ---\n' + String(install.stdout ?? '').slice(-4000) + '\n--- install stderr (tail) ---\n' + String(install.stderr ?? '').slice(-4000) + '\n');
    process.stdout.write('[smoke] --- 形态 B 诊断（plugin-Dr5KNRuz.js:78 的 logPath）---\n'
      + 'path=' + (installDiagnostics.path || '(未在输出中找到 diagnostics: 路径)') + '\n'
      + (installDiagnostics.error ? 'read-error=' + installDiagnostics.error + '\n' : '')
      + 'bytes=' + String(installDiagnostics.bytes) + '\n' + installDiagnostics.tail + '\n');
    report.red.push('install-formB-failed');
  }
  check('I-2 干净 profile 上安装成功（形态 B 具备上限重试 ' + String(INSTALL_RETRY_LIMIT) + ' 次）',
    install.status === 0, 'attempts=' + JSON.stringify(installAttempts));

  // ── 步骤 ④：面①/② —— 组合树两行同时在（`--dump-config`，共用 boot 的 patch 算法）───
  const dump = runChild(dshBin, ['--profile', 'web', '--dump-config'], ISO_ENV, 180000);
  const dumpText = dump.stdout + dump.stderr;
  check('面① dump 含本引擎行 dsh-punky-swarm', dump.stdout.includes('dsh-punky-swarm'), 'status=' + String(dump.status));
  check('面② dump 含模式注册行 dsh-agent-preset-punky', dump.stdout.includes('dsh-agent-preset-punky'), 'status=' + String(dump.status));
  const dumpDiag = activationDiagnosticsOf(dumpText, 'dsh-agent-preset-punky');
  check('面② 组合树零激活失败/零行禁用诊断（dump 面）', dumpDiag.length === 0,
    'diagnostics=' + JSON.stringify(dumpDiag) + ' dump 文本长度=' + String(dumpText.length));

  // ── F-1(a)：**dump 面** profile 零行禁用（硬判据 · 批 6 假绿教训的回写）────────────────
  //   覆盖面 = **整个 profile 组合**（不只是已知名字的三行）：上游团队子包的版本错配会体现为
  //   `disabling profile plugin row "<其它 id>"` ⇒ 只查三行会「假绿」放行。
  const dumpDisabled = disabledRowsOf(dumpText);
  report.disabledRowsDump = dumpDisabled;
  check('F-1(a) --dump-config 面 profile 零行禁用', dumpDisabled.length === 0,
    'disabled_count=' + String(dumpDisabled.length) + ' disabled=' + JSON.stringify(dumpDisabled));

  // ── 步骤 ④a′：C-6(c) workflow 面**单行两线通吃**（dump 面）────────────────────────────
  //   双线同源依据见 `WORKFLOW_ROW_ID` 的 docstring；此处断言「行在场 + 零失败诊断」。
  check('C-6(c) dump 含 workflow 行 ' + WORKFLOW_ROW_ID, dump.stdout.includes(WORKFLOW_ROW_ID),
    'status=' + String(dump.status));
  const dumpDiagWf = activationDiagnosticsOf(dumpText, WORKFLOW_ROW_ID);
  check('C-6(c) dump 面 workflow 行零激活失败/零行禁用', dumpDiagWf.length === 0,
    'diagnostics=' + JSON.stringify(dumpDiagWf));
  // 反向锁：旧推进器包名不得在组合树里出现（判据源 D-4 禁回加；名字在此**拼装**构造，不写字面量）
  const LEGACY_PUSHER = 'dsh-workflow-' + 'worker-thread';
  check('C-6(c) 组合树零命中旧推进器包（禁回加）', !dumpText.includes(LEGACY_PUSHER),
    'searched=' + LEGACY_PUSHER);

  // ── 步骤 ④b：**真实启动**（隔离 home + `--port 0` 端口隔离 + `--no-open`）──────────
  //   为什么必须真启动：① 面② 的「该行无激活失败诊断」只在 boot 的 activation audit 里产生
  //   （`--dump-config` 不出该诊断 ⇒ 只看 dump 会构成**空转断言**，纪律 §15⑤）；
  //   ② 面③ 的资产落盘由 `lib/index.js#apply()` 的 `syncAssets()` 触发，**只在加载插件时发生**。
  let boot = { how: 'skipped', stdout: '', stderr: '' };
  let bootPort = '';
  if (!args.skipBoot) {
    boot = await bootThenCapture(dshBin, ['--profile', 'web', '--port', '0', '--no-open'], ISO_ENV, args.bootTimeout);
    const bootText = boot.stdout + boot.stderr;
    process.stdout.write('[smoke] --- boot stdout (tail 2000) ---\n' + boot.stdout.slice(-2000) + '\n--- boot stderr (tail 2000) ---\n' + boot.stderr.slice(-2000) + '\n');
    const urlHit = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(bootText);
    bootPort = urlHit ? urlHit[1] : '';
    check('I-7(e) 真启动可达（端口隔离机制 `--port 0`）', !!urlHit, 'how=' + boot.how + ' url_port=' + (bootPort || '-'));

    // D-7 / C-6(d) 强证据：`--port 0` 必须拿到**不在占用集内**的 OS 分配端口。
    //   占用集 = {3080 组合树缺省（用户 GUI 端口）, 3081 iso-web, 3082 iso-perf}（批 cmd 明列，禁猜）。
    const OCCUPIED_PORTS = ['3080', '3081', '3082'];
    check('C-6(d) 端口隔离生效（实测端口 ∉ {3080,3081,3082}）',
      bootPort !== '' && !OCCUPIED_PORTS.includes(bootPort),
      '实测端口=' + (bootPort || '-') + ' 占用集=' + JSON.stringify(OCCUPIED_PORTS));

    const bootDiagPreset = activationDiagnosticsOf(bootText, 'dsh-agent-preset-punky');
    const bootDiagEngine = activationDiagnosticsOf(bootText, 'dsh-punky-swarm');
    const bootDiagWf = activationDiagnosticsOf(bootText, WORKFLOW_ROW_ID);
    check('面② 真启动：模式行零激活失败/零行禁用', bootDiagPreset.length === 0,
      'diagnostics=' + JSON.stringify(bootDiagPreset) + ' how=' + boot.how);
    check('面① 真启动：本引擎行零激活失败/零行禁用', bootDiagEngine.length === 0,
      'diagnostics=' + JSON.stringify(bootDiagEngine) + ' how=' + boot.how);
    check('C-6(c) 真启动：workflow 行零激活失败/零行禁用', bootDiagWf.length === 0,
      'diagnostics=' + JSON.stringify(bootDiagWf) + ' how=' + boot.how);

    // ── F-1(b)：**真启动面** profile 零行禁用（**硬判据**；原 C-6「全局限用」升格）──────────
    //   为什么必须真启动：`activation audit` **只在 boot 产生**（D-12）⇒ 只跑 `--dump-config` 覆盖不到本子项。
    //   为什么必须**全局**扫描：逐行断言（面①/面②/workflow）只覆盖已知名字的三行；两线适配的真实风险是
    //   「**上游团队行的版本错配**」⇒ 只查三行会让「其它团队行被静默停用」冒充通过（批 6 假绿）。
    //   干净 home + 宿主同线 spec 下应为 **0 行**；宿主异线（0.2.0 宿主 + `@0.1.7-rc.2`）应为 **>0**。
    const disabledRows = disabledRowsOf(bootText);
    check('F-1(b) 真启动面 profile 零行禁用（原 C-6 全局判据升格）', disabledRows.length === 0,
      'disabled_count=' + String(disabledRows.length) + ' disabled=' + JSON.stringify(disabledRows));
    report.disabledRows = disabledRows;

    check('面② 真启动无 agentPresets 服务等待（模式面已挂载）',
      !/waiting for services: agentPresets/.test(bootText), 'how=' + boot.how);
  } else {
    note('（--skip-boot）跳过真启动 ⇒ 面② 仅 dump 面、面③ 断言将不可达（覆盖损失如实登记）');
    note('（--skip-boot）⇒ **F-1(b) 真启动面零行禁用【未覆盖】**（D-12：不得判 pass，只能登记覆盖损失）');
  }
  report.boot = { how: boot.how, port: bootPort, teamSpec, hostVersion, line: args.line || null };

  // ── F-2(a)：**解析层 / 安装面确定性**（团队族 distinct 版本各 = 1，且 = 宿主同线）────────
  //   「修复 = 非确定性归零」的可机检面（判据源 F-2(a)）：**禁只解析层判一次就收工**——
  //   本块同时给「锁面」与「安装面」两个可核读数；取值来源**显式登记**（禁静默回落）：
  //     ① 首选：`pnpm install --lockfile-only --ignore-scripts` **复解析**后的锁（`--no-lock-probe` 可关）；
  //     ② 复解析失败（离线 / pnpm 不可用）⇒ 回落**安装产物锁**，并在读数里如实标注来源。
  const profileDir = path.join(tmpDshHome, 'profiles', 'web');
  const lockFile = path.join(profileDir, 'pnpm-lock.yaml');
  const lockProbe = args.lockProbe
    ? { ...runLockProbe(profileDir), skipped: false }
    : { ran: false, skipped: true, status: null, stdout: '', stderr: '' };
  const lockText = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : '';
  const lockSource = lockProbe.ran ? 'lockfile-only-复解析' : (lockText ? '安装产物锁' : 'missing');
  note('F-2(a) 锁来源=' + lockSource + '（复解析 ran=' + String(lockProbe.ran) + ' status=' + String(lockProbe.status)
    + ' skipped=' + String(!!lockProbe.skipped) + '）lockFile=' + lockFile);
  if (!lockProbe.ran && !lockProbe.skipped) {
    process.stdout.write('[smoke] --- lock probe stderr (tail) ---\n' + String(lockProbe.stderr ?? '') + '\n');
  }
  const teamVersions = teamVersionsFromLock(lockText);
  const familyRows = TEAM_FAMILY.map((p) => ({ pkg: p, versions: [...(teamVersions.get(p) ?? [])] }));
  const distinctAll = [...new Set(familyRows.flatMap((r) => r.versions))];
  const presentCount = familyRows.filter((r) => r.versions.length > 0).length;
  report.lockSource = lockSource;
  report.teamVersions = familyRows;
  report.teamVersionsDistinct = distinctAll;
  check('F-2(a) 锁面：团队族 distinct 版本数 = 1', distinctAll.length === 1,
    'distinct=' + JSON.stringify(distinctAll) + ' 来源=' + lockSource);
  check('F-2(a) 锁面：团队族**每个在场包**各自 distinct 版本数 = 1', familyRows.every((r) => r.versions.length === 1),
    JSON.stringify(familyRows));
  //   防空转下界：至少 4 件中的 3 件在锁里在场（空锁 / 解析器退化不得冒充通过）
  check('F-2(a) 锁面：团队族在场包数 ≥ 3（防空转下界）', presentCount >= 3,
    'present=' + String(presentCount) + '/' + String(TEAM_FAMILY.length));
  //   「与宿主同线」——安装后确定性校验的核心（禁只判「只有一个版本」而不管它是哪条线）
  check('F-2(a) 锁面：团队族版本 = 宿主同线（= dsh --version）', distinctAll.length === 1 && distinctAll[0] === hostVersion,
    'host=' + hostVersion + ' team=' + JSON.stringify(distinctAll));

  // ── 步骤 ④：面③ —— 技能指针 8 件 + references 非空（**在临时 home 上**）─────────────
  const skillHits = SKILL_NAMES.filter((n) => fs.existsSync(path.join(tmpHome, '.agents', 'skills', n, 'SKILL.md')));
  const refs = path.join(tmpHome, '.dsh', '.agent-presets', 'punky-preset', 'references');
  const refCount = fs.existsSync(refs) ? fs.readdirSync(refs).length : 0;
  check('面③ 技能指针 8 件全在', skillHits.length === SKILL_NAMES.length, skillHits.length + '/8：' + skillHits.join(','));
  check('面③ references 目录非空', refCount > 0, refs + ' 条目=' + String(refCount));
  check('面③ 指引正档 preset.yml 到位', fs.existsSync(path.join(tmpHome, '.dsh', '.agent-presets', 'punky-preset', 'preset.yml')), '');

  // ── 步骤 ⑤：守卫复算（I-7(c) 硬门）────────────────────────────────────────────────
  const after = realHomeGuard();
  const drift = guardDiff(before, after);
  note('守卫复算（真实 home）：files=' + String(after.files) + ' digest=' + after.digest);
  const guardOk = before.digest === after.digest && before.files === after.files;
  check('I-7(c) 真实 home 零污染（前后逐文件 sha256 全等）', guardOk,
    guardOk ? 'PASS 逐文件全等' : 'FAIL 漂移 ' + String(drift.length) + ' 项');
  if (!guardOk) for (const d of drift) process.stdout.write('[smoke]     ' + d + '\n');

  // ── 步骤 ⑥：清理（守卫失败时**保留现场**）─────────────────────────────────────────
  const keepTmp = args.keep || !guardOk;
  if (!keepTmp) fs.rmSync(tmpRoot, { recursive: true, force: true });
  note('临时根：' + (keepTmp ? '保留（取证）' : '已清理') + ' —— ' + tmpRoot);

  const failed = report.checks.filter((c) => !c.ok);
  const ok = failed.length === 0;
  process.stdout.write('[smoke] ===== ' + (ok ? 'GREEN' : 'RED') + '：checks ' + String(report.checks.length)
    + ' / pass ' + String(report.checks.length - failed.length) + ' / fail ' + String(failed.length) + '\n');
  for (const f of failed) process.stdout.write('[smoke]   FAILED: ' + f.label + ' —— ' + f.detail + '\n');
  // 机读摘要（供 `exec/smoke.md` 逐字抄录，免手抄失真）
  process.stdout.write('[smoke] SMOKE_SUMMARY=' + JSON.stringify({
    hostVersion, teamSpec, installSpecs: report.installSpecs ?? [], boot: report.boot ?? null,
    disabledRows: report.disabledRows ?? null,
    disabledRowsDump: report.disabledRowsDump ?? null,
    disabledCountDump: (report.disabledRowsDump ?? []).length,
    disabledCountBoot: (report.disabledRows ?? []).length,
    installAttempts: report.installAttempts ?? null,
    installDiagnostics: report.installDiagnostics ?? null,
    lockSource: report.lockSource ?? null,
    teamVersions: report.teamVersions ?? null,
    teamVersionsDistinct: report.teamVersionsDistinct ?? null,
    guard: { before: before.digest, after: after.digest, files: before.files, ok: guardOk },
    tarballBytes: fs.existsSync(tarball) ? fs.statSync(tarball).size : null,
    checks: report.checks.map((c) => ({ label: c.label, ok: c.ok, detail: c.detail })),
    verdict: ok ? 'GREEN' : 'RED',
  }) + '\n');
  return { ok, report, tmpRoot, tarball };
}

const out = await main();
process.exit(out.ok ? 0 : 1);
