# 开源发布说明（dsh-punky-swarm）

> 2026-08-20 · 目标：插件 + 模式 + jiufeng-team 指引三件套作为独立模块开源。

## 工作台（个人功能，不开源）

本地 web UI 的「蟛蜞集群」工作台分页（lib/client.js）仅作为个人需求，**不随开源包发布**：package.json files 已排除 lib/client.js。本地 link 挂载可用；npm 用户无此 UI（dsh host 记录 client bundle 缺失日志，不影响引擎）。

## 三件套
- **插件**：packages/dsh-punky（引擎，13 治理工具 + Tier3 三层门禁 + 会话隔离 v2）；
- **模式**：packages/dsh-punky/presets/jiufeng（蟛蜞模式预设：preset.yml + agent.cordis.yml + NOTICE）；
- **指引**：packages/dsh-punky/skills/jiufeng-team（角色 × 装配：SKILL.md + references/）。

## 发布 checklist

| # | 项 | 状态 |
|---|----|----|
| 1 | LICENSE（Apache-2.0） | ✅ 已补 |
| 2 | CI（.github/workflows/ci.yml，node 22/24） | ✅ 已补 |
| 3 | package.json（license/engines/files/peerDeps/test script） | ✅ 已补（test script 修复） |
| 4 | 三件套入包（presets/ + skills/ 进 files） | ✅ 已拷入 |
| 5 | repository 字段 | ✅ github.com/Punky971210/dsh-punky-swarm |
| 6 | README.en.md | ✅ 已完善（对齐 README 主要章节） |
| 7 | docs 去敏（个人路径 / 机器上下文） | ⬜ 发布前替换 |
| 8 | dsh-punky-swarm-tier3 副本去留 | ⬜ 建议排除或独立包，避免双份维护 |
| 9 | npm 发布（或 GitHub Packages） | ⬜ 建仓后执行（npm view dsh-punky-swarm 查占用） |
| 10 | awesome-dsh-plugin PR + dsh-market 收录 | ⬜ 发布后提交 |

## 安装（发布后）

```sh
# 本地 link（开发）
dsh plugin --profile web add link:<repo>/packages/dsh-punky

# npm（发布后）
dsh plugin --profile web add dsh-punky-swarm
```

## 预设与技能分发
- 当前：包内自带 presets/ 与 skills/，需手动拷贝到 ~/.dsh/.agent-presets/jiufeng 与 ~/.agents/skills/jiufeng-team（README 有说明）；
- 0.2.0 计划：host 启动自动同步（参照 dsh-liangshen 的启动同步机制）。
