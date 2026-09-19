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

// assembly/chain.js —— 团队资产**推进链**（`chain`）声明：解析 + 加载期静态校验 + 拓扑查询（P2）。
// ─────────────────────────────────────────────────────────────────────────────
// 定位：`chain` 把「批内环节怎么顺次推进」从 Leader 手工派发搬进**每团队一份**的声明资产
//   （`presets/<team>/team-asset.yml`，规范位 = **顶层 `chain`**）。
//   本模块只做**纯函数**（无 IO、无副作用、不写盘）：解析 / 八条静态校验 / 拓扑查询。
//   写盘（`chain.step` 事件、`paused` 相位、自动派发）在 `lib/engine/chain-runner.js`；
//   构造期拒在 `lib/tools/core.js` 的 `wave_plan`（`createBatch` 之前 ⇒ 零批次 JSON 落盘）。
//
// 声明格式（与 `presets/engine-team/team-asset.yml:60-72` 同形；**规范位 = 顶层 `chain`**）：
//   chain: {
//     version: 1,
//     steps: [ { id, layer, role, next?|on?:{merged,fail,skipped,conflict}, join?:'all'|'any', terminal?:true } ],
//     join: { anyFailure: 'pause'|'review'|'failed' },
//     onFail: 'pause'|'review'|'failed',          // 缺省 'pause'
//     rework: { allowed: bool, max_attempts: int, escalate: 'human'|'none' },
//     needHuman: [<step id>],                     // 声明位（本批不接线；见文末「未接线子键」）
//   }
//
// 唯一规范位（Leader 裁决 ①，2026-09-16）：`chain` **只认顶层**。增补草案的 `flows.chain` 位
//   **不写兼容分支**（禁双真源）——显式声明 `flows.chain` 即拒（复用既有 `TEAM_ASSET_FIELD_NOT_ALLOWED`，
//   零新造码）。注：该键本就会在同一次加载里被 `flows` 的层名白名单命中（`TEAM_ASSET_LAYER_UNKNOWN`）；
//   此处独立报码是为了让「规范位」成为**机器可判**的规则，不靠读者记忆。
//
// 八条静态校验（逐条复用既有 `TEAM_ASSET_*` 码面，**零新造码**）：
//   ① 层白名单      step.layer ∈ layers 键集                        → TEAM_ASSET_LAYER_UNKNOWN
//   ② 角色悬空      step.role ∈ layers[step.layer].roles             → TEAM_ASSET_LEAD_NOT_IN_LAYERS
//   ③ 悬空 next/on  目标 id ∈ steps[].id                            → TEAM_ASSET_MISSING_FIELD
//   ④ 到不了的环节  自链首步沿 next/on 的可达集 = 全集（无孤儿步）      → TEAM_ASSET_MISSING_FIELD
//   ⑤ 环须由 rework 承认  存在回边 ⇒ rework.allowed===true；环数 ≤ max_attempts → TEAM_ASSET_REWORK_INVALID
//   ⑥ 链尾唯一      terminal:true 恰好一步                          → TEAM_ASSET_MISSING_FIELD
//   ⑦ join:any 必带 anyFailure  任一步 join==='any' ⇒ chain.join.anyFailure 必填 → TEAM_ASSET_MISSING_FIELD
//   ⑧ 只收枚举 token  on 键 ∈ {merged,fail,skipped,conflict}；onFail/anyFailure ∈ {pause,review,failed}；**禁表达式**
//                                                                    → TEAM_ASSET_FIELD_NOT_ALLOWED
//
// 条件边（**W1-②**，2026-09-16，蓝图 `docs/engine-reform-blueprint-20260916.md §W1-2`）：
//   `on` 的键域从 `{merged,fail}` 扩为**成员终态全体**（`lib/schema.js` 的 `merged/failed/skipped` +
//   `conflict`）⇒ 「跳过/冲突」等终态能被**显式路由**，不必只能走链级 `onFail`。**仍只收枚举、禁表达式**
//   （校验 ⑧ 原样复用 `looksLikeExpression`，零新造码）。三条硬锁：
//     ① **未声明即旧语义**：不声明 `on.skipped`/`on.conflict` ⇒ 行为与今日**逐字不变**
//        （`skipped` 不推进；`conflict` 走失败面 = `on.fail` → `anyFailure` → 链级 `onFail`）；
//     ② **v1 语义逐字不变**：v1 资产不声明新键 ⇒ 零差异（v2 亦然——键域扩展**不按版本分档**，
//        因为它是**值域扩展**而非拓扑新键：未声明的资产拓扑不变）；
//     ③ **`via` 取值族同步**：`on.skipped`/`on.conflict` 已进 `CHAIN_STEP_VIA`（读端白名单，
//        见 `lib/engine/chain-runner.js` 的 `chainStepPayload`——漏加会把载荷 `via` 静默写成 `null`）。
//   判定优先级（单点在 `chainNextOf`，禁第二套）：
//     · `merged`   → `next` → `on.merged`（v1/v2 原样）
//     · `failed`   → `on.fail` → `join:any` 的 `anyFailure` → 链级 `onFail`（原样）
//     · `conflict` → **`on.conflict`（新，最具体）** → 未声明则**逐字沿用 failed 的老路径**
//     · `skipped`  → **`on.skipped`（新）** → 未声明则**不推进**（`reason:'skipped-no-advance'`）
//
// 「加载期」口径（本模块与 spec 的对齐）：八条校验是**纯函数**（无 IO、无副作用），加载期语义
//   由**单一强制点**承载 = 构造期（`wave_plan`，`createBatch` 之前 ⇒ 拒后零批次 JSON 落盘）。
//   **刻意不折进 `validateTeamAsset`**：那里的码面走 `BLOCKING_CODES` 严重级分档，而本组码里
//   `LEAD_NOT_IN_LAYERS` / `REWORK_INVALID` 是 warning 级 —— 折进去会让「同一份声明」经两条严重级
//   通道重复报告。改为：纯校验器单点（本模块）+ 构造期原样透出首个问题码（与 P1 `assertTeamAssetReady`
//   同形的 fail-closed 形态）。
//
// 缺省口径（R5 向后兼容锁）：**无 `chain` 声明 ⇒ 不做任何推进**（引擎缺省退化链 = 现行 3 层直线链
//   `plan→exec→audit`，字段映射/门禁/事件逐字不变）；无链即无推进 ⇒ 不写 `chain.step`、
//   读端（`batch_status`）也不出现回显字段。
//
// 未接线子键（显式登记，禁「写了不生效」的静默）：`chain.needHuman`（链级人工闸提示）本批**只声明不消费**
//   —— 人工闸的既有承载面 = 层声明 `flows.audit.needhuman` + Tier3 `checkNeedHumanGate`，本键暂无读端。
//   接线归后续批（P4 接口面）。此处**不**登记进 `UNWIRED_DECLARATIONS`（那是顶层键台账，`chain` 已接线）。

