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

// ===== [panel-segment] locales.js =====
    const zh = {
      "view.cluster": "蟛蜞集群",
      "live": "实时",
      "refresh.auto": "3s 自动刷新",
      "stream.live": "实时推送",
      "stream.fallback": "已降级 3s 轮询",
      "updated": "更新于",
      "stat.total": "总批次",
      "stat.running": "运行中",
      "stat.done": "已完结",
      "stat.issues": "异常",
      "batch.title": "批次列表",
      "batch.progress": "进度",
      "batch.release": "可自动放行",
      "batch.done": "已完结",
      "lanes": "子任务",
      "events": "事件",
      "concurrency": "并发",
      "event.timeline": "事件时间线",
      "mailbox.title": "收件箱（只读）",
      "mailbox.inbox": "派发",
      "mailbox.broadcast": "广播",
      "mailbox.hint": "暂无未读",
      "empty": "暂无批次",
      "empty.hint": "创建 wave_plan 批次后在此查看",
      "load.error": "加载失败",
      "gate.missing": "缺",
      "attempt": "返工",
      "upgrade": "升级人工",
      "task.deps": "依赖",
      "task.layer": "层",
      "gate.consume": "消费缺失",
      "gate.outputs": "产物缺失",
      "gate.produce": "产出缺失",
      "gate.contract": "契约问题"
    };
    const en = {
      "view.cluster": "Punky swarm",
      "live": "Live",
      "refresh.auto": "3s auto refresh",
      "stream.live": "Live push",
      "stream.fallback": "3s polling fallback",
      "updated": "updated",
      "stat.total": "Batches",
      "stat.running": "Running",
      "stat.done": "Done",
      "stat.issues": "Issues",
      "batch.title": "Batches",
      "batch.progress": "progress",
      "batch.release": "auto-release",
      "batch.done": "done",
      "lanes": "lanes",
      "events": "events",
      "concurrency": "concurrency",
      "event.timeline": "Event timeline",
      "mailbox.title": "Inbox (read-only)",
      "mailbox.inbox": "dispatch",
      "mailbox.broadcast": "broadcast",
      "mailbox.hint": "nothing unread",
      "empty": "No batches",
      "empty.hint": "Create a wave_plan batch to see it here",
      "load.error": "Load failed",
      "gate.missing": "missing",
      "attempt": "rework",
      "upgrade": "escalate",
      "task.deps": "deps",
      "task.layer": "layer",
      "gate.consume": "consume missing",
      "gate.outputs": "outputs missing",
      "gate.produce": "produce missing",
      "gate.contract": "contract problem"
    };

    // module-level translator: zh-first, en fallback (matches the original panel behavior)
    function tt(k) { return zh[k] || en[k] || k; }
