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

// 损坏批次旁路清单（v2-node-robustness ②，设计 D-001）
// 批次 JSON 唯一事实源结构零变更；损坏隔离信息走会话级旁路清单 corrupt-batches.json
// （<sessionDir>/corrupt-batches.json，与 governance.json 同层同级）。
// 语义：损坏批次无法写入 batch 文件本身（文件已坏），故隔离以「清单状态 + logger 留痕」呈现；
//       损坏文件本体保留现场供人工抢救（damaged-file-restoration 技能路线），
//       人工修复/删除文件后调 clearCorruptMark 清除标记。
// 容错：清单文件自身损坏 → 读降级空清单（governance.json 同款 try/catch 模式），不 throw。
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RE } from './constants.js'; // P1-07 单点（原 :29 定义迁出）

const CORRUPT_SCHEMA = 1;

// 清单文件路径（会话级；与 store.sessionDir 同源解析——root/sessions/<sessionId>/）
export function corruptFileOf(root, sessionId) {
  if (!SESSION_RE.test(sessionId)) throw new Error('invalid sessionId: ' + sessionId);
  return path.join(root, 'sessions', sessionId, 'corrupt-batches.json');
}

export function createCorruptRegistry(root) {
  function readList(sessionId) {
    const file = corruptFileOf(root, sessionId);
    if (!fs.existsSync(file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data?.corrupt) ? data.corrupt : [];
    } catch {
      return []; // 清单自身损坏 → 降级空清单（不 throw；人工重建）
    }
  }

  // 原子写（与 store.atomicWrite 同模式：tmp + rename，防半写）
  function writeList(sessionId, list) {
    const file = corruptFileOf(root, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ schema: CORRUPT_SCHEMA, corrupt: list }, null, 2));
    fs.renameSync(tmp, file);
  }

  // 幂等登记（INV-2/INV-3）：同 sessionId+batchId 已登记 → first=false 不重复写、不重复刷日志
  function markBatchCorrupt(sessionId, batchId, error) {
    const list = readList(sessionId);
    if (list.some((c) => c.batchId === batchId)) return { first: false };
    const entry = {
      sessionId,
      batchId,
      file: path.join('sessions', sessionId, 'batches', batchId + '.json'),
      error: String((error && error.message) || error),
      detectedAt: new Date().toISOString(),
    };
    list.push(entry);
    writeList(sessionId, list);
    return { first: true };
  }

  // 只读清单：sessionId 缺省 → 全部会话（排序稳定）
  function listCorruptBatches(sessionId) {
    if (sessionId) return readList(sessionId);
    const out = [];
    const sessionsDir = path.join(root, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const s of fs.readdirSync(sessionsDir).sort()) {
        if (!SESSION_RE.test(s)) continue;
        out.push(...readList(s));
      }
    }
    return out;
  }

  // 人工修复/删除损坏文件后清除标记（幂等：无标记 → { removed:false }）
  function clearCorruptMark(sessionId, batchId) {
    const list = readList(sessionId);
    const next = list.filter((c) => c.batchId !== batchId);
    if (next.length === list.length) return { removed: false };
    writeList(sessionId, next);
    return { removed: true };
  }

  // 区分「损坏」与「不存在」（readBatch 两者均返回 null，需区分的调用方二次查询）
  function isCorrupt(sessionId, batchId) {
    return readList(sessionId).some((c) => c.batchId === batchId);
  }

  return { markBatchCorrupt, listCorruptBatches, clearCorruptMark, isCorrupt, corruptFileOf };
}
