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

export const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

export const SESSION_RE = SAFE_ID;

export function isAbsPath(p) {
  return /^[A-Za-z]:[\\/]|^\\|^\//.test(p);
}

export const TERMINAL = ['merged', 'failed', 'skipped', 'conflict'];

export const HUMAN_EVIDENCE_RE = /^human:[^\s:@]+[@:]\d{4}-\d{2}-\d{2}[^\s:]*:[^\s].*/m;

/** 从 note 提取人工裁决证据；无证据返回 null（与既有 `(note.match(...) ?? [null])[0]` 语义一致）。 */
export function humanEvidenceOf(note) {
  return typeof note === 'string' ? (note.match(HUMAN_EVIDENCE_RE) ?? [null])[0] : null;
}
