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
import fs from 'node:fs';
import { createStore } from './state/store.js';
import { loadRules } from './state/machine-rules.js'; // 棘轮规则表（config.ratchet）装配期解析——见下方 createStore 注入点
import { ratchetHotGuard } from './hot/config-watch.js'; // ratchet 热更守卫（重启生效面：只校验+告警，不应用）——见 applyConfigChange ⑥
import { createTools } from './tools/register.js';
// 【方案 A · 延迟绑定】`/mcp` 的唯一延迟入口要**重试挂载**它：`createTools` 里那次尝试早于
//   `webServer` 就绪（`lib/tools/register.js:38`），早退时返回 `installed=false` 的 no-op disposer。
import { installMcpDataPlane } from './mcp/data-plane-server.js';
import { RESIDENT_TOOL_NAMES } from './engine/suite.js';
import { EXEC_TOOLS } from './tools/core.js';
import { wakeLeaderForReport } from './tools/swarm-comms.js';
import { poolViewOf } from './tools/task-tools.js';
import { createApi } from './api.js';
import { syncAssets } from './assets.js';
import { createTrajectoryBridge, isTrajectoryEnabled } from './bridge/trajectory.js';
import { installDispatchRegistration } from './bridge/dispatch-register.js'; // 派发写侧登记点（见 bridge/dispatch-register.js）
// P3a 自动结算主路（规格 §2/§3/§4）：宿主 `subagent/end` 生命周期事件 → 引擎自动判定 ⇒ 全绿自动 merged /
//   任一判据不满足 ⇒ 停轮（缺省 onFail=pause）。**必须**以 `{ global: true }` 注册（契约卡
//   `plan/host-completion-probe-spec.md` #8/#9：被 scope 化的插件 ctx 下默认监听漏收）。
import { installAutoSettle, AUTO_SETTLE_SUBAGENT_END } from './engine/auto-settle.js';
import { ownerSessionIdOf, wakeAddressOf, dispatchIndexEntryOf, batchSessionIdOfWorker, batchSessionIdOfWorkerResolved } from './engine/dispatch.js';
import { replayBatch } from './engine/replay.js'; // W1-① 重放/恢复（启动期有界扫描）
import { createLaneHeartbeat, resolveLongrunConfig } from './watch/lane-heartbeat.js';
import { resolveWatchConfig, resolveDiscoveryConfig, resolveAcpsDiscoveryConfig, resolveAcpsConfig, resolveVerifyConfig, autoSettleEnabledOf, autoSettleSwitchOf, resolveBridgeConfig } from './schema.js';
import { validateCapabilities, readCapability } from './assembly/schema.js';
import { ENGINE_INJECTIONS, capabilityReport, assertRequired } from './capabilities.js';
// 【W4 · D-2/D-3】功能面探活所需的端口实例：由装配根在此**建一次**，供 `capabilityReport({ ports })` 读 `available`。
//   方向 = 引擎 → provider 端口（J6：宿主差异只在 provider 内）；本文件不再读任何宿主服务名。
import { createToolsPort } from './provider-dsh/tools-http.js';
import { createAgentPort, agentChannelFactsOf } from './provider-dsh/agent.js';
import { createDiscoveryService } from './discovery/service.js';
import { createAcpsDiscoveryClient } from './acps/discovery-client.js';
import { buildAgentDescriptors } from './aip/agent-descriptor.js';
import { engineVersion } from './aip/tool-descriptor.js';
import { DEFAULT_ASSEMBLY } from './assembly.js';
import { mountVerify } from './verify/mount.js';
// 工具调用级护栏（governance hook）：lib/governance/wiring.js 订阅宿主
// tools/pre-execute + tools/post-execute（双阶段零宿主改造）——6 原语纯函数内核裁决 +
// 拒绝收据落盘（receipt-store.js）；装配对齐 mountVerify 模式。
import { installGovernanceHook } from './governance/wiring.js';
// 【L-1 · 随 P2 引入】governance 增量冲刷单点：用于插件卸载/热重载时闭合「未落盘计数」窗口
import { flushDirtyGovernance } from './state/store/governance.js';
import { dispatchRecordsOf } from './state/dispatch-events.js';
// governance 键热更：applyConfigChange ⑤ 经 resolveGovernanceConfig 归一比较 governance.hook
//   生效变化（enabled/rules/flags/defaults）→ dispose + 重挂（对齐 verifyMount 模式，不引入 updateConfig API）
import { resolveGovernanceConfig } from './governance/config.js';
// preset 装载：governance.hook.preset 引用键 → boot 装载一次 table 注入 resolve
//   presetTable——preset 文件 = 发布资产语义，热更只管引用启停、不重读文件）
import { loadPresetTable, PRESET_IDS } from './governance/preset-loader.js';
// WebUI 治理配置写通道：createApi configEndpoints 注入面——
//   runtimeConfig 服务实例（<root>/config/runtime.json 写通道）+ trustedHosts（出厂 []）+ applied/presets
//   getters（延迟引用装配后初始化绑定，HTTP 请求时求值无 TDZ——见 createApi 调用点注释）
import { createRuntimeConfigService } from './webui/runtime-config.js';
// 双层桥接事件流：收据事件 → 批级事件流文件（governance/events/refusal-<sessionId>.jsonl，
//   零依赖 node:fs 追加；仅事件可见性，不触发批级状态迁移）
import { appendRefusalEvent } from './governance/receipt-store.js';
// 【ACPS-04】createEndpointRpcHandler 不再由本文件直调（选择逻辑已收口到 selectRpcHandler 单点）
import { mountBridge, selectRpcHandler } from './comms/acps-bridge.js';
import { createRegistryClient, resolveRegistryConfig } from './acps/registry-client.js';
import { createAcpsServer } from './acps/server.js';
import * as mailbox from './comms/mailbox.js';
// 热更新运行时（lib/hot/config-watch.js）：<root>/config/runtime.json watch → deepMerge 快照 → config.changed 广播
import { createConfigWatcher, CONFIG_CHANGED_EVENT } from './hot/config-watch.js';
// topic 运行时（lib/comms/topic-runtime.js）：装配面 start/stop（与 trajectory 桥同形）+ 状态事件发布接线
import { createTopicRuntime } from './comms/topic-runtime.js';
// SSE hub（lib/panel/stream.js）由装配层创建注入 api.js（deps.panelStream），
//   topic.enabled 时经 hub.attachTopic('swarm.') 订阅低延迟触发源（subscribeTopicPrefix → parseTopicIds → notifyAll）
import { createStreamHub } from './panel/stream.js';
// 接线：启动恢复经 resume 模块（恢复 running/review 而非一律 idle；config.resume.enabled 缺省关 →
//   内部原样委托 store.recoverBatches()，零行为变化）
import { recoverBatches as resumeRecoverBatches, resolveResumeConfig } from './state/resume.js';
import { createWakeQueue } from './state/wake-queue.js';
// 审计日志 sink（lib/auditlog/）：进程级 cordis logger exporter——默认开、可显式关闭、按日分卷 + 体积上限、
//   零远程上报。挂载点见下方 apply() 内注释（必须在 validateCapabilities warn / GATE_ENABLED warn / syncAssets
//   三条 warn 之前，否则这些启动期审计信号永久缺席）。
import { mountAuditLog } from './auditlog/sink.js';
// 【W4 · S-2 站点①】HTTP 功能面读数：本文件不再直读 `ctx.webServer`（宿主服务名），
//   改向 provider 的端口要「**HTTP 功能拿到没有**」（`available`）。
//   为什么必须在这一步（R-2 顺序）：`ctx.webServer` 是**裸取属性**，在 `inject` 清空后会直接抛
//   `cannot get property "webServer" without inject`；而端口的 `available` 走 `ctx?.webServer ?? null`
//   + try 语义，且 provider 行自身持有 `inject: [tools, webServer, subagents]` ⇒ 不依赖引擎行。
//   依赖方向：引擎 → provider 端口（J6：宿主差异只在 provider 内）。
import { createHttpPort } from './provider-dsh/tools-http.js';
// 【方案 A · AC-8】能力报告的宿主面读数是快照 ⇒ 延迟装配后就地刷新（纯函数，独立可测）
import { refreshFaceReading } from './host-face-reading.js';

export const name = 'dsh-punky-swarm';
// ── `inject` 声明面：**W4 起为空**（J4'-a：引擎插件行 `inject` ∩ 宿主服务名 = ∅）──────────────────
//
// 宿主契约（可核，勿凭记忆）：
//   宿主 `@deepseek-ai/cordis` 4.0.5 的 `inject` **归一化为 name→config 映射、逐名 required，没有 optional 位**
//   （契约在 `Inject.resolve()` 把数组/对象统一成同名映射 + `Fiber` 构造时对每个键调 `_checkImpl(name)`）。
//   因此**只要 inject 里有一个宿主服务，该服务缺失时就没有「可选」写法可用**。
//
// W4 前的形态与本批处置：
//   · 旧形态把 `tools` / `webServer` / `subagents` 三键全部声明为硬依赖 ⇒ 任一服务缺失时
//     **本插件整块 fiber 置 pending**（`apply` 根本不执行；治理工具面全不出现、`/api/*` 全 404）。
//   · W4 把三键**移出** inject：宿主名改由 provider 行声明（`cordis.patch.yml` 的
//     `dsh-punky-swarm-provider-dsh` 行），引擎侧一律经**端口读数**取得功能。
//   · ⇒ 旧注释里「两处服务缺失守卫**不可达**」的前提**已消失**：清空 inject 后 fiber 恒就绪，
//     `apply` 一定会执行，那两处守卫（现已改为**功能面读数**）**变得可达且有意义**。
//   · ⇒ 旧注释里「若将来真要降级必须把对应键移出 inject」的**条件已满足**（本批即该动作），
//     其「须先在最小 host profile 夹具下取得红→绿读数再动」的要求**已按纪律执行**：见
//     `exec/inject-teardown.md` 的宿主级 RED→GREEN 两段读数。
//
// 兼容形态（既有冻结面要求）：声明行必须是 `export const inject = <单一标识符>;`，
//   禁手写数组字面量 ⇒ 这里引用 `ENGINE_INJECTIONS`（= `[]`，定义点见 `lib/capabilities.js`）。
export const inject = ENGINE_INJECTIONS;
// 恢复语义：每个进程只执行一次（无论插件按进程级还是会话级挂载）
let recoveredThisProcess = false;

