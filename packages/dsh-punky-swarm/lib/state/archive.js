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

// Archive：done→archive——complete 后自动归档、单向（产物打包保留可查 + 不可回滚标记）
// 职责（单文件 = 归档，不含状态迁移判定，迁移判定见 machine.js）：
//   archiveBatch  —— 把 sessions/<sessionId>/artifacts/<batchId>/ 快照复制到 sessions/<sessionId>/archive/<batchId>/
//                    （只复制不移动，保留原产物引用）+ 写 manifest.json（批次元数据 + 产物清单 + lanes 终态快照）
//                    + 批次 JSON 置 archived:true + archive.done 事件
//   readManifest  —— 只读：归档 manifest（无则 null）
//   listArchived  —— 只读：已归档批次列表
// 单向三重锁定：archived 字段 + 无 unarchive 入口（grep 可证无反向 API）+ complete 终态拒写（batch_phase/appendEvent 既有语义）
// 幂等：manifest 已存在或 archived===true → no-op 返回既有记录（不重复复制、不覆盖 manifest）
// 失败语义：归档失败 → archive.failed 事件（含原因），不阻断 complete（complete 已置终态；归档为可重试伴随动作）
// 打包形态：目录快照复制 + manifest 索引（Node 内置 fs/path/crypto，零运行时依赖，不做 zip）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrateV2toV3 } from './schema-v3.js';
// 路径三族单点（W2/A-3 收敛）：本文件只留单行委托，校验与抛错原文在 batch-paths.js
import { sessionDirOf, artifactsDirOf as artifactsDirOfAt, batchFilePathOf } from './batch-paths.js';
// listArchived 的目录名过滤仍用 SAFE_ID 字符集：原 `const BATCH_RE = SESSION_RE` 别名删除，
//   改为直接引单点常量（同一正则对象，行为逐字等价）
import { SESSION_RE } from './constants.js';
// 事件字面量改引 EVT 常量单点（archive.failed/archive.done）
import * as EVT from './event-types.js';