import { TEAM_ASSET_CODES, severityOfProblem, loadTeamAsset } from './team-asset.js';
import { packageRoot } from './flows.js';

/** 声明版本白名单：**v1 = 单路径链**（既有口径，向后兼容硬锁）；**v2 = DAG 边 + 分支配对**（P4a-pre）。
 *  ∈/∉ 白名单 ⇒ 拒，复用 `TEAM_ASSET_BAD_TYPE`（零新造码）。设计与语义见
 *  `docs/chain-model-upgrade-spec-20260916.md`。 */
export const CHAIN_VERSIONS = Object.freeze([1, 2]);
/** v1（既有缺省口径；`CHAIN_VERSIONS[0]` = 缺省语义版本）。 */
export const CHAIN_VERSION = 1;
/** `join` 合法枚举（步级汇合语义：all = 全 merged 才推进；any = 首个 merged 即推进）。 */
export const CHAIN_JOINS = Object.freeze(['all', 'any']);
/** `onFail` / `join.anyFailure` 合法 token（**只收枚举、禁表达式**）。 */
export const CHAIN_ON_FAIL_TOKENS = Object.freeze(['pause', 'review', 'failed']);
/** `on` 的合法键（分支面：merged / fail / **skipped / conflict**）。**值域扩展 = W1-② 条件边**：
 *  键域对齐「成员终态」全体（`lib/schema.js`：`merged`/`failed`→`fail`/`skipped` + `conflict`），
 *  使每个终态都能被**显式路由**。**仍只收枚举 token，禁表达式**（校验 ⑧ 未变）。 */
export const CHAIN_ON_TOKENS = Object.freeze(['merged', 'fail', 'skipped', 'conflict']);
/** `chain.step` 事件的 `via` 取值全集（推进命中的分支）。**这是读端白名单**：
 *  `chainStepPayload`（`lib/engine/chain-runner.js`）用它把不在册的 `via` 写成 `null`（静默失能）
 *  ⇒ **新增分支边必须同步本表**（W1-② 已补 `on.skipped` / `on.conflict`）。 */
