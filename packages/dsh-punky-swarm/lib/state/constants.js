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

// lib/state/constants.js —— 标识符/路径校验常量单点
// 零依赖纯常量/纯函数模块：不 import 任何本包模块（避免循环依赖）。
// 消费方：store/gates/archive/corrupt-registry/evidence/log-tools/lane-tools/
//         wave-plan/lane-heartbeat/client/panel 等。
// 浏览器端面板段（lib/panel/*.js 与 lib/client.js 合成 bundle）无 ESM import 能力，
// 其 TERMINAL 为手工同步副本（见该处注释），Node 端单点以本文件为准。

// 会话/批次/lane ID 合法字符集（原先散落 6 处：store/gates/archive/corrupt-registry/evidence/log-tools/lane-tools）
export const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

// 兼容别名（既有消费方以 SESSION_RE 命名的正则，与 SAFE_ID 同款同引用）
export const SESSION_RE = SAFE_ID;

// 绝对路径判定（原 gates.js isAbsPath 现实现：盘符前缀 / UNC 反斜杠 / POSIX 根斜杠）
export function isAbsPath(p) {
  return /^[A-Za-z]:[\\/]|^\\|^\//.test(p);
}

// 成员终态数组（原散落 3 处：log-tools / client.js / panel main.js；batch-list/batch-detail 引用共享段定义）
export const TERMINAL = ['merged', 'failed', 'skipped', 'conflict'];

// 人工裁决证据契约单点（note 契约 `human:<裁决人>:<时间>:<结论>`）
// 兼容式裁决（leader-adjudication7 R-1）：人/时间分隔符兼容 `@` 与 `:`；
// 存量 21/21 通过，仍拒 human:x / human::2026-08-21:accept / human:user:26-8-21:ok
export const HUMAN_EVIDENCE_RE = /^human:[^\s:@]+[@:]\d{4}-\d{2}-\d{2}[^\s:]*:[^\s].*/m;

/** 从 note 提取人工裁决证据；无证据返回 null（与既有 `(note.match(...) ?? [null])[0]` 语义一致）。 */
export function humanEvidenceOf(note) {
  return typeof note === 'string' ? (note.match(HUMAN_EVIDENCE_RE) ?? [null])[0] : null;
}
