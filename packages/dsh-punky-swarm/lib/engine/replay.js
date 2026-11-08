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

//   保留「先判后放」的实现会变成对空对象的第二套决策路径（双推进源风险）。

export async function replayBatch() {
  return {
    ok: true,
    scanned: 0,
    replayed: 0,
    results: [],
    reason: 'retired',
    note: 'chain-replay-retired-20260918',
  };
}