const mountStartupPrelude = ({ ctx, config, root }) => {
  // 审计日志挂载（唯一挂载点，代码内挂载：cordis loader 行 schema 无 logger 装配位）——
  // 必须在下方 validateCapabilities warn / GATE_ENABLED warn / syncAssets 三条 warn 之前，
  // 否则「配置非法 / 门禁逃生阀 / 资产清单不可用」这些启动期审计信号永久缺席；挂载失败不炸宿主。
  // 关闭态（PUNKY_AUDITLOG=off 或 capabilities.auditlog.enabled:false）→ 零目录零 exporter。
  let auditMount = null;
  try {
    auditMount = mountAuditLog(ctx, { root, config });
    if (auditMount.mounted) {
      ctx.logger?.info?.('[dsh-punky-swarm] audit log sink mounted: ' + auditMount.sinkDir + '\\' + auditMount.filename);
    }
  } catch (e) {
    ctx.logger?.warn?.('[dsh-punky-swarm] auditlog mount failed: ' + String(e)); // 挂载失败不炸宿主
  }

  // 配置校验兜底：仅 warn 不炸宿主——validateCapabilities 仅对显式
  // enabled 的非法组合报错；禁用能力零校验零 warn；空/缺省 config → errors=[] → 零 warn
  for (const err of validateCapabilities(config).errors) {
    ctx.logger?.warn?.('[dsh-punky-swarm] config: ' + err);
  }
  // 【W4 · D-3/D-4】把审计挂载结果**交回装配根**：内核端口 `audit` 的在位事实由它派生
  //   （`mounted:true` 或**策略性关闭** `reason:'disabled'` 都算「已交代」；只有 `no-logger` 等真装配缺陷才算缺）。
  return auditMount;
};
const createEngineStore = ({ ctx, config, root }) => {
  // topic 发布钩子容器：store 状态事件 → topic 运行时（装配点写入 emit；默认关零路径）
  const topicSink = { emit: null };
  const store = createStore(root, {
    rules: loadRules(config),
    // topic 发布钩子（store 状态事件 → topic 运行时）：topic 默认关 → emit=null → 零行为变化；
    // enabled 时装配点注入 emitTopic 发布（setMember/setPhase 调用点埋点，appendEvent 闭包不可外部 wrap）
    onStateChange: (ev) => { try { topicSink.emit?.(ev); } catch { /* 隔离：topic 发布失败不阻断状态机 */ } },
  });
  return { store, topicSink };
};
const installStartupRecovery = ({ ctx, config, store, root }) => {
  let sweepTimer = null;
  // 存量迁移：root/batches/*.json -> sessions/legacy/batches/（仅一次，幂等）
  if (!recoveredThisProcess) {
    try {
      const moved = store.migrateLegacy();
      if (moved) ctx.logger?.info?.('[dsh-punky-swarm] migrated ' + moved + ' legacy batch(es) to sessions/legacy');
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] legacy migration failed: ' + String(e));
    }
    // 资产同步：预设（~/.dsh/.agent-presets/punky-preset）与技能（~/.agents/skills/software-team），幂等，参照 dsh-liangshen
    //
    // 【冷启动瘦身 · 方案 A】`syncAssets()` **移出 apply() 同步段**：改由 apply 返回后的首个 tick（setImmediate）执行。
    //   实测依据（`scripts/probe-boot-cost.mjs --assets=inline|deferred`，读数与命令原文见 `exec/coldstart-session/notice.md`）：
    //   S7（syncAssets）是本段第二大单项（冷态读数见 notice §改动前归因）。
    //   ⚠ **口径变更**（与下方 mailbox sweep 的 B-1 同源）：改造后 `engine root` 与 `asset synced` / `asset sync failed`
    //   **跨 tick** ⇒ 不得再用这两类日志之差当「apply 同步耗时」（会低估）；同步耗时以探针读数为准。
    //   语义不变：启动后**仍完整执行一次**资产同步（成功/失败日志一条不增一条不减，AC-6）；`syncDir` 幂等，
    //     已 `current` 的状态零写盘。`lib/assets.js` **一行未改**（本改动只挪调用点，AC-5）。
    //   已知代价（显式登记，非静默降级）：进程若在首个 tick 前被 dispose/退出，则**本次同步取消** ——
    //     必须落一条 warn（下方 disposer 内）；可接受：资产是**供给性**（非事务性）且幂等，下次启动补同步；
    //     原同步实现同样不保证「同步完才退出」（进程可在 cpSync 中途被杀）。
    //   条件先判后调度（C-1）：`if (!recoveredThisProcess)` 在本同步段求值，回调内**不得**再判
    //     （紧随的第二个同名块会把该位置 true ⇒ 搬进回调就恒假 ⇒ 静默永不同步）。
    //   作用域外撤（C-2）：句柄 + 回调首行清句柄 + `ctx.effect` 取消，与 `mailbox sweep on start (deferred)` 逐字同形。
    let assetSyncHandle = null;
    const syncAssetsOnce = () => {
      assetSyncHandle = null;
      try {
        const { results, manifest } = syncAssets()
        for (const r of results) {
          if (r.status === 'synced') ctx.logger?.info?.('[dsh-punky-swarm] asset synced: ' + r.asset);
          else if (r.status === 'failed') ctx.logger?.warn?.('[dsh-punky-swarm] asset sync failed: ' + r.asset + ': ' + r.error);
        }
        if (manifest !== 'ok') {
          ctx.logger?.warn?.('[dsh-punky-swarm] asset manifest 不可用（' + manifest + '），已回退内置默认资产表；用户机实装面可能与包内清单声明不一致')
        }
      } catch (e) {
        ctx.logger?.warn?.('[dsh-punky-swarm] asset sync failed: ' + String(e));
      }
    };
    assetSyncHandle = setImmediate(syncAssetsOnce);
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (assetSyncHandle) {
          clearImmediate(assetSyncHandle);
          assetSyncHandle = null;
          // 取消**不得静默**（AC-4①）：tick 之前被撤 ⇒ 本次未同步，必须可观测。
          ctx.logger?.warn?.('[dsh-punky-swarm] asset sync skipped: deferred task cancelled before first tick（本次未同步；下次启动补同步）');
        }
      }, 'dsh-punky-swarm: asset sync (deferred)');
    }
  }

  // 启动恢复：in-flight 成员 -> idle + system.recovered（每个进程仅一次，跨全部 session）
  // 接线：改调 resume.recoverBatches(store, { restoreRunning: resumeCfg.enabled })——
  //   config.resume.enabled 缺省关 → 内部委托 store.recoverBatches()（原路径零行为变化）；
  //   开启 → restoreBatches()（running/review 原地保留 + system.restored 事件）。返回数组形态
  //   .length/.corrupt 兼容既有日志消费。
  if (!recoveredThisProcess) {
    recoveredThisProcess = true;
    try {
      const resumeCfg = resolveResumeConfig(config);
      const r = resumeRecoverBatches(store, { restoreRunning: resumeCfg.enabled });
      if (r.length) ctx.logger?.info?.('[dsh-punky-swarm] recovered batches: ' + r.join(', '));
      // 恢复容错汇总：损坏批次被隔离（corrupt-batches.json + 跳过），不阻断其余恢复
      if (Array.isArray(r.corrupt) && r.corrupt.length) {
        ctx.logger?.warn?.('[dsh-punky-swarm] isolated ' + r.corrupt.length + ' corrupt batch(es): ' + r.corrupt.join(', ') + '（人工修复/删除后 clearCorruptMark）');
      }
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] recovery failed: ' + String(e));
    }

    // mailbox 启动清扫（sweepOnStart 默认 true）：recoverBatches 之后逐批次 mailbox 根 sweep 一次——
    // 清 ack 超 TTL 消息+标记 / 损坏消息 quarantine / 孤儿 .acked（默认 TTL 7d、quarantine 30d）。
    // 失败仅 warn 不阻塞启动；幂等可重入（sweep 无状态全量扫描）。
    const mailCfg = config?.mailbox ?? {};
    const sweepAllMailboxes = () => {
      const agg = { scanned: 0, removed: 0, quarantined: 0, failed: 0 };
      const mbBase = join(root, 'sessions');
      if (fs.existsSync(mbBase)) {
        for (const sid of fs.readdirSync(mbBase)) {
          const mbRoot = join(mbBase, sid, 'mailbox');
          if (!fs.existsSync(mbRoot)) continue;
          for (const bid of fs.readdirSync(mbRoot)) {
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
      // 【B-1 · boot-slim】启动清扫**移出 apply() 同步段**：改由 apply 返回后的首个 tick（setImmediate）执行。
      //   实测依据（`scripts/probe-boot-cost.mjs`，读数与命令原文见 `exec/boot-slim/notice.md`）：
      //   本段在「`engine root` → `mailbox sweep on start`」桶内占 **72.88%**（成对实验中载）/ 冷态首访 **64.86%** / 热态 **53.4–74.4%**，
      //   是该桶最大单项；移出后 apply 同步耗时实测下降 **73.73%**（中载 2674.853 → 702.628ms）
      //   / **53.4%**（轻载 971.173 → 452.4ms），两档均满足 AC-2 的 ≥50%。
      //   ⚠ 口径变更：改造后 `engine root` 与 `mailbox sweep on start` **跨 tick** ⇒ 不得再用这两条日志之差
      //   当「apply 同步耗时」（会低估）；同步耗时以 `exec/boot-slim/notice.md` 的探针读数为准。
      //   **实现零改动**：`sweepAllMailboxes` 仍是同步全量扫（见上方同名定义），本改动只挪调用点。
      //   语义不变：启动后仍全量清扫一次，幂等可重入（sweep 无状态）；日志与四计数口径逐字保留（AC-3/AC-5）。
      //   已知代价（显式登记，非静默降级）：进程若在首个 tick 前退出，则本次清扫丢失 ——
      //   可接受：sweep 幂等，下次启动补扫；且原同步实现同样不保证「扫完才退出」。
      //   作用域外撤：插件在 tick 之前被 dispose 时取消，避免 dispose 后仍写 mailbox 目录。
      let sweepOnStartHandle = null;
      const sweepOnce = () => {
        sweepOnStartHandle = null;
        try {
          const agg = sweepAllMailboxes();
          if (agg.scanned || agg.removed || agg.quarantined || agg.failed) {
            ctx.logger?.info?.('[dsh-punky-swarm] mailbox sweep on start: scanned=' + agg.scanned
              + ' removed=' + agg.removed + ' quarantined=' + agg.quarantined + ' failed=' + agg.failed);
          }
        } catch (e) {
          ctx.logger?.warn?.('[dsh-punky-swarm] mailbox sweep on start failed: ' + String(e));
        }
      };
      sweepOnStartHandle = setImmediate(sweepOnce);
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          if (sweepOnStartHandle) { clearImmediate(sweepOnStartHandle); sweepOnStartHandle = null; }
        }, 'dsh-punky-swarm: mailbox sweep on start (deferred)');
      }
    }
    // 周期 sweep（默认 0=关，零隐式行为）：显式配置 sweepIntervalMs>0 才挂 setInterval（unref + dispose 清理）
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
  return sweepTimer;
};
const installTools = ({ ctx, config, store, root, readConfig, heartbeat, heartbeatRef, dispatchIndex }) => {
  const tools = createTools(ctx, { store, root, config, readConfig, heartbeat, getHeartbeat: () => heartbeatRef.current,
    dispatchIndex, // 【本批 C】工具 deps 面透传同一 Map 引用（lane_dispatch 自派写点用；register.js → member-tools.js）
    // 修复① 兜底：miss ⇒ 扫事件流反查 + 回填同一 dispatchIndex（值经 dispatchIndexEntryOf 单点）
    // 【U-b】真传 logger（只加这一个实参）：不传则 `laneBindingOf` 的两态在该路径仍静默。
    resolveBatchSession: (exec) => batchSessionIdOfWorkerResolved(store, dispatchIndex, exec, ctx?.logger) });
  return tools;
};

