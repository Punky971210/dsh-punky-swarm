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
    }

    module.exports = { apply, inject };
    return module.exports;
