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

// test/helpers/schema-conformance.mjs —— **output.schema 一致性**的共享单点（task-26 抽取）
// ─────────────────────────────────────────────────────────────────────────────
// 由来（真实批次缺陷，2026-09-17 / task-25）：`handoff_submit` 写入成功、但返回值 `code: null` 违反其
//   **自身** `output.schema` 的 `{"code":{"type":"string"}}` ⇒ 宿主抛
//   `tool "handoff_submit" returned invalid output: "value.code" must be a string`
//   ⇒ **假失败**（数据已落盘、调用方却以为失败，可能重试 ⇒ 重复交接）。
// 抽取缘由：该维度原在两处测试各自手写一份（`handoff-gate.test.js` / `p2-settle-handoff.test.js`）⇒
//   本模块为**唯一实现**，两处改为引用；后续新增工具/回显字段一律复用（禁再复制一份）。
//
// 两条口径（互补，共享同一调用签名）：
//   ① `schemaViolations` = **宿主同款校验的最小等价面**（覆盖本仓 `output.schema` 用到的全部关键字：
//      type / required / properties / additionalProperties / items / enum）——同步纯函数、零依赖，
//      用于夹具内的**逐条断言**；
//   ② `hostSchemaViolations` = 直接调**宿主真实**校验函数（`@deepseek-ai/dsh-tools` 的
//      `validateJsonSchemaValue`，与 `test/team-asset-snapshot.test.js:38` 同源）——用于普查的**交叉校验**；
//      宿主模块不可用时返回 `null`（调用方自判降级，不静默当"通过"）。
import assert from 'node:assert/strict';

/** 宿主同款校验的**最小等价面**：返回违例清单（空 = 通过）。
 *  @param value 被检值
 *  @param schema 工具描述里的 `output.schema`
 *  @param at 违例路径前缀（默认 `value`）
 */
export function schemaViolations(value, schema, at = 'value') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  const type = schema.type;
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'object') {
    if (!isObj) return [at + ' must be an object（实得 ' + JSON.stringify(value) + '）'];
    for (const r of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, r)) errs.push(at + '.' + r + ' is required');
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (!sub) {
        if (schema.additionalProperties === false) errs.push(at + '.' + k + ' is not allowed');
        continue;
      }
      errs.push(...schemaViolations(v, sub, at + '.' + k));
    }
    return errs;
  }
  if (type === 'string') { if (typeof value !== 'string') errs.push(at + ' must be a string（实得 ' + JSON.stringify(value) + '）'); }
  else if (type === 'boolean') { if (typeof value !== 'boolean') errs.push(at + ' must be a boolean（实得 ' + JSON.stringify(value) + '）'); }
  else if (type === 'integer') { if (!Number.isInteger(value)) errs.push(at + ' must be an integer（实得 ' + JSON.stringify(value) + '）'); }
  else if (type === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) errs.push(at + ' must be a number（实得 ' + JSON.stringify(value) + '）'); }
  else if (type === 'array') {
    if (!Array.isArray(value)) errs.push(at + ' must be an array（实得 ' + JSON.stringify(value) + '）');
    else if (schema.items) value.forEach((v, i) => errs.push(...schemaViolations(v, schema.items, at + '[' + i + ']')));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errs.push(at + ' must be one of ' + JSON.stringify(schema.enum));
  return errs;
}

/** 取工具**自身**的 `output.schema`（单一来源 = 工具描述；缺 ⇒ null，调用方须显式处理，禁静默跳过）。 */
export function outputSchemaOf(tool) {
  const s = tool?.output?.schema;
  return s && typeof s === 'object' ? s : null;
}

/** 断言：某工具的真实返回值满足其**自身** `output.schema`（违例即抛，信息带工具名与逐条违例）。 */
export function assertOutputConforms(tool, value, label = 'value') {
  const schema = outputSchemaOf(tool);
  assert.ok(schema, '前置：工具须暴露 output.schema（' + (tool?.name ?? '?') + '）');
  const v = schemaViolations(value, schema, 'value');
  assert.deepEqual(v, [], (tool?.name ?? 'tool') + ' ' + label + ' 返回值必须满足自身 output.schema：'
    + JSON.stringify(v));
}

/** 拒态判据：抛错**不得**是「返回值不满足 schema」形态的宿主校验错（否则即假失败/形态错位）。 */
export function assertRejectionIsNotSchemaError(err) {
  const msg = String(err?.message ?? err);
  assert.ok(!/invalid output/.test(msg), '拒态不得表现为宿主 invalid output：' + msg);
  assert.ok(!/must be a string|must be a boolean|must be an integer|must be an array/.test(msg),
    '拒态不得夹带 schema 型校验错：' + msg);
}

let hostMod = null;
let hostProbed = false;

/** 宿主**真实**校验函数（`@deepseek-ai/dsh-tools#validateJsonSchemaValue`）的口径；模块不可用 ⇒ null。 */
export async function hostSchemaViolations(value, schema, at = 'value') {
  if (!hostProbed) {
    hostProbed = true;
    try { hostMod = await import('@deepseek-ai/dsh-tools'); } catch { hostMod = null; }
  }
  const fn = hostMod?.validateJsonSchemaValue;
  if (typeof fn !== 'function') return null;
  const out = fn(schema, value, at);
  return Array.isArray(out) ? out : null;
}

/** 双口径交叉校验：返回 `{local, host, agree}`；宿主不可用时 `host:null` / `agree:null`。 */
export async function crossCheckConformance(value, schema, at = 'value') {
  const local = schemaViolations(value, schema, at);
  const host = await hostSchemaViolations(value, schema, at);
  return { local, host, agree: host === null ? null : (local.length === 0) === (host.length === 0) };
}