const installWatchRuntime = ({ ctx, config, store, root }) => {
  // config 贯通：apply 的 config（cordis.patch.yml -> 插件 config）传入 createTools，
  // tools.js guard 经 config?.escalation.execTools 覆盖执行型工具名单（可选，缺省 EXEC_TOOLS）
  // enabled=true 时 register() 生成 catalog（注册面全量 × 6 属性快照），传给 createApi 挂 /tools 端点
  // watch 心跳引擎（lane 过期检测 + longrun 档）：出厂默认开（resolveWatchConfig 缺省 enabled=true）——
  // 仅显式 capabilities.watch.enabled:false 时引擎不创建、watchdog 定时器不挂（零运行时开销）。
  // 引擎引用 holder（heartbeatRef）：热重建（applyConfigChange 生效变化
  // 通道 / boot 对账）后，watchdog timer 回调与 lane_heartbeat/lane_longrun 工具（均已于 G3/B1 删除）经 heartbeatRef.current
  // 执行时解引用、自动跟随新实例（修复「工具闭包绑创建时旧引擎 → 热重建后静默失效」缺陷）。
  const watchCfg = resolveWatchConfig(config);
  const longrunCfg = resolveLongrunConfig(config); // longrun 档独立解析于 lane-heartbeat.js
  const heartbeatRef = { current: null };
  let heartbeat = null;
  if (watchCfg.enabled) {
    heartbeat = createLaneHeartbeat({ store, mailbox, config, root, liveConfig: config, logger: ctx.logger });
    heartbeatRef.current = heartbeat;
  }
  let watchInstalledCfg = {
    enabled: watchCfg.enabled,
    longrun: {
      enabled: longrunCfg.enabled,
      maxDurationMs: longrunCfg.maxDurationMs,
      noProgressWindowMs: longrunCfg.noProgressWindowMs,
      staleBatchMs: longrunCfg.staleBatchMs,
      unconsumedTimeoutMs: longrunCfg.unconsumedTimeoutMs,
    },
    scanIntervalMinutes: watchCfg.scanIntervalMinutes,
  };
  return { watchCfg, longrunCfg, heartbeatRef, heartbeat, watchInstalledCfg };
};
const installWatchdog = ({ ctx, watchCfg, heartbeatRef, heartbeat }) => {
  let watchTimer = null;
  if (watchCfg.enabled && heartbeat) {
    const scanMs = Math.max(1000, Math.round(watchCfg.scanIntervalMinutes * 60_000));
    watchTimer = setInterval(() => {
      try { heartbeatRef.current?.tick(); } catch (e) { ctx.logger?.warn?.('[dsh-punky-swarm] heartbeat tick failed: ' + String(e)); }
    }, scanMs);
    if (typeof watchTimer.unref === 'function') watchTimer.unref();
    if (ctx.effect) {
      ctx.effect(() => () => { clearInterval(watchTimer); watchTimer = null; heartbeat?.dispose(); }, 'dsh-punky-swarm: watch heartbeat');
    }
    ctx.logger?.info?.('[dsh-punky-swarm] watch capability enabled: lane heartbeat watchdog mounted (scan ' + scanMs + 'ms)');
  }
  return watchTimer;
};
// ── HTTP 面装配（方案 A · 延迟绑定）─────────────────────────────────────────────────────
// 【历史缺陷（实测，非推断）】原 `installWebSurface` 在 apply 同步段一次性判定
//   `createHttpPort(ctx).available`。桌面宿主里 `webServer` **晚于**本插件装配约 10.6s 就绪
//   （成功那次 boot：`governance tool face mounted` 00:42:32.184 → `dsh web: http://127.0.0.1:59312/`
//   00:42:42.843）⇒ 该判定恒 false ⇒ `/api`、`/discover` 静默全缺席；`/mcp` 因跳过点在
//   `lib/mcp/data-plane-server.js:263-269` 也同样恒早退（boot 日志 `[mcp] data plane mounted` 0 次）。
// 【现形态（用户裁决 = 方案 A）】**不改** `cordis.patch.yml` 的 inject（宿主 cordis 的 inject 无
//   optional 位 ⇒ 硬注入会让 headless 宿主整块 pending），改为监听宿主 `internal/service` 服务注册
//   事件：`webServer` 就绪后再装配、消失即释放。契约依据（宿主 cordis `lib/index.js` 4.x）：
//     · 事件名 `internal/service`；监听器实收 `(name, value)`（`dispatch` 先 shift 掉 self 与事件名）；
//     · 「服务消失」= 注销路径**先 delete 再 notify** ⇒ `value === undefined`；
//     · **事件发射段与 inject 无关**（只有 inject-refresh 段看 inject）⇒ 监听该事件不需要 inject 声明；
//     · `Fiber._updateState` 在 fiber 进出 ready 时对本 fiber 已 provide 的服务补发 notify ⇒ 不漏通知。
//   仍保留「注册监听后立即主动探测一次」作双保险（覆盖「监听注册晚于服务提供」的次序竞态）。
//
// 拆分（R-1/R-2）：`createHttpSurface` = 纯装配工厂；`bindHttpSurfaceDeferred` = **唯一**延迟入口。
//   `createHttpSurface` 的前置契约 = 调用方已确认 `createHttpPort(ctx).available === true`
//   （可装配性判定只允许出现在延迟入口一处，否则就是「第二套分支」）。
const createHttpSurface = ({ ctx, config, store, root, tools, getWatchInstalledCfg, getGovernanceInstalledCfg, getPresetCatalog }) => {
  let apiDispose = null;
  let panelStream = null;
  // 发现服务（ADP）：capabilities.discovery.enabled（默认开）时装配——
    // 消费 tool-descriptor catalog（tools.catalog，aip.enabled 时非空）+ agent-descriptor 目录（DEFAULT_ASSEMBLY 派生）
    const discoveryCfg = resolveDiscoveryConfig(config);
    let discovery = null;
    if (discoveryCfg.enabled) {
      // 【⑧-3 · 2026-11-08 裁决甲】agent 目录**单一构造点** = `tools.agentCatalog`（`tools/register.js:63`
      //   用 `resolveAssembly(aip.team ?? 'punky-preset', config.assembly)` + 9 个 engineInfo 键构建）。
      //   此前这里**另建一次** `buildAgentDescriptors(DEFAULT_ASSEMBLY, {version})` ⇒ 配置了
      //   `aip.team` / `config.assembly` 时 `/agents` 与 `/discover` 会报**不同团队/不同席位集**。
      //   回落分支只在 `aip.enabled=false`（目录不构建）时生效：保持既有降级语义（有席位、无工具）。
      const agentDescriptors = tools.agentCatalog
        ? tools.agentCatalog.list()
        : buildAgentDescriptors(DEFAULT_ASSEMBLY, { version: engineVersion() });
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

    // SSE hub 装配层创建注入——先建 hub 再传 deps.panelStream，
    //   dispose 归属本层（api.js 自建者 dispose；注入时 api.js 不 push disposer）。
    //   hub 随 webServer 挂载（无独立配置键）；topic.enabled 时经 attachTopic('swarm.') 接线触发源
    panelStream = createStreamHub({ root, logger: ctx.logger });
    // WebUI 治理配置写通道：configEndpoints 注入面——
    //   runtimeConfig = <root>/config/runtime.json 写通道服务实例；trustedHosts 出厂 []（loopback-only，
    //   非 loopback 部署需把宿主 trustedHosts 镜像进插件 config.trustedHosts——文档化运维要求）；
    //   applied/presets = 延迟 getter：governanceInstalledCfg/presetCatalog 在本函数体后段（preset 装载
    //   之后）才初始化——getter 只在 HTTP 请求时求值，彼时已绑定，无 TDZ。
    apiDispose = createApi(ctx, {
      store, root, catalog: tools.catalog, agentCatalog: tools.agentCatalog, aipFormat: tools.aipFormat,
      discovery, acpsDiscovery: acpsDiscoveryClient, panelStream,
      configEndpoints: {
        runtimeConfig: createRuntimeConfigService({ root, logger: ctx.logger }),
        trustedHosts: Array.isArray(config?.trustedHosts) ? config.trustedHosts : [],
        applied: () => getGovernanceInstalledCfg(),
        // watch 生效快照 getter：watchInstalledCfg 初始化于上方 watch 引擎装配
        //   （早于本 createApi 调用）——惰性 getter 与 applied 同法，HTTP 请求时求值无 TDZ。
        //   生效快照随比较集扩展自动携带 longrun 阈值（maxDurationMs/noProgressWindowMs）
        //   → GET /config applied.watch 即面板回显与 watchSig 确认轮询的完整数据源（无需装配侧再加工）
        appliedWatch: () => getWatchInstalledCfg(),
        presets: () => getPresetCatalog(),
      },
    }).dispose;

    // SSE hub 装配层创建注入（上方 createStreamHub + deps.panelStream），
    //   topic.enabled 时经 attachTopic('swarm.') 订阅低延迟触发源（下方 topic 运行时装配分支与热更新通道对称接线）；
    //   topic 关闭时 hub 仍装配（fs.watch 与心跳通道不变），attachTopic 零调用零路径。
  return { apiDispose, panelStream };
};

// ── 延迟绑定入口（唯一）──────────────────────────────────────────────────────────────────
// 职责：宿主 `internal/service` 事件驱动「装配 / 释放」两态，并以 apply 末尾的一次主动探测兜住
//   「监听注册晚于服务提供」的次序竞态（双保险之一）。
// 持有面（D1 单一持有）：`/api`（含 `/discover`、`/.well-known/aip`）、SSE hub、`/mcp` 三者的
//   路由 disposer **只**由本工厂的聚合释放持有；`createTools` 里那次早退的 no-op disposer 不算持有者。
// 幂等（D4）：`mounted !== null` 单点表达「已装配」——**不新增 rt 字段**（rt 字段集已被
//   `test/w7f-rt-write-surface.test.js` 冻结，新增字段会破坏该冻结面）。
const bindHttpSurfaceDeferred = ({
  ctx, config, store, root, tools, rt,
  getWatchInstalledCfg, getGovernanceInstalledCfg, getPresetCatalog,
  mcpPlaneOf, syncConsumers,
}) => {
  // 已装配面（非空 = 已装配；唯一持有者是 `mounted.dispose` —— 一次性聚合释放器）
  let mounted = null;
  // 首轮：若 `createTools` 那次尝试**已真装上**（宿主先起 webServer 后加载插件，如热重载），
  //   则本路径不再挂第二个 ⇒ 禁双挂。释放过一轮后置 false：旧 disposer 指向的 webServer 实例已消失。
  let adoptEarlyMcp = true;
  const surfaceDeps = { ctx, config, store, root, tools, getWatchInstalledCfg, getGovernanceInstalledCfg, getPresetCatalog };

  /** 释放面：一次性聚合释放（逆序 `/api` → SSE hub → `/mcp`）+ 清 rt 读位。幂等（`mounted` 置空后零操作）。 */
  const release = (reason) => {
    if (!mounted) return false;
    const aggregate = mounted.dispose;
    mounted = null;
    // D1 单一持有：三条路由面的 disposer 全部由这一个聚合函数持有，本处是它的**唯一**调用点之一
    //   （另一处 = `rt.apiDispose`，它指向同一个聚合函数，自带一次性守卫 ⇒ 不会重复摘路由）。
    aggregate();
    // rt 读位回落到「未装配」态：否则热更 topic 通道会往**已释放**的 hub 上接线（attachTopic 在
    //   disposed hub 上返回 no-op ⇒ topicAttachUn 被一个空函数占位 ⇒ 重挂后静默丢线）。
    if (rt.topicAttachUn) { try { rt.topicAttachUn(); } catch { /* 已随 hub 释放 */ } rt.topicAttachUn = null; }
    rt.panelStream = null;
    // 旧 webServer 实例已消失 ⇒ 早装 disposer 指向的路由面不再有效，下一轮必须自己挂
    adoptEarlyMcp = false;
    syncConsumers?.();
    if (reason !== 'plugin unload') ctx.logger?.info?.('[dsh-punky-swarm] http surface released: ' + reason);
    return true;
  };

  /** 装配面（幂等）：`mounted` 已非空即 no-op。 */
  const mount = (reason) => {
    if (mounted) {
      ctx.logger?.debug?.('[dsh-punky-swarm] http surface mounted already（跳过重复装配，trigger=' + reason + '）');
      return false;
    }
    if (!createHttpPort(ctx).available) {
      ctx.logger?.warn?.('[dsh-punky-swarm] http surface: webServer 在读时刻不可用（保持延迟态，trigger=' + reason + '）');
      return false;
    }
    // ① `/mcp` 重试挂载：早退的 no-op disposer（`installed === false`）不构成持有者 ⇒ 这里拿到的才是
    //    唯一持有者。判据用既有 `installed` 标志（`data-plane-server.js:266/277`），不新造标记。
    let mcpRouteDispose = null;
    const early = typeof mcpPlaneOf === 'function' ? mcpPlaneOf() : null;
    const earlyInstalled = Boolean(early) && early.installed === true;
    if (!(adoptEarlyMcp && earlyInstalled)) {
      const dispose = installMcpDataPlane(ctx, { logger: ctx.logger });
      if (dispose && dispose.installed === true) mcpRouteDispose = dispose;
      else ctx.logger?.warn?.('[dsh-punky-swarm] http surface: /mcp 重试挂载未成功（注册被拒 ⇒ installed=false，保持未挂载）');
    }
    // ② `/api`（含 `/discover`、`/.well-known/aip`）＋ ③ SSE hub
    const surface = createHttpSurface(surfaceDeps);
    // 聚合释放器：一次性守卫，逆序释放。它同时是 `rt.apiDispose` 的持有者 ——
    //   `releaseAll` 在插件卸载时还会再调一次 `rt.apiDispose?.()`，一次性守卫保证**不会重复摘路由**。
    let spent = false;
    const dispose = () => {
      if (spent) return;
      spent = true;
      try { surface?.apiDispose?.(); } catch (e) { ctx.logger?.warn?.('[dsh-punky-swarm] http surface: /api dispose failed: ' + String(e?.message ?? e)); }
      try { surface?.panelStream?.dispose(); } catch (e) { ctx.logger?.warn?.('[dsh-punky-swarm] http surface: stream hub dispose failed: ' + String(e?.message ?? e)); }
      try { mcpRouteDispose?.(); } catch (e) { ctx.logger?.warn?.('[dsh-punky-swarm] http surface: /mcp dispose failed: ' + String(e?.message ?? e)); }
    };
    mounted = { dispose };
    rt.apiDispose = dispose;
    rt.panelStream = surface.panelStream;
    // ④ 装配后补接线：topic 接线（AC-7）与能力读数刷新（AC-8）只能在此刻求值（`rt` 读位刚回填）
    try { syncConsumers?.(); } catch (e) { ctx.logger?.warn?.('[dsh-punky-swarm] http surface: post-mount wiring failed: ' + String(e?.message ?? e)); }
    return true;
  };

  // 双保险之二：监听宿主服务注册事件（**不需要** inject 声明，依据见上方契约注）。
  let unsubscribe = () => {};
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('internal/service', (serviceName, value) => {
        if (serviceName !== 'webServer') return;
        // 「服务消失」= 注销路径先 delete 再 notify ⇒ value 取不到（undefined）
        if (value === undefined) { release('webServer gone'); return; }
        mount('internal/service');
      });
      if (typeof off === 'function') unsubscribe = off;
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] http surface: internal/service 订阅失败（降级为仅主动探测）：' + String(e?.message ?? e));
    }
  }

  // 双保险之一：注册监听后**立即主动探测一次**
  if (createHttpPort(ctx).available) mount('probe');
  else ctx.logger?.info?.('[dsh-punky-swarm] http surface deferred: webServer unavailable in this host');

  return {
    mount,
    release,
    /** 插件卸载：释放已装配的面并退订（幂等）。 */
    close() {
      release('plugin unload');
      try { unsubscribe(); } catch { /* 已随 fiber 退订 */ }
    },
  };
};
const installTrajectoryBridge = ({ ctx, config, store, dispatchIndex = null }) => {
  // 诊断桥接（trajectory）：订阅 trajectory 异常 → sessionId→lane 映射 → notify（默认 notify-only）。
  // trajectory 出厂默认开（isTrajectoryEnabled 经 readCapability 合并注册表 default enabled:true）——仅显式 capabilities.trajectory.enabled:false 时桥接不创建不挂载（零运行时开销，行为与既有版本一致）
  // 生命周期：start() 挂订阅/轮询；stop() 退订/清定时器（经 apply 返回的 dispose 释放，进程重启后桥接随插件重建、映射从批次事件幂等恢复）
  // 【S-1】把装配期已建好的 `dispatchIndex` 传下去 ⇒ 轨迹重建**不再自扫**（启动期 2N→N）。
  //   传 null 时轨迹桥回落自扫（行为与改前一致，向后兼容）。
  let trajectory = isTrajectoryEnabled(config) ? createTrajectoryBridge(ctx, { store, config, mailbox, dispatchIndex }) : null;
  if (trajectory) {
    const st = trajectory.start();
    if (st.subscribed) {
      ctx.logger?.info?.('[dsh-punky-swarm] trajectory bridge subscribed (autoFail=' + (config?.capabilities?.trajectory?.autoFail === true) + ')');
    }
  }
  return trajectory;
};

