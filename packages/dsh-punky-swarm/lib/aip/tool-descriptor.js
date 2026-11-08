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

import { readFileSync } from 'node:fs';

export function engineVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export function toToolId(name) {
  return 'dsh.punky-swarm.' + name;
}

function toInputParam(parameters = {}) {
  if (parameters && typeof parameters === 'object' && 'type' in parameters) {
    const clone = structuredClone(parameters);
    if (!('required' in clone)) clone.required = [];
    return clone;
  }
  const required = [];
  const properties = {};
  for (const [key, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = spec ?? {};
    if (isRequired === true) required.push(key);
    properties[key] = rest;
  }
  return { type: 'object', properties, required };
}

function toOutputParam(output) {
  return output?.schema ? structuredClone(output.schema) : { type: 'object', properties: {} };
}

export function buildToolDescriptor(tool, ctx = {}) {
  const config = ctx.config ?? {};
  const version = config?.aip?.toolVersion ?? ctx.version ?? engineVersion();
  return {
    toolId: toToolId(tool.name),
    name: tool.name,
    description: tool.description,
    version,
    inputParam: toInputParam(tool.parameters),
    outputParam: toOutputParam(tool.output),
  };
}

export function buildToolCatalog(tools, ctx = {}) {
  const descriptors = tools.map((t) => buildToolDescriptor(t, ctx));
  return {
    generatedAt: new Date().toISOString(),
    descriptors: Object.freeze(descriptors),
    list() {
      return descriptors.slice();
    },
    get(name) {
      return descriptors.find((d) => d.name === name) ?? null;
    },
  };
}
