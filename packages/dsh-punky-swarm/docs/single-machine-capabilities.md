# 单机能力边界（Single-Machine Capabilities）

> 本文档以产品化语言陈述 dsh-punky-swarm 的单机能力边界：本地运行、零云依赖、默认零网络暴露、插件级治理范围、确定性零依赖。
> English: [single-machine-capabilities.en.md](single-machine-capabilities.en.md)

## 1. 本地运行

- 插件运行于 dsh（DeepSeek Harness）进程内，编排、裁决与留痕全部在本机进程内完成；
- 治理对象是同一进程内编排的一批 Agent 子进程（批次 / 门禁 / 通信 / 恢复重派）；
- 单 npm 包内含：插件引擎、Punky Swarm 预设（presets/jiufeng）、jiufeng-team 角色指引（skills/jiufeng-team）；插件启动时自动同步预设与技能到用户目录，无需手动放置；
- 只读监控面板随插件加载（会话页「Punky Swarm 集群」分页），安装即得。

## 2. 零云依赖 / 零外部服务

- 引擎实现仅使用 Node.js 原生能力（node:fs / node:crypto / node:https / node:tls）；
- peer 依赖为宿主运行时：@deepseek-ai/dsh-tools（宿主工具与执行上下文）、@deepseek-ai/cordis（插件总线）；
- 无外部数据库、无外部消息队列、无 SaaS 依赖；本地起 dsh 即具备完整治理能力。

## 3. 默认零网络暴露（安全默认）

- 网络类能力全部**默认关**：ACPs 通讯（`acps.*`）、身份体系（`aip.identity`）默认关闭；
- 关闭状态下零运行时足迹：无监听、无定时器、无网络路径（不加载不实例化）；
- 显式开启（如 `acps.endpoint.enabled`）才加载监听/客户端；对外端点默认 host 仅 `127.0.0.1`；
- 出厂护栏零拦截：`governance.hook.rules` 默认为空（decide 恒 ALLOW），装上即用、不改变既有行为。

## 4. 插件级治理范围

- 治理范围为**单个 dsh 插件进程**内的集群编排（批级三层门禁 + 调用级护栏双层，见 governance-technical.md / guardrails-hook.md）；
- 批次/成员状态以状态文件为唯一事实源，事件全程留痕可审计；
- 崩溃恢复为 checkpoint 保全 + 恢复审计 + idle 归位重派（新 worker 可查 checkpoint 跳过已完成步骤）；**不自动续跑**——失败 lane 终态、重做开新批次；
- 跨机分布式集群同步、多机编排、成本控制、模型分层路由不在提供范围（见 governance-technical.md §8 架构边界）。

## 5. 确定性与零依赖

- 调用级护栏内核为**同步、确定性、零 IO** 的纯函数（`lib/governance/`）：规则匹配 → 违规分类 → 决策，无外部状态参与；
- 拒绝收据哈希链使用标准库 sha256（node:crypto）+ 确定性 canonical 序列化（RFC8785 简版：键排序 / 无空白 / undefined 对齐 JSON.stringify），同输入同输出、可复现验证；
- 文件 IO（收据 / 状态 / 事件流）使用原子写（tmp+rename）+ 写后读校验，fail-closed，不留半成品；
- 全部实现零新增运行时依赖（仅 peer 宿主依赖 + Node 标准库）。

## 6. 与外部体系的连接（可选，默认关）

- **国标 AIP 兼容**（默认开，进程内只读端点）：遵循 GB/Z 185-2026 描述结构生成工具/智能体目录，详见 [aip-compliance.md](aip-compliance.md)；
- **ACPs 通讯**（默认关）：对外 mTLS 端点 / 内部桥接 / registry / discovery，仅显式开启时才有网络路径，详见 [acps-communication.md](acps-communication.md)；
- 两类能力与单机治理正交：关闭时不影响任何本地治理功能。
