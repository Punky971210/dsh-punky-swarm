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

// 难度评估工具（自 `lib/tools/core.js` **原样搬移**）：assign_check。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './shared.js';
import { assertModeActive } from './tier-gate.js';

/** 难度档位序（rank）：D=4 > C=3 > B=2 > A=1 > 未知/缺失=0 —— **全仓唯一 rank 真源**（模块级单点导出）。
 *  动机（本批 `assign-tier-downgrade-guard`，判据源 L-AC-8）：原为 `assign_check.execute` 内的函数局部常量，
 *  模块外不可复用；「在跑批不降档守卫」必须与「镜像路径 Q4=B 只升不降」的判据**同源** ⇒ 提为模块级单点，
 *  **禁**在第二处复制粘贴本映射表（`lib/**` 内该形态的重复实现数须恒为 0）。
 *  P-2：D 最强（D 蕴含 C 全部 + team 通道）。 */
export const tierRank = (t) => (t === 'D' ? 4 : t === 'C' ? 3 : t === 'B' ? 2 : t === 'A' ? 1 : 0);

/** 准入档（三阶）：A=1 < B=2 < {C,D}=3 —— C 与 D **同属建批档**（discipline.md §0p 十四权威口径：
 *  「与 C 同属建批档…差异在**交接机制**而非难度」）。
 *  用途：降档守卫与镜像「只升不降」**共用**同一判据（模块级单点；禁在两处各写一套）。
 *  ⚠ `tierRank`（D=4>C=3>B=2>A=1）**保留不动**：其语义 = 「D 蕴含 C 全部 + team 通道」的**强度序**，
 *    另有两处存量消费（镜像强度序、静态锁「D=4 映射在 `lib/**` 恰 1 处」）不得变。本判据**不得**写成
 *    rank 映射的三元形态（否则被静态锁计为第二份 rank 表）。本批 `d-override-fix-20261011` Q-3 裁决
 *    （补 S-2：活跃 D 批期间声明 C＝纪律要求的显式降级被 tierRank 误拦 ⇒ 改按**准入档**比较，
 *    C↔D 互转不再是降档）。 */
export const accessTierRank = (t) => ((t === 'C' || t === 'D') ? 3 : t === 'B' ? 2 : t === 'A' ? 1 : 0);

