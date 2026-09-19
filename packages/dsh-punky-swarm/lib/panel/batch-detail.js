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

// ===== [panel-segment] batch-detail.js =====
    // 右栏批次详情：三层泳道（层为一等分区）+ lane 卡字段扩展（契约行/角色技能/依赖+交接/门禁+动作句/
    //   返工升级/最近活动）+ 装配与门禁条 + 人话事件流（可切原始 type）+ 邮箱元数据（不贴正文）。
    // 判定一律取自 panel-model.js 纯函数（0 值收起 / 不混层 / 去重 / 人话映射都只有一份实现）。
    function GateBadge({ gate }) {
      const items = gateBadgesOf(gate);
      if (!items.length) return null;
      const KIND = { consume: tt('gate.consume'), outputs: tt('gate.outputs'), produce: tt('gate.produce'), contract: tt('gate.contract') };
      return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } },
        items.map((it, i) => React.createElement('span', {
          key: i,
          title: KIND[it.kind] + ': ' + it.path,
          style: { color: T.warn, background: pal().gateBg, borderRadius: 999, padding: '1px 7px', fontSize: 10.5, fontWeight: 600, fontFamily: T.mono, whiteSpace: 'nowrap' }
        }, tt('gate.missing') + ' ' + it.path)),
        React.createElement('span', { style: { fontSize: 10.5, color: T.text3 } }, '— ' + tt('gate.fix.hint'))
      );
    }

    function AttemptBadge({ n, upgrade }) {
      if (!n && !upgrade) return null;
      const label = upgrade ? tt('upgrade') : fmtCount(tt('attempt'), n);
      return React.createElement('span', {
        style: upgrade
          ? { color: pal().escFg, background: pal().escBg, borderRadius: 999, padding: '1px 7px', fontSize: 10.5, fontWeight: 600, fontFamily: T.mono, whiteSpace: 'nowrap' }
          : { color: T.text2, fontSize: 10.5, fontFamily: T.mono, whiteSpace: 'nowrap' }
      }, label);
    }

    // 交接徽章三态：已交接 / 待交接 / 待 X 交接解锁（判据单点在 panel-model.handoffBadgeOf）
    function HandoffBadge({ badge }) {
      if (!badge) return null;
      const tone = badge.key === 'done' ? T.success : badge.key === 'blocked' ? T.error : T.warn;
      const text = badge.from
        ? tt('handoff.' + badge.key).replace('{from}', badge.from)
        : tt('handoff.' + badge.key);
      return React.createElement('span', {
        style: { color: tone, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap' }
      }, text);
    }

    function LaneCard({ lane, state, attempt, upgrade, gate, meta, handoff, lastTs }) {
      const st = STATE[state] || STATE.pending;
      const m = meta || {};
      const line = contractLineOf(m);
      const deps = m.deps && m.deps.length ? m.deps : null;
      const outList = line.produce.concat(line.outputs);
      const contractText = (line.consume.length || outList.length)
        ? tt('contract.line').replace('{a}', line.consume.length ? line.consume.join(', ') : '—').replace('{b}', outList.length ? outList.join(', ') : '—')
        : tt('contract.none');
      return React.createElement('div', {
        className: 'psw-card',
        style: Object.assign({}, cardBase, {
          flex: '1 1 168px', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
          borderLeft: '3px solid ' + st.fg
        })
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, lane),
          React.createElement(Chip, { st: st }, state),
          React.createElement(HandoffBadge, { badge: handoff })
        ),
        m.cmd ? React.createElement('div', {
          style: { fontSize: 11, color: T.text2, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
        }, m.cmd) : null,
        React.createElement('div', { style: { fontSize: 10.5, color: T.text2, fontFamily: T.mono, lineHeight: 1.45, wordBreak: 'break-all' } }, contractText),
        m.role || (m.skills && m.skills.length)
          ? React.createElement('div', { style: { fontSize: 10.5, color: T.text3 } },
              tt('role.skills').replace('{role}', m.role || '—').replace('{skills}', (m.skills || []).length ? m.skills.join(', ') : '—'))
          : null,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
          React.createElement(GateBadge, { gate }),
          React.createElement(AttemptBadge, { n: attempt, upgrade }),
          deps ? React.createElement('span', { style: { fontSize: 10.5, color: T.dim, fontFamily: T.mono } }, tt('task.deps') + ': ' + deps.join(', ')) : null
        ),
        lastTs ? React.createElement('div', {
          style: { fontSize: 10.5, color: T.dim, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' },
          title: tt('lane.recentHint')
        }, tt('lane.lastActive').replace('{t}', String(lastTs).slice(11, 19))) : null
      );
    }

    // 事件人话文本（渲染层唯一拼装点；未知 type 由渲染层回退原始 type，绝不用 key 兜底冒充人话）
    function panelEventText(v) {
      const a = v.args || {};
      const head = a.lane ? a.lane + ' ' : '';
      if (v.raw === 'member.settled') {
        const verdictRaw = (a.from === 'review' && a.to === 'running') ? 'review>running' : String(a.to || '');
        return head + tt(v.key) + '：' + String(a.to || '') + tt(verdictNoteOf(verdictRaw));
      }
      if (v.raw === 'member.dispatch') return head + tt(v.key);
      if (v.raw === 'gate.needhuman_blocked' && a.path) return head + tt(v.key) + '（' + a.path + '）';
      if (a.from && a.to) return head + tt(v.key) + ' ' + a.from + '→' + a.to;
      return head + tt(v.key);
    }

    function EventRow({ e, raw }) {
      const v = eventViewOf(e);
      const color = v.severity === 'error' ? T.error
        : v.severity === 'warn' ? T.warn
          : v.severity === 'info' ? T.info : T.text3;
      // raw 模式 = 原始 type + lane + 转移（工程师面）；人话模式 = 换词后动作句；未知 type 恒回退原始 type
      const label = (raw || !v.key)
        ? v.raw + (v.args.lane ? ':' + v.args.lane : '') + (v.args.from ? ' ' + v.args.from + '->' + v.args.to : '')
        : panelEventText(v);
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
        React.createElement(Dot, { color: color }),
        React.createElement('span', { style: { flex: 1, fontSize: 11.5, color: T.text2, fontFamily: T.mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        React.createElement('span', { style: { fontSize: 10.5, color: T.dim, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' } }, (e.ts || '').slice(11, 19))
      );
    }

    // 事件流：类别 chips + lane 过滤 + 「原始 type」开关（Q-4：人话默认，工程面可切）
    function EventStream({ evs, eventCount, lanes }) {
      const [category, setCategory] = useState('all');
      const [lane, setLane] = useState('');
      const [raw, setRaw] = useState(false);
      const shown = eventFilterOf(evs, { category: category, lane: lane, raw: raw });
      const filterKeys = EVENT_CATEGORIES.map((c) => 'event.filter.' + c);
      return React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '10px 12px' }) },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement(SectionTitle, null, tt('event.timeline')),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('span', {
            style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' }
          }, tt('event.tail').replace('{n}', String(shown.length)).replace('{m}', String(eventCount == null ? (evs || []).length : eventCount)))
        ),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', margin: '4px 0 6px' } },
          EVENT_CATEGORIES.map((c) => React.createElement('button', {
            key: c,
            type: 'button',
            className: 'psw-btn',
            'aria-pressed': category === c,
            onClick: () => setCategory(c),
            style: {
              fontSize: 10.5, padding: '1px 8px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid ' + (category === c ? T.accent : T.border),
              background: category === c ? T.selBg : 'transparent',
              color: category === c ? T.text : T.text3, fontFamily: T.font
            }
          }, tt('event.filter.' + c))),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('select', {
            value: lane,
            'aria-label': tt('event.laneFilter'),
            onChange: (ev) => setLane(ev.target.value),
            style: { fontSize: 10.5, borderRadius: 8, border: '1px solid ' + T.border, background: T.card, color: T.text2, fontFamily: T.mono, maxWidth: 140 }
          },
            React.createElement('option', { value: '' }, tt('event.laneAll')),
            Object.keys(lanes || {}).map((l) => React.createElement('option', { key: l, value: l }, l))
          ),
          React.createElement('button', {
            type: 'button',
            className: 'psw-btn',
            'aria-pressed': raw,
            onClick: () => setRaw(!raw),
            style: {
              fontSize: 10.5, padding: '1px 8px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid ' + (raw ? T.accent : T.border),
              background: raw ? T.selBg : 'transparent',
              color: raw ? T.text : T.text3, fontFamily: 'inherit'
            }
          }, raw ? tt('event.raw.on') : tt('event.raw.off'))
        ),
        shown.length
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } }, shown.map((e, i) => React.createElement(EventRow, { key: i, e: e, raw: raw })))
          : React.createElement('div', { style: { fontSize: 11.5, color: T.text3, padding: '4px 0' } }, tt('empty'))
      );
    }

    // 邮箱：计数 + 元数据列表（只列元数据字段名与类型，不复制正文——与 mailbox「只写元数据」纪律一致）
    function MailBox({ mail }) {
      const m = mail || { inbox: [], broadcast: [] };
      const rows = [];
      for (const it of (m.inbox || [])) rows.push({ box: 'mailbox.inbox', it: it });
      for (const it of (m.broadcast || [])) rows.push({ box: 'mailbox.broadcast', it: it });
      return React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }) },
        React.createElement(SectionTitle, null, tt('mailbox.title')),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: T.skeleton, borderRadius: 8, padding: '6px 10px' } },
            React.createElement(Dot, { color: T.info }),
            React.createElement('span', { style: { fontSize: 11, color: T.text2 } }, tt('mailbox.inbox')),
            React.createElement('span', { style: { marginLeft: 'auto', fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: T.text, fontVariantNumeric: 'tabular-nums' } }, (m.inbox || []).length)
          ),
          React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: T.skeleton, borderRadius: 8, padding: '6px 10px' } },
            React.createElement(Dot, { color: T.warn }),
            React.createElement('span', { style: { fontSize: 11, color: T.text2 } }, tt('mailbox.broadcast')),
            React.createElement('span', { style: { marginLeft: 'auto', fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: T.text, fontVariantNumeric: 'tabular-nums' } }, (m.broadcast || []).length)
          )
        ),
        rows.length
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              React.createElement('div', { style: { fontSize: 10.5, color: T.dim } }, tt('mailbox.meta')),
              rows.slice(0, 8).map((r, i) => React.createElement('div', { key: i, style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                (String(r.it.ts || '').slice(11, 19) || '--:--:--') + ' · ' + tt(r.box) + ' · ' + (r.it.type || '-') + ' · ' + (r.it.lane || '-') + ' · ' + Object.keys(r.it.meta || {}).length)
              )
            )
          : React.createElement('div', { style: { fontSize: 11, color: T.text3 } }, tt('mailbox.hint'))
      );
    }

    // 装配与门禁条：团队资产 / 装配声明 / Manager 登记 / 并发声明（**未启用限流**，Q-B 2026-09-18）/ 门禁总览（复用 lanesGate 的 gateStrength，
    //   不新增第二份门禁判定）/ 冒烟批 / 装配声明静态回显（`chain` = **建批期展开 + 静态校验**，非运行期真源：运行期 DAG 真源 =
    //   `lanes[].deps` + `batch.handoffs`；G-10#4 已去「链」叙事——标签文案见 `assembly.chain` locale 键，改前作「链」会把静态声明
    //   读成运行期推进面）。
    function AssemblyBar({ d }) {
      const lg = d.lanesGate || {};
      const firstLane = Object.keys(lg)[0];
      const gs = firstLane ? (lg[firstLane] || {}).gateStrength || null : null;
      const ta = d.teamAsset || null;
      const asm = d.assembly || null;
      const items = [];
      const push = (k, v) => { if (v !== null && v !== undefined && v !== '') items.push({ k: k, v: String(v) }); };
      push('assembly.team',
        (ta && ta.team ? ta.team : '-')
        + (ta && ta.assetHash ? ' · ' + String(ta.assetHash).slice(0, 8) : '')
        + (ta && ta.ok === false ? ' · !' + String(ta.severity || 'gap') : ''));
      push('assembly.orchestration', asm && asm.managerPlan ? asm.managerPlan : null);
      push('assembly.auditLane', asm && asm.auditLane ? asm.auditLane : null);
      push('assembly.manager', d.manager && d.manager.agentId ? d.manager.agentId : tt('assembly.managerNone'));
      push('concurrency', d.concurrency != null ? tt('concurrency') + ' ' + d.concurrency : null);
      if (gs) push('assembly.gates', gs.level + ' · ' + (gs.lanes ? ('plan ' + gs.lanes.plan + ' / exec ' + gs.lanes.exec + ' / audit ' + gs.lanes.audit) : '') + ((gs.escapes || []).length ? ' · escape ' + gs.escapes.length : '') + ((gs.degrades || []).length ? ' · degrade ' + gs.degrades.length : ''));
      if (d.smoke) push('assembly.smoke', tt('assembly.smoke'));
      if (d.chain && Array.isArray(d.chain.steps) && d.chain.steps.length) {
        push('assembly.chain', d.chain.steps.map((s) => (s && s.id) || '?').join(' → '));
      }
      if (!items.length) return null;
      return React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }) },
        React.createElement(SectionTitle, null, tt('assembly.title')),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
          items.map((it, i) => React.createElement('span', { key: i, style: { fontSize: 10.5, color: T.text2 } },
            React.createElement('span', { style: { color: T.text3 } }, tt(it.k) + ' '),
            React.createElement('span', { style: { fontFamily: T.mono } }, it.v)
          ))
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
      const evs = d.recentEvents || [];
      const mail = d.mail || { inbox: [], broadcast: [] };
      const meta = laneMetaOf(d.wavePlan);
      const groups = lanesByLayerOf(d.lanes, meta);
      const dangling = Array.isArray(d.danglingLanes) ? d.danglingLanes : [];
      // lane 最近活动（面板口径：近 20 条事件内该 lane 末条 ts；已明示口径）
      const lastTs = {};
      for (const e of evs) { if (e && e.lane) lastTs[e.lane] = e.ts || lastTs[e.lane]; }
      return React.createElement('div', { className: 'psw-scroll', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', paddingRight: 4 } },
        React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }) },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' } },
            React.createElement(Chip, { st: st }, d.phase + (d.viewSettled ? ' ✓' : '')),
            React.createElement('span', { style: { fontWeight: 700, fontSize: 14, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, d.batchId),
            React.createElement('span', { style: { flex: 1 } }),
            dangling.length
              ? React.createElement('span', { style: { color: T.warn, fontSize: 10.5, fontWeight: 600 } }, fmtCount(tt('dangling.badge'), dangling.length))
              : null,
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
            React.createElement('span', null, tt('events') + ' ' + (d.eventCount != null ? d.eventCount : evs.length)),
            React.createElement('span', null, tt('concurrency') + ' ' + d.concurrency)
          )
        ),
        React.createElement(AssemblyBar, { d: d }),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          groups.map((g) => React.createElement('div', { key: g.layer, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              // 层位标 = 3px 中性竖条（颜色只编码状态 ⇒ 层不用语义色）
              React.createElement('span', { 'aria-hidden': 'true', style: { width: 3, height: 12, borderRadius: 999, background: T.border } }),
              React.createElement('span', { style: { fontSize: 12.5, fontWeight: 700, color: T.text } }, tt('layer.' + g.layer)),
              React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono } }, String(g.lanes.length)),
              g.layer === 'exec'
                ? React.createElement('span', { style: { fontSize: 10.5, color: T.text3 } }, fmtCount(tt('layer.parallel'), g.lanes.length))
                : null
            ),
            React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              g.lanes.map((x) => React.createElement(LaneCard, {
                key: x.lane, lane: x.lane, state: x.state,
                attempt: (d.laneAttempts || {})[x.lane], upgrade: (d.upgrades || {})[x.lane],
                gate: (d.lanesGate || {})[x.lane], meta: x.meta,
                handoff: handoffBadgeOf(x.lane, d.handoffs || {}, x.meta, x.state),
                lastTs: lastTs[x.lane]
              }))
            )
          ))
        ),
        React.createElement(EventStream, { evs: evs, eventCount: d.eventCount, lanes: d.lanes }),
        React.createElement(MailBox, { mail: mail })
      );
    }
