import type { Batch } from '../../types/contracts.js';
import type { GatesCx } from './cx.js';
export declare function buildTargets(cx: GatesCx): {
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
};
