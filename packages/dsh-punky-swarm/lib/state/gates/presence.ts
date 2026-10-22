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

// presence 判据纯叶（形态二分 / 空内容通道 / 行首锚定 / 路径守边）——
//   `presenceJudge` 本体（唯一实现）仍在 `gates.ts`（源码文本面断言锚：`gates.js` 内 `function presenceJudge` 恰 1 处）。
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。

import fs from 'node:fs';
import path from 'node:path';

const EMPTY_REASON_RE = /^empty-reason:[ \t]*(\S[^\n]*)$/m;

export type PresenceMode = 'declare' | 'runtime';

/** 空内容原因行留痕（`gate.escape{kind:'empty-artifact-noted'}` 的载荷）。 */
export interface PresenceNote { artifact: string; reason: string }

export interface PresenceVerdict {
  ok: boolean;
  mode: PresenceMode;
  layer: string | null;
  declaredKind: string | null;
  path: string | null;
  kind: 'file' | 'dir';
  code: string | null;
  problems: string[];
  notes: PresenceNote[];
}

/** `presenceJudge` 的入参形态（原闭包内联形参类型**逐字搬移**为新具名类型；建批期 / 运行期两 mode 共用）。 */
export interface PresenceInput {
  mode?: PresenceMode;
  layer?: string | null;
  declared?: unknown;
  declaredKind?: string | null;
  abs?: string | null;
  content?: string | null;
  artifactsRoot?: string | null;
}

/** 声明形态（R-1）：按**声明原文**判定（`/` 结尾 = 目录语义），不做尾斜杠规范化。 */
export function declaredKindOf(declared: string): 'file' | 'dir' {
  return typeof declared === 'string' && declared.endsWith('/') ? 'dir' : 'file';
}

/** 原因行判定：**行首锚定 + 非空文本**（R-2；行中出现 / 前导空白 / 空文本 ⇒ 不命中）。 */
export function emptyReasonOf(content: string): string | null {
  if (typeof content !== 'string') return null;
  const m = content.match(EMPTY_REASON_RE);
  if (!m) return null;
  const reason = String(m[1]).trim();
  return reason.length > 0 ? reason : null;
}

/** 「可空」的定义（O-4.1）：扣除原因行后**无任何实质内容**。 */
export function substantiveContentOf(content: string): string {
  return String(content ?? '').replace(/^empty-reason:.*$/gm, '');
}

/** 判据章节**裸标题行**判定（S10 最低内容判据）：行首锚定 + 整行仅标题（编号变体/正文提及均不命中）。 */
export function sectionLineHit(content: string, section: string): boolean {
  if (typeof content !== 'string' || typeof section !== 'string' || section.length === 0) return false;
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped + '[ \\t]*$', 'm').test(content);
}

/**
 * 元素声明行判定（R1 §2.4 #3）：行首锚定 + 独立整行 `element: <id>`。
 *  与既有行族同构（`reason:` / `gate:` / `targets-claimed:` / `empty-reason:`）；不用 `content.includes(id)`
 *  是因为元素 id（如 `goal`）通常极短，`includes` 会把任意词命中 ⇒ 判据不可靠（假绿风险）。
 *  `id` 按**字面量**转义后匹配（与 `sectionLineHit` 同法，防正则元字符）。
 */
export function elementLineHit(content: string, id: string): boolean {
  if (typeof content !== 'string' || typeof id !== 'string' || id.length === 0) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^element:[ \\t]*' + escaped + '[ \\t]*$', 'm').test(content);
}

