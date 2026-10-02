import type { Batch, Layer } from '../../types/contracts.js';
import type { GatesCx } from './cx.js';
export declare function buildStatus(cx: GatesCx): {
    gateStrengthOf: (batch: Batch) => {
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
        auditContract: null;
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
    gateStatus: (sessionId: string, batchId: string, lane: string) => {
        lane: string;
        layer: Layer | null;
        state: import("../../types/contracts.js").MemberState;
        team: string | null;
        gates: string;
        consume: string[];
        produce: string[];
        outputs: string[];
        consumeMissing: string[];
        outputsMissing: string[];
        produceMissing: string[];
        contractProblems: any;
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
            auditContract: null;
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
        vocabulary: import("./reason-vocabulary.js").VocabularyView;
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
        state: import("../../types/contracts.js").MemberState;
        team: string | null;
        gates: string;
        consume: string[];
        produce: string[];
        outputs: string[];
        consumeMissing: string[];
        outputsMissing: string[];
        produceMissing: string[];
        contractProblems: any;
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
            auditContract: null;
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
        vocabulary: import("./reason-vocabulary.js").VocabularyView;
    }>;
    gateStatusMapOfBatch: (sessionId: string, batchId: string) => Record<string, {
        lane: string;
        layer: Layer | null;
        state: import("../../types/contracts.js").MemberState;
        team: string | null;
        gates: string;
        consume: string[];
        produce: string[];
        outputs: string[];
        consumeMissing: string[];
        outputsMissing: string[];
        produceMissing: string[];
        contractProblems: any;
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
            auditContract: null;
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
        vocabulary: import("./reason-vocabulary.js").VocabularyView;
    }>;
    gateStatusOfLane: (sessionId: string, batchId: string, batch: Batch, lane: string) => {
        lane: string;
        layer: Layer | null;
        state: import("../../types/contracts.js").MemberState;
        team: string | null;
        gates: string;
        consume: string[];
        produce: string[];
        outputs: string[];
        consumeMissing: string[];
        outputsMissing: string[];
        produceMissing: string[];
        contractProblems: any;
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
            auditContract: null;
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
        vocabulary: import("./reason-vocabulary.js").VocabularyView;
    };
};