export const CHAIN_STEP_VIA = Object.freeze(['next', 'on.merged', 'on.fail', 'on.skipped', 'on.conflict', 'onFail', 'anyFailure']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
/** 表达式探测（check ⑧「禁表达式」）：声明面只收**裸 token/id**，不收模板/比较/逻辑运算。 */
const looksLikeExpression = (s) => /[$<>{}()\[\]!?|&]|==|!=|&&|\|\|/.test(s);

/** 步级分支边的产出口（纯函数）：`next` → 'next'；`on.<token>` → 'on.<token>'。 */
export function edgesOfStep(step) {
  const out = [];
  if (!isPlainObject(step)) return out;
  if (isNonEmptyString(step.next)) out.push({ from: step.id, to: step.next, via: 'next' });
  if (isPlainObject(step.on)) {
    for (const [k, v] of Object.entries(step.on)) {
      if (isNonEmptyString(v)) out.push({ from: step.id, to: v, via: 'on.' + k });
    }
  }
  return out;
}

/**
 * 解析声明位（**只认顶层 `chain`**）：返回原始声明 + 「位置非法」问题（不做八条校验）。
 * @param asset `loadTeamAsset().asset`（`validateTeamAsset` 入参同形）
 * @returns {{chain: object|null, problems: Array<object>}}
 */
export function resolveChainOf(asset) {
  const problems = [];
  if (!isPlainObject(asset)) return { chain: null, problems };
  // 唯一规范位（Leader 裁决 ①）：`flows.chain` **不是**声明位，不解析、不合并、不留兼容分支。
  const flowsChain = isPlainObject(asset.flows) ? asset.flows.chain : null;
  if (flowsChain != null) {
    problems.push({
      code: TEAM_ASSET_CODES.FIELD_NOT_ALLOWED,
      path: 'flows.chain',
      message: '`chain` 的唯一规范位是**顶层** `chain`（`presets/<team>/team-asset.yml` 与顶层平级）；'
        + '`flows.chain` 不是声明位（禁双真源，不设兼容分支）——请把声明移到顶层。',
      severity: severityOfProblem({ code: TEAM_ASSET_CODES.FIELD_NOT_ALLOWED }),
    });
  }
  return { chain: asset.chain == null ? null : asset.chain, problems };
}

/**
 * 八条静态校验（纯函数）。
 * @param chain 顶层 `chain` 声明对象
 * @param layers `asset.layers`（`{ <layer>: { roles: [...] } }`）；非对象 ⇒ ①② 由 `validateTeamAsset`
 *   的 `layers` 必填面承担（本函数不重复报码，避免同一声明双报）
 * @returns {{ok: boolean, problems: Array<{code,path,message,severity}>}}
 */
export function validateChain(chain, layers) {
  const problems = [];
  const push = (code, path, message) => problems.push({ code, path, message, severity: severityOfProblem({ code }) });

  if (!isPlainObject(chain)) {
    push(TEAM_ASSET_CODES.BAD_TYPE, 'chain', 'chain 必须是对象（未声明 ⇒ 不写本键 = 不做推进）');
    return { ok: false, problems };
  }
  if (!CHAIN_VERSIONS.includes(chain.version)) {
    push(TEAM_ASSET_CODES.BAD_TYPE, 'chain.version', `chain.version 必须是 ${CHAIN_VERSIONS.join('|')}（收到：${JSON.stringify(chain.version ?? null)}）`);
  }
  if (!Array.isArray(chain.steps) || chain.steps.length === 0) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'chain.steps', 'chain.steps 必填（非空数组）');
    return { ok: false, problems };
  }

  // 步形状 + id 唯一（后续各条校验的前提面）
  const byId = new Map();
  const order = [];
  for (let i = 0; i < chain.steps.length; i++) {
    const s = chain.steps[i];
    const at = `chain.steps[${i}]`;
    if (!isPlainObject(s)) { push(TEAM_ASSET_CODES.BAD_TYPE, at, '链步必须是对象'); continue; }
    if (!isNonEmptyString(s.id)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.id`, '步 id 必填（非空字符串）'); continue; }
    if (byId.has(s.id)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `${at}.id`, `步 id 重复：${s.id}（id 唯一）`); continue; }
    byId.set(s.id, s);
    order.push(s.id);
  }
  if (byId.size === 0) return { ok: false, problems };

  // ⑨【v2 新增 · P4a-pre 2026-09-16】分支配对 `perLane` 与显式 DAG 边 `deps`（**结构面**校验）
  //   · **仅 `version: 2` 允许声明**；v1 声明即拒（`FIELD_NOT_ALLOWED`）——「v1 语义逐字不变」是硬锁，
  //     防止老资产被新键悄悄改变拓扑。
  //   · 此处只判「形状 + 悬空 + 自指 + 重复」；**实例化与推进语义**在 `lib/engine/chain-runner.js`
  //     （本模块是纯函数面，不碰 lane/事件/相位）。两键意义见 `docs/chain-model-upgrade-spec-20260916.md §2.1`。
  const isV2 = chain.version === 2;
  for (const [id, s] of byId) {
    if (s.perLane !== undefined) {
      if (!isV2) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.perLane`,
          'perLane 仅 chain.version=2 允许（v1 语义逐字不变：请先升 version）');
      } else if (!isNonEmptyString(s.perLane) || !byId.has(s.perLane)) {
        push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.perLane`,
          `perLane 目标悬空：${JSON.stringify(s.perLane ?? null)} 不在 steps[].id（${order.join('/')}）`);
      } else if (s.perLane === id) {
        push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.perLane`,
          'perLane 不得指向自身（自身实例化没有可展开的上游 lane）');
      }
    }
    if (s.deps !== undefined) {
      if (!isV2) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.deps`,
          'deps 仅 chain.version=2 允许（v1 语义逐字不变：请先升 version）');
      } else if (!Array.isArray(s.deps) || s.deps.length === 0) {
        push(TEAM_ASSET_CODES.BAD_TYPE, `chain.steps.${id}.deps`,
          'deps 必须是**非空**数组（不声明 = 沿用 next/on 拓扑）');
      } else {
        const seenDep = new Set();
        for (const d of s.deps) {
          if (!isNonEmptyString(d) || !byId.has(d)) {
            push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.deps`,
              `悬空依赖：${JSON.stringify(d ?? null)} 不在 steps[].id（${order.join('/')}）`);
            continue;
          }
          if (d === id) { push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.deps`, 'deps 不得自指'); continue; }
          if (seenDep.has(d)) { push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.deps`, `重复依赖：${d}`); continue; }
          seenDep.add(d);
        }
      }
    }
  }

  // ①② 层白名单 / 角色悬空
  const hasLayers = isPlainObject(layers);
  const layerKeys = hasLayers ? Object.keys(layers) : [];
  for (const [id, s] of byId) {
    if (!hasLayers) break; // 缺 layers ⇒ validateTeamAsset 的 layers 必填面已拒，不重复报
    if (!isNonEmptyString(s.layer) || !layerKeys.includes(s.layer)) {
      push(TEAM_ASSET_CODES.LAYER_UNKNOWN, `chain.steps.${id}.layer`,
        `未知层：${JSON.stringify(s.layer ?? null)}（允许：${layerKeys.join('/') || '（无）'}）`);
      continue; // 层未定 ⇒ 角色判据无意义，跳过（避免级联双报）
    }
    const def = layers[s.layer];
    const roles = isPlainObject(def) && Array.isArray(def.roles) ? def.roles.map((r) => String(r).trim().toLowerCase()) : [];
    if (!isNonEmptyString(s.role) || !roles.includes(String(s.role).trim().toLowerCase())) {
      push(TEAM_ASSET_CODES.LEAD_NOT_IN_LAYERS, `chain.steps.${id}.role`,
        `步角色悬空：role=${JSON.stringify(s.role ?? null)} 不在 layers.${s.layer}.roles（${roles.join('/') || '（无）'}）`);
    }
  }

  // ③ 悬空 next / on 目标（先收集边，④⑤ 复用）
  const edges = [];
  for (const [id, s] of byId) {
    if (isPlainObject(s.on)) {
      for (const [k, v] of Object.entries(s.on)) {
        // 键的非枚举面归 ⑧；此处只判**目标悬空**（值形态非法时也归 ⑧，避免双报）
        if (CHAIN_ON_TOKENS.includes(k) && isNonEmptyString(v) && !byId.has(v)) {
          push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.on.${k}`,
            `悬空目标：${v} 不在 steps[].id（${order.join('/')}）`);
        }
      }
    }
    if (isNonEmptyString(s.next) && !byId.has(s.next)) {
      push(TEAM_ASSET_CODES.MISSING_FIELD, `chain.steps.${id}.next`,
        `悬空目标：${s.next} 不在 steps[].id（${order.join('/')}）`);
    }
    for (const e of edgesOfStep(s)) if (byId.has(e.to) && e.to !== e.from) edges.push(e);
    // v2：显式依赖边（dep → 本步）与 `perLane` 隐式入边（上游步 → 本步）。二者**只进拓扑面**
    //   （④ 可达 / ⑤ 环检测 / 聚合顺序），**不参与** `chain.step.via` 取值（`CHAIN_STEP_VIA` 不含
    //   `deps`/`perLane` ⇒ 不会泄漏到事件载荷）。
    if (Array.isArray(s.deps)) {
      for (const d of s.deps) if (isNonEmptyString(d) && byId.has(d) && d !== id) edges.push({ from: d, to: id, via: 'deps' });
    }
    if (isNonEmptyString(s.perLane) && byId.has(s.perLane) && s.perLane !== id) {
      edges.push({ from: s.perLane, to: id, via: 'perLane' });
    }
  }

  // ④ 到不了的环节（自链首步可达集 = 全集）
  const adj = new Map(order.map((id) => [id, []]));
  for (const e of edges) adj.get(e.from).push(e.to);
  const seen = new Set([order[0]]);
  const stack = [order[0]];
  while (stack.length) {
    for (const nx of adj.get(stack.pop()) ?? []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
  }
  const orphans = order.filter((id) => !seen.has(id));
  if (orphans.length > 0) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'chain.steps',
      `自链首步（${order[0]}）沿 next/on 不可达的孤儿步：${orphans.join(', ')}（可达集须 = steps[] 全集）`);
  }

  // ⑤ 环须由 rework 承认（回边计数 ≤ rework.max_attempts）
  const color = new Map(); // 0 未访问 / 1 在栈上 / 2 已完成
  let backEdges = 0;
  const dfs = (id) => {
    color.set(id, 1);
    for (const nx of adj.get(id) ?? []) {
      const c = color.get(nx) ?? 0;
      if (c === 1) backEdges++;            // 指向「在栈上」的节点 = 回边（环）
      else if (c === 0) dfs(nx);
    }
    color.set(id, 2);
  };
  for (const id of order) if ((color.get(id) ?? 0) === 0) dfs(id);
  const rw = isPlainObject(chain.rework) ? chain.rework : null;
  if (backEdges > 0) {
    if (!rw || rw.allowed !== true) {
      push(TEAM_ASSET_CODES.REWORK_INVALID, 'chain.rework',
        `链内存在 ${backEdges} 条回边（环），须由 \`rework.allowed: true\` 承认（当前：${JSON.stringify(chain.rework ?? null)}）`);
    } else if (!Number.isInteger(rw.max_attempts) || rw.max_attempts < 1) {
      push(TEAM_ASSET_CODES.REWORK_INVALID, 'chain.rework.max_attempts',
        `有回边 ⇒ max_attempts 必填（正整数）；收到：${JSON.stringify(rw.max_attempts ?? null)}`);
    } else if (backEdges > rw.max_attempts) {
      push(TEAM_ASSET_CODES.REWORK_INVALID, 'chain.rework.max_attempts',
        `链内环数 ${backEdges} 超 rework.max_attempts=${rw.max_attempts}（回边须被返工预算承认）`);
    }
  }

  // ⑥ 链尾唯一（terminal:true 恰好一步）
  const terminals = [...byId.values()].filter((s) => s.terminal === true).map((s) => s.id);
  if (terminals.length !== 1) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'chain.steps',
      `链尾（terminal:true）须**恰好一步**，当前 ${terminals.length} 个：${terminals.join('/') || '（无）'}`);
  }

  // ⑦ join:any 必带 anyFailure
  const anySteps = [...byId.values()].filter((s) => s.join === 'any').map((s) => s.id);
  const anyFailure = isPlainObject(chain.join) ? chain.join.anyFailure : undefined;
  if (anySteps.length > 0 && anyFailure == null) {
    push(TEAM_ASSET_CODES.MISSING_FIELD, 'chain.join.anyFailure',
      `步 ${anySteps.join('/')} 声明 join:'any' ⇒ chain.join.anyFailure 必填（落败分支的收口口径）`);
  }

  // ⑧ 只收枚举 token（on 键 / onFail / anyFailure / join 值；禁表达式）
  if (chain.on != null) push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, 'chain.on', '`on` 只允许出现在 step 内（步级分支面）');
  if (chain.join != null && !isPlainObject(chain.join)) {
    push(TEAM_ASSET_CODES.BAD_TYPE, 'chain.join', 'chain.join 必须是对象（{ anyFailure }）');
  }
  const tokenAt = (path, value) => {
    if (value == null) return;
    if (typeof value !== 'string' || looksLikeExpression(value) || !CHAIN_ON_FAIL_TOKENS.includes(value)) {
      push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, path,
        `${path} 只收枚举 token ${CHAIN_ON_FAIL_TOKENS.join('/')}（禁表达式；收到：${JSON.stringify(value)}）`);
    }
  };
  tokenAt('chain.onFail', chain.onFail);
  tokenAt('chain.join.anyFailure', anyFailure);
  for (const [id, s] of byId) {
    if (s.join != null && !CHAIN_JOINS.includes(s.join)) {
      push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.join`,
        `join 只收 ${CHAIN_JOINS.join('/')}（收到：${JSON.stringify(s.join)}）`);
    }
    if (s.on == null) continue;
    if (!isPlainObject(s.on)) { push(TEAM_ASSET_CODES.BAD_TYPE, `chain.steps.${id}.on`, 'on 必须是对象（{merged,fail}）'); continue; }
    for (const [k, v] of Object.entries(s.on)) {
      if (!CHAIN_ON_TOKENS.includes(k)) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.on.${k}`,
          `on 键只收 ${CHAIN_ON_TOKENS.join('/')}（收到：${JSON.stringify(k)}）`);
        continue;
      }
      if (typeof v !== 'string' || looksLikeExpression(v)) {
        push(TEAM_ASSET_CODES.FIELD_NOT_ALLOWED, `chain.steps.${id}.on.${k}`,
          `on.${k} 只收步 id 字面量（禁表达式；收到：${JSON.stringify(v)}）`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/** 解析 + 校验（纯函数，`asset` 入参同 `validateTeamAsset`）：`{ chain, problems, ok }`。 */
export function chainProblemsOf(asset) {
  const resolved = resolveChainOf(asset);
  if (resolved.chain == null) return { chain: null, problems: resolved.problems, ok: resolved.problems.length === 0 };
  const v = validateChain(resolved.chain, isPlainObject(asset) ? asset.layers : null);
  const problems = [...resolved.problems, ...v.problems];
  return { chain: resolved.chain, problems, ok: problems.length === 0 };
}

/**
 * 按批次解析该团队的推进链（**根解析优先级与门禁/快照同源**：批次 `teamsRoot` → 包根）。
 * 无资产 / 资产无 `chain` ⇒ `chain:null`（= 无推进，向后兼容锁）。
 * @returns {{ok: boolean, chain: object|null, problems: Array<object>, path: string|null, root: string}}
 */
export function loadChainOf({ team, teamsRoot = null } = {}) {
  const root = teamsRoot ?? packageRoot();
  if (!isNonEmptyString(team)) return { ok: false, chain: null, problems: [], path: null, root };
  const r = loadTeamAsset(root, team);
  if (!r.ok || !r.asset) return { ok: false, chain: null, problems: r.problems ?? [], path: r.path ?? null, root };
  const c = chainProblemsOf(r.asset);
  return { ok: c.ok, chain: c.chain, problems: c.problems, path: r.path ?? null, root };
}

/** 批次侧便捷读端（`batch.team` + `batch.teamsRoot`；无 team ⇒ 无链）。 */
export function chainOfBatch(batch) {
  const team = isPlainObject(batch) ? batch.team : null;
  if (!isNonEmptyString(team)) return { ok: false, chain: null, problems: [], path: null, root: packageRoot() };
  return loadChainOf({ team, teamsRoot: isNonEmptyString(batch.teamsRoot) ? batch.teamsRoot : null });
}

// ── lane → step 映射（fail-closed，禁猜） ─────────────────────────────────────
// 规则（Leader 裁决 ④，2026-09-16）：
//   ① `step.id === lane.id` **优先**（显式命名即显式归属）；
//   ② 否则按 `(layer, role)` 命中链步 —— **多 lane 命中同一步 = 同层共享该步**，
//      推进时机由该步的 `join` 决定（engine-team 的双 exec lane 因此不歧义）；
//   ③ 同一 `(layer, role)` 命中 **≥2 个不同 step** ⇒ **歧义**（fail-closed，调用方停轮）；
//   ④ 无命中 ⇒ 链外 lane（手工派发语义不变，不参与推进）。
/**
 * @returns {{ok: boolean, step: object|null, reason: string|null}}
 *   `ok:false` + `reason:'ambiguous-mapping'` = 歧义（调用方须停轮）；`step:null` = 链外 lane。
 */
export function chainStepForLane(chain, laneId, { layer = null, role = null } = {}) {
  if (!isPlainObject(chain) || !Array.isArray(chain.steps)) return { ok: true, step: null, reason: null };
  const steps = chain.steps.filter((s) => isPlainObject(s) && isNonEmptyString(s.id));
  if (isNonEmptyString(laneId)) {
    const byId = steps.find((s) => s.id === laneId);
    if (byId) return { ok: true, step: byId, reason: null };
  }
  if (!isNonEmptyString(layer) || !isNonEmptyString(role)) return { ok: true, step: null, reason: null };
  const hits = steps.filter((s) => s.layer === layer && String(s.role ?? '').toLowerCase() === String(role).toLowerCase());
  if (hits.length === 0) return { ok: true, step: null, reason: null };
  const distinct = new Set(hits.map((s) => s.id));
  if (distinct.size > 1) {
    return { ok: false, step: null, reason: 'ambiguous-mapping: (' + layer + ',' + role + ') 命中 ' + distinct.size + ' 个链步（' + [...distinct].join('/') + '）' };
  }
  return { ok: true, step: hits[0], reason: null };
}

/**
 * 某链步在**本批 wavePlan 内**对应的 lane 集（顺序 = wavePlan 顺序）。
 * 语义：lane→step 映射（`chainStepForLane`）的**反向投影**——不存在于本批的链步 ⇒ 空集
 * （推进目标无 lane 时调用方停轮上报，**绝不新造 lane / 不改 wavePlan 分层**，RK2）。
 * @param tasks 本批全部任务（`wavePlan[].tasks` 拍平）
 */
export function chainLanesOfStep(chain, stepId, tasks) {
  const lanes = [];
  let ambiguous = null;
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!isPlainObject(t) || !isNonEmptyString(t.id)) continue;
    const m = chainStepForLane(chain, t.id, { layer: t.layer, role: t.role });
    if (!m.ok) { ambiguous = ambiguous ?? m.reason; continue; }
    if (m.step && m.step.id === stepId) lanes.push(t.id);
  }
  return { lanes, ambiguous };
}

