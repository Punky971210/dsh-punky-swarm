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

// 事件序不变量：pre→execute→post→result；本 wiring 不调用 ctx.emit 篡改事件流；
//   难度门禁只可能收紧不可能被本 hook 放行绕过。
//   flag-off 折叠 DENY 无状态副作用；禁 setInterval/禁端点（契约束维持）。
import { createGovernanceKernel, createRefusalReceipt, primitiveToPreDecision, resolveGovernanceConfig } from './index.js';
import { decide as decideAllowlist, canonicalDigest } from './allowlist.js';
import { writeRefusal, patchRefusalAsk } from './receipt-store.js';
import { readSessionState, setDeferred, setPaused } from './state-store.js';

const PRESET_OF_RULE_PREFIX = [
  ['L1-', 'l1-sensitive'],
  ['L2-', 'l2-resource'],
  ['L3-', 'l3-tool-ban'],
  ['L5-', 'l5-wait-ban'],
];

function presetOfRuleId(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  for (const [prefix, presetId] of PRESET_OF_RULE_PREFIX) {
    if (id.startsWith(prefix)) return presetId;
  }
  return null;
}

function ruleRefsText(ruleRefs) {
  if (!Array.isArray(ruleRefs) || ruleRefs.length === 0) return '';
  return ruleRefs
    .map((id) => {
      const presetId = presetOfRuleId(id);
      return presetId === null ? String(id) : `${id}（preset ${presetId}）`;
    })
    .join('、');
}

const GENERIC_DENIAL_OUTCOMES = new Set(['denied-rejected', 'denied-cancelled', 'unavailable', 'denied-no-agent']);

function buildDenialCorrectionText(pending) {
  const cached = pending?.decision;
  if (!cached || cached.primitive !== 'REQUIRE_APPROVAL') {
    throw new Error('cached decision unavailable (primitive=' + (cached?.primitive ?? 'none') + ')');
  }
  const sessionId = pending.sessionId ?? 'cli';
  const receiptId = pending.receiptId ?? '(unknown)';
  const refs = ruleRefsText(cached.ruleRefs);
  const reason = typeof cached.reason === 'string' && cached.reason.length > 0
    ? cached.reason
    : '护栏拦截（违规明细缺失）';
  return (
    `Error: [governance:${cached.primitive} 人工闸拒绝（护栏拦截，宿主泛化拒绝文本补正）] ` +
    (refs.length > 0 ? `命中规则：${refs}；` : '') +
    `${reason}；护栏明细见收据 <root>/governance/refusals/${sessionId}/${receiptId}.json，` +
    '全量规则审阅清单见 presets/hook-rules/README.md（Agent 可按违规 message 修正参数后重发合规调用）'
  );
}

