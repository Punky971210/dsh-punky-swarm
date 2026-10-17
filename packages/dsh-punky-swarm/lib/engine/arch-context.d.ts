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
export declare const DEFAULT_MAX_DOMAINS = 4;
/** 本模块所在**包根**（`lib/engine/` → 上两级）。编译产物与源同置 `lib/engine/`，故源码态与运行态一致。 */
export declare function pkgRootOfThisModule(): string;
/** 自 `start` 起向上查找 `.punky/arch.yml`（最多 5 层），兼容"真源在仓库根"的布局。 */
export declare function findArchFile(start: string): string | null;
export interface ArchRules {
    /** 允许的 `<from> -> <to>` 域对。 */
    allowed: Set<string>;
    /** 域 → 简述。 */
    domains: Map<string, string>;
}
/** 解析 `arch.yml` 的本件子集（`mode` / `domains` / `rules.allowed`）；无法解析 ⇒ 空集合（调用方据此不注入）。 */
export declare function parseArchRules(text: string): ArchRules;
/** 把目标文件（绝对路径）映射到 `lib/<域>`；不在 `lib/` 下的一律忽略。 */
export declare function domainsOfTargets(libRoot: string, targets: readonly string[]): string[];
export interface RenderArchContextOptions {
    /** 包根（缺省 = 本模块所在包）。 */
    pkgRoot?: string;
    /** lane 的目标文件（绝对路径）；缺省/空 ⇒ 不注入。 */
    targets?: readonly string[] | null;
    /** 单条 lane 最多注入几个域的约束（防上下文膨胀）。 */
    maxDomains?: number;
}
/** 渲染该 lane 的架构约束段；不可判定 ⇒ `null`（调用方零动作）。 */
export declare function renderArchContext(opts: RenderArchContextOptions): string | null;
