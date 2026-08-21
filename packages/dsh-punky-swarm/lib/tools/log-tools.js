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

// 蟛蜞模式日志导出工具（1 个）：log_export
// -----------------------------------------------------------------------------
// punky-finalize 决策包 §三（P2-11 半项）：模型可调用、只读、可审计的事件日志导出。
// 现状事件流已完备（store.appendEvent 全量落 batch.events，含 member.settled / gate.* /
// worktree.* / budget.* / system.* / asset.* 等），但缺模型可调用的导出工具——本工具为
// store.readBatch 的纯读投影，零副作用（R3：不 appendEvent、不改状态文件、不碰 mailbox、
// 不写工作区；唯一写路径是显式 writeTo 落盘到引擎产物根，属可审计产物）。
// 装配开关：config.capabilities?.logs?.enabled === true 时注册（默认关 → 工具总数 14 不变，
// 回归零破坏，对齐 aip/worktree.enabled 先例）。
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TEXT_OUTPUT, sessionOf } from './core.js';

const SAFE_ID = /^[a-zA-Z0-9._-]+$/; // 复用本包 SAFE_ID 语义（store.js SESSION_RE / batchId 同款）
const TERMINAL = ['merged', 'failed', 'skipped', 'conflict'];

function artifactsDirOf(root, sessionId, batchId) {
  return path.join(root, 'sessions', sessionId, 'artifacts', batchId);
}

// 路径防逃逸（同 store.claimAsset 语义）：批次内相对路径，拒绝绝对路径/盘符前缀/../空段
function assertSafeRelative(p) {
  if (typeof p !== 'string' || !p.length) throw new Error('invalid writeTo path: ' + p + ' (must be batch-relative)');
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new Error('invalid writeTo path: ' + p + ' (must be batch-relative, no absolute path)');
  const segs = p.split(/[\\/]+/);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new Error('invalid writeTo path: ' + p + ' (no .. or empty segment)');
  return segs;
}

