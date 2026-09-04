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
    // 引用的 T/cardBase/tt/chip/STATE/Dot/Chip/SectionTitle/Skeleton 等为前序段绑定（渲染时已初始化）。
    //
    // 数据契约 = GET /api/dsh-punky-swarm/config → { overlay, applied, presets }
    //   overlay = <root>/config/runtime.json governance 段原样（磁盘原文；无 = null）
    //   applied = 引擎 resolve 后的生效快照——preset 已被展开为 rules（不保留 preset 键），
    //             故 preset 当前值只读 overlay.hook.preset；applied 仅用于「生效规则数/生效状态」展示。
    //   presets = [{ id, count }] 注册目录元数据（下拉规则数摘要）。
    // 写契约 = POST 同路径，body { governance: { hook: { enabled, preset?, escalation, flags } } }，
    //         400 → { ok:false, errors:[{ field, code, message }] }（页面按 code 双语映射）。

    function fmtN(k, n) { return tt(k).replace('{n}', String(n)); }
    function pickBool(a, b, d) { return typeof a === 'boolean' ? a : typeof b === 'boolean' ? b : d; }
    function pickNum(a, b, d) { return typeof a === 'number' && isFinite(a) ? a : typeof b === 'number' && isFinite(b) ? b : d; }
    function clockOf(d) { try { return d.toTimeString().slice(0, 8); } catch { return ''; } }
    function presetIds() { return ['l1-sensitive', 'l2-resource', 'compose']; }
    function escPrimitives() { return ['DENY', 'NARROW', 'DEFER', 'PAUSE']; } // REQUIRE_APPROVAL 红线不可经表单（引擎契约），不出现
    function presetMeaningKey(id) {
      switch (id) {
        case 'l1-sensitive': return 'gov.preset.l1';
        case 'l2-resource': return 'gov.preset.l2';
        case 'compose': return 'gov.preset.compose';
        default: return null;
      }
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
    // preset 只读 overlay.hook.preset（applied 不保留 preset）；null=出厂空表（保存省略键）。
    function deriveForm(data) {
      const ov = data && data.overlay && data.overlay.hook ? data.overlay.hook : null;
      const ap = data && data.applied && data.applied.hook ? data.applied.hook : null;
      const escO = (ov && ov.escalation) || {};
      const escA = (ap && ap.escalation) || {};
      const flO = (ov && ov.flags) || {};
      const flA = (ap && ap.flags) || {};
      let preset = null;
      const pv = ov && ov.preset;
      if (typeof pv === 'string' && pv !== '') preset = pv;
      else if (Array.isArray(pv) && pv.length) preset = pv.slice();
      return {
        enabled: pickBool(ov && ov.enabled, ap && ap.enabled, true),
        preset: preset,
        escalation: {
          enabled: pickBool(escO.enabled, escA.enabled, false),
          threshold: String(pickNum(escO.threshold, escA.threshold, 3)),
          windowMs: String(pickNum(escO.windowMs, escA.windowMs, 600000)),
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
          ? React.createElement('div', { style: { fontSize: 11.5, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, title)
          : null,
        children
      );
    }
    function SwitchRow({ checked, onChange, title, desc, disabled }) {
      const on = !!checked;
      return React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, color: T.text, lineHeight: 1.35 } }, title),
          desc
            ? React.createElement('div', { style: { fontSize: 11, color: T.text3, lineHeight: 1.45, marginTop: 3 } }, desc)
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
    function NumberField({ label, value, onChange, min, step, suffix, disabled }) {
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        React.createElement('span', { style: { flex: 1, fontSize: 11.5, color: T.text2, lineHeight: 1.3 } }, label),
        React.createElement('input', {
          type: 'number', min: min, step: step, value: value, disabled: !!disabled,
          onChange: (e) => onChange(e.target.value),
          style: {
            width: 96, background: T.card, color: T.text,
            border: '1px solid ' + T.border, borderRadius: 8, padding: '5px 8px',
            fontSize: 12, fontFamily: T.mono, outline: 'none', textAlign: 'right',
            opacity: disabled ? 0.55 : 1
          }
        }),
        suffix
          ? React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, width: 20, flex: 'none' } }, suffix)
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
              fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3,
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
      async function handleSave() {
        const esc = form.escalation;
        const threshold = Number(esc.threshold);
        const windowMs = Number(esc.windowMs);
        const bad = [];
        if (!Number.isInteger(threshold) || threshold < 1) bad.push({ code: 'invalid-value', message: tt('gov.esc.threshold') });
        if (!Number.isFinite(windowMs) || windowMs < 1000) bad.push({ code: 'invalid-value', message: tt('gov.esc.window') });
        if (bad.length) { setErr({ items: bad }); return; }
        const prims = esc.primitives.filter((p) => escPrimitives().indexOf(p) >= 0);
        const hook = {
          enabled: !!form.enabled,
          escalation: { enabled: !!esc.enabled, threshold: threshold, windowMs: windowMs, primitives: prims },
          flags: { narrow: !!form.narrow }
        };
        if (form.preset) hook.preset = form.preset; // string | array 原文；null=出厂空表（省略键）
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
          React.createElement(SectionTitle, null, state === 'error' ? tt('gov.error.net') : tt('gov.loading')),
          state === 'error'
            ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: T.error, fontSize: 12 } },
                React.createElement('span', null, tt('gov.error.net')),
                React.createElement('button', {
                  type: 'button', className: 'psw-btn', onClick: reload,
                  style: { background: T.card, color: T.text2, border: '1px solid ' + T.border, borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer' }
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
      const selectable = presetIds();
      const selValue = typeof form.preset === 'string' && selectable.indexOf(form.preset) >= 0 ? form.preset : '';
      const customPreset = form.preset !== null && selValue === '';
      const countOf = (id) => { const m = meta.presets; return typeof m[id] === 'number' ? m[id] : 0; };
      const liveSt = pending ? STATE.running : STATE.merged;
      const chipLabel = state === 'saving' ? tt('gov.saving') : state === 'confirming' ? tt('gov.saved') : tt('gov.live');
      const btnBase = {
        borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 600,
        cursor: 'pointer', lineHeight: 1.3, transition: 'opacity .15s ease'
      };
      const saveDisabled = busy || state === 'loading' || !dirty;

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, color: T.text, fontFamily: T.font, width: '100%', boxSizing: 'border-box' } },
        // 头部：标题 + 生效规则数 + 生效状态 Chip + 最近生效时间
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement(SectionTitle, null, fmtN('gov.title.live', meta.rules)),
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

        // 卡片 B 规则预设
        React.createElement(GovCard, { title: tt('gov.preset.title') },
          React.createElement('select', {
            value: selValue,
            onChange: (e) => patch({ preset: e.target.value === '' ? null : e.target.value }),
            style: {
              width: '100%', background: T.card, color: T.text,
              border: '1px solid ' + T.border, borderRadius: 8, padding: '6px 8px',
              fontSize: 12, fontFamily: T.mono, outline: 'none'
            }
          },
            [{ value: '', label: tt('gov.preset.none') }]
              .concat(selectable.map((id) => ({ value: id, label: id + ' · ' + fmtN('gov.preset.rules', countOf(id)) })))
              .map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))
          ),
          !customPreset && presetMeaningKey(selValue)
            ? React.createElement('div', { style: { fontSize: 11, color: T.text2 } }, tt(presetMeaningKey(selValue)))
            : null,
          customPreset
            ? React.createElement('div', { style: { fontSize: 10.5, color: T.warn, lineHeight: 1.45 } },
                tt('gov.preset.custom'),
                React.createElement('span', { style: { fontFamily: T.mono, opacity: 0.85 } }, ' ' + JSON.stringify(form.preset))
              )
            : null,
          meta.manualRules > 0
            ? React.createElement('div', { style: { fontSize: 10.5, color: T.warn, lineHeight: 1.45 } }, fmtN('gov.preset.manual', meta.manualRules))
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
                  label: tt('gov.esc.window'), value: form.escalation.windowMs,
                  min: 1000, step: 1000, suffix: 'ms',
                  onChange: (v) => patchEsc({ windowMs: v })
                }),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                  React.createElement('span', { style: { flex: 1, fontSize: 11.5, color: T.text2 } }, tt('gov.esc.primitives')),
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
                display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11.5, color: T.error
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
            ? React.createElement('span', { style: { fontSize: 11, color: T.warn } },
                React.createElement(Dot, { color: T.warn }),
                React.createElement('span', { style: { marginLeft: 5 } }, tt('gov.dirty')))
            : null
        )
      );
    }
