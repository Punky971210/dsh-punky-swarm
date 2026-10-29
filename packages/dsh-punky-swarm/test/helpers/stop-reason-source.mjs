/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/helpers/stop-reason-source.mjs —— `SETTLEABLE_STOP_REASONS` **定义位判据的单点实现**。
//
// 为什么抽出（B2 驳回 blocking①）：原判据把定义位**冻结成 `lib/schema.ts:501` 这个行号字符串** ⇒
//   本批 schema.ts 上方注释净 +1 行（内容一字未变）就把用例打红 —— **行号是位移，不是语义**。
//   现改为**内容锚定**：按正则找「定义语句本身」，断言其**文件集 / 逐字内容 / 白名单值集 / 与 StopReason 的先后顺序**；
//   行号只进诊断输出，**不参与任何相等比较**。
//
// 判据强度不降（四面都在）：① 定义位恰 1 处且在 `lib/schema.ts`；② 定义行**逐字**等于白名单单点形态；
//   ③ 白名单值集 ≡ `['completed']`；④ 定义位在 `export type StopReason` **之后**（先有取值域、再收窄可结算集）。

/** 白名单定义行的**规范形态**（逐字比较用；内容变了就红，注释位移不会）。 */
export const EXPECTED_DEFINITION_LINE = "export const SETTLEABLE_STOP_REASONS = Object.freeze(['completed'] as readonly StopReason[]);";

/** 定义语句探测（按内容，不按行号）。 */
export function definitionLineOf(src, name = 'SETTLEABLE_STOP_REASONS') {
  const re = new RegExp('^\\s*export const ' + name + '\\s*=');
  const lines = String(src).split(/\r?\n/);
  const hit = lines.find((l) => re.test(l));
  return hit === undefined ? null : hit.trim();
}

/** 白名单**值集**（从定义行解析；解析不出 ⇒ null，交由用例判红）。 */
export function whitelistValuesOf(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(/Object\.freeze\(\s*\[([^\]]*)\]\s*as readonly StopReason\[\]\s*\)/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((x) => x.trim().replace(/^'/, '').replace(/'$/, ''))
    .filter((x) => x.length > 0);
}

/** 语义顺序：白名单定义是否在 `export type StopReason` **之后**（按字符位置，不看行号）。 */
export function definitionAfterStopReasonType(src, name = 'SETTLEABLE_STOP_REASONS') {
  const s = String(src);
  const typeIdx = s.search(/export type StopReason\s*=/);
  const defIdx = s.search(new RegExp('^\\s*export const ' + name + '\\s*=', 'm'));
  if (typeIdx < 0 || defIdx < 0) return { typeIdx, defIdx, ok: false, why: typeIdx < 0 ? 'no-StopReason-type' : 'no-definition' };
  return { typeIdx, defIdx, ok: defIdx > typeIdx, why: defIdx > typeIdx ? null : 'definition-before-type' };
}

/** 一次判据求值（纯函数；供用例与「行号位移/内容变更」变异探针共用同一份实现）。 */
export function judgeSchemaSource(src, name = 'SETTLEABLE_STOP_REASONS') {
  const line = definitionLineOf(src, name);
  const values = whitelistValuesOf(line);
  const order = definitionAfterStopReasonType(src, name);
  return {
    line,
    values,
    order,
    exact: line === EXPECTED_DEFINITION_LINE,
    whitelistIsCompletedOnly: Array.isArray(values) && values.length === 1 && values[0] === 'completed',
  };
}
