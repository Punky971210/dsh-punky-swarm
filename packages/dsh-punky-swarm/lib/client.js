window.__ModuleLoader__.load({
  id: "dsh-punky-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    "use strict";
    // dsh-punky-swarm 集群工作台客户端：注册 conversation.view 第三分页（对话/轨迹/蟛蜞集群）
    const React = require('react');
    const { useState, useEffect } = React;

    const NS = 'dsh-punky-swarm';
    const zh = {
      "view.cluster": "蟛蜞集群",
      "live": "实时",
      "refresh.auto": "3s 自动刷新",
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
      "upgrade": "升级人工"
    };
    const en = {
      "view.cluster": "Punky swarm",
      "live": "Live",
      "refresh.auto": "3s auto refresh",
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
      "upgrade": "escalate"
    };

    // module-level translator: zh-first, en fallback (matches the original panel behavior)
    function tt(k) { return zh[k] || en[k] || k; }

    const inject = ['slots', 'locale'];

    // ---- design tokens: DSH alias vars with dark-dashboard fallbacks ----
    const T = {
      card: 'var(--dsw-alias-bg-layer-3, #141d31)',
      border: 'var(--dsw-alias-border-l1, #26304a)',
      text: 'var(--dsw-alias-label-primary, #e6ebf4)',
      text2: 'var(--dsw-alias-label-secondary, #9aa7bd)',
      text3: 'var(--dsw-alias-label-dimmed, #5f6b81)',
      accent: 'var(--dsw-alias-brand-primary, #4f8cff)',
      success: 'var(--dsw-alias-state-success-primary, #3fb950)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
      error: 'var(--dsw-alias-state-error-primary, #f85149)',
      info: 'var(--dsw-alias-state-business-primary, #58a6ff)',
      skeleton: 'var(--dsw-alias-bg-skeleton, #1d2740)',
      font: 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
      mono: 'var(--dsw-font-mono, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace)'
    };

    // ---- semantic status colors (fg token + soft rgba bg) ----
    function chip(fg, bg) {
      return { fg: fg, bg: bg };
    }
    const STATE = {
      pending: chip(T.text3, 'rgba(95,107,129,0.14)'),
      running: chip(T.warn, 'rgba(210,153,34,0.15)'),
      review: chip(T.info, 'rgba(88,166,255,0.15)'),
      merged: chip(T.success, 'rgba(63,185,80,0.15)'),
      failed: chip(T.error, 'rgba(248,81,73,0.15)'),
      skipped: chip(T.text3, 'rgba(95,107,129,0.12)'),
      conflict: chip('#e0682e', 'rgba(224,104,46,0.16)'),
      idle: chip(T.text3, 'rgba(95,107,129,0.10)')
    };
    const PHASE = {
      planning: chip(T.text3, 'rgba(95,107,129,0.12)'),
      running: chip(T.warn, 'rgba(210,153,34,0.15)'),
      paused: chip(T.info, 'rgba(88,166,255,0.15)'),
      aborted: chip(T.error, 'rgba(248,81,73,0.15)'),
      complete: chip(T.success, 'rgba(63,185,80,0.15)')
    };

    async function api(path, session) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch('/api/dsh-punky-swarm' + path + sep + 'session=' + encodeURIComponent(session));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    const TERMINAL = ['merged', 'failed', 'skipped', 'conflict'];
    const cardBase = { background: T.card, border: '1px solid ' + T.border, borderRadius: 10 };

    function Chip({ st, children, style }) {
      const c = st || chip(T.text2, 'rgba(95,107,129,0.12)');
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

    function GateBadge({ gate }) {
      if (!gate || !gate.layer) return null;
      const missing = (gate.consumeMissing || []).length + (gate.outputsMissing || []).length + (gate.produceMissing || []).length + (gate.contractProblems || []).length;
      if (missing === 0) return null;
      return React.createElement('span', {
        style: { color: T.warn, background: 'rgba(210,153,34,0.14)', borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 600, fontFamily: T.mono, whiteSpace: 'nowrap' }
      }, tt('gate.missing') + ' ' + missing);
    }

    function AttemptBadge({ n, upgrade }) {
      if (!n && !upgrade) return null;
      const label = (upgrade ? tt('upgrade') : tt('attempt')) + ' ' + n;
      return React.createElement('span', {
        style: upgrade
          ? { color: '#e0682e', background: 'rgba(224,104,46,0.14)', borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 600, fontFamily: T.mono, whiteSpace: 'nowrap' }
          : { color: T.text2, fontSize: 10.5, fontFamily: T.mono, whiteSpace: 'nowrap' }
      }, label);
    }

    function LaneCard({ lane, state, attempt, upgrade, gate }) {
      const st = STATE[state] || STATE.pending;
      return React.createElement('div', {
        className: 'psw-card',
        style: Object.assign({}, cardBase, {
          minWidth: 148, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
          borderLeft: '3px solid ' + st.fg
        })
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, lane),
          React.createElement(Chip, { st: st }, state)
        ),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
          React.createElement(GateBadge, { gate }),
          React.createElement(AttemptBadge, { n: attempt, upgrade })
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
        React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' } }, (e.ts || '').slice(11, 19))
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
                const sel = b.batchId === selected;
                return React.createElement('button', {
                  key: b.batchId,
                  type: 'button',
                  className: 'psw-btn',
                  onClick: () => onSelect(b.batchId),
                  'aria-pressed': sel,
                  style: Object.assign({}, cardBase, {
                    textAlign: 'left', cursor: 'pointer', padding: '8px 10px',
                    display: 'flex', flexDirection: 'column', gap: 6, width: '100%',
                    borderColor: sel ? T.accent : undefined,
                    background: sel ? 'var(--dsw-alias-interactive-bg-active, rgba(79,140,255,0.10))' : T.card,
                    boxShadow: sel ? '0 0 0 1px ' + T.accent : undefined
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
            React.createElement(Progress, { value: lanes.length ? (done / lanes.length) * 100 : 0, color: issues ? T.error : done === lanes.length && lanes.length ? T.success : T.warn }),
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
            gate: (d.lanesGate || {})[lane]
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

    function ClusterWorkbench({ sessionId }) {
      const [batches, setBatches] = useState(null);
      const [sel, setSel] = useState(null);
      const [detail, setDetail] = useState(null);
      const [updated, setUpdated] = useState(null);
      const sid = sessionId || '';
      useEffect(() => {
        if (!sid) return;
        let alive = true;
        const tick = async () => {
          try {
            const r = await api('/batches', sid);
            if (alive) { setBatches(r.batches); setUpdated(new Date()); }
          } catch {}
        };
        tick();
        const iv = setInterval(tick, 3000);
        return () => { alive = false; clearInterval(iv); };
      }, [sid]);
      useEffect(() => {
        if (!sel || !sid) { setDetail(null); return; }
        let alive = true;
        const tick = async () => {
          try {
            const d = await api('/batch?batchId=' + encodeURIComponent(sel), sid);
            let mail = { inbox: [], broadcast: [] };
            try { mail.inbox = (await api('/mailbox?batchId=' + encodeURIComponent(sel) + '&box=inbox', sid)).items; } catch {}
            try { mail.broadcast = (await api('/mailbox?batchId=' + encodeURIComponent(sel) + '&box=broadcast', sid)).items; } catch {}
            if (alive) setDetail(Object.assign({}, d, { mail }));
          } catch {}
        };
        tick();
        const iv = setInterval(tick, 3000);
        return () => { alive = false; clearInterval(iv); };
      }, [sel, sid]);

      const list = batches || [];
      const running = list.filter((b) => b.phase === 'running').length;
      const doneCnt = list.filter((b) => b.phase === 'complete').length;
      let issues = 0;
      for (const b of list) {
        const vals = Object.values(b.lanes || {});
        issues += vals.filter((s) => s === 'failed' || s === 'conflict').length;
      }
      const liveColor = !batches ? T.text3 : running ? T.warn : T.success;
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
            React.createElement('span', { className: 'psw-pulse', style: { width: 7, height: 7, borderRadius: 999, background: liveColor, boxShadow: '0 0 0 3px ' + (running ? 'rgba(210,153,34,0.2)' : 'rgba(63,185,80,0.18)') } }),
            React.createElement('span', { style: { fontSize: 10, fontWeight: 600, letterSpacing: 0.8, color: liveColor } }, tt('live'))
          ),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono } }, tt('refresh.auto')),
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
        el.textContent = ".psw-scroll::-webkit-scrollbar{width:8px;height:8px}\n.psw-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,#2b3550);border-radius:999px}\n.psw-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l1,#3a4a6d)}\n.psw-btn{transition:background .15s ease,border-color .15s ease,transform .15s ease}\n.psw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,184,.09))}\n.psw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:2px}\n.psw-card{transition:border-color .15s ease,background .15s ease}\n.psw-pulse{animation:pswPulse 2s ease-in-out infinite}\n@keyframes pswPulse{0%,100%{opacity:1}50%{opacity:.3}}\n.psw-shimmer{background:linear-gradient(90deg,var(--dsw-alias-bg-skeleton,#1d2740) 30%,rgba(148,163,184,.14) 50%,var(--dsw-alias-bg-skeleton,#1d2740) 70%);background-size:200% 100%;animation:pswShimmer 1.4s linear infinite}\n@keyframes pswShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}\n.psw-panes{display:flex;gap:12px;flex:1;min-height:0}\n@media (max-width:760px){.psw-panes{flex-direction:column}.psw-list{width:100%!important;max-height:240px}}\n@media (prefers-reduced-motion:reduce){.psw-pulse,.psw-shimmer{animation:none}.psw-btn,.psw-card{transition:none}}";
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
