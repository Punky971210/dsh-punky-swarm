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
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createStore } from './state/store.js';
import { createTools } from './tools/register.js';
import { createApi } from './api.js';
import { syncAssets } from './assets.js';
import { createTrajectoryBridge, isTrajectoryEnabled } from './bridge/trajectory.js';
import { createLaneHeartbeat } from './watch/lane-heartbeat.js';
import { resolveWatchConfig, resolveDiscoveryConfig, resolveAcpsDiscoveryConfig, resolveAcpsConfig } from './schema.js';
import { validateCapabilities, readCapability } from './assembly/schema.js';
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
// R1 热更新运行时（lib/hot/config-watch.js，新建）：<root>/config/runtime.json watch → deepMerge 快照 → config.changed 广播
import { createConfigWatcher, CONFIG_CHANGED_EVENT } from './hot/config-watch.js';
// R2 topic 运行时（lib/comms/topic-runtime.js，新建）：装配面 start/stop（与 trajectory 桥同形）+ 状态事件发布接线
import { createTopicRuntime } from './comms/topic-runtime.js';
// P1-02 接线：启动恢复经 resume 模块（恢复 running/review 而非一律 idle；config.resume.enabled 缺省关 →
//   内部原样委托 store.recoverBatches()，零行为变化）
import { recoverBatches as resumeRecoverBatches, resolveResumeConfig } from './state/resume.js';

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

  // R2 topic 发布钩子容器：store 状态事件 → topic 运行时（装配点写入 emit；默认关零路径）
  const topicSink = { emit: null };
  const store = createStore(root, {
    // R2 topic 发布钩子（store 状态事件 → topic 运行时）：topic 默认关 → emit=null → 零行为变化；
    // enabled 时装配点注入 emitTopic 发布（setMember/setPhase 调用点埋点，appendEvent 闭包不可外部 wrap）
    onStateChange: (ev) => { try { topicSink.emit?.(ev); } catch { /* 隔离：topic 发布失败不阻断状态机 */ } },
  });

  // P2-04：GATE_ENABLED=false 逃生阀启动级留痕——gates.js checkCommandGate/checkTargetsGate 命中逃生阀时
  // 内部静默返回零感知（{ ok:true, declared:false }，行为语义不变），装配侧在此检测并落启动级 warn，
  // 保证「门禁被禁用」状态可查（审计/排障经启动日志即可见，无需翻 gates.js 源码）。
  if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') {
    ctx.logger?.warn?.('[dsh-punky-swarm] GATE_ENABLED=false: 命令门禁/targets 门禁整体放行（应急逃生阀，零感知语义），禁用状态已留痕于启动日志');
  }

  // mailbox 周期 sweep 定时器（④，config.mailbox.sweepIntervalMs>0 时挂载；默认 0=关，零隐式行为）——提升到 apply 作用域供 disposer 清理
  let sweepTimer = null;

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
  // P1-02 接线：改调 resume.recoverBatches(store, { restoreRunning: resumeCfg.enabled })——
  //   config.resume.enabled 缺省关 → 内部委托 store.recoverBatches()（原路径零行为变化）；
  //   开启 → restoreBatches()（running/review 原地保留 + system.restored 事件）。返回数组形态
  //   .length/.corrupt 兼容既有日志消费。
  if (!recoveredThisProcess) {
    recoveredThisProcess = true;
    try {
      const resumeCfg = resolveResumeConfig(config);
      const r = resumeRecoverBatches(store, { restoreRunning: resumeCfg.enabled });
      if (r.length) ctx.logger?.info?.('[dsh-punky-swarm] recovered batches: ' + r.join(', '));
      // 恢复容错汇总（v2-node-robustness ②）：损坏批次被隔离（corrupt-batches.json + 跳过），不阻断其余恢复
      if (Array.isArray(r.corrupt) && r.corrupt.length) {
        ctx.logger?.warn?.('[dsh-punky-swarm] isolated ' + r.corrupt.length + ' corrupt batch(es): ' + r.corrupt.join(', ') + '（人工修复/删除后 clearCorruptMark）');
      }
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] recovery failed: ' + String(e));
    }

    // mailbox 启动清扫（④，D-006/sweepOnStart 默认 true）：recoverBatches 之后逐批次 mailbox 根 sweep 一次——
    // 清 ack 超 TTL 消息+标记 / 损坏消息 quarantine / 孤儿 .acked（默认 TTL 7d、quarantine 30d）。
    // 失败仅 warn 不阻塞启动；幂等可重入（sweep 无状态全量扫描）。
    const mailCfg = config?.mailbox ?? {};
    const sweepAllMailboxes = () => {
      const agg = { scanned: 0, removed: 0, quarantined: 0, failed: 0 };
      const mbBase = join(root, 'sessions');
      if (existsSync(mbBase)) {
        for (const sid of readdirSync(mbBase)) {
          const mbRoot = join(mbBase, sid, 'mailbox');
          if (!existsSync(mbRoot)) continue;
          for (const bid of readdirSync(mbRoot)) {
            try {
              const r = mailbox.sweep(join(mbRoot, bid));
              agg.scanned += r.scanned; agg.removed += r.removed; agg.quarantined += r.quarantined; agg.failed += r.failed;
            } catch { agg.failed++; }
          }
        }
      }
      return agg;
    };
    if (mailCfg.sweepOnStart !== false) {
      try {
        const agg = sweepAllMailboxes();
        if (agg.scanned || agg.removed || agg.quarantined || agg.failed) {
          ctx.logger?.info?.('[dsh-punky-swarm] mailbox sweep on start: scanned=' + agg.scanned
            + ' removed=' + agg.removed + ' quarantined=' + agg.quarantined + ' failed=' + agg.failed);
        }
      } catch (e) {
        ctx.logger?.warn?.('[dsh-punky-swarm] mailbox sweep on start failed: ' + String(e));
      }
    }
    // 周期 sweep（默认 0=关，C-6 零隐式行为）：显式配置 sweepIntervalMs>0 才挂 setInterval（unref + dispose 清理）
    const sweepIntervalMs = Number(mailCfg.sweepIntervalMs) || 0;
    if (sweepIntervalMs > 0) {
      sweepTimer = setInterval(() => {
        try {
          const agg = sweepAllMailboxes();
          if (agg.removed || agg.quarantined || agg.failed) {
            ctx.logger?.info?.('[dsh-punky-swarm] mailbox sweep (periodic): scanned=' + agg.scanned
              + ' removed=' + agg.removed + ' quarantined=' + agg.quarantined + ' failed=' + agg.failed);
          }
        } catch (e) {
          ctx.logger?.warn?.('[dsh-punky-swarm] mailbox sweep failed: ' + String(e));
        }
      }, sweepIntervalMs);
      if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
      if (ctx.effect) {
        ctx.effect(() => () => { clearInterval(sweepTimer); sweepTimer = null; }, 'dsh-punky-swarm: mailbox sweep');
      }
      ctx.logger?.info?.('[dsh-punky-swarm] mailbox periodic sweep mounted (interval ' + sweepIntervalMs + 'ms)');
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
        + ' baseUrl=' + (acpsDiscoveryCfg.baseUrl || '(unset)') + ' (external ADP /discover)');
    }

    apiDispose = createApi(ctx, { store, root, catalog: tools.catalog, agentCatalog: tools.agentCatalog, aipFormat: tools.aipFormat, discovery, acpsDiscovery: acpsDiscoveryClient }).dispose;

    // [exec-b 挂载点预留] R3 SSE hub（lib/panel/stream.js，exec-b 新建）在此装配：随 webServer 挂载（ADR-4 无独立
    //   配置键）、topic.enabled 时经 subscribeTopic('swarm.') 订阅低延迟触发源 + fs.watch 批次目录兜底；exec-a merged
    //   后接线（契约移交点）。本批 exec-a 不实现 hub——exec-b 在 api.js 侧经 deps.panelStream 注入复用/自建兜底
    //   （缺省 createStreamHub），本预留仅声明挂载面，不引入任何装配。
  }

  // 诊断桥接（trajectory）：订阅 trajectory 异常 → sessionId→lane 映射 → notify（默认 notify-only）。
  // enabled 默认关：enabled=false 时桥接不创建不挂载——零运行时开销，行为与既有版本一致。
  // 生命周期：start() 挂订阅/轮询；stop() 退订/清定时器（经 apply 返回的 dispose 释放，进程重启后桥接随插件重建、映射从批次事件幂等恢复）
  let trajectory = isTrajectoryEnabled(config) ? createTrajectoryBridge(ctx, { store, config, mailbox }) : null;
  if (trajectory) {
    const st = trajectory.start();
    if (st.subscribed) {
      ctx.logger?.info?.('[dsh-punky-swarm] trajectory bridge subscribed (autoFail=' + (config?.capabilities?.trajectory?.autoFail === true) + ')');
    }
  }

  // R2 topic 运行时装配（默认关——readCapability 缺省合并 {enabled:false}；显式 capabilities.topic.enabled:true 开启）：
  // enabled 时创建运行时（start/stop 与 trajectory 桥同形）+ 接线状态事件发布（store.setMember/setPhase 调用点埋点）；
  // 关闭时零挂载零路径（与 acps/bridge config 短路同构）。trajectory 桥 broadcast 直走不变，topic.enabled 时仅镜像（并存不替换）。
  // R1 热更新（config.changed）可实时启停本运行时（L1 消费点，见下方 applyConfigChange ③）。
  let topicRuntime = null;
  if (readCapability(config, 'topic')?.enabled) {
    topicRuntime = createTopicRuntime(ctx, { root, logger: ctx.logger });
    topicRuntime.start();
    topicSink.emit = (ev) => { try { topicRuntime.publishStateChange(ev); } catch { /* 隔离 */ } };
    ctx.logger?.info?.('[dsh-punky-swarm] topic capability enabled: topic runtime started (swarm.<type>.<sid>.<bid>)');
  }

  // 内部 ACPs 桥接（config.acps.bridge，默认关）：enabled=false 时 mountBridge 短路返回 null——
  // 不实例化、零运行时路径（config 短路）；outbound=mailbox→ACPs 投影/投递，inbound 默认关：
  // 外部写 mailbox 需显式 acps.bridge.inbound=true。/rpc 监听与对外投递由 endpoint 侧承担。
  const bridge = mountBridge(config, { root, mailbox, logger: ctx.logger });
  if (bridge) {
    ctx.logger?.info?.('[dsh-punky-swarm] acps.bridge enabled: in-process bridge mounted (inbound='
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
    ctx.logger?.info?.('[dsh-punky-swarm] acps.registry enabled: semi-automatic registration client ready ('
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
  let verifyMount = mountVerify(ctx, { root, config });
  if (verifyMount.installed) {
    ctx.logger?.info?.('[dsh-punky-swarm] verify capability enabled: post-execute evidence capture mounted');
  }

  // ── R1 热更新装配（L1 消费点就地启停，叠加非替换）──
  // 触发源：<root>/config/runtime.json（fs.watch + 防抖 300ms + 原子读重试）→ deepMerge 快照 → config.changed 广播
  // 生效语义：只影响被覆盖键的后续读取；不写静态文件、不改变 cordis.patch.yml 读取结果（D2）；
  //   缺省 {} → 快照 = 静态 config 原样（零行为变化）；判定语义双套保留、热更新只做值传播（设计 §3.1.5 裁决）
  // 生效范围（L1，设计 §3.1.4）：trajectory 桥 start/stop、watch watchdog 启停、topic 运行时启停、verify 挂载（可选）
  //   对外能力（acps/bridge/acps.discovery/identity）不纳入热切（设计 §3.1.5 附带裁决）
  let hotConfig = null;
  const applyConfigChange = (change) => {
    const next = change.config;
    // ① watch watchdog：enabled 翻转 → 启/停（heartbeat.dispose + timer 句柄，幂等）
    const wc = resolveWatchConfig(next);
    if (wc.enabled && !heartbeat) {
      heartbeat = createLaneHeartbeat({ store, mailbox, config: next, root });
      const scanMs = Math.max(1000, Math.round(wc.scanIntervalMinutes * 60_000));
      watchTimer = setInterval(() => {
        try { heartbeat.tick(); } catch (e) { ctx.logger?.warn?.('[dsh-punky-swarm] heartbeat tick failed: ' + String(e)); }
      }, scanMs);
      if (typeof watchTimer.unref === 'function') watchTimer.unref();
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: watch watchdog started (scan ' + scanMs + 'ms)');
    } else if (!wc.enabled && heartbeat) {
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
      heartbeat.dispose(); heartbeat = null;
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: watch watchdog stopped');
    }
    // ② trajectory 桥：enabled 翻转 → stop + 以新快照重建（映射经批次事件幂等恢复）
    const trajOn = isTrajectoryEnabled(next);
    if (trajOn && !trajectory) {
      trajectory = createTrajectoryBridge(ctx, { store, config: next, mailbox });
      const st = trajectory.start();
      if (st.subscribed) ctx.logger?.info?.('[dsh-punky-swarm] hot config: trajectory bridge started');
    } else if (!trajOn && trajectory) {
      trajectory.stop(); trajectory = null;
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: trajectory bridge stopped');
    }
    // ③ topic 运行时：readCapability 缺省关 → enabled 翻转 → 启/停（状态事件发布钩子随动）
    const topicCfg = readCapability(next, 'topic');
    if (topicCfg?.enabled && !topicRuntime) {
      topicRuntime = createTopicRuntime(ctx, { root, logger: ctx.logger });
      topicRuntime.start();
      topicSink.emit = (ev) => { try { topicRuntime.publishStateChange(ev); } catch { /* 隔离 */ } };
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: topic runtime started');
    } else if (!topicCfg?.enabled && topicRuntime) {
      topicRuntime.stop(); topicRuntime = null;
      topicSink.emit = null;
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: topic runtime stopped');
    }
    // ④ verify 挂载（可选 L1）：enabled 翻转 → dispose + 以新快照重挂（inert 与 installed 双态幂等）
    const vc = resolveVerifyConfig(next);
    if (vc.enabled !== verifyMount.installed) {
      verifyMount.dispose?.();
      verifyMount = mountVerify(ctx, { root, config: next });
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: verify capture ' + (vc.enabled ? 'mounted' : 'unmounted'));
    }
  };
  hotConfig = createConfigWatcher({
    root, config,
    onChange: (change) => {
      // ① 进程内广播（cordis 总线事件，宿主可用时；exec-b hub/未来订阅方经 ctx.on 订阅）
      try { ctx.emit?.(CONFIG_CHANGED_EVENT, change); } catch { /* 宿主事件缺失静默 */ }
      // ② topic 镜像（R1→R2 可选，设计 §3.4）：topic.enabled 时同步 emitTopic('swarm.config.changed')，仅进程内分发
      if (topicRuntime) { try { topicRuntime.publishConfigChanged(change); } catch { /* 隔离 */ } }
      // ③ L1 消费点就地启停
      applyConfigChange(change);
    },
    logger: ctx.logger,
  });
  hotConfig.start();

  return () => {
    hotConfig?.dispose();
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    heartbeat?.dispose();
    apiDispose?.();
    trajectory?.stop();
    topicRuntime?.stop();
    verifyMount?.dispose();
    if (acpsEndpoint) { acpsEndpoint.close().catch(() => {}); acpsEndpoint = null; }
  };
};
