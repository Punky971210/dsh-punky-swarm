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

import { serviceOf } from './tools-http.js';


export const name = 'dsh-punky-swarm-provider-dsh';

export function apply(ctx) {
  const roster = serviceOf(ctx, 'agentTeams');
  const available = Boolean(roster) && typeof roster.listMembers === 'function';
  ctx?.logger?.info?.('[dsh-punky-swarm] optional service agentTeams=' + (available ? 'available' : 'unavailable')
    + '（可选服务，不进 inject；缺失时降级，不 pending）');
}
