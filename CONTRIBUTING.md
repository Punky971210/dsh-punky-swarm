# 贡献指南（Contributing）

## 开发环境
- Node.js >= 22；零运行时依赖，无需安装依赖即可测试：

```sh
cd packages/dsh-punky
node --test
```

## 目录
- lib/：引擎（schema / wave-plan / lock / mailbox / batch-store / assembly / artifact-types / tools / api / client / index）；
- presets/jiufeng/：蟛蜞模式预设（persona + 治理纪律 + tool-bootstrap）；
- skills/jiufeng-team/：角色 × 装配指引（3 层 8 角色 + constitution + 模板）。

## 提交 PR
1. 新功能必须带 node:test 单测（gates / contract / rework 等既有模式）；
2. 改动后 node --test 全绿（基线 68 项）；
3. 文档同步（docs/ + README + CHANGELOG）；
4. 保持零运行时依赖（只允许 @deepseek-ai/* peer 依赖）；
5. 中文注释与文档保持一致。

## 项目边界（重要）
本项目目标 = **dsh 单机多子 agent 治理**。硬化 / 续跑 / 集群同步 / 成本控制不在范围内，请勿为此类需求提交功能。
