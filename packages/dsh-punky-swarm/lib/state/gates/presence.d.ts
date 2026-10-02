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
