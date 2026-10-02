import type { Batch } from '../../types/contracts.js';
import type { GatesCx } from './cx.js';
export declare function buildEntry(cx: GatesCx): {
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
};
