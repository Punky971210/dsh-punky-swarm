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
          style: { color: T.warn, background: T.gateBg, borderRadius: 999, padding: '1px 7px', fontSize: 10.5, fontWeight: 600, fontFamily: T.mono, whiteSpace: 'nowrap' }
        }, tt('gate.missing') + ' ' + it.path)),
        // 【波 A · A-1】「— 补上即可结算」是缺口的**行动指引正文**（用户读它才知道下一步做什么）⇒ 上调次级文本。
        React.createElement('span', { style: { fontSize: 10.5, color: T.text2 } }, '— ' + tt('gate.fix.hint'))
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
      // 【B-7】持久 `cmd` 是装配串（`[role=…] [skills=…] 原文`）⇒ 渲染前剥前缀取原文：下方 role/skills 行
      //   已单独承载角色与技能，再原样显示整串即是同一信息的第二遍（且首段不是「任务是什么」）。
      const plainCmd = plainCmdOf(m.cmd, m.role, m.skills);
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
          React.createElement(Chip, { st: st }, protocolLabelOf('state', state)),
          React.createElement(HandoffBadge, { badge: handoff })
        ),
        plainCmd ? React.createElement('div', {
          style: { fontSize: 11, color: T.text2, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
        }, plainCmd) : null,
        React.createElement('div', { style: { fontSize: 10.5, color: T.text2, fontFamily: T.mono, lineHeight: 1.45, wordBreak: 'break-all' } }, contractText),
        m.role || (m.skills && m.skills.length)
          // 【波 A · A-1】角色/技能是 lane 卡的任务元数据正文（与上一行契约行同级）⇒ 上调次级文本。
          ? React.createElement('div', { style: { fontSize: 10.5, color: T.text2 } },
              tt('role.skills').replace('{role}', m.role || '—').replace('{skills}', (m.skills || []).length ? m.skills.join(', ') : '—'))
          : null,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
          React.createElement(GateBadge, { gate }),
          React.createElement(AttemptBadge, { n: attempt, upgrade }),
          // 【波 A · A-1】依赖列表是 DAG 关系正文（用户据以判断上下游是否解锁）⇒ 原 label-dimmed
          //   （宿主语义 = 占位/禁用）既非其义、又低于可读基线 ⇒ 直接上调次级文本。
          deps ? React.createElement('span', { style: { fontSize: 10.5, color: T.text2, fontFamily: T.mono } }, tt('task.deps') + ': ' + deps.join(', ')) : null,
          // 【B-3】归属徽章：`owner === null` ⇒ 在池内（未派发）；非空 ⇒ 已派发给谁。
          //   仅在 meta 有该键时渲染：孤儿 lane（`lanes` 有而 wavePlan 无）没有归属声明可读，故零噪音不猜。
          m.owner !== undefined
            ? React.createElement('span', {
                style: {
                  fontSize: 10.5, fontFamily: T.mono, whiteSpace: 'nowrap',
                  color: m.owner === null ? T.text2 : T.success
                }
              }, m.owner === null ? tt('owner.pooled') : tt('owner.assigned').replace('{owner}', m.owner))
            : null
        ),
        lastTs ? React.createElement('div', {
          // 【波 A · A-1】保留弱层级（时间戳属旁注），但纠令牌语义：label-dimmed=占位/禁用 ⇒ 换 label-tertiary。
          style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' },
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
      // 【B-5】出池留痕：带上受派方（面板读者据此知道「派给谁」，而非只知「派过」）
      if (v.raw === 'task.owner.assigned') return head + tt(v.key) + (a.owner ? ' → ' + a.owner : '');
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
        React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' } }, (e.ts || '').slice(11, 19))
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
            // 【波 A · A-1】「近 N 条 / 共 M 条」是**事件窗口是否被截断**的唯一读数（口径见 panel-model 尾窗注释）
            //   ⇒ 属正文读数，上调次级文本；非装饰性计数。
            style: { fontSize: 10.5, color: T.text2, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' }
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
              // 【波 A · A-1】「元数据（不贴正文）」是列表小标题：保留弱层级，纠令牌语义（dimmed=占位/禁用 ⇒ tertiary）。
              React.createElement('div', { style: { fontSize: 10.5, color: T.text3 } }, tt('mailbox.meta')),
              // 【波 A · A-1】邮箱元数据行（时刻 · 箱 · type · lane · 字段数）是用户实际读的数据行 ⇒ 上调次级文本。
              rows.slice(0, 8).map((r, i) => React.createElement('div', { key: i, style: { fontSize: 10.5, color: T.text2, fontFamily: T.mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                (String(r.it.ts || '').slice(11, 19) || '--:--:--') + ' · ' + tt(r.box) + ' · ' + (r.it.type || '-') + ' · ' + (r.it.lane || '-') + ' · ' + Object.keys(r.it.meta || {}).length)
              )
            )
          : React.createElement('div', { style: { fontSize: 11, color: T.text3 } }, tt('mailbox.hint'))
      );
    }

    // 装配与门禁条：团队资产 / 装配声明 / Manager 登记 / 并发声明（**未启用限流**，Q-B 2026-09-18）/ 门禁总览（复用 lanesGate 的 gateStrength，
    //   不新增第二份门禁判定）/ 冒烟批。
    //   【2026-09-27 · 批 3 D-4 删净】原「装配声明静态回显」一项（建批期展开 + 静态校验）**已整条删除**：
    //   链声明面与回显面全量退役 ⇒ 标签文案键同批删除（原键 = 本组件下方 push 的第一参）。
    //   运行期 DAG 真源 = 批次的 `lanes[].deps` + `batch.handoffs`（逐边取件见 `handoff_view` 工具）。
    function AssemblyBar({ d }) {
      const lg = d.lanesGate || {};
      const firstLane = Object.keys(lg)[0];
      const gs = firstLane ? (lg[firstLane] || {}).gateStrength || null : null;
      // 【历史兼容读 · 零发射点，新批不再产】该键自批 3 起**建批侧已停写**，存量批 JSON 真值里仍可能带它
      //   ⇒ 本读点**保留**（与 HTTP 侧同源读点成对，Q-1 裁决 = 双侧同保留）：删读端 = 主动丢历史可复盘面；
      //   该键**零发射点** ⇒ 无「写了不生效」的静默面。**禁为求绿删本读点或其断言**。
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
      if (!items.length) return null;
      return React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }) },
        React.createElement(SectionTitle, null, tt('assembly.title')),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
          items.map((it, i) => React.createElement('span', { key: i, style: { fontSize: 10.5, color: T.text2 } },
            // 【波 A · A-1】键名（团队/编排/验收 lane/Manager 登记/门禁）是可读字段名：值常为 mono 编码串，
            //   离开键名不可解读 ⇒ 上调次级文本（值本身同层，故此处无层级差）。
            React.createElement('span', { style: { color: T.text2 } }, tt(it.k) + ' '),
            React.createElement('span', { style: { fontFamily: T.mono } }, it.v)
          ))
        )
      );
    }

    // 任务池视图（B-4）：数据源 = 服务端 `/batch.pool` 投影（判据单点在 `task-tools.poolViewOf`）——
    //   面板**不自行判定**「哪些任务在池内 / 是否可派发」，只渲染投影给出的 pooled/dispatchable/blockers。
    //   零噪音：池内无任务 ⇒ 整块不渲染（已派发计数在 lane 卡徽章上已可读）。
    //   blockers 是引擎判据串（含 GATE_* 码）⇒ 原样显示，不译、不加工（协议面在工程师侧照旧可读）。
    function PoolView({ pool, meta }) {
      const items = pool && Array.isArray(pool.pool) ? pool.pool : [];
      if (!items.length) return null;
      const dispatchable = items.filter((t) => t.dispatchable).length;
      const summary = tt('pool.summary')
        .replace('{n}', String(items.length)).replace('{m}', String(dispatchable))
        .replace('{k}', String(pool.dispatched || 0));
      return React.createElement('div', { className: 'psw-card', style: Object.assign({}, cardBase, { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }) },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement(SectionTitle, null, tt('pool.title')),
          React.createElement('span', { style: { fontSize: 10.5, color: T.text2, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' } }, summary)
        ),
        items.map((t, i) => {
          const m = (meta || {})[t.id] || {};
          const text = plainCmdOf(t.cmd, m.role, m.skills);
          return React.createElement('div', { key: t.id || i, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: 11, fontWeight: 600, fontFamily: T.mono, color: T.text } }, String(t.id)),
            React.createElement('span', { style: { fontSize: 10.5, fontWeight: 600, color: t.dispatchable ? T.success : T.warn } },
              tt(t.dispatchable ? 'pool.dispatchable' : 'pool.blocked')),
            text ? React.createElement('span', { style: { flex: 1, fontSize: 10.5, color: T.text2, fontFamily: T.mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, text) : React.createElement('span', { style: { flex: 1 } }),
            (t.blockers || []).length
              ? React.createElement('span', { style: { fontSize: 10.5, color: T.warn, fontFamily: T.mono } }, t.blockers.join(' · '))
              : null
          );
        })
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
            React.createElement(Chip, { st: st }, protocolLabelOf('phase', d.phase) + (d.viewSettled ? ' ✓' : '')),
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
            React.createElement('span', { style: { fontSize: 10.5, color: T.text2, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, done + '/' + lanes.length)
          ),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 10.5, color: T.text2, flexWrap: 'wrap' } },
            React.createElement('span', null, tt('lanes') + ' ' + lanes.length),
            React.createElement('span', null, tt('events') + ' ' + (d.eventCount != null ? d.eventCount : evs.length)),
            React.createElement('span', null, tt('concurrency') + ' ' + d.concurrency),
            // 【B-1 消费点】计划版本：>1 即「本批计划被追加/加边改过」，读数由服务端帧提供（此前帧内无该键）
            d.planRevision != null
              ? React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, fmtCount(tt('plan.revision'), d.planRevision))
              : null
          )
        ),
        React.createElement(AssemblyBar, { d: d }),
        React.createElement(PoolView, { pool: d.pool, meta: meta }),
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
