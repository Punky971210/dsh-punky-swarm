# dsh-punky-swarm —— DeepSeek Harness 多 Agent 集群治理插件

<p align="center">
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Punky971210/dsh-punky-swarm?label=license" alt="license"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Punky971210/dsh-punky-swarm/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/packages/dsh-punky-swarm/package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="node"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/tree/main/packages/dsh-punky-swarm/test"><img src="https://img.shields.io/badge/tests-582%20passed-success" alt="tests"></a>
</p>

> **单机 dsh 的多 Agent 集群编排器——门禁拒绝半成品，检查点断点续跑，让 AI 团队不「坏」而不只是能「跑」。**
>
> *Engine-enforced guardrails for DeepSeek Harness agent swarms: quality gates reject half-done work, crash-safe checkpoints resume in place — keeps AI teams from breaking, not just running.*

English: [README.en.md](README.en.md)

## 文档导航（Contents）

- [摘要](#摘要abstract) · [为什么需要它](#为什么需要它why) · [快速了解（30 秒）](#快速了解30-秒) · [快速开始](#快速开始quick-start) · [能力清单](#能力清单10-项) · [架构](#架构architecture) · [演示](#演示demo) · [兼容矩阵](#兼容矩阵compatibility-matrix) · [路线图](#路线图roadmap) · [License](#license)
- 英文版：[README.en.md](README.en.md)

---

## 摘要（Abstract）

dsh-punky-swarm 是 DeepSeek Harness（dsh）的多 Agent 集群治理插件：任务按依赖分波执行，引擎级门禁拦截半成品，检查点让长任务崩溃可续跑。它面向单机场景，在同一 dsh 进程内治理一批 worker（批次 / 门禁 / 通信 / 恢复），提供单写者锁、mailbox 黑板通信与事件审计。当前状态：npm 包 `dsh-punky-swarm@0.3.6` 一条命令装入 dsh；默认装配 19 个治理工具；582 项测试全绿；以 AGPL-3.0-only 单一许可发布。

*dsh-punky-swarm is a single-machine multi-agent governance plugin for DeepSeek Harness. Tasks run in dependency-ordered waves, engine-enforced gates reject half-done work, and checkpoints let long-running batches resume after a crash. The plugin ships 19 governance tools (20 with all capabilities enabled), passes 582 tests, and is licensed under AGPL-3.0-only.*

## 为什么需要它（Why）

单 Agent 好写，多 Agent 集群难管：并行任务的依赖怎么排、产物怎么对齐、失败怎么恢复、谁改了什么。多 Agent 并行不是把 prompt 一起发出去就完了——谁先跑、谁等谁、谁写哪个文件、崩了从哪续，这些才是集群治理的问题。

- **无门禁的派发会带病开工**：下游在依赖产物缺失时就被派发，错误传播到返工阶段才暴露。门禁在派发前核对产物是否齐备，缺件即拒绝，把「带病开工」挡在源头。
- **无检查点的长任务一崩全丢**：长批次没有中间保全，一次崩溃让数小时工作归零。完成每个子步骤即保存进度，崩溃后可从断点继续，不再从头再来。
- **多 lane 同写一个仓库互相踩**：并发写同一仓库会互相覆盖、冲突难追责。每个 lane 有独立工作区互不干扰，冲突保留现场交裁决。

## 快速了解（30 秒）

三个痛点：

- **无门禁的派发会带病开工**——上游产物没齐就派下游，失败要到返工才发现；
- **无检查点的长任务一崩全丢**——几小时的批次因一次崩溃回到原点；
- **多 lane 同写一个仓库互相踩**——并发提交互相覆盖，出冲突说不清谁改了什么。

**图1 · wavePlan 分波 DAG** —— plan/exec/audit 三层泳道，exec 内 wave1-3 分列：wave 内并行、wave 间串行，依赖箭头标注产物名。

```mermaid
flowchart LR
  subgraph PLAN[plan 层]
    P["plan 产出 spec.md"]
  end
  subgraph EXEC[exec 层]
    subgraph W1[wave 1 并行]
      A1["exec-A 产出 impl.md"]
      A2["exec-B 产出 test.md"]
    end
    subgraph W2[wave 2]
      A3["exec-C 产出 verify.md"]
    end
    subgraph W3[wave 3]
      A4["exec-D 产出 release.md"]
    end
  end
  subgraph AUDIT[audit 层]
    AU["audit 验收"]
  end
  P -->|"spec.md"| A1
  P -->|"spec.md"| A2
  A1 -->|"impl.md"| A3
  A2 -->|"test.md"| A3
  A3 -->|"verify.md"| A4
  A4 -->|"release.md"| AU
  NOTE["wave 固定语义 批次创建后绝不中途重算"]
  EXEC -.-> NOTE
```

## 快速开始（Quick Start）

环境要求：已安装 DeepSeek Harness（dsh）。

```sh
# 一条命令安装 npm 包
npm install -g dsh-punky-swarm
# 装入 dsh（web 为示例 profile，可替换）
dsh plugin --profile web add dsh-punky-swarm
dsh web restart
```

最小示例（从安装到跑通第一个三层批次）：

```text
1. 按上一步安装插件并重启 dsh。
2. 在会话中让 Agent 执行：wave_plan 建批（声明 plan/exec/audit 三层与产物契约）
   → 批次进入 running → 各 lane 按 wave 依赖顺序派发执行。
3. 用 batch_status / gate_status 观察批次状态与门禁缺件清单。
```

## 能力清单（10 项）

1. **任务难度 ABC 路由门禁**：A=Leader 直做 / B=单 subagent / C=wave_plan 建批；评估对象为完整目标任务（scope=full），default to C。
2. **wavePlan 固定语义分波**：plan→exec→audit 三层，wave 按依赖 DAG 分层，批次创建后绝不中途重算。
3. **Tier3 引擎强制门禁**：consume 产物齐备才派发（缺则 GATE_ENTRY_MISSING 拒派）；产物落盘才结算（缺则拒 merged）；audit 验收完成才 complete。
4. **checkpoint 断点续跑**：每完成一个子步骤即 git 保全（step N/total），崩溃后新 worker 查询 checkpoint 跳过已完成步骤。
5. **lane worktree 物理隔离 + 串行 merge**：多 lane 同写一个 git 仓库互不冲突，合并串行化，冲突保留现场。
6. **mailbox 黑板通信**：inbox/outbox/broadcast 三向，原子写 + ackId，只写元数据不复制正文。
7. **lane_claim 单写者锁**：O_EXCL 锁，冲突先拒绝，可 wait 等待、可 force 接管。
8. **成员状态机**：pending→running→review→merged/failed/conflict/skipped，终态后拒绝再写。
9. **批次会话隔离**：状态文件为唯一事实源，事件流留痕可审计。
10. **工程状态**：19 个治理工具（默认装配，开启全部能力为 20 个）、582/582 测试全绿、v0.3.6 已发布（AGPL-3.0-only）、已收录 awesome-dsh-plugin。

## 架构（Architecture）

- **角色分层**：Leader（决策与终门禁）→ Manager（调度）→ Worker（执行）；批次按 plan/exec/audit 三层组织，各层产物按契约衔接。
- **状态与通信**：批次/成员状态以状态文件为唯一事实源；跨上下文通信走 mailbox 黑板（inbox/outbox/broadcast）；每一步操作写入事件流，可审计可回溯。
- 治理不是写在文档里的约定，而是引擎强制执行的门禁——状态文件是唯一事实源，每一步都有事件可查。

## 演示（Demo）

**图2 · Tier3 引擎强制门禁** —— 派发前核对 consume 产物（缺件 GATE_ENTRY_MISSING 拒派）、结算前核对产物落盘（缺失 GATE_TARGET_MISSING 拒结算）、需人工裁决时转人工闸（GATE_NEEDHUMAN）。

```mermaid
flowchart TD
  S["派发 lane"] --> D1{"consume 产物齐备?"}
  D1 -- "否" --> R1["拒派 GATE_ENTRY_MISSING"]
  D1 -- "是" --> X["执行 worker 落盘产物"]
  X --> D2{"产物已落盘?"}
  D2 -- "否" --> R2["拒结算 GATE_TARGET_MISSING"]
  D2 -- "是" --> C["member_settle merged"]
  C --> D3{"audit 验收完成?"}
  D3 -- "人工闸" --> R3["GATE_NEEDHUMAN 人工裁决"]
  D3 -- "通过" --> DONE["批次 complete"]
```

**图3 · checkpoint 断点续跑** —— 每完成一个子步骤即 lane_checkpoint 提交 git 保全（step N/total）；崩溃后新 worker 用 lane_checkpoint_status 查询进度，跳过已完成步骤续跑。

```mermaid
sequenceDiagram
  participant A as worker A
  participant G as lane git 保全
  participant B as worker B
  A->>A: 执行 step 1/3
  A->>G: lane_checkpoint git 保全
  A->>A: 执行 step 2/3
  A->>G: lane_checkpoint git 保全
  Note over A: 崩溃 进程终止
  Note over G: checkpoint 历史 git log 可查
  B->>G: lane_checkpoint_status 查询进度
  G-->>B: 已完成 step 2/3
  B->>B: 跳过已完成步骤 从 step 3 续跑
```

## 兼容矩阵（Compatibility Matrix）

| 组件 | 版本 | 状态 |
|---|---|---|
| dsh-punky-swarm | 0.3.6（当前发布版） | 支持 |
| Node.js | >=22（package.json engines） | 支持（实测于 Node 24） |
| @deepseek-ai/dsh-tools（peer） | ^0.1.0-rc.6 \|\| ^0.1.1-rc.2 | 支持 |
| @deepseek-ai/cordis（peer） | ^4.0.1 | 支持 |
| 其他 dsh / Node 版本 | — | 未验证 |

> 以仓库 CI 与测试矩阵为准；未验证项如实标注，不作未经实测的版本声明。

## 路线图（Roadmap）

- 演示动画 gh-pages 托管上线（动画 HTML 已在 assets/demo/，可直接浏览器打开）

## License

本项目以 **GNU AGPL v3（AGPL-3.0-only）为唯一许可**：

- 在遵守 [AGPL-3.0](LICENSE) 的前提下，可自由使用、修改、分发（含商用）；若修改后通过网络提供服务，须按 AGPL-3.0 公开修改内容。
- 镜像同步透明说明：任何镜像仅复制发布文件（逐字节一致）并新增 commit 推送，不改写 .git 历史。
