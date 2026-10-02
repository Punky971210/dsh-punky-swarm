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

// reason 词表扫描面 + 放行侧载荷（纯函数）——
//   判定单点 `reasonVocabularyVerdict` 仍在 `gates.ts`（源码文本面断言锚：`gates.js` 须含 `GATE_TOKEN_UNKNOWN`）。
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。

import { isAbsPath } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';

const REASON_DECL_RE = /^reason:[ \t]*(\S[^\n]*)$/gm;

export interface ReasonTokenDecl { token: string; path: string; index: number }

export interface ReasonVocabularyVerdict {
  ok: boolean;
  declarations: ReasonTokenDecl[];
  unknown: ReasonTokenDecl[];
  restated: Array<ReasonTokenDecl & { entryId: string | null }>;
  degrade: { kind: string; code: string; problems: string[] } | null;
}

/** 词表只读视图（§2.4 #6 的**纯展示位**形态：恰好三键，不参与任何判定）。 */
export interface VocabularyView { loaded: boolean; version: number | null; source: string | null }
/** 解析产物内的 `reason: <token>` 声明行（保序；`token` 取 trim 后原文，空则不计入）。 */
export function detectReasonTokens(artifactsDir: string, paths: string[]): ReasonTokenDecl[] {
  const out: ReasonTokenDecl[] = [];
  if (!Array.isArray(paths) || paths.length === 0) return out;
  for (const p of paths) {
    const abs = isAbsPath(p) ? p : path.join(artifactsDir, p);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    REASON_DECL_RE.lastIndex = 0; // /g 正则复用防 lastIndex 泄漏（同 detectGate 纪律）
    let m;
    while ((m = REASON_DECL_RE.exec(content)) !== null) {
      const token = String(m[1]).trim();
      if (token.length === 0) continue;
      out.push({ token, path: p, index: m.index });
    }
  }
  return out;
}
/**
 * 词表判定的**放行侧载荷**（单点构造；entry 门 E1 与命令门 C3 同形）：
 *   `{}` = 零感知（无声明 / 全部在册）；`escapes[]` = 留痕面（`vocabulary-restated` 告警 /
 *   `vocabulary-unavailable` 降级）。
 * 形态选择（**刻意的**）：只走 `escapes[]` **多值通道**，**不**占用 `escape` 单值键 —— 调用点可能已自带
 *   专属 `escape`（如 `command-declared-off` / `standalone`），两态可同时成立（例：显式禁用 `gate:` +
 *   产物声明停用词条）⇒ 多值通道使两条留痕**各自可归因**、互不覆盖（写端 `store.js#gateEscapeEvents`
 *   同时消费 `escape` 与 `escapes[]`）。
 * 纪律：本函数**只产载荷**，不落盘、不改判定（落盘唯一在 store 写路径 ⇒ R-5「只读视图零事件」）。
 */
export function reasonVocabularyNote(v: ReasonVocabularyVerdict) {
  if (v.degrade !== null) {
    return {
      vocabCode: v.degrade.code,
      escapes: [{
        kind: v.degrade.kind,
        reason: '词表不可用（' + v.degrade.code + '）⇒ fail-open 降级放行 + 留痕（**不拒批**：词表损坏不得砸生产）'
          + (v.degrade.problems.length ? '：' + v.degrade.problems.join('; ') : ''),
      }],
    };
  }
  if (v.restated.length > 0) {
    return {
      escapes: [{
        kind: 'vocabulary-restated',
        reason: '产物声明的 reason token 命中**停用**词条（enabled:false）⇒ 放行 + 告警'
          + '（禁用≠删除：既有产物仍解析通过）：' + v.restated.map((r) => r.token + '@' + r.path).join(', '),
      }],
    };
  }
  return {};
}
