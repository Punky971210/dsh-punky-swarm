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

window.__ModuleLoader__.load({
  id: "dsh-punky-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    "use strict";
    // dsh-punky-swarm 蟛蜞集群监控面板客户端（只读）：注册 conversation.view 第三分页（对话/轨迹/蟛蜞集群）
    const React = require('react');
    const { useState, useEffect } = React;

// ===== [panel-segment] locales.js =====
    const zh = {
      "view.cluster": "蟛蜞集群",
      "live": "实时",
      "refresh.auto": "3s 自动刷新",
      "stream.live": "实时推送",
      "stream.fallback": "已降级 3s 轮询",
      "updated": "更新于",
      "stat.total": "总批次",
      "stat.running": "运行中",
      "stat.done": "已完结",
      "stat.issues": "异常",
      "batch.title": "批次列表",
      "batch.progress": "进度",
      "batch.release": "可自动放行",
      "batch.done": "已完结",
      "lanes": "子任务",
      "events": "事件",
      "concurrency": "并发",
      "event.timeline": "事件时间线",
      "mailbox.title": "收件箱（只读）",
      "mailbox.inbox": "派发",
      "mailbox.broadcast": "广播",
      "mailbox.hint": "暂无未读",
      "empty": "暂无批次",
      "empty.hint": "创建 wave_plan 批次后在此查看",
      "load.error": "加载失败",
      "gate.missing": "缺",
      "attempt": "返工",
      "upgrade": "升级人工",
      "task.deps": "依赖",
      "task.layer": "层",
      "gate.consume": "消费缺失",
      "gate.outputs": "产物缺失",
      "gate.produce": "产出缺失",
      "gate.contract": "契约问题",
      // ===== 治理配置页（settings.section: governance-config）=====
      "nav.governance": "蟛蜞治理配置",
      "gov.title.live": "蟛蜞治理配置 · {n} 条规则生效",
      "gov.live": "已生效",
      "gov.hook.title": "护栏开关",
      "gov.hook.desc": "开启后拦截越界调用；出厂空规则表零拦截",
      "gov.preset.title": "规则预设",
      "gov.preset.hint": "可多选叠加装载；全不选 = 出厂空表（零拦截）",
      "gov.preset.none": "出厂空表（零拦截）",
      "gov.preset.rules": "{n} 条规则",
      "gov.preset.l1": "敏感数据防护（凭据/私钥）",
      "gov.preset.l2": "资源上限（超时/并发）",
      "gov.preset.compose": "L1 + L2 全量组合",
      "gov.preset.custom": "检测到非受控 preset 引用，保存将沿用原文",
      "gov.preset.manual": "检测到 {n} 条手工规则，预设切换需先手工移除",
      "gov.esc.title": "违规自动升级",
      "gov.esc.threshold": "窗口内触发次数",
      "gov.esc.window": "窗口（秒）",
      "gov.esc.primitives": "计入原语",
      "gov.narrow.title": "窄化放行",
      "gov.narrow.desc": "开启后超限调用按收窄指引重试放行，替代直接拒绝",
      "gov.save": "保存",
      "gov.reset": "重置",
      "gov.saving": "保存中…",
      "gov.saved": "已保存，生效确认中",
      "gov.dirty": "有未保存改动",
      "gov.loading": "加载中…",
      "gov.error.net": "请求失败",
      "gov.err.prefix": "保存被拒",
      "gov.err.unknownPreset": "未知规则预设",
      "gov.err.fieldNotAllowed": "字段不在受控范围",
      "gov.err.invalidValue": "字段取值非法",
      "gov.err.topLevel": "未知顶层键",
      "gov.err.conflict": "与手工规则冲突"
    };
    const en = {
      "view.cluster": "Punky swarm",
      "live": "Live",
      "refresh.auto": "3s auto refresh",
      "stream.live": "Live push",
      "stream.fallback": "3s polling fallback",
      "updated": "updated",
      "stat.total": "Batches",
      "stat.running": "Running",
      "stat.done": "Done",
      "stat.issues": "Issues",
      "batch.title": "Batches",
      "batch.progress": "progress",
      "batch.release": "auto-release",
      "batch.done": "done",
      "lanes": "lanes",
      "events": "events",
      "concurrency": "concurrency",
      "event.timeline": "Event timeline",
      "mailbox.title": "Inbox (read-only)",
      "mailbox.inbox": "dispatch",
      "mailbox.broadcast": "broadcast",
      "mailbox.hint": "nothing unread",
      "empty": "No batches",
      "empty.hint": "Create a wave_plan batch to see it here",
      "load.error": "Load failed",
      "gate.missing": "missing",
      "attempt": "rework",
      "upgrade": "escalate",
      "task.deps": "deps",
      "task.layer": "layer",
      "gate.consume": "consume missing",
      "gate.outputs": "outputs missing",
      "gate.produce": "produce missing",
      "gate.contract": "contract problem",
      // ===== Governance config page (settings.section: governance-config) =====
      "nav.governance": "Punky Governance Config",
      "gov.title.live": "Punky Governance Config · {n} rules live",
      "gov.live": "Live",
      "gov.hook.title": "Guardrail switch",
      "gov.hook.desc": "Blocks out-of-scope calls when on; the factory empty rule table intercepts nothing",
      "gov.preset.title": "Rule preset",
      "gov.preset.hint": "Multi-select stacks presets; none selected = factory-empty (no interception)",
      "gov.preset.none": "Factory default (no rules)",
      "gov.preset.rules": "{n} rules",
      "gov.preset.l1": "Sensitive-data guard (credentials/keys)",
      "gov.preset.l2": "Resource limits (timeout/concurrency)",
      "gov.preset.compose": "Full L1 + L2 combination",
      "gov.preset.custom": "Non-listed preset reference detected; saving keeps it verbatim",
      "gov.preset.manual": "{n} custom rules present; switch the preset only after removing them manually",
      "gov.esc.title": "Auto-escalation",
      "gov.esc.threshold": "Refusals within window",
      "gov.esc.window": "Window (s)",
      "gov.esc.primitives": "Counted verdicts",
      "gov.narrow.title": "Narrowed allowance",
      "gov.narrow.desc": "Lets over-limit calls retry within clamped bounds instead of a direct refusal",
      "gov.save": "Save",
      "gov.reset": "Reset",
      "gov.saving": "Saving…",
      "gov.saved": "Saved, confirming…",
      "gov.dirty": "Unsaved changes",
      "gov.loading": "Loading…",
      "gov.error.net": "Request failed",
      "gov.err.prefix": "Save rejected",
      "gov.err.unknownPreset": "Unknown rule preset",
      "gov.err.fieldNotAllowed": "Field not in controlled scope",
      "gov.err.invalidValue": "Invalid field value",
      "gov.err.topLevel": "Unknown top-level key",
      "gov.err.conflict": "Conflicts with custom rules"
    };

    // module-level translator: zh-first, en fallback (matches the original panel behavior)
    function tt(k) { return zh[k] || en[k] || k; }
// ===== [panel-segment] theme.js =====
    // ================= theme-aware palette =================
    // DSH 主题开关：body[data-ds-dark-theme]（深色）vs 默认浅色。令牌 var(--dsw-alias-*)
    // 会随主题自动切换；这里只负责「令牌缺失时」的兜底色板，并按主题切换重渲染。
    let CURRENT_THEME = 'dark';
    function detectTheme() {
      try {
        if (typeof document !== 'undefined' && document.body) {
          return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
        }
      } catch {}
      return 'dark';
    }
    try { CURRENT_THEME = detectTheme(); } catch {}

    const P = {
      light: {
        card: '#ffffff', border: '#dfe5ee',
        text: '#1f2937', text2: '#475569', text3: '#64748b', dim: '#64748b',
        accent: '#3b82f6', success: '#15803d', warn: '#b45309', error: '#dc2626', info: '#2563eb',
        skeleton: '#eef2f7', selBg: 'rgba(59,130,246,0.10)',
        chipPending: 'rgba(100,116,139,0.20)', chipRunning: 'rgba(180,83,9,0.12)',
        chipReview: 'rgba(37,99,235,0.10)', chipMerged: 'rgba(21,128,61,0.12)',
        chipFailed: 'rgba(220,38,38,0.10)', chipSkipped: 'rgba(100,116,139,0.16)',
        chipConflict: 'rgba(234,88,12,0.12)', chipIdle: 'rgba(100,116,139,0.14)',
        haloSuccess: 'rgba(21,128,61,0.16)', haloWarn: 'rgba(180,83,9,0.16)',
        gateBg: 'rgba(180,83,9,0.12)', escBg: 'rgba(234,88,12,0.12)', escFg: '#c2410c'
      },
      dark: {
        card: '#141d31', border: '#26304a',
        text: '#e6ebf4', text2: '#a8b3c7', text3: '#7f8ca3', dim: '#8b96ab',
        accent: '#4f8cff', success: '#3fb950', warn: '#d29922', error: '#f85149', info: '#58a6ff',
        skeleton: '#1d2740', selBg: 'rgba(79,140,255,0.12)',
        chipPending: 'rgba(127,140,163,0.22)', chipRunning: 'rgba(210,153,34,0.16)',
        chipReview: 'rgba(88,166,255,0.16)', chipMerged: 'rgba(63,185,80,0.16)',
        chipFailed: 'rgba(248,81,73,0.16)', chipSkipped: 'rgba(127,140,163,0.18)',
        chipConflict: 'rgba(224,104,46,0.18)', chipIdle: 'rgba(127,140,163,0.16)',
        haloSuccess: 'rgba(63,185,80,0.18)', haloWarn: 'rgba(210,153,34,0.18)',
        gateBg: 'rgba(210,153,34,0.16)', escBg: 'rgba(224,104,46,0.16)', escFg: '#e0682e'
      }
    };
    const pal = () => P[CURRENT_THEME] || P.dark;

    // 令牌优先、兜底随主题：getter 在每次渲染时求值
    const T = {
      get card() { return 'var(--dsw-alias-bg-layer-3, ' + pal().card + ')'; },
      get border() { return 'var(--dsw-alias-border-l1, ' + pal().border + ')'; },
      get text() { return 'var(--dsw-alias-label-primary, ' + pal().text + ')'; },
      get text2() { return 'var(--dsw-alias-label-secondary, ' + pal().text2 + ')'; },
      get text3() { return 'var(--dsw-alias-label-tertiary, ' + pal().text3 + ')'; },
      get dim() { return 'var(--dsw-alias-label-dimmed, ' + pal().dim + ')'; },
      get accent() { return 'var(--dsw-alias-brand-primary, ' + pal().accent + ')'; },
      get success() { return 'var(--dsw-alias-state-success-primary, ' + pal().success + ')'; },
      get warn() { return 'var(--dsw-alias-state-warn-primary, ' + pal().warn + ')'; },
      get error() { return 'var(--dsw-alias-state-error-primary, ' + pal().error + ')'; },
      get info() { return 'var(--dsw-alias-state-business-primary, ' + pal().info + ')'; },
      get skeleton() { return 'var(--dsw-alias-bg-skeleton, ' + pal().skeleton + ')'; },
      get selBg() { return 'var(--dsw-alias-interactive-bg-active, ' + pal().selBg + ')'; },
      get font() { return 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)'; },
      get mono() { return 'var(--dsw-font-mono, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace)'; }
    };

    function chip(fgKey, bgKey, fgVar) {
      return {
        get fg() { return fgVar ? 'var(' + fgVar + ', ' + pal()[fgKey] + ')' : pal()[fgKey]; },
        get bg() { return pal()[bgKey]; }
      };
    }
    const STATE = {
      pending: chip('text2', 'chipPending', '--dsw-alias-label-secondary'),
      running: chip('warn', 'chipRunning', '--dsw-alias-state-warn-primary'),
      review: chip('info', 'chipReview', '--dsw-alias-state-business-primary'),
      merged: chip('success', 'chipMerged', '--dsw-alias-state-success-primary'),
      failed: chip('error', 'chipFailed', '--dsw-alias-state-error-primary'),
      skipped: chip('text2', 'chipSkipped', '--dsw-alias-label-secondary'),
      conflict: chip('escFg', 'chipConflict', '--dsw-alias-state-warn-primary'),
      idle: chip('text2', 'chipIdle', '--dsw-alias-label-secondary')
    };
    const PHASE = {
      planning: chip('text2', 'chipSkipped', '--dsw-alias-label-secondary'),
      running: chip('warn', 'chipRunning', '--dsw-alias-state-warn-primary'),
      paused: chip('info', 'chipReview', '--dsw-alias-state-business-primary'),
      aborted: chip('error', 'chipFailed', '--dsw-alias-state-error-primary'),
      complete: chip('success', 'chipMerged', '--dsw-alias-state-success-primary')
    };
    // =======================================================
// ===== [panel-segment] widgets.js =====
    function Chip({ st, children, style }) {
      const c = st || chip('text2', 'chipPending', '--dsw-alias-label-secondary');
      return React.createElement('span', {
        style: Object.assign({
          display: 'inline-flex', alignItems: 'center', gap: 4,
          color: c.fg, background: c.bg,
          borderRadius: 999, padding: '1px 8px', fontSize: 10.5,
          fontWeight: 600, letterSpacing: 0.2, lineHeight: '16px',
          fontFamily: T.mono, whiteSpace: 'nowrap'
        }, style || null)
      }, children);
    }

    function Dot({ color }) {
      return React.createElement('span', { style: { width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' } });
    }

    function Progress({ value, color, height }) {
      const h = height || 4;
      return React.createElement('div', {
        style: { height: h, borderRadius: 999, background: T.skeleton, overflow: 'hidden', flex: 1 }
      }, React.createElement('div', {
        style: { width: Math.max(0, Math.min(100, value)) + '%', height: '100%', borderRadius: 999, background: color || T.accent, transition: 'width .3s ease' }
      }));
    }

    function Stat({ label, value, color }) {
      return React.createElement('div', {
        style: Object.assign({}, cardBase, { padding: '6px 10px', minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 })
      },
        React.createElement('span', { style: { fontSize: 10.5, color: T.text3, lineHeight: 1.2 } }, label),
        React.createElement('span', { style: { fontSize: 17, fontWeight: 700, fontFamily: T.mono, color: color || T.text, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' } }, value)
      );
    }

    function SectionTitle({ children }) {
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
        React.createElement('span', { style: { width: 3, height: 12, borderRadius: 999, background: T.accent } }),
        React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600, color: T.text, letterSpacing: 0.3 } }, children)
      );
    }

    function Skeleton({ h, w, style }) {
      return React.createElement('div', { className: 'psw-shimmer', style: Object.assign({ height: h || 12, width: w || '100%', borderRadius: 6 }, style || null) });
    }
// ===== [panel-segment] batch-list.js =====
    function BatchList({ batches, selected, onSelect, loading }) {
      return React.createElement('div', {
        className: 'psw-list psw-scroll',
        style: { width: 276, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', paddingRight: 4 }
      },
        React.createElement(SectionTitle, null, tt('batch.title') + ' · ' + (batches ? batches.length : 0)),
        loading && !batches
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              React.createElement(Skeleton, { h: 52 }),
              React.createElement(Skeleton, { h: 52 }),
              React.createElement(Skeleton, { h: 52 })
            )
          : batches && batches.length
            ? batches.map((b) => {
                const st = PHASE[b.phase] || PHASE.planning;
                const vals = Object.values(b.lanes || {});
                const done = vals.filter((s) => TERMINAL.indexOf(s) >= 0).length;
                const total = vals.length;
                const sel = selected && (typeof selected === 'object'
                  ? selected.session === b.session && selected.batchId === b.batchId
                  : selected === b.batchId);
                return React.createElement('button', {
                  key: b.session ? b.session + ':' + b.batchId : b.batchId,
                  type: 'button',
                  className: 'psw-btn',
                  onClick: () => onSelect(b),
                  'aria-pressed': sel,
                  style: Object.assign({}, cardBase, {
                    textAlign: 'left', cursor: 'pointer', padding: '8px 10px',
                    display: 'flex', flexDirection: 'column', gap: 6, width: '100%',
                    ...(sel ? { borderColor: T.accent, boxShadow: '0 0 0 1px ' + T.accent } : {}),
                    background: sel ? T.selBg : T.card
                  })
                },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                    React.createElement(Chip, { st: st }, b.phase),
                    React.createElement('span', { style: { flex: 1, fontWeight: 700, fontSize: 12.5, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, b.batchId)
                  ),
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    React.createElement(Progress, { value: total ? (done / total) * 100 : 0, color: st.fg, height: 3 }),
                    React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, done + '/' + total)
                  ),
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: T.text3 } },
                    b.sessionShort && !b.isOwnSession
                      ? React.createElement('span', { title: b.session, style: { fontFamily: T.mono, opacity: 0.9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 } }, b.sessionShort + ' ·')
                      : null,
                    b.autoReleaseable
                      ? React.createElement(React.Fragment, null, React.createElement(Dot, { color: T.success }), React.createElement('span', null, tt('batch.release')))
                      : b.phase === 'complete' || b.phase === 'aborted'
                        ? React.createElement('span', null, tt('batch.done'))
                        : React.createElement('span', null, tt('batch.progress') + ' · ' + (b.concurrency != null ? tt('concurrency') + '=' + b.concurrency : ''))
                  )
                );
              })
            : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '28px 12px', color: T.text3, textAlign: 'center' } },
                React.createElement('svg', { width: 36, height: 36, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' },
                  React.createElement('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
                  React.createElement('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
                  React.createElement('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
                  React.createElement('rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 })
                ),
                React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, color: T.text2 } }, tt('empty')),
                React.createElement('div', { style: { fontSize: 11, lineHeight: 1.5 } }, tt('empty.hint'))
              )
      );
    }