/** 【v2 · P4a-pre】`perLane` 目标步查询（纯函数）：`stepId` 的后继中若有声明 `perLane === stepId` 的步，
 *  返回该步；否则 `null`。用途 = `chain-runner` 判定「本跳是否要走**分支级 1:1**（不作同层汇合等待）」。 */
export function perLaneTargetOf(chain, stepId) {
  if (!isPlainObject(chain) || !Array.isArray(chain.steps) || !isNonEmptyString(stepId)) return null;
  const hit = chain.steps.find((s) => isPlainObject(s) && s.perLane === stepId && s.id !== stepId);
  return hit ?? null;
}

/** 【v2 · P4a-pre】配对 lane 解析（纯函数，**禁猜**）：在 `targetLanes` 中找 `deps` **恰为** `[sourceLane]`
 *  的那条 lane —— 判据 = wavePlan 任务自带的 `deps`（Batch II 的 `submit_batch` 会按 `pair` 模板为每个
 *  上游 lane 生成一条 `deps:[<上游 lane>]` 的配对 lane）。
 *  找不到 ⇒ 返回 `null`；调用方须**停轮上报**（不顺序兜底、不静默改派、不新造 lane —— RK2 禁改分层）。 */
export function pairedLaneOf(targetLanes, sourceLane, tasks) {
  if (!isNonEmptyString(sourceLane)) return null;
  const ids = Array.isArray(targetLanes) ? targetLanes : [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!isPlainObject(t) || !isNonEmptyString(t.id)) continue;
    if (!ids.includes(t.id)) continue;
    const deps = Array.isArray(t.deps) ? t.deps.filter(isNonEmptyString) : [];
    if (deps.length === 1 && deps[0] === sourceLane) return t.id;
  }
  return null;
}

