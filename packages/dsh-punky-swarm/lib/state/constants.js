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

// 【D-09 / RQ-3 · 路径组件校验器**单点**】`session` / `batchId` / `lane` 三个会被拼进路径的组件
//   全部走这一个判据（`isSafeId` / `assertSafeId`），下游只消费、禁复制第二份。
//
// 为什么不再用 `/^[a-zA-Z0-9._-]+$/`：该式对下列输入**全部放行** ——
//   `..`（`path.join(root,'sessions','..')` 直接跳出 sessions/）、`.`、Windows 设备名
//   （`NUL`/`CON`/`PRN`/`AUX`/`COM1`/`LPT1`）、尾点（`a.` 在 Win32 归一到 `a` ⇒ 与 `a` 撞名）、
//   超长名（无上限）。实测后果：`lane_claim({session:'../../../../tmp/probe'})` 可在任意位置建目录
//   并落一个锁文件（`lib/lock.js#acquire` 先 `mkdirSync`）。判定 P0（写到仓外）。
//
// 现行判据（逐条对应 D-09 逃逸面，见 plan/defect-leads.md D-09 表）：
//   ① 长度 1..MAX_ID_LEN —— 拒超长；
//   ② 首字符须 `[A-Za-z0-9_-]` —— 拒 `.` 与 `..`（首字符即点）；
//   ③ 末字符须 `[A-Za-z0-9_-]` —— 拒尾点 / 尾空格（`a.`）；
//   ④ 禁出现 `..` 段 —— 拒 `a..b` 型中间穿越；
//   ⑤ 大小写不敏感地拒 Windows 设备名（含带扩展名形态 `nul.txt`）；
//   ⑥ 字符集只留 `[A-Za-z0-9._:-]` —— 顺带拒 `/`、`\`（路径分隔，唯一的**逃逸**载体）、NUL 字符、空格。
//      为什么放行 `:`：它**不是逃逸载体**（`path.join(root,'sessions','C:x')` 仍是 root 内的相对名，
//      Win32 也不把「非首段」的 `C:` 当盘符），且既有用例以 ISO 时间戳拼批次名
//      （`test/gate-hardening-red.test.js` 的 `t27-e1-2099-01-01T00:00:00.000Z`）——
//      收紧到禁 `:` 会打红一条与本面无关的既有用例，属「要求之外的收窄」。
//      ⚠ 残余风险（登记、不在本 lane 修）：NTFS 备用数据流（ADS，`name:stream`）形态本判据不拦。
export const MAX_ID_LEN = 128;

export const SAFE_ID = new RegExp(
  '^(?=.{1,' + MAX_ID_LEN + '}$)'
  + '(?!.*\\.\\.)'
  + '(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$))'
  + '[a-zA-Z0-9_:\\-](?:[a-zA-Z0-9._:\\-]*[a-zA-Z0-9_:\\-])?$',
  'i',
);

export const SESSION_RE = SAFE_ID;

/** 三组件共用的校验谓词（**唯一实现**）。
 *  非字符串一律 false —— 旧写法 `SESSION_RE.test(x)` 会把 `undefined` 当字符串 `"undefined"` 放行。 */
export function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

/** 校验并回传（便于内联进路径表达式）；非法即抛，**禁静默回落**（fail-closed）。 */
export function assertSafeId(value, what = 'id') {
  if (!isSafeId(value)) {
    throw new Error('invalid ' + what + ': ' + JSON.stringify(value === undefined ? null : value)
      + '（路径组件须 1..' + MAX_ID_LEN + ' 字符、只含 [A-Za-z0-9._:-]、首末非点、'
      + '禁 `..` 段、禁 Windows 设备名 —— RQ-3 校验器单点兑现）');
  }
  return value;
}

export function isAbsPath(p) {
  return /^[A-Za-z]:[\\/]|^\\|^\//.test(p);
}

export const TERMINAL = ['merged', 'failed', 'skipped', 'conflict'];

export const HUMAN_EVIDENCE_RE = /^human:[^\s:@]+[@:]\d{4}-\d{2}-\d{2}[^\s:]*:[^\s].*/m;

/** 从 note 提取人工裁决证据；无证据返回 null（与既有 `(note.match(...) ?? [null])[0]` 语义一致）。 */
export function humanEvidenceOf(note) {
  return typeof note === 'string' ? (note.match(HUMAN_EVIDENCE_RE) ?? [null])[0] : null;
}