const installTopicRuntime = ({ ctx, config, root, topicSink, panelStream, topicAttachUn }) => {
  // topic 运行时装配（默认关——readCapability 缺省合并 {enabled:false}；显式 capabilities.topic.enabled:true 开启）：
  // enabled 时创建运行时（start/stop 与 trajectory 桥同形）+ 接线状态事件发布（store.setMember/setPhase 调用点埋点）；
  // 关闭时零挂载零路径（与 acps/bridge config 短路同构）。trajectory 桥 broadcast 直走不变，topic.enabled 时仅镜像（并存不替换）。
  // 热更新（config.changed）可实时启停本运行时（见下方 applyConfigChange）。
  let topicRuntime = null;
  if (readCapability(config, 'topic')?.enabled) {
    topicRuntime = createTopicRuntime(ctx, { root, logger: ctx.logger });
    topicRuntime.start();
    topicSink.emit = (ev) => { try { topicRuntime.publishStateChange(ev); } catch { /* 隔离 */ } };
    // hub 触发源接线（attachTopic('swarm.')，幂等——已接线不重复订阅）——
    // 订阅后 store.setMember/setPhase 状态事件（swarm.member.settled / swarm.batch.phase）经 hub 路由推送 SSE
    if (panelStream && !topicAttachUn) topicAttachUn = panelStream.attachTopic('swarm.');
    ctx.logger?.info?.('[dsh-punky-swarm] topic capability enabled: topic runtime started (swarm.<type>.<sid>.<bid>)');
  }
  return { topicRuntime, topicAttachUn };
};
const mountAcpsBridge = ({ ctx, config, root }) => {
  // 内部 ACPs 桥接（config.acps.bridge，默认关）：enabled=false 时 mountBridge 短路返回 null——
  // 不实例化、零运行时路径（config 短路）；outbound=mailbox→ACPs 投影/投递，inbound 默认关：
  // 外部写 mailbox 需显式 acps.bridge.inbound=true。/rpc 监听与对外投递由 endpoint 侧承担。
  const bridge = mountBridge(config, { root, mailbox, logger: ctx.logger });
  if (bridge) {
    ctx.logger?.info?.('[dsh-punky-swarm] acps.bridge enabled: in-process bridge mounted (inbound='
      + (config?.acps?.bridge?.inbound === true) + ')');
  }
  return bridge;
};
const installRegistryClient = ({ ctx, config }) => {
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
  return registryClient;
};
const installAcpsEndpoint = ({ ctx, config, root, bridge }) => {
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
      //  /rpc 回 TaskResult rejected 不落 mailbox）。
      // 【ACPS-04】bridge 未装配时不再无条件回 accepted：声明了 acps.bridge.inbound=true ⇒ 显式
      //   rejected INBOUND_UNAVAILABLE + 一次 warn；未声明 ⇒ 保持既有「独立 accepted」向后兼容（逐字不变）。
      // 选择逻辑单一实现 = acps-bridge.js#selectRpcHandler（本处只做调用，禁第二套分支）。
      const rpcHandler = selectRpcHandler({
        bridge,
        inboundRequested: resolveBridgeConfig(config).inbound,
        logger: ctx.logger,
      });
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
  return acpsEndpoint;
};
const createRefusalEventBridge = ({ ctx, root, store, dispatchIndex, rebuildIndex, getGovernanceInstalledCfg }) => {
  // 工具调用级护栏（governance hook）：governance.hook.enabled 缺省 true——
  // 订阅宿主 tools/pre-execute + tools/post-execute；rules 空表=零拦截（decide 恒 ALLOW，行为不变）。
  // 双层桥接：注入 onRefusal → 收据落盘时写批级事件流
  //   <root>/governance/events/refusal-<sessionId>.jsonl（governance.refusal.recorded；仅事件可见性，
  //   不触发批级状态迁移）。回调抛错由 wiring 观察者纪律隔离（warn 不阻断）。
  // governance 键已纳入热更新白名单（config-watch.js ALLOWED_TOP_KEYS）——
  //   governance.hook 任一子键生效变化（enabled 翻转 / rules / flags / defaults / escalation）经 applyConfigChange
  //   dispose + 重挂即时生效（对齐 verifyMount 模式；重挂后 refusals count 归零、pendingAsks 清空——
  //   运行时状态重置契约，交互处置详见 remountGovernanceHook 注释）。
  // 违规升级桥接扩展（escalation.enabled=true 时）：收据经「会话→批次归属」映射
  //   （member.dispatch 事件重建，读侧索引 dispatchIndex）命中后 → store.recordGovernanceRefusal（升级链
  //   在 store 方法内闭环：记录/评估/棘轮升级单次原子写）；映射缺失/'cli'/未命中 → 静默降级
  //   （仅 jsonl 可见、批事件流零新增、零升级——不误暂停）。
  //   宿主派发流（member_set_status → subagent spawn）无 batchId/lane 结构化字段，归属登记点（写侧）
  //   由装配观察登记（见 bridge/dispatch-register.js）；读侧索引缺登记时恒空 → 出厂 enabled=false
  //   零路径 + 即使开启也静默降级（安全侧：漏计不误暂停）。读侧索引经 rebuildDispatchIndex 幂等重建，
  //   登记点落地（写 member.dispatch）后无需改动即可生效。
  // 装配层桥接回调（remount 复用：旧实例 dispose 断开回调后，新实例重新注入——桥接随动不断链）
  const refusalEventBridge = (receipt) => {
    try {
      appendRefusalEvent(root, receipt?.sessionId ?? 'cli', receipt); // jsonl 事件可见性
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] governance refusal event bridge failed (isolated): ' + String(e?.message ?? e));
    }
    // 违规升级链（观察者纪律：任一失败仅 warn，不阻断 deny 裁决）
    try {
      const esc = getGovernanceInstalledCfg()?.escalation; // 热更感知：remount 后 governanceInstalledCfg 已更新
      if (esc?.enabled !== true) return;              // T20：enabled=false 零路径（出厂默认）
      const sessionId = receipt?.sessionId ?? 'cli';
      if (sessionId === 'cli') return;                // cli 未归属不计数
      let hit = dispatchIndex.get(sessionId);         // 归属映射（member.dispatch 重建）
      if (!hit) {
        // miss 惰性重建：运行中登记点（写 member.dispatch）落地后，下一 refusal 即可命中（无需重启/热更）；
        // 重建幂等（镜像 trajectory rebuildFromEvents）；refusal 为低频事件，全扫成本可接受
        rebuildIndex();
        hit = dispatchIndex.get(sessionId);
      }
      if (!hit) return;                               // 映射缺失 → 仅 jsonl、零批事件、零升级
      store.recordGovernanceRefusal(hit.sessionId, hit.batchId, {
        lane: hit.lane,
        receiptId: receipt?.receiptId,
        primitive: receipt?.decision?.primitive,
        ruleRefs: receipt?.ruleRefs,
        tool: receipt?.tool,
        escalation: { enabled: true, threshold: esc.threshold, windowMs: esc.windowMs, primitives: esc.primitives },
      });
    } catch (e) {
      ctx.logger?.warn?.('[dsh-punky-swarm] governance escalation bridge failed (isolated): ' + String(e?.message ?? e));
    }
  };
  return refusalEventBridge;
};
const createDispatchIndexRebuilder = ({ store, dispatchIndex }) => {
  // 归属读侧索引（读侧骨架先行）：
  //   workerSessionId → { sessionId, batchId, lane }——从全部批次事件 member.dispatch 幂等重建
  //   （镜像 trajectory.js rebuildFromEvents 先例；映射独立于 trajectory 桥实例存在，不依赖桥挂载）。
  //   登记点（写 member.dispatch）落地前索引恒空 → 静默降级（安全侧）。
  const rebuildDispatchIndex = () => {
    dispatchIndex.clear();
    let n = 0;
    for (const { sessionId, batchId } of store.listAllBatches()) {
      const batch = store.readBatch(sessionId, batchId);
      if (!batch?.events) continue;
      for (const ev of dispatchRecordsOf(batch.events)) {
        dispatchIndex.set(ev.workerSessionId, dispatchIndexEntryOf(sessionId, batchId, ev.lane, ownerSessionIdOf(ev)));
        n++;
      }
    }
    return n;
  };
  return rebuildDispatchIndex;
};

