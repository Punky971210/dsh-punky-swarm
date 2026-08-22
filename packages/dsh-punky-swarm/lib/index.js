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

// dsh-punky-swarm 插件入口：蟛蜞模式集群治理引擎（leader-member 治理）
// v2：批次绑定 session（root/sessions/<sessionId>/...）；存量 root/batches 自动迁移到 legacy
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { createStore } from './state/store.js';
import { createTools } from './tools/register.js';
import { createApi } from './api.js';
import { syncAssets } from './assets.js';
import { createTrajectoryBridge, isTrajectoryEnabled } from './bridge/trajectory.js';
import { createLaneHeartbeat } from './watch/lane-heartbeat.js';
import { resolveWatchConfig, resolveDiscoveryConfig, resolveAcpsDiscoveryConfig, resolveAcpsConfig } from './schema.js';
import { validateCapabilities } from './assembly/schema.js';
import { createDiscoveryService } from './discovery/service.js';
import { createAcpsDiscoveryClient } from './acps/discovery-client.js';
import { buildAgentDescriptors } from './aip/agent-descriptor.js';
import { engineVersion } from './aip/tool-descriptor.js';
import { DEFAULT_ASSEMBLY } from './assembly.js';
import { mountVerify } from './verify/mount.js';
import { mountBridge, createEndpointRpcHandler } from './comms/acps-bridge.js';
import { createRegistryClient, resolveRegistryConfig } from './acps/registry-client.js';
import { createAcpsServer } from './acps/server.js';
import * as mailbox from './comms/mailbox.js';

export const name = 'dsh-punky-swarm';
export const inject = ['tools', 'webServer'];

// 恢复语义：每个进程只执行一次（无论插件按进程级还是会话级挂载）
let recoveredThisProcess = false;

