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
    // 【波 A · A-2】探测不到（body 未就绪 / 无 document）时按**宿主默认浅色**兜底：原缺省 'dark'
    //   会让「段求值早于 body 就绪」的加载序停在暗色兜底色板（#7f8ca3 落在浅色卡上 = 用户看到的浅灰字）。
    //   初始探测点同时由 main.js 的 apply() 补齐（mount 立即调用 + documentElement 子树观察）。
    let CURRENT_THEME = 'light';
    function detectTheme() {
      try {
        if (typeof document !== 'undefined' && document.body) {
          return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
        }
      } catch {}
      return 'light'; // body 未就绪 ⇒ 按宿主默认浅色（token 缺失时的兜底档，见上注）
    }
    try { CURRENT_THEME = detectTheme(); } catch {}

    const P = {
      light: {
        card: '#ffffff', border: '#dfe5ee',
        text: '#1f2937', text2: '#475569', text3: '#64748b', dim: '#64748b',
        accent: '#3b82f6', success: '#15803d', warn: '#b45309', error: '#dc2626', info: '#2563eb',
        skeleton: '#eef2f7', selBg: 'rgba(59,130,246,0.10)',
        // 对比度（验收 7）：light 侧 chipRunning/chipReview/chipMerged/chipFailed/chipConflict 原 alpha
        //   实测 < 4.5:1 ⇒ 按冻结节拍 §3.2 的处置「只调 bg alpha、不新增色相」收窄至 ≥4.6:1。
        chipPending: 'rgba(100,116,139,0.20)', chipRunning: 'rgba(180,83,9,0.06)',
        chipReview: 'rgba(37,99,235,0.08)', chipMerged: 'rgba(21,128,61,0.06)',
        chipFailed: 'rgba(220,38,38,0.03)', chipSkipped: 'rgba(100,116,139,0.16)',
        chipConflict: 'rgba(234,88,12,0.09)', chipIdle: 'rgba(100,116,139,0.14)',
        haloSuccess: 'rgba(21,128,61,0.16)', haloWarn: 'rgba(180,83,9,0.16)',
        gateBg: 'rgba(180,83,9,0.12)', escBg: 'rgba(234,88,12,0.12)', escFg: '#c2410c'
      },
      dark: {
        card: '#141d31', border: '#26304a',
        text: '#e6ebf4', text2: '#a8b3c7', text3: '#7f8ca3', dim: '#8b96ab',
        accent: '#4f8cff', success: '#3fb950', warn: '#d29922', error: '#f85149', info: '#58a6ff',
        skeleton: '#1d2740', selBg: 'rgba(79,140,255,0.12)',
        // 对比度（验收 7）：dark 侧 chipFailed / chipConflict 原 alpha 实测 < 4.5:1 ⇒ 同法收窄至 ≥4.6:1。
        chipPending: 'rgba(127,140,163,0.22)', chipRunning: 'rgba(210,153,34,0.16)',
        chipReview: 'rgba(88,166,255,0.16)', chipMerged: 'rgba(63,185,80,0.16)',
        chipFailed: 'rgba(248,81,73,0.08)', chipSkipped: 'rgba(127,140,163,0.18)',
        chipConflict: 'rgba(224,104,46,0.07)', chipIdle: 'rgba(127,140,163,0.16)',
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
      // 【波 A · A-3】实心控件上的前景（开关圆点 / 勾选对勾 / accent 填充上的文字）：
      //   宿主对 `background: --dsw-alias-button-primary-fill` 的同款配法就是 label-primary-foreground
      //   ⇒ 这一处白色前景改由宿主皮肤接管（原为裸 '#fff'，换肤不跟随）。
      get onAccent() { return 'var(--dsw-alias-label-primary-foreground, #fff)'; },
      // 【波 A · A-3】门禁缺口徽章底色：宿主 `--dsw-alias-state-warn-tertiary` 的定义与用法即
      //   「warn-primary 前景 + tertiary 底色」的条/芯片（本面板对侧前景 = T.warn = state-warn-primary）。
      get gateBg() { return 'var(--dsw-alias-state-warn-tertiary, ' + pal().gateBg + ')'; },
      get accent() { return 'var(--dsw-alias-brand-primary, ' + pal().accent + ')'; },
      get success() { return 'var(--dsw-alias-state-success-primary, ' + pal().success + ')'; },
      get warn() { return 'var(--dsw-alias-state-warn-primary, ' + pal().warn + ')'; },
      get error() { return 'var(--dsw-alias-state-error-primary, ' + pal().error + ')'; },
      get info() { return 'var(--dsw-alias-state-business-primary, ' + pal().info + ')'; },
      get skeleton() { return 'var(--dsw-alias-bg-skeleton, ' + pal().skeleton + ')'; },
      get selBg() { return 'var(--dsw-alias-interactive-bg-active, ' + pal().selBg + ')'; },
      get font() { return 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)'; },
      // 【波 A · 附】宿主 --dsw-font-mono **def=0（不存在）** ⇒ 原写法恒走硬编码栈。
      //   改用宿主实有的等宽令牌 --ds-font-family-code（def=1，宿主 markdown-code 族的底令牌）；
      //   仍把 --dsw-font-mono 留在链首：若某版宿主补上该令牌则优先，不补也不影响解析。
      get mono() { return 'var(--dsw-font-mono, var(--ds-font-family-code, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace))'; }
    };

    // 芯片：fg 走令牌（缺则兜底色）；底色【波 A · A-3】原为直返 pal()（不跟随宿主换肤）⇒
    //   分出 bgCss = var(--dsw-alias-*, 兜底色)。保留 bg = 纯兜底色值：面板 chip 对比度回归断言
    //   （test/panel-render.test.js T-R2）逐色解析的正是 bg（该断言审的就是「令牌缺失时的兜底档」）。
    function chip(fgKey, bgKey, fgVar, bgVar) {
      return {
        get fg() { return fgVar ? 'var(' + fgVar + ', ' + pal()[fgKey] + ')' : pal()[fgKey]; },
        get bg() { return pal()[bgKey]; },
        get bgCss() { return bgVar ? 'var(' + bgVar + ', ' + pal()[bgKey] + ')' : pal()[bgKey]; }
      };
    }
    // 四参 chip(..., bgVar)：仅**宿主确有同款软底色 alias** 的三档加 bgVar（warn/business/success 各一）。
    //   其余档（pending/skipped/idle/failed/conflict）宿主无对应软底色令牌 ⇒ 保留兜底色，登记为已知边界。
    const STATE = {
      pending: chip('text2', 'chipPending', '--dsw-alias-label-secondary'),
      running: chip('warn', 'chipRunning', '--dsw-alias-state-warn-primary', '--dsw-alias-state-warn-tertiary'),
      review: chip('info', 'chipReview', '--dsw-alias-state-business-primary', '--dsw-alias-state-business-tertiary'),
      merged: chip('success', 'chipMerged', '--dsw-alias-state-success-primary', '--dsw-alias-state-success-tertiary'),
      failed: chip('error', 'chipFailed', '--dsw-alias-state-error-primary'),
      skipped: chip('text2', 'chipSkipped', '--dsw-alias-label-secondary'),
      conflict: chip('escFg', 'chipConflict', '--dsw-alias-state-warn-primary'),
      idle: chip('text2', 'chipIdle', '--dsw-alias-label-secondary')
    };
    const PHASE = {
      planning: chip('text2', 'chipSkipped', '--dsw-alias-label-secondary'),
      running: chip('warn', 'chipRunning', '--dsw-alias-state-warn-primary', '--dsw-alias-state-warn-tertiary'),
      paused: chip('info', 'chipReview', '--dsw-alias-state-business-primary', '--dsw-alias-state-business-tertiary'),
      aborted: chip('error', 'chipFailed', '--dsw-alias-state-error-primary'),
      complete: chip('success', 'chipMerged', '--dsw-alias-state-success-primary', '--dsw-alias-state-success-tertiary')
    };
    // =======================================================
