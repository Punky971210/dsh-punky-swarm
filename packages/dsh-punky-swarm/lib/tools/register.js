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
// ⚠ P2-05 治理工具豁免边界（与 core.js installDifficultyGuard ① 口径一致）：
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
// P6 接线（exec-format-wire）：装配层导出 AIP 结构投影函数，供 api.js 只读端点使用（纯函数，不改 mailbox 存储）
import * as aipFormat from '../comms/aip-format.js';
import { readCapability } from '../assembly/schema.js';

export function createTools(ctx, deps) {
  // guard 注册顺序保持现状：createTools 开头、工具数组构造之前（guard 回调闭包依赖 store/config）
  installDifficultyGuard(ctx, deps);

  const tools = [
    ...createCoreTools(ctx, deps),
    ...createMailboxTools(ctx, deps),
    ...createLaneTools(ctx, deps),
    ...createLogTools(ctx, deps), // E3 log_export：readCapability(config,'logs') 合并注册表 default（logs 默认关 → 缺省不注册；patch 显式 logs.enabled:true 注册）。TBD-2 实测工具总数：裸配置 19 / patch 全开 20 / 显式关（worktree+watch 关）14
  ];

  // 装配 enabled 开关（缺省默认开——AIP 为主线 + 治理能力全开，
  //   显式 aip.enabled:false 可关闭）。经 readCapability 默认合并读取（schema.js CAPABILITY_REGISTRY 同源口径）：
  //   缺省配置（config 无 aip 键）→ 合并默认 {enabled:true} → 实际默认开启；enabled === true 时注册工具目录快照并暴露 catalog。
  // 生成器只读遍历 tools，不替换、不包装任何已注册工具对象（红线：既有工具契约不变）。
  // P4 ACS：enabled === true 时按装配配置（config.assembly ?? DEFAULT_ASSEMBLY，
  //   team 取 config.aip.team ?? 'jiufeng'）经 agent-descriptor 纯函数生成智能体描述目录 agentCatalog
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
      const assembly = resolveAssembly(aipCfg.team ?? 'jiufeng', deps?.config?.assembly) ?? DEFAULT_ASSEMBLY;
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
    // P6 接线（exec-format-wire）：AIP 结构投影函数集（toAipMessage/toAipTask/toAipSession）——恒导出（纯函数零副作用），
    // api.js 只读端点消费（缺省传入时端点不附投影，既有行为不变；红线：不改 mailbox 存储）
    get aipFormat() { return aipFormat; },
  };
}
