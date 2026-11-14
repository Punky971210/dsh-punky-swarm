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

// @ts-check
export const MEMBER_STATES = [
    'pending', 'running', 'review', 'merged', 'failed', 'skipped', 'conflict', 'idle',
];
// 批次阶段：planning -> running -> paused -> aborted | complete
export const BATCH_PHASES = ['planning', 'running', 'paused', 'aborted', 'complete'];
export const SETTLE_STATES = ['merged', 'failed', 'skipped'];export const MEMBER_TRANSITIONS = {
    pending: ['running', 'failed', 'skipped'],
    running: ['review', 'failed', 'skipped'],
    review: ['merged', 'conflict', 'failed'], // 返工边（`review → running`）已于 2026-09-21 去除（K3）：失败即终态，返工 = gap-list + 新任务批次
    idle: ['running'],
    merged: [],
    failed: [],
    skipped: [],
    conflict: [],
};
// 工具面枚举**只从这里派生**（`member_settle` / `member_set_status` 的参数 enum 不得手抄第二份）：
//   终态 = 迁移表里无出边的态（排除恢复专用 `idle`）；可设非终态 = 有出边且非 `idle` 的态。
//   顺序取迁移表声明序 ⇒ 参数枚举跨版本稳定。
export const TERMINAL_MEMBER_STATES = Object.freeze(
    Object.keys(MEMBER_TRANSITIONS).filter((s) => MEMBER_TRANSITIONS[s].length === 0 && s !== 'idle'),
);
export const SETTABLE_MEMBER_STATES = Object.freeze(
    Object.keys(MEMBER_TRANSITIONS).filter((s) => MEMBER_TRANSITIONS[s].length > 0 && s !== 'idle'),
);
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
// ── capabilities.verify：验收证据捕获（`lib/verify/evidence.js`，台账落 `<root>/verify/`）──
// enabled=true（默认）挂 post-execute 捕获 hook；显式 enabled:false 才关（关 = 零运行时开销）。
// 裁决侧（AC × 台账 → 三态）**已退役**：无生产消费点，重新接线属功能立项，不在重构范围。
export const VERIFY_DEFAULTS = Object.freeze({
    enabled: true,
});
export function resolveVerifyConfig(config) {
    const c = config?.capabilities?.verify ?? {};
    return {
        // 等价默认合并：缺省 = VERIFY_DEFAULTS.enabled(true)，显式 enabled:false 才关（同 resolveWatchConfig 注释）
        enabled: c.enabled !== false,
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
// ── config.mcp：MCP 面（入口 A 宿主路由 `POST /mcp` / 入口 B 自建 loopback 监听）──
// 【2026-11-09 · 批 `punky-mcp-l1-wiring` · 判据源 §3.4 + Leader 裁决 A-1/A-3】
//   · **静态配置**：`mcp` 键**不在** `lib/hot/config-watch.js` 的 ALLOWED_TOP_KEYS 内 ⇒ 从 runtime.json
//     覆盖会被判 `unknown top-level key` 并**静默保持旧快照**（C-7/RK-6）。改端口**必须重启**——
//     这也正是「端口恒等、不自动迁移」成立的前提。
//   · `loopback.enabled` 默认 **true**（用户要它可用；显式 `false` 才关）。
//   · `loopback.port` **恒等使用**：冲突**不迁移 / 不扫描 +1..+9 / 不回落 0**（A-1 否决顺序扫描）。
//     MCP 客户端配置是一次填写、长期使用的稳定契约 ⇒ 冲突是确定性故障，应显式报错而非自愈。
//   · `loopback.host` **不可配**：恒 `127.0.0.1`（C-3，安全面不让配通配地址）；若用户写了别的值，
//     归一化时记为 `rejectedHost`，由装配侧**显式 warn**（不静默丢弃）。
// 消费方：`lib/tools/register.js#createTools`（唯一创建点）→ `lib/mcp/loopback-listener.js`（入口 B）。
export const MCP_LOOPBACK_DEFAULTS = Object.freeze({
    enabled: true,   // 入口 B 总开关（默认开；显式 false 关）
    port: 3918,      // 恒等使用（冲突 ⇒ installed=false + warn，不迁移）
    host: '127.0.0.1', // 硬钉，不可配（C-3）
});
export function resolveMcpLoopbackConfig(config) {
    const m = (config?.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp)) ? config.mcp : {};
    const l = (m.loopback && typeof m.loopback === 'object' && !Array.isArray(m.loopback)) ? m.loopback : {};
    const requestedHost = typeof l.host === 'string' && l.host.length > 0 ? l.host : null;
    return {
        enabled: l.enabled !== false, // 默认开：只有显式 false 才关
        port: Number.isInteger(Number(l.port)) && Number(l.port) > 0 ? Number(l.port) : MCP_LOOPBACK_DEFAULTS.port,
        // host 不参与取值；仅当配置显式给出**非本机回环**值时登记被拒原值，交给装配侧留痕
        host: MCP_LOOPBACK_DEFAULTS.host,
        rejectedHost: requestedHost !== null && requestedHost !== MCP_LOOPBACK_DEFAULTS.host ? requestedHost : null,
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
/**
 * 可结算的 `stopReason` 白名单：**只放行 `completed`**；未知值 / 其它四值一律**保守不结算**
 * （fail-safe：宁可漏结算，也不谎报成功）。
 *
 * ⚠ **单一真源**：`lib/engine/auto-settle.js` 原持有一份私有副本（`const` 非 export），本批已删除并改为
 * 从这里 `import` ⇒ 全仓定义**仅此一处**（`grep -rn "SETTLEABLE_STOP_REASONS *=" lib/` = 1）。
 * ⚠ 冻结：语义是白名单常量，禁止运行期增删（`Object.freeze` 兜运行期误改）。
 */
export const SETTLEABLE_STOP_REASONS = Object.freeze(['completed']);
