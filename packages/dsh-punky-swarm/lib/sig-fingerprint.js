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

// lib/sig-fingerprint.js —— sig 任务内容指纹（N3-②）
//
// 定位（规格来源 = `docs/sig-fingerprint-design-2026-09-22.md` §1/§2 + 用户 D-sig-1..4 四项裁定）：
//   · **形式**：`WaveTask.sig` = 单任务内容指纹，随 wavePlan 持久化、可选字段、**不参与任何门禁判定**
//     （风格同既有 `owner` 可选字段）；
//   · **哈希构成**（D-sig-1 裁定 = **不含 `assemblyRef`**，只含任务信息）：
//     `sha256(canonicalJSON({ id, layer, role, deps, produce, outputs, cmd }))` 截 **16 hex**（D-sig-3 裁定）。
//     规范形态复用包内既有惯例（先例 = `lib/verify/selector.js` 的 `canonicalizeArgs` + `createHash('sha256')`；
//     另见 `lib/assembly/snapshot.js` 的 sha256 惯例）：对象键递归排序、**数组保序**（`deps` 顺序 = 声明顺序，
//     是语义面而非噪声）、`undefined`/`null` 空值在规范形态里**一致落为 `null`**（不落 `undefined`：
//     后者会被键排序剔键 ⇒ 「未写 layer」与「显式 layer:null」曾产生两个不同哈希）。
//   · **计算点唯一纪律**（D-sig-4 裁定）：唯一计算入口 = `buildWavePlan`（建批全量算）；
//     `addPoolTasks` 追加任务经同一次 `buildWavePlan` 重归一化 ⇒ 新任务补算、既有任务输入不变 ⇒ sig 不变；
//     `addTaskEdges` 加边经同一次重归一化 ⇒ 受影响任务（deps 变化）重算、**无关任务 sig 不变**；
//     已派发（`owner` 非空）任务在 `buildWavePlan` 内**冻结**（读旧 sig 原样落盘，见 `lib/wave-plan.ts`）。
//   · **判等面已退役**（用户裁决 Q-C = 乙 · 批 `punky-engine-fix-20261106` lane `e2-fix-b3`）：
//     原「同批次内存在 sig 相同且状态 ∈ {running, review, merged} 的其他 lane ⇒ 落一条留痕事件」
//     这条判等路径**整面删除**（删净 = 引用与定义一起消失，不是「名字没了但判等逻辑还在」）。
//     根因（已实核）：哈希输入**含 `id`**（`canonicalTaskForSig` 首键）而判等循环又**跳过同 `id`**
//     ⇒ 候选集结构性恒空 ⇒ 留痕事件**永不触发** —— 属「声明了一个不生效的判据」
//     （既有测试靠手工注入同 `sig` 才造出事件）。删净后 `sig` 只回答一个问题：
//     **「这条 lane 的持久字段长什么样」**（内容锚定 + 可重算校验），**不回答**「是否重复」。
//     `GateErrorCode` union 不因此新增/删除任何码。
//     **判红**（防判等面以别的形式装回来）：出现以 `sig` 为键的判重（含 `Map`/`Set` 按 sig 去重）。
//     注：本注释刻意**不写出**被删符号名与事件码字面量 —— 验收项要求 `lib test` 内该族名字**零命中**。
//
// 零依赖纪律：本模块**只 import node:crypto**——
//   它被 `lib/wave-plan.ts`（TS 源码）与 `lib/state/store.js`（手写 JS）**共同** import，
//   故必须保持零本包运行期依赖（避免循环：store ← wave-plan 已在既有导入图内）。
// 事件常量不在此 import：本模块**只产/只读 sig**，不登记任何事件码、不构造任何事件载荷。

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

// ── 判等面（原 N3-② 消费点）**已整面退役** ────────────────────────────────────────────────
//
// 删除清单（批 `punky-engine-fix-20261106` lane `e2-fix-b3`，用户裁决 Q-C = 乙）：
//   原 5 个判等符号（1 个状态白名单常量 + 4 个函数：判等 / 去重键 / 事件载荷 / 判定）
//   —— 连同其下游接线（`lib/state/store/events.js` 的判定包装、`lib/state/store/member.js`
//   的 `sigDup` 消费块、`lib/state/event-types.js` 的事件码常量）一并删净。
//   删净判据：**引用与定义一起消失**，不是「名字没了但判等逻辑还在」。
//   本注释刻意**不写出**被删符号名与事件码字面量：验收项要求该族名字在 `lib test` 内**零命中**
//   （`grep` 会把注释一并计入）⇒ 用「原 5 个判等符号」指代，具体名单见
//   `exec/e2-b3.md` 的删除面清单（产物面，不在被 grep 的 `lib`/`test` 内）。
//
// 保留并**加强**的一面（这才是 `sig` 在真用的一面）：哈希计算 + 读口径单点，
//   二者共同支撑「落盘 `sig` 可由持久字段**重算**并比对一致」（可重算校验由四个测试文件覆盖）。

