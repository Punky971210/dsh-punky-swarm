# dsh-punky-swarm — 蟛蜞模式（Punky Swarm 集群治理）

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green)

> dsh（DeepSeek Harness）**单机多子 agent 集群治理**插件：wavePlan 三层 DAG + 引擎级门禁（Entry/L0/Exit/Complete）+ 状态机 + 锁/mailbox + 会话隔离。附蟛蜞模式预设与 jiufeng-team 角色指引。

English: [README.en.md](README.en.md)

## 边界（Scope）

- **目标**：dsh **单机多子 agent 治理**——在同一 dsh 进程内治理一批 worker（批次 / 门禁 / 通信 / 恢复重置派发）；
- **范围外**：硬化（hardening）、续跑（durable resume）、集群同步、成本控制——不在考虑范围内，请勿按这些需求使用本项目。

## 三件套

| 件 | 位置 | 内容 |
|---|---|---|
| 插件 | packages/dsh-punky | 引擎：13 治理工具 + Tier3 门禁 + 会话隔离 v2 + 只读 API |
| 模式 | packages/dsh-punky/presets/jiufeng | 蟛蜞模式预设：Leader persona + 治理纪律 + tool-bootstrap |
| 指引 | packages/dsh-punky/skills/jiufeng-team | 3 层 8 角色 × 操作手册装配表 + constitution + 模板 |

## 安装

> 以下指引面向 Agent / 自动化执行，命令可直接运行；`web` 为示例 profile，可替换。

### 1. 获取插件（GitHub）

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
```

### 2. 挂载插件

```sh
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky
```

### 3. 放置模式预设（目标已存在则先删除）

```sh
rm -rf ~/.dsh/.agent-presets/jiufeng
cp -r packages/dsh-punky/presets/jiufeng ~/.dsh/.agent-presets/jiufeng
# Windows: robocopy packages\dsh-punky\presets\jiufeng %USERPROFILE%\.dsh\.agent-presets\jiufeng /E
```

### 4. 放置技能指引

```sh
rm -rf ~/.agents/skills/jiufeng-team
cp -r packages/dsh-punky/skills/jiufeng-team ~/.agents/skills/jiufeng-team
```

### 5. 验证

1. 重启 dsh web，新建会话，预设选择器出现「蟛蜞模式」；
2. 工具面含 13 个治理工具：wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack；
3. 技能就位：`ls ~/.agents/skills/jiufeng-team/SKILL.md`。

> npm 发布后亦可：`dsh plugin --profile web add dsh-punky-swarm`（预设 / 技能仍按第 3-4 步放置，源路径为已安装包内的 presets/、skills/）。

## 工具清单（13）

wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack

## 三层门禁（Tier3）

- **建批静态校验**：layer ∈ plan/exec/audit；有 exec 必有 audit；产物路径契约；跨层引用；防篡改；
- **Entry Gate**：exec 派发前 consume 齐备；
- **L0**：plan merged 前 spec 必填章节 / JSON 可解析；
- **Exit Gate**：exec→outputs、audit→produce 存在；
- **Complete Gate**：audit 全终态且无 failed/conflict，exec 全终态。

generic 批次（无 layer）不触发门禁，向后兼容。

## 状态机

```
成员：pending -> running -> review -> merged | failed | skipped | conflict（idle=恢复重派；review->running=返工）
批次：planning -> running -> paused -> aborted | complete（complete 前置三层门禁）
```

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
