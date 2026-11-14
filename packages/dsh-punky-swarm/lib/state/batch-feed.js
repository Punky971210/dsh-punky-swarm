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

// lib/state/batch-feed.js — P0 端口化 · X-7 · 批次文件读面（`corePort('batchFeed')` 的**唯一**实现）
//
// 为什么存在：批次 JSON 在改造前有**两个读者**在读盘——`panel/stream.js:78-86` 自建路径 + `JSON.parse(readFileSync)`，
//   `watch/heartbeat/scan.js:57-72` 借 `store.batchFile` 取路径但读法自建。两个读者对同一份文件各自决定
//   「怎么读、读失败算什么」，改一处必然漏另一处。本模块把「读」收敛成**一份实现**，由 core 装配根登记成端口。
//
// 硬约束（逐条是判据，不是建议）：
//   ① **路径单一真源**：本模块**不**自己拼 `sessions/<sid>/batches/<bid>.json`——有 store 就转发 `store.batchFile`
//      （与 `state/store/paths.js` 的 `batchFilePathOf` 同一函数），无 store（纯 hub / 心跳夹具）才走
//      `state/batch-paths.js#batchFilePathOf`（同一路径单点，且带 `assertSafeId` 校验）。
//      ⇒ 全仓「自建批路径」只剩 `state/corrupt-registry.js:56` 那处**登记用相对字符串**（不在 X-7 范围）。
//   ② **读盘即真相**（K-1 红线）：`readEventCount` 必须回**盘上实测**的 `events.length`，**禁**改成内存计数——
//      SSE 摘要的 `eventCount` 是客户端回拉的锚，外部手改 / 跨进程写在内存里看不见。
//   ③ **读失败不抛**（调用方语义冻结）：文件不在 / 坏 JSON / `events` 非数组 ⇒ `null`（`readEventCount`），
//      前 N 字节 / 全文读失败 ⇒ `null`。`0` 只表示「events 是空数组」，不与「读失败」混用。
//   ④ BOM：走 `hot/config-watch.js#stripBom`（单点），与 `stream.test.js` S16 的既有口径一致。
//
// `subscribeChanges` 的口径（关键，防行为收缩）：**只作补充**，不得取代 `fs.watch` / stat 轮询。
//   它 = `corePort('store').onStateChange` 的**批级投影**，而该事件只在 `setMember` / `setPhase` 等状态机
//   迁移处触发（`state/store/events.js#emitStateChange`），**不覆盖 `appendEvent`**——故它连「进程内每次写盘」
//   都不足，更不足以替代文件监视（外部手改批 JSON、原子 rename 换 inode 都只有文件监视能看见）。
import fs from 'node:fs';
import { join } from 'node:path';
import { batchFilePathOf } from './batch-paths.js';
import { stripBom } from '../hot/config-watch.js';
import { corePort, hasCorePort } from '../core-ports.js';

const HEAD_BYTES_DEFAULT = 512;

/**
 * 构造批次文件读面（**唯一**实现；生产由 `lib/index.js` 传给 `corePort('batchFeed')`）。
 * @param {{ root?: string|null, store?: object|null, logger?: object|null }} deps
 */
export function createBatchFeed({ root = null, store = null, logger = null } = {}) {
  // 路径单一真源：有 store ⇒ 转发 `store.batchFile`（逐字同源）；无 store ⇒ 走 `batchFilePathOf`
  const sessionsDir = store?.sessionsDir ?? (root ? join(root, 'sessions') : null);
  const fileOf = (sessionId, batchId) => (typeof store?.batchFile === 'function'
    ? store.batchFile(sessionId, batchId)
    : batchFilePathOf(sessionsDir, sessionId, batchId));

  const batchFile = (sessionId, batchId) => {
    if (!sessionsDir) throw new Error('batchFeed.batchFile: 缺 root 且无 store（无法定位批次目录）');
    return fileOf(sessionId, batchId);
  };

  const readText = (sessionId, batchId) => {
    if (!sessionsDir || !batchId) return null;
    try {
      return fs.readFileSync(batchFile(sessionId, batchId), 'utf8');
    } catch {
      return null; // 文件不在 / 权限 / 目录缺失 —— 与既有读法同义（不抛）
    }
  };

  const readEventCount = (sessionId, batchId) => {
    if (!sessionId || !batchId) return null;
    const text = readText(sessionId, batchId);
    if (text === null) return null;
    try {
      const batch = JSON.parse(stripBom(text));
      return Array.isArray(batch?.events) ? batch.events.length : null;
    } catch {
      return null; // 坏 JSON（含坏 BOM 内容）⇒ null，禁向调用方抛错逃逸
    }
  };

  const readHead = (sessionId, batchId, bytes = HEAD_BYTES_DEFAULT) => {
    if (!sessionsDir || !batchId) return null;
    const size = Number.isInteger(bytes) && bytes > 0 ? bytes : HEAD_BYTES_DEFAULT;
    let fd = null;
    try {
      fd = fs.openSync(batchFile(sessionId, batchId), 'r');
      const buf = Buffer.allocUnsafe(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8', 0, n);
    } catch {
      return null;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖读取结果 */ } }
    }
  };

  /** 进程内变更信号（**补充**通道）：`store` 端口的 `onStateChange` 批级投影 ⇒ `cb({sessionId, batchId, type})`。 */
  const subscribeChanges = (sessionId, cb) => {
    if (typeof cb !== 'function') throw new TypeError('batchFeed.subscribeChanges expects a function (got: ' + String(cb) + ')');
    if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('batchFeed.subscribeChanges: sessionId 必填');
    if (!hasCorePort('store')) {
      // 不静默：端口缺席 = 无装配夹具直调（生产恒有）。回落为「无补充信号」，文件监视仍是唯一通道。
      logger?.info?.('[dsh-punky-swarm] batchFeed.subscribeChanges: store 端口未登记 ⇒ 本订阅零信号（文件监视通道不受影响）');
      return () => {};
    }
    return corePort('store').onStateChange((ev) => {
      if (!ev || ev.sessionId !== sessionId) return;
      try {
        cb({ sessionId, batchId: ev.batchId ?? null, type: ev.type ?? null });
      } catch (e) {
        logger?.warn?.('[dsh-punky-swarm] batchFeed change subscriber failed (isolated): ' + String(e?.message ?? e));
      }
    });
  };

  return {
    batchFile,
    readEventCount,
    readHead,
    readText,
    subscribeChanges,
    /** 非契约面（身份守卫，与 `hooks.owns` 同族）：消费侧据此判定「本读面绑的是不是我的 root」。 */
    root,
  };
}

/**
 * 取批次读面：**端口优先**（生产唯一入口），端口缺席或绑定的是**别的 root**（同进程多夹具/多引擎）⇒
 * 用**同一实现**就地构造（不新增第二条读路径，值恒等）。
 * @param {{ root?: string|null, store?: object|null, logger?: object|null }} deps
 */
export function batchFeedOf({ root = null, store = null, logger = null } = {}) {
  if (hasCorePort('batchFeed')) {
    const port = corePort('batchFeed');
    if (port && port.root === root) return port;
    // root 不同 ⇒ 不借他人根（否则读到别的引擎的批次目录）。落 info 而非静默：
    if (port && root !== null && port.root !== root) {
      logger?.info?.('[dsh-punky-swarm] batchFeed: 已登记端口绑定 root=' + String(port.root)
        + '，本次请求 root=' + String(root) + ' ⇒ 以同一实现就地构造（同源，非第二条读路径）');
    }
  }
  return createBatchFeed({ root, store, logger });
}
