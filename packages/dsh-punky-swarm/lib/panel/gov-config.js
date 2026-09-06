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

// ===== [panel-segment] gov-config.js =====
    // 治理配置页（settings.section，id='governance-config' order=16；main.js apply() 注册）。
    // 段内仅 function 声明：本段物理序在 main.js 之后（工厂体以 module.exports/return 收尾），
    // 依赖函数声明提升在 apply 注册引用时可用——禁止在本段顶层出现 const/let/var（死区永不初始化）。
    // 引用的 T/cardBase/tt/chip/STATE/Dot/Chip/Skeleton 等为前序段绑定（渲染时已初始化）；
    // 本页专属标题/复选行/字号基准 = 段内 G()/GovHeader/PresetCheckRow（不动共享 SectionTitle——避免波及其它视图）。
    //
    // 数据契约 = GET /api/dsh-punky-swarm/config → { overlay, overlayWatch, applied, presets }
    //   overlay = <root>/config/runtime.json governance 段原样（磁盘原文；无 = null）
    //   overlayWatch = 磁盘 capabilities.watch 段原样（磁盘原文；无 = null）——watch 开关表单基准（overlay 优先）
    //   applied = 引擎 resolve 后的生效快照——preset 已被展开为 rules（不保留 preset 键），
    //             故 preset 当前值只读 overlay.hook.preset；applied 仅用于「生效规则数/生效状态」展示。
    //   applied.watch = 引擎 resolve 后的 watch 生效快照（{ enabled, longrun: { enabled, maxDurationMs, noProgressWindowMs }, scanIntervalMinutes }；
    //             缺省 enabled/longrun.enabled = true——出厂默认开语义，显式 false 才关；长跑阈值缺省 1200000/300000 ms（LONGRUN_DEFAULTS）。
    //             e2 remount 生效面含阈值后，applied 快照携带阈值 → 表单回显 + 确认轮询数据源；表单兜底源）
    //   presets = [{ id, count }] 注册目录元数据（复选行/合计规则数摘要：l1=12 / l2=6 / compose=18）。
    // 写契约 = POST 同路径，body { governance: { hook: {...} }, capabilities: { watch: { enabled, longrun: { enabled, maxDurationMs, noProgressWindowMs } } } }
    //         （单保存合并双段：governance + watch 能力开关；400 → { ok:false, errors:[{ field, code, message }] }（页面按 code 双语映射））。
    // 窗口单位：GET overlay.escalation.windowMs 存 ms（毫秒契约不变）；
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
      // watch 段（卡片 E）：overlayWatch = 磁盘 capabilities.watch 原文；applied.watch = 引擎 resolve 生效快照
      const ovW = data && data.overlayWatch && typeof data.overlayWatch === 'object' ? data.overlayWatch : null;
      const apW = data && data.applied && data.applied.watch && typeof data.applied.watch === 'object' ? data.applied.watch : null;
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
        narrow: pickBool(flO.narrow, flA.narrow, false),
        // watch 能力开关（卡片 E）：overlay 优先、applied 兜底；缺省 true（出厂默认开语义，显式 false 才关——
        //   与引擎 resolveWatchConfig/resolveLongrunConfig 的 enabled !== false 判定同口径，回显「开」）
        watch: {
          enabled: pickBool(ovW && ovW.enabled, apW && apW.enabled, true),
          longrun: {
            enabled: pickBool(ovW && ovW.longrun && ovW.longrun.enabled, apW && apW.longrun && apW.longrun.enabled, true),
            // 长跑两阈值（分钟表单态）：overlay → applied → 默认 20/5（引擎 LONGRUN_DEFAULTS 1200000/300000 ms），
            //   /60000 显示分钟；非整分钟存量值（手工 runtime.json）允许小数分钟显示，提交 Math.round 保真
            maxDurationMin: String(pickNum(ovW && ovW.longrun && ovW.longrun.maxDurationMs, apW && apW.longrun && apW.longrun.maxDurationMs, 1200000) / 60000),
            noProgressMin: String(pickNum(ovW && ovW.longrun && ovW.longrun.noProgressWindowMs, apW && apW.longrun && apW.longrun.noProgressWindowMs, 300000) / 60000)
          }
        }
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
    // applied.watch 生效快照签名（watch 段：父开关 + longrun 子开关 + 长跑两阈值 ms——热重建生效比对用；
    //   阈值纳入签名使「阈值-only 保存」在确认轮询中能被识别为生效快照翻转；快照缺阈值键（e2 生效面落地前）按 null 处理）
    function watchSig(w) {
      const lr = (w && w.longrun) || {};
      return JSON.stringify({
        enabled: !!(w && w.enabled),
        longrun: {
          enabled: !!lr.enabled,
          maxDurationMs: typeof lr.maxDurationMs === 'number' ? lr.maxDurationMs : null,
          noProgressWindowMs: typeof lr.noProgressWindowMs === 'number' ? lr.noProgressWindowMs : null
        }
      });
    }
    // dirty 基准分节（单保存合并 governance + capabilities.watch 双段）：剥掉 watch 键后 = governance 表单节
    function govFormOf(f) { const o = Object.assign({}, f); delete o.watch; return o; }
    // remount 确认：按「实际改动节」比对生效快照（governance 节沿用 hookSig 既有语义；watch 节用 watchSig）。
    //   未改动节不要求快照翻转（watch 与 governance 各自独立生效通道——watch-only 保存时 governance 快照
    //   不变属预期，不阻塞确认）；改动节要求生效快照已翻转（快照未变=热更未落，继续轮询）。
    function appliedMatches(payload, beforeSig, applied, beforeWatchSig, govChanged, watchChanged) {
      if (!applied) return false;
      if (govChanged) {
        if (!applied.hook) return false;
        if (applied.hook.enabled !== payload.governance.hook.enabled) return false;
        const sig = hookSig(applied.hook);
        if (beforeSig !== null && sig === beforeSig) return false;
      }
      if (watchChanged) {
        const w = applied.watch;
        if (!w) return false;
        const want = payload.capabilities.watch;
        if (!!w.enabled !== !!want.enabled) return false;
        const wantLr = (want.longrun && want.longrun.enabled) === true;
        if (((w.longrun && w.longrun.enabled) === true) !== wantLr) return false;
        const ws = watchSig(w);
        if (beforeWatchSig !== null && ws === beforeWatchSig) return false;
      }
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
            if (appliedMatches(confirm.payload, confirm.beforeSig, data && data.applied, confirm.beforeWatchSig, confirm.govChanged, confirm.watchChanged)) {
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
      // watch 段（卡片 E）patch：父开关整层替换、子开关只动 longrun 子对象
      function patchWatch(p) { patch({ watch: Object.assign({}, form.watch, p) }); }
      function patchWatchLongrun(p) { patchWatch({ longrun: Object.assign({}, form.watch.longrun, p) }); }
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
        // watch 长跑两阈值（分钟语义；UI 本地换算 ms 原生键 maxDurationMs/noProgressWindowMs——后端白名单/值域已就绪，零后端代码）
        const wlr = (form.watch && form.watch.longrun) || {};
        const maxDurMin = Number(wlr.maxDurationMin);
        const noProgMin = Number(wlr.noProgressMin);
        const bad = [];
        if (!Number.isInteger(threshold) || threshold < 1) bad.push({ code: 'invalid-value', message: tt('gov.esc.threshold') });
        if (!Number.isFinite(windowSecs) || windowSecs < 1) bad.push({ code: 'invalid-value', message: tt('gov.esc.window') });
        if (!Number.isFinite(maxDurMin) || maxDurMin < 1) bad.push({ code: 'invalid-value', message: tt('gov.watch.longrun.maxDuration') });
        if (!Number.isFinite(noProgMin) || noProgMin < 1) bad.push({ code: 'invalid-value', message: tt('gov.watch.longrun.noProgress') });
        if (bad.length) { setErr({ items: bad }); return; }
        const prims = esc.primitives.filter((p) => escPrimitives().indexOf(p) >= 0);
        // POST 装载键：null/undefined = 省略 preset 键（后端删键回出厂零规则）；数组 = string[]；
        // { custom } = 原文透传。全不勾必须省略键（后端拒空数组/空串）
        const presetWire = presetWireOf(form.preset);
        const hook = {
          enabled: !!form.enabled,
          escalation: { enabled: !!esc.enabled, threshold: threshold, windowSeconds: windowSecs, primitives: prims },
          flags: { narrow: !!form.narrow }
        };
        if (presetWire !== undefined) hook.preset = presetWire;
        const watch = form.watch || { enabled: true, longrun: { enabled: true } };
        const wl = (watch && watch.longrun) || {};
        // 单保存合并双段：governance 组装保持原样 + capabilities.watch 段追加——
        //   显式布尔（与 governance.hook.enabled 先例一致，不做「等于默认值删键」）；
        //   longrun 三键齐发（enabled + 两阈值 ms）——后端 merge 只覆盖显式提交子键，无损其它手工键
        const payload = {
          governance: { hook: hook },
          capabilities: {
            watch: {
              enabled: !!watch.enabled,
              longrun: {
                enabled: !!(wl && wl.enabled),
                maxDurationMs: Math.round(maxDurMin * 60000),
                noProgressWindowMs: Math.round(noProgMin * 60000)
              }
            }
          }
        };
        const beforeSig = meta && meta.applied ? hookSig(meta.applied.hook) : null;
        const beforeWatchSig = meta && meta.applied && meta.applied.watch ? watchSig(meta.applied.watch) : null;
        // dirty 基准分节：确认轮询按实际改动节比对（watch 与 governance 独立生效通道——未动节不要求快照翻转）
        const preForm = base ? JSON.parse(base) : null;
        const govChanged = preForm === null || JSON.stringify(govFormOf(form)) !== JSON.stringify(govFormOf(preForm));
        const watchChanged = preForm === null || JSON.stringify(form.watch) !== JSON.stringify(preForm.watch);
        setErr(null); setState('saving');
        try {
          await postConfig(payload);
          setBase(JSON.stringify(form));
          setConfirm({ payload: payload, beforeSig: beforeSig, beforeWatchSig: beforeWatchSig, govChanged: govChanged, watchChanged: watchChanged });
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

        // 卡片 C 违规升级（SwitchRow 无标题卡片；desc 常显——开关 off 亦显示语义说明；子项开启后联动显示）
        React.createElement(GovCard, null,
          React.createElement(SwitchRow, {
            checked: form.escalation.enabled,
            onChange: (v) => patchEsc({ enabled: v }),
            title: tt('gov.esc.title'),
            desc: tt('gov.esc.desc')
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

        // 卡片 E watch 能力开关（父开关 Lane 过期检测 + 子开关 longrun 探针 + 长跑两阈值分钟字段；
        //   父关 → 子开关 disabled 不可点（交互保留、无解释文字）；阈值字段在父子均开时渲染，关闭时隐藏但值保留于 form）
        React.createElement(GovCard, null,
          React.createElement(SwitchRow, {
            checked: form.watch.enabled,
            onChange: (v) => patchWatch({ enabled: v }),
            title: tt('gov.watch.title'),
            desc: tt('gov.watch.desc')
          }),
          React.createElement(SwitchRow, {
            checked: form.watch.enabled && form.watch.longrun.enabled,
            onChange: (v) => patchWatchLongrun({ enabled: v }),
            disabled: !form.watch.enabled,
            title: tt('gov.watch.longrun.title'),
            desc: tt('gov.watch.longrun.desc')
          }),
          form.watch.enabled && form.watch.longrun.enabled
            ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0 0 2px' } },
                React.createElement(NumberField, {
                  label: tt('gov.watch.longrun.maxDuration'), value: form.watch.longrun.maxDurationMin,
                  min: 1, step: 1,
                  onChange: (v) => patchWatchLongrun({ maxDurationMin: v })
                }),
                React.createElement(NumberField, {
                  label: tt('gov.watch.longrun.noProgress'), value: form.watch.longrun.noProgressMin,
                  min: 1, step: 1,
                  onChange: (v) => patchWatchLongrun({ noProgressMin: v })
                })
              )
            : null
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
