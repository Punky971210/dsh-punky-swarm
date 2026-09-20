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

// 通用产物类型注册表
// 定位：通用任务治理模式——登记产物类型 → 层/目录前缀的约定，供校验与查询；
// 不绑定任何团队模板（punky-preset 四件套只是使用者，产物内部格式归模板层）。
// 三层目录约定：plan/（任务层）、exec/（执行层）、audit/（审计层），与 wave-plan 路径契约一致。

export const ARTIFACT_TYPES = [
  { type: 'plan',       dir: 'plan/',  layer: 'plan', desc: '任务层产物（排期/模块清单/摸底）' },
  { type: 'spec',       dir: 'plan/',  layer: 'plan', desc: '执行规范（模板层定义内部结构）' },
  { type: 'taskTree',   dir: 'plan/',  layer: 'plan', desc: '任务树（细拆）' },
  { type: 'survey',     dir: 'plan/',  layer: 'plan', desc: '代码摸底报告（现状/入口/依赖/风险）' },
  { type: 'code',       dir: 'exec/',  layer: 'exec', desc: '代码/实现产物' },
  { type: 'testReport', dir: 'exec/',  layer: 'exec', desc: '测试报告' },
  { type: 'review',     dir: 'audit/', layer: 'audit', desc: '审查证据' },
  { type: 'gapList',    dir: 'audit/', layer: 'audit', desc: '差距清单' },
  { type: 'acceptance', dir: 'audit/', layer: 'audit', desc: '验收报告' },
  { type: 'retrospective', dir: 'audit/', layer: 'audit', desc: '复盘报告（记忆沉淀输入，记忆工具开放语义）' },
];

// 相对产物路径 → 类型名（按目录前缀匹配；绝对路径返回 null）
export function artifactTypeOf(relPath) {
  if (typeof relPath !== 'string') return null;
  for (const t of ARTIFACT_TYPES) {
    if (relPath.startsWith(t.dir)) return t.type;
  }
  return null;
}

// 层 → 该层注册的产物类型
export function typesOfLayer(layer) {
  return ARTIFACT_TYPES.filter((t) => t.layer === layer).map((t) => t.type);
}

// 产物类型注册表 → 回显视图（**唯一读端**，供 `lib/tools/core.js` 的 `artifact_types` 消费）。
// 冻结契约（blueprint §2.2）：四字段逐字回显；新字段**纯增量**、**缺省不声明即不产键**
//   ⇒ 既有条目的回显键集恒为 `{type,dir,layer,desc}`（零漂移）。
// `elements`（string[]）：该产物类型必须逐条覆盖的元素 id（∈ 词表 kind:'element' 且 enabled:true）；
// `subsections`（object|string[]）：产物内部小节骨架（对象形 = { "<标题>": level }；数组形等价 level 2）。
// 入参缺省 = 本模块的注册表（测试可注入夹具，无需改注册表即可验两态）。
export function artifactTypesView(types = ARTIFACT_TYPES) {
  const rows = Array.isArray(types) ? types : [];
  return rows.map((t) => ({
    type: t.type,
    dir: t.dir,
    layer: t.layer,
    desc: t.desc,
    ...(Array.isArray(t.elements) ? { elements: [...t.elements] } : {}),
    ...(t.subsections != null ? { subsections: t.subsections } : {}),
  }));
}
