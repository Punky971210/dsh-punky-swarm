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

// ===== [panel-segment] widgets.js =====
    // 通用件：Chip（带状态语义的 aria-label）/ Dot（纯色块，aria-hidden）/ Progress / Stat（关键数字 ≥18px）
    //   / SectionTitle / Skeleton / FocusBlock（引力条单元，0 值由调用方先过滤）。
    // 视觉硬上限（Q-2 边界）：辅助字 ≥10.5px、关键数字 ≥18px、不新增色相（颜色只编码状态）。
    function Chip({ st, children, style, label }) {
      const c = st || chip('text2', 'chipPending', '--dsw-alias-label-secondary');
      const text = label === undefined || label === null
        ? fmtCount(tt('chip.state'), children === undefined || children === null ? '' : children)
        : label;
      return React.createElement('span', {
        'aria-label': text,
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
      return React.createElement('span', { 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' } });
    }

    function Progress({ value, color, height }) {
      const h = height || 4;
      return React.createElement('div', {
        style: { height: h, borderRadius: 999, background: T.skeleton, overflow: 'hidden', flex: 1 }
      }, React.createElement('div', {
        style: { width: Math.max(0, Math.min(100, value)) + '%', height: '100%', borderRadius: 999, background: color || T.accent, transition: 'width .3s ease' }
      }));
    }

    function Stat({ label, value, color, emphasis }) {
      const numStyle = { fontSize: 18, fontWeight: 700, fontFamily: T.mono, color: color || T.text, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' };
      if (emphasis) numStyle.fontSize = 20; // 主行动卡关键数字（Q-2 上限内：20 ≥ 18）
      return React.createElement('div', {
        style: Object.assign({}, cardBase, { padding: '6px 10px', minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 })
      },
        React.createElement('span', { style: { fontSize: 10.5, color: T.text3, lineHeight: 1.2 } }, label),
        React.createElement('span', { style: numStyle }, value)
      );
    }

    function SectionTitle({ children }) {
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
        React.createElement('span', { 'aria-hidden': 'true', style: { width: 3, height: 12, borderRadius: 999, background: T.accent } }),
        React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600, color: T.text, letterSpacing: 0.3 } }, children)
      );
    }

    function Skeleton({ h, w, style }) {
      return React.createElement('div', { 'aria-hidden': 'true', className: 'psw-shimmer', style: Object.assign({ height: h || 12, width: w || '100%', borderRadius: 6 }, style || null) });
    }

    // 引力块（引力条单元）：只负责渲染一枚非 0 块 + aria-label（0 值由 focusBlocksOf 先行收起）
    function FocusBlock({ label, n, tone, onClick }) {
      const text = label + ' ' + n;
      return React.createElement('button', {
        type: 'button',
        className: 'psw-btn',
        'aria-label': text,
        onClick: onClick,
        style: Object.assign({}, cardBase, {
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', cursor: 'pointer', flex: 'none'
        })
      },
        React.createElement('span', { style: { fontSize: 15, fontWeight: 700, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums', color: tone || T.text } }, n),
        React.createElement('span', { style: { fontSize: 10.5, color: T.text3 } }, label)
      );
    }
