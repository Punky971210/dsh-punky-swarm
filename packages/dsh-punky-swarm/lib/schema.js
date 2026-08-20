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

// 蟛蜞模式状态机 schema（纯逻辑，零依赖）
// 成员状态（对齐 A2 语义 + 设计 3.4）：
//   pending -> running -> review -> merged | failed | skipped | conflict
//   idle：恢复语义（重启后 in-flight 成员落位 idle，可重新指派）
export const MEMBER_STATES = [
  'pending', 'running', 'review', 'merged', 'failed', 'skipped', 'conflict', 'idle',
];

// 批次阶段：planning -> running -> paused -> aborted | complete
export const BATCH_PHASES = ['planning', 'running', 'paused', 'aborted', 'complete'];

export const SETTLE_STATES = ['merged', 'failed', 'skipped'];

export const MEMBER_TRANSITIONS = {
  pending: ['running', 'failed', 'skipped'],
  running: ['review', 'failed', 'skipped'],
  review: ['merged', 'conflict', 'failed', 'running'], // running = REWORK 返工（attempt+1，由事件计数）
  idle: ['running'],
  merged: [],
  failed: [],
  skipped: [],
  conflict: [],
};

export const BATCH_TRANSITIONS = {
  planning: ['running', 'aborted'],
  running: ['paused', 'complete', 'aborted'],
  paused: ['running', 'aborted'],
  aborted: [],
  complete: [],
};

export function isMemberState(s) {
  return MEMBER_STATES.includes(s);
}

export function isBatchPhase(p) {
  return BATCH_PHASES.includes(p);
}

export function isMemberTerminal(s) {
  return SETTLE_STATES.includes(s) || s === 'conflict';
}

export function isBatchTerminal(p) {
  return p === 'aborted' || p === 'complete';
}

export function canTransitionMember(from, to) {
  if (!isMemberState(from) || !isMemberState(to)) return false;
  return MEMBER_TRANSITIONS[from].includes(to);
}

export function canTransitionBatch(from, to) {
  if (!isBatchPhase(from) || !isBatchPhase(to)) return false;
  return BATCH_TRANSITIONS[from].includes(to);
}

export function assertMemberTransition(from, to) {
  if (!canTransitionMember(from, to)) {
    throw new Error('invalid member transition: ' + from + ' -> ' + to);
  }
}

export function assertBatchTransition(from, to) {
  if (!canTransitionBatch(from, to)) {
    throw new Error('invalid batch phase transition: ' + from + ' -> ' + to);
  }
}

export function assertMemberState(s) {
  if (!isMemberState(s)) throw new Error('unknown member state: ' + String(s));
}

export function assertBatchPhase(p) {
  if (!isBatchPhase(p)) throw new Error('unknown batch phase: ' + String(p));
}