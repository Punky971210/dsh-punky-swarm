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

// 蟛蜞模式治理工具聚合注册入口（core 11 + mailbox 3 + lane 工具族 + 可选能力组；可选组按装配键
// 缺省默认开——readCapability 合并注册表 default；显式 enabled:false 可逐键关闭）
// 拆分自 lib/tools.js（createTools 签名保持，index.js 调用不变）
// ⚠ 治理工具豁免边界（与 core.js installDifficultyGuard 口径一致）：
//   治理/查询类工具（batch_status/gate_status/member_status/artifact_types/lane_heartbeat/
//   lane_checkpoint_status 等非执行型）豁免任务难度门禁——理由：防死锁（评估/查询若被拦
//   则「先评估后执行」护栏自锁）；豁免仅限难度门禁，其余 guard 语义（执行计数等）不受影响。
import { createCoreTools, installDifficultyGuard } from './core.js';
import { createMailboxTools } from './mailbox-tools.js';
import { createLaneTools } from './lane-tools.js';
import { createLogTools } from './log-tools.js';
import { buildToolCatalog, engineVersion } from '../aip/tool-descriptor.js';
import { buildAgentCatalog } from '../aip/agent-descriptor.js';
import { resolveAssembly, DEFAULT_ASSEMBLY } from '../assembly.js';
// 接线：装配层导出 AIP 结构投影函数，供 api.js 只读端点使用（纯函数，不改 mailbox 存储）
import * as aipFormat from '../comms/aip-format.js';
import { readCapability } from '../assembly/schema.js';

export function createTools(ctx, deps) {
  // guard 注册顺序保持现状：createTools 开头、工具数组构造之前（guard 回调闭包依赖 store/config）
  installDifficultyGuard(ctx, deps);
  // 【批 `d-override-fix-20261011` · lane `e4-session-bind`】批归属会话 resolver **注入单点**（AC-3/AC-5）。
  //   消费面：`lib/tools/shared.js#sessionOf(args, exec, resolveBatchSession)` 的可选第三参数（四级回落）。
  //   构造面：`deps.resolveBatchSession`（缺省 `undefined` ⇒ 各工具 `sessionOf` 逐字回落原三级路径，
  //     **零行为变化**——Leader 会话 / 未登记会话 / 未接线部署均不受影响）。
  //   **本文件不构造第二套判定**：resolver 本体是 `lib/engine/dispatch.js#batchSessionIdOfWorker`
  //     （唯一 worker→批 反查点，数据源 = 既有 `dispatchIndex`）；装配层（`lib/index.js`）以
  //     `batchSessionIdOfWorkerResolved(store, dispatchIndex, exec)` 注入 —— 闭包捕获**同一个** Map 引用，
  //     `rebuildDispatchIndex()` / 登记点热更新对该 Map 的写入**无需重挂即被看见**（惰性求值）。
  //   【批 `session-bind-index-fix-20261012` · lane `e4-wiring`】同一 `dispatchIndex` 引用**同时**经 `deps` 下传
  //     供**写侧**消费（修复③ 主路）：`lib/tools/member-tools.js#buildDispatchTools` 的 `lane_dispatch` ⇒
  //     `dispatchLaneCore({ ..., dispatchIndex: deps?.dispatchIndex })` ⇒ 自派成功后同步 `set` 同一 Map
  //     ⇒ worker 首个治理调用**立即**命中（无需等兜底反查）。读侧（resolver 闭包）与写侧（deps）**同一引用**，
  //     禁在任一侧另建 Map（单点判定；`mapCtor = ['lib/index.js']`）。
  //   透传形态 = `deps` 原样下传（各 `build*Tools` / 工具工厂经 `cx.deps` 取用），
  //     故本处**无需**逐工具改签名 ⇒ 不引入第二个注入面。
  //   ⚠ `deps.dispatchIndex` 不可序列化（Map 实例）⇒ 只走 JS 侧装配（`lib/index.js` 直传），yml 静态块不适用；
  //     缺省 `undefined` ⇒ `lane_dispatch` 逐字回原行为（`dispatchLaneCore` 内 `instanceof Map` 守卫，零行为变化）。
  const tools = [
    ...createCoreTools(ctx, deps),
    ...createMailboxTools(ctx, deps),
    ...createLaneTools(ctx, deps),
    ...createLogTools(ctx, deps), // log_export：readCapability(config,'logs') 合并注册表 default（logs 默认关 → 缺省不注册；patch 显式 logs.enabled:true 注册）。实测工具总数：裸配置 20 / patch 全开 21 / 显式关（worktree+watch 关）14
  ];

  // 装配 enabled 开关（缺省默认开——AIP 为主线 + 治理能力全开，
  //   显式 aip.enabled:false 可关闭）。经 readCapability 默认合并读取（schema.js CAPABILITY_REGISTRY 同源口径）：
  //   缺省配置（config 无 aip 键）→ 合并默认 {enabled:true} → 实际默认开启；enabled === true 时注册工具目录快照并暴露 catalog。
  // 生成器只读遍历 tools，不替换、不包装任何已注册工具对象（红线：既有工具契约不变）。
  // ACS 智能体描述：enabled === true 时按装配配置（config.assembly ?? DEFAULT_ASSEMBLY，
  //   team 取 config.aip.team ?? 'punky-preset'）经 agent-descriptor 纯函数生成智能体描述目录 agentCatalog
  //   （ACS 字段集，见 lib/aip/agent-descriptor.js）；enabled=false 时恒为 null、零开销。
  const aipCfg = readCapability(deps?.config, 'aip');
  const aipEnabled = aipCfg?.enabled === true;
  let catalog = null;
  let agentCatalog = null;

  const register = () => {
    for (const t of tools) ctx.tools.register(t);
    if (aipEnabled) {
      catalog = buildToolCatalog(tools, { version: engineVersion(), config: deps?.config });
      const aipCfg = deps?.config?.aip ?? {};
      const assembly = resolveAssembly(aipCfg.team ?? 'punky-preset', deps?.config?.assembly) ?? DEFAULT_ASSEMBLY;
      const { owner, skillMeta, endPoints, securitySchemes, capabilities, defaultInputModes, defaultOutputModes } = aipCfg;
      agentCatalog = buildAgentCatalog(assembly, {
        version: engineVersion(),
        generatedAt: new Date().toISOString(),
        owner, skillMeta, endPoints, securitySchemes, capabilities, defaultInputModes, defaultOutputModes,
      });
    }
  };

  return {
    tools,
    register,
    // catalog / agentCatalog 在 register() 之后非空（index.js 先 register 再 createApi 取用）；
    //   缺省默认开启 → 非空，仅显式 aip.enabled=false 时恒为 null（/tools 端点不注册）
    get catalog() { return catalog; },
    get agentCatalog() { return agentCatalog; },
    // 接线：AIP 结构投影函数集（toAipMessage/toAipTask/toAipSession）——恒导出（纯函数零副作用），
    // api.js 只读端点消费（缺省传入时端点不附投影，既有行为不变；红线：不改 mailbox 存储）
    get aipFormat() { return aipFormat; },
  };
}
