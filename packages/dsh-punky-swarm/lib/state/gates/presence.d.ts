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
export declare function declaredKindOf(declared: string): 'file' | 'dir';
export declare function emptyReasonOf(content: string): string | null;
export declare function substantiveContentOf(content: string): string;
export declare function sectionLineHit(content: string, section: string): boolean;
/**
 *  与既有行族同构（`reason:` / `gate:` / `targets-claimed:` / `empty-reason:`）；不用 `content.includes(id)`
 *  是因为元素 id（如 `goal`）通常极短，`includes` 会把任意词命中 ⇒ 判据不可靠（假绿风险）。
 */
export declare function elementLineHit(content: string, id: string): boolean;
export declare function isInsideRoot(absPath: string, rootDir: string): boolean;
/** 解权档选项。 */
export interface InsideRootResolvedOptions {
    /**
     * `true` = 目标**允许尚不存在**（写面：目标由本次调用创建）⇒ 解权「最近既有祖先」+ 剩余段。
     * `false`（缺省）= 目标本身须可解权；解不了（不存在/断链/权限）⇒ `false`。
     */
    allowMissing?: boolean;
}
export declare function isInsideRootResolved(absPath: string, rootDir: string, opts?: InsideRootResolvedOptions): boolean;