// ===== [panel-segment] batch-detail.js =====
    function GateBadge({ gate }) {
      if (!gate || !gate.layer) return null;
      const items = [];
      const seen = {};
      const add = (kind, p) => { if (!seen[p]) { seen[p] = 1; items.push({ kind: kind, path: p }); } };
      for (const p of gate.consumeMissing || []) add('consume', p);
      for (const p of gate.outputsMissing || []) add('outputs', p);
      for (const p of gate.produceMissing || []) add('produce', p);
      for (const p of gate.contractProblems || []) {
        const m = String(p).match(/^(.+?)\s+missing$/i);
        if (m) add('contract', m[1]); else add('contract', String(p));
      }
      if (!items.length) return null;
      const KIND = { consume: tt('gate.consume'), outputs: tt('gate.outputs'), produce: tt('gate.produce'), contract: tt('gate.contract') };
      return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
        items.map((it, i) => React.createElement('span', {
          key: i,
          title: KIND[it.kind] + ': ' + it.path,
          style: { color: T.warn, background: pal().gateBg, borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 600, fontFamily: T.mono, whiteSpace: 'nowrap' }
        }, tt('gate.missing') + ' ' + it.path))
      );
    }

    function AttemptBadge({ n, upgrade }) {
      if (!n && !upgrade) return null;
      const label = (upgrade ? tt('upgrade') : tt('attempt')) + ' ' + n;
      return React.createElement('span', {
        style: upgrade
          ? { color: pal().escFg, background: pal().escBg, borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 600, fontFamily: T.mono, whiteSpace: 'nowrap' }
          : { color: T.text2, fontSize: 10.5, fontFamily: T.mono, whiteSpace: 'nowrap' }
      }, label);
    }

    function LaneCard({ lane, state, attempt, upgrade, gate, meta }) {
      const st = STATE[state] || STATE.pending;
      const m = meta || {};
      const deps = m.deps && m.deps.length ? m.deps : null;
      return React.createElement('div', {
        className: 'psw-card',
        style: Object.assign({}, cardBase, {
          flex: '1 1 168px', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
          borderLeft: '3px solid ' + st.fg
        })
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, lane),
          React.createElement(Chip, { st: st }, state)
        ),
        m.cmd ? React.createElement('div', {
          style: { fontSize: 11, color: T.text2, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
        }, m.cmd) : null,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
          React.createElement(GateBadge, { gate }),
          React.createElement(AttemptBadge, { n: attempt, upgrade }),
          m.layer ? React.createElement('span', { style: { fontSize: 10, color: T.text3, fontFamily: T.mono } }, tt('task.layer') + ' ' + m.layer) : null,
          deps ? React.createElement('span', { style: { fontSize: 10, color: T.dim, fontFamily: T.mono } }, tt('task.deps') + ': ' + deps.join(', ')) : null
        )
      );
    }

    function EventRow({ e }) {
      const kind = String(e.type || '').toLowerCase();
      const color = kind.indexOf('running') >= 0 ? T.warn : kind.indexOf('fail') >= 0 || kind.indexOf('conflict') >= 0 ? T.error : kind.indexOf('merge') >= 0 ? T.success : kind.indexOf('review') >= 0 ? T.info : T.text3;
      const label = e.type + (e.lane ? ':' + e.lane : '') + (e.from ? ' ' + e.from + '->' + e.to : '');
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
        React.createElement(Dot, { color: color }),
        React.createElement('span', { style: { flex: 1, fontSize: 11.5, color: T.text2, fontFamily: T.mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        React.createElement('span', { style: { fontSize: 10.5, color: T.dim, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' } }, (e.ts || '').slice(11, 19))
      );
    }
    function BatchDetail({ d }) {
      if (!d) {
        return React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' } },
          React.createElement(Skeleton, { h: 64 }),
          React.createElement(Skeleton, { h: 40 }),
          React.createElement(Skeleton, { h: 120 })
        );
      }
      const lanes = Object.keys(d.lanes || {});
      const vals = Object.values(d.lanes || {});
      const done = vals.filter((s) => TERMINAL.indexOf(s) >= 0).length;
      const issues = vals.filter((s) => s === 'failed' || s === 'conflict').length;
      const st = PHASE[d.phase] || PHASE.planning;
      const evs = (d.recentEvents || []).slice().reverse();
      const mail = d.mail || { inbox: [], broadcast: [] };
      const laneMeta = {};
      for (const w of d.wavePlan || []) {
        for (const t of w.tasks || []) {
          laneMeta[t.id] = { cmd: t.cmd || '', layer: t.layer || null, role: t.role || null, deps: t.deps || [] };
        }
      }
      return React.createElement('div', { className: 'psw-scroll', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', paddingRight: 4 } },
        React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }) },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            React.createElement(Chip, { st: st }, d.phase + (d.viewSettled ? ' ✓' : '')),
            React.createElement('span', { style: { fontWeight: 700, fontSize: 14, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, d.batchId),
            React.createElement('span', { style: { flex: 1 } }),
            d.autoReleaseable
              ? React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, color: T.success, fontSize: 11, fontWeight: 600 } },
                  React.createElement(Dot, { color: T.success }), tt('batch.release'))
              : null
          ),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement(Progress, { value: lanes.length ? (done / lanes.length) * 100 : 0, color: issues ? T.error : (lanes.length && done === lanes.length) ? T.success : (d.phase === 'running' || d.phase === 'paused') ? T.warn : T.dim }),
            React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, done + '/' + lanes.length)
          ),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 10.5, color: T.text3, flexWrap: 'wrap' } },
            React.createElement('span', null, tt('lanes') + ' ' + lanes.length),
            React.createElement('span', null, tt('events') + ' ' + (d.eventCount != null ? d.eventCount : (d.recentEvents || []).length)),
            React.createElement('span', null, tt('concurrency') + '=' + d.concurrency)
          )
        ),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          lanes.map((lane) => React.createElement(LaneCard, {
            key: lane, lane: lane, state: d.lanes[lane],
            attempt: (d.laneAttempts || {})[lane], upgrade: (d.upgrades || {})[lane],
            gate: (d.lanesGate || {})[lane], meta: laneMeta[lane]
          }))
        ),
        React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '10px 12px' }) },
          React.createElement(SectionTitle, null, tt('event.timeline')),
          evs.length
            ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } }, evs.map((e, i) => React.createElement(EventRow, { key: i, e })))
            : React.createElement('div', { style: { fontSize: 11.5, color: T.text3, padding: '4px 0' } }, tt('empty'))
        ),
        React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }) },
          React.createElement(SectionTitle, null, tt('mailbox.title')),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: T.skeleton, borderRadius: 8, padding: '6px 10px' } },
              React.createElement(Dot, { color: T.info }),
              React.createElement('span', { style: { fontSize: 11, color: T.text2 } }, tt('mailbox.inbox')),
              React.createElement('span', { style: { marginLeft: 'auto', fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: T.text, fontVariantNumeric: 'tabular-nums' } }, mail.inbox.length)
            ),
            React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: T.skeleton, borderRadius: 8, padding: '6px 10px' } },
              React.createElement(Dot, { color: T.warn }),
              React.createElement('span', { style: { fontSize: 11, color: T.text2 } }, tt('mailbox.broadcast')),
              React.createElement('span', { style: { marginLeft: 'auto', fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: T.text, fontVariantNumeric: 'tabular-nums' } }, mail.broadcast.length)
            )
          ),
          mail.inbox.length + mail.broadcast.length === 0
            ? React.createElement('div', { style: { fontSize: 11, color: T.text3 } }, tt('mailbox.hint'))
            : null
        )
      );
    }
