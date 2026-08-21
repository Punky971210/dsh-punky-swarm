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

// 国标 AIP 工具 6 属性描述生成器（P0-1，纯函数零副作用）
// 国标 P7 工具调用要求每工具提供 6 项属性：toolId / Name / Description / Version / InputParam / OutputParam
//   （GB/Z 185-2026《人工智能 智能体互联》P7，见 full-benchmark.md §6.1 / aip-decision.md §1.1）
// 设计要点：4 项原样透传（name/description/inputParam/outputParam）、2 项派生（toolId/version），
//   保证「零语义改写」——国标字段与引擎既有描述同构透传而非二次建模，任何一方变更都不产生漂移。
// 本文件只依赖 Node 内建（structuredClone），不读文件系统，可独立单测。
import { readFileSync } from 'node:fs';

// 引擎版本缺省值（可被 ctx.version 注入 / config.aip.toolVersion 覆盖）
export function engineVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// toolId 命名规则（统一）：dsh.punky-swarm.<既有 name>（反向域唯一性 + 双向可逆，预留 OID 前缀接入位）
export function toToolId(name) {
  return 'dsh.punky-swarm.' + name;
}

// inputParam：defineTool 已把扁平属性表归一化为 JSON Schema 顶层结构
//   {type:'object', properties, required}（required 提升为顶层数组，与国标 inputParam 同构）——
//   已归一化则原样透传（决策包「原样透传」语义），扁平形态兜底展开（防御 defineTool 版本差异）。
//   国标要求 required 恒存在（全可选参数时补空数组）。
export function toInputParam(parameters = {}) {
  if (parameters && typeof parameters === 'object' && 'type' in parameters) {
    const clone = structuredClone(parameters);
    if (!('required' in clone)) clone.required = [];
    return clone;
  }
  const required = [];
  const properties = {};
  for (const [key, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = spec ?? {};
    if (isRequired === true) required.push(key);
    properties[key] = rest;
  }
  return { type: 'object', properties, required };
}

// outputParam：既有 output.schema 已是 JSON Schema 顶层结构，原样透传（深拷贝防共享引用漂移）
export function toOutputParam(output) {
  return output?.schema ? structuredClone(output.schema) : { type: 'object', properties: {} };
}

// 单工具 6 属性生成器：输入 defineTool 对象 + ctx（{ version?, config? }），输出国标 6 属性 JSON
// ctx.version：引擎版本（缺省 engineVersion()）；ctx.config.aip.toolVersion：可选覆盖
export function buildToolDescriptor(tool, ctx = {}) {
  const config = ctx.config ?? {};
  const version = config?.aip?.toolVersion ?? ctx.version ?? engineVersion();
  return {
    toolId: toToolId(tool.name),
    name: tool.name,
    description: tool.description,
    version,
    inputParam: toInputParam(tool.parameters),
    outputParam: toOutputParam(tool.output),
  };
}

// 工具目录快照：持有全量描述 + 只读 list()/get(name) 查询；注册完成后冻结（防误改）
export function buildToolCatalog(tools, ctx = {}) {
  const descriptors = tools.map((t) => buildToolDescriptor(t, ctx));
  return {
    generatedAt: new Date().toISOString(),
    descriptors: Object.freeze(descriptors),
    list() {
      return descriptors.slice();
    },
    get(name) {
      return descriptors.find((d) => d.name === name) ?? null;
    },
  };
}
