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


import { createHash } from 'node:crypto';

/** 指纹精度：16 hex（D-sig-3 裁定；先例 `selector.js` 为 12 hex，此处留更长内部判等碰撞余量）。 */
export const SIG_HEX_LEN = 16;

/** sig 形态判据（16 位小写 hex）：消费点/测试共用同一份正则，禁第二套口径。 */
export const SIG_PATTERN = /^[0-9a-f]{16}$/;

/**
 * 递归规范化：对象键递归排序（`{a:1,b:2}` 与 `{b:2,a:1}` 同哈希）；数组**保序**；`undefined` 剔除；
 * 标量原样（字符串/数字/布尔/null）。与 `lib/verify/selector.js#canonicalizeArgs` **同款语义**
 * （此为 sig 侧唯一实现，不改动 selector 侧冻结实现）。
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalizeForSig(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForSig);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = canonicalizeForSig(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

/**
 * 单任务 sig 的**规范形态**（哈希输入面；也是「字段敏感性」的可读举证面）。
 * 三态归一（消除「缺省」与「显式空」造成的伪差异）：
 *   · `layer` / `role`：非字符串（含缺省 / null）⇒ `null`；
 *   · `deps` / `produce` / `outputs`：非数组（含缺省 / null）⇒ `[]`（`deps` 顺序=声明顺序，保序不排序）；
 *   · `cmd`：非字符串 ⇒ `''`。
 * **不含 `assemblyRef`**；`role`/`skills` 经 `cmd` 进入（`cmd` 是持久面字段）。
 * `updatedAt` / `planRevision` / `owner` 等易变/派生元数据同样不入（D-sig-1 裁定：哈希只含任务信息）。
 * @param {Record<string, unknown>} task 任务对象（`WavePlanTaskInput` 或持久形态 `WavePlanTask` 均可）
 * @returns {{id: string, layer: string|null, role: string|null, deps: string[], produce: string[], outputs: string[], cmd: string}}
 */
export function canonicalTaskForSig(task) {
  const t = task ?? {};
  const strArr = (v) => (Array.isArray(v) ? [...v] : []);
  return {
    id: typeof t.id === 'string' ? t.id : '',
    layer: typeof t.layer === 'string' ? t.layer : null,
    role: typeof t.role === 'string' ? t.role : null,
    deps: strArr(t.deps),
    produce: strArr(t.produce),
    outputs: strArr(t.outputs),
    cmd: typeof t.cmd === 'string' ? t.cmd : '',
  };
}

/**
 * 计算任务内容指纹：`sha256(canonicalJSON(canonicalTaskForSig(task)))` 前 16 hex。
 * **纯函数**（零 IO、零副作用）：同输入恒同值、键序无关、数组保序。
 * @param {Record<string, unknown>} task
 * @returns {string} 16 位小写 hex
 */
export function computeTaskSig(task) {
  const canonical = canonicalTaskForSig(task);
  return createHash('sha256').update(JSON.stringify(canonicalizeForSig(canonical))).digest('hex').slice(0, SIG_HEX_LEN);
}

/** 落盘 sig 取值（唯一读取口径）：非 16 hex 形态（缺省 / 旧批无该字段 / 形态漂移）⇒ `null`。
 *  读取方**不得**自行判断 `typeof === 'string'`（那一口径会把任意脏串当真值）。 */
export function sigOf(task) {
  const raw = task?.sig;
  return typeof raw === 'string' && SIG_PATTERN.test(raw) ? raw : null;
}


