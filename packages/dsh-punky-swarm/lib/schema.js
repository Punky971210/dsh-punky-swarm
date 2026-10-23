/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
export const MEMBER_STATES = [
    'pending', 'running', 'review', 'merged', 'failed', 'skipped', 'conflict', 'idle',
];
// 批次阶段：planning -> running -> paused -> aborted | complete
export const BATCH_PHASES = ['planning', 'running', 'paused', 'aborted', 'complete'];
export const SETTLE_STATES = ['merged', 'failed', 'skipped'];
export const MEMBER_TRANSITIONS = {
    pending: ['running', 'failed', 'skipped'],
    running: ['review', 'failed', 'skipped'],
    review: ['merged', 'conflict', 'failed'], // 返工边（`review → running`）已于 2026-09-21 去除（K3）：失败即终态，返工 = gap-list + 新任务批次
    idle: ['running'],
    merged: [],
    failed: [],
    skipped: [],
    conflict: [],
};
// 恢复/回收专用「入 idle」边 `RECOVERY_IDLE_FROM`（**刻意不入 MEMBER_TRANSITIONS**）：
//   棘轮地板不得放宽（machine-rules 的 allowRelax 逃生门只管「收紧」，默认表一放就不可回收）；
//   且 test/outcome-typing.test.js 显式断言 canTransitionMember('running','idle') === false。
// 唯一消费点 = lib/state/store/lifecycle.js::laneIdleOnRecovery（单点写入口）。
export const RECOVERY_IDLE_FROM = Object.freeze(['running', 'review']);
export const BATCH_TRANSITIONS = {
    planning: ['running', 'aborted'],
    running: ['paused', 'complete', 'aborted'],
    paused: ['running', 'aborted'],
    aborted: [],
    complete: [],
};
// 守卫函数：unknown 入参 + 类型谓词（下游收窄）；内部 includes 单点断言——
// 运行期等价：Array.includes 接受任意值，断言仅类型层。
export function isMemberState(s) {
    return MEMBER_STATES.includes(s);
}
function isBatchPhase(p) {
    return BATCH_PHASES.includes(p);
}
export function isMemberTerminal(s) {
    return SETTLE_STATES.includes(s) || s === 'conflict';
}
export function isBatchTerminal(p) {
    return p === 'aborted' || p === 'complete';
}
// 参数类型化为 MemberState/BatchPhase；内部运行时守卫（isMemberState 等）保留不动
// （防御 JS 调用方非法值——类型只约束编译期）。
export function canTransitionMember(from, to) {
    if (!isMemberState(from) || !isMemberState(to))
        return false;
    // 中间变量标注：satisfies 保留字面量类型，联合键索引得元组联合 → 统一为通用只读数组后再 includes（运行期零变更）
    const tos = MEMBER_TRANSITIONS[from];
    return tos.includes(to);
}
export function canTransitionBatch(from, to) {
    if (!isBatchPhase(from) || !isBatchPhase(to))
        return false;
    const tos = BATCH_TRANSITIONS[from];
    return tos.includes(to);
}
export function assertMemberState(s) {
    if (!isMemberState(s))
        throw new Error('unknown member state: ' + String(s));
}
export function assertBatchPhase(p) {
    if (!isBatchPhase(p))
        throw new Error('unknown batch phase: ' + String(p));
}
// ── 可选配置键默认值（装配默认开——AIP 为主线 + 治理能力全开；
//   显式 enabled:false 可逐键关闭。缺省 = 全能力启用，行为按各能力语义）──
// capabilities.trajectory：诊断桥接（lib/bridge/trajectory.js）——订阅 trajectory 异常 → sessionId→lane 映射 → notify；
//   enabled=true（默认）：桥接挂载；autoFail=false（默认）：异常只 notify，不自动 member_settle failed；
//   failConfidence：loop_deadlock 自动 failed 的置信阈值（默认 0.85，可配）；
//   poll：可选 HTTP 轮询 fallback（默认关，插件未装/无事件时静默降级）
export const TRAJECTORY_DEFAULTS = {
    enabled: true,
    autoFail: false,
    failConfidence: 0.85,
    poll: { enabled: false, baseUrl: null, intervalMs: 60_000 },
};
// ── capabilities.watch：lane 过期检测（lib/watch/lane-heartbeat.js）──
// enabled=true（默认）时 watchdog 挂载、lane_heartbeat 注册
export const WATCH_DEFAULTS = Object.freeze({
    enabled: true,
    intervalsMinutes: [10, 20, 30], // 退避档位（分钟）：冷场越久追问间隔越长
    maxMissed: 3, // 硬停拍数：连续 N 拍无活动 → lane.stalled 事件，停止追问
    scanIntervalMinutes: 1, // watchdog 扫描间隔（index.js 挂载 setInterval 用）
    probeTemplate: null, // 追问模板（可选覆写；缺省用内置 ≤5 句模板，支持 {lane}/{batchId}/{missed} 占位）
});
export function resolveWatchConfig(config) {
    const c = config?.capabilities?.watch ?? {};
    const intervals = Array.isArray(c.intervalsMinutes) && c.intervalsMinutes.length > 0
        ? c.intervalsMinutes.map((m) => (Number.isFinite(Number(m)) && Number(m) >= 0 ? Number(m) : null)).filter((x) => x !== null)
        : null;
    return {
        // 等价默认合并：缺省 = WATCH_DEFAULTS.enabled(true)（与 readCapability 对注册表 default 的
        // deepMerge 语义等价——显式 enabled:false 才关）。不直接 import readCapability 以避免
        // lib/schema.ts ⟷ lib/assembly/schema.ts 顶层循环依赖（assembly 顶层初始化需本文件常量，静态 import 会 TDZ）。
        enabled: c.enabled !== false,
        intervalsMinutes: intervals && intervals.length > 0 ? intervals : WATCH_DEFAULTS.intervalsMinutes,
        maxMissed: Number.isFinite(Number(c.maxMissed)) && Number(c.maxMissed) >= 1 ? Math.floor(Number(c.maxMissed)) : WATCH_DEFAULTS.maxMissed,
        scanIntervalMinutes: Number.isFinite(Number(c.scanIntervalMinutes)) && Number(c.scanIntervalMinutes) >= 0.1
            ? Number(c.scanIntervalMinutes)
            : WATCH_DEFAULTS.scanIntervalMinutes,
        probeTemplate: typeof c.probeTemplate === 'string' && c.probeTemplate.length > 0
            ? c.probeTemplate
            : WATCH_DEFAULTS.probeTemplate,
    };
}
// ── capabilities.verify：验收证据（lib/verify/evidence.js + lib/verify/gate.js）──
// enabled=true（默认）捕获 hook 挂载；
//   mode=advisory（默认）只记录不拦截；**mode=enforce 的裁决侧未接线**（createCompletionGate 无生产消费点）
//   ⇒ 实际按 advisory 生效，装配面只输出一条 warn 说明未接线（A1-P2-11）；接线 or 退役属待裁决 followup。
// as const：mode 字面量派生返回类型（'advisory'|'enforce'），纯类型层、运行期等价。
export const VERIFY_DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'advisory',
});
export function resolveVerifyConfig(config) {
    const c = config?.capabilities?.verify ?? {};
    return {
        // 等价默认合并：缺省 = VERIFY_DEFAULTS.enabled(true)，显式 enabled:false 才关（同 resolveWatchConfig 注释）
        enabled: c.enabled !== false,
        mode: c.mode === 'enforce' ? 'enforce' : VERIFY_DEFAULTS.mode,
    };
}
// ── autoSettle：**判定式**（本函数）+ **投影**（`autoSettleSwitchOf` 紧随其后）两个单点 ──
// 本函数**只收判定式，不收读源**：装配期读静态 `config`、兼底路读 `readLiveConfig(deps)` 的热更快照
//   （两路读源不同 ⇒ 原始 `enabled` 值由投影单点 `autoSettleSwitchOf` 取，判定只此一处）。
// 语义冻结：**只有显式 `false` 才停用**；`undefined`（键缺省）/ 键缺失 / 任何非布尔值 ⇒ 启用。
//   ⚠ **禁真值判断**：`!enabled` 会把 `0` / `''` / `null` 一并当停用 ⇒ **越权关停**。
// 消费方（3 处，均只调本单点，禁再内联判定式）：`lib/engine/auto-settle.js`（装配期 `enabled`）、
//   `lib/index.js`（热更生效比对 + boot 对账，读静态 config）、`lib/tools/swarm-tools.js`（兼底路短路，读热更快照）。
export function autoSettleEnabledOf(enabled) {
    return enabled !== false;
}
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
export function autoSettleSwitchOf(config) {
    return config?.autoSettle?.enabled;
}
// ── capabilities.discovery：发现服务（lib/discovery/service.js）──
// ADP（Agent Discovery Protocol）统一 POST /discover + /.well-known/aip 预置；
//   enabled=true（默认）：webServer 存在时挂载发现服务（消费 tool catalog + agent-descriptor 目录）；
//   nodes：节点级 active 覆写——{ <aic|name>: { active: false } } 时该节点不出现在查询结果（默认 active=true）。
export const DISCOVERY_DEFAULTS = Object.freeze({
    enabled: true,
    nodes: {},
});
export function resolveDiscoveryConfig(config) {
    const c = config?.capabilities?.discovery ?? {};
    return {
        // 等价默认合并：缺省 = DISCOVERY_DEFAULTS.enabled(true)，显式 enabled:false 才关（同 resolveWatchConfig 注释）
        enabled: c.enabled !== false,
        nodes: (c.nodes && typeof c.nodes === 'object' && !Array.isArray(c.nodes)) ? c.nodes : {},
    };
}
// ── acps.discovery：外部 ADP 发现客户端（lib/acps/discovery-client.js）──
// 插件 Leader 经外部 discovery-server 发现 partner（POST {baseUrl}/discover）；
// 默认关（对外能力显式开启）——enabled=false 不创建客户端实例，零运行时路径。
//   baseUrl：外部 discovery-server 根地址（空 = 未配置，discover 调用抛错）
//   timeout/limit：单次请求超时 ms（默认 10000）与默认返回上限（默认 5）
//   scope：查询范围 local（仅既有本地目录）/ external（仅外部）/ both（本地+外部合并）
// as const：scope 字面量派生返回类型（'local'|'external'|'both'），纯类型层、运行期等价。
export const ACPS_DISCOVERY_DEFAULTS = Object.freeze({
    enabled: false,
    baseUrl: '',
    timeout: 10_000,
    limit: 5,
    scope: 'local',
});
export function resolveAcpsDiscoveryConfig(config) {
    const c = config?.acps?.discovery ?? {};
    // 单点断言：includes 命中即 c.scope 必为三值之一（运行期 includes 语义不变，断言仅类型层）
    const scope = ['local', 'external', 'both'].includes(c.scope)
        ? c.scope
        : ACPS_DISCOVERY_DEFAULTS.scope;
    return {
        enabled: c.enabled === true,
        baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : ACPS_DISCOVERY_DEFAULTS.baseUrl,
        timeout: Number.isFinite(Number(c.timeout)) && Number(c.timeout) > 0
            ? Number(c.timeout)
            : ACPS_DISCOVERY_DEFAULTS.timeout,
        limit: Number.isFinite(Number(c.limit)) && Number(c.limit) >= 1
            ? Math.floor(Number(c.limit))
            : ACPS_DISCOVERY_DEFAULTS.limit,
        scope,
    };
}
// ── config.acps.bridge：内部 ACPs 桥接（lib/comms/acps-bridge.js，单向：外部 → supervisor/inbox）──
// 桥只经 mailbox.js 公共接口投递/投影，绝不绕过；enabled=false 时不加载不实例化（零路径）。
// inbound 默认关：外部 ACPs 消息写 mailbox 需显式开启。
// 【ACPS-05 · 批 punky-acps-closeout-20261023】inbound 投递目标**只**由装配期配置声明：
//   报文自带的 sessionId / commandParams.batchId 一律丢弃（见 lib/comms/acps-bridge.js）；
//   inbound=true 时两键必填，缺失或非法 ⇒ fail-closed 拒收（INBOUND_UNAVAILABLE），不落盘、不静默。
// as const：mode 字面量派生返回类型（'inprocess'|'http'），纯类型层、运行期等价。
export const BRIDGE_DEFAULTS = Object.freeze({
    enabled: false,
    mode: 'inprocess', // 进程内双向（本机 HTTP 桥不实现）
    inbound: false, // inbound 默认关：外部 ACPs 消息写 mailbox 需显式开启
    // 【ACPS-05】投递目标只由装配期配置声明（报文自选 id 一律丢弃）；inbound=true 时两键必填
    inboundSessionId: null, // 主 Agent 会话 id（须匹配 /^[a-zA-Z0-9._-]+$/ 且非 "." / ".."）
    inboundBatchId: null, // 该会话下的目标批次 id（同判据）
});
export function resolveBridgeConfig(config) {
    const c = config?.acps?.bridge ?? {};
    return {
        enabled: c.enabled === true,
        mode: c.mode === 'http' ? 'http' : BRIDGE_DEFAULTS.mode,
        inbound: c.inbound === true,
        // 只做类型收敛（与同文件 cert/key/ca 的收敛写法一致）；id 是否可作**路径段**由 ACPS 域唯一判定
        // （lib/comms/acps-bridge.js#isSafePathSegment）——schema 不承担路径安全判定。
        inboundSessionId: typeof c.inboundSessionId === 'string' && c.inboundSessionId.length > 0 ? c.inboundSessionId : null,
        inboundBatchId: typeof c.inboundBatchId === 'string' && c.inboundBatchId.length > 0 ? c.inboundBatchId : null,
    };
}
// ── config.acps：ACPs 通讯能力 ──
// 默认关（acps.enabled 与 acps.endpoint.enabled 均默认 false——显式开启才加载监听，关闭时零运行时路径）。
//   endpoint：对外 mTLS 服务端点（lib/acps/server.js）——
//     port 9443；host 默认 127.0.0.1（config 可配）；
//     cert/key/ca：三路径（null=自动生成到 certDir，默认 <root>/acps/certs）；aic：ACS 身份码
//     （缺省=agent-descriptor 派生占位，注册后经 config 覆盖）；minVersion TLSv1.3；
//     devInsecure：显式开发开关（默认 false，生产不允许降级）。
// 消费方：lib/index.js 装配（enabled 双真才实例化 createAcpsServer）；lib/assembly/schema.js CAPABILITY_REGISTRY。
// as const：minVersion 字面量派生返回类型（'TLSv1.2'|'TLSv1.3'），纯类型层、运行期等价。
export const ACPS_DEFAULTS = Object.freeze({
    enabled: false, // 能力总开关（默认关）
    endpoint: {
        enabled: false, // 对外端点开关（默认关）
        port: 9443, // 对外监听端口
        host: '127.0.0.1',
        cert: null, // 三路径（null=自动生成 certDir）
        key: null,
        ca: null,
        certDir: null, // 缺省 <root>/acps/certs（index.js 注入 root）
        aic: null, // ACS aic（缺省=agent-descriptor 派生占位）
        agentName: 'dsh-punky-swarm',
        minVersion: 'TLSv1.3', // TLS 最低版本
        devInsecure: false, // 开发模式开关（默认关）
    },
});
export function resolveAcpsConfig(config) {
    const c = config?.acps ?? {};
    const e = (c.endpoint && typeof c.endpoint === 'object' && !Array.isArray(c.endpoint)) ? c.endpoint : {};
    return {
        enabled: c.enabled === true,
        endpoint: {
            enabled: e.enabled === true,
            port: Number.isInteger(Number(e.port)) && Number(e.port) > 0 ? Number(e.port) : ACPS_DEFAULTS.endpoint.port,
            host: typeof e.host === 'string' && e.host.length > 0 ? e.host : ACPS_DEFAULTS.endpoint.host,
            cert: typeof e.cert === 'string' && e.cert.length > 0 ? e.cert : null,
            key: typeof e.key === 'string' && e.key.length > 0 ? e.key : null,
            ca: typeof e.ca === 'string' && e.ca.length > 0 ? e.ca : null,
            certDir: typeof e.certDir === 'string' && e.certDir.length > 0 ? e.certDir : null,
            aic: typeof e.aic === 'string' && e.aic.length > 0 ? e.aic : null,
            agentName: typeof e.agentName === 'string' && e.agentName.length > 0 ? e.agentName : ACPS_DEFAULTS.endpoint.agentName,
            // 单点断言：双条件命中即 e.minVersion 必为二值之一（运行期比较语义不变，断言仅类型层）
            minVersion: e.minVersion === 'TLSv1.2' || e.minVersion === 'TLSv1.3' ? e.minVersion : ACPS_DEFAULTS.endpoint.minVersion,
            devInsecure: e.devInsecure === true,
        },
    };
}
// ── capabilities.auditlog：审计日志 sink（lib/auditlog/*）──
// **默认值单点仍是 `AUDITLOG_DEFAULTS`**（lib/auditlog/config.js，本文件**不复制任何数值**）。
// 此处只登记「哪些键可配」这一**结构事实**（schema 面的可配键清单），用途有两条：
//   ① 一致性用例对齐 `Object.keys(AUDITLOG_DEFAULTS)`（`test/auditlog-sinkfid.test.js` 断言逐条相等）
//      ⇒ 新增配置键漏登记即红，防 schema 面与 config.js 漂移；
//   ② 类型面 `ConfigCapabilitiesInput.auditlog` 有据可依（宽松输入：字段 unknown，归一化在 config.js）。
// env 覆盖通道（与仓内既有 auditlog 开关惯例一致，逐键 `PUNKY_AUDITLOG_*`）：
//   enabled→PUNKY_AUDITLOG｜keepDays→…_KEEP_DAYS｜maxFileBytes→…_MAX_FILE_BYTES｜maxTotalBytes→…_MAX_TOTAL_BYTES
//   stdout→PUNKY_LOGGER_STDOUT｜levelsDefault→…_LEVELS_DEFAULT｜aggregate→…_AGGREGATE｜pruneStray→…_PRUNE_STRAY
// pruneStray【D-16-②】：stray（`parseSegmentName` 不认的常规文件，如 `.bak`）计入 512 MiB 总量上限、
//   挂载期一条 warn + 诊断面 `strays` 字段；删除须显式 opt-in（默认 false ⇒ **绝不自动删用户备份**）。
export const AUDITLOG_CONFIG_KEYS = [
    'enabled',
    'keepDays',
    'maxFileBytes',
    'maxTotalBytes',
    'stdout',
    'levelsDefault',
    'aggregate',
    'pruneStray',
];
// ── config.ratchet：棘轮规则表配置键（可选；缺省 = 默认规则 = 本文件 MEMBER_TRANSITIONS/BATCH_TRANSITIONS，零运行时开销）──
// 消费方 lib/state/machine-rules.ts（loadRules）：
//   { ratchet: { memberRules?: { from: [to...] }, batchRules?: { from: [to...] }, allowRelax?: false } }
// 棘轮语义：配置覆盖只许删（收紧）不许增（放宽）——覆盖表出现本文件默认表不存在的迁移 → loadRules throw（fail-closed）；
//   allowRelax: true 为显式逃生门（默认 false，仅在部署侧明确授权时可用，不推荐）。
