// 通用产物类型注册表（2026-08-19，Tier3 增量）
// 定位：通用任务治理模式——登记产物类型 → 层/目录前缀的约定，供校验与查询；
// 不绑定任何团队模板（jiufeng 四件套只是使用者，产物内部格式归模板层）。
// 三层目录约定：plan/（任务层）、exec/（执行层）、audit/（审计层），与 wave-plan 路径契约一致。

export const ARTIFACT_TYPES = [
  { type: 'plan',       dir: 'plan/',  layer: 'plan', desc: '任务层产物（排期/模块清单/摸底）' },
  { type: 'spec',       dir: 'plan/',  layer: 'plan', desc: '执行规范（模板层定义内部结构）' },
  { type: 'taskTree',   dir: 'plan/',  layer: 'plan', desc: '任务树（细拆）' },
  { type: 'survey',     dir: 'plan/',  layer: 'plan', desc: '代码摸底报告（现状/入口/依赖/风险）' },
  { type: 'code',       dir: 'exec/',  layer: 'exec', desc: '代码/实现产物' },
  { type: 'testReport', dir: 'exec/',  layer: 'exec', desc: '测试报告' },
  { type: 'review',     dir: 'audit/', layer: 'audit', desc: '审查证据' },
  { type: 'gapList',    dir: 'audit/', layer: 'audit', desc: '差距清单' },
  { type: 'acceptance', dir: 'audit/', layer: 'audit', desc: '验收报告' },
  { type: 'retrospective', dir: 'audit/', layer: 'audit', desc: '复盘报告（记忆沉淀输入，记忆工具开放语义）' },
];

// 相对产物路径 → 类型名（按目录前缀匹配；绝对路径返回 null）
export function artifactTypeOf(relPath) {
  if (typeof relPath !== 'string') return null;
  for (const t of ARTIFACT_TYPES) {
    if (relPath.startsWith(t.dir)) return t.type;
  }
  return null;
}

// 层 → 该层注册的产物类型
export function typesOfLayer(layer) {
  return ARTIFACT_TYPES.filter((t) => t.layer === layer).map((t) => t.type);
}