export function createArchive(root, deps = {}) {
  const sessionsDir = path.join(root, 'sessions');
  // 【2026-10-22 · 原 F3 D-2 残余收尾】批次 JSON 的**写点归一**：归档会写批次 JSON（archived 标记 /
  //   archive.done / archive.failed），若绕过 `commitBatch` 则 `__rev` 不推进；此时若另一写方在
  //   「归档读 → 归档写」之间提交，归档会用**旧数据 + 旧 rev** 整份覆盖 ⇒ rev 回退 ⇒ 后续正常写入拿到
  //   **虚假冲突**。故批次 JSON 一律经注入的 `commitBatch`（store.js 在装配点传入，见 `createArchive(root, { commitBatch })`）。
  //   缺省（未注入，如纯只读调用/测试直建）：退回 `atomicWrite`，与改造前逐字等价（**不静默改变**旧行为）。
  //   manifest（`manifestFileOf`）不是批次 JSON、不受 rev 约束 ⇒ 仍走 atomicWrite。
  const commitBatch = typeof deps.commitBatch === 'function' ? deps.commitBatch : null;
  const writeBatchJson = (sessionId, batchId, batch) => {
    if (commitBatch) return commitBatch(sessionId, batchId, batch);
    return atomicWrite(batchFileOf(sessionId, batchId), batch);
  };

  function sessionDir(sessionId) { return sessionDirOf(sessionsDir, sessionId); }
  function batchFileOf(sessionId, batchId) { return batchFilePathOf(sessionsDir, sessionId, batchId); }
  function artifactsDirOf(sessionId, batchId) { return artifactsDirOfAt(sessionsDir, sessionId, batchId); }
  // 归档目标：sessions/<sessionId>/archive/<batchId>/（与 batches/、artifacts/ 平级）
  function archiveDirOf(sessionId, batchId) {
    return path.join(sessionDir(sessionId), 'archive', batchId);
  }
  function manifestFileOf(sessionId, batchId) {
    return path.join(archiveDirOf(sessionId, batchId), 'manifest.json');
  }

  function readBatch(sessionId, batchId) {
    const file = batchFileOf(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // 损坏批次隔离（读路径不 throw）：损坏 → null（登记在 store 旁路清单，本文件不重复）
      return null;
    }
  }
  function atomicWrite(file, data) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file); // Windows: MoveFileEx REPLACE_EXISTING
  }

  // 只读：归档 manifest（无则 null）
  function readManifest(sessionId, batchId) {
    const file = manifestFileOf(sessionId, batchId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // 只读：已归档批次列表（有 manifest 的批次目录，稳定排序）
  function listArchived(sessionId) {
    const dir = path.join(sessionDir(sessionId), 'archive');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => SESSION_RE.test(f) && fs.existsSync(path.join(dir, f, 'manifest.json')))
      .sort();
  }

  // 产物清单：相对路径 + size + sha256（快照完整性可校验）
  function sha256Of(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  function collectArtifacts(dir) {
    const out = [];
    const walk = (d, rel) => {
      for (const name of fs.readdirSync(d)) {
        const abs = path.join(d, name);
        const relPath = rel ? rel + '/' + name : name;
        const st = fs.statSync(abs);
        if (st.isDirectory()) walk(abs, relPath);
        else if (st.isFile()) out.push({ path: relPath, size: st.size, sha256: sha256Of(abs) });
      }
    };
    walk(dir, '');
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  // 失败留痕：archive.failed 事件（best-effort，不抛——complete 已置终态，归档为可重试伴随动作）
  function recordFailure(sessionId, batchId, reason) {
    try {
      const b = readBatch(sessionId, batchId);
      if (!b) return;
      const nb = migrateV2toV3(b); // v2 存量批次经迁移兜底（schema 升 3 + chains/archived 补齐）
      nb.events = nb.events ?? [];
      nb.events.push({ ts: new Date().toISOString(), type: EVT.EVT_ARCHIVE_FAILED, reason });
      nb.updatedAt = new Date().toISOString();
      writeBatchJson(sessionId, batchId, nb);
    } catch { /* 兜底也失败：静默（审计可经 archive/ 目录状态判断） */ }
  }

  // 归档动作（幂等；失败记录 archive.failed 后返回 { ok:false }，不 throw）
  function archiveBatch(sessionId, batchId) {
    const batch = readBatch(sessionId, batchId);
    if (!batch) throw new Error('batch not found: ' + batchId);
    const next = migrateV2toV3(batch); // 归一化视图：schema 3 + chains/archived 兜底（chains 逻辑不动）
    // 幂等：archived 已置 或 manifest 已存在 → no-op 返回既有记录
    if (next.archived === true) return readManifest(sessionId, batchId) ?? { batchId, sessionId, archived: true };
    const existing = readManifest(sessionId, batchId);
    if (existing) return existing;

    const srcDir = artifactsDirOf(sessionId, batchId);
    if (!fs.existsSync(srcDir)) {
      recordFailure(sessionId, batchId, 'artifacts dir missing: ' + srcDir);
      return { ok: false, reason: 'artifacts dir missing: ' + srcDir };
    }
    try {
      const dstDir = archiveDirOf(sessionId, batchId);
      fs.cpSync(srcDir, dstDir, { recursive: true }); // 快照复制（只复制不移动，保留原产物引用）
      const artifacts = collectArtifacts(dstDir);
      const archivedAt = new Date().toISOString();
      const manifest = {
        batchId,
        sessionId,
        archivedAt,
        schema: next.schema,
        phase: next.phase,
        wavePlan: { waves: (next.wavePlan ?? []).length, lanes: Object.keys(next.lanes ?? {}).length },
        lanes: { ...(next.lanes ?? {}) },
        artifacts,
        eventCount: (next.events ?? []).length,
      };
      atomicWrite(manifestFileOf(sessionId, batchId), manifest);
      // 单向标记：批次 JSON 置 archived:true + archive.done 事件（无 unarchive 入口 = 不可回滚）
      next.archived = true;
      next.events = next.events ?? [];
      next.events.push({ ts: archivedAt, type: EVT.EVT_ARCHIVE_DONE, archivedAt });
      next.updatedAt = archivedAt;
      writeBatchJson(sessionId, batchId, next);
      return manifest;
    } catch (err) {
      recordFailure(sessionId, batchId, String((err && err.message) || err));
      return { ok: false, reason: String((err && err.message) || err) };
    }
  }

  return { archiveBatch, readManifest, listArchived };
}