/** 本批全部任务（`wavePlan[].tasks` 拍平；`wavePlan` 存的是 **wave 数组**，见 `lane_dispatch` 注释）。 */
export function flatTasksOf(batch) {
  const wp = isPlainObject(batch) ? batch.wavePlan : null;
  if (!Array.isArray(wp)) return [];
  const out = [];
  for (const w of wp) for (const t of (isPlainObject(w) && Array.isArray(w.tasks)) ? w.tasks : []) if (isPlainObject(t)) out.push(t);
  return out;
}

// ── 推进判定（纯函数：给定「已结算的 lane + 结果」，算下一环） ────────────────────
/**
 * @param chain   顶层 chain 声明
 * @param step    触发步（`chainStepForLane` 命中）
 * @param outcome `'merged'|'failed'|'conflict'|'skipped'`
 * @param opts.stepLanes 触发步在本批的 lane 集（`chainLanesOfStep`）
 * @param opts.laneStates `{ [lane]: state }`（批次 `batch.lanes`）
 * @returns {{action:'advance'|'pause'|'hold'|'wait'|'none', to:string|null, via:string|null,
 *            pending?:string[], reason:string|null}}
 *   `advance` = 推进到 `to` 步；`pause` = 停轮且**批次转 paused**；`hold` = 停轮但**不改批次相位**
 *   （`onFail` 的 review/failed 两 token：交还 Leader/Manager 裁决，引擎不自动判死）；
 *   `wait` = 汇合未齐（`join:all` 尚有未结算 lane）；`none` = 不推进（链外/链尾/skipped **未声明显式边**）。
 */
