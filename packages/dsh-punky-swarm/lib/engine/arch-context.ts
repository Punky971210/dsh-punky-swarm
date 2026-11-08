
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_DOMAINS = 4;

export function pkgRootOfThisModule(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function findArchFile(start: string): string | null {
  let d = resolve(start);
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(d, '.punky', 'arch.yml');
    if (existsSync(candidate)) return candidate;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

export interface ArchRules {
  allowed: Set<string>;
  domains: Map<string, string>;
}

export function parseArchRules(text: string): ArchRules {
  const allowed = new Set<string>();
  const domains = new Map<string, string>();
  let section: string | null = null;
  let sub: string | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();

    if (indent === 0) {
      const top = /^([A-Za-z_][\w-]*):/.exec(t);
      if (top && top[1]) {
        section = top[1];
        sub = null;
        continue;
      }
    }
    if (section === 'rules' && !t.startsWith('-')) {
      const m = /^([A-Za-z_][\w-]*):/.exec(t);
      if (m && m[1]) {
        sub = m[1];
        continue;
      }
    }
    if (section === 'rules' && sub === 'allowed' && t.startsWith('-')) {
      const v = t.replace(/^-\s*/, '').replace(/^["']|["']$/g, '').trim();
      if (v.length > 0) allowed.add(v);
      continue;
    }
    if (section === 'domains' && !t.startsWith('-')) {
      const m = /^("?)([^":]+)\1:\s*(.*)$/.exec(t);
      if (m && m[2]) {
        domains.set(m[2], (m[3] ?? '').replace(/^["']|["']$/g, ''));
      }
    }
  }
  return { allowed, domains };
}

export function domainsOfTargets(libRoot: string, targets: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of targets) {
    if (typeof t !== 'string' || t.length === 0) continue;
    const abs = resolve(t);
    if (!abs.startsWith(libRoot + sep)) continue;
    const rel = abs.slice(libRoot.length + 1);
    const seg = rel.split(sep)[0];
    if (!seg) continue;
    const domain = seg.includes('.') ? '(lib-root)' : seg;
    if (!out.includes(domain)) out.push(domain);
  }
  return out;
}

export interface RenderArchContextOptions {
  pkgRoot?: string;
  targets?: readonly string[] | null;
  maxDomains?: number;
}

export function renderArchContext(opts: RenderArchContextOptions): string | null {
  const pkgRoot = opts.pkgRoot ?? pkgRootOfThisModule();
  const archFile = findArchFile(pkgRoot);
  if (!archFile) return null;

  let rules: ArchRules;
  try {
    rules = parseArchRules(readFileSync(archFile, 'utf8'));
  } catch {
    return null;
  }
  if (rules.allowed.size === 0) return null;

  const domains = domainsOfTargets(join(pkgRoot, 'lib'), opts.targets ?? []);
  if (domains.length === 0) return null;

  const max = opts.maxDomains ?? DEFAULT_MAX_DOMAINS;
  const picked = domains.slice(0, max);
  const L: string[] = [];
  L.push('## 架构约束（本 lane 涉域）');
  L.push('- 本 lane 目标文件所属域：' + picked.map((d) => '`' + d + '`').join('、')
    + (domains.length > picked.length ? '（共 ' + domains.length + ' 个，此处只列前 ' + max + ' 个）' : ''));
  for (const d of picked) {
    const from = [...rules.allowed].filter((p) => p.startsWith(d + ' -> ')).map((p) => p.split(' -> ')[1] ?? '');
    const to = [...rules.allowed].filter((p) => p.endsWith(' -> ' + d)).map((p) => p.split(' -> ')[0] ?? '');
    const desc = rules.domains.get(d);
    L.push('- `' + d + '`' + (desc ? '（' + desc + '）' : '') + ' 允许依赖：'
      + (from.length > 0 ? from.map((x) => '`' + x + '`').join('、') : '（无）'));
    L.push('  —— 可被这些域依赖：' + (to.length > 0 ? to.map((x) => '`' + x + '`').join('、') : '（无）'));
  }
  L.push('- **白名单之外的新增跨域依赖 = 违规**：门 `scripts/arch-check.mjs` 以非 0 退出码拒绝 merged。');
  L.push('- 真源 `.punky/arch.yml`；确需新增域对时，须在产物中显式说明理由。');
  return L.join('\n');
}
