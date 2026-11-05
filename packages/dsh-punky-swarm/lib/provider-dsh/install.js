/*
Copyright (C) 2025-2026 Punky

本文件属于 provider-dsh（DSH 宿主适配层）的一部分。

【为什么安装器放在 provider-dsh 而不是引擎核心】
  「装进哪个 profile、怎么声明 bundles、怎么验证装配」全部是 **DSH 特有**的机制：
    · profile 目录布局（$DSH_HOME/profiles/<name>）
    · package.json 的 dsh.profile.bundles 字段
    · dsh --profile <name> --dump-config 的验证方式
    · dsh plugin add 会转发给 profile 目录里的 pnpm
  换到别的宿主（不同平台的插件体系），这些全都不成立。
  ⇒ 按「引擎只问适配层要能力」的分层，安装是适配层职责，不进引擎核心。

【两种安装模式】
  · link —— 开发模式：node_modules 里建立到源码目录的链接，源码改动立即生效，不打包
  · pack —— 分发模式：pnpm pack 打成 tarball 再装，与源码解耦，适合交付/CI

【一键安装的三处必配（缺功能就残）】
  dsh plugin add 只把「被 add 的包」加进 bundles，不会递归加它依赖的上游 bundle：
    · @deepseek-ai/dsh-web-app                             → 缺则没有 GUI
    · @deepseek-ai/dsh-experimental-agent-team-profile     → 缺则 agentTeams 服务不可用
  ⇒ 本安装器显式把这三项写全（引擎 + 两个上游）。
*/

import { execFileSync } from 'node:child_process';
// ⚠ 必须用默认导入 fs（不是 `import { mkdirSync, writeFileSync }`）：
//   命名导入拿到的是函数引用 ⇒ write-intercept.mjs 拦不到（它拦的是 `fs.writeFileSync` 属性访问）
//   ⇒ 结构性不可被写入拦截 ⇒ 违反引擎「lib/** 写入必须可拦截」纪律（测试 I4 会红）。
import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 引擎包自身根目录（本文件在 lib/provider-dsh/ ⇒ 上溯两层）。 */
export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * pnpm 的可执行名。
 * Windows 上 pnpm 是 .cmd：execFileSync 直接找 'pnpm' 会 ENOENT，找 'pnpm.cmd' 会 EINVAL
 * （Node 在 Windows 上不把 .cmd 当可执行文件）⇒ 必须经 shell 解析。
 *
 * ⚠ 这里的 shell:true **不违反**引擎「拒绝 shell 元字符」的纪律：
 *   那条纪律针对**产物里用户可写的 `gate:` 命令**（command-exec.js 的 runCommand）；
 *   本处参数是**代码内固定常量**（'install' / 'pack' / '--prefer-offline'），无任何用户输入。
 *   若将来要接受用户传参，必须改成「先分词、再校验元字符」而不是直接拼进 shell。
 */
export const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** 跑 pnpm 的选项（Windows 需 shell 才能解析 .cmd）。 */
const PNPM_OPTS = { shell: process.platform === 'win32' };

/** 引擎包名（从自己的 package.json 读，不硬编码）。 */
export function enginePackageName(root = ENGINE_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg.name;
}

/** DSH 家目录：优先环境变量，回落 ~/.dsh。 */
export function dshHomeOf() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** profile 目录。 */
export function profileDirOf(profileName, dshHome = dshHomeOf()) {
  return join(dshHome, 'profiles', profileName);
}

/**
 * 一键安装时必写的 bundles（顺序即加载顺序）。
 * 前两个是 DSH 官方上游；第三个是引擎自己。
 * 说明：dsh-base 是 DSH 任何 profile 的地基；缺它 profile 起不来。
 */
export function requiredBundles(engineName) {
  return [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-experimental-agent-team-profile',
    engineName,
  ];
}

/** 合并 bundles：保留已有顺序，补上缺的（幂等）。 */
export function mergeBundles(current, required) {
  const out = Array.isArray(current) ? current.filter((x) => typeof x === 'string' && x) : [];
  for (const b of required) if (!out.includes(b)) out.push(b);
  return out;
}

/**
 * 准备 profile 目录与两个基础文件（幂等）。
 * @returns {{profileDir: string, packageJsonPath: string, created: boolean}}
 */