export const apply = (ctx, config = {}) => {
  const rawRoot = config.root ?? '~/.dsh/jiufeng';
  const root = rawRoot.startsWith('~') ? join(homedir(), rawRoot.slice(1)) : rawRoot;
  mkdirSync(root, { recursive: true });
  // 启动日志：引擎产物根（诊断可见性——worker/Leader 产物落盘契约的权威路径）
  ctx.logger?.info?.('[dsh-punky-swarm] engine root: ' + root + '；产物根 = <root>/sessions/<sessionId>/artifacts/<batchId>/');

  // 配置校验兜底：仅 warn 不炸宿主——validateCapabilities 仅对显式
  // enabled 的非法组合报错；禁用能力零校验零 warn；空/缺省 config → errors=[] → 零 warn
  for (const err of validateCapabilities(config).errors) {
    ctx.logger?.warn?.('[dsh-punky-swarm] config: ' + err);
  }

  const store = createStore(root);

  // 存量迁移：root/batches/*.json -> sessions/legacy/batches/（仅一次，幂等）
  if (!recoveredThisProcess) {
    try {
      const moved = store.migrateLegacy();
      if (moved) ctx.logger?.info?.('[dsh-punky-swarm] migrated ' + moved + ' legacy batch(es) to sessions/legacy');
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] legacy migration failed: ' + String(e));
    }
    // 资产同步：预设（~/.dsh/.agent-presets/jiufeng）与技能（~/.agents/skills/jiufeng-team），幂等，参照 dsh-liangshen
    try {
      for (const r of syncAssets()) {
        if (r.status === 'synced') ctx.logger?.info?.('[dsh-punky-swarm] asset synced: ' + r.asset);
        else if (r.status === 'failed') ctx.logger?.warn?.('[dsh-punky-swarm] asset sync failed: ' + r.asset + ': ' + r.error);
      }
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] asset sync failed: ' + String(e));
    }
  }

  // 启动恢复：in-flight 成员 -> idle + system.recovered（每个进程仅一次，跨全部 session）
  if (!recoveredThisProcess) {
    recoveredThisProcess = true;
    try {
      const r = store.recoverBatches();
      if (r.length) ctx.logger?.info?.('[dsh-punky-swarm] recovered batches: ' + r.join(', '));
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] recovery failed: ' + String(e));
    }
  }

  // config 贯通：apply 的 config（cordis.patch.yml -> 插件 config）传入 createTools，
  // tools.js guard 经 config?.escalation.execTools 覆盖执行型工具名单（可选，缺省 EXEC_TOOLS）
  // enabled=true 时 register() 生成 catalog（14 工具 6 属性快照），传给 createApi 挂 /tools 端点
  // watch 心跳引擎（lane 过期检测）：enabled 默认关——开启时才创建引擎并挂 watchdog 定时器
  const watchCfg = resolveWatchConfig(config);
  let heartbeat = null;
  if (watchCfg.enabled) {
    heartbeat = createLaneHeartbeat({ store, mailbox, config, root });
  }
  const tools = createTools(ctx, { store, root, config, heartbeat });
  tools.register();

  // watchdog 挂载：setInterval(scanIntervalMinutes) 调 heartbeat.tick() 扫描全部 running lane。
  // enabled 缺省/false 不挂——零运行时开销；ctx.effect（宿主可用时）与 apply 返回的 disposer 双保险清理（幂等）
  let watchTimer = null;
  if (watchCfg.enabled && heartbeat) {
    const scanMs = Math.max(1000, Math.round(watchCfg.scanIntervalMinutes * 60_000));
    watchTimer = setInterval(() => {
      try { heartbeat.tick(); } catch (e) { ctx.logger?.warn?.('[dsh-punky-swarm] heartbeat tick failed: ' + String(e)); }
    }, scanMs);
    if (typeof watchTimer.unref === 'function') watchTimer.unref();
    if (ctx.effect) {
      ctx.effect(() => () => { clearInterval(watchTimer); watchTimer = null; heartbeat?.dispose(); }, 'dsh-punky-swarm: watch heartbeat');
    }
    ctx.logger?.info?.('[dsh-punky-swarm] watch capability enabled: lane heartbeat watchdog mounted (scan ' + scanMs + 'ms)');
  }

  // 只读治理 API（工作台用）；agentCatalog：ACS 描述目录（aip.enabled 门控，register 后非空）
  // aipFormat 随装配导出给 api.js 只读端点（mailbox/batch 响应附 ACPs 投影；纯函数不改存储）
  let apiDispose = null;
  if (ctx.webServer) {
    // 发现服务（ADP）：capabilities.discovery.enabled（默认开）时装配——
    // 消费 tool-descriptor catalog（tools.catalog，aip.enabled 时非空）+ agent-descriptor 目录（DEFAULT_ASSEMBLY 派生）
    const discoveryCfg = resolveDiscoveryConfig(config);
    let discovery = null;
    if (discoveryCfg.enabled) {
      const agentDescriptors = buildAgentDescriptors(DEFAULT_ASSEMBLY, { version: engineVersion() });
      discovery = createDiscoveryService({ catalog: tools.catalog, agentDescriptors, config: discoveryCfg });
      ctx.logger?.info?.('[dsh-punky-swarm] discovery capability enabled: POST /discover + /.well-known/aip mounted (' + discovery.stats().entries + ' entries)');
    }

    // 外部 ADP 发现客户端（acps.discovery，默认关——显式开启）：
    // 装配在 webServer 域（与本地 discovery service 同域，scope=local/both 依赖其实例）；
    // enabled=false 不创建实例，零运行时路径（无网络/定时器）。消费方：经 api 上下文 acpsDiscovery 取用
    // mini-ADSP 仅预留签名（createMiniAdsp），endpoint 就绪前不实现。
    const acpsDiscoveryCfg = resolveAcpsDiscoveryConfig(config);
    let acpsDiscoveryClient = null;
    if (acpsDiscoveryCfg.enabled) {
      acpsDiscoveryClient = createAcpsDiscoveryClient({
        baseUrl: acpsDiscoveryCfg.baseUrl,
        timeout: acpsDiscoveryCfg.timeout,
        limit: acpsDiscoveryCfg.limit,
        scope: acpsDiscoveryCfg.scope,
        localService: discovery,
      });
      ctx.logger?.info?.('[dsh-punky-swarm] acps discovery client enabled: scope=' + acpsDiscoveryCfg.scope
        + ' baseUrl=' + (acpsDiscoveryCfg.baseUrl || '(unset)') + ' (external ADP /discover, DS1)');
    }

    apiDispose = createApi(ctx, { store, root, catalog: tools.catalog, agentCatalog: tools.agentCatalog, aipFormat: tools.aipFormat, discovery, acpsDiscovery: acpsDiscoveryClient }).dispose;
  }

  // 诊断桥接（trajectory）：订阅 trajectory 异常 → sessionId→lane 映射 → notify（默认 notify-only）。
  // enabled 默认关：enabled=false 时桥接不创建不挂载——零运行时开销，行为与既有版本一致。
  // 生命周期：start() 挂订阅/轮询；stop() 退订/清定时器（经 apply 返回的 dispose 释放，进程重启后桥接随插件重建、映射从批次事件幂等恢复）
  const trajectory = isTrajectoryEnabled(config) ? createTrajectoryBridge(ctx, { store, config, mailbox }) : null;
  if (trajectory) {
    const st = trajectory.start();
    if (st.subscribed) {
      ctx.logger?.info?.('[dsh-punky-swarm] trajectory bridge subscribed (autoFail=' + (config?.capabilities?.trajectory?.autoFail === true) + ')');
    }
  }

  // 内部 ACPs 桥接（config.acps.bridge，默认关）：enabled=false 时 mountBridge 短路返回 null——
  // 不实例化、零运行时路径（config 短路）；outbound=mailbox→ACPs 投影/投递，inbound 默认关：
  // 外部写 mailbox 需显式 acps.bridge.inbound=true。/rpc 监听与对外投递由 endpoint 侧承担。
  const bridge = mountBridge(config, { root, mailbox, logger: ctx.logger });
  if (bridge) {
    ctx.logger?.info?.('[dsh-punky-swarm] acps.bridge enabled: G1 in-process bridge mounted (inbound='
      + (config?.acps?.bridge?.inbound === true) + ')');
  }

  // 半自动注册客户端（config.acps.registry）：默认关——enabled=true 且
  // registry.url 配置时创建 RegistryClient 实例（能力装配，不自动发起注册——V3 人工审核不自动化
  // 跳过，注册动作由用户经脚本/工具显式触发：login→upsert→submit→人工审批→requestEab）。
  // enabled=false / 缺 url 时短路：不建实例、零网络、零运行时路径。
  const registryCfg = resolveRegistryConfig(config);
  const registryClient = registryCfg.enabled ? createRegistryClient(registryCfg) : null;
  if (registryCfg.enabled && !registryClient) {
    ctx.logger?.warn?.('[dsh-punky-swarm] acps.registry: ' + (registryCfg.reason ?? 'unable to create client'));
  } else if (registryClient) {
    ctx.logger?.info?.('[dsh-punky-swarm] acps.registry enabled: R1 semi-automatic registration client ready ('
      + registryCfg.apiBaseUrl + ')');
  }

  // ACPs 对外 mTLS 服务端点：acps.enabled && acps.endpoint.enabled 双真才装配——
  // 默认双关 = 零加载零监听零定时器（config 短路，关闭时无运行时路径）。
  // 证书缺失/不可用 → 启动告警并保持禁用，不阻塞主进程。
  // 与既有端点零冲突：对外独立 9443 监听 + /acps/* 前缀，/api/dsh-punky-swarm/* 与 /.well-known/aip 一字不动。
  const acpsCfg = resolveAcpsConfig(config);
  let acpsEndpoint = null;
  if (acpsCfg.enabled && acpsCfg.endpoint?.enabled) {
    try {
      const endpointCfg = {
        ...acpsCfg,
        endpoint: {
          ...acpsCfg.endpoint,
          certDir: acpsCfg.endpoint.certDir ?? join(root, 'acps', 'certs'), // 默认数据目录（引擎根内）
        },
      };
      // /acps/rpc → bridge inbound 接线——endpoint 收到 TaskCommand 交 bridge.handleInbound
      // （经 mailbox 公共接口原子写 inbox；inbound 门控保持：bridge.inbound=false → INBOUND_DISABLED 拒绝，
      //  /rpc 回 TaskResult rejected 不落 mailbox）。bridge 未装配（enabled=false）时回独立 accepted（向后兼容）。
      const rpcHandler = bridge ? createEndpointRpcHandler(bridge, { logger: ctx.logger }) : undefined;
      acpsEndpoint = createAcpsServer({ config: endpointCfg, logger: ctx.logger, rpcHandler });
      if (acpsEndpoint.error) {
        ctx.logger?.warn?.('[dsh-punky-swarm] ' + acpsEndpoint.error + '（acps endpoint 保持禁用）');
        acpsEndpoint = null;
      } else {
        acpsEndpoint.listen().then((addr) => {
          ctx.logger?.info?.('[dsh-punky-swarm] acps endpoint enabled: mTLS listener https://' + addr.address + ':' + addr.port
            + ' (TLSv1.3 + CERT_REQUIRED, devInsecure=' + endpointCfg.endpoint.devInsecure + ')');
        }).catch((e) => {
          ctx.logger?.warn?.('[dsh-punky-swarm] acps endpoint listen failed: ' + String(e) + '（保持禁用）');
          acpsEndpoint = null;
        });
      }
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] acps endpoint disabled: ' + String(e.message));
      acpsEndpoint = null;
    }
  }

  // verify 引擎级捕获（verify-report 集成注意项 1 接线）：capabilities.verify.enabled 门控挂
  // installEvidenceCapture（tools/post-execute 证据捕获，blob + ledger 落 <root>/verify/）。enabled=false（默认）
  // 不挂 hook、零运行时开销；ctx.on 缺失静默降级。createCompletionGate 与 audit lane DI 消费路径一字不动（gate.js 零改动）。
  const verifyMount = mountVerify(ctx, { root, config });
  if (verifyMount.installed) {
    ctx.logger?.info?.('[dsh-punky-swarm] verify capability enabled: post-execute evidence capture mounted');
  }

  return () => {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    heartbeat?.dispose();
    apiDispose?.();
    trajectory?.stop();
    verifyMount?.dispose();
    if (acpsEndpoint) { acpsEndpoint.close().catch(() => {}); acpsEndpoint = null; }
  };
};