export function buildAssignTools(cx) {
  const { deps, store } = cx;
  return [
    defineTool({
      name: "assign_check",
      description: "委派形态判定：写入 difficulty（A=Leader 直做 / B=单个 subagent / C=集群建批 / D=team 方案）+ rationale（必填 ≥12 字，落 governance.json）；无默认档，不填即拒。五布尔入参只作交叉校验，与声明矛盾即拒。只读侦察先行，判据须引侦察证据。双轴：derived 由五布尔机械推导（任一 C 判据→C；否则 needIsolation→B；否则 A），derivedChannel = durableSeats ? team : dispatch。偏离：D+dispatch ⇒ overrideKind:'channel'，其余 ⇒ overrideKind:'tier'，三要素走 deviation。失败必带 GATE_* 码。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"difficulty":{"type":"string","required":true,"enum":["A","B","C","D"],"description":"难度值（必填，无默认档）：A=Leader 直做；B=单个 subagent；C=集群 wave_plan 建批（多线并行 或 多依赖需 DAG 分层）；D=team 方案（须同时声明 durableSeats:true）"},"rationale":{"type":"string","required":true,"description":"判据（必填，≥12 字）：定档依据 + 已完成的只读侦察证据。D 且无 durableSeats:true 时三要素由 deviation 承载"},"parallel":{"type":"boolean","description":"需要并行或任务间依赖（仅交叉校验）"},"multiRole":{"type":"boolean","description":"需要多角色协作（编码+测试+审查分离）"},"gate":{"type":"boolean","description":"需要门禁/审计（人审、验收、gap-list）"},"recoverable":{"type":"boolean","description":"需要跨轮治理/可恢复/可审计"},"needIsolation":{"type":"boolean","description":"需要独立上下文/工具面（查代码、跑测试等）"},"fixedRole":{"type":"boolean","description":"固定任务形态（缺省 false）：角色与流程可预见 ⇒ 推导升 C，宜评 D；判低档仅告警 WARN_DTIER_FIXED_ROLE_AS_LOWER"},"durableSeats":{"type":"boolean","description":"需 durable 席位 + 事件队列交接：通道轴唯一判据（true ⇒ team），并把难度轴推为 C；缺省 false；D 且 true ⇒ override:false"},"deviation":{"type":"object","additionalProperties":false,"description":"偏离三要素（override 为真时必填）：tier 与 channel 共用同一形状；三子键各 ≥4 字、禁未知子键","properties":{"feature":{"type":"string","description":"① 依据面：tier 偏离引特征面（parallel/multiRole/gate/recoverable/needIsolation）；channel 偏离引通道/席位面"},"counterpoint":{"type":"string","description":"② 反证面：tier 偏离给例外/反例；channel 偏离给为何 durable 而非 subagent"},"direction":{"type":"string","description":"③ 方向与上限：tier 偏离给升/降档与上限；channel 偏离给不泛化为全批、team 面缺失须降级"}}},"scope":{"type":"string","enum":["current","full"],"description":"评估对象：current=当前动作；full=完整目标任务（强制 full）"},"session":{"type":"string","description":"显式评估落点会话（会话 ID 或命名黑板）；缺省=当前执行会话；与执行会话不同时镜像过去"}},
      output: {
        // 【阻断缺陷 C-1 修复 · 批 `d-override-fix-20261011` / lane `e5-c1-schema-fix`】`overrideKind` 的取值
        //   是**闭集** `null | 'channel' | 'tier'`（单点 = 下方三元式），而原声明 `{type:"string",required:true}`
        //   把常规路径（`override=false`，绝大多数调用）的 `null` 判为违例 ⇒ 宿主 `createSuccessResult`
        //   抛 `INVALID_TOOL_OUTPUT`（**假失败**：治理已落盘、调用方却看到失败，易触发重试/误判）。
        //   ⚠ **形态不可凭推理**：宿主 value-schema DSL 的关键字子集是
        //   `type/oneOf/properties/required/additionalProperties/items/enum/const`（`dsh-tools` `checkSchemaNode`），
        //   且 (a) 每节点必须声明 `type` **或** `oneOf`（`oneOf` ≥2 支，且不得与 properties/required/enum/const 同现）；
        //   (b) `enum` 只允许与**标量** `type` 同现且成员须逐个类型正确；(c) `type` 数组与 `anyOf` **都不是关键字**
        //   （`anyOf` 在 `defineTool` 编译期即抛 `UNSUPPORTED_SCHEMA` ⇒ 整个工具注册失败，非仅本键失效）。
        //   ⇒ 「可空 + 闭集」在本 DSL 下的**唯一合法形态** = `oneOf[ {type:"string",enum:[…]}, {type:"null"} ]`。
        //     实测宿主对该形态**两向都判**：`null`/`"channel"`/`"tier"` 零违例（解 C-1）；`123`/`"bogus"` 判违例
        //     （非恒真）。读数见 `exec/fix-c1/progress/02-probe-candidates.md` 与 `03-apply-fix.md`。
        schema: {"type":"object","additionalProperties":false,"properties":{"difficulty":{"type":"string","required":true},"rationale":{"type":"string","required":true},"derived":{"type":"string","required":true},"override":{"type":"boolean","required":true},"derivedChannel":{"type":"string","required":true},"overrideKind":{"oneOf":[{"type":"string","enum":["channel","tier"]},{"type":"null"}],"required":true},"form":{"type":"string","required":true},"allowed":{"type":"boolean","required":true},"reasons":{"type":"array","required":true,"items":{"type":"string"}},"next":{"type":"array","required":true,"items":{"type":"string"}},"execToolCount":{"type":"integer","required":true},"escalationHint":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"mirroredTo":{"type":"string"},"notice":{"type":"string"},"history":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => {
          const d = value.difficulty ?? value.form;
          let s = 'assign difficulty: ' + d + ((d === 'C' || d === 'D') ? ' (must use batch) → next: wave_plan' : ' (allowed)') + (value.sessionId ? ' @' + value.sessionId : '');
          // 双轴读数外显（本批 `d-override-fix-20261011`）：偏离支须可读 `overrideKind` 与通道轴，否则新字段在工具行不可见
          if (value.override) s += ' [override(' + value.overrideKind + '): derived=' + value.derived + '/' + value.derivedChannel + ' → ' + d + ']';
          if (value.mirroredTo) s += ' [mirror→' + value.mirroredTo + ']';
          if (value.escalationHint) s += ' ⚠ ' + value.escalationHint;
          if (value.notice) s += ' ⚠ ' + value.notice;
          return TEXT_OUTPUT(s);
        },
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '难度评估（assign_check）'); // 模式门（E 阶段）：非生效模式零治理写入（不写 lastAssign 镜像），先于档位校验
        const sessionId = sessionOf(args, exec);
        // ① 主动写入的难度（必填，无默认档）：不接受「推导代替判断」——档位由 Leader 声明，引擎只做交叉校验
        const difficulty = args.difficulty;
        if (!['A', 'B', 'C', 'D'].includes(difficulty)) {
          throw new Error('GATE_DIFFICULTY_INVALID: difficulty 必填且只能是 A|B|C|D（收到 ' + JSON.stringify(difficulty ?? null) + '）——'
            + '本门禁**无默认档**：先用只读侦察摸清任务，再主动写入难度，不得以默认值代替判据');
        }
        // ② 判据（必填，供审计）：留空/套话不算，长度下限 12 字
        const rationale = typeof args.rationale === 'string' ? args.rationale.trim() : '';
        if (rationale.length < 12) {
          throw new Error('GATE_DIFFICULTY_RATIONALE_MISSING: rationale 判据必填且 ≥12 字（收到 ' + JSON.stringify(args.rationale ?? null) + '）——'
            + '写明定档依据 + 已完成的只读侦察证据（读到/探测到什么），该字段落 governance.json 供审计');
        }
        const reasons = [];
        if (args.parallel) reasons.push('需要并行或任务依赖（DAG）');
        if (args.multiRole) reasons.push('需要多角色协作（编码+测试+审查分离）');
        if (args.gate) reasons.push('需要门禁/审计（人审、验收、gap-list）');
        if (args.recoverable) reasons.push('需要跨轮治理/可恢复/可审计');
        // ③ 交叉校验（**双轴判据**，本批 `d-override-fix-20261011` Q-1 裁决；原语义见下述分叉）：
        //    **难度轴** `derived` = 机械推导档位（任一 C 判据 || fixedRole || durableSeats → C；否则 needIsolation → B；否则 A）；
        //      **D 不参与难度轴**（故意：通道不是难度 —— 五布尔 + 两个新布尔都推不出「团队方案」这层治理含义）。
        //    **通道轴** `derivedChannel`（本批新增）= `"durableSeats" === true ? 'team' : 'dispatch'`
        //      （**独立推导，与难度轴无耦合**；调用形态即 `assign_check({ difficulty:'D', "durableSeats": true })`）。
        //    三支（判据源 plan/techdebt-design.md §一.1.1 真值表 10 列 × 12 行）：
        //      · **D 正当形态**（关键格①）：difficulty='D' 且 derivedChannel='team' ⇒ **回归常规路径**（override=false /
        //        overrideKind=null）——D 被机械事实覆盖（durable 席位面已声明）⇒ 不记偏离，rationale **不需要**
        //        A/B/C 特征词（这正是原「D 恒 override=true」误拒合规 D 的修复点）。
        //      · **D 通道变体**（关键格②，唯一保留的偏离）：difficulty='D' 但 derivedChannel='dispatch' ⇒
        //        override=true / overrideKind='channel'，走**通道三要素**校验（原三要素不适合：其①强制 A/B/C 特征词）。
        //      · **tier 支**（存量语义**逐字保留**）：difficulty !== derived 且非 D ⇒ override=true / overrideKind='tier'，
        //        仍走原三要素（**存在性启发**，正则逐字不动）。
        //    缺省零破坏：`fixedRole` / `durableSeats` 不传时两式退化为原 `derived = cFeatures ? 'C' : …` 且恒走 tier 支。
        const cFeatures = reasons.length > 0;
        const derived = (cFeatures || args.fixedRole === true || args.durableSeats === true) ? 'C'
          : (args.needIsolation ? 'B' : 'A');
        const derivedChannel = args.durableSeats === true ? 'team' : 'dispatch';
        // D 正当形态（关键格①）= 建批档（difficulty='D'）+ team 通道（`derivedChannel='team'`）。
        //   ⚠ **偏离登记（本 lane 唯一一处对设计件代码骨架的订正，理由是设计件内部自相矛盾）**：判据源
        //     `plan/techdebt-design.md` §一.1.1 的代码骨架写作
        //     `channelProper = (difficulty === 'D' && derivedChannel === 'team' && difficulty === derived)`，
        //     但第三个合取项 `difficulty === derived` 与该骨架**自身**的语义说明表（真值表第 7 行 /
        //     关键格①）**直接冲突**：第 7 行取 `C=0 F=0 U=1 I=0` ⇒ `derived='C'`，而 `difficulty='D'`
        //     ⇒ `difficulty !== derived` ⇒ 该式恒 false ⇒ **AC-3 永远无法成立**（override 恒 true）。
        //     另两个 AC 正文（`scope.md` AC-3「不填任何 C 判据 ⇒ override===false」、AC-7 第 7/10 行两格）
        //     与真值表一致、与该合取项冲突。此外 `derivedChannel === 'team'` ⟺ `durableSeats === true`
        //     ⟹ `derived === 'C'` 已由难度轴蕴含 ⇒ 该合取项**语义冗余**。
        //     裁决：**按真值表 + 两个关键格 AC 实现**（去掉冗余合取项），并在此登记偏离供 audit 核。
        const channelProper = difficulty === 'D' && derivedChannel === 'team';
        const override = channelProper ? false : (difficulty !== derived || difficulty === 'D');
        const overrideKind = !override ? null : (difficulty === 'D' ? 'channel' : 'tier');
        // 【乙改】偏离三要素的**唯一判定入口**（tier / channel 共用同一形状，禁第二入口）：
        //   · 缺省 / 非对象 ⇒ 三子键全列缺（形状非法时直接回显 JSON.stringify 原值，便于调用方自纠）；
        //   · 含未知子键 ⇒ 拒（工具面 additionalProperties:false 的语义在代码侧同样成立）；
        //   · 子键 trim() < 4 字或纯空白 ⇒ 拒。
        //   三条文案**复用既有 GATE_DIFFICULTY_MISMATCH**（不新增 GATE_ 码）。
        const DEVIATION_SUBKEYS = ['feature', 'counterpoint', 'direction'];
        const DEVIATION_LABELS = {
          channel: { feature: '① 引用通道/特征面', counterpoint: '② 为何 durable 而非 subagent', direction: '③ 通道方向与上限' },
          tier: { feature: '① 引用具体特征面', counterpoint: '② 例外/反例', direction: '③ 偏离方向与上限' },
        };
        const deviationIssuesOf = (raw, kind) => {
          const labels = DEVIATION_LABELS[kind];
          if (raw === undefined || raw === null) {
            return DEVIATION_SUBKEYS.map((k) => 'deviation.' + k + '（' + labels[k] + '）');
          }
          if (typeof raw !== 'object' || Array.isArray(raw)) {
            return ['deviation 形状非法：须为对象（收到 ' + JSON.stringify(raw) + '）'];
          }
          const unknown = Object.keys(raw).filter((k) => !DEVIATION_SUBKEYS.includes(k));
          if (unknown.length > 0) {
            return ['deviation 含未知子键 ' + JSON.stringify(unknown) + '（只允许 ' + DEVIATION_SUBKEYS.join(' / ') + '）'];
          }
          const issues = [];
          for (const k of DEVIATION_SUBKEYS) {
            const v = raw[k];
            if (typeof v !== 'string' || v.trim().length < 4) issues.push('deviation.' + k + '（' + labels[k] + '）');
          }
          return issues;
        };
        if (override) {
          if (overrideKind === 'channel') {
            // 通道三要素（判据源 §一.1.2；**不**复用原三要素——原①强制 A/B/C 特征词，正是要绕开的误拒源）
            // featureNote 在通道支须为**通道向**描述（缺口 G1）：不得沿用「机械推导为 C」这种像错派的措辞。
            const channelNote = '"durableSeats" 未声明（= false）⇒ 通道轴=dispatch';
            // 【乙改】通道三要素改由**结构化 deviation 子键**承载：不再从 rationale 自由文本正则提取
            //   （本仓 I-13 明令「分级按根因、不按消息文本」；旧正则正是被绕开的误拒源）。
            const miss = deviationIssuesOf(args.deviation, 'channel');
            if (miss.length > 0) {
              throw new Error('GATE_DIFFICULTY_MISMATCH: 声明 D，而通道轴推导为 dispatch（' + channelNote + '）——'
                + '**通道偏离须解释**：须提供结构化 deviation 三子键（feature=① 引用通道/特征面；'
                + 'counterpoint=② 为何 durable 而非 subagent；direction=③ 通道方向与上限），各子键 trim 后 ≥4 字，当前缺/不合法：' + miss.join('、')
                + '。**两条正范式**（任选其一）：'
                + '① 确需 durable 席位 ⇒ 重评 assign_check({ difficulty:"D", durableSeats:true, rationale, scope:"full" })'
                + ' 并以 channel:"team"|"mixed" 建批；'
                + '② 确属引擎自派 ⇒ 显式降级为 C（rationale 写明降级原因，与 discipline.md §0b 十四⑤ 同源，禁静默降级）');
            }
          } else {
            const featureNote = reasons.length > 0
              ? reasons.join('；')
              : (args.needIsolation ? 'needIsolation=true' : '四项 C 判据全为 false 且 needIsolation=false');
            const miss = deviationIssuesOf(args.deviation, 'tier');
            if (miss.length > 0) {
              throw new Error('GATE_DIFFICULTY_MISMATCH: 声明 ' + difficulty + '，而机械推导为 ' + derived + '（' + featureNote + '）——'
                + '**偏离须解释**：须提供结构化 deviation 三子键（feature=① 引用具体特征面；counterpoint=② 例外/反例；'
                + 'direction=③ 偏离方向与上限），各子键 trim 后 ≥4 字，当前缺/不合法：' + miss.join('、')
                + '；无解释的偏离仍拒（宁严勿松），有解释则放行并记 override');
            }
          }
        }
        const form = difficulty; // legacy 字段：guard 门禁 2/3 与既有读端按 form 判定（A/B/C 同值）
        // 写入治理状态：lastAssign + history 追加（审计：每回合评估留痕，含难度与判据）；C 类且无活跃批次 → pendingBatch=true
        const now = new Date().toISOString();
        const scope = args.scope ?? 'full';
        const g0 = store.readGovernance(sessionId);
        // 【在跑批不降档守卫（判据源 S-1 / L-AC-1；本批 Q-3 改按准入档）】保护条件**唯一合法形态** =
        //   `hasActive && accessTierRank(本次 difficulty) < accessTierRank(既有 lastAssign.difficulty)`。
        //   · 复用既有单点：`store.hasActiveBatch`（governance.js:288-293，**planning 亦属活跃**）
        //     + 模块级 `accessTierRank`（本文件顶部**准入档单点**）——禁另写第二套活跃判定或第二套档序映射。
        //   · 落点会话 = `sessionId`（`sessionOf(args, exec)`，与下同源）：不得改用执行会话，否则命名会话评估路径的保护面漂移。
        //   · 判定式**不得**引用 `pendingBatch` / `pendingSince`（L-AC-2）：活跃批场景下 `pendingBatch` 恒 `false` 是
        //     「Leader 跑批期间直做不被拦」的**唯一依赖**（tier-gate.js:194 门禁 2）；一旦把保护条件写成 `pendingBatch`，
        //     门禁 2 会在已有活跃批时拒执行型工具，而 `wave_plan` 对已存在的批无从再建 ⇒ **死锁**（判据源 P-4 告警）。
        //   · 既有档位缺失（`lastAssign === null`，含仅有 legacy `form` 的旧记录）⇒ `accessTierRank(undefined) = 0`
        //     ⇒ 恒非降档 ⇒ 首次评估/未评估态**永不被保护**（与门禁 1 的「未评估」口径一致）。
        const hasActive = store.hasActiveBatch(sessionId);
        const existingDifficulty = g0?.lastAssign?.difficulty ?? null;
        // 【本批 `d-override-fix-20261011` Q-3 裁决 · 补 S-2】降档比较改按**准入档**（`accessTierRank`，模块级单点）：
        //   C 与 D **同属建批档**（准入档三阶 A=1 < B=2 < {C,D}=3）⇒ 「活跃 D 批期间改声明 C」**不是降档**——
        //   这正是 discipline.md §0b 十四⑤ 要求的**显式降级**动作，原先被 `tierRank(D=4>C=3)` 误拦
        //   （`GATE_DIFFICULTY_DOWNGRADE_BLOCKED` ⇒ 纪律要求的动作被守卫堵死）；**跨准入档**（{D,C} → {B,A}）
        //   照旧拦。判据源 S-2；`tierRank`（强度序）**保留不动**（其两处存量消费：镜像强度序、静态锁）。
        const downgradeBlocked = hasActive && accessTierRank(difficulty) < accessTierRank(existingDifficulty);
        // 【P3（2026-10-03）】turn 编号随 `history` 有界化同步修正：`history` 只保留最近 N 条后，
        //   若仍按 `history.length + 1` 编号，到界后长度恒定 ⇒ 编号卡死重号。改为
        //   「累计丢弃数（裁剪标记 `historyTruncated.dropped`）+ 现存条数 + 1」，编号恢复单调不重号；
        //   未发生裁剪时 `dropped` 缺省 0 ⇒ 与旧行为**逐字等价**。
        const entry = { turn: (g0.historyTruncated?.dropped ?? 0) + (g0.history?.length ?? 0) + 1, difficulty, form, derived, override, derivedChannel, overrideKind, at: now, reasons, rationale };
        if (downgradeBlocked) {
          // 审计面（L-AC-3）：被保护的调用**仍**追加恰好 1 条 `history`（条数 = 调用次数，`turn` 计法同上不动），
          //   该条带「声明档 vs 生效档」可检索区分字段 —— 从审计面即可分辨本次声明未被采纳及其生效档位。
          entry.declaredDifficulty = difficulty;
          entry.effectiveDifficulty = existingDifficulty;
          entry.downgradeBlocked = 'GATE_DIFFICULTY_DOWNGRADE_BLOCKED';
        }
        const history = [...(g0.history ?? []), entry];
        const patch = downgradeBlocked
          // 命中保护 ⇒ **不覆盖** `lastAssign` 的档位面（`difficulty`/`form`/`scope`/`rationale`/`derived`/`override`/`reasons`
          //   逐字保留），仅刷新评估时间窗与纯观察计数：`lastAssign.at` 冻结会让 `stale`（governance.js:280-286，30min）
          //   在下一回合把会话锁在 `tier-gate.js:190` 门禁 1（未评估/过期）上 ⇒ 与 P-4 同类的**锁死面**；
          //   而 `at`/`execCallsSince` 均**不是**档位判据（C-10 明示冻结），故刷新不触碰 L-AC-1 的 `difficulty` 面。
          ? { lastAssign: { ...g0.lastAssign, at: now, execCallsSince: 0 }, history }
          : { lastAssign: { difficulty, form, scope, rationale, derived, override, derivedChannel, overrideKind, at: now, reasons, execCallsSince: 0 }, history };
        if ((form === 'C' || form === 'D') && !hasActive) { patch.pendingBatch = true; patch.pendingSince = now; }
        // 新评估总是把 pendingBatch 收敛到正确状态——已有活跃批次，或残留 pendingBatch（C 判定后重评为 A/B），一律清锁
        else if (hasActive || g0.pendingBatch) { patch.pendingBatch = false; patch.pendingSince = null; }
        // session-compat：显式 session 与执行会话不同 → 镜像到执行会话（guard 落点兼容）。
        // 镜像只写 lastAssign + pendingBatch + mirror 指针，不污染执行会话 history；解锁经 clearPendingBatch 传播
        // **Q4=B 保护（2026-09-15 用户裁决）+ 本批 Q-3 同源改判（2026-10-11）**：镜像**只升不降**——若执行会话自身
        //   档位**强于**本次被镜像的档位，则**跳过镜像**（保留执行会话自身的 lastAssign / pendingBatch / mirror 指针不动）。
        //   动机（实测）：为写「他会话」夹具而调 assign_check 时，镜像会把 Leader 自己已记录的 C 档覆盖成夹具档位
        //   ⇒ 写夹具顺手削弱自身保护。跳过时在 `notice` 里如实回显，可审计。
        //   ⚠ 比较口径与降档守卫**同源**：改用**准入档** `accessTierRank`（C↔D **同档** ⇒ 「D 会话被镜像 C」**不再跳过**、
        //   照常镜像；跨档降档才跳过）。禁两处各写一套判据（同一纪律两处不同判 = 缺陷）。
        const execSessionId = exec?.agent?.session?.id ?? null;
        // P-2：`tierRank`（强度序 D=4 最强）仍为本支的**存量读数**来源（上方 execRank0 留痕），
        //   而**跳过判据**改用准入档单点 `accessTierRank`（模块级）。
        const execGov0 = execSessionId ? store.readGovernance(execSessionId) : null;
        // 镜像强度序读数（存量：与 `tierRank` 单点同源；仅用于 notice 回显「自身档位强于本次」的可读说明）
        const execRank0 = tierRank(execGov0?.lastAssign?.difficulty);
        const downgradeSkip = Boolean(args?.session && execSessionId && args.session !== execSessionId
          && accessTierRank(execGov0?.lastAssign?.difficulty) > accessTierRank(difficulty));
        const mirror = Boolean(args?.session && execSessionId && args.session !== execSessionId) && !downgradeSkip;
        if (mirror) patch.mirroredTo = execSessionId;
        const g = store.writeGovernance(sessionId, patch);
        let mirroredTo = null;
        if (mirror) {
          mirroredTo = execSessionId;
          store.writeGovernance(execSessionId, {
            lastAssign: { ...patch.lastAssign, mirroredFrom: sessionId },
            pendingBatch: patch.pendingBatch ?? g.pendingBatch ?? false,
            pendingSince: patch.pendingSince ?? g.pendingSince ?? null,
            mirror: { from: sessionId, at: now },
          });
        }
        const execToolCount = g.execToolCount ?? 0;
        // 升级信号：升 C 的**最高优先级判据**只有两条——**多线并行**（≥2 条可
        //   并行推进的任务线）与**多依赖**（依赖链需 DAG 分层 / 多波次）；**单线程任务一律不建批**（含同回合
        //   内多步串行，环节数 / 字数不构成理由），Leader 带上下文直做。故本条只作「已进入多环节长任务」的
        //   **弱旁证提示**，**不得**读作「必须建批」。
        const escalationHint = (execToolCount >= 5 && !hasActive)
          ? 'execToolCount=' + execToolCount + ' ≥5 且无批次：已属多环节长任务——**单线程（无并行任务线、无依赖链）可直接执行**；'
            + '仅当**明确多线并行**（≥2 条可并行推进的任务线）或**多依赖**（需 DAG 分层 / 多波次）时才 wave_plan 建批'
          : '';
        // session-compat：cli 兜底警示（共享黑板跨调用互相覆盖）
        // 在跑批不降档守卫回显位（本批 Q-3 补准入档口径）：**复用既有 `notice` 字段**（零回显契约变更）——
        //   码 + 既有档位 + 本次档位 + 准入档口径 + 处置指引齐备，供 Leader 当回合即读。
        const downgradeNotice = 'GATE_DIFFICULTY_DOWNGRADE_BLOCKED：会话 ' + sessionId + ' 存在活跃批次，本次声明 ' + difficulty
          + ' 低于既有档位 ' + String(existingDifficulty) + ' —— **降档写入已拒绝**：lastAssign 保留 '
          + String(existingDifficulty) + '（本次声明档位仅入 history 供审计）。'
          + '**降档比较按准入档**（A=1 < B=2 < {C,D}=3）：C↔D **同属建批档**，二者互转不算降档（如活跃 D 批期间改声明 C 属允许的显式降级），'
          + '本次为**跨准入档**降档（{C,D} → {A,B}）故拦。处置：批次运行期按既有档位继续'
          + '（C/D 档可直接 wave_plan / member_set_status / member_settle）；确已收窄为单线程则先经 batch_phase 收口或中止在跑批次，再重评档位';
        const notice = sessionId === 'cli'
          ? 'session 未显式指定且无 agent.session：评估落点 cli 共享黑板，跨调用互相覆盖，建议显式传 session'
          : (downgradeSkip
            ? '镜像跳过（Q4=B 只升不降）：执行会话 ' + execSessionId + ' 自身档位 '
              + String(execGov0?.lastAssign?.difficulty) + ' 强于本次 ' + difficulty + '，保留其原记录不动'
            : (downgradeBlocked ? downgradeNotice : ''));
        // 【本批 Q-5 裁决 · 留痕提示（非拒态）】固定任务形态（`fixedRole:true` ⇒ derived='C'）却声明**低于 C** 的档位
        //   （A/B）⇒ 指引反例 7 的错派形态：**不硬拒**（首期只留痕），在既有 `notice` 字段**尾部并入**提示码
        //   （与 cli 兜底 / 镜像跳过 / 降档保护三分支**不互斥**，三者可同时出现，禁丢）。
        const fixedRoleAsLower = args.fixedRole === true && derived === 'C' && (difficulty === 'A' || difficulty === 'B');
        const noticeText = notice + (fixedRoleAsLower
          ? (notice ? ' ⚠ ' : '')
            + 'WARN_DTIER_FIXED_ROLE_AS_LOWER：声明 ' + difficulty + ' 档，而本次**固定任务形态**（fixedRole=true，角色与流程可预见）'
            + '机械推导为 C 档——**固定任务形态宜评 D（team 席位：durableSeats:true + 事件队列交接）**；'
            + 'B 档仅限两类（不占主上下文的调研 / 已明确上下文的单步派发）。本条**首期仅留痕提示，不硬拒**'
            + '（档位照写、未被改写；如需改判请重评 assign_check）'
          : '');
        // 条件构造返回对象：不触发镜像时镜像字段完全缺席——undefined/null 值均会触发 harness lossless JSON 校验拒绝
        const needsBatch = form === 'C' || form === 'D'; // P-1：D 与 C 同属建批档
        const out = { difficulty, rationale, derived, override, derivedChannel, overrideKind, form, allowed: !needsBatch, reasons, next: needsBatch ? ['wave_plan'] : [], execToolCount, escalationHint, notice: noticeText, sessionId, history: g.history };
        if (mirroredTo) out.mirroredTo = mirroredTo;
        return out;
      },
    }),
  ];
}