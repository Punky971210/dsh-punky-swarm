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

window.__ModuleLoader__.load({
  id: "dsh-punky-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    "use strict";
    // dsh-punky-swarm 蟛蜞集群监控面板客户端（只读）：注册 conversation.view 第三分页（对话/轨迹/蟛蜞集群）
    const React = require('react');
    const { useState, useEffect } = React;

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
// ===== [panel-segment] locales.js =====
    const zh = {
      "view.cluster": "蟛蜞集群",
      "live": "实时",
      "refresh.auto": "3s 自动刷新",
      "stream.live": "实时推送",
      "stream.fallback": "实时通道中断，已切 3 秒轮询",
      "updated": "更新于",
      "stat.total": "总批次",
      "stat.running": "运行中",
      "stat.done": "已完结",
      "stat.issues": "异常",
      "batch.title": "批次列表",
      "batch.progress": "进度",
      "batch.release": "可自动收口",
      "batch.done": "已完结",
      "lanes": "子任务",
      "events": "事件",
      "concurrency": "并发声明（未启用限流）",
      "event.timeline": "事件时间线",
      "mailbox.title": "收件箱（只读）",
      "mailbox.inbox": "派发消息",
      "mailbox.broadcast": "广播消息",
      "mailbox.unread": "未读 {n}",
      "mailbox.hint": "暂无未读",
      "mailbox.meta": "元数据（不贴正文）",
      "mailbox.from": "来自",
      "empty": "暂无批次",
      "empty.hint": "1 建批 → 2 派发 → 3 结算；建一个 wave_plan 批次后这里会自动出现",
      "empty.step1": "1 建批",
      "empty.step2": "2 派发",
      "empty.step3": "3 结算",
      "load.error": "加载失败",
      "load.retry": "重试",
      "stale.data": "数据可能过期",
      "gate.missing": "缺",
      "gate.fix.hint": "补上即可结算",
      "gate.needhuman": "等你裁决：验收产物声明需人工确认",
      "attempt": "已返工 {n} 次",
      "upgrade": "待人工裁决",
      "task.deps": "依赖",
      "task.layer": "层",
      "gate.consume": "消费缺失",
      "gate.outputs": "产物缺失",
      "gate.produce": "产出缺失",
      "gate.contract": "契约问题",
      // ===== 三层泳道 / 交接 / 装配与门禁 / 引力条 / 主行动卡（面板重构新增）=====
      "chip.state": "状态：{n}",
      "layer.plan": "计划层",
      "layer.exec": "执行层",
      "layer.audit": "验收层",
      "layer.unlayered": "未分层",
      "layer.parallel": "并行 {n} 条",
      "contract.line": "吃 {a} → 吐 {b}",
      "contract.none": "无契约声明",
      "role.skills": "角色 {role} · 技能 {skills}",
      "lane.lastActive": "最近活动 {t}",
      "lane.recentHint": "最近活动按近 20 条事件推导",
      "handoff.done": "已交接",
      "handoff.pending": "待交接",
      "handoff.blocked": "待 {from} 交接解锁",
      "handoff.unlock": "上游交接解锁后可派发",
      "assembly.title": "装配与门禁",
      "assembly.team": "团队",
      "assembly.orchestration": "编排",
      "assembly.auditLane": "验收 lane",
      "assembly.manager": "Manager 登记",
      "assembly.managerNone": "未登记",
      "assembly.managerHint": "在册校验属工具面",
      "assembly.gates": "门禁",
      "assembly.smoke": "冒烟批",
      "focus.title": "当前关注",
      "focus.pick": "点选即筛选左栏",
      "focus.decision": "待裁决",
      "focus.stuck": "待恢复",
      "focus.gate": "门禁缺口",
      "focus.running": "运行",
      "focus.mail": "邮箱",
      "action.title": "主行动",
      "action.why": "为什么最重要",
      "action.next": "你能做什么",
      "action.goto": "去处理",
      "action.why.issue": "有 {n} 条子任务异常，需先处理",
      "action.why.paused": "批次已停轮，等你恢复",
      "action.why.running": "{n} 条子任务运行中",
      "action.why.done": "全部子任务已结算，可收口",
      "action.why.idle": "暂无异常，等待新事件",
      "event.filter.all": "全部",
      "event.filter.gate": "门禁",
      "event.filter.member": "成员",
      "event.filter.phase": "相位",
      "event.filter.chain": "链",
      "event.filter.handoff": "交接",
      "event.filter.mail": "邮箱",
      "event.raw.on": "原始 type",
      "event.raw.off": "人话摘要",
      "event.tail": "近 {n} 条 / 共 {m} 条",
      "event.laneFilter": "按子任务过滤",
      "event.laneAll": "全部子任务",
      "dangling.badge": "悬挂 {n}",
      "list.filter.all": "全部",
      "list.filter.issue": "异常",
      "list.filter.running": "运行中",
      "list.filter.done": "已完结",
      "list.search": "搜索批次",
      "list.settleable": "待收口",
      "list.issueBadge": "异常 {n}",
      "view.range.own": "本会话",
      "view.range.all": "全部会话",
      "view.copy": "复制链接",
      "view.copied": "已复制",
      "event.member.settled": "结算",
      "event.member.dispatched": "已派发（等待回执）",
      "event.member.skipped": "已跳过",
      "event.member.needhuman": "等你裁决",
      "event.member.recycled": "已回收",
      "event.member.stalled": "已标记停滞",
      "event.member.longrun": "长跑候选",
      "event.member.exempt": "豁免变更",
      "event.member.overbudget": "超预算",
      "event.member.binding": "成员绑定缺口",
      "event.member.decision": "人工裁决",
      "event.member.claimed": "产物归位",
      "event.member.worktree": "工作树流转",
      "event.handoff.submitted": "已交接",
      "event.handoff.gap": "交接缺口",
      "event.gate.blocked": "门禁拦截",
      "event.gate.passed": "门禁通过",
      "event.gate.needhuman": "等你裁决",
      "event.gate.escape": "门禁逃逸",
      "event.gate.degrade": "门禁降级",
      "event.gate.manager": "编排缺口",
      "event.gate.role": "角色不合规",
      "event.gate.target": "目标校验",
      "event.governance": "护栏拒绝",
      "event.chain.settle": "自动结算",
      "event.phase.created": "建批",
      "event.phase.changed": "相位变更",
      "event.phase.manager": "Manager 已拉起",
      "event.phase.smoke": "冒烟批",
      "event.phase.dangling": "悬挂成员告警",
      "event.phase.escalate": "违规升级",
      "event.mail.report": "成员回报",
      "event.mail.cc": "副本抄送",
      "event.system": "系统事件",
      "verdict.merged": "（通过）",
      "verdict.failed": "（未通过）",
      "verdict.conflict": "（冲突）",
      "verdict.skipped": "（跳过）",
      "verdict.running": "（返工）",
      // ===== 治理配置页（settings.section: governance-config）=====
      "nav.governance": "蟛蜞治理配置",
      "gov.title.live": "蟛蜞治理配置 · {n} 条规则生效",
      "gov.live": "已生效",
      "gov.hook.title": "护栏开关",
      "gov.hook.desc": "开启后拦截越界调用；出厂空规则表零拦截",
      "gov.preset.title": "规则预设",
      "gov.preset.hint": "全部规则集平级多选、可任意叠加装载；全不选 = 出厂空表（零拦截）",
      "gov.preset.none": "出厂空表（零拦截）",
      "gov.preset.rules": "{n} 条规则",
      "gov.preset.total": "已选 {n} 项 · 合计 {m} 条",
      "gov.preset.l1": "敏感数据防护（凭据/私钥）",
      "gov.preset.l2": "资源上限（超时/并发）",
      "gov.preset.l3": "工具黑名单（pwsh 写文件）",
      "gov.preset.l5": "等待能力禁用（wait_agent / sleep）",
      "gov.preset.custom": "检测到非受控 preset 引用，保存将沿用原文",
      "gov.preset.manual": "检测到 {n} 条手工规则，预设切换需先手工移除",
      "gov.esc.title": "违规自动升级",
      "gov.esc.desc": "开启后：同一批任务在设定时间窗口内被护栏拒绝（计入「计入原语」的处置）达到阈值次数时，自动将该批次暂停并留痕，等待你检查后手动恢复运行。",
      "gov.esc.threshold": "窗口内触发次数",
      "gov.esc.window": "窗口（秒）",
      "gov.esc.primitives": "计入原语",
      "gov.narrow.title": "窄化放行",
      "gov.narrow.desc": "开启后超限调用按收窄指引重试放行，替代直接拒绝",
      "gov.save": "保存",
      "gov.reset": "重置",
      "gov.saving": "保存中…",
      "gov.saved": "已保存，生效确认中",
      "gov.dirty": "有未保存改动",
      "gov.loading": "加载中…",
      "gov.error.net": "请求失败",
      "gov.err.prefix": "保存被拒",
      "gov.err.unknownPreset": "未知规则预设",
      "gov.err.fieldNotAllowed": "字段不在受控范围",
      "gov.err.invalidValue": "字段取值非法",
      "gov.err.topLevel": "未知顶层键",
      "gov.err.conflict": "与手工规则冲突",
      // watch 能力开关（卡片 E：父开关 Lane 过期检测 + longrun 子开关 + 长跑两阈值分钟字段；出厂默认开，显式 false 才关）
      "gov.watch.title": "Lane 过期检测",
      "gov.watch.desc": "开启后扫描运行中的子任务，连续无活动按档位追问并标记 stalled；关闭后停止扫描",
      "gov.watch.longrun.title": "长跑超时重派探针",
      "gov.watch.longrun.desc": "运行超时长阈值且窗口内无 checkpoint/活动的 lane 将产出重派候选，由 Manager/Leader 半自动裁决重派",
      "gov.watch.longrun.maxDuration": "超时窗口（分钟）",
      "gov.watch.longrun.noProgress": "无进展窗口（分钟）"
    };
    const en = {
      "view.cluster": "Punky swarm",
      "live": "Live",
      "refresh.auto": "3s auto refresh",
      "stream.live": "Live push",
      "stream.fallback": "live channel dropped, polling every 3s",
      "updated": "updated",
      "stat.total": "Batches",
      "stat.running": "Running",
      "stat.done": "Done",
      "stat.issues": "Issues",
      "batch.title": "Batches",
      "batch.progress": "progress",
      "batch.release": "auto-closable",
      "batch.done": "done",
      "lanes": "lanes",
      "events": "events",
      "concurrency": "concurrency (no limit enforced)",
      "event.timeline": "Event timeline",
      "mailbox.title": "Inbox (read-only)",
      "mailbox.inbox": "dispatch messages",
      "mailbox.broadcast": "broadcast messages",
      "mailbox.unread": "{n} unread",
      "mailbox.hint": "nothing unread",
      "mailbox.meta": "metadata (no body)",
      "mailbox.from": "from",
      "empty": "No batches",
      "empty.hint": "1 plan → 2 dispatch → 3 settle; create a wave_plan batch and it appears here",
      "empty.step1": "1 plan",
      "empty.step2": "2 dispatch",
      "empty.step3": "3 settle",
      "load.error": "Load failed",
      "load.retry": "Retry",
      "stale.data": "data may be stale",
      "gate.missing": "missing",
      "gate.fix.hint": "add it to settle",
      "gate.needhuman": "needs your decision: audit artifact declaration requires human confirmation",
      "attempt": "reworked {n}×",
      "upgrade": "needs human decision",
      "task.deps": "deps",
      "task.layer": "layer",
      "gate.consume": "consume missing",
      "gate.outputs": "outputs missing",
      "gate.produce": "produce missing",
      "gate.contract": "contract problem",
      // ===== three-layer lanes / handoff / assembly bar / focus strip / action card =====
      "chip.state": "state: {n}",
      "layer.plan": "plan",
      "layer.exec": "exec",
      "layer.audit": "audit",
      "layer.unlayered": "unlayered",
      "layer.parallel": "{n} in parallel",
      "contract.line": "eats {a} → yields {b}",
      "contract.none": "no contract declared",
      "role.skills": "role {role} · skills {skills}",
      "lane.lastActive": "last active {t}",
      "lane.recentHint": "last activity derived from the recent 20 events",
      "handoff.done": "handed off",
      "handoff.pending": "handoff pending",
      "handoff.blocked": "waiting for {from} to hand off",
      "handoff.unlock": "dispatchable once the upstream handoff lands",
      "assembly.title": "Assembly & gates",
      "assembly.team": "team",
      "assembly.orchestration": "orchestration",
      "assembly.auditLane": "audit lane",
      "assembly.manager": "Manager registered",
      "assembly.managerNone": "not registered",
      "assembly.managerHint": "roster check belongs to the tool surface",
      "assembly.gates": "gates",
      "assembly.smoke": "smoke batch",
      "focus.title": "In focus",
      "focus.pick": "click to filter the left list",
      "focus.decision": "need decision",
      "focus.stuck": "idle",
      "focus.gate": "gate gaps",
      "focus.running": "running",
      "focus.mail": "mailbox",
      "action.title": "Main action",
      "action.why": "why it matters",
      "action.next": "what you can do",
      "action.goto": "handle it",
      "action.why.issue": "{n} lanes failed — handle those first",
      "action.why.paused": "batch paused, waiting for you to resume",
      "action.why.running": "{n} lanes running",
      "action.why.done": "all lanes settled, ready to close",
      "action.why.idle": "no issue, waiting for new events",
      "event.filter.all": "all",
      "event.filter.gate": "gates",
      "event.filter.member": "members",
      "event.filter.phase": "phase",
      "event.filter.chain": "chain",
      "event.filter.handoff": "handoff",
      "event.filter.mail": "mailbox",
      "event.raw.on": "raw type",
      "event.raw.off": "plain words",
      "event.tail": "last {n} of {m}",
      "event.laneFilter": "filter by lane",
      "event.laneAll": "all lanes",
      "dangling.badge": "dangling {n}",
      "list.filter.all": "all",
      "list.filter.issue": "issues",
      "list.filter.running": "running",
      "list.filter.done": "done",
      "list.search": "search batches",
      "list.settleable": "ready to close",
      "list.issueBadge": "{n} issues",
      "view.range.own": "this session",
      "view.range.all": "all sessions",
      "view.copy": "Copy link",
      "view.copied": "Copied",
      "event.member.settled": "settled",
      "event.member.dispatched": "dispatched (awaiting report)",
      "event.member.skipped": "skipped",
      "event.member.needhuman": "needs your decision",
      "event.member.recycled": "recycled",
      "event.member.stalled": "marked stalled",
      "event.member.longrun": "long-run candidate",
      "event.member.exempt": "exemption changed",
      "event.member.overbudget": "over budget",
      "event.member.binding": "member binding gap",
      "event.member.decision": "human decision",
      "event.member.claimed": "artifact claimed",
      "event.member.worktree": "worktree",
      "event.handoff.submitted": "handoff submitted",
      "event.handoff.gap": "handoff gap",
      "event.gate.blocked": "gate blocked",
      "event.gate.passed": "gate passed",
      "event.gate.needhuman": "needs your decision",
      "event.gate.escape": "gate escape",
      "event.gate.degrade": "gate degraded",
      "event.gate.manager": "orchestration gap",
      "event.gate.role": "role invalid",
      "event.gate.target": "target check",
      "event.governance": "guardrail refusal",
      "event.chain.settle": "auto settle",
      "event.phase.created": "batch created",
      "event.phase.changed": "phase changed",
      "event.phase.manager": "manager raised",
      "event.phase.smoke": "smoke batch",
      "event.phase.dangling": "dangling lanes warning",
      "event.phase.escalate": "escalation",
      "event.mail.report": "member report",
      "event.mail.cc": "cc",
      "event.system": "system event",
      "verdict.merged": "(passed)",
      "verdict.failed": "(rejected)",
      "verdict.conflict": "(conflict)",
      "verdict.skipped": "(skipped)",
      "verdict.running": "(rework)",
      // ===== Governance config page (settings.section: governance-config) =====
      "nav.governance": "Punky Governance Config",
      "gov.title.live": "Punky Governance Config · {n} rules live",
      "gov.live": "Live",
      "gov.hook.title": "Guardrail switch",
      "gov.hook.desc": "Blocks out-of-scope calls when on; the factory empty rule table intercepts nothing",
      "gov.preset.title": "Rule preset",
      "gov.preset.hint": "All rule sets are peer multi-select options and stack freely; none selected = factory-empty (no interception)",
      "gov.preset.none": "Factory default (no rules)",
      "gov.preset.rules": "{n} rules",
      "gov.preset.total": "{n} selected · {m} rules total",
      "gov.preset.l1": "Sensitive-data guard (credentials/keys)",
      "gov.preset.l2": "Resource limits (timeout/concurrency)",
      "gov.preset.l3": "Tool blacklist (pwsh file writes)",
      "gov.preset.l5": "Wait capability ban (wait_agent / sleep)",
      "gov.preset.custom": "Non-listed preset reference detected; saving keeps it verbatim",
      "gov.preset.manual": "{n} custom rules present; switch the preset only after removing them manually",
      "gov.esc.title": "Auto-escalation",
      "gov.esc.desc": "When on, once guardrail refusals for the same batch reach the threshold within the counting window, the batch is automatically paused with a record, waiting for you to review and resume it manually.",
      "gov.esc.threshold": "Refusals within window",
      "gov.esc.window": "Window (s)",
      "gov.esc.primitives": "Counted verdicts",
      "gov.narrow.title": "Narrowed allowance",
      "gov.narrow.desc": "Lets over-limit calls retry within clamped bounds instead of a direct refusal",
      "gov.save": "Save",
      "gov.reset": "Reset",
      "gov.saving": "Saving…",
      "gov.saved": "Saved, confirming…",
      "gov.dirty": "Unsaved changes",
      "gov.loading": "Loading…",
      "gov.error.net": "Request failed",
      "gov.err.prefix": "Save rejected",
      "gov.err.unknownPreset": "Unknown rule preset",
      "gov.err.fieldNotAllowed": "Field not in controlled scope",
      "gov.err.invalidValue": "Invalid field value",
      "gov.err.topLevel": "Unknown top-level key",
      "gov.err.conflict": "Conflicts with custom rules",
      // watch capability switches (card E: parent switch + longrun child switch + two long-run threshold minute fields; on by default, explicit false disables)
      "gov.watch.title": "Lane expiry watch",
      "gov.watch.desc": "Scans running lanes and probes lanes idle past backoff tiers until stalled; off stops scanning",
      "gov.watch.longrun.title": "Long-run timeout probe",
      "gov.watch.longrun.desc": "Emits a redispatch candidate for lanes past the duration threshold with no recent checkpoint/activity; Manager/Leader decide",
      "gov.watch.longrun.maxDuration": "Timeout window (min)",
      "gov.watch.longrun.noProgress": "No-progress window (min)"
    };

    // module-level translator: zh-first, en fallback (matches the original panel behavior)
    function tt(k) { return zh[k] || en[k] || k; }
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

    // 浏览器端 TERMINAL 副本：Node 端单点 = lib/state/constants.js；
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
    // 引力条（选中批次作用域）：块由 focusBlocksOf 产出（0 值已收起）；点选 → 设置左栏筛选
    function focusFilterOf(key) {
      if (key === 'gate' || key === 'decision') return 'issue';
      if (key === 'running') return 'running';
      return 'all';
    }

    function FocusStrip({ blocks, onPick }) {
      if (!blocks || !blocks.length) return null;
      const tone = (k) => (k === 'decision' ? pal().escFg : k === 'stuck' || k === 'gate' ? T.warn : k === 'running' ? T.info : T.text2);
      return React.createElement('div', {
        role: 'status',
        'aria-live': 'polite',
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
      },
        React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontWeight: 600 } }, tt('focus.title')),
        blocks.map((b) => React.createElement(FocusBlock, {
          key: b.key, label: tt('focus.' + b.key), n: b.n, tone: tone(b.key),
          onClick: () => onPick(b.key)
        })),
        React.createElement('span', { style: { fontSize: 10.5, color: T.text3 } }, tt('focus.pick'))
      );
    }

    // 主行动卡（整行，尖端诱导：关键数字 20px/700）；对象 = 列表范围最高优先批次（选中则以选中项为准）
    function ActionCard({ card, pending, onGo }) {
      if (!card) return null;
      const tone = card.order === 0 ? T.error : card.order === 1 ? T.info : card.order === 2 ? T.warn : T.success;
      const args = card.reasonArgs || {};
      const why = fmtCount(tt(card.reasonKey), args.n == null ? 0 : args.n)
        + (args.dangling ? ' · ' + fmtCount(tt('dangling.badge'), args.dangling) : '');
      return React.createElement('div', {
        className: 'psw-card',
        style: Object.assign({}, cardBase, { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderLeft: '3px solid ' + tone })
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontWeight: 600 } }, tt('action.title')),
          React.createElement('span', { style: { fontSize: 16, fontWeight: 700, fontFamily: T.mono, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, card.batchId),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('span', { style: { fontSize: 20, fontWeight: 700, fontFamily: T.mono, color: tone, fontVariantNumeric: 'tabular-nums' } }, pending),
          React.createElement('button', {
            type: 'button', className: 'psw-btn', onClick: () => onGo(card),
            style: { fontSize: 10.5, padding: '2px 10px', borderRadius: 999, cursor: 'pointer', border: '1px solid ' + T.accent, background: 'transparent', color: T.accent, fontFamily: 'inherit', fontWeight: 600 }
          }, tt('action.goto'))
        ),
        React.createElement('div', { style: { fontSize: 11, color: T.text2, lineHeight: 1.45 } },
          React.createElement('span', { style: { color: T.text3 } }, tt('action.why') + '：'), why),
        React.createElement('div', { style: { fontSize: 11, color: T.text3, lineHeight: 1.45 } },
          tt('action.next') + '：' + tt('focus.pick'))
      );
    }

    function ClusterWorkbench({ sessionId }) {
      const [batches, setBatches] = useState(null);
      const [sel, setSel] = useState(null);
      const [detail, setDetail] = useState(null);
      const [updated, setUpdated] = useState(null);
      const [mode, setMode] = useState('sse'); // 'sse' | 'poll'（SSE 降级回轮询状态）
      const [scope, setScope] = useState('own'); // 'own' 本会话 | 'all' 全部会话（跨会话聚合显式化）
      const [listFilter, setListFilter] = useState('all');
      const [loadErr, setLoadErr] = useState(null);
      const [staleAt, setStaleAt] = useState(null);
      const [copied, setCopied] = useState(false);
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

      // SSE 列表流：EventSource 主通道 + 3s 轮询降级兜底（保留既有轮询路径不删）。
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
            const agg = await aggregateBatches(scope === 'all' ? '' : sid);
            if (!alive) return;
            setBatches(agg); setUpdated(new Date()); setLoadErr(null);
            for (const b of agg) {
              if (typeof b.eventCount === 'number') seen.set(b.batchId, Math.max(seen.get(b.batchId) || 0, b.eventCount));
            }
          } catch (e) {
            // 拉取失败**不清屏**：保留上次成功数据 + 标注「数据可能过期」（禁静默降级）
            if (alive) { setLoadErr(String((e && e.message) || e)); setStaleAt(new Date()); }
          }
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
      }, [sid, scope]);

      // 深链读端：#cluster=<session>:<batchId>&view=... ⇒ 选中该批次（刷新后保持；仅读，不写引擎）
      useEffect(() => {
        try {
          const m = /(?:^|[#&])cluster=([^&]+)/.exec(String((typeof location !== 'undefined' && location.hash) || ''));
          if (!m || !m[1]) return;
          const raw = decodeURIComponent(m[1]);
          const i = raw.lastIndexOf(':');
          if (i > 0) setSel({ session: raw.slice(0, i), batchId: raw.slice(i + 1) });
        } catch {}
      }, []);

      // SSE 详情流：信号 → 回拉 /batch + 双 /mailbox（复用既有逻辑）；降级回轮询语义同列表流
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
            if (alive) { setDetail(Object.assign({}, d, { mail })); lastCount = d.eventCount; setLoadErr(null); }
          } catch (e) {
            if (alive) { setLoadErr(String((e && e.message) || e)); setStaleAt(new Date()); }
          }
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
      // 选中批次作用域：引力条 / 主行动卡 / 详情共用同一份数据（无选中 ⇒ 引力条不渲染，首屏焦点交主行动卡）
      const selDetail = detail && sel && detail.batchId === sel.batchId ? detail : null;
      const selMail = selDetail && selDetail.mail ? selDetail.mail : { inbox: [], broadcast: [] };
      const selEvs = selDetail ? (selDetail.recentEvents || []) : [];
      const focus = selDetail ? focusBlocksOf(selDetail, selMail, selEvs) : [];
      const card = actionCardOf(list, sel, selDetail, selMail, selEvs);
      const cardScope = card && selDetail && selDetail.batchId === card.batchId ? selDetail : (card ? list.filter((b) => b.batchId === card.batchId)[0] : null);
      const cardPending = cardScope ? Object.values(cardScope.lanes || {}).filter((s) => TERMINAL.indexOf(s) < 0).length : 0;
      const selectBatch = (b) => {
        const next = b && b.batchId ? { session: b.session || sid, batchId: b.batchId } : null;
        setSel(next);
        try {
          if (next && typeof location !== 'undefined') {
            location.hash = 'cluster=' + encodeURIComponent(next.session + ':' + next.batchId) + '&view=lanes';
          }
        } catch {}
      };
      const copyLink = () => {
        try {
          if (typeof location !== 'undefined' && navigator && navigator.clipboard) navigator.clipboard.writeText(location.href);
          setCopied(true);
        } catch {}
      };
      const rangeBtn = (key) => React.createElement('button', {
        key: key,
        type: 'button',
        className: 'psw-btn',
        'aria-pressed': scope === key,
        onClick: () => setScope(key),
        style: {
          fontSize: 10.5, padding: '1px 8px', borderRadius: 999, cursor: 'pointer',
          border: '1px solid ' + (scope === key ? T.accent : T.border),
          background: scope === key ? T.selBg : 'transparent',
          color: scope === key ? T.text : T.text3, fontFamily: 'inherit'
        }
      }, tt(key === 'own' ? 'view.range.own' : 'view.range.all'));

      return React.createElement('div', {
        'aria-busy': !batches,
        style: {
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10,
          padding: '14px 16px', color: T.text, fontFamily: T.font
        }
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, flexWrap: 'wrap' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('span', { style: { fontSize: 15, fontWeight: 700, letterSpacing: 0.2 } }, tt('view.cluster')),
            React.createElement('span', { className: 'psw-pulse', style: { width: 7, height: 7, borderRadius: 999, background: liveColor, boxShadow: '0 0 0 3px ' + halo } }),
            React.createElement('span', { style: { fontSize: 10.5, fontWeight: 600, letterSpacing: 0.8, color: liveColor } }, tt('live'))
          ),
          React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, rangeBtn('own'), rangeBtn('all')),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('button', {
            type: 'button', className: 'psw-btn', onClick: copyLink,
            style: { fontSize: 10.5, padding: '1px 8px', borderRadius: 999, cursor: 'pointer', border: '1px solid ' + T.border, background: 'transparent', color: T.text3, fontFamily: 'inherit' }
          }, copied ? tt('view.copied') : tt('view.copy')),
          React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono } }, tt(mode === 'poll' ? 'stream.fallback' : 'stream.live')),
          React.createElement('span', { style: { fontSize: 10.5, color: T.text3, fontFamily: T.mono, fontVariantNumeric: 'tabular-nums' } }, '· ' + tt('updated') + ' ' + updatedText)
        ),
        React.createElement('div', { role: 'status', 'aria-atomic': 'true', style: { display: 'flex', gap: 8 } },
          React.createElement(Stat, { label: tt('stat.total'), value: list.length }),
          React.createElement(Stat, { label: tt('stat.running'), value: running, color: T.warn }),
          React.createElement(Stat, { label: tt('stat.done'), value: doneCnt, color: T.success }),
          React.createElement(Stat, { label: tt('stat.issues'), value: issues, color: issues ? T.error : T.text3 })
        ),
        loadErr
          ? React.createElement('div', {
              role: 'status', 'aria-live': 'polite',
              style: Object.assign({}, cardBase, { padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, borderColor: T.error, flexWrap: 'wrap' })
            },
              React.createElement('span', { style: { fontSize: 11, color: T.error, fontWeight: 600 } }, tt('load.error') + ' · ' + loadErr),
              React.createElement('span', { style: { fontSize: 10.5, color: T.text3 } },
                (staleAt ? updatedText : '--:--:--') + ' · ' + tt('stale.data')),
              React.createElement('button', {
                type: 'button', className: 'psw-btn',
                onClick: () => { setLoadErr(null); setUpdated(null); },
                style: { fontSize: 10.5, padding: '1px 8px', borderRadius: 999, cursor: 'pointer', border: '1px solid ' + T.border, background: 'transparent', color: T.text2, fontFamily: 'inherit' }
              }, tt('load.retry'))
            )
          : null,
        React.createElement(FocusStrip, { blocks: focus, onPick: (key) => setListFilter(focusFilterOf(key)) }),
        React.createElement(ActionCard, { card: card, pending: cardPending, onGo: (c) => selectBatch({ batchId: c.batchId, session: c.session || sid }) }),
        React.createElement('div', { className: 'psw-panes' },
          React.createElement(BatchList, { batches: batches, selected: sel, onSelect: selectBatch, loading: true, filter: listFilter, onFilter: setListFilter }),
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
      // 治理配置页（settings.section；与 conversation.view 并存，两 seat 互不排他）。
      // order=16：出厂占用 0/10/15/20，16..19 空闲位取 16；
      // label thunk 随 locale 惰性重读；页面自带 GET/POST 取数，inject 省略（owner 仅收 { close }）。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'governance-config',
        order: 16,
        locale: NS,
        label: () => t('nav.governance')
      }, GovernanceConfigSection));
    }

    module.exports = { apply, inject };
    return module.exports;
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
    //   presets = [{ id, count }] 注册目录元数据（复选行/合计条目数摘要：l1=12 / l2=6 / l3=1）。
    // 写契约 = POST 同路径，body { governance: { hook: {...} }, capabilities: { watch: { enabled, longrun: { enabled, maxDurationMs, noProgressWindowMs } } } }
    //         （单保存合并双段：governance + watch 能力开关；400 → { ok:false, errors:[{ field, code, message }] }（页面按 code 双语映射））。
    // 窗口单位：GET overlay.escalation.windowMs 存 ms（毫秒契约不变）；
    //   表单以秒显示/输入（初值 = windowMs/1000），提交走 escalation.windowSeconds（秒语义字段），
    //   后端 runtime-config.js 换算 ×1000 归一为 windowMs 落盘——UI 提交层单位约定，引擎侧不改。
    // preset 语义（2026-09-14 改：全部规则集平级多选）：装载键 = string | string[]；
    //   勾选集 = ["l1-sensitive","l2-resource","l3-tool-ban"] 的任意子集——**组合由勾选叠加表达**，
    //   面板不存在也不接受 compose 这一「组合项」（`compose` 注册 id 已废除：引擎注册表只剩四项，
    //   旧配置若含它须经下方一次性回显迁移转成 l1+l2 才能保存）。
    //   三个规则集 id 互不重叠（L1/L2 走 rules 面、L3 走 toolBan 面），多选叠加不会被引擎唯一性校验拒；
    //   全不勾 = 省略 preset 键（后端删键回出厂零规则；空数组/空串会被后端 400 拒）。
    //   旧值一次性迁移（救生索，非注册项）：overlay.hook.preset === 'compose' → 回显为 l1+l2 两项勾选，
    //   用户保存即归一为合法数组；不做该迁移则旧值会落到 { custom } 分支、被后端 unknown-preset 拒。

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
    // 双占位符文案格式化（{n} = 已选规则集项数、{m} = 合计条目数）——「已选 N 项 · 合计 M 条」合计行用
    function fmtN2(k, n, m) { return tt(k).replace('{n}', String(n)).replace('{m}', String(m)); }
    function pickBool(a, b, d) { return typeof a === 'boolean' ? a : typeof b === 'boolean' ? b : d; }
    function pickNum(a, b, d) { return typeof a === 'number' && isFinite(a) ? a : typeof b === 'number' && isFinite(b) ? b : d; }
    function clockOf(d) { try { return d.toTimeString().slice(0, 8); } catch { return ''; } }
    // 可选装载复选集 = 全部注册规则集（四个平级多选项：L1 敏感 / L2 资源 / L3 工具黑名单 / L5 等待能力禁用）——
    //   组合 = 勾选叠加本身（如「规则预设」全勾 = ['l1-sensitive','l2-resource','l3-tool-ban','l5-wait-ban']），
    //   不再有 compose 这一「组合项」（该注册 id 已废除）；'compose' 仅在 formPresetOf 里作一次性旧值迁移。
    //   2026-09-26 扩面：新增 l5-wait-ban（wait_agent + sleep 禁用，用户裁决）。
    function presetOptionIds() { return ['l1-sensitive', 'l2-resource', 'l3-tool-ban', 'l5-wait-ban']; }
    function escPrimitives() { return ['DENY', 'NARROW', 'DEFER', 'PAUSE']; } // REQUIRE_APPROVAL 红线不可经表单（引擎契约），不出现
    function presetMeaningKey(id) {
      switch (id) {
        case 'l1-sensitive': return 'gov.preset.l1';
        case 'l2-resource': return 'gov.preset.l2';
        case 'l3-tool-ban': return 'gov.preset.l3';
        case 'l5-wait-ban': return 'gov.preset.l5';
        default: return null;
      }
    }
    // GET overlay.hook.preset 回显 → 表单勾选集（**仅数组形态**；单选遗产清除 2026-09-14）：
    //   空/省略 → null（全不勾）；数组且 id 全在可选集内 → 勾选集；
    //   单值字符串（旧单选遗留）/ 含未注册 id / 其它非法形态 → { custom: <原文> }——无勾选位可表，
    //   保存时原文透传，由后端形态校验拒绝并回显（面板给警示，用户按多选重新勾选即可）。
    function formPresetOf(pv) {
      if (pv === undefined || pv === null || pv === '') return null;
      if (!Array.isArray(pv)) return { custom: pv }; // 单值字符串等旧形态：不再自动迁移，交用户改勾选
      const opts = presetOptionIds();
      const sel = [];
      for (const id of pv) {
        if (opts.indexOf(id) >= 0) { if (sel.indexOf(id) < 0) sel.push(id); }
        else return { custom: pv }; // 含未注册 id → 整值原样保留（后端拒绝并回显）
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
    // 回显兼容映射见 formPresetOf：'compose'（已废除的旧组合项）→ l1+l2 两项勾选、string[] → 按项勾、空/省略 → null。
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
      const presetTotal = presetSel.reduce((s, id) => s + countOf(id), 0);        // 条目数合计：四项全勾 = 12 + 6 + 1 + 3 = 22（多选叠加）
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

        // 卡片 B 规则预设（多选：L1/L2/L3/L5 四个平级勾选项；组合 = 勾选叠加本身，无 compose 组合项语义）
        React.createElement(GovCard, { title: tt('gov.preset.title') },
          React.createElement('div', { style: { fontSize: G().sub, color: T.text3, lineHeight: 1.5 } }, tt('gov.preset.hint')),
          selOptions.map((id) => React.createElement(PresetCheckRow, {
            key: id,
            checked: presetSel.indexOf(id) >= 0,
            onChange: (v) => togglePreset(id, v),
            title: tt(presetMeaningKey(id)),
            sub: id + ' · ' + fmtN('gov.preset.rules', countOf(id))
          })),
          // 合计行（通用；不含任何「组合项」概念）：已选 N 项 · 合计 M 条
          presetSel.length > 0 && presetTotal > 0
            ? React.createElement('div', { style: { fontSize: G().cap, color: T.text2, fontWeight: 600 } },
                fmtN2('gov.preset.total', presetSel.length, presetTotal))
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
  }
});