// ===== [panel-segment] main.js =====
    const NS = 'dsh-punky-swarm';
    const inject = ['slots', 'locale'];
    async function api(path, session) {
      const base = '/api/dsh-punky-swarm' + path;
      const url = session
        ? base + (base.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(session)
        : base;
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    // 跨会话聚合：/sessions 取全部有批次的会话 → 逐会话 /batches 合并为统一列表；
    // 当前对话会话（sid）批次优先，其后按会话展示；列表项携带 session 归属字段
    async function aggregateBatches(sid) {
      let sessions = [];
      try {
        const r = await api('/sessions');
        sessions = (r && r.sessions) || [];
      } catch {}
      const ids = [];
      if (sid) ids.push(sid);
      for (const s of sessions) {
        if (s && s.sessionId && s.sessionId !== sid) ids.push(s.sessionId);
      }
      const out = [];
      for (const id of ids) {
        let items = [];
        try {
          const r = await api('/batches', id);
          items = (r && r.batches) || [];
        } catch {}
        for (const b of items) {
          out.push(Object.assign({}, b, {
            session: id,
            sessionShort: String(id).slice(0, 8),
            isOwnSession: id === sid
          }));
        }
      }
      return out;
    }

    // 浏览器端 TERMINAL 副本：Node 端单点 = lib/state/constants.js（P1-07 收敛）；
    // 面板段经 window.__ModuleLoader__ 拼接执行（无 ESM import 能力），此处为手工同步副本，
    // batch-list/batch-detail 段共享本作用域引用（渲染时求值）。
    const TERMINAL = ['merged', 'failed', 'skipped', 'conflict'];
    const cardBase = {
      get background() { return T.card; },
      get borderWidth() { return 1; },
      get borderStyle() { return 'solid'; },
      get borderColor() { return T.border; },
      borderRadius: 10
    };
    function ClusterWorkbench({ sessionId }) {
      const [batches, setBatches] = useState(null);
      const [sel, setSel] = useState(null);
      const [detail, setDetail] = useState(null);
      const [updated, setUpdated] = useState(null);
      const [mode, setMode] = useState('sse'); // 'sse' | 'poll'（R3 SSE 降级回轮询状态，D6 简化②）
      const [, setThemeTick] = useState(0);
      const sid = sessionId || '';

      // 跟随 web UI 主题（body[data-ds-dark-theme]）切换兜底色板并重渲染
      useEffect(() => {
        const apply = () => {
          const t = detectTheme();
          if (t !== CURRENT_THEME) { CURRENT_THEME = t; setThemeTick((x) => x + 1); }
        };
        let mo = null;
        try {
          if (typeof MutationObserver !== 'undefined' && document.body) {
            mo = new MutationObserver(apply);
            mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
          }
        } catch {}
        let mq = null;
        try {
          if (typeof matchMedia !== 'undefined') {
            mq = matchMedia('(prefers-color-scheme: light)');
            if (mq.addEventListener) mq.addEventListener('change', apply);
          }
        } catch {}
        return () => {
          if (mo) mo.disconnect();
          if (mq && mq.removeEventListener) mq.removeEventListener('change', apply);
        };
      }, []);

      // R3 SSE 列表流（设计 §3.3.4）：EventSource 主通道 + 3s 轮询降级兜底（D2 保留既有轮询路径不删）。
      // 收到 batch 信号 → eventCount 去重（旧于当前忽略）→ 重跑既有聚合；onerror / 15s 无心跳 → 回退轮询；
      // 重连成功（EventSource 自动重连 / 心跳恢复）→ 停轮询回 SSE。
      useEffect(() => {
        let alive = true;
        let es = null;
        let pollIv = null;
        let lastBeat = 0;
        let degraded = false;
        const seen = new Map(); // batchId -> 已见 eventCount（服务端摘要去重，旧于当前忽略）
        const tick = async () => {
          try {
            const agg = await aggregateBatches(sid);
            if (!alive) return;
            setBatches(agg); setUpdated(new Date());
            for (const b of agg) {
              if (typeof b.eventCount === 'number') seen.set(b.batchId, Math.max(seen.get(b.batchId) || 0, b.eventCount));
            }
          } catch {}
        };
        const startPoll = () => { if (degraded || pollIv) return; degraded = true; setMode('poll'); pollIv = setInterval(tick, 3000); };
        const stopPoll = () => { degraded = false; if (pollIv) { clearInterval(pollIv); pollIv = null; } setMode('sse'); };
        const onBatch = (ev) => {
          lastBeat = Date.now();
          try {
            const d = JSON.parse(ev.data);
            const bid = d.batchId, n = d.eventCount;
            if (bid && typeof n === 'number' && seen.get(bid) != null && n <= seen.get(bid)) return; // 旧于当前忽略
            if (bid && typeof n === 'number') seen.set(bid, n);
            tick();
          } catch { tick(); }
        };
        const onHeartbeat = () => { lastBeat = Date.now(); if (degraded) stopPoll(); }; // 心跳恢复 → 回 SSE
        const connect = () => {
          try {
            if (typeof EventSource === 'undefined' || !sid) { startPoll(); return; }
            es = new EventSource('/api/dsh-punky-swarm/stream?session=' + encodeURIComponent(sid));
            es.addEventListener('batch', onBatch);
            es.addEventListener('heartbeat', onHeartbeat);
            es.onopen = () => { lastBeat = Date.now(); stopPoll(); };
            es.onerror = () => { lastBeat = Date.now(); if (!degraded) startPoll(); }; // 断流 → 轮询兜底（EventSource 自动重连）
          } catch { startPoll(); }
        };
        tick();
        connect();
        const stall = setInterval(() => {
          if (!degraded && es && lastBeat && Date.now() - lastBeat > 15000) startPoll(); // 15s 无心跳 → 降级轮询
        }, 5000);
        return () => { alive = false; if (es) { try { es.close(); } catch {} } if (pollIv) clearInterval(pollIv); clearInterval(stall); };
      }, [sid]);
      // R3 SSE 详情流（设计 §3.3.4）：信号 → 回拉 /batch + 双 /mailbox（复用既有逻辑）；降级回轮询语义同列表流
      useEffect(() => {
        if (!sel) { setDetail(null); return; }
        let alive = true;
        let es = null;
        let pollIv = null;
        let lastBeat = 0;
        let degraded = false;
        let lastCount = null;
        const tick = async () => {
          try {
            const d = await api('/batch?batchId=' + encodeURIComponent(sel.batchId), sel.session);
            let mail = { inbox: [], broadcast: [] };
            try { mail.inbox = (await api('/mailbox?batchId=' + encodeURIComponent(sel.batchId) + '&box=inbox', sel.session)).items; } catch {}
            try { mail.broadcast = (await api('/mailbox?batchId=' + encodeURIComponent(sel.batchId) + '&box=broadcast', sel.session)).items; } catch {}
            if (alive) { setDetail(Object.assign({}, d, { mail })); lastCount = d.eventCount; }
          } catch {}
        };
        const startPoll = () => { if (degraded || pollIv) return; degraded = true; setMode('poll'); pollIv = setInterval(tick, 3000); };
        const stopPoll = () => { degraded = false; if (pollIv) { clearInterval(pollIv); pollIv = null; } setMode('sse'); };
        const onSignal = (ev) => {
          lastBeat = Date.now();
          try {
            const d = JSON.parse(ev.data);
            if (typeof d.eventCount === 'number' && lastCount != null && d.eventCount <= lastCount) return; // 旧于当前忽略
            tick();
          } catch { tick(); }
        };
        const onHeartbeat = () => { lastBeat = Date.now(); if (degraded) stopPoll(); };
        const connect = () => {
          try {
            if (typeof EventSource === 'undefined' || !sel.session) { startPoll(); return; }
            es = new EventSource('/api/dsh-punky-swarm/stream?session=' + encodeURIComponent(sel.session) + '&batchId=' + encodeURIComponent(sel.batchId));
            es.addEventListener('batch', onSignal);
            es.addEventListener('mailbox', onSignal); // 帧协议 event: mailbox（mailbox 目录变更信号，回拉双 /mailbox）
            es.addEventListener('heartbeat', onHeartbeat);
            es.onopen = () => { lastBeat = Date.now(); stopPoll(); };
            es.onerror = () => { lastBeat = Date.now(); if (!degraded) startPoll(); };
          } catch { startPoll(); }
        };
        tick();
        connect();
        const stall = setInterval(() => {
          if (!degraded && es && lastBeat && Date.now() - lastBeat > 15000) startPoll();
        }, 5000);
        return () => { alive = false; if (es) { try { es.close(); } catch {} } if (pollIv) clearInterval(pollIv); clearInterval(stall); };
      }, [sel]);

      const list = batches || [];
      const running = list.filter((b) => b.phase === 'running').length;
      const doneCnt = list.filter((b) => b.phase === 'complete').length;
      let issues = 0;
      for (const b of list) {
        const vals = Object.values(b.lanes || {});
        issues += vals.filter((s) => s === 'failed' || s === 'conflict').length;
      }
      const liveColor = !batches ? T.dim : running ? T.warn : T.success;
      const halo = !batches ? 'transparent' : running ? pal().haloWarn : pal().haloSuccess;
      const updatedText = updated
        ? updated.toTimeString().slice(0, 8)
        : '--:--:--';

      return React.createElement('div', {
        'aria-busy': !batches,
        style: {
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10,
          padding: '14px 16px', color: T.text, fontFamily: T.font
        }
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('span', { style: { fontSize: 15, fontWeight: 700, letterSpacing: 0.2 } }, tt('view.cluster')),
            React.createElement('span', { className: 'psw-pulse', style: { width: 7, height: 7, borderRadius: 999, background: liveColor, boxShadow: '0 0 0 3px ' + halo } }),
            React.createElement('span', { style: { fontSize: 10, fontWeight: 600, letterSpacing: 0.8, color: liveColor } }, tt('live'))
          ),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono } }, tt(mode === 'poll' ? 'stream.fallback' : 'stream.live')),
          React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' } }, '· ' + tt('updated') + ' ' + updatedText)
        ),
        React.createElement('div', { role: 'status', 'aria-atomic': 'true', style: { display: 'flex', gap: 8 } },
          React.createElement(Stat, { label: tt('stat.total'), value: list.length }),
          React.createElement(Stat, { label: tt('stat.running'), value: running, color: T.warn }),
          React.createElement(Stat, { label: tt('stat.done'), value: doneCnt, color: T.success }),
          React.createElement(Stat, { label: tt('stat.issues'), value: issues, color: issues ? T.error : T.text3 })
        ),
        React.createElement('div', { className: 'psw-panes' },
          React.createElement(BatchList, { batches: batches, selected: sel, onSelect: setSel, loading: true }),
          React.createElement(BatchDetail, { d: detail })
        )
      );
    }

    function apply(ctx) {
      if (typeof document !== 'undefined' && !document.getElementById('dsh-punky-swarm-ui')) {
        const el = document.createElement('style');
        el.id = 'dsh-punky-swarm-ui';
        el.textContent = "body{--psw-shimmer-a:#eef2f7;--psw-shimmer-b:rgba(120,140,170,.16)}\nbody[data-ds-dark-theme]{--psw-shimmer-a:#1d2740;--psw-shimmer-b:rgba(148,163,184,.14)}\n.psw-scroll::-webkit-scrollbar{width:8px;height:8px}\n.psw-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,rgba(148,163,184,.35));border-radius:999px}\n.psw-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l1,rgba(148,163,184,.5))}\n.psw-btn{transition:background .15s ease,border-color .15s ease,transform .15s ease}\n.psw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,184,.09))}\n.psw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:2px}\n.psw-card{transition:border-color .15s ease,background .15s ease}\n.psw-pulse{animation:pswPulse 2s ease-in-out infinite}\n@keyframes pswPulse{0%,100%{opacity:1}50%{opacity:.3}}\n.psw-shimmer{background:linear-gradient(90deg,var(--psw-shimmer-a) 30%,var(--psw-shimmer-b) 50%,var(--psw-shimmer-a) 70%);background-size:200% 100%;animation:pswShimmer 1.4s linear infinite}\n@keyframes pswShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}\n.psw-panes{display:flex;gap:12px;flex:1;min-height:0}\n@media (max-width:760px){.psw-panes{flex-direction:column}.psw-list{width:100%!important;max-height:240px}}\n@media (prefers-reduced-motion:reduce){.psw-pulse,.psw-shimmer{animation:none}.psw-btn,.psw-card{transition:none}}";
        document.head.appendChild(el);
      }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-punky-swarm: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'cluster',
        order: 20,
        locale: NS,
        label: () => t('view.cluster'),
        inject: (sessionId) => ({ sessionId })
      }, ClusterWorkbench));
      // 治理配置页（settings.section；与 conversation.view 并存，两 seat 互不排他）。
      // order=16：出厂占用 0/10/15/20（host-impl-facts §②），16..19 空闲位取 16；
      // label thunk 随 locale 惰性重读；页面自带 GET/POST 取数，inject 省略（owner 仅收 { close }）。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'governance-config',
        order: 16,
        locale: NS,
        label: () => t('nav.governance')
      }, GovernanceConfigSection));
    }

    module.exports = { apply, inject };
    return module.exports;
