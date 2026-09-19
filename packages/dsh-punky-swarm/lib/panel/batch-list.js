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

// ===== [panel-segment] batch-list.js =====
    // 左栏：筛选 chips（全部/异常/运行中/已完结）+ 搜索 + 关注度角标（异常 N / 待收口）+ 异常优先排序。
    // 排序只做「异常置顶」，其余保持聚合顺序（聚合顺序真源 = main.js aggregateBatches）。
    function BatchList({ batches, selected, onSelect, loading, filter, onFilter }) {
      const [query, setQuery] = useState('');
      const active = filter || 'all';
      const all = batches || [];
      const issueNOf = (b) => Object.values(b.lanes || {}).filter((s) => s === 'failed' || s === 'conflict').length;
      const isIssue = (b) => issueNOf(b) > 0;
      const isRunning = (b) => b.phase === 'running' || b.phase === 'paused' || b.phase === 'planning';
      const isDone = (b) => !isRunning(b);
      const q = query.trim().toLowerCase();
      const matches = (b) => {
        if (active === 'issue' && !isIssue(b)) return false;
        if (active === 'running' && !isRunning(b)) return false;
        if (active === 'done' && !isDone(b)) return false;
        if (!q) return true;
        const id = String(b.batchId || '').toLowerCase();
        const short = String(b.sessionShort || '').toLowerCase();
        return id.indexOf(q) >= 0 || short.indexOf(q) >= 0;
      };
      const shown = all.filter(matches).map((b, i) => ({ b: b, i: i }))
        .sort((x, y) => (isIssue(x.b) ? 0 : 1) - (isIssue(y.b) ? 0 : 1) || x.i - y.i)
        .map((x) => x.b);
      const chipRow = (labelKeys) => React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
        labelKeys.map((k) => React.createElement('button', {
          key: k,
          type: 'button',
          className: 'psw-btn',
          'aria-pressed': active === k,
          onClick: () => onFilter(k),
          style: {
            fontSize: 10.5, padding: '1px 8px', borderRadius: 999, cursor: 'pointer',
            border: '1px solid ' + (active === k ? T.accent : T.border),
            background: active === k ? T.selBg : 'transparent',
            color: active === k ? T.text : T.text3, fontFamily: T.font
          }
        }, tt(k))));
      return React.createElement('div', {
        className: 'psw-list psw-scroll',
        style: { width: 276, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', paddingRight: 4 }
      },
        React.createElement(SectionTitle, null, tt('batch.title') + ' · ' + all.length),
        chipRow(['list.filter.all', 'list.filter.issue', 'list.filter.running', 'list.filter.done']),
        React.createElement('input', {
          type: 'search',
          value: query,
          'aria-label': tt('list.search'),
          placeholder: tt('list.search'),
          onChange: (ev) => setQuery(ev.target.value),
          style: {
            width: '100%', boxSizing: 'border-box', fontSize: 11, padding: '4px 8px', borderRadius: 8,
            border: '1px solid ' + T.border, background: T.card, color: T.text, fontFamily: T.font
          }
        }),
        loading && !batches
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              React.createElement(Skeleton, { h: 52 }),
              React.createElement(Skeleton, { h: 52 }),
              React.createElement(Skeleton, { h: 52 })
            )
          : shown.length
            ? shown.map((b) => {
                const st = PHASE[b.phase] || PHASE.planning;
                const vals = Object.values(b.lanes || {});
                const done = vals.filter((s) => TERMINAL.indexOf(s) >= 0).length;
                const total = vals.length;
                const issues = issueNOf(b);
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
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: T.text3, flexWrap: 'wrap' } },
                    b.sessionShort && !b.isOwnSession
                      ? React.createElement('span', { title: b.session, style: { fontFamily: T.mono, opacity: 0.9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 } }, b.sessionShort + ' ·')
                      : null,
                    b.autoReleaseable
                      ? React.createElement(React.Fragment, null, React.createElement(Dot, { color: T.success }), React.createElement('span', null, tt('batch.release')))
                      : b.phase === 'complete' || b.phase === 'aborted'
                        ? React.createElement('span', null, tt('batch.done'))
                        : React.createElement('span', null, tt('batch.progress') + ' · ' + (b.concurrency != null ? tt('concurrency') + ' ' + b.concurrency : '')),
                    issues > 0
                      ? React.createElement('span', { style: { color: T.error, fontWeight: 600, fontFamily: T.mono } }, fmtCount(tt('list.issueBadge'), issues))
                      : null,
                    b.settled === true && !b.autoReleaseable
                      ? React.createElement('span', { style: { color: T.warn, fontWeight: 600 } }, tt('list.settleable'))
                      : null
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
                React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' } },
                  ['empty.step1', 'empty.step2', 'empty.step3'].map((k) => React.createElement('span', {
                    key: k, style: { fontSize: 10.5, padding: '1px 8px', borderRadius: 999, background: T.skeleton, color: T.text2 }
                  }, tt(k)))
                ),
                React.createElement('div', { style: { fontSize: 11, lineHeight: 1.5 } }, tt('empty.hint'))
              )
      );
    }
