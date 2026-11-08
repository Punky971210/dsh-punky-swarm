
export const HOST_PROVIDED_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'wait_agent',
  'spawn_teammate',
]);

export const HOST_INTERSECT_EXEMPT = Object.freeze(['list_agents', 'wait_agent']);

export const CONDITIONAL_REGISTRATION = Object.freeze(['log_export']);

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

export const HOST_CONTINUATION_SUBSET = Object.freeze(
  HOST_PROVIDED_TOOLS.filter((n) => ['interrupt_agent', 'list_agents', 'wait_agent', 'spawn_teammate'].includes(n)),
);