// ===== [panel-segment] gov-config.js =====
    // 治理配置页（settings.section，id='governance-config' order=16；main.js apply() 注册）。
    // 段内仅 function 声明：本段物理序在 main.js 之后（工厂体以 module.exports/return 收尾），
    // 依赖函数声明提升在 apply 注册引用时可用——禁止在本段顶层出现 const/let/var（死区永不初始化）。
    // 引用的 T/cardBase/tt/chip/STATE/Dot/Chip/Skeleton 等为前序段绑定（渲染时已初始化）；
    // 本页专属标题/复选行/字号基准 = 段内 G()/GovHeader/PresetCheckRow（不动共享 SectionTitle——避免波及其它视图）。
    //
    // 数据契约 = GET /api/dsh-punky-swarm/config → { overlay, applied, presets }
    //   overlay = <root>/config/runtime.json governance 段原样（磁盘原文；无 = null）
    //   applied = 引擎 resolve 后的生效快照——preset 已被展开为 rules（不保留 preset 键），
    //             故 preset 当前值只读 overlay.hook.preset；applied 仅用于「生效规则数/生效状态」展示。
    //   presets = [{ id, count }] 注册目录元数据（复选行/合计规则数摘要：l1=12 / l2=6 / compose=18）。
    // 写契约 = POST 同路径，body { governance: { hook: { enabled, preset?, escalation, flags } } }，
    //         400 → { ok:false, errors:[{ field, code, message }] }（页面按 code 双语映射）。
    // 窗口单位（webui-config-fix2-20260904）：GET overlay.escalation.windowMs 存 ms（毫秒契约不变）；
    //   表单以秒显示/输入（初值 = windowMs/1000），提交走 escalation.windowSeconds（秒语义字段），
    //   后端 runtime-config.js 换算 ×1000 归一为 windowMs 落盘——UI 提交层单位约定，引擎侧不改。
    // preset 语义（本次多选改造）：装载键 = string | string[]；compose 与 l1+l2 展开等价且 id 重叠，
    //   同批引用 compose+l1 会被引擎唯一性校验拒（resolve 回退空表）→ UI 不复选 compose：
    //   勾选集仅 l1/l2 两 checkbox，全勾 = ["l1-sensitive","l2-resource"]（18 条，compose 等效）；
    //   全不勾 = 省略 preset 键（后端删键回出厂零规则；空数组/空串会被后端 400 拒）。

    // —— 字号基准（配置页局部；宿主 settings 卡片 15/13/12 尺度对齐，整体较旧版上调一级）——
    // 本段顶层禁 const（物理序在 main.js 的 return 之后，死区永不初始化）→ 一律函数声明取数。
    function G() {
      return {
        title: 13,   // 卡片标题
        row: 13,     // 行标题（开关/复选行）
        sub: 12,     // 行说明/提示
        label: 12.5, // 字段名 label
        input: 13,   // 输入/数值控件文本
        cap: 12,     // 小标注/警示/合计行
        chip: 11.5,  // mono 编码小件（原语 chip / 单位后缀）
        btn: 13      // 动作按钮
      };
    }
    function fmtN(k, n) { return tt(k).replace('{n}', String(n)); }
    function pickBool(a, b, d) { return typeof a === 'boolean' ? a : typeof b === 'boolean' ? b : d; }
    function pickNum(a, b, d) { return typeof a === 'number' && isFinite(a) ? a : typeof b === 'number' && isFinite(b) ? b : d; }
    function clockOf(d) { try { return d.toTimeString().slice(0, 8); } catch { return ''; } }
    // 可选装载复选集 = l1 + l2（不再提供 compose 作独立项；compose 仅作旧值回显展开，见 formPresetOf）
    function presetOptionIds() { return ['l1-sensitive', 'l2-resource']; }
    function escPrimitives() { return ['DENY', 'NARROW', 'DEFER', 'PAUSE']; } // REQUIRE_APPROVAL 红线不可经表单（引擎契约），不出现
    function presetMeaningKey(id) {
      switch (id) {
        case 'l1-sensitive': return 'gov.preset.l1';
        case 'l2-resource': return 'gov.preset.l2';
        case 'compose': return 'gov.preset.compose';
        default: return null;
      }
    }
    // GET overlay.hook.preset 回显 → 表单勾选集。兼容：单字符串（compose/l1-sensitive/l2-resource）|
    // string[] | 空/省略 → null（全不勾）。'compose' = l1+l2 展开全勾（旧值迁移，保存归一为数组）。
    // 含未注册 id / 非法形态 → { custom: <原文> }（无勾选位可表，保存原样保留 + 警示）。
    function formPresetOf(pv) {
      if (pv === undefined || pv === null || pv === '') return null;
      const raw = typeof pv === 'string' ? [pv] : Array.isArray(pv) ? pv : null;
      if (!raw) return { custom: pv };
      const opts = presetOptionIds();
      const sel = [];
      for (const id of raw) {
        if (id === 'compose') { if (sel.indexOf('l1-sensitive') < 0) sel.push('l1-sensitive'); if (sel.indexOf('l2-resource') < 0) sel.push('l2-resource'); }
        else if (opts.indexOf(id) >= 0) { if (sel.indexOf(id) < 0) sel.push(id); }
        else return { custom: pv }; // 含未知 id（如并发手工混入 compose+l1 的旧文件）→ 整值原样保留
      }
      return opts.filter((id) => sel.indexOf(id) >= 0).length ? opts.filter((id) => sel.indexOf(id) >= 0) : null;
    }
    // 表单勾选集 → POST 装载键：null = 省略 preset 键（回出厂零规则，后端删键）；数组 = string[] 装载键；
    // { custom } = 原文透传（后端 unknown-preset 校验自行裁决）。
    function presetWireOf(fp) {
      if (fp === null || fp === undefined) return undefined;
      if (fp && typeof fp === 'object' && !Array.isArray(fp) && 'custom' in fp) return fp.custom;
      return fp; // string[]（deriveForm 归一非空）
    }
    function errorLabelKey(code) {
      switch (code) {
        case 'unknown-preset': return 'gov.err.unknownPreset';
        case 'field-not-allowed': return 'gov.err.fieldNotAllowed';
        case 'invalid-value': return 'gov.err.invalidValue';
        case 'unknown-top-level': return 'gov.err.topLevel';
        case 'preset-conflicts-inline-rules': return 'gov.err.conflict';
        default: return null;
      }
    }
    async function getConfig() {
      const res = await fetch('/api/dsh-punky-swarm/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }
    async function postConfig(body) {
      const res = await fetch('/api/dsh-punky-swarm/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        const e = new Error('HTTP ' + res.status);
        e.status = res.status;
        e.data = data;
        throw e;
      }
      return data;
    }
    // 表单初值：overlay（磁盘原文）优先、applied（生效默认补齐）兜底——字段粒度合并。
    // preset 只读 overlay.hook.preset（applied 不保留 preset）；null=出厂空表（保存省略键）；
    // 回显兼容映射见 formPresetOf：'compose' → 全勾数组、string[] → 按项勾、空/省略 → null。
    function deriveForm(data) {
      const ov = data && data.overlay && data.overlay.hook ? data.overlay.hook : null;
      const ap = data && data.applied && data.applied.hook ? data.applied.hook : null;
      const escO = (ov && ov.escalation) || {};
      const escA = (ap && ap.escalation) || {};
      const flO = (ov && ov.flags) || {};
      const flA = (ap && ap.flags) || {};
      return {
        enabled: pickBool(ov && ov.enabled, ap && ap.enabled, true),
        preset: formPresetOf(ov && ov.preset), // null | string[]（勾选集） | { custom: 原文 }
        escalation: {
          enabled: pickBool(escO.enabled, escA.enabled, false),
          threshold: String(pickNum(escO.threshold, escA.threshold, 3)),
          // 窗口单位：overlay/applied 存 windowMs（ms，毫秒契约）→ 表单以秒显示/输入（/1000）；
          // 缺省 600000ms = 600s。提交走 windowSeconds（秒）由后端 ×1000 归一落盘。
          windowSecs: String(pickNum(escO.windowMs, escA.windowMs, 600000) / 1000),
          primitives: Array.isArray(escO.primitives)
            ? escO.primitives.slice()
            : Array.isArray(escA.primitives) ? escA.primitives.slice() : ['DENY', 'NARROW']
        },
        narrow: pickBool(flO.narrow, flA.narrow, false)
      };
    }
    function deriveMeta(data) {
      const ov = (data && data.overlay) || null;
      const ap = (data && data.applied) || null;
      const ovHook = ov && ov.hook ? ov.hook : null;
      const apHook = ap && ap.hook ? ap.hook : null;
      const presets = {};
      const list = data && Array.isArray(data.presets) ? data.presets : [];
      for (const p of list) {
        if (p && typeof p.id === 'string') presets[p.id] = typeof p.count === 'number' ? p.count : 0;
      }
      return {
        rules: apHook && Array.isArray(apHook.rules) ? apHook.rules.length : 0, // 生效规则数（applied）
        manualRules: ovHook && Array.isArray(ovHook.rules) ? ovHook.rules.length : 0, // 手工规则（overlay）
        presets: presets,
        applied: ap
      };
    }
    // applied 生效快照签名（含展开 rules 数；preset 不在此列——applied 已展开）
    function hookSig(h) {
      const esc = (h && h.escalation) || {};
      const fl = (h && h.flags) || {};
      return JSON.stringify({
        enabled: !!(h && h.enabled),
        escalation: {
          enabled: !!esc.enabled,
          threshold: typeof esc.threshold === 'number' ? esc.threshold : null,
          windowMs: typeof esc.windowMs === 'number' ? esc.windowMs : null,
          primitives: Array.isArray(esc.primitives) ? esc.primitives.slice().sort() : null
        },
        narrow: !!(fl && fl.narrow),
        rules: h && Array.isArray(h.rules) ? h.rules.length : 0
      });
    }
    // remount 确认：生效快照已变化且 enabled 与提交一致 → 判定生效（快照未变=热更未落，继续轮询）
    function appliedMatches(payload, beforeSig, applied) {
      if (!applied || !applied.hook) return false;
      if (applied.hook.enabled !== payload.governance.hook.enabled) return false;
      const sig = hookSig(applied.hook);
      if (beforeSig !== null && sig === beforeSig) return false;
      return true;
    }
    function GovCard({ title, children }) {
      return React.createElement('div', {
        style: Object.assign({}, cardBase, { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9 })
      },
        title
          ? React.createElement('div', { style: { fontSize: G().title, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, title)
          : null,
        children
      );
    }
    // 配置页主标题（SectionTitle 同形态、字号上调到宿主设置页标题尺度；不改共享 widgets.SectionTitle——避免波及其它视图）
    function GovHeader({ children }) {
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
        React.createElement('span', { style: { width: 3, height: 14, borderRadius: 999, background: T.accent } }),
        React.createElement('span', { style: { fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: 0.3 } }, children)
      );
    }
    function SwitchRow({ checked, onChange, title, desc, disabled }) {
      const on = !!checked;
      return React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { style: { fontSize: G().row, fontWeight: 600, color: T.text, lineHeight: 1.35 } }, title),
          desc
            ? React.createElement('div', { style: { fontSize: G().sub, color: T.text3, lineHeight: 1.45, marginTop: 3 } }, desc)
            : null
        ),
        React.createElement('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          disabled: !!disabled,
          onClick: () => onChange(!on),
          style: {
            position: 'relative', boxSizing: 'border-box', flex: 'none',
            width: 36, height: 20, borderRadius: 999, padding: 0,
            background: on ? T.accent : T.skeleton,
            border: '1px solid ' + (on ? 'transparent' : T.border),
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            transition: 'background .15s ease'
          }
        },
          React.createElement('span', {
            style: {
              position: 'absolute', top: 2, left: on ? 18 : 2,
              width: 14, height: 14, borderRadius: 999,
              background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)',
              transition: 'left .15s ease'
            }
          })
        )
      );
    }
    // preset 复选行（规则预设多选）：行 = 语义标题 + id · 规则数（mono）+ 右侧方形勾选框（与 SwitchRow 同几何）
    function PresetCheckRow({ checked, onChange, title, sub, disabled }) {
      const on = !!checked;
      return React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { style: { fontSize: G().row, fontWeight: 600, color: T.text, lineHeight: 1.35 } }, title),
          React.createElement('div', { style: { fontSize: G().sub, color: T.text3, fontFamily: T.mono, lineHeight: 1.45, marginTop: 3 } }, sub)
        ),
        React.createElement('button', {
          type: 'button',
          role: 'checkbox',
          'aria-checked': on,
          disabled: !!disabled,
          onClick: () => onChange(!on),
          style: {
            position: 'relative', boxSizing: 'border-box', flex: 'none', marginTop: 1,
            width: 18, height: 18, borderRadius: 5, padding: 0,
            background: on ? T.accent : T.card,
            border: '1px solid ' + (on ? T.accent : T.border),
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            transition: 'background .15s ease, border-color .15s ease'
          }
        },
          on
            ? React.createElement('span', {
                style: {
                  position: 'absolute', top: 3, left: 5,
                  width: 5, height: 9,
                  border: 'solid #fff', borderWidth: '0 2px 2px 0',
                  transform: 'rotate(45deg)'
                }
              })
            : null
        )
      );
    }
    function NumberField({ label, value, onChange, min, step, suffix, disabled }) {
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        React.createElement('span', { style: { flex: 1, fontSize: G().label, color: T.text2, lineHeight: 1.3 } }, label),
        React.createElement('input', {
          type: 'number', min: min, step: step, value: value, disabled: !!disabled,
          onChange: (e) => onChange(e.target.value),
          style: {
            width: 96, background: T.card, color: T.text,
            border: '1px solid ' + T.border, borderRadius: 8, padding: '5px 8px',
            fontSize: G().input, fontFamily: T.mono, outline: 'none', textAlign: 'right',
            opacity: disabled ? 0.55 : 1
          }
        }),
        suffix
          ? React.createElement('span', { style: { fontSize: G().chip, color: T.text3, fontFamily: T.mono, width: 20, flex: 'none' } }, suffix)
          : null
      );
    }
    function PrimitiveChips({ value, onChange, disabled }) {
      return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        escPrimitives().map((p) => {
          const on = value.indexOf(p) >= 0;
          return React.createElement('button', {
            key: p, type: 'button', disabled: !!disabled,
            onClick: () => onChange(on ? value.filter((x) => x !== p) : value.concat([p])),
            style: {
              fontFamily: T.mono, fontSize: G().chip, fontWeight: 700, letterSpacing: 0.3,
              padding: '3px 10px', borderRadius: 999, cursor: disabled ? 'default' : 'pointer',
              color: on ? '#fff' : T.text2,
              background: on ? T.accent : 'transparent',
              border: '1px solid ' + (on ? T.accent : T.border),
              opacity: disabled ? 0.55 : 1
            }
          }, p);
        })
      );
    }
    function GovernanceConfigSection({ close }) { // settings.section owner props：close（settings 弹窗关闭，本期预留）
      const [state, setState] = useState('loading'); // loading|ready|saving|confirming|live|error
      const [form, setForm] = useState(null);        // 表单值（overlay 基准 + applied 兜底补齐）
      const [base, setBase] = useState(null);        // 最近载入/保存快照 JSON（dirty 基准）
      const [meta, setMeta] = useState(null);        // { rules, manualRules, rawPreset, presets, applied }
      const [liveAt, setLiveAt] = useState(null);
      const [err, setErr] = useState(null);          // { net:true } | { items:[{code,message}] }
      const [confirm, setConfirm] = useState(null);  // { payload, beforeSig }
      const [, setTick] = useState(0);

      // 主题跟随（body[data-ds-dark-theme] + prefers-color-scheme），与蟛蜞集群面板同型
      useEffect(() => {
        const apply = () => {
          const t = detectTheme();
          if (t !== CURRENT_THEME) { CURRENT_THEME = t; setTick((x) => x + 1); }
        };
        let mo = null;
        try {
          if (typeof MutationObserver !== 'undefined' && document.body) {
            mo = new MutationObserver(apply);
            mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
          }
        } catch {}
        let mq = null;
        try {
          if (typeof matchMedia !== 'undefined') {
            mq = matchMedia('(prefers-color-scheme: light)');
            if (mq.addEventListener) mq.addEventListener('change', apply);
          }
        } catch {}
        return () => {
          if (mo) mo.disconnect();
          if (mq && mq.removeEventListener) mq.removeEventListener('change', apply);
        };
      }, []);

      // 页载取数（GET /config → form/meta；overlay 为表单基准，见段头契约注释）
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const data = await getConfig();
            if (!alive) return;
            const f = deriveForm(data);
            setForm(f); setBase(JSON.stringify(f));
            setMeta(deriveMeta(data));
            setLiveAt(new Date());
            setErr(null); setConfirm(null); setState('ready');
          } catch {
            if (!alive) return;
            setErr({ net: true }); setState('error');
          }
        })();
        return () => { alive = false; };
      }, []);

      // 保存后 remount 确认轮询：500ms×6（≤3s）→ 2s×6 低频 → 终态兜底转 live；依赖 confirm 对象重启
      useEffect(() => {
        if (!confirm) return;
        let alive = true;
        let tries = 0;
        let timer = null;
        const tick = async () => {
          if (!alive) return;
          tries += 1;
          try {
            const data = await getConfig();
            if (!alive) return;
            setMeta(deriveMeta(data));
            if (appliedMatches(confirm.payload, confirm.beforeSig, data && data.applied)) {
              setLiveAt(new Date()); setState('live');
              return;
            }
          } catch {}
          if (!alive) return;
          if (tries < 6) timer = setTimeout(tick, 500);       // ≤3s 快轮询确认 remount
          else if (tries < 12) timer = setTimeout(tick, 2000); // 低频续等热更（300ms 防抖链）
          else { setLiveAt(new Date()); setState('live'); }    // 兜底：已写入即视为生效
        };
        tick();
        return () => { alive = false; if (timer) clearTimeout(timer); };
      }, [confirm]);

      async function reload() {
        setState('loading'); setErr(null);
        try {
          const data = await getConfig();
          const f = deriveForm(data);
          setForm(f); setBase(JSON.stringify(f));
          setMeta(deriveMeta(data));
          setLiveAt(new Date()); setConfirm(null); setState('ready');
        } catch { setErr({ net: true }); setState('error'); }
      }
      function patch(p) { setForm(Object.assign({}, form, p)); }
      function patchEsc(p) { patch({ escalation: Object.assign({}, form.escalation, p) }); }
      // preset 复选切换：勾选集 = string[] 子集（保序）；全取消 → null（保存省略键回出厂）；自定义引用被替换为显式勾选
      function togglePreset(id, on) {
        const opts = presetOptionIds();
        let cur = Array.isArray(form.preset) ? form.preset.slice() : [];
        if (on) { if (cur.indexOf(id) < 0) cur.push(id); }
        else cur = cur.filter((x) => x !== id);
        const next = opts.filter((x) => cur.indexOf(x) >= 0);
        patch({ preset: next.length ? next : null });
      }
      async function handleSave() {
        const esc = form.escalation;
        const threshold = Number(esc.threshold);
        const windowSecs = Number(esc.windowSecs); // 秒语义；后端 ×1000 归一 windowMs（毫秒契约不变）
        const bad = [];
        if (!Number.isInteger(threshold) || threshold < 1) bad.push({ code: 'invalid-value', message: tt('gov.esc.threshold') });
        if (!Number.isFinite(windowSecs) || windowSecs < 1) bad.push({ code: 'invalid-value', message: tt('gov.esc.window') });
        if (bad.length) { setErr({ items: bad }); return; }
        const prims = esc.primitives.filter((p) => escPrimitives().indexOf(p) >= 0);
        // POST 装载键：null/undefined = 省略 preset 键（后端删键回出厂零规则）；数组 = string[]；
        // { custom } = 原文透传。全不勾必须省略键（后端拒空数组/空串，runtime-config.js §③）
        const presetWire = presetWireOf(form.preset);
        const hook = {
          enabled: !!form.enabled,
          escalation: { enabled: !!esc.enabled, threshold: threshold, windowSeconds: windowSecs, primitives: prims },
          flags: { narrow: !!form.narrow }
        };
        if (presetWire !== undefined) hook.preset = presetWire;
        const payload = { governance: { hook: hook } };
        const beforeSig = meta && meta.applied ? hookSig(meta.applied.hook) : null;
        setErr(null); setState('saving');
        try {
          await postConfig(payload);
          setBase(JSON.stringify(form));
          setConfirm({ payload: payload, beforeSig: beforeSig });
          setState('confirming');
        } catch (e) {
          const data = (e && e.data) || null;
          if (data && Array.isArray(data.errors) && data.errors.length) setErr({ items: data.errors });
          else if (data && data.error) setErr({ items: [{ code: data.error, message: '' }] });
          else setErr({ net: true });
          setState('ready');
        }
      }

      // —— loading / error 态（无表单可编辑时的骨架与失败面板）——
      if (!form || !meta) {
        return React.createElement('div', { 'aria-busy': 'true', style: { display: 'flex', flexDirection: 'column', gap: 10, color: T.text, fontFamily: T.font } },
          React.createElement(GovHeader, null, state === 'error' ? tt('gov.error.net') : tt('gov.loading')),
          state === 'error'
            ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: T.error, fontSize: G().label } },
                React.createElement('span', null, tt('gov.error.net')),
                React.createElement('button', {
                  type: 'button', className: 'psw-btn', onClick: reload,
                  style: { background: T.card, color: T.text2, border: '1px solid ' + T.border, borderRadius: 8, padding: '5px 12px', fontSize: G().label, cursor: 'pointer' }
                }, tt('gov.reset'))
              )
            : React.createElement('div', null,
                React.createElement(Skeleton, { h: 52 }),
                React.createElement('div', { style: { height: 8 } }),
                React.createElement(Skeleton, { h: 84 }),
                React.createElement('div', { style: { height: 8 } }),
                React.createElement(Skeleton, { h: 52 })
              )
        );
      }

      const dirty = JSON.stringify(form) !== base;
      const busy = state === 'saving' || state === 'confirming';
      const liveOk = state === 'ready' || state === 'live';
      const pending = state === 'saving' || state === 'confirming';
      const selOptions = presetOptionIds();
      const presetSel = Array.isArray(form.preset) ? form.preset : [];            // 勾选集（保序；仅注册选项）
      const customRef = form.preset !== null && !Array.isArray(form.preset);      // { custom: 原文 }（无勾选位可表，保存原样）
      const countOf = (id) => { const m = meta.presets; return typeof m[id] === 'number' ? m[id] : 0; };
      const presetTotal = presetSel.reduce((s, id) => s + countOf(id), 0);        // 规则数摘要：l1=12 / l2=6 / 全选=18（compose 等效）
      const liveSt = pending ? STATE.running : STATE.merged;
      const chipLabel = state === 'saving' ? tt('gov.saving') : state === 'confirming' ? tt('gov.saved') : tt('gov.live');
      const btnBase = {
        borderRadius: 8, padding: '6px 14px', fontSize: G().btn, fontWeight: 600,
        cursor: 'pointer', lineHeight: 1.3, transition: 'opacity .15s ease'
      };
      const saveDisabled = busy || state === 'loading' || !dirty;

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, color: T.text, fontFamily: T.font, width: '100%', boxSizing: 'border-box' } },
        // 头部：标题 + 生效规则数 + 生效状态 Chip + 最近生效时间
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement(GovHeader, null, fmtN('gov.title.live', meta.rules)),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement(Chip, { st: liveSt },
            React.createElement(Dot, { color: liveSt.fg }),
            React.createElement('span', null, chipLabel),
            liveOk && liveAt ? React.createElement('span', { style: { opacity: 0.8 } }, '· ' + clockOf(liveAt)) : null
          )
        ),

        // 卡片 A 护栏开关（GovCard 无标题：SwitchRow 自带 title+desc）
        React.createElement(GovCard, null,
          React.createElement(SwitchRow, {
            checked: form.enabled,
            onChange: (v) => patch({ enabled: v }),
            title: tt('gov.hook.title'),
            desc: tt('gov.hook.desc')
          })
        ),

        // 卡片 B 规则预设（多选：l1 + l2 两勾选项；不复选 compose——后端唯一性校验拒同批重复 id）
        React.createElement(GovCard, { title: tt('gov.preset.title') },
          React.createElement('div', { style: { fontSize: G().sub, color: T.text3, lineHeight: 1.5 } }, tt('gov.preset.hint')),
          selOptions.map((id) => React.createElement(PresetCheckRow, {
            key: id,
            checked: presetSel.indexOf(id) >= 0,
            onChange: (v) => togglePreset(id, v),
            title: tt(presetMeaningKey(id)),
            sub: id + ' · ' + fmtN('gov.preset.rules', countOf(id))
          })),
          // 规则数摘要联动：单勾 12/6；全勾 = 18（compose 全量组合等效行）
          presetSel.length === 2 && presetTotal > 0
            ? React.createElement('div', { style: { fontSize: G().cap, color: T.text2, fontWeight: 600 } },
                tt(presetMeaningKey('compose')) + ' · ' + fmtN('gov.preset.rules', presetTotal))
            : null,
          presetSel.length === 0 && !customRef
            ? React.createElement('div', { style: { fontSize: G().cap, color: T.text3 } }, tt('gov.preset.none'))
            : null,
          customRef
            ? React.createElement('div', { style: { fontSize: G().cap, color: T.warn, lineHeight: 1.5 } },
                tt('gov.preset.custom'),
                React.createElement('span', { style: { fontFamily: T.mono, opacity: 0.85 } }, ' ' + JSON.stringify(form.preset.custom))
              )
            : null,
          meta.manualRules > 0
            ? React.createElement('div', { style: { fontSize: G().cap, color: T.warn, lineHeight: 1.5 } }, fmtN('gov.preset.manual', meta.manualRules))
            : null
        ),

        // 卡片 C 违规升级（SwitchRow 无标题卡片；子项开启后联动显示）
        React.createElement(GovCard, null,
          React.createElement(SwitchRow, {
            checked: form.escalation.enabled,
            onChange: (v) => patchEsc({ enabled: v }),
            title: tt('gov.esc.title'),
            desc: null
          }),
          form.escalation.enabled
            ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0 0 2px' } },
                React.createElement(NumberField, {
                  label: tt('gov.esc.threshold'), value: form.escalation.threshold,
                  min: 1, step: 1,
                  onChange: (v) => patchEsc({ threshold: v })
                }),
                React.createElement(NumberField, {
                  label: tt('gov.esc.window'), value: form.escalation.windowSecs,
                  min: 1, step: 1,
                  onChange: (v) => patchEsc({ windowSecs: v })
                }),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                  React.createElement('span', { style: { flex: 1, fontSize: G().label, color: T.text2 } }, tt('gov.esc.primitives')),
                  React.createElement(PrimitiveChips, {
                    value: form.escalation.primitives,
                    onChange: (next) => patchEsc({ primitives: next })
                  })
                )
              )
            : null
        ),

        // 卡片 D 窄化放行（同卡片 A：SwitchRow 自带 title+desc）
        React.createElement(GovCard, null,
          React.createElement(SwitchRow, {
            checked: form.narrow,
            onChange: (v) => patch({ narrow: v }),
            title: tt('gov.narrow.title'),
            desc: tt('gov.narrow.desc')
          })
        ),

        // 错误条（网络失败 / 400 逐条 code→双语映射）
        err
          ? React.createElement('div', {
              role: 'alert',
              style: {
                border: '1px solid ' + T.error, borderRadius: 8, padding: '8px 12px',
                display: 'flex', flexDirection: 'column', gap: 3, fontSize: G().sub, color: T.error
              }
            },
              err.net
                ? React.createElement('span', { style: { fontWeight: 600 } }, tt('gov.error.net'))
                : React.createElement(React.Fragment, null,
                    React.createElement('span', { style: { fontWeight: 600 } }, tt('gov.err.prefix')),
                    err.items.map((it, i) => {
                      const key = errorLabelKey(it.code);
                      const head = key ? tt(key) : (it.code || '');
                      return React.createElement('span', { key: i }, head + (it.message ? ' — ' + it.message : ''));
                    })
                  )
            )
          : null,

        // 动作行：保存 / 重置 + 脏状态提示
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement('button', {
            type: 'button',
            onClick: handleSave,
            disabled: saveDisabled,
            style: Object.assign({}, btnBase, {
              background: T.accent, color: '#fff', border: '1px solid transparent',
              opacity: saveDisabled ? 0.5 : 1, cursor: saveDisabled ? 'default' : 'pointer'
            })
          }, tt('gov.save')),
          React.createElement('button', {
            type: 'button', className: 'psw-btn',
            onClick: reload,
            disabled: state === 'loading',
            style: Object.assign({}, btnBase, {
              background: T.card, color: T.text2, border: '1px solid ' + T.border,
              opacity: state === 'loading' ? 0.5 : 1, cursor: state === 'loading' ? 'default' : 'pointer'
            })
          }, tt('gov.reset')),
          React.createElement('span', { style: { flex: 1 } }),
          dirty && !busy
            ? React.createElement('span', { style: { fontSize: G().cap, color: T.warn } },
                React.createElement(Dot, { color: T.warn }),
                React.createElement('span', { style: { marginLeft: 5 } }, tt('gov.dirty')))
            : null
        )
      );
    }
  }
});
