import { runCommand } from './command-exec.js';
import { isAbsPath } from './constants.js';
import type { Batch, Layer } from '../types/contracts.js';
export { isAbsPath };
export declare function smokeOf(batch: Batch | null | undefined): boolean;
export type ContractMissingPayload = {
    contractMissing: {
        cause: 'undeclared';
        gateKind: string;
        layer: string;
        declared: false;
        source: string;
        degrade: {
            kind: string;
            note: string;
        };
        problems: string[];
    };
};
export declare const TARGETS_CLAIMED_RE: RegExp;
export declare function detectNeedHuman(artifactsDir: string, producePaths: string[]): {
    declared: boolean;
    path: null;
} | {
    declared: boolean;
    path: string;
};
export declare function detectPendingMarker(content: string, literal: string): {
    declared: boolean;
    index: number;
};
export declare const GATE_LINE_RE: RegExp;
export declare const GATE_EMPTY_LINE_RE: RegExp;
export declare function detectGate(artifactsDir: string, paths: string[]): {
    declared: boolean;
    commands: string[];
    path: string | null;
    emptyCommand: string | null;
};
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
/**
 * 词表判定（**单点**：`checkEntryGate` E1 与 `checkCommandGate` C3 同调本函数）：
 *   · 未登记 token ⇒ `ok:false` + `unknown[]` ⇒ 调用方拒 `GATE_TOKEN_UNKNOWN`（Q-3=B 的收紧面）；
 *   · 词条存在但 `enabled:false` ⇒ `restated[]`（**放行 + 告警**，禁用≠删除：既有产物仍解析通过）；
 *   · 词表不可用（缺文件 / 坏 JSON / schema 不过）⇒ **fail-open**：`ok:true` + `degrade`
 *     （`GATE_VOCAB_INVALID` 是**告警级**码，不是拒码 —— 词表损坏不得砸生产，§2.1(f)）。
 * 严格生效（U-2）：本函数**无**任何按批龄分流 / env 关阀 / 缺声明放宽分支；「存量不追溯」由词表内容
 *   承载（R1 交付形态 `entries: []` ⇒ 零 token 命中 ⇒ 零校验面），**不**由批次年龄承载。
 */
export declare function reasonVocabularyVerdict(artifactsDir: string, paths: string[], opts?: {
    root?: string | null;
}): ReasonVocabularyVerdict;
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
/** 声明形态（R-1）：按**声明原文**判定（`/` 结尾 = 目录语义），不做尾斜杠规范化。 */
export declare function declaredKindOf(declared: string): 'file' | 'dir';
/**
 * presence 判据唯一实现（判据同源：建批期 `mode:'declare'` / 运行期 `mode:'runtime'`）。
 * `abs` / `content` 只对**单件声明**有效（多件声明由调用方逐件调用，或建批期只走静态面）。
 */
