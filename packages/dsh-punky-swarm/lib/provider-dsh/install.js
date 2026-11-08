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

export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const PNPM_OPTS = { shell: process.platform === 'win32' };

export function enginePackageName(root = ENGINE_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg.name;
}

export function dshHomeOf() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function profileDirOf(profileName, dshHome = dshHomeOf()) {
  return join(dshHome, 'profiles', profileName);
}

export function requiredBundles(engineName) {
  return [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-experimental-agent-team-profile',
    engineName,
  ];
}

export function mergeBundles(current, required) {
  const out = Array.isArray(current) ? current.filter((x) => typeof x === 'string' && x) : [];
  for (const b of required) if (!out.includes(b)) out.push(b);
  return out;
}

/**
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

export function runInstall({ profileDir }) {
  return execFileSync(PNPM, ['install', '--reporter=append-only', '--prefer-offline'], {
    ...PNPM_OPTS,
    cwd: profileDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function verifyAssembly({ profileName, dshBin, nodeBin = process.execPath }) {
  const out = execFileSync(nodeBin, [dshBin, '--profile', profileName, '--dump-config'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  const sectionHeaders = (out.match(/^# == /gm) || []).length;
  const pending = (out.match(/\bpending\b/g) || []).length;
  const engineHits = 0;
  return { sectionHeaders, pending, engineHits, raw: out };
}

/**
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