function formatDecision(d) {
  let reason = `[governance:${d.primitive}] ${d.reason}`;
  if (d.primitive === 'NARROW' || (d.primitive === 'DENY' && d.narrowedParams !== undefined)) {
    reason += '；参数修正指引：宿主禁止输入改写，请按收窄指引修正参数后重新发起调用';
  }
  if (d.narrowedParams !== undefined) {
    const clamped = d.narrowedParams?.clamped;
    if (Array.isArray(clamped) && clamped.length > 0) {
      const detail = clamped
        .map((c) => `${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
        .join('、');
      reason += `；钳制明细：${detail}`;
    }
  }
  const refs = ruleRefsText(d.ruleRefs);
  if (refs.length > 0) reason += `；规则引用：${refs}`;
  return reason;
}

export function installGovernanceHook(ctx, { store, root, config, logger, onRefusal, presetTable, presetBanTable, allowlistScope } = {}) {
  const log = logger ?? ctx?.logger ?? null;
  const cfg = resolveGovernanceConfig(config?.governance?.hook ?? {}, {
    presetTable,
    presetBanTable,
    warn: (m) => log?.warn?.('[governance] ' + m),
  });
  // 【⑥-2 · 2026-11-08 裁决丙「两套人工闸合并为一个 ask」】allowlist 判据归属本 hook。
  //   为什么必须在这里：`tools.guard()` **只能返回拒绝串**，产不出真正的审批态；
  //   而 `REQUIRE_APPROVAL` 的收据 `ask` 块 + 宿主 `serviceAsk` + 事后回填都长在本 hook 上。
  //   ⇒ allowlist 从工具层（tier-gate）搬到这里，与内核规则**共用同一套 ask 机制**。
  //   作用域不变：只对 `allowlistScope`（= `config.escalation.execTools`，缺省 EXEC_TOOLS）里的
  //   工具生效 —— 沿用原实现「只治理执行型工具」的边界，不扩大到治理工具面。
  const allowlistCfg = Array.isArray(config?.tools?.allowlist) ? config.tools.allowlist : null;
  const allowScope = Array.isArray(allowlistScope) && allowlistScope.length > 0 ? allowlistScope : null;
  const inert = (reason, level = 'warn') => {
    try {
      const line = '[governance] inert(' + level + '): ' + reason;
      if (level === 'info') { if (typeof log?.info === 'function') log.info(line); else log?.warn?.(line + ' [info-unavailable]'); }
      else log?.warn?.(line);
    } catch {  }
    return { installed: false, inert: true, reason, level, refusals: { count: () => 0 }, dispose() {} };
  };
  if (cfg.enabled !== true) return inert('disabled', 'info');
  if (!root || typeof ctx?.on !== 'function') return inert('ctx.on unavailable');
  const kernel = createGovernanceKernel(cfg);
  let refusalCount = 0;
  let refusalCb = typeof onRefusal === 'function' ? onRefusal : null;
  const pendingAsks = new Map();

  const sessionIdOf = (exec) => exec?.agent?.session?.id ?? 'cli';

  const ALLOWLIST_RULE_REF = 'tools.allowlist';

  /** allowlist 判定 → 治理原语（`null` = 不适用/已批准；否则 DENY / REQUIRE_APPROVAL）。 */
  function allowlistDecisionOf(exec) {
    if (allowlistCfg === null) return null;                       // 未配置 ⇒ 整段关闭（旧行为）
    if (allowScope !== null && !allowScope.includes(exec?.name)) return null; // 只治理执行型工具
    const full = exec?.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? exec.arguments : {};
    const business = { ...full };
    delete business.approval;                                     // 控制位不参与摘要（否则永远不匹配）
    const digest = canonicalDigest(business);
    const approval = full.approval && typeof full.approval === 'object' ? full.approval : null;
    if (approval !== null && approval.digest !== digest) {
      return {
        primitive: 'DENY', priority: 4, ruleRefs: [ALLOWLIST_RULE_REF],
        reason: 'approval-args-mismatch: ' + exec.name
          + '（批准票据与本轮参数摘要不一致；票据须等于当前参数的 canonicalDigest，含控制位除外的全部参数）',
      };
    }
    const dec = decideAllowlist({
      toolName: exec.name,
      args: business,
      allowlist: allowlistCfg,
      // 票据与参数同源（digest 相符）才算「已批准」
      facts: { approval: approval !== null && approval.digest === digest },
    });
    if (dec.decision === 'allow') return null;
    if (dec.decision === 'ask') {
      return {
        primitive: 'REQUIRE_APPROVAL', priority: 3, ruleRefs: [ALLOWLIST_RULE_REF],
        reason: dec.reason + '（tools.allowlist 声明该调用需人工批准；批准票据 digest 须为 ' + digest
          + '，与票据同参重发即放行）',
      };
    }
    return { primitive: 'DENY', priority: 4, ruleRefs: [ALLOWLIST_RULE_REF], reason: dec.reason };
  }

  const pre = async (exec, next) => {
    const sessionId = sessionIdOf(exec);
    let st;
    try {
      st = readSessionState(root, sessionId);
    } catch (e) {
      log?.warn?.('[governance] session state read failed (state gate bypassed, kernel still applies): ' + String(e?.message ?? e));
      st = { status: 'idle' };
    }
    if (st.status === 'deferred' || st.status === 'paused') {
      const gatePrimitive = st.status === 'deferred' ? 'DEFER' : 'PAUSE';
      const gateReason = st.status === 'deferred'
        ? `会话处于延后挂起（deferId=${st.deferId}, retryAfterMs=${st.retryAfterMs}, until=${st.until}）：retry-after 窗口内重试被拒（惰性过期自动恢复）`
        : `会话处于暂停（pauseToken=${st.pauseToken}, until=${st.until}）：同会话工具调用被拒（过期自动恢复）`;
      const gateDecision = {
        primitive: gatePrimitive,
        priority: gatePrimitive === 'DEFER' ? 5 : 3,
        reason: gateReason,
        ruleRefs: [],
      };
      const gateReceipt = createRefusalReceipt({
        tool: exec.name,
        callId: exec.callId,
        sessionId,
        decision: gateDecision,
        attemptedParams: exec.arguments,
      });
      if (st.status === 'deferred') {
        gateReceipt.deferMeta = { deferId: st.deferId, retryAfterMs: st.retryAfterMs, until: st.until };
      } else {
        gateReceipt.pauseMeta = { pauseToken: st.pauseToken, until: st.until };
      }
      try {
        writeRefusal(root, gateReceipt);
        refusalCount++;
        try {
          refusalCb?.(gateReceipt);
        } catch (e) {
          log?.warn?.('[governance] refusal bridge callback failed (isolated): ' + String(e?.message ?? e));
        }
      } catch (e) {
        log?.warn?.('[governance] refusal receipt write failed (observer, does not block decision): ' + String(e?.message ?? e));
      }
      return { kind: 'deny', reason: formatDecision(gateDecision) };
    }
    const kernelDecision = kernel.decide({ name: exec.name, arguments: exec.arguments });
    // 【⑥-2 裁决丙】内核放行后再评 allowlist；内核已拒则以内核为准（不叠加两条拒因）。
    const allowDecision = kernelDecision.primitive === 'ALLOW' ? allowlistDecisionOf(exec) : null;
    const d = allowDecision ?? kernelDecision;
    if (d.primitive === 'ALLOW') return next();
    let deferMeta;
    let pauseMeta;
    if (d.primitive === 'DEFER') {
      try {
        deferMeta = setDeferred(root, sessionId, {});
      } catch (e) {
        log?.warn?.('[governance] DEFER state write failed (deny stands): ' + String(e?.message ?? e));
      }
    } else if (d.primitive === 'PAUSE') {
      try {
        pauseMeta = setPaused(root, sessionId);
      } catch (e) {
        log?.warn?.('[governance] PAUSE state write failed (deny stands): ' + String(e?.message ?? e));
      }
    }
    const receipt = createRefusalReceipt({
      tool: exec.name,
      callId: exec.callId,
      sessionId,
      decision: d,
      attemptedParams: exec.arguments,
    });
    if (deferMeta !== undefined) receipt.deferMeta = deferMeta;
    if (pauseMeta !== undefined) receipt.pauseMeta = pauseMeta;
    if (d.primitive === 'REQUIRE_APPROVAL') {
      receipt.ask = { channel: 'host-serviceAsk', initiated: receipt.ts, requestId: exec.callId };
    }
    try {
      writeRefusal(root, receipt);
      refusalCount++;
      try {
        refusalCb?.(receipt);
      } catch (e) {
        log?.warn?.('[governance] refusal bridge callback failed (isolated): ' + String(e?.message ?? e));
      }
      if (receipt.ask !== undefined) {
        pendingAsks.set(exec.callId, {
          receiptId: receipt.receiptId,
          sessionId,
          decision: {
            primitive: d.primitive,
            priority: d.priority,
            reason: d.reason,
            ruleRefs: Array.isArray(d.ruleRefs) ? [...d.ruleRefs] : [],
          },
        });
      }
    } catch (e) {
      log?.warn?.('[governance] refusal receipt write failed (observer, does not block decision): ' + String(e?.message ?? e));
    }
    const mapped = primitiveToPreDecision(d.primitive);
    if (mapped === 'pass') return next();
    let reason = formatDecision(d);
    if (d.primitive === 'DEFER' && deferMeta !== undefined) {
      reason += `；会话延后挂起：deferId=${deferMeta.deferId}，retryAfterMs=${deferMeta.retryAfterMs}，until=${deferMeta.until}（窗口内重试将被拒，惰性过期自动恢复）`;
    } else if (d.primitive === 'PAUSE' && pauseMeta !== undefined) {
      reason += `；会话已暂停：pauseToken=${pauseMeta.pauseToken}，until=${pauseMeta.until}（暂停期间同会话工具调用被拒，过期自动恢复）`;
    }
    return { kind: mapped.kind, reason };
  };

  const inferAskOutcome = (result) => {
    if (result?.isError !== true) return 'allowed-once';
    const msg = [
      typeof result?.error?.message === 'string' ? result.error.message : '',
      (() => {
        const c = result?.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ');
        return '';
      })(),
    ].join(' ');
    if (/no agent to route it through/.test(msg)) return 'denied-no-agent';
    if (/user rejected/.test(msg)) return 'denied-rejected';
    if (/was cancelled/.test(msg)) return 'denied-cancelled';
    if (/no approval channel is available/.test(msg)) return 'unavailable';
    return 'denied-no-approval';
  };

  const post = async (exec, result, next) => {
    try {
      const sessionId = sessionIdOf(exec);
      const pending = pendingAsks.get(exec.callId);
      if (pending !== undefined && pending.sessionId === sessionId) {
        pendingAsks.delete(exec.callId);
        const outcome = inferAskOutcome(result);
        if (GENERIC_DENIAL_OUTCOMES.has(outcome)) {
          try {
            patchRefusalAsk(root, sessionId, pending.receiptId, outcome);
            const text = buildDenialCorrectionText(pending);
            return { kind: 'accept', content: [{ type: 'text', text }] };
          } catch (e) {
            log?.warn?.('[governance] ask outcome backfill/correction failed (degraded to pass-through): ' + String(e?.message ?? e));
          }
        } else {
          try {
            patchRefusalAsk(root, sessionId, pending.receiptId, outcome);
          } catch (e) {
            log?.warn?.('[governance] ask outcome patch failed (observer, does not block result): ' + String(e?.message ?? e));
          }
        }
      }
    } catch (e) {
      log?.warn?.('[governance] ask outcome observer failed (does not block result): ' + String(e?.message ?? e));
    }
    return next();
  };

  const disposePre = ctx.on('tools/pre-execute', pre);
  const disposePost = ctx.on('tools/post-execute', post);
  let disposed = false;
  return {
    installed: true,
    refusals: { count: () => refusalCount },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingAsks.clear();
      refusalCb = null;
      if (typeof disposePre === 'function') disposePre();
      if (typeof disposePost === 'function') disposePost();
    },
  };
}
