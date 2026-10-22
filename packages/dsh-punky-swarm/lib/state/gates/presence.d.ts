export type PresenceMode = 'declare' | 'runtime';
/** 空内容原因行留痕（`gate.escape{kind:'empty-artifact-noted'}` 的载荷）。 */
export interface PresenceNote {
    artifact: string;
    reason: string;
}
export interface PresenceVerdict {
    ok: boolean;
    mode: PresenceMode;
    layer: string | null;
    declaredKind: string | null;
    path: string | null;
    kind: 'file' | 'dir';
    code: string | null;
    problems: string[];
    notes: PresenceNote[];
}
/** `presenceJudge` 的入参形态（原闭包内联形参类型**逐字搬移**为新具名类型；建批期 / 运行期两 mode 共用）。 */
export interface PresenceInput {
    mode?: PresenceMode;
    layer?: string | null;
    declared?: unknown;
    declaredKind?: string | null;
    abs?: string | null;
    content?: string | null;
    artifactsRoot?: string | null;
}
/** 声明形态（R-1）：按**声明原文**判定（`/` 结尾 = 目录语义），不做尾斜杠规范化。 */
export declare function declaredKindOf(declared: string): 'file' | 'dir';
/** 原因行判定：**行首锚定 + 非空文本**（R-2；行中出现 / 前导空白 / 空文本 ⇒ 不命中）。 */
export declare function emptyReasonOf(content: string): string | null;
/** 「可空」的定义（O-4.1）：扣除原因行后**无任何实质内容**。 */
export declare function substantiveContentOf(content: string): string;
/** 判据章节**裸标题行**判定（S10 最低内容判据）：行首锚定 + 整行仅标题（编号变体/正文提及均不命中）。 */
export declare function sectionLineHit(content: string, section: string): boolean;
/**
 * 元素声明行判定（R1 §2.4 #3）：行首锚定 + 独立整行 `element: <id>`。
 *  与既有行族同构（`reason:` / `gate:` / `targets-claimed:` / `empty-reason:`）；不用 `content.includes(id)`
 *  是因为元素 id（如 `goal`）通常极短，`includes` 会把任意词命中 ⇒ 判据不可靠（假绿风险）。
 *  `id` 按**字面量**转义后匹配（与 `sectionLineHit` 同法，防正则元字符）。
 */
export declare function elementLineHit(content: string, id: string): boolean;
/** 路径归属判定（P8）：绝对路径产物必须在批次产物根内。 */
export declare function isInsideRoot(absPath: string, rootDir: string): boolean;
/** 解权档选项。 */
export interface InsideRootResolvedOptions {
    /**
     * `true` = 目标**允许尚不存在**（写面：目标由本次调用创建）⇒ 解权「最近既有祖先」+ 剩余段。
     * `false`（缺省）= 目标本身须可解权；解不了（不存在/断链/权限）⇒ `false`。
     */
    allowMissing?: boolean;
}
/**
 * 路径归属判定（**解权档** · A1-P1-03）：绝对路径产物在**解权后**必须仍在批次产物根内。
 *   · 词法档必过（既有拒绝面逐字保留：`../` / 根外绝对 / 跨盘盘符 / UNC 一律先拒）；
 *   · **两侧都 realpath**（禁「未解权 root + 已解权 abs」混用：Windows 大小写/短名差异会造成假逃逸）；
 *   · 根内软链 → 根内目标 ⇒ `true`（不误拒）；根内软链/junction → 根外 ⇒ `false`；
 *   · 根不可解 / 目标不可解（不存在、断链、权限）⇒ `false`（fail-closed）。
 */
export declare function isInsideRootResolved(absPath: string, rootDir: string, opts?: InsideRootResolvedOptions): boolean;
