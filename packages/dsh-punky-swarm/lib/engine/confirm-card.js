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


export const CARD_FIELDS = Object.freeze(['cardId', 'kind', 'title', 'summary', 'options', 'authority', 'createdAt']);

function textOf(value) {
  return (typeof value === 'string' && value.trim().length > 0) ? value : '';
}

export function buildConfirmCard(input = {}) {
  const given = (input && typeof input === 'object') ? input : {};

  const kind = textOf(given.kind) || 'unknown';
  const createdAt = (given.createdAt === undefined) ? null : given.createdAt;
  const options = Array.isArray(given.options) ? [...given.options] : [];

  const title = textOf(given.title) || ('变更确认：' + kind);
  const summary = textOf(given.summary) || ('待裁决的 ' + kind + ' 变更（调用方未提供摘要）');
  const authority = textOf(given.authority) || 'unspecified';

  const cardId = textOf(given.cardId)
    || ('card:' + kind + ':' + (createdAt === null ? 'no-time' : String(createdAt)));

  return { cardId, kind, title, summary, options, authority, createdAt };
}
