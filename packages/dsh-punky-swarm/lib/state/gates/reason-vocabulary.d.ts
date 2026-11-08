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
export interface VocabularyView {
    loaded: boolean;
    version: number | null;
    source: string | null;
}
/** 解析产物内的 `reason: <token>` 声明行（保序；`token` 取 trim 后原文，空则不计入）。 */
export declare function detectReasonTokens(artifactsDir: string, paths: string[]): ReasonTokenDecl[];
/**
 *   `{}` = 零感知（无声明 / 全部在册）；`escapes[]` = 留痕面（`vocabulary-restated` 告警 /
 *   `vocabulary-unavailable` 降级）。
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