export function chainNextOf(chain, step, outcome, { stepLanes = [], laneStates = {}, reworkAttempts = 0 } = {}) {
  if (!isPlainObject(chain) || !isPlainObject(step)) return { action: 'none', to: null, via: null, reason: 'no-step' };

  // ── `skipped` 的路由边界（**W1-② 规则写死，禁各读各写**）─────────────────────────────────────
  //   ① **显式声明优先**：步声明了 `on.skipped`（非空字符串）⇒ 按该显式边推进
  //      （`action:'advance'`、`via:'on.skipped'`）——跳过是**作者签过字的路由决定**。
  //   ② **未声明 = 旧语义逐字不变**：`{action:'none', reason:'skipped-no-advance'}`（含 `join:'all'` 的
  //      「skipped 视为未完成」口径）。**本规则只覆盖「触发面」**（该 lane 自己结算 `skipped` 时是否推进），
  //      **不改「汇合面」**：`join:'all'` 下某兄弟 lane 结算 `skipped` 后，另一 lane 结算 `merged` 时
  //      仍把它算 `pending` ⇒ `wait`（`merged` 分支的 `pending` 过滤未变）。
  //      理由：汇合面是**该步**的合并语义（作者已用 `join` 声明），条件边是**边**的语义；两者正交，
  //      改汇合面会静默改变既有 v1/v2 资产的推进时机（违硬锁①）。
  //   ③ 已知边界（登记，不静默）：`join:'any'` 的步同时声明 `on.skipped` 时，跳过会先推进一次、
  //      其后某个 `merged` 仍会再推进一次（`join:any` 本就「首个成功即推进」）——**由资产作者负责**，
  //      引擎不额外加互斥（加锁需新增批字段 = 越出本次改动面）。
  //   ④ `skipped` 显式边**不占返工预算**（`rework.max_attempts` 只管失败面的重入，跳过不是失败重试）。
  if (outcome === 'skipped') {
    const to = isPlainObject(step.on) && typeof step.on.skipped === 'string' ? step.on.skipped : null;
    if (to) return { action: 'advance', to, via: 'on.skipped', reason: null };
    return { action: 'none', to: null, via: null, reason: 'skipped-no-advance' };
  }

  const join = step.join === 'any' ? 'any' : 'all'; // 缺省 all（spec §推进规则）
  const rw = isPlainObject(chain.rework) ? chain.rework : null;
  const maxAttempts = Number.isInteger(rw?.max_attempts) ? rw.max_attempts : 0;

  if (outcome === 'merged') {
    // 汇合闸：`join:all` 须同一步全部 lane 已 merged（skipped 视为**未完成**，不推进）
    if (join === 'all') {
      const pending = stepLanes.filter((l) => (laneStates[l] ?? 'pending') !== 'merged');
      if (pending.length > 0) return { action: 'wait', to: null, via: null, pending, reason: 'join-all-pending' };
    }
    if (typeof step.next === 'string' && step.next) return { action: 'advance', to: step.next, via: 'next', reason: null };
    if (isPlainObject(step.on) && typeof step.on.merged === 'string' && step.on.merged) {
      return { action: 'advance', to: step.on.merged, via: 'on.merged', reason: null };
    }
    return { action: 'none', to: null, via: null, reason: 'chain-end' }; // 链尾（terminal）或未声明后继
  }

  // 失败面（failed / conflict）：命中最具体的分支，顺序 = 步级 `on.conflict`（**仅 conflict**）
  //   → 步级 `on.fail` → `join:any` 的 `anyFailure` → 链级 `onFail`。
  //   `on.conflict`（**W1-② 新增**）只对 `conflict` 生效：`failed` 仍逐字走原路径（即便声明了 `on.conflict`）；
  //   未声明 `on.conflict` ⇒ `conflict` **逐字沿用旧口径**（与 `failed` 同路 ⇒ 走 `on.fail`/失败面）。
  //   命中后与 `on.fail` **共用同一段后处理**（枚举 token ⇒ pause/hold；步 id ⇒ 返工预算硬限后 advance）
  //   ⇒ 语义一致、零第二套。
  const tokenOfAnyFailure = isPlainObject(chain.join) ? chain.join.anyFailure : null;
  const tokenOfOnFail = typeof chain.onFail === 'string' ? chain.onFail : 'pause'; // 缺省 pause（停轮上报）
  let via = null;
  let to = null;
  if (outcome === 'conflict' && isPlainObject(step.on) && typeof step.on.conflict === 'string' && step.on.conflict) {
    via = 'on.conflict'; to = step.on.conflict;
  } else if (isPlainObject(step.on) && typeof step.on.fail === 'string' && step.on.fail) {
    via = 'on.fail'; to = step.on.fail;
  } else if (join === 'any' && typeof tokenOfAnyFailure === 'string' && tokenOfAnyFailure) {
    via = 'anyFailure'; to = tokenOfAnyFailure;
  } else {
    via = 'onFail'; to = tokenOfOnFail;
  }
  if (CHAIN_ON_FAIL_TOKENS.includes(to)) {
    // 枚举 token（非步 id）：pause ⇒ 批次 paused（停轮上报，不写 failed、不 abort）；
    // review/failed ⇒ 只留痕停轮（不改相位，处置交还 Leader/Manager）。
    return { action: to === 'pause' ? 'pause' : 'hold', to: null, via, reason: 'onFail-' + to };
  }
  // 回边（on.fail / on.conflict 指向步 id）：返工预算硬限——超限停轮（绝不改 wavePlan 分层，RK2）
  if (maxAttempts > 0 && reworkAttempts >= maxAttempts) {
    return { action: 'pause', to: null, via, reason: 'rework-max-attempts(' + reworkAttempts + '/' + maxAttempts + ')' };
  }
  return { action: 'advance', to, via, reason: null };
}

