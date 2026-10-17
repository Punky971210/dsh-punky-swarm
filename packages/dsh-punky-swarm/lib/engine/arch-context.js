/**
 * arch-context —— 架构上下文注入件（P2）
 *
 * 定位：把 `.punky/arch.yml`（架构真源）裁剪成**一段任务包文本**，让 worker 在开工时就读到
 * 「我改的文件属于哪个域、可依赖谁、白名单之外一律违规」。这是"执行期 Agent 可读的架构"的落点。
 *
 * 设计约束（与引擎既有惯例一致）：
 *   · **独立成件** —— `dispatch.ts` 只加一行调用，逻辑不塞进已逾千行的 `dispatch.ts`（大文件解耦）。
 *   · **零回归** —— 拿不到 arch.yml / 拿不到 targets / 域集合为空 ⇒ 返回 `null`，调用方不注入任何文本，
 *     任务包与改动前**逐字节相同**（与 `injectBudget` 缺省 `null` 的同款口径）。
 *   · **纯函数** —— 只读文件、只返回字符串；不写盘、不发事件、不改状态。
 *   · **零第三方依赖** —— 只 import `node:*`；`arch.yml` 用针对性行扫描解析本文件子集（与
 *     `scripts/arch-check.mjs` 同口径，但各自独立实现：脚本侧是门，本件是注入面）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const DEFAULT_MAX_DOMAINS = 4;
/** 本模块所在**包根**（`lib/engine/` → 上两级）。编译产物与源同置 `lib/engine/`，故源码态与运行态一致。 */
export function pkgRootOfThisModule() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
/** 自 `start` 起向上查找 `.punky/arch.yml`（最多 5 层），兼容"真源在仓库根"的布局。 */
export function findArchFile(start) {
    let d = resolve(start);
    for (let i = 0; i < 5; i += 1) {
        const candidate = join(d, '.punky', 'arch.yml');
        if (existsSync(candidate))
            return candidate;
        const up = dirname(d);
        if (up === d)
            break;
        d = up;
    }
    return null;
}
/** 解析 `arch.yml` 的本件子集（`mode` / `domains` / `rules.allowed`）；无法解析 ⇒ 空集合（调用方据此不注入）。 */
export function parseArchRules(text) {
    const allowed = new Set();
    const domains = new Map();
    let section = null;
    let sub = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '');
        if (line.trim().length === 0)
            continue;
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
            if (v.length > 0)
                allowed.add(v);
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
/** 把目标文件（绝对路径）映射到 `lib/<域>`；不在 `lib/` 下的一律忽略。 */
export function domainsOfTargets(libRoot, targets) {
    const out = [];
    for (const t of targets) {
        if (typeof t !== 'string' || t.length === 0)
            continue;
        const abs = resolve(t);
        if (!abs.startsWith(libRoot + sep))
            continue;
        const rel = abs.slice(libRoot.length + 1);
        const seg = rel.split(sep)[0];
        if (!seg)
            continue;
        const domain = seg.includes('.') ? '(lib-root)' : seg;
        if (!out.includes(domain))
            out.push(domain);
    }
    return out;
}
/** 渲染该 lane 的架构约束段；不可判定 ⇒ `null`（调用方零动作）。 */
export function renderArchContext(opts) {
    const pkgRoot = opts.pkgRoot ?? pkgRootOfThisModule();
    const archFile = findArchFile(pkgRoot);
    if (!archFile)
        return null;
    let rules;
    try {
        rules = parseArchRules(readFileSync(archFile, 'utf8'));
    }
    catch {
        return null;
    }
    if (rules.allowed.size === 0)
        return null;
    const domains = domainsOfTargets(join(pkgRoot, 'lib'), opts.targets ?? []);
    if (domains.length === 0)
        return null;
    const max = opts.maxDomains ?? DEFAULT_MAX_DOMAINS;
    const picked = domains.slice(0, max);
    const L = [];
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
