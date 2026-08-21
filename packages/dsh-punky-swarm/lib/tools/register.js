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

// 蟛蜞模式治理工具聚合注册入口（14 个 = core 11 + mailbox 3 + lane 骨架 0；可选能力组按装配键默认关）
// 拆分自 lib/tools.js（punky-restructure exec-tools-split lane）：createTools 签名保持，index.js 调用不变
import { createCoreTools, installDifficultyGuard } from './core.js';
import { createMailboxTools } from './mailbox-tools.js';
import { createLaneTools } from './lane-tools.js';
import { createLogTools } from './log-tools.js';
import { buildToolCatalog, engineVersion } from '../aip/tool-descriptor.js';

export function createTools(ctx, deps) {
  // guard 注册顺序保持现状：createTools 开头、工具数组构造之前（guard 回调闭包依赖 store/config）
  installDifficultyGuard(ctx, deps);

  const tools = [
    ...createCoreTools(ctx, deps),
    ...createMailboxTools(ctx, deps),
    ...createLaneTools(ctx, deps),
    ...createLogTools(ctx, deps), // E3 log_export：config.capabilities.logs.enabled===true 时注册（默认关 → 14 不变）
  ];

  // 国标 AIP P0-1：装配 enabled 开关（默认关）——enabled === true 时注册工具目录快照并暴露 catalog。
  // 生成器只读遍历 tools，不替换、不包装任何已注册工具对象（红线：既有工具契约不变）。
  const aipEnabled = deps?.config?.aip?.enabled === true;
  let catalog = null;

  const register = () => {
    for (const t of tools) ctx.tools.register(t);
    if (aipEnabled) catalog = buildToolCatalog(tools, { version: engineVersion(), config: deps?.config });
  };

  return {
    tools,
    register,
    // catalog 在 register() 之后非空（index.js 先 register 再 createApi 取用）；enabled=false 时恒为 null
    get catalog() { return catalog; },
  };
}
