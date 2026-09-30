/*
服务依赖探针（微型插件 · 2026-09-30 批 decl-face-and-logging-20260930）

唯一职责：以**独立 id + 独立插件**的形态，承载本包对宿主团队服务 `agentTeams` 的依赖声明
（装配面 `cordis.patch.yml` 该行上的 `inject: [agentTeams]`），使**缺该服务时该行真正进入
activation 审计并产生 pending**（启动响亮：`pending (waiting for service: agentTeams)`）。

本插件**不做任何事**：不注册工具、不写状态、不挂钩子、不读 config —— 服务面齐备时零运行时影响。
（历史：曾以「无 name 的声明行」承担同一职责，实测该行不会成为 loader entry ⇒ 空转，故改为本载体。）
*/
export const name = 'dsh-punky-swarm-service-probe';

export function apply() {}
