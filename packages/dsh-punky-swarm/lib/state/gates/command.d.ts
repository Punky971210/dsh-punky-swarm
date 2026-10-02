import { runCommand } from '../command-exec.js';
import type { Batch } from '../../types/contracts.js';
import type { GatesCx } from './cx.js';
export declare function buildCommand(cx: GatesCx): {
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
};
