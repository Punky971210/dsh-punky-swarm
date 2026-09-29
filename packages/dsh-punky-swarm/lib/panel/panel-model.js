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

// ===== [panel-segment] panel-model.js =====
    // ================= 面板纯逻辑层（零 React / 零 tt / 零 T）=================
    // 存在理由：面板段经 window.__ModuleLoader__ 拼接执行、无运行时 harness ⇒ 把「引力条 0 值收起 /
    //   三层分区 / 契约行逐字一致 / 门禁徽章零噪音 / 人话事件映射」这些**可测语义**下沉到本段：
    //   段内只有纯函数（入参 → 数据或 locale key），测试用 marker 抽取 + new Function 独立求值。
    // 纪律（冻结节拍 §约束 6）：本段**不得**引用 React 组件、tt 翻译函数与 T 设计令牌（三者均属渲染段）
    //   —— 需要文案的调用方拿 key 自行翻译。
    // 本段置 SEGMENT_ORDER 首位（零跨段依赖 ⇒ 规避 const 初始化序风险）。
    const LAYER_ORDER = ['plan', 'exec', 'audit', 'unlayered'];
    const LANE_TERMINAL = ['merged', 'failed', 'skipped', 'conflict'];
    const EVENT_CATEGORIES = ['all', 'gate', 'member', 'phase', 'chain', 'handoff', 'mail'];

    // wavePlan（waves[] 形态）→ lane 元数据表；只读 tasks 字段，逐键原样（不做二次判定）
    function laneMetaOf(wavePlan) {
      const out = {};
      const waves = Array.isArray(wavePlan) ? wavePlan : [];
      for (const w of waves) {
        for (const t of (w && w.tasks) || []) {
          if (!t || typeof t.id !== 'string' || !t.id) continue;
          out[t.id] = {
            cmd: t.cmd || '',
            layer: t.layer || null,
            role: t.role || null,
            skills: Array.isArray(t.skills) ? t.skills : [],
            consume: Array.isArray(t.consume) ? t.consume : [],
            produce: Array.isArray(t.produce) ? t.produce : [],
            outputs: Array.isArray(t.outputs) ? t.outputs : [],
            deps: Array.isArray(t.deps) ? t.deps : [],
            condition: t.condition === undefined ? null : t.condition,
            targets: Array.isArray(t.targets) ? t.targets : []
          };
        }
      }
      return out;
    }

    // 三层泳道分组：层序恒 ['plan','exec','audit','unlayered']；未声明 layer 的 lane 落 unlayered（不吞不混层）；
    // 空层不产出组（零噪音）。
    function lanesByLayerOf(lanes, meta) {
      const groups = {};
      for (const layer of LAYER_ORDER) groups[layer] = [];
      for (const lane of Object.keys(lanes || {})) {
        const m = (meta || {})[lane] || null;
        const declared = m && m.layer;
        const layer = declared && LAYER_ORDER.indexOf(declared) >= 0 ? declared : 'unlayered';
        groups[layer].push({ lane: lane, state: lanes[lane], meta: m });
      }
      const out = [];
      for (const layer of LAYER_ORDER) {
        if (groups[layer].length) out.push({ layer: layer, lanes: groups[layer] });
      }
      return out;
    }

    // 契约行：consume / produce∪outputs 逐元素原样（与 wavePlan.tasks 全等，供验收 4 逐字比对）
    function contractLineOf(meta) {
      const m = meta || {};
      return {
        consume: Array.isArray(m.consume) ? m.consume : [],
        produce: Array.isArray(m.produce) ? m.produce : [],
        outputs: Array.isArray(m.outputs) ? m.outputs : []
      };
    }

    // 门禁徽章（有缺口才出，无缺口零噪音）：去重；!gate.layer ⇒ 早退（保留既有语义）
    function gateBadgesOf(gate) {
      if (!gate || !gate.layer) return [];
      const items = [];
      const seen = {};
      const add = (kind, p) => { if (!seen[p]) { seen[p] = 1; items.push({ kind: kind, path: p }); } };
      for (const p of gate.consumeMissing || []) add('consume', p);
      for (const p of gate.outputsMissing || []) add('outputs', p);
      for (const p of gate.produceMissing || []) add('produce', p);
      for (const p of gate.contractProblems || []) {
        const m = String(p).match(/^(.+?)\s+missing$/i);
        add('contract', m ? m[1] : String(p));
      }
      return items;
    }

    // 交接徽章三态：done = 入边全 submitted；pending = 有 pending 且本 lane 已开工；
    //   blocked = 有 pending 且本 lane 仍 pending（entry 门会拒 ⇒ 「待 X 交接解锁」）；无信息 ⇒ null（零噪音）
    function handoffBadgeOf(lane, handoffs, meta, state) {
      const mine = Array.isArray((handoffs || {})[lane]) ? handoffs[lane] : [];
      if (mine.length) {
        const pend = mine.filter((e) => e && e.status !== 'submitted');
        if (!pend.length) return { key: 'done' };
        const from = pend[0] && pend[0].from ? pend[0].from : null;
        return state === 'pending' ? { key: 'blocked', from: from } : { key: 'pending', from: from };
      }
      const deps = (meta && meta.deps) || [];
      if (deps.length) return { key: 'blocked', from: deps[0] };
      return null;
    }

    // 事件 type → 人话 key / 类别 / 高亮级；未知 type ⇒ key:null（渲染层回退原始 type，禁伪人话）。
    // 规则表按序首命中；`raw` 恒为原始 type（「原始 type」开关与工程师排查用）。
    const EVENT_VIEW_RULES = [
      { re: /^member\.settled$/, key: 'event.member.settled', category: 'member', severity: 'info' },
      { re: /^member\.dispatch$/, key: 'event.member.dispatched', category: 'member', severity: 'info' },
      { re: /^lane\.skipped$/, key: 'event.member.skipped', category: 'member', severity: 'warn' },
      { re: /^lane\.needhuman$/, key: 'event.member.needhuman', category: 'member', severity: 'warn' },
      { re: /^lane\.recycled$/, key: 'event.member.recycled', category: 'member', severity: 'warn' },
      { re: /^lane\.stalled$/, key: 'event.member.stalled', category: 'member', severity: 'warn' },
      { re: /^lane\.longrun\./, key: 'event.member.longrun', category: 'member', severity: 'warn' },
      { re: /^lane\.exempt\./, key: 'event.member.exempt', category: 'member', severity: 'none' },
      { re: /^lane\.over-budget$/, key: 'event.member.overbudget', category: 'member', severity: 'warn' },
      { re: /^budget\./, key: 'event.member.overbudget', category: 'member', severity: 'warn' },
      { re: /^lane\.binding_gap$/, key: 'event.member.binding', category: 'member', severity: 'warn' },
      { re: /^human\.decision$/, key: 'event.member.decision', category: 'member', severity: 'info' },
      { re: /^asset\.claimed$/, key: 'event.member.claimed', category: 'member', severity: 'none' },
      { re: /^lane\.handoff\.gap$/, key: 'event.handoff.gap', category: 'handoff', severity: 'error' },
      { re: /^lane\.handoff$/, key: 'event.handoff.submitted', category: 'handoff', severity: 'info' },
      { re: /^handoff/, key: 'event.handoff.submitted', category: 'handoff', severity: 'info' },
      { re: /^worktree\./, key: 'event.member.worktree', category: 'member', severity: 'info' },
      { re: /^gate\.needhuman_blocked$/, key: 'event.gate.needhuman', category: 'gate', severity: 'warn' },
      { re: /^gate\.escape$/, key: 'event.gate.escape', category: 'gate', severity: 'warn' },
      { re: /^gate\.degrade$/, key: 'event.gate.degrade', category: 'gate', severity: 'warn' },
      { re: /^gate\.manager_/, key: 'event.gate.manager', category: 'gate', severity: 'warn' },
      { re: /^gate\.role_/, key: 'event.gate.role', category: 'gate', severity: 'error' },
      { re: /^gate\.target/, key: 'event.gate.target', category: 'gate', severity: 'warn' },
      { re: /^gate\.(passed|exit)$/, key: 'event.gate.passed', category: 'gate', severity: 'info' },
      { re: /^gate\./, key: 'event.gate.blocked', category: 'gate', severity: 'error' },
      { re: /^governance\./, key: 'event.governance', category: 'gate', severity: 'warn' },
      { re: /^auto\.settle\./, key: 'event.chain.settle', category: 'chain', severity: 'info' },
      { re: /^batch\.created$/, key: 'event.phase.created', category: 'phase', severity: 'none' },
      { re: /^batch\.phase$/, key: 'event.phase.changed', category: 'phase', severity: 'info' },
      { re: /^batch\.manager\.raised$/, key: 'event.phase.manager', category: 'phase', severity: 'info' },
      // 【2026-09-28 · 批 `cleanup-tail-20260927` E-4｜2026-09-29 批 `cleanup-settle-20260929` G-1 改写】原
      //   **已退役事件**（码值入退役锁）的 phase 分类器**已删**：该事件常量零发射点且已随批删净 ⇒ 分类器
      //   为**死分类器**；其配套 locale 键（`lib/panel/locales.js` zh/en 各一条）同批删除。
      //   ⚠ 本注释**禁**再写该码值的**正则源码形态**（分隔符前带反斜杠）—— 那是逐字匹配的盲区（转义变体
      //   漏网，本会话已复发 2 次）；归一化守卫见 `test/hygiene-comment-literals.test.js`（判据 G-1）。
      { re: /^batch\.smoke$/, key: 'event.phase.smoke', category: 'phase', severity: 'none' },
      { re: /^batch\.abort_dangling$/, key: 'event.phase.dangling', category: 'phase', severity: 'warn' },
      { re: /^batch\.(failed-escalate|governance-escalate)$/, key: 'event.phase.escalate', category: 'phase', severity: 'error' },
      { re: /^batch\./, key: 'event.phase.changed', category: 'phase', severity: 'info' },
      { re: /^swarm\.report$/, key: 'event.mail.report', category: 'mail', severity: 'info' },
      { re: /^swarm\.cc$/, key: 'event.mail.cc', category: 'mail', severity: 'none' },
      { re: /^(archive|system)\./, key: 'event.system', category: 'phase', severity: 'info' }
    ];

    function eventViewOf(e) {
      const raw = String((e && e.type) || '');
      const args = {
        lane: (e && e.lane) || null,
        from: (e && e.from) || null,
        to: (e && e.to) || null,
        path: (e && e.path) || null
      };
      for (const r of EVENT_VIEW_RULES) {
        if (r.re.test(raw)) {
          return { key: r.key, category: r.category, severity: r.severity, raw: raw, args: args };
        }
      }
      return { key: null, category: 'other', severity: 'none', raw: raw, args: args };
    }

    // 协议值原样 + 中文括注的**文案 key**（协议字段不译；文案落 locales 段，本段保持零 tt）：
    //   merged/failed/conflict/skipped/「review>running」（返工） ⇒ verdict.* ；其余 ⇒ 空串（无括注）
    function verdictNoteOf(raw) {
      const v = String(raw || '');
      if (v === 'merged') return 'verdict.merged';
      if (v === 'failed') return 'verdict.failed';
      if (v === 'conflict') return 'verdict.conflict';
      if (v === 'skipped') return 'verdict.skipped';
      if (v === 'review>running') return 'verdict.running';
      return '';
    }

    // 事件过滤：类别（all = 不过滤）+ lane 过滤 → 逆序（保持既有「最新在前」语义）
    function eventFilterOf(evs, opt) {
      const o = opt || {};
      const list = Array.isArray(evs) ? evs : [];
      const out = [];
      for (const e of list) {
        if (o.lane && e && e.lane !== o.lane) continue;
        if (o.category && o.category !== 'all') {
          const v = eventViewOf(e);
          if (v.category !== o.category) continue;
        }
        out.push(e);
      }
      return out.slice().reverse();
    }

    // 待裁决 lane（面板口径，明示按 recentEvents 推导）：末条相关事件为 needhuman 且其后无 human.decision
    function needHumanLanesOf(evs, lanes) {
      const pending = {};
      for (const e of evs || []) {
        if (!e || !e.lane) continue;
        const t = String(e.type || '');
        if (t === 'lane.needhuman' || t === 'gate.needhuman_blocked') pending[e.lane] = true;
        else if (t === 'human.decision') pending[e.lane] = false;
      }
      return Object.keys(lanes || {}).filter((lane) => pending[lane] === true);
    }

    function gateGapCountOf(lanesGate) {
      const seen = {};
      let n = 0;
      for (const lane of Object.keys(lanesGate || {})) {
        const g = (lanesGate || {})[lane] || {};
        for (const kind of ['consumeMissing', 'outputsMissing', 'produceMissing']) {
          for (const p of g[kind] || []) { if (!seen[p]) { seen[p] = 1; n += 1; } }
        }
        for (const p of g.contractProblems || []) {
          const m = String(p).match(/^(.+?)\s+missing$/i);
          const key = m ? m[1] : String(p);
          if (!seen[key]) { seen[key] = 1; n += 1; }
        }
      }
      return n;
    }

    // 引力条：只返回 n > 0 的块（0 值收起 = 本函数契约）；块序固定
    function focusBlocksOf(d, mail, evs) {
      const out = [];
      const lanes = (d && d.lanes) || {};
      const need = needHumanLanesOf(evs, lanes).length;
      if (need > 0) out.push({ key: 'decision', n: need });
      let idle = 0;
      for (const lane of Object.keys(lanes)) { if (lanes[lane] === 'idle') idle += 1; }
      if (idle > 0) out.push({ key: 'stuck', n: idle });
      const gaps = gateGapCountOf((d && d.lanesGate) || {});
      if (gaps > 0) out.push({ key: 'gate', n: gaps });
      if (d && d.phase === 'running') out.push({ key: 'running', n: 1 });
      const m = mail || {};
      const mn = ((m.inbox || []).length) + ((m.broadcast || []).length);
      if (mn > 0) out.push({ key: 'mail', n: mn });
      return out;
    }

    function issueLanesOf(b) {
      let n = 0;
      for (const s of Object.values((b && b.lanes) || {})) { if (s === 'failed' || s === 'conflict') n += 1; }
      return n;
    }

    function actionRankOf(b) {
      if (issueLanesOf(b) > 0) return 0;
      if (b && b.phase === 'paused') return 1;
      if (b && b.phase === 'running') return 2;
      return 3;
    }

    // 主行动卡：优先级 = 异常 lane > paused > running > 其余；sel 命中即以 sel 为准。
    // 只返回对象身份 + 文案 key/args + 序（渲染层负责文案与视觉）。
    function actionCardOf(list, sel, detail, mail, evs) {
      const items = Array.isArray(list) ? list : [];
      let pick = null;
      if (sel && sel.batchId) {
        pick = items.filter((b) => b.batchId === sel.batchId && (!sel.session || b.session === sel.session))[0] || null;
        if (!pick) {
          pick = { batchId: sel.batchId, session: sel.session || null, phase: (detail && detail.phase) || null, lanes: (detail && detail.lanes) || {} };
        }
      } else {
        let bestRank = 99;
        for (const b of items) {
          const r = actionRankOf(b);
          if (r < bestRank) { bestRank = r; pick = b; }
        }
      }
      if (!pick) return null;
      const scope = (detail && pick.batchId && detail.batchId === pick.batchId) ? detail : pick;
      const order = actionRankOf(scope);
      const args = {};
      let reasonKey = 'action.why.idle';
      if (order === 0) {
        reasonKey = 'action.why.issue';
        args.n = issueLanesOf(scope);
      } else if (order === 1) {
        reasonKey = 'action.why.paused';
      } else if (order === 2) {
        reasonKey = 'action.why.running';
        args.n = Object.values(scope.lanes || {}).filter((s) => s === 'running').length;
      } else {
        const vals = Object.values(scope.lanes || {});
        reasonKey = vals.length && vals.every((s) => LANE_TERMINAL.indexOf(s) >= 0) ? 'action.why.done' : 'action.why.idle';
      }
      const dangling = Array.isArray(scope.danglingLanes) ? scope.danglingLanes.length : 0;
      if (dangling > 0) args.dangling = dangling;
      return {
        batchId: pick.batchId,
        session: pick.session || null,
        reasonKey: reasonKey,
        reasonArgs: args,
        order: order
      };
    }

    // 文案模板插值（单点，禁在段内调 tt —— 调用方传已翻译模板）：k 可含 {n}
    function fmtCount(k, n) {
      return String(k).replace('{n}', String(n));
    }