export function ensureProfile({ profileName, dshHome = dshHomeOf() }) {
  const profileDir = profileDirOf(profileName, dshHome);
  const packageJsonPath = join(profileDir, 'package.json');
  const created = !fs.existsSync(packageJsonPath);

  fs.mkdirSync(profileDir, { recursive: true });

  if (!fs.existsSync(packageJsonPath)) {
    const seed = {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    };
    fs.writeFileSync(packageJsonPath, JSON.stringify(seed, null, 2) + '\n', 'utf8');
  }
  // cordis.yml 必须是空数组（配置走 cordis.patch.yml；这个约定来自 DSH 的 profile 根注释）
  const cordisYml = join(profileDir, 'cordis.yml');
  if (!fs.existsSync(cordisYml)) {
    fs.writeFileSync(
      cordisYml,
      [
        '# dsh profile root — an empty entry list. The tree is composed as patches:',
        "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any",
        '# --patch overlays. Edit cordis.patch.yml, not this file.',
        '[]',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  return { profileDir, packageJsonPath, created };
}

/** 把引擎写进 profile 的 dependencies + bundles（幂等；保留其它依赖）。 */
export function declareSelf({ profileName, engineName = enginePackageName(), dependencySpec, dshHome = dshHomeOf() }) {
  const { profileDir, packageJsonPath } = ensureProfile({ profileName, dshHome });
  const cfg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  cfg.dependencies = cfg.dependencies && typeof cfg.dependencies === 'object' ? cfg.dependencies : {};
  cfg.dependencies[engineName] = dependencySpec;

  cfg.dsh = cfg.dsh && typeof cfg.dsh === 'object' ? cfg.dsh : {};
  cfg.dsh.profile = cfg.dsh.profile && typeof cfg.dsh.profile === 'object' ? cfg.dsh.profile : {};
  cfg.dsh.profile.bundles = mergeBundles(cfg.dsh.profile.bundles, requiredBundles(engineName));

  fs.writeFileSync(packageJsonPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { profileDir, packageJsonPath, bundles: cfg.dsh.profile.bundles, dependencySpec };
}

/** 在 profile 目录里跑 pnpm install（link: 不下载，秒级）。 */
export function runInstall({ profileDir }) {
  // 说明：pnpm 的 link:/file: 语义与 npm 不同（npm 不支持 link: ⇒ EUNSUPPORTEDPROTOCOL）
  return execFileSync(PNPM, ['install', '--reporter=append-only', '--prefer-offline'], {
    ...PNPM_OPTS,
    cwd: profileDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 用 dsh 的 bin.js 跑 --dump-config 并解析读数。 */
export function verifyAssembly({ profileName, dshBin, nodeBin = process.execPath }) {
  const out = execFileSync(nodeBin, [dshBin, '--profile', profileName, '--dump-config'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  const sectionHeaders = (out.match(/^# == /gm) || []).length;
  const pending = (out.match(/\bpending\b/g) || []).length;
  const engineHits = 0; // 由调用方按 engineName 统计（这里只给通用读数）
  return { sectionHeaders, pending, engineHits, raw: out };
}

/**
 * 一键安装（组合：准备 profile → 声明 → 装依赖 → 可选验证）。
 * @param {object} opts
 * @param {string} opts.profileName  目标 profile 名
 * @param {'link'|'pack'} [opts.mode] 默认 link（开发）；pack 会先 pnpm pack
 * @param {string} [opts.dshHome]     DSH 家目录
 * @param {string} [opts.engineRoot]  引擎源码目录
 * @param {boolean} [opts.verify]     是否跑 --dump-config 验证
 * @param {string} [opts.dshBin]      dsh 的 bin.js（verify 必填）
 */
export function installProfile(opts) {
  const { profileName, mode = 'link', dshHome = dshHomeOf(), engineRoot = ENGINE_ROOT, verify = false, dshBin } = opts || {};
  if (!profileName || typeof profileName !== 'string') throw new Error('installProfile: 缺少 profileName');

  const engineName = enginePackageName(engineRoot);
  const steps = [];

  let dependencySpec;
  if (mode === 'pack') {
    // pack 模式：先打 tarball（与源码解耦，适合交付）
    const tgzOut = execFileSync(PNPM, ['pack', '--pack-destination', dshHome], { ...PNPM_OPTS, cwd: engineRoot, encoding: 'utf8' });
    const tgz = String(tgzOut).trim().split(/\r?\n/).filter((l) => l.endsWith('.tgz')).pop();
    if (!tgz) throw new Error('installProfile: pnpm pack 未产出 tarball');
    dependencySpec = `file:${tgz.replace(/\\/g, '/')}`;
    steps.push({ step: 'pack', tgz });
  } else {
    dependencySpec = `link:${engineRoot.replace(/\\/g, '/')}`;
    steps.push({ step: 'link', target: engineRoot });
  }

  const declared = declareSelf({ profileName, engineName, dependencySpec, dshHome });
  steps.push({ step: 'declare', bundles: declared.bundles, dependencySpec });

  runInstall({ profileDir: declared.profileDir });
  steps.push({ step: 'pnpm-install', ok: true });

  let verifyResult = null;
  if (verify) {
    if (!dshBin) throw new Error('installProfile: verify=true 时必须给 dshBin');
    verifyResult = verifyAssembly({ profileName, dshBin });
    steps.push({ step: 'verify', ...verifyResult, raw: undefined });
  }

  return { profileName, profileDir: declared.profileDir, mode, steps, verify: verifyResult };
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────
// 用法：node lib/provider-dsh/install.js --profile <name> [--mode link|pack] [--verify --dsh-bin <path>]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const profileName = argOf('--profile');
  if (!profileName) {
    console.error('用法：node lib/provider-dsh/install.js --profile <name> [--mode link|pack] [--verify --dsh-bin <path>]');
    process.exit(2);
  }
  try {
    const r = installProfile({
      profileName,
      mode: argOf('--mode') || 'link',
      verify: argv.includes('--verify'),
      dshBin: argOf('--dsh-bin'),
    });
    console.log(JSON.stringify({ ok: true, ...r, steps: r.steps }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }, null, 2));
    process.exit(1);
  }
}
