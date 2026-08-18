window.__ModuleLoader__.load({
  id: "dsh-punky-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    "use strict";
    // dsh-punky-swarm 集群工作台客户端：注册 conversation.view 第三分页（对话/轨迹/集群工作台）
    const React = require('react');
    const { useState, useEffect } = React;

    const NS = 'dsh-punky-swarm';
    const zh = {
      "view.cluster": "蟛蜞集群",
      "batch.title": "批次列表",
      "batch.progress": "进度",
      "batch.release": "可自动放行",
      "batch.done": "已完结",
      "event.timeline": "事件时间线",
      "mailbox.title": "收件箱（只读）",
      "mailbox.inbox": "派发",
      "mailbox.broadcast": "广播",
      "empty": "暂无批次",
    };
    const en = { "view.cluster": "Punky swarm" };

    const inject = ['slots', 'locale'];

    const STATE_COLORS = { pending: '#9aa0a6', running: '#f5a623', review: '#4a90d9', merged: '#34a853', failed: '#ea4335', skipped: '#b0b0b0', conflict: '#e06000', idle: '#8e8e8e' };
    const PHASE_COLORS = { planning: '#9aa0a6', running: '#f5a623', paused: '#4a90d9', aborted: '#ea4335', complete: '#34a853' };

    async function api(path, session) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch('/api/dsh-punky-swarm' + path + sep + 'session=' + encodeURIComponent(session));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    const row = { display: 'flex', alignItems: 'center', gap: '8px' };
    const card = { background: 'var(--dsw-alias-bg-layer-2, #1e1e1e)', border: '1px solid var(--dsw-alias-border-l1, #333)', borderRadius: 10, padding: '8px 10px' };
    const badge = (c) => ({ color: '#fff', background: c, borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 600 });

    function AttemptBadge({ n, upgrade }) {
      if (!n && !upgrade) return null;
      return React.createElement('span', { style: upgrade ? badge('#e06000') : { color: '#e06000', fontSize: 11 } }, (upgrade ? '升级人工 ' : '返工 ') + n + (upgrade ? ' ⚠' : ''));
    }

    function GateBadge({ gate }) {
      if (!gate || !gate.layer) return null;
      const missing = (gate.consumeMissing || []).length + (gate.outputsMissing || []).length + (gate.produceMissing || []).length + (gate.contractProblems || []).length;
      if (missing === 0) return null;
      return React.createElement('span', { style: { background: '#e06000', color: '#fff', borderRadius: 999, padding: '1px 6px', fontSize: 10, fontWeight: 600, marginLeft: 4 } }, '缺 ' + missing);
    }

    function LaneCard({ lane, state, attempt, upgrade, gate }) {
      return React.createElement('div', { style: Object.assign({}, card, { minWidth: 140 }) },
        React.createElement('div', { style: row },
          React.createElement('span', { style: badge(STATE_COLORS[state] || '#888') }, state),
          React.createElement('span', { style: { fontSize: 12, fontWeight: 600 } }, lane),
          React.createElement(GateBadge, { gate }),
          React.createElement(AttemptBadge, { n: attempt, upgrade })
        )
      );
    }

    function EventRow({ e }) {
      const label = e.type + (e.lane ? ':' + e.lane : '') + (e.from ? ' ' + e.from + '->' + e.to : '');
      return React.createElement('div', { style: Object.assign({}, row, { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #bbb)' }) },
        React.createElement('span', { style: { flex: 1 } }, label),
        React.createElement('span', { style: { fontSize: 11 } }, (e.ts || '').slice(11, 19))
      );
    }

    function BatchList({ batches, selected, onSelect, t }) {
      return React.createElement('div', { style: { width: 300, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', paddingRight: 8 } },
        React.createElement('h3', { style: { margin: '0 0 4px', fontSize: 14 } }, t('batch.title')),
        (batches && batches.length ? batches.map((b) =>
          React.createElement('button', { key: b.batchId, onClick: () => onSelect(b.batchId), style: Object.assign({}, card, { textAlign: 'left', cursor: 'pointer', borderColor: b.batchId === selected ? '#4a90d9' : undefined }) },
            React.createElement('div', { style: row },
              React.createElement('span', { style: badge(PHASE_COLORS[b.phase] || '#888') }, b.phase),
              React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, b.batchId)
            ),
            React.createElement('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #bbb)' } },
              t('batch.progress') + ': ' + Object.values(b.lanes).filter((s) => ['merged','failed','skipped','conflict'].includes(s)).length + '/' + Object.keys(b.lanes).length
              + (b.autoReleaseable ? ' · ' + t('batch.release') : (b.phase === 'complete' || b.phase === 'aborted') ? ' · ' + t('batch.done') : '')
            )
          )
        ) : React.createElement('div', { style: { fontSize: 12, color: '#888' } }, t('empty')))
      );
    }

    function BatchDetail({ d, t }) {
      if (!d) return React.createElement('div', null);
      const lanes = Object.keys(d.lanes);
      const evs = (d.recentEvents || []).slice().reverse();
      const mail = d.mail || { inbox: [], broadcast: [] };
      return React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' } },
        React.createElement('div', { style: Object.assign({}, card) },
          React.createElement('div', { style: row },
            React.createElement('span', { style: badge(PHASE_COLORS[d.phase] || '#888') }, d.phase + (d.viewSettled ? ' ✓' : '')),
            React.createElement('span', { style: { fontWeight: 700, fontSize: 14 } }, d.batchId),
            React.createElement('span', { style: { fontSize: 12, color: '#888' } }, 'concurrency=' + d.concurrency + ' · events=' + d.eventCount)
          ),
          d.autoReleaseable ? React.createElement('div', { style: { marginTop: 6, color: '#34a853', fontSize: 12 } }, '✓ ' + t('batch.release')) : null
        ),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          lanes.map((lane) => React.createElement(LaneCard, { key: lane, lane, state: d.lanes[lane], attempt: (d.laneAttempts || {})[lane], upgrade: (d.upgrades || {})[lane], gate: (d.lanesGate || {})[lane] }))
        ),
        React.createElement('div', { style: Object.assign({}, card) },
          React.createElement('h4', { style: { margin: '0 0 6px', fontSize: 13 } }, t('event.timeline')),
          evs.map((e, i) => React.createElement(EventRow, { key: i, e }))
        ),
        React.createElement('div', { style: Object.assign({}, card) },
          React.createElement('h4', { style: { margin: '0 0 6px', fontSize: 13 } }, t('mailbox.title')),
          React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #bbb)' } },
            t('mailbox.inbox') + ' ' + mail.inbox.length + ' · ' + t('mailbox.broadcast') + ' ' + mail.broadcast.length
          )
        )
      );
    }

    function ClusterWorkbench({ sessionId }) {
      const [batches, setBatches] = useState(null);
      const [sel, setSel] = useState(null);
      const [detail, setDetail] = useState(null);
      const sid = sessionId || '';
      useEffect(() => {
        if (!sid) return;
        const tick = async () => { try { const r = await api('/batches', sid); setBatches(r.batches); } catch {} };
        tick(); const iv = setInterval(tick, 3000);
        return () => clearInterval(iv);
      }, [sid]);
      useEffect(() => {
        if (!sel || !sid) { setDetail(null); return; }
        const tick = async () => {
          try {
            const d = await api('/batch?batchId=' + encodeURIComponent(sel), sid);
            let mail = { inbox: [], broadcast: [] };
            try { mail.inbox = (await api('/mailbox?batchId=' + encodeURIComponent(sel) + '&box=inbox', sid)).items; } catch {}
            try { mail.broadcast = (await api('/mailbox?batchId=' + encodeURIComponent(sel) + '&box=broadcast', sid)).items; } catch {}
            setDetail(Object.assign({}, d, { mail }));
          } catch {}
        };
        tick(); const iv = setInterval(tick, 3000);
        return () => clearInterval(iv);
      }, [sel, sid]);
      return React.createElement('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', color: 'var(--dsw-alias-label-primary, #eee)', fontFamily: 'var(--dsw-font-family, inherit)' } },
        React.createElement('div', { style: { flex: 1, minHeight: 0, display: 'flex', gap: 12 } },
        React.createElement(BatchList, { batches, selected: sel, onSelect: setSel, t: (k) => zh[k] || k }),
        React.createElement(BatchDetail, { d: detail, t: (k) => zh[k] || k })
        )
      );
    }

    function apply(ctx) {
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