// 事件关键字段摘要（markdown 时间线表用；未知事件回退 JSON 截断）
function summaryOf(e) {
  if (e.type === 'member.settled') return (e.from ?? '') + ' -> ' + (e.to ?? '') + (e.note ? ' | ' + e.note : '');
  if (e.type === 'lane.skipped' || e.type === 'lane.needhuman') return e.note ?? '';
  if (e.type === 'batch.phase') return (e.from ?? '') + ' -> ' + (e.to ?? '');
  if (e.type.startsWith('gate.') || e.type.startsWith('worktree.') || e.type === 'budget.rejected') {
    const keys = ['lane', 'code', 'missing', 'detail', 'step', 'total', 'chainId', 'gate'];
    const parts = keys.filter((k) => e[k] !== undefined).map((k) => k + '=' + (Array.isArray(e[k]) ? e[k].join(',') : String(e[k])));
    return parts.join(' | ');
  }
  if (e.type.startsWith('asset.') || e.type.startsWith('archive.')) {
    const keys = ['lane', 'target', 'source', 'reason'];
    const parts = keys.filter((k) => e[k] !== undefined).map((k) => k + '=' + String(e[k]));
    return parts.join(' | ');
  }
  const extra = { ...e };
  delete extra.ts; delete extra.type; delete extra.lane;
  const s = JSON.stringify(extra);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

function matchEvent(e, args) {
  if (args.lane && e.lane !== args.lane) return false;
  if (args.type && !String(e.type ?? '').startsWith(args.type)) return false;
  if (args.since && Date.parse(e.ts) < Date.parse(args.since)) return false;
  return true;
}

function filterDesc(args) {
  const conds = [];
  if (args.lane) conds.push('lane=' + args.lane);
  if (args.type) conds.push('type~' + args.type);
  if (args.since) conds.push('since=' + args.since);
  return conds.length ? conds.join('; ') : '无';
}

// markdown 可审计报告：批次头 + 时间线表 + 尾部汇总（终态计数/门禁清单/资产归档清单）
function buildReport(batch, sessionId, filtered, args) {
  const lines = [];
  lines.push('# 事件日志导出报告');
  lines.push('');
  lines.push('- 批次: ' + batch.batchId);
  lines.push('- 会话: ' + sessionId);
  lines.push('- phase: ' + batch.phase);
  lines.push('- 事件总数: ' + (batch.events ?? []).length);
  lines.push('- 过滤条件: ' + filterDesc(args));
  lines.push('- 导出时间: ' + new Date().toISOString());
  lines.push('');
  lines.push('## 时间线');
  lines.push('');
  lines.push('| ts | type | lane | 关键字段 |');
  lines.push('|---|---|---|---|');
  for (const e of filtered) {
    lines.push('| ' + e.ts + ' | ' + e.type + ' | ' + (e.lane ?? '-') + ' | ' + summaryOf(e).replace(/\|/g, '\\|') + ' |');
  }
  lines.push('');
  lines.push('## 尾部汇总');
  lines.push('');
  lines.push('### 各 lane 终态计数');
  lines.push('');
  lines.push('| 终态 | 计数 |');
  lines.push('|---|---|');
  for (const st of TERMINAL) {
    const n = Object.values(batch.lanes ?? {}).filter((v) => v === st).length;
    lines.push('| ' + st + ' | ' + n + ' |');
  }
  const gateEvents = filtered.filter((e) => String(e.type).startsWith('gate.'));
  lines.push('');
  lines.push('### 门禁事件清单 (' + gateEvents.length + ')');
  lines.push('');
  for (const e of gateEvents) lines.push('- `' + e.type + '` ' + summaryOf(e));
  const assetEvents = filtered.filter((e) => String(e.type).startsWith('asset.') || String(e.type).startsWith('archive.'));
  lines.push('');
  lines.push('### 资产/归档事件清单 (' + assetEvents.length + ')');
  lines.push('');
  for (const e of assetEvents) lines.push('- `' + e.type + '` ' + summaryOf(e));
  return lines.join('\n');
}

export function createLogTools(ctx, deps) {
  const config = deps?.config ?? {};
  // 默认关（对齐 aip/worktree.enabled 先例）：logs 未配置/disabled → 零注册，工具总数 14 不变
  if (config?.capabilities?.logs?.enabled !== true) return [];
  const { root, store } = deps;

  return [
    defineTool({
      name: "log_export",
      description: "导出批次事件日志（只读投影，零副作用）：按 lane/type(前缀)/since 过滤；format=json 返回结构化事件数组（ts/type 保序），format=markdown 返回可审计报告（批次头+时间线表+尾部汇总）；writeTo 可选落盘到引擎产物根（批次内相对路径，防逃逸）。",
      parameters: {"batchId":{"type":"string","required":true,"description":"批次 ID"},"session":{"type":"string","description":"批次归属会话（缺省=当前执行会话，cli 兜底）"},"lane":{"type":"string","description":"按 lane 过滤"},"type":{"type":"string","description":"按事件 type 过滤（支持前缀匹配）"},"since":{"type":"string","description":"ISO 时间戳，仅返回该时刻之后的事件"},"format":{"type":"string","enum":["json","markdown"],"description":"json 默认 / markdown 可审计报告"},"writeTo":{"type":"string","description":"可选：相对批次产物根的落盘路径（如 audit/event-log.md），仅落引擎产物根"}},
      output: {
        schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean","required":true},"batchId":{"type":"string","required":true},"session":{"type":"string","required":true},"phase":{"type":"string","required":true},"eventCount":{"type":"integer","required":true},"exported":{"type":"integer","required":true},"items":{"type":"array","items":{"type":"object","additionalProperties":true}},"report":{"type":"string"},"writtenTo":{"type":"string"}}},
        render: (_args, value) => TEXT_OUTPUT('log_export: ' + value.exported + '/' + value.eventCount + ' events' + (value.writtenTo ? ' -> ' + value.writtenTo : '')),
      },
      async execute(args, exec) {
        const sessionId = sessionOf(args, exec);
        if (!SAFE_ID.test(sessionId)) throw new Error('invalid session: ' + sessionId);
        if (!SAFE_ID.test(args.batchId)) throw new Error('invalid batchId: ' + args.batchId);
        if (args.since != null && !Number.isFinite(Date.parse(args.since))) throw new Error('invalid since: ' + args.since + ' (must be ISO timestamp)');
        const batch = store.readBatch(sessionId, args.batchId);
        if (!batch) throw new Error('batch not found: ' + args.batchId);
        const events = batch.events ?? [];
        const filtered = events.filter((e) => matchEvent(e, args));
        const out = { ok: true, batchId: args.batchId, session: sessionId, phase: batch.phase, eventCount: events.length, exported: filtered.length };
        if ((args.format ?? 'json') === 'markdown') {
          out.report = buildReport(batch, sessionId, filtered, args);
          if (args.writeTo) {
            const segs = assertSafeRelative(args.writeTo);
            const artifactsDir = artifactsDirOf(root, sessionId, args.batchId);
            const dest = path.join(artifactsDir, ...segs);
            if (!path.resolve(dest).startsWith(path.resolve(artifactsDir) + path.sep)) throw new Error('writeTo escapes artifacts dir: ' + args.writeTo);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, out.report, 'utf8');
            out.writtenTo = args.writeTo;
          }
        } else {
          out.items = filtered;
        }
        return out;
      },
    }),
  ];
}
