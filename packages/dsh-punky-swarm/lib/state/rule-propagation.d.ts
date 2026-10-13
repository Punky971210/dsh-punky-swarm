/** 传播判定结果（**字段冻结**：供接线方消费，两侧不得各自改动）。 */
export interface RulePropagationResult {
    /** 受影响 lane id（**仅含非终态 lane**；批已终态 ⇒ 空数组）。顺序已归一（字典序）。 */
    affected: string[];
    /** 规则内容是否**非默认**（内容级判定，见文件头「变更判定」）。 */
    changed: boolean;
    /** 规则内容指纹（透传/补算）；两者均不可得 ⇒ null。 */
    version: string | null;
    /** 可判读说明（逐条：批次态、逐 lane 判定、变更面、回落点）。 */
    detail: string[];
}
/**
 * 判定「规则变更 ⇒ 哪些在途 lane 需复核」。
 *
 * **不抛**：形状不可判时返回空受影响集并在 `detail` 里**响亮点名** —— 本模块在被注入引擎热路径
 * （批次相位迁移）时，抛错会**阻断迁移**；而「打标」是**附加留痕**，其失败不应改变引擎行为。
 * ⇒ 宁可「少打标 + 点名」，不可「因附加面异常而阻断主流程」。
 */
export declare function evaluateRulePropagation(input: {
    batch?: unknown;
    rules?: unknown;
}): RulePropagationResult;