const mountDispatchRegistration = ({ ctx, config, store, dispatchIndex }) => {
  let dispatchReg = installDispatchRegistration(ctx, {
    store,
    dispatchIndex, // 与读侧共享同一 Map（幂等守卫 + 即时生效）
    config,
    // 装配注入面：config.dispatch.resolveBatchContext 显式提供归属（宿主/编排层可注入函数；
    //   缺省 undefined → 模块内 member_set_status(running) 意图兜底）。config 经 cordis 装配可携带函数（仅 JS 侧），
    //   yml 静态块不适用时走兜底意图——两路共存，静默降级语义保持。
    resolveBatchContext: config?.dispatch?.resolveBatchContext,
    logger: ctx.logger,
  });
  if (dispatchReg.installed) {
    ctx.logger?.info?.('[dsh-punky-swarm] dispatch registration mounted: tools/post-execute 观察派发工具 → member.dispatch 登记（零宿主改造）');
  }
  return dispatchReg;
};
const installAutoSettleMainPath = ({ ctx, config, store, dispatchIndex, root }) => {
  let autoSettle = installAutoSettle(ctx, {
    store,
    dispatchIndex, // 与读侧骨架 / 登记点共享同一 Map（登记后无需重启即命中）
    root,
    liveConfig: config, // 与 `member_settle` 链推进同源（`apply` 的 config；热更经 readLiveConfig 在工具面）
    enabled: autoSettleSwitchOf(config),
    logger: ctx.logger,
  });
  if (autoSettle.installed) {
    ctx.logger?.info?.('[dsh-punky-swarm] auto-settle mounted: 宿主 subagent/end（global:true）→ 引擎自动结算判定（复用 Tier3 校验链；缺省 onFail=pause 停轮）');
  }
  return autoSettle;
};
  // 热更「生效变化」基线（约束 11：以**严格布尔解析后的值**比对 ⇒ `undefined` 与 `true` 同值，
  //   不触发无意义重挂）。【A1-P2-07】判定式已收成**单点** `schema.js#autoSettleEnabledOf`（本批显式覆盖
  //   原「刻意不导出 ⇒ 本地同形镜像」的 L-AC-14 局部约束：三处镜像即第二套开关口径，属双真源）。
  //   此处**只保留读源差异**（装配期读静态 `config`），判定式一律委托单点 ⇒ 本文件不再持有判定式副本。
  const autoSettleEnabledOfConfig = (cfg) => autoSettleEnabledOf(autoSettleSwitchOf(cfg));
const installLaneWakePath = ({ ctx, store, dispatchIndex, autoSettleEnabled }) => {
  let laneWake = null;
  const wakeQueue = createWakeQueue();
  /** 唤醒路的**单次动作**：全程 try/catch 且不抛（观察者纪律，与结算主路同款）。 */
  const onLaneWorkerEnd = async (info) => {
    try {
      if (!info || typeof info !== 'object') return;
      const id = info.id;
      if (typeof id !== 'string' || id.length === 0) return; // 无 durable 子会话 id ⇒ 静默丢弃
      const hit = dispatchIndex instanceof Map ? dispatchIndex.get(id) : null;
      if (!hit || !hit.sessionId || !hit.batchId || !hit.lane) return; // 非本套件派发 ⇒ 静默丢弃
      if (wakeQueue.isSuppressed(hit.lane)) {
        ctx.logger?.debug?.('[dsh-punky-swarm] lane-wake suppressed (self-produced event): ' + hit.lane);
        return;
      }
      wakeQueue.enqueue({ lane: hit.lane, reason: 'lane-worker-end', runId: id });
      if (wakeQueue.drain().length === 0) {
        ctx.logger?.debug?.('[dsh-punky-swarm] lane-wake skipped (wake budget exhausted): ' + hit.lane);
        return;
      }
      // ② 候选（**只读**，D-3 甲）：`poolViewOf` 单点判「deps 已结算 + owner===null + lane pending」。
      let candidates = null;
      try {
        const view = poolViewOf(store.readBatch(hit.sessionId, hit.batchId));
        const ids = (view.pool ?? []).filter((t) => t.dispatchable).map((t) => t.id);
        if (ids.length > 0) candidates = ids;
      } catch { candidates = null; /* 批次不可读 ⇒ 无候选面（不影响唤醒本身） */ }
      const stopReason = typeof info.stopReason === 'string' && info.stopReason.length > 0 ? info.stopReason : null;
      wakeLeaderForReport(ctx, {
        callerSessionId: id, leaderSessionId: wakeAddressOf(hit),
        batchId: hit.batchId, lane: hit.lane, type: stopReason,
        summary: '子代理已结束（主路 subagent/end；stopReason=' + stopReason + '）',
        candidates,
      });
    } catch (e) {
      try { ctx?.logger?.warn?.('[dsh-punky-swarm] lane-wake subagent/end handler failed (isolated): ' + String(e?.message ?? e)); } catch { /* 隔离 */ }
    }
  };
  /** 装配置点（**独立**，条件③）：与 `installAutoSettle` 并列；返回形态同形（`{installed, reason?, count(), dispose()}`）。 */
  const installLaneWake = () => {
    const inert = (reason) => {
      try { ctx?.logger?.warn?.('[dsh-punky-swarm] lane-wake inert: ' + reason); } catch { /* 回显失败不阻断装配 */ }
      return { installed: false, inert: true, reason, count: () => 0, dispose() {} };
    };
    if (!store || typeof ctx?.on !== 'function') return inert('ctx.on unavailable or store missing');
    let hits = 0;
    const handler = (info) => {
      hits += 1;
      // 不 await：宿主对 listener 的 containment 不覆盖异步悬空 ⇒ 自行 catch（onLaneWorkerEnd 内亦已包 try/catch）。
      return onLaneWorkerEnd(info).catch((e) => {
        try { ctx.logger?.warn?.('[dsh-punky-swarm] lane-wake handler rejected (isolated): ' + String(e?.message ?? e)); } catch { /* 隔离 */ }
      });
    };
    // `{ global: true }` **硬性要求**（与结算主路同判据、同纪律）：`'subagent/end'` 在 `dsh-scope` 的 invariant 里
    //   resolver 为 `null`（受 scope 过滤）⇒ 被 scope 化的插件 ctx（preset standing mount）默认漏收；
    //   缺则本路**静默失效**（探针实测先例见 `lib/engine/auto-settle.js` 头注释 §①）。
    const dispose = ctx.on(AUTO_SETTLE_SUBAGENT_END, handler, { global: true });
    return { installed: true, count: () => hits, dispose() { try { if (typeof dispose === 'function') dispose(); } catch { /* 幂等 */ } } };
  };
  // 停用开关（`autoSettle.enabled`）的**生效值**复用上方单点：本路属引擎**主路面** ⇒ 与结算路同生共死；
  //   兼底路（`swarm_report`）唤醒面 = 甲，与开关**无关**、不受影响（D-5 甲的解耦面）。
  if (autoSettleEnabled) laneWake = installLaneWake();
  if (laneWake?.installed) {
    ctx.logger?.info?.('[dsh-punky-swarm] lane-wake mounted: 宿主 subagent/end（global:true，与结算主路**并列独立**）→ 命中 lane ⇒ 取 Leader 句柄唤醒 + 附可派发候选（只建议，不派发）');
  }
  return { laneWake, installLaneWake };
};
const replayStartupGaps = ({ ctx, config, store, root }) => {
  try {
    const MAX_SESSIONS = 5;
    const MAX_BATCHES = 20;
    const sessions = (typeof store.listSessions === 'function' ? store.listSessions() : []).slice(0, MAX_SESSIONS);
    const targets = [];
    for (const sid of sessions) {
      const ids = typeof store.listBatches === 'function' ? store.listBatches(sid) : [];
      for (const bid of ids) {
        if (targets.length >= MAX_BATCHES) break;
        try { if (store.readBatch(sid, bid)?.phase === 'running') targets.push({ sessionId: sid, batchId: bid }); } catch { /* 坏批跳过 */ }
      }
      if (targets.length >= MAX_BATCHES) break;
    }
    if (targets.length > 0) {
      void (async () => {
        let replayed = 0; const hits = [];
        for (const t of targets) {
          try {
            const r = await replayBatch({ store, root, liveConfig: config }, ctx, t);
            if (r && r.replayed > 0) { replayed += r.replayed; hits.push(t.batchId); }
          } catch { /* 单批隔离 */ }
        }
        if (replayed > 0) {
          ctx.logger?.info?.('[dsh-punky-swarm] replay(装配期)：补链推进决策 ' + replayed + ' 处（' + hits.join(',')
            + '）—— 重放只落「待派清单」，真派仍由 Leader 在工具面执行');
        }
      })();
    }
  } catch { /* 启动期扫描失败不影响插件装载 */ }
};

// ── W7e E1：governance 装载面（preset 双表 + 注册目录元数据 + hook 安装）下沉为顶层工厂 ──
//   装配顺序不变：仍在 apply 原位调用（晚于 refusalEventBridge / HTTP 面装配的惰性 getter——
//   后者现由 `bindHttpSurfaceDeferred` 承载，`presets: () => getPresetCatalog()` 等仍是惰性求值）。
const installGovernanceSurface = ({ ctx, config, store, root, refusalEventBridge }) => {
  const governanceWarn = (m) => ctx.logger?.warn?.('[governance] ' + m);
  const { table: presetTable, banTable: presetBanTable, errors: presetErrors } = loadPresetTable();
  for (const e of presetErrors) governanceWarn('preset 装载失败：' + e);
  // WebUI 治理配置写通道：preset 注册目录元数据
  //   （GET /config presets 源：id = 已成功装载的注册 id、count = 条目数——装载失败不入目录，
  //   装配侧已对 errors 逐条 warn；derived from 双表，装载后一次性派生）
  //   两表并计：rules 面（l1-sensitive / l2-resource）+ 第三类 toolBan 面（l3-tool-ban），
  //   count = 各类条目数之和（l3/l5 仅有 toolBan 条目，l1/l2 仅有 rules；compose 组合项已废除）
  const presetCatalog = PRESET_IDS
    .filter((id) => Array.isArray(presetTable[id]) || Array.isArray(presetBanTable[id]))
    .map((id) => ({ id, count: (presetTable[id]?.length ?? 0) + (presetBanTable[id]?.length ?? 0) }));
  // 当前已挂载 hook 的解析配置快照（热更比对基准；静态 config 缺省 = resolveGovernanceConfig 全默认）
  let governanceInstalledCfg = resolveGovernanceConfig(config?.governance?.hook ?? {}, { presetTable, presetBanTable, warn: governanceWarn });
  let governanceHook = installGovernanceHook(ctx, { store, root, config, onRefusal: refusalEventBridge, presetTable, presetBanTable, allowlistScope: config?.escalation?.execTools ?? EXEC_TOOLS });
  if (governanceHook.installed) {
    ctx.logger?.info?.('[dsh-punky-swarm] governance hook enabled: tools/pre-execute + post-execute mounted (6 原语内核，rules 空表=零拦截；refusal 事件桥接 refusal-<sessionId>.jsonl'
      + (governanceInstalledCfg.escalation?.enabled === true ? '；escalation 违规计数升级已开启' : '；escalation 默认关（违规计数升级零路径）') + ')');
  }
  return { governanceWarn, presetTable, presetBanTable, presetCatalog, installedCfg: governanceInstalledCfg, hook: governanceHook };
};