/** 路径归属判定（P8）：绝对路径产物必须在批次产物根内。 */
export function isInsideRoot(absPath: string, rootDir: string): boolean {
  const rel = path.relative(path.resolve(rootDir), path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ─────────────────────────────────────────────────────────────────────────────
// 【A1-P1-03 · F2】根内判据**解权档**（词法档 `isInsideRoot` 之上补一层 realpath）
//   缺陷：纯词法档不解析软链 ⇒ 根内 junction/软链指向根外仍判「根内」⇒ 门禁读到根外内容
//     （R11 第三类逃逸；gap-list A1-SENTINEL 已取运行期读数）。
//   两档分工（单一职责，不互相替代）：
//     · 词法档 `isInsideRoot` —— **语义逐字不变**，仍是既有全部消费点的快路径，零 fs 调用；
//     · 解权档 `isInsideRootResolved` —— 词法必过 → 两侧都 `realpath` → 尾判复用词法档。
//   纪律：**无法解权 ⇒ false（fail-closed）**；不得 fail-open；
//     尾判（相对路径判内）**唯一实现 = 词法档**（此处只调它，不复制第三份）。
// ─────────────────────────────────────────────────────────────────────────────

/** 解权档选项。 */
export interface InsideRootResolvedOptions {
  /**
   * `true` = 目标**允许尚不存在**（写面：目标由本次调用创建）⇒ 解权「最近既有祖先」+ 剩余段。
   * `false`（缺省）= 目标本身须可解权；解不了（不存在/断链/权限）⇒ `false`。
   */
  allowMissing?: boolean;
}

/** 最近既有祖先（`allowMissing` 档的解析基）：祖先绝对路径 + 尚未落盘的剩余段；无（含盘根不存在）⇒ `null`。 */
function nearestExistingAncestorOf(absPath: string): { anc: string; rest: string[] } | null {
  let cur = absPath;
  const rest: string[] = [];
  for (;;) {
    if (fs.existsSync(cur)) return { anc: cur, rest };
    const parent = path.dirname(cur);
    if (parent === cur) return null; // 已到盘根仍不存在
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/**
 * 路径归属判定（**解权档** · A1-P1-03）：绝对路径产物在**解权后**必须仍在批次产物根内。
 *   · 词法档必过（既有拒绝面逐字保留：`../` / 根外绝对 / 跨盘盘符 / UNC 一律先拒）；
 *   · **两侧都 realpath**（禁「未解权 root + 已解权 abs」混用：Windows 大小写/短名差异会造成假逃逸）；
 *   · 根内软链 → 根内目标 ⇒ `true`（不误拒）；根内软链/junction → 根外 ⇒ `false`；
 *   · 根不可解 / 目标不可解（不存在、断链、权限）⇒ `false`（fail-closed）。
 */
export function isInsideRootResolved(absPath: string, rootDir: string, opts: InsideRootResolvedOptions = {}): boolean {
  if (!isInsideRoot(absPath, rootDir)) return false; // 词法档快路径（零 fs 调用；既有拒绝面不变）
  let rootReal: string;
  if (opts.allowMissing === true) {
    // 【2026-10-22 · F2 追加修正（Leader 直做；由 test/log-export.test.js T3.5 抓出）】
    //   写面目标根（`<root>/sessions/<sid>/artifacts/<batch>/`）**本身可能尚未创建**（由落盘前的 mkdir 创建）。
    //   原实现无条件 `realpathSync(rootDir)` ⇒ root 不存在即抛 ⇒ 返回 false ⇒ **正常写入被误判为逃逸**
    //   （fail-closed 过头 = 把合法面打死，与「宁严」不同族）。故 allowMissing 档下 root 侧同样按
    //   「最近既有祖先 + 剩余段」解权，与 abs 侧**对称**——两侧解权口径对称是本题硬要求。
    const nearRoot = nearestExistingAncestorOf(path.resolve(rootDir));
    if (nearRoot === null) return false;
    let ancRootReal: string;
    try { ancRootReal = fs.realpathSync(nearRoot.anc); } catch { return false; }
    rootReal = path.join(ancRootReal, ...nearRoot.rest);
  } else {
    try { rootReal = fs.realpathSync(path.resolve(rootDir)); } catch { return false; }
  }
  let absReal: string;
  if (opts.allowMissing === true) {
    const near = nearestExistingAncestorOf(path.resolve(absPath));
    if (near === null) return false;
    let ancReal: string;
    try { ancReal = fs.realpathSync(near.anc); } catch { return false; }
    absReal = path.join(ancReal, ...near.rest); // 剩余段本身不存在 ⇒ 不含链接成分
  } else {
    try { absReal = fs.realpathSync(path.resolve(absPath)); } catch { return false; }
  }
  return isInsideRoot(absReal, rootReal); // 尾判**唯一实现** = 词法档（两侧均已解权）
}
