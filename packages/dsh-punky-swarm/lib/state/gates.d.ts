import { runCommand } from './command-exec.js';
import { isAbsPath } from './constants.js';
import type { Batch, Layer } from '../types/contracts.js';
export { isAbsPath };
export declare const TARGETS_CLAIMED_RE: RegExp;
export declare function detectNeedHuman(artifactsDir: string, producePaths: string[]): {
    declared: boolean;
    path: null;
} | {
    declared: boolean;
    path: string;
};
export declare const GATE_LINE_RE: RegExp;
export declare function detectGate(artifactsDir: string, paths: string[]): {
    declared: boolean;
    commands: string[];
    path: string | null;
};
export declare function createGates(root: string): {
    checkEntryGate: (sessionId: string, batchId: string, batch: Batch, lane: string) => {
        ok: boolean;
        code?: undefined;
        missing?: undefined;
    } | {
        ok: boolean;
        code: string;
        missing: string[];
    };
    checkPlanContract: (sessionId: string, batchId: string, batch: Batch, lane: string) => {
        ok: boolean;
        code?: undefined;
        problems?: undefined;
    } | {
        ok: boolean;
        code: string;
        problems: string[];
    };
    checkExitGate: (sessionId: string, batchId: string, batch: Batch, lane: string) => {
        ok: boolean;
        code?: undefined;
        problems?: undefined;
    } | {
        ok: boolean;
        code: string;
        problems: string[];
    } | {
        ok: boolean;
        code: string;
        missing: string[];
    };
    checkNeedHumanGate: (sessionId: string, batchId: string, batch: Batch, lane: string, note?: string | null) => {
        ok: boolean;
        declared: boolean;
        path: null;
        evidence?: undefined;
        code?: undefined;
        message?: undefined;
    } | {
        ok: boolean;
        declared: boolean;
        path: string | null;
        evidence: string;
        code?: undefined;
        message?: undefined;
    } | {
        ok: boolean;
        code: string;
        declared: boolean;
        path: string | null;
        message: string;
        evidence?: undefined;
    };
    checkCommandGate: (sessionId: string, batchId: string, batch: Batch, lane: string, deps?: {
        runCommand?: typeof runCommand;
    }) => {
        ok: boolean;
        declared: boolean;
        code?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        detail?: undefined;
        commands?: undefined;
        results?: undefined;
        outputTruncated?: undefined;
        path?: undefined;
    } | {
        ok: boolean;
        code: string;
        command: null;
        exitCode: null;
        declared: boolean;
        needHumanEscalation: boolean;
        detail: string;
        commands?: undefined;
        results?: undefined;
        outputTruncated?: undefined;
        path?: undefined;
    } | {
        declared: boolean;
        needHumanEscalation: boolean;
        path: string | null;
        code: string;
        command: string;
        exitCode: number | null;
        detail: string;
        ok: boolean;
        commands?: undefined;
        results?: undefined;
        outputTruncated?: undefined;
    } | {
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
        code?: undefined;
        command?: undefined;
        exitCode?: undefined;
        needHumanEscalation?: undefined;
        detail?: undefined;
    };
    checkTargetsGate: (sessionId: string, batchId: string, batch: Batch, lane: string) => {
        ok: boolean;
        declared: boolean;
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
    } | {
        ok: boolean;
        declared: boolean;
        code: string;
        missing: never[];
        unchanged: string[];
        mode: string;
        targets: string[];
    } | {
        ok: boolean;
        declared: boolean;
        missing: never[];
        unchanged: never[];
        mode: string;
        targets: string[];
        code?: undefined;
    };
    checkCompleteGate: (batch: Batch) => {
        ok: boolean;
        code?: undefined;
        pending?: undefined;
    } | {
        ok: boolean;
        code: string;
        pending?: undefined;
    } | {
        ok: boolean;
        code: string;
        pending: string[];
    };
    gateStatus: (sessionId: string, batchId: string, lane: string) => {
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
        gates?: undefined;
    } | {
        lane: string;
        layer: null;
        state: import("../types/contracts.js").MemberState;
        gates: string;
        team: string;
        corrupt?: undefined;
        consume?: undefined;
        produce?: undefined;
        outputs?: undefined;
        consumeMissing?: undefined;
        outputsMissing?: undefined;
        produceMissing?: undefined;
        contractProblems?: undefined;
        targets?: undefined;
        targetsMissing?: undefined;
        targetsUnchanged?: undefined;
    } | {
        lane: string;
        layer: Layer | null;
        state: import("../types/contracts.js").MemberState;
        team: string;
        consume: string[];
        produce: string[];
        outputs: string[];
        consumeMissing: string[];
        outputsMissing: string[];
        produceMissing: string[];
        contractProblems: string[] | null | undefined;
        targets: string[];
        targetsMissing: string[];
        targetsUnchanged: string[];
        corrupt?: undefined;
        gates?: undefined;
    };
};
