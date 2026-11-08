export interface RulePropagationResult {
    affected: string[];
    changed: boolean;
    /** 规则内容指纹（透传/补算）；两者均不可得 ⇒ null。 */
    version: string | null;
    detail: string[];
}
/**
 * 判定「规则变更 ⇒ 哪些在途 lane 需复核」。
 * **不抛**：形状不可判时返回空受影响集并在 `detail` 里**响亮点名** —— 本模块在被注入引擎热路径
 */
export declare function evaluateRulePropagation(input: {
    batch?: unknown;
    rules?: unknown;
}): RulePropagationResult;
