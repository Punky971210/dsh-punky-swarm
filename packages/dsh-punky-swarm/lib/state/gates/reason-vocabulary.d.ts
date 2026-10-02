export interface ReasonTokenDecl {
    token: string;
    path: string;
    index: number;
}
export interface ReasonVocabularyVerdict {
    ok: boolean;
    declarations: ReasonTokenDecl[];
    unknown: ReasonTokenDecl[];
    restated: Array<ReasonTokenDecl & {
        entryId: string | null;
    }>;
    degrade: {
        kind: string;
        code: string;
        problems: string[];
    } | null;
}
/** 词表只读视图（§2.4 #6 的**纯展示位**形态：恰好三键，不参与任何判定）。 */
export interface VocabularyView {
    loaded: boolean;
    version: number | null;
    source: string | null;
}
/** 解析产物内的 `reason: <token>` 声明行（保序；`token` 取 trim 后原文，空则不计入）。 */
export declare function detectReasonTokens(artifactsDir: string, paths: string[]): ReasonTokenDecl[];
/**
 * 词表判定的**放行侧载荷**（单点构造；entry 门 E1 与命令门 C3 同形）：
 *   `{}` = 零感知（无声明 / 全部在册）；`escapes[]` = 留痕面（`vocabulary-restated` 告警 /
 *   `vocabulary-unavailable` 降级）。
 * 形态选择（**刻意的**）：只走 `escapes[]` **多值通道**，**不**占用 `escape` 单值键 —— 调用点可能已自带
 *   专属 `escape`（如 `command-declared-off` / `standalone`），两态可同时成立（例：显式禁用 `gate:` +
 *   产物声明停用词条）⇒ 多值通道使两条留痕**各自可归因**、互不覆盖（写端 `store.js#gateEscapeEvents`
 *   同时消费 `escape` 与 `escapes[]`）。
 * 纪律：本函数**只产载荷**，不落盘、不改判定（落盘唯一在 store 写路径 ⇒ R-5「只读视图零事件」）。
 */
export declare function reasonVocabularyNote(v: ReasonVocabularyVerdict): {
    vocabCode: string;
    escapes: {
        kind: string;
        reason: string;
    }[];
} | {
    escapes: {
        kind: string;
        reason: string;
    }[];
    vocabCode?: undefined;
} | {
    vocabCode?: undefined;
    escapes?: undefined;
};
