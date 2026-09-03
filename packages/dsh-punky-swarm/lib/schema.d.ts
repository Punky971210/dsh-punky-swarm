export declare const MEMBER_STATES: readonly ["pending", "running", "review", "merged", "failed", "skipped", "conflict", "idle"];
export type MemberState = typeof MEMBER_STATES[number];
export declare const BATCH_PHASES: readonly ["planning", "running", "paused", "aborted", "complete"];
export type BatchPhase = typeof BATCH_PHASES[number];
export declare const SETTLE_STATES: readonly ["merged", "failed", "skipped"];
export type SettleState = typeof SETTLE_STATES[number];
export declare const MEMBER_TRANSITIONS: {
    readonly pending: readonly ["running", "failed", "skipped"];
    readonly running: readonly ["review", "failed", "skipped"];
    readonly review: readonly ["merged", "conflict", "failed", "running"];
    readonly idle: readonly ["running"];
    readonly merged: readonly [];
    readonly failed: readonly [];
    readonly skipped: readonly [];
    readonly conflict: readonly [];
};
export declare const BATCH_TRANSITIONS: {
    readonly planning: readonly ["running", "aborted"];
    readonly running: readonly ["paused", "complete", "aborted"];
    readonly paused: readonly ["running", "aborted"];
    readonly aborted: readonly [];
    readonly complete: readonly [];
};
export declare function isMemberState(s: unknown): s is MemberState;
export declare function isBatchPhase(p: unknown): p is BatchPhase;
export declare function isMemberTerminal(s: unknown): s is MemberState;
export declare function isBatchTerminal(p: unknown): p is BatchPhase;
export declare function canTransitionMember(from: MemberState, to: MemberState): boolean;
export declare function canTransitionBatch(from: BatchPhase, to: BatchPhase): boolean;
export declare function assertMemberTransition(from: MemberState, to: MemberState): void;
export declare function assertBatchTransition(from: BatchPhase, to: BatchPhase): void;
export declare function assertMemberState(s: MemberState): void;
export declare function assertBatchPhase(p: BatchPhase): void;
export declare const TRAJECTORY_DEFAULTS: {
    enabled: boolean;
    autoFail: boolean;
    failConfidence: number;
    poll: {
        enabled: boolean;
        baseUrl: null;
        intervalMs: number;
    };
};
export declare const WATCH_DEFAULTS: Readonly<{
    enabled: true;
    intervalsMinutes: number[];
    maxMissed: 3;
    scanIntervalMinutes: 1;
    probeTemplate: null;
}>;
interface ConfigWatchInput {
    enabled?: unknown;
    intervalsMinutes?: unknown[];
    maxMissed?: unknown;
    scanIntervalMinutes?: unknown;
    probeTemplate?: unknown;
}
interface ConfigVerifyInput {
    enabled?: unknown;
    mode?: unknown;
}
interface ConfigDiscoveryInput {
    enabled?: unknown;
    nodes?: unknown;
}
interface ConfigAcpsDiscoveryInput {
    enabled?: unknown;
    baseUrl?: unknown;
    timeout?: unknown;
    limit?: unknown;
    scope?: unknown;
}
interface ConfigBridgeInput {
    enabled?: unknown;
    mode?: unknown;
    inbound?: unknown;
}
interface ConfigAcpsEndpointInput {
    enabled?: unknown;
    port?: unknown;
    host?: unknown;
    cert?: unknown;
    key?: unknown;
    ca?: unknown;
    certDir?: unknown;
    aic?: unknown;
    agentName?: unknown;
    minVersion?: unknown;
    devInsecure?: unknown;
}
interface ConfigCapabilitiesInput {
    watch?: ConfigWatchInput;
    verify?: ConfigVerifyInput;
    discovery?: ConfigDiscoveryInput;
}
interface ConfigAcpsInput {
    enabled?: unknown;
    discovery?: ConfigAcpsDiscoveryInput;
    bridge?: ConfigBridgeInput;
    endpoint?: ConfigAcpsEndpointInput;
}
interface ConfigInput {
    capabilities?: ConfigCapabilitiesInput;
    acps?: ConfigAcpsInput;
}
interface ResolvedWatchConfig {
    enabled: boolean;
    intervalsMinutes: readonly number[];
    maxMissed: number;
    scanIntervalMinutes: number;
    probeTemplate: string | null;
}
interface ResolvedVerifyConfig {
    enabled: boolean;
    mode: 'advisory' | 'enforce';
}
interface ResolvedDiscoveryConfig {
    enabled: boolean;
    nodes: object;
}
interface ResolvedAcpsDiscoveryConfig {
    enabled: boolean;
    baseUrl: string;
    timeout: number;
    limit: number;
    scope: 'local' | 'external' | 'both';
}
interface ResolvedBridgeConfig {
    enabled: boolean;
    mode: 'inprocess' | 'http';
    inbound: boolean;
}
interface ResolvedAcpsEndpointConfig {
    enabled: boolean;
    port: number;
    host: string;
    cert: string | null;
    key: string | null;
    ca: string | null;
    certDir: string | null;
    aic: string | null;
    agentName: string;
    minVersion: 'TLSv1.2' | 'TLSv1.3';
    devInsecure: boolean;
}
interface ResolvedAcpsConfig {
    enabled: boolean;
    endpoint: ResolvedAcpsEndpointConfig;
}
export declare function resolveWatchConfig(config: ConfigInput | null | undefined): ResolvedWatchConfig;
export declare const VERIFY_DEFAULTS: Readonly<{
    readonly enabled: true;
    readonly mode: "advisory";
}>;
export declare function resolveVerifyConfig(config: ConfigInput | null | undefined): ResolvedVerifyConfig;
export declare const DISCOVERY_DEFAULTS: Readonly<{
    enabled: true;
    nodes: {};
}>;
export declare function resolveDiscoveryConfig(config: ConfigInput | null | undefined): ResolvedDiscoveryConfig;
export declare const ACPS_DISCOVERY_DEFAULTS: Readonly<{
    readonly enabled: false;
    readonly baseUrl: "";
    readonly timeout: 10000;
    readonly limit: 5;
    readonly scope: "local";
}>;
export declare function resolveAcpsDiscoveryConfig(config: ConfigInput | null | undefined): ResolvedAcpsDiscoveryConfig;
export declare const BRIDGE_DEFAULTS: Readonly<{
    readonly enabled: false;
    readonly mode: "inprocess";
    readonly inbound: false;
}>;
export declare function resolveBridgeConfig(config: ConfigInput | null | undefined): ResolvedBridgeConfig;
export declare const ACPS_DEFAULTS: Readonly<{
    readonly enabled: false;
    readonly endpoint: {
        readonly enabled: false;
        readonly port: 9443;
        readonly host: "127.0.0.1";
        readonly cert: null;
        readonly key: null;
        readonly ca: null;
        readonly certDir: null;
        readonly aic: null;
        readonly agentName: "dsh-punky-swarm";
        readonly minVersion: "TLSv1.3";
        readonly devInsecure: false;
    };
}>;
export declare function resolveAcpsConfig(config: ConfigInput | null | undefined): ResolvedAcpsConfig;
export {};
