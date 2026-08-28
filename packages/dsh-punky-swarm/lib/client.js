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
      "gate.contract": "契约问题"
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
      "gate.contract": "contract problem"
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
    }

    module.exports = { apply, inject };
    return module.exports;
  }
});
