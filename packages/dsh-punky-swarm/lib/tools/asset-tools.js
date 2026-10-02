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

// 产物面工具（自 `lib/tools/core.js` **原样搬移**）：artifact_types（类型注册表，只读）/ asset_claim（归位）。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { artifactTypesView } from '../artifact-types.js';

export function buildArtifactTools(cx) {
  return [
    defineTool({
      name: "artifact_types",
      description: "产物类型注册表（只读，Tier3 通用任务治理）：列出产物类型 → 层/目录前缀约定，供 wave_plan 声明产物与模板对齐。不绑定任何团队模板。",
      parameters: {},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"types":{"type":"array","required":true,"items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => TEXT_OUTPUT('artifact types: ' + value.types.length),
      },
      async execute() {
        return { types: artifactTypesView() };
      },
    }),
  ];
}

export function buildAssetClaimTools(cx) {
  const { store } = cx;
  return [
    defineTool({
      name: "asset_claim",
      description: "归位：**Leader 或成员（worker）**产物注册为批次资产——复制 source 进 <artifacts>/<batchId>/<target>（保留内容，不移动），批次事件 asset.claimed 留痕，返回批次内路径供 wave_plan consume/produce 声明。路径防逃逸：target 必须是批次内相对路径，拒绝 .. 与绝对路径。引擎产物根 = <~/.dsh/punky-preset>/sessions/<sessionId>/artifacts/<batchId>/；Leader 直做的探索/探测/排障产物、成员按工作区落盘的产物，结算前均应经本工具归位到该根下。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"source":{"type":"string","required":true,"description":"源文件绝对路径（已直做产物）"},"target":{"type":"string","required":true,"description":"批次内目标路径（相对 artifacts/<batchId>/，不得含 .. 或绝对路径）"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"claimedPath":{"type":"string"},"batchId":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('asset claimed: ' + value.claimedPath),
      },
      async execute(args, exec) {
        // 【2026-09-27 用户裁 · 三项全放】本件**已撤模式门**（`suite.js` 表条目 `modeGate:false`）⇒ 此处不再落
        //   `assertModeActive`：成员认领任务刚需 asset_claim，而受模式门的工具必须 deny 成员（不变量
        //   「modeGate ⊆ memberDeny」），二者不可兼得 ⇒ 取「成员可调用」，代价 = 非生效模式下亦允许归位
        //   （写面仍受「批次须存在 + target 防逃逸 + source 须为文件」约束，见 store.claimAsset）。
        const sessionId = sessionOf(args, exec);
        const r = store.claimAsset(sessionId, args.batchId, { source: args.source, target: args.target });
        return { ok: r.ok, claimedPath: r.claimedPath, batchId: r.batchId };
      },
    }),
  ];
}