// ── W7e E2：governance hook 热切重挂器（句柄经 read/write 访问器与 apply 作用域交互）──
const createGovernanceRemounter = ({ ctx, store, root, refusalEventBridge, presetTable, presetBanTable, governanceWarn, readInstalled, writeInstalled, readHook, writeHook }) => {
  // 热切重挂（生效变化通道 + 启动对账共用）：解析 next 快照 governance.hook → 与当前挂载快照比较（生效变化
  //   = enabled 翻转或 rules/flags/defaults 实际变更；JSON 序敏感——规则序参与裁决，变化即重挂）→
  //   dispose + 以新快照重挂。kernel 闭包持有旧 cfg（createGovernanceKernel(cfg) 捕获引用）→ 最小改动
  //   统一走 dispose+重挂，不引入 updateConfig API。幂等：无生效变化零操作。
  //   交互处置：
  //   - 桥接（onRefusal）：dispose 置空旧实例 refusalCb（断开）→ 新实例重新注入 refusalEventBridge
  //     → remount 后批级事件流随动（bridge 事件不因重挂丢失接线）；
  //   - 状态机：pendingAsks 为 hook 实例内存态（跨 pre/post 存活）→ 重挂清空——跨重挂在途 ask 的
  //     outcome 补记丢失（收据 ask.initiated 已在 pre 落盘不丢审计，outcome 保持 initiated 态；重挂仅
  //     发生在 governance 配置变化时，窗口极小）；DEFER/PAUSE 会话状态为文件态（state-store）→ 不随重挂丢失；
  //   - refusals count 随新实例归零（运行时状态重置契约：重挂后 refusals count 等运行时状态重置）。
  const remountGovernanceHook = (nextConfig, logTag) => {
    const govCfg = resolveGovernanceConfig(nextConfig?.governance?.hook ?? {}, { presetTable, presetBanTable, warn: governanceWarn });
    if (JSON.stringify(govCfg) === JSON.stringify(readInstalled())) return false;
    const wasInstalled = readHook()?.installed === true;
    readHook()?.dispose?.();
    writeHook(installGovernanceHook(ctx, { store, root, config: nextConfig, onRefusal: refusalEventBridge, presetTable, presetBanTable, allowlistScope: nextConfig?.escalation?.execTools ?? EXEC_TOOLS }));
    writeInstalled(govCfg);
    const nowInstalled = readHook()?.installed === true;
    ctx.logger?.info?.('[dsh-punky-swarm] hot config: governance hook ' + (nowInstalled
      ? 're-mounted (governance.hook 生效变化已热切，新 rules/flags/defaults/enabled 生效)'
      : 'unmounted (governance.hook.enabled=false 或装配前置缺失)')
      + (logTag ? ' [' + logTag + ']' : '') + ' [was=' + wasInstalled + ' now=' + nowInstalled + ']');
    return true;
  };
  return remountGovernanceHook;
};

// ── W7e E3：watch 引擎热切重挂器（heartbeat / watchTimer 经访问器写回 apply 作用域；heartbeatRef 原文透传）──
const createWatchRemounter = ({ ctx, config, store, mailbox, root, heartbeatRef, readHeartbeat, writeHeartbeat, readWatchTimer, writeWatchTimer, readInstalled, writeInstalled }) => {
  // watch 引擎重挂（热更生效变化通道 + 启动对账共用；镜像
  //   remountGovernanceHook 模式）：解析 next 快照 watch.* 生效面（7 键 {enabled, longrun.enabled,
  //   scanIntervalMinutes, longrun.maxDurationMs, longrun.noProgressWindowMs, longrun.staleBatchMs,
  //   longrun.unconsumedTimeoutMs}）
  //   → 与当前安装快照 JSON 比较——任一变化 → dispose 旧引擎 + 清 timer → enabled
  //   时以合并快照（change.config，含 longrun.enabled/阈值/scan 值传播）重建 + 重挂 watchdog + 更新
  //   heartbeatRef.current + watchInstalledCfg。幂等：无生效变化零操作。
  //   运行时状态重置契约：引擎内存状态表随 dispose 清空、重建后从事件流/产物 mtime 基线重算
  //   （lane-heartbeat baselineTs 兜底）——不会误 stalled；longrun 候选去重以事件流 runningSince 为准，
  //   跨重建不重复产 candidate。工具注册面仍启动静态：运行期关闭只停扫描，lane_heartbeat/lane_longrun（已于 G3/B1 删除）
  //   查询返回 disabled 状态（lane-heartbeat.js 工具侧 getHeartbeat 执行时解引用）。
  const remountWatchEngine = (nextConfig, logTag) => {
    const wc = resolveWatchConfig(nextConfig);
    const lr = resolveLongrunConfig(nextConfig);
    const nextInstalled = {
      enabled: wc.enabled,
      longrun: {
        enabled: lr.enabled,
        maxDurationMs: lr.maxDurationMs,
        noProgressWindowMs: lr.noProgressWindowMs,
        staleBatchMs: lr.staleBatchMs,
        unconsumedTimeoutMs: lr.unconsumedTimeoutMs,
      },
      scanIntervalMinutes: wc.scanIntervalMinutes,
    };
    if (JSON.stringify(nextInstalled) === JSON.stringify(readInstalled())) return false;
    if (readWatchTimer()) { clearInterval(readWatchTimer()); writeWatchTimer(null); }
    if (readHeartbeat()) { readHeartbeat().dispose(); writeHeartbeat(null); heartbeatRef.current = null; }
    if (wc.enabled) {
      writeHeartbeat(createLaneHeartbeat({ store, mailbox, config: nextConfig, root, liveConfig: nextConfig, logger: ctx.logger }));
      heartbeatRef.current = readHeartbeat();
      const scanMs = Math.max(1000, Math.round(wc.scanIntervalMinutes * 60_000));
      writeWatchTimer(setInterval(() => {
        try { heartbeatRef.current?.tick(); } catch (e) { ctx.logger?.warn?.('[dsh-punky-swarm] heartbeat tick failed: ' + String(e)); }
      }, scanMs));
      if (typeof readWatchTimer().unref === 'function') readWatchTimer().unref();
    }
    writeInstalled(nextInstalled);
    ctx.logger?.info?.('[dsh-punky-swarm] hot config: watch engine ' + (wc.enabled
      ? 're-mounted (scan ' + Math.max(1000, Math.round(wc.scanIntervalMinutes * 60_000)) + 'ms, longrun=' + lr.enabled + ')'
      : 'unmounted (watch disabled)')
      + (logTag ? ' [' + logTag + ']' : ''));
    return true;
  };
  return remountWatchEngine;
};
// ── d1 seam：`rt` 的唯一创建点（W7f）────────────────────────────────────────────────
//   无 sink ⇒ 返回纯对象（生产零 Proxy/零 trap，与手写字面量同构）；注入 sink ⇒ Proxy set trap 记字段名，
//   供测试断言「某分支只写了哪些字段」（单写 vs 双写可区分性 = L3）。字段集 **冻结 20 项**（p1 §3.1）。
const createRuntimeState = (onWrite) => {
  const base = {
    hotConfig: null, watchTimer: null, sweepTimer: null, heartbeat: null, heartbeatRef: null,
    watchInstalledCfg: null, apiDispose: null, trajectory: null, topicRuntime: null, topicAttachUn: null,
    panelStream: null, verifyMount: null, governanceHook: null, governanceInstalledCfg: null,
    dispatchReg: null, autoSettle: null, autoSettleEnabled: null, laneWake: null, acpsEndpoint: null,
    lastRatchetJson: null,
  };
  if (typeof onWrite !== 'function') return base;
  return new Proxy(base, { set(target, key, value) { target[key] = value; onWrite(String(key)); return true; } });
};

// GATE_ENABLED=false 逃生阀启动级留痕——gates.js checkCommandGate/checkTargetsGate 命中逃生阀时
// 内部静默返回零感知（{ ok:true, declared:false }，行为语义不变），装配侧在此检测并落启动级 warn，
// 保证「门禁被禁用」状态可查（审计/排障经启动日志即可见，无需翻 gates.js 源码）。
const warnGateEscapeValve = (ctx) => {
  if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') {
    ctx.logger?.warn?.('[dsh-punky-swarm] GATE_ENABLED=false: 命令门禁/targets 门禁整体放行（应急逃生阀，零感知语义），禁用状态已留痕于启动日志');
  }
};

const createReadConfig = ({ config, rt }) => () => {
  try {
    const hot = rt.hotConfig;
    return hot ? hot.readSnapshot() : config;
  } catch {
    return config;
  }
};

// 释放面（W7f #9）：读 rt 的 15 个资源字段 + flush；幂等（置 null 的 5 项二次调用零操作）。
const releaseAll = (rt) => {
  rt.hotConfig?.dispose();
  if (rt.watchTimer) { clearInterval(rt.watchTimer); rt.watchTimer = null; }
  if (rt.sweepTimer) { clearInterval(rt.sweepTimer); rt.sweepTimer = null; }
  rt.heartbeat?.dispose();
  rt.apiDispose?.();
  rt.trajectory?.stop();
  rt.topicRuntime?.stop();
  // attachTopic 退订 + hub dispose（装配层创建者负责，api.js 注入时不重复 dispose）
  if (rt.topicAttachUn) { rt.topicAttachUn(); rt.topicAttachUn = null; }
  if (rt.panelStream) { rt.panelStream.dispose(); rt.panelStream = null; }
  rt.verifyMount?.dispose();
  rt.governanceHook?.dispose();
  rt.dispatchReg?.dispose?.(); // 派发登记点退订（幂等）
  rt.autoSettle?.dispose?.(); // 自动结算主路（subagent/end）退订（幂等；兼底路随工具面存续）
  rt.laneWake?.dispose?.(); // 【D-2 甲】主路唤醒路（subagent/end 第二路订阅）退订（幂等；独立装配 ⇒ 独立释放）
  // 【L-1】冲刷 governance 未落盘增量：P2 的 flush 三时机（阈值/定时/process.once('exit')）
  //   中 exit 只覆盖进程退出，**不覆盖「插件卸载而宿主继续运行」**的场景 ⇒ 此处补一次显式冲刷。
  //   幂等；零脏会话时为空操作（不产生 I/O、不挂钩子）。
  try { flushDirtyGovernance(); } catch {}
  if (rt.acpsEndpoint) { rt.acpsEndpoint.close().catch(() => {}); rt.acpsEndpoint = null; }
};

// boot 对账（W7f #8）：watcher.start() 应用初始 runtime.json overlay 但不广播（重启语义）——若启动时
//   overlay 已含 governance / watch / autoSettle 变化，装配侧仍按静态 config 挂载 ⇒ 此处按当前快照补一次
//   对账重挂（「配置即状态」不滞后一写）。**不直接写字段**（只调三个 remount；幂等 ⇒ 一致时零操作）。
const reconcileBootOverlay = ({ rt, remountGovernanceHook, remountWatchEngine, remountAutoSettle }) => {
  const snapshot = rt.hotConfig.readSnapshot();
  remountGovernanceHook(snapshot, 'boot-overlay');
  remountWatchEngine(snapshot, 'boot-overlay');
  remountAutoSettle(snapshot, 'boot-overlay');
};

// 两个 remount（W7e 工厂）的访问器装配（W7f）：① watch 与 ⑤ governance 的 rt 写点全部收拢在本工厂内
//   ——写集 {heartbeat, watchTimer, watchInstalledCfg} / {governanceHook, governanceInstalledCfg} 各字段唯一写点。
const mountRemounters = ({ ctx, config, store, root, mailbox, refusalEventBridge, presetTable, presetBanTable, governanceWarn, rt }) => {
  const readInstalled = () => rt.governanceInstalledCfg;
  const writeInstalled = (v) => { rt.governanceInstalledCfg = v; };
  const readHook = () => rt.governanceHook;
  const writeHook = (v) => { rt.governanceHook = v; };
  const remountGovernanceHook = createGovernanceRemounter({ ctx, store, root, refusalEventBridge, presetTable, presetBanTable, governanceWarn, readInstalled, writeInstalled, readHook, writeHook });
  const readHeartbeat = () => rt.heartbeat;
  const writeHeartbeat = (v) => { rt.heartbeat = v; };
  const readWatchTimer = () => rt.watchTimer;
  const writeWatchTimer = (v) => { rt.watchTimer = v; };
  //   注：E3 的 installed 快照是 watchInstalledCfg（≠ E2 的 governanceInstalledCfg）⇒ 就地绑定、不复用 E2 访问器
  const remountWatchEngine = createWatchRemounter({
    ctx, config, store, mailbox, root, heartbeatRef: rt.heartbeatRef,
    readHeartbeat, writeHeartbeat, readWatchTimer, writeWatchTimer,
    readInstalled: () => rt.watchInstalledCfg, writeInstalled: (v) => { rt.watchInstalledCfg = v; },
  });
  return { remountGovernanceHook, remountWatchEngine };
};

