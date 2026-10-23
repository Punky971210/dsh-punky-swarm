export declare const MEMBER_STATES: readonly ["pending", "running", "review", "merged", "failed", "skipped", "conflict", "idle"];
export type MemberState = typeof MEMBER_STATES[number];
export declare const BATCH_PHASES: readonly ["planning", "running", "paused", "aborted", "complete"];
export type BatchPhase = typeof BATCH_PHASES[number];
export declare const SETTLE_STATES: readonly ["merged", "failed", "skipped"];
export type SettleState = typeof SETTLE_STATES[number];
export declare const MEMBER_TRANSITIONS: {
    readonly pending: readonly ["running", "failed", "skipped"];
    readonly running: readonly ["review", "failed", "skipped"];
    readonly review: readonly ["merged", "conflict", "failed"];
    readonly idle: readonly ["running"];
    readonly merged: readonly [];
    readonly failed: readonly [];
    readonly skipped: readonly [];
    readonly conflict: readonly [];
};
export declare const RECOVERY_IDLE_FROM: readonly MemberState[];
export declare const BATCH_TRANSITIONS: {
    readonly planning: readonly ["running", "aborted"];
    readonly running: readonly ["paused", "complete", "aborted"];
    readonly paused: readonly ["running", "aborted"];
    readonly aborted: readonly [];
    readonly complete: readonly [];
};
export declare function isMemberState(s: unknown): s is MemberState;
export declare function isMemberTerminal(s: unknown): s is MemberState;
export declare function isBatchTerminal(p: unknown): p is BatchPhase;
export declare function canTransitionMember(from: MemberState, to: MemberState): boolean;
export declare function canTransitionBatch(from: BatchPhase, to: BatchPhase): boolean;
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
    inboundSessionId?: unknown;
    inboundBatchId?: unknown;
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
    auditlog?: ConfigAuditlogInput;
}
interface ConfigAuditlogInput {
    enabled?: unknown;
    keepDays?: unknown;
    maxFileBytes?: unknown;
    maxTotalBytes?: unknown;
    sinkDir?: unknown;
    stdout?: unknown;
    levelsDefault?: unknown;
    aggregate?: unknown;
    /** 【D-16-②】stray 文件删除 opt-in（默认 false；env PUNKY_AUDITLOG_PRUNE_STRAY） */
    pruneStray?: unknown;
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
export interface ResolvedWatchConfig {
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
    inboundSessionId: string | null;
    inboundBatchId: string | null;
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
export declare function autoSettleEnabledOf(enabled: unknown): boolean;
/**
 * `autoSettle.enabled` 的**投影单点**（A2-G12）：只做 `config → 原始值` 的取面，**不判定**
 *   （判定归 `autoSettleEnabledOf`）。
 *
 * 读源**两路是显式二阶，不是缺陷、也不能硬合并**：
 *   ① 装配期 = `apply(ctx, config)` 的**静态 config** —— 此时 `<root>/config/runtime.json` 尚未并入快照；
 *   ② 热更后 = **热更快照**（工具面 `readLiveConfig(deps)` / 装配面 `readConfig()`）。
 * 两路最终都交给判定式单点。**合并两路 = 改行为**（装配期快照未就绪）；故只收「投影」与「判定」，
 *   读源二阶在此登记，供审计核「为什么允许两个入口」。
 * 等价性：逐字搬移原四处内联的 `cfg?.autoSettle?.enabled`（`lib/index.js` ×3、`lib/tools/swarm-tools.js` ×1）
 *   ⇒ 返回值形态零变化（`installAutoSettle` 的 `enabled` 契约 = 按原始值透传，只有显式 `false` 才停用）。
 */
export declare function autoSettleSwitchOf(config: unknown): unknown;
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
    readonly inboundSessionId: null;
    readonly inboundBatchId: null;
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
export declare const AUDITLOG_CONFIG_KEYS: readonly ["enabled", "keepDays", "maxFileBytes", "maxTotalBytes", "stdout", "levelsDefault", "aggregate", "pruneStray"];
export type AuditlogConfigKey = typeof AUDITLOG_CONFIG_KEYS[number];
export {};
