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

// 蟛蜞模式状态机 schema（纯逻辑，零依赖）
// 成员状态（对齐 A2 语义 + 设计 3.4）：
//   pending -> running -> review -> merged | failed | skipped | conflict
//   idle：恢复语义（重启后 in-flight 成员落位 idle，可重新指派）
export const MEMBER_STATES = [
  'pending', 'running', 'review', 'merged', 'failed', 'skipped', 'conflict', 'idle',
];

// 批次阶段：planning -> running -> paused -> aborted | complete
export const BATCH_PHASES = ['planning', 'running', 'paused', 'aborted', 'complete'];

export const SETTLE_STATES = ['merged', 'failed', 'skipped'];

export const MEMBER_TRANSITIONS = {
  pending: ['running', 'failed', 'skipped'],
  running: ['review', 'failed', 'skipped'],
  review: ['merged', 'conflict', 'failed', 'running'], // running = REWORK 返工（attempt+1，由事件计数）
  idle: ['running'],
  merged: [],
  failed: [],
  skipped: [],
  conflict: [],
};

export const BATCH_TRANSITIONS = {
  planning: ['running', 'aborted'],
  running: ['paused', 'complete', 'aborted'],
  paused: ['running', 'aborted'],
  aborted: [],
  complete: [],
};

export function isMemberState(s) {
  return MEMBER_STATES.includes(s);
}

export function isBatchPhase(p) {
  return BATCH_PHASES.includes(p);
}

export function isMemberTerminal(s) {
  return SETTLE_STATES.includes(s) || s === 'conflict';
}

export function isBatchTerminal(p) {
  return p === 'aborted' || p === 'complete';
}

export function canTransitionMember(from, to) {
  if (!isMemberState(from) || !isMemberState(to)) return false;
  return MEMBER_TRANSITIONS[from].includes(to);
}

export function canTransitionBatch(from, to) {
  if (!isBatchPhase(from) || !isBatchPhase(to)) return false;
  return BATCH_TRANSITIONS[from].includes(to);
}

export function assertMemberTransition(from, to) {
  if (!canTransitionMember(from, to)) {
    throw new Error('invalid member transition: ' + from + ' -> ' + to);
  }
}

export function assertBatchTransition(from, to) {
  if (!canTransitionBatch(from, to)) {
    throw new Error('invalid batch phase transition: ' + from + ' -> ' + to);
  }
}

export function assertMemberState(s) {
  if (!isMemberState(s)) throw new Error('unknown member state: ' + String(s));
}

export function assertBatchPhase(p) {
  if (!isBatchPhase(p)) throw new Error('unknown batch phase: ' + String(p));
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
  maxMissed: 3,                   // 硬停拍数：连续 N 拍无活动 → lane.stalled 事件，停止追问
  scanIntervalMinutes: 1,         // watchdog 扫描间隔（index.js 挂载 setInterval 用）
  probeTemplate: null,            // 追问模板（可选覆写；缺省用内置 ≤5 句模板，支持 {lane}/{batchId}/{missed} 占位）
});

export function resolveWatchConfig(config) {
  const c = config?.capabilities?.watch ?? {};
  const intervals = Array.isArray(c.intervalsMinutes) && c.intervalsMinutes.length > 0
    ? c.intervalsMinutes.map((m) => (Number.isFinite(Number(m)) && Number(m) >= 0 ? Number(m) : null)).filter((x) => x !== null)
    : null;
  return {
    enabled: c.enabled === true,
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
//   mode=advisory（默认）只记录不拦截；mode=enforce 显式启用则审计裁决拦截（createCompletionGate 读本键）
export const VERIFY_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'advisory',
});

export function resolveVerifyConfig(config) {
  const c = config?.capabilities?.verify ?? {};
  return {
    enabled: c.enabled === true,
    mode: c.mode === 'enforce' ? 'enforce' : VERIFY_DEFAULTS.mode,
  };
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
    enabled: c.enabled === true,
    nodes: (c.nodes && typeof c.nodes === 'object' && !Array.isArray(c.nodes)) ? c.nodes : {},
  };
}

// ── acps.discovery：外部 ADP 发现客户端（lib/acps/discovery-client.js）──
// 插件 Leader 经外部 discovery-server 发现 partner（POST {baseUrl}/discover）；
// 默认关（对外能力显式开启）——enabled=false 不创建客户端实例，零运行时路径。
//   baseUrl：外部 discovery-server 根地址（空 = 未配置，discover 调用抛错）
//   timeout/limit：单次请求超时 ms（默认 10000）与默认返回上限（默认 5）
//   scope：查询范围 local（仅既有本地目录）/ external（仅外部）/ both（本地+外部合并）
export const ACPS_DISCOVERY_DEFAULTS = Object.freeze({
  enabled: false,
  baseUrl: '',
  timeout: 10_000,
  limit: 5,
  scope: 'local',
});

export function resolveAcpsDiscoveryConfig(config) {
  const c = config?.acps?.discovery ?? {};
  const scope = ['local', 'external', 'both'].includes(c.scope) ? c.scope : ACPS_DISCOVERY_DEFAULTS.scope;
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

// ── config.acps.bridge：内部 ACPs 桥接（lib/comms/acps-bridge.js，进程内双向）──
// 桥只经 mailbox.js 公共接口投递/投影，绝不绕过；enabled=false 时不加载不实例化（零路径）。
// inbound 默认关：外部 ACPs 消息写 mailbox 需显式开启。
export const BRIDGE_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'inprocess', // 进程内双向（本机 HTTP 桥不实现）
  inbound: false,    // inbound 默认关：外部 ACPs 消息写 mailbox 需显式开启
});

export function resolveBridgeConfig(config) {
  const c = config?.acps?.bridge ?? {};
  return {
    enabled: c.enabled === true,
    mode: c.mode === 'http' ? 'http' : BRIDGE_DEFAULTS.mode,
    inbound: c.inbound === true,
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
export const ACPS_DEFAULTS = Object.freeze({
  enabled: false,               // 能力总开关（默认关）
  endpoint: {
    enabled: false,             // 对外端点开关（默认关）
    port: 9443,                 // 对外监听端口
    host: '127.0.0.1',
    cert: null,                 // 三路径（null=自动生成 certDir）
    key: null,
    ca: null,
    certDir: null,              // 缺省 <root>/acps/certs（index.js 注入 root）
    aic: null,                  // ACS aic（缺省=agent-descriptor 派生占位）
    agentName: 'dsh-punky-swarm',
    minVersion: 'TLSv1.3',      // TLS 最低版本
    devInsecure: false,         // 开发模式开关（默认关）
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
      minVersion: e.minVersion === 'TLSv1.2' || e.minVersion === 'TLSv1.3' ? e.minVersion : ACPS_DEFAULTS.endpoint.minVersion,
      devInsecure: e.devInsecure === true,
    },
  };
}

// ── config.ratchet：棘轮规则表配置键（可选；缺省 = 默认规则 = 本文件 MEMBER_TRANSITIONS/BATCH_TRANSITIONS，零运行时开销）──
// 消费方 lib/state/machine-rules.js（loadRules）：
//   { ratchet: { memberRules?: { from: [to...] }, batchRules?: { from: [to...] }, allowRelax?: false } }
// 棘轮语义：配置覆盖只许删（收紧）不许增（放宽）——覆盖表出现本文件默认表不存在的迁移 → loadRules throw（fail-closed）；
//   allowRelax: true 为显式逃生门（默认 false，仅在部署侧明确授权时可用，不推荐）。