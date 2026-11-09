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
import { assertNotSentinelSessionArg } from '../state/session-authority.js';

/** 难度档位序（rank）：D=4 > C=3 > B=2 > A=1 > 未知/缺失=0 —— **全仓唯一 rank 真源**（模块级单点导出）。
 *  P-2：D 最强（D 蕴含 C 全部 + team 通道）。 */
export const tierRank = (t) => (t === 'D' ? 4 : t === 'C' ? 3 : t === 'B' ? 2 : t === 'A' ? 1 : 0);

/**
 *  「与 C 同属建批档…差异在**交接机制**而非难度」）。
 *    C↔D 互转不再是降档）。 */
export const accessTierRank = (t) => ((t === 'C' || t === 'D') ? 3 : t === 'B' ? 2 : t === 'A' ? 1 : 0);

export function buildAssignTools(cx) {
  const { deps, store } = cx;
  const { resolveBatchSession } = deps ?? {};
  return [
    defineTool({
      name: "assign_check",
      description: "委派形态判定：写入 difficulty（A=Leader 直做 / B=单个 subagent / C=集群建批 / D=team 方案）+ rationale（必填 ≥12 字，落 governance.json）；无默认档，不填即拒。五布尔入参只作交叉校验，与声明矛盾即拒。只读侦察先行，判据须引侦察证据。双轴：derived 由五布尔机械推导（任一 C 判据→C；否则 needIsolation→B；否则 A），derivedChannel = durableSeats ? team : dispatch。偏离：D+dispatch ⇒ overrideKind:'channel'，其余 ⇒ overrideKind:'tier'，三要素走 deviation。失败必带 GATE_* 码。",
      parameters: {sourceRunId:{"type":"string","description":"来源 run（缺省取 agent.session.id），缺失即拒"},"difficulty":{"type":"string","required":true,"enum":["A","B","C","D"],"description":"难度值（必填，无默认档）：A=Leader 直做；B=单个 subagent；C=集群 wave_plan 建批（多线并行 或 多依赖需 DAG 分层）；D=team 方案（须同时声明 durableSeats:true）"},"rationale":{"type":"string","required":true,"description":"判据（必填，≥12 字）：定档依据 + 已完成的只读侦察证据。D 且无 durableSeats:true 时三要素由 deviation 承载"},"parallel":{"type":"boolean","description":"需要并行或任务间依赖（仅交叉校验）"},"multiRole":{"type":"boolean","description":"需要多角色协作（编码+测试+审查分离）"},"gate":{"type":"boolean","description":"需要门禁/审计（人审、验收、gap-list）"},"recoverable":{"type":"boolean","description":"需要跨轮治理/可恢复/可审计"},"needIsolation":{"type":"boolean","description":"需要独立上下文/工具面（查代码、跑测试等）"},"fixedRole":{"type":"boolean","description":"固定任务形态（缺省 false）：角色与流程可预见 ⇒ 推导升 C，宜评 D；判低档仅告警 WARN_DTIER_FIXED_ROLE_AS_LOWER"},"durableSeats":{"type":"boolean","description":"需 durable 席位 + 事件队列交接：通道轴唯一判据（true ⇒ team），并把难度轴推为 C；缺省 false；D 且 true ⇒ override:false"},"deviation":{"type":"object","additionalProperties":false,"description":"偏离三要素（override 为真时必填）：tier 与 channel 共用同一形状；三子键各 ≥4 字、禁未知子键","properties":{"feature":{"type":"string","description":"① 依据面：tier 偏离引特征面（parallel/multiRole/gate/recoverable/needIsolation）；channel 偏离引通道/席位面"},"counterpoint":{"type":"string","description":"② 反证面：tier 偏离给例外/反例；channel 偏离给为何 durable 而非 subagent"},"direction":{"type":"string","description":"③ 方向与上限：tier 偏离给升/降档与上限；channel 偏离给不泛化为全批、team 面缺失须降级"}}},"scope":{"type":"string","enum":["current","full"],"description":"评估对象：current=当前动作；full=完整目标任务（强制 full）"},"session":{"type":"string","description":"显式评估落点会话（会话 ID 或命名黑板）；缺省=当前执行会话；与执行会话不同时镜像过去"}},
      output: {
        //   且 (a) 每节点必须声明 `type` **或** `oneOf`（`oneOf` ≥2 支，且不得与 properties/required/enum/const 同现）；
        schema: {"type":"object","additionalProperties":false,"properties":{"difficulty":{"type":"string","required":true},"rationale":{"type":"string","required":true},"derived":{"type":"string","required":true},"override":{"type":"boolean","required":true},"derivedChannel":{"type":"string","required":true},"overrideKind":{"oneOf":[{"type":"string","enum":["channel","tier"]},{"type":"null"}],"required":true},"form":{"type":"string","required":true},"allowed":{"type":"boolean","required":true},"reasons":{"type":"array","required":true,"items":{"type":"string"}},"next":{"type":"array","required":true,"items":{"type":"string"}},"execToolCount":{"type":"integer","required":true},"escalationHint":{"type":"string","required":true},"sessionId":{"type":"string","required":true},"mirroredTo":{"type":"string"},"notice":{"type":"string"},"history":{"type":"array","items":{"type":"object","additionalProperties":true}}}},
        render: (_args, value) => {
          const d = value.difficulty ?? value.form;
          let s = 'assign difficulty: ' + d + ((d === 'C' || d === 'D') ? ' (must use batch) → next: wave_plan' : ' (allowed)') + (value.sessionId ? ' @' + value.sessionId : '');
          if (value.override) s += ' [override(' + value.overrideKind + '): derived=' + value.derived + '/' + value.derivedChannel + ' → ' + d + ']';
          if (value.mirroredTo) s += ' [mirror→' + value.mirroredTo + ']';
          if (value.escalationHint) s += ' ⚠ ' + value.escalationHint;
          if (value.notice) s += ' ⚠ ' + value.notice;
          return TEXT_OUTPUT(s);
        },
      },
      async execute(args, exec) {
        assertModeActive(deps, exec, '难度评估（assign_check）');
        assertNotSentinelSessionArg(args, 'assign_check');                       // D-03/RQ-5
        const sessionId = sessionOf(args, exec, resolveBatchSession);            // D-02/RQ-2
        //   注：本站点（D-04 站点 1/2：difficulty / scope）**不落** `authorizeBatchWrite`：
        //   `session` 在本工具的语义是「评估落点（会话 id 或**命名黑板**）」，且跨会话写入是
        //   **显式设计**的双向镜像（`mirror` / `mirroredTo`，见 `governance.test.js:431/454` 锁定用例），
        //   没有「他人批次」这个被判对象。判据与残余风险见台账 D-04 站点台账。
        const difficulty = args.difficulty;
        if (!['A', 'B', 'C', 'D'].includes(difficulty)) {
          throw new Error('GATE_DIFFICULTY_INVALID: difficulty 必填且只能是 A|B|C|D（收到 ' + JSON.stringify(difficulty ?? null) + '）——'
            + '本门禁**无默认档**：先用只读侦察摸清任务，再主动写入难度，不得以默认值代替判据');
        }
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
        //    **难度轴** `derived` = 机械推导档位（任一 C 判据 || fixedRole || durableSeats → C；否则 needIsolation → B；否则 A）；
        const cFeatures = reasons.length > 0;
        const derived = (cFeatures || args.fixedRole === true || args.durableSeats === true) ? 'C'
          : (args.needIsolation ? 'B' : 'A');
        const derivedChannel = args.durableSeats === true ? 'team' : 'dispatch';
        const channelProper = difficulty === 'D' && derivedChannel === 'team';
        const override = channelProper ? false : (difficulty !== derived || difficulty === 'D');
        const overrideKind = !override ? null : (difficulty === 'D' ? 'channel' : 'tier');
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
            const channelNote = '"durableSeats" 未声明（= false）⇒ 通道轴=dispatch';
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
        const form = difficulty;
        const now = new Date().toISOString();
        const scope = args.scope ?? 'full';
        const g0 = store.readGovernance(sessionId);
        const hasActive = store.hasActiveBatch(sessionId);
        const existingDifficulty = g0?.lastAssign?.difficulty ?? null;
        const downgradeBlocked = hasActive && accessTierRank(difficulty) < accessTierRank(existingDifficulty);
        const entry = { turn: (g0.historyTruncated?.dropped ?? 0) + (g0.history?.length ?? 0) + 1, difficulty, form, derived, override, derivedChannel, overrideKind, at: now, reasons, rationale };
        if (downgradeBlocked) {
          entry.declaredDifficulty = difficulty;
          entry.effectiveDifficulty = existingDifficulty;
          entry.downgradeBlocked = 'GATE_DIFFICULTY_DOWNGRADE_BLOCKED';
        }
        const history = [...(g0.history ?? []), entry];
        const patch = downgradeBlocked
          ? { lastAssign: { ...g0.lastAssign, at: now, execCallsSince: 0 }, history }
          : { lastAssign: { difficulty, form, scope, rationale, derived, override, derivedChannel, overrideKind, at: now, reasons, execCallsSince: 0 }, history };
        if ((form === 'C' || form === 'D') && !hasActive) { patch.pendingBatch = true; patch.pendingSince = now; }
        else if (hasActive || g0.pendingBatch) { patch.pendingBatch = false; patch.pendingSince = null; }
        const execSessionId = exec?.agent?.session?.id ?? null;
        const execGov0 = execSessionId ? store.readGovernance(execSessionId) : null;
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
        //   **弱旁证提示**，**不得**读作「必须建批」。
        const escalationHint = (execToolCount >= 5 && !hasActive)
          ? 'execToolCount=' + execToolCount + ' ≥5 且无批次：已属多环节长任务——**单线程（无并行任务线、无依赖链）可直接执行**；'
            + '仅当**明确多线并行**（≥2 条可并行推进的任务线）或**多依赖**（需 DAG 分层 / 多波次）时才 wave_plan 建批'
          : '';
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
        const fixedRoleAsLower = args.fixedRole === true && derived === 'C' && (difficulty === 'A' || difficulty === 'B');
        const noticeText = notice + (fixedRoleAsLower
          ? (notice ? ' ⚠ ' : '')
            + 'WARN_DTIER_FIXED_ROLE_AS_LOWER：声明 ' + difficulty + ' 档，而本次**固定任务形态**（fixedRole=true，角色与流程可预见）'
            + '机械推导为 C 档——**固定任务形态宜评 D（team 席位：durableSeats:true + 事件队列交接）**；'
            + 'B 档仅限两类（不占主上下文的调研 / 已明确上下文的单步派发）。本条**首期仅留痕提示，不硬拒**'
            + '（档位照写、未被改写；如需改判请重评 assign_check）'
          : '');
        const needsBatch = form === 'C' || form === 'D';
        const out = { difficulty, rationale, derived, override, derivedChannel, overrideKind, form, allowed: !needsBatch, reasons, next: needsBatch ? ['wave_plan'] : [], execToolCount, escalationHint, notice: noticeText, sessionId, history: g.history };
        if (mirroredTo) out.mirroredTo = mirroredTo;
        return out;
      },
    }),
  ];
}