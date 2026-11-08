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


import { resolveArtifactIn } from '../batch-paths.js';
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

export interface VocabularyView { loaded: boolean; version: number | null; source: string | null }
/** 解析产物内的 `reason: <token>` 声明行（保序；`token` 取 trim 后原文，空则不计入）。 */
export function detectReasonTokens(artifactsDir: string, paths: string[]): ReasonTokenDecl[] {
  const out: ReasonTokenDecl[] = [];
  if (!Array.isArray(paths) || paths.length === 0) return out;
  for (const p of paths) {
    let abs: string;
    try { abs = resolveArtifactIn(artifactsDir, p); } catch { continue; }
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    REASON_DECL_RE.lastIndex = 0;
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
 *   `{}` = 零感知（无声明 / 全部在册）；`escapes[]` = 留痕面（`vocabulary-restated` 告警 /
 *   `vocabulary-unavailable` 降级）。
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
