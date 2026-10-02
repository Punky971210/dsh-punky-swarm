import type { Batch } from '../../types/contracts.js';
import type { GatesCx } from './cx.js';
export declare function buildExit(cx: GatesCx): {
    checkExitGate: (sessionId: string, batchId: string, batch: Batch, lane: string) => import("./cx.js").GateVerdict;
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
};