export declare function presenceJudge(input?: {
    mode?: PresenceMode;
    layer?: string | null;
    declared?: unknown;
    declaredKind?: string | null;
    abs?: string | null;
    content?: string | null;
    artifactsRoot?: string | null;
}): PresenceVerdict;
export declare function createGates(root: string, opts?: {
    flowsRoot?: string;
    readConfig?: () => unknown;
    vocabularyRoot?: string;
}): {
    checkEntryGate: (sessionId: string, batchId: string, batch: Batch, lane: string) => {
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        recovered: boolean;
        state: "idle";
        missing: string[];
        problems: string[];
        escape: {
            kind: string;
            lane: string;
            reason: string;
        };
    } | {
        handoffLegacy: boolean;
        missing: string[];
        code: string;
        problems?: string[];
        ok: boolean;
        lane: string;
    } | {
        ok: boolean;
        code: string;
        lane: string;
        missing: never[];
        problems: string[];
    } | {
        ok: boolean;
        lane: string;
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        vocabCode: string;
        escapes: {
            kind: string;
            reason: string;
        }[];
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        smoke: boolean;
        smokeSkipped: string;
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        escapes: {
            kind: string;
            reason: string;
        }[];
        vocabCode?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        smoke: boolean;
        smokeSkipped: string;
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        vocabCode?: undefined;
        escapes?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        smoke: boolean;
        smokeSkipped: string;
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        vocabCode: string;
        escapes: {
            kind: string;
            reason: string;
        }[];
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        standalone: boolean;
        escape: {
            kind: string;
            lane: string;
            reason: string;
        };
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        escapes: {
            kind: string;
            reason: string;
        }[];
        vocabCode?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        standalone: boolean;
        escape: {
            kind: string;
            lane: string;
            reason: string;
        };
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        vocabCode?: undefined;
        escapes?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        standalone: boolean;
        escape: {
            kind: string;
            lane: string;
            reason: string;
        };
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        vocabCode: string;
        escapes: {
            kind: string;
            reason: string;
        }[];
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        handoffLegacy: boolean;
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        escapes: {
            kind: string;
            reason: string;
        }[];
        vocabCode?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        handoffLegacy: boolean;
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    } | {
        vocabCode?: undefined;
        escapes?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        lane: string;
        handoffLegacy: boolean;
        code?: undefined;
        missing?: undefined;
        problems?: undefined;
    };
    checkPlanContract: (sessionId: string, batchId: string, batch: Batch, lane: string) => Record<string, unknown>;
    checkExitGate: (sessionId: string, batchId: string, batch: Batch, lane: string) => Record<string, unknown>;
    checkNeedHumanGate: (sessionId: string, batchId: string, batch: Batch, lane: string, note?: string | null) => {
        ok: boolean;
        declared: boolean;
        path: null;
        disabledBy: string;
        escape: {
            kind: string;
            lane: string;
            reason: string;
        };
        code?: undefined;
        message?: undefined;
    } | {
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        path: null;
        disabledBy?: undefined;
        escape?: undefined;
        code?: undefined;
        message?: undefined;
    } | {
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        path: string | null;
        evidence: string;
        disabledBy?: undefined;
        escape?: undefined;
        code?: undefined;
        message?: undefined;
    } | {
        ok: boolean;
        code: string;
        declared: boolean;
        path: string | null;
        message: string;
        disabledBy?: undefined;
        escape?: undefined;
    };
    checkCommandGate: (sessionId: string, batchId: string, batch: Batch, lane: string, deps?: {
        runCommand?: typeof runCommand;
    }) => {
        ok: boolean;
        declared: boolean;
        escape: {
            kind: string;
            gate: string;
            lane: string;
            reason: string;
            path?: undefined;
        };
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        path?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        ok: boolean;
        declared: boolean;
        disabledBy: string;
        escape?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        path?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        ok: boolean;
        code: string;
        lane: string;
        declared: boolean;
        command: null;
        exitCode: null;
        needHumanEscalation: boolean;
        path: string;
        token: string;
        source: string;
        detail: string;
        problems: string[];
        escape?: undefined;
        disabledBy?: undefined;
    } | {
        ok: boolean;
        code: string;
        command: null;
        exitCode: null;
        declared: boolean;
        needHumanEscalation: boolean;
        path: string;
        detail: string;
        escape?: undefined;
        disabledBy?: undefined;
        lane?: undefined;
        token?: undefined;
        source?: undefined;
        problems?: undefined;
    } | {
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        vocabCode: string;
        escapes: {
            kind: string;
            reason: string;
        }[];
        ok: boolean;
        declared: boolean;
        escape: {
            kind: string;
            lane: string;
            path: string | null;
            reason: string;
            gate?: undefined;
        };
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        path?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        escapes: {
            kind: string;
            reason: string;
        }[];
        vocabCode?: undefined;
        ok: boolean;
        declared: boolean;
        escape: {
            kind: string;
            lane: string;
            path: string | null;
            reason: string;
            gate?: undefined;
        };
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        path?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        vocabCode?: undefined;
        escapes?: undefined;
        ok: boolean;
        declared: boolean;
        escape: {
            kind: string;
            lane: string;
            path: string | null;
            reason: string;
            gate?: undefined;
        };
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        path?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        vocabCode: string;
        escapes: {
            kind: string;
            reason: string;
        }[];
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        escape?: undefined;
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        path?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        escapes: {
            kind: string;
            reason: string;
        }[];
        vocabCode?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        escape?: undefined;
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        path?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        vocabCode?: undefined;
        escapes?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        escape?: undefined;
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        path?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        declared: boolean;
        needHumanEscalation: boolean;
        path: string | null;
        code: string;
        command: string;
        exitCode: number | null;
        detail: string;
        ok: boolean;
        escape?: undefined;
        disabledBy?: undefined;
        lane?: undefined;
        token?: undefined;
        source?: undefined;
        problems?: undefined;
    } | {
        vocabCode: string;
        escapes: {
            kind: string;
            reason: string;
        }[];
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        commands: string[];
        results: {
            command: string;
            exitCode: number | null;
            durationMs: number;
        }[];
        outputTruncated: boolean;
        path: string | null;
        escape?: undefined;
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        escapes: {
            kind: string;
            reason: string;
        }[];
        vocabCode?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        commands: string[];
        results: {
            command: string;
            exitCode: number | null;
            durationMs: number;
        }[];
        outputTruncated: boolean;
        path: string | null;
        escape?: undefined;
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    } | {
        vocabCode?: undefined;
        escapes?: undefined;
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        commands: string[];
        results: {
            command: string;
            exitCode: number | null;
            durationMs: number;
        }[];
        outputTruncated: boolean;
        path: string | null;
        escape?: undefined;
        disabledBy?: undefined;
        code?: undefined;
        lane?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        token?: undefined;
        source?: undefined;
        detail?: undefined;
        problems?: undefined;
    };
    checkTargetsGate: (sessionId: string, batchId: string, batch: Batch, lane: string) => {
        ok: boolean;
        declared: boolean;
        escape: {
            kind: string;
            gate: string;
            lane: string;
            reason: string;
        };
        disabledBy?: undefined;
        code?: undefined;
        missing?: undefined;
        unchanged?: undefined;
        mode?: undefined;
        targets?: undefined;
    } | {
        ok: boolean;
        declared: boolean;
        escape?: undefined;
        disabledBy?: undefined;
        code?: undefined;
        missing?: undefined;
        unchanged?: undefined;
        mode?: undefined;
        targets?: undefined;
    } | {
        ok: boolean;
        declared: boolean;
        disabledBy: string;
        escape?: undefined;
        code?: undefined;
        missing?: undefined;
        unchanged?: undefined;
        mode?: undefined;
        targets?: undefined;
    } | {
        ok: boolean;
        declared: boolean;
        disabledBy: string;
        escape: {
            kind: string;
            lane: string;
            reason: string;
            gate?: undefined;
        };
        code?: undefined;
        missing?: undefined;
        unchanged?: undefined;
        mode?: undefined;
        targets?: undefined;
    } | {
        ok: boolean;
        declared: boolean;
        code: string;
        missing: string[];
        unchanged: never[];
        mode: string;
        targets: string[];
        escape?: undefined;
        disabledBy?: undefined;
    } | {
        ok: boolean;
        declared: boolean;
        code: string;
        missing: never[];
        unchanged: string[];
        mode: string;
        targets: string[];
        escape?: undefined;
        disabledBy?: undefined;
    } | {
        contractMissing?: {
            cause: "undeclared";
            gateKind: string;
            layer: string;
            declared: false;
            source: string;
            degrade: {
                kind: string;
                note: string;
            };
            problems: string[];
        } | undefined;
        ok: boolean;
        declared: boolean;
        missing: never[];
        unchanged: never[];
        mode: string;
        skippedChange: boolean;
        targets: string[];
        escape?: undefined;
        disabledBy?: undefined;
        code?: undefined;
    };
    checkCompleteGate: (batch: Batch) => Record<string, unknown>;
    checkSettleHandoffGate: (sessionId: string, batchId: string, batch: Batch, lane: string, note?: string | null) => {
        ok: boolean;
        code: string | null;
        missing: string[];
        problems: string[];
        disabled?: boolean;
        smoke?: boolean;
        legacy?: boolean;
        humanException?: boolean;
        downstream?: string[];
    };
    gateStatus: (sessionId: string, batchId: string, lane: string) => {
        lane: string;
        layer: Layer | null;
        state: import("../types/contracts.js").MemberState;
        team: string | null;
        gates: string;
        consume: string[];
        produce: string[];
        outputs: string[];
        consumeMissing: string[];
        outputsMissing: string[];
        produceMissing: string[];
        contractProblems: unknown;
        targets: string[];
        targetsMissing: string[];
        targetsUnchanged: string[];
        gateStrength: {
            level: string;
            lanes: {
                plan: number;
                exec: number;
                audit: number;
            };
            produceField: {
                plan: string[];
                exec: string[];
                audit: string[];
            };
            produceFieldDeclared: Record<string, string | null>;
            entryRequires: Record<string, Record<string, unknown>>;
            consumeField: {
                exec: string;
                audit: string;
            };
            escapes: {
                kind: string | null;
            }[];
            degrades: {
                kind: string | null;
            }[];
            disabled: string[];
            unwired: Record<string, unknown>[];
            evaluatedAt: string[];
            orphanProducts: {
                plan: string[];
                exec: string[];
                audit: string[];
            };
            emptyNoted: never[];
            auditContract: {
                criteriaFrom: any;
                consumesRequired: any;
                verdict: any;
                source: string;
            } | null;
            completeOutcomes: {
                source: string;
                declared: string[] | null;
                values: string[];
                narrowed: string[];
                rejectedBy: string[];
                escapeRoute: {
                    phase: "aborted";
                    reason: string;
                };
            };
            completeSemantics: string;
        };
        vocabulary: VocabularyView;
    } | {
        lane: string;
        layer: null;
        state: null;
        team: null;
        corrupt: boolean;
        consume: never[];
        produce: never[];
        outputs: never[];
        consumeMissing: never[];
        outputsMissing: never[];
        produceMissing: never[];
        contractProblems: null;
        targets: never[];
        targetsMissing: never[];
        targetsUnchanged: never[];
    };
    gateStatusOfBatch: (sessionId: string, batchId: string) => Record<string, {
        lane: string;
        layer: Layer | null;
        state: import("../types/contracts.js").MemberState;
        team: string | null;
        gates: string;
        consume: string[];
        produce: string[];
        outputs: string[];
        consumeMissing: string[];
        outputsMissing: string[];
        produceMissing: string[];
        contractProblems: unknown;
        targets: string[];
        targetsMissing: string[];
        targetsUnchanged: string[];
        gateStrength: {
            level: string;
            lanes: {
                plan: number;
                exec: number;
                audit: number;
            };
            produceField: {
                plan: string[];
                exec: string[];
                audit: string[];
            };
            produceFieldDeclared: Record<string, string | null>;
            entryRequires: Record<string, Record<string, unknown>>;
            consumeField: {
                exec: string;
                audit: string;
            };
            escapes: {
                kind: string | null;
            }[];
            degrades: {
                kind: string | null;
            }[];
            disabled: string[];
            unwired: Record<string, unknown>[];
            evaluatedAt: string[];
            orphanProducts: {
                plan: string[];
                exec: string[];
                audit: string[];
            };
            emptyNoted: never[];
            auditContract: {
                criteriaFrom: any;
                consumesRequired: any;
                verdict: any;
                source: string;
            } | null;
            completeOutcomes: {
                source: string;
                declared: string[] | null;
                values: string[];
                narrowed: string[];
                rejectedBy: string[];
                escapeRoute: {
                    phase: "aborted";
                    reason: string;
                };
            };
            completeSemantics: string;
        };
        vocabulary: VocabularyView;
    }>;
    gateStatusMapOfBatch: (sessionId: string, batchId: string) => Record<string, {
        lane: string;
        layer: Layer | null;
        state: import("../types/contracts.js").MemberState;
        team: string | null;
        gates: string;
        consume: string[];
        produce: string[];
        outputs: string[];
        consumeMissing: string[];
        outputsMissing: string[];
        produceMissing: string[];
        contractProblems: unknown;
        targets: string[];
        targetsMissing: string[];
        targetsUnchanged: string[];
        gateStrength: {
            level: string;
            lanes: {
                plan: number;
                exec: number;
                audit: number;
            };
            produceField: {
                plan: string[];
                exec: string[];
                audit: string[];
            };
            produceFieldDeclared: Record<string, string | null>;
            entryRequires: Record<string, Record<string, unknown>>;
            consumeField: {
                exec: string;
                audit: string;
            };
            escapes: {
                kind: string | null;
            }[];
            degrades: {
                kind: string | null;
            }[];
            disabled: string[];
            unwired: Record<string, unknown>[];
            evaluatedAt: string[];
            orphanProducts: {
                plan: string[];
                exec: string[];
                audit: string[];
            };
            emptyNoted: never[];
            auditContract: {
                criteriaFrom: any;
                consumesRequired: any;
                verdict: any;
                source: string;
            } | null;
            completeOutcomes: {
                source: string;
                declared: string[] | null;
                values: string[];
                narrowed: string[];
                rejectedBy: string[];
                escapeRoute: {
                    phase: "aborted";
                    reason: string;
                };
            };
            completeSemantics: string;
        };
        vocabulary: VocabularyView;
    }>;
    teamAssetViewOf: (_batch: Batch | null | undefined) => {
        teamAsset: unknown;
        declaration: unknown;
        declarationMissing: boolean;
    };
    presenceJudge: typeof presenceJudge;
};
