// 可插拔装配数据（设计 §12.1/§14.2/§15.3 N7）：team → layer → role → skills
// 引擎只认 "role 契约 + skill 前缀" 通用格式，不感知 team；非 jiufeng 团队 = 换装配（外部路径 config.assembly 或自定义 resolveAssembly）
export const DEFAULT_ASSEMBLY = {
  team: 'jiufeng',
  layers: {
    plan: {
      roles: ['coordinator', 'designer'],
      skills: { coordinator: ['dev-planner'], designer: ['dev-designer', 'spec-writing', 'design-an-interface'] },
    },
    exec: {
      roles: ['coder', 'tester'],
      skills: { coder: ['dev-coder', 'efficient-edit', 'codebase-design'], tester: ['dev-tester'] },
    },
    audit: {
      roles: ['reviewer', 'supervisor', 'doc-manager'],
      skills: { reviewer: ['code-review-guideline', 'report-blind-audit'], supervisor: ['report-blind-audit', 'archive'], 'doc-manager': ['doc-generator', 'doc-update'] },
    },
  },
};

export function resolveAssembly(team, configAssembly = null) {
  if (configAssembly) return configAssembly;
  return team === 'jiufeng' ? DEFAULT_ASSEMBLY : null;
}