// ⑥ auto-settle 停用开关**热切**（R-5/N-8「热更生效」，镜像 governance / watch 两个 remount 语义）：
//   `autoSettle.enabled` **生效变化** ⇒ dispose 旧路 + 按新快照重装（`false` 时 `installAutoSettle`
//   自身走停用分支：零订阅 + 停用日志 + `installed:false` + `reason='auto-settle-disabled'`）。
//   幂等：**无生效变化零操作**（防 fs 抖动重挂，RK-8）。停用**不改相位、不落 `auto.settle.paused`**（R-3）。
//   写集 = {autoSettle, laneWake, autoSettleEnabled}（各 1 次，顺序固定 943 → 950 → 957）。
const createAutoSettleRemounter = ({ ctx, store, dispatchIndex, root, rt, installLaneWake }) => (nextConfig, logTag) => {
  const nextEnabled = autoSettleEnabledOfConfig(nextConfig);
  if (nextEnabled === rt.autoSettleEnabled) return false;
  rt.autoSettle?.dispose?.();
  rt.autoSettle = installAutoSettle(ctx, {
    store, dispatchIndex, root, liveConfig: nextConfig, logger: ctx.logger,
    enabled: autoSettleSwitchOf(nextConfig),
  });
  // 【D-2 甲】主路唤醒路与结算路**同生共死**（同属引擎主路面）：同一开关生效变化 ⇒ 同步退订 / 重挂；
  //   幂等由上方 `nextEnabled === rt.autoSettleEnabled` 早退保证（无生效变化 ⇒ 本段零操作，零日志抖动）。
  rt.laneWake?.dispose?.();
  rt.laneWake = nextEnabled ? installLaneWake() : null;
  if (!nextEnabled) {
    ctx.logger?.info?.('[dsh-punky-swarm] hot config: lane-wake unsubscribed（引擎主路面停用 ⇒ 结算 + 主路唤醒一并退订；'
      + '兼底路 swarm_report 的唤醒/回报面不受影响）' + (logTag ? ' [' + logTag + ']' : ''));
  } else if (rt.laneWake?.installed) {
    ctx.logger?.info?.('[dsh-punky-swarm] hot config: lane-wake re-mounted（主路唤醒路随结算路恢复）' + (logTag ? ' [' + logTag + ']' : ''));
  }
  rt.autoSettleEnabled = nextEnabled;
  ctx.logger?.info?.('[dsh-punky-swarm] hot config: auto-settle ' + (rt.autoSettle.installed
    ? 're-mounted (autoSettle.enabled 生效值 → true：宿主 subagent/end 重新订阅，自动结算恢复)'
    : 'disabled (autoSettle.enabled 生效值 → false：主路已退订；结算责任归 Leader：member_set_status(review) → member_settle(...))')
    + (logTag ? ' [' + logTag + ']' : ''));
  return true;
};

