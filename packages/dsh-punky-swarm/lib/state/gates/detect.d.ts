import type { Batch, WavePlanTask } from '../../types/contracts.js';
export declare function taskOf(batch: Batch | null, lane: string): WavePlanTask | null;
export declare function smokeOf(batch: Batch | null | undefined): boolean;
export type TaskArrayField = 'consume' | 'produce' | 'outputs';
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
/** 六判定位共用的载荷构造（gateKind 见 6 个调用点；source/degrade 逐点给出**引擎缺省来源**，可审计）。 */
export declare function contractMissingPayload(gateKind: string, layer: string, source: string, degradeKind: string, degradeNote: string): ContractMissingPayload;
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
export declare function detectGateOff(artifactsDir: string, paths: string[]): {
    declared: boolean;
    path: null;
} | {
    declared: boolean;
    path: string;
};
