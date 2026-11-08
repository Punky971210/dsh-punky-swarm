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


import { findTask } from '../task-utils.js';
import * as EVT from '../event-types.js';
import type { Batch, WavePlanTask } from '../../types/contracts.js';
import fs from 'node:fs';
import { resolveArtifactIn } from '../batch-paths.js';

export function taskOf(batch: Batch | null, lane: string): WavePlanTask | null {
  return findTask(batch, lane) as WavePlanTask | null;
}

export function smokeOf(batch: Batch | null | undefined): boolean {
  const evs = ((batch as unknown as { events?: unknown[] } | null | undefined)?.events ?? []) as Array<{ type?: unknown }>;
  return evs.some((e) => e && e.type === EVT.EVT_BATCH_SMOKE);
}

export type TaskArrayField = 'consume' | 'produce' | 'outputs';

export type ContractMissingPayload = {
  contractMissing: {
    cause: 'undeclared';
    gateKind: string;
    layer: string;
    declared: false;
    source: string;
    degrade: { kind: string; note: string };
    problems: string[];
  };
};
export function contractMissingPayload(
  gateKind: string, layer: string, source: string, degradeKind: string, degradeNote: string,
): ContractMissingPayload {
  return {
    contractMissing: {
      cause: 'undeclared', gateKind, layer, declared: false, source,
      degrade: { kind: degradeKind, note: degradeNote }, problems: [],
    },
  };
}

export const TARGETS_CLAIMED_RE = /^targets-claimed:\s*true$/m;

export function detectNeedHuman(artifactsDir: string, producePaths: string[]) {
  if (!Array.isArray(producePaths) || producePaths.length === 0) return { declared: false, path: null };
  for (const p of producePaths) {
    let abs: string;
    try { abs = resolveArtifactIn(artifactsDir, p); } catch { continue; }
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (/^needHuman:\s*true$/m.test(content)) return { declared: true, path: p };
  }
  return { declared: false, path: null };
}

export function detectPendingMarker(content: string, literal: string) {
  if (typeof content !== 'string' || content.length === 0
    || typeof literal !== 'string' || literal.length === 0) {
    return { declared: false, index: -1 };
  }
  const index = content.indexOf(literal);
  return index < 0 ? { declared: false, index: -1 } : { declared: true, index };
}

export const GATE_LINE_RE = /^gate:\s*(.+)$/gm;

export const GATE_EMPTY_LINE_RE = /^gate:[ \t]*$/m;

export function detectGate(artifactsDir: string, paths: string[]) {
  if (!Array.isArray(paths) || paths.length === 0) return { declared: false, commands: [], path: null, emptyCommand: null };
  const commands = [];
  let declaredPath: string | null = null;
  let emptyCommandPath: string | null = null;
  for (const p of paths) {
    let abs: string;
    try { abs = resolveArtifactIn(artifactsDir, p); } catch { continue; }
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    GATE_LINE_RE.lastIndex = 0;
    let m;
    while ((m = GATE_LINE_RE.exec(content)) !== null) {
      const cmd = m[1].trim();
      if (cmd.length === 0 || cmd === 'false') continue;
      commands.push(cmd);
      if (!declaredPath) declaredPath = p;
    }
    if (!emptyCommandPath && GATE_EMPTY_LINE_RE.test(content)) emptyCommandPath = p;
  }
  return { declared: commands.length > 0, commands, path: declaredPath, emptyCommand: emptyCommandPath };
}

const GATE_OFF_LINE_RE = /^gate:[ \t]*false[ \t]*$/m;

export function detectGateOff(artifactsDir: string, paths: string[]) {
  if (!Array.isArray(paths) || paths.length === 0) return { declared: false, path: null };
  for (const p of paths) {
    let abs: string;
    try { abs = resolveArtifactIn(artifactsDir, p); } catch { continue; }
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (GATE_OFF_LINE_RE.test(content)) return { declared: true, path: p };
  }
  return { declared: false, path: null };
}

export const GATE_SCRIPT_SHA_RE = /^gate-script-sha256:[ \t]*(\S+?)[ \t]*=[ \t]*([0-9a-f]{64})[ \t]*$/gm;

/** 锚定键归一（**单点**）：反斜杠→`/`、剥前导 `./`、去尾 `/`。
 *  与 `command.ts` 侧「候选脚本键」**必须同一口径**（否则同一文件两处键不等 ⇒ 锚定永不命中）。 */
export function normalizeScriptKey(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function detectScriptAnchors(artifactsDir: string, paths: string[]) {
  const anchors: Record<string, string> = {};
  let anchorPath: string | null = null;
  if (!Array.isArray(paths) || paths.length === 0) return { anchors, path: anchorPath };
  for (const p of paths) {
    let abs: string;
    try { abs = resolveArtifactIn(artifactsDir, p); } catch { continue; }
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() || st.size === 0) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    GATE_SCRIPT_SHA_RE.lastIndex = 0;
    let m;
    while ((m = GATE_SCRIPT_SHA_RE.exec(content)) !== null) {
      const key = normalizeScriptKey(m[1]);
      if (key.length === 0) continue;
      if (anchors[key] === undefined) anchors[key] = m[2].toLowerCase();
      if (!anchorPath) anchorPath = p;
    }
  }
  return { anchors, path: anchorPath };
}

export function scriptTokensOf(command: string): string[] {
  const out: string[] = [];
  if (typeof command !== 'string' || command.length === 0) return out;
  for (const raw of command.split(/\s+/)) {
    if (raw.length === 0) continue;
    let t = raw;
    const quoted = (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'));
    if (quoted && t.length >= 2) t = t.slice(1, -1);
    if (t.length === 0 || t.startsWith('-')) continue;
    out.push(t);
  }
  return out;
}