// 热更新装配（W7f #7：就地启停，叠加非替换）：
// 触发源：<root>/config/runtime.json（fs.watch + 防抖 300ms + 原子读重试）→ deepMerge 快照 → config.changed 广播
// 生效语义：只影响被覆盖键的后续读取；不写静态文件、不改变 cordis.patch.yml 读取结果；
//   缺省 {} → 快照 = 静态 config 原样（零行为变化）；判定语义双套保留、热更新只做值传播
// 生效范围：trajectory 桥 start/stop、watch watchdog 启停、topic 运行时启停、verify 挂载（可选）
//   对外能力（acps/bridge/acps.discovery/identity）不纳入热切
// 写集：⓪{lastRatchetJson} ②{trajectory} ③{topicRuntime, topicAttachUn} ④{verifyMount}（①⑤⑥ 在各自 remount 内）
const mountHotConfigRuntime = ({ ctx, config, store, mailbox, root, rt, topicSink, remountWatchEngine, remountGovernanceHook, remountAutoSettle }) => {
  // ratchet 热更守卫的基线：与 createStore 注入所用的同一份 config 对齐（装配期生效的棘轮表）
  rt.lastRatchetJson = JSON.stringify(config?.ratchet ?? null);
  const applyConfigChange = (change) => {
    const next = change.config;
    // ⓪ ratchet（棘轮表）：**重启生效面**——棘轮表在装配期
    //   随 `createStore({ rules })` 注入（上方），热更**不应用**；但变化必须显式告警、非法必须当场校验
    //   （禁「写了不生效却不吭声」；`loadRules` fail-closed 语义不变——重启时非法配置仍会装配失败）。
    const rg = ratchetHotGuard({ next, lastJson: rt.lastRatchetJson });
    if (rg.changed) {
      ctx.logger?.warn?.('[dsh-punky-swarm] hot config: ' + rg.message);
      rt.lastRatchetJson = rg.json;
    }
    // ① watch 引擎（lane 过期检测 + longrun 档）：生效变化通道——7 键 {enabled, longrun.enabled,
    //   scanIntervalMinutes, longrun.maxDurationMs, longrun.noProgressWindowMs, longrun.staleBatchMs,
    //   longrun.unconsumedTimeoutMs} 任一变化 → dispose+重建+重挂 timer+更新 heartbeatRef/watchInstalledCfg
    //   （逻辑见 remountWatchEngine；幂等无变化零操作）。longrun.enabled 翻转与阈值变更经同一通道即时生效。
    remountWatchEngine(next);
    // ② trajectory 桥：enabled 翻转 → stop + 以新快照重建（映射经批次事件幂等恢复）
    const trajOn = isTrajectoryEnabled(next);
    if (trajOn && !rt.trajectory) {
      rt.trajectory = createTrajectoryBridge(ctx, { store, config: next, mailbox });
      const st = rt.trajectory.start();
      if (st.subscribed) ctx.logger?.info?.('[dsh-punky-swarm] hot config: trajectory bridge started');
    } else if (!trajOn && rt.trajectory) {
      rt.trajectory.stop(); rt.trajectory = null;
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: trajectory bridge stopped');
    }
    // ③ topic 运行时：readCapability 缺省关 → enabled 翻转 → 启/停（状态事件发布钩子随动 + hub attachTopic 对称退订）
    const topicCfg = readCapability(next, 'topic');
    if (topicCfg?.enabled && !rt.topicRuntime) {
      rt.topicRuntime = createTopicRuntime(ctx, { root, logger: ctx.logger });
      rt.topicRuntime.start();
      topicSink.emit = (ev) => { try { rt.topicRuntime.publishStateChange(ev); } catch { /* 隔离 */ } };
      if (rt.panelStream && !rt.topicAttachUn) rt.topicAttachUn = rt.panelStream.attachTopic('swarm.');
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: topic runtime started');
    } else if (!topicCfg?.enabled && rt.topicRuntime) {
      rt.topicRuntime.stop(); rt.topicRuntime = null;
      topicSink.emit = null;
      if (rt.topicAttachUn) { rt.topicAttachUn(); rt.topicAttachUn = null; }
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: topic runtime stopped');
    } else {
      ctx.logger?.debug?.('[dsh-punky-swarm] hot config: topic runtime 无变化（期望态 == 现值）');
    }
    // ④ verify 挂载（可选）：enabled 翻转 → dispose + 以新快照重挂（inert 与 installed 双态幂等）
    const vc = resolveVerifyConfig(next);
    if (vc.enabled !== rt.verifyMount.installed) {
      rt.verifyMount.dispose?.();
      rt.verifyMount = mountVerify(ctx, { root, config: next });
      ctx.logger?.info?.('[dsh-punky-swarm] hot config: verify capture ' + (vc.enabled ? 'mounted' : 'unmounted'));
    }
    // ⑤ governance hook（热切）与 ⑥ auto-settle（热切）——逻辑见各自 remount；幂等：无生效变化零操作
    remountGovernanceHook(next);
    remountAutoSettle(next);
  };
  rt.hotConfig = createConfigWatcher({
    root, config,
    onChange: (change) => {
      // ① 进程内广播（cordis 总线事件，宿主可用时；SSE hub/未来订阅方经 ctx.on 订阅）
      try { ctx.emit?.(CONFIG_CHANGED_EVENT, change); } catch { /* 宿主事件缺失静默 */ }
      // ② topic 镜像（可选）：topic.enabled 时同步 emitTopic('swarm.config.changed')，仅进程内分发
      if (rt.topicRuntime) { try { rt.topicRuntime.publishConfigChanged(change); } catch { /* 隔离 */ } }
      // ③ 就地启停
      applyConfigChange(change);
    },
    logger: ctx.logger,
  });
  rt.hotConfig.start();
  reconcileBootOverlay({ rt, remountGovernanceHook, remountWatchEngine, remountAutoSettle });
};
// ── 装配根纪律（①-1-6 裁决甲 2026-11-09：**不做 MOUNTS 表**，只立两条防退化约束）──────────────
// 现状（实测）：本文件已是「一挂载面一具名工厂」形态 —— 26 个具名工厂，`if (cfg.enabled)` 等
//   条件判定全部在**工厂体内**（24 处），本函数内**一处挂载条件都没有**（仅 2 处告警分支）。
//   本函数只剩 119 行**有序 + 携数据**的编排（28 个工厂调用，形参 2–12 个）。
//   ⇒ 再套一层「表驱动」要额外表达顺序 / 每步产出 / 依赖注入三件事，行数不降而可读性更差，故撤销。
// 以下两条是**约束**（不是建议），违反任一都会让本文件重新长成单体：
//   ① **顺序约束**：装配顺序承载语义（例：`重建索引` 必须先于 `轨迹挂载`，见下方 S-1 注释；
//      `createDispatchIndexRebuilder` 的求值点早于 TDZ 相关声明亦然）。新增步骤必须在注释里写明
//      前置依赖；**不得**为「看起来更整齐」而重排既有调用。
//   ② **工厂约束**：新挂载面必须做成具名工厂（形参显式声明依赖），**不得在本函数内联展开**。
//      若某步确实需要表驱动，须先证明它既无顺序依赖也无跨步数据流 —— 本文件当前没有这样的步。
export const apply = (ctx, config = {}) => {
  const rawRoot = config.root ?? '~/.dsh/punky-preset';
  const root = rawRoot.startsWith('~') ? join(homedir(), rawRoot.slice(1)) : rawRoot;
  ctx.logger?.info?.('[dsh-punky-swarm] engine root: ' + root + '；产物根 = <root>/sessions/<sessionId>/artifacts/<batchId>/');
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (cause) {
    // 【A1-P0-01 · Q3】**fail-closed：抛出，不吞、不 return、不降级继续**。理由：root 不可建时后续**全部**落盘
    //   （store / mailbox sweep / assets / 产物根）都会在不存在或不可写的根下失败 ⇒ 继续装配只会把「一条配置键
    //   写错」放大成「全套工具面静默失效 + 零自解释信息」（原缺陷形态：整块插件 pending、没有任何我们自己的日志）。
    //   错误消息必须三段可诊断：① root **绝对路径** ② **配置键名**与缺省值 + 修复动作 ③ 原始 `e.code`
    //   （ENOTDIR = 路径中段是普通文件；EACCES/EPERM = 权限）。
    //   零新造拒码：用 `[dsh-punky-swarm]` 前缀的普通 `Error`（**不以拒码前缀开头**），并保留 `cause` 链。
    const err = new Error('[dsh-punky-swarm] 引擎状态根不可创建：' + root
      + '（配置键 config.root，缺省 ~/.dsh/punky-preset；请修正该键或修复目录权限后重启插件）｜cause: '
      + String(cause?.code ?? '') + ' ' + String(cause?.message ?? cause));
    err.cause = cause;
    throw err;
  }
  const auditMount = mountStartupPrelude({ ctx, config, root });
  const { store, topicSink } = createEngineStore({ ctx, config, root });

  warnGateEscapeValve(ctx);
  const rtOnWrite = (() => { try { return typeof ctx?.rtWriteLog?.push === 'function' ? (k) => ctx.rtWriteLog.push(k) : null; } catch { return null; } })();
  const rt = createRuntimeState(rtOnWrite);

  rt.sweepTimer = installStartupRecovery({ ctx, config, store, root });
  const watchRuntime = installWatchRuntime({ ctx, config, store, root });
  ({ heartbeatRef: rt.heartbeatRef, heartbeat: rt.heartbeat, watchInstalledCfg: rt.watchInstalledCfg } = watchRuntime);
  const readConfig = createReadConfig({ config, rt });
  // 批归属会话解析索引（读侧骨架）：声明须早于 `createTools` 求值点（TDZ）；仍是同一个 Map，由下方启动重建/登记点热更新填充
  const dispatchIndex = new Map();
  const tools = installTools({ ctx, config, store, root, readConfig, heartbeat: rt.heartbeat, heartbeatRef: rt.heartbeatRef, dispatchIndex });
  // ── 工具面注册点：**不在本行**（丙 · 装配隔离，2026-11-08 用户裁决）──────────────────────────
  // 宿主的工具注册表按 scope 分层：`tools.register()` 落入**调用方 ctx** 所属的 scope 层
  //   （`@deepseek-ai/dsh-tools` 的 `register()` → `ScopedLayers.effect(scopeOf(ctx))`），
  //   preset 组合里注册的是**祖先层贡献**，只对该 preset 选出的 agent 及其派生 worker 可见。
  // ⇒ 本行只建目录（AIP `/tools`、ADP `/discover` 要读）+ 把工具集挂成服务，
  //   注册动作由预设组合里的 `dsh-punky-swarm/provider-dsh` 行以自己的 ctx 执行。
  //   取证与消费面影响见 `host-contract-preset-tool-scope.md`（本批 lane 产物）。
  tools.buildCatalog();
  // ── MCP 常驻面（2026-11-09 用户裁决）：黑板 7 件注册到**引擎行根 ctx**（宿主 global 层）──────
  //   global 是每个 scope 视图的**无条件起点**（宿主 dsh-tools index.js:480）⇒
  //     ① MCP（无 agent）的 get/execute 直接命中 ⇒ `/mcp` 不再是空数据面；
  //     ② 各 preset 的 agent 经祖先链仍看得见（preset 行只注册补集 ⇒ 同层不重名）；
  //     ③ 兄弟 scope 与其它模式**只看到这 7 件**（= 用户要的「通用任务黑板」）；
  //     ④ 注册 disposer 必须挂 `ctx.effect`：热重载不释放 ⇒ 同层重名抛 `tool "X" is already registered`。
  //   常驻集定义见 `lib/engine/suite.js` 的 RESIDENT_TOOL_NAMES（逐件裁定，非 kind 派生）。
  const disposeResident = tools.register(ctx, { only: RESIDENT_TOOL_NAMES });
  if (typeof disposeResident === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => disposeResident, 'dsh-punky-swarm: resident tool face (MCP)');
  }
  try {
    ctx.provide?.('punkySwarmTools', {
      registerTools: (targetCtx, options) => tools.register(targetCtx ?? ctx, options),
      toolNames: tools.tools.map((t) => t.name),
    });
  } catch (e) {
    // 同名服务已在本 scope 提供（热重载残留）⇒ 不阻断装配，响亮留痕：工具面将缺席。
    ctx.logger?.warn?.('[dsh-punky-swarm] punkySwarmTools provide failed: ' + String(e?.message ?? e));
  }
  rt.watchTimer = installWatchdog({ ctx, watchCfg: watchRuntime.watchCfg, heartbeatRef: rt.heartbeatRef, heartbeat: rt.heartbeat });
  // 【S-1 时序】索引重建**必须先于**轨迹挂载：轨迹的 rebuildFromEvents 会直接取用该索引，
  //   若索引还没建（空 Map），轨迹映射会变空 ⇒ 行为降级。故此处把重建对提升到挂载之前。
  const rebuildDispatchIndex = createDispatchIndexRebuilder({ store, dispatchIndex });
  rebuildDispatchIndex(); // 启动重建（幂等；装配期一次）
  rt.trajectory = installTrajectoryBridge({ ctx, config, store, dispatchIndex });
  ({ topicRuntime: rt.topicRuntime, topicAttachUn: rt.topicAttachUn } = installTopicRuntime({ ctx, config, root, topicSink, panelStream: rt.panelStream, topicAttachUn: rt.topicAttachUn }));
  // ── HTTP 面（方案 A · 延迟绑定）：装配点**后移到 topic 运行时之后**─────────────────────────
  //   顺序依据（对判据源 S2.1 的**唯一**调整，理由可判）：AC-7 的补接线回调要读 `rt.topicRuntime`，
  //   而后者在本行才由 `installTopicRuntime` 写入 ⇒ 若仍按旧位置（`installWatchdog` 之后）调用延迟入口，
  //   则 webServer 已就绪的那种宿主里 probe 会在 topicRuntime 就绪**之前**装配完成，topic 接线仍会丢一次。
  //   其余装配面无顺序依赖：本段的产物（路由 / hub）只有 HTTP 请求时才被消费，且 `getPresetCatalog`
  //   等全部是惰性 getter（见 `createHttpSurface` 内注释）。
  //   ⚠ 与旧 `installWebSurface` 的返回值语义**不完全等价**：`rt.apiDispose` / `rt.panelStream` 由延迟入口
  //    在装配完成时回填（可能晚于本行）⇒ 任何消费方一律**读时求值**，禁在本同步段缓存布尔/引用。
  const syncHttpSurfaceConsumers = () => {
    // AC-7：`installTopicRuntime` 在 `panelStream === null` 时跳过 `attachTopic('swarm.')`
    //   （`if (panelStream && !topicAttachUn)`，:436）⇒ 延迟装配后必须补接，否则 topic 事件**静默丢线且不报错**。
    //   与热更通道（`applyConfigChange ③`）逐字同式，幂等：已接线不重复订阅。
    if (rt.topicRuntime && rt.panelStream && !rt.topicAttachUn) {
      rt.topicAttachUn = rt.panelStream.attachTopic('swarm.');
      ctx.logger?.info?.('[dsh-punky-swarm] http surface: topic wiring attached（延迟装配后补接线）');
    }
    // AC-8：`rt.capabilities` 的 `host[].httpSurface` 是 apply 时刻快照（`ports.httpSurface` 只求值一次）
    //   ⇒ 装配/释放后就地刷新该面读数 + 派生 `unavailable`。刷新逻辑是纯函数（`lib/host-face-reading.js`），
    //   独立成模块以便单测直接驱动（`lib/capabilities.js` 的导出面被 C7 用例冻结，禁增删）。
    const refreshed = refreshFaceReading(rt.capabilities, 'httpSurface', createHttpPort(ctx).available === true);
    if (refreshed) {
      ctx.logger?.info?.('[dsh-punky-swarm] http surface: capability reading refreshed (httpSurface.available='
        + (createHttpPort(ctx).available === true) + ')');
    }
  };
  const httpSurface = bindHttpSurfaceDeferred({
    ctx, config, store, root, tools, rt,
    getWatchInstalledCfg: () => rt.watchInstalledCfg,
    getGovernanceInstalledCfg: () => rt.governanceInstalledCfg,
    getPresetCatalog: () => presetCatalog,
    // `/mcp` 早到的那次尝试（`createTools` 内）的返回：`installed === false` 的 no-op 不构成持有者
    mcpPlaneOf: () => tools.mcpPlaneDispose,
    syncConsumers: syncHttpSurfaceConsumers,
  });
  const bridge = mountAcpsBridge({ ctx, config, root });
  const registryClient = installRegistryClient({ ctx, config });
  rt.acpsEndpoint = installAcpsEndpoint({ ctx, config, root, bridge });
  rt.verifyMount = mountVerify(ctx, { root, config });
  const refusalEventBridge = createRefusalEventBridge({ ctx, root, store, dispatchIndex, rebuildIndex: () => rebuildDispatchIndex(), getGovernanceInstalledCfg: () => rt.governanceInstalledCfg });
  rt.dispatchReg = mountDispatchRegistration({ ctx, config, store, dispatchIndex });
  rt.autoSettle = installAutoSettleMainPath({ ctx, config, store, dispatchIndex, root });
  rt.autoSettleEnabled = autoSettleEnabledOfConfig(config);
  const { laneWake: laneWakeInstalled, installLaneWake } = installLaneWakePath({ ctx, store, dispatchIndex, autoSettleEnabled: rt.autoSettleEnabled });
  rt.laneWake = laneWakeInstalled;

  replayStartupGaps({ ctx, config, store, root });
  const { governanceWarn, presetTable, presetBanTable, presetCatalog, installedCfg, hook } = installGovernanceSurface({ ctx, config, store, root, refusalEventBridge });
  rt.governanceInstalledCfg = installedCfg;
  rt.governanceHook = hook;
  const { remountGovernanceHook, remountWatchEngine } = mountRemounters({ ctx, config, store, root, mailbox, refusalEventBridge, presetTable, presetBanTable, governanceWarn, rt });
  const remountAutoSettle = createAutoSettleRemounter({ ctx, store, dispatchIndex, root, rt, installLaneWake });
  mountHotConfigRuntime({ ctx, config, store, mailbox, root, rt, topicSink, remountWatchEngine, remountGovernanceHook, remountAutoSettle });

  const agentPortForCapability = createAgentPort(ctx);
  // 内核端口在位事实（**不是**宿主能力）：
  //   · `runtime` = 成员执行端口对象是否装上；
  //   · `audit`   = **内核审计出口**是否存在 —— 语义锚点 = `KernelPorts.AuditSink`（批次事件日志），
  //     由 `createEngineStore` 产出，**恒存在**。
  //     ⚠ **不要**把 auditlog exporter 的挂载结果当 kernel.audit：那是**可选内部能力**
  //     （`capabilities.auditlog`，已由 `internal` 段与 `capability-disabled:` 表达），
  //     把它算作内核必需位会让「显式关闭审计日志 / 无真实 logger 的夹具」被误判成装配缺陷。
  const kernelFacts = { runtime: agentPortForCapability != null, audit: store != null };
  void auditMount; // 保留 `mountStartupPrelude` 的返回（诊断可用），但不参与内核判定（见上）
  const probePorts = {
    toolSurface: createToolsPort(ctx),
    httpSurface: createHttpPort(ctx),
    agentRuntime: agentPortForCapability,
  };
  const agentChannels = agentChannelFactsOf(ctx);
  rt.capabilities = capabilityReport({
    ...rt,
    ctx,
    config,
    ports: probePorts,
    agentChannels,
    kernel: kernelFacts,
  });
  const WIRED_ISSUE_RE = /^(port-absent:|roster-table-unwired:)/;
  const wiredFaceIssues = (rt.capabilities.host ?? [])
    .filter((h) => h.available === false && WIRED_ISSUE_RE.test(String(h.reason ?? '')))
    .map((h) => h.key);
  if (wiredFaceIssues.length > 0) {
    ctx.logger?.warn?.('[dsh-punky-swarm] capability-unavailable: ' + wiredFaceIssues.join(','));
  }
  // 路②：internal 未启用（含默认关的 4 键）⇒ info（策略停用，不是故障）
  const disabledCapabilities = rt.capabilities.internal.filter((c) => !c.enabled).map((c) => c.key);
  if (disabledCapabilities.length > 0) {
    ctx.logger?.info?.('[dsh-punky-swarm] capability-disabled: ' + disabledCapabilities.join(','));
  }
  // 红线（C-2）：`assertRequired` 只读 `report.kernel`，是 fail-closed 的**全部**意义（不再读宿主能力）。
  assertRequired(rt.capabilities);

  // 释放顺序：延迟入口先释放（`/api` → hub → `/mcp`）并退订 `internal/service`；`releaseAll` 随后
  //   收其余资源。延迟入口释放后已把 `rt.apiDispose` / `rt.panelStream` / `rt.topicAttachUn` 置空
  //   ⇒ `releaseAll` 对这三项为零操作（`releaseAll` 的置空写集不变，仍恰 5 项）。
  return () => { httpSurface.close(); releaseAll(rt); };
};