// ── 读端回显投影（`batch_status`；RK1） ───────────────────────────────────────
/**
 * `chain` 回显面：`{ version, steps[], lastStep, edges[{from,to,via}] }`。
 * 无链 ⇒ `null`（读端**不出现**回显字段——无链即无推进，零差异）。
 * 事件面取值 = 批次事件流里的 `chain.step`（**唯一事实源**，不另设内存态）。
 */
export function chainEchoOf(batch, chain) {
  if (!isPlainObject(chain)) return null;
  const events = (Array.isArray(batch?.events) ? batch.events : []).filter((e) => e && e.type === 'chain.step');
  const edges = [];
  const seen = new Set();
  for (const e of events) {
    const key = String(e.from) + '→' + String(e.to) + '#' + String(e.via);
    if (seen.has(key)) continue; // 图语义去重（重复命中次数由事件流本身可核：log_export）
    seen.add(key);
    edges.push({ from: e.from ?? null, to: e.to ?? null, via: e.via ?? null });
  }
  const last = events.length ? events[events.length - 1] : null;
  return {
    version: chain.version ?? null,
    steps: Array.isArray(chain.steps) ? chain.steps : [],
    lastStep: last ? { from: last.from ?? null, to: last.to ?? null, via: last.via ?? null, lane: last.lane ?? null } : null,
    edges,
  };
}
