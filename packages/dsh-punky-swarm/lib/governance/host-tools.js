/**
 * 宿主工具口径**单点**（M1）：本仓内「哪些工具不由本插件注册」的**唯一**名单来源。
 *
 * ⚠ 三个常量**语义不同、禁合并**（批 `punky-qa-fix-m1m2-2026-10-31` C-1）：
 *   合并会把「事实」与「策略」压成一个集合 —— 那样任何一方变动都会静默改变另一方的行为。
 */

/**
 * 【事实】宿主提供、本仓**不注册**的**完整 7 件**。
 *
 * 语义 = 「这些工具的注册方是宿主（Team 面 / 派发面），本插件查不到它们属**正常形态**」。
 * 用途 = 声明完备性对账（`SUITE_TOOLS ∖ 注册表` 的合法差集来源）、测试侧「未默认注册」集合来源。
 * ⚠ 它们是**事实清单**，不是豁免策略：要不要豁免由 `HOST_INTERSECT_EXEMPT` 决定。
 */
export const HOST_PROVIDED_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'wait_agent',
  'spawn_teammate',
]);

/**
 * 【策略】可调面求交时**豁免**求交的子集（2 件）。
 *
 * 语义 = 「`tools/list` 求交（声明面 ∩ 实际可派发面）时，这 2 件**不参与求交**即便本仓不注册」。
 * 为什么要独立成常量：求交是**能力宣告策略**（能宣告的必须真能调到），豁免名单是这条策略的
 * 例外清单。它**可以**是事实集合的子集，但**不必须等于**事实集合 —— 二者分开，改动各自可审。
 * ⚠ 本文件保留 `wait_agent` 于豁免面（`list_agents`/`wait_agent` 为宿主 Team 面只读件，
 * 本仓无法自证其可见性 ⇒ 按「能宣告即真能调」的反面处置：豁免求交、登记未验证）。
 */
export const HOST_INTERSECT_EXEMPT = Object.freeze(['list_agents', 'wait_agent']);

/**
 * 【事实】**条件注册**：能力位未开时本仓不注册的工具（当前 = `log_export`）。
 *
 * 语义 = 「是否注册取决于 `logs` capability；默认关 ⇒ 默认不在注册表」。
 * 与宿主提供**不同**：这类工具本插件**会**注册（能力位开时），宿主提供类则**永不**由本仓注册。
 * ⚠ 常量为**数组**形式（便于 `[...HOST_PROVIDED_TOOLS, ...CONDITIONAL_REGISTRATION]` 组集合），
 * 当前只有 1 件，但形状按集合给，避免将来加第二件时改变导出类型。
 */
export const CONDITIONAL_REGISTRATION = Object.freeze(['log_export']);

/**
 * 【说明面 · **不作判据**】宿主工具台账：逐件记录「由谁提供 / 本仓是否注册 / 属于哪个面」。
 *
 * 用途 = 供人阅读与审计交叉核对；**任何断言/门禁都不得以它为输入**（判据只有上面三个常量）。
 * 若它与常量冲突 ⇒ 以常量为准，本表应改。
 */
export const HOST_TOOL_LEDGER = Object.freeze([
  { name: 'subagent', providedBy: 'host:dispatch', registeredByEngine: false, face: 'dispatch' },
  { name: 'subagent_fork', providedBy: 'host:dispatch', registeredByEngine: false, face: 'dispatch' },
  { name: 'spawn_teammate', providedBy: 'host:agent-team', registeredByEngine: false, face: 'agent-team' },
  { name: 'send_message', providedBy: 'host:agent-team', registeredByEngine: false, face: 'agent-team' },
  { name: 'interrupt_agent', providedBy: 'host:agent-team', registeredByEngine: false, face: 'agent-team' },
  { name: 'list_agents', providedBy: 'host:agent-team', registeredByEngine: false, face: 'agent-team' },
  { name: 'wait_agent', providedBy: 'host:agent-team', registeredByEngine: false, face: 'agent-team' },
  { name: 'log_export', providedBy: 'engine:conditional', registeredByEngine: 'capability:logs', face: 'blackboard' },
]);

/**
 * 【说明面 · **不作判据**】测试侧常用的「4 件宿主连续控制/席位拉起子集」的**派生**形态。
 *
 * 存在理由：测试里有一处只关心 `{interrupt_agent, list_agents, wait_agent, spawn_teammate}`
 * 这个**原子子集**（S2 连续控制族 ＋ AG-20 席位拉起面）。为避免测试侧再手写第二份名单，
 * 这里按「从事实集合**过滤**得到」派生 —— 子集语义保留，名单不复制。
 * ⚠ 这是**派生视图**，不是第四份事实；改事实集合时它会跟着变（这正是要的）。
 */
export const HOST_CONTINUATION_SUBSET = Object.freeze(
  HOST_PROVIDED_TOOLS.filter((n) => ['interrupt_agent', 'list_agents', 'wait_agent', 'spawn_teammate'].includes(n)),
);
