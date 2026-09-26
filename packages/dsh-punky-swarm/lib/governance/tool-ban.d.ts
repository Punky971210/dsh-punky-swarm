import type { ToolBanEntry, Violation } from './types.js';
export declare function judgeWaitSleepCommand(command: unknown): FileWriteVerdict;
export declare const WRITE_CHANNEL_HINT = "\uFF1B\u6587\u4EF6\u5199\u8BF7\u6539\u7528 edit / write / str-replace-editor \u7B49\u5728\u518C\u5DE5\u5177\uFF08\u62A4\u680F\u5199\u901A\u9053\u8DEF\u7531\uFF1Ashell \u5199\u76D8\u6613\u7834\u574F\u6587\u4EF6\u7F16\u7801\u5934\uFF09";
export interface FileWriteVerdict {
    hit: boolean;
    reason: string;
    segment?: string;
}
export declare const UNIMPLEMENTED_BEHAVIOR_REASON_PREFIX = "\u884C\u4E3A\u9762\u672A\u5B9E\u73B0\u6216\u975E\u6CD5\uFF1A";
export declare const UNKNOWN_VIOLATION_CODE = "unknown";
export declare function judgeFileWriteCommand(command: unknown): FileWriteVerdict;
export declare function matchToolBan(entries: readonly ToolBanEntry[] | undefined, exec: {
    name: string;
    arguments: unknown;
}): {
    violations: Violation[];
    ruleRefs: string[];
};
