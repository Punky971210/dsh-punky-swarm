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
