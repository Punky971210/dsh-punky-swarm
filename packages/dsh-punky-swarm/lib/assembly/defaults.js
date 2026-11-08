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

export const DEFAULT_ASSEMBLY = {
  team: 'software-team',
  layers: {
    plan: {
      roles: ['coordinator', 'designer'],
      skills: { coordinator: ['brainstorming', 'writing-plans'], designer: ['brainstorming', 'writing-plans', 'spec-writing'] },
    },
    exec: {
      roles: ['coder', 'tester', 'reviewer'],
      skills: {
        coder: ['test-driven-development', 'codebase-design', 'receiving-code-review', 'requesting-code-review'],
        tester: ['verification-before-completion', 'systematic-debugging'],
        reviewer: ['code-review'],
      },
    },
    audit: {
      roles: ['supervisor', 'doc-manager'],
      skills: {
        supervisor: ['verification-before-completion'],
        'doc-manager': ['doc-generator'],
      },
    },
  },
};
